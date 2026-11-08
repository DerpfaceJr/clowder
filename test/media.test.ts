// Media adapters run against fake HTTP servers only. No test calls a real provider, and no test needs a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type IncomingMessage, type ServerResponse, type Server} from 'node:http';
import Fastify from 'fastify';
import {ModelHub, mediaStatus, registerMediaRoutes} from '../src/models.ts';
import {installAccess} from '../src/access.ts';
import {Store} from '../src/store.ts';
import {artifactIndex, artifactsDir} from '../src/artifacts.ts';
import {MEDIA_SPECS, checkMedia, customAdapter, downloadMedia, fillTemplate, higgsfieldAdapter, openAIImagesAdapter, pick, runtimeFor, seedanceAdapter} from '../src/media.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture-body')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const signal = () => new AbortController().signal;

type Hit = {method?: string; url?: string; auth?: string; headers: IncomingMessage['headers']; body: any};
// A fake service: `route` answers each request. Every request is recorded so tests can check headers and bodies.
async function fakeService(route: (hit: Hit, res: ServerResponse, n: number) => void) {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const hit: Hit = {method: req.method, url: req.url, auth: req.headers.authorization, headers: req.headers, body: raw ? JSON.parse(raw) : undefined};
      hits.push(hit);
      route(hit, res, hits.length);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  return {base, hits, close: () => new Promise<void>(r => server.close(() => r()))};
}
const json = (res: ServerResponse, body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const bytes = (res: ServerResponse, type: string, body: Buffer) => { res.setHeader('content-type', type); res.end(body); };

test('Seedance image: POST images/generations with Bearer, then download the returned URL', async () => {
  const svc = await fakeService((hit, res) => {
    if (hit.url === '/api/v3/images/generations') return json(res, {data: [{url: `${svc.base}/pic.png`}]});
    return bytes(res, 'image/png', PNG);
  });
  try {
    const runtime = runtimeFor([seedanceAdapter({base: `${svc.base}/api/v3`, key: 'ark-key', imageModel: 'seedream-test', timeoutMs: 5000})], {allowHttp: true});
    const file = await runtime.generate({kind: 'image', prompt: 'a cat'}, signal());
    assert.deepEqual(file.bytes, PNG);
    assert.equal(file.adapter, 'seedance');
    assert.equal(svc.hits[0].auth, 'Bearer ark-key');
    assert.equal(svc.hits[0].body.model, 'seedream-test');
    assert.equal(svc.hits[0].body.response_format, 'url');
    assert.equal(svc.hits[0].body.prompt, 'a cat');
  } finally { await svc.close(); }
});

test('Seedance video: create a task, poll until succeeded, then download content.video_url', async () => {
  const svc = await fakeService((hit, res) => {
    if (hit.method === 'POST' && hit.url === '/api/v3/contents/generations/tasks') return json(res, {id: 'cgt-1'});
    if (hit.method === 'GET' && hit.url === '/api/v3/contents/generations/tasks/cgt-1') {
      const polls = svc.hits.filter(h => h.method === 'GET').length;
      return json(res, polls < 2 ? {id: 'cgt-1', status: 'running'} : {id: 'cgt-1', status: 'succeeded', content: {video_url: `${svc.base}/clip.mp4`}});
    }
    return bytes(res, 'video/mp4', MP4);
  });
  try {
    const runtime = runtimeFor([seedanceAdapter({base: `${svc.base}/api/v3`, key: 'ark-key', videoModel: 'seedance-test', timeoutMs: 5000})], {allowHttp: true, pollMs: 1});
    const file = await runtime.generate({kind: 'video', prompt: 'a cat jumps', duration: 5}, signal());
    assert.deepEqual(file.bytes, MP4);
    const create = svc.hits[0];
    assert.equal(create.auth, 'Bearer ark-key');
    assert.equal(create.body.model, 'seedance-test');
    assert.deepEqual(create.body.content, [{type: 'text', text: 'a cat jumps'}]);
    assert.equal(create.body.duration, 5);
    assert.equal(svc.hits.filter(h => h.method === 'GET' && h.url?.includes('/tasks/')).length, 2, 'polled until succeeded');
  } finally { await svc.close(); }
});

test('Seedance video: a failed task stops with its status and downloads nothing', async () => {
  const svc = await fakeService((hit, res) => {
    if (hit.method === 'POST') return json(res, {id: 'cgt-2'});
    return json(res, {id: 'cgt-2', status: 'failed'});
  });
  try {
    const runtime = runtimeFor([seedanceAdapter({base: `${svc.base}/api/v3`, key: 'k', videoModel: 'm', timeoutMs: 5000})], {allowHttp: true, pollMs: 1});
    await assert.rejects(runtime.generate({kind: 'video', prompt: 'x'}, signal()), /failed the video/);
  } finally { await svc.close(); }
});

test('Higgsfield: submit with Key auth and an Idempotency-Key, poll the status link, then download images[].url', async () => {
  const svc = await fakeService((hit, res) => {
    if (hit.method === 'POST' && hit.url === '/higgsfield-ai/soul/v2/standard') return json(res, {status: 'queued', request_id: 'r1', status_url: `${svc.base}/requests/r1/status`, cancel_url: `${svc.base}/requests/r1/cancel`});
    if (hit.url === '/requests/r1/status') return json(res, {status: 'completed', images: [{url: `${svc.base}/img.png`}]});
    return bytes(res, 'image/png', PNG);
  });
  try {
    const runtime = runtimeFor([higgsfieldAdapter({base: svc.base, key: 'id-1:secret-2', imageModel: '/higgsfield-ai/soul/v2/standard', timeoutMs: 5000})], {allowHttp: true, pollMs: 1});
    const file = await runtime.generate({kind: 'image', prompt: 'alpine lake'}, signal());
    assert.deepEqual(file.bytes, PNG);
    assert.equal(svc.hits[0].auth, 'Key id-1:secret-2');
    assert.match(String(svc.hits[0].headers['idempotency-key']), /^[0-9a-f-]{36}$/);
    assert.deepEqual(svc.hits[0].body, {prompt: 'alpine lake'});
    assert.equal(svc.hits[1].auth, 'Key id-1:secret-2', 'the key goes with the status poll');
  } finally { await svc.close(); }
});

test('Higgsfield never polls a status link on another host, and offers no video', async () => {
  const svc = await fakeService((hit, res) => json(res, {status: 'queued', request_id: 'r', status_url: 'https://evil.example/requests/r/status'}));
  try {
    const runtime = runtimeFor([higgsfieldAdapter({base: svc.base, key: 'a:b', imageModel: '/x/y', timeoutMs: 5000})], {allowHttp: true, pollMs: 1});
    await assert.rejects(runtime.generate({kind: 'image', prompt: 'x'}, signal()), /another host/);
    assert.equal(runtime.has('video'), false, 'video is not wired for Higgsfield (TODO until its result field is documented)');
  } finally { await svc.close(); }
});

test('OpenAI-compatible images: b64_json is stored as given, and a url reply is downloaded', async () => {
  const svc = await fakeService((hit, res) => {
    if (hit.url === '/v1/images/generations' && svc.hits.length === 1) return json(res, {data: [{b64_json: PNG.toString('base64')}]});
    if (hit.url === '/v1/images/generations') return json(res, {data: [{url: `${svc.base}/from-url.png`}]});
    return bytes(res, 'image/png', PNG);
  });
  try {
    const runtime = runtimeFor([openAIImagesAdapter({base: `${svc.base}/v1`, model: 'm', key: 'k', timeoutMs: 5000})], {allowHttp: true});
    assert.deepEqual((await runtime.generate({kind: 'image', prompt: 'a'}, signal())).bytes, PNG);
    assert.deepEqual((await runtime.generate({kind: 'image', prompt: 'b'}, signal())).bytes, PNG);
  } finally { await svc.close(); }
});

test('custom HTTP: a JSON template with {prompt}, a dot-path to base64, and the auth header the owner named', async () => {
  const svc = await fakeService((hit, res) => json(res, {result: {b64: PNG.toString('base64')}}));
  try {
    const runtime = runtimeFor([customAdapter({base: svc.base, path: '/v1/make', authHeader: 'X-Api-Token', authPrefix: 'Token ', key: 'k1',
      kind: 'image', bodyTemplate: '{"prompt":"{prompt}","n":1,"nested":["a {prompt} b"]}', resultPath: 'result.b64', resultEncoding: 'base64', timeoutMs: 5000})]);
    const file = await runtime.generate({kind: 'image', prompt: 'a cat'}, signal());
    assert.deepEqual(file.bytes, PNG);
    assert.equal(svc.hits[0].headers['x-api-token'], 'Token k1');
    assert.equal(svc.hits[0].body.prompt, 'a cat');
    assert.deepEqual(svc.hits[0].body.nested, ['a a cat b']);
  } finally { await svc.close(); }
});

test('custom HTTP: a prompt cannot change the shape of the JSON it is put into', () => {
  const template = JSON.parse('{"prompt":"{prompt}","safe":true}');
  const body = fillTemplate(template, 'x","evil":true,"safe":false');
  assert.equal(body.prompt, 'x","evil":true,"safe":false');
  assert.deepEqual(Object.keys(body).sort(), ['prompt', 'safe']);
  assert.equal(body.safe, true);
  assert.equal(pick({data: [{url: 'u'}]}, 'data.0.url'), 'u');
});

test('custom HTTP: an async service is polled by job id until its status is the done value', async () => {
  const svc = await fakeService((hit, res, n) => {
    if (hit.method === 'POST') return json(res, {job: {id: 'j9'}});
    if (hit.url === '/tasks/j9') return json(res, n < 3 ? {state: 'working'} : {state: 'ok', out: {url: `${svc.base}/out.png`}});
    return bytes(res, 'image/png', PNG);
  });
  try {
    const runtime = runtimeFor([customAdapter({base: svc.base, path: '/v1/jobs', authHeader: 'Authorization', authPrefix: 'Bearer ', key: 'k',
      kind: 'image', bodyTemplate: '{"prompt":"{prompt}"}', resultPath: 'out.url', resultEncoding: 'url', idPath: 'job.id', pollPath: '/tasks/{id}',
      statusPath: 'state', doneValue: 'ok', failedValue: 'bad', timeoutMs: 5000})], {allowHttp: true, pollMs: 1});
    assert.deepEqual((await runtime.generate({kind: 'image', prompt: 'x'}, signal())).bytes, PNG);
    assert.equal(svc.hits.filter(h => h.method !== 'POST').length, 3);
  } finally { await svc.close(); }
});

test('downloads are HTTPS only, and a result larger than the cap is refused while it streams', async () => {
  await assert.rejects(downloadMedia('http://files.example/a.png', 'image', signal()), /HTTPS/);
  await assert.rejects(downloadMedia('https://user:pw@files.example/a.png', 'image', signal()), /HTTPS/);
  const svc = await fakeService((hit, res) => bytes(res, 'image/png', Buffer.alloc(8 * 1024 * 1024 + 10, 1)));
  try {
    await assert.rejects(downloadMedia(`${svc.base}/big.png`, 'image', signal(), true), /larger than the 8 MB limit/);
  } finally { await svc.close(); }
});

test('checkMedia keeps a key only for the same endpoint, refuses unknown fields and non-HTTPS bases', () => {
  const saved = {base: 'https://images.example.com/v1', model: 'm', key: 'sk-saved-1234'};
  assert.equal(checkMedia('openai-images', {base: 'https://images.example.com/v1/', model: 'm2'}, saved).key, 'sk-saved-1234');
  assert.throws(() => checkMedia('openai-images', {base: 'https://other.example.com/v1', model: 'm2'}, saved), /Enter api key/);
  assert.throws(() => checkMedia('openai-images', {base: 'http://images.example.com/v1', model: 'm', key: 'k'}), /HTTPS/);
  assert.throws(() => checkMedia('openai-images', {base: 'https://images.example.com/v1', model: 'm', key: 'k', extra: 'x'}), /Unknown setting/);
  assert.throws(() => checkMedia('nope', {}), /Unknown media provider/);
  assert.throws(() => checkMedia('higgsfield', {imageModel: 'no-leading-slash', key: 'a:b'}), /right form/);
  assert.throws(() => checkMedia('higgsfield', {imageModel: '/x/y', key: 'no-colon'}), /right form/);
  const custom = {base: 'https://svc.example.com', path: '/v1/x', kind: 'image', key: 'k', bodyTemplate: '{"a":1}', resultPath: 'url'};
  assert.throws(() => checkMedia('custom', custom), /must include \{prompt\}/);
  assert.throws(() => checkMedia('custom', {...custom, bodyTemplate: '{nope'}), /not valid JSON/);
  assert.equal(checkMedia('custom', {...custom, bodyTemplate: '{"p":"{prompt}"}'}).authHeader, 'Authorization');
  assert.ok(MEDIA_SPECS.seedance.fields.some(f => f.name === 'key' && f.secret));
});

test('the settings route never returns a key, and Check settings sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-route-'));
  const hub = new ModelHub({file: join(dir, 'models.json'), config, env: {}});
  await hub.update({media: {'openai-images': {base: 'https://images.example.com/v1', model: 'pic-1', key: 'sk-live-abcdefgh1234'}}});
  const store = new Store(join(dir, 'events.jsonl'), config.cats);
  const svc = await fakeService((hit, res) => bytes(res, 'image/png', PNG));
  const app = Fastify();
  installAccess(app, false, [], 9999,undefined,undefined,'test-owner');
  registerMediaRoutes(app, hub, () => ({journal: store, dir}));
  await app.ready();
  try {
    const list = await app.inject({url: '/api/models/media', headers: {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner'}});
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes('sk-live'), 'the key is never returned');
    const entry = JSON.parse(list.body).find((m: {id: string}) => m.id === 'openai-images');
    assert.equal(entry.hasKey, true);
    assert.equal(entry.keyLast4, '1234');
    assert.equal(entry.values.model, 'pic-1');

    // Pointed at a fake endpoint, Check settings must not reach it: that is the "nothing billable" promise.
    hub.settings.media!['openai-images'].base = svc.base;
    const check = await app.inject({method: 'POST', url: '/api/models/media/openai-images/test', headers: {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner', 'content-type': 'application/json', 'x-town-action': 'owner'}, payload: {}});
    assert.equal(check.statusCode, 200);
    assert.equal(svc.hits.length, 0);
  } finally {
    await app.close();
    await svc.close();
  }
});

test('one test image is made only when asked, and lands in the gallery index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-test-'));
  const hub = new ModelHub({file: join(dir, 'models.json'), config, env: {}});
  const store = new Store(join(dir, 'events.jsonl'), config.cats);
  const svc = await fakeService((hit, res) => {
    if (hit.url === '/v1/images/generations') return json(res, {data: [{b64_json: PNG.toString('base64')}]});
    return bytes(res, 'image/png', PNG);
  });
  const app = Fastify();
  installAccess(app, false, [], 9999,undefined,undefined,'test-owner');
  registerMediaRoutes(app, hub, () => ({journal: store, dir}));
  await app.ready();
  try {
    hub.settings.media = {'openai-images': {base: `${svc.base}/v1`, model: 'pic-1', key: 'k'}};
    const res = await app.inject({method: 'POST', url: '/api/models/media/openai-images/test', headers: {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner', 'content-type': 'application/json', 'x-town-action': 'owner'}, payload: {generate: true}});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(svc.hits.length, 1);
    const [record] = artifactIndex(store.state.events);
    assert.equal(record.id, JSON.parse(res.body).artifact);
    assert.equal(record.title, 'Test image');
    assert.deepEqual(readFileSync(join(artifactsDir(dir), record.file)), PNG);
  } finally {
    await app.close();
    await svc.close();
  }
});

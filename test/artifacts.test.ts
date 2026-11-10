import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {Pairing} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {installAccess} from '../src/access.ts';
import {ARTIFACT_CSP, LIMITS, artifactIndex, artifactsDir, generateMediaTool, registerArtifactRoutes, saveArtifactTool, sniffMedia, storeArtifact} from '../src/artifacts.ts';
import {runtimeFor, openAIImagesAdapter, type MediaRuntime} from '../src/media.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const tempDir = () => mkdtempSync(join(tmpdir(), 'artifacts-'));
const journal = (dir: string, cats: unknown[] = []) => new Store(join(dir, 'events.jsonl'), cats as any);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('well-formed-enough-body')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]);
async function until(fn: () => boolean) {
  for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Timed out waiting for state transition');
}
// A provider that makes one tool call per turn, then answers in text.
function scripted(calls: {name: string; args: any}[]) {
  let turn = 0;
  return async () => {
    const call = calls[turn++];
    if (!call) return {message: {role: 'assistant', content: 'Finished.'}};
    return {message: {role: 'assistant', content: null, tool_calls: [{id: `call-${turn}`, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.args)}}]}};
  };
}
const toolResults = (store: Store) => store.state.events.filter(e => e.type === 'tool.finished').map(e => String(e.data.result));
const noRuntime = (): MediaRuntime | null => null;
const fakeRuntime = (kind: 'image' | 'video', bytes: Buffer): MediaRuntime => ({has: k => k === kind, generate: async () => ({bytes, adapter: 'fake'})});

test('artifacts are indexed by journal events and survive a restart', () => {
  const dir = tempDir(), store = journal(dir);
  saveArtifactTool({journal: store, dir: artifactsDir(dir), cat: 'scholar', task: 't1', project: 'p1', args: {title: '  Hello   page ', kind: 'html', content: '<h1>hi</h1>'}});
  const [record] = artifactIndex(store.state.events);
  assert.equal(record.title, 'Hello page');
  assert.equal(record.kind, 'html');
  assert.equal(record.mime, 'text/html; charset=utf-8');
  assert.equal(record.size, Buffer.byteLength('<h1>hi</h1>'));
  assert.equal(readFileSync(join(artifactsDir(dir), record.file), 'utf8'), '<h1>hi</h1>');
  assert.deepEqual(artifactIndex(new Store(join(dir, 'events.jsonl'), []).state.events), [record], 'the index replays from the journal');
});

test('size limits: 512 KB for text kinds, 8 MB images, 100 MB videos, and real formats only', () => {
  const dir = tempDir(), store = journal(dir), base = {journal: store, dir: artifactsDir(dir), cat: 'scholar', task: 't', project: 't'};
  const html = (n: number) => ({...base, title: 'Big', kind: 'html' as const, bytes: Buffer.alloc(n, 0x61)});
  assert.throws(() => storeArtifact(html(LIMITS.text + 1)), /512 KB/);
  assert.equal(storeArtifact(html(LIMITS.text)).size, LIMITS.text);
  assert.throws(() => storeArtifact({...base, title: 'Img', kind: 'image', bytes: Buffer.concat([PNG, Buffer.alloc(LIMITS.image)])}), /8 MB/);
  assert.throws(() => storeArtifact({...base, title: 'Vid', kind: 'video', bytes: Buffer.concat([MP4, Buffer.alloc(LIMITS.video)])}), /100 MB/);
  assert.throws(() => storeArtifact({...base, title: 'Img', kind: 'image', bytes: Buffer.from('not a picture at all')}), /PNG, JPEG or WebP/);
  assert.throws(() => storeArtifact({...base, title: 'Vid', kind: 'video', bytes: PNG}), /MP4 or WebM/);
  assert.throws(() => storeArtifact({...base, title: 'Empty', kind: 'text', bytes: Buffer.alloc(0)}), /some content/);
  assert.throws(() => storeArtifact({...base, title: '   ', kind: 'text', bytes: Buffer.from('x')}), /title/);
  assert.throws(() => saveArtifactTool({journal: store, dir: base.dir, cat: 'x', task: 't', project: 't', args: {title: 'j', kind: 'json', content: '{nope'}}), /valid JSON/);
  assert.throws(() => saveArtifactTool({journal: store, dir: base.dir, cat: 'x', task: 't', project: 't', args: {title: 's', kind: 'svg', content: '<div/>'}}), /<svg>/);
  assert.throws(() => saveArtifactTool({journal: store, dir: base.dir, cat: 'x', task: 't', project: 't', args: {title: 'i', kind: 'image', content: 'x'}}), /Choose a kind/);
  assert.deepEqual(sniffMedia('video', MP4), {mime: 'video/mp4', ext: 'mp4'});
  assert.deepEqual(sniffMedia('video', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), {mime: 'video/webm', ext: 'webm'});
  assert.deepEqual(sniffMedia('image', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), {mime: 'image/jpeg', ext: 'jpg'});
});

test('the per-world total is checked against the index before anything is written', () => {
  const dir = tempDir(), written: string[] = [];
  const full = {state: {events: [{type: 'artifact.created', at: '2026-01-01T00:00:00.000Z', data: {id: '00000000-0000-4000-8000-000000000001', kind: 'text', file: 'x.txt', size: LIMITS.world - 10}}]} as any, emit: () => { written.push('emit'); return {} as any; }};
  assert.throws(() => storeArtifact({journal: full, dir: join(dir, 'artifacts'), cat: 'c', task: null, project: null, title: 'Too much', kind: 'text', bytes: Buffer.alloc(11)}), /gallery is full/);
  assert.deepEqual(written, []);
  assert.equal(existsSync(join(dir, 'artifacts')), false);
});

test('path traversal and unknown ids are refused; a tampered index entry cannot reach outside the folder', async () => {
  const dir = tempDir(), store = journal(dir);
  const record = saveArtifactTool({journal: store, dir: artifactsDir(dir), cat: 'scholar', task: 't', project: 't', args: {title: 'Note', kind: 'text', content: 'ok'}});
  const id = /Saved artifact ([0-9a-f-]{36})/.exec(record)![1];
  writeFileSync(join(dir, 'secret.txt'), 'top secret');
  const tampered = '00000000-0000-4000-8000-0000000000aa';
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({id: 'e', at: '2026-01-01T00:00:00.000Z', type: 'artifact.created', data: {id: tampered, title: 'x', kind: 'text', mime: 'text/plain', file: '../secret.txt', size: 10}}) + '\n');
  const app = Fastify();
  registerArtifactRoutes(app, {dir: () => dir, events: () => new Store(join(dir, 'events.jsonl'), []).state.events});
  await app.ready();
  for (const bad of ['..%2F..%2Fpackage.json', '%2e%2e%2fsecret.txt', 'not-a-uuid', '..', `${id}%2F..%2Fsecret`]) {
    const res = await app.inject({url: `/artifacts/${bad}`});
    assert.equal(res.statusCode, 404, `refused ${bad}`);
    assert.ok(!res.body.includes('top secret'));
  }
  assert.equal((await app.inject({url: '/artifacts/00000000-0000-4000-8000-00000000ffff'})).statusCode, 404, 'a valid id that is not indexed');
  assert.equal((await app.inject({url: `/artifacts/${tampered}`})).statusCode, 404, 'an indexed file name outside the folder');
  assert.equal((await app.inject({url: `/artifacts/${id}`})).statusCode, 200);
  await app.close();
});

test('HTML, SVG, markdown, video and images carry the sandbox CSP and nosniff, on the page and the raw route', async () => {
  const dir = tempDir(), store = journal(dir);
  const make = (title: string, kind: 'html' | 'svg' | 'markdown', content: string) =>
    /Saved artifact ([0-9a-f-]{36})/.exec(saveArtifactTool({journal: store, dir: artifactsDir(dir), cat: 'artist', task: 't', project: 't', args: {title, kind, content}}))![1];
  const html = make('Page', 'html', '<h1>hi</h1><script>fetch("/api/state")</script>');
  const svg = make('Drawing', 'svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
  const md = make('Notes', 'markdown', '# Title');
  const video = storeArtifact({journal: store, dir: artifactsDir(dir), cat: 'artist', task: 't', project: 't', title: 'Clip', kind: 'video', bytes: MP4}).id;
  const app = Fastify();
  registerArtifactRoutes(app, {dir: () => dir, events: () => store.state.events});
  await app.ready();
  const expect: [string, string][] = [[html, 'text/html'], [svg, 'image/svg+xml'], [md, 'text/plain'], [video, 'video/mp4']];
  for (const [id, type] of expect) {
    for (const url of [`/artifacts/${id}`, `/artifacts/${id}/raw`]) {
      const res = await app.inject({url});
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['content-security-policy'], ARTIFACT_CSP, url);
      assert.ok(String(res.headers['content-type']).startsWith(type), url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', url);
    }
  }
  assert.match(ARTIFACT_CSP, /^sandbox allow-scripts allow-forms allow-popups;/);
  assert.ok(!/allow-same-origin/.test(ARTIFACT_CSP), 'never allow-same-origin');
  assert.match(String((await app.inject({url: `/artifacts/${html}/raw`})).headers['content-disposition']), /^inline; filename="html-/);
  await app.close();
});

test('an artifact answers a byte range, so a video can seek', async () => {
  const dir = tempDir(), store = journal(dir);
  const id = storeArtifact({journal: store, dir: artifactsDir(dir), cat: 'artist', task: 't', project: 't', title: 'Clip', kind: 'video', bytes: MP4}).id;
  const app = Fastify();
  registerArtifactRoutes(app, {dir: () => dir, events: () => store.state.events});
  await app.ready();
  const get = (range?: string) => app.inject({url: `/artifacts/${id}`, headers: range ? {range} : {}});
  const whole = await get(), last = MP4.length - 1;
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(Number(whole.headers['content-length']), MP4.length);
  assert.deepEqual(whole.rawPayload, Buffer.from(MP4));
  const cases: [string, number, number][] = [['bytes=0-3', 0, 3], ['bytes=4-', 4, last], ['bytes=-5', MP4.length - 5, last], [`bytes=2-${MP4.length + 50}`, 2, last]];
  for (const [range, start, end] of cases) {
    const part = await get(range);
    assert.equal(part.statusCode, 206, range);
    assert.equal(part.headers['content-range'], `bytes ${start}-${end}/${MP4.length}`, range);
    assert.deepEqual(part.rawPayload, Buffer.from(MP4).subarray(start, end + 1), range);
    assert.equal(part.headers['content-security-policy'], ARTIFACT_CSP, range);
  }
  const past = await get(`bytes=${MP4.length}-`);
  assert.equal(past.statusCode, 416);
  assert.equal(past.headers['content-range'], `bytes */${MP4.length}`);
  assert.equal((await get('bytes=0-1,4-5')).statusCode, 200, 'a list of ranges gets the whole file');
  await app.close();
});

test('read rules: an unpaired remote request gets 401, a paired viewer gets the page, and a LAN viewer needs the cookie', async () => {
  const dir = tempDir(), store = journal(dir);
  const id = /Saved artifact ([0-9a-f-]{36})/.exec(saveArtifactTool({journal: store, dir: artifactsDir(dir), cat: 'artist', task: 't', project: 't', args: {title: 'P', kind: 'html', content: '<p>x</p>'}}))![1];
  const origin = 'https://test-town.trycloudflare.com';
  const pairing = new Pairing(join(dir, 'devices.json'), config.remote);
  const remote = Fastify();
  installRemoteAccess(remote, pairing, () => origin);
  registerArtifactRoutes(remote, {dir: () => dir, events: () => store.state.events});
  await remote.ready();
  const host = new URL(origin).host;
  assert.equal((await remote.inject({url: `/artifacts/${id}`, headers: {host}})).statusCode, 401, 'unpaired');
  assert.equal((await remote.inject({url: `/artifacts/${id}`, headers: {host}, remoteAddress: '127.0.0.1'})).statusCode, 401, 'unpaired loopback through the tunnel');
  const invite = pairing.create('viewer');
  const {token} = pairing.pair(invite.code, 'Tablet');
  const paired = await remote.inject({url: `/artifacts/${id}`, headers: {host, cookie: `__Host-town_device=${token}`}});
  assert.equal(paired.statusCode, 200);
  assert.equal(paired.headers['x-frame-options'], 'SAMEORIGIN', 'the gallery can frame it on a paired phone');
  assert.equal((await remote.inject({url: `/artifacts/${id}`, headers: {host: 'evil.example'}})).statusCode, 403, 'wrong host');
  await remote.close();

  const lan = Fastify();
  installAccess(lan, true, ['192.168.1.5'], 9999,undefined,undefined,'test-owner');
  registerArtifactRoutes(lan, {dir: () => dir, events: () => store.state.events});
  await lan.ready();
  assert.equal((await lan.inject({url: `/artifacts/${id}`, headers: {host: '192.168.1.5:9999'}, remoteAddress: '192.168.1.5'})).statusCode, 401, 'LAN viewer without the viewing cookie');
  await lan.close();

  const closed = Fastify();
  installAccess(closed, false, [], 9999,undefined,undefined,'test-owner');
  registerArtifactRoutes(closed, {dir: () => dir, events: () => store.state.events});
  await closed.ready();
  assert.equal((await closed.inject({url: `/artifacts/${id}`, headers: {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner', 'x-forwarded-for': '203.0.113.9'}})).statusCode, 403, 'proxied request is never the owner');
  assert.equal((await closed.inject({url: `/artifacts/${id}`, headers: {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner'}})).statusCode, 200, 'the owner on loopback');
  await closed.close();
});

test('a sandboxed artifact page cannot read or write the town API', async () => {
  const app = Fastify();
  installAccess(app, false, [], 9999,undefined,undefined,'test-owner');
  app.get('/api/state', async () => ({cats: ['private']}));
  app.post('/api/pause', async () => ({ok: true}));
  await app.ready();
  // Sandboxed pages have an opaque origin: the browser sends Origin: null and Sec-Fetch-Site: cross-site.
  const sandboxed = {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner', origin: 'null', 'sec-fetch-site': 'cross-site'};
  const read = await app.inject({url: '/api/state', headers: sandboxed});
  assert.equal(read.statusCode, 403);
  assert.ok(!read.body.includes('private'));
  assert.equal(read.headers['access-control-allow-origin'], undefined);
  assert.equal((await app.inject({method: 'POST', url: '/api/pause', headers: {...sandboxed, 'x-town-action': 'owner', 'content-type': 'application/json'}, payload: {value: true}})).statusCode, 403);
  assert.equal((await app.inject({url: '/api/state', headers: {host: 'localhost:9999', cookie: 'town_owner_9999=test-owner', 'sec-fetch-site': 'same-origin'}})).statusCode, 200, 'the owner app still reads');
  await app.close();
});

test('save_artifact runs through a task with a fake provider and lands in the gallery index', async () => {
  const dir = tempDir(), store = journal(dir, allRoles(config));
  const fake = scripted([{name: 'save_artifact', args: {title: 'Cozy page', kind: 'html', content: '<p>hello</p><script>1</script>'}}]);
  const town = new Town(store, config, {fake});
  const id = town.submit('scholar', 'Make a page', 'fake');
  await until(() => store.state.tasks.find(t => t.id === id)?.status === 'done');
  const [record] = artifactIndex(store.state.events);
  assert.equal(record.title, 'Cozy page');
  assert.equal(record.cat, 'scholar');
  assert.equal(record.task, id);
  assert.equal(record.project, id);
  assert.equal(readFileSync(join(artifactsDir(dir), record.file), 'utf8'), '<p>hello</p><script>1</script>');
  assert.ok(toolResults(store).some(r => r.includes(`Saved artifact ${record.id}`) && /Artist's gallery/.test(r)));
});

test('generate_image and generate_video with no provider return guidance and make nothing', async () => {
  const dir = tempDir(), store = journal(dir, allRoles(config));
  const town = new Town(store, config, {fake: scripted([{name: 'generate_image', args: {prompt: 'a cat on a roof', title: 'Roof cat'}}, {name: 'generate_video', args: {prompt: 'a cat jumps', title: 'Jump'}}])});
  const id = town.submit('scholar', 'Draw me a cat', 'fake');
  await until(() => store.state.tasks.find(t => t.id === id)?.status === 'done');
  assert.ok(toolResults(store).some(r => /No image model is configured/.test(r) && /Do not invent/.test(r)));
  assert.ok(toolResults(store).some(r => /No video model is configured/.test(r) && /request_capability/.test(r)));
  assert.equal(artifactIndex(store.state.events).length, 0);
  assert.equal(existsSync(artifactsDir(dir)), false);
});

test('generate_image through a configured adapter stores the PNG; a non-image reply is refused and stores nothing', async () => {
  const dir = tempDir(), store = journal(dir, allRoles(config));
  let reply: unknown = {data: [{b64_json: PNG.toString('base64')}]};
  const seen: {url?: string; auth?: string; body?: any}[] = [];
  const {createServer} = await import('node:http');
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push({url: req.url, auth: req.headers.authorization, body: JSON.parse(raw)});
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as {port: number}).port;
  try {
    const runtime = runtimeFor([openAIImagesAdapter({base: `http://127.0.0.1:${port}/v1/`, model: 'pic-1', key: 'sk-test-key', timeoutMs: 5000})], {allowHttp: true});
    const town = new Town(store, config, {fake: scripted([{name: 'generate_image', args: {prompt: 'a cat painter', title: 'Painter', size: '1024x1024'}}])});
    town.media = () => runtime;
    const id = town.submit('scholar', 'Paint', 'fake');
    await until(() => store.state.tasks.find(t => t.id === id)?.status === 'done');
    assert.equal(seen[0].url, '/v1/images/generations');
    assert.equal(seen[0].auth, 'Bearer sk-test-key');
    assert.equal(seen[0].body.model, 'pic-1');
    assert.equal(seen[0].body.size, '1024x1024');
    const [record] = artifactIndex(store.state.events);
    assert.equal(record.kind, 'image');
    assert.equal(record.mime, 'image/png');
    assert.deepEqual(readFileSync(join(artifactsDir(dir), record.file)), PNG);
    assert.ok(toolResults(store).some(r => r.includes(`Made image ${record.id}`)));

    reply = {data: [{b64_json: Buffer.from('<html>not an image</html>').toString('base64')}]};
    const bad = new Town(store, config, {fake: scripted([{name: 'generate_image', args: {prompt: 'again', title: 'Again'}}])});
    bad.media = () => runtime;
    const badId = bad.submit('scholar', 'Again', 'fake');
    await until(() => store.state.tasks.find(t => t.id === badId)?.status === 'done');
    assert.ok(toolResults(store).some(r => /Tool error: That is not a PNG/.test(r)));
    assert.equal(artifactIndex(store.state.events).length, 1);
    assert.equal(readdirSync(artifactsDir(dir)).length, 1);
  } finally {
    server.close();
  }
});

test('generate_video stores an MP4 from a configured video provider', async () => {
  const dir = tempDir(), store = journal(dir, allRoles(config));
  const town = new Town(store, config, {fake: scripted([{name: 'generate_video', args: {prompt: 'a cat jumps', title: 'Jump', duration: 5}}])});
  town.media = () => fakeRuntime('video', MP4);
  const id = town.submit('scholar', 'Film it', 'fake');
  await until(() => store.state.tasks.find(t => t.id === id)?.status === 'done');
  const [record] = artifactIndex(store.state.events);
  assert.equal(record.kind, 'video');
  assert.equal(record.mime, 'video/mp4');
  assert.match(record.file, /\.mp4$/);
});

test('generate tools validate the prompt, size and duration before any provider call', async () => {
  const dir = tempDir(), store = journal(dir);
  let called = false;
  const runtime: MediaRuntime = {has: () => true, generate: async () => { called = true; return {bytes: PNG, adapter: 'x'}; }};
  const base = {journal: store, dir: artifactsDir(dir), cat: 'c', task: 't', project: 't', runtime, signal: new AbortController().signal};
  await assert.rejects(generateMediaTool({...base, kind: 'image', args: {prompt: 'x', title: 'y', size: 'huge'}}), /size/);
  await assert.rejects(generateMediaTool({...base, kind: 'video', args: {prompt: 'x', title: 'y', duration: 99}}), /duration/);
  await assert.rejects(generateMediaTool({...base, kind: 'image', args: {prompt: '  ', title: 'y'}}), /prompt/);
  await assert.rejects(generateMediaTool({...base, kind: 'image', args: {prompt: 'x', title: ''}}), /title/);
  assert.equal(called, false);
});

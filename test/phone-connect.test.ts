// Item 1.6 of docs/product-plan.md, connect from the phone. The remote listener is wired as server.ts wires it (installRemoteAccess plus
// registerConnectRoutes with phone: true) and asked by a paired owner device, a viewer and the phone's cookieless system browser. Every sign-in
// server and GitHub's whoami answer in memory: no request leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isOwner} from '../src/access.ts';
import {AccountMonitor} from '../src/accounts.ts';
import {ConnectorHub, registerConnectRoutes} from '../src/connectors.ts';
import {Town} from '../src/engine.ts';
import {pollDevice} from '../src/mcp-oauth.ts';
import {Pairing} from '../src/pairing.ts';
import {quests} from '../src/quests.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const PORT = 4321; // the loopback port the hub advertises; nothing listens here
const ORIGIN = 'https://clowder-test.tail1234.ts.net', HOST = new URL(ORIGIN).host;
const LOOPBACK = `http://127.0.0.1:${PORT}/api/connectors/oauth/callback`, REMOTE = `${ORIGIN}/api/connectors/oauth/callback`;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
async function until(fn: () => boolean, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('Timed out'); }
const fakeConnect = (async () => ({info: {}, listTools: async () => [], callTool: async () => ({text: 'ok', isError: false}), close: async () => {}})) as any;

// One sign-in server for every directory URL, plus GitHub's GET /user. device: its metadata lists a device authorization endpoint.
// pendingPolls: device polls answered authorization_pending before the token. failToken: the next code exchange is refused.
function fakeNet(o: {device?: boolean; pendingPolls?: number}) {
  const hits: {url: string; body: string}[] = [], ctl = {failToken: false};
  let polls = 0;
  const f = (async (input: any, init?: any) => {
    const u = new URL(String(input)), body = init?.body ? String(init.body) : '';
    hits.push({url: u.href, body});
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});
    if (u.host === 'api.github.com' && u.pathname === '/user') return new Headers(init?.headers).get('authorization') === 'Bearer ghp_good' ? json(200, {login: 'octo', id: 7}) : json(401, {message: 'Bad credentials'});
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, {resource: `${u.origin}/mcp`, authorization_servers: [u.origin]});
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, {authorization_endpoint: `${u.origin}/authorize`, token_endpoint: `${u.origin}/token`, registration_endpoint: `${u.origin}/register`, code_challenge_methods_supported: ['S256'], ...(o.device ? {device_authorization_endpoint: `${u.origin}/device`} : {})});
    if (u.pathname === '/register') return json(201, {client_id: `client-${hits.filter(h => h.url.endsWith('/register')).length}`});
    if (u.pathname === '/device') return json(200, {device_code: 'dev-code', user_code: 'WDJB-MJHT', verification_uri: `${u.origin}/activate`, verification_uri_complete: `${u.origin}/activate?user_code=WDJB-MJHT`, expires_in: 600, interval: 0});
    if (u.pathname === '/token') {
      if (new URLSearchParams(body).get('grant_type') === DEVICE_GRANT && polls++ < (o.pendingPolls ?? 0)) return json(400, {error: 'authorization_pending'});
      if (ctl.failToken) { ctl.failToken = false; return json(400, {error: 'invalid_grant', error_description: 'code expired'}); }
      return json(200, {access_token: 'fresh-token', expires_in: 3600});
    }
    return json(404, {});
  }) as typeof fetch;
  const count = (path: string) => hits.filter(h => new URL(h.url).pathname === path).length;
  return {f, hits, ctl, count};
}

function world(o: {stable: boolean; device?: boolean; pendingPolls?: number}) {
  const net = fakeNet(o), dataDir = tmp('phone-connect-data-');
  writeFileSync(join(dataDir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  const hub = new ConnectorHub({dataDir, port: PORT, home: tmp('phone-connect-home-'), connect: fakeConnect, fetch: net.f, remote: () => ({origin: ORIGIN, stable: o.stable})});
  const store = new Store(join(tmp('phone-connect-town-'), 'events.jsonl'), allRoles(config));
  const town = new Town(store, config, {test: async () => ({message: {role: 'assistant', content: 'unused'}})});
  town.autonomy = () => 'balanced';
  town.connectors = () => hub;
  hub.health = new AccountMonitor({source: hub, store: () => store});
  const pairing = new Pairing(join(tmp('phone-connect-pair-'), 'devices.json'), config.remote);
  const app = Fastify();
  const access = installRemoteAccess(app, pairing, () => ORIGIN);
  app.setErrorHandler((e: any, _req, res) => res.code(e.statusCode || 400).send({error: e.message}));
  registerConnectRoutes(app, hub, {canWrite: isOwner, town: () => town, phone: true, device: req => access.device(req) ?? 'unpaired'});
  const base = {host: HOST, origin: ORIGIN, 'x-town-action': 'owner'};
  const pair = async (permission: 'owner' | 'viewer', name: string) => {
    const r = await app.inject({method: 'POST', url: '/api/pair', headers: base, payload: {code: pairing.create(permission).code, name}});
    return {headers: {...base, cookie: String(r.headers['set-cookie']).split(';')[0]!}, id: pairing.list().find(d => d.name === name)!.id};
  };
  const connectStep = (id: string, service: string) => store.emit('owner.step', {id, goal: null, cat: 'scholar', title: `Connect ${service}`, steps: 'For the work.', blocking: false, kind: 'account', connect: service});
  const step = (id: string) => store.state.ownerSteps.find(s => s.id === id)!;
  const done = (id: string) => store.state.events.find(e => e.type === 'owner.step.done' && e.data.id === id)?.data;
  const post = (url: string, headers: Record<string, string>, payload: object = {}) => app.inject({method: 'POST', url, headers, payload});
  return {net, hub, store, town, app, base, pair, connectStep, step, done, post, close: async () => { town.dispose(); await hub.dispose(); await app.close(); }};
}

test('on a stable origin a phone sign-in comes back to the remote listener: state alone, no cookie, works once; a replayed or wrong state is refused', async () => {
  const w = world({stable: true});
  try {
    const phone = await w.pair('owner', 'Phone');
    w.connectStep('step-l', 'linear');
    const r = await w.post('/api/owner-steps/step-l/connect', phone.headers);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().finish, 'callback');
    const authorize = new URL(r.json().url), state = authorize.searchParams.get('state')!;
    assert.equal(authorize.searchParams.get('redirect_uri'), REMOTE, 'the phone comes back to the remote listener');
    // One client for both addresses, so a sign-in from this computer reuses it.
    const reg = w.net.hits.filter(h => h.url.endsWith('/register'));
    assert.equal(reg.length, 1);
    assert.deepEqual(JSON.parse(reg[0]!.body).redirect_uris, [REMOTE, LOOPBACK]);
    // The phone's system browser: no cookie, no Origin, cross-site.
    const back = (s: string) => w.app.inject({method: 'GET', url: `/api/connectors/oauth/callback?code=c&state=${s}`, headers: {host: HOST, 'sec-fetch-site': 'cross-site'}});
    const wrong = await back('not-it');
    assert.equal(wrong.statusCode, 200);
    assert.match(wrong.body, /did not match a request from Clowder/);
    assert.equal(w.step('step-l').status, 'open', 'a wrong state changes nothing');
    const ok = await back(state);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /Signed in to Linear\. You can close this tab\./);
    assert.deepEqual(w.done('step-l'), {id: 'step-l', note: 'Connected Linear.', device: phone.id}, 'the step closes, journaled with the phone that started it');
    assert.equal(w.hub.publicConnectors().find(c => c.id === 'linear')!.auth, 'signed-in');
    const replay = await back(state);
    assert.match(replay.body, /did not match a request from Clowder/, 'a state works once');
    assert.equal(w.net.count('/token'), 1, 'the replay never reached the token endpoint');
    // A failed exchange uses the state up too.
    const again = new URL((await w.hub.signIn('linear', {phone: true})).url).searchParams.get('state')!;
    w.net.ctl.failToken = true;
    assert.match((await back(again)).body, /Sign-in failed: code expired/);
    assert.match((await back(again)).body, /did not match a request from Clowder/);
    assert.equal(w.net.count('/token'), 2);
    // From this computer: the loopback callback, the same client.
    const host = await w.hub.signIn('linear');
    assert.deepEqual([new URL(host.url).searchParams.get('redirect_uri'), host.finish], [LOOPBACK, 'callback']);
    assert.equal(w.net.count('/register'), 1, 'no second client');
  } finally { await w.close(); }
});

test('on a Quick Tunnel the phone pastes the address back: a wrong state is refused and changes nothing, the right one finishes', async () => {
  const w = world({stable: false});
  try {
    const phone = await w.pair('owner', 'Phone');
    w.connectStep('step-n', 'notion');
    const r = await w.post('/api/owner-steps/step-n/connect', phone.headers);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().finish, 'paste');
    const authorize = new URL(r.json().url), state = authorize.searchParams.get('state')!;
    assert.equal(authorize.searchParams.get('redirect_uri'), LOOPBACK, 'a Quick Tunnel address is never registered: it dies with the tunnel');
    const paste = (url: string, headers = phone.headers) => w.post('/api/connectors/oauth/paste', headers, {url});
    const wrong = await paste(`${LOOPBACK}?code=c&state=wrong-state`);
    assert.equal(wrong.statusCode, 409);
    assert.match(wrong.json().error, /did not match a request from Clowder/);
    assert.equal(w.step('step-n').status, 'open');
    assert.equal(w.net.count('/token'), 0, 'a wrong state sends no token request');
    const ok = await paste(`  ${LOOPBACK}?code=c&state=${state}  `);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json(), {ok: true, name: 'Notion'});
    assert.deepEqual(w.done('step-n'), {id: 'step-n', note: 'Connected Notion.', device: phone.id});
    assert.equal((await paste(`code=c&state=${state}`)).statusCode, 409, 'the bare query works too, and only once');
  } finally { await w.close(); }
});

test('where the sign-in server lists a device endpoint, a phone gets a device code and the hub polls until it signs in', async () => {
  const w = world({stable: false, device: true, pendingPolls: 2});
  try {
    const phone = await w.pair('owner', 'Phone');
    w.connectStep('step-d', 'linear');
    const r = await w.post('/api/owner-steps/step-d/connect', phone.headers);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().finish, 'device');
    assert.equal(r.json().url, 'https://mcp.linear.app/activate?user_code=WDJB-MJHT');
    assert.equal(r.json().device.userCode, 'WDJB-MJHT');
    await until(() => w.step('step-d').status === 'done');
    const polls = w.net.hits.filter(h => h.url.endsWith('/token')).map(h => Object.fromEntries(new URLSearchParams(h.body)));
    assert.equal(polls.length, 3, 'two pending answers, then the token');
    assert.ok(polls.every(p => p.grant_type === DEVICE_GRANT && p.device_code === 'dev-code' && p.client_id === 'client-1'));
    assert.deepEqual(JSON.parse(w.net.hits.find(h => h.url.endsWith('/register'))!.body).grant_types, ['authorization_code', 'refresh_token', DEVICE_GRANT]);
    assert.deepEqual(w.done('step-d'), {id: 'step-d', note: 'Connected Linear.', device: phone.id});
    assert.equal(w.hub.publicConnectors().find(c => c.id === 'linear')!.auth, 'signed-in');
    // From this computer the browser still comes back by itself, with the same client.
    const host = await w.hub.signIn('linear');
    assert.deepEqual([host.finish, new URL(host.url).searchParams.get('redirect_uri'), w.net.count('/register')], ['callback', LOOPBACK, 1]);
  } finally { await w.close(); }
});

test('a device code poll waits on authorization_pending, slows down on slow_down, and stops on a refusal or the end of its window', async () => {
  const st = {tokenEndpoint: 'https://auth.example/token', clientId: 'c', pending: {state: 's', verifier: '', createdAt: 0, device: {code: 'd', interval: 1, expiresAt: 10_000}}};
  const answer = (j: object) => (async () => new Response(JSON.stringify(j), {status: 400})) as unknown as typeof fetch;
  assert.equal((await pollDevice(st, answer({error: 'authorization_pending'}), 1000)).wait, 1);
  const slow = await pollDevice(st, answer({error: 'slow_down'}), 1000);
  assert.deepEqual([slow.wait, slow.state.pending!.device!.interval], [6, 6]);
  await assert.rejects(pollDevice(st, answer({error: 'access_denied'}), 1000), {message: 'Sign-in failed: access_denied'});
  await assert.rejects(pollDevice(st, answer({error: 'authorization_pending'}), 10_001), /took too long/);
  const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.equal((await pollDevice(st, offline, 1000)).wait, 1, 'no answer at all is asked again');
});

test('a token pasted from an owner device runs whoami at once: a refused one leaves the step open, a good one closes it naming the identity', async () => {
  const w = world({stable: false});
  try {
    const phone = await w.pair('owner', 'Phone');
    w.connectStep('step-g', 'github');
    const bad = await w.post('/api/owner-steps/step-g/connect', phone.headers, {token: 'ghp_bad'});
    assert.equal(bad.statusCode, 409, bad.body);
    assert.equal(bad.json().error, 'GitHub refused the sign-in (HTTP 401).');
    assert.equal(w.step('step-g').status, 'open', 'a refused token closes nothing');
    const good = await w.post('/api/owner-steps/step-g/connect', phone.headers, {token: 'ghp_good'});
    assert.equal(good.statusCode, 200, good.body);
    assert.deepEqual(good.json(), {ok: true, account: {status: 'connected', reason: '', identity: '@octo'}});
    assert.deepEqual(w.done('step-g'), {id: 'step-g', note: 'Connected GitHub as @octo.', device: phone.id});
    assert.equal(w.store.state.accounts.github?.identity, '@octo', 'the verified identity is journaled');
    // The same from the hub, with no quest: the token route.
    const direct = await w.post('/api/connectors/github/token', phone.headers, {token: 'ghp_good'});
    assert.equal(direct.statusCode, 200, direct.body);
    assert.equal(direct.json().account.identity, '@octo');
    assert.equal((await w.post('/api/connectors/github/token', phone.headers, {token: 'ghp_bad'})).json().account.status, 'needs-sign-in');
    assert.equal((await w.post('/api/connectors/nope/token', phone.headers, {token: 't'})).statusCode, 404);
  } finally { await w.close(); }
});

test('a viewer device is refused every connect route, an unpaired client gets 401, and nothing changes', async () => {
  const w = world({stable: true});
  try {
    const viewer = await w.pair('viewer', 'Tablet');
    w.connectStep('step-v', 'github');
    const routes: [string, object][] = [['/api/owner-steps/step-v/connect', {token: 'ghp_good'}], ['/api/connectors/oauth/paste', {url: `${LOOPBACK}?code=c&state=s`}], ['/api/connectors/github/token', {token: 'ghp_good'}], ['/api/connectors/github/sign-in', {}]];
    for (const [url, payload] of routes) {
      assert.equal((await w.post(url, viewer.headers, payload)).statusCode, 403, `viewer ${url}`);
      assert.equal((await w.post(url, w.base, payload)).statusCode, 401, `unpaired ${url}`);
    }
    assert.equal(w.step('step-v').status, 'open');
    assert.equal(w.hub.publicConnectors().length, 0, 'no connector was added');
    assert.equal(w.net.hits.length, 0, 'no request left for a sign-in server or whoami');
  } finally { await w.close(); }
});

test('Continue on your computer: a quest handed off from the phone is listed first on the host, and only for a day', () => {
  const store = new Store(join(tmp('phone-connect-handoff-'), 'events.jsonl'), allRoles(config));
  const town = new Town(store, config, {test: async () => ({message: {role: 'assistant', content: 'unused'}})});
  try {
    store.emit('owner.step', {id: 's-a', goal: null, cat: 'scholar', title: 'Approve the plan', steps: 'Read it.', blocking: true, kind: 'design'});
    store.emit('owner.step', {id: 's-b', goal: null, cat: 'scholar', title: 'Sign in to instagram.com', steps: 'Open https://instagram.com/ and sign in.', blocking: false, kind: 'account', browser: true, mode: 'test'});
    const list = (host: boolean, now = new Date()) => quests({state: store.state, projects: [], capabilities: [], seasons: [], models: null, now, host});
    assert.equal(list(true).find(q => q.id === 'owner-step:s-b')!.computer, true, 'a cats\' browser step finishes only on the computer');
    assert.deepEqual(list(true).map(q => q.id), ['owner-step:s-a', 'owner-step:s-b'], 'rank order before any hand-off');
    town.handoffQuest('owner', 'owner-step:s-b', 'phone-1');
    assert.deepEqual(store.state.events.at(-1)!.data, {id: 'owner-step:s-b', device: 'phone-1'});
    assert.deepEqual(list(true).map(q => q.id), ['owner-step:s-b', 'owner-step:s-a'], 'the host lists the hand-off first');
    assert.deepEqual(list(false).map(q => q.id), ['owner-step:s-a', 'owner-step:s-b'], 'the phone keeps rank order');
    assert.ok(list(false)[1]!.handoff, 'and shows it handed off');
    assert.equal(list(true, new Date(Date.now() + 25 * 3_600_000)).find(q => q.id === 'owner-step:s-b')!.handoff, undefined, 'a day later it is no longer on its way');
    assert.throws(() => town.handoffQuest('mayor', 'owner-step:s-b'), /Only the owner/);
  } finally { town.dispose(); }
});

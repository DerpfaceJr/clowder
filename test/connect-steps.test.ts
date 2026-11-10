import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectorHub, registerConnectorRoutes} from '../src/connectors.ts';
import {Town} from '../src/engine.ts';
import {registerGoalRoutes} from '../src/goals.ts';
import {PENDING_MS} from '../src/mcp-oauth.ts';
import {Pairing, type RemoteConfig} from '../src/pairing.ts';
import type {Provider} from '../src/provider.ts';
import {quests} from '../src/quests.ts';
import {isOwner} from '../src/access.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {untilEvery} from './helpers/until.ts';

// Items 0.5-0.7 of docs/product-plan.md: connect steps close on a real sign-in, a second cat gets a grant, and a control phone closes steps.
const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const PORT = 4321; // the redirect port the hub advertises; nothing listens here
const OWNER = {host: `127.0.0.1:${PORT}`};
const OWNER_WRITE = {...OWNER, 'x-town-action': 'owner'};
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const emptyDataDir = () => { const dir = tmp('connect-steps-data-'); writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []})); return dir; };
const until = untilEvery(20);
const reply = (content: string) => ({message: {role: 'assistant', content}});
const callOf = (name: string, args: unknown) => ({message: {role: 'assistant', content: null, tool_calls: [{id: 'call-' + name, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}});
const fakeClient = {info: {}, listTools: async () => [{name: 'search', annotations: {readOnlyHint: true}}], callTool: async () => ({text: 'ok', isError: false}), close: async () => {}};
const fakeConnect = (async () => fakeClient) as any;
const failingConnect = (async () => { throw new Error('offline for this test'); }) as any;
// One sign-in server for any directory URL, answered in memory: discovery, client registration and the code exchange. No network.
const oauthFetch = (async (input: any) => {
  const u = new URL(String(input)), json = (status: number, v: unknown) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});
  if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, {resource: `${u.origin}/mcp`, authorization_servers: [u.origin]});
  if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, {authorization_endpoint: `${u.origin}/authorize`, token_endpoint: `${u.origin}/token`, registration_endpoint: `${u.origin}/register`, code_challenge_methods_supported: ['S256']});
  if (u.pathname === '/register') return json(201, {client_id: 'client-1'});
  if (u.pathname === '/token') return json(200, {access_token: 'fresh-token', expires_in: 3600});
  return json(404, {});
}) as typeof fetch;
function townFor(hub: ConnectorHub | null, provider: Provider = async () => reply('unused')) {
  const store = new Store(join(tmp('connect-steps-town-'), 'events.jsonl'), allRoles(config));
  const town = new Town(store, config, {test: provider});
  town.autonomy = () => 'balanced';
  town.connectors = () => hub;
  return {store, town};
}
function connectApp(hub: ConnectorHub, town: Town) {
  const app = Fastify();
  app.setErrorHandler((e: any, _req, res) => res.code(e.statusCode || 400).send({error: e.message}));
  registerConnectorRoutes(app, hub, {canWrite: () => true, cats: () => [], town: () => town});
  return app;
}
const connectStep = (store: Store, id: string, service: string, cat = 'scholar') => store.emit('owner.step', {id, goal: null, cat, title: `Connect ${service}`, steps: 'For the work.', blocking: false, kind: 'account', connect: service});
const stepOf = (store: Store, id: string) => store.state.ownerSteps.find(s => s.id === id)!;
const eventOf = (store: Store, type: string, id: string) => store.state.events.find(e => e.type === type && e.data.id === id)?.data;
const questOf = (store: Store, id: string, now: Date) => quests({state: store.state, projects: [], capabilities: [], seasons: [], models: null, now}).find(q => q.id === `owner-step:${id}`)!;

test('a connect step stays open through an abandoned sign-in, says so after the sign-in window, and the callback closes it', async () => {
  const hub = new ConnectorHub({dataDir: emptyDataDir(), port: PORT, home: tmp('connect-steps-home-'), connect: failingConnect, fetch: oauthFetch});
  const {store, town} = townFor(hub);
  const app = connectApp(hub, town);
  try {
    connectStep(store, 'step-l', 'linear');
    const started = await app.inject({method: 'POST', url: '/api/owner-steps/step-l/connect', headers: OWNER_WRITE});
    assert.equal(started.statusCode, 200, started.body);
    const authorize = new URL(started.json().url);
    assert.equal(stepOf(store, 'step-l').status, 'open', 'a sign-in page is not a sign-in');
    const at = Date.parse(stepOf(store, 'step-l').signInAt!);
    assert.ok(at > 0, 'the sign-in time is journaled on the step');
    assert.equal(questOf(store, 'step-l', new Date(at + PENDING_MS - 1000)).detail, 'For the work.', 'inside the window the step reads as before');
    const stale = questOf(store, 'step-l', new Date(at + PENDING_MS + 1000));
    assert.match(stale.detail, /^Sign-in to Linear was not finished\. Tap Connect Linear to sign in again\.\n\nFor the work\.$/);
    assert.equal(stale.connect?.id, 'linear', 'Connect still starts a fresh sign-in');
    const wrong = await app.inject({method: 'GET', url: '/api/connectors/oauth/callback?code=c&state=not-it', headers: OWNER});
    assert.ok(wrong.body.includes('did not match'));
    assert.equal(stepOf(store, 'step-l').status, 'open', 'a callback that does not match closes nothing');
    const done = await app.inject({method: 'GET', url: `/api/connectors/oauth/callback?code=c&state=${authorize.searchParams.get('state')}`, headers: OWNER});
    assert.ok(done.body.includes('Signed in to Linear'), done.body);
    assert.equal(stepOf(store, 'step-l').status, 'done', 'the callback closes the step that started the sign-in');
    assert.deepEqual(eventOf(store, 'owner.step.done', 'step-l'), {id: 'step-l', note: 'Connected Linear.', device: 'host'});
    assert.equal(hub.publicConnectors().find(c => c.id === 'linear')!.auth, 'signed-in');
  } finally { town.dispose(); await hub.dispose(); }
});

test('a token past expiresAt with no refresh token reads expired, and a connect step for it signs in again', async () => {
  const dataDir = emptyDataDir(), home = tmp('connect-steps-home-');
  const first = new ConnectorHub({dataDir, port: PORT, home, connect: failingConnect});
  first.addDirectory('linear');
  first.patchConnector('linear', {enabled: true, cats: ['scholar']});
  await first.dispose();
  const secrets = (oauth: object) => writeFileSync(join(dataDir, 'connector-secrets.json'), JSON.stringify({linear: {vars: {}, oauth}}));
  let clock = 1_000_000;
  const hubAt = () => new ConnectorHub({dataDir, port: PORT, home, connect: fakeConnect, fetch: oauthFetch, now: () => clock});
  const auth = (hub: ConnectorHub) => hub.publicConnectors().find(c => c.id === 'linear')!.auth;
  secrets({accessToken: 'old-token', expiresAt: 2_000_000});
  const hub = hubAt();
  hub.start();
  await until(() => hub.publicConnectors()[0]?.status === 'connected');
  assert.equal(auth(hub), 'signed-in', 'before expiresAt');
  assert.equal(hub.grantable('linear', 'critic'), true, 'connected for the scholar, so the critic would get a grant');
  clock = 2_000_000;
  assert.equal(auth(hub), 'expired', 'at expiresAt, with no refresh token');
  assert.equal(hub.grantable('linear', 'critic'), false, 'an expired service is reconnected, never granted');
  assert.match((await hub.connectService('linear', 'scholar'))?.url ?? '', /\/authorize\?/, 'its connect step hands out a sign-in page');
  await hub.dispose();
  secrets({accessToken: 'old-token', refreshToken: 'refresh', expiresAt: 1});
  const renewable = hubAt();
  assert.equal(auth(renewable), 'signed-in', 'a refresh token can renew it');
  await renewable.dispose();
});

test('a second cat asking for a connected service gets a grant approval; 6 GitHub requests give 1 step and 5 approvals; Allow grants, Deny does not', async () => {
  const hub = new ConnectorHub({dataDir: emptyDataDir(), port: PORT, home: tmp('connect-steps-home-'), connect: fakeConnect});
  const provider: Provider = async messages => {
    if (String(messages.at(-1)?.content ?? '').startsWith('Record for the town')) return reply('Nothing new to record.');
    return messages.some(m => m.role === 'tool') ? reply('Done.') : callOf('request_connection', {service: 'github', reason: 'Push the site.'});
  };
  const {store, town} = townFor(hub, provider);
  const app = connectApp(hub, town);
  const ask = async (cat: string) => { const id = town.submit(cat, 'Ship it', 'test'); await until(() => ['done', 'failed'].includes(store.state.tasks.find(t => t.id === id)?.status ?? '')); };
  const results = () => store.state.events.filter(e => e.type === 'tool.finished' && e.data.name === 'request_connection').map(e => String(e.data.result));
  try {
    const cats = ['builder', 'scholar', 'critic', 'artist', 'merchant', 'operator'];
    await ask(cats[0]!);
    const [step] = store.state.ownerSteps;
    assert.equal(step?.connect, 'github');
    const connected = await app.inject({method: 'POST', url: `/api/owner-steps/${step!.id}/connect`, headers: OWNER_WRITE, payload: {token: 'ghp_test_token'}});
    assert.equal(connected.statusCode, 200, connected.body);
    await until(() => hub.canUse(cats[0]!, 'github'));
    for (const cat of cats.slice(1)) await ask(cat);
    await ask('scholar');
    const grants = store.state.approvals.filter(a => a.gate === 'grant');
    assert.equal(store.state.ownerSteps.length, 1, 'one connect step');
    assert.equal(grants.length, 5, 'five grant approvals, one per other cat');
    assert.deepEqual(grants.map(a => [a.cat, a.service, a.status, a.options]), cats.slice(1).map(cat => [cat, 'github', 'pending', ['Allow', 'Deny']]));
    assert.equal(grants[0]!.question, `Give GitHub to ${store.state.cats.find(c => c.id === 'scholar')!.name}? Push the site.`);
    assert.equal(results().at(-1), 'Already asked the owner to give you GitHub.', 'a second ask while one waits is answered, not filed');
    const allow = grants[0]!, deny = grants[1]!;
    town.decide(allow.id, 'Allow', true, 'phone-1');
    assert.ok(hub.canUse('scholar', 'github'), 'Allow gives the service to the cat');
    assert.deepEqual(eventOf(store, 'approval.resolved', allow.id), {id: allow.id, status: 'approved', answer: 'Allow', device: 'phone-1'});
    town.decide(deny.id, 'Deny', false);
    assert.equal(hub.canUse('critic', 'github'), false, 'Deny gives nothing');
    assert.deepEqual(eventOf(store, 'approval.resolved', deny.id), {id: deny.id, status: 'rejected', answer: 'Deny', device: 'host'});
    // A restart keeps the grants still waiting: their tasks finished long ago.
    town.dispose();
    const restarted = new Town(new Store(store.file, allRoles(config)), config, {test: provider});
    assert.equal(restarted.store.state.approvals.filter(a => a.gate === 'grant' && a.status === 'pending').length, 3);
    restarted.dispose();
  } finally { town.dispose(); await hub.dispose(); }
});

test('an owner device closes and dismisses owner steps, a viewer gets 403, and each event names the device; older events still replay', async () => {
  const remote: RemoteConfig = config.remote;
  const pairing = new Pairing(join(tmp('connect-steps-pair-'), 'devices.json'), remote);
  const origin = 'https://test-town.trycloudflare.com';
  const {store, town} = townFor(null);
  const app = Fastify();
  const access = installRemoteAccess(app, pairing, () => origin);
  app.setErrorHandler((e: any, _req, res) => res.code(e.statusCode || 400).send({error: e.message}));
  // The same wiring as server.ts registerTown on the remote listener.
  registerGoalRoutes(app, {town: () => town, decide: isOwner, device: req => access.device(req) ?? 'unpaired'});
  const headers = {host: new URL(origin).host, origin, 'x-town-action': 'owner'};
  const pair = async (permission: 'viewer' | 'owner', name: string) => {
    const r = await app.inject({method: 'POST', url: '/api/pair', headers, payload: {code: pairing.create(permission).code, name}});
    return {...headers, cookie: String(r.headers['set-cookie']).split(';')[0]!};
  };
  try {
    const control = await pair('owner', 'Phone'), viewer = await pair('viewer', 'Tablet');
    const phone = pairing.list().find(d => d.name === 'Phone')!.id;
    for (const id of ['s1', 's2', 's3']) store.emit('owner.step', {id, goal: null, cat: 'scholar', title: `Step ${id}`, steps: 'Do it.', blocking: false, kind: 'account'});
    assert.equal((await app.inject({method: 'POST', url: '/api/owner-steps/s1/done', headers: viewer, payload: {}})).statusCode, 403, 'a viewer cannot mark done');
    assert.equal((await app.inject({method: 'POST', url: '/api/owner-steps/s1/dismiss', headers: viewer})).statusCode, 403, 'a viewer cannot dismiss');
    assert.equal(stepOf(store, 's1').status, 'open');
    assert.equal((await app.inject({method: 'POST', url: '/api/owner-steps/s1/done', headers: control, payload: {note: 'from the phone'}})).statusCode, 200);
    assert.equal((await app.inject({method: 'POST', url: '/api/owner-steps/s2/dismiss', headers: control})).statusCode, 200);
    assert.deepEqual([stepOf(store, 's1').status, stepOf(store, 's2').status], ['done', 'dismissed']);
    assert.deepEqual(eventOf(store, 'owner.step.done', 's1'), {id: 's1', note: 'from the phone', device: phone});
    assert.deepEqual(eventOf(store, 'owner.step.dismissed', 's2'), {id: 's2', device: phone});
    // Left out, decide falls back to isOwner: a request that is not the host's gets 403.
    const plain = Fastify();
    registerGoalRoutes(plain, {town: () => town});
    assert.equal((await plain.inject({method: 'POST', url: '/api/owner-steps/s3/done', headers: {host: 'example.com'}, payload: {}})).statusCode, 403);
    assert.equal((await plain.inject({method: 'POST', url: '/api/owner-steps/s3/done', headers: OWNER, payload: {}})).statusCode, 200);
    assert.equal(eventOf(store, 'owner.step.done', 's3').device, 'host');
    // A journal written before `device` existed replays the same.
    const file = join(tmp('connect-steps-old-'), 'events.jsonl');
    const line = (type: string, data: object) => JSON.stringify({id: type + Math.random(), at: '2026-11-01T00:00:00.000Z', type, data});
    writeFileSync(file, [line('founded', {cats: allRoles(config)}), line('owner.step', {id: 'old', goal: null, cat: 'scholar', title: 'Old', steps: 'x', blocking: false}), line('owner.step.done', {id: 'old', note: 'done then'})].join('\n') + '\n');
    assert.equal(new Store(file, []).state.ownerSteps[0]!.status, 'done');
  } finally { town.dispose(); }
});

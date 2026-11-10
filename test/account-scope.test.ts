// Account scope (plan 10.8, D14 a): owner-only by default; the owner marks an account team-scoped; a member's tree reaches team-scoped accounts
// only, and its call to any other account is a card only the owner answers. The member is synthetic until attribution (10.6) passes a real `by`.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopeOf} from '../src/accounts.ts';
import {ConnectorHub, registerConnectorRoutes} from '../src/connectors.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const PORT = 4322; // the redirect port the hub advertises; nothing listens here
const OWNER = {host: `127.0.0.1:${PORT}`, cookie: `town_owner_${PORT}=test-owner`, 'x-town-action': 'owner'};
const MEMBER = 'person-member-1';
const SEARCH = 'mcp__context7__search';
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const fakeClient = {info: {}, listTools: async () => [{name: 'search', annotations: {readOnlyHint: true}}], callTool: async (name: string) => ({text: `ran ${name}`, isError: false}), close: async () => {}};
const connect = (async () => fakeClient) as any;
const until = untilEvery(25, 15000);
// A fresh install seeds Context7 (read-only, every cat): its search is allowed with no card, so any card below comes from the scope alone.
async function seeded(dataDir = tmp('scope-data-')) {
  const hub = new ConnectorHub({dataDir, port: PORT, home: tmp('scope-home-'), connect});
  hub.start();
  await until(() => hub.publicConnectors().find(c => c.id === 'context7')?.status === 'connected');
  return {hub, dataDir};
}
function appFor(hub: ConnectorHub, canWrite = () => true) {
  const app = Fastify();
  app.setErrorHandler((e: any, _req, res) => res.code(e.statusCode || 400).send({error: e.message}));
  registerConnectorRoutes(app, hub, {canWrite, cats: () => [], town: () => ({} as any)});
  return app;
}
const scopeIn = (dataDir: string, id: string) => JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')).accounts.find((a: any) => a.id === id)?.scope;
const reply = (content: string) => ({message: {role: 'assistant', content}});
const callSearch = {message: {role: 'assistant', content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: SEARCH, arguments: '{"q":"x"}'}}]}};
function townWith(hub: ConnectorHub, actor?: string) {
  const provider: Provider = async messages => String(messages.at(-1)?.content ?? '').startsWith('Record for the town') ? reply('Nothing new to record.')
    : messages.some(m => m.role === 'tool') ? reply('done') : callSearch;
  const store = new Store(join(tmp('scope-town-'), 'events.jsonl'), allRoles(config));
  const town = new Town(store, config, {test: provider});
  town.autonomy = () => 'balanced';
  town.connectors = () => hub;
  if (actor) town.actorOf = () => actor;
  return {store, town};
}

test('every account is owner-only by default, the listing says so, and loading an older file writes nothing', async () => {
  assert.equal(scopeOf(undefined), 'owner');
  assert.equal(scopeOf({}), 'owner');
  assert.equal(scopeOf({scope: 'nonsense' as any}), 'owner', 'anything but team on disk is owner-only');
  assert.equal(scopeOf({scope: 'team'}), 'team');
  const {hub, dataDir} = await seeded();
  try {
    assert.ok(hub.publicConnectors().length > 0);
    for (const c of hub.publicConnectors()) assert.equal(c.scope, 'owner', `${c.id} reads as owner`);
    assert.equal(scopeIn(dataDir, 'context7'), undefined, 'owner-only is stored as no key');
  } finally { await hub.dispose(); }
  const before = statSync(join(dataDir, 'accounts.json')).mtimeMs, text = readFileSync(join(dataDir, 'accounts.json'), 'utf8');
  const again = new ConnectorHub({dataDir, port: PORT, home: tmp('scope-home-'), connect});
  try {
    assert.equal(again.publicConnectors().find(c => c.id === 'context7')?.scope, 'owner');
    assert.equal(readFileSync(join(dataDir, 'accounts.json'), 'utf8'), text);
    assert.equal(statSync(join(dataDir, 'accounts.json')).mtimeMs, before, 'no migration write');
  } finally { await again.dispose(); }
});

test('an owner call is unchanged: the same hit with or without the owner named, no ownerOnly, and it runs with no card', async () => {
  const {hub} = await seeded();
  try {
    const hit = hub.resolve('mayor', SEARCH);
    assert.deepEqual(hit, {connector: 'context7', label: 'Context7', tool: 'search', permission: 'allow', effect: 'read', identity: null});
    assert.deepEqual(hub.resolve('mayor', SEARCH, 'owner'), hit);
    assert.ok(!('ownerOnly' in hit!));
    const {store, town} = townWith(hub);
    const id = town.submit('mayor', 'Search', 'test');
    await until(() => store.state.tasks.find(t => t.id === id)?.status === 'done');
    assert.equal(store.state.approvals.length, 0);
    town.dispose();
  } finally { await hub.dispose(); }
});

test('a member tree reaches a team-scoped account: allowed, no card', async () => {
  const {hub, dataDir} = await seeded();
  const app = appFor(hub);
  try {
    const r = await app.inject({method: 'PUT', url: '/api/accounts/context7/scope', headers: OWNER, payload: {scope: 'team'}});
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), {id: 'context7', scope: 'team'});
    assert.equal(hub.publicConnectors().find(c => c.id === 'context7')?.scope, 'team', 'the hub’s listing shows it');
    hub.patchConnector('context7', {tools: {search: 'allow'}});
    assert.equal(scopeIn(dataDir, 'context7'), 'team', 'a later write keeps the scope');
    const hit = hub.resolve('mayor', SEARCH, MEMBER);
    assert.equal(hit?.permission, 'allow');
    assert.ok(!('ownerOnly' in hit!));
    const {store, town} = townWith(hub, MEMBER);
    const id = town.submit('mayor', 'Search', 'test');
    await until(() => store.state.tasks.find(t => t.id === id)?.status === 'done');
    assert.equal(store.state.approvals.length, 0);
    town.dispose();
    // Back to owner-only: the key goes, as an older file has it.
    assert.equal((await app.inject({method: 'PUT', url: '/api/accounts/context7/scope', headers: OWNER, payload: {scope: 'owner'}})).statusCode, 200);
    assert.equal(scopeIn(dataDir, 'context7'), undefined);
    assert.equal(hub.resolve('mayor', SEARCH, MEMBER)?.permission, 'ask');
  } finally { await hub.dispose(); }
  const again = new ConnectorHub({dataDir, port: PORT, home: tmp('scope-home-'), connect});
  try { assert.equal(again.publicConnectors().find(c => c.id === 'context7')?.scope, 'owner'); } finally { await again.dispose(); }
});

test('a member tree’s call to an owner-only account files a card only the owner answers, whatever Always allow says', async () => {
  const {hub} = await seeded();
  try {
    hub.patchConnector('context7', {tools: {search: 'allow'}});
    assert.deepEqual(hub.resolve('mayor', SEARCH, MEMBER), {connector: 'context7', label: 'Context7', tool: 'search', permission: 'ask', effect: 'read', identity: null, ownerOnly: true});
    const {store, town} = townWith(hub, MEMBER);
    const id = town.submit('mayor', 'Search', 'test');
    await until(() => store.state.approvals.some(a => a.status === 'pending'));
    const card = store.state.approvals.find(a => a.status === 'pending')! as any;
    assert.equal(card.gate, 'connector');
    assert.equal(card.ownerOnly, true);
    assert.equal(card.question, 'Mayor wants to use Context7: search');
    assert.equal(store.state.tasks.find(t => t.id === id)?.status, 'waiting');
    town.dispose();
  } finally { await hub.dispose(); }
});

test('only the owner changes a scope: a non-owner, or a request canWrite refuses, gets 403 and nothing changes; an unknown account is 404', async () => {
  const {hub, dataDir} = await seeded();
  try {
    const foreign = await appFor(hub).inject({method: 'PUT', url: '/api/accounts/context7/scope', headers: {host: 'town.example', 'x-town-action': 'owner'}, payload: {scope: 'team'}});
    assert.equal(foreign.statusCode, 403);
    const refused = await appFor(hub, () => false).inject({method: 'PUT', url: '/api/accounts/context7/scope', headers: OWNER, payload: {scope: 'team'}});
    assert.equal(refused.statusCode, 403);
    assert.equal(hub.publicConnectors().find(c => c.id === 'context7')?.scope, 'owner');
    assert.equal(scopeIn(dataDir, 'context7'), undefined);
    assert.equal((await appFor(hub).inject({method: 'PUT', url: '/api/accounts/nope/scope', headers: OWNER, payload: {scope: 'team'}})).statusCode, 404);
    assert.equal((await appFor(hub).inject({method: 'PUT', url: '/api/accounts/context7/scope', headers: OWNER, payload: {scope: 'everyone'}})).statusCode, 400);
  } finally { await hub.dispose(); }
});

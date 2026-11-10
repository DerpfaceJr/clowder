// Plan 11.1: a follow-up carries `parent` and joins its request's thread, Retry resubmits an interrupted or failed request inside
// its thread, and an interrupted root reads "interrupted" with its reason. The real server runs in this process on a scratch port with a
// temp CAT_TOWN_DATA; demo mode only, so no model is called.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';

const ORIGIN = 'https://follow-up.trycloudflare.com', DAY = 86_400_000, OWNER_KEY = 'follow-up-owner-key';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const tokens = {owner: randomBytes(32).toString('hex'), member: randomBytes(32).toString('hex')};
let dir = '', port = 0, app: FastifyInstance, remoteApp: FastifyInstance, worlds: {store: any; town: any};
const realFetch = globalThis.fetch;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'follow-up-'));
  const now = Date.now(), device = (id: string, permission: string, extra = {}) => ({id, name: id, permission, tokenHash: sha(tokens[id as keyof typeof tokens]), createdAt: now, expiresAt: now + 20 * DAY, ...extra});
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  writeFileSync(join(dir, 'devices.json'), JSON.stringify([device('owner', 'owner', {person: 'owner'}), device('member', 'member', {person: 'p-member'})]));
  writeFileSync(join(dir, 'people.json'), JSON.stringify([{id: 'p-member', name: 'Member', role: 'member', createdAt: now}]));
  globalThis.fetch = (async () => new Response(null, {status: 503})) as typeof fetch;
  port = 30000 + Math.floor(Math.random() * 20000);
  Object.assign(process.env, {PORT: String(port), CAT_REMOTE_PORT: String(port + 1), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_TOWN_LAN: '0', CAT_OWNER_KEY: OWNER_KEY});
  const server = await import('../src/server.ts');
  ({app, remoteApp} = server);
  worlds = server.worlds as any;
  server.tunnel.origin = ORIGIN;
});
after(async () => { await app?.close(); globalThis.fetch = realFetch; rmSync(dir, {recursive: true, force: true}); });

const host = () => ({host: `localhost:${port}`, 'x-town-action': 'owner', 'content-type': 'application/json', cookie: `town_owner_${port}=${OWNER_KEY}`});
const remote = (who: keyof typeof tokens) => ({host: new URL(ORIGIN).host, origin: ORIGIN, 'x-town-action': 'owner', 'content-type': 'application/json', cookie: `__Host-town_device=${tokens[who]}`});
const chat = (payload: object, headers = host(), server = app) => server.inject({method: 'POST', url: '/api/chat', headers, payload});
const projects = async () => { const r = await app.inject({method: 'GET', url: '/api/projects', headers: host()}); assert.ok(Array.isArray(r.json()), r.body); return r.json() as {id: string; status: string; reason: string | null}[]; };
const task = (id: string) => worlds.store.state.tasks.find((t: {id: string}) => t.id === id);
const children = (id: string) => worlds.store.state.tasks.filter((t: {parent?: string}) => t.parent === id);

// Demo work finishes on its own, but its first step asks the owner a question: answer each pending decision, then wait for the task.
async function settle(id: string) {
  for (let i = 0; i < 400; i++) {
    for (const a of worlds.store.state.approvals.filter((a: {task: string; status: string}) => a.task === id && a.status === 'pending')) {
      await app.inject({method: 'POST', url: `/api/approvals/${a.id}`, headers: host(), payload: {answer: a.options[0], approved: true}});
    }
    const s = task(id)?.status;
    if (s && !['queued', 'running', 'waiting', 'waiting_child'].includes(s)) return s;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`task ${id} did not settle: ${task(id)?.status}`);
}
const rootOf = async (text: string) => {
  const r = await chat({cat: 'mayor', text, mode: 'demo'});
  assert.equal(r.statusCode, 200, r.body);
  return (r.json() as {task: string}).task;
};

test('a follow-up with parent joins its request: 3 roots stay 3, the thread holds the follow-up, and a control without parent makes a 4th', async () => {
  const ids: string[] = [];
  for (const text of ['Draft a cat cafe menu', 'Name three ferries', 'Count the lamps']) { const id = await rootOf(text); await settle(id); ids.push(id); }
  assert.equal((await projects()).length, 3);
  const follow = await chat({cat: 'mayor', text: 'Follow up: make it shorter', mode: 'demo', parent: ids[0]});
  assert.equal(follow.statusCode, 200, follow.body);
  const childId = (follow.json() as {task: string}).task;
  await settle(childId);
  assert.equal(task(childId).parent, ids[0]);
  assert.equal((await projects()).length, 3, 'a follow-up is not a new root');
  const thread = JSON.stringify((await app.inject({method: 'GET', url: `/api/threads/${ids[0]}`, headers: host()})).json());
  assert.ok(thread.includes('Follow up: make it shorter'), 'the thread returns the follow-up');
  await settle(await rootOf('Control with no parent'));
  assert.equal((await projects()).length, 4, 'the control: the same message without parent is a 4th root');
});

test('an interrupted root reads interrupted with its reason; Retry adds one child with the same text and cat, under the same root', async () => {
  const id = await rootOf('Water the garden');
  await settle(id);
  worlds.store.emit('task.updated', {id, status: 'interrupted', result: 'Server restarted during work. Send a new message to retry.'});
  const p = (await projects()).find(x => x.id === id)!;
  assert.equal(p.status, 'interrupted');
  assert.equal(p.reason, 'Server restarted during work. Send a new message to retry.');
  const before = children(id).length;
  const retry = await app.inject({method: 'POST', url: `/api/tasks/${id}/retry`, headers: host(), payload: {}});
  assert.equal(retry.statusCode, 200, retry.body);
  const added = children(id).slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].text, 'Water the garden');
  assert.equal(added[0].cat, task(id).cat);
  await settle(added[0].id);
  assert.equal((await projects()).length, 5, 'retry is a child, so no new root');
});

test('a member follows up on their own request only; a parent on the owner request gets 403', async () => {
  const ownerRoot = await rootOf('Owner-only request');
  await settle(ownerRoot);
  const memberFollow = await chat({cat: 'mayor', text: 'Member tries the owner request', mode: 'demo', parent: ownerRoot}, remote('member'), remoteApp);
  assert.equal(memberFollow.statusCode, 403, memberFollow.body);
  const own = await chat({cat: 'mayor', text: 'A member request', mode: 'demo'}, remote('member'), remoteApp);
  assert.equal(own.statusCode, 200, own.body);
  const memberRoot = (own.json() as {task: string}).task;
  await settle(memberRoot);
  const ok = await chat({cat: 'mayor', text: 'Member follow-up', mode: 'demo', parent: memberRoot}, remote('member'), remoteApp);
  assert.equal(ok.statusCode, 200, ok.body);
  await settle((ok.json() as {task: string}).task);
  // The owner does not write inside a member's request as that member (plan 10.6): a new request instead.
  const ownerInMember = await chat({cat: 'mayor', text: 'Owner steers the member request', mode: 'demo', parent: memberRoot});
  assert.equal(ownerInMember.statusCode, 403, ownerInMember.body);
});

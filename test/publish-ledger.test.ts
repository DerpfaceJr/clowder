// The publish ledger (plan 0.1) and unknown outcomes (plan 0.2), through the real ConnectorHub. Only the MCP client is a stand-in.
import {mock, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConnectorHub, effectOf} from '../src/connectors.ts';
import {McpError, connectMcp} from '../src/mcp-client.ts';
import {allRoles} from '../src/roles.ts';
import {Town} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import type {Provider} from '../src/provider.ts';
import type {McpCallResult} from '../src/connector-types.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));
const PUBLISH = 'mcp__instagram__publish_reel', READ = 'mcp__instagram__get_media';
const REEL = {video: 'clip.mp4', caption: 'Cats at dusk'};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
// Counts turns, not the clock: the Date mock below must not stop it.
async function until(fn: () => boolean) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('Timed out waiting for state transition'); }

// One Instagram account as the service sees it. calls: every publish that reached it; posts: the ones that went up.
// publish(n) answers the nth publish call (0-based); by default each one posts and returns its media id.
function service(publish?: (n: number, post: () => McpCallResult) => Promise<McpCallResult>) {
  const calls: any[] = [], posts: any[] = [], reads: any[] = [];
  const post = () => { posts.push(calls.at(-1)); return {text: `{"id":"media-${posts.length}"}`, isError: false}; };
  const client = {
    info: {}, close: async () => {},
    listTools: async () => [{name: 'publish_reel', inputSchema: {type: 'object'}}, {name: 'get_media', inputSchema: {type: 'object'}, annotations: {readOnlyHint: true}}],
    callTool: async (name: string, args: any) => {
      if (name === 'get_media') { reads.push(args); return {text: 'media-1, media-2', isError: false}; }
      calls.push(args);
      return publish ? publish(calls.length - 1, post) : post();
    },
  };
  return {client, calls, posts, reads};
}
// The owner's Instagram connector, given to two cats, publish_reel on Always allow (as in M2).
async function hubFor(client: object) {
  const hub = new ConnectorHub({dataDir: tmp('ledger-hub-'), port: 4321, home: tmp('ledger-home-'), connect: (async () => client) as any});
  hub.addCustom({name: 'Instagram', type: 'http', url: 'https://example.com/mcp'});
  hub.patchConnector('instagram', {enabled: true, cats: ['scholar', 'critic'], tools: {publish_reel: 'allow'}});
  await until(() => hub.publicConnectors().find(c => c.id === 'instagram')?.status === 'connected');
  return hub;
}
const reply = (content: string) => ({message: {role: 'assistant', content}});
const callOf = (name: string, args: unknown, n = 0) => ({message: {role: 'assistant', content: null, tool_calls: [{id: `call-${n}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}});
const toolTexts = (messages: any[]) => messages.filter(m => m.role === 'tool').map(m => String(m.content));
// Each cat makes the calls in `plan` one per turn, then reports. The recorder's own call is answered and not seen.
function scripted(plan: (cat: string) => [string, unknown][]) {
  const seen = new Map<string, string[]>();
  const provider: Provider = async messages => {
    if (String(messages.at(-1)?.content ?? '').startsWith('Record for the town')) return reply('Nothing new to record.');
    const cat = /CAT_ID=(\S+)/.exec(String(messages[0].content))![1], done = toolTexts(messages), next = plan(cat)[done.length];
    seen.set(cat, done);
    return next ? callOf(next[0], next[1], done.length) : reply('Report.');
  };
  return {provider, seen};
}
function townFor(hub: ConnectorHub, provider: Provider, file = join(tmp('ledger-'), 'events.jsonl')) {
  const store = new Store(file, allRoles(config));
  const town = new Town(store, config, {test: provider});
  town.connectors = () => hub;
  return {file, store, town};
}
const finished = (store: Store, id: string) => until(() => ['done', 'failed', 'cancelled', 'interrupted'].includes(store.state.tasks.find(t => t.id === id)?.status ?? ''));
const pending = (store: Store) => store.state.approvals.filter(a => a.status === 'pending');
const effectEvents = (store: Store) => store.state.events.filter(e => e.type.startsWith('effect.'));

test('M2 replay: two cats post the same Reel 37 s apart; one post reaches Instagram and the second cat gets the first media id', async () => {
  mock.timers.enable({apis: ['Date'], now: Date.parse('2026-11-02T10:00:00Z')});
  const svc = service(), hub = await hubFor(svc.client);
  try {
    // The second cat writes the same arguments in another key order: the ledger reads them as the same call.
    const {provider, seen} = scripted(cat => [[PUBLISH, cat === 'scholar' ? REEL : {caption: REEL.caption, video: REEL.video}]]);
    const {store, town} = townFor(hub, provider);
    await finished(store, town.submit('scholar', 'Post the reel', 'test'));
    mock.timers.tick(37_000);
    await finished(store, town.submit('critic', 'Post the reel', 'test'));
    assert.equal(svc.calls.length, 1, 'exactly one publish reached the service');
    assert.equal(svc.posts.length, 1);
    assert.equal(seen.get('scholar')![0], '{"id":"media-1"}');
    assert.match(seen.get('critic')![0], /^Not sent again: this exact call already went through 37 s ago \(made by scholar\)\. Its result: \{"id":"media-1"\}$/);
    assert.deepEqual(effectEvents(store).map(e => e.type), ['effect.intended', 'effect.done'], 'the refused duplicate journals nothing');
    assert.ok(!JSON.stringify(effectEvents(store)).includes('clip.mp4'), 'the ledger keeps a hash, never the arguments');
    assert.equal(pending(store).length, 0, 'Always allow asks nobody for the first post');
  } finally { mock.timers.reset(); await hub.dispose(); }
});

test('a publish that times out is unknown: the retry is refused, one owner card asks, a stop keeps it, and No allows the retry', async () => {
  // The service gives up answering, then posts anyway: the client's timeout fires first, as at 300 s in M4.
  const svc = service(async (n, post) => {
    if (n > 0) return post();
    setTimeout(post, 60);
    await new Promise(r => setTimeout(r, 20));
    throw new McpError('Connector call timed out.', {unsettled: true});
  });
  const hub = await hubFor(svc.client);
  try {
    // The scholar retries the same post after the timeout, as four tasks did on 10-31.
    const {provider, seen} = scripted(cat => cat === 'scholar' ? [[PUBLISH, REEL], [PUBLISH, REEL]] : [[PUBLISH, REEL]]);
    const {store, town} = townFor(hub, provider);
    const id = town.submit('scholar', 'Post the reel', 'test');
    await finished(store, id);
    assert.equal(store.state.tasks.find(t => t.id === id)?.status, 'done', 'the card never pauses the task');
    const [first, retry] = seen.get('scholar')!;
    assert.match(first, /timed out\. The call may have gone through anyway\. Do not retry it: check with a read tool/);
    assert.match(retry, /may already have gone through: no answer came\. .*Do not retry it; check with a read tool\./);
    assert.equal(svc.calls.length, 1, 'the retry never reached the service');
    await until(() => svc.posts.length === 1);
    const cards = pending(store);
    assert.equal(cards.length, 1, 'exactly one owner card');
    assert.equal(cards[0].gate, 'effect');
    assert.deepEqual(cards[0].options, ['Yes', 'No']);
    assert.ok(!cards[0].question.includes('clip.mp4') && cards[0].detail === undefined, 'the card names the tool, not the arguments');
    town.pause(true); town.pause(false);
    assert.equal(pending(store)[0]?.id, cards[0].id, 'stopping the town does not drop the question');
    assert.throws(() => town.decide(cards[0].id, 'maybe', true), /Answer Yes or No/);
    town.decide(cards[0].id, 'No', false);
    assert.equal(store.state.approvals.find(a => a.id === cards[0].id)?.status, 'rejected');
    await finished(store, town.submit('critic', 'Post the reel', 'test'));
    assert.equal(svc.calls.length, 2, 'after No the same post may be made again');
    assert.equal(seen.get('critic')![0], '{"id":"media-2"}');
  } finally { await hub.dispose(); }
});

test('Yes settles an unknown post as done, and a call in flight at a restart becomes unknown with one card', async () => {
  const svc = service(async () => { throw new McpError('HTTP 502: bad gateway', {status: 502}); });
  const hub = await hubFor(svc.client);
  try {
    const {provider, seen} = scripted(() => [[PUBLISH, REEL]]);
    const {file, store, town} = townFor(hub, provider);
    await finished(store, town.submit('scholar', 'Post the reel', 'test'));
    town.decide(pending(store)[0].id, 'Yes', true);
    await finished(store, town.submit('critic', 'Post the reel', 'test'));
    assert.equal(svc.calls.length, 1);
    assert.match(seen.get('critic')![0], /^Not sent again: .*Its result: The owner confirmed it went through\.$/);
    // A call journaled as intended with no outcome: the server stopped mid-call.
    store.emit('effect.intended', {key: 'instagram:publish_reel:abc', account: 'instagram', tool: 'publish_reel', hash: 'abc', kind: 'public', cat: 'scholar', task: 'gone'});
    town.dispose();
    const again = new Store(file, allRoles(config)), next = new Town(again, config, {test: provider});
    assert.equal(again.state.effects['instagram:publish_reel:abc'].status, 'unknown');
    assert.deepEqual(pending(again).map(a => [a.gate, a.effect]), [['effect', 'instagram:publish_reel:abc']]);
    next.dispose();
    const third = new Town(new Store(file, allRoles(config)), config, {test: provider});
    assert.equal(pending(third.store).length, 1, 'a second restart neither drops nor repeats the card');
    third.dispose();
  } finally { await hub.dispose(); }
});

test('an error answer is a failure, so the retry goes out; the same post made in parallel is refused while the first runs', async () => {
  const svc = service(async (n, post) => n === 0 ? {text: 'Rate limited', isError: true} : (await new Promise(r => setTimeout(r, 100)), post()));
  const hub = await hubFor(svc.client);
  try {
    const {provider, seen} = scripted(cat => cat === 'scholar' ? [[PUBLISH, REEL], [PUBLISH, REEL]] : [[PUBLISH, REEL]]);
    const {store, town} = townFor(hub, provider);
    const id = town.submit('scholar', 'Post the reel', 'test');
    await until(() => svc.calls.length === 2);
    await finished(store, town.submit('critic', 'Post the reel', 'test'));
    await finished(store, id);
    assert.equal(seen.get('scholar')![0], 'Error from Instagram: Rate limited');
    assert.equal(seen.get('scholar')![1], '{"id":"media-1"}', 'the retry after a definite failure went out');
    assert.match(seen.get('critic')![0], /running now in other work\. Do not retry it/);
    assert.equal(svc.calls.length, 2);
    assert.deepEqual(effectEvents(store).map(e => e.type), ['effect.intended', 'effect.failed', 'effect.intended', 'effect.done']);
    assert.equal(store.state.approvals.length, 0);
  } finally { await hub.dispose(); }
});

test('read tools are never ledgered', async () => {
  const svc = service(), hub = await hubFor(svc.client);
  try {
    const {provider} = scripted(() => [[READ, {id: 'media-1'}], [READ, {id: 'media-1'}]]);
    const {store, town} = townFor(hub, provider);
    await finished(store, town.submit('scholar', 'Check the reel', 'test'));
    await finished(store, town.submit('critic', 'Check the reel', 'test'));
    assert.equal(svc.reads.length, 4, 'every read reaches the service');
    assert.equal(effectEvents(store).length, 0);
    assert.equal(store.state.approvals.length, 0);
  } finally { await hub.dispose(); }
});

test('a different post on the same account within 10 min asks the owner even under Always allow; after the window it does not', async () => {
  mock.timers.enable({apis: ['Date'], now: Date.parse('2026-11-02T10:00:00Z')});
  const svc = service(), hub = await hubFor(svc.client);
  try {
    const {provider} = scripted(cat => [[PUBLISH, {...REEL, video: `${cat}.mp4`}]]);
    const {store, town} = townFor(hub, provider);
    await finished(store, town.submit('scholar', 'Post a reel', 'test'));
    mock.timers.tick(5 * 60_000);
    const id = town.submit('critic', 'Post a reel', 'test');
    await until(() => pending(store).length === 1);
    const [card] = pending(store);
    assert.equal(card.gate, 'connector');
    assert.deepEqual(card.options, ['Allow once', 'Deny'], 'already Always allow, so the card offers no Always allow');
    assert.match(card.question, /publish_reel again: a call to it went out 5 min ago with other arguments$/);
    assert.equal(svc.calls.length, 1, 'nothing runs while the owner decides');
    town.decide(card.id, 'Allow once', true);
    await finished(store, id);
    assert.equal(svc.posts.length, 2);
    mock.timers.tick(11 * 60_000);
    await finished(store, town.submit('scholar', 'Post another reel', 'test'));
    assert.equal(svc.calls.length, 2, 'the scholar’s same reel is still a duplicate');
    const fresh = scripted(() => [[PUBLISH, {...REEL, video: 'third.mp4'}]]);
    town.providers.test = fresh.provider;
    await finished(store, town.submit('critic', 'Post a third reel', 'test'));
    assert.equal(svc.posts.length, 3, 'past the window a new post asks nobody');
    assert.equal(store.state.approvals.length, 1);
  } finally { mock.timers.reset(); await hub.dispose(); }
});

test('the ledger survives a store reopen', async () => {
  const svc = service(), hub = await hubFor(svc.client);
  try {
    const {provider, seen} = scripted(() => [[PUBLISH, REEL]]);
    const first = townFor(hub, provider);
    await finished(first.store, first.town.submit('scholar', 'Post the reel', 'test'));
    first.town.dispose();
    const {store, town} = townFor(hub, provider, first.file);
    assert.equal(Object.values(store.state.effects)[0]?.status, 'done');
    await finished(store, town.submit('critic', 'Post the reel', 'test'));
    assert.equal(svc.calls.length, 1);
    assert.match(seen.get('critic')![0], /Its result: \{"id":"media-1"\}$/);
  } finally { await hub.dispose(); }
});

test('tools are classed by the owner’s override, then annotations, then name', () => {
  const t = (name: string, annotations?: object) => ({name, inputSchema: {}, ...(annotations ? {annotations} : {})});
  const none = {};
  assert.equal(effectOf(none, t('publish_reel')), 'public');
  assert.equal(effectOf(none, t('sendMessage')), 'public');
  assert.equal(effectOf(none, t('get_post')), 'read');
  assert.equal(effectOf(none, t('delete_comment')), 'delete');
  assert.equal(effectOf(none, t('create_payment')), 'money');
  assert.equal(effectOf(none, t('write_page')), 'write');
  assert.equal(effectOf(none, t('post_comment', {readOnlyHint: true})), 'read');
  for (const name of ['sell_stock', 'trade', 'swap_tokens', 'deposit_cash', 'withdraw_funds', 'create_withdrawal']) assert.equal(effectOf(none, t(name)), 'money', name);
  assert.equal(effectOf(none, t('sell_stock', {readOnlyHint: true})), 'money', 'no hint talks a money word out of its card');
  assert.equal(effectOf(none, t('get_trade', {readOnlyHint: true})), 'read', 'a read verb still reads');
  assert.equal(effectOf({effects: {sell_stock: 'read'}}, t('sell_stock')), 'read', 'the owner’s override still wins');
  assert.equal(effectOf(none, t('sync', {destructiveHint: true})), 'delete');
  assert.equal(effectOf(none, t('publish', {idempotentHint: true})), 'write');
  assert.equal(effectOf(none, t('send_note', {openWorldHint: false})), 'write');
  assert.equal(effectOf(none, t('update', {openWorldHint: true})), 'public');
  assert.equal(effectOf({effects: {write_page: 'public'}}, t('write_page')), 'public');
  assert.equal(effectOf({effects: {publish_reel: 'nonsense'}}, t('publish_reel')), 'public', 'an unknown override is ignored');
});

test('the client marks a sent call it stopped waiting for, and the hub passes that on as unknown; an error answer is not unknown', async () => {
  const c = await connectMcp({type: 'stdio', command: process.execPath, args: [FIXTURE]});
  try {
    await assert.rejects(c.callTool('slow', {}, {timeoutMs: 200}), {message: 'Connector call timed out.', unsettled: true});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(c.callTool('slow', {}, {signal: ac.signal}), {message: 'Stopped by owner.', unsettled: true});
  } finally { await c.close(); }
  for (const [error, unknown] of [[new McpError('HTTP 503: down', {status: 503}), true], [new McpError('-32602: Unknown tool'), false], [new McpError('HTTP 400: bad', {status: 400}), false]] as const) {
    const hub = await hubFor({...service().client, callTool: async () => { throw error; }});
    try { await assert.rejects(hub.call('scholar', PUBLISH, {}, new AbortController().signal), (e: any) => e.unknown === (unknown || undefined)); }
    finally { await hub.dispose(); }
  }
});

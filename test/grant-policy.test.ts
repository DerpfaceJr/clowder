// Grant-level policy (plan item 1.4, adjusted by D1): Allow once, Always allow (this cat), Always allow (every cat), Deny, for connector tools and
// built-ins, and Always allow for this site for browse. Through a real ConnectorHub on a temp data folder; only the MCP client and the Claude CLI are stand-ins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectorHub, registerConnectorRoutes} from '../src/connectors.ts';
import {ALLOW_ONCE, EVERY_CAT, SITE_EVERY_CAT, SITE_THIS_CAT, THIS_CAT, alwaysScope, decideToolPolicy, readAccounts} from '../src/accounts.ts';
import {allRoles} from '../src/roles.ts';
import {Town} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import {BUILTINS, type ToolRuntime} from '../src/tool-runtimes.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const until = untilEvery(10);
const TOOL_CARD = [ALLOW_ONCE, THIS_CAT, EVERY_CAT, 'Deny'];
// One tool per effect class, named so effectOf classes it (connectors.ts).
const CLASSES = {get_report: 'read', save_note: 'write', publish_post: 'public', pay_invoice: 'money', delete_file: 'delete'} as const;
const fn = (tool: string) => `mcp__svc__${tool}`;

// A fake Claude CLI for browse: one line per run, then a plain result.
const cliDir = tmp('policy-cli-'), win = process.platform === 'win32', runsLog = join(cliDir, 'runs.log');
const script = join(cliDir, 'fake.mjs'), cli = join(cliDir, win ? 'fake.cmd' : 'fake');
writeFileSync(script, `import {appendFileSync} from 'node:fs';
process.stdin.resume(); process.stdin.on('end', () => { appendFileSync(${JSON.stringify(runsLog)}, 'run\\n'); console.log(JSON.stringify({type: 'result', is_error: false, result: 'Done.', usage: {}})); });
`);
if (win) writeFileSync(cli, `@"${process.execPath}" "${script}" %*\r\n`); else { writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(cli, 0o755); }
const browseRuns = () => existsSync(runsLog) ? readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).length : 0;

// The service: every call answers, and is counted per tool.
function service() {
  const calls: string[] = [];
  const client = {info: {}, close: async () => {}, listTools: async () => Object.keys(CLASSES).map(name => ({name, inputSchema: {type: 'object'}})),
    callTool: async (name: string) => { calls.push(name); return {text: `ok ${calls.length}`, isError: false}; }};
  return {client, calls};
}
// One hub (its world switchable) and one town whose cat makes the call set in `next`, then reports.
async function setup(o: {dataDir?: string; world?: {id: string}} = {}) {
  const svc = service(), world = o.world ?? {id: 'w1'}, dataDir = o.dataDir ?? tmp('policy-data-');
  const hub = new ConnectorHub({dataDir, port: 4331, home: tmp('policy-home-'), connect: (async () => svc.client) as any, world: () => world.id});
  hub.addCustom({name: 'Svc', type: 'http', url: 'https://example.com/mcp'});
  hub.patchConnector('svc', {enabled: true, cats: ['scholar', 'critic'], tools: Object.fromEntries(Object.keys(CLASSES).map(t => [t, 'ask']))});
  await until(() => hub.publicConnectors().find(c => c.id === 'svc')?.status === 'connected');
  const next = {name: '', args: {} as unknown};
  const provider: Provider = async messages => {
    if (String(messages.at(-1)?.content ?? '').startsWith('Record for the town')) return {message: {role: 'assistant', content: 'Nothing new to record.'}};
    if (messages.some(m => m.role === 'tool')) return {message: {role: 'assistant', content: 'Report.'}};
    return {message: {role: 'assistant', content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: next.name, arguments: JSON.stringify(next.args)}}]}};
  };
  const store = new Store(join(tmp('policy-world-'), 'events.jsonl'), allRoles(config)), town = new Town(store, config, {test: provider});
  const runtime: ToolRuntime = {kind: 'claude', executable: cli, defaultModel: 'haiku', fastModel: 'haiku', workspaceRoot: tmp('policy-ws-')};
  town.connectors = () => hub; town.claudePlan = () => runtime; town.browserWindow = async () => 'http://127.0.0.1:9333';
  const pending = () => store.state.approvals.filter(a => a.status === 'pending');
  const settled = (id: string) => until(() => ['done', 'failed', 'cancelled'].includes(store.state.tasks.find(t => t.id === id)?.status ?? ''));
  /** The cat makes one call: the card it raised (then answered with `answer`), or null when it ran with no card. */
  async function call(cat: string, name: string, args: unknown, answer = 'Deny') {
    Object.assign(next, {name, args});
    const id = town.submit(cat, 'Do it', 'test');
    await until(() => pending().length > 0 || ['done', 'failed'].includes(store.state.tasks.find(t => t.id === id)?.status ?? ''));
    const card = pending()[0] ?? null;
    if (card) town.decide(card.id, answer, answer !== 'Deny');
    await settled(id);
    return card;
  }
  return {svc, hub, town, store, call, world, dataDir};
}

test('card-options matrix: every connector effect class and the built-ins offer the four answers; browse offers its site only when it names one', async () => {
  const w = await setup();
  try {
    for (const [tool, effect] of Object.entries(CLASSES)) {
      const card = await w.call('scholar', fn(tool), {n: tool});
      assert.deepEqual([card?.effectClass, card?.options], [effect, TOOL_CARD], `${tool} (${effect}), money and deletes included (D1)`);
    }
    w.hub.patchConnector(BUILTINS, {tools: {save_artifact: 'ask'}});
    assert.deepEqual((await w.call('scholar', 'save_artifact', {title: 'Plan', kind: 'markdown', content: '# Plan'}))?.options, TOOL_CARD, 'a built-in that writes');
    assert.deepEqual((await w.call('scholar', 'browse', {task: 'Read the page', url: 'https://www.example.com/a'}))?.options, [ALLOW_ONCE, SITE_THIS_CAT, SITE_EVERY_CAT, 'Deny'], 'browse with a start page');
    assert.deepEqual((await w.call('scholar', 'browse', {task: 'Find a page'}))?.options, [ALLOW_ONCE, 'Deny'], 'browse with no site to name');
    assert.equal(w.svc.calls.length, 0, 'every card was denied, so nothing ran');
  } finally { await w.hub.dispose(); }
});

test('Always allow (this cat) allows that cat only and asks another; the connector stays Ask for every cat', async () => {
  const w = await setup();
  try {
    assert.ok(await w.call('scholar', fn('save_note'), {n: 1}, THIS_CAT));
    assert.equal(await w.call('scholar', fn('save_note'), {n: 2}), null, 'the scholar is not asked again');
    assert.deepEqual((await w.call('critic', fn('save_note'), {n: 3}))?.options, TOOL_CARD, 'the critic still is');
    assert.deepEqual(w.svc.calls, ['save_note', 'save_note'], 'Allow ran the first call; the critic was denied');
    const view = w.hub.publicConnectors().find(c => c.id === 'svc')!;
    assert.equal(view.tools.find(t => t.name === 'save_note')?.permission, 'ask');
    assert.deepEqual(view.catTools, {scholar: {save_note: 'allow'}});
    // A built-in the same way, on the built-ins' grant.
    w.hub.patchConnector(BUILTINS, {tools: {save_artifact: 'ask'}});
    const art = {title: 'Plan', kind: 'markdown', content: '# Plan'};
    assert.ok(await w.call('scholar', 'save_artifact', art, THIS_CAT));
    assert.equal(await w.call('scholar', 'save_artifact', art), null);
    assert.ok(await w.call('critic', 'save_artifact', art));
    assert.deepEqual([w.hub.builtinPermission('save_artifact'), w.hub.builtinPermission('save_artifact', 'scholar')], ['ask', 'allow']);
  } finally { await w.hub.dispose(); }
});

test('Always allow (every cat) allows all, as the old Always allow did; an Off for every cat still wins over a cat’s own allow', async () => {
  const w = await setup();
  try {
    assert.ok(await w.call('scholar', fn('save_note'), {n: 1}, EVERY_CAT));
    assert.equal(await w.call('critic', fn('save_note'), {n: 2}), null);
    assert.equal(w.hub.publicConnectors().find(c => c.id === 'svc')!.tools.find(t => t.name === 'save_note')?.permission, 'allow');
    assert.equal(alwaysScope('Always allow'), 'every', 'an Always allow on a card filed before 1.4 still means every cat');
    assert.equal(decideToolPolicy({tools: {t: 'off'}, catTools: {a: {t: 'allow'}}}, 'a', 't'), 'off');
    assert.equal(decideToolPolicy({tools: {t: 'allow'}, catTools: {a: {t: 'ask'}}}, 'a', 't'), 'ask', 'a cat’s own Ask over every cat’s Allow');
    assert.equal(decideToolPolicy(undefined, 'a', 't', 'allow'), 'allow', 'no grant: the tool’s default');
  } finally { await w.hub.dispose(); }
});

test('the publish ledger’s repeat card still asks under Always allow (this cat) and (every cat)', async () => {
  const w = await setup();
  try {
    assert.ok(await w.call('scholar', fn('publish_post'), {text: 'one'}, THIS_CAT), 'the first post asks once');
    const repeat = await w.call('scholar', fn('publish_post'), {text: 'two'}, ALLOW_ONCE);
    assert.deepEqual(repeat?.options, [ALLOW_ONCE, 'Deny'], 'a second post within the window asks, with no Always allow');
    assert.match(repeat!.question, /publish_post again/);
    w.hub.patchConnector('svc', {tools: {pay_invoice: 'allow'}});
    assert.equal(await w.call('critic', fn('pay_invoice'), {id: 'a'}), null);
    assert.deepEqual((await w.call('critic', fn('pay_invoice'), {id: 'b'}))?.options, [ALLOW_ONCE, 'Deny'], 'every cat’s allow too');
  } finally { await w.hub.dispose(); }
});

test('browse: Always allow for this site skips the card for that site only, for that cat or for every cat', async () => {
  const w = await setup(), before = browseRuns();
  try {
    assert.ok(await w.call('scholar', 'browse', {task: 'Read', url: 'https://example.com/a'}, SITE_THIS_CAT));
    assert.equal(await w.call('scholar', 'browse', {task: 'Read more', url: 'https://www.example.com/b'}), null, 'same site: no card');
    assert.ok(await w.call('scholar', 'browse', {task: 'Read', url: 'https://other.org/'}), 'another site asks');
    assert.ok(await w.call('critic', 'browse', {task: 'Read', url: 'https://example.com/'}), 'another cat asks');
    assert.equal(browseRuns() - before, 2, 'the allowed run and the skipped card ran; the denied ones did not');
    assert.deepEqual(w.hub.browserSites(), [{id: 'browser:example.com', host: 'example.com', permission: 'ask', catTools: {scholar: {browse: 'allow'}}}]);
    assert.ok(await w.call('critic', 'browse', {task: 'Read', url: 'https://other.org/'}, SITE_EVERY_CAT));
    assert.equal(await w.call('scholar', 'browse', {task: 'Read', url: 'https://other.org/x'}), null, 'every cat on other.org');
    assert.equal(w.hub.sitePermission('other.org'), 'allow');
  } finally { await w.hub.dispose(); }
});

test('per-world scope: a cat’s Always allow holds in its own world only, and survives a reopen from accounts.json', async () => {
  const world = {id: 'w1'}, w = await setup({world});
  try {
    assert.ok(await w.call('scholar', fn('save_note'), {n: 1}, THIS_CAT));
    w.hub.allowTool(BUILTINS, 'save_artifact', 'scholar');
    w.hub.allowTool('browser:example.com', 'browse', 'scholar');
    world.id = 'w2';
    w.hub.patchConnector('svc', {cats: ['scholar']});
    assert.equal(w.hub.resolve('scholar', fn('save_note'))?.permission, 'ask', 'another world asks');
    assert.equal(w.hub.sitePermission('example.com', 'scholar'), 'ask');
    assert.ok(await w.call('scholar', fn('save_note'), {n: 2}));
    world.id = 'w1';
    assert.equal(w.hub.resolve('scholar', fn('save_note'))?.permission, 'allow');
    const g = readAccounts(w.dataDir).grants.find(x => x.account === 'svc' && x.world === 'w1');
    assert.deepEqual(g?.catTools, {scholar: {save_note: 'allow'}}, 'kept in accounts.json');
  } finally { await w.hub.dispose(); }
  const again = new ConnectorHub({dataDir: w.dataDir, port: 4331, home: tmp('policy-home-'), connect: (async () => { throw new Error('offline'); }) as any, world: () => 'w1'});
  try { assert.deepEqual([again.builtinPermission('save_artifact', 'scholar'), again.sitePermission('example.com', 'scholar'), again.sitePermission('example.com', 'critic')], ['allow', 'allow', 'ask']); }
  finally { await again.dispose(); }
});

test('the connectors routes show each cat’s choices and change them; null drops one', async () => {
  const hub = new ConnectorHub({dataDir: tmp('policy-data-'), port: 4331, home: tmp('policy-home-'), connect: (async () => { throw new Error('offline'); }) as any, world: () => 'w1'});
  const app = Fastify(), owner = {host: '127.0.0.1:4331'};
  registerConnectorRoutes(app, hub, {canWrite: () => true, cats: () => [], town: () => ({}) as any});
  try {
    hub.addCustom({name: 'Svc', type: 'http', url: 'https://example.com/mcp'});
    const patch = (id: string, payload: object) => app.inject({method: 'PATCH', url: `/api/connectors/${id}`, payload, headers: owner});
    assert.deepEqual((await patch('svc', {catTools: {critic: {save_note: 'allow', publish_post: 'allow'}}})).json().connector.catTools, {critic: {save_note: 'allow', publish_post: 'allow'}});
    assert.deepEqual((await patch('svc', {catTools: {critic: {publish_post: null}}})).json().connector.catTools, {critic: {save_note: 'allow'}});
    assert.deepEqual((await patch(BUILTINS, {catTools: {scholar: {save_artifact: 'allow'}}})).json().connector.catTools, {scholar: {save_artifact: 'allow'}});
    assert.equal((await patch(BUILTINS, {catTools: {scholar: {fetch_url: 'allow'}}})).statusCode, 400);
    assert.equal((await patch('browser:example.com', {catTools: {scholar: {browse: 'allow'}}})).statusCode, 200);
    assert.equal((await patch('browser:example.com', {tools: {post: 'allow'}})).statusCode, 400);
    const got = (await app.inject({method: 'GET', url: '/api/connectors', headers: owner})).json();
    assert.deepEqual([got.connectors.find((c: any) => c.id === 'svc').catTools, got.builtinCatTools, got.sites], [{critic: {save_note: 'allow'}}, {scholar: {save_artifact: 'allow'}}, [{id: 'browser:example.com', host: 'example.com', permission: 'ask', catTools: {scholar: {browse: 'allow'}}}]]);
  } finally { await app.close(); await hub.dispose(); }
});

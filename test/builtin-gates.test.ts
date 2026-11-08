// The built-in tools that write (code_workspace, generate_image, generate_video, save_artifact) under the owner's allow/ask/off.
// The setting is read from a real ConnectorHub on a temp data folder, so Always allow and a reopen are checked against accounts.json, not a fake.
import {test} from 'node:test';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {ConnectorHub, registerConnectorRoutes} from '../src/connectors.ts';
import {artifactIndex} from '../src/artifacts.ts';
import {allRoles} from '../src/roles.ts';
import {BUILTINS, type ToolRuntime} from '../src/tool-runtimes.ts';
import type {MediaRuntime} from '../src/media.ts';
import type {Provider} from '../src/provider.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const offline = (async () => { throw new Error('offline for this test'); }) as any;
const hubAt = (dataDir: string) => new ConnectorHub({dataDir, port: 4329, home: tmp('gates-home-'), connect: offline});
// ms: 5 s timed out once while the full suite loaded the CPU (5,858 ms), so the ceiling is 30 s; it returns as soon as fn holds.
async function until(fn: () => boolean, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('Timed out waiting for state transition'); }
const statusOf = (store: Store, id: string) => store.state.tasks.find(t => t.id === id)?.status;
const finished = (store: Store, id: string, ms?: number) => until(() => ['done', 'failed', 'cancelled', 'interrupted'].includes(statusOf(store, id) ?? ''), ms);
const pendingOf = (store: Store) => store.state.approvals.filter(a => a.status === 'pending');
const toolResults = (store: Store) => store.state.events.filter(e => e.type === 'tool.finished').map(e => String(e.data.result));

// Calls one tool, then reports. Records the tools and prompt each model call was given.
function once(name: string, args: unknown) {
  const seen: {tools: string[]; prompt: string}[] = [];
  const provider: Provider = async (messages, tools) => {
    if (String(messages.at(-1)?.content ?? '').startsWith('Record for the town')) return {message: {role: 'assistant', content: 'Nothing new to record.'}};
    seen.push({tools: tools.map(t => t.function.name), prompt: String(messages[0].content)});
    if (messages.some(m => m.role === 'tool')) return {message: {role: 'assistant', content: 'Report.'}};
    return {message: {role: 'assistant', content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name, arguments: JSON.stringify(args)}}]}};
  };
  return {provider, seen};
}

// A fake Claude CLI for code_workspace: one line in its log per run, and one file in the workspace. It never reaches a model.
const cliDir = tmp('gates-cli-'), win = process.platform === 'win32', cliLog = join(cliDir, 'runs.log');
const cliScript = join(cliDir, 'fake-claude.mjs'), cli = join(cliDir, win ? 'fake-claude.cmd' : 'fake-claude');
writeFileSync(cliScript, `import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(cliLog)}, 'run\\n');
writeFileSync('index.html', '<h1>Hi</h1>');
process.stdout.write(JSON.stringify({type: 'result', is_error: false, result: 'Made a page.', usage: {input_tokens: 1, output_tokens: 1}}));
`);
if (win) writeFileSync(cli, `@"${process.execPath}" "${cliScript}" %*\r\n`);
else { writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${cliScript}" "$@"\n`); chmodSync(cli, 0o755); }
const cliRuns = () => existsSync(cliLog) ? readFileSync(cliLog, 'utf8').split('\n').filter(Boolean).length : 0;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('well-formed-enough-body')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]);

// One world: a journal, a hub on its own data folder, a media runtime and the fake CLI, each counting what it ran.
function world(provider: Provider, o: {dataDir?: string; file?: string} = {}) {
  const dataDir = o.dataDir ?? tmp('gates-data-'), file = o.file ?? join(tmp('gates-world-'), 'events.jsonl');
  const store = new Store(file, allRoles(config)), hub = hubAt(dataDir), town = new Town(store, config, {test: provider});
  const generated: string[] = [];
  const media: MediaRuntime = {has: () => true, generate: async req => { generated.push(req.kind); return {bytes: req.kind === 'image' ? PNG : MP4, adapter: 'fake'}; }};
  const runtime: ToolRuntime = {kind: 'claude', executable: cli, defaultModel: 'haiku', fastModel: 'haiku', workspaceRoot: tmp('gates-ws-')};
  town.connectors = () => hub; town.media = () => media; town.claudePlan = () => runtime;
  return {dataDir, file, store, hub, town, generated};
}

const CASES = [
  {tool: 'save_artifact', args: {title: 'Plan', kind: 'markdown', content: '# Plan'}, ran: (w: ReturnType<typeof world>) => artifactIndex(w.store.state.events).length, what: /^Save markdown: Plan/},
  {tool: 'generate_image', args: {prompt: 'a cat on a roof', title: 'Roof cat'}, ran: (w: ReturnType<typeof world>) => w.generated.length, what: /^Make an image: Roof cat/},
  {tool: 'generate_video', args: {prompt: 'a cat jumps', title: 'Jump'}, ran: (w: ReturnType<typeof world>) => w.generated.length, what: /^Make a video: Jump/},
  {tool: 'code_workspace', args: {task: 'Make a page', project: 'Cafe'}, ran: () => cliRuns(), what: /^Build in a code workspace: Make a page/},
];

for (const c of CASES) test(`${c.tool} on ask pauses with a card and runs nothing; Allow runs it exactly once`, async () => {
  const {provider, seen} = once(c.tool, c.args);
  const w = world(provider), before = c.ran(w);
  w.hub.patchConnector(BUILTINS, {tools: {[c.tool]: 'ask'}});
  try {
    const id = w.town.submit('scholar', 'Do the work', 'test');
    await until(() => pendingOf(w.store).length === 1);
    const [ask] = pendingOf(w.store);
    assert.equal(ask.gate, 'connector');
    assert.equal(ask.question, `Scholar wants to use ${c.tool}`);
    assert.deepEqual(ask.options, ['Allow once', 'Always allow (this cat)', 'Always allow (every cat)', 'Deny']);
    assert.equal(ask.effectClass, 'write', 'a local write, so a phone notification can answer it');
    assert.match(ask.card!.what, c.what);
    assert.ok(ask.card!.where && ask.card!.who_sees && ask.card!.undo);
    assert.equal(statusOf(w.store, id), 'waiting');
    assert.equal(c.ran(w), before, 'nothing runs while the owner decides');
    w.town.decide(ask.id, 'Allow once', true);
    await finished(w.store, id, 60_000);
    assert.equal(statusOf(w.store, id), 'done');
    assert.equal(c.ran(w), before + 1, 'ran exactly once');
    assert.equal(seen.length, 2, 'the model was asked, then given the result');
    assert.equal(w.hub.builtinPermission(c.tool), 'ask', 'a plain Allow leaves the setting as it is');
  } finally { await w.hub.dispose(); }
});

test('Always allow runs the call, flips the setting in accounts.json, and the next call asks nobody', async () => {
  const {provider} = once('save_artifact', CASES[0].args);
  const w = world(provider);
  w.hub.patchConnector(BUILTINS, {tools: {save_artifact: 'ask', generate_image: 'ask'}});
  try {
    const id = w.town.submit('scholar', 'Save the plan', 'test');
    await until(() => pendingOf(w.store).length === 1);
    w.town.decide(pendingOf(w.store)[0].id, 'Always allow (every cat)', true);
    await finished(w.store, id);
    assert.equal(artifactIndex(w.store.state.events).length, 1);
    assert.equal(w.hub.builtinPermission('save_artifact'), 'allow');
    assert.equal(w.hub.builtinPermission('generate_image'), 'ask', 'only the asked tool flips');
    const second = w.town.submit('scholar', 'Save it again', 'test');
    await finished(w.store, second);
    assert.equal(artifactIndex(w.store.state.events).length, 2);
    assert.equal(w.store.state.approvals.length, 1, 'the second call asked nobody');
  } finally { await w.hub.dispose(); }
  const again = hubAt(w.dataDir);
  try { assert.deepEqual(again.builtinTools(), {code_workspace: 'allow', generate_image: 'ask', generate_video: 'allow', save_artifact: 'allow'}, 'kept on disk'); } finally { await again.dispose(); }
});

test('off hides the tool and its prompt line, and a call made anyway (alias too) is refused and runs nothing', async () => {
  for (const [tool, args] of [['save_artifact', CASES[0].args], ['generate_image', CASES[1].args], ['claude_code', CASES[3].args]] as const) {
    const {provider, seen} = once(tool, args);
    const w = world(provider), runs = cliRuns();
    w.hub.patchConnector(BUILTINS, {tools: {save_artifact: 'off', generate_image: 'off', code_workspace: 'off'}});
    try {
      const id = w.town.submit('scholar', 'Do the work', 'test');
      await finished(w.store, id);
      for (const off of ['save_artifact', 'generate_image', 'code_workspace']) assert.ok(!seen[0].tools.includes(off), `${off} is not offered`);
      assert.ok(seen[0].tools.includes('generate_video'), 'a tool left on is still offered');
      assert.ok(!seen[0].prompt.includes('Use code_workspace'), 'the prompt does not point at an off tool');
      assert.ok(toolResults(w.store).includes('Tool error: Tool not available.'), `${tool} is refused`);
      assert.equal(w.store.state.approvals.length, 0);
      assert.equal(artifactIndex(w.store.state.events).length + w.generated.length + cliRuns() - runs, 0, 'nothing ran');
    } finally { await w.hub.dispose(); }
  }
});

test('a paused call survives a store and hub reopen, and resumes once on Allow', async () => {
  const {provider, seen} = once('generate_image', CASES[1].args);
  const w = world(provider);
  w.hub.patchConnector(BUILTINS, {tools: {generate_image: 'ask'}});
  const id = w.town.submit('scholar', 'Draw a cat', 'test');
  await until(() => pendingOf(w.store).length === 1);
  w.town.dispose(); await w.hub.dispose();
  const r = world(provider, {dataDir: w.dataDir, file: w.file});
  try {
    await new Promise(res => setTimeout(res, 50));
    assert.equal(statusOf(r.store, id), 'waiting');
    assert.equal(pendingOf(r.store).length, 1);
    assert.equal(w.generated.length + r.generated.length, 0);
    r.town.decide(pendingOf(r.store)[0].id, 'Allow once', true);
    await finished(r.store, id);
    assert.equal(statusOf(r.store, id), 'done');
    assert.deepEqual(r.generated, ['image'], 'ran once, after the reopen');
    assert.equal(seen.length, 2, 'the model was not asked again before the answer');
  } finally { await r.hub.dispose(); }
});

test('default allow behaves as today: no hub, or a hub with no setting, runs each tool at once and asks nobody', async () => {
  for (const hubbed of [false, true]) for (const c of CASES) {
    const {provider} = once(c.tool, c.args);
    const w = world(provider), before = c.ran(w);
    if (!hubbed) w.town.connectors = () => null;
    try {
      const id = w.town.submit('scholar', 'Do the work', 'test');
      await finished(w.store, id, 60_000);
      assert.equal(statusOf(w.store, id), 'done');
      assert.equal(c.ran(w), before + 1, `${c.tool} ran once`);
      assert.equal(w.store.state.approvals.length, 0, `${c.tool} asked nobody`);
    } finally { await w.hub.dispose(); }
  }
  const h = hubAt(tmp('gates-data-'));
  try {
    assert.deepEqual(h.builtinTools(), {code_workspace: 'allow', generate_image: 'allow', generate_video: 'allow', save_artifact: 'allow'});
    assert.throws(() => h.patchConnector(BUILTINS, {tools: {web_search: 'off'}}), /Built-in tools take only/);
    assert.throws(() => h.patchConnector(BUILTINS, {enabled: true}), /Built-in tools take only/);
  } finally { await h.dispose(); }
});

test('the connectors route shows the built-ins and PATCH /api/connectors/builtin:tools sets them', async () => {
  const hub = hubAt(tmp('gates-data-')), app = Fastify(), owner = {host: '127.0.0.1:4329'};
  registerConnectorRoutes(app, hub, {canWrite: () => true, cats: () => [], town: () => ({}) as any});
  try {
    assert.equal((await app.inject({method: 'GET', url: '/api/connectors', headers: owner})).json().builtins.save_artifact, 'allow');
    const set = await app.inject({method: 'PATCH', url: `/api/connectors/${BUILTINS}`, payload: {tools: {save_artifact: 'ask', code_workspace: 'off'}}, headers: owner});
    assert.equal(set.statusCode, 200);
    assert.deepEqual(set.json().connector.tools, {code_workspace: 'off', generate_image: 'allow', generate_video: 'allow', save_artifact: 'ask'});
    assert.equal((await app.inject({method: 'GET', url: '/api/connectors', headers: owner})).json().builtins.code_workspace, 'off');
    assert.equal((await app.inject({method: 'PATCH', url: `/api/connectors/${BUILTINS}`, payload: {tools: {fetch_url: 'off'}}, headers: owner})).statusCode, 400);
  } finally { await app.close(); await hub.dispose(); }
});

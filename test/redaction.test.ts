import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {redact, redactValues, type ToolRuntime} from '../src/tool-runtimes.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import type {Provider} from '../src/provider.ts';
import type {ConnectorRuntime} from '../src/connector-types.ts';

// Planted test values only. SAVED is 16 characters: below the generic 20-character rule, so only the by-value rule can mask it.
const SAVED = 'Zq7pW2xK9mR4tLb8';
const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'redaction-'));
const newWorld = () => { const file = join(mkdtempSync(join(tmpdir(), 'world-')), 'events.jsonl'); return {file, store: new Store(file, allRoles(config))}; };
async function until(fn: () => boolean, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('Timed out waiting for state transition'); }
const statusOf = (store: Store, id: string) => store.state.tasks.find(t => t.id === id)?.status;
// Calls one tool, then answers; records what each model call saw (the recorder's own calls excluded).
function oneCall(name: string, args: unknown) {
  const seen: any[][] = [];
  const provider: Provider = async messages => {
    if (String(messages.at(-1)?.content ?? '').startsWith('Record for the town')) return {message: {role: 'assistant', content: 'Nothing new to record.'}};
    seen.push([...messages]);
    return messages.some(m => m.role === 'tool') ? {message: {role: 'assistant', content: 'Finished.'}} : {message: {role: 'assistant', content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name, arguments: JSON.stringify(args)}}]}};
  };
  return {provider, toolSeen: () => String(seen.flat().filter(m => m.role === 'tool').at(-1)?.content ?? '')};
}
const SEARCH = 'mcp__fake__search';
const connector = (result: string): ConnectorRuntime => ({
  toolsFor: () => [{type: 'function', function: {name: SEARCH, description: 'Search.', parameters: {type: 'object', properties: {q: {type: 'string'}}}}}],
  resolve: (_cat: string, name: string) => name === SEARCH ? {connector: 'fake', label: 'Fake', tool: 'search', permission: 'allow'} : null,
  call: async () => result, canUse: () => false, brief: () => '', skills: () => [], readSkill: () => '', roles: () => [], allowTool: () => {},
  findPlugins: async () => [], findPlugin: () => null, installPlugin: async () => ({name: '', skills: [], connectors: []}),
} as unknown as ConnectorRuntime);
const assertMasked = (file: string, store: Store, seen: string) => {
  const journal = readFileSync(file, 'utf8');
  assert.ok(!journal.includes(SAVED), 'the saved value is not in events.jsonl');
  assert.ok(journal.includes('••••' + SAVED.slice(-4)), 'its masked form is');
  assert.ok(!seen.includes(SAVED) && seen.includes('••••' + SAVED.slice(-4)), 'the model sees the masked form');
  assert.ok(!JSON.stringify(store.state).includes(SAVED));
};

test('a 16-character saved value in a connector result is masked in the journal and in what the model sees', async () => {
  const {file, store} = newWorld();
  const {provider, toolSeen} = oneCall(SEARCH, {q: 'cats'});
  const town = new Town(store, config, {test: provider});
  town.autonomy = () => 'full'; town.connectors = () => connector(`{"note":"key is ${SAVED} here"}`);
  // Read per call, with short and non-string values that must be ignored.
  town.secrets = () => ['short', undefined, '', SAVED];
  const id = town.submit('scholar', 'Search the fake index', 'test');
  await until(() => statusOf(store, id) === 'done');
  assertMasked(file, store, toolSeen());
  assert.match(toolSeen(), /key is ••••tLb8 here/);
});

test('a 16-character saved value in a browse result is masked in the journal and in what the model sees', async () => {
  // A fake Claude CLI that answers the browse run with the saved value in its reply. It never reaches a model.
  const script = join(dir, 'fake-claude.mjs'), win = process.platform === 'win32', exe = join(dir, win ? 'fake-claude.cmd' : 'fake-claude');
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',is_error:false,result:'Copied ${SAVED} from https://business.facebook.com/latest/home',usage:{}})));`);
  if (win) writeFileSync(exe, `@"${process.execPath}" "${script}" %*\r\n`); else { writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(exe, 0o755); }
  const runtime: ToolRuntime = {kind: 'claude', executable: exe, defaultModel: 'haiku', fastModel: 'haiku', workspaceRoot: mkdtempSync(join(tmpdir(), 'ws-'))};
  const {file, store} = newWorld();
  const {provider, toolSeen} = oneCall('browse', {task: 'Copy the key'});
  const town = new Town(store, config, {test: provider});
  town.autonomy = () => 'full'; town.claudePlan = () => runtime; town.browserWindow = async () => 'http://127.0.0.1:9333';
  town.secrets = () => [SAVED];
  const id = town.submit('scholar', 'Copy the key', 'test');
  await until(() => store.state.approvals.some(a => a.status === 'pending'));
  town.decide(store.state.approvals.find(a => a.status === 'pending')!.id, 'Allow once', true);
  await until(() => statusOf(store, id) === 'done');
  assertMasked(file, store, toolSeen());
  assert.ok(toolSeen().includes('https://business.facebook.com/latest/home'), 'a page address stays readable');
});

test('a 20-character random token is masked; 19 characters and ordinary prose are unchanged', () => {
  const token = 'a8F3kQ9zR2mX7pL4vN1c';
  assert.equal(token.length, 20);
  assert.equal(redact(`token ${token} end`), 'token ••••vN1c end');
  assert.equal(redact(`id ${token.slice(1)} end`), `id ${token.slice(1)} end`);
  const prose = 'The cats met at noon to plan the week. Reels go out on Tuesday at 09:30, and the café opens at https://example.com/menu.';
  assert.equal(redact(prose), prose);
  assert.equal(redactValues(prose, ['noon', 'Tuesday', SAVED]), prose, 'values under 8 characters never mangle words');
  assert.equal(redactValues(`a ${SAVED}xyz b`, [SAVED, SAVED + 'xyz']), 'a ••••8xyz b','the longer value is masked whole');
  const slug = 'https://example.com/blog/how-to-build-a-cat-town-from-scratch';
  assert.equal(redact(slug), slug, 'a long slug with no digit stays readable');
  assert.equal(redactValues('account 17841400000000001 posted', ['17841400000000001']), 'account 17841400000000001 posted', 'an all-digit id is not a credential');
});

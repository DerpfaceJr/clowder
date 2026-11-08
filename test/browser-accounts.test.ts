// Item 1.8 of docs/product-plan.md: a cats'-browser sign-in is a browser-session Account per site, with one quest per state change. The browse
// run is a fake Claude CLI (it never reaches a model or a browser), the hub and monitor are the real ones over a temp data folder, and the
// probe that reads who a site is signed in as is a fake: no browser is launched and no request leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountMonitor, readAccounts} from '../src/accounts.ts';
import {ConnectorHub} from '../src/connectors.ts';
import {Town} from '../src/engine.ts';
import {quests} from '../src/quests.ts';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import type {Provider} from '../src/provider.ts';
import type {ToolRuntime} from '../src/tool-runtimes.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const dir = tmp('browser-accounts-');
const win = process.platform === 'win32';
// The fake CLI answers every run with the site the task names, then a NEEDS_OWNER line, as a run stopped at a sign-in page would.
const script = join(dir, 'fake-claude.mjs'), claude = join(dir, win ? 'fake-claude.cmd' : 'fake-claude');
writeFileSync(script, `let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
  const site = /Start at (https:\\/\\/[^\\s]+?)\\.\\n/.exec(s)?.[1] ?? 'https://unknown.test/';
  console.log(JSON.stringify({type: 'result', is_error: false, result: 'Reached the sign-in page.\\nNEEDS_OWNER: Sign in, then ask me again.\\nCurrent page: ' + site + 'login', usage: {}}));
});\n`);
if (win) writeFileSync(claude, `@"${process.execPath}" "${script}" %*\r\n`); else { writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(claude, 0o755); }
const runtime: ToolRuntime = {kind: 'claude', executable: claude, defaultModel: 'haiku', fastModel: 'haiku', workspaceRoot: tmp('browser-accounts-ws-')};
async function until(fn: () => boolean, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('Timed out'); }
// One browse call for the https address in the task, then done. A restarted task names no address, so it only finishes.
const provider: Provider = async messages => {
  const asked = String([...messages].reverse().find((m: any) => m.role === 'user')?.content ?? ''), url = /https:\/\/\S+/.exec(asked)?.[0];
  if (!url || messages.at(-1)?.role === 'tool') return {message: {role: 'assistant', content: 'Finished.'}};
  return {message: {role: 'assistant', content: null, tool_calls: [{id: `call-${url}`, type: 'function', function: {name: 'browse', arguments: JSON.stringify({task: 'Open the settings', url})}}]}};
};

function world() {
  const dataDir = tmp('browser-accounts-data-');
  writeFileSync(join(dataDir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  const hub = new ConnectorHub({dataDir, port: 4321, home: tmp('browser-accounts-home-'), connect: (async () => { throw new Error('unused'); }) as any, fetch: (async () => { throw new Error('no network in this test'); }) as any});
  const store = new Store(join(tmp('browser-accounts-town-'), 'events.jsonl'), allRoles(config));
  hub.health = new AccountMonitor({source: hub, store: () => store});
  const town = new Town(store, config, {test: provider});
  Object.assign(town, {autonomy: () => 'full', claudePlan: () => runtime, browserWindow: async () => 'http://127.0.0.1:9', connectors: () => hub});
  const probed: string[] = [];
  town.siteProbe = async host => { probed.push(host); return host === 'github.com' ? 'octocat' : null; };
  // Every browse call asks the owner first; the test allows each as it comes and waits for the task to end.
  const run = async (cat: string, text: string) => {
    const id = town.submit(cat, text, 'test');
    await until(() => { for (const a of store.state.approvals.filter(a => a.status === 'pending' && a.task === id)) town.decide(a.id, 'Allow once', true); return store.state.tasks.find(t => t.id === id)?.status === 'done'; });
    return id;
  };
  const browserAccounts = () => readAccounts(dataDir).accounts.filter(a => a.kind === 'browser-session');
  return {hub, store, town, run, probed, browserAccounts, close: async () => { town.dispose(); await hub.dispose(); }};
}

test('NEEDS_OWNER twice for one site gives one browser-session Account and one quest, and no free-text step', async () => {
  const w = world();
  await w.run('scholar', 'Check the repo at https://github.com/settings');
  await w.run('builder', 'Check the tokens at https://www.github.com/settings/tokens');
  const accounts = w.browserAccounts();
  assert.equal(accounts.length, 1, 'www. and the path do not make a second site');
  assert.deepEqual({id: accounts[0].id, label: accounts[0].label, secretRef: accounts[0].secretRef, status: accounts[0].status}, {id: 'browser:github.com', label: 'github.com', secretRef: null, status: 'needs-sign-in'});
  assert.equal(w.store.state.ownerSteps.length, 1, 'the second run files nothing new');
  const [step] = w.store.state.ownerSteps;
  assert.equal(step.title, 'Sign in to github.com in the cats’ browser');
  assert.equal(step.steps, 'Sign in. Do this on your computer: tap Open the cats’ browser (phone sign-ins do not work there). Then tap Mark done, and Scholar carries on by itself.');
  assert.deepEqual({cat: step.cat, mode: step.mode, browser: step.browser, kind: step.kind, account: step.account, goal: step.goal, url: step.url}, {cat: 'scholar', mode: 'test', browser: true, kind: 'account', account: 'browser:github.com', goal: null, url: 'https://github.com/settings'});
  assert.ok(!w.store.state.ownerSteps.some(s => s.title.startsWith('Finish in the cats’ browser')), 'the old free-text step is gone');
  assert.equal(w.store.state.accounts['browser:github.com'].step, step.id);
  const quest = quests({state: w.store.state, projects: [], capabilities: [], seasons: [], models: null, now: new Date()}).find(q => q.source.id === step.id);
  assert.equal(quest?.browser, true, 'the quest keeps its Open the cats’ browser button');
  assert.ok(w.store.state.events.filter(e => e.type === 'tool.finished').every(e => /one quest to sign in to github\.com/.test(String(e.data.result))), 'both cats are told about the one quest');
  // Dismissed is "not now": the next stop asks again, once.
  w.town.ownerStepDismiss('owner', step.id);
  await w.run('builder', 'Once more at https://github.com/settings');
  assert.equal(w.store.state.ownerSteps.filter(s => s.status === 'open' && s.account === 'browser:github.com').length, 1);
  assert.equal(w.browserAccounts().length, 1);
  await w.close();
});

test('a different site gets its own Account and quest; Mark done re-probes and sets connected or unchecked, then the cat carries on', async () => {
  const w = world();
  await w.run('scholar', 'Check the repo at https://github.com/settings');
  await w.run('scholar', 'Check the board at https://trello.com/b/1');
  assert.deepEqual(w.browserAccounts().map(a => a.id).sort(), ['browser:github.com', 'browser:trello.com']);
  assert.equal(w.store.state.ownerSteps.length, 2);
  const stepFor = (host: string) => w.store.state.ownerSteps.find(s => s.account === `browser:${host}`)!;
  const statusOf = (host: string) => w.store.state.accounts[`browser:${host}`].status;
  // github.com: unchecked at once (so a cat stopping there again files a new quest), connected once the probe reads the handle.
  const tasks = w.store.state.tasks.length;
  assert.equal(w.town.ownerStepDone('owner', stepFor('github.com').id, 'Signed in'), 'Marked done. Scholar is carrying on.');
  await until(() => statusOf('github.com') === 'connected');
  assert.equal(w.store.state.accounts['browser:github.com'].identity, '@octocat');
  assert.equal(w.browserAccounts().find(a => a.id === 'browser:github.com')?.identity?.handle, 'octocat', 'accounts.json holds who it is');
  const next = w.store.state.tasks[tasks];
  assert.deepEqual({cat: next.cat, mode: next.mode}, {cat: 'scholar', mode: 'test'});
  assert.match(next.text, /^The owner finished “Sign in to github\.com in the cats’ browser” in the cats’ browser \(Signed in\)\. Run browse again/);
  await until(() => w.store.state.tasks.find(t => t.id === next.id)?.status === 'done');
  // trello.com: the probe reads no handle, so it stays unchecked.
  w.town.ownerStepDone('owner', stepFor('trello.com').id, '');
  await until(() => w.probed.includes('trello.com'));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(statusOf('trello.com'), 'unchecked');
  assert.equal(statusOf('github.com'), 'connected', 'one site’s sign-in leaves the other alone');
  // A later stop at the signed-in site is a new state change: one new quest.
  await w.run('builder', 'Again at https://github.com/settings');
  assert.equal(statusOf('github.com'), 'needs-sign-in');
  assert.equal(w.store.state.ownerSteps.filter(s => s.account === 'browser:github.com' && s.status === 'open').length, 1);
  await until(() => w.store.state.tasks.every(t => t.status === 'done'));
  await w.close();
});

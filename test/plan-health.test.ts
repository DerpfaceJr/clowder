// Plan health (item 4.6): a Claude plan call's failure moves the plan's Account through the accounts monitor, over a real ConnectorHub and Store.
// A fake `claude` answers in the mode CAT_FAKE_MODE sets, so nothing runs the real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountMonitor} from '../src/accounts.ts';
import {claudePlanProvider} from '../src/claude-plan.ts';
import {ConnectorHub} from '../src/connectors.ts';
import {Store} from '../src/store.ts';
import {CLI_ENV} from '../src/claude-plan.ts';
// The fake CLIs read these; a real CLI run gets only CLI_ENV from this process's environment (security pass M3).
CLI_ENV.push('CAT_FAKE_MODE');

const dir = mkdtempSync(join(tmpdir(), 'plan-health-'));
const win = process.platform === 'win32';
const script = join(dir, 'fake-claude.mjs');
const executable = join(dir, win ? 'fake-claude.cmd' : 'fake-claude');
writeFileSync(script, `const mode=process.env.CAT_FAKE_MODE;
const usage={input_tokens:1,output_tokens:1};
if(mode==='notlogged'){process.stdout.write(JSON.stringify({type:'result',is_error:true,result:'Not logged in · Please run /login',usage}));process.exit(1);}
else if(mode==='limit'){process.stdout.write(JSON.stringify({type:'result',is_error:true,result:"You've hit your weekly limit · resets Monday",usage}));process.exit(1);}
else if(mode==='hang'){setTimeout(()=>process.exit(0),5000);}
else process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'',structured_output:{action:'pass',args:{note:'fake plan'}},usage}));
`);
if (win) writeFileSync(executable, `@"${process.execPath}" "${script}" %*\r\n`);
else { writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(executable, 0o755); }

const messages = [{role: 'system', content: 'You are the Mayor.'}, {role: 'user', content: 'hi'}];
const tools = [{type: 'function', function: {name: 'pass', description: 'Take no action', parameters: {type: 'object', properties: {}}}}];
const call = (p: ReturnType<typeof claudePlanProvider>) => p(messages as any, tools as any, new AbortController().signal);

async function withMode(mode: string, fn: () => Promise<void>) {
  const prev = process.env.CAT_FAKE_MODE;
  process.env.CAT_FAKE_MODE = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.CAT_FAKE_MODE; else process.env.CAT_FAKE_MODE = prev; }
}

// One Claude plan Account in accounts.json, as the boot migration writes it; the monitor reads its strikes from here (3 in a row).
// timeoutMs: a normal fake call needs a few seconds on Windows (node start), and far longer while the full suite loads the CPU, so only the hang test uses a short one.
function setup(timeoutMs = 30000) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plan-health-data-'));
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({accounts: [{id: 'models:claude', service: 'claude-plan', label: 'Claude plan', kind: 'cli', identity: null, secretRef: null, status: 'unchecked', expiresAt: null, refreshable: false, lastOkAt: null, lastError: null}], grants: []}));
  writeFileSync(join(dataDir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dataDir, 'connector-secrets.json'), '{}');
  const hub = new ConnectorHub({dataDir, port: 4321, home: mkdtempSync(join(tmpdir(), 'plan-health-home-')), connect: (async () => { throw new Error('no connect'); }) as any, fetch: (async () => { throw new Error('no fetch'); }) as any, now: () => Date.now()});
  const store = new Store(join(dataDir, 'events.jsonl'), [{id: 'mayor', name: 'Mayor', role: '', color: '', icon: ''}]);
  const monitor = new AccountMonitor({source: hub, store: () => store, strikes: () => 3});
  hub.health = monitor;
  const provider = claudePlanProvider('haiku', timeoutMs, {executable, workdir: dir, health: f => monitor.plan('models:claude', f)});
  const status = () => store.state.accounts['models:claude']?.status ?? 'none';
  const quests = () => store.state.ownerSteps.filter(s => s.account === 'models:claude' && s.status === 'open');
  const moves = () => store.state.events.filter(e => e.type === 'account.state' && e.data.id === 'models:claude');
  return {hub, store, provider, status, quests, moves};
}

test('a sign-in failure marks the plan needs-sign-in and files one quest across several failing tasks, and a working call clears it', async () => {
  const {hub, provider, status, quests, moves} = setup();
  await withMode('notlogged', async () => {
    for (let i = 0; i < 3; i++) await assert.rejects(call(provider), (e: any) => e.fatal === true && /Claude plan needs you to sign in again — run `claude` in a terminal\./.test(e.message));
  });
  assert.equal(status(), 'needs-sign-in');
  assert.equal(quests().length, 1, 'one quest for every failing task');
  assert.equal(quests()[0]!.title, 'Sign in to Claude plan');
  assert.equal(moves().length, 1, 'one state change');
  await withMode('ok', async () => { await call(provider); });
  assert.equal(status(), 'unchecked');
  assert.equal(quests().length, 0, 'the quest closes once a call works');
  await hub.dispose();
});

test('a usage limit is a note: the plan is not marked needs-sign-in or expired, and no quest is filed', async () => {
  const {hub, provider, status, quests, moves} = setup();
  await withMode('limit', async () => {
    for (let i = 0; i < 2; i++) await assert.rejects(call(provider), (e: any) => e.fatal === true && /usage limit reached: You've hit your weekly limit/.test(e.message));
  });
  assert.equal(status(), 'unchecked');
  assert.equal(quests().length, 0);
  assert.match(String(moves()[0]!.data.reason), /usage limit/);
  assert.equal(moves().length, 1);
  await hub.dispose();
});

test('timeouts count, and only as many in a row as town.config.json sets mark the plan', async () => {
  const {hub, provider, status, quests} = setup(1000);
  await withMode('hang', async () => {
    await assert.rejects(call(provider), /Claude plan call timed out\./);
    await assert.rejects(call(provider), /Claude plan call timed out\./);
    assert.notEqual(status(), 'error', 'two in a row do not mark it');
    assert.equal(quests().length, 0);
    await assert.rejects(call(provider), /Claude plan call timed out\./);
  });
  assert.equal(status(), 'error', 'three in a row do');
  assert.equal(quests().length, 1);
  assert.equal(quests()[0]!.title, 'Claude plan is not answering');
  await hub.dispose();
});

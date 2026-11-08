// Account health (item 1.2) and identity (item 1.3): the monitor over a real ConnectorHub and Store, with fetch and MCP faked, so nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountMonitor, type Accounts} from '../src/accounts.ts';
import {ConnectorHub} from '../src/connectors.ts';
import {authProblem} from '../src/mcp-client.ts';
import {Store} from '../src/store.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const http = (id: string, name: string, url: string, extra = {}) => ({id, name, source: 'custom', transport: {type: 'http', url, ...extra}, enabled: true, cats: ['*'], tools: {}, addedAt: 1});
const ig = (id: string, name: string) => ({id, name, source: 'custom', transport: {type: 'stdio', command: 'node', args: ['ig-mcp.js'], env: {INSTAGRAM_ACCESS_TOKEN: '${INSTAGRAM_ACCESS_TOKEN}', INSTAGRAM_ACCOUNT_ID: '${INSTAGRAM_ACCOUNT_ID}'}}, enabled: true, cats: ['*'], tools: {}, addedAt: 1});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
// Any request no route answers fails the test: the probes must only call what they are meant to.
const fakeFetch = (routes: [RegExp, () => Response][]) => (async (url: string | URL) => { const hit = routes.find(([re]) => re.test(String(url))); if (!hit) throw new Error(`unexpected fetch ${url}`); return hit[1](); }) as typeof fetch;
const client = (result: {text: string; isError: boolean}) => ({info: {}, listTools: async () => [{name: 'search'}], callTool: async () => result, close: async () => {}});

function setup(connectors: unknown[], secrets: Record<string, unknown>, o: {fetch?: typeof fetch; result?: {text: string; isError: boolean}} = {}) {
  const dataDir = tmp('health-data-'), clock = {now: Date.now()};
  writeFileSync(join(dataDir, 'connectors.json'), JSON.stringify({connectors, plugins: []}));
  writeFileSync(join(dataDir, 'connector-secrets.json'), JSON.stringify(secrets));
  const hub = new ConnectorHub({dataDir, port: 4321, home: tmp('health-home-'), connect: (async () => client(o.result ?? {text: 'ok', isError: false})) as any, fetch: o.fetch ?? fakeFetch([]), now: () => clock.now});
  const file = join(dataDir, 'events.jsonl'), store = new Store(file, [{id: 'mayor', name: 'Mayor', role: '', color: '', icon: ''}]);
  const monitor = new AccountMonitor({source: hub, store: () => store, now: () => clock.now});
  hub.health = monitor;
  return {hub, store, monitor, clock, dataDir, file};
}
const steps = (store: Store, account: string) => store.state.ownerSteps.filter(s => s.account === account);
const open = (store: Store, account: string) => steps(store, account).filter(s => s.status === 'open');
const accountsFile = (dir: string): Accounts => JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
async function connected(hub: ConnectorHub, id: string) {
  hub.start();
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (hub.publicConnectors().find(c => c.id === id)?.status === 'connected') return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('connector never connected');
}

test('five cats hitting one refused sign-in give five account.error events and exactly one quest, which a probe that verifies nothing does not clear', async () => {
  const {hub, store, monitor} = setup([http('notes', 'Notes', 'https://notes.example/mcp')], {}, {result: {text: `HTTP 401 Unauthorized: invalid_token ${'x'.repeat(12_000)}`, isError: true}});
  await connected(hub, 'notes');
  const cats = ['mayor', 'builder', 'scholar', 'critic', 'reel_builder'];
  const said = await Promise.all(cats.map(cat => hub.call(cat, 'mcp__notes__search', {}, new AbortController().signal)));
  // The note leads, so the engine's 12,000-character cut of a long error body keeps it.
  for (const s of said) assert.match(s.slice(0, 12_000), /^Clowder has told the owner that Notes needs signing in again; one quest covers every cat\. Do not file an owner step/);
  assert.equal(store.state.events.filter(e => e.type === 'account.error').length, 5);
  assert.deepEqual(store.state.events.filter(e => e.type === 'account.error').map(e => e.data.cat), cats);
  assert.equal(steps(store, 'notes').length, 1, 'one quest for every cat');
  assert.equal(open(store, 'notes')[0]!.title, 'Sign in to Notes');
  assert.equal(store.state.accounts.notes!.status, 'needs-sign-in');
  await monitor.tick(); // Notes has no identity endpoint: unchecked proves nothing against a refusal
  assert.equal(store.state.accounts.notes!.status, 'needs-sign-in');
  assert.equal(open(store, 'notes').length, 1);
  await hub.dispose();
});

test('a Vercel-shaped sign-in (expiry, no refresh token) is unchecked, then expiring 2 h before its end, then expired, one quest per change, with no fetch at all', async () => {
  const base = Date.now();
  const {hub, store, monitor, clock, dataDir} = setup([http('vercel', 'Vercel', 'https://mcp.vercel.com')], {vercel: {vars: {}, oauth: {accessToken: 'fake-vercel-access', clientId: 'fake-client', tokenEndpoint: 'https://vercel.example/token', expiresAt: base + 3 * HOUR}}});
  clock.now = base;
  await monitor.tick();
  assert.equal(store.state.accounts.vercel!.status, 'unchecked', 'no userinfo endpoint: never connected');
  assert.equal(steps(store, 'vercel').length, 0);
  clock.now = base + HOUR - MIN; // 2 h 1 min left
  await monitor.tick();
  assert.equal(store.state.accounts.vercel!.status, 'unchecked');
  clock.now = base + HOUR + MIN; // 1 h 59 min left
  await monitor.tick();
  assert.equal(store.state.accounts.vercel!.status, 'expiring');
  assert.equal(accountsFile(dataDir).accounts.find(a => a.id === 'vercel')!.status, 'expiring');
  assert.deepEqual(open(store, 'vercel').map(s => [s.title, s.connect]), [['Vercel sign-in ends soon', 'vercel']]);
  await monitor.tick(); // no change, no second quest
  assert.equal(steps(store, 'vercel').length, 1);
  clock.now = base + 3 * HOUR + MIN;
  await monitor.tick();
  assert.equal(store.state.accounts.vercel!.status, 'expired');
  assert.deepEqual(open(store, 'vercel').map(s => s.title), ['Vercel sign-in expired'], 'the expiring quest gives way to the expired one');
  assert.equal(steps(store, 'vercel').length, 2);
  assert.deepEqual(store.state.events.filter(e => e.type === 'account.state').map(e => [e.data.from, e.data.to]), [[null, 'unchecked'], ['unchecked', 'expiring'], ['expiring', 'expired']]);
  await hub.dispose();
});

const IG_ID = '17841400000000001';
const graph = (username: string, expiresAt: number) => fakeFetch([
  [/\/me\/accounts\?/, () => json({data: [{name: 'Page', instagram_business_account: {id: IG_ID, username}}]})],
  [/\/debug_token\?/, () => json({data: {expires_at: Math.round(expiresAt / 1000)}})],
]);
const igSecrets = {instagram: {vars: {INSTAGRAM_ACCESS_TOKEN: 'fake-ig-token', INSTAGRAM_ACCOUNT_ID: IG_ID}}};

test('a whoami mismatch gives wrong-account and one quest naming both identities; the state and its open quest survive a store reopen', async () => {
  const {hub, store, monitor, clock, file} = setup([ig('instagram', 'instagram @example_shop')], igSecrets, {fetch: graph('example_studio', Date.now() + 50 * DAY)});
  await connected(hub, 'instagram');
  await monitor.tick();
  await monitor.tick();
  assert.equal(store.state.accounts.instagram!.status, 'wrong-account');
  const quests = steps(store, 'instagram');
  assert.equal(quests.length, 1);
  assert.match(quests[0]!.title, /@example_studio/);
  assert.match(quests[0]!.title, /@example_shop/);
  assert.equal(quests[0]!.connect, undefined, 'not a directory service: no Connect button');
  // The approval card names who the account really is.
  assert.equal(hub.resolve('mayor', 'mcp__instagram__search')!.identity, '@example_studio');
  const reopened = new Store(file, []);
  assert.equal(reopened.state.accounts.instagram!.status, 'wrong-account');
  assert.equal(reopened.state.accounts.instagram!.identity, '@example_studio');
  assert.equal(reopened.state.ownerSteps.find(s => s.id === reopened.state.accounts.instagram!.step)!.status, 'open');
  await new AccountMonitor({source: hub, store: () => reopened, now: () => clock.now}).tick();
  assert.equal(steps(reopened, 'instagram').length, 1, 'a restart files nothing new');
  await hub.dispose();
});

test('Instagram warns 7 days before its token ends; the right handle with time to spare is connected', async () => {
  const base = Date.now();
  const late = setup([ig('instagram', 'instagram @example_shop')], igSecrets, {fetch: graph('example_shop', base + 6 * DAY)});
  await late.monitor.tick();
  assert.equal(late.store.state.accounts.instagram!.status, 'expiring');
  assert.match(open(late.store, 'instagram')[0]!.steps, /ends in 6 days/);
  const fine = setup([ig('instagram', 'instagram @example_shop')], igSecrets, {fetch: graph('example_shop', base + 8 * DAY)});
  await fine.monitor.tick();
  assert.equal(fine.store.state.accounts.instagram!.status, 'connected');
  assert.equal(fine.store.state.accounts.instagram!.identity, '@example_shop');
  assert.equal(steps(fine.store, 'instagram').length, 0);
  await Promise.all([late.hub.dispose(), fine.hub.dispose()]);
});

test('unchecked without an identity endpoint; GitHub /user and OAuth userinfo verify who it is, and a new sign-in clears a refusal', async () => {
  const github = {...http('github', 'GitHub', 'https://api.githubcopilot.com/mcp/', {headers: {Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}'}})};
  const {hub, store, monitor, clock} = setup([http('notes', 'Notes', 'https://notes.example/mcp'), github, http('linear', 'Linear', 'https://mcp.linear.example/mcp')],
    {github: {vars: {GITHUB_PERSONAL_ACCESS_TOKEN: 'fake-gh-token'}}, linear: {vars: {}, oauth: {accessToken: 'fake-linear', userinfoEndpoint: 'https://linear.example/userinfo'}}},
    {fetch: fakeFetch([[/api\.github\.com\/user$/, () => json({login: 'octo', id: 7})], [/linear\.example\/userinfo$/, () => json({sub: 'u1', email: 'owner@example.com'})]])});
  await monitor.tick();
  assert.equal(store.state.accounts.notes!.status, 'unchecked');
  assert.deepEqual([store.state.accounts.github!.status, store.state.accounts.github!.identity], ['connected', '@octo']);
  assert.deepEqual([store.state.accounts.linear!.status, store.state.accounts.linear!.identity], ['connected', 'owner@example.com']);
  // A refusal a cat reports stands until new credentials come; then the next check clears it and closes its quest.
  monitor.report('github', 'builder', 'auth', 'Bad credentials');
  assert.equal(store.state.accounts.github!.status, 'needs-sign-in');
  const quest = open(store, 'github')[0]!;
  assert.equal(quest.connect, 'github', 'a directory service gets the Connect button');
  clock.now += MIN;
  hub.patchConnector('github', {vars: {GITHUB_PERSONAL_ACCESS_TOKEN: 'fake-gh-token-2'}});
  await monitor.tick();
  assert.equal(store.state.accounts.github!.status, 'connected');
  assert.equal(store.state.ownerSteps.find(s => s.id === quest.id)!.status, 'done');
  await hub.dispose();
});

test('auth and scope errors are told apart inside tool results, and other errors are left alone', () => {
  assert.equal(authProblem('{"error":{"message":"Error validating access token: Session has expired on Friday","type":"OAuthException","code":190}}'), 'auth');
  assert.equal(authProblem('Bad credentials'), 'auth');
  assert.equal(authProblem('HTTP 403: insufficient_scope'), 'scope');
  assert.equal(authProblem('(#10) Application does not have permission for this action'), 'scope');
  assert.equal(authProblem('(#4) Application request limit reached'), null);
  assert.equal(authProblem('EACCES: permission denied, open /tmp/x'), null);
  assert.equal(authProblem('Found 401 results'), null);
});

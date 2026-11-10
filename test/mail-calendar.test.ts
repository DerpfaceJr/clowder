// Item 3.3 (trial) and 3.12: the owner's own Google and Microsoft clients (D6), labelled accounts through one client, the trial mail servers'
// tool classes, and the Composio entry. Google's endpoints are a local fake reached through an injected fetch; nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {AccountMonitor, whoami, type Accounts} from '../src/accounts.ts';
import {ConnectorHub, effectOf, fnNames, registerConnectorRoutes} from '../src/connectors.ts';
import {DIRECTORY, directoryEntry, directoryList} from '../src/connector-directory.ts';
import {openSecretStore, resetSecretStores, storeFor, type Broker} from '../src/secret-store.ts';
import {Store} from '../src/store.ts';
import {untilEvery} from './helpers/until.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const CLIENT = {clientId: 'cid-123.apps.googleusercontent.com', clientSecret: 'GOCSPX-fake-secret'};
// A stand-in for safeStorage: reversible, and never the plain text on disk.
const broker: Broker = {available: async () => true, encrypt: async t => Buffer.from(`enc:${t}`).toString('base64').split('').reverse().join(''), decrypt: async b => Buffer.from(b.split('').reverse().join(''), 'base64').toString().slice(4)};

// The fake Google: a token endpoint (code and refresh grants) and OpenID userinfo, each access token naming its account.
type Grant = Record<string, string>;
async function fakeGoogle() {
  const grants: Grant[] = [], userinfo: string[] = [];
  const codes: Record<string, string> = {'code-work': 'work', 'code-personal': 'personal'}, emails: Record<string, string> = {work: 'cat@work.example', personal: 'cat.home@gmail.example'};
  let n = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = (status: number, j: unknown) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(j)); };
      if (req.url === '/token' && req.method === 'POST') {
        const g = Object.fromEntries(new URLSearchParams(body)) as Grant; grants.push(g);
        if (g.client_id !== CLIENT.clientId || g.client_secret !== CLIENT.clientSecret) return send(401, {error: 'invalid_client'});
        const who = g.grant_type === 'authorization_code' ? codes[g.code!] : g.grant_type === 'refresh_token' ? /^rt-(\w+)$/.exec(g.refresh_token ?? '')?.[1] : undefined;
        if (!who) return send(400, {error: 'invalid_grant'});
        // Google gives the refresh token once, at the first exchange.
        return send(200, {access_token: `at-${who}-${++n}`, expires_in: 3599, token_type: 'Bearer', ...(g.grant_type === 'authorization_code' ? {refresh_token: `rt-${who}`} : {})});
      }
      if (req.url === '/v1/userinfo') {
        const tok = /^Bearer at-(\w+)-\d+$/.exec(req.headers.authorization ?? '')?.[1]; userinfo.push(req.headers.authorization ?? '');
        return tok ? send(200, {sub: `sub-${tok}`, email: emails[tok], email_verified: true}) : send(401, {error: 'invalid_token'});
      }
      send(404, {});
    });
  });
  await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as {port: number}).port}`;
  // Only Google's token and userinfo hosts are routed; any other address fails the test.
  const fetch: typeof globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.host !== 'oauth2.googleapis.com' && u.host !== 'openidconnect.googleapis.com') throw new Error(`unexpected fetch ${u.href}`);
    return globalThis.fetch(`${base}${u.pathname}`, init);
  }) as typeof globalThis.fetch;
  return {fetch, grants, userinfo, close: () => srv.close()};
}

const sendTool = {name: 'send_gmail_message', inputSchema: {type: 'object'}, annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true}};
const draftTool = {name: 'draft_gmail_message', inputSchema: {type: 'object'}, annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true}};

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mail-data-')), clock = {now: Date.UTC(2026, 10, 7)}, g = await fakeGoogle(), launched: any[] = [];
  resetSecretStores();
  await openSecretStore(dataDir, broker);
  const connect = (async (t: any) => { launched.push(t); return {info: {}, listTools: async () => [sendTool, draftTool], callTool: async () => ({text: 'ok', isError: false}), close: async () => {}}; }) as any;
  const hub = new ConnectorHub({dataDir, port: 4321, home: mkdtempSync(join(tmpdir(), 'mail-home-')), connect, fetch: g.fetch, now: () => clock.now});
  const store = new Store(join(dataDir, 'events.jsonl'), [{id: 'mayor', name: 'Mayor', role: '', color: '', icon: ''}]);
  const monitor = new AccountMonitor({source: hub, store: () => store, now: () => clock.now});
  hub.health = monitor;
  return {dataDir, clock, g, hub, monitor, launched};
}
// The owner's browser: the authorize URL's state comes back with the code, as the loopback callback would bring it.
async function signIn(hub: ConnectorHub, id: string, code: string) {
  const r = await hub.signIn(id);
  return {url: new URL(r.url), r, name: await hub.finishSignIn({code, state: new URL(r.url).searchParams.get('state')!})};
}
const until = untilEvery(10);
const allFiles = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; });

test('two Google accounts through one owner client: two Accounts with their own emails, refreshed with the saved refresh token, secrets only in the store', async () => {
  const {dataDir, clock, g, hub, monitor, launched} = await setup();
  try {
    await assert.rejects(hub.signIn(hub.addAccount('google-workspace', 'Work').id), /Set up your own Google client first/);
    hub.saveOwnerClient('google', CLIENT);
    hub.addAccount('google-workspace', 'Personal');
    assert.throws(() => hub.addAccount('google-workspace', 'Work'), /already here/);

    const work = await signIn(hub, 'google-workspace-work', 'code-work');
    const q = work.url.searchParams;
    // No discovery and no dynamic registration: Google's own endpoint, the owner's client, a loopback redirect, offline access and PKCE.
    assert.equal(work.url.origin + work.url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(q.get('client_id'), CLIENT.clientId);
    assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:4321/api/connectors/oauth/callback');
    assert.equal(q.get('access_type'), 'offline');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('resource'), null);
    assert.ok(q.get('scope')!.split(' ').includes('https://www.googleapis.com/auth/gmail.send'));
    assert.equal(work.r.finish, 'callback');
    assert.equal(work.name, 'Google Workspace · Work');
    await signIn(hub, 'google-workspace-personal', 'code-personal');
    assert.deepEqual(g.grants.map(x => [x.grant_type, x.code, !!x.code_verifier]), [['authorization_code', 'code-work', true], ['authorization_code', 'code-personal', true]]);

    assert.equal((await monitor.check('google-workspace-work'))?.identity, 'cat@work.example');
    assert.equal((await monitor.check('google-workspace-personal'))?.identity, 'cat.home@gmail.example');
    const accts = (JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as Accounts).accounts.filter(a => a.service === 'google-workspace');
    assert.deepEqual(accts.map(a => [a.label, a.kind, a.status, a.identity?.email, a.refreshable]).sort(), [
      ['Google Workspace · Personal', 'oauth', 'connected', 'cat.home@gmail.example', true],
      ['Google Workspace · Work', 'oauth', 'connected', 'cat@work.example', true]]);

    // Eight days on (past Testing mode's 7): the access token has long ended, and the saved refresh token renews it with the owner's client.
    clock.now += 8 * DAY;
    assert.equal((await monitor.check('google-workspace-work'))?.status, 'connected');
    // The newest grant and userinfo call of the Work account, not of the list: the Personal account renews by itself after the same jump,
    // and under load its grant landed last (one full-suite run beside an installer build, 2026-11-10).
    const refresh = g.grants.filter(x => x.grant_type === 'refresh_token' && x.refresh_token === 'rt-work').at(-1)!;
    assert.deepEqual([refresh?.grant_type, refresh?.refresh_token, refresh?.client_id, refresh?.client_secret], ['refresh_token', 'rt-work', CLIENT.clientId, CLIENT.clientSecret]);
    assert.match(g.userinfo.filter(h => h.startsWith('Bearer at-work')).at(-1)!, /^Bearer at-work-3$/);

    // The trial server gets the owner's client and a fresh access token at launch, never the refresh token.
    await until(() => launched.some(t => t.env?.WORKSPACE_MCP_CREDENTIALS_DIR?.endsWith('google-workspace-work')));
    const t = launched.find(t => t.env?.WORKSPACE_MCP_CREDENTIALS_DIR?.endsWith('google-workspace-work'));
    assert.deepEqual([t.type, t.command, t.args[0], t.env.GOOGLE_OAUTH_CLIENT_ID], ['stdio', 'uvx', 'workspace-mcp@2.3.0', CLIENT.clientId]);
    const creds = JSON.parse(readFileSync(allFiles(t.env.WORKSPACE_MCP_CREDENTIALS_DIR)[0]!, 'utf8'));
    assert.match(creds.token, /^at-work-/);
    assert.equal(creds.refresh_token, undefined);

    // The client secret and both refresh tokens are in the store, encrypted; no file under the data folder holds one in the clear.
    await storeFor(dataDir).flush();
    assert.equal(storeFor(dataDir).get('oauth-clients.json#google.clientSecret'), CLIENT.clientSecret);
    assert.deepEqual(hub.ownerClients().google, {clientId: CLIENT.clientId, hasSecret: true, savedAt: clock.now - 8 * DAY});
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'oauth-clients.json'), 'utf8')).google.clientSecret, undefined);
    for (const f of allFiles(dataDir)) { const text = readFileSync(f, 'utf8'); for (const s of [CLIENT.clientSecret, 'rt-work', 'rt-personal']) assert.ok(!text.includes(s), `${s} in clear in ${f}`); }
  } finally { await hub.dispose(); g.close(); }
});

test('sending email is a public action and a draft a private write, on both trial servers', async () => {
  const {g, hub} = await setup();
  try {
    hub.saveOwnerClient('google', CLIENT);
    await signIn(hub, hub.addAccount('google-workspace', 'Work').id, 'code-work');
    hub.patchConnector('google-workspace-work', {cats: ['*']});
    await until(() => hub.publicConnectors().find(c => c.id === 'google-workspace-work')?.status === 'connected');
    const fn = fnNames('google-workspace-work', [sendTool, draftTool]);
    // Gmail's send says destructiveHint (which reads as delete) and its draft openWorldHint (public): the entry's classes win.
    assert.equal(hub.resolve('mayor', fn.get('send_gmail_message')!)?.effect, 'public');
    assert.equal(hub.resolve('mayor', fn.get('draft_gmail_message')!)?.effect, 'write');
    const ms = directoryEntry('ms-365')!, cls = (name: string) => effectOf({effects: ms.effects}, {name, inputSchema: {}, annotations: {readOnlyHint: false, openWorldHint: true}});
    assert.deepEqual(['send-mail', 'send-draft-message', 'reply-mail-message', 'create-draft-email', 'create-reply-draft'].map(cls), ['public', 'public', 'public', 'write', 'write']);
    assert.deepEqual([ms.type, ms.command, ms.args?.[1], ms.env?.MS365_MCP_OAUTH_TOKEN, ms.client, ms.license], ['stdio', 'npx', '@softeria/ms-365-mcp-server@0.179.1', '${OAUTH_ACCESS_TOKEN}', 'microsoft', 'MIT']);
  } finally { await hub.dispose(); g.close(); }
});

test('Composio is in the directory, managed in the cloud, off by default and not offered to cats', async () => {
  const {g, hub} = await setup();
  try {
    const c = directoryEntry('composio')!;
    assert.equal(c.managed, 'cloud');
    assert.match(c.description, /pass through Composio/);
    assert.ok(!hub.publicConnectors().some(x => x.id === 'composio'), 'not a starter');
    assert.ok(!directoryList().includes('composio'));
    assert.equal(hub.addDirectory('composio').enabled, false);
    // Only Composio is managed; the trial mail servers run on this computer.
    assert.deepEqual(DIRECTORY.filter(d => d.managed).map(d => d.id), ['composio']);
  } finally { await hub.dispose(); g.close(); }
});

test('the owner-client routes: a guided setup the UI renders, the secret never sent back, saved on the host computer only', async () => {
  const {g, hub} = await setup();
  const app = Fastify();
  app.setErrorHandler((e: any, _req, res) => res.code(e.statusCode || 400).send({error: e.message}));
  registerConnectorRoutes(app, hub, {canWrite: () => true, cats: () => [], town: () => ({}) as any});
  try {
    const setupPage = (await app.inject({method: 'GET', url: '/api/owner-clients/setup'})).json();
    assert.equal(setupPage.google.redirectUri, 'http://127.0.0.1:4321/api/connectors/oauth/callback');
    assert.ok(setupPage.google.steps.some((s: any) => /In production/.test(s.title)));
    assert.ok(setupPage.google.scopes.includes('https://www.googleapis.com/auth/gmail.compose'));
    assert.equal(setupPage.microsoft.registerAs, 'http://localhost/api/connectors/oauth/callback');
    assert.ok(setupPage.microsoft.scopes.includes('offline_access'));
    const away = await app.inject({method: 'PUT', url: '/api/owner-clients/google', payload: CLIENT, remoteAddress: '192.168.1.20'});
    assert.equal(away.statusCode, 403);
    const put = await app.inject({method: 'PUT', url: '/api/owner-clients/microsoft', payload: {clientId: 'app-id', tenant: 'consumers'}});
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().clients.microsoft, {clientId: 'app-id', hasSecret: false, tenant: 'consumers', savedAt: Date.UTC(2026, 10, 7)});
    assert.equal((await app.inject({method: 'PUT', url: '/api/owner-clients/yahoo', payload: {clientId: 'x'}})).statusCode, 404);
    const added = await app.inject({method: 'POST', url: '/api/connectors/directory/ms-365/accounts', payload: {label: 'Work'}});
    assert.equal(added.json().connector.id, 'ms-365-work');
    const r = await hub.signIn('ms-365-work');
    const u = new URL(r.url);
    assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:4321/api/connectors/oauth/callback');
    assert.ok(u.searchParams.get('scope')!.includes('offline_access'));
    assert.equal((await app.inject({method: 'DELETE', url: '/api/owner-clients/microsoft'})).json().clients.microsoft, null);
  } finally { await app.close(); await hub.dispose(); g.close(); }
});

test('a Microsoft account is named by Graph me: its mail, else its user principal name', async () => {
  const me = (body: unknown) => (async (url: string | URL) => { assert.equal(String(url), 'https://graph.microsoft.com/v1.0/me'); return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}}); }) as typeof fetch;
  const p = {service: 'ms-365', token: 'at', userinfo: 'https://graph.microsoft.com/v1.0/me'};
  assert.deepEqual((await whoami(p, me({id: 'a1', mail: 'cat@contoso.example', userPrincipalName: 'cat@contoso.onmicrosoft.com'}), 5)).identity, {handle: undefined, email: 'cat@contoso.example', accountId: 'a1', checkedAt: 5});
  assert.equal((await whoami(p, me({id: 'a2', mail: null, userPrincipalName: 'cat@outlook.example'}), 5)).identity?.email, 'cat@outlook.example');
});

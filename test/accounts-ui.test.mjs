import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {healthOf, whoText, expiryLine, isReference, ownerConnected, summaryLine, directoryOrder, groupOf, serviceOf, serviceGroups, catsLine, modelHealth, createAccountsPanel, POLL_MS} from '../public/accounts-panel.js';
import {appsStep} from '../public/setup-hub.js';
import {fakeDocument, fakeWindow, fakeServer, settle, byKey, buttonByText} from './fixtures/fake-dom-accounts.mjs';

const DIRECTORY = [
  {id: 'context7', name: 'Context7', auth: 'none', url: 'https://mcp.context7.com/mcp'},
  {id: 'deepwiki', name: 'DeepWiki', auth: 'none'},
  {id: 'vercel', name: 'Vercel', auth: 'oauth'},
  {id: 'linear', name: 'Linear', auth: 'oauth', url: 'https://mcp.linear.app/mcp'},
  {id: 'github', name: 'GitHub', auth: 'token', url: 'https://api.githubcopilot.com/mcp/', tokenUrl: 'https://github.com/settings/tokens/new', tokenHelp: 'GitHub opens with the right boxes ticked.'},
  {id: 'google-workspace', name: 'Google Workspace (trial)', auth: 'oauth'},
];
const starter = {id: 'context7', name: 'Context7', source: 'directory', enabled: true, status: 'connected', auth: 'none', vars: [], cats: ['*'], tools: []};

test('health reads the account first and the live connection second, and is never Connected without a verified identity', () => {
  const on = {enabled: true, status: 'connected', auth: 'signed-in'};
  assert.deepEqual(healthOf({...on, enabled: false}), {state: 'off', tone: 'off', label: 'Off'});
  assert.equal(healthOf(on).label, 'Working · not verified');
  assert.equal(healthOf(on).tone, 'ok');
  assert.equal(healthOf({...on, account: {status: 'connected', identity: {handle: 'octocat', checkedAt: 1}}}).label, 'Connected');
  assert.equal(healthOf({...on, account: {status: 'unchecked', identity: null}}).label, 'Working · not verified');
  assert.equal(healthOf({...on, account: {status: 'wrong-account'}}).label, 'Wrong account');
  assert.equal(healthOf({...on, account: {status: 'expiring'}}).label, 'Ends soon');
  assert.equal(healthOf({...on, auth: 'expired'}).label, 'Expired');
  assert.equal(healthOf({enabled: true, status: 'needs-auth', auth: 'oauth'}).label, 'Needs sign-in');
  assert.equal(healthOf({id: 'github', enabled: true, status: 'needs-setup', auth: 'none'}, {directory: DIRECTORY}).label, 'Needs a token');
  assert.equal(healthOf({id: 'custom', enabled: true, status: 'needs-setup', auth: 'none'}, {directory: DIRECTORY}).label, 'Needs setup');
  assert.equal(healthOf({enabled: true, status: 'connecting'}).label, 'Starting…');
  assert.equal(healthOf({enabled: true, status: 'connecting'}, {stale: true}).label, 'Still starting…');
  assert.equal(healthOf({enabled: true, status: 'error'}).label, 'Not answering');
  assert.equal(healthOf({...on, status: 'needs-auth'}, {signing: true}).label, 'Signing in…');
});

test('who an account is reads as @handle, else the email, else the id; the expiry reads in hours or days, and only when it cannot renew', () => {
  assert.equal(whoText({handle: 'octocat', email: 'o@x.com'}), '@octocat');
  assert.equal(whoText({handle: '@examplecat'}), '@examplecat');
  assert.equal(whoText({email: 'me@example.com', accountId: '42'}), 'me@example.com');
  assert.equal(whoText({accountId: '42'}), '42');
  assert.equal(whoText('@octocat'), '@octocat');
  assert.equal(whoText(null), null);
  assert.equal(whoText({}), null);
  const now = 1_000_000_000;
  assert.equal(expiryLine(now + 3 * 3_600_000, now), 'The sign-in ends in 3 hours.');
  assert.equal(expiryLine(now + 1_000, now), 'The sign-in ends in 1 hour.');
  assert.equal(expiryLine(now + 5 * 86_400_000, now), 'The sign-in ends in 5 days.');
  assert.equal(expiryLine(now - 1, now), 'The sign-in has ended.');
  assert.equal(expiryLine(now + 5 * 86_400_000, now, true), '', 'a sign-in that renews itself has no end to show');
  assert.equal(expiryLine(null, now), '');
  assert.equal(expiryLine(undefined, now), '');
});

test('Ready counts only what the owner connected: a no-sign-in starter is reference, not an account (F12)', () => {
  const github = {id: 'github', source: 'directory', enabled: true, status: 'connected', auth: 'none', vars: [{name: 'GITHUB_PERSONAL_ACCESS_TOKEN', set: true}]};
  const linear = {id: 'linear', source: 'directory', enabled: true, status: 'needs-auth', auth: 'oauth', vars: []};
  assert.equal(isReference(starter), true);
  assert.equal(isReference(github), false);
  assert.equal(ownerConnected(starter), false);
  assert.equal(ownerConnected(github), true);
  assert.equal(ownerConnected({...github, enabled: false}), false);
  assert.equal(summaryLine([starter, {...starter, id: 'deepwiki'}]), 'Nothing connected yet. Add a service below.');
  assert.equal(summaryLine([starter, github]), '1 connected');
  assert.equal(summaryLine([starter, github, linear]), '1 connected · 1 needs you');
  assert.equal(summaryLine([linear, {...linear, id: 'vercel'}]), '2 need you');
  // The setup hub's Apps row uses the same rule.
  assert.equal(appsStep([starter, {...starter, id: 'deepwiki', name: 'DeepWiki'}]).state, 'optional');
  assert.equal(appsStep([starter, {...github, name: 'GitHub'}]).text, 'GitHub connected.');
});

test('the directory leads with assistant services, then build tools, then reference docs, and search filters it', () => {
  assert.deepEqual(directoryOrder(DIRECTORY).map(d => d.id), ['google-workspace', 'github', 'linear', 'vercel', 'context7', 'deepwiki']);
  assert.deepEqual(DIRECTORY.map(groupOf), ['reference', 'reference', 'build', 'assistant', 'assistant', 'assistant']);
  assert.deepEqual(directoryOrder(DIRECTORY, 'lin').map(d => d.id), ['linear']);
  assert.deepEqual(directoryOrder(DIRECTORY, 'nothing like it'), []);
});

test('accounts group by service: an added account keeps its entry, a copy is found by address, and Instagram copies are one service', () => {
  assert.equal(serviceOf({id: 'github-work', entry: 'github'}, DIRECTORY), 'github');
  assert.equal(serviceOf({id: 'linear-copy', url: 'https://mcp.linear.app/mcp'}, DIRECTORY), 'linear');
  assert.equal(serviceOf({id: 'instagram-examplecat', instagram: true}, DIRECTORY), 'instagram');
  assert.equal(serviceOf({id: 'my-server', url: 'https://example.com/mcp'}, DIRECTORY), 'my-server');
  const groups = serviceGroups([starter, {id: 'github', name: 'GitHub', vars: [{name: 'T', set: true}]}, {id: 'github-work', entry: 'github', name: 'GitHub · Work'}, {id: 'ig-a', instagram: true, name: 'instagram @a'}, {id: 'ig-b', instagram: true, name: 'instagram @b'}], DIRECTORY);
  assert.deepEqual(groups.map(g => [g.service, g.name, g.accounts.length]), [['github', 'GitHub', 2], ['instagram', 'Instagram', 2], ['context7', 'Context7', 1]], 'the reference starter goes last');
});

test('the cats line and the AI model rows say who and what in plain words', () => {
  const cats = [{id: 'mayor', name: 'Mayor'}, {id: 'reel', name: 'Reel Builder'}];
  assert.equal(catsLine(['*'], cats), 'Every cat may use it.');
  assert.equal(catsLine([], cats), 'No cat may use it yet.');
  assert.equal(catsLine(['mayor', 'reel'], cats), 'Mayor, Reel Builder may use it.');
  assert.equal(catsLine(['a', 'b', 'c', 'd', 'e'], cats), 'a, b, c and 2 more may use it.');
  assert.deepEqual(modelHealth('plan', {enabled: true, configured: true, available: true}), {tone: 'ok', label: 'Signed in'});
  assert.deepEqual(modelHealth('plan', {enabled: true, configured: false, available: false, installed: true}), {tone: 'warn', label: 'Needs sign-in'});
  assert.deepEqual(modelHealth('plan', {enabled: true, configured: false, installed: false}), {tone: 'warn', label: 'Not installed'});
  assert.deepEqual(modelHealth('key', {enabled: true, configured: false}), {tone: 'warn', label: 'Needs a key'});
  assert.deepEqual(modelHealth('local', {enabled: true, configured: false, available: false}), {tone: 'warn', label: 'Not answering'});
  assert.deepEqual(modelHealth('key', {enabled: false, hasKey: true}), {tone: 'off', label: 'Off'});
  assert.equal(modelHealth('key', {enabled: false}), null, 'not set up at all: named on one line instead');
});

// ---- The panel ----

const CATS = [{id: 'mayor', name: 'Mayor'}, {id: 'reel', name: 'Reel Builder'}];
function mount(routes = {}, {connectors = [starter], extra = {}} = {}) {
  const doc = fakeDocument(), win = fakeWindow();
  const data = {connectors, directory: DIRECTORY, cats: CATS, builtins: {code_workspace: 'allow', generate_image: 'allow', generate_video: 'ask', save_artifact: 'allow'}, builtinCatTools: {}, sites: []};
  const server = fakeServer({
    'GET /api/connectors': () => data,
    'GET /api/cat-browser': () => ({mode: 'own', tokenSet: false, extension: 'https://chromewebstore.google.com/detail/x'}),
    'GET /api/models/status': () => ({claude: {name: 'Claude plan · opus', enabled: true, configured: true, available: true}, chatgpt: {enabled: false}, local: {name: 'Local AI', enabled: true, configured: false, available: false}}),
    'GET /api/telegram': () => ({configured: false}),
    'GET /api/discord': () => ({configured: true, bot: 'mayor_bot', paired: true, connected: true, error: null}),
    ...routes,
  });
  server.data = data;
  const surfaces = [], button = doc.createElement('button');
  button.hidden = true;
  const panel = createAccountsPanel({button, doc, win, fetchImpl: server.fetch, ask: async () => true, openSurface: name => surfaces.push(name), ...extra});
  const body = () => panel.dialog.querySelector('div.ac-body');
  const row = id => body().querySelector(`li[data-id="${id}"]`);
  return {doc, win, server, panel, button, surfaces, body, row};
}

test('the entry shows only where the owner route answers, and the hub paints with no literal null or undefined (F11)', async t => {
  const host = mount();
  t.after(() => host.doc.restore());
  assert.equal(await host.panel.probe(), true);
  assert.equal(host.button.hidden, false);
  await host.panel.open();
  await settle();
  const text = host.body().textContent;
  assert.doesNotMatch(text, /\bnull\b|\bundefined\b/);
  assert.match(text, /Nothing connected yet\. Add a service below\./, 'the starter does not count');
  assert.match(text, /Reference for cats · no sign-in/);
  assert.match(text, /Claude plan · opus/);
  assert.match(text, /Not set up: ChatGPT plan\./);
  assert.match(text, /Paired with your DM on mayor_bot/);
  // The dev server keeps saved keys in plain text: one quiet line says so (GET /api/state secrets).
  host.win.dispatchEvent({type: 'town-state', detail: {next: {secrets: {mode: 'plaintext', note: 'Saved keys are stored unencrypted on this computer.'}}}});
  assert.equal(host.body().querySelector('p.ac-secrets').textContent, 'Saved keys are stored unencrypted on this computer.');
  host.win.dispatchEvent({type: 'town-state', detail: {next: {secrets: {mode: 'encrypted', note: null}}}});
  assert.equal(host.body().querySelector('p.ac-secrets'), null);
  const viewer = mount({'GET /api/connectors': () => new Error('Owner only.')});
  assert.equal(await viewer.panel.probe(), false);
  assert.equal(viewer.button.hidden, true);
});

test('Add on a sign-in service switches it on, gives it to every cat and opens its sign-in in one tap; the row updates when it finishes', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let linear = null;
  const p = mount({
    'POST /api/connectors/directory/linear': (_, s) => { linear = {id: 'linear', name: 'Linear', source: 'directory', enabled: false, status: 'off', auth: 'oauth', vars: [], cats: [], tools: []}; s.data.connectors.push(linear); return {connector: linear}; },
    'PATCH /api/connectors/linear': body => { Object.assign(linear, body, {status: 'needs-auth'}); return {connector: linear}; },
    'POST /api/connectors/linear/sign-in': () => ({url: 'https://mcp.linear.app/authorize?state=abc', finish: 'callback'}),
  });
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  byKey(p.body(), 'dir:linear').click();
  await settle();
  assert.deepEqual(p.server.calls.filter(c => c[0] !== 'GET').map(c => [c[0], c[1], c[2]]), [
    ['POST', '/api/connectors/directory/linear', {}],
    ['PATCH', '/api/connectors/linear', {enabled: true, cats: ['*']}],
    ['POST', '/api/connectors/linear/sign-in', {}],
  ]);
  assert.deepEqual(p.win.opened, ['https://mcp.linear.app/authorize?state=abc']);
  assert.match(p.row('linear').textContent, /Signing in…/);
  assert.match(p.row('linear').querySelector('.cf-box').textContent, /The Linear sign-in page opened\. Finish there; this updates by itself\./);
  // The callback lands on the server; the next poll sees it.
  Object.assign(linear, {status: 'connected', auth: 'signed-in', account: {status: 'connected', identity: {email: 'me@example.com', checkedAt: 1}}});
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(p.row('linear').querySelector('.cf-box'), null, 'the sign-in box is gone');
  assert.match(p.row('linear').textContent, /Signed in as me@example\.com/);
  assert.match(p.row('linear').textContent, /Connected/);
  assert.match(p.row('linear').textContent, /Signed in to Linear\./);
});

test('a sign-in that finishes by device code shows the code; one that cannot start says why on the new row', async t => {
  const p = mount({
    'POST /api/connectors/directory/vercel': (_, s) => { const c = {id: 'vercel', name: 'Vercel', source: 'directory', enabled: true, status: 'needs-auth', auth: 'oauth', vars: [], cats: ['*'], tools: []}; s.data.connectors.push(c); return {connector: c}; },
    'PATCH /api/connectors/vercel': () => ({}),
    'POST /api/connectors/vercel/sign-in': () => new Error('fetch failed'),
    'POST /api/connectors/directory/linear': (_, s) => { const c = {id: 'linear', name: 'Linear', source: 'directory', enabled: true, status: 'needs-auth', auth: 'oauth', vars: [], cats: ['*'], tools: []}; s.data.connectors.push(c); return {connector: c}; },
    'PATCH /api/connectors/linear': () => ({}),
    'POST /api/connectors/linear/sign-in': () => ({url: 'https://mcp.linear.app/device', finish: 'device', device: {userCode: 'WDJB-MJHT', expiresAt: Date.now() + 600_000}}),
  });
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  byKey(p.body(), 'dir:vercel').click();
  await settle();
  assert.match(p.row('vercel').textContent, /Added Vercel\. Every cat may use it\. The sign-in did not start: fetch failed/);
  byKey(p.body(), 'dir:linear').click();
  await settle();
  assert.equal(p.row('linear').querySelector('.cf-code').textContent, 'WDJB-MJHT');
  assert.deepEqual(p.win.opened, [], 'a device sign-in waits for the owner to read the code first');
  p.panel.close();
});

test('Add on a token service opens its token box; a pasted token shows who it signs in as, or the service’s reason', async t => {
  let github = null, answer = {account: {status: 'connected', reason: '', identity: '@octocat'}};
  const p = mount({
    'POST /api/connectors/directory/github': (_, s) => { github = {id: 'github', name: 'GitHub', source: 'directory', enabled: true, status: 'needs-setup', auth: 'none', vars: [{name: 'GITHUB_PERSONAL_ACCESS_TOKEN', set: false}], cats: ['*'], tools: []}; s.data.connectors.push(github); return {connector: github}; },
    'PATCH /api/connectors/github': () => ({}),
    'POST /api/connectors/github/token': () => ({ok: true, ...answer}),
  });
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  byKey(p.body(), 'dir:github').click();
  await settle();
  const row = () => p.row('github');
  assert.match(row().textContent, /Needs a token/);
  assert.doesNotMatch(row().textContent, /GITHUB_PERSONAL_ACCESS_TOKEN/, 'the token box says what it needs, not the variable');
  assert.equal(row().querySelector('a.cx-open').getAttribute('href'), 'https://github.com/settings/tokens/new');
  const form = () => row().querySelector('form.ac-token');
  await form().onsubmit({preventDefault() {}});
  assert.match(row().textContent, /Paste the token first\./);
  assert.equal(p.server.calls.some(c => c[1].endsWith('/token')), false, 'an empty box never posts');
  const input = byKey(row(), 'ac:github:token-input');
  input.value = '  ghp_example  ';
  input.oninput();
  await form().onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(p.server.calls.find(c => c[1].endsWith('/token')), ['POST', '/api/connectors/github/token', {token: 'ghp_example'}]);
  assert.match(row().textContent, /Signed in as @octocat\./);
  // A refused token: the reason, not a success.
  answer = {account: {status: 'needs-sign-in', reason: 'GitHub refused the sign-in (HTTP 401).', identity: null}};
  byKey(row(), 'ac:github:token').click();
  const again = byKey(row(), 'ac:github:token-input');
  again.value = 'ghp_bad'; again.oninput();
  await form().onsubmit({preventDefault() {}});
  await settle();
  assert.match(row().textContent, /GitHub refused the sign-in \(HTTP 401\)\./);
  assert.doesNotMatch(row().textContent, /Signed in as @octocat/, 'an old identity is not kept after a refusal');
});

test('an account says who it is, when it ends and which cats may use it; cats and tool choices save with PATCH', async t => {
  const now = Date.UTC(2026, 10, 7);
  const ig = {id: 'instagram-a', name: 'instagram @examplecat', instagram: true, source: 'custom', enabled: true, status: 'connected', auth: 'none', vars: [{name: 'INSTAGRAM_ACCESS_TOKEN', set: true}], cats: ['mayor'], tools: [{name: 'publish_reel', title: 'Publish a Reel', permission: 'ask'}, {name: 'list_media', permission: 'allow', readOnly: true}],
    account: {status: 'expiring', identity: {handle: 'examplecat', checkedAt: 1}, expiresAt: now + 5 * 86_400_000, refreshable: false}};
  const p = mount({'PATCH /api/connectors/instagram-a': body => ({connector: {...ig, ...body}})}, {connectors: [ig], extra: {now: () => now}});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  const row = () => p.row('instagram-a');
  assert.match(row().textContent, /Signed in as @examplecat/);
  assert.match(row().textContent, /Ends soon/);
  assert.match(row().textContent, /The sign-in ends in 5 days\./);
  byKey(row(), 'ac:instagram-a:more').click();
  assert.match(row().textContent, /Mayor may use it\./);
  assert.match(row().textContent, /What cats may do \(2 tools\)/);
  byKey(row(), 'ac:instagram-a:cat:reel').click();
  await settle();
  assert.deepEqual(p.server.calls.filter(c => c[0] === 'PATCH').at(-1), ['PATCH', '/api/connectors/instagram-a', {cats: ['mayor', 'reel']}]);
  byKey(row(), 'ac:instagram-a:tool:publish_reel:off').click();
  await settle();
  assert.deepEqual(p.server.calls.filter(c => c[0] === 'PATCH').at(-1), ['PATCH', '/api/connectors/instagram-a', {tools: {publish_reel: 'off'}}]);
  assert.equal(byKey(row(), 'ac:instagram-a:tool:list_media:allow').getAttribute('aria-pressed'), 'true');
});

test('Add another account of a directory service names it and starts its sign-in, but gives it to no cat by surprise', async t => {
  const linear = {id: 'linear', name: 'Linear', source: 'directory', enabled: true, status: 'connected', auth: 'signed-in', vars: [], cats: ['*'], tools: []};
  const p = mount({
    'POST /api/connectors/directory/linear/accounts': (body, s) => { const c = {id: 'linear-work', entry: 'linear', name: `Linear · ${body.label}`, source: 'directory', enabled: true, status: 'needs-auth', auth: 'oauth', vars: [], cats: [], tools: []}; s.data.connectors.push(c); return {connector: c}; },
    'POST /api/connectors/linear-work/sign-in': () => ({url: 'https://mcp.linear.app/authorize?w=1', finish: 'callback'}),
  }, {connectors: [linear]});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  byKey(p.body(), 'svc:linear:another').click();
  const field = byKey(p.body(), 'svc:linear:label');
  field.value = 'Work'; field.oninput();
  await p.body().querySelector('li[data-service="linear"]').querySelector('form.ac-token').onsubmit({preventDefault() {}});
  await settle();
  const writes = p.server.calls.filter(c => c[0] !== 'GET').map(c => c[1]);
  assert.deepEqual(writes, ['/api/connectors/directory/linear/accounts', '/api/connectors/linear-work/sign-in']);
  assert.match(p.row('linear-work').textContent, /No cat may use it yet\./);
  assert.equal(p.body().querySelector('li[data-service="linear"]').querySelectorAll('li.ac-account').length, 2, 'both accounts sit under one service');
  p.panel.close();
});

test('a card that says Starting… is read again until the server answers, then the polling stops (F11)', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const linear = {id: 'linear', name: 'Linear', source: 'directory', enabled: true, status: 'connecting', auth: 'oauth', vars: [], cats: ['*'], tools: []};
  const p = mount({}, {connectors: [linear]});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  assert.match(p.row('linear').textContent, /Starting…/);
  linear.status = 'needs-auth';
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.match(p.row('linear').textContent, /Needs sign-in/);
  assert.ok(buttonByText(p.row('linear'), 'Sign in'), 'its fix is one tap');
  const reads = p.server.calls.length;
  t.mock.timers.tick(POLL_MS * 5);
  await settle();
  assert.equal(p.server.calls.length, reads, 'nothing is starting, so nothing polls');
});

test('the built-in tools and a site’s browsing take Allow, Ask first or Off; the cats’ browser and AI models are one tap away', async t => {
  const p = mount({'PATCH /api/connectors/builtin:tools': body => ({id: 'builtin:tools', tools: body.tools}), 'PATCH /api/connectors/browser%3Ax.com': body => ({id: 'browser:x.com', ...body})});
  p.server.data.sites = [{id: 'browser:x.com', host: 'x.com', permission: 'allow', catTools: {}}];
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  assert.match(p.body().textContent, /Code workspace.*Make images.*Make videos.*Save to the gallery/);
  assert.equal(byKey(p.body(), 'bt:generate_video:ask').getAttribute('aria-pressed'), 'true');
  byKey(p.body(), 'bt:code_workspace:ask').click();
  await settle();
  assert.deepEqual(p.server.calls.filter(c => c[0] === 'PATCH').at(-1), ['PATCH', '/api/connectors/builtin:tools', {tools: {code_workspace: 'ask'}}]);
  byKey(p.body(), 'site:x.com:off').click();
  await settle();
  assert.deepEqual(p.server.calls.filter(c => c[0] === 'PATCH').at(-1), ['PATCH', '/api/connectors/browser%3Ax.com', {tools: {browse: 'off'}}]);
  byKey(p.body(), 'models:open').click();
  assert.deepEqual(p.surfaces, ['models']);
  assert.equal(p.panel.dialog.open, false, 'the hub steps aside for the other panel');
});

test('typing in the directory search filters the list under it and leaves the box itself in place', async t => {
  const p = mount();
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  const search = byKey(p.body(), 'dir:search');
  search.value = 'lin';
  search.oninput();
  assert.equal(byKey(p.body(), 'dir:search'), search, 'the same box, so focus and the caret stay');
  assert.deepEqual(p.body().querySelector('div.ac-dir').querySelectorAll('[data-key]').map(n => n.dataset.key), ['dir:linear']);
  search.value = 'zzz';
  search.oninput();
  assert.match(p.body().querySelector('div.ac-dir').textContent, /Nothing matches that search\./);
});

test('☰ > Devices & AI lists Accounts & connections on the host, and app.js wires it and its surface', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<section id="settings-devices"[^]*?<button id="share"[^>]*>Devices<\/button><button id="accounts-open" data-owner data-host hidden aria-haspopup="dialog" data-note="[^"]+">Accounts &amp; connections<\/button>/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /const accountsPanel=createAccountsPanel\(\{button:\$\('accounts-open'\)\}\);\nvoid accountsPanel\.probe\(\);/);
  assert.match(app, /accounts:\(\)=>void accountsPanel\.open\(\)/);
  const css = readFileSync(new URL('../public/accounts-panel.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css.replace(/#accounts-dialog/g, '')), false, 'theme tokens only, no raw colours');
  assert.match(css, /@media\(max-width:600px\)\{\n  #accounts-dialog\{inset:0;width:100%;max-width:none;height:100dvh/, 'a full-screen page on phones');
  const hub = readFileSync(new URL('../public/setup-hub.js', import.meta.url), 'utf8');
  assert.match(hub, /openOther\('accounts', '#accounts-open'\)/, 'the setup hub’s Apps row opens the hub');
});

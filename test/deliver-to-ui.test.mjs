import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {writeServices, readServices, deliverMenu, createGalleryView} from '../public/gallery-view.js';
import {deliverPlan} from '../public/chat-thread.js';
import {FakeDocument, FakeWindow} from './fixtures/fake-dom-palette.mjs';
import {browserPath, startScratch, newPage, loadApp, openMayorChat, answerQuick, DEMO_GOAL} from './helpers/chat-spine-scratch.mjs';

// Plan 11.24 (N17): "Deliver to" on a result and on an artifact lists the owner's connected write services (Notion, Google Workspace,
// Microsoft 365) and sends one request: a follow-up inside the result's own request where the engine takes one, else a new request to the
// Mayor. The cat writes through the connector, so Allow, Ask or Off and the publish ledger (row 0.1) gate it as any other write; the page
// never calls a service. The rules first, then the Archive's menu in a fake DOM, then a real browser on a scratch server
// (test/helpers/chat-spine-scratch.mjs: own ports, a temporary data folder, Demonstration, no Internet) at 1440 x 900 and 375 x 812.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOON = '2026-11-09T12:00:00.000Z';
const ART = '7c1e2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const writes = (permission = 'ask') => [{name: 'notion-create-pages', permission, readOnly: false}, {name: 'notion-search', permission: 'allow', readOnly: true}];
const NOTION = {id: 'notion', entry: 'notion', name: 'Notion', source: 'directory', enabled: true, status: 'connected', cats: ['*'], tools: writes()};
const connectors = [
  NOTION,
  {id: 'google-workspace-work', entry: 'google-workspace', name: 'Google Workspace · Work', enabled: true, status: 'connected', cats: ['scholar'], tools: writes('allow')},
  {id: 'google-workspace', entry: 'google-workspace', name: 'Google Workspace (trial)', enabled: true, status: 'connected', cats: ['*'], tools: writes('off')},
  {id: 'ms-365', entry: 'ms-365', name: 'Microsoft 365 (trial)', enabled: true, status: 'needs-auth', cats: ['*'], tools: []},
  {id: 'ms-365-home', entry: 'ms-365', name: 'Microsoft 365 · Home', enabled: false, status: 'off', cats: ['*'], tools: writes()},
  {id: 'notion-2', entry: 'notion', name: 'Notion · Club', enabled: true, status: 'connected', cats: [], tools: writes()},
  {id: 'linear', entry: 'linear', name: 'Linear', enabled: true, status: 'connected', cats: ['*'], tools: writes()},
];

test('the menu lists only connected write services a cat may write with: on, connected, given to a cat, a write tool not Off', () => {
  assert.deepEqual(writeServices(connectors), [
    {id: 'notion', name: 'Notion', to: 'my Notion as a new page'},
    {id: 'google-workspace-work', name: 'Google Workspace · Work', to: 'my Google Drive'},
  ], 'every write tool Off, signed out, switched off, given to no cat, or not a write service: left out');
  assert.deepEqual(writeServices([{...connectors[3], status: 'connected', tools: writes()}]), [{id: 'ms-365', name: 'Microsoft 365', to: 'my OneDrive'}], '"(trial)" is not part of the name');
  for (const odd of [undefined, null, {}, 'x', [null]]) assert.deepEqual(writeServices(odd), [], `${JSON.stringify(odd)}: none`);
});

test('a refused, failed or odd read of /api/connectors is no service, so the menu hides', async () => {
  const answer = body => async () => body;
  assert.deepEqual(await readServices(answer({ok: true, json: async () => ({connectors})})), writeServices(connectors));
  assert.deepEqual(await readServices(answer({ok: false, json: async () => ({error: 'Only the owner can do that.'})})), [], 'a viewer gets 403');
  assert.deepEqual(await readServices(answer({ok: true, json: async () => null})), []);
  assert.deepEqual(await readServices(async () => { throw new TypeError('Failed to fetch'); }), []);
  assert.equal(deliverMenu([], () => {}), null);
});

test('one tap is a follow-up inside the owner’s own request, in its own reasoning; anything else asks the Mayor anew, naming the artifact', () => {
  const service = writeServices(connectors)[0];
  const root = {id: 'r', cat: 'scholar', from: 'owner', text: 'Plan the fair.', mode: 'demo', status: 'done'};
  const turn = {id: 'f', cat: 'scholar', from: 'owner', parent: 'r', mode: 'demo', status: 'done'};
  const town = {tasks: [root, turn], models: [], townDefault: null, cats: [{id: 'mayor'}]};
  assert.deepEqual(deliverPlan({task: 'f', ids: [], service}, town),
    {cat: 'scholar', parent: 'r', mode: 'demo', text: 'Save your result in this request to my Notion as a new page. Use the Notion connector.'}, 'a follow-up’s result: the root is the parent');
  assert.deepEqual(deliverPlan({task: 'r', ids: [ART], service}, town),
    {cat: 'scholar', parent: 'r', mode: 'demo', text: `Save artifact ${ART} to my Notion as a new page. Use the Notion connector.`});
  assert.equal(deliverPlan({task: 'r', ids: [ART, 'b'], service}, town).text, `Save artifacts ${ART} and b to my Notion as a new page. Use the Notion connector.`);
  // The engine takes no follow-up on these (engine.ts submit and followUp): a goal round, a routine run, a record, Hermes, a member's tree.
  for (const [why, odd] of [['goal', {goal: 'g'}], ['routine', {routine: 'w'}], ['record', {record: true}], ['Hermes', {mode: 'hermes'}], ['member', {by: 'ana'}]]) {
    const tasks = [{...root, ...odd}];
    assert.deepEqual(deliverPlan({task: 'r', ids: [ART], service}, {...town, tasks}),
      {cat: 'mayor', mode: 'demo', text: `Save artifact ${ART} to my Notion as a new page. Use the Notion connector.`}, `${why}: a new request to the Mayor`);
    assert.equal(deliverPlan({task: 'r', ids: [], service}, {...town, tasks}), null, `${why}: with no artifact to name, nothing to deliver`);
  }
  assert.equal(deliverPlan({task: 'gone', ids: [ART], service}, town).cat, 'mayor', 'an artifact whose request the page does not know: the Mayor');
  assert.equal(deliverPlan({task: 'gone', ids: [ART], service}, {...town, models: [{id: 'local', label: 'Ollama', models: ['qwen3']}]}).mode, 'local', 'the town’s default reasoning, as askMayorToReviewGoals sends');
});

test('the result bubble and the Archive draw one menu (gallery-view.js deliverMenu); the page never posts to a service', () => {
  const thread = read('chat-thread.js'), gallery = read('gallery-view.js');
  assert.match(thread, /api\('chat',plan\)/, 'the thread sends through POST /api/chat, as a typed message');
  assert.match(thread, /win\.addEventListener\?\.\('deliver-to'/);
  assert.match(gallery, /win\.dispatchEvent\?\.\(new CustomEvent\('deliver-to'/);
  for (const [file, source] of [['chat-thread.js', thread], ['gallery-view.js', gallery]]) {
    assert.ok(!/notion\.com|googleapis|graph\.microsoft/.test(source), `${file} names no service address`);
    assert.equal((source.match(/deliverMenu\(/g) ?? []).length, file === 'gallery-view.js' ? 2 : 1, `${file}: one menu, one builder`);
  }
});

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
// The Artist tab's gallery in the fake DOM, on a real EventTarget for the window, so a real CustomEvent reaches the stand-in thread.
function mountGallery(list) {
  const doc = new FakeDocument(), win = new EventTarget();
  new FakeWindow(doc);
  globalThis.document = doc;
  globalThis.Option = function Option(text, value) { const o = doc.createElement('option'); o.textContent = text; o.value = value; return o; };
  const root = doc.createElement('div');
  doc.body.append(root);
  const artifact = {id: ART, title: 'Fair plan', kind: 'markdown', file: `${ART}.md`, cat: 'mayor', task: 'r', project: null, createdAt: NOON, size: 20};
  const fetchImpl = async url => url === '/api/artifacts' ? {ok: true, json: async () => ({artifacts: [artifact]})}
    : url === '/api/connectors' ? {ok: true, json: async () => ({connectors: list})} : url === '/api/projects' ? {ok: true, json: async () => []} : {ok: true, text: async () => '# Fair plan'};
  const gallery = createGalleryView(root, {fetchImpl, win});
  return {doc, win, gallery, viewer: () => doc.body.querySelector('.gallery-viewer')};
}

test('the Archive: Deliver to sits in the reader’s bar; one tap sends one event naming the artifact and its request, and says what happened', async () => {
  const g = mountGallery(connectors), asked = [];
  let settle;
  g.win.addEventListener('deliver-to', event => { asked.push(structuredClone({...event.detail})); event.detail.sent = new Promise(resolve => { settle = resolve; }); });
  await g.gallery.load();
  g.gallery.openArtifact(ART);
  await tick();
  const bar = g.viewer().querySelector('.gallery-bar'), menu = bar.querySelector('details.deliver');
  assert.ok(menu, 'in the bar, beside Download and Copy');
  assert.equal(menu.querySelector('summary').textContent, 'Deliver to');
  const buttons = menu.querySelectorAll('button');
  assert.deepEqual(buttons.map(b => b.textContent), ['Notion', 'Google Workspace · Work']);
  buttons[0].click();
  await tick();
  assert.deepEqual(asked, [{task: 'r', ids: [ART], service: writeServices(connectors)[0]}], 'one event, naming the artifact and the request it came from');
  assert.ok(buttons.every(b => b.disabled), 'every button waits while it is on its way, so a second tap sends nothing (the browser proof counts the posts)');
  settle('Asked Mayor.');
  await tick();
  assert.equal(bar.querySelector('.deliver-note').textContent, 'Asked Mayor.');
  assert.ok(!menu.open && buttons.every(b => !b.disabled), 'the menu folds; another service can still be chosen');
});

test('the Archive: with no thread to answer, the menu says to ask the Mayor; with no write service connected, it is hidden', async () => {
  const g = mountGallery(connectors);
  await g.gallery.load();
  g.gallery.openArtifact(ART);
  await tick();
  g.viewer().querySelector('details.deliver button').click();
  await tick();
  assert.equal(g.viewer().querySelector('.deliver-note').textContent, 'Ask the Mayor in its chat instead.');
  const none = mountGallery([{...NOTION, status: 'needs-auth'}]);
  await none.gallery.load();
  none.gallery.openArtifact(ART);
  await tick();
  assert.ok(none.viewer().querySelector('.gallery-bar'), 'the reader is open');
  assert.equal(none.viewer().querySelector('.deliver'), null, 'no menu');
});

// ---- The browser: a scratch server, a Demonstration request with its result, and a fixture Notion served for GET /api/connectors. ----
const skip = !browserPath && 'no Chromium, Edge or Chrome here';
let scratch, browser, root;
before(async () => {
  if (skip) return;
  scratch = await startScratch();
  const {chromium} = await import('playwright-core');
  browser = await chromium.launch({executablePath: browserPath, headless: true});
});
after(async () => {
  await browser?.close();
  await scratch?.close();
});

// The tasks the server shows: /api/state keeps only unfinished ones (store.ts snapshot), so the Mayor's chat page adds its newest finished ones.
const state = page => page.evaluate(async () => {
  const [s, chat] = await Promise.all(['/api/state', '/api/chats/mayor'].map(u => fetch(u).then(r => r.json())));
  return {tasks: [...new Map([...chat.tasks, ...s.tasks].map(t => [t.id, t])).values()]};
});
const roots = s => s.tasks.filter(t => !t.parent).length;
// Runs in the page: the menu's controls and the result's (or reader's) other buttons, open, with their boxes and the pairs that overlap.
const LAYOUT = scope => {
  const box = document.querySelector(scope), menu = box.querySelector('details.deliver');
  const parts = [...box.querySelectorAll('.chat-copy, .gallery-bar > a, .gallery-bar > button'), menu.querySelector('summary'), ...menu.querySelectorAll('button')]
    .map(e => { const r = e.getBoundingClientRect(); return {name: e.textContent.trim(), left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height}; });
  const overlaps = [];
  for (const [i, a] of parts.entries()) for (const b of parts.slice(i + 1)) {
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${a.name}/${b.name}`);
  }
  return {parts, overlaps, scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth, right: Math.max(...parts.map(p => p.right))};
};
function checkLayout(t, label, layout) {
  t.diagnostic(`${label}: ${layout.parts.map(p => `${p.name} ${Math.round(p.width)}x${Math.round(p.height)}`).join(', ')}; scrollWidth ${layout.scrollWidth} of ${layout.width}`);
  assert.equal(layout.scrollWidth, layout.width, `${label}: no horizontal scroll`);
  assert.ok(layout.right <= layout.width, `${label}: every control on screen`);
  for (const p of layout.parts) assert.ok(p.width >= 44 && p.height >= 44, `${label}: ${p.name} is ${Math.round(p.width)}x${Math.round(p.height)}, a 44px target`);
  assert.deepEqual(layout.overlaps, [], `${label}: nothing overlaps`);
}
// Every POST /api/chat the page makes; one that is not a Demonstration is refused here, so no model is ever called.
async function watchChat(page) {
  const posts = [];
  await page.route('**/api/chat', route => {
    const body = route.request().postDataJSON();
    posts.push(body);
    return body?.mode === 'demo' ? route.continue() : route.abort();
  });
  return posts;
}
const withNotion = page => page.route('**/api/connectors', route => route.fulfill({json: {connectors: [NOTION], directory: [], cats: [], builtins: [], builtinCatTools: {}, sites: []}}));
const artifactFor = task => ({id: ART, title: 'Fair plan', kind: 'markdown', file: `${ART}.md`, mime: 'text/markdown', cat: 'mayor', task, project: null, createdAt: NOON, size: 20});
async function withArtifact(page, task) {
  await page.route('**/api/artifacts', route => route.fulfill({json: {artifacts: [artifactFor(task)], kinds: [], limits: {}}}));
  await page.route(`**/artifacts/${ART}`, route => route.fulfill({contentType: 'text/markdown', body: '# Fair plan\nStalls by the river.'}));
}
// Taps a destination and waits for its request to land: returns the body posted and the follow-up the server made of it.
async function deliver(page, scope, posts) {
  const before = posts.length, s0 = await state(page);
  await page.locator(`${scope} details.deliver button`, {hasText: 'Notion'}).click();
  await page.locator(`${scope} .deliver-note`, {hasText: 'Asked'}).waitFor({timeout: 10_000});
  assert.equal(posts.length, before + 1, 'one tap, one request');
  const s1 = await state(page), body = posts.at(-1);
  return {body, rootsBefore: roots(s0), rootsAfter: roots(s1), made: s1.tasks.filter(t => t.from === 'owner' && t.text === body.text && !s0.tasks.some(o => o.id === t.id))};
}
function checkFollowUp(made, expected) {
  assert.deepEqual(made.body, expected, 'the request names the result or artifact and the service, as a follow-up in Demonstration');
  assert.equal(made.rootsAfter, made.rootsBefore, 'no new request: the same thread continues');
  assert.equal(made.made.length, 1, 'one task made of it');
  assert.equal(made.made[0].parent, root.id, 'inside the same request');
}

test('proof at 1440 x 900: no write service, no menu; with one, a result’s Deliver to and the Archive’s each send one follow-up in the same request', {skip, timeout: 240_000}, async t => {
  const {ctx, page, errors} = await newPage(browser, {width: 1440, height: 900});
  try {
    const posts = await watchChat(page), reads = [];
    page.on('response', r => { if (r.url().endsWith('/api/connectors')) reads.push(r.status()); });
    await loadApp(page, scratch.url);
    await openMayorChat(page);
    await answerQuick(page, 'thread');
    await page.locator('#chat .chat-copy').first().waitFor({timeout: 30_000});
    root = (await state(page)).tasks.find(t => !t.parent && t.text === DEMO_GOAL);
    assert.equal(root?.status, 'done', 'the Demonstration request finished with its result');
    await page.waitForTimeout(800);
    assert.ok(reads.includes(200), 'the page read the connectors (the scratch town has none)');
    assert.equal(await page.locator('#chat .deliver').count(), 0, 'with no write service connected, the menu is hidden');

    await withNotion(page);
    await page.reload();
    await page.waitForFunction(() => !document.body.classList.contains('connecting') && !!document.querySelector('#cats .cat-button'));
    await openMayorChat(page);
    await page.locator('#chat details.deliver summary').first().waitFor({timeout: 15_000});
    assert.equal(await page.locator('#chat details.deliver').count(), 1, 'one result, one menu');
    await page.locator('#chat details.deliver summary').click();
    checkLayout(t, 'result at 1440', await page.evaluate(LAYOUT, '#chat .chat-message:has(details.deliver)'));
    checkFollowUp(await deliver(page, '#chat', posts), {cat: root.cat, parent: root.id, mode: 'demo', text: 'Save your result in this request to my Notion as a new page. Use the Notion connector.'});

    await withArtifact(page, root.id);
    await page.evaluate(() => window.openSurface('archive'));
    await page.waitForSelector('#archive-panel[open]');
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('open-artifact', {detail: {id}})), ART);
    await page.locator('#archive-panel details.deliver summary').waitFor({timeout: 15_000});
    await page.locator('#archive-panel details.deliver summary').click();
    checkLayout(t, 'Archive at 1440', await page.evaluate(LAYOUT, '#archive-panel .gallery-viewer:not([hidden])'));
    checkFollowUp(await deliver(page, '#archive-panel', posts), {cat: root.cat, parent: root.id, mode: 'demo', text: `Save artifact ${ART} to my Notion as a new page. Use the Notion connector.`});
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('proof at 375 x 812: the result’s and the Archive’s Deliver to fit the phone and each send one follow-up in the same request', {skip, timeout: 240_000}, async t => {
  assert.ok(root, 'the 1440 proof made the request first');
  const {ctx, page, errors} = await newPage(browser, {width: 375, height: 812, phone: true});
  try {
    const posts = await watchChat(page);
    await withNotion(page);
    await loadApp(page, scratch.url);
    await openMayorChat(page);
    const menu = page.locator('#chat .chat-message:has(.chat-copy) details.deliver').first();
    await menu.locator('summary').waitFor({timeout: 15_000});
    await menu.locator('summary').scrollIntoViewIfNeeded();
    await menu.locator('summary').click();
    checkLayout(t, 'result at 375', await page.evaluate(LAYOUT, '#chat .chat-message:has(details.deliver[open])'));
    checkFollowUp(await deliver(page, '#chat', posts), {cat: root.cat, parent: root.id, mode: 'demo', text: 'Save your result in this request to my Notion as a new page. Use the Notion connector.'});

    await withArtifact(page, root.id);
    await page.evaluate(() => window.openSurface('archive'));
    await page.waitForSelector('#archive-panel[open]');
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('open-artifact', {detail: {id}})), ART);
    await page.locator('#archive-panel details.deliver summary').waitFor({timeout: 15_000});
    await page.locator('#archive-panel details.deliver summary').click();
    checkLayout(t, 'Archive at 375', await page.evaluate(LAYOUT, '#archive-panel .gallery-viewer:not([hidden])'));
    checkFollowUp(await deliver(page, '#archive-panel', posts), {cat: root.cat, parent: root.id, mode: 'demo', text: `Save artifact ${ART} to my Notion as a new page. Use the Notion connector.`});
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

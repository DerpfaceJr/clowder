import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {browserPath, startScratch, newPage, loadApp} from './helpers/chat-spine-scratch.mjs';
import {SETUP_ASK, WSL_ASK, SETUP_CONFIRM, WSL_CONFIRM} from '../public/models-panel.js';

// docs/ux-ui-improvements.md row 9: no page script calls the browser's own confirm box. The workshop setup and the WSL install in AI
// models were the last two; they now ask with confirmDialog (public/dialogs.js) like every other confirm, in the same words, with
// Cancel focused when the dialog opens. The sources are read first; then a real browser on a scratch server
// (test/helpers/chat-spine-scratch.mjs: own ports, a temporary data folder, no Internet) runs both flows at 1024 x 768 and 375 x 812
// with /api/workshop answered by the test, so nothing is installed. Skipped where no Chromium, Edge or Chrome is installed.
const PUBLIC = new URL('../public/', import.meta.url);
const sources = readdirSync(PUBLIC, {recursive: true}).map(String).filter(f => /\.(js|mjs|html)$/.test(f)).sort();
const read = name => readFileSync(new URL(name.replaceAll('\\', '/'), PUBLIC), 'utf8').replace(/\r\n/g, '\n');
// A call of the browser's box: confirm( on its own, or reached through window, globalThis or self. confirmDialog( and x.confirm( are not.
const NATIVE = /(?<![.\w$])confirm\s*\(|\b(?:window|globalThis|self)\s*(?:\.\s*confirm\b|\[\s*['"`]confirm['"`]\s*\])/;

test('no script or page under public/ calls the browser\'s confirm box', t => {
  assert.ok(sources.length >= 80 && sources.includes('models-panel.js') && sources.includes('index.html'), `${sources.length} files read`);
  t.diagnostic(`${sources.length} .js, .mjs and .html files read under public/`);
  for (const [text, hit] of [['if(!window.confirm(X))return;', true], ['if (confirm("Sure?")) go();', true], ['globalThis.confirm(x)', true], ["window['confirm'](x)", true],
    ['await confirmDialog({title})', false], ['api("workshop/install-wsl",{confirm:true})', false], ['box.confirm(x)', false], ['confirmFirst(ask)', false]]) {
    assert.equal(NATIVE.test(text), hit, `the pattern on: ${text}`);
  }
  const found = sources.flatMap(file => read(file).split('\n').map((line, i) => (NATIVE.test(line) ? `${file}:${i + 1}: ${line.trim().slice(0, 120)}` : null)).filter(Boolean));
  assert.deepEqual(found, []);
});

test('the workshop setup and the WSL install ask with confirmDialog, in the words the browser box had', () => {
  const panel = read('models-panel.js');
  assert.match(panel, /import \{confirmDialog\} from '\.\/dialogs\.js';/);
  assert.match(panel, /async function createWorkshop\(button\)\{\n\s*if\(!await confirmDialog\(SETUP_ASK\)\)return;/);
  assert.match(panel, /async function installWsl\(button\)\{\n\s*if\(!await confirmDialog\(WSL_ASK\)\)return;/);
  assert.equal(SETUP_ASK.message, SETUP_CONFIRM);
  assert.equal(WSL_ASK.message, WSL_CONFIRM);
  assert.match(SETUP_CONFIRM, /^Clowder will download the official Ubuntu base image, .* This can take a while\. Continue\?$/);
  assert.match(WSL_CONFIRM, /^Clowder’s cats need Windows Subsystem for Linux for their sandbox\. Install it now\? /);
  // The title is the button's own label, and neither is styled as a danger: an install, not a deletion.
  assert.match(panel, /'data-role':'create',text:'Create workshop'/);
  assert.match(panel, /'data-role':'install-wsl',text:'Install WSL'/);
  assert.deepEqual([SETUP_ASK.title, SETUP_ASK.confirmLabel, SETUP_ASK.cancelLabel, SETUP_ASK.danger], ['Create workshop', 'Continue', 'Cancel', undefined]);
  assert.deepEqual([WSL_ASK.title, WSL_ASK.confirmLabel, WSL_ASK.cancelLabel, WSL_ASK.danger], ['Install WSL', 'Install', 'Cancel', undefined]);
  // dialogs.js puts Cancel first in the dialog, which is what gives it focus on showModal().
  assert.match(read('dialogs.js'), /actions\.append\(cancel, ok\);/);
});

const skip = !browserPath && 'no Chromium, Edge or Chrome here';
let scratch, browser;
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

// Runs in the page: the styled confirm as it stands now.
const DIALOG = () => {
  const d = document.querySelector('dialog.confirm-dialog'), r = d?.getBoundingClientRect(), a = document.activeElement;
  return {open: !!d?.open, modal: !!d?.matches(':modal'), title: d?.querySelector('#confirm-title')?.textContent ?? '', message: d?.querySelector('#confirm-message')?.textContent ?? '',
    focus: a?.classList.contains('confirm-cancel') ? 'cancel' : a?.classList.contains('confirm-ok') ? 'ok' : a?.dataset?.role ?? a?.id ?? a?.tagName ?? '',
    box: r ? {left: r.left, top: r.top, right: r.right, bottom: r.bottom} : null,
    buttons: [...(d?.querySelectorAll('.confirm-actions button') ?? [])].map(b => { const q = b.getBoundingClientRect(); return {text: b.textContent, width: q.width, height: q.height}; }),
    scrollWidth: document.documentElement.scrollWidth};
};

const VIEWS = [{name: '1024 x 768', width: 1024, height: 768, phone: false}, {name: '375 x 812', width: 375, height: 812, phone: true}];
const FLOWS = [{name: 'workshop setup', wsl: true, role: 'create', ask: SETUP_ASK, path: '/api/workshop/setup', body: {}},
  {name: 'WSL install', wsl: false, role: 'install-wsl', ask: WSL_ASK, path: '/api/workshop/install-wsl', body: {confirm: true}}];

for (const view of VIEWS) for (const flow of FLOWS) {
  test(`the ${flow.name} asks in the styled dialog with Cancel focused, and installs only on its confirm button (${view.name})`, {skip, timeout: 120_000}, async () => {
    const {ctx, page, errors} = await newPage(browser, view);
    const natives = [], posts = [];
    page.on('dialog', dialog => { natives.push(dialog.message()); void dialog.dismiss(); });
    // The workshop's owner routes, answered here: no distro yet, WSL there or missing. Nothing reaches the scratch server's own.
    await page.route('**/api/workshop', route => route.fulfill({json: {distro: {present: false}, isolated: false, setup: {status: 'idle', wsl: flow.wsl}, tools: [], settings: {autoSetup: false}}}));
    await page.route('**/api/workshop/*', route => { posts.push({path: new URL(route.request().url()).pathname, body: route.request().postDataJSON()}); return route.fulfill({json: {}}); });
    await loadApp(page, scratch.url);
    await page.click('#models-chip');
    await page.waitForSelector('#models-dialog[open] [data-nav="workshop"]:not([hidden])', {timeout: 10_000});
    await page.click('#models-dialog [data-nav="workshop"]');
    const button = `#models-dialog [data-role="${flow.role}"]`;
    await page.waitForSelector(button, {state: 'visible', timeout: 5_000});

    // Opening it: the styled dialog, modal, in the same words, inside the window, with Cancel focused. No browser box.
    await page.click(button);
    await page.waitForSelector('dialog.confirm-dialog[open]', {timeout: 5_000});
    const asked = await page.evaluate(DIALOG);
    assert.ok(asked.modal, 'the confirm is modal, on top of AI models');
    assert.equal(asked.title, flow.ask.title);
    assert.equal(asked.message, flow.ask.message);
    assert.deepEqual(asked.buttons.map(b => b.text), ['Cancel', flow.ask.confirmLabel]);
    for (const b of asked.buttons) assert.ok(b.width >= 44 && b.height >= 44, `${b.text}: ${b.width} x ${b.height}, a 44px target`);
    assert.equal(asked.focus, 'cancel', 'Cancel has focus when the dialog opens');
    assert.ok(asked.box.left >= 0 && asked.box.top >= 0 && asked.box.right <= view.width + 0.5 && asked.box.bottom <= view.height + 0.5, `the dialog fits the window: ${JSON.stringify(asked.box)}`);
    assert.equal(asked.scrollWidth, view.width, 'no horizontal scroll');

    // Enter on the default (Cancel) installs nothing, and focus goes back to the button that asked.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('dialog.confirm-dialog')?.open);
    const cancelled = await page.evaluate(DIALOG);
    assert.equal(cancelled.open, false);
    assert.equal(cancelled.focus, flow.role, 'focus returns to the button');
    assert.deepEqual(posts, [], 'nothing was posted');

    // Escape cancels too.
    await page.click(button);
    await page.waitForSelector('dialog.confirm-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.confirm-dialog')?.open);
    assert.deepEqual(posts, [], 'Escape posted nothing');

    // The confirm button is the only way through: one POST, to the same route with the same body as before.
    await page.click(button);
    await page.waitForSelector('dialog.confirm-dialog[open]');
    // The panel reads the card again once its POST is answered: by then the POST is counted.
    const reread = page.waitForResponse(r => new URL(r.url()).pathname === '/api/workshop' && r.request().method() === 'GET', {timeout: 10_000});
    await page.click('dialog.confirm-dialog .confirm-ok');
    await reread;
    assert.equal(await page.evaluate(() => !!document.querySelector('dialog.confirm-dialog')?.open), false);
    assert.deepEqual(posts, [{path: flow.path, body: flow.body}]);
    assert.deepEqual(natives, [], 'the browser\'s own confirm box never opened');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

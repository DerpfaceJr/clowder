import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {browserPath, startScratch, newPage, loadApp, UNNAMED} from './helpers/chat-spine-scratch.mjs';
import {PROMPT_KEY} from '../public/notify-prompt.js';

// docs/design/menu-chat-mailman.md in a real browser, on a scratch server in Demonstration mode (test/helpers/chat-spine-scratch.mjs): ☰ is
// seven rows; the header logo's status dot reads Running or Paused and opens the Town panel; Options > Manage, the Mayor's corner chips and
// the panel commands open their panels as sheets over the thread (full-screen sheets at 375 px); the Post office; the Moonvault; More.
// Every surface keeps the page at its own width and every visible control named. Skipped where no Chromium, Edge or Chrome is installed.
const skip = !browserPath && 'no Chromium, Edge or Chrome here';
const SIZES = [{width: 375, height: 812, phone: true}, {width: 1440, height: 900, phone: false}];
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

async function open(size) {
  const context = await browser.newContext({viewport: {width: size.width, height: size.height}, ...(size.phone ? {isMobile: true, hasTouch: true} : {})});
  // The notifications card asks once per browser; answered here, so it never sits over a control below.
  await context.addInitScript(key => { try { localStorage.setItem(key, 'later'); } catch { /* storage off */ } }, PROMPT_KEY);
  const {ctx, page, errors} = await newPage(browser, {...size, context});
  await loadApp(page, scratch.url);
  // Probe-gated entries (Routines, Memory, the Post office's channels) show once their routes answer.
  await page.waitForFunction(() => ['routines-open', 'memory-open', 'usage-open', 'telegram-open'].every(id => { const el = document.getElementById(id); return el && !el.hidden; }), null, {timeout: 20_000});
  return {ctx, page, errors};
}
// The page keeps its width, and every control on screen has a name.
async function sound(page, width, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${label}: no sideways scroll`);
  const unnamed = await page.evaluate(UNNAMED);
  assert.equal(unnamed.count, 0, `${label}: unnamed control ${unnamed.sample[0] ?? ''}`);
}
const rect = (page, selector) => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height}; }, selector);
const closeAll = page => page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
// A sheet over the thread: the chat is still open under it, and on a phone it fills the screen.
async function overThread(page, size, selector, label, sheet = selector) {
  await page.waitForSelector(selector);
  assert.equal(await page.evaluate(() => !document.getElementById('inspector-panel').hidden), true, `${label}: the chat stays open under it`);
  if (size.phone) {
    const box = await rect(page, sheet);
    assert.ok(box.width >= size.width - 1 && box.height >= size.height - 1, `${label}: a full-screen sheet at ${size.width} px (${Math.round(box.width)} x ${Math.round(box.height)})`);
  }
  await sound(page, size.width, label);
}

for (const size of SIZES) {
  test(`☰ is seven rows, and the header status dot opens the Town panel to pause and resume (${size.width} px)`, {skip, timeout: 120_000}, async () => {
    const {ctx, page, errors} = await open(size);
    await page.click('#menu-toggle');
    await page.waitForSelector('#town-menu[open]');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#settings-list .menu-row-title')].map(n => n.textContent)),
      ['Appearance', 'Sound & notifications', 'Screen & app', 'Devices', 'AI models', 'Worlds', 'Backups']);
    await sound(page, size.width, '☰');
    await closeAll(page);

    assert.equal(await page.getAttribute('#town-status', 'data-state'), 'running');
    assert.equal(await page.getAttribute('#town-status', 'aria-label'), 'Town running. Open town controls to pause');
    const dot = await rect(page, '#town-status');
    assert.ok(dot.width >= 44 && dot.height >= 44, `the dot's target is ${dot.width} x ${dot.height}`);
    await page.click('#town-status');
    await page.waitForSelector('#town-menu[open] #settings-town:not([hidden])');
    assert.equal(await page.textContent('#town-menu-title'), 'Town controls', 'headed by the words the dot says it opens');
    assert.equal(await page.isVisible('#settings-back'), false, 'opened on its own: no Back');
    await sound(page, size.width, 'the Town panel');
    await page.click('#pause');
    await page.waitForSelector('#town-status[data-state="paused"]');
    assert.equal(await page.textContent('#town-status .town-status-word'), 'Paused');
    await page.click('#town-status');
    await page.waitForSelector('#town-menu[open] #settings-town:not([hidden])');
    assert.equal(await page.textContent('#pause'), 'Resume town');
    await page.click('#pause');
    await page.waitForSelector('#town-status[data-state="running"]');
    // The ☰ list comes back on its own rows afterwards, never on the Town page.
    await page.click('#menu-toggle');
    await page.waitForSelector('#town-menu[open]');
    assert.equal(await page.isVisible('#settings-list'), true);
    await closeAll(page);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`chat manages everything: Options > Manage, the Mayor's corner and the panel commands open sheets over the thread (${size.width} px)`, {skip, timeout: 180_000}, async () => {
    const {ctx, page, errors} = await open(size);
    // The Mayor's corner and the setup card.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#corner-chips .corner-chip')].map(b => b.textContent)), ['Autonomy', 'Routines']);
    assert.equal(await page.getAttribute('#corner-chips', 'aria-label'), 'What Mayor looks after');
    await page.waitForSelector('#setup-card:not([hidden])', {state: 'attached'});
    assert.equal(await page.textContent('#setup-card .setup-card-title'), 'Set up Clowder');
    // Under 900px both step aside so the conversation keeps half the pane (Gate 11 F9); Options > Manage holds them.
    assert.deepEqual(await page.evaluate(() => ['#corner-chips', '#setup-card'].map(s => getComputedStyle(document.querySelector(s)).display === 'none')), size.phone ? [true, true] : [false, false]);
    await sound(page, size.width, 'the Mayor’s corner');

    // Options > Manage.
    await page.click('#composer-options');
    await page.waitForSelector('#composer-options-menu:not([hidden]) #composer-manage');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#composer-manage .manage-row:not([hidden])')].map(r => `${r.querySelector('.manage-who').textContent}: ${[...r.querySelectorAll('.manage-item:not([hidden])')].map(b => b.textContent).join(', ')}`)),
      ['Mayor: Autonomy, Routines', 'Mailman: Channels, Sign-ins, Apps', 'Banker: Money, Usage', 'Archivist: Memory, Backups']);
    assert.match(await page.textContent('#manage-setup'), /^Set up Clowder · \d+ of \d+ ready$/, 'Set up Clowder heads Manage while setup is not complete');
    for (const box of await page.evaluate(() => [...document.querySelectorAll('#composer-manage .manage-item')].map(b => b.getBoundingClientRect().height))) assert.ok(box >= 44, `a Manage item is ${box}px tall`);
    await sound(page, size.width, 'Options > Manage');
    await page.click('#routines-open');
    await overThread(page, size, '#routines-dialog[open]', 'Routines from Manage');
    assert.equal(await page.isVisible('#composer-options-menu'), false, 'Options closed first');
    await closeAll(page);

    // The Mayor's corner chip opens the autonomy page over the thread; on a phone, Manage's Autonomy does.
    if (size.phone) { await page.click('#composer-options'); await page.click('#autonomy-open'); }
    else await page.click('#corner-chips .corner-chip[data-item="autonomy"]');
    await overThread(page, size, '#town-menu[open][data-over="thread"] #settings-autonomy:not([hidden])', 'Autonomy from the corner', '#town-menu');
    if (!size.phone) assert.equal(Math.round((await rect(page, '#town-menu')).right), size.width, 'from 900px it sits over the chat pane, on the right');
    await closeAll(page);

    // Commands: Enter picks the command from the list, and Enter again runs it.
    for (const [command, selector] of [['/connect', '#post-office-dialog[open]'], ['/money', '#treasury-dialog[open]'], ['/memory', '#memory-dialog[open]']]) {
      await page.fill('#message', command);
      await page.press('#message', 'Enter');
      await page.press('#message', 'Enter');
      await overThread(page, size, selector, command);
      assert.equal(await page.inputValue('#message'), '', `${command} empties the box`);
      await closeAll(page);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`the Post office, the Moonvault and More (${size.width} px)`, {skip, timeout: 120_000}, async () => {
    const {ctx, page, errors} = await open(size);
    await page.evaluate(() => window.openSurface('postoffice'));
    await page.waitForSelector('#post-office-dialog[open]');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#post-office-dialog .po-group:not([hidden]) > h3')].map(h => h.textContent)), ['Channels', 'Sign-ins', 'Apps']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#post-office-dialog [data-items="channels"] > button')].filter(b => !b.hidden).map(b => b.textContent)),
      ['Telegram', 'Discord', 'Email to the Mayor', 'Android ping']);
    await sound(page, size.width, 'the Post office');
    // An entry closes the Post office and opens its own panel.
    await page.click('#telegram-open');
    await page.waitForSelector('#telegram-dialog[open]');
    assert.equal(await page.evaluate(() => document.getElementById('post-office-dialog').open), false, 'never two dialogs stacked');
    await closeAll(page);

    await page.click('#treasury-button');
    await page.waitForSelector('#treasury-dialog[open]');
    assert.equal(await page.getAttribute('#vault-tab-money', 'aria-selected'), 'true', 'the Money pill opens Money');
    assert.equal(await page.isVisible('#vault-usage'), false);
    await sound(page, size.width, 'the Moonvault');
    await page.click('#vault-tab-usage');
    await page.waitForSelector('#vault-usage:not([hidden]) .us-facts');
    assert.equal(await page.textContent('#treasury-title'), 'Usage');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getAttribute('#vault-tab-money', 'aria-selected'), 'true', 'the arrow keys move between the tabs');
    await closeAll(page);

    // Search heads More under 900px (plan 11.7) and stands in the dock row with the rest from 900px (UX audit 2026-11-10, row 10).
    const more = ['Search', 'Cats', 'Diary', 'Archive', 'Memorial'];
    if (size.phone) {
      await page.click('#dock-more');
      await page.waitForSelector('#dock-more-menu.is-open');
    }
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#dock-more-menu > button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.querySelector('.dock-label').textContent)), more);
    await sound(page, size.width, 'More');
    await page.click('#toggle-memorial');
    await page.waitForSelector('#memorial-panel[open]');
    await closeAll(page);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

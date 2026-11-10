import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {browserPath, startScratch, newPage, loadApp, openMayorChat, askDemoDecision, CHAT_SHARE} from './helpers/chat-spine-scratch.mjs';

// Plan 11.15 (F9, chat-ux §3.1): the chat pane's header is one 48px row (avatar, name over status, the Conversation and Work tabs, ⋯ and
// close), and Visit home, Customize, Settings, Roads and Council open from the ⋯ menu, a native popover. The markup and the rules are read
// first; then a real browser on a scratch server (test/helpers/chat-spine-scratch.mjs: own ports, a temporary data folder, Demonstration,
// no Internet) checks the row at 375 x 812, 1024 x 768 and 1440 x 900 with a Demonstration decision, Gate 11's conversation share at 375, and that
// every moved control opens from ⋯ by keyboard. Skipped where no Chromium, Edge or Chrome is installed.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html'), css = read('chat-sheet.css'), app = read('app.js');
const between = (source, start, end) => { const at = source.indexOf(start); return source.slice(at, source.indexOf(end, at)); };
const pane = between(html, '<aside id="inspector-panel"', '</aside>');
const menu = between(pane, '<div id="pane-menu"', '<div id="quest-notice"');
const MOVED = ['visit-home', 'studio-house', 'tab-roads', 'tab-council'];

test('the pane header keeps no tools row: Visit home, Customize, Settings, Roads and Council sit in the ⋯ menu', () => {
  assert.ok(!pane.includes('class="chat-tools"') && !pane.includes('class="home-summary"'), 'the Visit home / Customize / Settings row is gone');
  assert.match(pane, /<button type="button" id="pane-menu-open" class="pane-menu-open" popovertarget="pane-menu" aria-label="Chat menu"><svg[^>]*aria-hidden="true"[^>]*><use href="#i-ellipsis"\/><\/svg><\/button>/);
  assert.match(menu, /^<div id="pane-menu" class="pane-menu" popover role="group" aria-label="Chat menu">/);
  for (const id of MOVED) {
    assert.match(menu, new RegExp(`<button type="button"[^>]*\\sid="${id}"[^>]*\\spopovertarget="pane-menu" popovertargetaction="hide">`), `${id} is in the menu and closes it as it opens its part`);
    assert.equal(html.split(`id="${id}"`).length, 2, `${id} is in the page once`);
  }
  // cat-settings-flyout.js finds the disclosure by this markup and moves its body into the flyout; the summary stays the toggle.
  // Its words are the sheet's heading ("Mayor’s settings", painted by app.js), so the menu holds no second "Settings" beside ☰'s.
  assert.match(menu, /<details class="chat-settings" data-owner><summary>Cat’s settings<\/summary><div class="settings-body">/);
  assert.match(menu, /<div class="pane-menu-views" role="tablist" aria-label="More chat views" aria-orientation="vertical"><button type="button" role="tab" id="tab-roads" data-tab="roads" aria-selected="false" aria-controls="roads"/);
  assert.match(menu, /<button type="button" id="studio-house" data-owner /, 'Customize stays the owner’s');
  const bar = between(pane, '<div class="tab-list"', '</div>');
  assert.deepEqual([...bar.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]), ['chat', 'tasks', 'memory', 'gallery'], 'Conversation and Work stay tabs in the row');
  // The tabs stay the pane's own child, between the header and the conversation: mobile-ui.js puts the Inbox before them from 900px.
  const at = s => pane.indexOf(s);
  assert.ok(at('id="cat-header"') < at('<div class="tabs">') && at('<div class="tabs">') < at('id="pane-menu-open"') && at('id="pane-menu-open"') < at('id="chat"'));
  // Each moved control keeps the handler app.js gives it by id or data-tab, wherever it sits.
  assert.match(app, /\$\('visit-home'\)\.onclick=/);
  assert.match(app, /\$\('studio-house'\)\.onclick=/);
  assert.match(app, /document\.querySelectorAll\('\[data-tab\]'\)\.forEach\(b=>b\.onclick=/);
});

test('the row is 48px, and the menu steps aside while the Settings sheet it opened is open', () => {
  assert.match(css, /\.immersive \.inspector\{--head-top:0px;--head-h:48px;/);
  assert.match(css, /\.immersive \.inspector #cat-header\{display:grid;grid-template-columns:auto minmax\(0,1fr\);grid-template-rows:24px 24px;/);
  assert.match(css, /\.pane-menu:has\(>\.chat-settings\[open\]\)\{display:none\}/);
  assert.match(css, /\.pane-menu \[hidden\],\.pane-menu #home-label\{display:none\}/, 'a hidden item stays hidden in the menu');
  assert.match(css, /\.immersive \.inspector:has\(#brain-card:not\(\[hidden\]\)\) #cat-header \.demo-line\{display:none\}/);
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

// Runs in the page: the row's parts and their boxes, the pairs that overlap, the header's own box, and the page's scroll width.
const ROW = () => {
  const parts = {avatar: '#cat-header .avatar', name: '#cat-header h2', status: '#cat-header .cat-status', conversation: '#tab-chat', work: '#tab-tasks',
    menu: '#pane-menu-open', close: '#inspector-panel > .panel-tools .panel-close'};
  const boxes = Object.fromEntries(Object.entries(parts).map(([k, s]) => {
    const e = document.querySelector(s), r = e?.getBoundingClientRect();
    return [k, r && r.width > 0 && getComputedStyle(e).visibility !== 'hidden' ? {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height} : null];
  }));
  const overlaps = [], list = Object.entries(boxes);
  for (const [i, [a, ra]] of list.entries()) for (const [b, rb] of list.slice(i + 1)) {
    if (ra && rb && Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 0.5 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 0.5) overlaps.push(`${a}/${b}`);
  }
  const head = document.getElementById('cat-header').getBoundingClientRect();
  return {boxes, overlaps, head: {top: head.top, height: head.height}, scrollWidth: document.documentElement.scrollWidth, tabsChild: !!document.querySelector('#inspector-panel > .tabs')};
};
const menuOpen = page => page.evaluate(() => document.getElementById('pane-menu').matches(':popover-open'));
const active = page => page.evaluate(() => {
  const e = document.activeElement, r = e?.getBoundingClientRect();
  return {id: e?.id ?? '', summary: !!e?.matches('#pane-menu .chat-settings>summary'), height: r?.height ?? 0, width: r?.width ?? 0};
});

// From the tab bar's tab stop: Tab reaches ⋯, Enter opens the menu.
async function openMenuByKeyboard(page) {
  await page.evaluate(() => { document.getElementById('pane-menu').hidePopover(); document.querySelector('#inspector-panel .tab-list [tabindex="0"]').focus(); });
  await page.keyboard.press('Tab');
  assert.equal((await active(page)).id, 'pane-menu-open', 'Tab from the tabs reaches ⋯');
  await page.keyboard.press('Enter');
  assert.ok(await menuOpen(page), 'Enter on ⋯ opens the menu');
}
// Tab from ⋯ until the item has focus; the item is at least 44px tall.
async function tabTo(page, label, reached) {
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const a = await active(page);
    if (reached(a)) { assert.ok(a.height >= 44 && a.width >= 44, `${label}: ${a.width} x ${a.height}, a 44px target`); return; }
  }
  assert.fail(`${label} is not reached by Tab from ⋯`);
}
async function backToConversation(page) {
  if (await page.evaluate(() => document.getElementById('inspector-panel').hidden || document.body.classList.contains('chat-rail'))) await openMayorChat(page);
  await page.click('#tab-chat');
}

// 1024 x 768 too, the width every UI change is checked at (plan §4.1).
const VIEWS = [{name: '375 x 812', width: 375, height: 812, phone: true}, {name: '1024 x 768', width: 1024, height: 768, phone: false}, {name: '1440 x 900', width: 1440, height: 900, phone: false}];
const pct = x => `${(x * 100).toFixed(1)}%`;
for (const view of VIEWS) {
  test(`the header is one 48px row at ${view.name} with one decision, and every moved control opens from ⋯ by keyboard`, {skip, timeout: 240_000}, async t => {
    const {ctx, page, errors} = await newPage(browser, view);
    await loadApp(page, scratch.url);
    await openMayorChat(page);
    await askDemoDecision(page);
    await page.waitForTimeout(800);

    const row = await page.evaluate(ROW);
    assert.ok(row.tabsChild, 'the tabs are still the pane’s own child');
    assert.ok(row.head.height <= 48.5, `header ${row.head.height}px, one 48px row`);
    for (const [part, box] of Object.entries(row.boxes)) {
      assert.ok(box, `${part} shows`);
      assert.ok(box.top >= row.head.top - 0.5 && box.bottom <= row.head.top + 48.5, `${part} sits in the row`);
    }
    for (const part of ['conversation', 'work', 'menu', 'close']) assert.ok(row.boxes[part].width >= 44 && row.boxes[part].height >= 44, `${part}: a 44px target`);
    assert.deepEqual(row.overlaps, [], 'nothing in the row overlaps');
    assert.equal(row.scrollWidth, view.width, 'no horizontal scroll');

    // Gate 11 (F9): the conversation's share of the pane at 375 x 812 with one decision (baseline 29%). box: #chat's height over the
    // pane's, the conversation's area; shown: the messages on screen inside it (gate8.mjs prints both).
    const share = await page.evaluate(CHAT_SHARE);
    t.diagnostic(`${view.name}: conversation ${pct(share.box)} of the pane (${Math.round(share.chat)} of ${Math.round(share.sheet)} px); messages shown ${pct(share.shownShare)} (${Math.round(share.shown)} px)`);
    if (view.phone) assert.ok(share.box >= 0.5, `conversation ${pct(share.box)} of the pane at 375, at least 50%`);

    // Settings: its sheet opens and the menu steps aside; Escape closes the sheet and puts focus back on Settings in the menu.
    await openMenuByKeyboard(page);
    await tabTo(page, 'Settings', a => a.summary);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cat-settings-flyout:not([hidden])', {timeout: 5_000});
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('pane-menu')).display), 'none', 'the menu steps aside for the Settings sheet');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cat-settings-flyout', {state: 'hidden', timeout: 5_000});
    assert.ok((await active(page)).summary, 'focus is back on Settings');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('pane-menu')).display), 'grid', 'and the menu shows again');

    // Roads and Council: the pane switches and the menu closes, focus back on ⋯.
    for (const [label, id, pane] of [['Roads', 'tab-roads', 'roads'], ['Council', 'tab-council', 'council']]) {
      await openMenuByKeyboard(page);
      const menuBox = await page.evaluate(() => { const r = document.getElementById('pane-menu').getBoundingClientRect(); return {left: r.left, right: r.right}; });
      assert.ok(menuBox.left >= 0 && menuBox.right <= view.width, 'the menu is on screen');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), view.width, 'no horizontal scroll with the menu open');
      await tabTo(page, label, a => a.id === id);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`#${pane}:not([hidden])`, {timeout: 5_000});
      assert.equal(await menuOpen(page), false, `${label} closes the menu`);
      assert.equal((await active(page)).id, 'pane-menu-open', 'focus is back on ⋯');
      assert.equal(await page.getAttribute(`#${id}`, 'aria-selected'), 'true');
      await backToConversation(page);
    }

    // Customize opens the Studio.
    await openMenuByKeyboard(page);
    await tabTo(page, 'Customize', a => a.id === 'studio-house');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#studio:not([hidden])', {timeout: 10_000});
    assert.equal(await menuOpen(page), false, 'Customize closes the menu');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#studio', {state: 'hidden', timeout: 10_000});
    await backToConversation(page);

    // Visit home shows the town: the chat sheet closes or folds, and the menu with it.
    await openMenuByKeyboard(page);
    await tabTo(page, 'Visit home', a => a.id === 'visit-home');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('inspector-panel').hidden || document.body.classList.contains('chat-rail'), null, {timeout: 5_000});
    assert.equal(await menuOpen(page), false, 'Visit home closes the menu');

    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  });
}

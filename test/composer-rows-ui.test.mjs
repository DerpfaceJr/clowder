import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {browserPath, startScratch, newPage, loadApp, openMayorChat, askDemoDecision} from './helpers/chat-spine-scratch.mjs';
import {fitComposer} from '../public/chat-sheet.js';

// docs/ux-ui-improvements.md row 2: the composer's text box gets a row of its own with Send where the form is narrow, and the thread
// switcher, Attach and Options sit on a small row above it (public/chat-composer.css says where and why, with the measured widths).
//   From 900px (the 360px side pane): always. Under 600px (a phone's sheet): once the box holds text; an empty box keeps the one row,
//   because Gate 11 (docs/product-plan.md, held by test/pane-header-ui.test.mjs) keeps the conversation at half the pane at 375 x 812.
//   600 to 899px: one row, as before.
// The rules are read first. Then a real browser on a scratch server (test/helpers/chat-spine-scratch.mjs: own ports, a temporary data
// folder, Demonstration, no Internet) measures the composer at 1024 x 768, 375 x 812 and 768 x 1024 with getBoundingClientRect: the text
// box's share of the form, 44px targets, the order on screen against the DOM, the hidden states, a three-line draft, the brain card and
// the decision strip, the "/" list and the note, and a phone with its keyboard up (a 520px tall window). Skipped where no Chromium,
// Edge or Chrome is installed.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('chat-composer.css').replace(/\/\*[\s\S]*?\*\//g, '');

test('the text box spans every column but Send\'s: always from 900px, and under 600px once it holds text', () => {
  const block = query => { const at = css.indexOf(`@media(${query}){`); assert.ok(at >= 0, `@media(${query})`); return css.slice(at, css.indexOf('\n}', at)); };
  const wide = block('min-width:900px'), phone = block('max-width:599px');
  assert.match(wide, /\.immersive \.inspector #chat-form>#message\{grid-column:1\/-2\}/);
  assert.match(wide, /\.immersive \.inspector #chat-form>div:has\(> #send\)\{grid-column:-2\/-1\}/);
  assert.match(phone, /\.immersive \.inspector #chat-form>#message:not\(:placeholder-shown\)\{grid-column:1\/-2\}/);
  assert.match(phone, /#message:not\(:placeholder-shown\)~div:has\(> #send\)\{grid-column:-2\/-1\}/);
  assert.ok(!/placeholder-shown/.test(wide), 'from 900px the rows do not wait for text');
  assert.ok(!/:focus/.test(wide + phone), 'the rows never follow focus (ux-audit F15)');
  // The second row costs the pane 36px, not 48: no bottom margin, 4px block padding, a 2px row gap.
  assert.match(wide, /\.immersive \.inspector #chat-form\{margin-bottom:0;padding-block:4px;row-gap:2px\}/);
  // The text box has a placeholder in the page and app.js always sets one, so :placeholder-shown means "empty".
  assert.match(read('index.html'), /<textarea id="message"[^>]* placeholder="[^"]+"/);
  // The "/" and "@" list opens on the text box, over the small row.
  assert.match(css, /@supports\(anchor-name:--a\)\{\s*\.immersive \.inspector #chat-form>#message\{anchor-name:--composer-box\}\s*\.immersive \.inspector #chat-form>\.slash-list\{position-anchor:--composer-box;bottom:anchor\(top\)\}\s*\}/);
});

test('the text box grows only while a pane that cannot scroll has the room, and never under its 44px', () => {
  const had = globalThis.getComputedStyle;
  globalThis.getComputedStyle = el => ({overflowY: el.overflowY});
  try {
    // A box whose text needs `lines` px, in a pane of 600px that holds `rest` px of other things.
    const make = (overflowY = 'hidden') => {
      const style = {}, writes = [];
      const height = () => parseFloat(style.height) || 44;
      const box = {value: '', clientWidth: 290, lines: 44, style: new Proxy(style, {set(t, k, v) { t[k] = v; writes.push(k); return true; }}),
        get scrollHeight() { return Math.max(this.lines, height()); }, get offsetHeight() { return height(); }};
      const pane = {overflowY, clientHeight: 600, rest: 400, get scrollHeight() { return Math.max(this.clientHeight, this.rest + height()); }};
      return {box, pane, style, writes, fit: () => fitComposer(box, {pane})};
    };
    const t = make();
    t.box.value = 'five lines'; t.box.lines = 107; t.fit();
    assert.deepEqual([t.style.height, t.style.overflowY], ['107px', 'hidden'], 'room: the box takes its text');
    t.writes.length = 0; t.fit();
    assert.deepEqual(t.writes, [], 'the same text with room is not measured again');
    t.pane.rest = 520; t.fit();
    assert.deepEqual([t.style.height, t.style.overflowY], ['80px', 'auto'], 'the pane lost 27px of room: the box gives them back and scrolls its text');
    assert.equal(t.pane.scrollHeight, t.pane.clientHeight, 'nothing runs past the pane\'s foot');
    t.pane.rest = 590; t.fit();
    assert.deepEqual([t.style.height, t.style.overflowY], ['44px', 'auto'], 'never under 44px');
    t.pane.rest = 400; t.fit();
    assert.deepEqual([t.style.height, t.style.overflowY], ['107px', 'hidden'], 'the room is back: so is the height, with the same text');
    t.box.value = ''; t.box.lines = 44; t.fit();
    assert.deepEqual([t.style.height, t.style.overflowY], ['44px', 'hidden']);
    // A phone's sheet scrolls and pins the composer (pinComposer), so there the box keeps its text's height.
    const phone = make('auto');
    phone.pane.rest = 590; phone.box.value = 'five lines'; phone.box.lines = 107; phone.fit();
    assert.deepEqual([phone.style.height, phone.style.overflowY], ['107px', 'hidden']);
    // The 132px cap stays.
    const long = make();
    long.box.value = 'ten lines'; long.box.lines = 212; long.fit();
    assert.deepEqual([long.style.height, long.style.overflowY], ['132px', 'auto']);
  } finally {
    if (had) globalThis.getComputedStyle = had; else delete globalThis.getComputedStyle;
  }
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

// Runs in the page: the composer's parts and their boxes, in one layout pass. hide: parts to hide first, the way chat-composer.js and
// chat-sheet.js do (the hidden attribute), measured before any repaint can put them back, then shown again.
const LAYOUT = (hide = []) => {
  const rect = el => { const r = el.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height}; };
  const shown = el => { if (!el) return false; const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const form = document.getElementById('chat-form'), pane = document.getElementById('inspector-panel'), chat = document.getElementById('chat');
  const parts = {threads: form.querySelector('.thread-switch:not(.composer-attach)'), attach: form.querySelector('.composer-attach'), options: document.getElementById('composer-options'),
    text: document.getElementById('message'), send: document.getElementById('send')};
  const was = hide.map(key => [parts[key], parts[key].hidden]);
  for (const key of hide) parts[key].hidden = true;
  const boxes = Object.fromEntries(Object.entries(parts).map(([key, el]) => [key, shown(el) ? rect(el) : null]));
  const there = Object.keys(boxes).filter(key => boxes[key]);
  // The order on screen: by row (a part is on a later row when it starts under the middle of the one before), then left to right.
  const screen = [...there].sort((a, b) => (Math.abs(boxes[a].top - boxes[b].top) > 22 ? boxes[a].top - boxes[b].top : boxes[a].left - boxes[b].left));
  const dom = [...there].sort((a, b) => (parts[a].compareDocumentPosition(parts[b]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const one = sel => { const el = document.querySelector(sel); return shown(el) ? rect(el) : null; };
  const last = chat.lastElementChild;
  const out = {form: rect(form), pane: rect(pane), chat: rect(chat), boxes, screen, dom, brain: one('#brain-card'), strip: one('#approvals'), slash: one('#slash-list'), note: one('#chat-form > .composer-note'),
    last: last && shown(last) ? rect(last) : null, sticky: getComputedStyle(form).position === 'sticky', boxScrolls: parts.text.style.overflowY === 'auto', scrollWidth: document.documentElement.scrollWidth,
    rows: getComputedStyle(form).gridTemplateRows.split(' ').length};
  for (const [el, hidden] of was) el.hidden = hidden;
  return out;
};
const SMALL = ['threads', 'attach', 'options'];
const meets = (a, b) => !!a && !!b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
const px = n => Math.round(n * 10) / 10;
const layout = (page, hide = []) => page.evaluate(LAYOUT, hide);
async function draft(page, text) {
  await page.locator('#message').fill(text);
  await page.waitForTimeout(150);
}

// Two rows: the small controls share a row above the text box, the text box and Send share the next, and the text box is wide.
function assertTwoRows(l, where) {
  const {text, send} = l.boxes;
  const small = SMALL.filter(key => l.boxes[key]);
  assert.ok(small.length > 0, `${where}: a small control shows`);
  for (const key of small) {
    assert.ok(l.boxes[key].bottom <= text.top + 0.5, `${where}: ${key} sits above the text box (${px(l.boxes[key].bottom)} <= ${px(text.top)})`);
    assert.ok(Math.abs(l.boxes[key].top - l.boxes[small[0]].top) <= 0.5, `${where}: ${key} is on the small row`);
  }
  assert.ok(send.left >= text.right && send.top >= text.top - 0.5 && send.bottom <= text.bottom + 0.5, `${where}: Send is on the text box's row`);
  assert.ok(text.width / l.form.width >= 0.7, `${where}: the text box is ${px(text.width)} of ${px(l.form.width)} px, ${px(text.width / l.form.width * 100)}%, at least 70%`);
}
// One row: every part is on the text box's row.
function assertOneRow(l, where) {
  for (const [key, box] of Object.entries(l.boxes)) if (box) assert.ok(box.top >= l.boxes.text.top - 0.5 && box.bottom <= l.boxes.text.bottom + 0.5, `${where}: ${key} is on the text box's row`);
  assert.equal(l.rows, 1, `${where}: the form has one row`);
}
// What holds in both: 44px targets, the DOM order on screen, nothing over the brain card or the strip, inside the form and the pane.
// scrolled: a phone's sheet that is shorter than its content scrolls under the pinned composer (chat-sheet.css), the brain card with
// it, as before; the strip is pinned too, so it is still checked.
function assertSound(l, where, width, {scrolled = false} = {}) {
  for (const [key, box] of Object.entries(l.boxes)) {
    if (!box) continue;
    assert.ok(box.width >= 44 && box.height >= 44, `${where}: ${key} is ${px(box.width)} x ${px(box.height)}, a 44px target`);
    assert.ok(box.left >= l.form.left && box.right <= l.form.right + 0.5 && box.top >= l.form.top && box.bottom <= l.form.bottom + 0.5, `${where}: ${key} is inside the composer`);
  }
  const list = Object.entries(l.boxes).filter(([, box]) => box);
  for (const [i, [a, ra]] of list.entries()) for (const [b, rb] of list.slice(i + 1)) assert.ok(!meets(ra, rb), `${where}: ${a} and ${b} do not overlap`);
  assert.deepEqual(l.screen, l.dom, `${where}: the order on screen is the DOM order, so Tab follows it`);
  if (!scrolled) assert.ok(!meets(l.form, l.brain), `${where}: the composer does not cover the brain card`);
  assert.ok(!meets(l.form, l.strip), `${where}: the composer does not cover the decision strip`);
  assert.ok(l.form.bottom <= l.pane.bottom + 0.5, `${where}: the composer ends inside its pane (${px(l.form.bottom)} <= ${px(l.pane.bottom)})`);
  assert.equal(l.scrollWidth, width, `${where}: no horizontal scroll`);
}
// The hidden states: each small control gives up its place, and with all three hidden the composer is the text box's one row.
async function assertHiddenStates(page, where, base) {
  for (const hide of [['attach'], ['options'], ['threads', 'attach'], ['attach', 'options']]) {
    const l = await layout(page, hide);
    for (const key of hide) assert.equal(l.boxes[key], null, `${where}, ${hide} hidden`);
    assertTwoRows(l, `${where}, ${hide} hidden`);
    const left = SMALL.filter(key => l.boxes[key]);
    assert.ok(Math.abs(l.boxes[left[0]].left - base.boxes.threads.left) <= 0.5, `${where}, ${hide} hidden: ${left[0]} starts the row, no gap left behind`);
    if (left[1]) assert.ok(l.boxes[left[1]].left - l.boxes[left[0]].right <= 8.5, `${where}, ${hide} hidden: ${left[1]} follows at the column gap`);
    assert.ok(Math.abs(l.form.height - base.form.height) <= 0.5, `${where}, ${hide} hidden: the composer keeps its height`);
    assert.ok(Math.abs(l.boxes.text.width - base.boxes.text.width) <= 0.5, `${where}, ${hide} hidden: the text box keeps its width`);
  }
  const bare = await layout(page, SMALL);
  assertOneRow(bare, `${where}, all three hidden`);
  assert.ok(Math.abs(bare.boxes.text.width - base.boxes.text.width) <= 0.5 && bare.boxes.text.width / bare.form.width >= 0.7, `${where}, all three hidden: the text box stays wide`);
  assert.ok(base.form.height - bare.form.height >= 44, `${where}, all three hidden: no empty row is left (${px(bare.form.height)} px against ${px(base.form.height)})`);
  return bare;
}
// A pending decision, asked once per scratch server: later pages find it waiting.
async function ensureDecision(page) {
  const waiting = () => page.waitForSelector('#approvals .decision-card[data-state="pending"]', {state: 'attached', timeout: 2_500}).then(() => true, () => false);
  if (!await waiting()) await askDemoDecision(page);
  await page.waitForTimeout(800);
}
// The strip shows a decision only while its card in the conversation is off screen (plan 11.6), as after the owner scrolls up.
async function showStrip(page) {
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 0; });
  await page.waitForSelector('#approvals .decision-card', {state: 'visible', timeout: 10_000});
  await page.waitForTimeout(300);
}

test('from 900px the text box has a row of its own with Send, and the small controls a row above it (1024 x 768)', {skip, timeout: 180_000}, async t => {
  const {ctx, page, errors} = await newPage(browser, {width: 1024, height: 768});
  await loadApp(page, scratch.url);
  await openMayorChat(page);
  await page.waitForTimeout(500);

  // At rest, with an empty box: the audit measured 105 of 360 px here.
  const rest = await layout(page);
  assert.deepEqual(rest.dom, ['threads', 'attach', 'options', 'text', 'send'], 'the owner has all five parts');
  assertTwoRows(rest, 'empty');
  assertSound(rest, 'empty', 1024);
  assert.ok(rest.brain, 'the brain card shows on a first run');
  t.diagnostic(`1024 x 768: text box ${px(rest.boxes.text.width)} of ${px(rest.form.width)} px (${px(rest.boxes.text.width / rest.form.width * 100)}%), composer ${px(rest.form.height)} px tall`);

  // Tab walks the screen order: Threads, Attach, Options, the text box, Send.
  await draft(page, 'A draft, so Send is on.');
  await page.locator('#chat-form .thread-switch:not(.composer-attach)').focus();
  const stops = [];
  for (let i = 0; i < 5; i++) {
    stops.push(await page.evaluate(() => { const a = document.activeElement; return a.id || (a.classList.contains('composer-attach') ? 'attach' : a.classList.contains('thread-switch') ? 'threads' : a.tagName); }));
    await page.keyboard.press('Tab');
  }
  assert.deepEqual(stops, ['threads', 'attach', 'composer-options', 'message', 'send']);
  const typed = await layout(page);
  assert.ok(Math.abs(typed.form.height - rest.form.height) <= 0.5 && Math.abs(typed.boxes.text.width - rest.boxes.text.width) <= 0.5, 'a one-line draft changes nothing here');

  const bare = await assertHiddenStates(page, '1024', rest);
  t.diagnostic(`1024 x 768, all three small controls hidden: composer ${px(bare.form.height)} px tall, text box ${px(bare.boxes.text.width)} px`);

  // The "/" list opens on the text box itself; the note opens above the composer. Neither moves the composer.
  await draft(page, '/');
  await page.waitForSelector('#slash-list:not([hidden])');
  const listed = await layout(page);
  assert.ok(listed.slash.bottom <= listed.boxes.text.top + 0.5 && listed.boxes.text.top - listed.slash.bottom <= 8, `the "/" list sits on the text box (${px(listed.slash.bottom)} against ${px(listed.boxes.text.top)})`);
  assert.ok(Math.abs(listed.form.height - rest.form.height) <= 0.5, 'the list is a popover: the composer keeps its height');
  await page.keyboard.press('Escape');
  await draft(page, '/ask');
  await page.keyboard.press('Escape');
  await page.locator('#message').press('Enter');
  await page.waitForSelector('#chat-form > .composer-note:not([hidden])');
  const noted = await layout(page);
  assert.ok(noted.note.bottom <= noted.boxes.text.top + 0.5 && noted.note.bottom <= noted.form.top + 0.5, 'the note is above the text box, over the foot of the conversation');
  assert.ok(Math.abs(noted.form.height - rest.form.height) <= 0.5);
  await draft(page, '');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('under 600px an empty box keeps the one row, and the text box takes its own row once it holds text (375 x 812)', {skip, timeout: 180_000}, async t => {
  const {ctx, page, errors} = await newPage(browser, {width: 375, height: 812, phone: true});
  await loadApp(page, scratch.url);
  await openMayorChat(page);
  await page.waitForTimeout(500);

  // Empty: one row, as before, so the conversation keeps its share (Gate 11: 8 px to spare at 375 x 812 with one decision).
  const rest = await layout(page);
  assertOneRow(rest, 'empty');
  assertSound(rest, 'empty', 375);
  assert.ok(rest.form.height <= 62, `empty: the composer is ${px(rest.form.height)} px tall, one row`);

  // With text: two rows, the audit's fix. The audit measured 129 of 375 px here.
  await draft(page, 'A goal for the Mayor');
  const typed = await layout(page);
  assert.deepEqual(typed.dom, ['threads', 'attach', 'options', 'text', 'send']);
  assertTwoRows(typed, 'with text');
  assertSound(typed, 'with text', 375);
  assert.ok(Math.abs(typed.boxes.send.left - rest.boxes.send.left) <= 0.5 && Math.abs(typed.form.bottom - rest.form.bottom) <= 0.5, 'Send and the composer\'s foot stay where they were: the composer grows upward');
  assert.ok(typed.sticky, 'the composer stays pinned to the sheet\'s foot');
  t.diagnostic(`375 x 812: text box ${px(rest.boxes.text.width)} of ${px(rest.form.width)} px empty (${px(rest.form.height)} px tall), ${px(typed.boxes.text.width)} px (${px(typed.boxes.text.width / typed.form.width * 100)}%) with text (${px(typed.form.height)} px tall)`);

  const bare = await assertHiddenStates(page, '375', typed);
  t.diagnostic(`375 x 812, all three small controls hidden, with text: composer ${px(bare.form.height)} px tall, text box ${px(bare.boxes.text.width)} px`);

  // The "/" list opens on the text box, and "/" is text: the box is on its own row while the list is open.
  await draft(page, '/');
  await page.waitForSelector('#slash-list:not([hidden])');
  const listed = await layout(page);
  assertTwoRows(listed, '"/"');
  assert.ok(listed.slash.bottom <= listed.boxes.text.top + 0.5 && listed.boxes.text.top - listed.slash.bottom <= 8, `the "/" list sits on the text box (${px(listed.slash.bottom)} against ${px(listed.boxes.text.top)})`);
  await page.keyboard.press('Escape');

  // Emptied again: back to the one row, the same height as at first.
  await draft(page, '');
  const emptied = await layout(page);
  assertOneRow(emptied, 'emptied');
  assert.ok(Math.abs(emptied.form.height - rest.form.height) <= 0.5 && Math.abs(emptied.boxes.text.width - rest.boxes.text.width) <= 0.5);

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('from 600 to 899px the composer keeps its one row, with or without text (768 x 1024)', {skip, timeout: 120_000}, async t => {
  const {ctx, page, errors} = await newPage(browser, {width: 768, height: 1024, phone: true});
  await loadApp(page, scratch.url);
  await openMayorChat(page);
  await page.waitForTimeout(500);
  const rest = await layout(page);
  assertOneRow(rest, 'empty');
  assertSound(rest, 'empty', 768);
  await draft(page, 'A goal for the Mayor');
  const typed = await layout(page);
  assertOneRow(typed, 'with text');
  assert.ok(Math.abs(typed.form.height - rest.form.height) <= 0.5 && Math.abs(typed.boxes.text.width - rest.boxes.text.width) <= 0.5);
  t.diagnostic(`768 x 1024: text box ${px(rest.boxes.text.width)} of ${px(rest.form.width)} px (${px(rest.boxes.text.width / rest.form.width * 100)}%), one row`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a three-line draft grows the box and the conversation gives the room, strip or no strip (1024 x 768)', {skip, timeout: 240_000}, async t => {
  const {ctx, page, errors} = await newPage(browser, {width: 1024, height: 768});
  await loadApp(page, scratch.url);
  await openMayorChat(page);
  await ensureDecision(page);

  // The decision's card is the conversation's last item and is on screen, so the strip is away.
  const rest = await layout(page);
  assertTwoRows(rest, 'one decision');
  assertSound(rest, 'one decision', 1024);
  assert.ok(rest.last && rest.last.bottom <= rest.chat.bottom + 0.5, 'the conversation shows its last item');
  await draft(page, 'one\ntwo\nthree');
  const three = await layout(page);
  assert.ok(three.boxes.text.height >= rest.boxes.text.height + 15, `three lines: the box grew from ${px(rest.boxes.text.height)} to ${px(three.boxes.text.height)} px`);
  assert.ok(!three.boxScrolls, 'all three lines show');
  assertSound(three, 'three lines', 1024);
  assert.ok(!meets(three.form, three.chat) && three.chat.bottom <= three.form.top + 0.5, 'the composer does not cover the conversation');
  assert.ok(three.last.bottom <= three.chat.bottom + 0.5 && three.last.bottom <= three.form.top, `the last item is still in view above the composer (${px(three.last.bottom)} <= ${px(three.chat.bottom)})`);
  assert.ok(Math.abs((rest.chat.height - three.chat.height) - (three.form.height - rest.form.height)) <= 0.5, 'the conversation gave exactly the room the box took');
  await draft(page, '');

  // The tightest first-run state: setup card, brain card, a working line and the decision strip. Before the second row the conversation
  // had 40 px above its floor here; the two-row composer still fits, and a long draft no longer runs past the pane's foot.
  await showStrip(page);
  const tight = await layout(page);
  assert.ok(tight.strip && tight.brain, 'the strip and the brain card both show');
  assertTwoRows(tight, 'strip showing');
  assertSound(tight, 'strip showing', 1024);
  assert.ok(Math.abs(tight.strip.bottom - tight.form.top) <= 0.5, 'the strip sits right on the composer');
  await draft(page, '1\n2\n3\n4\n5\n6\n7');
  const long = await layout(page);
  assertSound(long, 'strip showing, seven lines', 1024);
  assert.ok(long.boxes.text.height >= 44 && long.boxScrolls, `the box keeps the height that fits (${px(long.boxes.text.height)} px) and scrolls its text`);
  assert.ok(long.chat.height >= 95.5, `the conversation keeps its floor (${px(long.chat.height)} px)`);
  t.diagnostic(`1024 x 768, strip showing: conversation ${px(tight.chat.height)} px, composer ${px(tight.form.height)} px; with seven lines the composer is ${px(long.form.height)} px and ends ${px(long.pane.bottom - long.form.bottom)} px above the pane's foot`);
  await draft(page, '');
  const back = await layout(page);
  assert.ok(Math.abs(back.boxes.text.height - 44) <= 0.5 && !back.boxScrolls, 'emptied: the box is one row again');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a phone the composer stays pinned with the strip on top of it, keyboard down or up (375 x 812, then 375 x 520)', {skip, timeout: 240_000}, async t => {
  const {ctx, page, errors} = await newPage(browser, {width: 375, height: 812, phone: true});
  await loadApp(page, scratch.url);
  await openMayorChat(page);
  await ensureDecision(page);

  // A three-line draft: the box grows, the composer grows upward, and the conversation gives the room.
  const rest = await layout(page);
  assertOneRow(rest, 'one decision');
  await draft(page, 'one\ntwo\nthree');
  const three = await layout(page);
  assertTwoRows(three, 'three lines');
  assertSound(three, 'three lines', 375);
  assert.ok(three.boxes.text.height >= 59 && !three.boxScrolls, `three lines: the box is ${px(three.boxes.text.height)} px and shows them all`);
  assert.ok(!meets(three.form, three.chat) && three.chat.bottom <= three.form.top + 0.5, 'the composer does not cover the conversation');
  assert.ok(Math.abs(three.form.bottom - rest.form.bottom) <= 0.5, 'the composer\'s foot stays where it was');
  if (rest.last && rest.last.bottom <= rest.chat.bottom + 0.5) assert.ok(three.last.bottom <= three.chat.bottom + 0.5, 'the last item is still in view');

  // The strip (shown once the decision's card is scrolled away) sits right on the composer, whatever its height.
  await showStrip(page);
  const strip = await layout(page);
  assertSound(strip, 'strip showing', 375);
  assert.ok(strip.strip && Math.abs(strip.strip.bottom - strip.form.top) <= 1, `the strip sits on the composer (${px(strip.strip.bottom)} against ${px(strip.form.top)})`);

  // Keyboard up: the window is 520 px tall (interactive-widget=resizes-content), the sheet 260 px. The composer is pinned to the sheet's
  // foot with the text box next to the keyboard, every part on screen, and the strip still on top of it.
  await page.setViewportSize({width: 375, height: 520});
  await page.locator('#message').focus();
  await page.waitForTimeout(400);
  const up = await layout(page);
  assertTwoRows(up, 'keyboard up');
  assertSound(up, 'keyboard up', 375, {scrolled: true});
  assert.ok(up.sticky && up.pane.bottom - up.form.bottom <= 16, `the composer is at the sheet's foot (${px(up.pane.bottom - up.form.bottom)} px above it)`);
  assert.ok(up.form.top >= up.pane.top && up.boxes.text.bottom <= 520 && up.boxes.send.bottom <= 520, 'the whole composer is on screen');
  assert.ok(up.boxes.text.bottom >= Math.max(...SMALL.map(key => up.boxes[key]?.bottom ?? 0)), 'the text box is the row next to the keyboard');
  assert.ok(up.strip && Math.abs(up.strip.bottom - up.form.top) <= 1 && up.strip.top >= up.pane.top - 0.5, 'the strip is on screen, right on the composer');
  // An empty box with the keyboard up is the one row, exactly as before.
  await draft(page, '');
  const upEmpty = await layout(page);
  assertOneRow(upEmpty, 'keyboard up, empty');
  assert.ok(upEmpty.strip && Math.abs(upEmpty.strip.bottom - upEmpty.form.top) <= 1);
  t.diagnostic(`375 x 520 (keyboard up), strip showing: composer ${px(up.form.height)} px with a three-line draft, ${px(upEmpty.form.height)} px empty; strip top at ${px(up.strip.top)} and ${px(upEmpty.strip.top)} px, sheet top ${px(up.pane.top)} px`);

  assert.deepEqual(errors, []);
  await ctx.close();
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nextSheetState, COMPACT_QUERY, PHONE_QUERY, TWO_PANES_QUERY, LEFT_SHEETS, rivalsOf, chatRail, newForOwner, headerCat, railName, initPaneLayout, initSheet, LABEL_KEY, LABEL_MODES, normalizeLabelMode, readLabelMode, writeLabelMode, applyLabelMode} from '../public/mobile-ui.js';
import {confirmDialog} from '../public/dialogs.js';
import {registerSettingsSection} from '../public/settings-menu.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Line endings are normalised: a Windows checkout has CRLF, and the patterns below expect LF.
const read = f => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const css = read('immersive.css');
const app = ['app.js', 'decision-strip.js', 'chat-thread.js'].map(read).join('\n');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
// The ☰ menu is the one place for settings: everything between its opening and closing tags.
const menuStart = html.indexOf('<dialog id="town-menu"');
const menuEnd = html.indexOf('</dialog>', menuStart);
const menu = html.slice(menuStart, menuEnd);

test('a grip gesture decides the sheet: tap or swipe down closes, swipe up expands, small moves snap back', () => {
  assert.equal(nextSheetState('half', 2), 'closed', 'a tap closes');
  assert.equal(nextSheetState('full', -3), 'closed', 'a tap closes a full sheet too');
  assert.equal(nextSheetState('half', 120), 'closed', 'a long swipe down closes a half sheet');
  assert.equal(nextSheetState('full', 120), 'half', 'a swipe down from full drops to half');
  assert.equal(nextSheetState('half', -120), 'full', 'a swipe up expands to full');
  assert.equal(nextSheetState('full', -120), 'full', 'swiping up on full stays full');
  assert.equal(nextSheetState('half', 30), 'half', 'a short drag snaps back to the same size');
});

test('every settings control exists exactly once, inside the ☰ menu, in its section', () => {
  const moved = {
    'world-view-switch': 'settings-view', 'label-mode': 'settings-labels',
    'edit-town': 'settings-town', 'pause': 'settings-town', 'replay-visits': 'settings-town',
    'share': 'settings-devices', 'step-up-open': 'settings-devices', 'logout': 'settings-devices', 'models-open': 'settings-models',
    'fullscreen': 'settings-screen',
  };
  for (const [id, section] of Object.entries(moved)) {
    assert.ok(ids.has(id), `${id} is in index.html`);
    assert.equal([...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length, 1, `${id} appears once`);
    const at = menu.indexOf(` id="${id}"`);
    assert.ok(at > 0, `${id} is inside the town menu`);
    assert.ok(menu.slice(0, at).includes(`id="${section}"`), `${id} sits in ${section}`);
    assert.ok(menu.slice(at).split('</section>')[0].includes(`id="${id}"`), `${id} is inside its own section`);
  }
  assert.ok(html.includes('id="town-menu"') && html.includes('id="menu-toggle"'), 'menu dialog and toggle exist');
  assert.ok(html.includes('aria-controls="town-menu"'), 'toggle points at the menu');
});

test('the ☰ menu lists the sections in order and leaves a container for the sound worker', () => {
  const order = ['settings-view', 'settings-labels', 'settings-town', 'settings-devices', 'settings-models', 'settings-screen', 'settings-sound'];
  let last = -1;
  for (const id of order) {
    const at = menu.indexOf(`id="${id}"`);
    assert.ok(at > last, `${id} comes after the previous section`);
    last = at;
  }
  assert.match(menu, /<section id="settings-sound"[^>]*>(?:(?!<\/section>)[\s\S])*?<div class="menu-items"><\/div><\/section>/, 'settings-sound is an empty container');
  assert.match(menu, /data-world-view="dawn"[\s\S]*data-world-view="day"[\s\S]*data-world-view="sunset"[\s\S]*data-world-view="night"/, 'four times of day');
});

test('the left floating settings row is gone from the world view', () => {
  assert.ok(!html.includes('class="world-settings"'), 'no world settings row');
  const title = html.slice(html.indexOf('<div class="world-title">'), html.indexOf('<div id="canvas-wrap">'));
  assert.ok(!title.includes('view-switch') && !title.includes('edit-town'), 'nothing in the world title');
});

test('the menu toggle shows at every width', () => {
  assert.ok(!/min-width:1101px\)\{\.immersive \.menu-toggle\{display:none\}/.test(css), 'no desktop hide for ☰');
  // Named after the dialog it opens (ux-ui-improvements row 5): the ☰ dialog is headed "Settings".
  assert.match(html, /<button id="menu-toggle"[^>]*aria-label="Settings" title="Settings"/);
  assert.match(html, /<h2 id="town-menu-title" tabindex="-1">Settings<\/h2>/);
});

test('the dock keeps the panels that stay on the world view', () => {
  const dock = html.slice(html.indexOf('<nav class="town-dock"'), html.indexOf('</nav>', html.indexOf('<nav class="town-dock"')));
  const labels = [...dock.matchAll(/<span class="dock-label">([^<]+)<\/span>/g)].map(m => m[1]);
  // Under 900px five buttons show and More lists Cats, the Diary, Archive and the Memorial (menu-chat-mailman.md); from 900px Town and
  // More go and those four stand in the row (plan 8.5). Plan 11.7 puts Search first in More; from 900px it stands in the row too (UX audit 2026-11-10, row 10), beside Ctrl+K. Coins stays in the markup, hidden: its surface opens from the treasury while the
  // coin economy is on.
  assert.deepEqual(labels, ['Chat', 'Inbox', 'Work', 'Town', 'More', 'Search', 'Cats', 'Diary', 'Archive', 'Coins', 'Memorial']);
  assert.deepEqual([...dock.matchAll(/<button id="([^"]+)"[^>]*\shidden>/g)].map(m => m[1]), ['toggle-season'], 'only Coins is hidden; the Memorial shows in More');
  for (const [, target] of dock.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(ids.has(target), `${target} exists`);
  for (const id of ['toggle-projects', 'toggle-quests', 'toggle-memorial']) {
    assert.equal([...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length, 1, `${id} appears once`);
    assert.ok(dock.includes(` id="${id}"`), `${id} is in the dock`);
    assert.ok(!menu.includes(` id="${id}"`), `${id} is no longer in the ☰ menu`);
  }
  assert.equal([...html.matchAll(/\sid="quests-badge"/g)].length, 1, 'quests badge appears once');
  assert.ok(dock.indexOf('id="quests-badge"') > dock.indexOf('id="toggle-quests"'), 'the needs-you badge sits on the Needs you button');
  assert.ok(dock.includes('id="decision-badge"') && dock.indexOf('id="decision-badge"') > dock.indexOf('id="toggle-inspector"'), 'the decision badge sits on Chat');
});

test('under 900px the five dock buttons share one row: nothing scrolls sideways, and More opens its list above the dock', () => {
  const block = css.slice(css.indexOf('/* Narrow dock, under 900px'), css.indexOf('@media(prefers-reduced-motion:no-preference)'));
  assert.match(block, /\.immersive \.town-dock\{justify-content:space-between;overflow:visible\}/, 'one row, no sideways scroll');
  assert.match(block, /\.immersive \.town-dock>button\{flex:1 1 0;min-width:0\}/, 'each button an equal share of the row');
  assert.match(block, /\.dock-more\.is-open\{position:absolute;right:0;bottom:calc\(100% \+ var\(--space-2\)\)/, 'the list opens above the dock');
  assert.ok(!/town-dock\{[^}]*overflow-x:auto/.test(css), 'no rule scrolls the dock any more');
  assert.ok(!css.includes('scroll-snap-type:x mandatory'), 'no snap scrolling');
});

test('the settings helper and confirm dialog are plain modules that can be imported without a DOM', () => {
  assert.equal(typeof registerSettingsSection, 'function');
  assert.equal(typeof confirmDialog, 'function');
});

test('no native confirm, alert or prompt is left in the client', () => {
  const files = readdirSync(root).filter(f => f.endsWith('.js'));
  const offenders = files.filter(f => /(?<![.\w])(confirm|alert|prompt)\s*\(/.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use confirmDialog from dialogs.js');
});

test('the approval sheet holds the full question, the options, a text field and both answers', () => {
  const sheet = html.slice(html.indexOf('<dialog id="approval-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="approval-dialog"')));
  for (const id of ['approval-question', 'approval-options', 'approval-custom', 'approval-send', 'approval-decline']) assert.ok(sheet.includes(`id="${id}"`), `${id} in the sheet`);
  assert.match(sheet, /<textarea id="approval-custom"[^>]*maxlength="2000"/);
  assert.match(sheet, />Send answer</);
  assert.match(sheet, />Decline</);
  assert.ok(app.includes("$('approvals').addEventListener('click'"), 'strips open the sheet');
  // Plan 8.8: a decline is easy to hit by mistake on a phone, so every answer, a decline included, waits 4 s behind Undo before it is sent.
  assert.ok(app.includes('export const HOLD_MS=4000;') && app.includes("'Undo'") && app.includes("choose(openApprovalId,'Rejected',false"), 'Decline waits behind Undo');
});

test('camera controls keep accessible names and the phone hides only the zoom pair', () => {
  for (const id of ['zoom-out', 'zoom-in', 'reset-view', 'focus-home']) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`))[0];
    assert.match(tag, /aria-label="[^"]+"/, `${id} has aria-label`);
  }
  assert.match(css, /\.cam-zoom\{display:none\}/);
});

test('phone and tablet breakpoints, safe-area insets and reduced motion are wired in CSS', () => {
  assert.equal(COMPACT_QUERY, '(max-width:899px)', 'narrow screens (one sheet at a time, chat first) end at 899px');
  assert.equal(PHONE_QUERY, '(max-width:599px)');
  assert.equal(TWO_PANES_QUERY, '(min-width:1280px)', 'a left sheet and the full chat pane share the screen from 1280px');
  assert.ok(css.includes('@media(max-width:599px)'), 'phone block');
  assert.ok(css.includes('env(safe-area-inset-bottom)'), 'bottom safe area');
  assert.ok(css.includes('prefers-reduced-motion:reduce'), 'reduced motion honoured');
  assert.ok(css.includes('body.immersive[data-labels=auto] .world-label:not(.selected):not([data-cat=mayor])'), 'phone shows only the selected cat and the Mayor');
});

test('app wiring uses the shared breakpoint and opens chat at full height', () => {
  assert.ok(!app.includes("max-width:800px"), 'no stale 800px breakpoint in app.js');
  assert.ok(app.includes("id==='inspector'?'full':'half'"), 'chat opens full on phones');
  assert.ok(app.includes("from './mobile-ui.js'"), 'imports the mobile module');
});

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }};
}
const blockedStorage = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }};

test('house names: unknown or missing values read as auto, and only a known mode is kept', () => {
  assert.deepEqual(LABEL_MODES, ['auto', 'on', 'off']);
  assert.equal(readLabelMode(memoryStorage()), 'auto', 'nothing stored');
  assert.equal(readLabelMode(memoryStorage({[LABEL_KEY]: 'loud'})), 'auto', 'unknown stored value');
  assert.equal(readLabelMode(blockedStorage), 'auto', 'blocked storage reads as auto');
  assert.equal(readLabelMode(null), 'auto', 'no storage at all');
  const s = memoryStorage();
  assert.equal(writeLabelMode(s, 'off'), 'off');
  assert.equal(readLabelMode(s), 'off', 'the choice survives a reload');
  assert.equal(writeLabelMode(s, '<b>'), 'auto', 'junk is not stored');
  assert.equal(s.map.get(LABEL_KEY), 'auto');
  assert.equal(writeLabelMode(blockedStorage, 'on'), 'on', 'a blocked write still applies for this page');
  assert.equal(normalizeLabelMode(undefined), 'auto');
});

test('house names map to one body attribute that the CSS keys on', () => {
  const body = {dataset: {}};
  assert.equal(applyLabelMode(body, 'on'), 'on');
  assert.equal(body.dataset.labels, 'on');
  assert.equal(applyLabelMode(body, 'bogus'), 'auto');
  assert.equal(body.dataset.labels, 'auto');
});

test('the House names switch lives in the menu and has CSS for each mode', () => {
  assert.ok(menu.slice(0, menu.indexOf('id="label-mode"')).includes('id="settings-labels"'), 'House names sits in its own menu section');
  const sw = html.match(/<div id="label-mode"[^>]*>[\s\S]*?<\/div>/)[0];
  for (const mode of LABEL_MODES) assert.ok(sw.includes(`data-label-mode="${mode}"`), `${mode} option`);
  assert.match(sw, /role="group" aria-label="House names"/);
  assert.match(css, /body\.immersive\[data-labels=off\] \.world-label:not\(\.selected\)/, 'off hides every label but the selected cat');
  assert.ok(css.includes('body.immersive[data-labels=auto] .world-label:not(.selected):not([data-cat=mayor])'), 'auto keeps the phone rule');
  assert.ok(app.includes("initHouseNames(document,$('label-mode'))"), 'app wires the switch');
});

test('Android browsers are offered the native app, but not inside it or on other phones', async () => {
  const {offersAndroidApp} = await import('../public/mobile-ui.js');
  assert.equal(offersAndroidApp('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131 Mobile'), true);
  assert.equal(offersAndroidApp('Mozilla/5.0 (Linux; Android 14; wv) Chrome/131 Mobile ClowderAndroid'), false);
  assert.equal(offersAndroidApp('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), false);
  assert.equal(offersAndroidApp(''), false);
});

// ===== Plan 8.5: the chat pane and its rail from 900px, the town strip under 900px =====
const PANELS = ['residents', 'inspector', 'diary', 'season', 'projects', 'quests'];
const openSet = (...ids) => id => ids.includes(id);

test('which panels give way: one sheet under 900px; from 900px the chat never closes for a left sheet, and below 1280px they take turns', () => {
  const narrow = {narrow: true, twoPanes: false, panels: PANELS};
  assert.deepEqual(rivalsOf('projects', true, {...narrow, isOpen: openSet('inspector')}), ['inspector'], 'a phone sheet replaces the chat');
  assert.deepEqual(rivalsOf('inspector', true, {...narrow, isOpen: openSet('quests', 'diary')}), ['diary', 'quests']);
  assert.deepEqual(rivalsOf('inspector', false, {...narrow, isOpen: openSet('inspector')}), [], 'closing takes nothing else');
  const wide = {narrow: false, twoPanes: false, panels: PANELS};
  assert.deepEqual(LEFT_SHEETS, ['residents', 'diary', 'season', 'projects']);
  assert.deepEqual(rivalsOf('projects', true, {...wide, isOpen: openSet('inspector', 'season')}), ['season'], 'the chat stays; one left sheet at a time');
  assert.deepEqual(rivalsOf('diary', true, {...wide, isOpen: openSet('inspector', 'residents', 'projects')}), ['projects'], 'Cats and the Diary share the left column');
  assert.deepEqual(rivalsOf('projects', true, {...wide, isOpen: openSet('inspector', 'quests')}), ['quests'], 'below 1280px a left sheet folds the chat, and its Inbox with it');
  assert.deepEqual(rivalsOf('inspector', true, {...wide, isOpen: openSet('inspector', 'projects', 'residents')}), ['residents', 'projects'], 'unfolding the chat below 1280px closes the left column');
  assert.deepEqual(rivalsOf('quests', true, {...wide, isOpen: openSet('inspector', 'season')}), ['season'], 'so does opening the Inbox, which lives in the pane');
  assert.deepEqual(rivalsOf('inspector', false, {...wide, isOpen: openSet('inspector', 'quests')}), ['quests'], 'folding the chat closes its Inbox');
  const two = {narrow: false, twoPanes: true, panels: PANELS};
  assert.deepEqual(rivalsOf('inspector', true, {...two, isOpen: openSet('inspector', 'projects')}), [], 'from 1280px a left sheet and the full pane share the screen');
  assert.deepEqual(rivalsOf('projects', true, {...two, isOpen: openSet('inspector', 'quests', 'season')}), ['season']);
});

test('the chat shows as its rail only from 900px: when folded, or when a left sheet needs the room below 1280px', () => {
  assert.equal(chatRail({narrow: true, folded: true, leftOpen: true, twoPanes: false}), false);
  assert.equal(chatRail({narrow: false, folded: false, leftOpen: false, twoPanes: false}), false);
  assert.equal(chatRail({narrow: false, folded: false, leftOpen: true, twoPanes: false}), true);
  assert.equal(chatRail({narrow: false, folded: false, leftOpen: true, twoPanes: true}), false);
  assert.equal(chatRail({narrow: false, folded: true, leftOpen: false, twoPanes: true}), true);
});

test('the rail counts what came for the owner while folded, and says whose chat it opens', () => {
  const before = {messages: [{id: 'm1', to: 'owner'}], approvals: [{id: 'a1', status: 'pending'}]};
  const after = {messages: [{id: 'm1', to: 'owner'}, {id: 'm2', to: 'owner'}, {id: 'm3', to: 'mayor'}], approvals: [{id: 'a1', status: 'pending'}, {id: 'a2', status: 'pending'}, {id: 'a3', status: 'approved'}]};
  assert.equal(newForOwner(before, after), 2, 'one reply to the owner and one new decision; cat-to-cat talk and answered decisions do not count');
  assert.equal(newForOwner(after, after), 0);
  assert.equal(newForOwner(undefined, after), 0, 'the first snapshot counts nothing');
  assert.equal(headerCat('Mayor’s corner'), 'Mayor');
  assert.equal(headerCat("Scholar's corner"), 'Scholar');
  assert.equal(headerCat('Conversations'), null);
  assert.equal(railName('Mayor', 0), 'Open chat with Mayor');
  assert.equal(railName('Mayor', 3), 'Open chat with Mayor, 3 unread');
  assert.equal(railName(null, 1), 'Open chat, 1 unread');
});

// A small DOM for initPaneLayout: elements with ids, classes, attributes, children and bubbling listeners, and matchMedia on a
// width the test sets. MutationObserver is left out, so the rail and the strip caption paint on sync and at start.
class FakeEl {
  constructor(doc, tag, {id = '', className = '', attrs = {}, hidden = false, text = ''} = {}) {
    Object.assign(this, {ownerDocument: doc, tagName: tag.toUpperCase(), id, attrs: {...attrs}, hidden, textContent: text, children: [], parentElement: null, listeners: {}, dataset: {}, classes: new Set(className.split(' ').filter(Boolean))});
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(' ').filter(Boolean)); }
  get classList() { const c = this.classes; return {add: n => c.add(n), remove: n => c.delete(n), contains: n => c.has(n), toggle: (n, on = !c.has(n)) => { if (on) c.add(n); else c.delete(n); return on; }}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, init = {}) { const event = {type, target: this, preventDefault() {}, stopPropagation() {}, ...init}; for (let at = this; at; at = at.parentElement) for (const fn of at.listeners[type] ?? []) fn(event); }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  detach() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; }
  append(...nodes) { for (const n of nodes) { n.detach(); n.parentElement = this; this.children.push(n); } }
  prepend(n) { n.detach(); n.parentElement = this; this.children.unshift(n); }
  insertBefore(n, ref) { n.detach(); n.parentElement = this; const at = this.children.indexOf(ref); this.children.splice(at < 0 ? this.children.length : at, 0, n); }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.detach(); this.append(...nodes); }
  cloneNode() { return new FakeEl(this.ownerDocument, this.tagName, {className: this.className, text: this.textContent}); }
  get outerHTML() { return `<${this.tagName} class="${this.className}">${this.textContent}`; }
  contains(n) { for (let at = n; at; at = at.parentElement) if (at === this) return true; return false; }
  closest(sel) { for (let at = this; at; at = at.parentElement) if (at.matches(sel)) return at; return null; }
  matches(sel) {
    if (sel.startsWith('.')) return this.classes.has(sel.slice(1));
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    return attr ? this.attrs[attr[1]] === attr[2] : this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const deep = c.querySelector(sel); if (deep) return deep; } return null; }
}

function paneFixture(startWidth) {
  let width = startWidth;
  const doc = {activeElement: null, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }};
  const el = (tag, opts, ...kids) => { const node = new FakeEl(doc, tag, opts); node.append(...kids); return node; };
  doc.createElement = tag => el(tag);
  const dockButton = (id, label, extra = {}) => el('button', {id, attrs: extra}, el('span', {className: 'dock-label', text: label}));
  const panel = id => el('aside', {id: `${id}-panel`, className: 'panel', hidden: true});
  const inspector = el('aside', {id: 'inspector-panel', hidden: true},
    el('div', {className: 'panel-tools'}, el('button', {attrs: {'data-collapse': 'inspector', 'aria-label': 'Close chat'}}, el('use', {attrs: {href: '#i-x'}}))),
    el('div', {id: 'cat-header'}, el('span', {className: 'avatar', text: '✦'}), el('div', {}, el('h2', {text: 'Mayor’s corner'}))),
    el('div', {className: 'tabs'}));
  const main = el('main', {}, panel('residents'), el('section', {className: 'world'}, el('div', {id: 'canvas-wrap'}), panel('diary')), inspector, panel('season'), panel('projects'), panel('quests'));
  const dock = el('nav', {className: 'town-dock'}, dockButton('toggle-inspector', 'Chat'), dockButton('toggle-quests', 'Inbox'), dockButton('toggle-projects', 'Work'),
    dockButton('dock-town', 'Town'), dockButton('dock-more', 'More', {'aria-expanded': 'false'}),
    el('div', {id: 'dock-more-menu', className: 'dock-more'}, dockButton('toggle-residents', 'Cats'), dockButton('toggle-diary', 'Diary'), dockButton('toggle-season', 'Coins')));
  const menu = el('dialog', {id: 'town-menu'});
  menu.open = false;
  doc.body = el('body', {className: 'immersive'}, el('header', {}, el('span', {id: 'world-activity', text: ' Scholar visits Mayor '})), main, dock, menu);
  doc.getElementById = id => { const walk = node => node.id === id ? node : node.children.map(walk).find(Boolean) ?? null; return walk(doc.body); };
  const queries = new Map();
  const matches = q => { const max = /max-width:(\d+)px/.exec(q), min = /min-width:(\d+)px/.exec(q); return (!max || width <= +max[1]) && (!min || width >= +min[1]); };
  const win = {listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    matchMedia: q => { if (!queries.has(q)) queries.set(q, {listeners: [], get matches() { return matches(q); }, addEventListener(type, fn) { this.listeners.push(fn); }}); return queries.get(q); }};
  const resize = next => { const was = new Map([...queries].map(([q, m]) => [q, m.matches])); width = next; for (const [q, m] of queries) if (m.matches !== was.get(q)) for (const fn of m.listeners) fn({matches: m.matches}); };
  const $ = id => doc.getElementById(id);
  let layout, pins = 0;
  // app.js's setPanel, reduced to what the layout needs.
  function setPanel(id, open) {
    for (const other of layout.plan(id, open)) setPanel(other, false);
    $(`${id}-panel`).hidden = !(open || (id === 'inspector' && !win.matchMedia(COMPACT_QUERY).matches));
    $(`toggle-${id}`)?.setAttribute('aria-expanded', String(open));
    layout.sync();
  }
  layout = initPaneLayout({doc, win, panels: PANELS, setPanel, pin: () => { pins += 1; }});
  const body = () => [...doc.body.classes].filter(c => c !== 'immersive').sort().join(' ');
  const open = () => PANELS.filter(id => !$(`${id}-panel`).hidden);
  return {doc, win, $, setPanel, layout, resize, body, open, pins: () => pins, menu};
}

test('under 900px the open chat is the home and the town is a strip; the strip and Town show the whole town', () => {
  const f = paneFixture(375);
  f.setPanel('inspector', true);
  assert.equal(f.body(), 'town-strip', 'a sheet is open: the town is the strip');
  assert.equal(f.$('toggle-inspector').getAttribute('aria-expanded'), 'true');
  const strip = f.$('canvas-wrap').querySelector('.town-strip-open');
  assert.ok(strip, 'the strip is one button over the town');
  assert.equal(strip.getAttribute('aria-label'), 'Show the town');
  assert.equal(f.$('town-strip-caption').textContent, 'Scholar visits Mayor', 'captioned with the header’s activity line');
  assert.equal(strip.getAttribute('aria-describedby'), 'town-strip-caption');
  strip.click();
  assert.deepEqual(f.open(), [], 'the strip closes the sheet');
  assert.equal(f.body(), '', 'and the town fills the screen again');
  assert.equal(f.$('dock-town').getAttribute('aria-current'), 'true', 'Town is the current view');
  assert.equal(f.doc.activeElement, f.$('dock-town'), 'focus lands on Town');
  f.setPanel('quests', true);
  assert.equal(f.$('dock-town').getAttribute('aria-current'), null);
  f.$('dock-town').click();
  assert.deepEqual(f.open(), []);
  assert.equal(f.$('quests-panel').parentElement.tagName, 'MAIN', 'under 900px the Inbox is a sheet of its own');
});

test('under 900px More opens the list of the other panels, and says which of them is open', () => {
  const f = paneFixture(375);
  const more = f.$('dock-more'), list = f.$('dock-more-menu');
  more.click();
  assert.ok(list.classList.contains('is-open'));
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  f.$('toggle-residents').click();
  assert.ok(!list.classList.contains('is-open'), 'an item closes the list');
  assert.equal(f.doc.activeElement, more, 'and leaves focus on More for its sheet to return to');
  f.setPanel('residents', true);
  assert.equal(more.getAttribute('aria-label'), 'More, Cats open');
  assert.ok(more.classList.contains('has-open'));
  assert.equal(f.layout.focusAfterClose('residents'), more, 'closing Cats returns focus to More, since its own button is in the closed list');
  more.click();
  for (const fn of f.doc.listeners.keydown) fn({key: 'Escape', preventDefault() {}, stopPropagation() {}});
  assert.ok(!list.classList.contains('is-open'), 'Escape closes the list');
});

test('from 900px the chat is a pane: a left sheet folds it to its rail below 1280px, and the rail opens it again', () => {
  const f = paneFixture(1024);
  f.setPanel('inspector', true);
  assert.equal(f.body(), '', 'the pane is open at launch');
  assert.equal(f.$('quests-panel').parentElement, f.$('inspector-panel'), 'the Inbox lives in the pane');
  assert.equal(f.$('inspector-panel').children.indexOf(f.$('quests-panel')) + 1, f.$('inspector-panel').children.indexOf(f.$('inspector-panel').querySelector('.tabs')), 'right above the tabs');
  assert.equal(f.$('inspector-panel').querySelector('[data-collapse="inspector"]').getAttribute('aria-label'), 'Collapse chat');
  assert.equal(f.$('inspector-panel').querySelector('use').getAttribute('href'), '#i-chevron-right');
  f.setPanel('projects', true);
  assert.equal(f.body(), 'chat-rail', 'two full panes never cover the town below 1280px');
  assert.deepEqual(f.open(), ['inspector', 'projects'], 'the chat is still on screen, as its rail');
  assert.equal(f.$('toggle-inspector').getAttribute('aria-expanded'), 'false');
  const rail = f.$('inspector-panel').querySelector('.chat-rail-open');
  assert.equal(rail.getAttribute('aria-label'), 'Open chat with Mayor');
  assert.equal(rail.querySelector('.chat-rail-face').querySelector('.avatar').textContent, '✦', 'the open cat’s avatar');
  // Replies and decisions that come while folded count on the rail.
  for (const fn of f.win.listeners['town-state']) fn({detail: {prev: {messages: [], approvals: []}, next: {messages: [{id: 'm1', to: 'owner'}], approvals: [{id: 'a1', status: 'pending'}]}}});
  assert.equal(rail.querySelector('.chat-rail-count').textContent, '2');
  assert.equal(rail.querySelector('.chat-rail-count').hidden, false);
  assert.equal(rail.getAttribute('aria-label'), 'Open chat with Mayor, 2 unread');
  const pins = f.pins();
  rail.click();
  assert.deepEqual(f.open(), ['inspector'], 'the rail opens the pane, and the left sheet gives way below 1280px');
  assert.equal(f.body(), '');
  assert.ok(f.pins() > pins, 'the conversation jumps to its newest message');
  assert.equal(rail.querySelector('.chat-rail-count').hidden, true, 'the count clears once read');
  f.setPanel('inspector', false);
  assert.equal(f.body(), 'chat-rail', 'the pane’s close button folds it');
  assert.equal(f.$('inspector-panel').hidden, false, 'it never closes from 900px');
  assert.equal(f.layout.focusAfterClose('inspector'), rail, 'focus goes to the rail');
  f.setPanel('quests', true);
  assert.equal(f.body(), '', 'opening the Inbox opens the pane it lives in');
});

test('from 1280px a left sheet and the full pane share the screen; Settings folds the chat below 1280px like a left sheet', () => {
  const f = paneFixture(1440);
  f.setPanel('inspector', true);
  f.setPanel('projects', true);
  assert.equal(f.body(), '', 'both full');
  f.resize(1200);
  assert.equal(f.body(), 'chat-rail', 'narrower than 1280px, the chat folds');
  f.resize(1300);
  assert.equal(f.body(), '');
  f.setPanel('projects', false);
  f.resize(1024);
  f.menu.open = true;
  f.layout.sync();
  assert.equal(f.body(), 'chat-rail', 'Settings opens on the left, so the chat folds');
  f.menu.open = false;
  f.layout.sync();
  assert.equal(f.body(), '');
});

test('crossing 900px moves the Inbox and keeps the layout whole', () => {
  const f = paneFixture(1024);
  f.setPanel('inspector', true);
  f.setPanel('projects', true);
  f.resize(800);
  assert.equal(f.$('quests-panel').parentElement.tagName, 'MAIN', 'the Inbox is a sheet again under 900px');
  assert.ok(f.body().includes('town-strip'));
  f.setPanel('inspector', false);
  f.resize(1024);
  assert.equal(f.$('quests-panel').parentElement, f.$('inspector-panel'));
  assert.equal(f.$('inspector-panel').hidden, false, 'widening brings the chat back as a pane');
  assert.equal(f.body(), 'chat-rail', 'as its rail while a left sheet is open below 1280px');
  f.setPanel('projects', false);
  assert.equal(f.body(), '', 'and as the full pane once the left sheet closes');
});

test('while the town is a strip, a sheet grip only closes: a tap or a swipe down, never a resize', () => {
  const listeners = {}, grip = {addEventListener: (type, fn) => { listeners[type] = fn; }, setPointerCapture() {}};
  const bodyClasses = new Set(['town-strip']);
  const panel = {dataset: {size: 'full'}, style: {}, querySelector: () => grip, ownerDocument: {body: {classList: {contains: n => bodyClasses.has(n)}}}};
  let closed = 0, resized = 0;
  initSheet(panel, {onClose: () => { closed += 1; }, onResize: () => { resized += 1; }});
  const drag = dy => { listeners.pointerdown({button: 0, pointerId: 1, clientY: 100}); listeners.pointerup({pointerId: 1, clientY: 100 + dy}); };
  drag(90);
  assert.equal(closed, 1, 'a swipe down closes the chat even from its full size');
  drag(30);
  drag(-90);
  assert.equal(resized, 0, 'nothing resizes under the strip');
  assert.equal(panel.dataset.size, 'full');
  bodyClasses.clear();
  drag(90);
  assert.equal(panel.dataset.size, 'half', 'without the strip a full sheet still drops to half');
});

test('the pane, its rail and the town strip are drawn from the V0 tokens', () => {
  // From 900px: the pane is 360px, 400-440px from 1200px, solid paper, and folds to a 56px rail.
  assert.match(css, /@media\(min-width:900px\)\{\n\.immersive\{--pane-w:360px;--rail-w:56px;/);
  assert.match(css, /@media\(min-width:1200px\)\{\.immersive\{--pane-w:clamp\(400px,calc\(30vw \+ 40px\),440px\)\}\}/);
  assert.match(css, /\.immersive \.inspector\{right:var\(--chrome-x\);width:var\(--pane-w\);min-height:0\}/);
  assert.match(css, /body\.immersive\.chat-rail \.inspector\{width:var\(--rail-w\);padding:0\}/);
  assert.match(css, /\.immersive \.season,\.immersive \.projects\{left:var\(--chrome-x\);/, 'Coins and Projects open on the left');
  assert.match(css, /body\.immersive \.town-menu\{inset:0 auto 0 0;/, 'and so does Settings');
  assert.ok(!/\.inspector[^{]*\{[^}]*backdrop-filter/.test(css), 'the pane is not glass');
  // Under 900px: the strip is a 96px inset card (8px, --r-md, --e1) under the header; its height changes over --dur-sheet.
  assert.match(css, /--strip-h:96px/);
  assert.match(css, /body\.immersive\.town-strip:not\(\.cinematic\):not\(\.studio-open\) #canvas-wrap\{top:var\(--strip-top\);left:var\(--space-2\);right:var\(--space-2\);height:var\(--strip-h\);border-radius:var\(--r-md\);box-shadow:var\(--e1\)\}/);
  assert.match(css, /\.immersive #canvas-wrap\{transition:top var\(--dur-sheet\) var\(--ease-out\),[^}]*height var\(--dur-sheet\) var\(--ease-out\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.immersive #canvas-wrap\{transition:none\}\}/);
  assert.match(css, /body\.immersive\.town-strip:not\(\.cinematic\):not\(\.studio-open\) :is\(#labels,\.world-controls,#edit-pill,#edit-bar\)\{display:none\}/, 'labels and the camera hide in the strip');
  assert.match(css, /\.town-strip-caption\{[^}]*font:500 var\(--text-sm\)\/1\.4 var\(--font-ui\)/, 'the caption is --text-sm');
  // No colour literals in the plan 8.5 rules at the end of the file.
  const added = css.slice(css.indexOf('/* ===== Plan 8.5:'));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(added.replace(/#(labels|canvas-wrap|edit-pill|edit-bar|diary-panel|cat-header|dock-town|dock-more)\b/g, '')), 'tokens only');
});

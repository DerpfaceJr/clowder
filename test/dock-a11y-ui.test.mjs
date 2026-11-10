import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dockName, nameDockButton, DECISIONS} from '../public/dock-names.js';
import {initTabsOverflow} from '../public/chat-sheet.js';

// Plan 6.5: every dock and composer button has an accessible name, toggles say whether they are open or on, badges are
// read with their count, and focus follows the order on screen. Plan 8.5: the dock reads Chat · Inbox · Work · Town · More,
// and the chat tabs follow the ARIA tabs pattern. A screen reader's real readout is still the owner's check.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const app = read('app.js');
const css = read('immersive.css');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const between = (start, end) => { const at = html.indexOf(start); return html.slice(at, html.indexOf(end, at)); };
const dock = between('<nav class="town-dock"', '</nav>');
const composer = between('<form id="chat-form"', '</form>');
const tabs = between('<div class="tabs">', '<div id="quest-notice"');
const tablist = between('<div class="tab-list"', '</div>');

// Every <button …>…</button> in a piece of markup, with its attributes and inner markup.
const buttons = markup => [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({attrs, inner}));
const attr = (attrs, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
// The accessible name as a screen reader computes it for these buttons: aria-label, else aria-labelledby, else the text
// that is not inside an aria-hidden element.
function accessibleName({attrs, inner}) {
  const label = attr(attrs, 'aria-label');
  if (label !== null) return label.trim();
  const by = attr(attrs, 'aria-labelledby');
  if (by) return by.split(/\s+/).map(id => between(`id="${id}"`, '<').replace(/^[^>]*>/, '')).join(' ').trim();
  return inner.replace(/<(\w+)[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
const word = button => /<span class="dock-label">([^<]+)<\/span>/.exec(button.inner)?.[1];
const icon = button => /<use href="#i-([\w-]+)"/.exec(button.inner)?.[1];

test('the name check finds a button that has only an icon and no name', () => {
  assert.equal(accessibleName({attrs: '', inner: '<span class="dock-ico" aria-hidden="true">ฅ</span>'}), '');
  assert.equal(accessibleName({attrs: ' aria-label="Cats"', inner: '<span aria-hidden="true">ฅ</span>'}), 'Cats');
  assert.equal(accessibleName({attrs: '', inner: '<span aria-hidden="true">ฅ</span> <span class="dock-label">Cats</span>'}), 'Cats');
});

test('every dock button has an accessible name that holds its visible word', () => {
  const list = buttons(dock);
  assert.equal(list.length, 11, 'Chat, Inbox, Work, Town and More, then Search (plan 11.7), Cats, Diary, Archive, Coins and Memorial');
  for (const button of list) {
    const id = attr(button.attrs, 'id');
    const name = accessibleName(button);
    assert.ok(name, `${id} has an accessible name`);
    assert.ok(word(button) && name.startsWith(word(button)), `${id}: the name "${name}" starts with the visible word "${word(button)}"`);
    assert.equal(attr(button.attrs, 'type'), 'button', `${id} is a plain button`);
  }
});

test('under 900px the dock is Chat · Inbox · Work · Town · More, with Lucide icons and 12px labels', () => {
  const list = buttons(dock);
  assert.deepEqual(list.slice(0, 5).map(word), ['Chat', 'Inbox', 'Work', 'Town', 'More']);
  assert.deepEqual(list.slice(0, 5).map(icon), ['message-circle', 'inbox', 'list-checks', 'house', 'ellipsis']);
  for (const name of ['message-circle', 'inbox', 'list-checks', 'house', 'ellipsis']) assert.ok(ids.has(`i-${name}`), `the sprite has ${name}`);
  // Search (plan 11.7), Cats, the Diary, Archive, Coins and Memorial are the More list; it opens above the dock on narrow screens and
  // stands in the row from 900px, Search with it (UX audit 2026-11-10, row 10), beside Ctrl+K.
  const more = between('<div id="dock-more-menu"', '</nav>');
  assert.deepEqual(buttons(more).map(word), ['Search', 'Cats', 'Diary', 'Archive', 'Coins', 'Memorial']);
  assert.match(dock, /<div id="dock-more-menu" class="dock-more" role="group" aria-label="More panels">/);
  assert.match(css, /@media\(max-width:899px\)\{\n\.immersive \.town-dock\{justify-content:space-between;overflow:visible\}[\s\S]*?\.immersive \.town-dock \.dock-more\{display:none\}\n\.immersive \.town-dock \.dock-more\.is-open\{position:absolute;/);
  assert.match(css, /@media\(min-width:900px\)\{\n\.immersive \.town-dock \.dock-more\{display:contents\}\n\.immersive \.town-dock :is\(#dock-town,#dock-more\)\{display:none\}/);
  assert.match(css, /\.immersive \.town-dock \.dock-label\{font-size:var\(--text-xs\)\}/, 'dock labels use the 12px step');
  assert.match(read('style.css'), /--text-xs:12px/);
  // The Chat badge stays a 10px dot that is not read on its own: the count is in the button's name.
  assert.match(dock, /<span id="decision-badge" class="dock-badge" aria-hidden="true" hidden><\/span>/);
  assert.match(css, /\.immersive \.town-dock :is\(#decision-badge,\.dock-badge\):empty\{min-width:0;width:10px;height:10px;padding:0\}/);
});

test('dock toggles say whether their panel is open; More says whether its list is open; the dialog openers say they open a dialog', () => {
  for (const button of buttons(dock)) {
    const id = attr(button.attrs, 'id');
    if (attr(button.attrs, 'data-toggle-panel') || id === 'dock-more') {
      assert.match(attr(button.attrs, 'aria-expanded') ?? '', /^(true|false)$/, `${id} has aria-expanded`);
      assert.ok(ids.has(attr(button.attrs, 'aria-controls')), `${id} controls something that exists`);
    } else if (id === 'dock-town') {
      // Town shows the whole town; mobile-ui.js marks it aria-current while no sheet is open.
      assert.equal(attr(button.attrs, 'aria-expanded'), null);
    } else {
      assert.equal(attr(button.attrs, 'aria-haspopup'), 'dialog', `${id} opens a dialog`);
    }
  }
  assert.match(app, /\$\('toggle-'\+id\)\.setAttribute\('aria-expanded',String\(open\)\)/, 'setPanel keeps aria-expanded true while the panel is open');
  // A folded chat pane is not hidden, so a toggle reads its own aria-expanded to know which way to go.
  assert.match(app, /\[data-toggle-panel\]'\)\.forEach\(b=>b\.onclick=\(\)=>setPanel\(b\.dataset\.togglePanel,b\.getAttribute\('aria-expanded'\)!=='true',true\)\)/);
});

test('badges are read as part of the button name, with their count', () => {
  for (const badge of ['decision-badge', 'quests-badge']) assert.match(dock, new RegExp(`id="${badge}"[^>]*aria-hidden="true"`), `${badge} is not read on its own`);
  assert.equal(dockName('Inbox', 3), 'Inbox, 3');
  assert.equal(dockName('Inbox', 0), 'Inbox');
  assert.equal(dockName('Chat', 1, DECISIONS), 'Chat, 1 decision waiting');
  assert.equal(dockName('Chat', 2, DECISIONS), 'Chat, 2 decisions waiting');
  assert.equal(dockName('Chat', 0, DECISIONS), 'Chat');
  const button = {attrs: {}, querySelector: () => ({textContent: ' Inbox '}), getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; }};
  nameDockButton(button, 4);
  assert.equal(button.attrs['aria-label'], 'Inbox, 4');
  nameDockButton(button, 0);
  assert.equal(button.attrs['aria-label'], 'Inbox', 'the count goes when nothing needs you');
  assert.doesNotThrow(() => nameDockButton(null, 1), 'a missing button is skipped');
  assert.match(app, /function paintQuestNotice\(\)\{\n[^\n]*\n\s*nameDockButton\(\$\('toggle-quests'\),questCount\);/, 'the Inbox takes the one "needs you" count');
  assert.match(app, /onCount:n=>\{[^}]*paintQuestNotice\(\);/, 'which onCount repaints');
  assert.match(app, /nameDockButton\(\$\('toggle-inspector'\),pending\.length,DECISIONS\)/, 'Chat takes the waiting decisions');
  assert.ok(!app.includes("$('decision-badge').setAttribute('aria-label'"), 'the hidden badge is no longer labelled on its own');
});

test('focus follows the order on screen: no positive tabindex, no reordering of dock or composer items', () => {
  assert.ok(!/tabindex="[1-9]/.test(html), 'no positive tabindex in index.html');
  for (const file of readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.js'))) {
    assert.ok(!/tabIndex\s*=\s*[1-9]|'tabindex'\s*,\s*'[1-9]/.test(read(file)), `${file} sets no positive tabindex`);
  }
  for (const file of readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.css'))) {
    const sheet = read(file);
    for (const [, selector] of sheet.matchAll(/([^{}]+)\{[^}]*(?<![-\w])order:/g)) {
      assert.ok(!/town-dock|chat-form|composer|\.tabs|tab-list/.test(selector), `${file}: "${selector.trim()}" reorders items against the DOM`);
    }
  }
  const order = buttons(dock).map(b => attr(b.attrs, 'id'));
  assert.deepEqual(order, ['toggle-inspector', 'toggle-quests', 'toggle-projects', 'dock-town', 'dock-more', 'dock-search', 'toggle-residents', 'toggle-diary', 'toggle-archive', 'toggle-season', 'toggle-memorial']);
  // The More list comes straight after the More button, so Tab walks into it when it is open.
  assert.ok(dock.indexOf('id="dock-more"') < dock.indexOf('id="dock-more-menu"') && dock.indexOf('id="dock-more-menu"') < dock.indexOf('id="toggle-residents"'));
  // The composer reads in screen order: the Options chip, its popover, the text box, then Send.
  const at = id => composer.indexOf(`id="${id}"`);
  assert.ok(at('composer-options') < at('composer-options-menu') && at('composer-options-menu') < at('message') && at('message') < at('send'));
});

test('every composer and tab button has a name, and its toggles expose their state', () => {
  for (const button of [...buttons(composer), ...buttons(tabs)]) {
    const label = attr(button.attrs, 'id') ?? attr(button.attrs, 'data-tab') ?? button.inner;
    assert.ok(accessibleName(button), `${label} has an accessible name`);
  }
  const chip = buttons(composer).find(b => attr(b.attrs, 'id') === 'composer-options');
  assert.equal(attr(chip.attrs, 'aria-expanded'), 'false');
  assert.equal(attr(chip.attrs, 'aria-controls'), 'composer-options-menu');
  assert.ok(ids.has('composer-options-menu'));
  assert.equal(attr(buttons(composer).find(b => attr(b.attrs, 'id') === 'send').attrs, 'aria-label'), 'Send message');
  const more = buttons(tabs).find(b => attr(b.attrs, 'id') === 'tabs-more');
  assert.equal(attr(more.attrs, 'aria-expanded'), 'false');
  assert.equal(attr(more.attrs, 'aria-controls'), 'tabs-more-menu');
});

test('the chat tabs follow the ARIA tabs pattern in the markup: tablist, tab, aria-selected, aria-controls, one tab stop', () => {
  assert.match(tabs, /^<div class="tabs"><div class="tab-list" role="tablist" aria-label="Chat views">/);
  const list = buttons(tablist);
  assert.deepEqual(list.map(b => attr(b.attrs, 'data-tab')), ['chat', 'tasks', 'memory', 'gallery'], 'Roads and Council open from the ⋯ menu (plan 11.15)');
  for (const tab of list) {
    const key = attr(tab.attrs, 'data-tab');
    assert.equal(attr(tab.attrs, 'role'), 'tab', `${key} is a tab`);
    assert.equal(attr(tab.attrs, 'aria-pressed'), null, `${key} says selected, not pressed`);
    assert.equal(attr(tab.attrs, 'aria-controls'), key, `${key} controls its pane`);
    assert.ok(ids.has(key), `${key}'s pane exists`);
    assert.equal(attr(tab.attrs, 'id'), `tab-${key}`);
    const selected = key === 'chat';
    assert.equal(attr(tab.attrs, 'aria-selected'), String(selected), `${key} aria-selected`);
    assert.equal(attr(tab.attrs, 'tabindex'), selected ? '0' : '-1', `${key} is ${selected ? 'the' : 'not a'} tab stop`);
  }
  // More and its menu sit outside the tablist, which owns tabs only.
  assert.ok(!tablist.includes('tabs-more'), 'More is not inside the tablist');
  assert.ok(tabs.indexOf('id="tabs-more"') > tabs.indexOf('</div>'), 'More comes after the tablist closes');
  // The panes name their tab; the conversation keeps role="log" for its live messages.
  for (const key of ['tasks', 'roads', 'council', 'memory', 'gallery']) assert.match(html, new RegExp(`<div id="${key}" class="tab-pane" role="tabpanel" aria-labelledby="tab-${key}" hidden>`));
  assert.match(html, /<div id="chat" class="tab-pane" role="log" aria-label="Cat conversation">/);
  // The tab handler moves aria-selected; the arrow keys and the roving tabindex are chat-sheet.js initTabsOverflow's.
  assert.match(app, /x\.setAttribute\('aria-selected',String\(x===b\)\)/, 'a tab switch moves aria-selected');
  assert.ok(!/setAttribute\('aria-pressed',String\(x===b\)\)/.test(app), 'tabs no longer use aria-pressed');
  // The 'tab' cue keys on the role (audio.js), so the tabs make the tab sound.
  assert.match(read('audio.js'), /control\?\.getAttribute\?\.\('role'\) === 'tab' \? 'tab'/);
});

// A stand-in for the tab bar: buttons with classes, attributes, focus and click, and events that bubble up to the bar.
function tabBar({hidden = [], overflow = []} = {}) {
  const doc = {activeElement: null, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }};
  function node(parent = null) {
    const classes = new Set();
    return {
      parent, hidden: false, tabIndex: 0, attrs: {}, dataset: {}, listeners: {}, textContent: '',
      classList: {add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n), toggle: (n, on = !classes.has(n)) => { if (on) classes.add(n); else classes.delete(n); return on; }},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
      closest(selector) { return selector === '[data-tab]' && this.dataset.tab ? this : null; },
      focus() { doc.activeElement = this; },
      dispatch(type, init = {}) {
        const event = {type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init};
        for (let at = this; at; at = at.parent) for (const fn of at.listeners[type] ?? []) fn(event);
        return event;
      },
      click() { this.onclick?.(); this.dispatch('click'); },
    };
  }
  const bar = node(), more = node(bar), menu = node(bar);
  const keys = ['chat', 'tasks', 'roads', 'council', 'memory', 'gallery'];
  const tabs = keys.map(key => {
    const tab = node(bar);
    Object.assign(tab.dataset, {tab: key});
    tab.textContent = key;
    tab.hidden = hidden.includes(key);
    if (overflow.includes(key)) tab.classList.add('tab-overflow');
    // app.js's tab handler: the clicked tab is the active, selected one.
    tab.onclick = () => { for (const t of tabs) { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab)); } };
    return tab;
  });
  tabs[0].classList.add('active');
  bar.querySelectorAll = () => tabs;
  menu.querySelectorAll = () => [];
  menu.hidden = true;
  initTabsOverflow({bar, more, menu, doc, Observer: null});
  const tab = key => tabs[keys.indexOf(key)];
  const press = (key, from = doc.activeElement, mods = {}) => from.dispatch('keydown', {key, ...mods});
  const selected = () => tabs.find(t => t.getAttribute('aria-selected') === 'true')?.dataset.tab;
  const stops = () => tabs.filter(t => t.tabIndex === 0).map(t => t.dataset.tab);
  return {doc, tab, press, selected, stops, focused: () => doc.activeElement?.dataset.tab};
}

test('the arrow keys, Home and End drive the chat tabs: focus moves, the tab opens and holds the one tab stop', () => {
  const t = tabBar({hidden: ['memory', 'gallery']});
  assert.deepEqual(t.stops(), ['chat'], 'only the selected tab is in the Tab order');
  t.tab('chat').focus();
  let event = t.press('ArrowRight');
  assert.ok(event.defaultPrevented, 'the arrow does not scroll the page');
  assert.equal(t.focused(), 'tasks');
  assert.equal(t.selected(), 'tasks', 'the focused tab opens');
  assert.deepEqual(t.stops(), ['tasks'], 'the tab stop moves with it');
  t.press('ArrowRight');
  assert.equal(t.selected(), 'roads');
  t.press('End');
  assert.equal(t.selected(), 'council', 'End goes to the last tab shown; hidden tabs are skipped');
  t.press('ArrowRight');
  assert.equal(t.selected(), 'chat', 'Right wraps to the first tab');
  t.press('ArrowLeft');
  assert.equal(t.selected(), 'council', 'Left wraps to the last tab');
  t.press('Home');
  assert.equal(t.selected(), 'chat');
  assert.deepEqual(t.stops(), ['chat']);
  event = t.press('ArrowRight', undefined, {altKey: true});
  assert.equal(t.selected(), 'chat', 'Alt+Right is the browser’s Forward, not a tab switch');
  assert.equal(event.defaultPrevented, false);
  event = t.press('a');
  assert.equal(t.selected(), 'chat');
  assert.equal(event.defaultPrevented, false, 'other keys are left alone');
});

test('a tab under More is skipped by the arrows and reached through More; the first shown tab keeps the tab stop meanwhile', () => {
  const t = tabBar({overflow: ['council', 'memory', 'gallery']});
  t.tab('chat').focus();
  t.press('End');
  assert.equal(t.selected(), 'roads', 'End stops at the last tab shown in the bar');
  t.press('ArrowRight');
  assert.equal(t.selected(), 'chat');
  // The More menu clicks the hidden tab (chat-sheet.js); the bar's first tab then holds the tab stop, so the tablist stays reachable.
  t.tab('gallery').click();
  assert.equal(t.selected(), 'gallery');
  assert.deepEqual(t.stops(), ['chat'], 'the selected tab is under More, so the first shown tab is the stop');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dockName, nameDockButton, DECISIONS} from '../public/dock-names.js';

// Plan 6.5: every dock and composer button has an accessible name, toggles say whether they are open or on, badges are
// read with their count, and focus follows the order on screen. A screen reader's real readout is still the owner's check.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const app = read('app.js');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const between = (start, end) => { const at = html.indexOf(start); return html.slice(at, html.indexOf(end, at)); };
const dock = between('<nav class="town-dock"', '</nav>');
const composer = between('<form id="chat-form"', '</form>');
const tabs = between('<div class="tabs">', '<div id="quest-notice"');

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

test('the name check finds a button that has only an icon and no name', () => {
  assert.equal(accessibleName({attrs: '', inner: '<span class="dock-ico" aria-hidden="true">ฅ</span>'}), '');
  assert.equal(accessibleName({attrs: ' aria-label="Cats"', inner: '<span aria-hidden="true">ฅ</span>'}), 'Cats');
  assert.equal(accessibleName({attrs: '', inner: '<span aria-hidden="true">ฅ</span> <span class="dock-label">Cats</span>'}), 'Cats');
});

test('every dock button has an accessible name that holds its visible word', () => {
  const list = buttons(dock);
  assert.equal(list.length, 8, 'six shown buttons plus Coins and Memorial');
  for (const button of list) {
    const id = attr(button.attrs, 'id');
    const name = accessibleName(button);
    const word = /<span class="dock-label">([^<]+)<\/span>/.exec(button.inner)?.[1];
    assert.ok(name, `${id} has an accessible name`);
    assert.ok(word && name.startsWith(word), `${id}: the name "${name}" starts with the visible word "${word}"`);
    assert.equal(attr(button.attrs, 'type'), 'button', `${id} is a plain button`);
  }
});

test('dock toggles say whether their panel is open; the dialog openers say they open a dialog', () => {
  for (const button of buttons(dock)) {
    const id = attr(button.attrs, 'id');
    if (attr(button.attrs, 'data-toggle-panel')) {
      assert.match(attr(button.attrs, 'aria-expanded') ?? '', /^(true|false)$/, `${id} has aria-expanded`);
      assert.ok(ids.has(attr(button.attrs, 'aria-controls')), `${id} controls a panel that exists`);
    } else {
      assert.equal(attr(button.attrs, 'aria-haspopup'), 'dialog', `${id} opens a dialog`);
    }
  }
  assert.match(app, /\$\('toggle-'\+id\)\.setAttribute\('aria-expanded',String\(open\)\)/, 'setPanel keeps aria-expanded true while the panel is open');
});

test('badges are read as part of the button name, with their count', () => {
  for (const badge of ['decision-badge', 'quests-badge']) assert.match(dock, new RegExp(`id="${badge}"[^>]*aria-hidden="true"`), `${badge} is not read on its own`);
  assert.equal(dockName('Needs you', 3), 'Needs you, 3');
  assert.equal(dockName('Needs you', 0), 'Needs you');
  assert.equal(dockName('Chat', 1, DECISIONS), 'Chat, 1 decision waiting');
  assert.equal(dockName('Chat', 2, DECISIONS), 'Chat, 2 decisions waiting');
  assert.equal(dockName('Chat', 0, DECISIONS), 'Chat');
  const button = {attrs: {}, querySelector: () => ({textContent: ' Needs you '}), getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; }};
  nameDockButton(button, 4);
  assert.equal(button.attrs['aria-label'], 'Needs you, 4');
  nameDockButton(button, 0);
  assert.equal(button.attrs['aria-label'], 'Needs you', 'the count goes when nothing needs you');
  assert.doesNotThrow(() => nameDockButton(null, 1), 'a missing button is skipped');
  assert.match(app, /function paintQuestNotice\(\)\{\n[^\n]*\n\s*nameDockButton\(\$\('toggle-quests'\),questCount\);/, 'Needs you takes the one "needs you" count');
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
    const css = read(file);
    for (const [, selector] of css.matchAll(/([^{}]+)\{[^}]*(?<![-\w])order:/g)) {
      assert.ok(!/town-dock|chat-form|composer|\.tabs/.test(selector), `${file}: "${selector.trim()}" reorders items against the DOM`);
    }
  }
  const order = buttons(dock).map(b => attr(b.attrs, 'id'));
  assert.deepEqual(order, ['toggle-residents', 'toggle-inspector', 'toggle-projects', 'toggle-quests', 'toggle-diary', 'toggle-archive', 'toggle-season', 'toggle-memorial']);
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
  for (const button of buttons(tabs).filter(b => attr(b.attrs, 'data-tab'))) {
    assert.match(attr(button.attrs, 'aria-pressed') ?? '', /^(true|false)$/, `${attr(button.attrs, 'data-tab')} tab says whether it is open`);
  }
  assert.match(app, /x\.setAttribute\('aria-pressed',String\(x===b\)\)/, 'a tab switch moves aria-pressed');
  const more = buttons(tabs).find(b => attr(b.attrs, 'id') === 'tabs-more');
  assert.equal(attr(more.attrs, 'aria-expanded'), 'false');
  assert.equal(attr(more.attrs, 'aria-controls'), 'tabs-more-menu');
});

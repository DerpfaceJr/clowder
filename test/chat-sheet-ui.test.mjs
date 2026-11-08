import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {optionsChipText, splitTabs, hasBrain, moreTabsName, initComposerOptions, paintBrainCard} from '../public/chat-sheet.js';
import {demoReply, DEMO_REPLY_NOTE} from '../public/demo-state.js';
import {taskCatOf} from '../public/town-events.js';
import {mountAskToggle} from '../public/ask-mayor.js';

// Plan 5.6 (the 375 px sweep) and 5.8 (first launch), checked without a browser: the pure rules, the markup and the CSS.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const app = ['app.js', 'chat-thread.js', 'decision-strip.js'].map(read).join('\n');
const css = read('chat-sheet.css');
const between = (start, end) => { const at = html.indexOf(start); return html.slice(at, html.indexOf(end, at)); };
const composer = between('<form id="chat-form"', '</form>');
const inspector = between('<aside id="inspector-panel"', '</aside>');

// A small stand-in for the elements the Options chip touches.
class El {
  constructor(tag = 'div') { Object.assign(this, {tagName: tag.toUpperCase(), hidden: false, textContent: '', attrs: {}, listeners: {}, children: [], dataset: {}, classes: new Set(), focused: false}); }
  get classList() { const c = this.classes; return {toggle: (n, on) => (on ? c.add(n) : c.delete(n)), contains: n => c.has(n), add: n => c.add(n), remove: n => c.delete(n)}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({type, target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...event}); }
  append(...nodes) { this.children.push(...nodes.filter(n => typeof n === 'object')); }
  contains(node) { return node === this || this.children.includes(node); }
  focus() { this.focused = true; }
}
function option(short, checked = false, hidden = false) {
  const label = new El('label'), box = new El('input');
  box.checked = checked;
  Object.assign(label, {hidden, dataset: {short}, querySelector: () => box});
  return {label, box};
}
function composerFixture(options) {
  const form = new El('form'), chip = new El('button'), menu = new El('div'), doc = new El('document');
  menu.children = options.map(o => o.label);
  menu.querySelectorAll = () => menu.children;
  const parts = initComposerOptions({form, chip, menu, doc});
  return {form, chip, menu, doc, parts};
}

test('the Options chip names the options that are on, and hides when none is offered', () => {
  assert.equal(optionsChipText([]), 'Options');
  assert.equal(optionsChipText(['Goal']), 'Options · Goal');
  assert.equal(optionsChipText(['Reply', 'Ask']), 'Options · Reply, Ask');

  const goal = option('Goal'), reply = option('Reply', false, true);
  const {form, chip, menu, doc, parts} = composerFixture([goal, reply]);
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, 'Options');
  assert.equal(menu.hidden, true, 'the popover starts closed');
  assert.equal(chip.getAttribute('aria-expanded'), 'false');

  chip.fire('click');
  assert.equal(menu.hidden, false);
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  goal.box.checked = true;
  menu.fire('change');
  assert.equal(chip.textContent, 'Options · Goal', 'a ticked option shows on the chip');
  assert.ok(chip.classList.contains('is-on'));

  let escape;
  form.listeners.keydown[0](escape = {key: 'Escape', stopPropagation() { this.stopped = true; }, preventDefault() {}});
  assert.equal(menu.hidden, true, 'Escape closes the popover');
  assert.ok(escape.stopped, 'and does not also close the chat sheet');
  assert.ok(chip.focused, 'focus goes back to the chip');

  chip.fire('click');
  doc.listeners.pointerdown[0]({target: new El()});
  assert.equal(menu.hidden, true, 'a tap outside closes it');
  chip.fire('click');
  form.fire('submit');
  assert.equal(menu.hidden, true, 'sending closes it');

  goal.label.hidden = true;
  parts.paint();
  assert.equal(chip.hidden, true, 'nothing to offer: no chip');
});

test('the goal, reply and ask toggles live in the Options popover, not in a row that appears on focus', () => {
  const menu = between('<div id="composer-options-menu"', '<label class="sr-only"');
  for (const id of ['goal-toggle', 'reply-as-answer']) assert.ok(menu.includes(`id="${id}"`), `${id} is inside the popover`);
  assert.match(menu, /id="goal-toggle"[^>]*data-short="Goal"/);
  assert.match(menu, /id="reply-as-answer"[^>]*data-short="Reply"/);
  assert.match(composer, /<button type="button" id="composer-options"[^>]*aria-controls="composer-options-menu"[^>]*hidden>Options<\/button>/);

  // The ask toggle is made at load; it joins the popover too.
  const saved = globalThis.document;
  const popover = new El('div'), form = new El('form');
  form.querySelector = sel => (sel === '.composer-options' ? popover : null);
  form.insertBefore = () => assert.fail('the ask toggle belongs in the popover');
  globalThis.document = {createElement: tag => new El(tag)};
  try {
    const {label} = mountAskToggle(form, () => {});
    assert.equal(popover.children[0], label);
    assert.equal(label.dataset.short, 'Ask');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
});

test('the composer keeps one height when focus leaves it, so Answer is where it was after typing', () => {
  assert.match(css, /#chat-form>textarea,\.immersive \.inspector #chat-form>textarea:focus\{height:44px;transition:none\}/, 'focus does not grow the box');
  assert.match(css, /#chat-form>\.composer-options\{position:absolute;/, 'the popover floats over the conversation instead of pushing the composer');
  assert.match(app, /\$\('message'\)\.addEventListener\('input',\(\)=>fitComposer\(\$\('message'\)\)\)/, 'the box grows with its text');
  // The decision strip sits right above the composer, with only the brain card before it.
  const at = id => inspector.indexOf(`id="${id}"`);
  assert.ok(at('brain-card') < at('approvals') && at('approvals') < at('chat-form'), 'brain card, decision strip, composer');
  const linked = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.ok(linked.indexOf('chat-sheet.css') > linked.indexOf('immersive.css'), 'chat-sheet.css loads after immersive.css, so its rules win');
});

test('tabs that do not fit go under More, in order, and the first tab always shows', () => {
  const tabs = [{key: 'chat', width: 90}, {key: 'tasks', width: 44}, {key: 'roads', width: 44}, {key: 'council', width: 52}, {key: 'memory', width: 88}, {key: 'gallery', width: 56}];
  assert.deepEqual(splitTabs(tabs.slice(0, 4), 343, {gap: 16, more: 72}), {shown: ['chat', 'tasks', 'roads', 'council'], overflow: []}, 'four tabs fit at 375');
  assert.deepEqual(splitTabs(tabs, 343, {gap: 16, more: 60}), {shown: ['chat', 'tasks', 'roads', 'council'], overflow: ['memory', 'gallery']});
  assert.deepEqual(splitTabs(tabs, 343, {gap: 16, more: 72}).overflow, ['council', 'memory', 'gallery'], 'a wider More pushes one more tab under it');
  assert.deepEqual(splitTabs(tabs, 120, {gap: 16, more: 72}), {shown: ['chat'], overflow: ['tasks', 'roads', 'council', 'memory', 'gallery']});
  assert.deepEqual(splitTabs([{key: 'chat', width: 400}], 300), {shown: ['chat'], overflow: []}, 'a lone tab never hides');
  const wide = [{key: 'a', width: 50}, {key: 'b', width: 200}, {key: 'c', width: 10}];
  assert.deepEqual(splitTabs(wide, 200, {gap: 0, more: 40}).overflow, ['b', 'c'], 'a narrow tab after a wide one does not jump ahead of it');
  assert.equal(moreTabsName(null), 'More tabs');
  assert.equal(moreTabsName('Gallery'), 'More tabs, Gallery open');
  assert.match(app, /renderMemory\(\);renderGallery\(\);tabsOverflow\.fit\(\);/, 'the bar is fitted again once Town memory and Gallery show or hide');
});

test('first launch: with no model signed in, "Sign in to a brain" comes before the composer and opens AI models', () => {
  const demoOnly = [{id: 'demo', label: 'Demonstration', models: []}];
  assert.equal(hasBrain(demoOnly), false);
  assert.equal(hasBrain([...demoOnly, {id: 'local', label: 'Local AI', models: ['qwen3.5:4b']}]), true);
  assert.equal(hasBrain([...demoOnly, {id: 'hosted', label: 'API', models: []}]), false, 'a provider with no model to pick is not a brain');
  assert.equal(hasBrain(undefined), false);

  const node = () => ({hidden: false, textContent: ''});
  const card = node(), button = node(), text = node();
  paintBrainCard({card, button, text, models: demoOnly, readOnly: false, canSignIn: true});
  assert.equal(card.hidden, false);
  assert.equal(button.hidden, false);
  paintBrainCard({card, button, text, models: demoOnly, readOnly: false, canSignIn: false});
  assert.equal(button.hidden, true, 'only the host computer signs in');
  assert.match(text.textContent, /host computer/);
  paintBrainCard({card, button, text, models: demoOnly, readOnly: true, canSignIn: true});
  assert.equal(card.hidden, true, 'a viewer cannot sign in');
  paintBrainCard({card, button, text, models: [...demoOnly, {id: 'claude', models: ['sonnet']}], readOnly: false, canSignIn: true});
  assert.equal(card.hidden, true, 'gone once a model is signed in');

  assert.match(inspector, /<div id="brain-card"[^>]*data-owner[^>]*hidden>.*<button type="button" id="brain-signin" class="primary"[^>]*>Sign in to a brain<\/button><\/div><div id="approvals"/);
  assert.match(app, /\$\('brain-signin'\)\.onclick=\(\)=>openSurface\('models'\)/, 'it opens the existing AI models sign-in');
});

test('a Demonstration reply says plainly that it did not read the request', () => {
  assert.equal(DEMO_REPLY_NOTE, 'Demonstration reply. It did not read your request.');
  assert.equal(demoReply({from: 'mayor', to: 'owner', text: '[Demonstration] Decision received.'}), 'Decision received.');
  assert.equal(demoReply({from: 'scholar', to: 'mayor', text: '[Demonstration] Hypothesis: …'}), 'Hypothesis: …');
  assert.equal(demoReply({from: 'owner', to: 'mayor', text: '[Demonstration] typed by the owner'}), null, 'the owner’s own words are never marked');
  assert.equal(demoReply({from: 'mayor', to: 'owner', text: 'A real reply.'}), null);
  assert.equal(demoReply(null), null);
  assert.match(app, /demo===null\?'':`<p class="demo-warning demo-reply-note">\$\{DEMO_REPLY_NOTE\}<\/p>`/);
});

test('the diary names the cat of a delegated task the snapshot no longer lists, and never says "undefined"', () => {
  const brief = {type: 'message', data: {from: 'mayor', to: 'banker', text: 'Review the costs.', task: 't2'}};
  const reply = {type: 'message', data: {from: 'banker', to: 'mayor', text: '[Demonstration] Keep the cap.', task: 't2'}};
  assert.equal(taskCatOf('t1', [{id: 't1', cat: 'mayor'}], []), 'mayor', 'a listed task');
  assert.equal(taskCatOf('t2', [], [brief, reply], '[Demonstration] Keep the cap.'), 'banker', 'the cat that said the result');
  assert.equal(taskCatOf('t2', [], [reply], '[Demonstration] Keep the cap.'), 'banker', 'the brief rolled out of the recent events');
  assert.equal(taskCatOf('t2', [], [brief]), 'banker', 'the cat the brief went to');
  assert.equal(taskCatOf('t3', [], [brief]), null);
  assert.match(app, /\$\{cat\?name\(cat\):'A cat'\} finished:/);
  assert.ok(!app.includes('${name(taskCat(d.id))} finished'), 'no unguarded name lookup left');
});

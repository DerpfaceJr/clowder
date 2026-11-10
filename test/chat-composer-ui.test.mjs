import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {
  createComposer, createDrafts, planSend, parseMention, parseCommand, offeredCommands, BUILTIN_COMMANDS, COMMAND_PANELS, pendingItem, requestFor,
  resolveThread, catThread, switcherLabel, threadOptions, workRoots, isTextField, wantsComposerFocus, DRAFTS_KEY, uploadFile, UPLOAD_CAP as CLIENT_CAP,
} from '../public/chat-composer.js';
import {Store} from '../src/store.ts';
import {installAccess, isOwner} from '../src/access.ts';
import {artifactIndex, artifactsDir} from '../src/artifacts.ts';
import {UPLOAD_CAP, registerUploadRoutes} from '../src/uploads.ts';
import {slashMatches, mentionMatches} from '../public/slash-commands.js';
import {initComposerOptions} from '../public/chat-sheet.js';
import {installUiSounds} from '../public/ui-sounds.js';

// Plan 8.7, the composer, checked without a browser: the pure rules, then createComposer on a small stand-in DOM.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------------------------------------- a small stand-in DOM

class FakeNode {
  constructor(tag, doc) {
    Object.assign(this, {tagName: String(tag).toUpperCase(), ownerDocument: doc, childNodes: [], parentNode: null, attributes: new Map(), listeners: new Map(), value: '', disabled: false, checked: false, type: '', clientWidth: 0, style: {setProperty() {}}});
  }
  get children() { return this.childNodes.filter(n => n instanceof FakeNode); }
  get hidden() { return this.attributes.has('hidden'); }
  set hidden(on) { if (on) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get id() { return this.getAttribute('id') ?? ''; }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean), set = list => this.setAttribute('class', list.join(' '));
    return {contains: n => names().includes(n), add: n => set([...new Set([...names(), n])]), remove: n => set(names().filter(x => x !== n)), toggle: (n, on = !names().includes(n)) => set(on ? [...new Set([...names(), n])] : names().filter(x => x !== n))};
  }
  get form() { let n = this.parentNode; while (n && n.tagName !== 'FORM') n = n.parentNode; return n; }
  get textContent() { return this.childNodes.map(n => (typeof n === 'string' ? n : n.textContent)).join(''); }
  set textContent(value) { this.replaceChildren(); if (value !== '' && value !== null && value !== undefined) this.childNodes.push(String(value)); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  adopt(n) { if (typeof n !== 'string') { n.remove(); n.parentNode = this; } return n; }
  append(...nodes) { for (const n of nodes) this.childNodes.push(this.adopt(n)); }
  prepend(...nodes) { this.childNodes.unshift(...nodes.map(n => this.adopt(n))); }
  insertBefore(n, ref) { this.adopt(n); const at = this.childNodes.indexOf(ref); this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, n); return n; }
  before(...nodes) { for (const n of nodes) this.parentNode.insertBefore(n, this); }
  after(...nodes) { const p = this.parentNode, ref = p.childNodes[p.childNodes.indexOf(this) + 1]; for (const n of nodes) p.insertBefore(n, ref); }
  replaceChildren(...nodes) { for (const n of this.childNodes) if (typeof n !== 'string') n.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { const p = this.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  fire(type, init = {}) {
    const event = {type, target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init};
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    if (typeof this[`on${type}`] === 'function') this[`on${type}`](event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.fire('click'); }
  setSelectionRange() {}
  requestSubmit() { this.fire('submit'); }
  matches(selector) {
    return selector.split(',').some(part => {
      const m = /^([a-z]*)((?:[.#][\w-]+)*)((?:\[[\w-]+(?:=[^\]]*)?\])*)$/i.exec(part.trim());
      if (!m || (m[1] && m[1].toUpperCase() !== this.tagName)) return false;
      for (const [, kind, name] of m[2].matchAll(/([.#])([\w-]+)/g)) if (kind === '#' ? this.id !== name : !this.className.split(/\s+/).includes(name)) return false;
      for (const [, name, value] of m[3].matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)) if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value.replace(/^["']|["']$/g, ''))) return false;
      return true;
    });
  }
  closest(selector) { for (let x = this; x instanceof FakeNode; x = x.parentNode) if (x.matches(selector)) return x; return null; }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) return this.children.filter(c => c.matches(selector.slice(9)));
    return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
class FakeDocument extends FakeNode {
  constructor() { super('#document', null); this.ownerDocument = this; this.body = new FakeNode('body', this); this.append(this.body); this.activeElement = this.body; this.visibilityState = 'visible'; }
  createElement(tag) { return new FakeNode(tag, this); }
  createElementNS(ns, tag) { return new FakeNode(tag, this); }
  getElementById(id) { return this.querySelector(`#${id}`); }
}
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
}

const at = s => `2026-11-08T10:00:${String(s).padStart(2, '0')}.000Z`;
const CATS = [{id: 'mayor', name: 'Mayor', role: 'Your guide'}, {id: 'scholar', name: 'Scholar', role: 'Research'}, {id: 'critic', name: 'Critic', role: 'Review'}];
function townState(extra = {}) {
  return {readOnly: false, paused: false, maxParallelWork: 1, activeWorld: {id: 'w1'}, cats: CATS, tasks: [], goals: [], approvals: [], councils: [], models: [{id: 'demo', label: 'Demonstration', models: []}],
    messages: [{id: 'm1', from: 'owner', to: 'mayor', text: 'Hello', at: at(1)}, {id: 'm2', from: 'mayor', to: 'owner', text: 'Hi there', at: at(2)}], ...extra};
}

/** createComposer on the stand-in DOM, with app.js's parts as small fakes that record what they were asked to do. */
// fine: the pointer is a mouse ('(pointer: fine)' matches), as on a desktop. prepare(doc): the page as it is before the first render.
function setup({state = townState(), chatThread = null, api = null, upload = null, storage = memoryStorage(), waiting = 0, selected = 'mayor', fine = false, prepare = null, openPanel = undefined, canOpen = undefined} = {}) {
  const doc = new FakeDocument();
  globalThis.document = doc;
  prepare?.(doc);
  const skipLink = doc.createElement('a');
  skipLink.setAttribute('id', 'skip-to-chat');
  doc.body.append(skipLink);
  const make = (tag, id, parent = null) => { const n = doc.createElement(tag); if (id) n.setAttribute('id', id); (parent ?? doc.body).append(n); return n; };
  const panel = make('aside', 'inspector-panel');
  const form = make('form', 'chat-form', panel);
  const chip = make('button', 'composer-options', form);
  const box = make('textarea', 'message', form);
  const send = make('button', 'send', make('div', null, form));
  const goalBox = make('input', 'goal-mode'), replyBox = make('input', 'reply-as-answer-input'), modeSelect = make('select', 'mode');
  goalBox.type = replyBox.type = 'checkbox';
  modeSelect.value = 'demo';
  const t = {doc, panel, form, chip, box, send, goalBox, replyBox, modeSelect, state, selected, chatPages: new Map(), renders: 0, renderLog: [], posts: [], notices: [], cues: [], selects: [], confirms: [], confirmAnswer: true, timers: [], flushes: [], storage, waiting, openedInbox: 0, openedChat: 0};
  installUiSounds({audio: {play: kind => { t.cues.push(kind); return true; }}});
  t.render = () => {
    t.renders += 1;
    if (!t.chatPages.has(t.selected)) t.chatPages.set(t.selected, {messages: [], tasks: [], more: false, loading: false});
    t.renderLog.push({selected: t.selected, pending: (t.chatPages.get(t.selected).pending ?? []).map(i => ({...i}))});
    send.disabled = !!t.state.readOnly || !!t.state.paused;
    t.composer?.paint();
  };
  t.drafts = createDrafts({storage, setTimer: fn => { t.flushes.push(fn); return t.flushes.length; }, clearTimer: () => {}});
  t.composer = createComposer({
    form, doc, win: {matchMedia: query => ({matches: fine && query === '(pointer: fine)'}), addEventListener() {}}, box, send, goalBox, replyBox, modeSelect, chatThread, chatPages: t.chatPages,
    getState: () => t.state, selected: () => t.selected, select: cat => { t.selects.push(cat); t.selected = cat; t.render(); },
    api: api ?? ((path, body) => { t.posts.push({path, body}); return Promise.resolve({}); }), ...(upload ? {upload} : {}), notify: error => t.notices.push(error.message), render: t.render,
    needsYou: () => t.waiting, openChat: () => { t.openedChat += 1; }, openInbox: () => { t.openedInbox += 1; },
    drafts: t.drafts, confirmFirst: async ask => { t.confirms.push(ask); return t.confirmAnswer; }, setTimer: (fn, ms) => { t.timers.push({fn, ms}); return t.timers.length; },
    makeIcon: name => { const svg = doc.createElement('svg'); svg.setAttribute('data-icon', name); return svg; },
    now: () => 1_000_000, ...(openPanel ? {openPanel} : {}), ...(canOpen ? {canOpen} : {}),
  });
  t.switcher = form.querySelector('.thread-switch');
  t.list = form.querySelector('.thread-list');
  t.type = text => { box.value = text; box.fire('input'); };
  t.option = name => t.list.querySelectorAll('button').find(b => b.getAttribute('aria-label').startsWith(name));
  t.pick = name => { t.switcher.fire('click', {detail: 1}); const b = t.option(name); assert.ok(b, `${name} is listed`); b.fire('click', {detail: 1}); };
  t.skipLink = skipLink;
  t.render();
  return t;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

// --------------------------------------------------------------------------------------------------------------- drafts

test('a draft survives a thread switch and back, and a reload', () => {
  const storage = memoryStorage();
  const t = setup({storage});
  t.type('Plan the spring fair');
  t.pick('Scholar');
  assert.equal(t.selected, 'scholar', 'the switcher opened Scholar’s chat');
  assert.equal(t.box.value, '', 'Scholar’s chat has its own, empty, draft');
  t.type('Check the sources');
  t.pick('Mayor');
  assert.equal(t.box.value, 'Plan the spring fair', 'back in the Mayor’s thread, its draft is there');
  t.pick('Scholar');
  assert.equal(t.box.value, 'Check the sources');

  // A cat picked anywhere else (the Cats list, a town label) goes through app.js's select and render the same way.
  t.selected = 'critic';
  t.render();
  assert.equal(t.box.value, '');
  t.selected = 'mayor';
  t.render();
  assert.equal(t.box.value, 'Plan the spring fair');

  // Saved a moment after typing: after the save runs, a new page (a reload) opens the Mayor's thread with its draft.
  t.flushes.at(-1)();
  const saved = JSON.parse(storage.getItem(DRAFTS_KEY)).drafts;
  assert.equal(saved['w1|mayor:mayor'].text, 'Plan the spring fair');
  assert.equal(saved['w1|cat:scholar'].text, 'Check the sources');
  const again = setup({storage});
  assert.equal(again.box.value, 'Plan the spring fair', 'the draft survives a reload');
  again.pick('Scholar');
  assert.equal(again.box.value, 'Check the sources');
});

test('with the thread view of 8.6, request and goal threads keep drafts of their own', () => {
  const chatThread = {thread: null, opened: [], open(t) { this.opened.push(t); this.thread = t; }, current() { return this.thread; }};
  const state = townState({tasks: [{id: 't1', cat: 'mayor', from: 'owner', text: 'Write the fair poster', status: 'done'}], goals: [{id: 'g1', title: 'Grow the garden', status: 'active'}]});
  const t = setup({state, chatThread});
  t.type('For the Mayor');
  t.pick('Write the fair poster');
  assert.deepEqual(chatThread.opened.at(-1), {kind: 'request', id: 't1'}, 'the switcher opens the request thread');
  assert.equal(t.box.value, '');
  t.type('About the poster');
  t.pick('Grow the garden');
  assert.deepEqual(chatThread.opened.at(-1), {kind: 'goal', id: 'g1'});
  assert.equal(t.box.value, '');
  t.pick('Write the fair poster');
  assert.equal(t.box.value, 'About the poster');
  t.pick('Mayor');
  assert.deepEqual(chatThread.opened.at(-1), {kind: 'mayor', id: 'mayor'});
  assert.equal(t.box.value, 'For the Mayor');
});

test('a message typed in another cat’s request thread starts new work in that cat’s own chat, which the thread view opens', () => {
  const chatThread = {thread: null, opened: [], open(t) { this.opened.push(t); this.thread = t; }, current() { return this.thread; }};
  const state = townState({tasks: [{id: 't1', cat: 'scholar', from: 'owner', text: 'Read the survey', status: 'done'}]});
  const t = setup({state, chatThread, selected: 'scholar'});
  t.pick('Read the survey');
  assert.deepEqual(chatThread.opened.at(-1), {kind: 'request', id: 't1'});
  t.type('Now the next survey');
  t.form.requestSubmit();
  assert.deepEqual(chatThread.opened.at(-1), {kind: 'request', id: 't1'}, 'a follow-up stays in its request thread (plan 11.12), where the reply comes');
  assert.deepEqual(t.posts, [{path: 'chat', body: {cat: 'scholar', text: 'Now the next survey', mode: 'demo', parent: 't1'}}]);
});

test('drafts work without storage, and keep only the newest when saved', () => {
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); }};
  const drafts = createDrafts({storage: broken, setTimer: fn => fn(), clearTimer: () => {}});
  drafts.set('a', 'still here');
  assert.equal(drafts.get('a'), 'still here', 'a private window keeps drafts for this visit');
  let clock = 0;
  const storage = memoryStorage();
  const kept = createDrafts({storage, kept: 3, now: () => ++clock, setTimer: () => 0, clearTimer: () => {}});
  for (const k of ['a', 'b', 'c', 'd']) kept.set(k, `text ${k}`);
  kept.set('e', '   ');
  kept.flush();
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(DRAFTS_KEY)).drafts).sort(), ['b', 'c', 'd'], 'the oldest goes; a blank draft is no draft');
});

// --------------------------------------------------------------------------------------------------------- the pending item

test('Send puts the pending item in page.pending and renders once, before the POST answers', async () => {
  let answer;
  const t = setup({api: (path, body) => { t.posts.push({path, body}); return new Promise(resolve => { answer = resolve; }); }});
  t.type('Open a lemonade stand');
  const before = t.renders;
  t.form.requestSubmit();
  const page = t.chatPages.get('mayor');
  assert.equal(page.pending.length, 1);
  const item = page.pending[0];
  assert.deepEqual(Object.keys(item).sort(), ['afterId', 'at', 'id', 'status', 'text']);
  assert.deepEqual({text: item.text, at: item.at, afterId: item.afterId, status: item.status}, {text: 'Open a lemonade stand', at: 1_000_000, afterId: 'm2', status: 'sending'});
  assert.equal(t.renders - before, 1, 'one render');
  assert.deepEqual(t.renderLog.at(-1).pending.map(i => i.id), [item.id], 'and the item was there when it ran');
  assert.deepEqual(t.cues, ['send'], 'the send cue as Send is accepted');
  assert.equal(t.box.value, '', 'the box empties at once');
  assert.deepEqual(t.posts, [{path: 'chat', body: {cat: 'mayor', text: 'Open a lemonade stand', mode: 'demo'}}]);
  answer({task: 't9'});
  await tick();
  assert.equal(page.pending.length, 1, 'the thread view swaps it for the journaled message, not the composer');
  assert.equal(t.timers.at(-1).ms, 5000, 'a timer only tidies up an item nothing replaced');
  t.timers.at(-1).fn();
  assert.equal(page.pending.length, 0);
});

test('a failed POST marks the item failed; Retry sends it again and Discard drops it', async () => {
  const chatThread = {open() {}, current: () => null};
  let fail = true;
  const t = setup({chatThread, api: (path, body) => { t.posts.push({path, body}); return fail ? Promise.reject(new Error('Town is paused.')) : Promise.resolve({}); }});
  t.type('Count the coins');
  t.form.requestSubmit();
  await tick();
  const page = t.chatPages.get('mayor');
  assert.equal(page.pending[0].status, 'failed');
  assert.deepEqual(t.cues, ['send', 'error']);
  assert.deepEqual(t.notices, ['Town is paused.']);
  assert.equal(t.box.value, '', 'the failed bubble keeps the text, not the box');

  // The thread view draws Retry and Discard as buttons holding the item id; a click anywhere reaches the composer.
  fail = false;
  const retry = t.doc.createElement('button');
  retry.setAttribute('data-retry', page.pending[0].id);
  t.doc.body.append(retry);
  const failedId = page.pending[0].id;
  t.doc.fire('click', {target: retry});
  assert.equal(page.pending.length, 1);
  assert.notEqual(page.pending[0].id, failedId, 'retry removes the failed item and sends a new one');
  assert.equal(page.pending[0].status, 'sending');
  assert.equal(t.posts.length, 2);
  assert.deepEqual(t.posts[1], t.posts[0], 'the same message again');

  fail = true;
  t.type('Second try');
  t.form.requestSubmit();
  await tick();
  const failed = page.pending.find(i => i.status === 'failed');
  const discard = t.doc.createElement('button');
  discard.setAttribute('data-discard', failed.id);
  t.doc.body.append(discard);
  t.doc.fire('click', {target: discard});
  assert.ok(!page.pending.includes(failed), 'discard removes it');
  assert.equal(t.composer.discard(failed.id), false, 'once');
});

test('a full refetch replaces the pages but keeps a failed message: it moves to the new page', async () => {
  const chatThread = {open() {}, current: () => null};
  const t = setup({chatThread, api: () => Promise.reject(new Error('Offline'))});
  t.type('Keep me');
  t.form.requestSubmit();
  await tick();
  const old = t.chatPages.get('mayor');
  assert.equal(old.pending[0].status, 'failed');
  t.chatPages.clear();
  t.render();
  const page = t.chatPages.get('mayor');
  assert.notEqual(page, old, 'app.js refresh() made a new page');
  assert.deepEqual(page.pending.map(i => [i.text, i.status]), [['Keep me', 'failed']]);
  assert.equal(old.pending.length, 0);
  const id = page.pending[0].id;
  page.pending.length = 0;
  t.render();
  assert.equal(t.composer.retry(id), false, 'an item the thread view dropped is forgotten');
});

test('before 8.6 draws failed bubbles, a failed send puts its text back in the box', async () => {
  const bodies = [];
  const t = setup({api: (path, body) => { bodies.push(body); return Promise.reject(new Error('Network down')); }});
  t.modeSelect.value = 'local|qwen3';
  t.goalBox.checked = true;
  t.type('Grow the garden');
  t.form.requestSubmit();
  assert.equal(t.box.value, '');
  assert.deepEqual(bodies, [{cat: 'mayor', text: 'Grow the garden', mode: 'local', model: 'qwen3', goal: true}], 'the open Reasoning pick, as before');
  assert.equal(t.confirms.length, 0, 'only a Demonstration goal asks first');
  await tick();
  assert.equal(t.box.value, 'Grow the garden', 'the text is never lost');
  assert.equal(t.goalBox.checked, true, 'nor the option it was sent with');
  assert.equal(t.chatPages.get('mayor').pending.length, 0);
  assert.deepEqual(t.notices, ['Network down']);
});

test('a goal and an answer leave no bubble behind once the town has them', async () => {
  const state = townState({approvals: [{id: 'a1', cat: 'mayor', status: 'pending', question: 'Publish?'}]});
  const t = setup({state});
  t.replyBox.checked = true;
  t.type('No, not yet');
  t.form.requestSubmit();
  assert.deepEqual(t.posts.at(-1), {path: 'approvals/a1', body: {answer: 'No, not yet', approved: false}});
  assert.equal(t.chatPages.get('mayor').pending.length, 1, 'it shows at once');
  await tick();
  assert.equal(t.chatPages.get('mayor').pending.length, 0, 'it is journaled as “Rejected: …”, so its bubble goes when the POST answers');
  t.confirmAnswer = false;
  t.type('/goal Keep the square tidy');
  t.form.requestSubmit();
  await tick();
  assert.equal(t.confirms.at(-1).title, 'Start a Demonstration goal?', 'a Demonstration goal asks first, as before');
  assert.equal(t.posts.length, 1, 'Cancel sends nothing');
  assert.equal(t.box.value, '/goal Keep the square tidy', 'and leaves the text');
  t.confirmAnswer = true;
  t.form.requestSubmit();
  await tick();
  assert.deepEqual(t.posts.at(-1), {path: 'chat', body: {cat: 'mayor', text: 'Keep the square tidy', mode: 'demo', goal: true}});
  await tick();
  assert.equal(t.chatPages.get('mayor').pending.length, 0, 'a goal is journaled as its first round');
});

test('the pending item and the POST are plain data', () => {
  const item = pendingItem({text: 'Hi', messages: [{id: 'a'}, {id: 'b'}], at: 5});
  assert.deepEqual({...item, id: 'x'}, {id: 'x', text: 'Hi', at: 5, afterId: 'b', status: 'sending'});
  assert.equal(pendingItem({text: 'First', messages: [], at: 6}).afterId, null, 'an empty chat has no newest message');
  assert.notEqual(pendingItem({text: 'a', at: 1}).id, pendingItem({text: 'a', at: 1}).id);
  assert.deepEqual(requestFor({kind: 'ask', cat: 'scholar', text: 'Done yet?'}, {mode: 'local', model: 'qwen'}), {path: 'ask', body: {cat: 'scholar', text: 'Done yet?', mode: 'local'}});
  assert.deepEqual(requestFor({kind: 'chat', cat: 'mayor', text: 'x', goal: false}, {mode: 'local', model: 'qwen'}), {path: 'chat', body: {cat: 'mayor', text: 'x', mode: 'local', model: 'qwen'}});
  assert.deepEqual(requestFor({kind: 'command', name: 'resume', value: false}), {path: 'pause', body: {value: false}});
});

// -------------------------------------------------------------------------------------------------------------- mentions

test('“@Scholar …” at the start sends to that cat, and the longest name wins', () => {
  const cats = [...CATS, {id: 'sir', name: 'Sir'}, {id: 'pounce', name: 'Sir Pounce'}];
  assert.deepEqual(parseMention('@scholar what did you find?', cats), {cat: 'scholar', text: 'what did you find?'});
  assert.deepEqual(parseMention('@Sir Pounce, the map please', cats), {cat: 'pounce', text: 'the map please'});
  assert.deepEqual(parseMention('@Sir go', cats), {cat: 'sir', text: 'go'});
  assert.deepEqual(parseMention('＠Mayor hello', cats), {cat: 'mayor', text: 'hello'}, 'the full-width @ of a Japanese keyboard');
  assert.deepEqual(parseMention('@critic', cats), {cat: 'critic', text: ''});
  assert.equal(parseMention('@Scholarly hi', cats), null, 'a longer word is not the name');
  assert.equal(parseMention('@nobody hi', cats), null);
  assert.equal(parseMention('mail me@scholar', cats), null, 'only at the start');
  const rows = mentionMatches(cats, '@s', {exclude: 'scholar'});
  assert.deepEqual(rows.map(r => r.name), ['Sir', 'Sir Pounce'], 'the open cat is not offered');
  assert.equal(rows[1].insert, '@Sir Pounce ');
  assert.deepEqual(mentionMatches(cats, '@').map(r => r.id).sort(), ['critic', 'mayor', 'pounce', 'scholar', 'sir']);
  assert.equal(mentionMatches(cats, '@sir pounce').length, 0, 'a space ends the list');
});

test('a mention opens that cat’s chat with the bubble in it; a working cat is refused with a note', async () => {
  const t = setup();
  t.type('@Scholar check the sources');
  t.form.requestSubmit();
  assert.deepEqual(t.selects, ['scholar'], 'the message shows where the reply will come');
  assert.deepEqual(t.posts.at(-1), {path: 'chat', body: {cat: 'scholar', text: 'check the sources', mode: 'demo'}});
  assert.equal(t.chatPages.get('scholar').pending[0].text, 'check the sources');
  await tick();

  t.state = townState({tasks: [{id: 't5', cat: 'critic', status: 'running'}]});
  t.selected = 'mayor';
  t.render();
  t.type('@Critic look again');
  t.form.requestSubmit();
  const note = t.form.querySelector('.composer-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /^Critic is working\. Ask how it’s going with \/ask/);
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(t.box.value, '@Critic look again', 'nothing was sent, so the text stays');
  t.type('@Critic /ask how far along are you?');
  t.form.requestSubmit();
  assert.deepEqual(t.posts.at(-1), {path: 'ask', body: {cat: 'critic', text: 'how far along are you?', mode: 'demo'}});
  assert.equal(note.hidden, true);
});

// -------------------------------------------------------------------------------------------------------------- commands

test('built-in / commands are listed first, and a plugin command with the same name inserts as plugin:name', () => {
  const plugins = [{name: 'review', plugin: 'lint', description: 'Review the diff'}, {name: 'stop', plugin: 'lint', description: 'Stop the linter'}];
  const rows = slashMatches(plugins, '/', {builtins: BUILTIN_COMMANDS});
  const builtins = ['goal', 'ask', 'pause', 'resume', 'stop', 'connect', 'routines', 'money', 'memory', 'autonomy'];
  assert.deepEqual(rows.slice(0, builtins.length).map(r => r.label), builtins, 'the panel commands sit beside /pause and /resume');
  assert.ok(rows.slice(0, builtins.length).every(r => r.builtin));
  assert.deepEqual(rows.slice(builtins.length).map(r => r.insert), ['/review ', '/lint:stop ']);
  assert.deepEqual(slashMatches(plugins, '/st', {builtins: BUILTIN_COMMANDS}).map(r => r.insert), ['/stop ', '/lint:stop '], 'the bare name runs the built-in');
  assert.deepEqual(slashMatches(plugins, '/rev').map(r => r.insert), ['/review '], 'without built-ins the list is as before');

  const idle = townState(), paused = townState({paused: true}), busy = townState({tasks: [{id: 'r1', cat: 'mayor', status: 'running'}, {id: 'c1', cat: 'scholar', parent: 'r1', status: 'running'}]});
  const none = () => false;
  assert.deepEqual(offeredCommands(idle, 'mayor', undefined, none).map(c => c.name), ['goal', 'ask', 'pause']);
  assert.deepEqual(offeredCommands(paused, 'scholar', undefined, none).map(c => c.name), ['ask', 'resume'], '/goal belongs to the Mayor’s chat');
  assert.deepEqual(offeredCommands(busy, 'mayor', undefined, none).map(c => c.name), ['goal', 'ask', 'pause', 'stop']);
  assert.deepEqual(offeredCommands(idle, 'mayor').map(c => c.name), ['goal', 'ask', 'pause', 'connect', 'routines', 'money', 'memory', 'autonomy'], 'with every panel open to this device');
  assert.deepEqual(offeredCommands(paused, 'scholar', undefined, panel => panel !== 'postoffice').map(c => c.name), ['ask', 'resume', 'routines', 'money', 'memory', 'autonomy'],
    'a panel this device cannot open is not offered: here the Post office, as on a paired phone');
  assert.deepEqual(workRoots(busy, 'scholar'), ['r1'], '/stop in a helper’s chat stops the request it works for');
  assert.deepEqual(workRoots(busy, 'mayor', {kind: 'request', id: 'r1'}), ['r1']);
  assert.deepEqual(parseCommand('/Goal  grow the garden'), {name: 'goal', args: 'grow the garden'});
  assert.equal(parseCommand('/review this'), null, 'plugin commands go to the server as typed');
});

test('/connect, /routines, /money, /memory and /autonomy open their panels: nothing is sent, even while the town is paused', () => {
  assert.deepEqual(COMMAND_PANELS, {connect: 'postoffice', routines: 'routines', money: 'money', memory: 'memory', autonomy: 'autonomy'});
  for (const [name, panel] of Object.entries(COMMAND_PANELS)) {
    assert.deepEqual(planSend(`/${name}`, {state: townState(), selected: 'mayor'}), {kind: 'open', panel, name});
    assert.deepEqual(planSend(`/${name}`, {state: townState({paused: true}), selected: 'scholar'}), {kind: 'open', panel, name}, `/${name} works paused, in any cat’s chat`);
    assert.equal(requestFor({kind: 'open', panel, name}), null, `/${name} posts nothing`);
  }
  assert.deepEqual(planSend('@Scholar /money', {state: townState(), selected: 'mayor'}), {kind: 'open', panel: 'money', name: 'money'});
  assert.deepEqual(parseCommand('/Connect'), {name: 'connect', args: ''});

  const opened = [];
  const t = setup({state: townState({paused: true}), openPanel: panel => { opened.push(panel); return true; }, canOpen: panel => panel !== 'autonomy'});
  t.type('/money');
  assert.equal(t.send.disabled, false, 'Send opens for a panel command while the town is paused');
  t.form.requestSubmit();
  assert.deepEqual(opened, ['money']);
  assert.equal(t.box.value, '', 'the box empties');
  assert.deepEqual(t.posts, [], 'nothing was sent');
  assert.equal(t.chatPages.get('mayor').pending?.length ?? 0, 0, 'and no bubble');
  t.type('/connect');
  t.form.requestSubmit();
  assert.deepEqual(opened, ['money', 'postoffice']);
  t.type('/autonomy');
  t.form.requestSubmit();
  assert.deepEqual(opened, ['money', 'postoffice'], 'a panel this device cannot open stays shut');
  assert.equal(t.box.value, '/autonomy', 'and the text stays');
  const note = t.form.querySelector('.composer-note');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'The Mayor’s autonomy doesn’t open on this device.');
});

test('what Send does, in plain data', () => {
  const ctx = (extra = {}, opts = {}) => ({state: townState(extra), selected: 'mayor', ...opts});
  assert.deepEqual(planSend('  ', ctx()), {kind: 'none'});
  assert.deepEqual(planSend('hi', ctx({readOnly: true})), {kind: 'none'}, 'a viewer sends nothing');
  assert.match(planSend('hi', ctx({}, {connected: false})).note, /Reconnecting/);
  assert.deepEqual(planSend('hi', ctx()), {kind: 'chat', cat: 'mayor', text: 'hi', goal: false});
  assert.deepEqual(planSend('hi', ctx({}, {goal: true})), {kind: 'chat', cat: 'mayor', text: 'hi', goal: true});
  assert.equal(planSend('hi', ctx({}, {goal: true, selected: 'scholar'})).goal, false, 'the goal option is the Mayor’s');
  assert.match(planSend('hi', ctx({paused: true})).note, /Type \/resume/);
  assert.deepEqual(planSend('/resume', ctx({paused: true})), {kind: 'command', name: 'resume', value: false}, '/resume works while paused');
  assert.match(planSend('/pause', ctx({paused: true})).note, /already paused/);
  assert.match(planSend('/goal', ctx()).note, /Type the goal after \/goal/);
  assert.match(planSend('/goal x', ctx({}, {selected: 'scholar'})).note, /Goals belong to the Mayor/);
  assert.match(planSend('/stop', ctx()).note, /Nothing is running/);
  assert.deepEqual(planSend('/ask how goes it', ctx({}, {selected: 'scholar'})), {kind: 'ask', cat: 'scholar', text: 'how goes it'});
  assert.deepEqual(planSend('hi', ctx({}, {selected: 'scholar', askInstead: true})), {kind: 'ask', cat: 'scholar', text: 'hi'});
  const approvals = [{id: 'a1', cat: 'critic', status: 'pending'}];
  assert.deepEqual(planSend('Yes, go ahead', ctx({approvals}, {reply: true})), {kind: 'answer', approval: 'a1', cat: 'critic', text: 'Yes, go ahead', approved: true});
  assert.equal(planSend('@Scholar hi', ctx({approvals}, {reply: true})).kind, 'chat', 'a mention is not an answer');
  const full = {tasks: [{id: 'r', cat: 'mayor', status: 'running'}]};
  assert.equal(planSend('hi', ctx(full)).kind, 'chat', 'the Mayor takes messages into its inbox while the town is full');
  assert.match(planSend('hi', ctx(full, {selected: 'scholar'})).note, /Every work slot is busy/);
});

test('/pause, /resume and /stop go to their routes with no bubble, and Send opens for them while the town is paused', async () => {
  const t = setup({state: townState({tasks: [{id: 'r1', cat: 'mayor', status: 'running'}, {id: 'r2', cat: 'mayor', status: 'waiting_child'}]})});
  t.type('/stop');
  t.form.requestSubmit();
  await tick();
  assert.equal(t.confirms.at(-1).title, 'Stop 2 pieces of work?');
  assert.deepEqual(t.posts.map(p => p.path), ['tasks/r1/stop', 'tasks/r2/stop'], 'two pieces of work, one confirm, both stopped');
  assert.equal(t.chatPages.get('mayor').pending?.length ?? 0, 0);
  t.state = townState({paused: true});
  t.render();
  assert.equal(t.send.disabled, true, 'render() closes Send while the town is paused');
  t.type('/resume');
  assert.equal(t.send.disabled, false, 'but /resume can still go');
  t.form.requestSubmit();
  await tick();
  assert.deepEqual(t.posts.at(-1), {path: 'pause', body: {value: false}});
  t.type('hello');
  assert.equal(t.send.disabled, true, 'a plain message waits for the town');
});

// ---------------------------------------------------------------------------------------------- the switcher and "/" focus

test('the switcher names the thread and what waits, lists the threads, and closes on Escape without closing the sheet', () => {
  const state = townState({tasks: [{id: 't1', cat: 'mayor', from: 'owner', text: 'Write the fair poster', status: 'running'}, {id: 't2', cat: 'scholar', parent: 't1', status: 'running'}], goals: [{id: 'g1', title: 'Grow the garden', status: 'paused'}]});
  const t = setup({state, waiting: 2});
  assert.equal(t.switcher.getAttribute('aria-label'), 'Mayor thread, 2 waiting on you', 'as chat-ux §6 words it');
  assert.equal(t.switcher.getAttribute('aria-expanded'), 'false');
  assert.equal(t.switcher.getAttribute('aria-controls'), 'thread-list');
  assert.equal(t.form.querySelector('.thread-switch-count').textContent, '2');
  assert.equal(t.switcher.getAttribute('type'), 'button');
  assert.ok(t.form.childNodes.indexOf(t.switcher) < t.form.childNodes.indexOf(t.chip), 'the switcher comes before the Options chip, in screen order');
  t.switcher.fire('click', {detail: 1});
  assert.equal(t.switcher.getAttribute('aria-expanded'), 'true');
  assert.equal(t.list.hidden, false);
  const names = t.list.querySelectorAll('button').map(b => b.getAttribute('aria-label'));
  assert.deepEqual(names, ['Waiting on you (2)', 'Mayor, Working', 'Write the fair poster, Working', 'Grow the garden, Paused', 'Scholar, Working', 'Critic, At ease']);
  assert.equal(t.option('Mayor').getAttribute('aria-current'), 'true');
  assert.equal(t.doc.activeElement, t.option('Mayor'), 'focus goes to the open thread');
  t.list.fire('keydown', {key: 'ArrowDown'});
  const focused = t.option('Write the fair poster');
  assert.equal(t.doc.activeElement, focused);
  t.render();
  assert.equal(t.doc.activeElement, focused, 'a render while the list is open keeps keyboard focus where it was');
  assert.ok(t.list.contains(focused));
  const escape = t.list.fire('keydown', {key: 'Escape'});
  assert.equal(t.list.hidden, true);
  assert.ok(escape.stopped, 'the chat sheet stays open');
  assert.equal(t.doc.activeElement, t.switcher);
  t.pick('Waiting on you');
  assert.equal(t.openedInbox, 1, 'the pinned row opens the Inbox');

  t.waiting = 0;
  t.selected = 'scholar';
  t.render();
  assert.equal(t.switcher.getAttribute('aria-label'), 'Scholar thread');
  assert.equal(t.form.querySelector('.thread-switch-count').hidden, true);
  // The count comes from the Needs you list after a render; count() repaints the name and badge without one.
  const renders = t.renders;
  t.waiting = 4;
  t.composer.count();
  assert.equal(t.switcher.getAttribute('aria-label'), 'Scholar thread, 4 waiting on you');
  assert.equal(t.form.querySelector('.thread-switch-count').textContent, '4');
  assert.equal(t.renders, renders);
  assert.equal(switcherLabel({kind: 'request', id: 't1'}, state, 1), 'Request thread: Write the fair poster, 1 waiting on you');
  assert.equal(switcherLabel({kind: 'goal', id: 'g1'}, state), 'Goal thread: Grow the garden');
});

test('the composer’s popovers never stack: focus on the switcher closes the Options popover', () => {
  const t = setup();
  const menu = t.doc.createElement('div'), label = t.doc.createElement('label'), box = t.doc.createElement('input');
  label.dataset = {short: 'Goal'};
  label.append(box);
  menu.append(label);
  t.form.append(menu);
  const options = initComposerOptions({form: t.form, chip: t.chip, menu, doc: t.doc});
  t.chip.fire('click');
  assert.equal(menu.hidden, false);
  t.box.focus();
  t.doc.fire('focusin', {target: box});
  assert.equal(menu.hidden, false, 'focus inside the popover keeps it open');
  t.doc.fire('focusin', {target: t.switcher});
  assert.equal(menu.hidden, true, 'focus on the switcher closes it');
  assert.equal(t.chip.getAttribute('aria-expanded'), 'false');
  options.paint();
});

test('before 8.6 the switcher opens a request in its cat’s chat; what current() says is checked against the open cat', () => {
  const state = townState({tasks: [{id: 't1', cat: 'scholar', from: 'owner', text: 'Find the old maps', status: 'done'}]});
  const t = setup({state});
  t.pick('Find the old maps');
  assert.equal(t.selected, 'scholar', 'no open(): the request’s cat opens, as Projects’ “Open in chat” does');
  assert.deepEqual(resolveThread(null, 'mayor', state), {kind: 'mayor', id: 'mayor'});
  assert.deepEqual(resolveThread({kind: 'request', id: 't1'}, 'scholar', state), {kind: 'request', id: 't1'});
  assert.deepEqual(resolveThread({kind: 'request', id: 't1'}, 'critic', state), catThread('critic'), 'a stale request thread yields to the open cat');
  assert.deepEqual(resolveThread({kind: 'goal', id: 'g1'}, 'scholar', state), catThread('scholar'));
  assert.deepEqual(resolveThread({kind: 'mayor'}, 'mayor', state), {kind: 'mayor', id: 'mayor'});
  const groups = threadOptions(townState(), catThread('critic'));
  assert.deepEqual(groups.flatMap(g => g.items).filter(i => i.current).map(i => i.id), ['critic']);
});

test('“/” focuses the composer when focus is not in a text field', () => {
  const doc = new FakeDocument();
  const key = (target, extra = {}) => ({key: '/', target, ...extra});
  const input = type => Object.assign(doc.createElement('input'), {type});
  assert.equal(wantsComposerFocus(key(doc.body), {doc}), true);
  assert.equal(wantsComposerFocus(key(input('checkbox')), {doc}), true, 'a checkbox is not a text field');
  for (const target of [input('text'), input('search'), doc.createElement('textarea'), doc.createElement('select'), {tagName: 'DIV', isContentEditable: true}]) assert.equal(wantsComposerFocus(key(target), {doc}), false, `${target.tagName} ${target.type ?? ''}`);
  assert.equal(wantsComposerFocus(key(doc.body, {ctrlKey: true}), {doc}), false);
  assert.equal(wantsComposerFocus(key(doc.body), {doc, readOnly: true}), false);
  assert.equal(wantsComposerFocus({key: 'a', target: doc.body}, {doc}), false);
  const dialog = doc.createElement('dialog');
  dialog.setAttribute('open', '');
  doc.body.append(dialog);
  assert.equal(wantsComposerFocus(key(doc.body), {doc}), false, 'not behind an open dialog');
  assert.equal(isTextField(null), false);

  const t = setup();
  const button = t.doc.createElement('button');
  t.doc.body.append(button);
  button.focus();
  const event = t.doc.fire('keydown', key(button));
  assert.ok(event.defaultPrevented, 'the slash is not typed');
  assert.equal(t.doc.activeElement, t.box);
  assert.equal(t.openedChat, 0, 'an open chat stays where it is');
  button.focus();
  t.panel.hidden = true;
  t.doc.fire('keydown', key(button));
  assert.equal(t.openedChat, 1, 'a closed chat opens first');
  assert.equal(t.doc.activeElement, t.box);
  t.panel.hidden = false;
  t.form.getClientRects = () => [];
  button.focus();
  t.doc.fire('keydown', key(button));
  assert.equal(t.openedChat, 2, 'a chat folded to its rail (the form is not drawn) opens first too');
  delete t.form.getClientRects;
  t.box.focus();
  assert.equal(t.doc.fire('keydown', key(t.box)).defaultPrevented, false, 'in the box, "/" is just typed');
});

test('at open the composer has focus with a mouse, once, and never takes it from a touch screen, a viewer, a dialog or the owner (Gate 8)', () => {
  const desk = setup({fine: true});
  assert.equal(desk.doc.activeElement, desk.box, 'the first render with the town puts the cursor in the composer');
  const button = desk.doc.createElement('button');
  desk.doc.body.append(button);
  button.focus();
  desk.render();
  assert.equal(desk.doc.activeElement, button, 'later renders leave focus where the owner put it');

  assert.notEqual(setup().doc.activeElement?.id, 'message', 'a touch screen keeps its keyboard down');
  assert.notEqual(setup({fine: true, state: townState({readOnly: true})}).doc.activeElement?.id, 'message', 'a viewer has no composer to type in');
  const behind = setup({fine: true, prepare: doc => { const dialog = doc.createElement('dialog'); dialog.setAttribute('open', ''); doc.body.append(dialog); }});
  assert.notEqual(behind.doc.activeElement?.id, 'message', 'an open dialog keeps focus');
});

test('“Go to conversation”, the first Tab stop, opens the chat and puts the cursor in the composer', () => {
  const t = setup();
  t.panel.hidden = true;
  const click = t.skipLink.fire('click');
  assert.ok(click.defaultPrevented, 'the link does not jump the page');
  assert.equal(t.openedChat, 1, 'a closed chat opens first');
  assert.equal(t.doc.activeElement, t.box);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<body[^>]*><a href="#message" id="skip-to-chat" class="skip-link">Go to conversation<\/a>/, 'it is the first element of the page');
});

test('Enter sends, Shift+Enter is a new line, and the list takes Enter while it is open', () => {
  const t = setup();
  t.type('One line');
  const shift = {key: 'Enter', shiftKey: true, preventDefault() { this.prevented = true; }};
  t.box.onkeydown(shift);
  assert.equal(t.posts.length, 0);
  assert.ok(!shift.prevented);
  t.box.onkeydown({key: 'Enter', preventDefault() {}});
  assert.equal(t.posts.length, 1);
  t.type('@Sch');
  const list = t.form.querySelector('.slash-list');
  assert.equal(list.hidden, false, 'the cats list opens for "@"');
  assert.equal(list.getAttribute('aria-label'), 'Cats');
  t.box.onkeydown({key: 'Enter', preventDefault() {}, stopPropagation() {}});
  assert.equal(t.box.value, '@Scholar ', 'Enter picks the cat instead of sending');
  assert.equal(t.posts.length, 1);
});

// --------------------------------------------------------------------------------------------------------- attach (11.26)

const ARTIFACT = n => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const dragOf = (files, types = files.length ? ['Files'] : ['text/plain']) => ({dataTransfer: {types, files, dropEffect: 'none'}});

test('Attach: the button and a dropped file each put a line naming the saved artifact in the box, and the sent message carries it', async () => {
  const picked = [];
  const t = setup({upload: async file => { picked.push(file.name); return {id: ARTIFACT(picked.length), title: file.name, kind: 'text'}; }});
  const attach = t.form.querySelector('.composer-attach'), input = t.form.querySelector('input[type=file]');
  assert.equal(attach.hidden, false, 'the owner sees Attach');
  assert.equal(attach.getAttribute('aria-label'), 'Attach a file');
  assert.ok(attach.classList.contains('thread-switch'), 'the switcher’s 44 px button rule');
  assert.equal(input.hidden, true, 'the file input itself is never on screen');
  let opened = 0;
  input.addEventListener('click', () => { opened += 1; });
  attach.fire('click');
  assert.equal(opened, 1, 'Attach opens the file picker');

  t.type('Summarise this');
  input.files = [{name: 'notes.txt', type: 'text/plain'}];
  input.fire('change');
  await tick();
  assert.equal(t.box.value, `Summarise this\nAttached: notes.txt (artifact ${ARTIFACT(1)})`);
  assert.equal(input.value, '', 'the same file can be picked again');
  assert.equal(t.drafts.get('w1|mayor:mayor'), t.box.value, 'the line is part of the thread’s draft');

  const over = t.panel.fire('dragover', dragOf([{name: 'receipt.png'}]));
  assert.ok(over.defaultPrevented, 'a file dragged over the chat panel may be dropped');
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  const drop = t.panel.fire('drop', dragOf([{name: 'receipt.png', type: 'image/png'}]));
  assert.ok(drop.defaultPrevented, 'the browser does not open the dropped file in place of the town');
  await tick();
  assert.equal(t.box.value.split('\n').at(-1), `Attached: receipt.png (artifact ${ARTIFACT(2)})`);
  assert.deepEqual(picked, ['notes.txt', 'receipt.png']);
  const text = t.panel.fire('drop', dragOf([]));
  assert.equal(text.defaultPrevented, false, 'dropped text is left to the text box');

  t.box.onkeydown({key: 'Enter', shiftKey: false, preventDefault() {}});
  await tick();
  const sent = t.posts.at(-1);
  assert.equal(sent.path, 'chat');
  assert.ok(sent.body.text.includes(`artifact ${ARTIFACT(1)}`) && sent.body.text.includes(`artifact ${ARTIFACT(2)}`), 'the message names both artifacts');
});

test('Attach: a refusal is shown in the server’s words next to the composer, and the box keeps what was typed', async () => {
  const t = setup({upload: async file => { throw new Error(file.name === 'big.mov' ? 'This file is larger than the 20 MB limit.' : 'Only the owner hands Clowder a file.'); }});
  const input = t.form.querySelector('input[type=file]'), note = t.form.querySelector('.composer-note');
  t.type('Look at this');
  input.files = [{name: 'big.mov'}];
  input.fire('change');
  await tick();
  assert.equal(t.box.value, 'Look at this');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'big.mov: This file is larger than the 20 MB limit.');
  assert.equal(note.getAttribute('role'), 'status', 'a screen reader hears it');
  assert.ok(t.cues.includes('error'));
});

test('Attach: a viewer or member page has no Attach control and takes no dropped file', async () => {
  let calls = 0;
  const t = setup({state: townState({readOnly: true, me: {role: 'viewer'}}), upload: async () => { calls += 1; return {}; }});
  assert.equal(t.form.querySelector('.composer-attach').hidden, true);
  const over = t.panel.fire('dragover', dragOf([{name: 'notes.txt'}])), drop = t.panel.fire('drop', dragOf([{name: 'notes.txt'}]));
  await tick();
  assert.deepEqual([over.defaultPrevented, drop.defaultPrevented, calls], [false, false, 0]);
});

test('uploadFile speaks the real upload route: the owner’s file is saved, and every refusal comes back in its words', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'composer-attach-')), store = new Store(join(dir, 'events.jsonl'), []), PORT = 9998, KEY = 'composer-attach-key';
  const local = Fastify();
  installAccess(local, false, [], PORT, undefined, undefined, KEY);
  registerUploadRoutes(local, {dir: () => dir, journal: () => store, owner: isOwner});
  const stranger = Fastify();
  registerUploadRoutes(stranger, {dir: () => dir, journal: () => store, owner: () => false});
  // The browser's fetch, through Fastify's inject: the composer's own method, headers and body reach the route unchanged.
  const via = (app, cookie = `town_owner_${PORT}=${KEY}`) => async (url, init) => {
    const r = await app.inject({method: init.method, url, payload: Buffer.from(await init.body.arrayBuffer()), headers: {host: `localhost:${PORT}`, cookie, ...init.headers}});
    return new Response(r.body, {status: r.statusCode, headers: {'content-type': 'application/json'}});
  };
  try {
    const saved = await uploadFile(new File(['Milk, eggs, 12.40'], 'Café receipt.txt', {type: 'text/plain'}), via(local));
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([saved.title, saved.kind], ['Café receipt.txt', 'text'], 'the name survives the header');
    assert.deepEqual(artifactIndex(store.state.events).map(a => [a.id, a.cat]), [[saved.id, 'owner']]);
    assert.equal(readFileSync(join(artifactsDir(dir), `${saved.id}.txt`), 'utf8'), 'Milk, eggs, 12.40');
    // A PDF is not on the route's list (src/uploads.ts uploadKind): refused, in its words.
    await assert.rejects(uploadFile(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 1, 2, 3])], 'scan.pdf'), via(local)), {message: /^Clowder cannot keep this kind of file\./});
    // Too big: refused before sending (a browser cannot read the route's early 413), with the cap and the words of that 413.
    assert.equal(CLIENT_CAP, UPLOAD_CAP, 'the composer’s cap is the route’s');
    const huge = new Uint8Array(UPLOAD_CAP + 1), sentHuge = [];
    const said = await local.inject({method: 'POST', url: '/api/uploads', payload: Buffer.from(huge), headers: {host: `localhost:${PORT}`, cookie: `town_owner_${PORT}=${KEY}`, 'x-town-action': 'owner', 'content-type': 'text/plain', 'x-file-name': 'huge.txt'}});
    assert.equal(said.statusCode, 413);
    await assert.rejects(uploadFile(new File([huge], 'huge.txt'), async (...call) => { sentHuge.push(call); return via(local)(...call); }), {message: said.json().error});
    assert.equal(sentHuge.length, 0, 'nothing is sent');
    assert.ok((await uploadFile(new File([new Uint8Array(UPLOAD_CAP).fill(97)], 'at-cap.txt'), async () => new Response('{"id":"x","title":"at-cap.txt"}'))).id, 'at the cap exactly it goes');
    await assert.rejects(uploadFile(new File(['hello'], 'note.txt'), via(stranger)), {message: 'Only the owner hands Clowder a file.'});
    await assert.rejects(uploadFile(new File(['hello'], 'note.txt'), via(local, '')), {message: /\S/}, 'no owner session: the gate refuses');
    await assert.rejects(uploadFile(new File(['hello'], 'note.txt'), async () => { throw new TypeError('Failed to fetch'); }), {message: 'It did not reach Clowder. Check the connection and try again.'});
    assert.equal(artifactIndex(store.state.events).length, 1, 'nothing refused was saved');
  } finally {
    await local.close();
    await stranger.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------------------------------------------- app.js and the stylesheet

test('app.js keeps one wiring line for the composer and no Send handler of its own', () => {
  const app = read('app.js');
  assert.equal(app.match(/createComposer\(/g)?.length, 1);
  assert.match(app, /const composer=createComposer\(\{form:\$\('chat-form'\),chatThread,chatPages,/);
  assert.ok(!app.includes("$('chat-form').onsubmit"), 'the Send handler lives in chat-composer.js');
  assert.ok(!app.includes('mountSlashList'), 'the composer mounts the list');
  assert.match(app, /composerOptions\.paint\(\);composer\.paint\(\);fitComposer\(\$\('message'\)\);/, 'render() repaints the composer');
  assert.match(app, /nameDockButton\(\$\('toggle-quests'\),questCount\);composer\.count\(\);/, 'the switcher takes the same "needs you" count as the dock');
  assert.equal(app.match(/\bcomposer\.\w+\(/g)?.length, 2, 'and nothing else in app.js reaches into the composer');
  assert.match(read('chat-composer.js'), /import \{uiSound\} from '\.\/ui-sounds\.js';/);
  assert.match(read('chat-composer.js'), /new URL\('chat-composer\.css', import\.meta\.url\)/, 'the module links its own stylesheet');
});

test('the composer stylesheet uses the tokens only and keeps touch-size targets', () => {
  const css = read('chat-composer.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...css.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]).join(';');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(declarations), 'no colour literals');
  assert.ok(!/font-family/.test(css), 'no fonts');
  assert.ok(!/:root/.test(css), 'no new tokens');
  for (const file of ['chat-composer.css', 'chat-composer.js', 'slash-commands.js']) assert.ok(!/#a77b35|#8c806a/i.test(read(file)), `${file}: no retired colour`);
  assert.match(css, /\.thread-switch\{[^}]*width:var\(--tap\);height:var\(--tap\);min-height:var\(--tap\)/);
  assert.match(css, /\.thread-option\{[^}]*min-height:var\(--tap\)/);
  assert.match(css, /#chat-form:has\(> \.composer-attach:not\(\[hidden\]\)\)\{grid-template-columns:auto auto auto minmax\(0,1fr\) 44px\}/, 'Attach has its own column, so Send stays on the row');
  assert.match(css, /#chat-form:has\(> \.composer-attach:not\(\[hidden\]\)\):has\(> #composer-options\[hidden\]\)\{grid-template-columns:auto auto minmax\(0,1fr\) 44px\}/);
  assert.ok(!/transition|animation/.test(css), 'nothing here moves; buttons keep the global rule that reduced motion turns off');
});

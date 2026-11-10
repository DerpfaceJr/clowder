// Plan 8.8: decisions answered where they appear. One card (decision-strip.js decisionCard) serves the strip above the composer, the Inbox
// and the thread. Inline answers only where the server's quick list allows; the rest open the card with focus on its first option; an answer
// waits 4 s behind Undo and is posted only then; answered cards fold to one line; the glossary words say what they mean.
// The proof: a quick decision in at most 2 taps and a card decision in at most 3, from the chat and from the Inbox.
// Plan 11.6, at the end: every card names the request it serves, and one decision shows one card on screen.
// Plan 11.17, after it: an answer made while Clowder is not answering waits in an outbox and is sent once when it answers again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserPath, freePort, newPage, loadApp, openMayorChat, askDemoDecision} from './helpers/chat-spine-scratch.mjs';
import {quickActions} from '../src/push.ts';
import {HOLD_MS, HTML, OUTBOX_KEY, QUEUED, RETRY_MS, answeredLine, createDecisionStrip, decisionCard, decisionCardHtml, quickOf, requestOf, requestTitle} from '../public/decision-strip.js';
import {GLOSSARY, createQuestsPanel} from '../public/quests-panel.js';
import {installUiSounds} from '../public/ui-sounds.js';
import {oneLiner} from '../public/one-liner.js';

// A small DOM for Node: elements, text, attributes, data-*, simple selectors (tag, #id, .class, [attr], [attr="v"], and comma lists),
// bubbling clicks and keys, focus that skips hidden and closed things, and a dialog whose showModal honours autofocus and whose close
// gives focus back and fires its close event after the current code, as browsers do.
class Text {
  constructor(doc, text) { Object.assign(this, {ownerDocument: doc, nodeType: 3, parentNode: null, text: String(text)}); }
  get textContent() { return this.text; }
}
const kebab = k => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
function parse(selector) {
  return selector.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^([a-z][a-z0-9-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/i);
    if (!m) throw new Error(`selector not supported here: ${s}`);
    const parts = [...m[2].matchAll(/([#.])([\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g)];
    return {tag: m[1]?.toUpperCase() ?? null, parts};
  });
}
class El {
  constructor(doc, tag) {
    Object.assign(this, {ownerDocument: doc, nodeType: 1, tagName: tag.toUpperCase(), attrs: new Map(), childNodes: [], parentNode: null, listeners: {}, value: '', disabled: false, style: {setProperty() {}}});
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get type() { return this.getAttribute('type') ?? ''; }
  set type(v) { this.setAttribute('type', v); }
  get autofocus() { return this.hasAttribute('autofocus'); }
  set autofocus(v) { if (v) this.setAttribute('autofocus', ''); else this.removeAttribute('autofocus'); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) {
    if (!v) { this.removeAttribute('hidden'); return; }
    this.setAttribute('hidden', '');
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  get dataset() {
    const el = this;
    return new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? el.getAttribute(`data-${kebab(k)}`) ?? undefined : undefined),
      set: (_, k, v) => { el.setAttribute(`data-${kebab(k)}`, v); return true; },
    });
  }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(String(v) ? [new Text(this.ownerDocument, v)] : [])); }
  set innerHTML(v) { this.childNodes = []; this.raw = String(v); }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new Text(this.ownerDocument, n) : n;
      if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter(c => c !== node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    const doc = this.ownerDocument, had = this !== doc.activeElement && this.contains(doc.activeElement);
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
    if (had && !doc.activeElement.isConnected) doc.activeElement = doc.body;
  }
  remove() { this.parentNode?.replaceChildren(...this.parentNode.childNodes.filter(c => c !== this)); }
  before(...nodes) {
    const parent = this.parentNode, list = parent.childNodes.filter(c => !nodes.includes(c)), at = list.indexOf(this);
    for (const n of nodes) { n.parentNode?.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1); n.parentNode = parent; }
    parent.childNodes = [...list.slice(0, at), ...nodes, ...list.slice(at)];
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  matches(selector) {
    return parse(selector).some(({tag, parts}) => (!tag || tag === this.tagName) && parts.every(p => (p[1] === '#' ? this.id === p[2]
      : p[1] === '.' ? this.className.split(/\s+/).includes(p[2]) : p[4] === undefined ? this.hasAttribute(p[3]) : this.getAttribute(p[3]) === p[4])));
  }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n; return null; }
  get focusable() {
    if (!this.isConnected || this.disabled) return false;
    if (!['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT'].includes(this.tagName) && !this.hasAttribute('tabindex')) return false;
    for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.hidden || (n.tagName === 'DIALOG' && !n.open)) return false;
    return true;
  }
  focus() { if (this.focusable) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) {
    event.target ??= this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    if (event.bubbles) path.push(this.ownerDocument);
    for (const n of event.bubbles ? path : [this]) {
      event.currentTarget = n;
      if (event.type === 'click' && typeof n.onclick === 'function') n.onclick(event);
      for (const fn of n.listeners?.[event.type] ?? []) fn(event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent(makeEvent('click')); }
  showModal() {
    if (this.open) return;
    this.before = this.ownerDocument.activeElement;
    this.open = true;
    const all = this.querySelectorAll('button, textarea, input, [tabindex]').filter(n => n.focusable);
    (all.find(n => n.autofocus) ?? all[0])?.focus();
  }
  close() {
    if (!this.open) return;
    const doc = this.ownerDocument, inside = this.contains(doc.activeElement);
    this.open = false;
    if (inside) doc.activeElement = this.before?.focusable ? this.before : doc.body;
    queueMicrotask(() => this.dispatchEvent(makeEvent('close', false)));
  }
}
function makeEvent(type, bubbles = true, extra = {}) {
  return {type, bubbles, target: null, currentTarget: null, stopped: false, defaultPrevented: false, ...extra,
    stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }};
}
function makeDocument() {
  const doc = {listeners: {}, visibilityState: 'visible'};
  doc.createElement = tag => new El(doc, tag);
  doc.createElementNS = (ns, tag) => new El(doc, tag);
  doc.createTextNode = text => new Text(doc, text);
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = id => doc.documentElement.querySelector(`#${id}`);
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  return doc;
}
// h for test markup: h('div', {id: 'x'}, children...).
const h = (doc, tag, attrs = {}, ...children) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...children); return n; };

// The chat sheet's decision parts as index.html has them: the strip, and the full card (the dialog) with Close ahead of the options.
function mountChat(doc) {
  const sheet = h(doc, 'aside', {id: 'inspector-panel'},
    h(doc, 'div', {id: 'chat'}), h(doc, 'div', {id: 'approvals'}), h(doc, 'form', {id: 'chat-form'}, h(doc, 'textarea', {id: 'message'})));
  const dialog = h(doc, 'dialog', {id: 'approval-dialog'},
    h(doc, 'span', {id: 'approval-avatar'}), h(doc, 'span', {class: 'eyebrow'}, 'NEEDS YOUR DECISION'), h(doc, 'h2', {id: 'approval-title'}),
    h(doc, 'button', {type: 'button', class: 'close-x', 'aria-label': 'Close decision'}),
    h(doc, 'p', {id: 'approval-question'}), h(doc, 'details', {id: 'approval-detail'}, h(doc, 'pre', {id: 'approval-detail-text'})),
    h(doc, 'div', {id: 'approval-options'}), h(doc, 'textarea', {id: 'approval-custom'}), h(doc, 'p', {id: 'approval-error'}),
    h(doc, 'button', {type: 'button', id: 'approval-decline'}, 'Decline'), h(doc, 'button', {type: 'button', id: 'approval-send'}, 'Send answer'),
    h(doc, 'p', {id: 'approval-hint'}));
  doc.body.append(sheet, dialog);
  return {sheet, dialog, strip: doc.getElementById('approvals')};
}

const cats = [{id: 'mayor', name: 'Mayor'}, {id: 'scholar', name: 'Scholar'}, {id: 'scribe', name: 'Scribe'}];
// Decisions as GET /api/state lists them: quick is publicApproval's, from the same quickActions rule push and Telegram use.
const withQuick = a => ({status: 'pending', ...a, quick: quickActions(a)});
const quickDecision = withQuick({id: 'a1', cat: 'scholar', question: 'Scholar wants to use GitHub: get_file_contents on DerpfaceJr/cat-town', options: ['Allow once', 'Always allow (this cat)', 'Always allow (every cat)', 'Deny'], gate: 'connector', effectClass: 'read'});
const cardDecision = withQuick({id: 'a2', cat: 'scribe', question: 'Scribe wants to use GitHub: push_files to DerpfaceJr/cat-town', options: ['Allow once', 'Deny'], gate: 'connector', effectClass: 'public'});
const hermesDecision = withQuick({id: 'a3', cat: 'mayor', question: 'Mayor wants to run: terminal', options: ['Allow once', 'Deny'], gate: 'hermes'});
const plainQuestion = withQuick({id: 'a4', cat: 'mayor', question: 'Which name should the shop use?', options: ['Whisker Works', 'Paw & Co', 'Tabby Tea']});

// IntersectionObserver and MutationObserver for the strip's "one card on screen" rule (plan 11.6). show(node, ratio) says how much of a
// watched node is on screen, as a browser would report it; toggled(panel) is what a browser does when the panel's hidden attribute flips.
class FakeIntersections {
  constructor(callback, options) { Object.assign(this, {callback, options, watched: new Set()}); FakeIntersections.last = this; }
  observe(node) { this.watched.add(node); }
  unobserve(node) { this.watched.delete(node); }
  disconnect() { this.watched.clear(); }
  show(node, ratio) { assert.ok(this.watched.has(node), 'that node is watched'); this.callback([{target: node, isIntersecting: ratio > 0, intersectionRatio: ratio}]); }
}
class FakeMutations {
  constructor(callback) { Object.assign(this, {callback, target: null}); FakeMutations.all.push(this); }
  observe(node, options) { Object.assign(this, {target: node, options}); }
  disconnect() { this.target = null; }
  static toggled(node) { for (const m of FakeMutations.all) if (m.target === node) m.callback([{type: 'attributes', attributeName: 'hidden', target: node}]); }
}
FakeMutations.all = [];

// One page: the chat's strip and card, and optionally the Inbox, over a state the test can change as the server would. watch installs the
// observers above before the strip is made, with the Inbox panel already in the page (index.html has it from the start), closed.
// localStorage for Node, behind the calls the outbox makes (plan 11.17). broken: every call throws, as when storage is off.
function fakeStorage(broken = false) {
  const map = new Map(), off = () => { throw new Error('storage is off'); };
  return broken ? {map, getItem: off, setItem: off, removeItem: off} : {map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
}
async function mountPage(t, approvals, {inbox = null, fail = null, tasks = [], goals = [], watch = false, storage = fakeStorage()} = {}) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const doc = makeDocument(), saved = {document: globalThis.document, matchMedia: globalThis.matchMedia, IntersectionObserver: globalThis.IntersectionObserver, MutationObserver: globalThis.MutationObserver};
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.document = doc;
  globalThis.matchMedia = () => ({matches: false});
  Object.defineProperty(globalThis, 'localStorage', {value: storage, configurable: true, writable: true});
  if (watch) { FakeMutations.all = []; Object.assign(globalThis, {IntersectionObserver: FakeIntersections, MutationObserver: FakeMutations}); }
  const sounds = [], audio = installUiSounds({audio: {play: kind => { sounds.push(kind); return true; }}});
  t.after(() => {
    audio.dispose(); Object.assign(globalThis, saved);
    for (const k of ['document', 'IntersectionObserver', 'MutationObserver']) if (saved[k] === undefined) delete globalThis[k];
    if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage); else delete globalThis.localStorage;
  });
  // down: Clowder cannot be reached, so fetch throws its TypeError ("Failed to fetch"), as app.js api does with the host stopped.
  const page = {doc, sounds, posts: [], fail, down: false, storage, state: {readOnly: false, cats, approvals: approvals.map(a => ({...a})), tasks, goals}, ...mountChat(doc)};
  page.outbox = () => JSON.parse(storage.map.get(OUTBOX_KEY) ?? '{}');
  if (watch) {
    page.panel = h(doc, 'section', {id: 'quests-panel', hidden: ''});
    doc.body.append(page.panel);
  }
  const pending = () => page.state.approvals.filter(a => a.status === 'pending');
  page.decisions = createDecisionStrip({getState: () => page.state, name: id => cats.find(c => c.id === id)?.name ?? id, avatar: () => '', render: () => page.decisions.renderApprovalStrips(pending()),
    api: async (path, body) => { page.posts.push([path, body]); if (page.down) throw new TypeError('Failed to fetch'); if (page.fail) throw new Error(page.fail); return {ok: true}; },
    keep: async (path, body) => { page.posts.push([path, body, 'keepalive']); if (page.down) throw new TypeError('Failed to fetch'); return {ok: true}; }});
  page.render = () => page.decisions.renderApprovalStrips(pending());
  // The server settles a decision: it is no longer pending and carries the answer, as an SSE frame brings it.
  page.settle = (id, answer, approved) => { Object.assign(page.state.approvals.find(a => a.id === id), {status: approved ? 'approved' : 'rejected', answer}); page.render(); };
  page.render();
  if (inbox) {
    const panel = page.panel ?? h(doc, 'section', {id: 'quests-panel'}), body = h(doc, 'div', {id: 'quests-body'}), status = h(doc, 'p'), badge = h(doc, 'span');
    panel.append(body, status, badge);
    if (!page.panel) doc.body.append(panel);
    page.quests = inbox;
    page.inbox = createQuestsPanel({panel, body, status, badge, decisionCard: (id, o) => page.decisions.decisionCardFor(id, o), onAction: () => {},
      fetchImpl: async url => ({ok: true, json: async () => (url === '/api/artifacts' ? {artifacts: []} : page.quests)})});
    page.inboxBody = body;
    await page.inbox.refresh();
  }
  return page;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
// Taps: each is one pointer tap on a control that is on screen and enabled. The tap that opens a surface from the dock (app.js setPanel)
// is counted with open(); everything after it runs through the real decision code.
function taps(doc) {
  let n = 0;
  return {
    open() { n++; },
    tap(el) {
      assert.ok(el, 'the control is on screen');
      assert.ok(!el.disabled && !el.closest('[hidden]'), 'the control can be tapped');
      n++;
      el.focus();
      el.click();
    },
    get count() { return n; },
  };
}
const card = (root, id) => root.querySelectorAll('[data-decision]').find(c => c.dataset.decision === id);
const toast = doc => doc.body.querySelector('.decision-toast');
// Nodes are compared by identity and described in the message: assert's own message would walk the whole fake DOM through its getters.
const describe = el => (el?.tagName ? `${el.tagName.toLowerCase()}${el.className ? `.${el.className.split(/\s+/).join('.')}` : ''} "${el.textContent.slice(0, 40)}"` : String(el));
const same = (actual, expected, message = 'the same node') => assert.ok(actual === expected, `${message}: got ${describe(actual)}, wanted ${describe(expected)}`);

test('inline answers only where the server’s quick list allows: never Always allow, and public, money, delete and Hermes calls open the card', () => {
  assert.deepEqual(quickOf(quickDecision).map(q => q.answer), ['Allow once', 'Deny']);
  assert.deepEqual(quickOf(cardDecision), [], 'a public write opens the card');
  assert.deepEqual(quickOf(hermesDecision), [], 'a Hermes call opens the card');
  assert.deepEqual(quickOf({options: ['Yes', 'No']}), [], 'no quick list (an older server) opens the card');
  const quick = decisionCardHtml(quickDecision, {name: id => id});
  assert.equal((quick.match(/data-answer=/g) ?? []).length, 2);
  assert.ok(!/Always allow/.test(quick), 'Always allow stays on the card');
  assert.ok(!/class="decision-open/.test(quick), 'a quick decision needs no Answer button');
  const full = decisionCardHtml(cardDecision, {name: id => id});
  assert.ok(!/data-answer=/.test(full), 'no inline answers');
  assert.match(full, /<button type="button" class="decision-open is-primary" data-open aria-haspopup="dialog" aria-describedby="card-decision-a2">Answer<\/button>/);
});

test('a Hermes decision and a connector decision render the same card (Gate 8)', () => {
  const shape = a => decisionCardHtml(a, {name: () => 'Cat'}).replaceAll(a.id, 'ID').replace(String(a.question), 'Q');
  assert.equal(shape(hermesDecision), shape(cardDecision));
});

test('one function draws every surface: the escaped string and the page’s nodes come from the same card, and cat text never becomes markup', () => {
  const doc = makeDocument(), saved = globalThis.document;
  globalThis.document = doc;
  try {
    const evil = {...quickDecision, question: '<img src=x onerror=alert(1)> wants "this" & that'};
    const html = decisionCardHtml(evil, {name: () => 'Scholar'});
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; wants &quot;this&quot; &amp; that') && !html.includes('<img'));
    const nodes = decisionCard(evil, {name: () => 'Scholar'}, {h: (tag, attrs, ...kids) => h(doc, tag, Object.fromEntries(Object.entries(attrs ?? {}).filter(([, v]) => v !== null && v !== false).map(([k, v]) => [k, v === true ? '' : v])), ...kids.flat(Infinity).filter(k => k !== null && k !== false && k !== '')), icon: () => h(doc, 'svg')});
    assert.equal(nodes.querySelector('.decision-q').textContent, evil.question, 'the question is text');
    assert.deepEqual(nodes.querySelectorAll('[data-answer]').map(b => b.textContent), ['Allow once', 'Deny']);
    assert.equal(typeof HTML.h, 'function');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
});

test('an answered card folds to one line that says who asked and what you said; a yes-or-no pair marks its yes, a choice marks none', () => {
  const folded = decisionCardHtml({...quickDecision, status: 'approved', answer: 'Allow once'}, {name: () => 'Scholar'});
  assert.match(folded, /class="decision-card is-folded"/);
  assert.match(folded, /<p class="decision-folded" tabindex="-1" title="You said yes to Scholar: Allow once">/);
  assert.ok(!/<button/.test(folded), 'nothing left to press');
  for (const no of ['Rejected', 'Reject', 'Deny', 'Decline', 'declined', 'No.']) assert.equal(answeredLine(no, false, 'Scribe'), 'You said no to Scribe', no);
  for (const yes of ['Approve', 'Approved', 'Allow', 'Yes', 'OK']) assert.equal(answeredLine(yes, true, 'Mayor'), 'You said yes to Mayor', yes);
  assert.equal(answeredLine('Rejected for now', false, 'Scribe'), 'You said no to Scribe: Rejected for now', 'only a bare no is folded away');
  assert.equal(answeredLine('Paw & Co', true, 'Mayor'), 'You said yes to Mayor: Paw & Co');
  assert.match(decisionCardHtml(quickDecision, {hold: {answer: 'Deny', approved: false, phase: 'held'}, name: () => 'Scholar'}), /You said no to Scholar/);
  assert.equal((decisionCardHtml(quickDecision).match(/is-primary/g) ?? []).length, 1, 'Allow once is the main answer');
  assert.equal((decisionCardHtml(plainQuestion).match(/is-primary/g) ?? []).length, 0, 'no option of a plain choice is pushed');
  assert.equal((decisionCardHtml(plainQuestion).match(/data-answer=/g) ?? []).length, 3);
  assert.ok(!/data-answer=|decision-open/.test(decisionCardHtml(quickDecision, {readOnly: true})), 'a viewer reads, and cannot answer');
});

test('chat: a quick decision is answered in 2 taps, held 4 s behind Undo, then posted once and the success cue plays', async t => {
  const page = await mountPage(t, [quickDecision]);
  const tally = taps(page.doc);
  tally.open(); // the dock's Chat: the strip sits above the composer in the chat sheet
  tally.tap(card(page.strip, 'a1').querySelector('[data-answer="0"]'));
  assert.ok(card(page.strip, 'a1').matches('.is-folded'), 'the card folds at once');
  assert.equal(card(page.strip, 'a1').textContent, 'You said yes to Scholar: Allow once');
  assert.equal(toast(page.doc).hidden, false, 'the Undo toast shows');
  same(page.doc.activeElement, toast(page.doc).querySelector('.decision-toast-undo'), 'Undo has focus, so the keyboard can reach it');
  t.mock.timers.tick(HOLD_MS - 1);
  await flush();
  assert.deepEqual(page.posts, [], 'nothing is sent while Undo is offered');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a1', {answer: 'Allow once', approved: true}]]);
  assert.deepEqual(page.sounds, ['success']);
  assert.equal(toast(page.doc).hidden, true);
  same(page.doc.activeElement, card(page.strip, 'a1').querySelector('.decision-folded'), 'focus waits on the folded card');
  page.settle('a1', 'Allow once', true);
  assert.ok(card(page.strip, 'a1') === undefined, 'answered, it leaves the strip; the thread shows what follows');
  assert.ok(tally.count <= 2, `${tally.count} taps`);
  assert.equal(tally.count, 2);
});

test('chat: a card decision is answered in 3 taps, with the card opening on its first option and not on Close', async t => {
  const page = await mountPage(t, [cardDecision]);
  const tally = taps(page.doc);
  tally.open(); // the dock's Chat
  const strip = card(page.strip, 'a2');
  assert.equal(strip.querySelectorAll('[data-answer]').length, 0, 'no inline answers for a public write');
  tally.tap(strip.querySelector('.decision-open'));
  assert.equal(page.dialog.open, true);
  assert.equal(page.doc.getElementById('approval-title').textContent, 'Scribe asks you to decide');
  const first = page.doc.getElementById('approval-options').querySelector('button');
  same(page.doc.activeElement, first, 'focus lands on the first option');
  assert.equal(first.textContent, 'Allow once');
  tally.tap(first);
  assert.equal(page.dialog.open, false);
  assert.ok(card(page.strip, 'a2').matches('.is-folded'));
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a2', {answer: 'Allow once', approved: true}]]);
  assert.ok(tally.count <= 3, `${tally.count} taps`);
  assert.equal(tally.count, 3);
});

test('Undo inside 4 s sends nothing and opens the card again where it was, focus on its first answer', async t => {
  const page = await mountPage(t, [quickDecision]);
  card(page.strip, 'a1').querySelector('[data-answer="1"]').click();
  assert.match(toast(page.doc).textContent, /You said no to Scholar/);
  t.mock.timers.tick(HOLD_MS - 500);
  toast(page.doc).querySelector('.decision-toast-undo').click();
  assert.equal(toast(page.doc).hidden, true);
  assert.ok(!card(page.strip, 'a1').matches('.is-folded'), 'the card is back');
  same(page.doc.activeElement, card(page.strip, 'a1').querySelector('[data-answer="0"]'));
  t.mock.timers.tick(HOLD_MS * 2);
  await flush();
  assert.deepEqual(page.posts, [], 'an undone answer never reaches the server');
  assert.deepEqual(page.sounds, []);
});

test('Undo of an answer from the card opens the card again, with your own words still in it', async t => {
  const page = await mountPage(t, [cardDecision]);
  card(page.strip, 'a2').querySelector('.decision-open').click();
  const box = page.doc.getElementById('approval-custom');
  box.value = 'Only the docs folder, please';
  box.oninput();
  page.doc.getElementById('approval-send').click();
  assert.equal(page.dialog.open, false);
  toast(page.doc).querySelector('.decision-toast-undo').click();
  assert.equal(page.dialog.open, true);
  assert.equal(box.value, 'Only the docs folder, please');
  same(page.doc.activeElement, box);
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, []);
});

test('a refused answer plays the error cue and opens the card again with the reason', async t => {
  const page = await mountPage(t, [quickDecision], {fail: 'That decision is no longer open.'});
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.equal(page.posts.length, 1);
  assert.deepEqual(page.sounds, ['error']);
  const again = card(page.strip, 'a1');
  assert.ok(!again.matches('.is-folded'));
  assert.equal(again.querySelector('.decision-error').textContent, 'Your answer did not go through. That decision is no longer open.');
  same(page.doc.activeElement, again.querySelector('[data-answer="0"]'), 'focus moves from the folded line to the first answer');
});

test('Escape from the card returns focus to what opened it; Escape from the toast keeps the answer and leaves the open sheet alone', async t => {
  const page = await mountPage(t, [cardDecision, quickDecision]);
  const answer = card(page.strip, 'a2').querySelector('.decision-open');
  answer.focus();
  answer.click();
  page.dialog.close();
  await flush();
  same(page.doc.activeElement, answer);
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  let reachedDocument = false;
  page.doc.addEventListener('keydown', () => { reachedDocument = true; });
  page.doc.activeElement.dispatchEvent(makeEvent('keydown', true, {key: 'Escape'}));
  assert.equal(reachedDocument, false, 'app.js would close the chat sheet on this Escape');
  same(page.doc.activeElement, card(page.strip, 'a1').querySelector('.decision-folded'));
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a1', {answer: 'Allow once', approved: true}]]);
});

test('an answer held here is dropped when the decision is settled elsewhere, and a hidden page sends what it holds at once', async t => {
  const page = await mountPage(t, [quickDecision, plainQuestion]);
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  page.settle('a1', 'Deny', false); // answered on Telegram during the 4 s
  assert.equal(toast(page.doc).hidden, true);
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, [], 'nothing is sent for a decision that is already answered');
  card(page.strip, 'a4').querySelector('[data-answer="1"]').click();
  page.doc.visibilityState = 'hidden';
  for (const fn of page.doc.listeners.visibilitychange) fn();
  await flush();
  assert.deepEqual(page.posts, [['approvals/a4', {answer: 'Paw & Co', approved: true}, 'keepalive']], 'the Undo can no longer be seen, so the answer goes now, and survives the page closing');
});

// The Inbox lists decisions as GET /api/quests does (src/quests.ts): kind approval, the question's first sentence as the title.
const decisionQuest = (a, detail) => ({id: `approval:${a.id}`, rank: 'S', title: a.question, detail, at: new Date(Date.now() - 120000).toISOString(), source: {kind: 'approval', id: a.id}, action: {label: 'Answer', panel: 'chat', cat: a.cat}, needsYou: true});
const stepQuest = {id: 'owner-step:s1', rank: 'A', title: 'Owner step: Connect GitHub', detail: 'Sign in so the Scribe can push files.', at: '2026-11-06T18:00:00.000Z', source: {kind: 'owner-step', id: 's1'}, stepKind: 'account', action: {label: 'Mark done', panel: 'projects'}, needsYou: true};
const goalQuest = {id: 'goal:g1', rank: 'A', title: 'Waiting on you: Launch the shop', detail: 'Mark the owner steps done and the goal resumes.', at: '2026-11-06T17:00:00.000Z', source: {kind: 'goal', id: 'g1'}, action: {label: 'Open goal', panel: 'projects'}, needsYou: true};

test('Inbox: a quick decision is answered in 2 taps on the same card the chat shows, and stays in place folded once answered', async t => {
  const quests = [decisionQuest(quickDecision, 'Scholar is blocked until you answer.'), decisionQuest(cardDecision, 'Scribe is blocked until you answer.'), stepQuest];
  const page = await mountPage(t, [quickDecision, cardDecision], {inbox: quests});
  const tally = taps(page.doc);
  tally.open(); // the dock's Needs you (the Inbox)
  const inboxCard = card(page.inboxBody, 'a1');
  assert.ok(inboxCard.closest('li.decision-item'), 'a decision is the shared card, inside the list');
  assert.equal(inboxCard.querySelector('.decision-note').textContent, 'Scholar is blocked until you answer. · 2 min ago');
  tally.tap(inboxCard.querySelector('[data-answer="0"]'));
  assert.ok(card(page.inboxBody, 'a1').matches('.is-folded'), 'the Inbox card folds in place');
  assert.ok(card(page.strip, 'a1').matches('.is-folded'), 'and so does the chat’s');
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a1', {answer: 'Allow once', approved: true}]]);
  assert.deepEqual(page.sounds, ['success']);
  // The server settles it and the next list no longer has it: the Inbox keeps the folded line where it was, so no tap is needed to see it.
  page.settle('a1', 'Allow once', true);
  page.quests = quests.slice(1);
  await page.inbox.refresh();
  const rows = page.inboxBody.querySelectorAll('li.decision-item');
  assert.deepEqual(rows.map(li => li.dataset.id), ['approval:a1', 'approval:a2'], 'the answered decision keeps its place');
  assert.equal(rows[0].textContent, 'You said yes to Scholar: Allow once');
  assert.ok(tally.count <= 2, `${tally.count} taps`);
  assert.equal(tally.count, 2);
});

test('Inbox: a card decision is answered in 3 taps through the full card, focus on its first option', async t => {
  const page = await mountPage(t, [cardDecision], {inbox: [decisionQuest(cardDecision, 'Scribe is blocked until you answer.')]});
  const tally = taps(page.doc);
  tally.open(); // the dock's Needs you
  const inboxCard = card(page.inboxBody, 'a2');
  assert.equal(inboxCard.querySelectorAll('[data-answer]').length, 0);
  tally.tap(inboxCard.querySelector('.decision-open'));
  const first = page.doc.getElementById('approval-options').querySelector('button');
  same(page.doc.activeElement, first);
  tally.tap(first);
  assert.ok(card(page.inboxBody, 'a2').matches('.is-folded'), 'the Inbox card it came from folds');
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a2', {answer: 'Allow once', approved: true}]]);
  assert.ok(tally.count <= 3, `${tally.count} taps`);
  assert.equal(tally.count, 3);
  page.dialog.close();
});

test('Inbox: Escape from a card opened there returns to the Inbox card, even when the list was redrawn while the card was open', async t => {
  const quests = [decisionQuest(cardDecision, 'Scribe is blocked until you answer.')];
  const page = await mountPage(t, [cardDecision], {inbox: quests});
  card(page.inboxBody, 'a2').querySelector('.decision-open').click();
  assert.equal(page.dialog.open, true);
  page.quests = [...quests, stepQuest]; // a new to-do arrives, so the list is drawn again under the open card
  await page.inbox.refresh();
  page.dialog.close();
  await flush();
  same(page.doc.activeElement, card(page.inboxBody, 'a2').querySelector('.decision-open'), 'focus is back on the redrawn Inbox card, not the strip');
});

test('Inbox: glossary words are marked where they appear and explained in words once per list, on the first card of each kind', async t => {
  const page = await mountPage(t, [quickDecision, cardDecision], {inbox: [decisionQuest(quickDecision, 'Scholar is blocked until you answer.'), decisionQuest(cardDecision, 'Scribe is blocked until you answer.'), stepQuest, goalQuest]});
  const body = page.inboxBody;
  const terms = body.querySelectorAll('.glossary-term');
  assert.deepEqual(terms.map(term => term.textContent), ['Decision', 'Decision', 'To-do', 'Goal']);
  for (const term of terms) assert.equal(term.getAttribute('title'), `${term.textContent}: ${GLOSSARY[term.textContent]}`);
  assert.deepEqual(body.querySelectorAll('.glossary-note').map(note => note.textContent), [GLOSSARY.Decision, GLOSSARY['To-do'], GLOSSARY.Goal]);
  assert.ok(card(body, 'a1').querySelector('.glossary-note') && !card(body, 'a2').querySelector('.glossary-note'), 'only the first decision says what a Decision is');
  assert.equal(body.querySelectorAll('li.quest')[0].querySelector('.quest-kind').textContent, 'To-do · Account', 'the kind line reads as before');
});

test('the Undo toast and the card use only V0 tokens, honour reduced motion and give coarse pointers 44px targets', () => {
  const css = readFileSync(new URL('../public/decision-strip.css', import.meta.url), 'utf8');
  assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? [], [], 'no colour literals');
  assert.ok(!/:root/.test(css) && !/@font-face/.test(css), 'no new tokens or fonts');
  assert.ok(!/#a77b35|#8c806a/i.test(css + readFileSync(new URL('../public/decision-strip.js', import.meta.url), 'utf8')));
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)\{\.decision-toast:not\(\[hidden\]\)\{animation:/);
  assert.match(css, /\.decision-actions button\{min-width:var\(--tap\);min-height:var\(--tap\)/);
  assert.match(css, /\.decision-toast-undo\{[^}]*min-width:var\(--tap\);min-height:var\(--tap\)/);
  assert.match(css, /\.decision-card\{[^}]*background:var\(--needs\)[^}]*box-shadow:var\(--e2\)/, 'design rule 5: a --needs card with --e2');
  assert.ok(!/border-left/.test(css), 'and no left accent border');
  assert.match(css, /\.decision-folded\{[^}]*color:var\(--ink-3\)/, 'answered cards fold to one line in --ink-3');
});

// Plan 11.6: one decision, one card on screen, and the card names its request. (a) Every card says "For: <request or goal title>" as a
// #thread= link (F2: three Inbox cards showed the same question, told apart only by their age). (b) The strip above the composer hides a
// decision while that decision's own card shows its answers on screen, and hides whole while the Inbox is open (F9: one decision twice at
// 375; N2: 3 "Approve draft" for one decision at 1280x800). (c) The Inbox keeps a 200px cap floor and the conversation shrinks first.
const sameQuestion = 'May the town continue by drafting a sample offer? This approval permits only a draft inside this chat.';
const asked = (id, task, cat = 'mayor') => withQuick({id, task, cat, question: sameQuestion, options: ['Approve draft', 'Reject']});
const threeTasks = [
  {id: 'r1', cat: 'mayor', from: 'owner', text: 'Draft three names for a cat cafe. Keep them short.', status: 'waiting_child'},
  {id: 'k1', cat: 'scholar', from: 'mayor', parent: 'r1', text: 'Propose three names.', status: 'waiting'},
  {id: 'r2', cat: 'mayor', from: 'owner', text: 'Plan a weekend bake sale for the shelter', status: 'waiting'},
  {id: 'g1r', cat: 'mayor', from: 'town', text: 'Goal round 2: Launch the spring fair', goal: 'g1', status: 'waiting'},
];
const threeGoals = [{id: 'g1', title: 'Launch the spring fair', status: 'active'}];
const threeAsks = [asked('d1', 'k1', 'scholar'), asked('d2', 'r2'), asked('d3', 'g1r')];
// The answer buttons for one decision a person could see: in no hidden box.
const shownAnswers = (doc, id) => doc.body.querySelectorAll('[data-answer]').filter(b => b.closest('[data-decision]')?.dataset.decision === id && !b.closest('[hidden]'));

test('the request a decision serves is the root of its task’s chain, titled as Projects titles it, or by its goal; a cap names none', () => {
  const state = {tasks: threeTasks, goals: threeGoals};
  assert.deepEqual(requestOf({task: 'k1'}, state), {id: 'r1', title: 'Draft three names for a cat cafe'}, 'a delegated ask names the owner’s request');
  assert.deepEqual(requestOf({task: 'r2'}, state), {id: 'r2', title: 'Plan a weekend bake sale for the shelter'});
  assert.deepEqual(requestOf({task: 'g1r'}, state), {id: 'g1r', title: 'Launch the spring fair'}, 'a goal round is named by its goal');
  assert.equal(requestOf({task: ''}, state), null, 'a usage cap or budget decision belongs to no request');
  assert.equal(requestOf({task: 'gone'}, state), null, 'a task the page does not hold');
  assert.equal(requestOf({task: 'k1'}), null, 'no state');
  assert.deepEqual(requestOf({task: 'x'}, {tasks: [{id: 'x', parent: 'y', text: 'X'}, {id: 'y', parent: 'x', text: 'Y'}]}), {id: 'x', title: 'X'}, 'a malformed cycle ends where it closes');
  assert.deepEqual(requestOf({task: 'k1'}, {tasks: threeTasks.filter(t => t.id !== 'r1')}), {id: 'k1', title: 'Propose three names'}, 'a parent the page lacks: the top it has');
  // The same words Projects shows for the request (src/projects.ts: oneLiner(root.text, 60), from one-liner.js).
  for (const text of ['Write **a** long brief for the shop window that names every cat in the town and their favourite snacks', 'Line one\nline two',
    'Draft three names for a cat cafe. Keep them short.', 'push_files to _the_ repo! Then wait', '', '...', 'Ünïcode café ☕ request', 'x'.repeat(80)])
    assert.equal(requestTitle(text), oneLiner(text, 60), JSON.stringify(text));
  assert.equal(requestTitle('Write **a** long brief for the shop window that names every cat in the town and their favourite snacks'), 'Write a long brief for the shop window that names every…');
});

test('every decision card says “For: <request>” as a link to its thread; the strip says it on the cat’s line, and an answered card does not', () => {
  const request = {id: 'r1', title: 'Draft three names for a cat cafe'};
  const full = decisionCardHtml(asked('d1', 'k1', 'scholar'), {name: () => 'Scholar', request});
  assert.match(full, /<a class="decision-for" href="#thread=r1" title="Open the request: Draft three names for a cat cafe"><span class="decision-for-label">For:<\/span> <span class="decision-for-title">Draft three names for a cat cafe<\/span><\/a><button type="button" class="decision-question"/, 'the link sits right before the question');
  const strip = decisionCardHtml(asked('d1', 'k1', 'scholar'), {name: () => 'Scholar', request, compact: true});
  assert.ok(!/<a /.test(strip), 'no link inside the strip’s one row: its question button opens the full card');
  assert.match(strip, /<button [^>]*class="decision-question"[^>]*><span class="decision-head"><strong>Scholar<\/strong> · <span class="decision-for-inline">For: Draft three names for a cat cafe<\/span> <\/span><span class="decision-q">/);
  assert.ok(!/decision-for/.test(decisionCardHtml(asked('d1', 'k1'), {name: () => 'Mayor'})), 'no request, no line');
  assert.ok(!/decision-for/.test(decisionCardHtml({...asked('d1', 'k1'), status: 'approved', answer: 'Approve draft'}, {request})), 'a folded card stays one line');
  const evil = decisionCardHtml(asked('d1', 'k1'), {request: {id: 'r 1', title: '<img src=x onerror=alert(1)> & "more"'}});
  assert.ok(evil.includes('href="#thread=r%201"') && evil.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;more&quot;') && !evil.includes('<img'), 'request words are text');
});

test('three requests asking the same question: the Inbox shows three cards naming three different requests, and so does the strip (F2)', async t => {
  const quests = threeAsks.map(a => decisionQuest(a, 'Blocked until you answer.'));
  const page = await mountPage(t, threeAsks, {inbox: quests, tasks: threeTasks, goals: threeGoals});
  const inboxFor = page.inboxBody.querySelectorAll('.decision-for');
  assert.deepEqual(inboxFor.map(a => a.textContent), ['For: Draft three names for a cat cafe', 'For: Plan a weekend bake sale for the shelter', 'For: Launch the spring fair']);
  assert.deepEqual(inboxFor.map(a => a.getAttribute('href')), ['#thread=r1', '#thread=r2', '#thread=g1r']);
  assert.equal(new Set(page.inboxBody.querySelectorAll('.decision-q').map(q => q.textContent)).size, 1, 'the questions alone cannot tell them apart');
  assert.deepEqual(page.strip.querySelectorAll('.decision-for-inline').map(s => s.textContent), ['For: Draft three names for a cat cafe', 'For: Plan a weekend bake sale for the shelter', 'For: Launch the spring fair']);
});

test('a request that reaches the page after its decision is named as soon as it does', async t => {
  const page = await mountPage(t, [asked('d2', 'r2')], {inbox: [decisionQuest(asked('d2', 'r2'), 'Blocked.')]});
  assert.equal(page.inboxBody.querySelector('.decision-for'), null);
  page.state.tasks = threeTasks;
  page.render();
  assert.equal(page.inboxBody.querySelector('.decision-for').textContent, 'For: Plan a weekend bake sale for the shelter');
  assert.equal(page.strip.querySelector('.decision-for-inline').textContent, 'For: Plan a weekend bake sale for the shelter');
});

test('one card on screen at 375: the strip hides a decision while its thread card’s answers are on screen, and shows it again when they leave (F9)', async t => {
  const page = await mountPage(t, [asked('d2', 'r2'), plainQuestion], {tasks: threeTasks, watch: true});
  const slot = page.decisions.decisionCardFor('d2', {surface: 'thread'});
  page.doc.getElementById('chat').append(slot);
  const io = FakeIntersections.last, answers = slot.querySelector('.decision-actions');
  assert.ok(io.watched.has(answers), 'the thread card is watched where it is answered');
  assert.equal(shownAnswers(page.doc, 'd2').length, 4, 'before: Approve draft and Reject twice, in the thread and in the strip (baseline 2 cards)');
  io.show(answers, 1);
  assert.equal(card(page.strip, 'd2').hidden, true, 'the strip card hides');
  assert.equal(card(page.strip, 'a4').hidden, false, 'a decision with no card on screen stays in the strip');
  assert.equal(page.strip.hidden, false);
  assert.deepEqual(shownAnswers(page.doc, 'd2').map(b => b.textContent), ['Approve draft', 'Reject'], 'one card for the decision');
  io.show(answers, 0.5);
  assert.equal(card(page.strip, 'd2').hidden, false, 'half-hidden answers do not count: the strip offers them again');
  io.show(answers, 0.8);
  assert.equal(card(page.strip, 'd2').hidden, true);
  // Answered on the thread card: both fold, the folded line is watched now, and the strip's folded copy stays hidden while it shows.
  slot.querySelector('[data-answer="0"]').click();
  assert.ok(card(slot, 'd2').matches('.is-folded') && card(page.strip, 'd2').matches('.is-folded'));
  const line = slot.querySelector('.decision-folded');
  assert.ok(io.watched.has(line) && !io.watched.has(answers), 'a redrawn card is watched again');
  io.show(line, 1);
  assert.equal(card(page.strip, 'd2').hidden, true);
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.deepEqual(page.posts, [['approvals/d2', {answer: 'Approve draft', approved: true}]], 'posted once');
  same(page.doc.activeElement, slot.querySelector('.decision-folded'), 'focus goes to the visible folded card, never into a hidden strip card');
});

test('a strip card that holds focus is not hidden under the keyboard; it hides once focus leaves', async t => {
  const page = await mountPage(t, [asked('d2', 'r2')], {tasks: threeTasks, watch: true});
  const slot = page.decisions.decisionCardFor('d2', {surface: 'thread'});
  page.doc.getElementById('chat').append(slot);
  const mine = card(page.strip, 'd2').querySelector('[data-answer="1"]');
  mine.focus();
  FakeIntersections.last.show(slot.querySelector('.decision-actions'), 1);
  assert.equal(card(page.strip, 'd2').hidden, false);
  same(page.doc.activeElement, mine);
  page.doc.getElementById('message').focus();
  page.strip.dispatchEvent(makeEvent('focusout'));
  await flush();
  assert.equal(card(page.strip, 'd2').hidden, true);
});

test('the strip hides while the Inbox is open: one decision shows its answers twice at 1280, Inbox and thread, not three times (N2)', async t => {
  const a = asked('d2', 'r2');
  const page = await mountPage(t, [a], {inbox: [decisionQuest(a, 'Mayor is blocked until you answer.')], tasks: threeTasks, watch: true});
  const slot = page.decisions.decisionCardFor('d2', {surface: 'thread'});
  page.doc.getElementById('chat').append(slot);
  assert.equal(page.strip.hidden, false, 'the Inbox starts closed');
  assert.equal(shownAnswers(page.doc, 'd2').length, 4, 'thread and strip (the Inbox is closed)');
  // app.js setPanel: the panel shows, then the Inbox refreshes (it draws only while open).
  page.panel.hidden = false;
  FakeMutations.toggled(page.panel);
  await page.inbox.refresh();
  assert.equal(page.strip.hidden, true);
  const shown = shownAnswers(page.doc, 'd2');
  assert.equal(shown.length, 4, '2 cards: the Inbox’s and the thread’s (baseline 3 cards)');
  assert.deepEqual([...new Set(shown.map(b => (b.closest('#quests-panel') ? 'inbox' : b.closest('#chat') ? 'thread' : 'strip')))].sort(), ['inbox', 'thread']);
  // An Inbox answer folds every copy and returns focus to the Inbox card, never into the hidden strip.
  card(page.inboxBody, 'd2').querySelector('[data-answer="0"]').click();
  t.mock.timers.tick(HOLD_MS);
  await flush();
  same(page.doc.activeElement, card(page.inboxBody, 'd2').querySelector('.decision-folded'));
  page.panel.hidden = true;
  FakeMutations.toggled(page.panel);
  assert.equal(page.strip.hidden, false, 'closed again, the strip is back');
});

test('the full card names the request before its question, and following the link closes the card so the thread is not under it', async t => {
  const cap = {...withQuick({id: 'c1', task: '', cat: 'mayor', question: 'The town has used its tokens this month. Raise the cap?', options: ['Raise the cap', 'Wait']}), gate: 'cap'};
  const page = await mountPage(t, [asked('d1', 'k1', 'scholar'), cap], {tasks: threeTasks});
  card(page.strip, 'd1').querySelector('.decision-question').click();
  assert.equal(page.dialog.open, true);
  const link = page.doc.getElementById('approval-for');
  assert.equal(link.textContent, 'For: Draft three names for a cat cafe');
  assert.equal(link.getAttribute('href'), '#thread=r1');
  const kids = page.dialog.childNodes;
  assert.equal(kids[kids.indexOf(link) + 1], page.doc.getElementById('approval-question'), 'right before the question');
  link.click();
  assert.equal(page.dialog.open, false);
  await flush();
  card(page.strip, 'c1').querySelector('.decision-question').click();
  assert.equal(page.doc.getElementById('approval-for'), null, 'a cap decision serves no request, so no line');
  card(page.strip, 'd1').querySelector('.decision-question').click();
  assert.equal(page.dialog.querySelectorAll('#approval-for').length, 1, 'one line, not one per opening');
});

test('the Inbox keeps a 200px floor from 900px and the conversation shrinks first; the card’s new parts are 44px targets in V0 tokens', () => {
  const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pane = read('immersive.css').split('@media(min-width:900px){').slice(1).join('');
  assert.match(pane, /\.immersive \.inspector>\.quests\{[^}]*max-height:max\(200px,min\(40%,320px\)\)/, 'the Inbox cap never goes under 200px (was min(40%,320px))');
  assert.match(pane, /\.immersive \.inspector>\.quests:not\(\[hidden\]\)~:is\(\.tab-pane,#chat\)\{min-height:0\}/, 'while it is open the conversation gives up its floor first');
  assert.match(read('immersive.css'), /\.immersive \.inspector #approvals\[hidden\]\{display:none\}/);
  const css = read('decision-strip.css');
  assert.match(css, /\.decision-for\{[^}]*min-height:var\(--tap\)/, 'the link is a 44px target');
  assert.match(css, /\.decision-for-title\{[^}]*text-overflow:ellipsis/, 'one line, cut with an ellipsis');
  assert.match(css, /\.is-compact \.decision-head\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/, 'the strip’s cat line stays one line');
  assert.match(css, /\.decision-card\[hidden\]\{display:none\}/, 'a hidden strip card is gone, though .is-compact sets display');
});

// Plan 11.17 (F7): with the server stopped, Approve showed "Your answer did not go through. Failed to fetch" and the answer was dropped.
// Now an answer that cannot reach Clowder waits in an outbox (localStorage), shown with the Undo hold as "Sends when Clowder answers",
// and is sent when Clowder answers again. A decided approval refuses a second POST (engine.ts decide); a try again that meets that
// refusal counts as sent, so no answer is applied twice, and no outbox entry outlives its decision.
const waiting = (doc, id) => card(doc.getElementById('approvals'), id);
// The connection line app.js paints in the header (paintConnection): down while Clowder is not answering.
const connection = (page, state) => {
  let el = page.doc.getElementById('connection');
  if (!el) { el = h(page.doc, 'span', {id: 'connection'}); page.doc.body.append(el); }
  el.dataset.state = state;
};

test('an answer made while Clowder is not answering waits in the outbox with its Undo, and is sent once when Clowder answers (F7)', async t => {
  const page = await mountPage(t, [quickDecision]);
  connection(page, 'down');
  page.down = true;
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  t.mock.timers.tick(HOLD_MS);
  assert.deepEqual(page.outbox(), {a1: {answer: 'Allow once', approved: true}}, 'written to the outbox before the POST, so a page closed now keeps it');
  await flush();
  assert.equal(page.posts.length, 1, 'the one try at the end of the hold');
  const folded = waiting(page.doc, 'a1');
  assert.equal(folded.dataset.state, 'queued');
  assert.equal(folded.textContent, `${QUEUED} · You said yes to Scholar: Allow once`);
  assert.equal(folded.querySelector('.decision-error'), null, 'no "Your answer did not go through. Failed to fetch"');
  assert.deepEqual(page.sounds, [], 'nothing went wrong, so no error cue');
  assert.equal(toast(page.doc).hidden, false, 'the Undo hold stays');
  assert.equal(toast(page.doc).querySelector('p').textContent, `${QUEUED} · You said yes to Scholar: Allow once`);
  same(page.doc.activeElement, toast(page.doc).querySelector('.decision-toast-undo'), 'focus was on Undo, so it is again');
  // The hold ends as every hold does: the toast leaves, so it never sits over the composer while the host sleeps, and the card says it.
  t.mock.timers.tick(HOLD_MS);
  assert.equal(toast(page.doc).hidden, true);
  assert.equal(waiting(page.doc, 'a1').dataset.state, 'queued');
  same(page.doc.activeElement, waiting(page.doc, 'a1').querySelector('.decision-folded'), 'focus goes back to the folded card');
  toast(page.doc).querySelector('.decision-toast-undo').click();
  assert.deepEqual(page.outbox(), {a1: {answer: 'Allow once', approved: true}}, 'its Undo went with it');
  // While the page says Clowder is down, nothing is tried.
  t.mock.timers.tick(RETRY_MS * 5);
  await flush();
  assert.equal(page.posts.length, 1, 'no tries while the page says Clowder is down');
  // Clowder answers again: within one RETRY_MS the answer goes, once.
  page.down = false;
  connection(page, 'up');
  t.mock.timers.tick(RETRY_MS);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a1', {answer: 'Allow once', approved: true}], ['approvals/a1', {answer: 'Allow once', approved: true}]], 'the failed try, then the one that got there');
  assert.deepEqual(page.sounds, ['success']);
  assert.equal(toast(page.doc).hidden, true);
  assert.deepEqual(page.outbox(), {}, 'sent, it leaves the outbox');
  assert.equal(page.storage.map.has(OUTBOX_KEY), false, 'an empty outbox leaves no key behind');
  t.mock.timers.tick(RETRY_MS * 5);
  await flush();
  assert.equal(page.posts.length, 2, 'never sent again');
  page.settle('a1', 'Allow once', true);
  assert.equal(waiting(page.doc, 'a1'), undefined);
});

test('a try again that hears the decision was already answered counts as sent: no error, and never tried again', async t => {
  // The refusal is engine.ts decide's own words; if they change, ANSWERED in decision-strip.js must follow.
  const refusal = 'This request has already been answered or cancelled.';
  assert.ok(readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf8').includes(`throw new Error('${refusal}')`), 'decide still refuses a decided approval in these words');
  const page = await mountPage(t, [quickDecision]);
  page.down = true;
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  t.mock.timers.tick(HOLD_MS);
  await flush();
  assert.equal(waiting(page.doc, 'a1').dataset.state, 'queued');
  // The first try reached Clowder after all and only its reply was lost; the next try is refused as already answered.
  page.down = false;
  page.fail = refusal;
  t.mock.timers.tick(RETRY_MS);
  await flush();
  assert.equal(page.posts.length, 2);
  assert.deepEqual(page.sounds, ['success'], 'settled, not an error');
  assert.equal(waiting(page.doc, 'a1').dataset.state, 'sent');
  assert.equal(waiting(page.doc, 'a1').querySelector('.decision-error'), null);
  assert.deepEqual(page.outbox(), {});
  t.mock.timers.tick(RETRY_MS * 10);
  await flush();
  assert.equal(page.posts.length, 2, 'a refusal is never retried');
});

test('Undo while an answer waits sends nothing more and empties the outbox; another refusal opens the card with its reason', async t => {
  const page = await mountPage(t, [quickDecision, plainQuestion]);
  page.down = true;
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  t.mock.timers.tick(HOLD_MS);
  await flush();
  toast(page.doc).querySelector('.decision-toast-undo').click();
  assert.equal(toast(page.doc).hidden, true);
  assert.ok(!waiting(page.doc, 'a1').matches('.is-folded'), 'the card is back');
  assert.deepEqual(page.outbox(), {});
  page.down = false;
  t.mock.timers.tick(RETRY_MS * 5);
  await flush();
  assert.equal(page.posts.length, 1, 'only the try that never got there');
  // A waiting answer refused for another reason (the town is paused) is not settled: it opens again, as a refused answer always has.
  page.down = true;
  card(page.strip, 'a4').querySelector('[data-answer="1"]').click();
  t.mock.timers.tick(HOLD_MS);
  await flush();
  page.down = false;
  page.fail = 'Resume the town before answering.';
  t.mock.timers.tick(RETRY_MS);
  await flush();
  assert.equal(waiting(page.doc, 'a4').querySelector('.decision-error').textContent, 'Your answer did not go through. Resume the town before answering.');
  assert.deepEqual(page.sounds, ['error']);
  assert.deepEqual(page.outbox(), {});
  t.mock.timers.tick(RETRY_MS * 5);
  await flush();
  assert.equal(page.posts.length, 3, 'and is not tried again');
});

test('an outbox entry does not outlive its decision: answered elsewhere while it waits, it is dropped and never sent', async t => {
  const page = await mountPage(t, [quickDecision]);
  page.down = true;
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  t.mock.timers.tick(HOLD_MS);
  await flush();
  page.settle('a1', 'Deny', false); // answered on Telegram while this page could not reach Clowder
  assert.deepEqual(page.outbox(), {});
  assert.equal(toast(page.doc).hidden, true);
  page.down = false;
  t.mock.timers.tick(RETRY_MS * 5);
  await flush();
  assert.equal(page.posts.length, 1, 'nothing more is sent');
});

test('a page opened again sends what the last one left waiting, once; an entry whose decision is gone is cleared at once', async t => {
  const storage = fakeStorage();
  storage.setItem(OUTBOX_KEY, JSON.stringify({a1: {answer: 'Allow once', approved: true}, gone: {answer: 'Yes', approved: true}, bad: {answer: 3}}));
  const page = await mountPage(t, [quickDecision], {storage});
  assert.deepEqual(page.outbox(), {a1: {answer: 'Allow once', approved: true}}, 'only the pending decision keeps its entry');
  assert.equal(waiting(page.doc, 'a1').textContent, `${QUEUED} · You said yes to Scholar: Allow once`);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(page.posts, [['approvals/a1', {answer: 'Allow once', approved: true}]]);
  assert.deepEqual(page.outbox(), {});
  t.mock.timers.tick(RETRY_MS * 5);
  await flush();
  assert.equal(page.posts.length, 1);
});

test('a hidden page whose answer cannot reach Clowder keeps it in the outbox; storage that throws leaves the outbox in the page', async t => {
  const page = await mountPage(t, [quickDecision], {storage: fakeStorage(true)});
  page.down = true;
  card(page.strip, 'a1').querySelector('[data-answer="0"]').click();
  page.doc.visibilityState = 'hidden';
  for (const fn of page.doc.listeners.visibilitychange) fn();
  await flush();
  assert.equal(waiting(page.doc, 'a1').dataset.state, 'queued', 'the keepalive try failed too: the answer waits');
  page.down = false;
  t.mock.timers.tick(RETRY_MS);
  await flush();
  assert.deepEqual(page.posts.map(p => p.length), [3, 2], 'the keepalive try, then one that got there');
  assert.deepEqual(page.sounds, ['success']);
});

// The same in a real browser, on scratch (plan 11.17's Proof): the app runs as its own process here, so it can be stopped and started
// again on the same port and data. Like startScratch (test/helpers/chat-spine-scratch.mjs): its own ports, a temporary CAT_TOWN_DATA,
// this launch's owner key, Demonstration only, and no Internet: fetch is stubbed before the server loads. Skipped without a browser.
const NO_INTERNET = 'data:text/javascript,globalThis.fetch=async()=>new Response(null,{status:503})';
// Measured in the page while an answer waits: the page's width, overlaps between the bar, the toast, the composer and the dock, and the
// tap targets in the bar, the toast and the decision's cards that are on screen.
const WAITING_LAYOUT = id => {
  const shown = el => { if (!el || el.closest('[hidden]')) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
  const parts = {bar: '#host-down', toast: '.decision-toast', composer: '#chat-form', dock: '.town-dock'};
  const rects = Object.fromEntries(Object.entries(parts).map(([k, s]) => [k, shown(document.querySelector(s))]).filter(([, r]) => r));
  const names = Object.keys(rects), overlaps = [];
  for (const [i, a] of names.entries()) for (const b of names.slice(i + 1)) {
    const r = rects[a], s = rects[b], w = Math.min(r.right, s.right) - Math.max(r.left, s.left), hgt = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
    if (w > 0.5 && hgt > 0.5) overlaps.push(`${a}/${b} ${Math.round(w)}x${Math.round(hgt)}`);
  }
  const targets = [...document.querySelectorAll(`#host-down button, .decision-toast button, [data-decision="${id}"] button, [data-decision="${id}"] a`)].map(el => [el, shown(el)]).filter(([, r]) => r);
  return {width: innerWidth, scrollWidth: document.documentElement.scrollWidth, shown: names, overlaps, targets: targets.length,
    small: targets.filter(([, r]) => r.width < 44 || r.height < 44).map(([el, r]) => `${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`)};
};

test('on scratch: stop Clowder, Approve, start it again; the journal holds exactly 1 approval.resolved with no second tap, at 1440 and at 375 (F7)', {skip: !browserPath && 'no Chromium, Edge or Chrome here', timeout: 900_000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-outbox-')), key = 'decision-outbox-owner-key', port = await freePort();
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  const env = {...process.env, PORT: String(port), CAT_REMOTE_PORT: String(await freePort()), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_OWNER_KEY: key};
  delete env.NODE_TEST_CONTEXT;
  let server = null, browser = null;
  const start = async () => {
    const child = server = spawn(process.execPath, ['--import', 'tsx', '--import', NO_INTERNET, 'src/server.ts'], {cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'ignore', 'pipe']});
    let err = '';
    child.stderr.on('data', d => { err += d; });
    for (;;) {
      try { await fetch(`http://127.0.0.1:${port}/api/remote-access`); return; } catch { /* not listening yet */ }
      if (child.exitCode !== null) throw new Error(`the scratch server stopped: ${err}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };
  const stop = () => new Promise(resolve => { if (!server || server.exitCode !== null) { resolve(); return; } server.once('exit', resolve); server.kill(); });
  t.after(async () => {
    await browser?.close();
    await stop();
    try { rmSync(dir, {recursive: true, force: true}); } catch { /* a file still held open on Windows: the temp folder clears it later */ }
  });
  const resolved = id => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(e => e.type === 'approval.resolved' && e.data?.id === id).map(e => ({status: e.data.status, answer: e.data.answer}));
  const {chromium} = await import('playwright-core');
  await start();
  browser = await chromium.launch({executablePath: browserPath, headless: true});
  const figures = {};
  for (const [size, options] of [['1440', {width: 1440, height: 900}], ['375', {width: 375, height: 812, phone: true}]]) {
    const {ctx, page, errors} = await newPage(browser, options);
    const posts = [];
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/api/approvals/')) posts.push(r.url()); });
    await loadApp(page, `http://127.0.0.1:${port}/?owner=${key}`);
    await openMayorChat(page);
    await askDemoDecision(page);
    const id = await page.evaluate(() => document.querySelector('#approvals .decision-card[data-state="pending"]').dataset.decision);
    // The decision's answers as the owner sees them: the thread card's, or the strip's when the thread card is off screen.
    const answer = page.locator(`[data-decision="${id}"]:visible .decision-answer`).first();
    await answer.waitFor({state: 'visible', timeout: 10_000});
    await stop();
    await page.waitForSelector('#host-down:not([hidden])', {timeout: 30_000});
    await answer.click();
    const taps = 1;
    await page.waitForSelector(`[data-decision="${id}"][data-state="queued"]`, {state: 'attached', timeout: 15_000});
    const toastText = await page.locator('.decision-toast p').textContent();
    const outbox = await page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? '{}'), OUTBOX_KEY);
    const holdOverlaps = (await page.evaluate(WAITING_LAYOUT, id)).overlaps; // reported, not asserted: the hold's toast is over the sheets by design
    // The page while the answer waits, once its Undo hold has ended (the toast sits over the sheets only for a hold, as since plan 8.8).
    await page.waitForSelector('.decision-toast[hidden]', {state: 'attached', timeout: HOLD_MS + 5_000});
    const layout = await page.evaluate(WAITING_LAYOUT, id);
    const folded = await page.locator(`[data-decision="${id}"]:visible .decision-folded`).first().textContent();
    const postsWhileDown = posts.length;
    await start();
    await page.waitForSelector(`[data-decision="${id}"][data-state="approved"]`, {state: 'attached', timeout: 60_000});
    figures[size] = {taps, postsWhileDown, posts: posts.length, journal: resolved(id), toastText, folded, outbox: Object.keys(outbox), holdOverlaps, layout,
      outboxAfter: await page.evaluate(k => localStorage.getItem(k), OUTBOX_KEY), errors};
    await ctx.close();
  }
  t.diagnostic(JSON.stringify(figures));
  for (const [size, f] of Object.entries(figures)) {
    const width = Number(size);
    assert.equal(f.taps, 1, `${size}: one tap`);
    assert.deepEqual(f.journal, [{status: 'approved', answer: 'Approve draft'}], `${size}: exactly 1 approval.resolved, the Approve made while Clowder was stopped`);
    assert.equal(f.postsWhileDown, 1, `${size}: one try while stopped, none after it until Clowder answers`);
    assert.equal(f.posts, 2, `${size}: then one more, which got there`);
    assert.equal(f.toastText, `${QUEUED} · You said yes to Mayor: Approve draft`, `${size}: the Undo hold says it waits`);
    assert.equal(f.folded, f.toastText, `${size}: and so does the folded card after it`);
    assert.equal(f.outbox.length, 1, `${size}: kept in localStorage while it waits`);
    assert.equal(f.outboxAfter, null, `${size}: and gone once sent`);
    assert.equal(f.layout.width, width);
    assert.equal(f.layout.scrollWidth, width, `${size}: no horizontal scroll`);
    assert.ok(f.layout.shown.includes('bar') && !f.layout.shown.includes('toast'), `${size}: the bar shows, and the toast has left`);
    assert.deepEqual(f.layout.overlaps, [], `${size}: nothing overlaps`);
    assert.ok(f.layout.targets >= 1, `${size}: Retry at least`);
    assert.deepEqual(f.layout.small, [], `${size}: every tap target is at least 44 px`);
    assert.deepEqual(f.errors, [], `${size}: no page errors`);
  }
});

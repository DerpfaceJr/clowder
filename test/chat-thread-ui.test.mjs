import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decisionCard,decisionCardHtml,domRenderer} from '../public/decision-strip.js';
import {threadItems,placeOf,workLabel,unsent,treeOf,roundsOf,liveText,ago,isWork,createChatThread,memberName,sender,peopleOf,STARTERS,latestTurn,resultIds} from '../public/chat-thread.js';
import {planSend,requestFor,workRoots} from '../public/chat-composer.js';

// Plan 8.6, the thread view, checked without a browser: the rows a thread is made of, the sends on their way, the decision card the same
// whatever asked it (Gate 8), and the view itself drawn into a small DOM stand-in. The 375 px pass is a browser check, not in this file.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const NAMES = {owner: 'You', mayor: 'Mayor', scholar: 'Scholar', critic: 'Critic', banker: 'Banker', town: 'Town'};
const name = id => NAMES[id] ?? id;
const at = minute => `2026-11-08T09:${String(minute).padStart(2, '0')}:00.000Z`;
const msg = (id, from, to, text, minute, extra = {}) => ({id, from, to, text, at: at(minute), ...extra});

// Gate 8: a Hermes tool call parked by the gate plugin and a connector call ask through the same card. Each fixture keeps its gate's own
// fields (Hermes: session and tool; connector: the call and its arguments) and the same quick buttons (push.ts quickActions), so only the gate differs.
const asked = {id: 'a1', task: 't1', cat: 'mayor', question: 'May the Mayor send the newsletter?', options: ['Allow once', 'Deny'], status: 'pending', toolCallId: 'c1', turn: 1, depth: 0, quick: []};
const hermes = {...asked, gate: 'hermes', hermes: {session: 's1', tool: 'send_email', digest: 'd1'}};
const connector = {...asked, gate: 'connector', effectClass: 'public', call: {id: 'c1', type: 'function', function: {name: 'gmail_send', arguments: '{}'}}, detail: '{"to":"list"}'};
const card = (a, readOnly = false) => decisionCardHtml(a, {name, readOnly, surface: 'thread'});

test('snapshot: a gate:hermes decision and a gate:connector decision render the same card', () => {
  assert.equal(card(hermes), card(connector));
  assert.match(card(hermes), /^<section class="decision-card" data-decision="a1" data-state="pending">/);
  assert.match(card(hermes), /id="thread-decision-a1"/, 'the thread surface keeps its ids apart from the strip’s and the Inbox’s');
  assert.equal(card({...hermes, status: 'approved'}), card({...connector, status: 'approved'}));
  assert.match(card({...hermes, status: 'approved', answer: 'Allow once'}), /<span>You said yes to Mayor: Allow once<\/span>/, 'answered: one line');
  assert.match(card({...connector, status: 'rejected'}), /<span>You said no to Mayor<\/span>/);
  assert.match(card({...hermes, status: 'cancelled'}), /<span>Mayor’s decision was cancelled<\/span>/);
  assert.ok(!card(hermes, true).includes('decision-actions'), 'a viewer reads the question but has no answers');
  const strip = read('decision-strip.js');
  assert.ok(!/gate/.test(strip.slice(strip.indexOf('export function decisionCard('), strip.indexOf('export const decisionCardHtml'))), 'the card never reads gate');
  assert.match(card({...asked, question: 'Use <b>&'}), /Use &lt;b&gt;&amp;/, 'the question is escaped');
});

test('a thread folds each run of cat-to-cat messages into one work row, and keeps rounds and owner talk as they are', () => {
  const messages = [
    msg('m1', 'owner', 'mayor', 'Explore a service.', 1),
    msg('m2', 'mayor', 'scholar', 'Propose a hypothesis.', 2), msg('m3', 'mayor', 'critic', 'Review it.', 3),
    msg('m4', 'scholar', 'mayor', 'Hypothesis.', 4), msg('m5', 'critic', 'mayor', 'Critique.', 5),
    msg('m6', 'mayor', 'owner', 'Here is the plan.', 6),
    msg('m7', 'town', 'mayor', 'Goal round 2: Tidy the square', 7),
    msg('m8', 'owner', 'mayor', 'How is it going?', 8, {aside: true}),
  ];
  const items = threadItems({messages, fold: true});
  assert.deepEqual(items.map(i => i.kind), ['message', 'work', 'message', 'round', 'message']);
  assert.deepEqual(items[1].messages.map(m => m.id), ['m2', 'm3', 'm4', 'm5']);
  assert.equal(items[1].key, 'wm2', 'a work row is keyed by its first message');
  assert.equal(items[3].round.round, 2, 'a goal round is a quiet line, never a "You" bubble');
  assert.deepEqual(threadItems({messages}).map(i => i.kind), ['message', 'message', 'message', 'message', 'message', 'message', 'round', 'message'], 'other cats and threads do not fold');
  assert.equal(isWork(messages[7]), false, 'an aside is owner talk');
  assert.equal(workLabel(items[1].messages, 'mayor', name), 'Mayor asked Scholar and Critic · 2 replies');
  assert.equal(workLabel([messages[1]], 'mayor', name), 'Mayor asked Scholar');
  assert.equal(workLabel([messages[3]], 'mayor', name), 'Scholar replied');
  assert.equal(workLabel([msg('p', 'mailman', 'mayor', 'Post for you, by Telegram.', 1)], 'mayor', id => id === 'mailman' ? 'Mailman' : name(id)), 'Mailman brought post', 'a delivery is not a reply');
  assert.equal(workLabel([msg('x', 'mayor', 'scholar', '', 1), msg('y', 'mayor', 'critic', '', 1), msg('z', 'mayor', 'banker', '', 1), msg('w', 'banker', 'mayor', '', 2)], 'mayor', name), 'Mayor asked Scholar, Critic and Banker · 1 reply');
});

test('a decision sits where it was asked, and an answered one with no place is left out', () => {
  const messages = [msg('m1', 'owner', 'mayor', 'Go.', 1, {task: 't1'}), msg('m2', 'mayor', 'scholar', 'Look.', 2, {task: 't2'}), msg('m3', 'scholar', 'mayor', 'Found.', 4, {task: 't2'})];
  const events = [{type: 'approval.requested', at: at(3), data: {id: 'a1'}}];
  assert.equal(placeOf({id: 'a1', task: 't1', status: 'pending'}, messages, events), 2, 'after the messages that were in when it was asked');
  assert.equal(placeOf({id: 'a2', task: 't2', status: 'approved'}, messages, []), 3, 'no event: after the last message of its task');
  assert.equal(placeOf({id: 'a3', task: 'gone', status: 'pending'}, messages, []), 3, 'waiting with no place: at the end');
  assert.equal(placeOf({id: 'a4', task: 'gone', status: 'approved'}, messages, []), -1, 'answered with no place: left out');
  const items = threadItems({messages, approvals: [{id: 'a1', task: 't1', status: 'pending'}], events, fold: true});
  assert.deepEqual(items.map(i => i.kind), ['message', 'work', 'decision', 'work'], 'the card splits the work run where it was asked');
  assert.equal(items[2].key, 'da1');
  const both = threadItems({messages, approvals: [{...hermes, task: 't2'}, {...connector, id: 'a2', task: 't2'}], fold: true});
  assert.deepEqual(both.filter(i => i.kind === 'decision').map(i => i.a.gate), ['hermes', 'connector'], 'both gates become the same kind of row');
});

test('a send shows until the owner message with its words is journaled after afterId (the plan 8.7 contract)', () => {
  const m1 = msg('m1', 'mayor', 'owner', 'Hello', 1), m2 = msg('m2', 'owner', 'mayor', 'Plan the fair', 2), m3 = msg('m3', 'owner', 'mayor', '  Plan the fair\n', 3);
  const p = (id, text, afterId, status = 'sending') => ({id, text, at: Date.parse(at(1)), afterId, status});
  assert.deepEqual(unsent([p('c1', 'Plan the fair', 'm1')], [m1]).map(x => x.id), ['c1'], 'nothing journaled yet');
  assert.deepEqual(unsent([p('c1', ' Plan the fair ', 'm1')], [m1, m3]), [], 'the same trimmed words after afterId');
  assert.deepEqual(unsent([p('c1', 'Plan the fair', 'm2')], [m1, m2]).map(x => x.id), ['c1'], 'an older message with the same words does not count');
  assert.deepEqual(unsent([p('c1', 'Plan the fair', 'm1'), p('c2', 'Plan the fair', 'm1')], [m1, m2]).map(x => x.id), ['c2'], 'one journaled message settles one send');
  assert.deepEqual(unsent([p('c1', 'Plan the fair', null)], [m2]), [], 'an empty thread at Send time');
  assert.deepEqual(unsent([p('c1', 'Plan the fair', 'paged-out')], [m2]), [], 'afterId no longer loaded: every message is after it');
  assert.deepEqual(unsent([p('c1', 'Plan the fair', 'm1', 'failed')], [m1]).map(x => x.status), ['failed'], 'a failed send stays until 8.7 retries or discards it');
  assert.deepEqual(unsent([p('c1', 'Plan the fair', 'm1')], [m1, msg('m2', 'mayor', 'owner', 'Plan the fair', 2)]).length, 1, 'only the owner’s own message settles it');
  assert.deepEqual(unsent([p('c1', '/review the shop', 'm1')], [m1, msg('m2', 'owner', 'mayor', 'Command /review the shop:\n\nReview…', 2)]), [], 'a plugin command is journaled expanded (connectors.ts commandMessage)');
  assert.deepEqual(unsent(undefined, [m1]), []);
});

test('request and goal threads: a task tree, a row per round, and the working line’s words', () => {
  const tasks = [{id: 'r', cat: 'mayor'}, {id: 'c', cat: 'scholar', parent: 'r', status: 'running'}, {id: 'g', cat: 'critic', parent: 'c', status: 'waiting'}, {id: 'x', cat: 'banker', parent: 'other'}];
  assert.deepEqual([...treeOf('r', tasks)].sort(), ['c', 'g', 'r']);
  const goal = {id: 'goal1', title: 'Tidy', status: 'active', rounds: 3, log: ['Round 1: Swept the square.', 'Round 2: Failed: no broom.']};
  const rounds = roundsOf(goal, [{id: 't1', goal: 'goal1', text: 'Goal round 1: Tidy'}, {id: 't3', goal: 'goal1', text: 'Goal round 3: Tidy'}, {id: 'tx', goal: 'other', text: 'Goal round 2: Tidy'}]);
  assert.deepEqual(rounds.map(r => [r.n, r.text, r.task?.id]), [[1, 'Swept the square.', 't1'], [2, 'Failed: no broom.', undefined], [3, 'Under way', 't3']]);
  assert.equal(liveText({id: 'r', cat: 'mayor', status: 'running'}, tasks, {label: 'reading a page'}, name), 'Mayor is working · reading a page');
  assert.equal(liveText({id: 'r', cat: 'mayor', status: 'waiting_child'}, tasks, {label: 'asking a cat'}, name), 'Mayor is waiting on Scholar');
  assert.equal(liveText({id: 'g', cat: 'critic', status: 'waiting'}, tasks, null, name), 'Critic needs your answer');
  assert.deepEqual([ago(at(0), Date.parse(at(0)) + 14e3), ago(at(0), Date.parse(at(3))), ago(at(0), Date.parse(at(0)) + 65 * 60e3)], ['14 s', '3 min', '1 h 5 min']);
});

// A small stand-in for the browser DOM: enough for Preact's render, icons.js and the view (elements, text, raw markup from innerHTML, events).
class Node {
  constructor(doc, tag, ns) { Object.assign(this, {ownerDocument: doc, localName: tag, namespaceURI: ns, nodeType: tag ? 1 : 3, parentNode: null, childNodes: [], attrs: {}, listeners: {}, style: {setProperty() {}}, data: ''}); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  insertBefore(node, ref) { node.remove(); node.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node); return node; }
  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
  after(node) { this.parentNode.insertBefore(node, this.nextSibling); }
  remove() { const s = this.parentNode?.childNodes; if (s) s.splice(s.indexOf(this), 1); this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  click() { for (let n = this; n; n = n.parentNode) for (const fn of n.listeners.click ?? []) fn.call(n, {type: 'click', target: this, currentTarget: n}); }
  set innerHTML(html) { this.childNodes = []; this.raw = html; }
  get textContent() { return this.nodeType === 3 ? this.data : (this.raw ?? '').replace(/<[^>]+>/g, '') + this.childNodes.map(c => c.textContent).join(''); }
  get outerHTML() { return this.nodeType === 3 ? esc(this.data) : `<${this.localName}${Object.entries(this.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${this.raw ?? ''}${this.childNodes.map(c => c.outerHTML).join('')}</${this.localName}>`; }
  all(test) { return this.childNodes.flatMap(c => [...(c.nodeType === 1 && test(c) ? [c] : []), ...c.all(test)]); }
}
function fakeDocument() {
  const doc = {createElementNS: (ns, tag) => new Node(doc, tag, ns), createTextNode: text => Object.assign(new Node(doc, null), {data: String(text)})};
  doc.createElement = tag => doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
  const body = doc.createElement('body'), chat = doc.createElement('div');body.append(chat);
  return {doc, chat};
}
const cls = c => n => (n.attrs.class ?? '').split(' ').includes(c);
function mount(options = {}) {
  const saved = globalThis.document, {doc, chat} = fakeDocument();globalThis.document = doc;
  const calls = [];
  const thread = createChatThread({chat, name, time: () => '09:00', openArchiveOn() {}, api: async (...a) => { calls.push(a); }, notify() {}, select: id => calls.push(['select', id]), decisionSlot: () => null, ...options});
  // done() draws the working line empty first, so its one-second clock stops (Preact runs effects about 35 ms after a render).
  const done = async () => { thread.live({page: {}, state: state(), selected: 'mayor'});await new Promise(r => setTimeout(r, 80));if (saved === undefined) delete globalThis.document; else globalThis.document = saved; };
  return {thread, chat, live: chat.nextSibling, calls, done};
}
const state = (extra = {}) => ({tasks: [], messages: [], approvals: [], events: [], goals: [], live: {}, readOnly: false, ...extra});

test('snapshot through the view: the Hermes and the connector decision are the strip’s live card, placed where they were asked', async () => {
  const approvals = [{...hermes, id: 'h1'}, {...connector, id: 'k1'}], asks = [];
  // decisionSlot stands in for decision-strip.js decisionCardFor, which hands back that card as nodes (domRenderer) and keeps it current.
  const {thread, chat, done} = mount({decisionSlot: (id, o) => { asks.push([id, o.surface]); return decisionCard(approvals.find(a => a.id === id), {name, surface: o.surface}, domRenderer()); }});
  try {
    const messages = [msg('m1', 'owner', 'mayor', 'Send the newsletter.', 1, {task: 't1'}), msg('m2', 'mayor', 'owner', 'Drafted.', 5, {task: 't1'})];
    const s = state({messages, approvals, events: [{type: 'approval.requested', at: at(2), data: {id: 'h1'}}, {type: 'approval.requested', at: at(3), data: {id: 'k1'}}]});
    thread.paint({page: {messages, tasks: []}, state: s, selected: 'mayor'});
    assert.deepEqual(chat.childNodes.map(n => n.localName), ['article', 'div', 'div', 'article'], 'both between the request and the reply, as asked');
    const cards = chat.all(cls('decision-card')), same = n => n.outerHTML.replaceAll(n.getAttribute('data-decision'), 'ID');
    assert.equal(cards.length, 2);
    assert.equal(same(cards[0]), same(cards[1]), 'the same card, only the id differs');
    assert.match(cards[0].outerHTML, /i-bell/, 'with the sprite’s bell');
    assert.deepEqual(asks, [['h1', 'thread'], ['k1', 'thread']], 'each card is asked of the strip once, for the thread surface');
    thread.paint({page: {messages, tasks: []}, state: s, selected: 'mayor'});
    assert.equal(asks.length, 2, 'a repaint keeps the live card instead of asking again');
    assert.equal(chat.all(cls('decision-card')).length, 2);
    assert.ok(!chat.listeners.click?.length, 'the thread adds no click handling of its own: the card answers through the strip');
  } finally { await done(); }
});

test('the view: a work row opens in place, a send shows at once, and the working line has the paw, the words and Stop', async () => {
  const {thread, chat, live, calls, done} = mount();
  try {
    const messages = [msg('m1', 'owner', 'mayor', 'Explore.', 1, {task: 'r'}), msg('m2', 'mayor', 'scholar', 'Look.', 2, {task: 'c'}), msg('m3', 'scholar', 'mayor', 'Found.', 3, {task: 'c'})];
    const tasks = [{id: 'r', cat: 'mayor', from: 'owner', text: 'Explore.', status: 'running'}];
    const page = {messages, tasks: [], pending: [{id: 'p1', text: 'And the fair', at: Date.now(), afterId: 'm3', status: 'sending'}, {id: 'p2', text: 'And the parade', at: Date.now(), afterId: 'm3', status: 'failed'}]};
    const s = state({messages, tasks, live: {r: {cat: 'mayor', label: 'reading a page', text: 'Draft so far'}}});
    thread.paint({page, state: s, selected: 'mayor'});thread.live({page, state: s, selected: 'mayor'});
    const row = chat.all(cls('work-row'))[0];
    assert.equal(row.textContent, 'Mayor asked Scholar · 1 reply09:00');
    assert.match(row.outerHTML, /data-icon="chevron-right"|#i-chevron-right/, 'a chevron icon from the sprite, not the ▸ glyph');
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    row.click();
    assert.equal(row.getAttribute('aria-expanded'), 'true', 'the same button, now open');
    assert.equal(chat.all(cls('work-body'))[0].all(cls('chat-message')).length, 2);
    const sending = chat.all(cls('pending'));
    assert.deepEqual(sending.map(n => [n.textContent, n.getAttribute('aria-hidden')]), [['YouSending…And the fair', 'true'], ['YouNot sentAnd the paradeRetryDiscard', null]]);
    assert.deepEqual(sending[1].all(n => n.localName === 'button').map(b => [b.getAttribute('data-retry'), b.getAttribute('data-discard')]), [['p2', null], [null, 'p2']], 'a failed send offers Retry and Discard (chat-composer.js handles them)');
    assert.equal(sending[0].all(n => n.localName === 'button').length, 0, 'a send on its way has none');
    const line = live.all(cls('live-line'))[0];
    assert.equal(live.all(n => n.attrs.role === 'status')[0].textContent, 'Mayor is working · reading a page');
    assert.match(line.outerHTML, /i-paw-print/, 'the paw is the sprite’s SVG');
    assert.equal(live.all(cls('draft'))[0].textContent, 'Mayor is writing…Draft so far');
    live.all(cls('live-stop'))[0].click();
    assert.deepEqual(calls.at(-1), ['tasks/r/stop', {}]);
    const journaled = state({...s, messages: [...messages, msg('m4', 'owner', 'mayor', 'And the fair', 4, {task: 'r2'})]});
    thread.paint({page, state: journaled, selected: 'mayor'});
    assert.deepEqual(chat.all(cls('pending')).map(n => n.textContent), ['YouNot sentAnd the paradeRetryDiscard'], 'the journaled message replaces its send');
  } finally { await done(); }
});

test('open() and current() for the plan 8.7 thread switcher', async () => {
  const {thread, chat, calls, done} = mount();
  const saved = globalThis.fetch;
  globalThis.fetch = async url => ({ok: true, json: async () => (url === '/api/threads/r' ? {messages: [msg('m1', 'owner', 'mayor', 'Explore.', 1, {task: 'r'}), msg('m2', 'mayor', 'scholar', 'Look.', 2, {task: 'c'})], more: false, tasks: [{id: 'r', cat: 'mayor', from: 'owner', text: 'Explore.', status: 'done'}, {id: 'c', cat: 'scholar', parent: 'r', status: 'done'}]} : {})});
  try {
    const s = state({goals: [{id: 'g1', title: 'Tidy', status: 'active', rounds: 1, log: ['Round 1: Swept.']}]});
    thread.paint({page: {messages: [], tasks: []}, state: s, selected: 'mayor'});
    assert.deepEqual(thread.current(), {kind: 'mayor', id: 'mayor'});
    thread.open({kind: 'request', id: 'r'});
    assert.deepEqual(thread.current(), {kind: 'request', id: 'r'});
    await new Promise(r => setTimeout(r, 0));
    assert.match(chat.all(cls('thread-head'))[0].textContent, /^Request Explore\.Done$/);
    assert.equal(chat.all(cls('chat-message')).length, 2, 'every message of the tree, cat to cat included');
    thread.open({kind: 'goal', id: 'g1'});
    assert.deepEqual(thread.current(), {kind: 'goal', id: 'g1'});
    assert.match(chat.all(cls('thread-head'))[0].textContent, /^Goal TidyActive$/);
    assert.equal(chat.all(cls('work-label'))[0].textContent, 'Round 1 · Swept.');
    chat.all(cls('thread-back'))[0].click();
    assert.deepEqual(thread.current(), {kind: 'mayor', id: 'mayor'}, 'Back returns to the cat’s chat');
    thread.open({kind: 'cat', id: 'scholar'});
    assert.deepEqual(calls.at(-1), ['select', 'scholar'], 'a cat’s chat is chosen through app.js select()');
    thread.paint({page: {messages: [], tasks: []}, state: s, selected: 'scholar'});
    assert.deepEqual(thread.current(), {kind: 'cat', id: 'scholar'});
    thread.open({kind: 'request', id: 'r'});
    const picks = calls.length;
    chat.all(cls('thread-back'))[0].click();
    assert.deepEqual(thread.current(), {kind: 'cat', id: 'scholar'}, 'Back from a request returns to the open cat’s chat, as its label says');
    assert.equal(calls.length, picks, 'and does not switch to the Mayor');
  } finally { globalThis.fetch = saved; await done(); }
});

test('plan 8.10: opening a work row replays its visits; a request thread eases the town to its cat once, a goal to the Mayor', async () => {
  const replays = [], aims = [];
  const {thread, chat, calls, done} = mount({replay: messages => replays.push(messages.map(m => m.id)), focusCat: id => aims.push(id)});
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, json: async () => ({messages: [], more: false, tasks: [{id: 'x', cat: 'critic', from: 'owner', text: 'Review.', status: 'done'}]})});
  try {
    const messages = [msg('m1', 'owner', 'mayor', 'Explore.', 1, {task: 'r'}), msg('m2', 'mayor', 'scholar', 'Look.', 2, {task: 'c'}), msg('m3', 'scholar', 'mayor', 'Found.', 3, {task: 'c'})];
    const s = state({messages, tasks: [{id: 'r', cat: 'scholar', from: 'owner', text: 'Explore.', status: 'running'}], goals: [{id: 'g1', title: 'Tidy', status: 'active', rounds: 1, log: ['Round 1: Swept.']}]});
    thread.paint({page: {messages, tasks: []}, state: s, selected: 'mayor'});
    const row = () => chat.all(cls('work-row'))[0];
    row().click();
    assert.deepEqual(replays, [['m2', 'm3']], 'the row’s own messages, to town.replay(msgs)');
    row().click();
    assert.equal(replays.length, 1, 'closing it replays nothing');
    assert.deepEqual(aims, [], 'a cat’s own chat eases through select, not focusCat');
    thread.open({kind: 'request', id: 'r'});
    assert.deepEqual(aims, ['scholar'], 'the root task’s cat, known from the state');
    thread.paint({page: {messages, tasks: []}, state: s, selected: 'mayor'});
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(aims, ['scholar'], 'once per open, not on every paint or load');
    thread.open({kind: 'goal', id: 'g1'});
    assert.deepEqual(aims, ['scholar', 'mayor']);
    chat.all(cls('work-row'))[0].click();
    assert.equal(replays.length, 1, 'a goal round loads its thread; it is not a work row');
    thread.open({kind: 'request', id: 'x'});
    assert.deepEqual(aims, ['scholar', 'mayor'], 'a root the page does not know yet waits for its thread');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(aims, ['scholar', 'mayor', 'critic'], 'and eases when it loads');
    assert.ok(!calls.some(c => c[0] === 'select'), 'opening a thread never switches the cat');
  } finally { globalThis.fetch = saved; await done(); }
});

test('app.js keeps the frame wiring and hands the drawing to chat-thread.js; the CSS uses only the V0 tokens', () => {
  const app = read('app.js'), css = read('chat-sheet.css');
  assert.match(app, /function paintLive\(\)\{if\(state\)chatThread\.live\(\{page:chatPages\.get\(selected\),state,selected\}\);\}/);
  assert.match(app, /if\(\(frame\.activity\|\|frame\.delta\)&&state&&!refreshing\)\{const next=applyFrame\(state,frame\);if\(next\)\{state=next;paintLive\(\);\}return;\}/, 'activity and delta frames still repaint only the working line');
  const thread = css.slice(css.indexOf('/* Thread view (plan 8.6)'));
  assert.ok(thread.length > 100);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(thread), 'no colour literals');
  assert.ok(!/:root/.test(thread), 'no new tokens');
  assert.ok(!/#a77b35|#8c806a/i.test(css));
  assert.match(thread, /@media\(prefers-reduced-motion:reduce\)\{\.live-line svg\{animation:none\}/, 'the paw is still under reduced motion');
  const card = read('decision-strip.css');
  assert.match(card, /\.decision-card\{[^}]*background:var\(--needs\);[^}]*box-shadow:var\(--e2\)/, 'the thread shows decision-strip.js’s card: --needs with --e2');
  assert.ok(!/border-left/.test(thread) && !/border-left/.test(card), 'no left accent border');
});

// Plans 10.6 and 10.12 (docs/for-you-and-teams-plan.md §4.5, §4.6): a team member's message keeps from 'owner' and carries their name, and a
// request thread names who is in it. Names are user input, so they reach the page as text nodes, never as markup.
const HOSTILE = '<img src=x onerror=alert(1)>';
test('10.6: a team member’s message reads as theirs; the owner’s own messages still read You', async () => {
  assert.equal(sender(msg('m1', 'owner', 'mayor', 'Hi', 1), name), 'You');
  assert.equal(sender(msg('m2', 'owner', 'mayor', 'Hi', 1, {name: 'Ana'}), name), 'Ana (team member)');
  assert.equal(sender(msg('m3', 'owner', 'mayor', 'Hi', 1, {name: '  '}), name), 'You', 'a blank name is no name');
  assert.equal(sender(msg('m4', 'mayor', 'owner', 'Hi', 1, {name: 'Ana'}), name), 'Mayor', 'only the owner’s side carries a person');
  assert.equal(memberName({from: 'owner', name: 42}), '', 'a name that is not text is ignored');
  const {thread, chat, done} = mount();
  try {
    const messages = [msg('m1', 'owner', 'mayor', 'Plan the fair.', 1, {task: 't1'}), msg('m2', 'mayor', 'owner', 'On it.', 2, {task: 't1'}), msg('m3', 'owner', 'mayor', 'Add a stall.', 3, {task: 't2', name: 'Ana'}), msg('m4', 'owner', 'mayor', 'Hello', 4, {task: 't3', name: HOSTILE})];
    thread.paint({page: {messages, tasks: []}, state: state({messages}), selected: 'mayor'});
    const bubbles = chat.all(cls('chat-message'));
    assert.deepEqual(bubbles.map(b => b.all(cls('sender'))[0].textContent), ['You09:00', 'Mayor09:00', 'Ana (team member)09:00', `${HOSTILE} (team member)09:00`]);
    assert.deepEqual(bubbles.map(b => b.getAttribute('class')), ['chat-message owner', 'chat-message mayor', 'chat-message owner member', 'chat-message owner member'], 'a member’s bubble keeps the owner side and adds member');
    assert.equal(chat.all(n => n.localName === 'img').length, 0, 'a name with markup in it stays text');
    assert.match(bubbles[3].outerHTML, /&lt;img src=x onerror=alert\(1\)&gt; \(team member\)/);
  } finally { await done(); }
});

test('10.12: a request thread names who is in it under its head, and an owner-only thread adds nothing', async () => {
  const you = [{id: 'owner', name: 'Owner'}], ana = [...you, {id: 'p-ana', name: 'Ana'}];
  assert.deepEqual(peopleOf(ana, name), [{id: 'owner', name: 'You'}, {id: 'p-ana', name: 'Ana', member: true}], 'the owner is named as the rest of the page names them');
  assert.deepEqual(peopleOf([{id: 'p-x', name: ' '}], name), [{id: 'p-x', name: 'A team member', member: true}]);
  assert.deepEqual(peopleOf(undefined, name), [], 'an older server sends none');
  const {thread, chat, done} = mount();
  const saved = globalThis.fetch, threads = {
    r: {messages: [msg('m1', 'owner', 'mayor', 'Plan the fair.', 1, {task: 'r', name: 'Ana'}), msg('m2', 'mayor', 'owner', 'Planned.', 2, {task: 'r'})], more: false, tasks: [{id: 'r', cat: 'mayor', from: 'owner', text: 'Plan the fair.', status: 'done', by: 'p-ana'}], participants: ana},
    o: {messages: [msg('m3', 'owner', 'mayor', 'Sweep.', 3, {task: 'o'})], more: false, tasks: [{id: 'o', cat: 'mayor', from: 'owner', text: 'Sweep.', status: 'done'}], participants: you},
    h: {messages: [], more: false, tasks: [{id: 'h', cat: 'mayor', from: 'owner', text: 'Hi.', status: 'done', by: 'p-h'}], participants: [...you, {id: 'p-h', name: HOSTILE}, {id: 'p-ben', name: 'Ben'}]},
  };
  globalThis.fetch = async url => ({ok: true, json: async () => threads[decodeURIComponent(url.split('/').at(-1))]});
  try {
    thread.paint({page: {messages: [], tasks: []}, state: state(), selected: 'mayor'});
    thread.open({kind: 'request', id: 'r'});
    await new Promise(r => setTimeout(r, 0));
    const people = chat.all(cls('thread-people'));
    assert.equal(people.length, 1);
    assert.equal(people[0].textContent, 'In this thread: You and Ana (team member)');
    assert.deepEqual(people[0].all(cls('thread-person')).map(n => n.textContent), ['You', 'Ana (team member)']);
    assert.equal(people[0].all(cls('thread-person-role')).length, 1, 'only the member carries the role, which phones fold away');
    assert.equal(chat.childNodes.indexOf(people[0]), chat.childNodes.indexOf(chat.all(cls('thread-head'))[0]) + 1, 'directly under the head');
    assert.match(chat.all(cls('thread-head'))[0].textContent, /^Request Plan the fair\.Done$/, 'the head row itself is unchanged');
    assert.equal(chat.all(cls('chat-message'))[0].all(cls('sender'))[0].textContent, 'Ana (team member)09:00');
    thread.open({kind: 'request', id: 'o'});
    await new Promise(r => setTimeout(r, 0));
    assert.equal(chat.all(cls('thread-people')).length, 0, 'the owner alone: no line');
    thread.open({kind: 'request', id: 'h'});
    await new Promise(r => setTimeout(r, 0));
    assert.equal(chat.all(cls('thread-people'))[0].textContent, `In this thread: You, ${HOSTILE} (team member) and Ben (team member)`);
    assert.equal(chat.all(n => n.localName === 'img').length, 0, 'a name with markup in it stays text');
  } finally { globalThis.fetch = saved; await done(); }
});

test('10.10: the closed gate has its own data-state and a calm hollow dot from the tokens, the title kept', () => {
  const app = read('app.js'), css = read('style.css');
  const paint = app.slice(app.indexOf('function paintConnection(){'), app.indexOf('function openStream(){'));
  assert.match(paint, /el\.dataset\.state=connected\?'up':closed\?'closed':'down';/, 'Reconnecting… stays down; Gate closed is closed');
  assert.match(paint, /el\.title=closed\?`Gate closed: the host computer is asleep or off\.\$\{g\.lastSeenAt\?` It last answered at /, 'the title still carries the last answer');
  const ours = css.slice(css.indexOf('/* Who is in a request thread (plan 10.12)'), css.indexOf('/* Component grammar'));
  assert.ok(ours.includes('#connection[data-state=closed]::before{background:var(--paper);box-shadow:inset 0 0 0 2px var(--ink-2)}'));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(ours.replace(/#connection/g, '')), 'no colour literals');
  assert.ok(!/:root|--[a-z0-9-]+\s*:/.test(ours), 'no new tokens');
  assert.ok(!/data-state=down/.test(ours), 'Reconnecting… keeps immersive.css’s red dot');
});

// Plan 11.12 (docs/product-plan.md §4.10c): the request thread keeps its follow-ups (F1), says Interrupted or Failed with the reason and
// Retry (F3), labels each working line with its request (F2), copies a result (F6) and offers starters in the empty Mayor thread (F10).
// The browser half (1440 and 375×812, the restart, the clipboard) ran on a scratch server; the rules and the view are checked here.
const TAP = 'min-height:var(--tap)';
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('11.12: the starters are the website’s own asks, 4 to 6 of them, with no coin or season words', () => {
  const site = readFileSync(new URL('../site/src/lib/scenarios.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const asks = [...site.matchAll(/^\s*ask: '([^']*)',$/gm)].map(m => m[1]);
  assert.equal(asks.length, 6, 'the site’s six scenarios');
  assert.ok(STARTERS.length >= 4 && STARTERS.length <= 6, `${STARTERS.length} starters`);
  for (const s of STARTERS) assert.ok(asks.includes(s.text), `${s.label}: its words are a scenario’s ask`);
  assert.equal(new Set(STARTERS.map(s => s.label)).size, STARTERS.length);
  assert.ok(!/coin|season/i.test(JSON.stringify(STARTERS)));
});

test('11.12: a request’s state is its latest turn, and a result is a finished task’s last word to the owner', () => {
  const root = {id: 'r', cat: 'mayor', from: 'owner', status: 'interrupted'}, kid = {id: 'k', cat: 'scholar', from: 'mayor', parent: 'r', status: 'done'};
  const again = {id: 'a', cat: 'mayor', from: 'owner', parent: 'r', status: 'running'};
  const messages = [msg('m1', 'owner', 'mayor', 'Plan the fair.', 1, {task: 'r'}), msg('m2', 'mayor', 'scholar', 'Look.', 2, {task: 'k'}), msg('m3', 'scholar', 'mayor', 'Found.', 3, {task: 'k'})];
  assert.equal(latestTurn(root, messages, [root, kid]), root, 'a delegated child is not a turn');
  assert.equal(latestTurn(root, [...messages, msg('m4', 'owner', 'mayor', 'Plan the fair.', 4, {task: 'a'})], [again, root, kid]), again, 'a Retry or a follow-up is');
  assert.equal(latestTurn(root, [], [root]), root, 'nothing loaded yet: the root');
  const tasks = new Map([['r', {...root, status: 'done'}], ['k', kid], ['q', {id: 'q', status: 'running'}]]);
  const said = [...messages, msg('m5', 'mayor', 'owner', 'Interim.', 5, {task: 'r'}), msg('m6', 'mayor', 'owner', 'The plan.', 6, {task: 'r'}), msg('m7', 'mayor', 'owner', 'Fine.', 7, {task: 'r', aside: true}),
    msg('m8', 'mayor', 'owner', 'Working on it.', 8, {task: 'q'}), msg('m9', 'system', 'owner', 'Restarted.', 9, {task: 'r'})];
  assert.deepEqual([...resultIds(said, tasks)], ['m6'], 'not an interim line, a Q&A aside, a running task’s line, a system line or cat-to-cat talk');
});

test('11.12: a send in the owner’s request thread posts parent; a goal, another cat, a member’s request or the cat’s own chat start new work', () => {
  const cats = [{id: 'mayor', name: 'Mayor'}, {id: 'scholar', name: 'Scholar'}, {id: 'critic', name: 'Critic'}];
  const s = {readOnly: false, paused: false, maxParallelWork: 2, cats, approvals: [], councils: [], goals: [], me: {role: 'owner', id: 'owner'},
    tasks: [{id: 'r', cat: 'mayor', from: 'owner', text: 'Plan the fair.', status: 'done'}, {id: 'm', cat: 'mayor', from: 'owner', text: 'Hi.', status: 'done', by: 'p-ana'}]};
  const thread = {kind: 'request', id: 'r'};
  const plan = planSend('Make it shorter', {state: s, selected: 'mayor', thread});
  assert.deepEqual(plan, {kind: 'chat', cat: 'mayor', text: 'Make it shorter', goal: false, parent: 'r'});
  assert.deepEqual(requestFor(plan, {mode: 'demo'}), {path: 'chat', body: {cat: 'mayor', text: 'Make it shorter', mode: 'demo', parent: 'r'}});
  assert.equal('parent' in planSend('Make it shorter', {state: s, selected: 'mayor'}), false, 'the Mayor’s own chat starts a request');
  assert.deepEqual(planSend('Grow it', {state: s, selected: 'mayor', thread, goal: true}), {kind: 'chat', cat: 'mayor', text: 'Grow it', goal: true}, 'a goal stays a goal');
  assert.deepEqual(planSend('@Critic look', {state: s, selected: 'mayor', thread}), {kind: 'chat', cat: 'critic', text: 'look', goal: false}, 'a mention is new work for that cat');
  assert.equal('parent' in planSend('More', {state: s, selected: 'mayor', thread: {kind: 'request', id: 'm'}}), false, 'the owner cannot follow up on a member’s request (403): new work');
  assert.equal(planSend('More', {state: {...s, me: {role: 'member', id: 'p-ana'}}, selected: 'mayor', thread: {kind: 'request', id: 'm'}}).parent, 'm', 'its member can');
  // A follow-up takes no work slot (plan 11.1), so a full town does not hold it back; new work for another cat still waits.
  const full = {...s, maxParallelWork: 1, tasks: [...s.tasks, {id: 's', cat: 'scholar', from: 'owner', text: 'Read.', status: 'done'}, {id: 'x', cat: 'critic', from: 'owner', text: 'Busy.', status: 'running'}]};
  assert.equal(planSend('And the survey', {state: full, selected: 'scholar', thread: {kind: 'request', id: 's'}}).parent, 's');
  assert.equal(planSend('And the survey', {state: full, selected: 'scholar'}).kind, 'note');
  // /stop in a request thread reaches a running follow-up too.
  const going = {...s, tasks: [...s.tasks, {id: 'f', cat: 'mayor', from: 'owner', parent: 'r', text: 'Shorter.', status: 'running'}, {id: 'k', cat: 'scholar', from: 'mayor', parent: 'f', status: 'running'}]};
  assert.deepEqual(workRoots(going, 'mayor', thread), ['f']);
});

test('11.12 view: an interrupted request says so with its reason and Retry; Retry posts once; the retry’s own state then shows', async () => {
  const why = 'Server restarted during work. Send a new message to retry.';
  const {thread, chat, calls, done} = mount();
  const saved = globalThis.fetch;
  // The thread loaded while the root still ran: the state’s newer copy must win.
  globalThis.fetch = async () => ({ok: true, json: async () => ({messages: [msg('m1', 'owner', 'mayor', 'Plan the fair.', 1, {task: 'r'})], more: false, tasks: [{id: 'r', cat: 'mayor', from: 'owner', text: 'Plan the fair.', status: 'running'}]})});
  try {
    const root = {id: 'r', cat: 'mayor', from: 'owner', text: 'Plan the fair.', status: 'interrupted', result: why}, page = {messages: [], tasks: []};
    thread.paint({page, state: state({tasks: [root]}), selected: 'mayor'});
    thread.open({kind: 'request', id: 'r'});
    await tick();
    const head = () => chat.all(cls('thread-head'))[0].textContent, trouble = () => chat.all(cls('thread-trouble'));
    assert.match(head(), /^Request Plan the fair\.Interrupted$/, 'Interrupted, not Stopped, from the state’s copy of the root');
    assert.equal(trouble()[0].textContent, `${why}Retry`);
    assert.equal(chat.childNodes.indexOf(trouble()[0]), chat.childNodes.indexOf(chat.all(cls('thread-head'))[0]) + 1, 'directly under the head');
    const retry = chat.all(cls('thread-retry'))[0];
    assert.equal(retry.style.cssText, TAP, 'a 44px target');
    retry.click();
    assert.deepEqual(calls.at(-1), ['tasks/r/retry', {}]);
    assert.equal(retry.disabled, true, 'a second tap sends nothing while the first is on its way');
    // The Retry runs as a child of the same root, from the owner: the request reads Working and offers no second Retry.
    const again = {id: 'a', cat: 'mayor', from: 'owner', parent: 'r', text: 'Plan the fair.', status: 'running'}, said = [msg('m2', 'owner', 'mayor', 'Plan the fair.', 2, {task: 'a'})];
    thread.paint({page, state: state({tasks: [root, again], messages: said}), selected: 'mayor'});
    assert.match(head(), /^Request Plan the fair\.Working$/);
    assert.equal(trouble().length, 0);
    assert.equal(chat.all(n => n.localName === 'article').length, 2, 'the Retry’s words sit in the same thread');
    // It failed too: Failed, its reason, and Retry again (the root is still the one that broke).
    thread.paint({page, state: state({tasks: [root, {...again, status: 'failed', result: 'Claude plan call timed out.'}], messages: said}), selected: 'mayor'});
    assert.match(head(), /^Request Plan the fair\.Failed$/);
    assert.equal(trouble()[0].textContent, 'Claude plan call timed out.Retry');
    thread.paint({page, state: state({tasks: [root], readOnly: true}), selected: 'mayor'});
    assert.equal(trouble()[0].textContent, why, 'a viewer reads why, with no Retry');
  } finally { globalThis.fetch = saved; await done(); }
});

test('11.12 view: a result gets Copy, which puts the words the bubble shows on the clipboard', async () => {
  const copied = [];
  let blocked = false;
  const {thread, chat, done} = mount({clipboard: {writeText: async text => { if (blocked) throw new Error('denied'); copied.push(text); }}});
  try {
    const messages = [msg('m1', 'owner', 'mayor', 'Plan the fair.', 1, {task: 'r'}), msg('m2', 'mayor', 'owner', '[Demonstration] Here is the plan.', 2, {task: 'r'}), msg('m3', 'mayor', 'owner', 'Still going.', 3, {task: 'q'})];
    const s = state({messages, tasks: [{id: 'r', cat: 'mayor', from: 'owner', text: 'Plan the fair.', status: 'done'}, {id: 'q', cat: 'mayor', from: 'owner', text: 'Sweep.', status: 'running'}]});
    thread.paint({page: {messages, tasks: []}, state: s, selected: 'mayor'});
    const copy = () => chat.all(cls('chat-copy'));
    assert.equal(copy().length, 1, 'the finished request’s reply only');
    assert.equal(copy()[0].style.cssText, TAP, 'a 44px target');
    copy()[0].click();
    await tick(20);
    assert.deepEqual(copied, ['Here is the plan.'], 'the words shown, without the Demonstration tag the note above already says');
    assert.equal(copy()[0].textContent, 'Copied');
    blocked = true;
    copy()[0].click();
    await tick(20);
    assert.equal(copy()[0].textContent, 'Copy it by hand', 'a blocked clipboard says so');
  } finally { await done(); }
});

test('11.12 view: the empty Mayor thread offers Try a delegation and the starters; a chip fills the composer and sends nothing', async () => {
  const filled = [];
  const {thread, chat, calls, done} = mount({fill: text => filled.push(text)});
  try {
    thread.paint({page: {messages: [], tasks: []}, state: state(), selected: 'mayor'});
    const chips = chat.all(cls('starter'));
    assert.deepEqual(chips.map(c => c.textContent), STARTERS.map(s => s.label));
    assert.ok(chips.every(c => c.style.cssText === TAP), 'each a 44px target');
    assert.equal(chat.all(n => n.attrs.id === 'try-demo').length, 1, 'Try a delegation stays');
    chips[1].click();
    assert.deepEqual(filled, [STARTERS[1].text]);
    assert.deepEqual(calls, [], 'nothing is posted');
    thread.paint({page: {messages: [], tasks: []}, state: state({readOnly: true}), selected: 'mayor'});
    assert.equal(chat.all(cls('starter')).length, 0, 'a viewer gets none');
    thread.paint({page: {messages: [], tasks: []}, state: state(), selected: 'scholar'});
    assert.equal(chat.all(cls('starter')).length, 0, 'the starters are the Mayor’s');
  } finally { await done(); }
});

test('11.12 view: in a cat’s chat each working line says which request it serves; in a request thread the head already does', async () => {
  const {thread, live, done} = mount();
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, json: async () => ({messages: [], more: false, tasks: []})});
  try {
    const tasks = [{id: 'r1', cat: 'mayor', from: 'owner', text: 'Draft three names for a cat cafe', status: 'waiting'}, {id: 'r2', cat: 'mayor', from: 'owner', text: 'Plan the fair', status: 'waiting'}];
    const page = {messages: [], tasks: []}, s = state({tasks});
    thread.paint({page, state: s, selected: 'mayor'});thread.live({page, state: s, selected: 'mayor'});
    assert.deepEqual(live.all(cls('decision-for')).map(a => [a.textContent, a.getAttribute('href')]), [['For: Draft three names for a cat cafe', '#thread=r1'], ['For: Plan the fair', '#thread=r2']]);
    assert.deepEqual(live.all(n => n.attrs.role === 'status').map(n => n.textContent), ['Mayor needs your answer', 'Mayor needs your answer'], 'the status words are unchanged');
    thread.open({kind: 'request', id: 'r1'});
    thread.live({page, state: s, selected: 'mayor'});
    assert.equal(live.all(cls('decision-for')).length, 0);
    assert.equal(live.all(cls('live-line')).length, 1);
  } finally { globalThis.fetch = saved; await done(); }
});

// The chat composer (plan 8.7): Send, the pending "sending" bubble, per-thread drafts, the thread switcher, @cat mentions,
// built-in / commands and "/" to focus. The pure rules come first, so the tests import them without a DOM; createComposer
// takes its elements and app.js's state as arguments. app.js creates it in one line, calls paint() from render() and count()
// where the "needs you" count changes.
//
// Contract with the thread view (plan 8.6, chat-thread.js, which this module never edits):
// - On Send the composer pushes {id, text, at, afterId, status:'sending'} to page.pending, where page is the cat's object in
//   app.js's chatPages, and renders once. afterId is the id of the newest message in that chat at Send time. The thread
//   view draws the item and drops it once the journaled message arrives.
// - The composer itself removes the item of a goal or a decision answer once its POST succeeds (neither is journaled as the
//   owner's own words), and any other item still 'sending' 5 s after its POST succeeded.
// - A failed POST sets status:'failed'. A click on [data-retry="<id>"] or [data-discard="<id>"] anywhere in the page, or
//   composer.retry(id) / composer.discard(id), removes the item; retry sends the same message again.
// - The switcher calls chatThread.open({kind, id}) and reads chatThread.current(), both guarded until 8.6 lands. Until then
//   nothing draws a failed bubble, so a failed send puts its text back in the box, as before.
import {icon} from './icons.js';
import {uiSound} from './ui-sounds.js';
import {mountSlashList} from './slash-commands.js';
import {chatMessages} from './state-delta.js';
import {fitComposer} from './chat-sheet.js';
import {parseReasoning, startingReasoning} from './ai-settings.js';
import {syncAskToggle} from './ask-mayor.js';
import {isRefusal} from './decision-strip.js';
import {confirmDialog} from './dialogs.js';

const LIVE = ['running', 'waiting', 'waiting_child'];
const active = task => LIVE.includes(task?.status);
const short = (text, max = 60) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

// ---------------------------------------------------------------------------------------------------------------- threads

/** A thread's key: "mayor:mayor", "cat:<cat>", "request:<task>" or "goal:<goal>". */
export const threadKey = thread => `${thread.kind}:${thread.id}`;

/** A cat's own chat: the Mayor's thread for the Mayor, a cat thread for any other cat. */
export const catThread = cat => (cat === 'mayor' ? {kind: 'mayor', id: 'mayor'} : {kind: 'cat', id: String(cat)});

/** The root of a task's delegation chain among the state's tasks (the task itself when it has no parent there). */
export function rootTask(tasks, id) {
  const byId = new Map((tasks ?? []).map(t => [t.id, t]));
  let task = byId.get(id);
  const seen = new Set();
  while (task?.parent && byId.has(task.parent) && !seen.has(task.id)) { seen.add(task.id); task = byId.get(task.parent); }
  return task ?? null;
}

/**
 * The thread open now. chat-thread.js says which once 8.6 lands (current() → {kind, id}). Before that, or when what it says
 * does not belong to the selected cat (app.js's `selected` stays the source of truth), it is the selected cat's chat.
 */
export function resolveThread(current, selected, state) {
  const own = catThread(selected);
  if (!current || typeof current.kind !== 'string') return own;
  if (current.kind === 'mayor') return own;
  if (current.id === undefined || current.id === null || current.id === '') return own;
  const thread = {kind: current.kind, id: String(current.id)};
  if (thread.kind === 'goal') return selected === 'mayor' ? thread : own;
  if (thread.kind === 'request') {
    const task = (state?.tasks ?? []).find(t => t.id === thread.id);
    return !task || task.cat === selected ? thread : own;
  }
  return own;
}

/** The roots of the work running in a thread: a request's own task and its follow-ups (plan 11.1), a goal's rounds, or every tree the cat is working in. */
export function workRoots(state, cat, thread = catThread(cat)) {
  const tasks = state?.tasks ?? [];
  if (thread?.kind === 'request') return tasks.filter(t => (t.id === thread.id || (t.parent === thread.id && t.from === 'owner')) && active(t)).map(t => t.id);
  if (thread?.kind === 'goal') return tasks.filter(t => !t.parent && t.goal === thread.id && active(t)).map(t => t.id);
  const roots = new Set();
  for (const t of tasks) if (t.cat === cat && active(t)) roots.add(rootTask(tasks, t.id)?.id ?? t.id);
  return [...roots];
}

const catName = (state, id) => (state?.cats ?? []).find(c => c.id === id)?.name ?? (id === 'mayor' ? 'Mayor' : String(id));
const STATUS_WORDS = {running: 'Working', waiting_child: 'Working', waiting: 'Needs you', queued: 'Queued', done: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped'};
function catStatus(state, id) {
  const tasks = (state?.tasks ?? []).filter(t => t.cat === id && active(t));
  return tasks.some(t => t.status === 'waiting') ? 'Needs you' : tasks.length ? 'Working' : 'At ease';
}

/** A thread's title: the cat's name, the request's first line or the goal's title. */
export function threadTitle(thread, state) {
  if (thread.kind === 'request') return short((state?.tasks ?? []).find(t => t.id === thread.id)?.text, 48) || 'A request';
  if (thread.kind === 'goal') return short((state?.goals ?? []).find(g => g.id === thread.id)?.title, 48) || 'A goal';
  return catName(state, thread.id);
}

/** The switcher's accessible name, as chat-ux §6 words it: "Mayor thread, 2 waiting on you". */
export function switcherLabel(thread, state, waiting = 0) {
  const title = threadTitle(thread, state);
  const base = thread.kind === 'request' ? `Request thread: ${title}` : thread.kind === 'goal' ? `Goal thread: ${title}` : `${title} thread`;
  return waiting > 0 ? `${base}, ${waiting} waiting on you` : base;
}

export const REQUESTS_SHOWN = 6, GOALS_SHOWN = 6;

/**
 * The switcher's list, in groups: Waiting on you (pinned first, when anything waits and the Inbox can open), the Mayor, recent
 * requests, live goals, then the other cats. Each item is {kind, id, name, meta, current}.
 */
export function threadOptions(state, thread, {waiting = 0, inbox = false} = {}) {
  const same = item => item.kind === thread?.kind && item.id === thread?.id;
  const mark = item => ({...item, current: same(item)});
  const groups = [];
  if (inbox && waiting > 0) groups.push({label: null, items: [{kind: 'inbox', id: 'inbox', name: `Waiting on you (${waiting})`, meta: '', current: false}]});
  const cats = state?.cats ?? [];
  if (cats.some(c => c.id === 'mayor')) groups.push({label: null, items: [mark({kind: 'mayor', id: 'mayor', name: catName(state, 'mayor'), meta: catStatus(state, 'mayor')})]});
  const requests = (state?.tasks ?? []).filter(t => !t.parent && !t.goal && !t.record && !t.routine).slice(-REQUESTS_SHOWN).reverse()
    .map(t => mark({kind: 'request', id: t.id, name: short(t.text, 48) || 'A request', meta: STATUS_WORDS[t.status] ?? '', cat: t.cat}));
  if (requests.length) groups.push({label: 'Requests', items: requests});
  const goals = (state?.goals ?? []).filter(g => g.status === 'active' || g.status === 'paused').slice(-GOALS_SHOWN).reverse()
    .map(g => mark({kind: 'goal', id: g.id, name: short(g.title, 48) || 'A goal', meta: g.status === 'paused' ? 'Paused' : 'Running'}));
  if (goals.length) groups.push({label: 'Goals', items: goals});
  const others = cats.filter(c => c.id !== 'mayor').map(c => mark({kind: 'cat', id: c.id, name: c.name ?? c.id, meta: catStatus(state, c.id)}));
  if (others.length) groups.push({label: 'Cats', items: others});
  return groups;
}

// ----------------------------------------------------------------------------------------------------------------- drafts

export const DRAFTS_KEY = 'cat-town-drafts', DRAFTS_KEPT = 40;

/** localStorage, or null where the browser refuses it (a private window, blocked site data, a sandboxed frame). */
export function safeStorage(win = globalThis) {
  try {
    const storage = win?.localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch { return null; }
}

/**
 * Per-thread drafts. They live in memory, so switching away and back always keeps them, and are saved to storage as one JSON
 * object (the newest DRAFTS_KEPT) a moment after typing stops, so they also survive a reload. Every storage call is in
 * try/catch: without storage, drafts last this visit.
 */
export function createDrafts({storage = safeStorage(), key = DRAFTS_KEY, kept = DRAFTS_KEPT, now = () => Date.now(), delay = 400, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let drafts = null, timer = null;
  function load() {
    if (drafts) return drafts;
    drafts = new Map();
    try {
      const saved = JSON.parse(storage?.getItem(key) ?? 'null');
      for (const [k, v] of Object.entries(saved?.drafts ?? {})) if (typeof v?.text === 'string' && v.text.trim()) drafts.set(k, {text: v.text, at: Number(v.at) || 0});
    } catch { /* unreadable: start empty */ }
    return drafts;
  }
  function flush() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!storage) return;
    const newest = [...load()].sort((a, b) => b[1].at - a[1].at).slice(0, kept);
    try {
      if (newest.length) storage.setItem(key, JSON.stringify({drafts: Object.fromEntries(newest)}));
      else storage.removeItem(key);
    } catch { /* full or blocked: the drafts last this visit */ }
  }
  return {
    get: k => load().get(k)?.text ?? '',
    set(k, text) {
      const value = String(text ?? '');
      if (value.trim()) load().set(k, {text: value, at: now()}); else load().delete(k);
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, delay);
    },
    flush,
  };
}

// ------------------------------------------------------------------------------------------------- mentions and commands

const AT = /^[@＠]/;

/**
 * "@Scholar …" at the start sends to that cat (chat-ux §3.4). The longest cat name or id that the text starts with wins, in
 * any case, when a space, punctuation or the end follows it. Returns {cat, text} with the rest, or null.
 */
export function parseMention(typed, cats) {
  const text = String(typed ?? '');
  if (!AT.test(text)) return null;
  const after = text.slice(1), low = after.toLowerCase();
  let best = null;
  for (const cat of cats ?? []) {
    for (const word of [cat?.name, cat?.id]) {
      const name = String(word ?? '').trim();
      if (!name || !low.startsWith(name.toLowerCase())) continue;
      const next = after.charAt(name.length);
      if ((next === '' || /[\s,:;.!?]/.test(next)) && (!best || name.length > best.length)) best = {cat: cat.id, length: name.length};
    }
  }
  return best ? {cat: best.cat, text: after.slice(best.length).replace(/^[,:;]\s*/, '').trim()} : null;
}

/**
 * The commands that open a panel instead of sending (docs/design/menu-chat-mailman.md): the command's name and the manage.js key app.js
 * opens. Nothing is sent, so they work while the town is paused or busy.
 */
export const COMMAND_PANELS = Object.freeze({connect: 'postoffice', routines: 'routines', money: 'money', memory: 'memory', autonomy: 'autonomy'});
const PANEL_NAMES = {postoffice: 'The Post office', routines: 'Routines', money: 'The Moonvault', memory: 'Memory', autonomy: 'The Mayor’s autonomy'};

/** The composer's own commands (chat-ux §3.4), listed before the plugins' commands. args: whether text follows the name. */
export const BUILTIN_COMMANDS = Object.freeze([
  Object.freeze({name: 'goal', argumentHint: 'what to achieve', description: 'Give the Mayor an ongoing goal', args: true}),
  Object.freeze({name: 'ask', argumentHint: 'your question', description: 'Ask how it’s going, without interrupting', args: true}),
  Object.freeze({name: 'pause', argumentHint: '', description: 'Pause the town', args: false}),
  Object.freeze({name: 'resume', argumentHint: '', description: 'Wake the town', args: false}),
  Object.freeze({name: 'stop', argumentHint: '', description: 'Stop the work in this thread', args: false}),
  Object.freeze({name: 'connect', argumentHint: '', description: 'Open the Post office: channels, sign-ins and apps', args: false}),
  Object.freeze({name: 'routines', argumentHint: '', description: 'Open Routines: work the cats do on a schedule', args: false}),
  Object.freeze({name: 'money', argumentHint: '', description: 'Open the Moonvault: money and usage', args: false}),
  Object.freeze({name: 'memory', argumentHint: '', description: 'Open Memory: the pages the cats keep', args: false}),
  Object.freeze({name: 'autonomy', argumentHint: '', description: 'Open the Mayor’s autonomy', args: false}),
]);

/**
 * The built-ins worth listing now: /goal in the Mayor's chat, /pause or /resume by the town's state, /stop while work runs, and a panel
 * command where can(key) says this device can open that panel (COMMAND_PANELS).
 */
export function offeredCommands(state, cat, thread = catThread(cat), can = () => true) {
  return BUILTIN_COMMANDS.filter(c => c.name === 'goal' ? cat === 'mayor'
    : c.name === 'pause' ? !state?.paused
    : c.name === 'resume' ? !!state?.paused
    : c.name === 'stop' ? workRoots(state, cat, thread).length > 0
    : COMMAND_PANELS[c.name] ? !!can(COMMAND_PANELS[c.name])
    : true);
}

/** A built-in at the start of the text: {name, args}. Anything else is null; plugin commands go to the server as typed. */
export function parseCommand(typed) {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(typed ?? '').trim());
  const name = m?.[1].toLowerCase();
  return name && BUILTIN_COMMANDS.some(c => c.name === name) ? {name, args: (m[2] ?? '').trim()} : null;
}

// --------------------------------------------------------------------------------------------------------------- the send

/** True while the town is at its parallel limit or a council votes: only the Mayor takes a message then (into its inbox). */
export function townFull(state) {
  return (state?.tasks ?? []).filter(t => !t.parent && active(t)).length >= (state?.maxParallelWork || 1) || !!state?.councils?.some(c => c.status === 'voting');
}

const note = text => ({kind: 'note', note: text});
const PAUSED = 'The town is paused. Type /resume to wake it.';
// A send in a request thread continues that request (plan 11.1's parent) when its sender started it: the server refuses the owner's
// follow-up on a team member's request (and a member's on anyone else's), so that one starts new work as before.
const ownRequest = (state, id) => (state?.tasks ?? []).find(t => t.id === id)?.by === (state?.me?.role === 'member' ? state.me.id : undefined);

function planCommand({name, args}, {state, cat, thread}) {
  if (COMMAND_PANELS[name]) return {kind: 'open', panel: COMMAND_PANELS[name], name};
  if (name === 'goal') {
    if (cat !== 'mayor') return note('Goals belong to the Mayor. Type /goal in the Mayor’s thread.');
    if (!args) return note('Type the goal after /goal.');
    return state.paused ? note(PAUSED) : {kind: 'chat', cat: 'mayor', text: args, goal: true};
  }
  if (name === 'ask') return args ? {kind: 'ask', cat, text: args} : note('Type your question after /ask.');
  if (name === 'pause') return state.paused ? note('The town is already paused.') : {kind: 'command', name, value: true};
  if (name === 'resume') return state.paused ? {kind: 'command', name, value: false} : note('The town is already awake.');
  const tasks = workRoots(state, cat, thread);
  return tasks.length ? {kind: 'command', name: 'stop', cat, tasks} : note('Nothing is running in this thread.');
}

/**
 * What Send does with the typed text, as plain data, so the rules are tested without a DOM or a network:
 * - {kind:'chat', cat, text, goal, parent?}, {kind:'ask', cat, text} or {kind:'answer', approval, cat, text, approved}: a message;
 * - {kind:'command', name, …}: /pause, /resume or /stop;
 * - {kind:'open', panel, name}: /connect, /routines, /money, /memory or /autonomy, which open a panel and send nothing;
 * - {kind:'note', note}: why nothing is sent (the text stays in the box); {kind:'none'}: nothing to do.
 * A mention picks the cat; the reply and ask options apply only to the open cat, and a goal only to the Mayor's own chat. A message
 * in the sender's own request thread carries parent, the request's root (a follow-up takes no work slot).
 */
export function planSend(typed, {state, selected, thread = catThread(selected), connected = true, goal = false, reply = false, askInstead = false} = {}) {
  const text = String(typed ?? '').trim();
  if (!text || !state || state.readOnly) return {kind: 'none'};
  if (!connected) return note('Reconnecting to the town. Your message stays here.');
  const mention = parseMention(text, state.cats);
  const other = !!mention && mention.cat !== selected;
  const cat = mention?.cat ?? selected;
  const body = mention ? mention.text : text;
  const command = parseCommand(body);
  if (command) return planCommand(command, {state, cat, thread: other ? catThread(cat) : thread});
  if (!body) return note(`Write a message after @${catName(state, cat)}.`);
  const pending = (state.approvals ?? []).filter(a => a.status === 'pending');
  if (!other && reply && pending.length === 1) return {kind: 'answer', approval: pending[0].id, cat: pending[0].cat, text: body, approved: !isRefusal(body)};
  if (!other && askInstead) return {kind: 'ask', cat, text: body};
  if (state.paused) return note(PAUSED);
  if (cat !== 'mayor' && (state.tasks ?? []).some(t => t.cat === cat && active(t))) return note(`${catName(state, cat)} is working. Ask how it’s going with /ask, or wait for it to finish.`);
  const asGoal = !!goal && cat === 'mayor' && selected === 'mayor';
  const parent = !other && !asGoal && thread?.kind === 'request' && ownRequest(state, thread.id) ? thread.id : null;
  if (cat !== 'mayor' && !parent && townFull(state)) return note('Every work slot is busy. The Mayor takes messages in its inbox; other cats wait for a free slot.');
  return {kind: 'chat', cat, text: body, goal: asGoal, ...(parent ? {parent} : {})};
}

/** The POST for a message or for /pause and /resume ({path, body} for app.js's api()); /stop posts once per task instead. */
export function requestFor(plan, reasoning = {mode: 'demo'}) {
  if (plan.kind === 'chat') return {path: 'chat', body: {cat: plan.cat, text: plan.text, ...reasoning, ...(plan.goal ? {goal: true} : {}), ...(plan.parent ? {parent: plan.parent} : {})}};
  if (plan.kind === 'ask') return {path: 'ask', body: {cat: plan.cat, text: plan.text, mode: reasoning.mode}};
  if (plan.kind === 'answer') return {path: `approvals/${encodeURIComponent(plan.approval)}`, body: {answer: plan.text, approved: plan.approved}};
  if (plan.kind === 'command' && (plan.name === 'pause' || plan.name === 'resume')) return {path: 'pause', body: {value: plan.value}};
  return null;
}

// The route's body cap, src/uploads.ts UPLOAD_CAP (the composer test holds the two equal, and the words equal its 413). Checked
// before sending because a browser cannot read that early 413: Chromium reports the cut-off upload as a network error.
export const UPLOAD_CAP = 20 * 1024 * 1024;

/**
 * One file to the owner's upload route (plan 11.22, src/uploads.ts): the bytes as the body, the name URI-encoded in X-File-Name.
 * Resolves the saved artifact {id, title, kind, mime, size}; a refusal (not the owner, too big, a type Clowder does not keep)
 * throws with the server's own words.
 */
export async function uploadFile(file, fetchFn = globalThis.fetch) {
  if (file.size > UPLOAD_CAP) throw new Error(`This file is larger than the ${UPLOAD_CAP / 1024 / 1024} MB limit.`);
  let response;
  try {
    response = await fetchFn('/api/uploads', {method: 'POST', headers: {'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Town-Action': 'owner'}, body: file});
  } catch { throw new Error('It did not reach Clowder. Check the connection and try again.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Clowder could not keep this file.');
  return body;
}

let pendingCount = 0;
/** The pending message the thread view draws at once (plan 8.6): exactly {id, text, at, afterId, status:'sending'}. */
export function pendingItem({text, messages = [], at = Date.now()}) {
  pendingCount += 1;
  return {id: `pending-${at.toString(36)}-${pendingCount.toString(36)}`, text, at, afterId: messages.at(-1)?.id ?? null, status: 'sending'};
}

// ------------------------------------------------------------------------------------------------------------ "/" to focus

const NOT_TEXT = /^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i;
/** True for an element that takes typed text: a text-like input, a text box, a select (type-ahead) or editable content. */
export function isTextField(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NOT_TEXT.test(String(target.type || 'text'));
}

/** "/" focuses the composer when focus is not in a text field, no modifier is held and no dialog is open. */
export function wantsComposerFocus(event, {doc = null, readOnly = false} = {}) {
  return event?.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !event.defaultPrevented
    && !readOnly && !isTextField(event.target) && !doc?.querySelector?.('dialog[open]');
}

// ---------------------------------------------------------------------------------------------------------------- wiring

const DEMO_GOAL = {title: 'Start a Demonstration goal?', message: 'Demonstration runs a canned script, no model. Start anyway?', confirmLabel: 'Start anyway', cancelLabel: 'Cancel'};
const REMOVE_ON_SUCCESS_MS = 5000;

/** The composer's own rules (chat-composer.css), linked once next to the module, as the other panels load theirs. */
function linkStyles(doc) {
  if (!doc.head || doc.querySelector?.('link[data-chat-composer]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('chat-composer.css', import.meta.url).href;
  link.setAttribute('data-chat-composer', '');
  doc.head.append(link);
}

// Send to "page.pending holds the item and one render ran" (plan 8.7's proof), as a User Timing entry a probe can read. The
// newest 50 are kept, so a long session does not collect them.
const MEASURE = 'composer:send-to-pending';
function perfMark(start, detail) {
  try {
    const perf = globalThis.performance;
    if (perf.getEntriesByName(MEASURE).length >= 50) perf.clearMeasures(MEASURE);
    perf.measure(MEASURE, {start, end: perf.now(), detail});
  } catch { /* an older browser without measure options: no entry */ }
}
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * Mounts the composer on the chat form. app.js passes its state through getters and its actions as functions:
 * render(), select(cat), api(path, body), notify(error), upload(file) (uploadFile by default), and chatThread (paint, pin, setFollow; open and current from 8.6).
 * Returns {paint, count, submit, retry, discard, focus}: app.js calls paint() from render(), and count() where the "needs you"
 * count changes without a render.
 */
export function createComposer({
  form, doc = globalThis.document, win = globalThis.window ?? globalThis,
  box = doc.getElementById('message'), send = doc.getElementById('send'),
  goalBox = doc.getElementById('goal-mode'), replyBox = doc.getElementById('reply-as-answer-input'), modeSelect = doc.getElementById('mode'),
  chatThread = null, chatPages, askToggle = null,
  getState, selected, connected = () => true, select = () => {}, api, upload = uploadFile, notify = () => {}, render = () => {},
  needsYou = () => 0, openChat = () => {}, openInbox = null, openPanel = () => false, canOpen = () => true,
  drafts = createDrafts({storage: safeStorage(win)}), confirmFirst = confirmDialog, makeIcon = icon, mountList = mountSlashList,
  remembered = cat => { try { return win.localStorage?.getItem(`cat-town-reasoning:${cat}`) ?? null; } catch { return null; } },
  now = () => Date.now(), setTimer = setTimeout,
}) {
  const make = (tag, attrs = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
    node.append(...children.filter(c => c !== null && c !== undefined));
    return node;
  };
  linkStyles(doc);
  const records = new Map();
  let shownKey = null, baseDisabled = null, noteTimer = null, queue = null;

  const safely = fn => { try { return fn(); } catch (error) { console.warn('Thread view:', error); return undefined; } };
  const thread = () => resolveThread(safely(() => chatThread?.current?.()), selected(), getState());
  const keyOf = t => `${getState()?.activeWorld?.id ?? ''}|${threadKey(t)}`;
  // 8.6 draws page.pending, failed items included; the 8.1 thread view does not, so a failed send goes back in the box.
  const drawsPending = () => typeof chatThread?.current === 'function';

  // The note above the box: why Enter did nothing. One live region, cleared by typing or after a few seconds.
  const noteBox = make('p', {class: 'composer-note', role: 'status', hidden: true});
  form.prepend(noteBox);
  function say(text) {
    noteBox.textContent = text;
    noteBox.hidden = !text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimer(() => say(''), 8000);
  }

  // The thread switcher: one button before the Options chip, on the small controls' row (chat-composer.css says where that row
  // is its own). Its list of threads is a popover above the composer, like the Options one, so opening it moves nothing. A plain
  // list: a screen reader says how many threads there are.
  const chip = doc.getElementById('composer-options');
  const count = make('span', {class: 'thread-switch-count', 'aria-hidden': 'true', hidden: true});
  const switcher = make('button', {type: 'button', class: 'thread-switch', title: 'Switch thread', 'aria-expanded': 'false', 'aria-controls': 'thread-list', hidden: true},
    makeIcon('message-circle', {size: 18}), makeIcon('chevron-up', {size: 12}), count);
  const list = make('ul', {id: 'thread-list', class: 'thread-list', 'aria-label': 'Threads', hidden: true});
  form.insertBefore(switcher, chip?.parentNode === form ? chip : box);
  switcher.after(list);
  let options = [];

  function paintList() {
    const state = getState();
    if (!state) return;
    const groups = threadOptions(state, thread(), {waiting: Number(needsYou()) || 0, inbox: typeof openInbox === 'function'});
    options = [];
    const row = item => {
      const meta = item.meta ? make('span', {class: 'thread-option-meta'}, item.meta) : null;
      const button = make('button', {type: 'button', class: 'thread-option', 'aria-current': item.current ? 'true' : null, 'aria-label': [item.name, item.meta].filter(Boolean).join(', ')},
        item.kind === 'inbox' ? makeIcon('inbox', {size: 16}) : null, make('span', {class: 'thread-option-name'}, item.name), meta, item.current ? makeIcon('check', {size: 16}) : null);
      button.addEventListener('click', event => openThread(item, event));
      options.push(button);
      return make('li', {}, button);
    };
    list.replaceChildren(...groups.flatMap(group => group.label
      ? [make('li', {class: 'thread-group'}, make('span', {class: 'thread-group-label', 'aria-hidden': 'true'}, group.label), make('ul', {'aria-label': group.label}, ...group.items.map(row)))]
      : group.items.map(row)));
  }
  function setListOpen(open) {
    if (open) paintList();
    list.hidden = !open;
    switcher.setAttribute('aria-expanded', String(open));
    if (open) (options.find(b => b.getAttribute('aria-current') === 'true') ?? options[0])?.focus();
  }
  switcher.addEventListener('click', () => setListOpen(list.hidden));
  // Escape closes the list first; the open sheet stays (app.js closes the sheet on an Escape that reaches the document).
  switcher.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !list.hidden) { setListOpen(false); event.stopPropagation(); event.preventDefault(); }
  });
  list.addEventListener('keydown', event => {
    const at = options.indexOf(doc.activeElement);
    const step = {ArrowDown: 1, ArrowUp: -1}[event.key];
    if (step && options.length) options[(at + step + options.length) % options.length].focus();
    else if (event.key === 'Home' && options.length) options[0].focus();
    else if (event.key === 'End' && options.length) options.at(-1).focus();
    else if (event.key === 'Escape') { setListOpen(false); switcher.focus(); event.stopPropagation(); }
    else return;
    event.preventDefault();
  });
  doc.addEventListener('pointerdown', event => {
    if (!list.hidden && !list.contains(event.target) && !switcher.contains(event.target)) setListOpen(false);
  });

  // Attach (plan 11.26): the button, or files dropped on the chat panel, go to the owner's upload route (11.22, src/uploads.ts), and
  // a line naming each saved artifact goes into the box, so the message the owner sends names it and the cats read it with
  // read_artifact. Owner only, as the route is: readOnly is the server's same isOwner check. The route's size and type rules are not
  // copied here; its refusals are shown in its own words.
  const fileInput = make('input', {type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true'});
  const attach = make('button', {type: 'button', class: 'thread-switch composer-attach', 'aria-label': 'Attach a file', title: 'Attach a file', hidden: true}, makeIcon('plus', {size: 18}));
  list.after(attach, fileInput);
  attach.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const files = [...(fileInput.files ?? [])]; fileInput.value = ''; void attachFiles(files); });
  const dropZone = form.closest?.('#inspector-panel') ?? form;
  const hasFiles = event => !attach.hidden && [...(event.dataTransfer?.types ?? [])].includes('Files');
  dropZone.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  dropZone.addEventListener('drop', event => {
    if (attach.hidden || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    void attachFiles([...event.dataTransfer.files]);
  });
  async function attachFiles(files) {
    const refused = [];
    for (const file of files) {
      say(`Attaching ${file.name}…`);
      try {
        const saved = await upload(file);
        const typed = box.value;
        box.value = `${typed}${typed && !typed.endsWith('\n') ? '\n' : ''}Attached: ${saved.title} (artifact ${saved.id})`;
        if (shownKey !== null) drafts.set(shownKey, box.value);
      } catch (error) { refused.push(`${file.name}: ${error.message}`); }
    }
    say(refused.join(' '));
    if (refused.length) uiSound('error');
    fitComposer(box);
    syncSend();
    if (refused.length < files.length && !win.matchMedia?.('(pointer: coarse)')?.matches) box.focus();
  }
  list.addEventListener('focusout', event => {
    if (!list.hidden && event.relatedTarget && !list.contains(event.relatedTarget) && event.relatedTarget !== switcher) setListOpen(false);
  });

  function openThread(item, event) {
    setListOpen(false);
    if (item.kind === 'inbox') { openInbox?.(); return; }
    const state = getState();
    const cat = item.kind === 'cat' ? item.id : item.kind === 'request' ? (item.cat ?? rootTask(state?.tasks, item.id)?.cat ?? 'mayor') : 'mayor';
    if (cat !== selected()) select(cat);
    if (item.kind !== 'cat') safely(() => chatThread?.open?.({kind: item.kind, id: item.id}));
    update();
    // A keyboard pick goes on to typing; a tap leaves the phone keyboard down.
    if (event?.detail === 0 || !win.matchMedia?.('(pointer: coarse)')?.matches) box.focus();
    else switcher.focus();
  }

  // One list for "/" (built-ins first, then plugin commands) and "@" (the other cats), above the text box.
  const suggestions = mountList(box, {
    builtins: () => { const state = getState(); return state ? offeredCommands(state, selected(), thread(), canOpen) : []; },
    cats: () => ({cats: getState()?.cats ?? [], exclude: selected()}),
  });

  const toggles = () => {
    const state = getState();
    return {state, selected: selected(), thread: thread(), connected: !!connected(), goal: !!goalBox?.checked, reply: !!replyBox?.checked, askInstead: !!(askToggle && state && syncAskToggle(askToggle, state, selected()))};
  };
  // render() sets Send for a plain message to the open cat; a command or a mention can still go when that one cannot.
  function syncSend() {
    if (baseDisabled === null || !send) return;
    const kind = planSend(box.value, toggles()).kind;
    send.disabled = baseDisabled && !['chat', 'ask', 'answer', 'command', 'open'].includes(kind);
  }

  /** Called by app.js's render(), right after it set Send for a plain message: keeps that as the base, then updates. */
  function paint() {
    baseDisabled = send ? !!send.disabled : null;
    update();
    if (!openedOnce && getState()) { openedOnce = true; focusAtOpen(); }
  }
  // Gate 8: at open the composer has focus where a mouse is the pointer, so the owner types at once. A touch screen keeps its keyboard
  // down, and nothing moves focus the owner (or an open dialog) already placed, or into a chat that is folded or closed.
  let openedOnce = false;
  function focusAtOpen() {
    if (getState()?.readOnly || !win.matchMedia?.('(pointer: fine)')?.matches) return;
    if ((doc.activeElement && doc.activeElement !== doc.body) || doc.querySelector?.('dialog[open]')) return;
    if (typeof form.getClientRects === 'function' && form.getClientRects().length === 0) return;
    box.focus({preventScroll: true});
  }
  // Swaps the draft when the thread changed, keeps pending items on the page shown now, names the switcher and settles Send.
  // The open thread list is not rebuilt here: renders come with every stream frame, and a rebuild would drop keyboard focus.
  function update() {
    const state = getState();
    if (!state) return;
    const open = thread(), key = keyOf(open);
    if (key !== shownKey) {
      if (shownKey !== null) drafts.set(shownKey, box.value);
      if (shownKey !== null || !box.value.trim()) box.value = drafts.get(key);
      else drafts.set(key, box.value);
      shownKey = key;
      suggestions.close?.();
      say('');
      fitComposer(box);
    }
    carry();
    paintCount(state, open);
    syncSend();
  }
  // The switcher's name and badge carry the one "needs you" count (chat-ux §6), which app.js learns after a render.
  function paintCount(state = getState(), open = thread()) {
    if (!state) return;
    const waiting = Number(needsYou()) || 0;
    switcher.hidden = attach.hidden = !!state.readOnly;
    switcher.setAttribute('aria-label', switcherLabel(open, state, waiting));
    count.hidden = waiting <= 0;
    count.textContent = waiting > 0 ? String(waiting) : '';
  }

  box.addEventListener('input', () => {
    if (shownKey !== null) drafts.set(shownKey, box.value);
    if (!noteBox.hidden) say('');
    syncSend();
  });
  box.onkeydown = event => {
    if (suggestions.onKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  };

  // The reasoning a cat starts on (app.js paintReasoning's rule), so a goal sent to the Mayor from another chat can be checked
  // for Demonstration before the composer opens the Mayor's chat.
  function reasoningOf(cat) {
    const state = getState();
    if (cat === selected()) return parseReasoning(modeSelect?.value);
    return parseReasoning(startingReasoning(state?.models, state?.townDefault, state?.cats?.find(c => c.id === cat)?.ai, remembered(cat)));
  }

  function removeItem(record) {
    const list = record.page?.pending;
    const at = list ? list.findIndex(item => item.id === record.item.id) : -1;
    if (at >= 0) list.splice(at, 1);
    records.delete(record.item.id);
    return at >= 0;
  }

  // POSTs go one after another, so two quick messages reach the town in the order sent; with none in flight, it starts at once.
  // A question (/api/ask) waits for its answer, so it runs beside the queue instead of holding it.
  function post(record) {
    const go = async () => {
      if (record.plan.kind === 'command' && record.plan.name === 'stop') for (const id of record.plan.tasks) await api(`tasks/${encodeURIComponent(id)}/stop`, {});
      else await api(record.request.path, record.request.body);
    };
    let run;
    if (record.plan.kind === 'ask') run = go();
    else {
      run = queue ? queue.then(go, go) : go();
      const settled = run.catch(() => {});
      queue = settled;
      void settled.then(() => { if (queue === settled) queue = null; });
    }
    return run.then(() => sent(record), error => failed(record, error));
  }
  function sent(record) {
    if (!record.item) { if (record.plan.kind === 'command') render(); return; }
    // An answer is journaled as "Approved: …" (or not at all for some gates) and a goal as its first round, so their bubble
    // goes now. Any other one stays for the thread view to swap for the journaled message; this timer only tidies up.
    if (record.plan.kind === 'answer' || record.plan.goal) { if (removeItem(record)) render(); return; }
    setTimer(() => { if (record.item.status === 'sending' && removeItem(record)) render(); }, REMOVE_ON_SUCCESS_MS);
  }
  // A bubble still shows while its page is the cat's page now (a full refetch replaces pages) and still holds it.
  const showing = record => !!record.item && !!record.page && chatPages?.get(record.cat) === record.page && !!record.page.pending?.includes(record.item);
  // A full refetch (app.js refresh) replaces every page: a pending or failed item moves to the new page, so a failed message
  // is never lost. One the thread view dropped (its journaled message came) is forgotten.
  function carry() {
    for (const record of [...records.values()]) {
      const old = record.page, page = chatPages?.get(record.cat);
      if (!old?.pending?.includes(record.item)) { records.delete(record.item.id); continue; }
      if (!page || page === old) continue;
      old.pending.splice(old.pending.indexOf(record.item), 1);
      (page.pending ??= []).push(record.item);
      record.page = page;
    }
  }
  function failed(record, error) {
    uiSound('error');
    notify(error);
    if (drawsPending() && showing(record)) { record.item.status = 'failed'; render(); return; }
    if (record.item) removeItem(record);
    restore(record);
    render();
  }
  // Nothing draws a failed bubble here: the text goes back where it can be sent again, never lost.
  function restore(record) {
    if (!box.value.trim()) {
      box.value = record.typed;
      if (goalBox) goalBox.checked = record.options.goal;
      if (replyBox) replyBox.checked = record.options.reply;
      if (shownKey !== null) drafts.set(shownKey, box.value);
    } else {
      const was = drafts.get(record.from);
      drafts.set(record.from, was.trim() ? `${was}\n${record.typed}` : record.typed);
    }
    drafts.flush();
  }

  /** Sends a plan that is allowed: the box empties, the bubble shows and renders once, then the POST goes. */
  function run(plan, start) {
    const state = getState();
    const typed = box.value, from = shownKey ?? keyOf(thread()), was = thread();
    const options = {goal: !!goalBox?.checked, reply: !!replyBox?.checked};
    box.value = '';
    drafts.set(from, '');
    suggestions.close?.();
    say('');
    if (goalBox) goalBox.checked = false;
    if (replyBox) replyBox.checked = false;
    const message = plan.kind === 'chat' || plan.kind === 'ask';
    // A message to another cat opens that cat's chat; a follow-up (plan.parent) stays in its request thread; any other one typed in a
    // request or goal thread starts new work in the cat's own chat, so the thread view opens that. Either way the bubble shows where the reply will come.
    if (message && plan.cat !== selected()) select(plan.cat);
    else if (message && !plan.parent && (was.kind === 'request' || was.kind === 'goal')) { safely(() => chatThread?.open?.(catThread(plan.cat))); update(); }
    const cat = plan.kind === 'answer' ? plan.cat : plan.cat ?? selected();
    const page = plan.kind !== 'command' && cat === selected() ? chatPages?.get(cat) : null;
    const record = {plan, typed, from, options, request: requestFor(plan, plan.kind === 'command' ? undefined : parseReasoning(modeSelect?.value)), cat, page, item: null};
    if (page) {
      record.item = pendingItem({text: plan.text, messages: chatMessages(page.messages, state?.messages ?? [], cat), at: now()});
      (page.pending ??= []).push(record.item);
      records.set(record.item.id, record);
    }
    chatThread?.setFollow?.(true);
    uiSound('send');
    render();
    if (record.item) perfMark(start, {id: record.item.id, cat, pending: page.pending.length, has: page.pending.includes(record.item)});
    drafts.flush();
    return post(record);
  }

  /** The form's submit: plans the send and runs it, after a confirm where one is needed (a Demonstration goal, several stops). */
  function submit(event) {
    event?.preventDefault?.();
    const start = perfNow();
    const plan = planSend(box.value, toggles());
    if (plan.kind === 'none') return undefined;
    if (plan.kind === 'note') { say(plan.note); return undefined; }
    if (plan.kind === 'open') return openCommand(plan);
    const ask = plan.kind === 'chat' && plan.goal && reasoningOf('mayor').mode === 'demo' ? DEMO_GOAL
      : plan.kind === 'command' && plan.name === 'stop' && plan.tasks.length > 1 ? {title: `Stop ${plan.tasks.length} pieces of work?`, message: `Everything ${catName(getState(), plan.cat)} is working on in this thread stops, and its decisions are cancelled.`, confirmLabel: 'Stop all', cancelLabel: 'Keep working', danger: true}
      : null;
    if (!ask) return run(plan, start);
    const typed = box.value;
    return confirmFirst(ask).then(ok => (ok && box.value === typed ? run(plan, perfNow()) : undefined));
  }
  form.onsubmit = submit;

  // /connect, /routines, /money, /memory and /autonomy: the box empties and the panel opens as a sheet over the thread. Nothing is sent.
  // A panel this device cannot open keeps the text and says so.
  function openCommand(plan) {
    if (!canOpen(plan.panel) || openPanel(plan.panel) === false) { say(`${PANEL_NAMES[plan.panel] ?? 'That panel'} doesn’t open on this device.`); return undefined; }
    box.value = '';
    if (shownKey !== null) drafts.set(shownKey, '');
    suggestions.close?.();
    say('');
    fitComposer(box);
    syncSend();
    return undefined;
  }

  function retry(id) {
    const old = records.get(id);
    if (!old) return false;
    removeItem(old);
    const page = chatPages?.get(old.cat) ?? null, state = getState();
    const record = {...old, page, item: null};
    if (page) {
      record.item = pendingItem({text: old.plan.text, messages: chatMessages(page.messages, state?.messages ?? [], old.cat), at: now()});
      (page.pending ??= []).push(record.item);
      records.set(record.item.id, record);
    }
    uiSound('send');
    render();
    void post(record);
    return true;
  }
  function discard(id) {
    const record = records.get(id);
    if (!record) return false;
    removeItem(record);
    render();
    return true;
  }
  // The thread view draws Retry and Discard on a failed bubble as [data-retry] / [data-discard] buttons holding the item id.
  doc.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-retry],[data-discard]');
    const id = button?.getAttribute('data-retry') ?? button?.getAttribute('data-discard');
    if (!id || !records.has(id)) return;
    event.preventDefault();
    if (button.hasAttribute('data-retry')) retry(id); else discard(id);
  });

  // The chat opens first only when it is closed, or folded to its rail from 900px (plan 8.5: the form is not drawn then): opening an
  // open chat would also jump it to the newest message.
  function focus() {
    let closed = typeof form.getClientRects === 'function' && form.getClientRects().length === 0;
    for (let node = form; node && !closed; node = node.parentNode) if (node.hidden) closed = true;
    if (closed) openChat();
    box.focus();
  }
  doc.addEventListener('keydown', event => {
    if (!wantsComposerFocus(event, {doc, readOnly: !!getState()?.readOnly})) return;
    event.preventDefault();
    focus();
  });
  // "Go to conversation", the page's first Tab stop (index.html), does what "/" does.
  doc.getElementById?.('skip-to-chat')?.addEventListener('click', event => { event.preventDefault(); focus(); });
  // Drafts are saved a moment after typing stops; leaving the page saves them at once.
  win.addEventListener?.('pagehide', () => drafts.flush());
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') drafts.flush(); });

  return {paint, count: () => paintCount(), submit, retry, discard, focus};
}

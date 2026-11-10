// The command palette (plan 8.9, chat-ux §3.4): Ctrl+K or ⌘K opens one box that finds the owner's threads, the cats, every
// surface in app.js SURFACES, the dock's panels, a few actions, and the town's search (GET /api/search, plan 8.4).
// It is a modal dialog holding an editable combobox and its listbox (WAI-ARIA APG). Focus stays in the box, the arrow keys move
// the active option (aria-activedescendant), Enter opens it, and Escape closes the dialog and returns focus to where it was.
// '/' is never bound here, because plan 8.7 uses it to focus the composer.
// Plan 11.7: a button with data-open-palette (the phone dock's More list has Search) opens it too, and "?" opens a one-screen list
// of the keys the app already answers to, which is also a palette row.
// The ranking, the rows and the words come first as pure functions, so the tests run them without a DOM. The dialogs follow.
import {icon} from './icons.js';

// Each surface's name in the palette, in the words of the place it lives (docs/design/menu-chat-mailman.md: ☰, the Post office, the
// Moonvault, a cat's corner), with its / command where it has one. In the Post office area a label is the heading of the dialog the
// row opens, word for word (test/naming-setup-ui.test.mjs walks them), and the words a place used to go by stay in `keywords`, so a
// search for them still finds it. `control` is the control whose visibility says whether this device may open it: probe-gated entries
// stay hidden until their route answers, and `.viewer [data-owner]` and `.remote [data-host]` hide owner-only and host-only ones;
// `controls` offers the surface while any of them shows. With neither the surface is always offered.
export const SURFACE_INFO = {
  memorial: {label: 'Memorial', detail: 'The cats who retired, under the night sky', icon: 'flower-2', keywords: ['retired', 'night sky', 'garden']},
  archive: {label: 'Town Archive', detail: 'Everything the cats made', icon: 'archive', keywords: ['artifacts', 'results', 'files', 'notice board']},
  season: {label: 'Coins', detail: 'The coin economy and its season', icon: 'coins', keywords: ['season', 'economy'], control: 'treasury-season'},
  models: {label: 'AI models', detail: 'Choose the models your cats think with', icon: 'sparkles', keywords: ['brain', 'sign in', 'provider', 'reasoning'], control: 'models-open'},
  connectors: {label: 'Connectors & plugins', detail: 'Post office · connect apps and add plugins for your cats', icon: 'wrench', keywords: ['apps', 'plugins', 'mcp', 'tools', 'the connectors'], control: 'connectors-open'},
  devices: {label: 'Devices', detail: 'Pair a phone or tablet, or open Wi-Fi viewing', icon: 'smartphone', keywords: ['pair', 'phone', 'remote access', 'tailscale', 'share'], control: 'share'},
  treasury: {label: 'Money', detail: 'The Moonvault: money and usage · /money', icon: 'coins', keywords: ['moonvault', 'treasury', 'balance', 'budget', 'banker']},
  studio: {label: 'Customize cats & homes', detail: 'Look, costume and home for each cat', icon: 'palette', keywords: ['studio', 'look', 'costume', 'house'], control: 'menu-studio'},
  worlds: {label: 'Worlds', detail: 'Switch to another world or start one', icon: 'globe', keywords: ['world', 'travel']},
  routines: {label: 'Routines', detail: 'The Mayor’s corner · work the cats do on a schedule · /routines', icon: 'refresh-cw', keywords: ['schedule', 'daily', 'briefing', 'recurring'], control: 'routines-open'},
  telegram: {label: 'Telegram', detail: 'Post office · talk to the Mayor from your Telegram chat', icon: 'send', keywords: ['chat app', 'bot', 'channel'], control: 'telegram-open'},
  memory: {label: 'Memory', detail: 'The Archivist’s corner · pages the cats keep · /memory', icon: 'book-open', keywords: ['wiki', 'notes', 'knowledge', 'archivist'], control: 'memory-open'},
  usage: {label: 'Usage', detail: 'The Moonvault · tokens used and the monthly cap', icon: 'cpu', keywords: ['tokens', 'cost', 'cap', 'spend', 'banker'], control: 'usage-open'},
  discord: {label: 'Discord', detail: 'Post office · talk to the Mayor from a Discord DM', icon: 'message-circle', keywords: ['chat app', 'bot', 'channel'], control: 'discord-open'},
  accounts: {label: 'Accounts & connections', detail: 'Post office · sign in to services and choose what your cats may use', icon: 'key-round', keywords: ['sign in', 'sign-ins', 'google', 'microsoft', 'grants', 'the accounts', 'apps', 'choose apps', 'open apps', 'manage apps'], control: 'accounts-open'},
  clients: {label: 'Sign-in clients', detail: 'Post office, advanced · your own Google and Microsoft clients', icon: 'settings', keywords: ['oauth', 'client id'], control: 'owner-clients-open'},
  mail: {label: 'Email to the Mayor', detail: 'Post office · mail under one Gmail label goes to the Mayor', icon: 'inbox', keywords: ['gmail', 'email', 'label', 'channel'], control: 'mail-watch-open'},
  ntfy: {label: 'Android ping', detail: 'Post office · ping a phone through ntfy when Clowder needs you', icon: 'bell', keywords: ['ntfy', 'notification', 'push', 'channel'], control: 'ntfy-open'},
  postoffice: {label: 'Post office', detail: 'The Mailman’s channels, sign-ins and apps · /connect', icon: 'send', keywords: ['mailman', 'channels', 'sign-ins', 'sign in', 'apps', 'connect', 'mail'],
    controls: ['telegram-open', 'discord-open', 'mail-watch-open', 'ntfy-open', 'accounts-open', 'owner-clients-open', 'connectors-open']},
  autonomy: {label: 'Mayor\'s autonomy', detail: 'The Mayor’s corner · how much it decides on its own · /autonomy', icon: 'gauge', keywords: ['autonomy', 'cautious', 'balanced', 'full', 'ask first'], control: 'autonomy-open'},
  backups: {label: 'Backups', detail: 'Encrypted backups of this town, and Restore', icon: 'copy', keywords: ['backup', 'restore', 'recovery key', 'archivist'], control: 'backups-open'},
};

// The dock's panels (data-toggle-panel buttons). Their names and icons are read from the dock itself, so a renamed dock still
// lists right; these add a line of detail and words people may type.
export const PANEL_INFO = {
  residents: {detail: 'Every cat in town', keywords: ['residents', 'cats']},
  inspector: {detail: 'The open conversation and its work', keywords: ['chat', 'conversation', 'messages']},
  projects: {detail: 'Goals, requests and their work', keywords: ['goals', 'requests', 'work']},
  quests: {detail: 'Decisions and steps waiting on you', keywords: ['inbox', 'needs you', 'decisions', 'to-do']},
  diary: {detail: 'Who talked to whom, and what finished', keywords: ['log', 'activity', 'history']},
};

export const GROUP_TITLES = {actions: 'Actions', threads: 'Threads', cats: 'Cats', places: 'Go to', artifacts: 'Artifacts', requests: 'Requests', messages: 'Messages', memory: 'Memory pages'};
const ORDER = Object.keys(GROUP_TITLES);
// Search hits arrive after the rest, so they always come last and never move the rows under the cursor.
const LATE = new Set(['artifacts', 'requests', 'messages', 'memory']);
// How many rows a group shows: with nothing typed, and once something is typed.
export const CAPS = {empty: {threads: 6}, typed: {threads: 8, artifacts: 5, requests: 5, messages: 8, memory: 5}};
// Shorter search words than this match too much of the journal to be worth a request.
export const MIN_SEARCH = 2;
// The search route's own limit on q.
const MAX_QUERY = 200;

const ACTIVE = new Set(['running', 'waiting', 'waiting_child']);
const TASK_WORDS = {running: 'working', waiting: 'needs you', waiting_child: 'working', pending: 'queued', queued: 'queued', done: 'done', failed: 'failed', cancelled: 'stopped', interrupted: 'interrupted'};

/** Lower case, accents and extra spaces dropped: "Café  Notes" -> "cafe notes". */
export const fold = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** One line of at most max characters, cut at a word where it can be. */
export function oneLine(text, max = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1), space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. Empty for a time that cannot be read. */
export function when(at, now = Date.now()) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.round((now - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days} d ago` : new Date(t).toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
}

/** A name for a cat id, as app.js names them: current cats, then retired ones, then the owner and the town. */
export function nameOf(state, id) {
  return state?.cats?.find(c => c.id === id)?.name ?? state?.retiredCats?.find(c => c.id === id)?.name ?? ({owner: 'You', system: 'Town', town: 'Town'})[id] ?? String(id ?? '');
}

/** The Cats panel's status words for one cat. */
export function catStatus(state, id) {
  const tasks = (state?.tasks ?? []).filter(t => t.cat === id && ACTIVE.has(t.status));
  return tasks.some(t => t.status === 'waiting') ? 'Needs you' : tasks.length ? 'Working' : 'At ease';
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const startsWord = word => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(word)}`, 'u');
const wordHit = (text, word, starts) => (!text ? 0 : starts.test(text) ? 3 : text.includes(word) ? 1 : 0);

/**
 * How well one row matches what was typed. 0 means no match. Every typed word must be found in the label, a keyword or the
 * detail. The label counts most, a word start counts more than a match inside a word, and a label equal to the query or
 * starting with it wins outright.
 */
export function matchScore(item, query) {
  const q = fold(query);
  if (!q) return 1;
  const label = fold(item.label), keys = (item.keywords ?? []).map(fold).filter(Boolean), detail = fold(item.detail);
  let score = 0;
  for (const word of q.split(' ')) {
    const starts = startsWord(word);
    const best = Math.max(wordHit(label, word, starts) * 4, ...keys.map(k => wordHit(k, word, starts) * 2), wordHit(detail, word, starts));
    if (!best) return 0;
    score += best;
  }
  const bonus = label === q ? 100 : label.startsWith(q) ? 60 : startsWord(q).test(label) ? 40 : keys.includes(q) ? 30 : label.includes(q) ? 20 : keys.some(k => k.startsWith(q)) ? 15 : 0;
  return score + bonus;
}

/**
 * The listbox's groups for a query. With nothing typed: the suggested actions, the newest threads, every cat and every place,
 * in that order. Once something is typed: every matching row, best first, and the groups ordered by their best row, so Enter
 * opens the best match. Search hits keep the server's order and come last.
 */
export function arrange(items, query) {
  const typed = fold(query) !== '', caps = typed ? CAPS.typed : CAPS.empty;
  const groups = new Map(ORDER.map(key => [key, []]));
  for (const item of items) {
    const list = groups.get(item.group);
    if (!list) continue;
    if (LATE.has(item.group)) { if (typed) list.push({...item, score: 0}); continue; }
    if (!typed) { if (item.group !== 'actions' || item.suggest) list.push({...item, score: 0}); continue; }
    const score = matchScore(item, query);
    if (score > 0) list.push({...item, score});
  }
  const out = [];
  for (const key of ORDER) {
    let list = groups.get(key);
    if (typed && !LATE.has(key)) list = list.map((item, i) => ({item, i})).sort((a, b) => b.item.score - a.item.score || a.item.label.length - b.item.label.length || a.i - b.i).map(r => r.item);
    if (caps[key]) list = list.slice(0, caps[key]);
    if (list.length) out.push({key, title: GROUP_TITLES[key], items: list, best: list[0].score});
  }
  if (typed) out.sort((a, b) => Number(LATE.has(a.key)) - Number(LATE.has(b.key)) || b.best - a.best || ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  return out;
}

/** Splits text into plain and marked parts: the first place each typed word appears, a word start first. */
export function marks(text, query) {
  const source = String(text ?? ''), lower = source.toLowerCase(), taken = [];
  const words = [...new Set(fold(query).split(' ').filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const word of words) {
    const free = i => i >= 0 && !taken.some(([a, b]) => i < b && i + word.length > a);
    const atStart = [...lower.matchAll(new RegExp(startsWord(word).source, 'gu'))].map(m => m.index + m[0].length - word.length).find(free);
    let at = atStart ?? -1;
    for (let i = lower.indexOf(word); at < 0 && i >= 0; i = lower.indexOf(word, i + 1)) if (free(i)) at = i;
    if (at >= 0) taken.push([at, at + word.length]);
  }
  taken.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let from = 0;
  for (const [a, b] of taken) {
    if (a > from) parts.push({text: source.slice(from, a), mark: false});
    parts.push({text: source.slice(a, b), mark: true});
    from = b;
  }
  if (from < source.length || !parts.length) parts.push({text: source.slice(from), mark: false});
  return parts;
}

/**
 * A long line shown from a few words before the first typed word, so the match is in view however narrow the row: the row's own
 * ellipsis cuts the end. A match near the start leaves the line as it is.
 */
export function around(text, query, lead = 24, max = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim(), lower = flat.toLowerCase();
  const found = fold(query).split(' ').filter(Boolean).map(w => lower.indexOf(w)).filter(i => i >= 0);
  const at = found.length ? Math.min(...found) : -1;
  if (at <= lead) return flat.slice(0, max);
  const space = flat.indexOf(' ', at - lead);
  const start = space >= 0 && space < at ? space + 1 : at - lead;
  return `…${flat.slice(start, start + max)}`;
}

/** True for Ctrl+K or ⌘K (one of the two, nothing else held), on any keyboard layout. '/' and plain K never open it. */
export function isPaletteKey(e) {
  if (!e || e.altKey || e.shiftKey || e.repeat || e.isComposing || !e.ctrlKey === !e.metaKey) return false;
  const key = String(e.key ?? '');
  return key.toLowerCase() === 'k' || (e.code === 'KeyK' && !/^[a-z]$/i.test(key));
}

/** True on a Mac, iPhone or iPad, where the palette's key is ⌘K. */
export function isMac(win = globalThis.window) {
  const nav = win?.navigator;
  return /mac|iphone|ipad|ipod/i.test(String(nav?.userAgentData?.platform ?? nav?.platform ?? ''));
}

/**
 * The shortcut list (plan 11.7, F16): only keys the app already binds. Ctrl+K or ⌘K is this module's; "/" is chat-composer.js's
 * (plan 8.7); E and Escape are app.js's. "/" and E do nothing on a read-only page, so a viewer's list leaves them out.
 */
export function shortcutRows({mac = false, readOnly = false} = {}) {
  return [
    {keys: [mac ? '⌘' : 'Ctrl', 'K'], what: 'Search threads, cats, places and messages'},
    {keys: ['/'], what: 'Go to the message box', owner: true},
    {keys: ['E'], what: 'Edit the town: move houses. E again to stop', owner: true},
    {keys: ['Esc'], what: 'Close search, a dialog or the open panel'},
    {keys: ['?'], what: 'Show this list'},
  ].filter(row => !(readOnly && row.owner)).map(({keys, what}) => ({keys, what}));
}

// A field that takes typed text, where "?" is a character and not a key to act on (chat-composer.js isTextField's rule).
const NOT_TEXT = /^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i;
const typing = target => !!target && (target.isContentEditable === true || /^(TEXTAREA|SELECT)$/i.test(String(target.tagName ?? ''))
  || (/^INPUT$/i.test(String(target.tagName ?? '')) && !NOT_TEXT.test(String(target.type || 'text'))));

/** True for "?" outside a text field with no Ctrl, ⌘ or Alt held. Shift is allowed: most layouts need it to type "?". */
export function isShortcutsKey(e) {
  return !!e && e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing && !e.defaultPrevented && !typing(e.target);
}

/** One row per surface the device may open, by label. available(name) says whether its control is shown. */
export function surfaceItems(names, available = () => true) {
  return names.filter(name => available(name)).map(name => {
    const info = SURFACE_INFO[name] ?? {label: name.charAt(0).toUpperCase() + name.slice(1), detail: '', icon: 'chevron-right', keywords: []};
    return {id: `surface:${name}`, group: 'places', kind: 'surface', surface: name, label: info.label, detail: info.detail, icon: info.icon, keywords: [name, ...info.keywords]};
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/** One row per cat: opening it opens that cat's chat. */
export function catItems(state) {
  return (state?.cats ?? []).map(c => ({
    id: `cat:${c.id}`, group: 'cats', kind: 'cat', cat: c.id, label: c.name, tint: c.color, icon: 'cat',
    detail: [catStatus(state, c.id), oneLine(c.role, 70)].filter(Boolean).join(' · '), keywords: [c.id],
  }));
}

/**
 * The owner's threads: goals still going (their rounds sit in the Mayor's thread), then the owner's requests, newest first.
 * The snapshot keeps only unfinished tasks, so requests come from the owner's recent messages, plus any unfinished request whose
 * message fell out of them. A request opens its own thread in the chat of the cat that took it, and a goal its thread in the Mayor's.
 */
export function threadItems(state, now = Date.now()) {
  if (!state) return [];
  const rows = [], seen = new Set(), tasks = new Map((state.tasks ?? []).map(t => [t.id, t]));
  const live = id => (state.cats ?? []).some(c => c.id === id);
  for (const g of state.goals ?? []) {
    if (g.status !== 'active' && g.status !== 'paused') continue;
    rows.push({id: `goal:${g.id}`, group: 'threads', kind: 'thread', cat: 'mayor', goal: g.id, label: oneLine(g.title, 90), icon: 'flag', keywords: ['goal'],
      detail: `Goal · ${g.status === 'paused' ? 'paused' : 'going'} · ${g.rounds ?? 0} round${g.rounds === 1 ? '' : 's'}`});
  }
  // A request to a cat that has since retired has no chat to open, so it is left out.
  const request = (task, cat, text, at) => {
    seen.add(task);
    if (!live(cat)) return;
    const t = tasks.get(task);
    rows.push({id: `thread:${task}`, group: 'threads', kind: 'thread', cat, task, label: oneLine(text, 600), long: true, icon: 'message-circle', keywords: ['request'],
      detail: [nameOf(state, cat), t ? TASK_WORDS[t.status] ?? t.status : when(at, now)].filter(Boolean).join(' · ')});
  };
  for (const m of [...(state.messages ?? [])].reverse()) {
    if (m.from === 'owner' && m.task && !m.aside && !seen.has(m.task) && !tasks.get(m.task)?.parent) request(m.task, m.to, m.text, m.at);
  }
  for (const t of state.tasks ?? []) if (!t.parent && t.from === 'owner' && !seen.has(t.id)) request(t.id, t.cat, t.text, null);
  return rows;
}

/**
 * The actions. has(id) says whether that control is shown on this device, and pressed(id) whether it is on. setup: whether the
 * Set up Clowder hub can open here (an owner's). Answer, New goal and Pause are suggested before anything is typed. Answer opens the
 * oldest waiting decision through the same #approval= link a notification uses. Keyboard shortcuts opens the "?" list on every device
 * (plan 11.7); typing "?" or "keys" finds it.
 */
export function actionItems(state, {has = () => true, pressed = () => false, mac = false, setup = false} = {}) {
  const rows = [], owner = !!state && !state.readOnly;
  const pending = (state?.approvals ?? []).filter(a => a.status === 'pending');
  if (owner && pending.length) {
    const next = pending[0];
    rows.push({id: 'action:answer', action: 'answer', approval: next.id, suggest: true, icon: 'inbox', label: 'Answer the next decision',
      detail: `${pending.length > 1 ? `1 of ${pending.length} · ` : ''}${nameOf(state, next.cat)}: ${oneLine(next.question, 80)}`, keywords: ['decision', 'approve', 'approval', 'needs you', 'reply']});
  }
  if (owner && state.cats?.some(c => c.id === 'mayor')) rows.push({id: 'action:goal', action: 'goal', suggest: true, icon: 'flag', label: 'New goal for the Mayor', detail: 'Opens the Mayor’s chat with the goal option on', keywords: ['goal', 'ongoing', 'objective']});
  if (owner && has('pause')) rows.push({id: 'action:pause', action: 'pause', suggest: true, inPlace: true, icon: state.paused ? 'play' : 'pause', label: state.paused ? 'Resume town' : 'Pause town',
    detail: state.paused ? 'Let the cats work again' : 'Stop the cats’ work until you resume', keywords: ['pause', 'resume', 'stop', 'rest']});
  if (owner && has('recruit')) rows.push({id: 'action:recruit', action: 'recruit', icon: 'plus', label: 'Recruit a cat', detail: 'Welcome a new resident with its own calling', keywords: ['new cat', 'add', 'hire', 'welcome']});
  if (owner && has('road-button') && (state.cats?.length ?? 0) > 1) rows.push({id: 'action:road', action: 'road', icon: 'paw-print', label: 'Connect two cats', detail: 'Build a road so they can delegate directly', keywords: ['road', 'connection', 'delegate']});
  if (owner && has('edit-town')) rows.push({id: 'action:edit', action: 'edit', inPlace: true, icon: 'pencil', label: pressed('edit-town') ? 'Done editing' : 'Edit town', detail: 'Move houses around the town', keywords: ['edit', 'move', 'houses', 'layout']});
  if (owner && setup) rows.push({id: 'action:setup', action: 'setup', icon: 'list-checks', label: 'Set up Clowder', detail: 'Brain, phone and apps · also pinned on the Mayor’s thread until done', keywords: ['setup', 'start', 'onboarding']});
  if (has('menu-toggle')) rows.push({id: 'action:settings', action: 'settings', icon: 'settings', label: 'Settings', detail: 'Appearance, sound, devices and more', keywords: ['menu', 'town menu', 'preferences', 'appearance', 'sound', 'weather']});
  // The detail names the keys as people write them: "Ctrl+K" on Windows and Linux, "⌘K" on a Mac.
  const named = keys => keys.join(mac ? '' : '+');
  rows.push({id: 'action:shortcuts', action: 'shortcuts', inPlace: true, icon: 'keyboard', label: 'Keyboard shortcuts',
    detail: shortcutRows({mac, readOnly: !owner}).map(r => named(r.keys)).join(', '), keywords: ['keys', 'keyboard', 'hotkeys', 'help', '?']});
  return rows.map(r => ({group: 'actions', kind: 'action', ...r}));
}

/**
 * Rows for GET /api/search's answer. A message opens the chat it belongs to: the cat the owner wrote to, the cat that wrote to the
 * owner, or for cat-to-cat talk the cat that wrote it. A message between retired cats has no chat to open and is left out. Wiki pages
 * (owners only) open in Memory. Memory notes are left out: the pages are what the owner reads.
 * Plan 11.19 (F5), owners only: an artifact, found by a word in its title or text, opens the Archive on it. A request, found by a word
 * in its text or result, opens its thread as a Threads row does; one taken by a cat that has since retired has no chat and is left out.
 */
export function hitItems(data, state, now = Date.now()) {
  const rows = [], live = id => !!id && id !== 'owner' && (state?.cats ?? []).some(c => c.id === id);
  for (const m of data?.messages ?? []) {
    const [from, to] = String(m.cat ?? '').split(' ');
    const cat = [from === 'owner' ? to : from, to].find(live);
    if (!cat || !m.id) continue;
    rows.push({id: `message:${m.id}`, group: 'messages', kind: 'cat', cat, label: oneLine(m.text, 600), long: true, icon: 'message-circle',
      detail: [`${nameOf(state, from)} to ${nameOf(state, to)}`, when(m.at, now)].filter(Boolean).join(' · ')});
  }
  for (const w of data?.wiki ?? []) {
    if (w?.slug) rows.push({id: `wiki:${w.slug}`, group: 'memory', kind: 'wiki', slug: w.slug, label: w.title || w.slug, detail: oneLine(w.snippet, 110), icon: 'book-open'});
  }
  for (const a of data?.artifacts ?? []) {
    if (a?.id) rows.push({id: `artifact:${a.id}`, group: 'artifacts', kind: 'artifact', artifact: a.id, label: oneLine(a.title, 200) || 'Untitled', icon: 'archive',
      detail: [nameOf(state, a.cat), when(a.at, now), oneLine(a.excerpt, 110)].filter(Boolean).join(' · ')});
  }
  for (const r of data?.requests ?? []) {
    if (r?.id && live(r.cat)) rows.push({id: `request:${r.id}`, group: 'requests', kind: 'thread', cat: r.cat, task: r.id, label: oneLine(r.title, 600), long: true, icon: 'message-circle',
      detail: [nameOf(state, r.cat), when(r.at, now), oneLine(r.result, 110)].filter(Boolean).join(' · ')});
  }
  return rows;
}

const IDS = {dialog: 'command-palette', input: 'cp-input', list: 'cp-list', shortcuts: 'shortcut-list'};

/** An element maker for one document: tag, class, attributes and text. */
const maker = doc => (tag, className, attrs = {}, text = '') => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
};

/**
 * The palette's dialog. surfaces: app.js SURFACES (its keys are listed); openSurface(name) opens one; select(id) opens a cat's chat;
 * town() is the current state; openMemoryPage(slug) opens a Memory page; openThread({kind, id}) opens a request or goal thread in
 * the open chat (chat-thread.js open); openShortcuts() opens the "?" list; openSetup() opens the Set up Clowder hub, and without it that action is not offered. openArtifact(id) opens the Archive on one artifact: by default
 * the Archive surface, then an 'open-artifact' event the Archive's gallery answers (gallery-view.js). Returns {open, close, isOpen, dialog, input, list}.
 */
export function createCommandPalette({doc = globalThis.document, win = globalThis.window, surfaces = {}, openSurface = name => win?.openSurface?.(name), select = () => {}, town = () => null,
  openMemoryPage = null, openThread = null, openShortcuts = null, openArtifact = null, openSetup = null, fetchImpl = (...args) => fetch(...args), debounceMs = 180, now = () => Date.now()} = {}) {
  const make = maker(doc);
  const kbd = (...content) => { const k = make('kbd'); k.append(...content); return k; };

  const dialog = make('dialog', 'command-palette', {id: IDS.dialog, 'aria-label': 'Search Clowder'});
  const field = make('div', 'cp-field');
  const input = make('input', 'cp-input', {id: IDS.input, type: 'text', role: 'combobox', 'aria-label': 'Search threads, cats, places, actions and messages', 'aria-autocomplete': 'list',
    'aria-expanded': 'false', 'aria-controls': IDS.list, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'Search or jump to…'});
  const closeButton = make('button', 'cp-close', {type: 'button', 'aria-label': 'Close search'});
  closeButton.append(icon('x', {size: 20}));
  field.append(icon('search', {size: 20}), input, closeButton);
  const list = make('div', 'cp-list', {id: IDS.list, role: 'listbox', 'aria-label': 'Results'});
  const empty = make('p', 'cp-empty');
  empty.hidden = true;
  const foot = make('div', 'cp-foot');
  const status = make('p', 'cp-status', {role: 'status'});
  const keys = make('p', 'cp-keys', {'aria-hidden': 'true'});
  keys.append(kbd(icon('chevron-up', {size: 14})), kbd(icon('chevron-down', {size: 14})), ' move ', kbd('Enter'), ' open ', kbd('Esc'), ' close');
  foot.append(status, keys);
  dialog.append(field, list, empty, foot);
  doc.body.append(dialog);

  let query = '', painted = null, options = [], nodes = [], active = -1, activeId = null, opener = null, running = false, frame = 0;
  // Search: the newest answer and the query it answers, an in-flight request, a short cache, and a refusal for this opening.
  let hits = null, hitsFor = '', searching = false, denied = false, timer = 0, controller = null;
  const cache = new Map();

  const shown = node => !!node && !node.hidden && win?.getComputedStyle?.(node)?.display !== 'none';
  const has = id => shown(doc.getElementById(id));
  const available = name => {
    const info = SURFACE_INFO[name];
    if (info?.controls) return info.controls.some(id => shown(doc.getElementById(id)));
    const node = info?.control ? doc.getElementById(info.control) : null;
    return !node || shown(node);
  };
  const coarse = () => !!win?.matchMedia?.('(pointer: coarse)')?.matches;

  function panelItems() {
    const rows = [], seen = new Set(), names = new Set(Object.keys(surfaces));
    for (const button of doc.querySelectorAll('[data-toggle-panel]')) {
      const id = button.getAttribute('data-toggle-panel');
      if (!id || !button.id || names.has(id) || seen.has(id) || !shown(button)) continue;
      seen.add(id);
      const info = PANEL_INFO[id] ?? {}, href = button.querySelector('use')?.getAttribute('href') ?? '';
      const label = (button.querySelector('.dock-label')?.textContent || button.getAttribute('aria-label') || id).trim();
      rows.push({id: `panel:${id}`, group: 'places', kind: 'panel', control: button.id, label, detail: info.detail ?? '', icon: href.startsWith('#i-') ? href.slice(3) : 'chevron-right', keywords: [id, ...(info.keywords ?? [])]});
    }
    return rows;
  }

  function items() {
    const state = town(), q = query.trim().slice(0, MAX_QUERY);
    return [
      ...actionItems(state, {has, pressed: id => doc.getElementById(id)?.getAttribute('aria-pressed') === 'true', mac: isMac(win), setup: typeof openSetup === 'function'}),
      ...threadItems(state, now()), ...catItems(state), ...panelItems(), ...surfaceItems(Object.keys(surfaces), available),
      ...(hits && hitsFor === q ? hitItems(hits, state, now()) : []),
    ];
  }

  function optionNode(item, index) {
    const node = make('div', 'cp-option', {id: `cp-opt-${index}`, role: 'option', 'aria-selected': 'false', 'data-index': String(index), 'data-id': item.id});
    const tile = make('span', 'cp-icon', {'aria-hidden': 'true'});
    tile.append(icon(item.icon || 'chevron-right', {size: 16}));
    if (item.tint) { tile.setAttribute('data-tint', ''); tile.style.setProperty('--cp-tint', String(item.tint)); }
    const text = make('span', 'cp-text'), label = make('span', 'cp-label');
    for (const part of marks(item.long ? around(item.label, query) : item.label, query)) label.append(part.mark ? make('mark', 'cp-mark', {}, part.text) : doc.createTextNode(part.text));
    text.append(label);
    if (item.detail) text.append(make('span', 'cp-detail', {}, item.detail));
    node.append(tile, text, make('span', 'cp-enter', {'aria-hidden': 'true'}, 'Enter'));
    return node;
  }

  function paint() {
    const groups = arrange(items(), query), keep = painted === query;
    painted = query;
    options = groups.flatMap(g => g.items);
    nodes = [];
    let index = 0;
    list.replaceChildren(...groups.map((g, gi) => {
      const box = make('div', 'cp-group', {role: 'group', 'aria-labelledby': `cp-g-${gi}`});
      box.append(make('p', 'cp-group-title', {id: `cp-g-${gi}`, role: 'presentation'}, g.title));
      for (const item of g.items) { const node = optionNode(item, index++); nodes.push(node); box.append(node); }
      return box;
    }));
    list.hidden = !options.length;
    input.setAttribute('aria-expanded', String(options.length > 0));
    const q = query.trim();
    empty.hidden = options.length > 0;
    empty.textContent = searching ? 'Searching…' : `Nothing matches “${oneLine(q, 60)}”.`;
    status.textContent = options.length ? `${options.length} result${options.length === 1 ? '' : 's'}${searching ? ' · searching messages…' : ''}` : searching ? 'Searching…' : q ? 'No results' : '';
    // A repaint for the same query (search hits, a town change) keeps the active row; a new query starts on the best match.
    const again = keep ? options.findIndex(o => o.id === activeId) : -1;
    active = -1;
    setActive(again >= 0 ? again : options.length ? 0 : -1, !keep);
  }

  function setActive(index, scroll = true) {
    nodes[active]?.setAttribute('aria-selected', 'false');
    active = index;
    const node = nodes[index];
    activeId = options[index]?.id ?? null;
    if (!node) { input.removeAttribute('aria-activedescendant'); return; }
    node.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', node.id);
    if (scroll) node.scrollIntoView?.({block: 'nearest'});
  }

  function move(delta, wrap) {
    const n = options.length;
    if (!n) return;
    const from = active < 0 ? (delta > 0 ? -1 : n) : active, next = from + delta;
    setActive(wrap ? ((next % n) + n) % n : Math.min(n - 1, Math.max(0, next)));
  }

  function abortSearch() { clearTimeout(timer); controller?.abort?.(); controller = null; searching = false; }

  function scheduleSearch() {
    abortSearch();
    const q = query.trim().slice(0, MAX_QUERY);
    if (denied || q.length < MIN_SEARCH) return;
    if (cache.has(q)) { hits = cache.get(q); hitsFor = q; return; }
    searching = true;
    timer = setTimeout(() => void search(q), debounceMs);
  }

  // The route answers owners and paired devices. Anywhere else (a page without the owner session, a revoked device) it says 401 or 403:
  // then the palette stops asking until it is opened again, and says nothing. Other failures leave the local rows only, also quietly.
  async function search(q) {
    const mine = controller = typeof AbortController === 'function' ? new AbortController() : {abort() {}};
    let data = null;
    try {
      const r = await fetchImpl(`/api/search?q=${encodeURIComponent(q)}`, {signal: mine.signal, cache: 'no-store'});
      if (r.status === 401 || r.status === 403) denied = true;
      else if (r.ok) data = await r.json();
    } catch { /* aborted, offline or not JSON: no hits */ }
    if (controller !== mine) return;
    controller = null; searching = false;
    if (data) { cache.set(q, data); if (cache.size > 20) cache.delete(cache.keys().next().value); }
    hits = data; hitsFor = q;
    if (dialog.open && query.trim().slice(0, MAX_QUERY) === q) paint();
  }

  function closeOtherDialogs() { for (const d of doc.querySelectorAll('dialog[open]')) if (d !== dialog) d.close(); }

  // Choosing a cat or a thread on a desk puts the cursor in the composer, as chat-ux §2 asks. Phones keep their keyboard down.
  function focusComposer(always = false) {
    const box = doc.getElementById('message');
    if (box && !box.disabled && (always || !coarse())) box.focus({preventScroll: true});
  }

  function openPanel(id) {
    closeOtherDialogs();
    const button = doc.getElementById(id);
    if (!button) return;
    // The dock buttons toggle, so an open panel is focused instead of clicked shut.
    if (button.getAttribute('aria-expanded') === 'true') (doc.getElementById(button.getAttribute('aria-controls'))?.querySelector('[data-collapse]') ?? button).focus();
    else button.click();
  }

  function runAction(item) {
    const click = id => doc.getElementById(id)?.click();
    switch (item.action) {
      case 'answer': {
        closeOtherDialogs();
        win.history?.replaceState?.(null, '', `#approval=${encodeURIComponent(item.approval)}`);
        win.dispatchEvent(new (win.HashChangeEvent ?? win.Event)('hashchange'));
        return;
      }
      case 'goal': {
        closeOtherDialogs();
        select('mayor');
        const goal = doc.getElementById('goal-mode');
        if (goal && !goal.checked) { goal.checked = true; goal.dispatchEvent(new win.Event('change', {bubbles: true})); }
        focusComposer(true);
        return;
      }
      case 'pause': return click('pause');
      case 'recruit': return click('recruit');
      case 'road': return click('road-button');
      case 'edit': return click('edit-town');
      case 'setup': { closeOtherDialogs(); return openSetup?.(); }
      case 'settings': return click('menu-toggle');
      case 'shortcuts': return openShortcuts?.();
    }
  }

  function run(item) {
    if (item.kind === 'surface') openSurface(item.surface);
    else if (item.kind === 'panel') openPanel(item.control);
    else if (item.kind === 'cat' || item.kind === 'thread') {
      closeOtherDialogs(); select(item.cat);
      if (item.kind === 'thread') openThread?.(item.task ? {kind: 'request', id: item.task} : {kind: 'goal', id: item.goal});
      focusComposer();
    }
    else if (item.kind === 'wiki') { if (openMemoryPage) openMemoryPage(item.slug); else openSurface('memory'); }
    else if (item.kind === 'artifact') {
      if (openArtifact) openArtifact(item.artifact);
      else { openSurface('archive'); win.dispatchEvent(new (win.CustomEvent ?? win.Event)('open-artifact', {detail: {id: item.artifact}})); }
    }
    else if (item.kind === 'action') runAction(item);
  }

  function activate(index) {
    const item = options[index];
    if (!item) return;
    // What opens a surface, a panel or a chat moves focus there itself; an action done in place gives it back.
    close(!!item.inPlace);
    try { run(item); } catch (error) { console.error('Command palette:', error); }
  }

  function open(initial = '') {
    if (dialog.open) { input.focus(); return; }
    const was = doc.activeElement;
    opener = was && was !== doc.body && !dialog.contains?.(was) ? was : null;
    // Each opening asks afresh: new messages may have come since, and a refusal may not hold any more.
    running = true; denied = false; hits = null; hitsFor = ''; painted = null;
    cache.clear();
    query = input.value = String(initial ?? '');
    scheduleSearch();
    paint();
    dialog.showModal();
    input.focus();
    win?.addEventListener?.('town-state', onTown);
  }

  // Ends one opening: no search left running, no town listener. Returns the element focused before it opened.
  function stop() {
    running = false;
    abortSearch();
    win?.removeEventListener?.('town-state', onTown);
    const back = opener;
    opener = null;
    return back;
  }
  const refocus = node => { if (node?.isConnected) node.focus?.({preventScroll: true}); };

  // restore: give focus back to where it was (Escape, the close button, an action done in place). Choosing a surface, a panel
  // or a chat does not: that place takes focus itself.
  function close(restore = true) {
    if (!dialog.open) return;
    const back = running ? stop() : null;
    dialog.close();
    if (restore) refocus(back);
    // A browser that leaves focus on the closed box: drop it there, so the box is never taken for where to return to.
    if (dialog.contains?.(doc.activeElement)) doc.activeElement.blur?.();
  }

  function onTown() {
    if (!dialog.open || frame) return;
    const later = win?.requestAnimationFrame?.bind(win) ?? (fn => setTimeout(fn, 16));
    frame = later(() => { frame = 0; if (dialog.open) paint(); });
  }

  input.addEventListener('input', () => { query = input.value; scheduleSearch(); paint(); });
  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    const moves = {ArrowDown: [1, true], ArrowUp: [-1, true], PageDown: [5, false], PageUp: [-5, false]}[e.key];
    if (moves) move(...moves);
    else if (e.key === 'Enter') activate(active);
    else if (e.key === 'Escape') close();
    else return;
    // Handled here: app.js's own Escape (close the open panel) and edit-mode keys never see it.
    e.preventDefault();
    e.stopPropagation();
  });
  closeButton.addEventListener('click', () => close());
  // Escape from the close button, and a phone's back gesture, ask the dialog to cancel: close it the same way.
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  // Something else closed it (a surface that closes every open dialog): tidy up, and give focus back only if it was lost.
  dialog.addEventListener('close', () => {
    if (!running) return;
    const back = stop();
    if (!doc.activeElement || doc.activeElement === doc.body) refocus(back);
  });
  // A click on the scrim, outside the card.
  dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
  // Pressing a row keeps focus, and a phone's keyboard, in the box; the click then opens the row.
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => { const node = e.target?.closest?.('[role="option"]'); if (node) activate(Number(node.getAttribute('data-index'))); });
  list.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const node = e.target?.closest?.('[role="option"]'), index = node ? Number(node.getAttribute('data-index')) : -1;
    if (index >= 0 && index !== active) setActive(index, false);
  });

  return {open, close, isOpen: () => !!dialog.open, dialog, input, list};
}

/**
 * The "?" list (plan 11.7): a modal dialog in the palette's card, one row per key, with a close button. Escape, the close button,
 * "?" again, the scrim and a phone's back gesture close it, and focus goes back to where it was. town() is the current state: a
 * read-only page lists only the keys that work there. Returns {open, close, toggle, isOpen, dialog}.
 */
export function createShortcutList({doc = globalThis.document, win = globalThis.window, town = () => null} = {}) {
  const make = maker(doc);
  const dialog = make('dialog', 'command-palette cp-sheet', {id: IDS.shortcuts, 'aria-labelledby': 'cp-sheet-title'});
  const head = make('div', 'cp-sheet-head');
  const closeButton = make('button', 'cp-close', {type: 'button', 'aria-label': 'Close keyboard shortcuts'});
  closeButton.append(icon('x', {size: 20}));
  head.append(icon('keyboard', {size: 20}), make('h2', 'cp-sheet-title', {id: 'cp-sheet-title'}, 'Keyboard shortcuts'), closeButton);
  const list = make('dl', 'cp-shortcuts');
  dialog.append(head, list);
  doc.body.append(dialog);
  let opener = null;

  function paint() {
    const state = town();
    list.replaceChildren(...shortcutRows({mac: isMac(win), readOnly: !state || !!state.readOnly}).map(row => {
      const line = make('div', 'cp-shortcut'), keys = make('dt', 'cp-shortcut-keys');
      keys.append(...row.keys.map(key => make('kbd', '', {}, key)));
      line.append(keys, make('dd', 'cp-shortcut-what', {}, row.what));
      return line;
    }));
  }

  function open() {
    if (dialog.open) return;
    const was = doc.activeElement;
    opener = was && was !== doc.body && !dialog.contains?.(was) ? was : null;
    paint();
    dialog.showModal();
    closeButton.focus();
  }

  function close(restore = true) {
    if (!dialog.open) return;
    const back = opener;
    opener = null;
    dialog.close();
    if (restore && back?.isConnected) back.focus?.({preventScroll: true});
    if (dialog.contains?.(doc.activeElement)) doc.activeElement.blur?.();
  }

  // Escape is handled here, so app.js never sees it: it would also close the open panel or leave edit mode.
  dialog.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  closeButton.addEventListener('click', () => close());
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  // Closed by something else (a surface that closes every open dialog): give focus back only if it was lost.
  dialog.addEventListener('close', () => {
    const back = opener;
    opener = null;
    if (back?.isConnected && (!doc.activeElement || doc.activeElement === doc.body)) back.focus?.({preventScroll: true});
  });
  dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

  return {open, close, toggle: () => (dialog.open ? close() : open()), isOpen: () => !!dialog.open, dialog};
}

/**
 * Called once by app.js. Ctrl+K or ⌘K opens the palette from anywhere and closes it again. An `open-palette` event opens it too
 * (detail: {query}), and a click on any button with data-open-palette sends that event: the phone dock's More list has one,
 * Search (plan 11.7). "?" opens the shortcut list, outside a text field and while no other dialog is open; "?" again closes it.
 * Returns the palette, with the list as `shortcuts`.
 */
export function initCommandPalette(options = {}) {
  const win = options.win ?? globalThis.window, doc = options.doc ?? globalThis.document;
  // The palette's dialog comes first in the page, the list's after it.
  const palette = createCommandPalette({...options, win, doc, openShortcuts: () => shortcuts.open()});
  const shortcuts = createShortcutList({win, doc, town: options.town});
  const blocked = () => ['unpaired', 'cinematic'].some(c => doc.body?.classList?.contains(c));
  // Capture, so a field that handles its own keys still lets Ctrl+K through. The pairing screen has nothing to find, and the
  // first-run intro (body.cinematic) keeps Escape for its own Skip, so neither opens it.
  win.addEventListener('keydown', e => {
    if (!isPaletteKey(e) || blocked()) return;
    e.preventDefault();
    if (palette.isOpen()) { palette.close(); return; }
    // From the shortcut list, Ctrl+K swaps it for the palette; focus goes back to where the list was opened from.
    shortcuts.close();
    palette.open();
  }, true);
  win.addEventListener('open-palette', e => palette.open(e?.detail?.query ?? ''));
  doc.addEventListener('click', e => {
    if (!e.target?.closest?.('[data-open-palette]')) return;
    win.dispatchEvent(new (win.CustomEvent ?? win.Event)('open-palette', {detail: {query: ''}}));
  });
  // Bubble phase, after any field or panel that wants the key; a text field types it.
  win.addEventListener('keydown', e => {
    if (!isShortcutsKey(e) || blocked()) return;
    if ([...doc.querySelectorAll('dialog[open]')].some(d => d !== shortcuts.dialog)) return;
    e.preventDefault();
    shortcuts.toggle();
  });
  return Object.assign(palette, {shortcuts});
}

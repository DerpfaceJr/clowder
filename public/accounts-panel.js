// Accounts & connections (plan 1.9): the one place the owner signs in to services and says what the cats may use. Post office > Sign-ins opens it on
// the host computer. One row per account, grouped by service: its label, who it is signed in as, its health, when the sign-in ends, Reconnect,
// which cats may use it and each tool's Allow / Ask first / Off, plus Add another account. Add from the directory (assistant services first)
// switches the service on, gives it to every cat and starts its sign-in in one tap. The AI models, the chat channels, the cats' browser and the
// built-in tools sit under it, so their status is here too. Routes: src/connectors.ts (GET /api/connectors, PATCH /:id, POST directory, sign-in,
// token, accounts, copy), src/cat-browser.ts, src/models.ts (GET /api/models/status), src/telegram.ts and src/discord.ts.
// A connector's account health comes from its `account` field when the server sends one (accounts.ts Account), else from its live status: never
// "Connected" without a verified identity (item 1.3). The pure helpers are exported for Node tests; the DOM is built with createElement and
// textContent only, so nothing a server or a service says can become markup.
import {el} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';
import {PERMISSIONS, permissionOf, webLink} from './connectors-panel.js';
import {signInPlan, signInBox, tokenLine, post} from './connect-flow.js';
import {statusLine as telegramLine} from './telegram-panel.js';
import {statusLine as discordLine} from './discord-panel.js';
import {secretsNote} from './settings-menu.js';

export const POLL_MS = 2000, CONNECTING_STALE_MS = 20_000, SIGN_IN_MS = 600_000;
/** The panel's one name: its heading, the Post office entry, the palette row and the Setup hub's button all say it. */
export const ACCOUNTS_NAME = 'Accounts & connections';
const DAY = 86_400_000, HOUR = 3_600_000;
const enc = encodeURIComponent;
const list = v => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const h = (tag, props, ...children) => el(tag, props, children.flat().filter(c => c !== null && c !== undefined && c !== false));

// ---- Pure helpers ----

/** The health words, by the account states of accounts.ts (item 1.2) plus the live connection's own. */
export const HEALTH = {
  connected: {tone: 'ok', label: 'Connected'},
  unchecked: {tone: 'ok', label: 'Working · not verified'},
  expiring: {tone: 'warn', label: 'Ends soon'},
  expired: {tone: 'error', label: 'Expired'},
  'wrong-account': {tone: 'error', label: 'Wrong account'},
  'needs-sign-in': {tone: 'warn', label: 'Needs sign-in'},
  requested: {tone: 'warn', label: 'Needs sign-in'},
  'signing-in': {tone: 'warn', label: 'Signing in…'},
  error: {tone: 'error', label: 'Not answering'},
  connecting: {tone: 'warn', label: 'Starting…'},
  stale: {tone: 'warn', label: 'Still starting…'},
  token: {tone: 'warn', label: 'Needs a token'},
  setup: {tone: 'warn', label: 'Needs setup'},
  off: {tone: 'off', label: 'Off'},
};
const ATTENTION = new Set(['needs-sign-in', 'requested', 'wrong-account', 'expiring', 'expired', 'error']);
const health = state => ({state, ...HEALTH[state]});

/** One connector's health. account: the server's Account for it (status, identity, expiresAt), when sent. signing: a sign-in this panel started
 *  is waiting. stale: it has said connecting for longer than CONNECTING_STALE_MS. */
export function healthOf(c, {account = c?.account, signing = false, stale = false, directory = []} = {}) {
  if (!c || c.enabled === false || c.status === 'off') return health('off');
  if (signing) return health('signing-in');
  if (c.auth === 'expired') return health('expired');
  const s = account?.status;
  if (ATTENTION.has(s) && s !== 'error') return health(s);
  if (c.status === 'needs-auth') return health('needs-sign-in');
  if (c.status === 'needs-setup') return health(tokenAccount(c, directory) ? 'token' : 'setup');
  if (c.status === 'error') return health('error');
  if (c.status === 'connecting') return health(stale ? 'stale' : 'connecting');
  if (s === 'error') return health('error');
  if (s === 'connected' || whoText(account?.identity)) return health('connected');
  return health('unchecked');
}

/** Who an identity names: @handle, else the email, else the id. Takes an Account's identity object or the text a check returned. */
export function whoText(identity) {
  if (typeof identity === 'string') return identity.trim() || null;
  if (!identity || typeof identity !== 'object') return null;
  const handle = typeof identity.handle === 'string' && identity.handle.trim() ? identity.handle.trim() : '';
  if (handle) return /^[^@]+@/.test(handle) ? handle : `@${handle.replace(/^@/, '')}`;
  return [identity.email, identity.accountId].find(x => typeof x === 'string' && x.trim())?.trim() ?? null;
}

/** When the sign-in ends, in words, or '' when nobody knows. A sign-in that renews itself has no end the owner needs to see. */
export function expiryLine(expiresAt, now = Date.now(), refreshable = false) {
  const t = Number(expiresAt);
  if (refreshable || expiresAt === null || expiresAt === undefined || !Number.isFinite(t) || t <= 0) return '';
  const left = t - now;
  if (left <= 0) return 'The sign-in has ended.';
  if (left < 48 * HOUR) return `The sign-in ends in ${plural(Math.max(1, Math.round(left / HOUR)), 'hour')}.`;
  return `The sign-in ends in ${plural(Math.round(left / DAY), 'day')}.`;
}

/** A reference service the cats read with no sign-in (a starter such as Context7): it is not an account, so it never counts as Ready. */
export const isReference = c => c?.source === 'directory' && (c.auth ?? 'none') === 'none' && !list(c.vars).length;
/** Connected by the owner (ux-audit F12): on, working, and an account the owner signed in to or added, not a starter. */
export const ownerConnected = c => !!c && c.enabled !== false && c.status === 'connected' && c.auth !== 'expired' && !isReference(c);
/** An account the owner must sign in to again or fix. Not the Inbox's "needs you" count (quests-panel.js needsYouCount): that one badge counts
 *  quests, and a broken sign-in reaches it as its own to-do (accounts.ts), so this list keeps its own words (plan 11.8, N13). */
export const needsSignIn = c => !!c && c.enabled !== false && !isReference(c) && ['warn', 'error'].includes(healthOf(c).tone) && healthOf(c).state !== 'connecting';

/** The line at the top: how many accounts work and how many need a sign-in. */
export function summaryLine(connectors) {
  const all = list(connectors), ready = all.filter(ownerConnected).length, needs = all.filter(needsSignIn).length;
  if (!ready && !needs) return 'Nothing connected yet. Add a service below.';
  return [ready ? `${ready} connected` : '', needs ? `${needs} need${needs === 1 ? 's' : ''} a sign-in` : ''].filter(Boolean).join(' · ');
}

// The directory, assistant services first (F12): email and calendar, then the everyday work apps, then the build tools, then reference docs.
// The first group is "Everyday apps", not "For you": For you is the Inbox's suggestions feature (D16, plan 11.8, N7).
export const ASSISTANT_FIRST = ['google-workspace', 'ms-365', 'github', 'notion', 'canva', 'figma', 'linear', 'asana', 'atlassian', 'monday', 'hubspot', 'intercom', 'stripe', 'paypal', 'square', 'composio'];
export const DIRECTORY_GROUPS = [['assistant', 'Everyday apps'], ['build', 'For building'], ['reference', 'Reference for cats · no sign-in']];
export const groupOf = d => (ASSISTANT_FIRST.includes(d?.id) ? 'assistant' : (d?.auth ?? 'none') === 'none' ? 'reference' : 'build');
/** The directory in that order, filtered by the search text. */
export function directoryOrder(items, query = '') {
  const q = String(query ?? '').trim().toLowerCase(), rank = d => [DIRECTORY_GROUPS.findIndex(([g]) => g === groupOf(d)), ASSISTANT_FIRST.includes(d.id) ? ASSISTANT_FIRST.indexOf(d.id) : 0];
  return list(items).map((d, i) => ({d, i})).filter(({d}) => !q || `${d.name} ${d.description ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => { const [ga, ra] = rank(a.d), [gb, rb] = rank(b.d); return ga - gb || ra - rb || a.i - b.i; }).map(({d}) => d);
}

/** The service a connector is an account of: Instagram, the directory entry it came from (an added account keeps its entry), else itself. */
export function serviceOf(c, directory = []) {
  if (c?.instagram) return 'instagram';
  if (c?.entry) return c.entry;
  const dir = list(directory);
  if (dir.some(d => d.id === c?.id)) return c.id;
  return (c?.url && dir.find(d => d.url && d.url === c.url)?.id) || c?.id;
}
const entryOf = (c, directory) => list(directory).find(d => d.id === serviceOf(c, directory));
/** A token account: Instagram, or a directory service whose sign-in is a pasted token (GitHub). */
export function tokenAccount(c, directory = []) { return !!c?.instagram || entryOf(c, directory)?.auth === 'token'; }
/** Signs in through a web page. */
export const oauthAccount = c => ['oauth', 'signed-in', 'expired'].includes(c?.auth);

/** Accounts grouped by service, in directory order, reference services last. Each group: {service, name, accounts, entry}. */
export function serviceGroups(connectors, directory = []) {
  const groups = new Map();
  for (const c of list(connectors)) {
    const service = serviceOf(c, directory), entry = list(directory).find(d => d.id === service);
    const name = service === 'instagram' ? 'Instagram' : entry ? entry.name.replace(/\s*\(.*\)$/, '') : c.name;
    if (!groups.has(service)) groups.set(service, {service, name, entry, accounts: []});
    groups.get(service).accounts.push(c);
  }
  const order = directoryOrder(directory).map(d => d.id), rank = g => (g.accounts.every(isReference) ? 1e6 : order.includes(g.service) ? order.indexOf(g.service) : order.length);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The cats line: All cats, a few names, or nobody. */
export function catsLine(cats, everyCat = []) {
  const ids = list(cats);
  if (ids.includes('*')) return 'Every cat may use it.';
  if (!ids.length) return 'No cat may use it yet.';
  const names = ids.map(id => list(everyCat).find(c => c.id === id)?.name ?? id);
  return `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} may use it.`;
}

/** Who may use an account (plan 10.8, D14 a): the connectors listing's scope. Owner-only is the default; team lets a member's work use it. */
export const SCOPES = [['owner', 'Only my work'], ['team', 'Team members too']];
export const scopeOf = c => (c?.scope === 'team' ? 'team' : 'owner');
export function scopeLine(scope) {
  return scope === 'team'
    ? 'Team: work a team member starts may use this account, still asking first as its tools say. Their decisions on it are theirs to answer.'
    : 'Only you (the default): your own work uses it. A team member’s work that needs it waits for you.';
}

// The AI models, by GET /api/models/status. kind: a plan signs in, a key is pasted, local answers on this computer.
export const MODEL_ROWS = [['claude', 'Claude plan', 'plan'], ['chatgpt', 'ChatGPT plan', 'plan'], ['anthropic', 'Anthropic API', 'key'], ['hosted', 'API', 'key'], ['local', 'Local AI', 'local'], ['jev', 'Jev decisions', 'key']];
/** One model's health, or null when it is not set up at all (those are named on one line instead). */
export function modelHealth(kind, m) {
  if (!m || typeof m !== 'object') return null;
  if (!m.enabled) return m.configured || m.hasKey || m.loggedIn ? {tone: 'off', label: 'Off'} : null;
  if (m.available ?? m.configured) return {tone: 'ok', label: kind === 'plan' ? 'Signed in' : 'Ready'};
  if (kind === 'plan') return {tone: 'warn', label: m.installed === false ? 'Not installed' : 'Needs sign-in'};
  if (kind === 'local') return {tone: 'warn', label: 'Not answering'};
  return {tone: 'warn', label: 'Needs a key'};
}

// The built-in tools that write (src/tool-runtimes.ts WRITING_BUILTINS), in plain words.
export const BUILTIN_LABELS = {code_workspace: ['Code workspace', 'Write and run code in the cats’ workshop.'], generate_image: ['Make images', 'Create pictures with your media provider.'], generate_video: ['Make videos', 'Create videos with your media provider.'], save_artifact: ['Save to the gallery', 'Keep what a cat made in the Archive.']};

// ---- The panel ----

function injectStyles(doc) {
  if (!doc?.head || doc.querySelector('link[data-accounts-panel]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('accounts-panel.css', import.meta.url).href;
  link.dataset.accountsPanel = '';
  doc.head.append(link);
}

/** button: the Post office entry, shown once the owner's route answers. openSurface(name): another panel (AI models, Telegram, Discord, Connectors). */
export function createAccountsPanel({button = null, doc = document, win = globalThis.window, fetchImpl = (...a) => fetch(...a), ask = confirmDialog, now = () => Date.now(), openSurface = name => win?.openSurface?.(name)} = {}) {
  injectStyles(doc);
  const state = {connectors: [], directory: [], cats: [], builtins: {}, sites: [], browser: null, models: null, telegram: null, discord: null, secrets: null};
  const ui = {loaded: false, sideLoaded: false, error: null, who: new Map(), busy: new Set(), msgs: new Map(), drafts: new Map(), open: new Set(), signing: new Map(), connectingSince: new Map(), search: '', adding: false};
  let timer = 0;

  const read = async path => {
    const r = await fetchImpl(path, {cache: 'no-store'});
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) throw Object.assign(new Error(data?.error || 'Accounts could not load.'), {status: r.status});
    return data;
  };
  const write = async (path, body = {}, method = 'POST') => {
    if (method === 'POST') return post(fetchImpl, `/api/${path}`, body);
    const r = await fetchImpl(`/api/${path}`, {method, headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'That did not work.');
    return data;
  };

  const back = h('button', {className: 'back-pill phone-only', text: '← Town', attrs: {type: 'button', 'aria-label': 'Back to town'}});
  const closeX = h('button', {className: 'close-x desk-only', text: '×', attrs: {type: 'button', 'aria-label': `Close ${ACCOUNTS_NAME}`}});
  const body = h('div', {className: 'ac-body'});
  const dialog = h('dialog', {className: 'accounts-dialog', attrs: {id: 'accounts-dialog', 'aria-labelledby': 'accounts-title'}},
    // The line above the heading says where the panel lives; the heading is its one name (ACCOUNTS_NAME).
    h('div', {className: 'treasury-dialog-title ac-top'}, back, h('span', {className: 'eyebrow', text: 'THE POST OFFICE'}), closeX),
    h('h2', {text: ACCOUNTS_NAME, attrs: {id: 'accounts-title'}}),
    h('p', {className: 'ac-lede', text: 'Sign in once and say what your cats may use. Every account and its health is here.'}),
    body);
  back.onclick = () => dialog.close();
  closeX.onclick = () => dialog.close();
  doc.body.append(dialog);
  const onFocus = () => void refresh();
  dialog.addEventListener('close', () => { stopPolling(); ui.signing.clear(); win?.removeEventListener?.('focus', onFocus); });
  // The secrets note rides on every state refresh (GET /api/state secrets).
  win?.addEventListener?.('town-state', event => { const next = event?.detail?.next?.secrets ?? null; if (JSON.stringify(next) !== JSON.stringify(state.secrets)) { state.secrets = next; if (dialog.open) paint(); } });

  // ---- Reads, polls and actions ----

  function stopPolling() { clearTimeout(timer); timer = 0; }
  // Polls while a sign-in waits or any account is starting, so "Starting…" never outlives the server's own answer (ux-audit F11).
  function schedule() {
    stopPolling();
    const waiting = ui.signing.size > 0 || state.connectors.some(c => c.enabled !== false && c.status === 'connecting');
    if (dialog.open && waiting) timer = setTimeout(() => void refresh(), POLL_MS);
  }

  const snapshot = () => JSON.stringify([state.connectors, state.cats, state.builtins, state.sites, state.browser, state.models, state.telegram, state.discord]);
  async function refresh(force = false) {
    if (!dialog.open && ui.loaded) return;
    const before = snapshot();
    try {
      const [c, b] = await Promise.all([read('/api/connectors'), read('/api/cat-browser').catch(() => null)]);
      Object.assign(state, {connectors: list(c.connectors), directory: list(c.directory), cats: list(c.cats), builtins: c.builtins && typeof c.builtins === 'object' ? c.builtins : {}, sites: list(c.sites), browser: b});
      ui.error = null;
    } catch (error) { ui.error = error.message; force = true; }
    ui.loaded = true;
    const t = now();
    for (const c of state.connectors) { if (c.status === 'connecting') { if (!ui.connectingSince.has(c.id)) ui.connectingSince.set(c.id, t); } else ui.connectingSince.delete(c.id); }
    for (const [id, s] of ui.signing) {
      const c = state.connectors.find(x => x.id === id);
      if (!c || t > s.until) { ui.signing.delete(id); force = true; }
      else if (signKey(c) !== s.from && c.status !== 'connecting') { ui.signing.delete(id); ui.msgs.set(`ac:${id}`, {text: `Signed in to ${c.name}.`}); force = true; }
    }
    if (force || snapshot() !== before) paint();
    schedule();
  }
  // What a sign-in changes: the sign-in, the live status and the account. A change ends the wait; the account's own waiting states (the server
  // marks it signing-in once the page is handed out) are one value, so they never read as a finished sign-in.
  const WAITING = new Set(['signing-in', 'requested', 'needs-sign-in']);
  const signKey = c => JSON.stringify([c.auth, c.status, WAITING.has(c.account?.status) ? 'waiting' : c.account?.status ?? null, whoText(c.account?.identity)]);

  // The slower reads (the model CLIs are probed) come after the first paint, once per open and on focus.
  async function refreshSide() {
    const [models, telegram, discord] = await Promise.all([read('/api/models/status').catch(() => null), read('/api/telegram').catch(() => null), read('/api/discord').catch(() => null)]);
    Object.assign(state, {models, telegram, discord});
    ui.sideLoaded = true;
    if (dialog.open) paint();
  }

  async function act(key, work, slot = key) {
    if (ui.busy.has(key)) return false;
    ui.busy.add(key); ui.msgs.delete(slot); paint();
    let ok = false;
    try { await work(); ok = true; } catch (error) { ui.msgs.set(slot, {text: error.message || String(error), bad: true}); }
    finally { ui.busy.delete(key); await refresh(true); }
    return ok;
  }

  async function startSignIn(c) {
    const r = await write(`connectors/${enc(c.id)}/sign-in`);
    const plan = signInPlan(r);
    if (!plan) throw new Error('The sign-in address is not a web link.');
    // A browser that blocks the page leaves the link in the box, and the box says so.
    if (plan.finish === 'callback') plan.opened = !!win?.open?.(plan.url, '_blank', 'noopener');
    const until = plan.expiresAt ?? now() + SIGN_IN_MS;
    ui.signing.set(c.id, {plan, until, from: signKey(state.connectors.find(x => x.id === c.id) ?? c)});
    ui.open.add(`row:${c.id}`);
  }

  // Add: on, every cat, then the sign-in (a web page) or the token box (GitHub) in the same tap. A service with no sign-in is ready at once.
  async function addService(d) {
    const key = `dir:${d.id}`;
    await act(key, async () => {
      const r = await write(`connectors/directory/${enc(d.id)}`);
      const id = r?.connector?.id ?? d.id;
      await write(`connectors/${enc(id)}`, {enabled: true, cats: ['*']}, 'PATCH');
      await afterAdd(id, d, `Added ${d.name}. Every cat may use it.`);
    });
  }
  async function afterAdd(id, d, note) {
    ui.open.add(`row:${id}`);
    if (d.auth === 'oauth') {
      await refreshQuiet();
      // The service is added either way: a sign-in that cannot start says why on its own row, where Sign in tries again.
      try { await startSignIn({id, name: d.name}); } catch (error) { ui.msgs.set(`ac:${id}`, {text: `${note} The sign-in did not start: ${error.message}`, bad: true}); }
      return;
    }
    if (d.auth === 'token') { ui.open.add(`token:${id}`); ui.msgs.set(`ac:${id}`, {text: `${note} Paste your ${d.name} token to finish.`}); return; }
    ui.msgs.set(`ac:${id}`, {text: note});
  }
  async function refreshQuiet() { try { const c = await read('/api/connectors'); state.connectors = list(c.connectors); } catch { /* the next refresh says why */ } }

  // ---- Painting ----

  const btn = (text, key, onclick, className = '', extra = {}) => {
    const node = h('button', {className, text, attrs: {type: 'button', ...(key ? {'data-key': key} : {}), ...extra}});
    if (key && [...ui.busy].some(k => key === k || key.startsWith(`${k}:`))) node.disabled = true;
    node.onclick = onclick;
    return node;
  };
  const msg = key => { const m = ui.msgs.get(key); return m ? h('p', {className: `cx-msg${m.bad ? ' bad' : ''}`, text: m.text, attrs: {role: 'status'}}) : null; };
  const dot = s => h('p', {className: 'cx-status ac-health'}, h('span', {className: 'cx-dot', attrs: {'data-tone': s.tone, 'aria-hidden': 'true'}}), h('span', {text: s.label}));
  const seg = (label, value, key, onPick) => h('div', {className: 'cx-seg', attrs: {role: 'group', 'aria-label': label}},
    PERMISSIONS.map(([v, text]) => btn(text, `${key}:${v}`, () => { if (value !== v) onPick(v); }, 'cx-seg-btn', {'aria-pressed': String(value === v)})));
  const disclose = (text, id, key) => btn(text, key, () => { if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id); paint(); }, 'cx-disclose', {'aria-expanded': String(ui.open.has(id))});
  const input = (key, attrs) => { const node = h('input', {attrs: {...attrs, 'data-key': key}}); node.value = ui.drafts.get(key) ?? ''; node.oninput = () => ui.drafts.set(key, node.value); return node; };

  function paint() {
    if (!dialog.open && ui.loaded) return;
    // A control that is replaced keeps focus, and a text box keeps its caret.
    const active = doc.activeElement, focusKey = active?.dataset?.key, caret = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const parts = [];
    if (!ui.loaded) parts.push(h('p', {className: 'cx-empty muted', text: 'Loading your accounts…', attrs: {role: 'status'}}));
    else if (ui.error && !state.connectors.length) parts.push(h('p', {className: 'cx-msg bad', text: ui.error, attrs: {role: 'status'}}));
    else {
      const note = secretsNote(state.secrets);
      parts.push(h('div', {className: 'ac-summary'}, h('p', {className: 'ac-count', text: summaryLine(state.connectors), attrs: {role: 'status'}}), note ? h('p', {className: `ac-secrets${note.quiet ? '' : ' warn'}`, text: note.text}) : null));
      if (ui.error) parts.push(h('p', {className: 'cx-msg bad', text: ui.error, attrs: {role: 'status'}}));
      parts.push(accountsSection(), addSection(), modelsSection(), channelsSection(), browserSection(), builtinsSection(), moreSection());
    }
    body.replaceChildren(...parts.filter(Boolean));
    const twin = focusKey && active && !active.isConnected ? [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled) : null;
    if (twin) { twin.focus?.({preventScroll: true}); if (caret) try { twin.setSelectionRange?.(...caret); } catch { /* not a text box */ } }
  }

  // The owner's accounts, one card per service; the reference services the cats read with no sign-in (the starters) follow in one quiet card.
  function accountsSection() {
    const groups = serviceGroups(state.connectors, state.directory), refs = groups.filter(g => g.accounts.every(isReference)), mine = groups.filter(g => !refs.includes(g));
    return h('section', {className: 'cx-section ac-section', attrs: {'aria-labelledby': 'ac-yours'}},
      h('h4', {text: 'Your accounts', attrs: {id: 'ac-yours'}}),
      mine.length ? h('ul', {className: 'ac-services'}, mine.map(serviceCard)) : h('p', {className: 'cx-empty muted', text: 'No accounts yet. Add a service below and your cats can use it.'}),
      refs.length ? [h('p', {className: 'ac-sub', text: 'Reference for cats · no sign-in'}), h('ul', {className: 'cx-card ac-accounts ac-refs'}, refs.flatMap(g => g.accounts).map(c => accountRow(c, false)))] : null);
  }

  function serviceCard(g) {
    const first = g.accounts[0], key = `svc:${g.service}`, single = g.accounts.length === 1 && first.name === g.name;
    return h('li', {className: 'cx-card ac-service', attrs: {'data-service': g.service}},
      single ? null : h('div', {className: 'ac-service-head'}, h('strong', {className: 'ac-service-name', text: g.name})),
      h('ul', {className: 'ac-accounts'}, g.accounts.map(c => accountRow(c, single))),
      anotherAccount(g, first, key));
  }

  // named: the row's name is the card's title (one account whose name is the service's).
  function accountRow(c, named = false) {
    const key = `ac:${c.id}`, signing = ui.signing.get(c.id), since = ui.connectingSince.get(c.id);
    const s = healthOf(c, {signing: !!signing, stale: since !== undefined && now() - since > CONNECTING_STALE_MS, directory: state.directory});
    const who = whoText(c.account?.identity) ?? ui.who.get(c.id) ?? null, expiry = expiryLine(c.account?.expiresAt, now(), c.account?.refreshable === true);
    // The token box says what a token account needs; the raw variable name the server reports would only repeat it.
    const reason = (s.tone === 'warn' || s.tone === 'error') && !['connecting', 'token', 'signing-in'].includes(s.state) ? c.account?.lastError || c.account?.reason || c.error : '';
    const open = ui.open.has(`row:${c.id}`), ref = isReference(c);
    return h('li', {className: 'ac-account', attrs: {'data-id': c.id, 'data-health': s.state}},
      h('div', {className: 'ac-row-head'},
        h('div', {className: 'ac-row-title'}, h('strong', {className: named ? 'ac-service-name' : '', text: c.name}), who ? h('p', {className: 'ac-who', text: `Signed in as ${who}`}) : !ref && s.state === 'unchecked' ? h('p', {className: 'ac-who muted', text: 'Nobody checked who it signs in as.'}) : null),
        dot(s)),
      expiry ? h('p', {className: 'ac-expiry', text: expiry}) : null,
      !ref && scopeOf(c) === 'team' ? h('p', {className: 'ac-hint ac-scope', text: 'Team members’ work may use it.'}) : null,
      reason ? h('p', {className: 'cx-err-line ac-reason', text: String(reason)}) : null,
      signing ? signInBox(signing.plan, {name: c.name, fetchImpl, clipboard: win?.navigator?.clipboard, onDone: () => { ui.signing.delete(c.id); void refresh(true); }}) : null,
      h('div', {className: 'ac-actions'}, mainAction(c, s, key), ref ? null : disclose(open ? 'Hide' : 'Cats and tools', `row:${c.id}`, `${key}:more`)),
      ui.open.has(`token:${c.id}`) ? tokenBox(c, key) : null,
      msg(key),
      open ? rowDetails(c, key) : null);
  }

  // The one button a row leads with: what fixes it, or Reconnect when it works.
  function mainAction(c, s, key) {
    if (s.state === 'off') return btn('Turn on', key, () => void act(key, () => write(`connectors/${enc(c.id)}`, {enabled: true}, 'PATCH')), 'primary');
    if (s.state === 'signing-in') return btn('Cancel', `${key}:cancel`, () => { ui.signing.delete(c.id); paint(); schedule(); });
    if (s.state === 'error' || s.state === 'stale') return btn('Retry', key, () => void act(key, () => write(`connectors/${enc(c.id)}/reconnect`)), 'primary');
    if (isReference(c) || s.state === 'connecting') return null;
    const fix = s.tone !== 'ok';
    if (tokenAccount(c, state.directory)) return btn(fix ? 'Paste a token' : 'Reconnect', `${key}:token`, () => { ui.open.add(`token:${c.id}`); paint(); }, fix ? 'primary' : '');
    if (oauthAccount(c)) return btn(fix ? 'Sign in' : 'Reconnect', key, () => void act(key, () => startSignIn(c)), fix ? 'primary' : '');
    if (s.state === 'setup') return btn('Open its settings', `${key}:setup`, () => { dialog.close(); openSurface('connectors'); });
    return null;
  }

  // A pasted token: saved, then whoami at once. The identity, or the service's reason for refusing it (a 409), shows by the box.
  function tokenBox(c, key) {
    const entry = entryOf(c, state.directory), dataKey = `${key}:token-input`, url = webLink(entry?.tokenUrl ?? '');
    const field = input(dataKey, {type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '4000', placeholder: 'Paste the token here', 'aria-label': `${c.name} token`});
    const save = h('button', {className: 'primary', text: 'Save token', attrs: {type: 'submit', 'data-key': `${key}:save`}});
    if (ui.busy.has(key)) save.disabled = true;
    const form = h('form', {className: 'ac-token', attrs: {novalidate: ''}}, field, save);
    form.onsubmit = event => {
      event?.preventDefault?.();
      const token = (ui.drafts.get(dataKey) ?? '').trim();
      if (!token) { ui.msgs.set(key, {text: 'Paste the token first.', bad: true}); paint(); return; }
      void act(key, async () => {
        const r = await write(`connectors/${enc(c.id)}/token`, {token});
        ui.drafts.delete(dataKey); ui.open.delete(`token:${c.id}`);
        if (r?.account?.identity) ui.who.set(c.id, r.account.identity); else ui.who.delete(c.id);
        ui.msgs.set(key, {text: tokenLine(r?.account, c.name)});
      });
    };
    return h('div', {className: 'ac-token-box'},
      entry?.tokenHelp ? h('p', {className: 'ac-hint', text: entry.tokenHelp}) : null,
      url ? h('a', {className: 'cx-open', text: `Get a token on ${entry.name} ↗`, attrs: {href: url, target: '_blank', rel: 'noopener noreferrer'}}) : null,
      form);
  }

  function rowDetails(c, key) {
    const cats = list(c.cats), all = cats.includes('*'), tools = list(c.tools);
    const chips = state.cats.length ? h('div', {className: 'cx-chips', attrs: {role: 'group', 'aria-label': `Cats that may use ${c.name}`}},
      btn('All cats', `${key}:cat:*`, () => void act(key, () => write(`connectors/${enc(c.id)}`, {cats: all ? [] : ['*']}, 'PATCH')), 'cx-chip', {'aria-pressed': String(all)}),
      state.cats.map(cat => {
        const chosen = !all && cats.includes(cat.id), next = chosen ? cats.filter(x => x !== cat.id) : [...cats.filter(x => x !== '*'), cat.id];
        return btn(cat.name, `${key}:cat:${cat.id}`, () => void act(key, () => write(`connectors/${enc(c.id)}`, {cats: all ? [cat.id] : next}, 'PATCH')), 'cx-chip', {'aria-pressed': String(chosen)});
      })) : null;
    const scope = scopeOf(c);
    const scopeBtn = ([value, text]) => btn(text, `${key}:scope:${value}`, () => { if (scope !== value) void act(key, () => write(`accounts/${enc(c.id)}/scope`, {scope: value}, 'PUT')); }, 'cx-seg-btn', {'aria-pressed': String(scope === value)});
    return h('div', {className: 'ac-details'},
      h('p', {className: 'ac-sub', text: 'Who may use it', attrs: {id: `ac-scope-${c.id}`}}),
      h('div', {className: 'cx-seg ac-two', attrs: {role: 'group', 'aria-labelledby': `ac-scope-${c.id}`}}, SCOPES.map(scopeBtn)),
      h('p', {className: 'ac-hint', text: scopeLine(scope)}),
      h('p', {className: 'ac-hint', text: catsLine(cats, state.cats)}),
      chips,
      tools.length ? h('p', {className: 'ac-sub', text: `What cats may do (${plural(tools.length, 'tool')})`}) : h('p', {className: 'ac-hint', text: 'Its tools show here once it is connected.'}),
      tools.length ? h('ul', {className: 'cx-tools'}, tools.map(tool => {
        const name = tool.title || tool.name, p = permissionOf(tool);
        return h('li', {className: 'cx-tool'},
          h('div', {className: 'cx-tool-name'}, h('strong', {text: name}), tool.readOnly ? h('span', {className: 'cx-ro', text: 'read-only'}) : null),
          seg(`Permission for ${name}`, p, `${key}:tool:${tool.name}`, v => void act(key, () => write(`connectors/${enc(c.id)}`, {tools: {[tool.name]: v}}, 'PATCH'))));
      })) : null,
      btn('Remove this account', `${key}:remove`, () => void remove(c, key), 'cx-remove ac-remove'));
  }

  async function remove(c, key) {
    const yes = await ask({title: `Remove ${c.name}?`, message: 'Its sign-in and saved values leave this computer, and its tools leave every cat.', confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true});
    if (yes) await act(key, () => write(`connectors/${enc(c.id)}`, {}, 'DELETE'));
  }

  // Another account of the same service: a directory service gets its own labelled sign-in (Work, Personal); a connector with settings, a copy.
  // No cat has the new one until the owner picks cats: two accounts of one service should never both reach every cat by surprise.
  function anotherAccount(g, first, key) {
    const entry = g.entry, copyable = !entry && list(first.vars).length > 0;
    if (g.accounts.every(isReference) || (!entry && !copyable) || (entry && (entry.auth ?? 'none') === 'none')) return null;
    const id = `add:${g.service}`, open = ui.open.has(id), dataKey = `${key}:label`;
    if (!open) return btn('Add another account', `${key}:another`, () => { ui.open.add(id); paint(); }, 'cx-disclose ac-another', {'aria-expanded': 'false'});
    const field = input(dataKey, {type: 'text', autocomplete: 'off', maxlength: entry ? '40' : '80', placeholder: entry ? 'Work, Personal…' : `${first.name} @other`, 'aria-label': 'Name for the new account'});
    const add = h('button', {className: 'primary', text: 'Add', attrs: {type: 'submit', 'data-key': `${key}:add`}});
    const form = h('form', {className: 'ac-token', attrs: {novalidate: ''}}, field, add);
    form.onsubmit = event => {
      event?.preventDefault?.();
      const label = (ui.drafts.get(dataKey) ?? '').trim();
      if (!label) { ui.msgs.set(key, {text: 'Name the account first, for example Work.', bad: true}); paint(); return; }
      void act(key, async () => {
        const r = entry ? await write(`connectors/directory/${enc(entry.id)}/accounts`, {label}) : await write(`connectors/${enc(first.id)}/copy`, {name: label});
        ui.drafts.delete(dataKey); ui.open.delete(id);
        const made = r?.connector;
        if (!made) return;
        ui.open.add(`row:${made.id}`);
        if (entry) await afterAdd(made.id, entry, `Added ${made.name}. Pick the cats that may use it.`);
        else ui.msgs.set(`ac:${made.id}`, {text: `Added ${made.name}. It starts off: open Connectors & plugins to change what differs, then turn it on.`});
      });
    };
    return h('div', {className: 'ac-another-box'}, h('p', {className: 'ac-hint', text: entry ? `A second ${g.name} sign-in with its own name. No cat may use it until you pick cats.` : 'A copy with the same settings and its own name. It starts off.'}), form, msg(key),
      btn('Cancel', `${key}:another-cancel`, () => { ui.open.delete(id); paint(); }, 'ac-quiet'));
  }

  // Typing in the search repaints only the list under it, so the box keeps its focus and caret.
  function addSection() {
    const search = h('input', {attrs: {type: 'search', autocomplete: 'off', placeholder: 'Search services', 'aria-label': 'Search services', 'data-key': 'dir:search'}});
    const results = h('div', {className: 'ac-dir'});
    search.value = ui.search;
    search.oninput = () => { ui.search = search.value; results.replaceChildren(...dirGroups()); };
    results.replaceChildren(...dirGroups());
    return h('section', {className: 'cx-section ac-section', attrs: {'aria-labelledby': 'ac-add'}},
      h('h4', {text: 'Add a service', attrs: {id: 'ac-add'}}),
      h('p', {className: 'ac-hint', text: 'Add switches it on, gives it to every cat and starts the sign-in, in one tap.'}),
      search, results);
  }
  function dirGroups() {
    const shown = directoryOrder(state.directory, ui.search);
    if (!shown.length) return [h('p', {className: 'cx-empty muted', text: state.directory.length ? 'Nothing matches that search.' : 'The directory is empty.'})];
    return DIRECTORY_GROUPS.map(([g, title]) => {
      const items = shown.filter(d => groupOf(d) === g);
      return items.length ? h('div', {className: 'ac-dir-group'}, h('p', {className: 'ac-sub', text: title}), h('ul', {className: 'cx-list'}, items.map(dirRow))) : null;
    }).filter(Boolean);
  }

  function dirRow(d) {
    const key = `dir:${d.id}`, added = state.connectors.some(c => serviceOf(c, state.directory) === d.id);
    const how = {oauth: 'Sign in', token: 'Paste a token', none: 'No sign-in'}[d.auth] ?? '';
    return h('li', {className: 'cx-row'},
      h('div', {className: 'cx-row-main'}, h('strong', {text: d.name}), d.description ? h('p', {className: 'cx-desc', text: d.description}) : null, how ? h('p', {className: 'cx-auth muted', text: how}) : null),
      added ? btn('Added ✓', null, () => {}, 'cx-done', {disabled: ''}) : btn('Add', key, () => void addService(d), 'primary'),
      msg(key));
  }

  function modelsSection() {
    const m = state.models;
    if (!m) return h('section', {className: 'cx-section ac-section'}, h('h4', {text: 'AI models'}), h('p', {className: 'cx-empty muted', text: ui.sideLoaded ? 'Your AI models could not be checked just now.' : 'Checking your AI models…', attrs: {role: 'status'}}), btn('Open AI models', 'models:open', () => { dialog.close(); openSurface('models'); }));
    const rows = [], unset = [];
    for (const [id, name, kind] of MODEL_ROWS) {
      const s = modelHealth(kind, m[id]);
      if (!s) { if (m[id]) unset.push(name); continue; }
      rows.push(h('li', {className: 'ac-model'}, h('span', {className: 'ac-model-name', text: m[id].name || name}), dot(s)));
    }
    return h('section', {className: 'cx-section ac-section', attrs: {'aria-labelledby': 'ac-models'}},
      h('h4', {text: 'AI models', attrs: {id: 'ac-models'}}),
      rows.length ? h('ul', {className: 'ac-models'}, rows) : h('p', {className: 'cx-empty muted', text: 'No AI model is set up yet.'}),
      unset.length ? h('p', {className: 'ac-hint', text: `Not set up: ${unset.join(', ')}.`}) : null,
      btn('Open AI models', 'models:open', () => { dialog.close(); openSurface('models'); }));
  }

  function channelsSection() {
    const row = (name, line, surface) => h('li', {className: 'ac-model'}, h('span', {className: 'ac-model-name', text: name}), dot({tone: line.tone, label: line.text}), btn('Open', `chan:${surface}`, () => { dialog.close(); openSurface(surface); }, 'ac-quiet'));
    const rows = [state.telegram ? row('Telegram', telegramLine(state.telegram), 'telegram') : null, state.discord ? row('Discord', discordLine(state.discord), 'discord') : null].filter(Boolean);
    if (!rows.length) return null;
    return h('section', {className: 'cx-section ac-section', attrs: {'aria-labelledby': 'ac-chat'}}, h('h4', {text: 'Chat channels', attrs: {id: 'ac-chat'}}), h('ul', {className: 'ac-models'}, rows));
  }

  // Clowder's own window, where the owner signs in once and the cats reuse it, or My Chrome through the Playwright extension. Each browse asks first
  // unless a site has Always allow; those sites are listed with their choice.
  function browserSection() {
    const b = state.browser, mine = b?.mode === 'chrome';
    const pick = (mode, label) => btn(label, `cb:${mode}`, () => void act(`cb:${mode}`, () => write('cat-browser', {mode}, 'PUT'), 'cb'), 'cx-seg-btn', {'aria-pressed': String((b?.mode ?? 'own') === mode)});
    const sites = state.sites.map(site => h('li', {className: 'cx-tool'}, h('div', {className: 'cx-tool-name'}, h('strong', {text: site.host})),
      seg(`Browsing on ${site.host}`, ['allow', 'ask', 'off'].includes(site.permission) ? site.permission : 'ask', `site:${site.host}`, v => void act(`site:${site.host}`, () => write(`connectors/${enc(site.id)}`, {tools: {browse: v}}, 'PATCH'), 'cb'))));
    return h('section', {className: 'cx-section ac-section', attrs: {'aria-labelledby': 'ac-browser'}},
      h('h4', {text: 'Cats’ browser', attrs: {id: 'ac-browser'}}),
      h('p', {className: 'ac-hint', text: mine ? 'Cats work in your own Chrome, signed in as you. Each run asks you first.' : 'Sign in to sites here once; cats reuse it. Clowder never sees your passwords.'}),
      b ? h('div', {className: 'cx-seg ac-two', attrs: {role: 'group', 'aria-label': 'Where cats browse'}}, pick('own', 'Clowder’s window'), pick('chrome', 'My Chrome')) : null,
      mine && b ? chromeToken(b) : null,
      btn(mine ? 'Open my Chrome' : 'Open the cats’ browser', 'cb:open', () => void act('cb:open', async () => { await write('cat-browser/open'); ui.msgs.set('cb', {text: mine ? 'Opened your Chrome.' : 'Opened the cats’ browser.'}); }, 'cb')),
      sites.length ? [h('p', {className: 'ac-sub', text: 'Sites with their own choice'}), h('ul', {className: 'cx-tools'}, sites)] : null,
      msg('cb'));
  }

  function chromeToken(b) {
    const dataKey = 'cb:token-input', field = input(dataKey, {type: 'password', autocomplete: 'off', placeholder: b.tokenSet ? 'Saved · paste to replace' : 'Extension token (optional)', 'aria-label': 'Playwright extension token'});
    const save = h('button', {className: '', text: 'Save', attrs: {type: 'submit', 'data-key': 'cb:token'}});
    const form = h('form', {className: 'ac-token', attrs: {novalidate: ''}}, field, save);
    form.onsubmit = event => {
      event?.preventDefault?.();
      void act('cb:token', async () => { const r = await write('cat-browser', {token: (ui.drafts.get(dataKey) ?? '').trim()}, 'PUT'); ui.drafts.delete(dataKey); ui.msgs.set('cb', {text: r?.tokenSet ? 'Token saved. Runs connect without Chrome asking.' : 'No token: Chrome asks you to connect each run.'}); }, 'cb');
    };
    const link = webLink(b.extension);
    return h('div', {className: 'ac-token-box'}, h('p', {className: 'ac-hint', text: 'Add the Playwright extension to Chrome once. With its token saved, a run connects without Chrome asking you.'}),
      link ? h('a', {className: 'cx-open', text: 'Get the Playwright extension ↗', attrs: {href: link, target: '_blank', rel: 'noopener noreferrer'}}) : null, form);
  }

  function builtinsSection() {
    const names = Object.keys(state.builtins);
    if (!names.length) return null;
    return h('section', {className: 'cx-section ac-section', attrs: {'aria-labelledby': 'ac-builtins'}},
      h('h4', {text: 'Built-in tools', attrs: {id: 'ac-builtins'}}),
      h('p', {className: 'ac-hint', text: 'What every cat may do without an account.'}),
      h('ul', {className: 'cx-tools'}, names.map(t => {
        const [label, note] = BUILTIN_LABELS[t] ?? [t, ''], p = ['allow', 'ask', 'off'].includes(state.builtins[t]) ? state.builtins[t] : 'allow';
        return h('li', {className: 'cx-tool'}, h('div', {className: 'cx-tool-name'}, h('strong', {text: label})), note ? h('p', {className: 'cx-tool-desc', text: note}) : null,
          seg(`Permission for ${label}`, p, `bt:${t}`, v => void act(`bt:${t}`, () => write('connectors/builtin:tools', {tools: {[t]: v}}, 'PATCH'), 'bt')));
      })),
      msg('bt'));
  }

  function moreSection() {
    return h('section', {className: 'cx-section ac-section'},
      h('p', {className: 'ac-hint', text: 'Your own MCP servers, programs on this computer and plugins live in Connectors & plugins.'}),
      btn('Open Connectors & plugins', 'more:connectors', () => { dialog.close(); openSurface('connectors'); }));
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    win?.addEventListener?.('focus', onFocus);
    if (!ui.loaded) paint();
    await refresh(true);
    void refreshSide();
  }

  // Only the owner's route answers; a viewer gets a 403 and never sees the entry.
  async function probe() {
    try { await read('/api/connectors'); if (button) button.hidden = false; return true; } catch { return false; }
  }

  if (button) button.addEventListener('click', () => void open());
  return {open, close: () => dialog.close(), refresh, probe, dialog};
}

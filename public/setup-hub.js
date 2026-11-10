// "Set up Clowder": one hub that reads the owner's status and runs each first-run step in place, so nothing needs a terminal.
// The pure functions (status JSON -> rows, counts, the auto-open rule) are exported for tests; the DOM is built below them.
import {pushSupport} from './notify.js';
import {ACCOUNTS_NAME, isReference} from './accounts-panel.js';
import {icon} from './icons.js';

export const SEEN_KEY = 'clowder.setup.seen';
export const OLLAMA_DOWNLOAD = 'https://ollama.com/download';
const NEEDS_YOU = ['needs-auth', 'needs-setup', 'error'];
const PROVIDERS = [['claude', 'Claude plan'], ['chatgpt', 'ChatGPT plan'], ['hosted', 'API'], ['local', 'Local AI']];
// One status word per step, and the Lucide icon (icons.js) that stands for the step on the left of its card.
const TAG = {ready: 'Ready', needs: 'Needed', optional: 'Optional'};
const STEP_ICON = {brain: 'sparkles', phone: 'smartphone', apps: 'globe', notify: 'bell', workshop: 'wrench'};
const SUMMARY_MS = 10_000, POLL_MS = 1000, PAIR_POLL_MS = 2000, SLOW_MS = 6000, WORKSHOP_MS = 30_000;

const joinNames = names => names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;

// Local AI is usable only when Ollama answers and its default model is installed.
export function localReady(local) {
  const model = local?.ai?.default?.model;
  return !!local?.available && !!model && (local.ai.models || []).includes(model);
}

export function brainStep(models) {
  const base = {id: 'brain', kind: 'required', title: 'A brain for your cats'};
  const usable = PROVIDERS.filter(([id]) => (id === 'local' ? localReady(models?.local) : !!models?.[id]?.available)).map(([, name]) => name);
  if (usable.length) return {...base, state: 'ready', text: `Your cats can think with ${joinNames(usable)}.`, action: null};
  if (models?.claude?.installed && !models.claude.loggedIn) return {...base, state: 'needs', text: 'Claude is installed but not signed in. Sign in so your cats can use it.', action: {kind: 'claude-login', label: 'Sign in with Claude'}};
  const local = models?.local;
  if (local?.enabled === false) return {...base, state: 'needs', text: 'Local AI is turned off, and no other model is ready.', action: {kind: 'models', label: 'Open AI models'}};
  if (!local?.configured) return {...base, state: 'needs', text: 'Install Ollama to run a model on this computer, or sign in to Claude or ChatGPT.', action: {kind: 'link', label: 'Get Ollama', href: OLLAMA_DOWNLOAD}};
  const model = local.ai?.default?.model;
  if (model) return {...base, state: 'needs', text: `Ollama is running. Download ${model} so your cats can think on this computer.`, action: {kind: 'pull', label: `Download ${model}`, model}};
  return {...base, state: 'needs', text: 'Ollama is running, but no model is chosen.', action: {kind: 'models', label: 'Open AI models'}};
}

export function phoneStep(remote) {
  const base = {id: 'phone', kind: 'recommended', title: 'Your phone'};
  const count = remote?.devices?.length || 0;
  if (count) return {...base, state: 'ready', text: `${count} ${count === 1 ? 'device is' : 'devices are'} paired. Clowder opens on ${count === 1 ? 'it' : 'them'} from anywhere.`, action: {kind: 'pair', label: 'Pair another phone'}};
  return {...base, state: 'needs', text: 'Pair your phone to open Clowder from your pocket.', action: {kind: 'pair', label: 'Pair your phone'}};
}

// The step's button opens Accounts & connections, so it says so in every state: a button is named after the dialog it opens.
export function appsStep(connectors) {
  const base = {id: 'apps', kind: 'optional', title: 'Apps your cats can use'}, action = {kind: 'connectors', label: `Open ${ACCOUNTS_NAME}`};
  if (connectors === null) return {...base, state: 'optional', text: 'Could not check your apps just now.', action};
  const list = Array.isArray(connectors) ? connectors : [];
  const needs = list.filter(c => NEEDS_YOU.includes(c.status)).map(c => c.name);
  if (needs.length) return {...base, state: 'needs', text: `${joinNames(needs)} needs you.`, action};
  // Only what the owner connected counts as Ready (ux-audit F12): a reference starter such as Context7 is not an app of theirs.
  const connected = list.filter(c => c.status === 'connected' && !isReference(c)).map(c => c.name);
  if (connected.length) return {...base, state: 'ready', text: `${joinNames(connected)} connected.`, action};
  return {...base, state: 'optional', text: 'Nothing connected yet. Connect the services your cats can use, such as your email, calendar or GitHub.', action};
}

// Null when this browser cannot do web push at all, so the row is hidden.
export function notifyStep(support, permission) {
  if (!support?.push) return null;
  const base = {id: 'notify', kind: 'optional', title: 'Notifications on this device'};
  if (support.needsInstall) return {...base, state: 'optional', text: support.note, action: null};
  if (permission === 'granted') return {...base, state: 'ready', text: 'This device shows a note for decisions, to-dos, Mayor messages and season results.', action: null};
  if (permission === 'denied') return {...base, state: 'optional', text: 'Blocked in your browser. Allow notifications in its site settings to turn them on.', action: null};
  return {...base, state: 'optional', text: 'Get a note for decisions, to-dos, Mayor messages and season results.', action: {kind: 'notify', label: 'Turn on notifications'}};
}

export function workshopStep(workshop) {
  const base = {id: 'workshop', kind: 'optional', title: 'Workshop for code and video'};
  if (workshop?.distro?.present) return {...base, state: 'ready', text: 'Installed. Your cats can run code and video jobs in it.', action: {kind: 'models', label: 'Open AI models'}};
  if (workshop === undefined) return {...base, state: 'optional', text: 'Checking the workshop…'};
  if (workshop === null) return {...base, state: 'optional', text: 'Could not check the workshop just now.', action: {kind: 'models', label: 'Open AI models'}};
  return {...base, state: 'optional', text: 'Runs code and video jobs for your cats in a separate Linux workshop.', action: {kind: 'models', label: 'Set up the workshop'}};
}

export function buildSteps({models, remote, connectors, workshop, support, permission} = {}) {
  return [brainStep(models), phoneStep(remote), appsStep(connectors), notifyStep(support, permission), workshopStep(workshop)].filter(Boolean);
}

// Required and recommended steps count; optional rows never do. badge is how many counted steps are not ready.
export function summarize(steps) {
  const counted = steps.filter(s => s.kind !== 'optional');
  const ready = counted.filter(s => s.state === 'ready').length;
  return {ready, total: counted.length, badge: counted.length - ready, text: `${ready} of ${counted.length} ready`};
}

// Opens by itself only once, and only while the brain is not ready. Blocked storage never opens it.
export function shouldAutoOpen(steps, storage) {
  try { if (storage.getItem(SEEN_KEY)) return false; } catch { return false; }
  return steps.find(s => s.id === 'brain')?.state !== 'ready';
}

export function pullPercent(job) {
  return job?.total > 0 ? Math.min(100, Math.round(100 * job.completed / job.total)) : 0;
}
export function sizeText(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
export function pullLabel(job) {
  if (!job?.total) return 'Starting the download…';
  return `${sizeText(job.completed)} of ${sizeText(job.total)} · ${pullPercent(job)}%`;
}

// The same link the server puts in the QR code, built from the invite the server returned.
export const pairLinkFor = invite => `${invite.origin}/#pair=${encodeURIComponent(invite.code)}`;
// Only the server's own QR markup is used, parsed as SVG, and never anything with a script.
export const safeSvg = svg => (typeof svg === 'string' && svg.startsWith('<svg') && !/<script/i.test(svg) ? svg : '');
function svgNode(doc, markup) {
  const parsed = new DOMParser().parseFromString(safeSvg(markup), 'image/svg+xml');
  return parsed.documentElement?.nodeName === 'svg' ? doc.importNode(parsed.documentElement, true) : null;
}

async function request(path, method = 'GET', body) {
  const res = await fetch(path, {method, headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let summaryCache = null;
// The counts for the settings menu: brain and phone only, so the menu needs no workshop or connector probe.
export async function setupSummary() {
  if (summaryCache && Date.now() - summaryCache.at < SUMMARY_MS) return summaryCache.value;
  try {
    const [models, remote] = await Promise.all([request('/api/models/status'), request('/api/remote/status').catch(() => null)]);
    const value = summarize(buildSteps({models, remote}));
    summaryCache = {at: Date.now(), value};
    return value;
  } catch {
    return null;
  }
}

// A probe that hangs gives null after the wait, so the rest of the hub still opens.
const soft = (promise, ms = SLOW_MS) => Promise.race([promise.catch(() => null), new Promise(done => setTimeout(() => done(null), ms))]);

// The hub draws as soon as the quick checks answer. The workshop check (WSL, several seconds) fills its row when it lands.
async function readSetup(win) {
  const workshop = soft(request('/api/workshop'), WORKSHOP_MS);
  const [models, remote, connectors] = await Promise.all([
    request('/api/models/status'),
    request('/api/remote/status').catch(() => null),
    soft(request('/api/connectors').then(d => d.connectors)),
  ]);
  const inputs = {models, remote, connectors, support: pushSupport(win, win.navigator), permission: win.Notification?.permission};
  return {steps: buildSteps(inputs), later: workshop.then(w => buildSteps({...inputs, workshop: w}))};
}

/**
 * Resolves once the town has had its turn: its loading notice is gone, so a new world's welcome (intro-cinematic.js) has started if it
 * is going to, and no welcome is playing. The hub is a modal dialog, which draws over the welcome's full-screen flight: opened on its
 * 1.5 s timer it covered the Mayor's first words (hub at 4.0 s, welcome behind it at 9.4 s; headless Edge at 1280x800 on a fresh
 * scratch town, n=1, measured 2026-11-10). settleMs lets the header and dock fade back in (0.9 s) before the hub opens.
 */
export function afterWelcome(win = window, doc = document, settleMs = 1000) {
  const loading = doc.getElementById('town-loading');
  const quiet = () => (!loading || loading.hidden) && !doc.body.classList.contains('cinematic');
  if (quiet()) return Promise.resolve();
  return new Promise(resolve => {
    const watch = typeof win.MutationObserver === 'function' && loading ? new win.MutationObserver(() => check()) : null;
    const later = () => win.setTimeout(check, settleMs);
    function check() {
      if (!quiet()) return;
      watch?.disconnect();
      win.removeEventListener('cinematic', later);
      resolve();
    }
    watch?.observe(loading, {attributes: true, attributeFilter: ['hidden']});
    win.addEventListener('cinematic', later);
  });
}

// Runs once at startup. Opens the hub when the brain is not ready, after the welcome, then never again on this browser.
export async function autoOpenOnce(win = window, doc = document) {
  let storage = null;
  try { storage = win.localStorage; if (storage.getItem(SEEN_KEY)) return false; } catch { return false; }
  let models;
  try { models = await request('/api/models/status'); } catch { return false; }
  if (!shouldAutoOpen([brainStep(models)], storage)) return false;
  await afterWelcome(win, doc);
  // The owner has begun (a dialog is open, or there are words in the composer): the hub stays a tap away on its card, and offers itself next launch.
  if (doc.querySelector('dialog[open]') || doc.getElementById('message')?.value) return false;
  try { storage.setItem(SEEN_KEY, '1'); } catch { return false; }
  await openSetupHub(win, doc);
  return true;
}

// focus: the step whose button gets focus once the hub has drawn, after a dialog that step opened closes (returnFrom).
const view = {win: null, doc: null, dialog: null, count: null, list: null, steps: [], poll: 0, pairTimer: 0, round: 0, focus: null};

export async function openSetupHub(win = window, doc = document) {
  view.win = win;
  view.doc = doc;
  const dialog = ensureDialog();
  if (!dialog.open) dialog.showModal ? dialog.showModal() : dialog.setAttribute('open', '');
  await refresh();
}

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.includes('-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

function ensureDialog() {
  if (view.dialog) return view.dialog;
  const doc = view.doc;
  // .back-pill is the phone's way out; .close-x is the desktop dialog's. The stylesheet shows one of them.
  const back = el(doc, 'button', {type: 'button', className: 'back-pill', 'aria-label': 'Back to town', onclick: closeHub}, [icon('arrow-left', {size: 18}), 'Town']);
  const close = el(doc, 'button', {type: 'button', className: 'close-x', 'aria-label': 'Close', onclick: closeHub}, [icon('x')]);
  const title = el(doc, 'h2', {id: 'setup-hub-title', textContent: 'Set up Clowder', tabIndex: -1});
  view.count = el(doc, 'p', {className: 'setup-count', 'aria-live': 'polite'});
  view.list = el(doc, 'ol', {className: 'setup-steps'});
  const body = el(doc, 'div', {className: 'setup-hub-body'}, [
    el(doc, 'div', {className: 'setup-top'}, [back, close]),
    el(doc, 'div', {className: 'setup-head'}, [title, view.count]),
    view.list,
  ]);
  view.dialog = el(doc, 'dialog', {className: 'setup-hub', 'aria-labelledby': 'setup-hub-title'}, [body]);
  view.dialog.addEventListener('close', () => { stopPolling(); view.focus = null; });
  doc.body.append(view.dialog);
  return view.dialog;
}

function closeHub() {
  view.dialog?.close();
}

function stopPolling() {
  clearTimeout(view.poll);
  clearTimeout(view.pairTimer);
  view.poll = 0;
  view.pairTimer = 0;
}

async function refresh() {
  summaryCache = null;
  stopPolling();
  view.count.textContent = 'Checking…';
  view.list.replaceChildren();
  let later;
  try {
    ({steps: view.steps, later} = await readSetup(view.win));
  } catch (err) {
    view.count.textContent = '';
    view.list.replaceChildren(el(view.doc, 'li', {className: 'setup-error', textContent: err.message}));
    return;
  }
  const summary = summarize(view.steps);
  view.count.textContent = summary.text;
  view.list.replaceChildren(...view.steps.map(rowFor));
  focusStep();
  void resumePull();
  const round = ++view.round;
  void later.then(steps => {
    const row = view.list.querySelector('[data-step="workshop"]'), step = steps.find(s => s.id === 'workshop');
    if (view.round !== round || !row || !step) return;
    view.steps = steps;
    row.replaceWith(rowFor(step));
    focusStep();
    if (view.focus === 'workshop') view.focus = null;
  });
}

// Back from a dialog a step opened: focus goes to that step's button, so the next key press acts where the owner left off. The workshop
// row gets its button when its slower check lands, so its wish waits for that; by then the owner may have tabbed into the list, and
// focus is theirs. A step that came back with no button (it turned ready) leaves focus where the hub put it.
function focusStep() {
  if (!view.focus || !view.dialog?.open) return;
  const button = view.list.querySelector(`[data-step="${view.focus}"] .setup-action`);
  if (!button) { if (view.focus !== 'workshop') view.focus = null; return; }
  view.focus = null;
  if (!view.list.contains(view.doc.activeElement)) button.focus();
}

function rowFor(step) {
  const doc = view.doc;
  const main = el(doc, 'div', {className: 'setup-row-main'}, [
    el(doc, 'div', {className: 'setup-row-head'}, [el(doc, 'h3', {textContent: step.title}), el(doc, 'span', {className: 'setup-tag', textContent: TAG[step.state]})]),
    el(doc, 'p', {textContent: step.text}),
  ]);
  // The step's icon on a tile tinted by its state (setup-hub.css); the status word beside the title says the same in words.
  const mark = el(doc, 'span', {className: 'setup-icon', 'aria-hidden': 'true'}, [icon(STEP_ICON[step.id] ?? 'check', {size: 20})]);
  const li = el(doc, 'li', {className: 'setup-row'}, [mark, main]);
  li.setAttribute('data-state', step.state);
  li.setAttribute('data-step', step.id);
  if (step.action) main.append(actionFor(step, {li, main}));
  return li;
}

function actionFor(step, ctx) {
  const {action} = step, doc = view.doc;
  const className = 'setup-action ' + (step.state === 'needs' ? 'primary' : 'secondary');
  if (action.kind === 'link') return el(doc, 'a', {className, href: action.href, target: '_blank', rel: 'noopener', textContent: action.label});
  const button = el(doc, 'button', {type: 'button', className, textContent: action.label});
  button.addEventListener('click', () => run(action, {...ctx, button}));
  return button;
}

function run(action, ctx) {
  if (action.kind === 'models') return openOther('models', '#models-open', stepOf(ctx));
  if (action.kind === 'connectors') return openOther('accounts', '#accounts-open', stepOf(ctx));
  if (action.kind === 'pull') return pull(action.model, ctx);
  if (action.kind === 'pair') return pair(ctx);
  if (action.kind === 'claude-login') return claudeLogin(ctx);
  if (action.kind === 'notify') return notify(ctx);
}

const stepOf = ctx => ctx.li?.getAttribute('data-step') ?? null;

// The surface opens over the town, so the hub steps aside first, and comes back when the surface closes (returnFrom). Falls back to
// the button the Post office and the settings menu use.
function openOther(name, selector, step = null) {
  const {win, doc} = view;
  closeHub();
  if (win.openSurface) win.openSurface(name);
  else doc.querySelector(selector)?.click();
  returnFrom([...doc.querySelectorAll('dialog[open]')].find(d => d !== view.dialog), step);
}

// Setup is a loop: Esc, the close button or the phone's back pill on a dialog that a step opened shows the hub again, read afresh, with
// focus on that step's button. Only this one opening is watched, so the same dialog opened from anywhere else closes to where it was
// opened. When the owner went on from it to another panel (one is open as it closes), the hub stays away.
function returnFrom(dialog, step) {
  if (!dialog) return;
  dialog.addEventListener('close', () => {
    if (view.doc.querySelector('dialog[open]')) return;
    view.focus = step;
    void openSetupHub(view.win, view.doc);
  }, {once: true});
}

function note(parent, text) {
  parent.append(el(view.doc, 'p', {className: 'setup-error', role: 'status', textContent: text}));
}

function progressBox(main) {
  main.querySelector('.setup-progress-wrap')?.remove();
  const bar = el(view.doc, 'span');
  const label = el(view.doc, 'p', {className: 'setup-note'});
  const track = el(view.doc, 'div', {className: 'setup-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100}, [bar]);
  const wrap = el(view.doc, 'div', {className: 'setup-progress-wrap'}, [track, label]);
  wrap.paint = job => {
    const pct = pullPercent(job);
    bar.style.width = `${pct}%`;
    track.setAttribute('aria-valuenow', String(pct));
    label.textContent = pullLabel(job);
  };
  main.append(wrap);
  return wrap;
}

// One tap: the CLI's sign-in opens Claude's page in the browser, and the row turns ready once Claude reports signed in.
// No code to paste on this computer. When the link only came back as the paste kind, the AI models card takes over.
async function claudeLogin(ctx) {
  ctx.button.disabled = true;
  ctx.main.querySelector('.setup-login')?.remove();
  try {
    const started = await request('/api/models/claude/login', 'POST', {});
    if (!started.auto) { ctx.button.disabled = false; return openOther('models', '#models-open', stepOf(ctx)); }
    const box = el(view.doc, 'div', {className: 'setup-login'}, [
      ...(started.vpn ? [el(view.doc, 'p', {className: 'setup-error', textContent: `A VPN is on (${started.vpn}). Claude’s sign-in usually refuses VPN addresses: turn it off, then tap Sign in with Claude again.`})] : []),
      el(view.doc, 'p', {className: 'setup-note', textContent: 'Claude’s sign-in page opened in your browser. Click Authorize there; this turns green by itself.'}),
      el(view.doc, 'a', {className: 'setup-action secondary', href: started.url, target: '_blank', rel: 'noopener', textContent: 'Open it again'}),
      ...(started.browsers?.length ? [
        el(view.doc, 'p', {className: 'setup-note', textContent: 'Says it could not verify your browser? Open the same page in another one:'}),
        el(view.doc, 'div', {className: 'setup-browsers'}, started.browsers.map(b => {
          const button = el(view.doc, 'button', {type: 'button', className: 'setup-action secondary', textContent: `Open in ${b.name}`});
          button.addEventListener('click', () => request('/api/models/claude/login/open', 'POST', {browser: b.id}).catch(err => note(ctx.main, err.message)));
          return button;
        })),
      ] : []),
    ]);
    ctx.main.append(box);
    const round = view.round, until = Date.now() + 5 * 60_000;
    const check = async () => {
      if (view.round !== round || !view.dialog?.open) return;
      const models = await request('/api/models/status').catch(() => null);
      if (models?.claude?.loggedIn) return refresh();
      if (Date.now() < until) view.poll = setTimeout(check, 3000);
      else { ctx.button.disabled = false; note(ctx.main, 'Sign-in timed out. Tap Sign in with Claude to try again.'); }
    };
    view.poll = setTimeout(check, 3000);
  } catch (err) {
    ctx.button.disabled = false;
    note(ctx.main, err.message);
  }
}

async function pull(model, ctx) {
  ctx.button.disabled = true;
  try {
    const {job} = await request('/api/setup/ollama-pull', 'POST', {model});
    follow(job, ctx);
  } catch (err) {
    ctx.button.disabled = false;
    note(ctx.main, err.message);
  }
}

// Shows a download job until it ends. Done refreshes the hub, so the brain row turns ready.
function follow(job, ctx) {
  stopPolling();
  const wrap = progressBox(ctx.main);
  wrap.paint(job);
  const tick = async () => {
    let current = null;
    try { ({job: current} = await request('/api/setup/ollama-pull')); } catch { /* try again on the next tick */ }
    if (!current) { view.poll = setTimeout(tick, POLL_MS); return; }
    wrap.paint(current);
    if (current.status === 'running') { view.poll = setTimeout(tick, POLL_MS); return; }
    view.poll = 0;
    if (current.status === 'done') return refresh();
    if (ctx.button) ctx.button.disabled = false;
    note(ctx.main, current.error || 'The download failed.');
  };
  view.poll = setTimeout(tick, POLL_MS);
}

// A download started before the hub opened keeps its progress bar.
async function resumePull() {
  if (view.steps.find(s => s.id === 'brain')?.action?.kind !== 'pull') return;
  const {job} = await request('/api/setup/ollama-pull').catch(() => ({job: null}));
  if (job?.status !== 'running') return;
  const main = view.list.querySelector('[data-step="brain"] .setup-row-main');
  const button = main?.querySelector('button.setup-action');
  if (!main) return;
  if (button) button.disabled = true;
  follow(job, {main, button});
}

async function pair(ctx) {
  const doc = view.doc;
  ctx.button.disabled = true;
  ctx.main.querySelector('.setup-pair')?.remove();
  const status = el(doc, 'p', {className: 'setup-note', role: 'status', textContent: 'Starting remote access…'});
  const qr = el(doc, 'div', {className: 'setup-qr'});
  const input = el(doc, 'input', {readOnly: true, className: 'setup-link-input', 'aria-label': 'Pairing link', type: 'text'});
  const copy = el(doc, 'button', {type: 'button', className: 'setup-action secondary', textContent: 'Copy link'});
  const expiry = el(doc, 'p', {className: 'setup-note'});
  const panel = el(doc, 'div', {className: 'setup-pair'}, [
    status,
    qr,
    el(doc, 'p', {className: 'setup-note', textContent: "Scan with your phone's camera — it opens Clowder and pairs"}),
    el(doc, 'div', {className: 'setup-link'}, [input, copy]),
    expiry,
  ]);
  ctx.main.append(panel);
  try {
    const current = await request('/api/remote/status');
    if (!current.origin) await request('/api/remote/start', 'POST', {});
    const invite = await request('/api/remote/invite', 'POST', {permission: 'owner'});
    const picture = svgNode(doc, invite.qr);
    if (picture) qr.replaceChildren(picture);
    input.value = pairLinkFor(invite);
    status.textContent = '';
    expiry.textContent = `This code works until ${new Date(invite.expiresAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}.`;
    copy.addEventListener('click', async () => {
      try { await view.win.navigator.clipboard.writeText(input.value); copy.textContent = 'Copied'; } catch { input.select(); }
    });
    watchPairing(current.devices?.length || 0, invite.expiresAt + 60_000);
  } catch (err) {
    status.textContent = err.message;
  } finally {
    ctx.button.disabled = false;
  }
}

// Refreshes the hub once a new phone shows up in the device list.
function watchPairing(paired, until) {
  const tick = async () => {
    if (!view.dialog?.open || Date.now() > until) return;
    const remote = await request('/api/remote/status').catch(() => null);
    if (remote && (remote.devices?.length || 0) > paired) return refresh();
    view.pairTimer = setTimeout(tick, PAIR_POLL_MS);
  };
  view.pairTimer = setTimeout(tick, PAIR_POLL_MS);
}

// notify.js keeps its controller private, so the enable button on its settings page does the work.
function notify(ctx) {
  const target = [...view.doc.querySelectorAll('#settings-sound button')].find(b => b.textContent.includes('Enable notifications'));
  if (!target) { note(ctx.main, 'Turn on notifications in Settings, Sound & notifications.'); return; }
  target.click();
  // Stops at a decision, when the hub closes, or after two minutes if the prompt is left open.
  let waited = 0;
  const check = () => {
    if (!view.dialog?.open || ++waited > 120) return;
    if (view.win.Notification?.permission !== 'default') return refresh();
    view.poll = setTimeout(check, POLL_MS);
  };
  view.poll = setTimeout(check, POLL_MS);
}

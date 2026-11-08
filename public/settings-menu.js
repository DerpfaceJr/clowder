// The ☰ settings menu: a short list of categories, then one page per category.
// Each category is a top-level .menu-page section of the menu body. A section added with registerSettingsSection
// becomes a page too; its optional {icon, summary} drives its row in the list.
// Under the list: the build this server runs (GET /api/state build), and a notice when newer code is on disk.
import {ago} from './quests-panel.js';

const LAST_KEY = 'cat-town-settings-page';
// List order for the built-in categories. Anything else follows in registration order.
const ORDER = ['setup', 'appearance', 'town', 'autonomy', 'routines', 'memory', 'usage', 'sound', 'devices', 'screen'];
const registered = new Map();
let menu = null;     // the ☰ dialog, once initSettingsNav has run
let current = null;  // the open category's key, or null for the list
let build = null;    // the latest state's build, or null
let buildBox = null; // the block under the list that shows it
let buildKey = '';   // what buildBox shows now, so a refresh that changes nothing leaves it alone
let secrets = null;  // the latest state's secrets status, for the owner only

export function summarizeAppearance(time, mode, quality) {
  return [time, `House names ${mode || 'auto'}`, quality && `Graphics ${quality}`].filter(Boolean).join(' · ');
}

export function summarizeTown({paused = false, editing = false} = {}) {
  return [paused ? 'Paused' : 'Running', editing ? 'Editing' : ''].filter(Boolean).join(' · ');
}

// The running build, {commit: string|null, startedAt, stale}, as the line under the list. Null when the server sends none.
// A git hash shows its first 7 characters (the full one is the title); a start time that cannot be read is left out.
export const STALE_BUILD_NOTICE = 'Newer code is on disk. Restart Clowder to run it.';
export function buildLine(build, now = Date.now()) {
  if (!build || typeof build !== 'object') return null;
  const commit = typeof build.commit === 'string' ? build.commit.trim() : '';
  const shown = /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : commit.length > 24 ? `${commit.slice(0, 23)}…` : commit;
  const started = Number.isFinite(Date.parse(build.startedAt)) ? ` · started ${ago(build.startedAt, now)}` : '';
  return {text: `Running build ${shown || '(commit unknown)'}${started}`, commit, stale: build.stale === true};
}

// The SecretStore's status (GET /api/state secrets, plan 1.7): one quiet line when saved keys sit unencrypted (npm start, not the desktop app),
// a plainer one when they are locked or could not move. Null when they are encrypted or the server says nothing.
export const PLAINTEXT_NOTE = 'Saved keys are stored unencrypted on this computer.';
export function secretsNote(status) {
  if (!status || typeof status !== 'object') return null;
  const text = typeof status.note === 'string' && status.note.trim() ? status.note.trim() : status.mode === 'plaintext' ? PLAINTEXT_NOTE : '';
  return text ? {text, quiet: status.mode === 'plaintext'} : null;
}

function appearanceNow() {
  return summarizeAppearance(
    document.querySelector('[data-world-view][aria-pressed="true"]')?.textContent.trim(),
    document.querySelector('[data-label-mode][aria-pressed="true"]')?.dataset.labelMode,
    document.querySelector('[data-quality][aria-pressed="true"]')?.dataset.quality,
  );
}

function townNow() {
  return summarizeTown({
    paused: /Resume/.test(document.getElementById('pause')?.textContent || ''),
    editing: document.getElementById('edit-town')?.getAttribute('aria-pressed') === 'true',
  });
}

const BUILT_IN = {
  appearance: {icon: '◐', summary: appearanceNow},
  town: {icon: '⌂', summary: townNow},
  devices: {icon: '▣', summary: () => 'Pairing, accounts and AI models'},
  screen: {icon: '⛶', summary: () => (document.fullscreenElement ? 'Fullscreen on' : 'Fullscreen off')},
};

// Rows whose icon, subtitle or badge this module owns. They override whatever was registered for the same id.
let setupLine = {text: '', badge: 0};
const EXTRA = {
  setup: {icon: '✚', summary: () => setupLine.text || 'Brain, phone and apps', badge: () => setupLine.badge},
  memorial: {icon: '☾', summary: () => 'The cats who retired, under the night sky'},
  worlds: {icon: '◎', summary: () => `Active: ${document.getElementById('worlds-chip-name')?.textContent.trim() || 'this town'}`},
};

function openMemorial() {
  // The Memorial row goes straight to the memorial; its old one-button page is never shown.
  if (window.openSurface) window.openSurface('memorial');
  else document.getElementById('menu-memorial-open')?.click();
}

// The setup hub and its CSS load on first use, so the menu costs nothing until someone asks for them.
const openSetup = () => import('./setup-hub.js').then(hub => hub.openSetupHub());

function ensureSetupStyles() {
  if (document.querySelector('link[data-setup-hub]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./setup-hub.css', import.meta.url).href;
  link.dataset.setupHub = '';
  document.head.append(link);
}

async function refreshSetup() {
  try {
    const {setupSummary} = await import('./setup-hub.js');
    setupLine = (await setupSummary()) || {text: '', badge: 0};
  } catch {
    setupLine = {text: '', badge: 0};
  }
  apply();
}

// Memorial's section already exists in index.html; it gets an id here so it is registered as the row's page.
function registerBuiltInRows() {
  const memorial = document.getElementById('menu-memorial')?.closest('.menu-page');
  if (memorial && !memorial.id) memorial.id = 'settings-memorial';
  registerSettingsSection('memorial', 'Memorial', null, {action: openMemorial});
  registerSettingsSection('setup', 'Set up Clowder', container => {
    // Owner-only: viewers never see the row. Its action opens the hub directly, so this button is a fallback only.
    const open = document.createElement('button');
    open.type = 'button';
    open.id = 'setup-open';
    open.setAttribute('data-owner', '');
    open.textContent = 'Open setup';
    open.addEventListener('click', openSetup);
    container.append(open);
  }, {action: openSetup});
}

// Lets other modules add a section to the ☰ settings menu. Built-in sections are already in index.html.
// A section that already exists for this id (for example settings-sound) is reused, so its markup and ids stay.
// render(container, section) runs once per call and appends its controls to the section's .menu-items.
// options: {icon} is the row's glyph; summary() returns the row's one-line subtitle, read each time the list is drawn.
export function registerSettingsSection(id, title, render, {icon = '', summary = null, action = null} = {}) {
  const body = document.querySelector('#town-menu .menu-body');
  if (!body || !id) return null;
  registered.set(id, {icon, summary, action});
  let section = document.getElementById('settings-' + id);
  if (!section) {
    section = document.createElement('section');
    section.id = 'settings-' + id;
    const heading = document.createElement('h3');
    heading.id = 'menu-' + id;
    heading.textContent = title;
    section.setAttribute('aria-labelledby', heading.id);
    const items = document.createElement('div');
    items.className = 'menu-items';
    section.append(heading, items);
    body.append(section);
  }
  section.classList.add('menu-group', 'menu-page');
  if (typeof render === 'function') render(section.querySelector('.menu-items'), section);
  apply();
  return section;
}

// Wires the ☰ dialog once: rows open pages, Back returns to the list, and Escape steps back from a page before it closes the menu.
export function initSettingsNav(dialog) {
  menu = dialog;
  current = readLast();
  registerBuiltInRows();
  ensureSetupStyles();
  // Once per browser, and only when the brain is not ready (checked inside setup-hub.js). Waits for the first paint and intro.
  setTimeout(() => void import('./setup-hub.js').then(hub => hub.autoOpenOnce()).catch(() => {}), 1500);
  menu.querySelector('#settings-back').addEventListener('click', () => go(null));
  menu.querySelector('#settings-list').addEventListener('click', e => {
    const row = e.target.closest('.menu-row');
    if (!row) return;
    // A row with an action (Worlds) opens its own screen directly instead of a menu page.
    const action = registered.get(row.dataset.category)?.action;
    if (typeof action === 'function') { menu.close?.(); action(); return; }
    go(row.dataset.category);
  });
  menu.addEventListener('cancel', e => {
    if (!activePage()) return;
    e.preventDefault();
    go(null);
  });
  menu.addEventListener('close', () => writeLast(current));
  // The running build sits under the list. app.js dispatches town-state on every refresh; a server without build info hides it.
  buildBox = make('div', 'settings-build');
  buildBox.id = 'settings-build';
  buildBox.hidden = true;
  menu.querySelector('#settings-list').after(buildBox);
  window.addEventListener('town-state', event => {
    build = event.detail?.next?.build ?? null;
    secrets = event.detail?.next?.readOnly ? null : event.detail?.next?.secrets ?? null;
    paintBuild();
  });
  apply();
}

// Shown with the list only, like the rows. The relative time is read again on every paint (menu open, page change, refresh).
function paintBuild() {
  if (!buildBox) return;
  const line = activePage() ? null : buildLine(build), note = activePage() ? null : secretsNote(secrets);
  const key = line || note ? JSON.stringify([line, note]) : '';
  if (key === buildKey) return;
  buildKey = key;
  buildBox.hidden = !line && !note;
  if (!line && !note) { buildBox.replaceChildren(); return; }
  const text = line ? make('p', 'settings-build-line', line.text) : null;
  if (line?.commit) text.title = `Commit ${line.commit}`;
  const keys = note ? [make('p', `settings-secrets${note.quiet ? '' : ' warn'}`, note.text)] : [];
  buildBox.replaceChildren(...(text ? [text] : []), ...(line?.stale ? [make('p', 'settings-build-stale', STALE_BUILD_NOTICE)] : []), ...keys);
}

// Called before the menu opens: summaries are fresh and the last category (this session only) is shown again.
export function refreshSettingsNav() {
  noteScreenLinks();
  apply();
  void refreshSetup();
}

// The Screen & app links come from mobile-ui.js without a subtitle; the same data-note the buttons use gives them one.
const SCREEN_NOTES = {'install-app': 'Add Clowder to your home screen', 'get-android-app': 'Keeps working when the town address changes'};
function noteScreenLinks() {
  for (const [id, note] of Object.entries(SCREEN_NOTES)) {
    const node = document.getElementById(id);
    if (node && !node.dataset.note) node.dataset.note = note;
  }
}

const keyOf = page => page.id.replace(/^settings-/, '');
const pages = () => (menu ? [...menu.querySelectorAll(':scope > .menu-body > .menu-page')] : []);
const sortedPages = () => pages().sort((a, b) => rank(keyOf(a)) - rank(keyOf(b)));
const rank = key => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
const activePage = () => pages().find(page => keyOf(page) === current) || null;
const metaOf = key => ({...(registered.get(key) || BUILT_IN[key] || {}), ...(EXTRA[key] || {})});
const titleOf = page => page.querySelector(':scope > h3')?.textContent.trim() || 'Settings';

// A page is listed only when something on it can be used. Owner-only controls hide themselves for viewers.
function hasControls(page) {
  return [...page.querySelectorAll('button, a[href], input, select, textarea')].some(el => {
    for (let node = el; node && node !== page; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).display === 'none') return false;
    }
    return true;
  });
}

function subtitleOf(key) {
  try {
    return String(metaOf(key).summary?.() ?? '');
  } catch {
    // A summary that fails only costs the subtitle, never the row.
    return '';
  }
}

function make(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function renderList() {
  const rows = [];
  for (const page of sortedPages()) {
    if (!hasControls(page)) continue;
    const key = keyOf(page);
    const icon = make('span', 'menu-row-icon', metaOf(key).icon || '◇');
    const sub = subtitleOf(key);
    const text = make('span', 'menu-row-text', make('span', 'menu-row-title', titleOf(page)), ...(sub ? [make('span', 'menu-row-sub', sub)] : []));
    const chevron = make('span', 'menu-row-chevron', '›');
    icon.setAttribute('aria-hidden', 'true');
    chevron.setAttribute('aria-hidden', 'true');
    const badge = Number(metaOf(key).badge?.()) || 0;
    const row = make('button', 'menu-row', icon, text, ...(badge ? [make('span', 'menu-row-badge', `${badge} to set up`)] : []), chevron);
    row.type = 'button';
    row.dataset.category = key;
    rows.push(row);
  }
  menu.querySelector('#settings-list').replaceChildren(...rows);
}

// Shows the list or the open category. Pages not on screen are hidden, so their controls are never reachable.
function apply() {
  if (!menu) return;
  const active = activePage();
  for (const page of pages()) page.hidden = page !== active;
  renderList();
  menu.querySelector('#settings-list').hidden = !!active;
  menu.querySelector('#settings-back').hidden = !active;
  menu.querySelector('#town-menu-title').textContent = active ? titleOf(active) : 'Settings';
  paintBuild();
}

function slide(element, direction) {
  if (!element?.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  element.animate([{transform: `translateX(${direction * 24}px)`, opacity: 0}, {transform: 'none', opacity: 1}], {duration: 200, easing: 'ease-out'});
}

// Moves between the list (key null) and a category page, then puts focus where the reader expects it.
function go(key) {
  const origin = current;
  current = key;
  apply();
  const title = menu.querySelector('#town-menu-title');
  if (key && activePage()) {
    slide(activePage(), 1);
    title.focus();
  } else {
    current = null;
    slide(menu.querySelector('#settings-list'), -1);
    menu.querySelector(`.menu-row[data-category="${origin}"]`)?.focus();
  }
}

function readLast() {
  try {
    return sessionStorage.getItem(LAST_KEY) || null;
  } catch {
    return null;
  }
}

function writeLast(key) {
  try {
    if (key) sessionStorage.setItem(LAST_KEY, key);
    else sessionStorage.removeItem(LAST_KEY);
  } catch {
    // Blocked storage: the menu still opens on the list.
  }
}

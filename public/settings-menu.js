// The ☰ settings menu: one flat list of device and app settings, then one page per row (docs/design/menu-chat-mailman.md).
// Each row is a top-level .menu-page section of the menu body. A section added with registerSettingsSection becomes a page too;
// its optional {icon, summary} drives its row. Only ROWS are listed: what a cat looks after lives with that cat (manage.js).
// A page that is not a row (Town controls, Mayor's autonomy) opens straight from its own entry point with openSettingsPage, as can a row's page.
// Under the list: the build this server runs (GET /api/state build), and a notice when newer code is on disk.
// One name per thing it opens: the ☰ button is "Settings" and opens the list under that heading; a page opened on its own is headed by
// its own name (the header's status dot says "town controls" and opens "Town controls"), and its close button says that name too.
import {ago} from './quests-panel.js';
import {icon as lucide} from './icons.js';

const LAST_KEY = 'cat-town-settings-page';
/** The list's name: the dialog's heading, the ☰ button's accessible name (index.html) and the palette's row (command-palette.js). */
export const MENU_NAME = 'Settings';
/** The ☰ list, in order. Seven rows; nothing else is listed. */
export const ROWS = Object.freeze(['appearance', 'sound', 'screen', 'devices', 'models', 'worlds', 'backup']);
// A row whose page holds only this one control opens it at once (the host's Devices and AI models): a page of one button is a dead step.
const DIRECT = {devices: 'share', models: 'models-open'};
const registered = new Map();
let menu = null;     // the ☰ dialog, once initSettingsNav has run
let current = null;  // the open category's key, or null for the list
let direct = false;  // true while a page was opened on its own (openSettingsPage): no Back, and Escape closes
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
  appearance: {summary: appearanceNow},
  town: {summary: townNow},
  devices: {summary: () => 'Pair a phone or tablet, or view on Wi-Fi'},
  models: {summary: () => 'Choose the models your cats think with'},
  screen: {summary: () => (document.fullscreenElement ? 'Fullscreen on' : 'Fullscreen off')},
};

// Each row's Lucide icon (the index.html sprite), and the subtitles this module owns. They override what was registered for the same id.
const ICONS = {appearance: 'palette', sound: 'volume-2', screen: 'maximize', devices: 'smartphone', models: 'sparkles', worlds: 'globe', backup: 'copy'};
const EXTRA = {
  worlds: {summary: () => `Active: ${document.getElementById('worlds-chip-name')?.textContent.trim() || 'this town'}`},
};

// The setup hub's CSS loads with the menu, so the hub (opened from the Mayor's thread or the palette) never draws unstyled.
function ensureSetupStyles() {
  if (document.querySelector('link[data-setup-hub]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./setup-hub.css', import.meta.url).href;
  link.dataset.setupHub = '';
  document.head.append(link);
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
  ensureSetupStyles();
  // Once per browser, and only when the brain is not ready (checked inside setup-hub.js, which also waits for the welcome to end).
  setTimeout(() => void import('./setup-hub.js').then(hub => hub.autoOpenOnce()).catch(() => {}), 1500);
  menu.querySelector('#settings-back').addEventListener('click', () => go(null));
  menu.querySelector('#settings-list').addEventListener('click', e => {
    const row = e.target.closest('.menu-row');
    if (!row) return;
    const key = row.dataset.category;
    // A row with an action (Worlds) opens its own screen directly instead of a menu page.
    const action = registered.get(key)?.action;
    if (typeof action === 'function') { menu.close?.(); action(); return; }
    // The host's Devices and AI models: the page would hold one button, so the row presses it.
    const only = soleControl(key);
    if (only) { menu.close?.(); only.click(); return; }
    go(key);
  });
  menu.addEventListener('cancel', e => {
    if (!activePage() || direct) return;
    e.preventDefault();
    go(null);
  });
  menu.addEventListener('close', () => {
    if (!direct) writeLast(current);
    else current = readLast();
    direct = false;
    delete menu.dataset.over;
    apply();
  });
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
}

/**
 * Opens the menu straight on one page, as a sheet of its own: Town controls from the header's status dot, the Mayor's autonomy and
 * Backups from the chat. over 'thread' docks it over the chat pane from 900px (manage.css). No Back: Escape and × close it, and the
 * list keeps the row it showed last. Returns false when the page is not there (a viewer's hidden section, say).
 */
export function openSettingsPage(key, {over = null} = {}) {
  if (!menu) return false;
  const page = pages().find(p => keyOf(p) === key);
  if (!page || !hasControls(page)) return false;
  noteScreenLinks();
  direct = true;
  current = key;
  if (over) menu.dataset.over = over; else delete menu.dataset.over;
  apply();
  if (!menu.open) menu.showModal?.();
  menu.querySelector('#town-menu-title')?.focus?.({preventScroll: true});
  return true;
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
// The listed pages, in ROWS order. A registered page that is not a row stays out of the list.
const rowPages = () => ROWS.map(key => pages().find(page => keyOf(page) === key)).filter(Boolean);
const activePage = () => pages().find(page => keyOf(page) === current) || null;
const metaOf = key => ({...(BUILT_IN[key] || {}), ...(registered.get(key) || {}), ...(EXTRA[key] || {})});
const titleOf = page => page.querySelector(':scope > h3')?.textContent.trim() || MENU_NAME;
/** The close button's name: the list and its rows are "settings"; a page opened on its own closes under its own name. */
export const closeLabel = (title, alone) => (alone && title ? `Close ${title}` : 'Close settings');

// A page is listed only when something on it can be used. Owner-only controls hide themselves for viewers.
function usable(page) {
  // A section that found its route closed hides itself (style.display none): nothing on it counts, even while every page is hidden.
  if (page.style?.display === 'none') return [];
  return [...page.querySelectorAll('button, a[href], input, select, textarea')].filter(el => {
    for (let node = el; node && node !== page; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).display === 'none') return false;
    }
    return true;
  });
}
const hasControls = page => usable(page).length > 0;

// The one control a DIRECT row's page holds on this device, or null when it holds more (a paired phone's Passkey and Unpair) or another.
function soleControl(key) {
  const page = pages().find(p => keyOf(p) === key), only = page ? usable(page) : [];
  return DIRECT[key] && only.length === 1 && only[0].id === DIRECT[key] ? only[0] : null;
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
  for (const page of rowPages()) {
    if (!hasControls(page)) continue;
    const key = keyOf(page);
    const glyph = make('span', 'menu-row-icon', ICONS[key] ? lucide(ICONS[key], {size: 18}) : '◇');
    const sub = subtitleOf(key);
    const text = make('span', 'menu-row-text', make('span', 'menu-row-title', titleOf(page)), ...(sub ? [make('span', 'menu-row-sub', sub)] : []));
    const chevron = make('span', 'menu-row-chevron', '›');
    glyph.setAttribute('aria-hidden', 'true');
    chevron.setAttribute('aria-hidden', 'true');
    const row = make('button', 'menu-row', glyph, text, chevron);
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
  menu.querySelector('#settings-back').hidden = !active || direct;
  menu.querySelector('#town-menu-title').textContent = active ? titleOf(active) : MENU_NAME;
  menu.querySelector('.menu-tools > .close-x')?.setAttribute('aria-label', closeLabel(active ? titleOf(active) : '', direct));
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

// Only a listed row comes back; a page opened on its own (Town controls, Mayor's autonomy) never does.
function readLast() {
  try {
    const key = sessionStorage.getItem(LAST_KEY);
    return ROWS.includes(key) ? key : null;
  } catch {
    return null;
  }
}

function writeLast(key) {
  try {
    if (key && ROWS.includes(key)) sessionStorage.setItem(LAST_KEY, key);
    else sessionStorage.removeItem(LAST_KEY);
  } catch {
    // Blocked storage: the menu still opens on the list.
  }
}

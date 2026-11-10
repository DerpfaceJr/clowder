// Phone, tablet and desktop chrome: the settings menu, sheet grips, house names and the layout around the chat (plan 8.5).
// Nothing runs at import time; the pure helpers are shared with Node tests.
import {initSettingsNav, refreshSettingsNav} from './settings-menu.js';

// Narrow screens (under 900px) are chat first: one sheet at a time, and the town is a strip while a sheet is open (initPaneLayout).
export const COMPACT_QUERY = '(max-width:899px)';
export const PHONE_QUERY = '(max-width:599px)';
// From 1280px a left sheet and the full chat pane fit side by side over the town; below that the chat folds to its rail.
export const TWO_PANES_QUERY = '(min-width:1280px)';

// Decides a sheet after a grip gesture. dy is pointer travel in px (positive = downward).
// A tap (tiny travel) closes the sheet, so the grip is also a close handle.
export function nextSheetState(size, dy, threshold = 64) {
  if (Math.abs(dy) < 6) return 'closed';
  if (dy >= threshold) return size === 'full' ? 'half' : 'closed';
  if (dy <= -threshold) return 'full';
  return size;
}

// Pointer handling for a grip: live feedback while moving, one decision on release.
// onRelease(null) means the gesture was cancelled and nothing should change.
export function bindGrip(grip, {onMove, onRelease}) {
  let start = null;
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    start = {id: e.pointerId, y: e.clientY};
    grip.setPointerCapture?.(e.pointerId);
  });
  grip.addEventListener('pointermove', e => {
    if (start?.id === e.pointerId) onMove(e.clientY - start.y);
  });
  grip.addEventListener('pointerup', e => {
    if (start?.id !== e.pointerId) return;
    const dy = e.clientY - start.y;
    start = null;
    onRelease(dy);
  });
  grip.addEventListener('pointercancel', e => {
    if (start?.id !== e.pointerId) return;
    start = null;
    onRelease(null);
  });
}

// A panel becomes a sheet on compact screens. Its size is kept on data-size (half or full).
// While the town is a strip (body.town-strip) a sheet already fills the room under it: a tap or a swipe down closes it, nothing resizes.
export function initSheet(panel, {onClose, onResize}) {
  const grip = panel.querySelector('.sheet-grip');
  if (!grip) return;
  bindGrip(grip, {
    onMove: dy => { panel.style.transform = dy > 0 ? `translateY(${dy}px)` : ''; },
    onRelease: dy => {
      panel.style.transform = '';
      if (dy === null) return;
      const strip = panel.ownerDocument?.body?.classList?.contains('town-strip') === true;
      const next = nextSheetState(strip ? 'half' : panel.dataset.size || 'half', dy);
      if (next === 'closed') onClose();
      else if (!strip) { panel.dataset.size = next; onResize?.(next); }
    },
  });
}

// ===== The layout around the chat (plan 8.5) =====
// Under 900px the app is chat first: one sheet at a time, and while one is open the town is a 96px strip under the header
// (body.town-strip). From 900px the chat is a pane on the right that never closes: it folds to a 56px rail (body.chat-rail). The
// other sheets open on the left, and below 1280px a left sheet folds the chat, so two full panes never cover the town. The Inbox
// moves into the top of the chat pane. setPanel in app.js stays the one place that opens and closes panels: it asks plan() what
// must give way and calls sync() after every change.

/** The sheets that open on the left from 900px. Cats and the Diary share the left column; the others take it alone. */
export const LEFT_SHEETS = ['residents', 'diary', 'season', 'projects'];
const SHARED_LEFT = ['residents', 'diary'];

/**
 * The open panels that must close when `id` opens or closes. Pure: isOpen(id) says which panels are open now.
 * Narrow: one sheet at a time. Wide: the Inbox is part of the chat pane, so folding the chat closes the Inbox. Below 1280px,
 * opening either of them closes the left sheets, and a left sheet (which folds the chat) closes the Inbox.
 */
export function rivalsOf(id, open, {narrow, twoPanes, isOpen, panels}) {
  if (narrow) return open ? panels.filter(p => p !== id && isOpen(p)) : [];
  const left = LEFT_SHEETS.filter(isOpen), inbox = isOpen('quests') ? ['quests'] : [];
  if (id === 'inspector') return open ? (twoPanes ? [] : left) : inbox;
  if (id === 'quests') return open && !twoPanes ? left : [];
  if (!open || !LEFT_SHEETS.includes(id)) return [];
  const others = left.filter(p => p !== id && !(SHARED_LEFT.includes(p) && SHARED_LEFT.includes(id)));
  return twoPanes ? others : [...others, ...inbox];
}

/** Whether the chat shows as its rail: never under 900px; from 900px when the owner folded it, or a left sheet needs the room. */
export function chatRail({narrow, folded, leftOpen, twoPanes}) {
  return !narrow && (folded || (leftOpen && !twoPanes));
}

/** What one state change brought for the owner: replies to the owner and decisions newly waiting, by ids the previous state lacked. */
export function newForOwner(prev, next) {
  const fresh = (before, after, keep) => {
    if (!Array.isArray(before) || !Array.isArray(after)) return 0;
    const seen = new Set(before.map(x => x?.id));
    return after.filter(x => keep(x) && !seen.has(x.id)).length;
  };
  return fresh(prev?.messages, next?.messages, m => m?.to === 'owner') + fresh(prev?.approvals, next?.approvals, a => a?.status === 'pending');
}

/** The cat the chat header names ("Mayor’s corner" names the Mayor), or null for any other heading. */
export const headerCat = text => /^(.+?)[’']s corner$/.exec(String(text ?? '').trim())?.[1] ?? null;

/** The rail's accessible name: whose chat it opens, and how many replies and decisions wait there unread. */
export function railName(cat, unread = 0) {
  const name = cat ? `Open chat with ${cat}` : 'Open chat';
  return unread > 0 ? `${name}, ${unread} unread` : name;
}

/**
 * The header's lead (plan 11.5, F12): what waits on the owner, said before the activity line. nouns: the Inbox's noun (plain-words.js
 * nounOf) of each item behind the one "needs you" count (quests-panel.js needsYouCount), so the number is that count. Empty when nothing
 * waits. One kind is named ("3 decisions waiting", "1 to-do waiting"); decisions and to-dos together name both; anything else is a thing.
 */
export function waitingLead(nouns) {
  const list = [...(nouns ?? [])], n = list.length;
  if (!n) return '';
  const many = (k, one, more) => `${k} ${k === 1 ? one : more}`;
  const decisions = list.filter(x => x === 'Decision').length, todos = list.filter(x => x === 'To-do').length;
  if (decisions === n) return `${many(n, 'decision', 'decisions')} waiting`;
  if (todos === n) return `${many(n, 'to-do', 'to-dos')} waiting`;
  if (decisions + todos === n) return `${many(decisions, 'decision', 'decisions')} and ${many(todos, 'to-do', 'to-dos')} waiting`;
  return `${many(n, 'thing', 'things')} waiting`;
}

/** The town strip's caption: the header's lead and its activity line, each only while the header shows it. */
export const stripCaption = (...parts) => parts.map(p => String(p ?? '').trim()).filter(Boolean).join(' · ');

/**
 * Builds the rail and the town strip, moves the Inbox, wires the narrow dock's Town and More, and keeps the body classes the CSS
 * keys on. panels: every panel id. setPanel(id, open, focus): app.js's. pin(): scrolls the conversation to its newest message.
 * Returns {plan, sync, focusAfterClose}.
 */
export function initPaneLayout({doc = globalThis.document, win = globalThis, panels, setPanel, pin = () => {}}) {
  const $ = id => doc.getElementById(id);
  const body = doc.body, chat = $('inspector-panel'), header = $('cat-header');
  const narrowQuery = win.matchMedia(COMPACT_QUERY), twoQuery = win.matchMedia(TWO_PANES_QUERY);
  const Observer = win.MutationObserver;
  const isOpen = id => $(`${id}-panel`)?.hidden === false;
  let folded = false, wasRail = false, unread = 0;

  // From 900px the Inbox (the quests panel) is the top of the chat pane, under its header rows; under 900px it is a sheet again.
  const inbox = $('quests-panel'), inboxHome = inbox?.parentElement, tabs = chat.querySelector('.tabs');
  function placeInbox() {
    if (!inbox || !inboxHome) return;
    if (narrowQuery.matches) { if (inbox.parentElement !== inboxHome) inboxHome.append(inbox); }
    else if (inbox.parentElement !== chat) chat.insertBefore(inbox, tabs);
  }
  placeInbox();

  // The rail: one button showing the open cat's avatar (copied from the chat header) and what came for the owner since it folded.
  const rail = doc.createElement('button'), face = doc.createElement('span'), count = doc.createElement('span');
  rail.type = 'button';
  rail.className = 'chat-rail-open';
  rail.setAttribute('aria-expanded', 'false');
  face.className = 'chat-rail-face';
  count.className = 'chat-rail-count';
  for (const part of [face, count]) part.setAttribute('aria-hidden', 'true');
  count.hidden = true;
  rail.append(face, count);
  chat.prepend(rail);
  rail.addEventListener('click', () => setPanel('inspector', true, true));
  let faceKey = null;
  function paintRail() {
    const avatar = header?.querySelector('.avatar') ?? null, key = avatar?.outerHTML ?? '';
    if (key !== faceKey) { faceKey = key; face.replaceChildren(...(avatar ? [avatar.cloneNode(true)] : [])); }
    count.hidden = unread <= 0;
    count.textContent = unread > 99 ? '99+' : String(unread);
    rail.setAttribute('aria-label', railName(headerCat(header?.querySelector('h2')?.textContent), unread));
  }
  if (header && Observer) new Observer(paintRail).observe(header, {childList: true, subtree: true, characterData: true});
  win.addEventListener('town-state', e => {
    if (!body.classList.contains('chat-rail')) return;
    unread += newForOwner(e.detail?.prev, e.detail?.next);
    paintRail();
  });

  // The strip: the whole town card is one button that shows the town, captioned with the header's line: the lead (app.js draws
  // #world-waiting, plan 11.5) and the activity line. A part the header hides (nothing waits, or Clowder is not answering) is left out.
  const wrap = $('canvas-wrap'), activity = $('world-activity');
  const strip = doc.createElement('button'), caption = doc.createElement('span');
  strip.type = 'button';
  strip.className = 'town-strip-open';
  strip.setAttribute('aria-label', 'Show the town');
  caption.className = 'town-strip-caption';
  caption.id = 'town-strip-caption';
  strip.setAttribute('aria-describedby', caption.id);
  strip.append(caption);
  wrap?.append(strip);
  const shown = node => (node && !node.hidden ? node.textContent : '');
  const mirror = () => { const text = stripCaption(shown($('world-waiting')), shown(activity)); if (caption.textContent !== text) caption.textContent = text; };
  // The whole line is watched, so the lead is mirrored whenever app.js adds it, and either part's hidden flag too.
  const line = activity?.parentElement;
  if (line && Observer) new Observer(mirror).observe(line, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden']});
  mirror();

  // The narrow dock's Town and More: Town closes every sheet; More opens the list of the other panels above the dock.
  const town = $('dock-town'), more = $('dock-more'), list = $('dock-more-menu');
  const showTown = () => { for (const id of panels) if (isOpen(id)) setPanel(id, false); };
  strip.addEventListener('click', () => { showTown(); town?.focus(); });
  town?.addEventListener('click', showTown);
  const listOpen = () => list?.classList.contains('is-open') === true;
  const setList = open => { list?.classList.toggle('is-open', open); more?.setAttribute('aria-expanded', String(open)); };
  more?.addEventListener('click', () => setList(!listOpen()));
  // An item closes the list first and leaves focus on More, so its sheet or layer hands focus back there when it closes.
  list?.addEventListener('click', e => { if (listOpen() && e.target.closest?.('button')) { setList(false); more.focus(); } }, true);
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && listOpen()) { e.preventDefault(); e.stopPropagation(); setList(false); more.focus(); } }, true);
  doc.addEventListener('pointerdown', e => { if (listOpen() && !list.contains(e.target) && !more.contains(e.target)) setList(false); });

  const close = chat.querySelector('[data-collapse="inspector"]');
  const dockLabel = id => $(`toggle-${id}`)?.querySelector('.dock-label')?.textContent.trim() || id;
  function sync() {
    const narrow = narrowQuery.matches, twoPanes = twoQuery.matches, open = panels.filter(isOpen), menu = $('town-menu');
    // A ☰ page opened from the chat (Autonomy, Backups) sits over the thread on the right, so the chat stays.
    const leftOpen = open.some(id => LEFT_SHEETS.includes(id)) || (menu?.open === true && menu.dataset?.over !== 'thread');
    const isRail = chatRail({narrow, folded, leftOpen, twoPanes});
    body.classList.toggle('town-strip', narrow && open.length > 0);
    body.classList.toggle('chat-rail', isRail);
    $('toggle-inspector')?.setAttribute('aria-expanded', String(narrow ? isOpen('inspector') : !isRail));
    if (narrow && open.length === 0) town?.setAttribute('aria-current', 'true');
    else town?.removeAttribute('aria-current');
    const inMore = narrow ? open.find(id => list?.contains($(`toggle-${id}`))) : undefined;
    more?.classList.toggle('has-open', !!inMore);
    more?.setAttribute('aria-label', inMore ? `More, ${dockLabel(inMore)} open` : 'More');
    if (!narrow && listOpen()) setList(false);
    // From 900px the chat's close button folds it to the rail.
    close?.setAttribute('aria-label', narrow ? 'Close chat' : 'Collapse chat');
    close?.querySelector('use')?.setAttribute('href', narrow ? '#i-x' : '#i-chevron-right');
    if (isRail !== wasRail) { unread = 0; if (!isRail) pin(); }
    wasRail = isRail;
    paintRail();
  }

  /** Records a fold or an unfold of the chat, then returns the open panels that must close for `id`. */
  function plan(id, open) {
    const narrow = narrowQuery.matches;
    if (!narrow && id === 'inspector') folded = !open;
    if (!narrow && id === 'quests' && open) folded = false;
    return rivalsOf(id, open, {narrow, twoPanes: twoQuery.matches, isOpen, panels});
  }

  /** Where focus goes when a panel closes: the rail for the folded chat, More for a sheet whose button is in the More list. */
  function focusAfterClose(id) {
    if (id === 'inspector' && !narrowQuery.matches) return rail;
    const button = $(`toggle-${id}`);
    return narrowQuery.matches && list?.contains(button) ? more : button;
  }

  // Widening past 900px: the chat is the pane again, or its rail while a left sheet is open below 1280px. Narrowing is app.js's (it
  // keeps one sheet). Crossing 1280px only changes whether the chat folds; going below it, a left sheet closes the Inbox.
  narrowQuery.addEventListener('change', e => {
    placeInbox();
    if (e.matches) { sync(); return; }
    if (LEFT_SHEETS.some(isOpen) && !twoQuery.matches) { setPanel('inspector', false); folded = false; sync(); }
    else setPanel('inspector', true);
  });
  twoQuery.addEventListener('change', e => {
    if (!e.matches && !narrowQuery.matches && LEFT_SHEETS.some(isOpen) && isOpen('quests')) setPanel('quests', false);
    sync();
  });
  // Settings (the ☰ sheet) opens on the left from 900px, so it folds the chat below 1280px too.
  const menu = $('town-menu');
  if (menu && Observer) new Observer(() => sync()).observe(menu, {attributes: true, attributeFilter: ['open']});
  paintRail();
  return {plan, sync, focusAfterClose};
}

// The ☰ menu is a modal dialog on every width: a bottom sheet on phones, a side sheet on desktop. Focus is trapped, Escape steps back from a category page and then closes it, and focus returns to the toggle.
// Tapping an action closes it first so the action's own dialog is not stacked underneath.
export function initTownMenu(dialog, toggle) {
  const setExpanded = open => toggle.setAttribute('aria-expanded', String(open));
  initSettingsNav(dialog);
  toggle.addEventListener('click', () => { refreshSettingsNav(); dialog.showModal(); setExpanded(true); });
  dialog.addEventListener('close', () => setExpanded(false));
  dialog.addEventListener('click', e => {
    if (e.target === dialog || e.target.closest('.menu-items button:not([data-world-view]):not([data-label-mode]):not([data-quality])')) dialog.close();
  });
  const body = dialog.querySelector('.menu-body'), grip = dialog.querySelector('.sheet-grip');
  if (grip) bindGrip(grip, {
    onMove: dy => { body.style.transform = dy > 0 ? `translateY(${dy}px)` : ''; },
    onRelease: dy => {
      body.style.transform = '';
      if (dy !== null && nextSheetState('half', dy) === 'closed') dialog.close();
    },
  });
}

// House names: which cat labels float over the town. The stored value is one of auto, on, off.
export const LABEL_KEY = 'cat-town-house-names';
export const LABEL_MODES = ['auto', 'on', 'off'];

// Anything unknown falls back to auto, the phone rule, which is the timid default.
export function normalizeLabelMode(value) {
  return LABEL_MODES.includes(value) ? value : 'auto';
}

// Storage can throw (private mode, blocked site data) or be missing, so every failure reads as auto.
export function readLabelMode(storage) {
  try { return normalizeLabelMode(storage?.getItem(LABEL_KEY)); } catch { return 'auto'; }
}

// Returns the mode actually kept, so callers never trust the raw input.
export function writeLabelMode(storage, mode) {
  const next = normalizeLabelMode(mode);
  try { storage?.setItem(LABEL_KEY, next); } catch { /* the choice still applies for this page */ }
  return next;
}

// The CSS keys on body[data-labels]. Returns the value written.
export function applyLabelMode(body, mode) {
  const next = normalizeLabelMode(mode);
  body.dataset.labels = next;
  return next;
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// Wires the House names switch: each [data-label-mode] button sets the pref and its aria-pressed state.
export function initHouseNames(doc, control, storage = defaultStorage()) {
  const show = mode => {
    const next = applyLabelMode(doc.body, mode);
    for (const b of control.querySelectorAll('[data-label-mode]')) b.setAttribute('aria-pressed', String(b.dataset.labelMode === next));
    return next;
  };
  control.addEventListener('click', e => {
    const b = e.target.closest?.('[data-label-mode]');
    if (b && control.contains(b)) show(writeLabelMode(storage, b.dataset.labelMode));
  });
  return show(readLabelMode(storage));
}

// Installed apps (home-screen PWAs) report standalone mode in two ways: the media query, and iOS's navigator.standalone.
export function isStandalone(win) {
  return !!(win?.matchMedia?.('(display-mode: standalone)').matches || win?.navigator?.standalone === true);
}

// iPhone and iPad report as Mac on iPadOS 13+, so touch points settle it.
export function isIOS(nav) {
  return /iPad|iPhone|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

const SHARE_GLYPH = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';

export const QUICK_TUNNEL_WARNING = 'This address changes when the town restarts, so each install adds a new icon. Remove the old Clowder icon first, or set up Tailscale for one permanent app.';
export const INSTALLED_NOTE = 'Clowder is already installed on this device. Open it from your home screen.';

// Pure: true when the browser lists this origin's web app for the manifest. A missing API or an empty list means not known.
export function isInstalledApp(apps, manifestPath = '/manifest.webmanifest') {
  return Array.isArray(apps) && apps.some(app => app?.platform === 'webapp' && (!app.url || new URL(app.url, 'https://town.invalid').pathname === manifestPath));
}

// Pure: warn only where the address is a quick tunnel, whose address changes on every restart. Tailscale and named tunnels keep one address; localhost is not a tunnel.
// provider and named come from the owner's remote status. Without them (a paired device gets 403), the hostname decides.
export function installWarning({provider, named = false, hostname = ''} = {}) {
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname)) return null;
  const quick = provider === undefined ? /\.trycloudflare\.com$/i.test(hostname) : provider !== 'tailscale' && named !== true;
  return quick ? QUICK_TUNNEL_WARNING : null;
}

// The owner-only status route names the carrier; paired devices get 403 and fall back to the address alone.
async function remoteStatus(win) {
  if (typeof win.fetch !== 'function') return {};
  try {
    const response = await win.fetch('/api/remote/status', {cache: 'no-store'});
    if (!response.ok) return {};
    const data = await response.json();
    return {provider: data.provider, named: data.named};
  } catch { return {}; }
}

// Builds the install sheet in code, so index.html stays untouched. Every string is static, except the warning, which is static too.
function installSheet(doc, ios, {warning = null, install: runInstall = null} = {}) {
  const dialog = doc.createElement('dialog');
  dialog.id = 'install-dialog';
  dialog.setAttribute('aria-labelledby', 'install-title');
  const eyebrow = doc.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'ADD TO HOME SCREEN';
  const title = doc.createElement('h2');
  title.id = 'install-title';
  title.textContent = 'Install Clowder.';
  const parts = [eyebrow, title];
  if (warning) {
    const caution = doc.createElement('p');
    caution.className = 'install-warning';
    caution.setAttribute('role', 'note');
    caution.textContent = warning;
    parts.push(caution);
  }
  const body = doc.createElement('p');
  const actions = doc.createElement('div');
  actions.className = 'dialog-actions';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Done';
  close.onclick = () => dialog.close();
  if (ios) {
    body.append('Tap ');
    const glyph = doc.createElement('span');
    glyph.className = 'install-glyph';
    glyph.innerHTML = SHARE_GLYPH;
    body.append(glyph, ' Share, then Add to Home Screen.');
    const note = doc.createElement('p');
    note.textContent = 'Open it from the home screen after that. It keeps its own icon and opens without the browser bar.';
    parts.push(body, note);
  } else {
    body.textContent = 'Open your browser menu and choose Install app or Add to Home Screen.';
    parts.push(body);
  }
  if (runInstall) {
    const install = doc.createElement('button');
    install.type = 'button';
    install.className = 'primary';
    install.textContent = 'Install now';
    install.onclick = async () => {
      try { await runInstall(); dialog.close(); }
      catch { body.textContent = 'The browser did not open the install prompt. Use your browser menu and choose Install app.'; }
    };
    actions.append(install);
  }
  actions.append(close);
  dialog.append(...parts, actions);
  doc.body.append(dialog);
  return dialog;
}

// The town menu's Install app item. Absent entirely when already installed, so it can never show in standalone mode.
// Chrome and Android: the captured beforeinstallprompt event runs the native prompt, and the browser says whether this app is already installed here.
// iOS has no such API, so its item stays and the sheet shows the share steps. A quick-tunnel address gets a warning before any install.
// Android phones in a browser get the native app: one app that keeps working when the town's address changes.
export const offersAndroidApp = (userAgent = '') => /Android/i.test(userAgent) && !/ClowderAndroid/.test(userAgent);

export function initInstallApp(doc, win, nav = win.navigator) {
  if (isStandalone(win)) return null;
  const group = doc.querySelector('#settings-screen .menu-items');
  if (!group) return null;
  if (offersAndroidApp(nav.userAgent)) {
    const link = doc.createElement('a');
    link.id = 'get-android-app';
    link.className = 'menu-link';
    link.href = '/app/clowder.apk';
    link.setAttribute('download', 'Clowder.apk');
    link.textContent = 'Get the Android app';
    group.append(link);
  }
  if (/ClowderAndroid/.test(nav.userAgent || '')) return null;
  const button = doc.createElement('button');
  button.id = 'install-app';
  button.type = 'button';
  button.textContent = 'Install app';
  group.append(button);
  let deferred = null;
  let installedShown = false;
  const showInstalled = () => {
    if (installedShown) return;
    installedShown = true;
    button.remove();
    deferred = null;
    const note = doc.createElement('p');
    note.id = 'install-installed';
    note.className = 'muted';
    note.textContent = INSTALLED_NOTE;
    group.append(note);
  };
  win.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
  win.addEventListener('appinstalled', showInstalled);
  nav.getInstalledRelatedApps?.().then(apps => { if (isInstalledApp(apps)) showInstalled(); }).catch(() => {});
  const ios = isIOS(nav);
  const remote = remoteStatus(win);
  let sheet = null;
  button.addEventListener('click', async () => {
    const warning = installWarning({...(await remote), hostname: win.location?.hostname});
    if (deferred && !warning) {
      const event = deferred;
      deferred = null;
      try { await event.prompt(); return; } catch { /* the browser refused the prompt: show the sheet instead */ }
    }
    sheet?.remove();
    sheet = installSheet(doc, ios, {warning, install: deferred ? () => { const next = deferred; deferred = null; return next.prompt(); } : null});
    sheet.showModal();
  });
  return button;
}

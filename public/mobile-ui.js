// Phone, tablet and desktop chrome: the settings menu, sheet grips and house names.
// Nothing runs at import time; the pure helpers are shared with Node tests.
import {initSettingsNav, refreshSettingsNav} from './settings-menu.js';

export const COMPACT_QUERY = '(max-width:1100px)';
export const PHONE_QUERY = '(max-width:599px)';

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
export function initSheet(panel, {onClose, onResize}) {
  const grip = panel.querySelector('.sheet-grip');
  if (!grip) return;
  bindGrip(grip, {
    onMove: dy => { panel.style.transform = dy > 0 ? `translateY(${dy}px)` : ''; },
    onRelease: dy => {
      panel.style.transform = '';
      if (dy === null) return;
      const next = nextSheetState(panel.dataset.size || 'half', dy);
      if (next === 'closed') onClose();
      else { panel.dataset.size = next; onResize?.(next); }
    },
  });
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

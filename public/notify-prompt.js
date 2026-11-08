// The first-run prompt to turn notifications on (plan 3.4, ux-audit F6). One quiet toast above the dock, once per browser, on an owner
// device whose browser can show notifications and is not getting them yet. GET /api/push/status says whether this device already does.
// A browser with a subscription of its own asks with ?endpoint=, so one the server has lost is offered again; a browser with none goes by
// the device, so a second browser on a computer that already gets them does not double them. Turn on runs notify.js's own subscribe
// flow (the controller initSound returns). Either answer is remembered, so it never asks twice; Settings, Sound & notifications keeps
// the switch. The pure helpers are exported for Node tests.
import {pushSupport} from './notify.js';

export const PROMPT_KEY = 'clowder.notify.prompt';
const WAIT_MS = 1000, GIVE_UP_MS = 120_000, READY_MS = 4000;

/**
 * Whether to ask. support: pushSupport(); permission: Notification.permission; status: GET /api/push/status, or null when the server
 * refused (a viewer); hasSubscription: this browser holds a push subscription; seen: an earlier answer, or true when storage is blocked.
 */
export function shouldPrompt({support, permission, status, hasSubscription, seen, desktopApp = false}) {
  if (seen || desktopApp) return false;
  if (!support?.push || support.needsInstall) return false;
  // Blocked in the browser: only its own site settings can undo that, so a card would only nag.
  if (permission === 'denied') return false;
  if (!status) return false;
  const on = hasSubscription ? status.endpoint === true : status.subscribed === true;
  return !on;
}

function readSeen(win) {
  try { return win.localStorage.getItem(PROMPT_KEY) !== null; } catch { return true; }
}
function writeSeen(win, answer) {
  try { win.localStorage.setItem(PROMPT_KEY, answer); } catch { /* the card still closes for this visit */ }
}

// This browser's own push subscription, or null. A service worker that never gets ready counts as none.
async function ownSubscription(win) {
  const workers = win.navigator?.serviceWorker;
  if (!workers) return null;
  const reg = await Promise.race([workers.ready.catch(() => null), new Promise(done => setTimeout(() => done(null), READY_MS))]);
  return (await reg?.pushManager?.getSubscription?.().catch(() => null)) ?? null;
}

/** What the server says about this device, or null when it refuses (a viewer, an unpaired browser) or cannot be reached. */
export async function pushStatus(fetchImpl, endpoint) {
  try {
    const response = await fetchImpl(`/api/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`, {cache: 'no-store'});
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function injectStyles(doc) {
  if (!doc.head || doc.querySelector('link[data-notify-prompt]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('notify-prompt.css', import.meta.url).href;
  link.dataset.notifyPrompt = '';
  doc.head.append(link);
}

function make(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/** The card. Resolves once it is answered or closed. controller: notify.js initSound's result. */
export function showNotifyPrompt({controller, win = window, doc = document, fetchImpl = (...args) => fetch(...args)}) {
  injectStyles(doc);
  const message = make(doc, 'p', {class: 'notify-prompt-msg', role: 'status'});
  const later = make(doc, 'button', {type: 'button', text: 'Not now'});
  const on = make(doc, 'button', {type: 'button', class: 'primary', text: 'Turn on'});
  const bell = make(doc, 'span', {class: 'notify-prompt-icon', 'aria-hidden': 'true'});
  bell.innerHTML = '<svg width="20" height="20" focusable="false"><use href="#i-bell"/></svg>';
  const card = make(doc, 'section', {class: 'notify-prompt', 'aria-labelledby': 'notify-prompt-title'}, [
    bell,
    make(doc, 'h2', {id: 'notify-prompt-title', text: 'Know when a cat needs you'}),
    make(doc, 'p', {text: 'Turn on notifications and this device tells you when a decision or a to-do waits for you, even with Clowder closed.'}),
    message,
    make(doc, 'div', {class: 'notify-prompt-actions'}, [later, on]),
  ]);
  doc.body.append(card);
  return new Promise(resolve => {
    const close = () => { card.remove(); resolve(); };
    later.onclick = () => { writeSeen(win, 'later'); close(); };
    on.onclick = async () => {
      writeSeen(win, 'asked');
      on.disabled = later.disabled = true;
      controller?.gesture?.();
      let text;
      try { text = await controller.enable(); } catch (error) { text = error.message || 'Notifications could not be turned on.'; }
      // Turned on means the server now lists this browser's own subscription, whatever enable() said.
      const sub = await ownSubscription(win);
      const status = sub ? await pushStatus(fetchImpl, sub.endpoint) : null;
      if (status?.endpoint === true) {
        message.textContent = 'Notifications are on for this device.';
        later.hidden = true; on.hidden = true;
        setTimeout(close, 2500);
        return;
      }
      message.textContent = text || 'Notifications are not on yet.';
      later.textContent = 'Close'; later.disabled = false; on.hidden = true;
      later.onclick = close;
    };
  });
}

/**
 * Runs once after the town loads on an owner device. Waits until no dialog or intro is on screen (the setup hub may open first), then
 * shows the card if shouldPrompt says so. Resolves true when the card was shown.
 */
export async function maybePromptNotifications({controller, win = window, doc = document, fetchImpl = (...args) => fetch(...args), wait = WAIT_MS} = {}) {
  const support = pushSupport(win, win.navigator), desktopApp = /Electron/i.test(win.navigator?.userAgent ?? '');
  const now = () => ({support, desktopApp, permission: win.Notification?.permission, seen: readSeen(win)});
  // Everything but the server's answer first, so a browser that will never be asked costs no request.
  if (!shouldPrompt({...now(), status: {subscribed: false}, hasSubscription: false})) return false;
  const started = Date.now();
  while (doc.querySelector('dialog[open], .intro-cinema.on')) {
    if (Date.now() - started > GIVE_UP_MS) return false;
    await new Promise(done => setTimeout(done, wait));
  }
  // Read after the wait: the setup hub may have turned notifications on while it was open.
  const sub = await ownSubscription(win);
  const status = await pushStatus(fetchImpl, sub?.endpoint);
  if (!shouldPrompt({...now(), status, hasSubscription: !!sub})) return false;
  void showNotifyPrompt({controller, win, doc, fetchImpl});
  return true;
}

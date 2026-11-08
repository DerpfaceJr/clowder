// Sound and notifications wiring: listens for town-state, plays audio, shows in-app notices for a hidden page, and manages Web Push subscriptions.
import {attachUiSounds, createAudio} from './audio.js';
import {installUiSounds} from './ui-sounds.js';
import {diffTownState,isMayorToOwner} from './town-events.js';
import {isIOS,isStandalone} from './mobile-ui.js';

export const PREF_KINDS = Object.freeze(['approvals', 'mayor', 'seasons', 'routines']);
export const PREF_STORAGE_KEY = 'clowder-notify';
// approvals is the server's kind for a decision or a to-do that needs you (push.ts noticeOf).
export const PREF_LABELS = Object.freeze({approvals: 'Decisions and to-dos', mayor: 'Messages from the Mayor', seasons: 'Season results', routines: 'Daily briefing'});

export function normalizePrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(PREF_KINDS.map(kind => [kind, typeof source[kind] === 'boolean' ? source[kind] : true]));
}

export function loadPrefs(storage) {
  try {
    const text = storage ? storage.getItem(PREF_STORAGE_KEY) : null;
    return normalizePrefs(text ? JSON.parse(text) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function savePrefs(storage, prefs) {
  const clean = normalizePrefs(prefs);
  try {
    if (storage) storage.setItem(PREF_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Blocked storage: the choice still holds for this page.
  }
  return clean;
}

/** Plain text for a notification: no control or format characters, one line, cut by code point with an ASCII ellipsis. */
export function noticeText(value, max) {
  const chars = Array.from(String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim());
  return chars.length > max ? chars.slice(0, Math.max(0, max - 3)).join('') + '...' : chars.join('');
}

/** The same notices the server would push, built from one town-state change. Tags and links match the server's (push.ts noticeOf), so a
 *  push and an in-app notice replace each other, and either one opens its decision's card. */
export function inAppNotices(diff, next, prefs) {
  const names = new Map((next?.cats || []).map(c => [c.id, c.name]));
  const out = [];
  if (prefs.approvals) for (const a of diff.approvals || []) out.push({kind: 'approvals', title: 'Clowder', body: `${names.get(a.cat) || a.cat} needs you: ${noticeText(a.question, 120)}`, tag: `approval-${a.id}`, url: approvalLink(a.id)});
  if (prefs.mayor) for (const m of diff.messages || []) if (isMayorToOwner(m)) out.push({kind: 'mayor', title: 'Mayor', body: noticeText(m.text, 240), tag: `mayor-${m.id}`, url: '/'});
  return out;
}

/** A notification opens its decision with this link (push.ts noticeOf builds the same one). */
export const approvalLink = id => `/#approval=${encodeURIComponent(String(id))}`;
/** The decision a link's fragment names ("#approval=<id>"), or null. Ids are the server's: letters, digits, _ and -, as sw.js accepts. */
export function approvalFromHash(hash) {
  const id = new URLSearchParams(String(hash ?? '').replace(/^#/, '')).get('approval');
  return id && /^[\w-]{1,80}$/.test(id) ? id : null;
}

/** The Sound & notifications row subtitle, e.g. "Music 35% · notifications on". */
export function soundSummary(settings, permission) {
  const music = settings.muted || settings.music === 0 ? 'Music off' : `Music ${settings.music}%`;
  return `${music} · notifications ${permission === 'granted' ? 'on' : 'off'}`;
}

export function urlBase64ToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

/** What this browser can do. iOS only offers web push to an installed home-screen app (iOS 16.4 or later). */
export function pushSupport(win, nav) {
  const hasPush = !!nav && 'serviceWorker' in nav && !!win && 'PushManager' in win && 'Notification' in win;
  const ios = isIOS(nav);
  const installed = isStandalone(win);
  return {
    push: hasPush,
    ios,
    needsInstall: ios && !installed,
    note: ios && !installed ? 'On iPhone and iPad, notifications work only for Clowder added to your Home Screen (iOS 16.4 or later). Open it from the Home Screen, then enable them.' : '',
  };
}

const JSON_HEADERS = {'Content-Type': 'application/json', 'X-Town-Action': 'owner'};
async function postJson(fetchImpl, path, body) {
  const res = await fetchImpl(path, {method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body)});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function element(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

/** Settings UI, built in code so no HTML or CSS files are touched. */
export function buildSoundSettings(doc, controller) {
  const audio = controller.audio;
  const status = element(doc, 'p', {className: 'sound-status', role: 'status'});
  const show = text => { status.textContent = text; };
  const settings = audio.settings();
  const slider = (label, key) => {
    const input = element(doc, 'input', {type: 'range', min: 0, max: 100, step: 1, value: settings[key], id: `sound-${key}`});
    input.addEventListener('input', () => audio.update({[key]: Number(input.value)}));
    return element(doc, 'label', {className: 'sound-slider'}, [element(doc, 'span', {textContent: label}), input]);
  };
  const mute = element(doc, 'input', {type: 'checkbox', id: 'sound-mute', checked: settings.muted});
  mute.addEventListener('change', () => audio.update({muted: mute.checked}));
  const memorialMusic = element(doc, 'input', {type: 'checkbox', id: 'sound-memorial-music', checked: settings.memorialMusic});
  memorialMusic.addEventListener('change', () => audio.update({memorialMusic: memorialMusic.checked}));
  const quiet = element(doc, 'input', {type: 'checkbox', id: 'sound-quiet', checked: settings.quiet});
  quiet.addEventListener('change', () => audio.update({quiet: quiet.checked}));
  // The buzz is offered only where the browser has a vibrator, and it starts off.
  const canVibrate = typeof controller.nav?.vibrate === 'function';
  const vibrate = element(doc, 'input', {type: 'checkbox', id: 'sound-vibrate', checked: settings.vibrate});
  vibrate.addEventListener('change', () => { audio.update({vibrate: vibrate.checked}); if (vibrate.checked) audio.haptic(); });
  const testSound = element(doc, 'button', {type: 'button', textContent: 'Test sound'});
  testSound.addEventListener('click', () => {
    controller.gesture();
    show(audio.play('chime') ? 'Playing a test chime.' : 'Sound is muted, or the effects volume is 0.');
  });

  const enable = element(doc, 'button', {type: 'button', textContent: 'Enable notifications'});
  enable.addEventListener('click', async () => {
    controller.gesture();
    enable.disabled = true;
    try {
      show(await controller.enable());
    } catch (error) {
      show(error.message || 'Notifications could not be enabled.');
    } finally {
      enable.disabled = false;
    }
  });
  const prefBoxes = PREF_KINDS.map(kind => {
    const box = element(doc, 'input', {type: 'checkbox', checked: controller.prefs[kind], id: `notify-${kind}`});
    box.addEventListener('change', async () => {
      controller.setPref(kind, box.checked);
      try {
        const result = await controller.resubscribe();
        if (result) show(result);
      } catch (error) {
        show(error.message);
      }
    });
    return element(doc, 'label', {className: 'notify-pref'}, [box, element(doc, 'span', {textContent: PREF_LABELS[kind]})]);
  });
  const testNotice = element(doc, 'button', {type: 'button', textContent: 'Test notification'});
  testNotice.addEventListener('click', async () => {
    controller.gesture();
    show(await controller.test());
  });

  const support = pushSupport(controller.win, controller.nav);
  const hints = [];
  if (support.note) hints.push(element(doc, 'p', {className: 'notify-hint', textContent: support.note}));
  if (!support.push) hints.push(element(doc, 'p', {className: 'notify-hint', textContent: 'This browser cannot show notifications while Clowder is closed.'}));

  return element(doc, 'div', {className: 'sound-settings'}, [
    element(doc, 'h4', {textContent: 'Sound'}),
    slider('Master', 'master'), slider('Music', 'music'), slider('Effects', 'effects'), slider('Interface sounds', 'interface'),
    element(doc, 'label', {className: 'sound-mute'}, [mute, element(doc, 'span', {textContent: 'Mute everything'})]),
    element(doc, 'label', {className: 'sound-mute'}, [quiet, element(doc, 'span', {textContent: 'Quiet (only decision chimes)'})]),
    ...(canVibrate ? [element(doc, 'label', {className: 'sound-mute'}, [vibrate, element(doc, 'span', {textContent: 'Vibrate on tap (phone)'})])] : []),
    element(doc, 'label', {className: 'sound-mute'}, [memorialMusic, element(doc, 'span', {textContent: 'Memorial music'})]),
    testSound,
    element(doc, 'h4', {textContent: 'Notifications'}),
    ...hints,
    enable,
    ...prefBoxes,
    testNotice,
    status,
  ]);
}

/**
 * Starts sound and notifications. Call once at startup. Nothing plays until the first user gesture.
 * The settings section is registered with settings-menu.js when that module exists, else rendered into #settings-sound, else skipped with a warning.
 */
export function initSound({win = window, doc = document, nav = navigator, fetchImpl = (...args) => fetch(...args), mountSettings = true} = {}) {
  let storage = null;
  try { storage = win.localStorage; } catch { storage = null; }
  const audio = createAudio({storage, win, doc, AudioContextClass: win.AudioContext || win.webkitAudioContext});
  const controller = {audio, win, nav, prefs: loadPrefs(storage), gesture: () => {}, setPref: null, enable: null, resubscribe: null, test: null};
  attachUiSounds({win, doc, audio, EventSourceClass: win.EventSource});
  installUiSounds({win, doc, audio});
  let registration = null;
  const ready = () => {
    if (!registration && nav.serviceWorker) registration = nav.serviceWorker.ready.catch(() => null);
    return registration || Promise.resolve(null);
  };

  controller.setPref = (kind, value) => { controller.prefs = savePrefs(storage, {...controller.prefs, [kind]: value}); };

  const subscribedEndpoint = async () => {
    const reg = await ready();
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    return sub;
  };

  controller.resubscribe = async () => {
    const sub = await subscribedEndpoint();
    if (!sub) return '';
    const json = sub.toJSON();
    await postJson(fetchImpl, '/api/push/subscribe', {endpoint: json.endpoint, keys: {p256dh: json.keys.p256dh, auth: json.keys.auth}, kinds: controller.prefs});
    return 'Saved your choices.';
  };

  controller.enable = async () => {
    const support = pushSupport(win, nav);
    if (!support.push) return 'This browser cannot show notifications in the background.';
    if (support.needsInstall) return support.note;
    const permission = await win.Notification.requestPermission();
    if (permission !== 'granted') return 'Notifications are blocked. Allow them in your browser or app settings, then try again.';
    const reg = await ready();
    if (!reg) return 'Notifications need the offline cache, which is not ready yet. Reload and try again.';
    const config = await (await fetchImpl('/api/push/config', {headers: {'X-Town-Action': 'owner'}})).json();
    if (!config.publicKey) throw new Error('The town did not return a notification key.');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(config.publicKey)});
    const json = sub.toJSON();
    await postJson(fetchImpl, '/api/push/subscribe', {endpoint: json.endpoint, keys: {p256dh: json.keys.p256dh, auth: json.keys.auth}, kinds: controller.prefs});
    return 'Notifications are on. Closed-app alerts follow your choices below.';
  };

  controller.test = async () => {
    if (!win.Notification) return 'Notifications are not supported here.';
    if (win.Notification.permission !== 'granted') {
      const permission = await win.Notification.requestPermission();
      if (permission !== 'granted') return 'Notifications are blocked, so there is nothing to test.';
    }
    const reg = await ready();
    if (!reg) return 'The offline cache is not ready yet. Reload and try again.';
    await reg.showNotification('Clowder test', {body: 'Notifications are working.', tag: 'clowder-test', icon: '/icons/icon-192.png', data: {url: '/'}});
    return 'Sent a test notification.';
  };

  // The first gesture unlocks audio. Capture phase, so no page handler can stop it.
  const gestureEvents = ['pointerdown', 'keydown', 'touchend'];
  const unlock = () => {
    if (!audio.unlock()) return;
    for (const type of gestureEvents) win.removeEventListener(type, unlock, true);
  };
  controller.gesture = unlock;
  for (const type of gestureEvents) win.addEventListener(type, unlock, true);

  // A town-state change: sounds always, notices only while the page is hidden (a visible page already shows the change).
  win.addEventListener('town-state', event => {
    const {prev, next} = event.detail || {};
    if (!next) return;
    audio.announce(prev, next);
    if (!doc.hidden) return;
    const diff = diffTownState(prev, next);
    if (diff.baseline || !win.Notification || win.Notification.permission !== 'granted') return;
    for (const notice of inAppNotices(diff, next, controller.prefs)) {
      void ready().then(reg => reg && reg.showNotification(notice.title, {body: notice.body, tag: notice.tag, icon: '/icons/icon-192.png', data: {url: notice.url}})).catch(() => {});
    }
  });

  if (mountSettings) void mountSettingsSection(doc, controller);
  return controller;
}

async function mountSettingsSection(doc, controller) {
  const render = element => element.replaceChildren(buildSoundSettings(doc, controller));
  try {
    const menu = await import('./settings-menu.js');
    if (typeof menu.registerSettingsSection === 'function') {
      menu.registerSettingsSection('sound', 'Sound & notifications', render, {icon: '♪', summary: () => soundSummary(controller.audio.settings(), controller.win?.Notification?.permission)});
      return 'section';
    }
  } catch {
    // settings-menu.js is not there yet; use the fallback container below.
  }
  const host = doc.getElementById('settings-sound');
  if (host) {
    render(host);
    return 'host';
  }
  console.warn('Sound and notifications: no settings-menu.js section and no #settings-sound container, so the settings UI was skipped.');
  return 'none';
}

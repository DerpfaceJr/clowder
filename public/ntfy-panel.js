// Android ping (plan 5.4, D8): for a paired phone whose app has no Web Push (the Android app's WebView), Clowder can ping the free ntfy
// app instead. The ping is one fixed line, "Clowder needs you — open the app": nothing about the decision leaves the computer. Each phone
// is turned on by itself and gets its own private address. Post office > Channels > Android ping opens this panel. Routes (src/ntfy.ts):
// GET /api/ntfy, POST /api/ntfy/devices/:id/enable (returns the subscribe address) and /disable, on the host computer. The pure
// helpers are exported for Node tests; the DOM is built with createElement and textContent only.
import {confirmDialog} from './dialogs.js';
import {copyBox, postOfficeEntry, h, msgNode, ownerDialog, readJson, sendJson, switchControl} from './owner-dialog.js';

export const HOST_ONLY = 'Notifications are managed on the host computer.';
export const NTFY_APP = 'https://ntfy.sh/';
const list = value => (Array.isArray(value) ? value : []);
const enc = encodeURIComponent;

/** A subscribe address split for the ntfy app: the topic it asks for, and whether "Use another server" is needed. */
export function subscribeParts(url, server = 'https://ntfy.sh') {
  try {
    const u = new URL(String(url)), base = new URL(String(server));
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    return {topic, server: `${u.protocol}//${u.host}`, otherServer: u.host !== 'ntfy.sh' || base.host !== 'ntfy.sh'};
  } catch { return {topic: '', server: String(server ?? ''), otherServer: false}; }
}

/** The Post office entry's note: how many phones get pings. */
export function entrySummary(devices) {
  const on = list(devices).filter(d => d.enabled).length;
  return on ? `${on} ${on === 1 ? 'phone gets' : 'phones get'} a ping when Clowder needs you` : 'Ping a phone through the ntfy app when Clowder needs you';
}

/** The Android ping dialog. openDevices() opens Devices to pair a phone. */
export function createNtfyPanel({doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), ask = confirmDialog, openDevices = () => {}} = {}) {
  const ui = {data: null, loaded: false, msgs: new Map(), busy: '', fresh: new Set()};
  const {dialog, body} = ownerDialog({doc, id: 'ntfy-dialog', eyebrow: 'PHONE NOTIFICATIONS', title: 'Android ping',
    lede: 'For a phone that gets no notifications from the Clowder app, the free ntfy app can ping it instead. The ping only says “Clowder needs you — open the app”: nothing about the decision leaves this computer, and a tap opens Clowder.',
    onClose: () => { ui.msgs.clear(); ui.fresh.clear(); }});

  async function refresh() {
    const r = await readJson(fetchImpl, '/api/ntfy').catch(error => ({ok: false, status: 0, data: {error: error.message}}));
    if (r.ok) { ui.data = r.data; ui.msgs.delete('page'); } else ui.msgs.set('page', {text: r.status === 403 || r.status === 401 ? HOST_ONLY : r.data.error || 'Android ping could not load.', bad: true});
    ui.loaded = true;
    paint();
  }

  function row(d) {
    const key = `d:${d.id}`, parts = d.url ? subscribeParts(d.url, ui.data?.server) : null;
    return h('li', {className: 'op-row', attrs: {'data-id': d.id}},
      h('div', {className: 'op-row-head'}, h('strong', {text: d.name}),
        switchControl({label: `Ping ${d.name}`, checked: d.enabled, key, disabled: !!ui.busy, onChange: on => void toggle(d, on)})),
      d.enabled && parts ? h('div', {className: 'op-field'},
        h('span', {text: 'Subscribe to this in ntfy'}),
        copyBox(win, `ntfy address for ${d.name}`, d.url),
        h('small', {text: parts.otherServer
          ? `In ntfy, tap +, tick “Use another server”, enter ${parts.server}, then the topic ${parts.topic}.`
          : `In ntfy, tap + and enter the topic ${parts.topic}. The address is private: anyone with it can ping this phone, though they read nothing.`})) : null,
      ui.fresh.has(d.id) ? msgNode({text: 'On. Subscribe to the address above in ntfy now, on that phone.'}) : null,
      msgNode(ui.msgs.get(d.id)));
  }

  function paint() {
    if (!dialog.open && ui.loaded) return;
    const focusKey = doc.activeElement?.dataset?.key;
    const d = ui.data, devices = list(d?.devices);
    const parts = [msgNode(ui.msgs.get('page'))];
    if (!d) { if (!ui.loaded) parts.push(h('p', {className: 'cx-empty muted', text: 'Loading…', attrs: {role: 'status'}})); body.replaceChildren(...parts.filter(Boolean)); return; }
    parts.push(h('section', {className: 'cx-section'}, h('h4', {text: 'How it works'}),
      h('ol', {className: 'op-steps'},
        h('li', {}, h('strong', {text: 'Install ntfy on the phone'}), h('p', {text: 'It is free and open source, from the Play Store or F-Droid.'}), h('a', {className: 'cx-open', text: 'About ntfy ↗', attrs: {href: NTFY_APP, target: '_blank', rel: 'noopener noreferrer'}})),
        h('li', {}, h('strong', {text: 'Turn the phone on below'}), h('p', {text: 'Clowder makes a private address for that phone only.'})),
        h('li', {}, h('strong', {text: 'Subscribe to the address in ntfy'}), h('p', {text: 'From then on, each time something needs you, the phone gets one ping, at most one a minute.'})))));
    if (!devices.length) {
      const pair = h('button', {text: 'Open Devices', attrs: {type: 'button', 'data-key': 'devices'}});
      pair.onclick = () => openDevices();
      parts.push(h('section', {className: 'cx-section'}, h('h4', {text: 'Your phones'}), h('p', {text: 'No phone is paired yet. Pair one in Devices first, then come back here.'}), h('div', {className: 'op-actions'}, pair)));
    } else {
      parts.push(h('section', {className: 'cx-section'}, h('h4', {text: 'Your phones'}), h('ul', {className: 'op-list'}, devices.map(row))));
    }
    if (d.server) parts.push(h('p', {className: 'op-hint', text: `Pings go through ${d.server}.`}));
    body.replaceChildren(...parts.filter(Boolean));
    if (focusKey) [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  async function toggle(d, on) {
    if (ui.busy) return;
    if (!on && !await ask({title: `Stop pinging ${d.name}?`, message: 'Its address stops working at once. Turning it on again makes a new address to subscribe to.', confirmLabel: 'Stop pings', cancelLabel: 'Keep pinging', danger: true})) { paint(); return; }
    ui.busy = d.id; ui.msgs.delete(d.id); ui.fresh.delete(d.id); paint();
    try {
      await sendJson(fetchImpl, `/api/ntfy/devices/${enc(d.id)}/${on ? 'enable' : 'disable'}`);
      if (on) ui.fresh.add(d.id);
    } catch (error) {
      ui.msgs.set(d.id, {text: error.status === 403 ? HOST_ONLY : error.message, bad: true});
    } finally { ui.busy = ''; }
    await refresh();
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.loaded = false; paint();
    await refresh();
  }
  async function probe() {
    const r = await readJson(fetchImpl, '/api/ntfy').catch(() => ({ok: false}));
    if (r.ok) ui.summary = entrySummary(r.data.devices);
    return r.ok;
  }
  return {open, close: () => dialog.close(), refresh, probe, dialog, summary: () => ui.summary};
}

/** Post office > Channels > Android ping, shown once the host route answers. */
export function initNtfyPanel(options = {}) {
  const doc = options.doc ?? document, panel = createNtfyPanel(options);
  const entry = postOfficeEntry(doc, {id: 'ntfy-open', group: 'channels', text: 'Android ping', note: 'Ping a phone through the ntfy app when Clowder needs you', open: panel.open});
  void panel.probe().then(ok => { if (entry) { entry.hidden = !ok; if (ok) entry.setAttribute('data-note', panel.summary()); } });
  return panel;
}

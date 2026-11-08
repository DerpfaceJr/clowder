// Passkey step-up (plan 5.5). On a stable address (Tailscale or a named tunnel, never a Quick Tunnel) an owner phone can add a passkey,
// once Devices on the computer allows it, and then confirm with it before changing what is otherwise only on the computer: money settings,
// Stripe, marking paid and new webhook links. A confirm lasts a few minutes, for that phone only. The server checks everything
// (src/remote-access.ts StepUp, src/webauthn.ts); this file only carries WebAuthn's binary fields as base64url and says what happens.
// Phone: ☰ > Devices & AI > Passkey (createStepUp). Computer: one line and button under each owner device in Devices (passkeyControls).
// Pure helpers are exported for Node tests; the DOM is built with createElement and textContent only.
import {el} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';

export const toB64url = buffer => {
  let text = '';
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64url = text => {
  const plain = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(plain.padEnd(Math.ceil(plain.length / 4) * 4, '=')), c => c.charCodeAt(0));
};
/** The server's options, with the binary fields WebAuthn wants as bytes. */
export const creationFromJson = o => ({...o, challenge: fromB64url(o.challenge), user: {...o.user, id: fromB64url(o.user.id)}, excludeCredentials: (o.excludeCredentials || []).map(c => ({...c, id: fromB64url(c.id)}))});
export const requestFromJson = o => ({...o, challenge: fromB64url(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({...c, id: fromB64url(c.id)}))});
/** A credential from navigator.credentials as JSON: only the fields the server reads. */
export function credentialJson(credential) {
  const r = credential.response, response = {clientDataJSON: toB64url(r.clientDataJSON)};
  if (r.attestationObject) response.attestationObject = toB64url(r.attestationObject);
  if (r.authenticatorData) response.authenticatorData = toB64url(r.authenticatorData);
  if (r.signature) response.signature = toB64url(r.signature);
  return {id: credential.id, type: credential.type, response};
}

const clock = (at, locale) => new Date(at).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'});
export const LEDE = 'Some settings stay on your computer: money, webhook links and keys. With a passkey this phone can change them too, for a few minutes after you confirm with your face, fingerprint or screen lock.';

/** The phone's one line and one action. status is GET /api/step-up; supported: this browser has WebAuthn. */
export function stepUpView(status, {supported = true, now = Date.now(), locale} = {}) {
  if (!status?.available) return {line: 'Passkeys need an address that stays the same, such as Tailscale.', action: null};
  if (!supported) return {line: 'This browser cannot use passkeys. Open your town’s address in your phone’s browser instead.', action: null};
  if (status.passkey && status.until && status.until > now) return {line: `Confirmed. Until ${clock(status.until, locale)} this phone can change money settings and make webhook links.`, action: null, fresh: true};
  if (status.canAdd) return {line: 'Your computer allowed this phone to add a passkey.', action: 'add'};
  if (status.passkey) return {line: 'This phone has a passkey. Confirm it’s you before changing money settings or making a webhook link.', action: 'confirm'};
  return {line: 'No passkey on this phone yet. On your computer, open Devices and choose Allow a passkey next to this phone, then come back here.', action: 'check'};
}

/** What the browser's passkey error means, in plain words. */
export function passkeyError(error) {
  if (error?.name === 'NotAllowedError') return 'The passkey was cancelled or timed out. Try again.';
  if (error?.name === 'InvalidStateError') return 'This phone already has that passkey.';
  if (error?.name === 'SecurityError') return 'This address cannot use passkeys.';
  return error?.message || 'The passkey did not work. Try again.';
}

/** The line under an owner device in Devices on the computer. status is GET /api/remote/status. Null where passkeys are not offered. */
export function passkeyLine(device, status, {now = Date.now(), locale} = {}) {
  if (device.permission !== 'owner' || !status?.stable || !status.origin) return null;
  const here = new URL(status.origin).hostname;
  if (device.passkey) return device.passkey.rpId === here
    ? {text: `Passkey added ${new Date(device.passkey.createdAt).toLocaleDateString(locale)}: can change money settings after confirming.`, action: 'remove'}
    : {text: 'Its passkey was made for another address and does not work here.', action: 'remove'};
  if (device.passkeyAllowedUntil > now) return {text: `Waiting for the phone to add its passkey, until ${clock(device.passkeyAllowedUntil, locale)}. On the phone: ☰ Settings, Devices & AI, Passkey.`, action: null};
  return {text: 'No passkey: this phone cannot change money settings.', action: 'allow'};
}

function injectStyles(doc) {
  if (!doc?.head || doc.querySelector('link[data-step-up]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('step-up.css', import.meta.url).href;
  link.dataset.stepUp = '';
  doc.head.append(link);
}

/** Devices on the computer: {line, buttons} for one paired device, or null. request posts like app.js api(); reload redraws Devices. */
export function passkeyControls(device, status, {request, reload, notify = () => {}, ask = confirmDialog}) {
  const view = passkeyLine(device, status);
  if (!view) return null;
  const line = el('small', {className: 'passkey-line', text: view.text});
  const buttons = [];
  const act = (text, work) => {
    const b = el('button', {text, attrs: {type: 'button'}});
    b.onclick = async () => { b.disabled = true; try { await work(); await reload(); } catch (error) { notify(error); b.disabled = false; } };
    buttons.push(b);
  };
  if (view.action === 'allow') act('Allow a passkey', () => request(`remote/passkey/${encodeURIComponent(device.id)}`, {}));
  if (view.action === 'remove') act('Remove passkey', async () => {
    if (!await ask({title: `Remove the passkey on ${device.name}?`, message: 'That phone can no longer change money settings or make webhook links, until you allow a new passkey.', confirmLabel: 'Remove passkey', cancelLabel: 'Keep it', danger: true})) return;
    await request(`remote/passkey/${encodeURIComponent(device.id)}/remove`, {});
  });
  return {line, buttons};
}

/** The phone's ☰ entry and its page. button: #step-up-open, shown only where a passkey is offered. */
export function createStepUp({button = null, doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args)} = {}) {
  injectStyles(doc);
  let status = null, message = '', busy = false, dialog = null, prepared = null;
  const supported = () => !!(win?.PublicKeyCredential && win.navigator?.credentials);

  const read = async () => {
    const r = await fetchImpl('/api/step-up', {cache: 'no-store'});
    return r.ok ? r.json() : {available: false};
  };
  const post = async (path, body = {}) => {
    const r = await fetchImpl(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'The passkey did not work. Try again.');
    return data;
  };
  // Options are fetched before the tap, so the browser sees navigator.credentials called straight from it (Safari asks for that).
  async function prepare() {
    prepared = null;
    const view = stepUpView(status, {supported: supported()});
    if (view.action !== 'add' && view.action !== 'confirm') return;
    const kind = view.action;
    try { prepared = {kind, at: Date.now(), options: await post(kind === 'add' ? '/api/step-up/register/options' : '/api/step-up/options')}; } catch (error) { message = error.message; }
    draw();
  }
  async function run(kind) {
    busy = true;message = '';draw();
    try {
      let ready = prepared?.kind === kind && Date.now() - prepared.at < 90_000 ? prepared.options : null;
      prepared = null;
      ready ??= await post(kind === 'add' ? '/api/step-up/register/options' : '/api/step-up/options');
      const credential = kind === 'add'
        ? await win.navigator.credentials.create({publicKey: creationFromJson(ready)})
        : await win.navigator.credentials.get({publicKey: requestFromJson(ready)});
      await post(kind === 'add' ? '/api/step-up/register' : '/api/step-up', credentialJson(credential));
      if (kind === 'add') message = 'Passkey added. Confirm it’s you whenever you change money settings from this phone.';
    } catch (error) {
      message = passkeyError(error);
    }
    busy = false;
    await refresh();
  }

  function draw() {
    if (!dialog) return;
    const view = stepUpView(status, {supported: supported()});
    const body = dialog.querySelector('.step-up-body');
    const parts = [el('p', {className: 'step-up-lede', text: LEDE}), el('p', {className: 'step-up-line', text: view.line, attrs: {role: 'status', ...(view.fresh ? {'data-fresh': ''} : {})}})];
    const label = {add: 'Add a passkey', confirm: 'Confirm it’s you', check: 'Check again'}[view.action];
    if (label) {
      const b = el('button', {className: view.action === 'check' ? '' : 'primary', text: busy ? 'Waiting for the passkey…' : label, attrs: {type: 'button'}});
      b.disabled = busy;
      b.onclick = () => (view.action === 'check' ? void refresh() : void run(view.action));
      parts.push(el('div', {className: 'step-up-actions'}, [b]));
    }
    if (message) parts.push(el('p', {className: 'cx-msg', text: message}));
    body.replaceChildren(...parts);
  }

  function build() {
    const close = el('button', {className: 'close-x', text: '×', attrs: {type: 'button', 'aria-label': 'Close passkey'}});
    const d = el('dialog', {className: 'step-up', attrs: {id: 'step-up-dialog', 'aria-labelledby': 'step-up-title'}}, [
      close, el('h2', {text: 'Passkey', attrs: {id: 'step-up-title'}}), el('div', {className: 'step-up-body'}),
    ]);
    close.onclick = () => d.close();
    doc.body.append(d);
    return d;
  }

  async function refresh() {
    try { status = await read(); } catch { status = {available: false}; }
    if (button) button.hidden = !status.available;
    draw();
    if (dialog?.open && !busy) await prepare();
    return status;
  }

  async function open() {
    dialog ??= build();
    message = '';
    if (!dialog.open) dialog.showModal();
    await refresh();
  }

  if (button) button.addEventListener('click', () => { button.closest('dialog')?.close?.(); void open(); });
  return {probe: refresh, open};
}

// The shell the owner's newer panels share (Memory, Usage, Email to the Mayor, Android ping, Sign-in clients): a centred dialog on desktop
// and a full-screen page with a back pill on phones, like Routines and Telegram. It also holds the small pieces they all use: JSON reads and
// writes with the owner header, a status message, an on/off switch and a copy box. Everything is built with createElement and textContent,
// so nothing a server or a page says can become markup. Nothing here touches the DOM at import, so Node tests can load the panels.
import {el} from './projects-panel.js';

/** el() with children as arguments; null, undefined and false children are skipped. */
export const h = (tag, props, ...children) => el(tag, props, children.flat().filter(c => c !== null && c !== undefined && c !== false));

/** A stylesheet next to this module, added once per document. */
export function ensureStyles(doc, file, key) {
  if (!doc?.head || doc.querySelector(`link[data-${key}]`)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL(file, import.meta.url).href;
  link.setAttribute(`data-${key}`, '');
  doc.head.append(link);
}

/** GET as JSON: {status, ok, data}. A body that is not JSON reads as {}. */
export async function readJson(fetchImpl, path) {
  const response = await fetchImpl(path, {cache: 'no-store'});
  const data = await response.json().catch(() => ({}));
  return {status: response.status, ok: response.ok, data};
}

/** A write with the owner header the server asks for. Throws the server's own sentence, with the status attached. */
export async function sendJson(fetchImpl, path, body = {}, method = 'POST') {
  const response = await fetchImpl(path, {method, headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'That did not work.'), {status: response.status});
  return data;
}

/** One status line: {text, bad}. */
export const msgNode = (m, slot) => (m ? h('p', {className: `cx-msg${m.bad ? ' bad' : ''}`, text: m.text, attrs: {role: 'status', ...(slot ? {'data-slot': slot} : {})}}) : null);

/** The connectors panel's switch: a real checkbox drawn as a track, with its own On/Off word. */
export function switchControl({label, checked, key, disabled = false, onChange, text = ['Off', 'On']}) {
  const input = h('input', {attrs: {type: 'checkbox', role: 'switch', 'aria-label': label, ...(key ? {'data-key': key} : {})}});
  input.checked = checked === true;
  input.disabled = disabled;
  const word = h('span', {text: input.checked ? text[1] : text[0]});
  input.onchange = () => { word.textContent = input.checked ? text[1] : text[0]; onChange?.(input.checked, input); };
  return h('label', {className: 'cx-switch op-switch'}, input, h('span', {className: 'switch-track', attrs: {'aria-hidden': 'true'}}), word);
}

/** A read-only text box with Copy beside it. Copy falls back to selecting the text when the clipboard is blocked. */
export function copyBox(win, label, value) {
  const input = h('input', {className: 'op-copy-input', attrs: {type: 'text', readonly: '', spellcheck: 'false', 'aria-label': label}});
  input.value = value;
  input.onclick = () => input.select?.();
  const copy = h('button', {className: 'op-copy-button', text: 'Copy', attrs: {type: 'button'}});
  copy.onclick = async () => {
    try { await win.navigator.clipboard.writeText(value); copy.textContent = 'Copied'; } catch { input.select?.(); copy.textContent = 'Select and copy'; }
  };
  return h('div', {className: 'op-copy'}, input, copy);
}

/**
 * The dialog itself. Returns {dialog, body, lede}. Escape and the close buttons close it; onClose runs after every close.
 * size 'wide' gives the roomier desktop width Memory and Usage use.
 */
export function ownerDialog({doc = document, id, eyebrow, title, lede = '', closeLabel = `Close ${title}`, size = '', onClose = () => {}}) {
  ensureStyles(doc, 'owner-panels.css', 'owner-panels');
  const back = h('button', {className: 'back-pill phone-only', text: '← Town', attrs: {type: 'button', 'aria-label': 'Back to town'}});
  const closeX = h('button', {className: 'close-x desk-only', text: '×', attrs: {type: 'button', 'aria-label': closeLabel}});
  const ledeNode = h('p', {className: 'op-lede', text: lede});
  const body = h('div', {className: 'op-body'});
  const dialog = h('dialog', {className: 'op-dialog', attrs: {id, 'aria-labelledby': `${id}-title`, ...(size ? {'data-size': size} : {})}},
    h('div', {className: 'treasury-dialog-title op-top'}, back, h('span', {className: 'eyebrow', text: eyebrow}), closeX),
    h('h2', {text: title, attrs: {id: `${id}-title`}}),
    ledeNode, body);
  back.onclick = () => dialog.close();
  closeX.onclick = () => dialog.close();
  dialog.addEventListener('close', () => onClose());
  doc.body.append(dialog);
  return {dialog, body, lede: ledeNode};
}

/**
 * An entry in the Post office (post-office.js) for a host or owner panel: group is 'channels', 'signins', 'signins-advanced' or 'apps'.
 * Hidden until the panel's probe says this device may use it.
 */
// host: the panel's routes live on the main listener only, so a paired phone never sees the entry (style.css hides .remote [data-host]).
export function postOfficeEntry(doc, {id, text, note, open, group, host = true}) {
  const items = doc.querySelector?.(`#post-office-dialog [data-items="${group}"]`);
  if (!items) return null;
  let button = doc.getElementById?.(id);
  if (!button) {
    button = h('button', {text, attrs: {type: 'button', id, 'data-owner': '', ...(host ? {'data-host': ''} : {}), 'aria-haspopup': 'dialog', 'data-note': note}});
    button.hidden = true;
    items.append(button);
  }
  button.addEventListener('click', () => void open());
  return button;
}

/** A ☰ > Devices entry for an owner panel that is about who reaches this town rather than a cat's channel (People, plan 10.11). Hidden until
 *  the panel's probe says this device may use it. host: as postOfficeEntry. */
export function devicesEntry(doc, {id, text, note, open, host = true}) {
  const items = doc.querySelector?.('#settings-devices > .menu-items');
  if (!items) return null;
  let button = doc.getElementById?.(id);
  if (!button) {
    button = h('button', {text, attrs: {type: 'button', id, 'data-owner': '', ...(host ? {'data-host': ''} : {}), 'aria-haspopup': 'dialog', 'data-note': note}});
    button.hidden = true;
    items.append(button);
  }
  button.addEventListener('click', () => void open());
  return button;
}

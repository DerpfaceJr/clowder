// Styled confirmation dialog, used in place of the browser's native box. Built once, on a native <dialog>.
// Esc cancels, Tab stays inside the dialog while it is open, and focus returns to the control that opened it.
// The cancel button comes first, so it has focus when the dialog opens; a stray Enter does not confirm.
import {icon} from './icons.js';

let dialog = null;

// One close icon for every dialog and panel: the × text that index.html and the panel scripts put in .close-x and .panel-close
// buttons becomes the sprite's x, which CSS centres exactly (a font's × sits low and left). The button keeps its aria-label.
// Runs once on load, then for buttons added later.
const CLOSE = '.close-x,.panel-close';
const iconClose = button => { if (button.textContent.trim() === '×') button.replaceChildren(icon('x')); };
export function upgradeCloseButtons(root) {
  if (root.matches?.(CLOSE)) iconClose(root);
  root.querySelectorAll?.(CLOSE).forEach(iconClose);
}
if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
  upgradeCloseButtons(document);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) upgradeCloseButtons(node);
  }).observe(document.body ?? document.documentElement, {childList: true, subtree: true});
}

function build(doc) {
  const d = doc.createElement('dialog');
  d.className = 'confirm-dialog';
  d.setAttribute('aria-labelledby', 'confirm-title');
  d.setAttribute('aria-describedby', 'confirm-message');
  const form = doc.createElement('form');
  form.method = 'dialog';
  const eyebrow = doc.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'PLEASE CONFIRM';
  const title = doc.createElement('h2');
  title.id = 'confirm-title';
  const message = doc.createElement('p');
  message.id = 'confirm-message';
  // Optional checkbox, shown only when a caller asks for one.
  const check = doc.createElement('label');
  check.className = 'confirm-check';
  check.hidden = true;
  const checkInput = doc.createElement('input');
  checkInput.type = 'checkbox';
  checkInput.className = 'confirm-check-input';
  const checkText = doc.createElement('span');
  check.append(checkInput, checkText);
  const actions = doc.createElement('div');
  actions.className = 'dialog-actions confirm-actions';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'confirm-cancel';
  cancel.addEventListener('click', () => d.close('cancel'));
  const ok = doc.createElement('button');
  ok.type = 'submit';
  ok.value = 'confirm';
  ok.className = 'confirm-ok';
  actions.append(cancel, ok);
  form.append(eyebrow, title, message, check, actions);
  d.append(form);
  doc.body.append(d);
  return d;
}

// Resolves true only when the confirm button is chosen; any other close (Esc, Cancel) resolves false.
// checkbox: {label, checked} adds an unticked box by default. Its checked value is written back when the dialog closes.
export function confirmDialog({title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, checkbox = null} = {}, doc = document) {
  dialog ??= build(doc);
  const d = dialog;
  const opener = doc.activeElement;
  const check = d.querySelector('.confirm-check');
  const checkInput = d.querySelector('.confirm-check-input');
  check.hidden = !checkbox;
  if (checkbox) {
    check.querySelector('span').textContent = checkbox.label ?? '';
    checkInput.checked = checkbox.checked === true;
  }
  d.querySelector('#confirm-title').textContent = title;
  d.querySelector('#confirm-message').textContent = message;
  d.querySelector('.confirm-cancel').textContent = cancelLabel;
  const ok = d.querySelector('.confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = danger ? 'confirm-ok danger' : 'confirm-ok primary';
  return new Promise(resolve => {
    d.addEventListener('close', () => {
      if (checkbox) checkbox.checked = checkInput.checked;
      resolve(d.returnValue === 'confirm');
      if (opener?.isConnected) opener.focus();
    }, {once: true});
    d.returnValue = '';
    d.showModal();
  });
}

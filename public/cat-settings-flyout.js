// The cat's Settings as a flyout beside the chat panel (tablets and desktops) or a full-screen sheet (phones).
// The chat's Settings disclosure stays the toggle. Its controls move into the flyout, so every id and handler keeps working.
// Nothing runs at import time; the pure helpers are shared with Node tests.

// Below this width the flyout is a full-screen sheet with a back arrow.
export const PHONE_SHEET_QUERY = '(max-width:767px)';

// What the Settings disclosure shows after an event. Its open state is the one source of truth.
// close: the × or back arrow. escape: Esc. save: a saved change. toggle: the Settings summary clicked.
export function settingsOpenAfter(open, event) {
  if (event === 'toggle') return !open;
  if (event === 'open') return true;
  if (event === 'close' || event === 'escape' || event === 'save') return false;
  return open;
}

// Esc closes the flyout only while it is open.
export function escapeClosesSettings(open, key) {
  return Boolean(open) && key === 'Escape';
}

export function settingsTitle(name) {
  return `${name || 'Cat'}’s settings`;
}

// Builds the flyout shell after the chat panel and moves the existing settings body into it (no clones, ids stay unique).
// Returns {close, setCatName, isOpen}. Returns null when the chat markup is missing.
export function initCatSettingsFlyout(doc = document) {
  const details = doc.querySelector('details.chat-settings');
  const body = details?.querySelector('.settings-body');
  const chat = doc.getElementById('inspector-panel');
  if (!details || !body || !chat) return null;

  const flyout = doc.createElement('aside');
  flyout.id = 'cat-settings-flyout';
  flyout.className = 'cat-settings-flyout';
  flyout.dataset.owner = '';
  flyout.hidden = true;
  flyout.setAttribute('aria-labelledby', 'cat-settings-title');
  flyout.innerHTML = '<div class="settings-flyout-head"><button type="button" class="settings-back" aria-label="Back to chat">←</button><h2 id="cat-settings-title"></h2><button type="button" class="settings-close" aria-label="Close settings">×</button></div>';
  flyout.append(body);
  // The Mayor's suggestion is the last section of the settings, so it moves in with them.
  const suggestion = doc.getElementById('cat-suggestion');
  if (suggestion) body.append(suggestion);
  // Phones: a bottom sheet on the body, so the chat panel's backdrop blur and stacking never trap it. Wider screens: inside the chat
  // panel, covering it, so the settings open in the chat column rather than as a second card over the 3D town.
  const phone = globalThis.matchMedia?.(PHONE_SHEET_QUERY);
  const place = () => (phone?.matches ? doc.body : chat).append(flyout);
  place();
  phone?.addEventListener?.('change', place);

  const summary = details.querySelector('summary');
  const title = flyout.querySelector('#cat-settings-title');
  const sync = () => { flyout.hidden = !details.open; };
  const set = event => { details.open = settingsOpenAfter(details.open, event); sync(); };
  const close = (event = 'close') => { set(event); if (event !== 'save') summary.focus(); };

  summary.addEventListener('click', e => { e.preventDefault(); set('toggle'); });
  details.addEventListener('toggle', sync);
  flyout.querySelectorAll('.settings-back, .settings-close').forEach(b => b.addEventListener('click', () => close('close')));

  // Capture phase, so the panel-level Escape handler never sees this press. Dialogs keep their own Escape.
  doc.addEventListener('keydown', e => {
    if (!escapeClosesSettings(details.open, e.key) || doc.querySelector('dialog[open]')) return;
    e.preventDefault();
    e.stopPropagation();
    close('escape');
  }, true);

  sync();
  return {
    close: () => close('save'),
    setCatName: name => { title.textContent = settingsTitle(name); },
    isOpen: () => details.open,
  };
}

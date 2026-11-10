// The Post office (docs/design/menu-chat-mailman.md): the Mailman's panel, where the town's messages come and go. Three groups, each a
// list of entries that open panels that already exist:
//   Channels: Telegram, Discord, Email to the Mayor and Android ping;
//   Sign-ins: Accounts & connections, with Sign-in clients under Advanced;
//   Apps: Connectors & plugins.
// The dialog and its static entries are in index.html; Email to the Mayor, Android ping and Sign-in clients add theirs through
// owner-dialog.js postOfficeEntry. Each entry shows once its panel's probe says this device may use it, as it did in ☰. The rules come
// first, so Node tests read them without a DOM.
// One name per place: the dialog is "Post office" when it opens whole (the palette, /connect). Opened on one group (Manage's Channels,
// Sign-ins and Apps, and the Mailman's corner chips) it shows that group alone under the group's own name, so the heading says what
// the control said. An entry carries the name of the panel it opens (Accounts & connections, Connectors & plugins, Sign-in clients).
import {icon} from './icons.js';

export const GROUPS = Object.freeze(['channels', 'signins', 'apps']);

/** Each entry's group and Lucide icon, by the id of its button. The order here is the order on screen. */
export const ENTRIES = Object.freeze({
  'telegram-open': {group: 'channels', icon: 'send'},
  'discord-open': {group: 'channels', icon: 'message-circle'},
  'mail-watch-open': {group: 'channels', icon: 'inbox'},
  'ntfy-open': {group: 'channels', icon: 'bell'},
  'accounts-open': {group: 'signins', icon: 'key-round'},
  'owner-clients-open': {group: 'signins', icon: 'settings', advanced: true},
  'connectors-open': {group: 'apps', icon: 'wrench'},
});

/** The entry ids in one group, in order. */
export const entriesOf = group => Object.entries(ENTRIES).filter(([, e]) => e.group === group).map(([id]) => id);

/** Which groups have something to show, from the ids of the entries this device can use. */
export function liveGroups(visibleIds) {
  const live = new Set(visibleIds);
  return GROUPS.filter(group => entriesOf(group).some(id => live.has(id)));
}

/** True when the node is drawn: not hidden, and not hidden by a rule (.viewer [data-owner], .remote [data-host]). */
export function shownNode(node, win = globalThis.window) {
  if (!node || node.hidden) return false;
  try { return win?.getComputedStyle?.(node)?.display !== 'none'; } catch { return true; }
}

/** What the dialog shows: every live group under the dialog's own name, or the one group it was opened on under that group's name. */
export function viewOf(only, live, names = {}, home = 'Post office') {
  const group = live.includes(only) ? only : null;
  return {group, title: group ? names[group] || home : home, shown: group ? [group] : [...live]};
}

/**
 * Wires the Post office dialog. open(group) shows it: whole, or on that group alone when one is named, titled with the group's name.
 * has(group) says whether that group (or, with no group, any) has an entry this device can use. An entry closes the Post office before
 * its own panel opens, as ☰ did, so two dialogs never stack.
 */
export function createPostOffice({doc = globalThis.document, win = globalThis.window, dialog = doc.getElementById('post-office-dialog')} = {}) {
  if (!dialog) return {open: () => false, has: () => false, paint() {}, dialog: null};
  const visible = () => Object.keys(ENTRIES).filter(id => shownNode(doc.getElementById(id), win));
  const empty = dialog.querySelector('.po-empty');
  // The names are the page's own words: the dialog's heading, and each group's heading in its section.
  const title = dialog.querySelector('#post-office-title'), closeX = dialog.querySelector('.close-x');
  const home = title?.textContent.trim() || 'Post office', closeHome = closeX?.getAttribute('aria-label') ?? '';
  const headingOf = group => dialog.querySelector(`[data-group="${group}"] > h3`);
  const names = Object.fromEntries(GROUPS.map(group => [group, headingOf(group)?.textContent.trim() ?? '']));
  let only = null; // the group the dialog is open on, or null for the whole Post office

  // Each entry gets its icon and its words in a span, once, so the grid in manage.css can place the note under the name.
  function decorate(button) {
    if (!button || button.dataset.decorated) return;
    const info = ENTRIES[button.id];
    const words = doc.createElement('span');
    words.className = 'po-label';
    words.append(...[...button.childNodes]);
    const tile = doc.createElement('span');
    tile.className = 'po-icon';
    tile.setAttribute('aria-hidden', 'true');
    tile.append(icon(info?.icon ?? 'chevron-right', {size: 18}));
    button.append(tile, words);
    button.dataset.decorated = '1';
  }

  function paint() {
    const ids = visible(), live = liveGroups(ids), view = viewOf(only, live, names, home);
    for (const group of GROUPS) {
      const section = dialog.querySelector(`[data-group="${group}"]`), heading = headingOf(group);
      if (section) section.hidden = !view.shown.includes(group);
      // The dialog's heading carries the group's name then, so the section's own heading steps aside.
      if (heading) heading.hidden = view.group === group;
    }
    if (title && title.textContent !== view.title) title.textContent = view.title;
    if (closeX) closeX.setAttribute('aria-label', view.group ? `Close ${view.title}` : closeHome);
    const advanced = dialog.querySelector('.po-advanced');
    if (advanced) advanced.hidden = !Object.entries(ENTRIES).some(([id, e]) => e.advanced && ids.includes(id));
    if (empty) empty.hidden = live.length > 0;
    for (const id of Object.keys(ENTRIES)) decorate(doc.getElementById(id));
  }

  function has(group = null) {
    const live = liveGroups(visible());
    return group ? live.includes(group) : live.length > 0;
  }

  function open(group = null) {
    only = GROUPS.includes(group) ? group : null;
    paint();
    if (!dialog.open) dialog.showModal();
    return true;
  }

  // Capture: the Post office closes before the entry's own handler opens its panel.
  dialog.addEventListener('click', e => {
    const entry = e.target.closest?.('.po-items > button');
    if (entry && dialog.contains(entry)) dialog.close();
  }, true);
  // Closed, it is the whole Post office again. The event arrives a task after close(), so one that finds the dialog open again
  // belongs to the view before this one and changes nothing.
  dialog.addEventListener('close', () => { if (!dialog.open) { only = null; paint(); } });
  paint();
  return {open, has, paint, dialog};
}

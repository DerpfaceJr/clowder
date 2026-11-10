// Chat manages everything (docs/design/menu-chat-mailman.md): what a cat looks after lives with that cat. This module keeps that list and
// draws the chat's ways to it: the Manage section in the composer's Options, the chips in a cat's corner header, and the "Set up Clowder"
// card pinned to the top of the Mayor's thread. Every item only opens a panel that already exists (app.js says how, through open(key));
// none of them changes a panel. The rules come first as pure functions, so Node tests run them without a DOM; createManage draws them.
import {icon} from './icons.js';

/** The role the Mailman holds. Another branch adds the cat; the chat keys on this id and shows the Mailman's chips only while one lives in town. */
export const MAILMAN = 'mailman';

/** The cats that look after something, in the Manage section's order, with what each one looks after. name: the role's own name. */
export const KEEPERS = Object.freeze([
  Object.freeze({role: 'mayor', name: 'Mayor', items: Object.freeze(['autonomy', 'routines'])}),
  Object.freeze({role: MAILMAN, name: 'Mailman', items: Object.freeze(['channels', 'signins', 'apps'])}),
  Object.freeze({role: 'banker', name: 'Banker', items: Object.freeze(['money', 'usage'])}),
  Object.freeze({role: 'archivist', name: 'Archivist', items: Object.freeze(['memory', 'backups'])}),
]);

/**
 * Each item: its words, its Lucide icon (the index.html sprite), the id of its button in the Manage section, and who may use it as the
 * page marks it (data-owner: owner devices; data-host: the host computer; style.css hides them elsewhere). The ids are the controls the
 * command palette reads to know whether a place opens on this device (command-palette.js SURFACE_INFO.control).
 * A label is the heading of what the item opens: Channels, Sign-ins and Apps are the Post office's three groups, named as
 * docs/design/menu-chat-mailman.md names them, and the Post office opens on that group under the same word (post-office.js).
 */
export const ITEMS = Object.freeze({
  autonomy: {label: 'Autonomy', icon: 'gauge', id: 'autonomy-open', owner: true},
  routines: {label: 'Routines', icon: 'refresh-cw', id: 'routines-open', owner: true},
  channels: {label: 'Channels', icon: 'send', id: 'channels-open', owner: true, host: true},
  signins: {label: 'Sign-ins', icon: 'key-round', id: 'signins-open', owner: true, host: true},
  apps: {label: 'Apps', icon: 'wrench', id: 'apps-open', owner: true, host: true},
  money: {label: 'Money', icon: 'coins', id: 'money-open'},
  usage: {label: 'Usage', icon: 'cpu', id: 'usage-open'},
  memory: {label: 'Memory', icon: 'book-open', id: 'memory-open', owner: true},
  backups: {label: 'Backups', icon: 'copy', id: 'backups-open', owner: true, host: true},
});

/**
 * True when the cat holds this role. A catalogue cat's id is its role's id (the engine names it after the role), and a cat may also
 * carry the role's id itself (roleId) or live in that role's house (home.style). Anything else, a name or role text, never counts.
 */
export function hasRole(cat, role) {
  if (!cat || !role) return false;
  return cat.id === role || cat.roleId === role || cat.home?.style === role;
}

/** The keeper (a KEEPERS entry) this cat is, or null for a cat that looks after nothing. */
export const keeperOf = cat => KEEPERS.find(k => hasRole(cat, k.role)) ?? null;

/** The chips in a cat's corner header: what it looks after, in order, that this device can open. */
export function cornerItems(cat, can = () => true) {
  return (keeperOf(cat)?.items ?? []).filter(key => can(key));
}

/**
 * The Manage section's rows: one per keeper with something this device can open. Each row is named after the cat that holds the role
 * now, else the role itself, so Money still has a home before a Banker is recruited.
 */
export function manageRows(cats, can = () => true) {
  return KEEPERS.map(k => ({role: k.role, name: (cats ?? []).find(c => hasRole(c, k.role))?.name || k.name, items: k.items.filter(key => can(key))}))
    .filter(row => row.items.length > 0);
}

/**
 * The header logo's status dot: Running or Paused once the town has loaded and its live feed is up; while the feed is down, the
 * connection's own words (Reconnecting…, Gate closed). label is what a screen reader hears, title what a pointer shows. A tap opens
 * Town controls (the ☰ dialog's Town page, headed "Town controls" in index.html), where Pause and Resume are: the words here and that
 * heading stay the same.
 */
export function townStatus({loaded = false, paused = false, connected = true, connection = ''} = {}) {
  if (!loaded) return {state: 'connecting', word: 'Connecting', label: 'Connecting to the town', title: 'Connecting to the town'};
  if (!connected) {
    const word = String(connection ?? '').trim() || 'Reconnecting…';
    return {state: 'down', word, label: `${word.replace(/[.…]+$/, '')}. Open town controls`, title: word};
  }
  return paused
    ? {state: 'paused', word: 'Paused', label: 'Town paused. Open town controls to resume', title: 'Paused · open town controls'}
    : {state: 'running', word: 'Running', label: 'Town running. Open town controls to pause', title: 'Running · open town controls'};
}

/** A corner's chips group name: "What Mayor looks after". */
export const cornerLabel = name => `What ${name} looks after`;

/**
 * The setup card's words for setup-hub.js setupSummary(): null once every counted step is ready (setup is complete), or when the counts
 * could not be read. Otherwise how many are ready and a button word.
 */
export function setupCard(summary) {
  if (!summary || typeof summary !== 'object' || !(Number(summary.badge) > 0)) return null;
  const ready = Number(summary.ready) || 0, total = Number(summary.total) || 0;
  return {title: 'Set up Clowder', text: `${ready} of ${total} ready`, action: ready ? 'Continue setup' : 'Start setup'};
}

/** Whether the setup card shows: the owner, in the Mayor's own thread on the Conversation tab, while setup is not complete. */
export function showsSetupCard({state, selected, conversation = true, summary}) {
  return !!state && !state.readOnly && selected === 'mayor' && conversation && !!setupCard(summary);
}

// ------------------------------------------------------------------------------------------------------------------- the DOM

/**
 * Draws the Manage section into the Options popover (menu), the corner chips after the cat header (header), and the setup card above the
 * conversation (chat). app.js passes:
 *  - getState(), selected(): its state and the open cat;
 *  - can(key): whether this device can open that item now (probes, owner and host rules);
 *  - open(key, {from}): opens the item's panel as a sheet over the thread; from is the control that asked, for focus on close;
 *  - summary(): setup-hub.js setupSummary(), cached there; openSetup(): opens the Set up Clowder hub.
 * paint() is cheap when nothing it shows changed, so app.js calls it from every render.
 */
export function createManage({doc = globalThis.document, menu, header, chat, getState = () => null, selected = () => 'mayor', can = () => false,
  open = () => {}, summary = async () => null, openSetup = () => {}, closeOptions = () => {}}) {
  const make = (tag, attrs = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = String(v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
    return node;
  };

  // The Manage section: built once, its rows repainted when what they show changes. Its item buttons keep their ids, so a palette
  // or a test can find them while the popover is closed.
  const section = make('section', {id: 'composer-manage', class: 'composer-manage', 'aria-labelledby': 'composer-manage-title', hidden: true},
    make('h3', {id: 'composer-manage-title', class: 'composer-manage-title'}, 'Manage'));
  const rows = make('div', {class: 'manage-rows'});
  // Set up Clowder, at the top of Manage while setup is not complete: under 900px the setup card and the corner chips step aside so the
  // conversation keeps half the pane (Gate 11 F9), and this row and the cats' rows below it are where they are reached.
  const setupWords = make('span', {}, 'Set up Clowder');
  const setupRow = make('button', {type: 'button', id: 'manage-setup', class: 'manage-item manage-setup', 'aria-haspopup': 'dialog', hidden: true},
    icon('list-checks', {size: 16}), setupWords);
  setupRow.addEventListener('click', () => { closeOptions(); openSetup(); });
  section.append(setupRow, rows);
  menu?.append(section);
  const buttons = new Map();
  for (const keeper of KEEPERS) {
    const who = make('span', {class: 'manage-who', id: `manage-who-${keeper.role}`}, keeper.name);
    const items = make('div', {class: 'manage-items'});
    const row = make('div', {class: 'manage-row', role: 'group', 'aria-labelledby': `manage-who-${keeper.role}`, 'data-role': keeper.role}, who, items);
    for (const key of keeper.items) {
      const item = ITEMS[key];
      const button = make('button', {type: 'button', id: item.id, class: 'manage-item', 'data-item': key, 'data-owner': !!item.owner, 'data-host': !!item.host, 'aria-haspopup': 'dialog', hidden: true},
        icon(item.icon, {size: 16}), make('span', {}, item.label));
      button.addEventListener('click', () => { closeOptions(); open(key, {from: button}); });
      buttons.set(key, button);
      items.append(button);
    }
    rows.append(row);
  }

  // The corner chips sit right after the cat header, outside it: app.js rewrites the header on every render, and a chip that kept
  // focus would lose it there.
  const corner = make('div', {id: 'corner-chips', class: 'corner-chips', role: 'group', hidden: true});
  header?.after(corner);

  // The setup card: pinned above the Mayor's conversation, outside the log, so the thread view never redraws it.
  const cardText = make('p', {class: 'setup-card-text'});
  const cardButton = make('button', {type: 'button', class: 'setup-card-open primary', 'aria-haspopup': 'dialog'});
  const card = make('section', {id: 'setup-card', class: 'setup-card', 'aria-labelledby': 'setup-card-title', hidden: true},
    make('span', {class: 'setup-card-icon', 'aria-hidden': 'true'}, icon('list-checks', {size: 20})),
    make('div', {class: 'setup-card-main'}, make('h3', {id: 'setup-card-title', class: 'setup-card-title'}, 'Set up Clowder'), cardText),
    cardButton);
  cardButton.addEventListener('click', () => openSetup());
  chat?.before(card);

  let manageKey = '', cornerKey = '', last = null, asked = 0;
  const conversation = () => !!chat && !chat.hidden;

  function paintManage(state) {
    const live = manageRows(state?.cats, can), key = JSON.stringify(live);
    if (key === manageKey) return;
    manageKey = key;
    section.hidden = live.length === 0 && setupRow.hidden;
    for (const row of rows.children) {
      const shown = live.find(r => r.role === row.dataset.role);
      row.hidden = !shown;
      if (shown) row.querySelector('.manage-who').textContent = shown.name;
    }
    for (const [key, button] of buttons) button.hidden = !live.some(r => r.items.includes(key));
  }

  function paintCorner(state) {
    const cat = state?.cats?.find(c => c.id === selected()) ?? null, keys = cornerItems(cat, can);
    const key = JSON.stringify([cat?.id ?? null, cat?.name ?? null, keys]);
    if (key === cornerKey) return;
    cornerKey = key;
    corner.hidden = keys.length === 0;
    if (corner.hidden) { corner.replaceChildren(); return; }
    corner.setAttribute('aria-label', cornerLabel(cat.name));
    corner.replaceChildren(...keys.map(key => {
      const item = ITEMS[key];
      const chip = make('button', {type: 'button', class: 'corner-chip', 'data-item': key, 'data-owner': !!item.owner, 'data-host': !!item.host, 'aria-haspopup': 'dialog'},
        icon(item.icon, {size: 16}), make('span', {}, item.label));
      chip.addEventListener('click', () => open(key, {from: chip}));
      return chip;
    }));
  }

  function paintCard(state) {
    const words = !state?.readOnly && setupCard(last);
    setupRow.hidden = !words;
    if (words) setupWords.textContent = `Set up Clowder · ${words.text}`;
    section.hidden = !words && ![...rows.children].some(row => !row.hidden);
    const show = showsSetupCard({state, selected: selected(), conversation: conversation(), summary: last});
    card.hidden = !show;
    if (!show) return;
    if (cardText.textContent !== words.text) cardText.textContent = words.text;
    if (cardButton.textContent !== words.action) cardButton.textContent = words.action;
  }

  // The counts come from setup-hub.js (cached there for 10 s); a render asks again at most once per that window.
  function askSummary(force = false) {
    const state = getState();
    if (!state || state.readOnly || selected() !== 'mayor') return;
    const now = Date.now();
    if (!force && now - asked < 10_000) return;
    asked = now;
    void Promise.resolve(summary()).then(value => { last = value ?? null; paintCard(getState()); }).catch(() => {});
  }

  function paint() {
    const state = getState();
    if (!state) return;
    paintManage(state);
    paintCorner(state);
    paintCard(state);
    askSummary();
  }

  return {paint, refreshSetup: () => askSummary(true), section, corner, card, button: key => buttons.get(key) ?? null};
}

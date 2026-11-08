// Worlds: the header's Worlds button opens this dialog, and the ☰ menu has one entry that opens it too.
// Listing is open to every device. Create, visit, rename, archive, unarchive and delete carry data-owner (hidden for viewers),
// and the server refuses them anywhere but the host computer. A switch flies to the new world and rebuilds the town in
// place (world-travel.js); only without a 3D scene does it reload the page.
import {registerSettingsSection} from './settings-menu.js';
import {confirmDialog} from './dialogs.js';
import {canDelete, catLabel, thumbnailUrl} from './worlds-view.js';
import {effortChoices, paintModelPicker, providerChoices, readModelPicker, wireModelPicker} from './ai-settings.js';
import {icon} from './icons.js';

const ownerHeaders = {'Content-Type': 'application/json', 'X-Town-Action': 'owner'};
const list = {active: null, worlds: [], archived: []};
let view = 'active';
let busy = false;
let renaming = null; // id of the card being renamed; refreshes do not repaint while it is set, so typing is not lost
let creating = false; // the New world form is open; same rule
let dialog = null, grid = null, status = null, chip = null, chipName = null, deleteDialog = null, travel = null;
const counts = {};

// Builds an element. Text always goes in as textContent, so a world name can never become markup.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  node.append(...children.filter(child => child !== false && child !== undefined && child !== null));
  return node;
}

async function call(path, body) {
  const response = await fetch(`/api/worlds${path}`, {method: 'POST', headers: ownerHeaders, body: JSON.stringify(body ?? {})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'That did not work.');
  return data;
}

function showStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('is-error', isError);
}

function setChipName(name) {
  chipName.textContent = name;
  chip.setAttribute('aria-label', `Worlds: ${name}`);
}

async function refreshList() {
  try {
    const response = await fetch('/api/worlds', {cache: 'no-store'});
    if (!response.ok) return;
    const data = await response.json();
    list.active = data.active;
    list.worlds = data.worlds;
    list.archived = data.archived ?? [];
    const current = list.worlds.find(w => w.id === list.active);
    if (current) setChipName(current.name);
    if (dialog.open) paint();
  } catch {
    // Offline or restarting: keep the last list on screen.
  }
}

function paint(force = false) {
  counts.active.textContent = String(list.worlds.length);
  counts.archived.textContent = String(list.archived.length);
  for (const button of dialog.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  if (!force && (renaming || creating)) return;
  grid.replaceChildren(...cards());
}

function cards() {
  const nodes = [];
  if (view === 'active') nodes.push(newCard());
  const worlds = view === 'archived' ? list.archived : list.worlds;
  if (view === 'archived' && !worlds.length) nodes.push(el('li', {class: 'worlds-empty'}, 'Nothing is archived. An archived world keeps its files and can come back at any time.'));
  for (const world of worlds) nodes.push(card(world));
  return nodes;
}

function newCard() {
  if (!creating) {
    return el('li', {class: 'world-card world-new', 'data-owner': true},
      el('button', {type: 'button', class: 'world-new-button', onclick: () => { creating = true; paint(true); }},
        el('span', {class: 'world-new-plus', 'aria-hidden': 'true'}, icon('plus', {size: 28})),
        el('strong', {text: 'New world'}),
        el('span', {class: 'world-new-note', text: 'A fresh town with its own cats, history and coins.'})));
  }
  const input = el('input', {type: 'text', maxlength: 40, required: true, autocomplete: 'off', placeholder: 'Name for a new world', 'aria-label': 'Name for a new world'});
  const defaults = newWorldDefaults();
  const save = el('button', {type: 'submit', class: 'primary', text: 'Create'});
  const cancel = el('button', {type: 'button', class: 'secondary', text: 'Cancel', onclick: () => { creating = false; paint(true); }});
  const form = el('form', {class: 'world-form', onsubmit: async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      const data = await call('', {name: input.value, ...defaults.body()});
      creating = false;
      await refreshList();
      showStatus(`Created ${data.world.name}. Visit it when you are ready.`);
    } catch (error) {
      save.disabled = false;
      showStatus(error.message, true);
    }
  }}, input, defaults.node, el('div', {class: 'world-form-actions'}, cancel, save));
  queueMicrotask(() => input.focus());
  return el('li', {class: 'world-card world-new is-open', 'data-owner': true}, form);
}

// The new world's default provider, model and effort. Prefilled with the town default the owner sees now, else the first
// provider that is set up. Demonstration is never offered; with no provider set up, nothing is sent and the world uses the global default.
let choicesFor = null;
function newWorldDefaults() {
  const provider = el('select', {'aria-label': 'Default provider'});
  const model = el('select', {'aria-label': 'Default model'});
  const other = el('input', {type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 120, placeholder: 'Model name', 'aria-label': 'Other model name', hidden: true});
  const effort = el('select', {'aria-label': 'Default effort'});
  const note = el('p', {class: 'world-ai-note muted', role: 'status', text: 'Loading the providers…'});
  const modelField = el('label', {class: 'world-ai-field'}, el('span', {text: 'Default model'}), model, other);
  const node = el('fieldset', {class: 'world-ai'}, el('legend', {text: 'Starting AI for this world'}),
    el('label', {class: 'world-ai-field'}, el('span', {text: 'Default provider'}), provider), modelField,
    el('label', {class: 'world-ai-field'}, el('span', {text: 'Default effort'}), effort), note);
  wireModelPicker(model, other);
  let catalog = {}, offered = [];
  const paintFor = (id, preset) => {
    const block = catalog[id]?.ai ?? {};
    const hosted = id === 'hosted';
    modelField.hidden = hosted;
    paintModelPicker(model, other, {models: block.models ?? [], value: preset?.model ?? block.default?.model ?? '', blankLabel: 'Provider default'});
    effort.replaceChildren(...effortChoices(block.efforts, 'Provider default').map(c => new Option(c.label, c.value)));
    effort.value = preset?.effort ?? block.default?.effort ?? '';
  };
  provider.addEventListener('change', () => paintFor(provider.value, null));
  const chosen = () => {
    if (!provider.value) return null;
    const block = catalog[provider.value]?.ai ?? {};
    const td = {provider: provider.value};
    if (provider.value !== 'hosted') {
      const m = readModelPicker(model, other);
      if (m) td.model = m;
    }
    if (effort.value && (block.efforts ?? []).includes(effort.value)) td.effort = effort.value;
    return td;
  };
  Promise.resolve().then(() => choicesFor?.() ?? {models: [], townDefault: null, catalog: {}}).then(choices => {
    catalog = choices.catalog ?? {};
    offered = providerChoices(choices.models, catalog);
    if (!offered.length) {
      provider.replaceChildren();
      provider.disabled = model.disabled = effort.disabled = true;
      note.textContent = 'No model provider is set up yet. This world will use the town default until you set one up in Models.';
      return;
    }
    provider.replaceChildren(...offered.map(p => new Option(p.name, p.id)));
    const td = choices.townDefault?.usable && offered.some(p => p.id === choices.townDefault.provider) ? choices.townDefault : null;
    provider.value = td ? td.provider : offered[0].id;
    paintFor(provider.value, td);
    note.textContent = 'Every cat in this world starts on this unless you or the Mayor choose otherwise.';
  }).catch(() => { note.textContent = 'Could not read the providers. The world will use the town default.'; });
  return {node, body: () => {
    const td = chosen();
    return td ? {townDefault: td} : {};
  }};
}

function card(world) {
  const isActive = world.id === list.active;
  const archived = Boolean(world.archivedAt);
  const isHome = world.id === 'home';
  const created = new Date(world.createdAt).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
  const thumb = el('img', {class: 'world-thumb', src: thumbnailUrl(world.id, world.cats ?? 0), alt: '', width: 240, height: 150, loading: 'lazy'});
  const badges = [
    isActive && el('span', {class: 'chip chip-accent', text: 'Active'}),
    archived && el('span', {class: 'chip', text: 'Archived'}),
  ];
  const body = el('div', {class: 'world-body'},
    el('div', {class: 'world-title-row'}, el('h3', {class: 'world-name', text: world.name}), ...badges),
    el('p', {class: 'world-meta', text: [catLabel(world.cats), `Created ${created}`].filter(Boolean).join(' · ')}));
  const item = el('li', {class: `world-card${isActive ? ' is-active' : ''}${archived ? ' is-archived' : ''}`, dataset: {world: world.id}});

  if (renaming === world.id) {
    const input = el('input', {type: 'text', maxlength: 40, value: world.name, autocomplete: 'off', 'aria-label': `New name for ${world.name}`});
    const save = el('button', {type: 'submit', class: 'primary', text: 'Save'});
    const cancel = el('button', {type: 'button', class: 'secondary', text: 'Cancel', onclick: () => { renaming = null; paint(true); }});
    body.append(el('form', {class: 'world-form', onsubmit: async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        await call(`/${encodeURIComponent(world.id)}/rename`, {name: input.value});
        renaming = null;
        await refreshList();
        showStatus('Renamed.');
      } catch (error) {
        save.disabled = false;
        showStatus(error.message, true);
      }
    }}, input, el('div', {class: 'world-form-actions'}, cancel, save)));
    queueMicrotask(() => { input.focus(); input.select(); });
    item.append(thumb, body);
    return item;
  }

  const actions = el('div', {class: 'world-actions'});
  if (!archived && !isActive) actions.append(el('button', {type: 'button', class: 'primary', 'data-owner': true, text: 'Visit', onclick: () => visit(world)}));
  if (!archived) actions.append(el('button', {type: 'button', 'data-owner': true, class: 'secondary', text: 'Rename', onclick: () => { renaming = world.id; paint(true); }}));
  if (archived) actions.append(el('button', {type: 'button', 'data-owner': true, class: 'secondary', text: 'Unarchive', onclick: () => unarchive(world)}));
  else if (!isActive) actions.append(el('button', {type: 'button', 'data-owner': true, class: 'worlds-archive quiet', text: 'Archive', onclick: () => archive(world)}));
  if (!isHome) {
    actions.append(el('button', {type: 'button', 'data-owner': true, class: 'worlds-delete danger', text: 'Delete', disabled: isActive,
      title: isActive ? 'Visit another world first' : undefined, onclick: () => openDelete(world)}));
  }
  item.append(thumb, body, actions);
  return item;
}

async function visit(world) {
  if (busy) return;
  busy = true;
  // The flight closes this dialog and calls activate itself. A failed activate flies back and reopens it with the reason.
  if (travel?.available) {
    const flight = travel.go(world); // null while another flight is under way
    const {phase, error} = flight ? await flight : {};
    busy = false;
    if (phase === 'aborted') { openDialog(); showStatus(error?.message || 'That world could not open.', true); }
    return;
  }
  showStatus(`Opening ${world.name}. The town reloads when it is ready.`);
  try {
    await call(`/${encodeURIComponent(world.id)}/activate`, {});
    location.reload();
  } catch (error) {
    busy = false;
    showStatus(error.message, true);
  }
}

async function archive(world) {
  const ok = await confirmDialog({
    title: `Archive ${world.name}?`,
    message: 'It leaves the Active list. Its files stay in the data folder, so nothing is deleted.',
    confirmLabel: 'Archive',
    cancelLabel: 'Keep it',
  });
  if (!ok) return;
  try {
    await call(`/${encodeURIComponent(world.id)}/archive`, {});
    await refreshList();
    showStatus(`${world.name} is archived.`);
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function unarchive(world) {
  try {
    await call(`/${encodeURIComponent(world.id)}/unarchive`, {});
    await refreshList();
    showStatus(`${world.name} is back in Active.`);
  } catch (error) {
    showStatus(error.message, true);
  }
}

// Permanent deletion needs the owner to type the world's exact name. The button stays disabled until canDelete says yes.
function openDelete(world) {
  deleteDialog ??= el('dialog', {class: 'worlds-delete-dialog confirm-dialog', 'aria-labelledby': 'worlds-delete-title'});
  if (!deleteDialog.isConnected) document.body.append(deleteDialog);
  deleteDialog.replaceChildren();
  const input = el('input', {type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 40, 'aria-label': `Type ${world.name} to confirm`});
  const error = el('p', {class: 'worlds-delete-error', role: 'status'});
  const cancel = el('button', {type: 'button', class: 'confirm-cancel secondary', text: 'Cancel', onclick: () => deleteDialog.close()});
  const remove = el('button', {type: 'submit', class: 'danger', text: 'Delete forever', disabled: true});
  input.addEventListener('input', () => { remove.disabled = !canDelete(input.value, world.name); });
  const form = el('form', {class: 'worlds-delete-form', onsubmit: async event => {
    event.preventDefault();
    if (!canDelete(input.value, world.name)) return;
    remove.textContent = 'Deleting…';
    remove.disabled = cancel.disabled = input.disabled = true;
    error.textContent = '';
    showStatus(`Deleting ${world.name}…`);
    try {
      await call(`/${encodeURIComponent(world.id)}/delete`, {});
      deleteDialog.close();
      await refreshList();
      showStatus(`Deleted ${world.name}. Its cats, history and coins are gone.`);
    } catch (err) {
      remove.textContent = 'Delete forever';
      remove.disabled = !canDelete(input.value, world.name);
      cancel.disabled = input.disabled = false;
      error.textContent = err.message;
      showStatus(`${world.name} was not deleted. ${err.message}`, true);
    }
  }}, el('span', {class: 'eyebrow', text: 'PERMANENT'}),
    el('h2', {id: 'worlds-delete-title', text: `Delete ${world.name} forever?`}),
    el('p', {text: `This permanently removes ${world.name}'s cats, history and coins. It cannot be undone.`}),
    el('label', {}, el('span', {text: `Type ${world.name} to confirm`}), input),
    error,
    el('div', {class: 'dialog-actions confirm-actions'}, cancel, remove));
  deleteDialog.append(form);
  deleteDialog.showModal();
  input.focus();
}

function openDialog() {
  if (!dialog.open) dialog.showModal();
  paint(true);
  showStatus('');
  void refreshList();
}

function buildDialog() {
  const filter = name => el('button', {type: 'button', dataset: {view: name}, 'aria-pressed': name === view ? 'true' : 'false',
    onclick: () => { view = name; paint(true); showStatus(''); }},
    name === 'active' ? 'Active' : 'Archived', ' ', counts[name] = el('span', {class: 'worlds-count'}));
  // Phone: a full-screen page with a back pill. Desktop: a dialog with ×.
  const back = el('button', {type: 'button', class: 'back-pill phone-only', 'aria-label': 'Back to town', onclick: () => dialog.close()}, icon('arrow-left', {size: 18}), 'Town');
  const close = el('button', {type: 'button', class: 'worlds-close close-x desk-only', 'aria-label': 'Close worlds', onclick: () => dialog.close()}, icon('x'));
  status = el('p', {class: 'worlds-status', role: 'status'});
  grid = el('ul', {class: 'worlds-grid', 'aria-label': 'Worlds'});
  dialog = el('dialog', {id: 'worlds-dialog', class: 'worlds-dialog', 'aria-labelledby': 'worlds-title'},
    el('div', {class: 'worlds-head'},
      back,
      el('div', {}, el('span', {class: 'eyebrow', text: 'YOUR TOWNS'}), el('h2', {id: 'worlds-title', text: 'Worlds'})),
      close),
    el('p', {class: 'worlds-intro', text: 'Each world is its own town, with its own cats, history and coins. Visit one to make it the town you see.'}),
    el('div', {class: 'worlds-filter', role: 'group', 'aria-label': 'Show worlds'}, filter('active'), filter('archived')),
    status,
    grid);
  document.body.append(dialog);
  // Closing drops any half-finished rename or new-world form, so the next open starts clean.
  dialog.addEventListener('close', () => { creating = false; renaming = null; });
}

function injectStyles() {
  if (document.querySelector('link[data-worlds-panel]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('worlds-panel.css', import.meta.url).href;
  link.dataset.worldsPanel = '';
  document.head.append(link);
}

/** travel: createWorldTravel's result (app.js). Without it, or before the 3D scene is up, a switch reloads the page. */
export function initWorldsPanel({travel: flight = null, aiChoices = null} = {}) {
  travel = flight;
  choicesFor = aiChoices;
  injectStyles();
  buildDialog();
  chip = document.getElementById('worlds-button');
  chipName = document.getElementById('worlds-chip-name');
  chip?.addEventListener('click', openDialog);
  // The ☰ menu keeps one entry; the menu closes itself when a button in it is pressed, and the dialog opens over it.
  // The ☰ Worlds row opens the Worlds screen directly; the page keeps one button as a fallback.
  registerSettingsSection('worlds', 'Worlds', container => {
    container.append(el('button', {type: 'button', id: 'worlds-open', 'aria-haspopup': 'dialog', text: 'Worlds…', onclick: openDialog}));
  }, {icon: icon('globe', {size: 18}), action: openDialog});
  // app.js dispatches town-state on every refresh. A different active world means the whole scene changes: a flight
  // already under way (or just landed) has it in hand; a switch made elsewhere flies there too; with no scene, reload.
  window.addEventListener('town-state', event => {
    const {prev, next} = event.detail || {};
    if (prev?.activeWorld && next?.activeWorld && prev.activeWorld.id !== next.activeWorld.id) {
      if (!travel?.available) { location.reload(); return; }
      if (!travel.active && travel.shown !== next.activeWorld.id) void travel.go(next.activeWorld, {activate: false});
    }
    if (next?.activeWorld) setChipName(next.activeWorld.name);
    if (dialog.open) void refreshList();
  });
  void refreshList();
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {
  SURFACE_INFO, PANEL_INFO, CAPS, MIN_SEARCH, fold, oneLine, when, nameOf, catStatus, matchScore, arrange, marks, around, isPaletteKey,
  surfaceItems, catItems, threadItems, actionItems, hitItems, initCommandPalette, isShortcutsKey, shortcutRows, isMac,
} from '../public/command-palette.js';
import {FakeDocument, FakeWindow, FakeEvent, press, type} from './fixtures/fake-dom-palette.mjs';

// Plan 8.9: Ctrl+K / ⌘K opens a palette over threads, cats, app.js SURFACES, actions and search hits (GET /api/search, plan 8.4).
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = read('app.js'), html = read('index.html'), css = read('command-palette.css'), source = read('command-palette.js');
// The SURFACES keys exactly as app.js declares them: the palette must open every one.
const SURFACE_KEYS = [...(/const SURFACES=\{(.*?)\};/.exec(app)?.[1] ?? '').matchAll(/(\w+):\(\)=>/g)].map(m => m[1]);
const NOW = Date.parse('2026-11-08T12:00:00Z');

const TOWN = {
  cats: [
    {id: 'mayor', name: 'Mayor', role: 'Coordinate the town.', color: '#e7c9a0'},
    {id: 'scholar', name: 'Scholar', role: 'Research and summaries.', color: '#b9c8d8'},
    {id: 'critic', name: 'Critic', role: 'Reviews drafts.', color: '#d8b9c8'},
  ],
  retiredCats: [{id: 'old', name: 'Old Tom'}],
  tasks: [{id: 't-live', cat: 'scholar', from: 'owner', text: 'Summarise the market notes', status: 'running', mode: 'demo'}],
  goals: [{id: 'g1', title: 'Grow the newsletter', status: 'active', rounds: 3}, {id: 'g2', title: 'Old goal', status: 'achieved', rounds: 9}],
  messages: [
    {id: 'm1', from: 'owner', to: 'mayor', text: 'Plan the launch week', task: 't1', at: '2026-11-08T09:00:00Z'},
    {id: 'm2', from: 'mayor', to: 'scholar', text: 'Please research competitors', task: 't2', at: '2026-11-08T09:01:00Z'},
    {id: 'm3', from: 'owner', to: 'scholar', text: 'How is it going?', aside: true, at: '2026-11-08T10:00:00Z'},
    {id: 'm4', from: 'owner', to: 'critic', text: 'Review the landing page copy', task: 't3', at: '2026-11-08T11:00:00Z'},
    {id: 'm5', from: 'owner', to: 'mayor', text: 'Plan the launch week (again)', task: 't1', at: '2026-11-08T11:30:00Z'},
    {id: 'm6', from: 'owner', to: 'old', text: 'Retired cat request', task: 't9', at: '2026-11-08T11:40:00Z'},
  ],
  approvals: [
    {id: 'a1', cat: 'critic', question: 'Publish the review on the blog?', status: 'pending'},
    {id: 'a2', cat: 'scholar', question: 'Spend 2 coins?', status: 'pending'},
    {id: 'a0', cat: 'scholar', question: 'Old one', status: 'approved'},
  ],
  paused: false, readOnly: false,
};

// A page with the parts the palette reads: the dock, the ☰ controls, the composer. Returns the palette and what it called.
function page({state = TOWN, coarse = false, fetchImpl = null, body = [], hide = [], ...rest} = {}) {
  const doc = new FakeDocument(), win = new FakeWindow(doc, {coarse});
  globalThis.document = doc; // icons.js builds its <svg> with the global document
  doc.body.classList.add(...body);
  const el = (tag, attrs = {}, text = '') => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text) n.textContent = text; return n; };
  const clicks = [];
  const dock = el('nav', {class: 'town-dock'});
  for (const [id, label, icon, panel] of [['residents', 'Cats', 'cat'], ['inspector', 'Chat', 'message-circle'], ['projects', 'Projects', 'flag'], ['quests', 'Inbox', 'inbox'], ['diary', 'Diary', 'book-open'], ['season', 'Coins', 'coins']]) {
    const b = el('button', {id: `toggle-${id}`, type: 'button', 'aria-label': label, 'aria-controls': `${id}-panel`, 'aria-expanded': 'false', 'data-toggle-panel': id});
    const ico = el('span', {class: 'dock-ico', 'aria-hidden': 'true'}), svg = el('svg'), use = el('use', {href: `#i-${icon}`});
    svg.append(use); ico.append(svg); b.append(ico, el('span', {class: 'dock-label'}, label));
    b.onclick = () => clicks.push(b.id);
    const p = el('aside', {id: `${id}-panel`}); p.append(el('button', {'data-collapse': id, 'aria-label': `Close ${label}`}));
    dock.append(b); doc.body.append(p);
    void panel;
  }
  doc.body.append(dock);
  const controls = [['models-open', 'data-owner data-host'], ['connectors-open', 'data-owner data-host'], ['share', 'data-owner data-host'], ['menu-studio', 'data-owner'], ['routines-open', 'data-owner'],
    ['telegram-open', 'data-owner data-host'], ['memory-open', 'data-owner'], ['usage-open', ''], ['discord-open', 'data-owner data-host'], ['accounts-open', 'data-owner data-host'], ['owner-clients-open', 'data-owner data-host'],
    ['mail-watch-open', 'data-owner data-host'], ['ntfy-open', 'data-owner data-host'], ['pause', 'data-owner'], ['recruit', 'data-owner'], ['road-button', 'data-owner'], ['edit-town', 'data-owner'], ['menu-toggle', ''], ['treasury-season', ''],
    ['autonomy-open', 'data-owner'], ['backups-open', 'data-owner data-host']];
  for (const [id, flags] of controls) {
    const b = el('button', {id, 'aria-pressed': 'false'});
    for (const f of flags.split(' ').filter(Boolean)) b.setAttribute(f, '');
    b.hidden = hide.includes(id);
    b.onclick = () => clicks.push(id);
    doc.body.append(b);
  }
  const other = el('dialog', {id: 'treasury-dialog'});
  const message = el('textarea', {id: 'message'}), goal = el('input', {id: 'goal-mode', type: 'checkbox'});
  const changes = [];
  goal.addEventListener('change', e => changes.push(e.target.id));
  doc.body.append(other, message, goal);
  const opened = [], selected = [], pages = [], fetches = [], threads = [];
  const answer = fetchImpl ?? (async () => ({ok: true, status: 200, json: async () => ({messages: [], notes: [], wiki: []})}));
  const palette = initCommandPalette({doc, win, surfaces: Object.fromEntries(SURFACE_KEYS.map(k => [k, () => {}])), openSurface: name => opened.push(name), select: id => selected.push(id),
    openThread: t => threads.push(t), town: () => state, openMemoryPage: slug => pages.push(slug), fetchImpl: (url, init) => { fetches.push(url); return answer(url, init); }, debounceMs: 1, now: () => NOW, ...rest});
  return {doc, win, palette, opened, selected, pages, fetches, threads, clicks, changes, message, goal, other};
}
// Nodes are compared by id: a failed strict assertion on two fake nodes would diff the whole page.
const active = p => p.doc.getElementById(p.palette.input.getAttribute('aria-activedescendant'));
const rows = p => p.palette.list.querySelectorAll('[role="option"]');
const ids = p => rows(p).map(r => r.getAttribute('data-id'));
const activeId = p => active(p)?.getAttribute('data-id') ?? null;
const rowId = (p, i) => rows(p)[i]?.getAttribute('data-id');
const focused = p => p.doc.activeElement?.id || p.doc.activeElement?.tagName;
const groupTitles = p => p.palette.list.querySelectorAll('.cp-group-title').map(t => t.textContent);
const settle = () => new Promise(r => setTimeout(r, 15));

test('every SURFACES key in app.js has a palette name, an icon from the sprite and words; names are unique', () => {
  assert.ok(SURFACE_KEYS.length >= 18, `app.js declares ${SURFACE_KEYS.length} surfaces`);
  assert.deepEqual([...SURFACE_KEYS].sort(), Object.keys(SURFACE_INFO).sort(), 'SURFACE_INFO covers exactly the SURFACES keys');
  const labels = Object.values(SURFACE_INFO).map(i => i.label);
  assert.equal(new Set(labels.map(fold)).size, labels.length, 'no two surfaces share a name');
  const sprite = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map(m => m[1]));
  const used = new Set([...source.matchAll(/icon(?:: |\(')'?([\w-]+)'/g)].map(m => m[1]));
  for (const info of Object.values(SURFACE_INFO)) used.add(info.icon);
  for (const name of used) assert.ok(sprite.has(name), `icon ${name} is in the index.html sprite`);
  // A control is in index.html or made by its panel's module (the ☰ rows routines, memory, usage and the Devices entries).
  const made = readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.js') && f !== 'command-palette.js').map(read).join('\n');
  for (const [name, info] of Object.entries(SURFACE_INFO)) {
    assert.ok(info.label && info.detail, `${name} has a name and a line`);
    if (info.control) assert.ok(html.includes(`id="${info.control}"`) || made.includes(`'${info.control}'`), `${name}'s control #${info.control} exists`);
  }
  assert.deepEqual(Object.keys(PANEL_INFO), ['residents', 'inspector', 'projects', 'quests', 'diary']);
});

test('proof (plan 8.9): every SURFACES entry opens from the palette by keyboard alone: Ctrl+K, its name, Enter', () => {
  const p = page();
  p.message.focus();
  for (const name of SURFACE_KEYS) {
    press(p.doc, 'k', {ctrlKey: true});
    assert.ok(p.palette.isOpen(), `${name}: Ctrl+K opens the palette`);
    assert.equal(focused(p), 'cp-input', `${name}: focus is in the box`);
    type(p.doc, SURFACE_INFO[name].label);
    assert.equal(activeId(p), `surface:${name}`, `${name}: its name makes it the active option`);
    press(p.doc, 'Enter');
    assert.deepEqual(p.opened, [name], `${name}: Enter opens it, and only it`);
    assert.equal(p.palette.isOpen(), false, `${name}: the palette closed`);
    p.opened.length = 0;
    p.message.focus();
  }
});

test('proof (plan 8.9): every SURFACES entry also opens with the arrow keys alone, without typing a letter', () => {
  const p = page();
  for (const name of SURFACE_KEYS) {
    press(p.doc, 'k', {metaKey: true});
    let steps = 0;
    while (activeId(p) !== `surface:${name}` && steps++ < 200) press(p.doc, 'ArrowDown');
    assert.equal(activeId(p), `surface:${name}`, `${name} is reached by ArrowDown`);
    press(p.doc, 'Enter');
    assert.deepEqual(p.opened, [name]);
    p.opened.length = 0;
  }
});

test('the dialog is a combobox with a grouped listbox: names, aria-controls, aria-expanded and one active option', async () => {
  const p = page();
  press(p.doc, 'k', {ctrlKey: true});
  const {dialog, input, list} = p.palette;
  assert.equal(dialog.tagName, 'DIALOG');
  assert.ok(dialog.getAttribute('aria-label'), 'the dialog has a name');
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.ok(input.getAttribute('aria-label'), 'the box has a name');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(p.doc.getElementById(input.getAttribute('aria-controls'))?.id, list.id);
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.ok(list.getAttribute('aria-label'));
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  for (const group of list.querySelectorAll('[role="group"]')) assert.ok(p.doc.getElementById(group.getAttribute('aria-labelledby'))?.textContent, 'each group is named by its title');
  assert.equal(rows(p).filter(r => r.getAttribute('aria-selected') === 'true').length, 1, 'one active option');
  assert.equal(activeId(p), rowId(p, 0), 'the first option starts active');
  for (const row of rows(p)) assert.ok(row.textContent.trim(), `${row.getAttribute('data-id')} has a name`);
  assert.equal(p.doc.querySelector('.cp-close').getAttribute('aria-label'), 'Close search');
  // Nothing typed: suggested actions, threads, cats, then places.
  assert.deepEqual(groupTitles(p), ['Actions', 'Threads', 'Cats', 'Go to']);
  type(p.doc, 'zzqx');
  assert.equal(input.getAttribute('aria-expanded'), 'false', 'no options, no popup');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  assert.ok(list.hidden);
  assert.equal(p.doc.querySelector('.cp-empty').textContent, 'Searching…', 'while the search runs');
  await settle();
  assert.equal(p.doc.querySelector('.cp-empty').textContent, 'Nothing matches “zzqx”.');
  assert.equal(p.doc.querySelector('.cp-status').textContent, 'No results');
});

test('arrows move the active option and wrap; Page keys jump five and stop at the ends', () => {
  const p = page();
  press(p.doc, 'k', {ctrlKey: true});
  const n = rows(p).length;
  press(p.doc, 'ArrowUp');
  assert.equal(activeId(p), rowId(p, n - 1), 'up from the first wraps to the last');
  press(p.doc, 'ArrowDown');
  assert.equal(activeId(p), rowId(p, 0), 'down from the last wraps to the first');
  press(p.doc, 'PageDown');
  assert.equal(activeId(p), rowId(p, 5));
  press(p.doc, 'PageUp'); press(p.doc, 'PageUp');
  assert.equal(activeId(p), rowId(p, 0));
  assert.equal(rows(p).filter(r => r.getAttribute('aria-selected') === 'true').length, 1);
  assert.ok(active(p).scrolled > 0, 'the active row is scrolled into view');
});

test('Escape closes and gives focus back; it never reaches app.js, which would close the open panel', () => {
  const p = page();
  let reached = 0;
  p.doc.addEventListener('keydown', e => { if (e.key === 'Escape') reached++; });
  p.message.focus();
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'mem');
  press(p.doc, 'Escape');
  assert.equal(p.palette.isOpen(), false);
  assert.equal(focused(p), 'message', 'focus returns to where it was');
  assert.equal(reached, 0, 'the Escape stopped at the palette');
  assert.deepEqual(p.opened, []);
  // The close button and the dialog's own cancel (Escape from the button, a phone's back gesture) do the same.
  press(p.doc, 'k', {ctrlKey: true});
  p.doc.querySelector('.cp-close').click();
  assert.equal(p.palette.isOpen(), false);
  assert.equal(focused(p), 'message');
  press(p.doc, 'k', {ctrlKey: true});
  const cancel = new FakeEvent('cancel');
  p.palette.dialog.dispatchEvent(cancel);
  assert.ok(cancel.defaultPrevented);
  assert.equal(p.palette.isOpen(), false);
  assert.equal(focused(p), 'message');
  // Something else closing every open dialog (a surface opening) leaves focus where that put it.
  press(p.doc, 'k', {ctrlKey: true});
  p.goal.focus();
  p.palette.dialog.close();
  assert.equal(focused(p), 'goal-mode');
  // Opened from nothing in particular, closing it leaves focus on the page, never on the closed box.
  p.doc.activeElement = p.doc.body;
  press(p.doc, 'k', {ctrlKey: true});
  press(p.doc, 'Escape');
  assert.equal(focused(p), 'BODY');
  // Opened again it starts empty.
  press(p.doc, 'k', {ctrlKey: true});
  assert.equal(p.palette.input.value, '');
});

test('Ctrl+K and ⌘K open it from anywhere and close it again; "/" and other keys never do', () => {
  assert.equal(isPaletteKey({key: 'k', ctrlKey: true}), true);
  assert.equal(isPaletteKey({key: 'K', metaKey: true}), true);
  assert.equal(isPaletteKey({key: 'л', code: 'KeyK', ctrlKey: true}), true, 'a Cyrillic layout still opens it');
  for (const e of [{key: '/'}, {key: '/', ctrlKey: true}, {key: 'k'}, {key: 'k', ctrlKey: true, shiftKey: true}, {key: 'k', ctrlKey: true, altKey: true}, {key: 'k', ctrlKey: true, metaKey: true},
    {key: 'k', ctrlKey: true, repeat: true}, {key: 'k', ctrlKey: true, isComposing: true}, {key: 'j', code: 'KeyK', ctrlKey: true}]) assert.equal(isPaletteKey(e), false, JSON.stringify(e));
  const p = page();
  const slash = press(p.doc, '/');
  assert.equal(p.palette.isOpen(), false, '"/" is plan 8.7\'s, to focus the composer');
  assert.equal(slash.defaultPrevented, false);
  p.message.focus();
  const open = press(p.doc, 'k', {ctrlKey: true});
  assert.ok(open.defaultPrevented, 'the browser does not get Ctrl+K');
  assert.ok(p.palette.isOpen());
  press(p.doc, 'k', {ctrlKey: true});
  assert.equal(p.palette.isOpen(), false);
  assert.equal(focused(p), 'message');
  for (const body of ['unpaired', 'cinematic']) {
    const q = page({body: [body]});
    press(q.doc, 'k', {ctrlKey: true});
    assert.equal(q.palette.isOpen(), false, `not on body.${body}`);
  }
  // Another surface can open it with words already in the box.
  p.win.dispatchEvent(new FakeEvent('open-palette', {detail: {query: 'scho'}}));
  assert.ok(p.palette.isOpen());
  assert.equal(p.palette.input.value, 'scho');
  assert.equal(activeId(p), 'cat:scholar');
});

test('search: debounced, one request for the last words, hits come after the rest; Enter opens the hit\'s chat', async () => {
  const p = page({fetchImpl: async url => ({ok: true, status: 200, json: async () => ({
    messages: [{id: 'h1', cat: 'owner scholar', at: '2026-11-08T11:00:00Z', text: 'Ask about the review of the pricing page'}, {id: 'h2', cat: 'old mayor', at: '2026-11-07T11:00:00Z', text: 'review from a retired cat'},
      {id: 'h4', cat: 'critic owner', at: '2026-11-08T10:00:00Z', text: 'A long preamble about many other things, the weather and the town, before at last the review itself'},
      {id: 'h3', cat: 'old owner', at: '2026-11-07T11:00:00Z', text: 'review only a retired cat could open'}],
    notes: [{kind: 'note', ref: 'n1', cat: 'scholar', at: '', text: 'note'}], wiki: [{slug: 'pricing', title: 'Pricing', snippet: 'the review of pricing'}],
    url})})});
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'r');
  assert.deepEqual(p.fetches, [], `fewer than ${MIN_SEARCH} letters ask nothing`);
  type(p.doc, 'eview');
  assert.match(p.doc.querySelector('.cp-status').textContent, /searching/);
  await settle();
  assert.deepEqual(p.fetches, ['/api/search?q=review'], 'one request, for the last words only');
  assert.deepEqual(groupTitles(p).slice(-2), ['Messages', 'Memory pages'], 'search hits come last');
  assert.ok(ids(p).includes('message:h2'), 'a retired cat\'s message to a current cat opens that cat\'s chat');
  assert.ok(!ids(p).includes('message:h3'), 'a message with no chat left to open is left out');
  assert.ok(!ids(p).some(id => id.startsWith('note')), 'memory notes are not listed');
  const hit = rows(p).find(r => r.getAttribute('data-id') === 'message:h1');
  assert.match(hit.textContent, /You to Scholar · 1 h ago/);
  assert.equal(hit.querySelector('mark').textContent.toLowerCase(), 'review', 'the typed word is marked');
  const late = rows(p).find(r => r.getAttribute('data-id') === 'message:h4').querySelector('.cp-label').textContent;
  assert.ok(late.startsWith('…') && late.indexOf('review') <= 26, `a match late in a long message is shown in view: ${late}`);
  // While it is open, words typed again reuse their answer.
  const retype = text => { p.palette.input.value = text; p.palette.input.dispatchEvent(new FakeEvent('input', {bubbles: true})); };
  retype('review x');
  retype('review');
  await settle();
  assert.equal(p.fetches.length, 1, 'no second request for the same words');
  assert.ok(ids(p).includes('message:h1'));
  for (let i = 0; activeId(p) !== 'message:h1' && i < 50; i++) press(p.doc, 'ArrowDown');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected, ['scholar']);
  // Opened again it asks afresh, since new messages may have come. A memory page opens in Memory, at that page.
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'review');
  await settle();
  assert.equal(p.fetches.length, 2);
  assert.ok(ids(p).includes('wiki:pricing'));
  for (let i = 0; activeId(p) !== 'wiki:pricing' && i < 50; i++) press(p.doc, 'ArrowDown');
  press(p.doc, 'Enter');
  assert.deepEqual(p.pages, ['pricing']);
});

for (const status of [401, 403]) {
  test(`search: a ${status} is quiet, and the palette stops asking until it is opened again`, async () => {
    const p = page({fetchImpl: async () => ({ok: false, status, json: async () => ({error: 'Open Clowder from its own window.'})})});
    press(p.doc, 'k', {ctrlKey: true});
    type(p.doc, 'scholar');
    await settle();
    assert.equal(p.fetches.length, 1);
    assert.ok(!groupTitles(p).includes('Messages'));
    assert.match(p.doc.querySelector('.cp-status').textContent, /^\d+ results?$/, 'no error, the local rows only');
    assert.ok(p.doc.querySelector('.cp-empty').hidden);
    assert.equal(activeId(p), 'cat:scholar');
    type(p.doc, ' notes');
    await settle();
    assert.equal(p.fetches.length, 1, 'no second request after a refusal');
    press(p.doc, 'Escape');
    press(p.doc, 'k', {ctrlKey: true});
    type(p.doc, 'critic');
    await settle();
    assert.equal(p.fetches.length, 2, 'a new opening asks once more');
  });
}

test('search: an answer for older words never replaces the answer for the newer ones', async () => {
  const waiting = [];
  const p = page({fetchImpl: url => new Promise(resolve => waiting.push({url, resolve}))});
  const reply = (i, text) => waiting[i].resolve({ok: true, status: 200, json: async () => ({messages: [{id: `x${i}`, cat: 'owner mayor', at: '2026-11-08T11:00:00Z', text}]})});
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'launch');
  await settle();
  type(p.doc, ' plan');
  await settle();
  assert.deepEqual(waiting.map(w => w.url), ['/api/search?q=launch', '/api/search?q=launch%20plan']);
  reply(1, 'launch plan for the week');
  await settle();
  reply(0, 'launch party');
  await settle();
  assert.ok(ids(p).includes('message:x1'));
  assert.ok(!ids(p).includes('message:x0'), 'the stale answer is dropped');
});

test('a repaint for the same words (search hits, a town change) keeps the active option; new words start on the best match', async () => {
  const r = page({fetchImpl: async () => ({ok: true, status: 200, json: async () => ({messages: [{id: 'z1', cat: 'owner critic', at: '', text: 'critic says hi'}]})})});
  press(r.doc, 'k', {ctrlKey: true});
  type(r.doc, 'cri');
  const first = activeId(r);
  press(r.doc, 'ArrowDown');
  const moved = activeId(r);
  assert.notEqual(moved, first);
  await settle();
  assert.ok(ids(r).includes('message:z1'), 'hits arrived');
  assert.equal(activeId(r), moved, 'the active option stayed put');
  r.win.dispatchEvent(new FakeEvent('town-state'));
  await settle();
  assert.equal(activeId(r), moved, 'and stays across a town change');
  type(r.doc, 't');
  assert.equal(activeId(r), rowId(r, 0), 'new words start on the best match');
});

test('what this device may do decides the list: viewers, paired phones and probe-gated rows', () => {
  const surfacesOf = p => ids(p).filter(id => id.startsWith('surface:')).map(id => id.slice(8)).sort();
  const owner = page();
  press(owner.doc, 'k', {ctrlKey: true});
  assert.deepEqual(surfacesOf(owner), [...SURFACE_KEYS].sort(), 'the host owner sees every surface');
  const viewer = page({state: {...TOWN, readOnly: true}, body: ['viewer']});
  press(viewer.doc, 'k', {ctrlKey: true});
  assert.deepEqual(surfacesOf(viewer), ['archive', 'memorial', 'season', 'treasury', 'usage', 'worlds'], 'a viewer sees what its ☰ menu shows');
  type(viewer.doc, 'a');
  assert.ok(!ids(viewer).some(id => id.startsWith('action:') && !['action:settings', 'action:shortcuts'].includes(id)), 'and no owner actions: Settings and the shortcut list only');
  const phone = page({body: ['remote']});
  press(phone.doc, 'k', {ctrlKey: true});
  assert.ok(!surfacesOf(phone).some(s => ['models', 'connectors', 'devices', 'telegram', 'discord', 'accounts', 'clients', 'mail', 'ntfy', 'postoffice', 'backups'].includes(s)), 'a paired phone sees no host-only surface');
  assert.ok(['routines', 'memory', 'autonomy'].every(s => surfacesOf(phone).includes(s)), 'the Mayor’s and the Archivist’s owner panels open there too');
  const fresh = page({hide: ['telegram-open', 'models-open']});
  press(fresh.doc, 'k', {ctrlKey: true});
  assert.ok(!surfacesOf(fresh).includes('telegram') && !surfacesOf(fresh).includes('models'), 'rows whose probe has not answered stay out');
  assert.ok(surfacesOf(fresh).includes('postoffice'), 'the Post office is offered while any of its entries shows');
  const empty = page({hide: ['telegram-open', 'discord-open', 'mail-watch-open', 'ntfy-open', 'accounts-open', 'owner-clients-open', 'connectors-open']});
  press(empty.doc, 'k', {ctrlKey: true});
  assert.ok(!surfacesOf(empty).includes('postoffice'), 'and not while none does');
});

test('cats, threads and panels open where they should; a desk gets the cursor in the composer, a phone does not', () => {
  const p = page();
  press(p.doc, 'k', {ctrlKey: true});
  p.other.showModal();
  type(p.doc, 'scholar');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected, ['scholar']);
  assert.equal(focused(p), 'message', 'the composer has the cursor');
  assert.equal(p.other.open, false, 'a dialog left open under the palette is closed, so the chat shows');
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'landing page');
  assert.equal(activeId(p), 'thread:t3', 'a request is found by its words');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected, ['scholar', 'critic']);
  assert.deepEqual(p.threads, [{kind: 'request', id: 't3'}], 'its cat’s chat opens on the request’s own thread');
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'grow the newsletter');
  assert.equal(activeId(p), 'goal:g1');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected.at(-1), 'mayor');
  assert.deepEqual(p.threads.at(-1), {kind: 'goal', id: 'g1'}, 'a goal opens its thread in the Mayor’s chat');
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'projects');
  assert.equal(activeId(p), 'panel:projects');
  press(p.doc, 'Enter');
  assert.deepEqual(p.clicks, ['toggle-projects'], 'a closed panel opens through its dock button');
  p.doc.getElementById('toggle-projects').setAttribute('aria-expanded', 'true');
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'projects');
  press(p.doc, 'Enter');
  assert.deepEqual(p.clicks, ['toggle-projects'], 'an open one is not clicked shut');
  assert.equal(p.doc.activeElement.getAttribute('data-collapse'), 'projects', 'it gets focus instead');
  const phone = page({coarse: true});
  press(phone.doc, 'k', {ctrlKey: true});
  type(phone.doc, 'critic');
  press(phone.doc, 'Enter');
  assert.deepEqual(phone.selected, ['critic']);
  assert.notEqual(focused(phone), 'message', 'a phone keeps its keyboard down');
  // The Coins panel is a SURFACES entry already, so the dock's Coins button is not listed twice.
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'coins');
  assert.deepEqual(ids(p).filter(id => /coins|season/.test(id)), ['surface:season']);
  // With the coin economy off, app.js hides the Money dialog's Coins season button, and the palette offers no Coins row either.
  const off = page({hide: ['treasury-season']});
  press(off.doc, 'k', {ctrlKey: true});
  type(off.doc, 'coins');
  assert.deepEqual(ids(off).filter(id => /coins|season/.test(id)), []);
});

test('actions: answer the next decision through its #approval= link, pause in place, a new goal, the rest by their controls', () => {
  const setups = [];
  const p = page({openSetup: () => setups.push('hub')});
  p.message.focus();
  press(p.doc, 'k', {ctrlKey: true});
  assert.deepEqual(ids(p).filter(id => id.startsWith('action:')), ['action:answer', 'action:goal', 'action:pause'], 'nothing typed: the suggested actions');
  assert.match(active(p).textContent, /Answer the next decision1 of 2 · Critic: Publish the review on the blog\?/);
  const hashes = [];
  p.win.addEventListener('hashchange', () => hashes.push(p.win.history.calls.at(-1)[2]));
  p.other.showModal();
  press(p.doc, 'Enter');
  assert.deepEqual(hashes, ['#approval=a1'], 'the same link a notification opens');
  assert.equal(p.other.open, false);
  p.message.focus();
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'pause');
  press(p.doc, 'Enter');
  assert.deepEqual(p.clicks, ['pause']);
  assert.equal(focused(p), 'message', 'pausing happens in place: focus goes back');
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'new goal');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected, ['mayor']);
  assert.ok(p.goal.checked);
  assert.deepEqual(p.changes, ['goal-mode'], 'the Options chip hears the change');
  assert.equal(focused(p), 'message');
  for (const [words, control] of [['recruit', 'recruit'], ['connect two', 'road-button'], ['edit town', 'edit-town'], ['settings', 'menu-toggle']]) {
    press(p.doc, 'k', {ctrlKey: true});
    type(p.doc, words);
    press(p.doc, 'Enter');
    assert.equal(p.clicks.at(-1), control, `${words} presses ${control}`);
  }
  // Set up Clowder left ☰ for a card on the Mayor's thread; the palette opens the same hub (menu-chat-mailman.md).
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'set up');
  assert.equal(activeId(p), 'action:setup');
  press(p.doc, 'Enter');
  assert.deepEqual(setups, ['hub'], 'Set up Clowder opens the hub');
  const paused = page({state: {...TOWN, paused: true}});
  press(paused.doc, 'k', {ctrlKey: true});
  type(paused.doc, 'resume');
  assert.equal(activeId(paused), 'action:pause');
  assert.match(active(paused).textContent, /Resume town/);
});

test('ranking: the label first, a word start before a middle, every typed word must match, accents fold', () => {
  const item = (label, keywords = [], detail = '') => ({label, keywords, detail});
  assert.equal(matchScore(item('AI models'), ''), 1);
  assert.ok(matchScore(item('Memory'), 'memory') > matchScore(item('Memorial'), 'memo'));
  assert.ok(matchScore(item('Memory'), 'mem') > matchScore(item('Email to the Mayor'), 'mem'), 'a word start beats a match inside a word');
  assert.ok(matchScore(item('Pause town'), 'town') > matchScore(item('Money', ['moonvault', 'town funds']), 'town'), 'the label beats a keyword');
  assert.ok(matchScore(item('Money', ['moonvault']), 'moon') > matchScore(item('Usage', [], 'tokens and the moon'), 'moon'), 'a keyword beats the detail');
  assert.equal(matchScore(item('Connectors & plugins'), 'conn plug') > 0, true, 'words in any order, each a prefix');
  assert.equal(matchScore(item('Connectors & plugins'), 'conn zebra'), 0, 'every word must match');
  assert.ok(matchScore(item('Café notes'), 'cafe') > 0, 'accents fold');
  assert.equal(fold('  Café   NOTES '), 'cafe notes');
  const ranked = arrange([{...item('Memorial'), group: 'places', id: 'a'}, {...item('Memory'), group: 'places', id: 'b'}, {...item('Mayor'), group: 'cats', id: 'c'}], 'mem');
  assert.deepEqual(ranked.flatMap(g => g.items.map(i => i.id)), ['b', 'a'], 'ties go to the shorter label; no match, no row');
});

test('arrange: nothing typed shows suggestions with threads capped; typed groups follow their best row; search hits stay last', () => {
  const rowsOf = (group, n, extra = {}) => Array.from({length: n}, (_, i) => ({id: `${group}${i}`, group, label: `${group} row ${i}`, ...extra}));
  const all = [...rowsOf('actions', 2, {suggest: false}), {id: 'go', group: 'actions', label: 'Pause town', suggest: true}, ...rowsOf('threads', 9), ...rowsOf('cats', 2), ...rowsOf('places', 3), ...rowsOf('messages', 12), ...rowsOf('memory', 7)];
  const empty = arrange(all, '');
  assert.deepEqual(empty.map(g => [g.key, g.items.length]), [['actions', 1], ['threads', CAPS.empty.threads], ['cats', 2], ['places', 3]]);
  const typed = arrange(all, 'row');
  assert.deepEqual(typed.map(g => [g.key, g.items.length]), [['actions', 2], ['threads', 8], ['cats', 2], ['places', 3], ['messages', 8], ['memory', 5]]);
  const best = arrange([{id: 'p', group: 'places', label: 'Pause notes'}, {id: 't', group: 'threads', label: 'Talk about a pause'}, {id: 'm', group: 'messages', label: 'pause'}], 'pause');
  assert.deepEqual(best.map(g => g.key), ['places', 'threads', 'messages'], 'the group with the best row comes first, hits last');
});

test('marks, snippets, one lines and times', () => {
  assert.deepEqual(marks('Email to the Mayor', 'ma'), [{text: 'Email to the ', mark: false}, {text: 'Ma', mark: true}, {text: 'yor', mark: false}], 'a word start is marked before a middle');
  assert.deepEqual(marks('AI models', 'mod ai'), [{text: 'AI', mark: true}, {text: ' ', mark: false}, {text: 'mod', mark: true}, {text: 'els', mark: false}]);
  assert.deepEqual(marks('Usage', 'zz'), [{text: 'Usage', mark: false}]);
  const long = `${'word '.repeat(40)}the pricing review is here ${'tail '.repeat(30)}`;
  const s = around(long, 'pricing');
  assert.ok(s.startsWith('…') && s.indexOf('pricing') > 0 && s.indexOf('pricing') <= 26, `a late match is in view: ${s}`);
  assert.equal(around('short text', 'x'), 'short text');
  assert.equal(around('Pricing comes first, then a great many other words', 'pricing'), 'Pricing comes first, then a great many other words', 'a match near the start leaves it');
  assert.equal(oneLine('a  b\n c'), 'a b c');
  assert.equal(oneLine('one two three four five six', 15), 'one two three…');
  assert.equal(when('2026-11-08T11:59:40Z', NOW), 'just now');
  assert.equal(when('2026-11-08T11:15:00Z', NOW), '45 min ago');
  assert.equal(when('2026-11-08T09:00:00Z', NOW), '3 h ago');
  assert.equal(when('2026-11-06T12:00:00Z', NOW), '2 d ago');
  assert.equal(when('nonsense', NOW), '');
  assert.equal(nameOf(TOWN, 'owner'), 'You');
  assert.equal(nameOf(TOWN, 'old'), 'Old Tom');
  assert.equal(catStatus(TOWN, 'scholar'), 'Working');
  assert.equal(catStatus({tasks: [{cat: 'x', status: 'waiting'}]}, 'x'), 'Needs you');
  assert.equal(catStatus(TOWN, 'critic'), 'At ease');
});

test('rows: surfaces by name, cats with status and colour, threads newest first, actions for owners, hits by chat', () => {
  const surfaces = surfaceItems(['ntfy', 'models', 'mystery'], name => name !== 'ntfy');
  assert.deepEqual(surfaces.map(s => [s.id, s.label]), [['surface:models', 'AI models'], ['surface:mystery', 'Mystery']], 'by name; an unknown surface still opens under its key');
  const cats = catItems(TOWN);
  assert.deepEqual(cats.map(c => [c.label, c.detail, c.tint]), [['Mayor', 'At ease · Coordinate the town.', '#e7c9a0'], ['Scholar', 'Working · Research and summaries.', '#b9c8d8'], ['Critic', 'At ease · Reviews drafts.', '#d8b9c8']]);
  const threads = threadItems(TOWN, NOW);
  assert.deepEqual(threads.map(t => [t.id, t.label, t.detail]), [
    ['goal:g1', 'Grow the newsletter', 'Goal · going · 3 rounds'],
    ['thread:t1', 'Plan the launch week (again)', 'Mayor · 30 min ago'],
    ['thread:t3', 'Review the landing page copy', 'Critic · 1 h ago'],
    ['thread:t-live', 'Summarise the market notes', 'Scholar · working'],
  ], 'goals going first; one row per request, newest first; asides, cat-to-cat talk and retired cats left out');
  assert.deepEqual(actionItems({...TOWN, readOnly: true}).map(a => a.id), ['action:settings', 'action:shortcuts'], 'a viewer gets Settings and the shortcut list only');
  assert.deepEqual(actionItems({...TOWN, cats: TOWN.cats.slice(0, 1), approvals: []}).map(a => a.id), ['action:goal', 'action:pause', 'action:recruit', 'action:edit', 'action:settings', 'action:shortcuts'], 'no road with one cat, no answer with nothing waiting, no setup without its hub');
  assert.ok(actionItems(TOWN, {setup: true}).some(a => a.id === 'action:setup'), 'an owner with the hub gets Set up Clowder');
  // ux-ui-improvements row 5: the row is the ☰ dialog's own heading, and the name the button used to have still finds it.
  const settings = actionItems(TOWN).find(a => a.id === 'action:settings');
  assert.equal(settings.label, 'Settings');
  assert.ok(matchScore(settings, 'town menu') > 0, '"town menu" still finds Settings');
  assert.ok(!actionItems({...TOWN, readOnly: true}, {setup: true}).some(a => a.id === 'action:setup'), 'a viewer never does');
  assert.equal(actionItems(TOWN, {pressed: id => id === 'edit-town'}).find(a => a.id === 'action:edit').label, 'Done editing');
  const hits = hitItems({messages: [{id: 'a', cat: 'owner critic', text: 'x', at: ''}, {id: 'b', cat: 'critic owner', text: 'y', at: ''}, {id: 'c', cat: 'mayor scholar', text: 'z', at: ''}, {id: 'd', cat: 'old owner', text: 'gone', at: ''}],
    notes: [{ref: 'n'}], wiki: [{slug: 'sam', title: '', snippet: 'Sam likes tea'}]}, TOWN, NOW);
  assert.deepEqual(hits.map(h => [h.id, h.kind, h.cat ?? h.slug, h.label]), [['message:a', 'cat', 'critic', 'x'], ['message:b', 'cat', 'critic', 'y'], ['message:c', 'cat', 'mayor', 'z'], ['wiki:sam', 'wiki', 'sam', 'sam']]);
});

// Plan 11.7 (F5, F16): the phone gets a Search button, and "?" lists the keys the app already answers to.
const sheetOf = p => p.palette.shortcuts;
const sheetKeys = p => sheetOf(p).dialog.querySelectorAll('.cp-shortcut').map(row => row.querySelectorAll('kbd').map(k => k.textContent).join(' '));
const sheetWords = p => sheetOf(p).dialog.querySelectorAll('.cp-shortcut-what').map(d => d.textContent);
// The phone dock's More list as index.html has it: More, then the list with Search first.
function moreList(p) {
  const more = p.doc.createElement('button'), list = p.doc.createElement('div'), search = p.doc.createElement('button'), label = p.doc.createElement('span');
  more.setAttribute('id', 'dock-more');
  list.setAttribute('id', 'dock-more-menu');
  search.setAttribute('id', 'dock-search');
  search.setAttribute('data-open-palette', '');
  label.className = 'dock-label';
  label.textContent = 'Search';
  search.append(label);
  list.append(search);
  p.doc.body.append(more, list);
  return {more, search, label};
}

test('plan 11.7 proof: the phone\'s More → Search opens the palette by the open-palette event, and a typed word finds a message', async () => {
  const p = page({coarse: true, fetchImpl: async url => ({ok: true, status: 200, json: async () => ({
    messages: url.includes('launch') ? [{id: 'h1', cat: 'owner mayor', at: '2026-11-08T11:30:00Z', text: 'Plan the launch week, with a checklist'}] : [], notes: [], wiki: []})})});
  const {more, search, label} = moreList(p);
  const events = [];
  p.win.addEventListener('open-palette', e => events.push(e.detail));
  // mobile-ui.js closes the list and leaves focus on More before the item's own click runs.
  more.focus();
  label.click();
  assert.equal(events.length, 1, 'one open-palette event per tap');
  assert.deepEqual(events[0], {query: ''});
  assert.ok(p.palette.isOpen(), 'Search opens the palette');
  assert.equal(focused(p), 'cp-input', 'with the cursor in the box');
  assert.equal(p.palette.input.value, '', 'and nothing typed');
  type(p.doc, 'launch');
  await settle();
  assert.equal(p.fetches.length, 1);
  assert.match(p.fetches[0], /\/api\/search\?q=launch$/);
  assert.ok(ids(p).includes('message:h1'), 'the typed word finds the message');
  assert.deepEqual(groupTitles(p).at(-1), 'Messages');
  while (activeId(p) !== 'message:h1') press(p.doc, 'ArrowDown');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected, ['mayor'], 'and opens its chat');
  assert.notEqual(focused(p), 'message', 'a phone keeps its keyboard down: the composer does not take focus');
  // Escape gives focus back to More, as every other item of the list does.
  more.focus();
  search.click();
  assert.ok(p.palette.isOpen());
  press(p.doc, 'Escape');
  assert.equal(p.palette.isOpen(), false);
  assert.equal(focused(p), 'dock-more');
  // A click anywhere else asks for nothing.
  more.click();
  p.doc.body.click();
  assert.equal(events.length, 2);
  assert.equal(p.palette.isOpen(), false);
});

test('plan 11.7: Search heads the More list in index.html, opens a dialog, stands in the dock row from 900px too, and Memory gets no second entry', () => {
  const at = html.indexOf('<div id="dock-more-menu"'), more = html.slice(at, html.indexOf('</div>', html.indexOf('id="toggle-memorial"', at)));
  const first = /^<div id="dock-more-menu"[^>]*>(<button [^>]*>)(.*?)<\/button>/.exec(more);
  assert.ok(first, 'the More list starts with a button');
  assert.match(first[1], /^<button id="dock-search" type="button" aria-label="Search" aria-haspopup="dialog" data-open-palette>$/);
  assert.match(first[2], /<use href="#i-search"\/>/);
  assert.match(first[2], /<span class="dock-label">Search<\/span>/);
  assert.equal(html.match(/data-open-palette/g)?.length, 1, 'one Search button in the page');
  assert.ok(!/data-toggle-panel/.test(first[1]), 'it is not a panel, so the palette does not list it as a place');
  assert.ok(!/Memory/.test(more), 'Memory stays where docs/design/menu-chat-mailman.md puts it (More → Archive): no second entry');
  for (const name of ['search', 'keyboard']) assert.match(html, new RegExp(`<symbol id="i-${name}" viewBox="0 0 24 24">`), `the sprite has ${name}`);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // UX audit 2026-11-10, row 10: from 900px the More list's items stand in the dock row, and Search stands there with them.
  assert.ok(!/#dock-search[^{}]*\{[^}]*display:none/.test(rules), 'no rule hides Search: the dock row shows it from 900px, beside Ctrl+K');
});

test('plan 11.7: "?" opens the shortcut list with the keys the app binds; Escape closes it, gives focus back and never reaches app.js', () => {
  const p = page();
  const button = p.doc.createElement('button');
  button.setAttribute('id', 'somewhere');
  p.doc.body.append(button);
  let reached = 0;
  p.doc.addEventListener('keydown', e => { if (e.key === 'Escape') reached++; });
  button.focus();
  const opened = press(p.doc, '?', {shiftKey: true});
  assert.ok(sheetOf(p).isOpen(), '"?" opens it');
  assert.ok(opened.defaultPrevented);
  assert.equal(p.palette.isOpen(), false, 'the palette stays shut');
  const dialog = sheetOf(p).dialog;
  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'cp-sheet-title');
  assert.equal(p.doc.getElementById('cp-sheet-title').textContent, 'Keyboard shortcuts');
  assert.ok(dialog.classList.contains('command-palette'), 'in the palette\'s card: a full-width sheet on phones');
  assert.equal(p.doc.activeElement.getAttribute('aria-label'), 'Close keyboard shortcuts', 'focus is on its close button');
  assert.deepEqual(sheetKeys(p), ['Ctrl K', '/', 'E', 'Esc', '?'], 'Ctrl+K, "/", E, Escape and "?" itself, nothing the app does not bind');
  assert.ok(sheetWords(p).every(w => w.length > 8), 'each key says what it does');
  assert.equal(dialog.querySelectorAll('.cp-shortcut').length, 5, 'one screen: five lines');
  press(p.doc, 'Escape');
  assert.equal(sheetOf(p).isOpen(), false, 'Escape closes it');
  assert.equal(focused(p), 'somewhere', 'and focus goes back');
  assert.equal(reached, 0, 'app.js never sees that Escape, which would close the open panel or leave edit mode');
  // "?" again closes it; the close button, the dialog's cancel (a phone's back gesture) and the scrim do too.
  press(p.doc, '?', {shiftKey: true});
  press(p.doc, '?', {shiftKey: true});
  assert.equal(sheetOf(p).isOpen(), false, '"?" toggles');
  assert.equal(focused(p), 'somewhere');
  press(p.doc, '?');
  dialog.querySelector('.cp-close').click();
  assert.equal(sheetOf(p).isOpen(), false);
  press(p.doc, '?');
  const cancel = new FakeEvent('cancel');
  dialog.dispatchEvent(cancel);
  assert.ok(cancel.defaultPrevented);
  assert.equal(sheetOf(p).isOpen(), false);
  press(p.doc, '?');
  dialog.dispatchEvent(new FakeEvent('click', {bubbles: true}));
  assert.equal(sheetOf(p).isOpen(), false, 'a click on the scrim');
  assert.equal(focused(p), 'somewhere');
  // Ctrl+K from the list swaps it for the palette; Escape then goes back to where the list was opened from.
  press(p.doc, '?');
  press(p.doc, 'k', {ctrlKey: true});
  assert.equal(sheetOf(p).isOpen(), false);
  assert.ok(p.palette.isOpen());
  press(p.doc, 'Escape');
  assert.equal(focused(p), 'somewhere');
});

test('plan 11.7: "?" is a character in a text field, and never opens over another dialog, with Ctrl, ⌘ or Alt, or before pairing', () => {
  const p = page();
  p.message.focus();
  type(p.doc, 'why?');
  assert.equal(p.message.value, 'why?', 'the composer types it');
  assert.equal(sheetOf(p).isOpen(), false);
  p.doc.body.focus?.();
  p.doc.activeElement = p.doc.body;
  for (const mods of [{ctrlKey: true}, {metaKey: true}, {altKey: true}, {repeat: true}, {isComposing: true}]) {
    press(p.doc, '?', {shiftKey: true, ...mods});
    assert.equal(sheetOf(p).isOpen(), false, JSON.stringify(mods));
  }
  p.other.showModal();
  press(p.doc, '?', {shiftKey: true});
  assert.equal(sheetOf(p).isOpen(), false, 'not over the Moonvault or any other dialog');
  p.other.close();
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, '?');
  assert.equal(sheetOf(p).isOpen(), false, 'in the palette, "?" is typed into the box');
  assert.equal(p.palette.input.value, '?');
  press(p.doc, 'Escape');
  for (const body of ['unpaired', 'cinematic']) {
    const q = page({body: [body]});
    press(q.doc, '?', {shiftKey: true});
    assert.equal(sheetOf(q).isOpen(), false, `not on body.${body}`);
  }
  assert.equal(isShortcutsKey({key: '?', shiftKey: true, target: {tagName: 'BUTTON'}}), true);
  assert.equal(isShortcutsKey({key: '?', target: {tagName: 'INPUT', type: 'checkbox'}}), true, 'a checkbox takes no text');
  for (const target of [{tagName: 'INPUT', type: 'search'}, {tagName: 'INPUT'}, {tagName: 'TEXTAREA'}, {tagName: 'SELECT'}, {tagName: 'DIV', isContentEditable: true}]) {
    assert.equal(isShortcutsKey({key: '?', target}), false, JSON.stringify(target));
  }
  assert.equal(isShortcutsKey({key: '/', target: null}), false, '"/" stays plan 8.7\'s');
  assert.equal(isShortcutsKey({key: '?', defaultPrevented: true}), false, 'a key something else took');
});

test('plan 11.7: the palette row "Keyboard shortcuts" opens the same list; "?", "keys" and "shortcuts" find it; viewers and Macs get their own keys', () => {
  const p = page();
  p.message.focus();
  press(p.doc, 'k', {ctrlKey: true});
  assert.ok(!ids(p).includes('action:shortcuts'), 'not suggested before anything is typed');
  for (const words of ['?', 'keys', 'shortcuts', 'keyboard']) {
    p.palette.input.value = '';
    type(p.doc, words);
    assert.equal(activeId(p), 'action:shortcuts', `"${words}" makes it the best match`);
    p.palette.input.value = '';
    p.palette.input.dispatchEvent(new FakeEvent('input', {bubbles: true}));
  }
  type(p.doc, 'shortcuts');
  const row = active(p);
  assert.equal(row.querySelector('.cp-label').textContent, 'Keyboard shortcuts');
  assert.equal(row.querySelector('.cp-detail').textContent, 'Ctrl+K, /, E, Esc, ?');
  press(p.doc, 'Enter');
  assert.equal(p.palette.isOpen(), false, 'the palette closes');
  assert.ok(sheetOf(p).isOpen(), 'and the list opens');
  press(p.doc, 'Escape');
  assert.equal(focused(p), 'message', 'Escape goes back to where the palette was opened from');
  // A viewer: "/" and E do nothing on a read-only page, so the list leaves them out.
  const viewer = page({state: {...TOWN, readOnly: true}, body: ['viewer']});
  press(viewer.doc, '?');
  assert.deepEqual(sheetKeys(viewer), ['Ctrl K', 'Esc', '?']);
  assert.deepEqual(shortcutRows({readOnly: true}).map(r => r.keys.join(' ')), ['Ctrl K', 'Esc', '?']);
  // A Mac reads ⌘K, in the list and in the row.
  const mac = page();
  mac.win.navigator = {platform: 'MacIntel'};
  assert.equal(isMac(mac.win), true);
  assert.equal(isMac({navigator: {userAgentData: {platform: 'Windows'}, platform: 'MacIntel'}}), false, 'userAgentData first');
  assert.equal(isMac({}), false);
  press(mac.doc, '?');
  assert.deepEqual(sheetKeys(mac), ['⌘ K', '/', 'E', 'Esc', '?']);
  assert.equal(actionItems(TOWN, {mac: true}).find(a => a.id === 'action:shortcuts').detail, '⌘K, /, E, Esc, ?');
});

test('wiring: one import and one init line in app.js, one stylesheet link in index.html', () => {
  assert.equal(app.match(/from '\.\/command-palette\.js'/g)?.length, 1);
  const init = app.split('\n').filter(line => line.includes('initCommandPalette('));
  assert.equal(init.length, 1);
  assert.match(init[0], /surfaces:SURFACES/);
  assert.match(init[0], /openSurface/);
  assert.ok(app.indexOf('initCommandPalette(') > app.indexOf('const SURFACES='), 'after SURFACES is defined');
  assert.equal(html.match(/<link rel="stylesheet" href="\/command-palette\.css">/g)?.length, 1);
  assert.ok(!/key\s*===\s*'\/'/.test(source), 'the palette binds no "/"');
});

test('the stylesheet uses the V0 tokens only, honours reduced motion, and is a full-width sheet with 44px rows on phones', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rules), 'no hex colours');
  assert.ok(!/\b(rgb|rgba|hsl|hsla|oklch|lab)\(/i.test(rules), 'no colour functions');
  assert.ok(!/[:\s,(](white|black|red|green|blue|gr[ae]y|silver|orange|yellow|purple|pink|brown|navy|teal)(?![\w-])/i.test(rules), 'no named colours');
  assert.ok(!/#a77b35|#8c806a/i.test(css), 'the retired colours stay retired');
  assert.ok(!/:root/.test(rules), 'no tokens of its own');
  assert.ok(!/@font-face|font-family/.test(rules), 'no fonts');
  for (const [, name] of rules.matchAll(/var\((--[\w-]+)/g)) {
    if (name === '--cp-tint') continue;
    assert.match(read('style.css'), new RegExp(`[{;]${name}:`), `${name} is a style.css token`);
  }
  // Every animation sits inside prefers-reduced-motion: no-preference.
  const blocks = [...rules.matchAll(/@media\(prefers-reduced-motion:no-preference\)[^{]*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map(m => m[0]);
  assert.ok(blocks.join('').includes('animation:'), 'an opening animation exists');
  assert.equal(blocks.reduce((rest, block) => rest.replace(block, ''), rules).match(/animation(-name)?:/g), null, 'and nowhere else');
  assert.match(rules, /@media\(pointer:coarse\)\{[^@]*\.cp-option\{min-height:var\(--tap\)\}/);
  assert.match(rules, /@media\(max-width:599px\)\{[^@]*dialog\.command-palette\{inset:0;width:100%;height:100dvh/);
  assert.match(rules, /@media\(hover:hover\)\{[^@]*:hover/, 'hover colours only where a pointer hovers');
  assert.ok(!/:hover/.test(rules.replace(/@media\(hover:hover\)\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '')), 'no hover rule outside it');
});

// Plan 11.19 (F5): GET /api/search's artifacts and requests (11.11) become the Artifacts and Requests groups.
const LANTERN = '6a42f031-fa3f-4d5e-b22a-7df6002b9988';
const FOUND = {messages: [{id: 'h1', cat: 'owner mayor', at: '2026-11-08T11:00:00Z', text: 'Lantern colours?'}], notes: [], wiki: [],
  artifacts: [{id: LANTERN, title: 'Harbour lantern festival plan', cat: 'scholar', at: '2026-11-08T10:00:00Z', excerpt: '# Lanterns\nRed and gold along the quay.'},
    {id: '00000000-0000-4000-8000-000000000009', title: '', cat: 'old', at: '', excerpt: ''}],
  requests: [{id: 't7', title: 'Draft the lantern walk route', cat: 'critic', at: '2026-11-08T09:00:00Z', result: 'Start at the harbour lantern stall.'},
    {id: 't8', title: 'Lantern budget', cat: 'old', at: '2026-11-08T09:00:00Z', result: 'Retired cat result'}]};

test('plan 11.19: artifact hits open the Archive and keep a retired maker; request hits open their thread, and a retired cat\'s is left out', () => {
  const rows = hitItems(FOUND, TOWN, NOW);
  assert.deepEqual(rows.filter(r => r.group === 'artifacts').map(r => [r.id, r.kind, r.artifact, r.label, r.detail]), [
    [`artifact:${LANTERN}`, 'artifact', LANTERN, 'Harbour lantern festival plan', 'Scholar · 2 h ago · # Lanterns Red and gold along the quay.'],
    ['artifact:00000000-0000-4000-8000-000000000009', 'artifact', '00000000-0000-4000-8000-000000000009', 'Untitled', 'Old Tom'],
  ]);
  assert.deepEqual(rows.filter(r => r.group === 'requests').map(r => [r.id, r.kind, r.cat, r.task, r.label, r.detail]), [
    ['request:t7', 'thread', 'critic', 't7', 'Draft the lantern walk route', 'Critic · 3 h ago · Start at the harbour lantern stall.'],
  ], 'the request\'s own words, then who took it, when, and its result');
  assert.ok(rows.every(r => r.icon), 'every row has an icon');
  assert.deepEqual(hitItems({messages: []}, TOWN, NOW), [], 'a viewer\'s answer has no artifacts or requests');
});

test('proof (plan 11.19): a word from an artifact\'s title finds it from the phone\'s Search and opens the Archive on it; a request opens its thread', async () => {
  const p = page({coarse: true, fetchImpl: async url => ({ok: true, status: 200, json: async () => (url.includes('lantern') ? FOUND : {messages: [], notes: [], wiki: [], artifacts: [], requests: []})})});
  const {more, search} = moreList(p);
  const asked = [];
  p.win.addEventListener('open-artifact', e => asked.push(e.detail));
  more.focus();
  search.click();
  assert.ok(p.palette.isOpen());
  type(p.doc, 'lantern');
  await settle();
  assert.deepEqual(groupTitles(p), ['Artifacts', 'Requests', 'Messages'], 'found results come before the messages that mention them');
  assert.equal(rows(p).find(r => r.getAttribute('data-id') === `artifact:${LANTERN}`).querySelector('mark').textContent, 'lantern', 'the typed word is marked in the title');
  while (activeId(p) !== `artifact:${LANTERN}`) press(p.doc, 'ArrowDown');
  press(p.doc, 'Enter');
  assert.equal(p.palette.isOpen(), false);
  assert.deepEqual(p.opened, ['archive'], 'the Archive opens');
  assert.deepEqual(asked, [{id: LANTERN}], 'on that artifact');
  // A request found by its result opens its thread in the chat of the cat that took it.
  search.click();
  type(p.doc, 'lantern');
  await settle();
  while (activeId(p) !== 'request:t7') press(p.doc, 'ArrowDown');
  press(p.doc, 'Enter');
  assert.deepEqual(p.selected, ['critic']);
  assert.deepEqual(p.threads, [{kind: 'request', id: 't7'}]);
});

test('plan 11.19: Ctrl+K finds artifacts on a desk too, and an openArtifact the page passes is used instead of the event', async () => {
  const opened = [];
  const p = page({fetchImpl: async () => ({ok: true, status: 200, json: async () => FOUND}), openArtifact: id => opened.push(id)});
  const asked = [];
  p.win.addEventListener('open-artifact', e => asked.push(e.detail));
  press(p.doc, 'k', {ctrlKey: true});
  type(p.doc, 'festival');
  await settle();
  assert.equal(groupTitles(p)[0], 'Artifacts', 'with nothing else matching, the artifact is the first row');
  assert.equal(activeId(p), `artifact:${LANTERN}`, 'so Enter opens it');
  press(p.doc, 'Enter');
  assert.deepEqual(opened, [LANTERN]);
  assert.deepEqual(asked, []);
  assert.deepEqual(p.opened, []);
});

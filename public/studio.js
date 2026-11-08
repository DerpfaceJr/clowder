// The Studio: the character-creation overlay for a cat's look, costume and house. The 3D town stays on screen as the preview
// (no second renderer): desktop docks the Studio on the right, phones raise it as a sheet. Drafts survive polling; only the
// saved values come from the server, and a clean draft follows them. DOM is built with createElement/textContent only.
import {resolveAppearance,appearanceBody,wearPart} from './editor.js';
import {randomLook,randomHouseLook,pick} from './looks.js';
import {seeded} from './hamlet-layout.js';
import {confirmDialog} from './dialogs.js';

export const STUDIO_SHEET_QUERY = '(max-width:1100px)';
export const TABS = ['cat', 'costume', 'house'];
const TAB_NAME = {cat: 'Cat', costume: 'Costume', house: 'House'};
const CAT_KEYS = ['base', 'marking', 'expression', 'fur', 'patch', 'cream', 'eyes'];
const COSTUME_KEYS = ['parts', 'outfit', 'trim'];
const enc = encodeURIComponent;
const title = id => id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const make = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };

/** The next cat in the town's order, wrapping. An unknown cat starts at the first. */
export function nextCatId(ids, current, step) { const i = ids.indexOf(current); if (i < 0 || !ids.length) return ids[0] ?? null; return ids[(i + step + ids.length) % ids.length]; }

/** The Costume tab's rows: each socket the kit has, with every catalog part that fits it (read from the catalog, never listed here). */
export function socketRows(kit) {
  return (kit?.sockets ?? []).map(socket => ({socket, label: title(socket), parts: Object.keys(kit.parts).filter(p => kit.parts[p].socket === socket).map(p => ({id: p, label: kit.parts[p].label}))})).filter(r => r.parts.length);
}

/** The decor the town offers, or null while the list is absent (the Decor section is then hidden). */
export const decorList = world => Array.isArray(world?.houseDecor) && world.houseDecor.length ? world.houseDecor : null;

/** The house a cat has now: saved values under the draft. A draft null means the style's default (undefined on the wire). */
/** What a house without a saved decor list shows (world-art.js makeHouse's classic trim), so the toggles start where the house is. */
export const CLASSIC_DECOR = ['lantern', 'ivy', 'flower_boxes', 'chimney'];
export function houseNow(cat, draft = {}) {
  // Saved = the recruit's seeded house look under the owner's home look (cat.home.look), as town.js draws it.
  const saved = {...cat?.look?.house, ...cat?.home?.look}, val = k => k in draft ? (draft[k] ?? undefined) : saved[k];
  return {style: draft.style ?? cat?.home?.style, roof: val('roof'), wall: val('wall'), trim: val('trim'), door: val('door'), decor: draft.decor ?? saved.decor ?? CLASSIC_DECOR};
}

/** The body for POST homes/:id/look: the parts the house has, and decor always a list. */
export const houseBody = look => ({...Object.fromEntries(['roof', 'wall', 'trim', 'door'].filter(k => look[k]).map(k => [k, look[k]])), decor: look.decor ?? []});

/** Which tabs hold edits the server has not seen: the cat's body and colours, its costume, its house (style or look). */
export function dirtyTabs(cat, world, draft = {}, house = {}) {
  const design = world.designs?.[cat.home?.style] || {}, a = resolveAppearance(draft, world.chromas, design, cat.look, world.kit), b = resolveAppearance(cat.appearance, world.chromas, design, cat.look, world.kit);
  const diff = keys => keys.some(k => !same(a[k], b[k]));
  return {cat: diff(CAT_KEYS) || (draft.chroma ?? '') !== (cat.appearance?.chroma ?? ''), costume: diff(COSTUME_KEYS), house: !same(houseNow(cat, house), houseNow(cat, {}))};
}

/** Draft values for one Surprise me press, palette-based so each roll is coherent. which: cat | costume | house | all. */
export function surpriseValues(rnd, world, style, which) {
  const {kit, designs} = world, s = which === 'all' ? pick(rnd, Object.keys(designs)) : style;
  const look = randomLook(rnd, kit, designs, s), house = randomHouseLook(rnd, kit, designs, s, decorList(world) ?? []), expression = pick(rnd, kit.expressions);
  const cat = {base: look.base, marking: look.marking, expression, fur: look.fur, patch: look.patch, cream: look.cream, eyes: look.eyes};
  const costume = {parts: look.parts, outfit: look.outfit, trim: look.trim};
  return {cat: {cat}, costume: {costume}, house: {house}}[which] ?? {cat, costume, house, style: s};
}

/** A fresh random source per press: Math.random seeds the PRNG, so no two presses in a row share a seed. */
export const rollSeed = () => seeded(String(Math.random()));

const chip = (label, attrs, className = 'studio-chip') => { const b = make('button', label, className); b.type = 'button'; b.setAttribute('aria-pressed', 'false'); for (const [k, v] of Object.entries(attrs)) b.dataset[k] = v; return b; };
const section = (label, nodes, className = 'studio-chips') => { const s = make('div', undefined, 'studio-section'), list = make('div', undefined, className); list.append(...nodes); s.append(make('h3', label), list); return s; };
const surprise = which => { const b = make('button', '⚄ Surprise me', 'studio-surprise'); b.type = 'button'; b.dataset.surprise = which; return b; };
/** A row of palette swatches. opts: {field} writes the cat's draft; {house} writes the house draft (with a default chip). */
function swatches(label, opts, palette) {
  const s = make('div', undefined, 'studio-section'), list = make('div', undefined, 'studio-swatches');
  if (opts.house !== undefined) list.append(chip('Style default', {house: opts.house, value: ''}));
  list.append(...[...new Set(palette)].map(hex => { const b = chip('', opts.field ? {field: opts.field, value: hex} : {house: opts.house, value: hex}, 'studio-swatch'); b.style.background = hex; b.setAttribute('aria-label', `${label} ${hex}`); b.title = hex; return b; }));
  s.append(make('h3', label), list);
  if (opts.field) { const c = make('label', undefined, 'studio-custom'), input = make('input'); input.type = 'color'; input.dataset.colour = opts.field; input.setAttribute('aria-label', `${label}, custom colour`); c.append(make('span', 'Custom'), input); s.append(c); }
  return s;
}

/**
 * Builds the Studio once, on the page. scene() returns the 3D town (or null). api(path, body) and refresh() are app.js's;
 * onOpen() runs as the Studio opens (app.js closes edit mode and the Settings flyout there).
 */
export function createStudio({scene = () => null, api, refresh, onOpen = () => {}}) {
  let id = null, tab = 'cat', state = null, world = null, cat = null, draft = {}, house = {}, busy = false, open = false, opener = null, builtKey = '', previewKey = '';
  const root = make('aside', undefined, 'studio');
  root.id = 'studio'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'studio-title');
  const grip = make('div', undefined, 'sheet-grip'); grip.setAttribute('aria-hidden', 'true'); grip.append(make('span'));
  const kicker = make('p', 'Studio', 'studio-kicker'), back = make('button', '×', 'studio-close close-x'); back.type = 'button'; back.setAttribute('aria-label', 'Return to town');
  const prev = make('button', '‹', 'studio-step'), next = make('button', '›', 'studio-step'), heading = make('h2', undefined, 'studio-name');
  prev.type = next.type = 'button'; prev.setAttribute('aria-label', 'Previous cat'); next.setAttribute('aria-label', 'Next cat'); heading.id = 'studio-title'; heading.tabIndex = -1;
  const top = make('div', undefined, 'studio-top'), topRow = make('div', undefined, 'studio-top-row'), catRow = make('div', undefined, 'studio-cat');
  topRow.append(kicker, back); catRow.append(prev, heading, next); top.append(topRow, catRow);
  const tabs = make('div', undefined, 'studio-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Studio sections');
  const tabBtn = {}, panels = {}, bodyEl = make('div', undefined, 'studio-body');
  for (const t of TABS) {
    const b = make('button', undefined, 'studio-tab'), name = make('span', TAB_NAME[t]), dot = make('span', undefined, 'studio-unsaved'), sr = make('span', ', unsaved changes', 'sr-only');
    b.type = 'button'; b.id = `studio-tab-${t}`; b.dataset.tab = t; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', `studio-panel-${t}`);
    dot.setAttribute('aria-hidden', 'true'); dot.hidden = sr.hidden = true; b.append(name, dot, sr); tabBtn[t] = {b, dot, sr}; tabs.append(b);
    const p = make('section', undefined, 'studio-panel'); p.id = `studio-panel-${t}`; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', b.id); p.hidden = true; panels[t] = p; bodyEl.append(p);
  }
  const status = make('p', undefined, 'studio-status'), random = make('button', 'Randomize all', 'studio-random'), reset = make('button', 'Reset'), save = make('button', 'Save changes', 'primary');
  random.type = reset.type = save.type = 'button';
  const foot = make('div', undefined, 'studio-foot'), actions = make('div', undefined, 'studio-actions');
  status.setAttribute('role', 'status'); actions.append(reset, save); foot.append(status, random, actions);
  root.append(grip, top, tabs, bodyEl, foot);
  document.body.append(root);

  const design = () => world?.designs?.[cat?.home?.style] || {};
  const dirtyAny = () => !!cat && world && Object.values(dirtyTabs(cat, world, draft, house)).some(Boolean);
  const setStatus = text => { status.textContent = text; };

  // ---- the tab bodies: built once per kit, then only their values are painted ----
  function buildCat(w) {
    const k = w.kit, bases = section('Body', k.bases.map(b => chip(title(b), {field: 'base', value: b}, 'studio-card')), 'studio-cards');
    const marks = section('Coat pattern', k.markings.map(m => chip(title(m), {field: 'marking', value: m})));
    const scheme = section('Colour scheme', [chip('None', {field: 'chroma', value: ''}), ...w.chromas.map(c => chip(c.label, {field: 'chroma', value: c.id}))]);
    const colours = [['Fur', 'fur', k.palettes.fur], ['Markings colour', 'patch', k.palettes.patch], ['Cream', 'cream', k.palettes.cream], ['Eyes', 'eyes', k.palettes.eyes]].map(([l, f, p]) => swatches(l, {field: f}, p));
    const expr = section('Expression', k.expressions.map(e => chip(title(e), {field: 'expression', value: e})));
    return [surprise('cat'), bases, marks, scheme, ...colours, expr];
  }
  function buildCostume(w) {
    const rows = socketRows(w.kit).map(r => section(r.label, [chip('None', {part: r.socket, value: ''}), ...r.parts.map(p => chip(p.label, {part: r.socket, value: p.id}))]));
    return [surprise('costume'), ...rows, swatches('Outfit', {field: 'outfit'}, w.kit.palettes.outfit), swatches('Trim', {field: 'trim'}, w.kit.palettes.trim)];
  }
  function buildHouse(w) {
    const styles = Object.entries(w.designs).map(([sid, d]) => { const b = chip('', {style: sid}, 'studio-card'), roof = make('i', undefined, 'studio-dot'), outfit = make('i', undefined, 'studio-dot'); roof.style.background = d.roof; outfit.style.background = d.outfit; b.append(make('span', d.icon || '⌂', 'studio-card-icon'), make('span', d.label, 'studio-card-name'), roof, outfit); return b; });
    const decor = decorList(w), decorRow = decor ? [section('Decor', decor.map(d => chip(d.label, {decor: d.id})))] : [];
    return [surprise('house'), section('Style', styles, 'studio-cards'), swatches('Roof', {house: 'roof'}, w.kit.palettes.outfit), swatches('Walls', {house: 'wall'}, w.kit.palettes.wall), swatches('Timber trim', {house: 'trim'}, w.kit.palettes.timber), swatches('Door', {house: 'door'}, w.kit.palettes.outfit), ...decorRow];
  }
  function rebuild() { if (!world?.kit) return; const build = {cat: buildCat, costume: buildCostume, house: buildHouse}; for (const t of TABS) panels[t].replaceChildren(...build[t](world)); }
  function rebuildIfNeeded() { const key = JSON.stringify([world?.kit, world?.designs, world?.houseDecor ?? null, world?.chromas]); if (key !== builtKey) { builtKey = key; rebuild(); } }

  // ---- values ----
  const pressedNow = (d, r, h) => {
    if (d.field !== undefined) return d.field === 'chroma' ? (draft.chroma ?? '') === d.value : String(r[d.field] ?? '').toLowerCase() === d.value.toLowerCase();
    if (d.part !== undefined) return (r.parts.find(p => world.kit.parts[p]?.socket === d.part) ?? '') === d.value;
    if (d.house !== undefined) return String(h[d.house] ?? '').toLowerCase() === d.value.toLowerCase();
    if (d.decor !== undefined) return h.decor.includes(d.decor);
    if (d.style !== undefined) return h.style === d.style;
    return false;
  };
  function paint() {
    if (!open || !cat || !world) return;
    const d = dirtyTabs(cat, world, draft, house), r = resolveAppearance(draft, world.chromas, design(), cat.look, world.kit), h = houseNow(cat, house), any = d.cat || d.costume || d.house;
    heading.textContent = cat.name;
    for (const t of TABS) {
      const dirty = {cat: d.cat, costume: d.costume, house: d.house}[t];
      tabBtn[t].b.setAttribute('aria-selected', String(t === tab)); tabBtn[t].b.tabIndex = t === tab ? 0 : -1; panels[t].hidden = t !== tab;
      tabBtn[t].dot.hidden = tabBtn[t].sr.hidden = !dirty;
    }
    for (const b of root.querySelectorAll('[data-field],[data-part],[data-house],[data-decor],[data-style]')) b.setAttribute('aria-pressed', String(pressedNow(b.dataset, r, h)));
    for (const input of root.querySelectorAll('[data-colour]')) input.value = r[input.dataset.colour] || '#000000';
    save.disabled = reset.disabled = busy || !any; random.disabled = busy;
    // Previews only when something changed: the town redraws a look, so a poll must not repeat the same one.
    const preview = {cat: d.cat || d.costume ? r : null, house: d.house ? h : null}, key = JSON.stringify([cat.id, preview]);
    if (key !== previewKey) { previewKey = key; scene()?.previewAppearance(cat.id, preview.cat); scene()?.previewHouse?.(cat.id, preview.house); }
  }

  // ---- edits ----
  root.addEventListener('click', e => {
    const b = e.target.closest?.('button'), d = b?.dataset;
    if (!d || !root.contains(b)) return;
    if (d.surprise !== undefined) return surpriseNow(d.surprise);
    // A colour scheme replaces fur, cloth and eyes (as the old customizer did); None only drops the scheme.
    if (d.field !== undefined) { if (d.field === 'chroma') { const {fur, outfit, eyes, chroma, ...rest} = draft; draft = d.value ? {...rest, chroma: d.value} : Object.fromEntries(Object.entries(draft).filter(([k]) => k !== 'chroma')); } else draft = {...draft, [d.field]: d.value}; }
    else if (d.part !== undefined) { const r = resolveAppearance(draft, world.chromas, design(), cat.look, world.kit).parts, s = d.part; draft = {...draft, parts: d.value ? wearPart(r, d.value, world.kit) : r.filter(p => world.kit.parts[p]?.socket !== s)}; }
    else if (d.house !== undefined) house = {...house, [d.house]: d.value || null};
    else if (d.decor !== undefined) { const now = houseNow(cat, house).decor; house = {...house, decor: now.includes(d.decor) ? now.filter(x => x !== d.decor) : [...now, d.decor]}; }
    else if (d.style !== undefined) house = {...house, style: d.style};
    else return;
    setStatus(''); paint();
  });
  root.addEventListener('input', e => { const f = e.target.dataset?.colour; if (!f) return; draft = {...draft, [f]: e.target.value}; setStatus(''); paint(); });
  tabs.addEventListener('click', e => { const b = e.target.closest?.('[data-tab]'); if (b) { tab = b.dataset.tab; paint(); } });
  tabs.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); const to = TABS[(TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 2)) % TABS.length]; tab = to; paint(); tabBtn[to].b.focus(); });
  prev.onclick = () => step(-1); next.onclick = () => step(1);
  back.onclick = () => requestClose();
  reset.onclick = () => { draft = {...(cat.appearance || {})}; house = {}; setStatus(''); paint(); };
  random.onclick = () => surpriseNow('all');
  save.onclick = () => saveAll();

  function surpriseNow(which) {
    const v = surpriseValues(rollSeed(), world, houseNow(cat, house).style, which);
    draft = {...draft, ...v.cat, ...v.costume};
    house = {...house, ...v.house, ...(v.style ? {style: v.style} : {})};
    setStatus(''); paint();
  }
  async function saveAll() {
    const d = dirtyTabs(cat, world, draft, house);
    busy = true; setStatus('Saving…'); paint();
    try {
      if (d.cat || d.costume) await api(`cats/${enc(cat.id)}/appearance`, appearanceBody(draft, world.chromas, design(), cat.look, world.kit));
      if (d.house) {
        const now = houseNow(cat, house), was = houseNow(cat, {});
        if (now.style !== was.style) await api('homes', {cat: cat.id, style: now.style});
        if (!same(houseBody(now), houseBody(was))) await api(`homes/${enc(cat.id)}/look`, houseBody(now));
      }
      setStatus('Saved.');
      await refresh();
    } catch (error) { setStatus(error.message || 'Could not save.'); }
    finally { busy = false; paint(); }
  }

  // ---- open, switch and close ----
  const discard = (title, message, confirmLabel) => confirmDialog({title, message, confirmLabel, cancelLabel: 'Keep editing', danger: true});
  function enter(catId) {
    id = catId; cat = state.cats.find(c => c.id === catId); draft = {...(cat.appearance || {})}; house = {}; previewKey = '';
    rebuildIfNeeded(); frame();
  }
  // The camera sits the cat in the part of the screen the Studio leaves free: the right side on desktop, the top on a sheet.
  function frame() {
    const s = scene(); if (!s?.frameCat) return;
    const r = root.getBoundingClientRect(), compact = matchMedia(STUDIO_SHEET_QUERY).matches;
    s.frameCat(id, compact ? {side: 'above', inset: innerHeight - r.top} : {side: 'left', inset: innerWidth - r.left});
  }
  async function openStudio(catId, which = 'cat') {
    if (!state || state.readOnly || !state.cats.some(c => c.id === catId)) return;
    if (open) {
      if (catId !== id) { if (dirtyAny() && !await discard('Switch cat?', 'Your changes to this cat are not saved. Leave them out?', 'Discard changes')) return; scene()?.previewAppearance(id, null); scene()?.previewHouse?.(id, null); enter(catId); }
      tab = which; paint(); return;
    }
    opener = document.activeElement; open = true; root.hidden = false; document.body.classList.add('studio-open');
    onOpen(); tab = which; enter(catId); paint();
    tabBtn[tab].b.focus();
  }
  function close() {
    if (!open) return;
    open = false; root.hidden = true; document.body.classList.remove('studio-open');
    scene()?.previewAppearance(id, null); scene()?.previewHouse?.(id, null); scene()?.restoreCamera?.();
    id = null; cat = null; draft = {}; house = {}; previewKey = ''; setStatus('');
    if (opener?.isConnected) opener.focus(); opener = null;
  }
  async function requestClose() {
    if (!open) return;
    if (dirtyAny() && !await discard('Leave the Studio?', 'Your changes are not saved. Leave them out?', 'Discard changes')) return;
    close();
  }
  async function step(dir) {
    if (!state) return;
    const to = nextCatId(state.cats.map(c => c.id), id, dir);
    if (to && to !== id) await openStudio(to, tab);
  }

  // Focus stays in the Studio while it is open (confirm dialogs are modal and keep their own focus); Escape closes it.
  document.addEventListener('keydown', e => {
    if (!open || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); requestClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...root.querySelectorAll('button:not([disabled]),input,select,textarea,[tabindex="0"]')].filter(x => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items.at(-1), active = document.activeElement;
    if (!root.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);
  document.addEventListener('focusin', e => { if (open && !root.contains(e.target) && !document.querySelector('dialog[open]')) tabBtn[tab].b.focus(); });
  addEventListener('resize', () => { if (open) frame(); });

  /** Called on every app render. Errors are shown in the status line; a cat that left the town closes the Studio. */
  function update(s) {
    state = s; world = s?.world ?? null;
    if (!s || s.readOnly) { if (open) close(); return; }
    if (!open) return;
    cat = s.cats.find(c => c.id === id) || null;
    if (!cat) { close(); return; }
    rebuildIfNeeded();
    if (!dirtyAny()) { draft = {...(cat.appearance || {})}; house = {}; }
    paint();
  }
  return {open: openStudio, close: requestClose, update, isOpen: () => open, get catId() { return id; }};
}

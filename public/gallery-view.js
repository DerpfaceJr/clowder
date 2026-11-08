// Artifact gallery: the grid of what cats made, a full-screen viewer, and a Web view for pages and https addresses.
// Pure helpers are exported for Node tests and touch no DOM. createGalleryView builds everything with createElement and
// textContent. Model-written text is never put into innerHTML. Pages and drawings load only into sandboxed frames.

export const KIND_LABEL = {image: 'Image', video: 'Video', html: 'Web page', svg: 'Drawing', markdown: 'Notes', text: 'Text', json: 'Data'};
export const KIND_SYMBOL = {image: '▣', video: '▶', html: '⌗', svg: '◇', markdown: '¶', text: '≡', json: '{}'};
export const DEVICE_WIDTHS = {phone: 390, tablet: 820, desktop: null};
export const SANDBOX = 'allow-scripts allow-forms allow-popups';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// An artifact id inside quest or chat text. matchAll copies the regex, so its lastIndex is never shared.
const ARTIFACT_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The server path for an artifact. raw is the "Open in new tab" route. Anything that is not an id gets no path. */
export function artifactPath(id, raw = false) {
  return UUID.test(String(id)) ? `/artifacts/${id}${raw ? '/raw' : ''}` : null;
}

export function filterArtifacts(list, {kind = 'all', project = 'all'} = {}) {
  return list.filter(a => (kind === 'all' || a.kind === kind) && (project === 'all' || a.project === project));
}

/** Projects that have at least one artifact, with the titles the Projects panel shows. Unknown projects read as "Project". */
export function projectOptions(list, titles = new Map()) {
  const seen = new Map();
  for (const a of list) if (a.project && !seen.has(a.project)) seen.set(a.project, titles.get(a.project) || 'Project');
  return [...seen].map(([id, title]) => ({id, title}));
}

/** The chips under one project card: its artifacts, newest first, capped so a busy project stays small. */
export function chipsFor(list, projectId, max = 6) {
  return list.filter(a => a.project === projectId).slice(0, max);
}

/** The Artist cat, found by id or by a role that says artist. Nothing about the role is defined here. */
export function artistIdOf(cats = []) {
  return (cats.find(c => c.id === 'artist') ?? cats.find(c => /\bartist\b/i.test(c.role || '')))?.id ?? null;
}

// The cats who keep the town's memory (setupCrew in town.config.json, which the client is not sent) show the Gallery too.
export const KEEPERS = ['scholar', 'archivist'];

/** The Gallery tab shows for the Artist and for the scholar and archivist when they live in the town. */
export function galleryAvailable(cats = [], selected) {
  const artist = artistIdOf(cats);
  // With no Artist yet only the keepers show it (project chips and artifact links still open the viewer).
  return (!!artist && selected === artist) || (KEEPERS.includes(selected) && cats.some(c => c.id === selected));
}

/**
 * Text split around artifact ids: [{text}, {id}, …], ids lowercased. With max the text is clipped like clip() in
 * projects-panel.js, counting an id as its 8-character short form; an id is kept whole or left out, never cut in half.
 */
export function artifactParts(text, max = Infinity) {
  let s = String(text ?? '');
  if (Number.isFinite(max)) s = s.replace(/\s+/g, ' ').trim();
  const parts = [];
  let at = 0;
  for (const m of s.matchAll(ARTIFACT_ID)) {
    if (m.index > at) parts.push({text: s.slice(at, m.index)});
    parts.push({id: m[0].toLowerCase()});
    at = m.index + m[0].length;
  }
  if (at < s.length) parts.push({text: s.slice(at)});
  const shown = p => (p.id ? 8 : p.text.length);
  if (parts.reduce((n, p) => n + shown(p), 0) <= max) return parts;
  const out = [];
  let room = max - 1;
  for (const p of parts) {
    if (shown(p) <= room) { out.push(p); room -= shown(p); continue; }
    if (p.text && room > 0) out.push({text: p.text.slice(0, room).trimEnd()});
    break;
  }
  out.push({text: '…'});
  return out;
}

/** A Web view address: a full https URL with no login. Anything else is refused with a reason the owner can read. */
export function webUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error('Type a full https address, such as https://example.com.'); }
  if (url.protocol !== 'https:') throw new Error('Only https addresses can be previewed.');
  if (url.username || url.password) throw new Error('Addresses with a login cannot be previewed.');
  return url.href;
}

export const zoomLevel = z => Math.min(6, Math.max(0.25, Number.isFinite(z) ? z : 1));

export function stamp(iso) {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString([], {month: 'short', day: 'numeric'}) : '';
}

export function sizeLabel(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Everything a card shows, as plain data, so the card can be checked without a browser. */
export function cardModel(a, projectTitle = '') {
  return {
    id: a.id, title: a.title || 'Untitled', kind: a.kind,
    label: KIND_LABEL[a.kind] ?? a.kind, symbol: KIND_SYMBOL[a.kind] ?? '•',
    cat: a.cat || '', project: projectTitle, when: stamp(a.createdAt), size: sizeLabel(a.size),
    // Pages and drawings get a live preview; images and video get their own media; text kinds get the icon.
    preview: a.kind === 'html' || a.kind === 'svg' ? 'frame' : a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : 'icon',
  };
}

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  // Keys with a dash are attributes (data-*, aria-*); the rest are DOM properties.
  for (const [k, v] of Object.entries(props)) { if (k.includes('-')) node.setAttribute(k, String(v)); else node[k] = v; }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

/** artifactParts as nodes: the text, and a link-styled button per id (its short form) that calls onOpen(id). */
export function artifactNodes(text, onOpen, max) {
  return artifactParts(text, max).map(p => (p.id
    ? el('button', {type: 'button', className: 'artifact-link', textContent: p.id.slice(0, 8), title: `Artifact ${p.id}`, 'aria-label': `Open artifact ${p.id}`, onclick: event => { event.stopPropagation(); onOpen(p.id); }})
    : document.createTextNode(p.text)));
}

/**
 * Mounts the gallery into root and the viewer onto host (the page body; the Archive's dialog, so the viewer sits in its
 * top layer). catName turns a maker's id into a name. fetchImpl is injectable for the browser check.
 */
export function createGalleryView(root, {fetchImpl = (...args) => fetch(...args), host = document.body, catName = id => id} = {}) {
  let list = [], titles = new Map(), kind = 'all', project = 'all';
  const status = el('p', {className: 'gallery-note', role: 'status'});
  const kindSelect = el('select', {'aria-label': 'Filter by kind'});
  const projectSelect = el('select', {'aria-label': 'Filter by project'});
  const grid = el('div', {className: 'gallery-grid', role: 'list', 'aria-label': 'Artifacts'});
  const webButton = el('button', {type: 'button', className: 'gallery-web', textContent: 'Web view', onclick: () => openWeb()});
  root.replaceChildren(
    el('div', {className: 'gallery-head'},
      el('div', {className: 'gallery-title'}, el('h3', {textContent: 'Gallery'}), el('p', {className: 'gallery-sub', textContent: 'What the cats have made, kept here for you.'})),
      webButton),
    el('div', {className: 'gallery-filters'},
      kindSelect, projectSelect),
    status, grid);

  const viewer = el('div', {className: 'gallery-viewer', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Artifact viewer'});
  host.append(viewer);

  function fillFilters() {
    const kinds = ['all', ...new Set(list.map(a => a.kind))];
    kindSelect.replaceChildren(...kinds.map(k => new Option(k === 'all' ? 'All kinds' : KIND_LABEL[k] ?? k, k)));
    kindSelect.value = kinds.includes(kind) ? kind : 'all';
    const projects = projectOptions(list, titles);
    projectSelect.replaceChildren(new Option('All projects', 'all'), ...projects.map(p => new Option(p.title, p.id)));
    project = projects.some(p => p.id === project) ? project : 'all';
    projectSelect.value = project;
  }
  kindSelect.onchange = () => { kind = kindSelect.value; render(); };
  projectSelect.onchange = () => { project = projectSelect.value; render(); };

  function render() {
    const shown = filterArtifacts(list, {kind, project});
    grid.replaceChildren(...shown.map(a => card(a, titles.get(a.project) || '')));
    status.textContent = list.length ? (shown.length ? '' : 'Nothing matches these filters.') : 'No artifacts yet. When a cat saves a page, a drawing or a picture, it appears here.';
  }

  function card(a, projectTitle) {
    const m = cardModel(a, projectTitle);
    const path = artifactPath(a.id);
    let preview;
    if (m.preview === 'frame') preview = el('iframe', {className: 'gallery-preview', src: path, title: `Preview of ${m.title}`, sandbox: SANDBOX, referrerPolicy: 'no-referrer', tabIndex: -1, loading: 'lazy'});
    else if (m.preview === 'image') preview = el('img', {className: 'gallery-thumb', src: path, alt: m.title, loading: 'lazy'});
    else if (m.preview === 'video') preview = el('video', {className: 'gallery-thumb', src: path, muted: true, preload: 'metadata'});
    else preview = el('span', {className: 'gallery-symbol', textContent: m.symbol, 'aria-hidden': 'true'});
    // Media cannot sit inside a button, so the card is a div and a transparent button covers it.
    return el('div', {className: 'gallery-card', 'data-kind': m.kind, role: 'listitem'},
      el('span', {className: 'gallery-frame'}, preview),
      el('span', {className: 'gallery-meta'},
        el('strong', {textContent: m.title}),
        el('span', {textContent: [m.label, m.cat && catName(m.cat), m.project, m.when, m.size].filter(Boolean).join(' · ')})),
      el('button', {type: 'button', className: 'gallery-hit', 'aria-label': `Open ${m.title}`, onclick: () => openViewer(a)}));
  }

  // ----- viewer -----
  function close() { viewer.hidden = true; viewer.replaceChildren(); document.body.classList.remove('gallery-open'); }
  function frame(title, bar, body) {
    viewer.replaceChildren(el('div', {className: 'gallery-viewer-head'},
      el('span', {className: 'gallery-viewer-title', textContent: title}),
      el('button', {type: 'button', className: 'gallery-close', textContent: 'Close', onclick: close})), bar, body);
    viewer.hidden = false;
    document.body.classList.add('gallery-open');
    viewer.querySelector('button')?.focus();
  }

  function openViewer(a) {
    const path = artifactPath(a.id);
    if (!path) return;
    if (a.kind === 'image') return imageViewer(a, path);
    if (a.kind === 'html' || a.kind === 'svg') return pageViewer(a, path);
    if (a.kind === 'video') return frame(a.title || 'Video', el('div'), el('div', {className: 'gallery-stage'}, el('video', {src: path, controls: true, preload: 'metadata', className: 'gallery-video'})));
    return textViewer(a, path);
  }

  function imageViewer(a, path) {
    let scale = 1, x = 0, y = 0, drag = null;
    const img = el('img', {src: path, alt: a.title || 'Image', className: 'gallery-image', draggable: false});
    const stage = el('div', {className: 'gallery-stage gallery-zoom'}, img);
    const paint = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
    const zoom = next => { scale = zoomLevel(next); paint(); };
    stage.addEventListener('wheel', e => { e.preventDefault(); zoom(scale * (e.deltaY < 0 ? 1.15 : 0.87)); }, {passive: false});
    stage.addEventListener('pointerdown', e => { drag = {px: e.clientX, py: e.clientY, x, y}; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', e => { if (!drag) return; x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; paint(); });
    stage.addEventListener('pointerup', () => { drag = null; });
    stage.addEventListener('pointercancel', () => { drag = null; });
    const bar = el('div', {className: 'gallery-bar'},
      el('button', {type: 'button', textContent: '−', 'aria-label': 'Zoom out', onclick: () => zoom(scale / 1.25)}),
      el('button', {type: 'button', textContent: '+', 'aria-label': 'Zoom in', onclick: () => zoom(scale * 1.25)}),
      el('button', {type: 'button', textContent: 'Reset', onclick: () => { scale = 1; x = 0; y = 0; paint(); }}),
      el('a', {href: artifactPath(a.id, true), target: '_blank', rel: 'noopener noreferrer', textContent: 'Open in new tab'}));
    frame(a.title || 'Image', bar, stage);
  }

  // A page or drawing in a cozy browser frame. The frame has no allow-same-origin, so the page cannot read the town.
  function pageViewer(a, path) {
    frame(a.title || 'Page', el('div'), browser({src: path, address: a.title || 'Untitled page', editable: false, rawHref: artifactPath(a.id, true)}));
  }

  function openWeb() {
    frame('Web view', el('div'), browser({src: 'about:blank', address: '', editable: true, rawHref: null}));
  }

  // The browser frame: a fake address bar, Reload, Open in new tab (or Open in browser), and device width toggles.
  function browser({src, address, editable, rawHref}) {
    const addressInput = el('input', {type: 'url', value: editable ? '' : address, placeholder: 'https://', readOnly: !editable, 'aria-label': editable ? 'Address to preview' : 'Address', maxLength: 2000, spellcheck: false, autocomplete: 'off'});
    const note = el('p', {className: 'gallery-note', role: 'status'});
    const iframe = el('iframe', {className: 'gallery-browser-frame', src, title: address, sandbox: SANDBOX, referrerPolicy: 'no-referrer'});
    const open = el('a', {className: 'gallery-open-link', target: '_blank', rel: 'noopener noreferrer', textContent: editable ? 'Open in browser' : 'Open in new tab', href: rawHref ?? 'about:blank'});
    const widths = {};
    const setWidth = name => {
      iframe.style.width = DEVICE_WIDTHS[name] ? `${DEVICE_WIDTHS[name]}px` : '100%';
      for (const [key, b] of Object.entries(widths)) b.setAttribute('aria-pressed', String(key === name));
    };
    for (const name of Object.keys(DEVICE_WIDTHS)) widths[name] = el('button', {type: 'button', textContent: name[0].toUpperCase() + name.slice(1), 'aria-pressed': 'false', onclick: () => setWidth(name)});
    const go = () => {
      try {
        const href = webUrl(addressInput.value);
        iframe.src = href;
        open.href = href;
        note.textContent = 'Many sites refuse to be shown in a frame. If this stays blank, use Open in browser.';
      } catch (err) { note.textContent = err.message; }
    };
    const form = el('form', {className: 'gallery-address', onsubmit: e => { e.preventDefault(); if (editable) go(); }},
      addressInput,
      editable ? el('button', {type: 'submit', textContent: 'Go'}) : null,
      el('button', {type: 'button', textContent: 'Reload', onclick: () => { iframe.src = iframe.getAttribute('src') || 'about:blank'; }}));
    const bar = el('div', {className: 'gallery-browser-bar'}, form,
      el('div', {className: 'gallery-widths', role: 'group', 'aria-label': 'Device width'}, ...Object.values(widths)),
      open);
    setWidth('desktop');
    if (!editable) note.textContent = 'Sandboxed: this page cannot reach the town, its cookies or its API.';
    return el('div', {className: 'gallery-browser'}, bar, note, el('div', {className: 'gallery-browser-stage'}, iframe));
  }

  async function textViewer(a, path) {
    const body = el('pre', {className: 'gallery-text', textContent: 'Loading…'});
    frame(a.title || 'Text', el('div', {className: 'gallery-bar'}, el('span', {textContent: KIND_LABEL[a.kind] ?? a.kind}), el('a', {href: artifactPath(a.id, true), target: '_blank', rel: 'noopener noreferrer', textContent: 'Open in new tab'})), el('div', {className: 'gallery-stage'}, body));
    try {
      const response = await fetchImpl(path, {cache: 'no-store'});
      if (!response.ok) throw new Error('This file could not be read.');
      let text = await response.text();
      // Markdown is shown as preformatted text, never rendered as HTML, so nothing it contains can run.
      if (a.kind === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as saved */ } }
      body.textContent = text;
    } catch (err) { body.textContent = err.message; }
  }

  async function load() {
    try {
      const response = await fetchImpl('/api/artifacts', {cache: 'no-store', headers: {Accept: 'application/json'}});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'The gallery could not load.');
      list = body.artifacts ?? [];
      // Project titles are the same ones the Projects panel shows. A failed read leaves the Project label generic.
      titles = new Map((await fetchImpl('/api/projects', {cache: 'no-store'}).then(r => (r.ok ? r.json() : [])).catch(() => [])).map(p => [p.id, p.title]));
      fillFilters();
      render();
    } catch (err) {
      status.textContent = err.message;
    }
  }

  return {
    load,
    close,
    /** Opens one artifact by id. An id the town does not have says so in the status line instead. */
    openArtifact(id) {
      const key = String(id).toLowerCase();
      const a = list.find(x => x.id === key || (key.length === 8 && x.id.startsWith(key)));
      if (a) openViewer(a); else status.textContent = `No artifact ${String(id).slice(0, 8)} in this town. It may belong to another world.`;
      return !!a;
    },
    get count() { return list.length; },
    get viewing() { return !viewer.hidden; },
  };
}

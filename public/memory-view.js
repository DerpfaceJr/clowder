// Town memory view: the Scholar's knowledge library. Full-text search over the town's own records, and an explorable
// graph of them. The layout is a small verlet simulation written here, with no libraries. Steps are capped, and nothing
// moves while the view is off screen.

export const MAX_STEPS = 260;
const BOUND = 2000, REST = 64, REPEL = 2600, SPRING = 0.05, GRAVITY = 0.01, DAMP = 0.72, MAX_V = 14;
const STYLE = {
  cat: {label: 'Cat', r: 13},
  group: {label: 'Nook', r: 11, color: '#b9a77e'},
  project: {label: 'Project', r: 10, color: '#7c6a9a'},
  task: {label: 'Task', r: 7, color: '#8aa39a'},
  business: {label: 'Business', r: 10, color: '#c9a86a'},
  note: {label: 'Note', r: 9, color: '#5f8fa8'},
  decision: {label: 'Decision', r: 8, color: '#c47f6a'},
  message: {label: 'Message', r: 5, color: '#a7a296'},
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = v => (Number.isFinite(v) ? v : 0);

/** Simulation state from graph nodes and edges. Nodes keep the positions in `previous` (id to {x, y}), so focusing does not scatter the map. */
export function buildSim(nodes, edges, previous = new Map()) {
  const index = new Map(), sim = {nodes: [], links: [], steps: 0};
  nodes.forEach((n, i) => {
    const old = previous.get(n.id), r = 18 * Math.sqrt(i), a = i * 2.39996;
    sim.nodes.push({id: n.id, x: old ? finite(old.x) : Math.cos(a) * r, y: old ? finite(old.y) : Math.sin(a) * r, vx: 0, vy: 0});
    index.set(n.id, i);
  });
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) sim.links.push({a, b, type: e.type, basis: e.basis});
  }
  return sim;
}

/** One force step: pairwise repulsion, spring links, a weak pull to the centre, damped and clamped so positions stay finite. */
export function layoutStep(sim, alpha = 1) {
  const {nodes, links} = sim, n = nodes.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = ((i * 7 + j * 13) % 5 - 2) * 0.5 || 0.5; dy = ((i * 11 + j * 3) % 5 - 2) * 0.5 || 0.5; d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2), f = REPEL * alpha / d2, fx = dx / d * f, fy = dy / d * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const l of links) {
    const a = nodes[l.a], b = nodes[l.b];
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - REST) * SPRING * alpha, fx = dx / d * f, fy = dy / d * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const p of nodes) {
    p.vx = clamp(finite((p.vx - p.x * GRAVITY * alpha) * DAMP), -MAX_V, MAX_V);
    p.vy = clamp(finite((p.vy - p.y * GRAVITY * alpha) * DAMP), -MAX_V, MAX_V);
    p.x = clamp(finite(p.x + p.vx), -BOUND, BOUND);
    p.y = clamp(finite(p.y + p.vy), -BOUND, BOUND);
  }
  return sim;
}

/** One capped step of the cooling schedule. Returns false once the step budget is spent. */
export function stepLayout(sim) {
  if (sim.steps >= MAX_STEPS) return false;
  layoutStep(sim, Math.max(0.05, 1 - sim.steps / MAX_STEPS));
  sim.steps++;
  return true;
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};
const when = at => (at ? new Date(at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : 'Season record');

async function load(url) {
  const response = await fetch(url, {headers: {Accept: 'application/json'}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Town memory is unavailable (${response.status}).`);
  return body;
}

/** Mounts the view into `root`. update(state) is called on every town refresh; the view refetches only when the town's records change. */
export function createMemoryView(root, {onBack = () => {}} = {}) {
  root.replaceChildren();
  const search = el('form', {className: 'memory-search', role: 'search'});
  const query = el('input', {type: 'search', placeholder: 'Search the town’s records', 'aria-label': 'Search the town’s records', maxLength: 200});
  search.append(query, el('button', {type: 'submit', className: 'primary', textContent: 'Search'}));
  const hits = el('ul', {className: 'memory-hits', 'aria-label': 'Search results'});
  const note = el('p', {className: 'memory-note', role: 'status'});
  const canvas = el('canvas', {className: 'memory-canvas', 'aria-label': 'Town memory graph'});
  const empty = el('p', {className: 'memory-empty', textContent: 'The Scholar is still collecting memories.', hidden: true});
  const overview = el('button', {type: 'button', textContent: 'Overview'});
  const widen = el('button', {type: 'button', textContent: 'Two steps out'});
  const tools = el('div', {className: 'memory-tools'}, overview, widen);
  // Shown only on phones while the tab is expanded to a full screen; it returns to the Conversation tab.
  const back = el('button', {type: 'button', className: 'memory-back', textContent: '← Back to chat', onclick: () => onBack()});
  const card = el('div', {className: 'memory-card', hidden: true});
  const legend = el('div', {className: 'memory-legend'},
    ...Object.entries(STYLE).map(([type, s]) => el('span', {className: 'memory-key'}, el('i', {className: 'memory-dot', style: `background:${s.color ?? '#526854'}`}), s.label)),
    el('span', {className: 'memory-key'}, el('i', {className: 'memory-line'}), 'EXTRACTED: read from an event'),
    el('span', {className: 'memory-key'}, el('i', {className: 'memory-line dashed'}), 'INFERRED: derived, reason kept'));
  root.append(
    el('div', {className: 'memory-head'},
      back,
      el('h3', {textContent: 'Town memory · knowledge library'}),
      note,
      el('p', {className: 'memory-note', textContent: 'Search is full-text over the town’s own records.'})),
    search, hits,
    el('div', {className: 'memory-stage'}, canvas, empty, tools, card),
    legend);
  const ctx = canvas.getContext('2d');
  let graph = {nodes: [], edges: []}, sim = null, focus = null, colours = new Map(), icons = new Map(), ownerOf = new Map(), signature = '';
  let scale = 1, ox = 0, oy = 0, width = 0, height = 0, dirty = true, shown = false, raf = 0;
  const pointers = new Map();
  let gesture = null;

  // Cats use their own colour and icon. A business takes its owner's colour through the owns edge in the subgraph.
  const colourOf = n => {
    if (n.type === 'business') return colours.get(ownerOf.get(n.id)) || STYLE.business.color;
    if (n.type !== 'cat') return STYLE[n.type].color;
    return colours.get(n.id) || (n.id === 'owner' ? '#526854' : '#6b6657');
  };
  const toScreen = p => [p.x * scale + ox, p.y * scale + oy];
  const schedule = () => { if (!raf && shown) raf = requestAnimationFrame(frame); };
  function frame() {
    raf = 0;
    const moving = sim ? stepLayout(sim) : false;
    if (moving || dirty) { draw(); dirty = false; }
    if (moving) schedule();
  }
  function resize() {
    const box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, box.width), h = Math.max(1, box.height);
    // A real change of size spreads the graph into the new room: a short re-layout that cools again, not a restart.
    if (sim && (Math.abs(w - width) > 2 || Math.abs(h - height) > 2)) sim.steps = Math.min(sim.steps, MAX_STEPS / 2);
    width = w; height = h;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!gesture) { ox = width / 2; oy = height / 2; }
    dirty = true; schedule();
  }
  function draw() {
    ctx.clearRect(0, 0, width, height);
    if (!sim) return;
    ctx.lineWidth = 1.2;
    for (const l of sim.links) {
      const [ax, ay] = toScreen(sim.nodes[l.a]), [bx, by] = toScreen(sim.nodes[l.b]);
      ctx.setLineDash(l.basis === 'INFERRED' ? [5, 4] : []);
      ctx.strokeStyle = l.basis === 'INFERRED' ? 'rgba(124,106,154,0.6)' : 'rgba(75,71,61,0.35)';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.setLineDash([]);
    graph.nodes.forEach((n, i) => {
      const [x, y] = toScreen(sim.nodes[i]), r = STYLE[n.type].r * clamp(scale, 0.7, 1.6);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = colourOf(n); ctx.fill();
      if (n.id === focus) { ctx.lineWidth = 2.5; ctx.strokeStyle = '#4b473d'; ctx.stroke(); }
      if (n.type === 'cat' && icons.has(n.id)) {
        ctx.fillStyle = '#fffdf8'; ctx.font = `${Math.round(r * 1.1)}px Georgia, "Times New Roman", serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(icons.get(n.id), x, y);
        ctx.textBaseline = 'alphabetic';
      }
      // Labels are sparse at overview zoom so the names do not pile up; zooming in or focusing a node shows more.
      const labelled = n.id === focus || n.type === 'group' || (n.type === 'business' && scale > 1) || (n.type === 'project' && scale > 1.1) || (n.type === 'cat' && scale > 1.4);
      if (labelled) {
        ctx.fillStyle = '#4b473d'; ctx.font = '11px Georgia, "Times New Roman", serif'; ctx.textAlign = 'center';
        ctx.fillText(n.label.length > 22 ? `${n.label.slice(0, 21)}...` : n.label, x, y + r + 12);
      }
    });
  }
  function nodeAt(x, y) {
    if (!sim) return null;
    let best = null, bestD = Infinity;
    graph.nodes.forEach((n, i) => {
      const [sx, sy] = toScreen(sim.nodes[i]), d = Math.hypot(sx - x, sy - y), reach = STYLE[n.type].r + 8;
      if (d < reach && d < bestD) { best = n; bestD = d; }
    });
    return best;
  }
  function zoomAt(x, y, factor) {
    const next = clamp(scale * factor, 0.3, 4), wx = (x - ox) / scale, wy = (y - oy) / scale;
    scale = next; ox = x - wx * next; oy = y - wy * next; dirty = true; schedule();
  }
  function setGraph(next) {
    const previous = new Map(sim ? sim.nodes.map(p => [p.id, p]) : []);
    graph = next;
    ownerOf = new Map(next.edges.filter(e => e.type === 'owns').map(e => [e.to, e.from]));
    sim = buildSim(next.nodes, next.edges, previous);
    // Only the overview of a town with no tasks, messages or decisions yet is "still collecting".
    empty.hidden = focus !== null || next.nodes.some(n => !['cat', 'group'].includes(n.type));
    dirty = true; schedule();
  }
  function showCard(n) {
    card.hidden = !n;
    if (!n) return;
    card.replaceChildren(el('strong', {textContent: n.label}), el('span', {textContent: `${STYLE[n.type].label} · ${when(n.at)}`}));
  }
  // Each load is numbered: a slower answer to an older request never replaces the graph a newer one asked for.
  let request = 0;
  async function overviewGraph() {
    focus = null; showCard(null);
    const mine = ++request, next = await load('/api/memory/graph?limit=160');
    if (mine !== request) return;
    setGraph(next);
    note.textContent = `${graph.nodes.length} records, ${graph.edges.length} links.`;
  }
  async function focusOn(id, depth = 1) {
    focus = id;
    const mine = ++request, next = await load(`/api/memory/graph?focus=${encodeURIComponent(id)}&depth=${depth}&limit=120`);
    if (mine !== request) return;
    setGraph(next);
    showCard(graph.nodes.find(n => n.id === id));
    note.textContent = `${graph.nodes.length} records around this one.`;
  }
  const guard = task => task.catch(error => { note.textContent = error.message; });

  search.addEventListener('submit', event => {
    event.preventDefault();
    const q = query.value.trim();
    if (!q) return;
    guard((async () => {
      const {hits: found} = await load(`/api/memory/search?q=${encodeURIComponent(q)}`);
      hits.replaceChildren(...(found.length ? found : [null]).map(h => h
        ? el('li', {}, el('button', {type: 'button', onclick: () => guard(focusOn(h.id))},
          el('strong', {textContent: h.label}), el('small', {textContent: `${STYLE[h.type].label}: ${h.snippet}`})))
        : el('li', {className: 'muted', textContent: 'Nothing in the town’s records matches that.'})));
    })());
  });
  overview.onclick = () => guard(overviewGraph());
  widen.onclick = () => (focus ? guard(focusOn(focus, 2)) : undefined);

  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {x: event.offsetX, y: event.offsetY});
    gesture = {moved: 0, pinch: null, x: event.offsetX, y: event.offsetY};
  });
  canvas.addEventListener('pointermove', event => {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    const prev = {x: p.x, y: p.y};
    p.x = event.offsetX; p.y = event.offsetY;
    if (pointers.size === 1) {
      ox += p.x - prev.x; oy += p.y - prev.y;
      gesture.moved += Math.hypot(p.x - prev.x, p.y - prev.y);
    } else if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / gesture.pinch);
      gesture.pinch = dist; gesture.moved = 99;
    }
    dirty = true; schedule();
  });
  const release = event => {
    const p = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (event.type === 'pointerup' && p && gesture && gesture.moved < 6 && pointers.size === 0) {
      const hit = nodeAt(p.x, p.y);
      if (hit) guard(focusOn(hit.id));
    }
    if (pointers.size === 0) gesture = null; else if (gesture) gesture.pinch = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 1.1 : 0.9);
  }, {passive: false});
  new ResizeObserver(resize).observe(canvas);
  // Off screen (or the tab is hidden), nothing steps or draws.
  new IntersectionObserver(([entry]) => {
    shown = entry.isIntersecting && !document.hidden;
    if (shown) { dirty = true; resize(); schedule(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }).observe(root);
  // The canvas follows its box while the tab expands or collapses; resize() sets the backing store to the new size.
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (shown) resize(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { shown = !document.hidden && root.getBoundingClientRect().height > 0; if (shown) schedule(); });

  return {
    /** Called on every town refresh. Refetches only when the records change; the Scholar's colours come from the cats. */
    update(state) {
      colours = new Map((state.cats || []).filter(c => c.color).map(c => [c.id, c.color]));
      icons = new Map((state.cats || []).filter(c => c.icon).map(c => [c.id, c.icon]));
      dirty = true; schedule();
      const sig = `${state.cats?.length}:${state.tasks?.length}:${state.messages?.length}:${state.approvals?.length}:${state.councils?.length}`;
      if (sig === signature) return;
      signature = sig;
      guard(focus ? focusOn(focus) : overviewGraph());
    },
    get graph() { return graph; },
    /** Centres the graph on one record (a wiki page's note source, from the Memory panel). */
    focus(id) { guard(focusOn(id)); },
  };
}

// Visiting another world without a page reload. The camera pulls up off the town, the town dissolves into a small
// planet in the Memorial's night sky, the planet drifts away while the new world's planet glides in, and the view
// descends onto it and dissolves into the new town at the town square view.
//   out -> space -> approach -> in -> done
// out:      the town camera rises (OUT ms) while the space overlay fades in over it. activate and the new /api/state
//           are already on their way.
// space:    the town render is paused. The new world is rebuilt in place (scene.resetWorld) once its state is here;
//           space holds until that is done and compiled, and space + approach last at least HOLD ms.
// approach: the old planet drifts off and the new one glides to the centre (APPROACH ms).
// in:       the town renders again from high above the new square (first frames under the still opaque sky), the
//           camera descends home while the sky dissolves (IN ms). Then the chrome returns and the new world's intro plays.
// A failed activate flies back with nothing changed ('return' -> 'aborted'). Any later failure, or no new world after
// TIMEOUT ms of space, reloads the page behind a plain fade ('fallback'). Reduced motion: a plain crossfade each way.
// Pure rules first (tested in test/world-travel.test.mjs); nothing touches document or window until go() runs.
import {worldPalette} from './worlds-view.js';
import {sfx} from './audio.js';

export const TRAVEL = Object.freeze({out: 1000, hold: 1200, approach: 750, in: 1200, timeout: 10000, fade: 350});
export const TRAVEL_REDUCED = Object.freeze({out: 350, hold: 0, approach: 0, in: 350, timeout: 10000, fade: 350});
const ENDS = new Set(['done', 'aborted', 'fallback']);

export function travelStart(now, reduced = false) {
  return {phase: 'out', at: now, spaceAt: null, spaceMs: 0, ready: false, applied: false, timing: reduced ? TRAVEL_REDUCED : TRAVEL};
}
/**
 * Events: {type:'tick', now}, {type:'applied'} (resetWorld has begun: the old world is gone), {type:'ready'},
 * {type:'abort', now} (activate failed, nothing changed), {type:'fail', now}.
 */
export function travelReduce(s, e) {
  if (ENDS.has(s.phase)) return s;
  const T = s.timing, go = (phase, now, extra = {}) => ({...s, ...extra, phase, at: now});
  if (e.type === 'ready') return {...s, ready: true};
  if (e.type === 'applied') return {...s, applied: true};
  if (e.type === 'abort') return (s.phase === 'out' || s.phase === 'space') && !s.applied ? go('return', e.now) : s.phase === 'return' ? s : go('fallback', e.now);
  if (e.type === 'fail') return s.phase === 'return' ? s : go('fallback', e.now);
  if (e.type !== 'tick') return s;
  const t = e.now - s.at;
  if (s.phase === 'out' && t >= T.out) return go('space', e.now, {spaceAt: e.now});
  if (s.phase === 'space') {
    if (s.ready && t >= T.hold - T.approach) return go('approach', e.now, {spaceMs: t});
    if (!s.ready && t >= T.timeout) return go('fallback', e.now);
  }
  if (s.phase === 'approach' && t >= T.approach) return go('in', e.now);
  if (s.phase === 'in' && t >= T.in) return go('done', e.now);
  if (s.phase === 'return' && t >= T.out) return go('aborted', e.now);
  return s;
}
export const travelEnded = s => ENDS.has(s.phase);

const clamp01 = t => Math.max(0, Math.min(1, t)), smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
const lerp = (a, b, k) => a + (b - a) * k;
/**
 * What the space overlay shows at `now`. alpha: overlay opacity. a / b: the old and new planet, centre as a fraction of
 * the view and radius as a fraction of its short side (b null while off screen). cam: star parallax travel. plain: sky
 * only (reduced motion, fallback).
 */
export function spaceView(s, now) {
  const T = s.timing, t = now - s.at, k = T[s.phase] ? clamp01(t / T[s.phase]) : 1;
  if (s.timing === TRAVEL_REDUCED || s.phase === 'fallback') {
    const alpha = s.phase === 'out' ? k : s.phase === 'in' ? 1 - k : s.phase === 'return' ? 1 - clamp01(t / T.out) : s.phase === 'done' || s.phase === 'aborted' ? 0 : 1;
    return {alpha, plain: true, fade: s.phase === 'fallback', a: null, b: null, cam: 0};
  }
  // In space the old planet keeps shrinking and drifting, however long the new world takes.
  const drift = d => ({x: .5 - .16 * smooth(d / 1300) - .012 * d / 1000, y: .5 + .03 * smooth(d / 1300), r: lerp(.42, .17, smooth(d / 1100))});
  const camAt = d => .1 * d / 1000;
  if (s.phase === 'out' || s.phase === 'return') {
    const u = s.phase === 'out' ? k : 1 - clamp01(t / T.out), e = smooth((u - .4) / .6);
    return {alpha: e, plain: false, a: {x: .5, y: .5, r: lerp(3.2, .42, Math.sqrt(e))}, b: null, cam: 0};
  }
  if (s.phase === 'space') return {alpha: 1, plain: false, a: drift(t), b: null, cam: camAt(t)};
  const held = drift(s.spaceMs), camHeld = camAt(s.spaceMs);
  if (s.phase === 'approach') {
    const e = smooth(k);
    return {alpha: 1, plain: false, a: {x: lerp(held.x, -.25, e), y: lerp(held.y, .58, e), r: lerp(held.r, .1, e)}, b: {x: lerp(1.3, .5, e), y: lerp(.42, .5, e), r: lerp(.1, .3, e)}, cam: camHeld + .35 * e};
  }
  if (s.phase === 'in') return {alpha: 1 - smooth((k - .3) / .5), plain: false, a: null, b: {x: .5, y: .5, r: .3 * Math.pow(14, k * k)}, cam: camHeld + .35 + .05 * k};
  return {alpha: 0, plain: false, a: null, b: null, cam: 0};
}

/** The camera pose high over the same square: looking almost straight down, zoomed out as far as the controls allow. */
export function highPose(view, {polar = .2, turn = -.35, zoom = .32} = {}) {
  const {position: p, target: c} = view, x = p.x - c.x, y = p.y - c.y, z = p.z - c.z, r = Math.hypot(x, y, z) || 1, az = Math.atan2(x, z) + turn;
  return {target: {...c}, position: {x: c.x + r * Math.sin(polar) * Math.sin(az), y: c.y + r * Math.cos(polar), z: c.z + r * Math.sin(polar) * Math.cos(az)}, zoom};
}

const STYLE = `
.world-travel{position:fixed;inset:0;z-index:55;width:100vw;height:100dvh;display:block;pointer-events:auto;touch-action:none;opacity:0}
body.world-travelling :is(header,.town-dock,footer,#labels,.world-controls,.world-hint,.world-title,.panel:not(.world)){opacity:0!important;pointer-events:none!important;transition:opacity .45s}
body.world-travelling #canvas-wrap{pointer-events:none}
body.world-arriving :is(header,.town-dock,footer,#labels,.world-controls,.world-hint,.world-title,.panel:not(.world)){transition:opacity .7s}
`;

// Seeded so the same world always gets the same planet.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** One world's planet surface, painted once: the town's own ground under the world's tint, hills, lakes and houses. */
function planetTexture(doc, id, town) {
  const W = 512, H = 256, c = doc.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), p = worldPalette(id), r = rng(p.hash);
  g.fillStyle = town?.terrain || '#93b672'; g.fillRect(0, 0, W, H);
  g.globalAlpha = .4; g.fillStyle = p.ground; g.fillRect(0, 0, W, H);
  const blob = (colour, alpha, n, size) => { g.fillStyle = colour; for (let i = 0; i < n; i++) { const x = r() * W, y = H * (.12 + .76 * r()), w = size * (.5 + r()), h = w * (.4 + .4 * r()); g.globalAlpha = alpha * (.6 + .4 * r()); for (const dx of [-W, 0, W]) { g.beginPath(); g.ellipse(x + dx, y, w, h, r() * Math.PI, 0, Math.PI * 2); g.fill(); } } };
  blob(p.hills, .75, 34, 30); blob(town?.water || '#7fb6c9', .85, 7, 18); blob('#ffffff', .5, 6, 8);
  // The town: a cluster of little houses on the side that faces the camera first.
  for (let i = 0; i < 26; i++) {
    const x = W * .25 + (r() - .5) * 90, y = H * .5 + (r() - .5) * 60;
    g.globalAlpha = 1; g.fillStyle = p.walls; g.fillRect(x, y, 5, 4); g.fillStyle = p.roof; g.beginPath(); g.moveTo(x - 1, y); g.lineTo(x + 2.5, y - 3.5); g.lineTo(x + 6, y); g.fill();
  }
  g.globalAlpha = 1;
  return {canvas: c, palette: p};
}

/** The 2D space layer: no shaders to compile, so its first frame costs what every other frame does. */
function createSpaceOverlay(doc, win) {
  if (!doc.getElementById('world-travel-style')) { const style = doc.createElement('style'); style.id = 'world-travel-style'; style.textContent = STYLE; doc.head.append(style); }
  const canvas = doc.createElement('canvas'); canvas.className = 'world-travel'; canvas.setAttribute('aria-hidden', 'true');
  const g = canvas.getContext('2d');
  let W = 0, H = 0, ratio = 1, sky = null, planets = {a: null, b: null};
  const stars = []; { const r = rng(0x5eed); for (const [n, depth, size] of [[150, .25, 1], [70, .6, 1.5], [26, 1, 2.2]]) for (let i = 0; i < n; i++) stars.push({x: r(), y: r(), depth, size, phase: r() * 6.3, tint: r() < .2}); }
  function resize() {
    ratio = Math.min(2, win.devicePixelRatio || 1); W = Math.round(win.innerWidth * ratio); H = Math.round(win.innerHeight * ratio);
    if (canvas.width === W && canvas.height === H && sky) return;
    canvas.width = W; canvas.height = H;
    // The Memorial's night: deep navy with a cyan haze, painted once per size.
    sky = doc.createElement('canvas'); sky.width = W; sky.height = H; const s = sky.getContext('2d');
    const base = s.createRadialGradient(W * .5, H * .45, 0, W * .5, H * .5, Math.hypot(W, H) * .6); base.addColorStop(0, '#171c4d'); base.addColorStop(.55, '#0b0f2e'); base.addColorStop(1, '#05071a');
    s.fillStyle = base; s.fillRect(0, 0, W, H);
    for (const [x, y, rad, colour] of [[.8, .2, .45, 'rgba(111,220,255,.10)'], [.15, .85, .5, 'rgba(160,120,255,.08)']]) { const n = s.createRadialGradient(W * x, H * y, 0, W * x, H * y, Math.max(W, H) * rad); n.addColorStop(0, colour); n.addColorStop(1, 'rgba(0,0,0,0)'); s.fillStyle = n; s.fillRect(0, 0, W, H); }
  }
  function planet(item, at, spin) {
    if (!item || !at) return;
    const m = Math.min(W, H), x = at.x * W, y = at.y * H, r = at.r * m;
    if (x + r * 1.3 < 0 || x - r * 1.3 > W) return;
    const glow = g.createRadialGradient(x, y, r * .9, x, y, r * 1.3); glow.addColorStop(0, item.palette.sky.replace(')', ' / .55)')); glow.addColorStop(1, 'rgba(111,220,255,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(x, y, r * 1.3, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
    const w = r * 4, u = ((spin % 1) + 1) % 1 * w;
    g.drawImage(item.canvas, x - r - u, y - r, w, r * 2); g.drawImage(item.canvas, x - r - u + w, y - r, w, r * 2);
    const shade = g.createRadialGradient(x - r * .35, y - r * .4, r * .1, x, y, r * 1.05); shade.addColorStop(0, 'rgba(255,255,240,.16)'); shade.addColorStop(.55, 'rgba(10,14,40,0)'); shade.addColorStop(1, 'rgba(5,7,26,.62)');
    g.fillStyle = shade; g.fillRect(x - r, y - r, r * 2, r * 2); g.restore();
  }
  return {
    canvas,
    mount(fromId, toId, town) { resize(); planets = {a: planetTexture(doc, fromId || 'home', town), b: planetTexture(doc, toId, town)}; canvas.style.opacity = '0'; doc.body.append(canvas); },
    draw(view, ms) {
      resize();
      // The fallback's plain fade eases from wherever the flight was (its one frame sets the target).
      canvas.style.transition = view.fade ? 'opacity .35s' : '';
      canvas.style.opacity = String(view.alpha);
      if (view.alpha <= 0) return;
      g.drawImage(sky, 0, 0);
      if (view.plain) return;
      const t = ms / 1000;
      for (const s of stars) {
        const x = ((s.x * W - view.cam * W * s.depth) % W + W) % W, y = s.y * H, a = .45 + .4 * Math.sin(t * (1 + s.depth) + s.phase);
        g.globalAlpha = a; g.fillStyle = s.tint ? '#9fe9ff' : '#e6ecff'; g.fillRect(x, y, s.size * ratio, s.size * ratio);
      }
      g.globalAlpha = 1;
      planet(planets.a, view.a, t * .02); planet(planets.b, view.b, t * .02 - .07);
    },
    remove() { canvas.remove(); planets = {a: null, b: null}; },
  };
}

/**
 * The runtime. stage(): the 3D scene or null (resetWorld, flyTo, cameraView, homeView, setRenderPaused, releaseIntro,
 * palette, worldId). go(world, {activate}) resolves to {phase: 'done' | 'aborted' | 'fallback', error}; aborted and
 * fallback carry the error. A fallback reloads the page. activate:false
 * follows a switch made elsewhere (another device) that has already happened.
 */
export function createWorldTravel({stage = () => null, win = globalThis, doc = globalThis.document, fetchImpl = (...a) => fetch(...a),
  reload = () => location.reload(), reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  now = () => performance.now(), frame = fn => requestAnimationFrame(fn), later = (fn, ms) => setTimeout(fn, ms),
  overlay = () => createSpaceOverlay(doc, win), onLanded = () => {}} = {}) {
  let running = null;
  const log = [];
  const emit = (type, detail) => win.dispatchEvent?.(new CustomEvent(type, {detail}));
  const chrome = mode => { // 'away' during the flight, 'back' while it returns, null when settled
    doc?.body?.classList?.toggle('world-travelling', mode === 'away');
    doc?.body?.classList?.toggle('world-arriving', mode === 'back');
  };
  async function post(path) {
    const response = await fetchImpl(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: '{}'});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'That world could not open.');
    return data;
  }
  async function readState(id) {
    const response = await fetchImpl('/api/state', {cache: 'no-store'});
    if (!response.ok) throw new Error('The new world could not be read.');
    const state = await response.json();
    if (state?.activeWorld?.id !== id) throw new Error('A different world is active.');
    return state;
  }

  function go(world, {activate = true} = {}) {
    const scene = stage();
    if (running || !scene?.resetWorld || !world?.id) return null;
    const layer = overlay(), fromId = scene.worldId;
    const home0 = scene.cameraView?.(), began = now();
    const calm = reduced();
    let s = travelStart(now(), calm), state = null, error = null, done;
    const finished = new Promise(resolve => { done = resolve; });
    running = true;
    log.length = 0; log.push({phase: 'out', at: s.at});
    const dispatch = e => {
      const before = s.phase; s = travelReduce(s, e);
      if (s.phase !== before) { log.push({phase: s.phase, at: s.at}); enter(s.phase); }
    };
    const apply = () => {
      if (!state || s.applied || s.phase !== 'space') return;
      dispatch({type: 'applied'});
      Promise.resolve().then(() => scene.resetWorld(state)).then(() => dispatch({type: 'ready'}), err => { error = err; dispatch({type: 'fail', now: now()}); });
    };
    function enter(phase) {
      // The rise lands now: a paused town steps no flight, and a late watchdog would move the rebuilt town's camera.
      if (phase === 'space') { if (!calm) { scene.flyTo({...highPose(home0), duration: 0}); emit('sfx', {name: 'travel-drone'}); } scene.setRenderPaused?.(true); apply(); }
      else if (phase === 'in') {
        scene.setRenderPaused?.(false);
        if (!calm) { const home = scene.homeView(); scene.flyTo({...highPose(home), duration: 0}); scene.flyTo({...home, duration: s.timing.in * .95}); emit('sfx', {name: 'travel-in'}); later(() => emit('sfx', {name: 'travel-land'}), s.timing.in * .8); }
      } else if (phase === 'return') {
        scene.setRenderPaused?.(false); emit('sfx', {name: 'travel-stop'});
        if (!calm) scene.flyTo({...home0, duration: s.timing.out});
      } else if (phase === 'fallback') {
        emit('sfx', {name: 'travel-stop'});
        later(reload, s.timing.fade);
        done({phase, error});
      } else if (phase === 'done' || phase === 'aborted') {
        layer.remove();
        // The intro starts (and hides the chrome its own way) before the travel's chrome class goes, so nothing flashes.
        if (phase === 'done') scene.releaseIntro?.();
        chrome('back'); later(() => chrome(null), 800);
        emit('world-travel', {on: false});
        running = null;
        if (phase === 'done') onLanded(world);
        done({phase, error});
      }
    }
    // Start: menus and dialogs close, the chrome steps aside, the camera rises.
    for (const dialog of doc.querySelectorAll?.('dialog[open]') || []) dialog.close();
    scene.endIntro?.();
    chrome('away');
    emit('world-travel', {on: true});
    layer.mount(fromId, world.id, scene.palette?.());
    if (!calm) { emit('sfx', {name: 'travel-out'}); scene.flyTo({...highPose(home0), duration: s.timing.out}); }
    (activate ? post(`/api/worlds/${encodeURIComponent(world.id)}/activate`) : Promise.resolve())
      .then(() => readState(world.id), err => { error = err; dispatch({type: 'abort', now: now()}); return null; })
      .then(next => { if (next) { state = next; apply(); } }, err => { error = err; dispatch({type: 'fail', now: now()}); });
    const loop = () => {
      const t = now();
      dispatch({type: 'tick', now: t});
      layer.draw(spaceView(s, t), t - began);
      if (!travelEnded(s)) frame(loop);
    };
    frame(loop);
    return finished;
  }
  return {go, log, get active() { return !!running; }, get available() { return !!stage()?.resetWorld; }, get shown() { return stage()?.worldId ?? null; }};
}

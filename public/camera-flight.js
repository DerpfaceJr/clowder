// Scripted camera moves for the town's OrbitControls camera. No Three.js import: it works on anything with
// position/target .x .y .z and .set(), so it runs in Node tests and any cinematic (the Memorial zoom, an intro) can share it.
// A pose is {position:{x,y,z}, target:{x,y,z}, zoom}.

export const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const xyz = v => ({x: v.x, y: v.y, z: v.z});
const lerp = (a, b, k) => a + (b - a) * k;

/** The camera's offset from its target as radius, polar angle from +y and azimuth (atan2(x, z)). */
function spherical(position, target) {
  const x = position.x - target.x, y = position.y - target.y, z = position.z - target.z, r = Math.hypot(x, y, z) || 1e-6;
  return {r, phi: Math.acos(Math.min(1, Math.max(-1, y / r))), theta: Math.atan2(x, z)};
}

/** The pose k of the way from a to b (k already eased). The target moves in a line; the offset swings round the shorter
 *  way at an interpolated radius, so the distance (and the distance fog) never dips mid-flight. */
export function posePoint(a, b, k) {
  const s = spherical(a.position, a.target), e = spherical(b.position, b.target);
  let turn = e.theta - s.theta;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  const target = {x: lerp(a.target.x, b.target.x, k), y: lerp(a.target.y, b.target.y, k), z: lerp(a.target.z, b.target.z, k)};
  const r = lerp(s.r, e.r, k), phi = lerp(s.phi, e.phi, k), theta = s.theta + turn * k;
  return {
    target,
    position: {x: target.x + r * Math.sin(phi) * Math.sin(theta), y: target.y + r * Math.cos(phi), z: target.z + r * Math.sin(phi) * Math.cos(theta)},
    zoom: lerp(a.zoom, b.zoom, k),
  };
}

/**
 * flyTo({position, target, zoom, duration}) glides the camera there with ease-in-out and resolves when it lands.
 * position and target default to where the camera is now, zoom to its zoom, duration (ms) to 1100; 0 lands at once.
 * A newer flyTo replaces the running one (which resolves where it stopped). Call step() once per rendered frame. If no
 * frames come (hidden tab, paused render) a watchdog lands the flight at duration + 400 ms, so the promise always settles.
 * User input is off while flying.
 */
export function createCameraFlight({camera, controls, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = t => clearTimeout(t)}) {
  let flight = null, enabledBefore = true;
  const view = () => ({position: xyz(camera.position), target: xyz(controls.target), zoom: camera.zoom});
  const apply = pose => {
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    camera.zoom = pose.zoom;
    camera.updateProjectionMatrix?.();
  };
  const land = () => {
    const f = flight;
    if (!f) return;
    flight = null;
    cancel(f.watchdog);
    apply(f.to);
    controls.enabled = enabledBefore;
    f.resolve();
  };
  function step() {
    if (!flight) return false;
    const k = flight.duration > 0 ? Math.min(1, (now() - flight.start) / flight.duration) : 1;
    if (k >= 1) land();
    else apply(posePoint(flight.from, flight.to, easeInOut(k)));
    return true;
  }
  function flyTo({position, target, zoom, duration = 1100} = {}) {
    const from = view();
    if (flight) { const old = flight; flight = null; cancel(old.watchdog); old.resolve(); } else enabledBefore = controls.enabled;
    controls.enabled = false;
    const to = {position: xyz(position || from.position), target: xyz(target || from.target), zoom: Number.isFinite(zoom) ? zoom : from.zoom};
    return new Promise(resolve => {
      const ms = Math.max(0, Number(duration) || 0);
      flight = {from, to, start: now(), duration: ms, resolve, watchdog: null};
      if (ms === 0) { land(); return; }
      const mine = flight;
      mine.watchdog = schedule(() => { if (flight === mine) land(); }, ms + 400);
    });
  }
  return {flyTo, step, view, get flying() { return !!flight; }};
}

/** The ease's speed: the share of the gap closed each second is 1 - exp(-EASE_RATE * dt), about 0.12 a frame at 60 fps (the old fixed step). */
export const EASE_RATE = 7.7;
/**
 * One frame of the town's ease toward goal {position, zoom} (focusTarget in town.js): target and camera move together by 1 - exp(-dt * rate)
 * of what is left, so the same time gives the same pose at 30 fps or 120 fps. Reduced motion lands at once. True once it has arrived.
 */
export function easeStep(camera, controls, goal, dt, {rate = EASE_RATE, reduced = false} = {}) {
  const k = reduced ? 1 : 1 - Math.exp(-Math.max(0, dt) * rate), t = controls.target, p = camera.position, g = goal.position;
  const dx = (g.x - t.x) * k, dy = (g.y - t.y) * k, dz = (g.z - t.z) * k;
  t.set(t.x + dx, t.y + dy, t.z + dz);
  p.set(p.x + dx, p.y + dy, p.z + dz);
  camera.zoom += (goal.zoom - camera.zoom) * k;
  camera.updateProjectionMatrix?.();
  return Math.hypot(g.x - t.x, g.y - t.y, g.z - t.z) < .01 && Math.abs(camera.zoom - goal.zoom) < .01;
}

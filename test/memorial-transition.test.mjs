import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemorialView, createTownPause, MEMORIAL_EVENT} from '../public/memorial-view.js';
import {createMemorialTransition, FLIGHT, REVEAL, FADE, RETURN, QUICK, SETTLE_FRAMES_MS} from '../public/memorial-transition.js';
import {createCameraFlight, posePoint} from '../public/camera-flight.js';

// A fake clock: schedule() queues, advance(ms) runs whatever falls due, in time order.
function clock() {
  let now = 0, id = 0;
  const queue = new Map();
  return {
    schedule(fn, ms) { queue.set(++id, {at: now + ms, fn}); return id; },
    cancel(t) { queue.delete(t); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...queue.entries()].filter(([, q]) => q.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        queue.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    get now() { return now; },
  };
}
const classes = () => { const set = new Set(); return {set, toggle(n, on) { if (on) set.add(n); else set.delete(n); }, contains: n => set.has(n)}; };
function fakeDialog() {
  const listeners = {};
  const fire = (type, event = {preventDefault() { this.defaultPrevented = true; }}) => { for (const fn of listeners[type] || []) fn(event); return event; };
  return {
    open: false, classList: classes(), vars: {}, fire,
    style: {setProperty(k, v) { this.owner.vars[k] = v; }},
    showModal() { this.open = true; },
    close() { if (!this.open) return; this.open = false; fire('close'); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector: () => null,
  };
}
function setup({reduced = false, scene = true, extra = {}} = {}) {
  const c = clock(), win = new EventTarget(), log = [];
  const dialog = fakeDialog();
  dialog.style.owner = dialog;
  const body = {classList: classes()};
  const doc = {activeElement: null, body};
  const pause = createTownPause(win);
  const heard = [];
  win.addEventListener(MEMORIAL_EVENT, e => { heard.push(e.detail); log.push(`announce ${e.detail.open}/${e.detail.pause}`); });
  const view = createMemorialView({dialog, doc, win});
  const show = view.show;
  view.show = () => { log.push('show'); show(); };
  const home = {position: {x: 96, y: 128, z: 140}, target: {x: 0, y: .6, z: 0}, zoom: 1.45};
  const shot = {position: {x: 10, y: 20, z: 30}, target: {x: 1, y: 5, z: 2}, zoom: 3.4};
  const stage = scene ? {
    flights: [], tints: [],
    cameraView: () => home,
    memorialShot: () => shot,
    memorialScreen: () => ({x: 400, y: 220}),
    flyTo(pose) { this.flights.push(pose); log.push(`fly ${pose.duration}`); return Promise.resolve(); },
    tint(name, seconds) { this.tints.push([name, seconds]); },
  } : null;
  const sounds = [];
  const audio = {zoomIn: s => sounds.push(['in', s]), zoomOut: s => sounds.push(['out', s])};
  const zoom = createMemorialTransition({view, stage: () => stage, audio: () => audio, win, doc, reduced: () => reduced, schedule: c.schedule, cancel: c.cancel, ...extra});
  const escape = () => { const e = new Event('keydown', {cancelable: true}); e.key = 'Escape'; win.dispatchEvent(e); return e; };
  return {c, win, dialog, body, pause, heard, view, zoom, stage, sounds, home, shot, log, escape};
}

test('the state machine runs open -> flying -> revealed -> closing -> idle with the camera, tint, chrome and sounds', () => {
  const t = setup();
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.zoom.open(), true);
  assert.equal(t.zoom.state, 'flying');
  assert.deepEqual(t.stage.flights[0], {...t.shot, duration: FLIGHT});
  assert.deepEqual(t.stage.tints[0], ['night', FLIGHT / 1000]);
  assert.deepEqual(t.sounds, [['in', FLIGHT / 1000]]);
  assert.ok(t.body.classList.contains('memorial-zooming'), 'the chrome fades out');
  assert.equal(t.dialog.open, false, 'the sky waits for the camera');
  t.c.advance(FLIGHT);
  assert.equal(t.dialog.open, true);
  assert.ok(t.dialog.classList.contains('zoom-reveal'));
  assert.deepEqual(t.dialog.vars, {'--mx': '400px', '--my': '220px'}, 'the reveal is centred on the telescope');
  assert.equal(t.zoom.state, 'flying');
  t.c.advance(REVEAL);
  assert.equal(t.zoom.state, 'revealed');
  assert.equal(t.dialog.classList.set.size, 0, 'the reveal look is cleared once settled');

  assert.equal(t.zoom.close('button'), true);
  assert.equal(t.zoom.state, 'closing');
  assert.ok(t.dialog.classList.contains('zoom-leave'));
  assert.equal(t.pause.paused, true, 'the town stays paused while the sky fades');
  t.c.advance(FADE);
  assert.equal(t.dialog.open, false);
  assert.equal(t.pause.paused, false, 'the town resumes on the zoomed view');
  assert.deepEqual(t.stage.flights[1], {...t.home, duration: RETURN}, 'the camera eases back to where it was');
  assert.deepEqual(t.stage.tints[1], [null, RETURN / 1000], 'the light returns to the chosen time');
  assert.deepEqual(t.sounds[1], ['out', RETURN / 1000]);
  assert.ok(t.body.classList.contains('memorial-unzooming') && !t.body.classList.contains('memorial-zooming'), 'the chrome fades back');
  t.c.advance(RETURN);
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.body.classList.set.size, 0);
});

test('the town pauses only after the reveal; the music hears the open as the flight starts', () => {
  const t = setup();
  t.zoom.open();
  assert.deepEqual(t.heard, [{open: true, pause: false}], 'the music crossfades with the camera');
  assert.equal(t.pause.paused, false, 'the town keeps rendering during the flight');
  t.c.advance(FLIGHT + REVEAL - 1);
  assert.equal(t.pause.paused, false, 'still rendering while the sky reveals');
  t.c.advance(1);
  assert.equal(t.pause.paused, true);
  assert.deepEqual(t.log, ['announce true/false', 'fly 1100', 'show', 'announce true/true']);
});

test('a double open never stacks, and input during a transition is ignored', () => {
  const t = setup();
  assert.equal(t.zoom.open(), true);
  assert.equal(t.zoom.open(), false);
  t.c.advance(FLIGHT);
  assert.equal(t.zoom.open(), false);
  assert.equal(t.zoom.close('button'), false, 'closing mid-reveal does nothing');
  t.c.advance(REVEAL);
  assert.equal(t.stage.flights.length, 1);
  assert.equal(t.sounds.length, 1);
  t.zoom.close('button');
  assert.equal(t.zoom.close('button'), false);
  assert.equal(t.zoom.open(), false, 'opening while closing does nothing');
  t.c.advance(FADE + RETURN);
  assert.equal(t.stage.flights.length, 2);
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.zoom.open(), true, 'it opens again once idle');
});

test('Escape mid-flight lands in the revealed state at once', () => {
  const t = setup();
  t.zoom.open();
  t.c.advance(400);
  const key = t.escape();
  assert.equal(key.defaultPrevented, true, 'the key press is swallowed so the dialog does not also cancel');
  assert.equal(t.zoom.state, 'revealed');
  assert.equal(t.dialog.open, true);
  assert.equal(t.pause.paused, false, 'the town draws the landed camera under the sky first');
  t.c.advance(SETTLE_FRAMES_MS);
  assert.equal(t.pause.paused, true);
  assert.deepEqual(t.stage.flights.at(-1), {...t.shot, duration: 0});
  assert.deepEqual(t.stage.tints.at(-1), ['night', 0]);
  assert.equal(t.dialog.classList.set.size, 0, 'no reveal animation left running');
  t.c.advance(5000);
  assert.equal(t.zoom.state, 'revealed', 'no stale timer fires later');
});

test('Escape during the reveal (dialog up) and during closing both jump to the end', () => {
  const t = setup();
  t.zoom.open();
  t.c.advance(FLIGHT + 100);
  const cancel = t.dialog.fire('cancel');
  assert.equal(cancel.defaultPrevented, true, 'the platform close is held back');
  assert.equal(t.zoom.state, 'revealed');
  t.dialog.fire('cancel');
  assert.equal(t.zoom.state, 'closing', 'Escape when revealed closes with the animation');
  t.c.advance(FADE + 200);
  t.escape();
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.dialog.open, false);
  assert.equal(t.pause.paused, false);
  assert.deepEqual(t.stage.flights.at(-1), {...t.home, duration: 0});
  assert.deepEqual(t.stage.tints.at(-1), [null, 0]);
  assert.equal(t.body.classList.set.size, 0);
  t.c.advance(5000);
  assert.equal(t.zoom.state, 'idle');
});

test('Escape on an idle or revealed town is not swallowed by the window listener', () => {
  const t = setup();
  assert.equal(t.escape().defaultPrevented, false);
  t.zoom.open();
  t.c.advance(FLIGHT + REVEAL);
  assert.equal(t.escape().defaultPrevented, false, 'the dialog handles it as a normal close');
});

test('reduced motion: no flight, tint, chrome fade or whoosh; a short crossfade each way', () => {
  const t = setup({reduced: true});
  t.zoom.open();
  assert.equal(t.dialog.open, true);
  assert.ok(t.dialog.classList.contains('zoom-fade'));
  assert.equal(t.pause.paused, false);
  t.c.advance(QUICK);
  assert.equal(t.zoom.state, 'revealed');
  assert.equal(t.pause.paused, true);
  t.zoom.close('button');
  t.c.advance(QUICK);
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.dialog.open, false);
  assert.deepEqual([t.stage.flights, t.stage.tints, t.sounds, [...t.body.classList.set]], [[], [], [], []]);
});

test('with no 3D scene yet the Memorial opens directly with a fade', () => {
  const t = setup({scene: false});
  t.zoom.open();
  assert.equal(t.dialog.open, true);
  assert.ok(t.dialog.classList.contains('zoom-fade'));
  t.c.advance(QUICK);
  assert.equal(t.zoom.state, 'revealed');
  t.zoom.close('escape');
  t.c.advance(QUICK);
  assert.equal(t.zoom.state, 'idle');
  assert.deepEqual(t.sounds, []);
});

test('Show observatory closes without flying back, so the town glide to the observatory is not fought', () => {
  const t = setup();
  t.zoom.open();
  t.c.advance(FLIGHT + REVEAL);
  t.win.dispatchEvent(new Event('focus-memorial'));
  assert.equal(t.zoom.state, 'closing');
  t.c.advance(FADE + RETURN);
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.stage.flights.length, 1, 'no fly back');
  assert.deepEqual(t.stage.tints.at(-1), [null, RETURN / 1000], 'the light still returns');
});

test('a dialog closed behind the transition still lands the town idle, so the next open works', () => {
  const t = setup();
  t.zoom.open();
  t.c.advance(FLIGHT + REVEAL);
  t.dialog.close();
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.pause.paused, false);
  assert.deepEqual(t.stage.flights.at(-1), {...t.home, duration: 0});
  assert.equal(t.body.classList.set.size, 0);
  assert.equal(t.zoom.open(), true);
});

test('flyTo eases along the way, lands exactly, superseding resolves the old flight, and a watchdog lands it without frames', async () => {
  let now = 0;
  const timers = [];
  const vec = (x, y, z) => ({x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; }});
  const camera = {position: vec(96, 128, 140), zoom: 1, updateProjectionMatrix() {}};
  const controls = {target: vec(0, 0, 0), enabled: true};
  const f = createCameraFlight({camera, controls, now: () => now, schedule: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, cancel: () => {}});
  const to = {position: {x: 10, y: 40, z: 60}, target: {x: 5, y: 2, z: 5}, zoom: 3};
  const done = f.flyTo({...to, duration: 1000});
  assert.equal(controls.enabled, false, 'input is off while flying');
  now = 100; f.step();
  const early = camera.zoom;
  now = 500; f.step();
  assert.ok(early - 1 < (camera.zoom - 1) / 4, 'ease-in: slow at the start');
  const r = Math.hypot(camera.position.x - controls.target.x, camera.position.y - controls.target.y, camera.position.z - controls.target.z);
  const r0 = Math.hypot(96, 128, 140), r1 = Math.hypot(5, 38, 55);
  assert.ok(r > Math.min(r0, r1) - 1e-6, 'the offset radius never dips below both ends');
  now = 1000; f.step();
  await done;
  assert.deepEqual([camera.position.x, camera.position.y, camera.position.z, controls.target.x, camera.zoom], [10, 40, 60, 5, 3]);
  assert.equal(controls.enabled, true, 'input comes back');
  assert.equal(f.flying, false);

  const first = f.flyTo({position: {x: 0, y: 50, z: 50}, duration: 1000});
  const second = f.flyTo({position: {x: 50, y: 50, z: 0}, duration: 1000});
  await first;
  timers.at(-1).fn(); // no frames came: the watchdog lands it
  await second;
  assert.deepEqual([camera.position.x, camera.position.z], [50, 0]);
  assert.equal(controls.enabled, true);
  const pose = posePoint({position: {x: 0, y: 0, z: 10}, target: {x: 0, y: 0, z: 0}, zoom: 1}, {position: {x: 10, y: 0, z: 0}, target: {x: 0, y: 0, z: 0}, zoom: 1}, .5);
  assert.ok(Math.abs(Math.hypot(pose.position.x, pose.position.z) - 10) < 1e-9, 'a swing keeps its radius');
});

test('the Archive flies to its own shot with no tint, and open(true) is the quick crossfade with no flight', () => {
  const t = setup({extra: {shotOf: scene => scene?.archiveShot?.(), screenOf: scene => scene?.archiveScreen?.(), tone: null}});
  t.stage.archiveShot = () => ({...t.shot, zoom: 5});
  t.stage.archiveScreen = () => ({x: 120, y: 90});
  assert.equal(t.zoom.open(), true);
  assert.deepEqual(t.stage.flights[0], {...t.shot, zoom: 5, duration: FLIGHT}, 'the board, not the observatory');
  t.c.advance(FLIGHT);
  assert.deepEqual(t.dialog.vars, {'--mx': '120px', '--my': '90px'}, 'the reveal opens from the board');
  t.c.advance(REVEAL);
  t.zoom.close('button');
  t.c.advance(FADE + RETURN);
  assert.deepEqual(t.stage.flights[1], {...t.home, duration: RETURN});
  assert.deepEqual(t.stage.tints, [], 'no tint either way');
  assert.equal(t.zoom.open(true), true);
  assert.equal(t.stage.flights.length, 2, 'a quick open does not fly');
  assert.equal(t.dialog.open, true);
  assert.ok(t.dialog.classList.contains('zoom-fade'));
  t.c.advance(QUICK);
  assert.equal(t.zoom.state, 'revealed');
  t.zoom.close('button');
  t.c.advance(QUICK);
  assert.equal(t.zoom.state, 'idle');
  assert.equal(t.stage.flights.length, 2, 'and does not fly back');
});

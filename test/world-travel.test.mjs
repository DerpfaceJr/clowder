import test from 'node:test';
import assert from 'node:assert/strict';
import {TRAVEL, TRAVEL_REDUCED, travelStart, travelReduce, travelEnded, spaceView, highPose, createWorldTravel} from '../public/world-travel.js';
import {destroy, removeResident, clearWorld} from '../public/world-reset.js';
import {SFX_EVENTS, SFX_SET_HOLD_MS, sfxGate, createAudio} from '../public/audio.js';
import {worldPalette, worldThumbnail} from '../public/worlds-view.js';

// Drives the reducer with ticks every 16 ms; extra(t) may return events to fire at that time.
function play(s, until, extra = () => []) {
  const seen = [s.phase];
  for (let t = s.at; t <= until; t += 16) {
    for (const e of [...extra(t), {type: 'tick', now: t}]) s = travelReduce(s, e);
    if (seen.at(-1) !== s.phase) seen.push(s.phase);
  }
  return {s, seen};
}

test('a quick world flies out, holds in space, approaches, lands, in that order', () => {
  const {s, seen} = play(travelStart(0), 6000, t => (t === 400 ? [{type: 'applied'}, {type: 'ready'}] : []));
  assert.deepEqual(seen, ['out', 'space', 'approach', 'in', 'done']);
  assert.ok(travelEnded(s));
});

test('space plus approach last at least the hold time even when the world is ready at once', () => {
  let s = travelStart(0), spaceAt = null, inAt = null;
  for (let t = 0; t < 5000; t += 16) {
    if (t === 0) s = travelReduce(s, {type: 'ready'});
    const before = s.phase; s = travelReduce(s, {type: 'tick', now: t});
    if (s.phase !== before && s.phase === 'space') spaceAt = t;
    if (s.phase !== before && s.phase === 'in') inAt = t;
  }
  assert.ok(inAt - spaceAt >= TRAVEL.hold, `space segment ${inAt - spaceAt} ms`);
  assert.ok(inAt - spaceAt < TRAVEL.hold + 40);
  // The whole flight is about 3.4 s when ready quickly.
  assert.ok(TRAVEL.out + TRAVEL.hold + TRAVEL.in >= 3000 && TRAVEL.out + TRAVEL.hold + TRAVEL.in <= 4000);
});

test('space waits for the new world however long it takes, up to the timeout', () => {
  const ready = 4000;
  const {seen} = play(travelStart(0), 9000, t => (t >= ready && t < ready + 16 ? [{type: 'ready'}] : []));
  assert.deepEqual(seen, ['out', 'space', 'approach', 'in', 'done']);
  let s = travelStart(0);
  ({s} = play(s, 3900));
  assert.equal(s.phase, 'space', 'still holding before the world is ready');
  const late = play(travelStart(0), TRAVEL.out + TRAVEL.timeout + 100);
  assert.deepEqual(late.seen, ['out', 'space', 'fallback']);
});

test('a failed activate flies back with nothing changed; later failures fall back to a reload', () => {
  const back = play(travelStart(0), 4000, t => (t === 160 ? [{type: 'abort', now: t}] : []));
  assert.deepEqual(back.seen, ['out', 'return', 'aborted']);
  const applied = play(travelStart(0), 4000, t => (t === 1200 ? [{type: 'applied'}] : t === 1312 ? [{type: 'abort', now: t}] : []));
  assert.deepEqual(applied.seen, ['out', 'space', 'fallback'], 'once the old world is gone, only a reload is safe');
  const failed = play(travelStart(0), 4000, t => (t === 1200 ? [{type: 'fail', now: t}] : []));
  assert.deepEqual(failed.seen, ['out', 'space', 'fallback']);
  assert.equal(travelReduce(failed.s, {type: 'ready'}), failed.s, 'an ended flight ignores everything');
});

test('reduced motion is a plain crossfade each way', () => {
  const {seen, s} = play(travelStart(0, true), 2000, t => (t === 0 ? [{type: 'ready'}] : []));
  assert.deepEqual(seen, ['out', 'space', 'approach', 'in', 'done']);
  assert.equal(s.timing, TRAVEL_REDUCED);
  const mid = spaceView({...travelStart(0, true)}, TRAVEL_REDUCED.out / 2);
  assert.equal(mid.plain, true);
  assert.ok(mid.alpha > .4 && mid.alpha < .6);
});

test('the overlay covers the town before the render pauses and uncovers it only while landing', () => {
  const s = travelStart(0);
  assert.equal(spaceView(s, 0).alpha, 0, 'the flight starts on the town');
  assert.equal(spaceView(s, TRAVEL.out).alpha, 1, 'fully covered when space (and the pause) begins');
  const space = travelReduce(s, {type: 'tick', now: TRAVEL.out});
  assert.equal(space.phase, 'space');
  assert.equal(spaceView(space, TRAVEL.out + 5000).alpha, 1);
  const landing = {...space, phase: 'in', at: 3000, spaceMs: 500};
  assert.equal(spaceView(landing, 3000).alpha, 1, 'the first landing frames draw the town under the sky');
  assert.equal(spaceView(landing, 3000 + TRAVEL.in).alpha, 0);
  // The old planet keeps drifting smoothly however long space lasts: no jump into the approach.
  const a = spaceView(space, TRAVEL.out + 500).a, approach = spaceView({...space, phase: 'approach', at: TRAVEL.out + 500, spaceMs: 500}, TRAVEL.out + 500).a;
  for (const k of ['x', 'y', 'r']) assert.ok(Math.abs(a[k] - approach[k]) < 1e-9);
});

test('highPose keeps the target and distance and looks almost straight down', () => {
  const view = {position: {x: 96, y: 128, z: 140}, target: {x: 0, y: .6, z: 0}, zoom: 1.45};
  const high = highPose(view), d = p => Math.hypot(p.x - view.target.x, p.y - view.target.y, p.z - view.target.z);
  assert.deepEqual(high.target, view.target);
  assert.ok(Math.abs(d(high.position) - d(view.position)) < 1e-6);
  assert.ok(Math.acos((high.position.y - view.target.y) / d(high.position)) < .21);
  assert.ok(high.zoom >= .3, 'never below the controls\' minimum zoom, which they would clamp');
});

test('the planet takes the same colours as the world card', () => {
  const p = worldPalette('second-town-b4fe44');
  const svg = worldThumbnail('second-town-b4fe44', 3);
  for (const colour of [p.sky, p.hills, p.ground, p.roof, p.walls]) assert.ok(svg.includes(colour), colour);
  assert.notEqual(worldPalette('home').ground, p.ground);
});

// The runtime with a fake scene, fetch, clock and frame loop.
function rig({activate = true, state = true, worldId = 'b', reset = 'now'} = {}) {
  let clock = 0, reloads = 0, finishReset = null;
  const frames = [], timers = [], calls = [], events = [];
  const view = {position: {x: 96, y: 128, z: 140}, target: {x: 0, y: .6, z: 0}, zoom: 1.45};
  const scene = {
    worldId: 'a',
    resetWorld(s) { calls.push(`reset:${s.activeWorld.id}`); if (reset === 'throw') return Promise.reject(new Error('boom')); if (reset === 'later') return new Promise(r => { finishReset = r; }); scene.worldId = s.activeWorld.id; return Promise.resolve([]); },
    flyTo(p) { calls.push(`fly:${Math.round(p.duration)}`); return Promise.resolve(); },
    cameraView: () => view, homeView: () => view, palette: () => null,
    setRenderPaused(on) { calls.push(`paused:${on}`); }, releaseIntro() { calls.push('intro'); }, endIntro() { calls.push('endIntro'); },
  };
  const fetchImpl = async path => {
    calls.push(`fetch:${path}`);
    if (path.includes('/activate')) return activate ? {ok: true, json: async () => ({})} : {ok: false, json: async () => ({error: 'Only the host can do that.'})};
    return state ? {ok: true, json: async () => ({activeWorld: {id: worldId}, world: {}, cats: []})} : {ok: false, json: async () => ({})};
  };
  const travel = createWorldTravel({
    stage: () => scene, fetchImpl, reload: () => { reloads++; }, reduced: () => false, now: () => clock,
    win: {dispatchEvent: e => events.push(`${e.type}:${e.detail?.name ?? e.detail?.on}`)},
    doc: {querySelectorAll: () => [], body: {classList: {toggle() {}}}},
    frame: fn => frames.push(fn), later: (fn, ms) => timers.push({fn, at: clock + ms}),
    overlay: () => ({mount() { calls.push('mount'); }, draw() {}, remove() { calls.push('remove'); }}),
  });
  const settle = () => new Promise(r => setImmediate(r));
  async function run(ms) {
    const end = clock + ms;
    while (clock < end) {
      clock += 16; await settle();
      for (const f of frames.splice(0)) f();
      for (const t of timers.filter(t => t.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    }
    await settle();
  }
  return {travel, scene, calls, events, run, get reloads() { return reloads; }, finish: () => finishReset?.([])};
}

test('a successful flight rebuilds in place: no reload, render paused only in space, intro after landing', async () => {
  const r = rig();
  const done = r.travel.go({id: 'b', name: 'B'});
  assert.equal(r.travel.active, true);
  assert.equal(r.travel.go({id: 'c'}), null, 'one flight at a time');
  await r.run(5000);
  assert.deepEqual(await done, {phase: 'done', error: null});
  assert.equal(r.reloads, 0, 'no reload on the travel path');
  assert.deepEqual(r.calls.filter(c => c.startsWith('fetch')), ['fetch:/api/worlds/b/activate', 'fetch:/api/state']);
  const order = r.calls.filter(c => /^(paused|reset|intro)/.test(c));
  assert.deepEqual(order, ['paused:true', 'reset:b', 'paused:false', 'intro']);
  assert.equal(r.travel.active, false);
  assert.equal(r.travel.shown, 'b');
  assert.deepEqual(r.travel.log.map(l => l.phase), ['out', 'space', 'approach', 'in', 'done']);
  for (const name of ['travel-out', 'travel-drone', 'travel-in', 'travel-land']) assert.ok(r.events.includes(`sfx:${name}`), name);
  assert.deepEqual(r.events.filter(e => e.startsWith('world-travel')), ['world-travel:true', 'world-travel:false']);
});

test('space holds until the rebuild and its compile finish', async () => {
  const r = rig({reset: 'later'});
  const done = r.travel.go({id: 'b'});
  await r.run(3000);
  assert.equal(r.travel.log.at(-1).phase, 'space', 'still in space while the rebuild runs');
  r.finish();
  await r.run(2600);
  assert.equal((await done).phase, 'done');
  assert.equal(r.reloads, 0);
});

test('a refused activate flies back and reports why; nothing is rebuilt or reloaded', async () => {
  const r = rig({activate: false});
  const done = r.travel.go({id: 'b'});
  await r.run(3000);
  const result = await done;
  assert.equal(result.phase, 'aborted');
  assert.match(result.error.message, /host/);
  assert.equal(r.reloads, 0);
  assert.ok(!r.calls.some(c => c.startsWith('reset')));
  assert.ok(r.calls.includes('paused:false') || !r.calls.includes('paused:true'), 'the town renders again');
});

test('a failure after activate falls back to the old reload behind a plain fade', async () => {
  for (const options of [{state: false}, {reset: 'throw'}, {worldId: 'someone-else'}]) {
    const r = rig(options);
    const done = r.travel.go({id: 'b'});
    await r.run(3000);
    assert.equal((await done).phase, 'fallback');
    assert.equal(r.reloads, 1, JSON.stringify(options));
    assert.equal(r.travel.log.at(-1).phase, 'fallback');
  }
});

test('without a scene that can rebuild, go() declines and the panel keeps its reload', () => {
  const travel = createWorldTravel({stage: () => ({}), win: {}, doc: {}});
  assert.equal(travel.available, false);
  assert.equal(travel.go({id: 'b'}), null);
});

// Fakes for the disposal rules: every geometry, material, skeleton and instanced buffer counts its dispose().
function fakes() {
  const count = {geometry: 0, material: 0, instanced: 0, skeleton: 0, sprite: 0, removed: 0, labels: 0};
  const geometry = () => ({dispose() { count.geometry++; }});
  const material = () => ({dispose() { count.material++; }});
  const node = (props = {}, children = []) => {
    const o = {userData: {}, children, ...props, removeFromParent() { count.removed++; }, traverse(fn) { fn(o); for (const c of o.children) c.traverse(fn); }};
    return o;
  };
  return {count, geometry, material, node};
}

test('destroy frees only what an object owns, Points included', () => {
  const {count, geometry, material, node} = fakes();
  const sharedMaterial = material(), sharedGeometry = geometry();
  const group = node({}, [
    node({isMesh: true, geometry: geometry(), material: sharedMaterial, userData: {ownedGeometry: true}}),
    node({isPoints: true, geometry: geometry(), material: sharedMaterial, userData: {ownedGeometry: true}}),
    node({isMesh: true, geometry: sharedGeometry, material: sharedMaterial}),
    node({isMesh: true, isInstancedMesh: true, geometry: sharedGeometry, material: sharedMaterial, dispose() { count.instanced++; }}),
    node({isMesh: true, isSkinnedMesh: true, geometry: sharedGeometry, material: material(), skeleton: {dispose() { count.skeleton++; }}, userData: {appearanceRole: 'kit'}}),
  ]);
  destroy(group);
  assert.deepEqual({geometry: count.geometry, material: count.material, instanced: count.instanced, skeleton: count.skeleton, removed: count.removed}, {geometry: 2, material: 1, instanced: 1, skeleton: 1, removed: 1});
});

test('clearWorld disposes every resident, street, link, memorial and farewell, and keeps the shared Mayor model', () => {
  const {count, geometry, material, node} = fakes();
  const residents = new Map();
  for (const id of ['mayor', 'builder', 'scholar']) {
    residents.set(id, {
      label: {remove() { count.labels++; }},
      bubble: id === 'builder' ? {} : null,
      group: node({}, [node({isMesh: true, geometry: geometry(), material: material(), userData: {ownedGeometry: true}})]),
      catModel: node({}, [node({isMesh: true, geometry: geometry(), material: material(), userData: {appearanceRole: 'fur'}})]),
      holo: {group: node({}, [node({geometry: geometry(), material: material()}), node({geometry: geometry(), material: material()})])},
    });
  }
  const mayorScene = {removed: 0, removeFromParent() { this.removed++; }};
  const townGroup = node({}, [node({isMesh: true, geometry: geometry(), material: material(), userData: {ownedGeometry: true}}), node({isPoints: true, geometry: geometry(), userData: {ownedGeometry: true}})]);
  const linkMesh = node({isMesh: true, geometry: geometry(), userData: {ownedGeometry: true}});
  const memorial = {labels: [{}, {}], group: node({}, [node({isMesh: true, geometry: geometry(), userData: {ownedGeometry: true}})])};
  const farewells = [{sprite: {}}];
  clearWorld({residents, townGroup, linkMesh, memorial, farewells, mayorScene}, {disposeSprite: () => { count.sprite++; }});
  assert.equal(residents.size, 0);
  assert.equal(farewells.length, 0);
  assert.equal(count.labels, 3, 'every name label leaves the page');
  // 3 houses + 3 x 2 hologram parts + 2 streets + 1 link + 1 memorial
  assert.equal(count.geometry, 3 + 6 + 2 + 1 + 1);
  // 3 cat looks + 3 x 2 hologram parts (house, street and link materials are shared)
  assert.equal(count.material, 3 + 6);
  assert.equal(count.sprite, 1 + 2 + 1, 'the builder\'s bubble, two name plates, one farewell');
  assert.equal(mayorScene.removed, 1, 'the Mayor GLB is detached, not disposed');
  // A second clear of the now empty world frees nothing more.
  const before = {...count};
  clearWorld({residents, farewells}, {disposeSprite: () => { count.sprite++; }});
  assert.deepEqual(count, before);
});

test('removeResident leaves the other residents alone', () => {
  const {node, geometry, material} = fakes();
  const make = () => ({label: {remove() {}}, bubble: null, group: node(), catModel: node(), holo: {group: node({}, [node({geometry: geometry(), material: material()})])}});
  const residents = new Map([['a', make()], ['b', make()]]);
  removeResident('a', residents.get('a'), residents, {disposeSprite() {}});
  assert.deepEqual([...residents.keys()], ['b']);
});

test('sfx events: every cue the cinematics fire has a plan, and stops name a real group', () => {
  const fired = ['intro-swell', 'intro-whoosh', 'intro-chirp', 'intro-sparkle', 'intro-resolve', 'intro-stop', 'build-tap', 'build-creak', 'build-roof', 'build-chirp', 'build-shimmer', 'travel-out', 'travel-drone', 'travel-in', 'travel-land', 'travel-stop'];
  assert.deepEqual(Object.keys(SFX_EVENTS).sort(), [...fired].sort());
  const groups = new Set(Object.values(SFX_EVENTS).map(p => p.group).filter(Boolean));
  for (const [name, plan] of Object.entries(SFX_EVENTS)) {
    assert.ok(plan.play || plan.stops, name);
    if (plan.stops) assert.ok(groups.has(plan.stops), `${name} stops ${plan.stops}`);
  }
  assert.equal(SFX_EVENTS['intro-stop'].stops, 'intro', 'Skip fades the intro sounds');
  assert.equal(SFX_EVENTS['travel-in'].stops, 'travel', 'the landing ends the drone');
});

test('sfxGate: one construction sound set at a time, released after the hold', () => {
  let gate = null, r;
  r = sfxGate(gate, {name: 'build-tap', set: 'baker'}, 0); assert.equal(r.ok, true); gate = r.gate;
  r = sfxGate(gate, {name: 'build-shimmer', set: 'poet'}, 500); assert.equal(r.ok, false, 'a second site is held back'); gate = r.gate;
  r = sfxGate(gate, {name: 'build-tap', set: 'baker'}, 1000); assert.equal(r.ok, true, 'the voiced site keeps sounding'); gate = r.gate;
  r = sfxGate(gate, {name: 'build-roof', set: 'poet'}, 1000 + SFX_SET_HOLD_MS - 1); assert.equal(r.ok, false);
  r = sfxGate(gate, {name: 'build-roof', set: 'poet'}, 1000 + SFX_SET_HOLD_MS); assert.equal(r.ok, true, 'a quiet site hands over'); gate = r.gate;
  assert.equal(sfxGate(gate, {name: 'travel-out'}, 1001 + SFX_SET_HOLD_MS).ok, true, 'sounds without a set always play');
});

test('the sfx event plays on the effects bus, respects mute, and a stop fades its group', () => {
  const listeners = {};
  const win = {addEventListener(type, fn) { (listeners[type] ??= []).push(fn); }, removeEventListener() {}};
  const ramps = [];
  const param = () => ({value: 1, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v, t) { ramps.push(v); this.value = v; }, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {}});
  const node = () => ({connect(n) { return n || this; }, disconnect() {}, start() {}, stop() {}});
  let oscillators = 0;
  class Ctx {
    constructor() { this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.destination = {}; }
    createGain() { return {...node(), gain: param()}; }
    createOscillator() { oscillators++; return {...node(), frequency: param(), detune: param()}; }
    createDynamicsCompressor() { return {...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param()}; }
    createBiquadFilter() { return {...node(), frequency: param(), Q: param()}; }
    createBufferSource() { return {...node()}; }
    createConvolver() { return {...node()}; }
    createBuffer(c, n) { return {getChannelData: () => new Float32Array(n)}; }
    resume() { return Promise.resolve(); }
  }
  const audio = createAudio({storage: null, win, doc: {hidden: false, addEventListener() {}}, AudioContextClass: Ctx, schedule: () => null, cancel: () => {}});
  const fire = name => { for (const fn of listeners.sfx || []) fn({detail: {name}}); };
  fire('intro-chirp');
  assert.equal(oscillators, 0, 'nothing before unlock');
  audio.unlock();
  oscillators = 0; fire('intro-swell'); fire('intro-chirp');
  assert.ok(oscillators > 0, 'the event reaches the controller');
  ramps.length = 0; fire('intro-stop');
  assert.ok(ramps.includes(0), 'Skip fades the group to silence');
  audio.update({muted: true});
  oscillators = 0; fire('travel-out');
  assert.equal(oscillators, 0, 'muted: silent');
  audio.update({muted: false, effects: 0});
  assert.equal(audio.cinema({name: 'build-tap'}), false, 'effects at zero: silent');
  audio.update({effects: 60});
  assert.equal(audio.cinema({name: 'nonsense'}), false);
  assert.equal(audio.cinema({name: 'build-tap', set: 'a'}), true);
  assert.equal(audio.cinema({name: 'build-tap', set: 'b'}), false, 'the controller applies the set gate');
});

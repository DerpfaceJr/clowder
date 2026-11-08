import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOOM, DEFAULTS, MELODY, PROGRESSIONS, SFX, SFX_KINDS, STORAGE_KEY, TAP_GAP_MS,
  attachUiSounds, busGains, clampVolume, createAudio, createRng, isNightTime, loadSettings, nextMelodyIndex, nextProgression, normalizeSettings, patchSettings, saveSettings,
  spendScale, tapAllowed, tapEligible, tapRecipe,
  CROSSFADE_S, SPACE_BELLS, SPACE_CHORDS, SpaceMusic, TRACK_SPACE, TRACK_TOWN, crossfadePlan, fadeGainAt, impulseSamples,
  nextBellGap, nextBellIndex, nextSpaceIndex, wantedTrack, EFFECTS_LOWPASS_HZ, LIMITER, DUCK_LEVEL, HAPTIC_MS, renderCue, tapKind, CUES, JITTER, cueAllowed, jitterCue,
} from '../public/audio.js';

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v))};
};
const throwing = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};

test('defaults are music 35, effects 60, master 100, unmuted', () => {
  assert.deepEqual({...DEFAULTS}, {master: 100, music: 35, effects: 60, interface: 70, muted: false, memorialMusic: true, quiet: false, vibrate: false});
  assert.deepEqual(normalizeSettings(null), DEFAULTS);
  assert.deepEqual(normalizeSettings('nonsense'), DEFAULTS);
});

test('volumes clamp to 0..100 and round; bad input falls back to the default', () => {
  assert.equal(clampVolume(150, 35), 100);
  assert.equal(clampVolume(-5, 35), 0);
  assert.equal(clampVolume(33.6, 35), 34);
  assert.equal(clampVolume('42', 35), 42);
  assert.equal(clampVolume('', 35), 35);
  assert.equal(clampVolume(NaN, 35), 35);
  assert.equal(clampVolume(Infinity, 35), 35);
  assert.equal(clampVolume(null, 60), 60);
  assert.deepEqual(normalizeSettings({master: 999, music: -1, effects: 'x', muted: 'yes', extra: 1}), {master: 100, music: 0, effects: 60, interface: 70, muted: false, memorialMusic: true, quiet: false, vibrate: false});
  assert.equal(normalizeSettings({muted: true}).muted, true);
});

test('patches merge onto current settings and stay clamped', () => {
  assert.deepEqual(patchSettings({master: 80, music: 35, effects: 60, muted: false}, {music: 500, muted: true}), {master: 80, music: 100, effects: 60, interface: 70, muted: true, memorialMusic: true, quiet: false, vibrate: false});
});

test('settings persist under one key and reload clamped', () => {
  const storage = memory();
  const saved = saveSettings(storage, {master: 70, music: 300, effects: -20, muted: true});
  assert.deepEqual(saved, {master: 70, music: 100, effects: 0, interface: 70, muted: true, memorialMusic: true, quiet: false, vibrate: false});
  assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)), saved);
  assert.deepEqual(loadSettings(storage), saved);
});

test('missing, corrupt or blocked storage gives defaults and never throws', () => {
  assert.deepEqual(loadSettings(memory()), DEFAULTS);
  assert.deepEqual(loadSettings(memory({[STORAGE_KEY]: '{not json'})), DEFAULTS);
  assert.deepEqual(loadSettings(memory({[STORAGE_KEY]: '{"music":"250"}'})), {...DEFAULTS, music: 100});
  assert.deepEqual(loadSettings(throwing), DEFAULTS);
  assert.deepEqual(loadSettings(null), DEFAULTS);
  assert.doesNotThrow(() => saveSettings(throwing, DEFAULTS));
  assert.doesNotThrow(() => saveSettings(null, DEFAULTS));
});

test('bus gains: mute silences the master only, and the music and effects sliders scale linearly', () => {
  const open = busGains(DEFAULTS);
  assert.equal(open.master, 1);
  assert.ok(Math.abs(open.music - 0.1575) < 1e-9);
  assert.ok(Math.abs(open.effects - 0.54) < 1e-9);
  const muted = busGains({...DEFAULTS, muted: true});
  assert.equal(muted.master, 0);
  assert.equal(muted.effects, open.effects, 'sliders keep their values while muted');
  assert.equal(busGains({...DEFAULTS, master: 0}).master, 0);
});

test('night is read from the town-time detail; anything absent means day', () => {
  assert.equal(isNightTime(undefined), false);
  assert.equal(isNightTime({}), false);
  assert.equal(isNightTime({night: true}), true);
  assert.equal(isNightTime({isNight: true}), true);
  assert.equal(isNightTime({phase: 'night'}), true);
  assert.equal(isNightTime({phase: 'day'}), false);
  assert.equal(isNightTime({hour: 23}), true);
  assert.equal(isNightTime({hour: 3}), true);
  assert.equal(isNightTime({hour: 12}), false);
  assert.equal(isNightTime({hour: NaN}), false);
});

test('the seeded generator is deterministic and stays in [0, 1)', () => {
  const a = createRng(7), b = createRng(7);
  const xs = Array.from({length: 500}, () => a());
  assert.deepEqual(xs, Array.from({length: 500}, () => b()));
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({length: 5}, createRng(8)));
});

test('the melody is C major pentatonic and its walk stays inside the range', () => {
  const pentatonic = new Set([0, 2, 4, 7, 9]);
  assert.ok(MELODY.every(m => pentatonic.has(m % 12)));
  const rng = createRng(3);
  let index = 3, rests = 0, moved = new Set();
  for (let i = 0; i < 2000; i++) {
    const next = nextMelodyIndex(rng, index);
    if (next < 0) { rests++; continue; }
    assert.ok(next >= 0 && next < MELODY.length);
    moved.add(next);
    index = next;
  }
  assert.ok(rests > 500 && rests < 1200, `sparse, rests ${rests}`);
  assert.ok(moved.size >= MELODY.length - 1, 'the walk covers the range');
});

test('progressions never repeat the one before, and every chord they name exists', () => {
  const rng = createRng(11);
  let previous = null;
  for (let i = 0; i < 200; i++) {
    const next = nextProgression(rng, previous);
    if (previous) assert.notEqual(next, previous);
    previous = next;
  }
  for (const p of PROGRESSIONS) assert.equal(p.length, 4);
});

test('every effect is soft and short', () => {
  assert.deepEqual([...SFX_KINDS].sort(), ['chime', 'chirp', 'close', 'coin', 'error', 'open', 'quest', 'select', 'send', 'spend', 'success', 'tab', 'tap', 'toggleOff', 'toggleOn']);
  for (const kind of SFX_KINDS) {
    const end = Math.max(...SFX[kind].map(n => n.start + n.dur));
    const peak = Math.max(...SFX[kind].map(n => n.peak));
    assert.ok(end <= 1.5, `${kind} lasts ${end}s`);
    assert.ok(peak <= 0.2, `${kind} peaks at ${peak}`);
  }
  assert.ok(SFX.tap[0].peak < SFX.chirp[0].peak, 'the tap is the quietest');
});

// A fake Web Audio graph: enough to check the wiring, which is the part that can go wrong without a browser.
function fakeContext() {
  const log = {oscillators: 0, gains: [], created: [], ramps: [], filters: [], noises: 0};
  const param = () => ({value: 0, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v, t) { log.ramps.push({v, t}); this.value = v; }, exponentialRampToValueAtTime(v) { this.to = v; }, setTargetAtTime(v) { this.target = v; (this.targets ??= []).push(v); }, cancelScheduledValues() {}});
  const node = () => ({connect(n) { return n || this; }, start() {}, stop() {}});
  class FakeContext {
    constructor() { this.currentTime = 0; this.sampleRate = 44100; this.state = 'running'; this.destination = {}; log.created.push(this); }
    createGain() { const g = {...node(), gain: param()}; log.gains.push(g); return g; }
    createOscillator() { log.oscillators++; return {...node(), stop(t) { (log.stops ??= []).push(t); }, type: 'sine', frequency: param(), detune: param()}; }
    createDynamicsCompressor() { log.limiters = (log.limiters ?? 0) + 1; return {...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param()}; }
    createBiquadFilter() { const f = {...node(), type: 'lowpass', frequency: param(), Q: param()}; log.filters.push(f); return f; }
    createBufferSource() { log.noises++; return {...node(), buffer: null}; }
    createConvolver() { return {...node(), buffer: null}; }
    createBuffer(channels, length) { return {getChannelData: () => new Float32Array(length)}; }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  return {FakeContext, log};
}

test('nothing is created before unlock; unlock builds the graph once; effects respect mute and zero volume', () => {
  const {FakeContext, log} = fakeContext();
  const storage = memory();
  const audio = createAudio({storage, AudioContextClass: FakeContext, schedule: () => null, cancel: () => {}});
  assert.equal(log.created.length, 0, 'no AudioContext before a gesture');
  assert.equal(audio.play('chime'), false);
  assert.equal(audio.unlock(), true);
  assert.equal(log.created.length, 1);
  assert.equal(audio.unlock(), true);
  assert.equal(log.created.length, 1, 'unlock is idempotent');
  assert.equal(audio.play('chime'), true);
  assert.equal(audio.play('nope'), false);
  audio.update({muted: true});
  assert.equal(audio.play('tap'), false);
  audio.update({muted: false, effects: 0, interface: 0});
  assert.equal(audio.play('tap'), false);
  audio.update({effects: 60, interface: 70});
  assert.equal(audio.play('coin'), true);
  assert.deepEqual(loadSettings(storage), {master: 100, music: 35, effects: 60, interface: 70, muted: false, memorialMusic: true, quiet: false, vibrate: false});
});

test('without an AudioContext class the controller stays silent instead of throwing', () => {
  const audio = createAudio({storage: memory(), AudioContextClass: null, win: null, doc: null});
  assert.equal(audio.unlock(), false);
  assert.equal(audio.play('chime'), false);
  assert.doesNotThrow(() => audio.dispose());
});

test('taps are rate limited to one per 60 ms, and the first always sounds', () => {
  assert.equal(TAP_GAP_MS, 60);
  assert.equal(tapAllowed(-Infinity, 0), true);
  assert.equal(tapAllowed(1000, 1059), false);
  assert.equal(tapAllowed(1000, 1060), true);
});

test('only enabled controls tap: text entry, disabled and aria-disabled stay silent', () => {
  assert.equal(tapEligible({tag: 'BUTTON', type: 'submit'}), true);
  assert.equal(tapEligible({tag: 'DIV'}), true);
  assert.equal(tapEligible({tag: 'INPUT', type: 'button'}), true);
  assert.equal(tapEligible({tag: 'BUTTON', disabled: true}), false);
  assert.equal(tapEligible({tag: 'DIV', ariaDisabled: true}), false);
  assert.equal(tapEligible({tag: 'INPUT', type: 'text'}), false);
  assert.equal(tapEligible({tag: 'INPUT', type: 'search'}), false);
  assert.equal(tapEligible({tag: 'TEXTAREA'}), false);
  assert.equal(tapEligible({tag: 'SELECT'}), false);
  assert.equal(tapEligible({tag: 'DIV', editable: true}), false);
});

test('the tap varies by at most a semitone and its blip is over within 100 ms', () => {
  const base = SFX.tap[0].from;
  for (const r of [0, 0.5, 0.999]) {
    const [note] = tapRecipe(() => r);
    assert.ok(Math.abs(Math.log2(note.from / base) * 12) <= 1 + 1e-9, `pitch at ${r}`);
    assert.ok(Math.max(...tapRecipe(() => r).map(n => n.start + n.dur)) <= 0.1);
  }
  assert.notEqual(tapRecipe(() => 0)[0].from, tapRecipe(() => 0.9)[0].from);
});

test('spend volume grows with the amount and is capped at full', () => {
  assert.equal(spendScale(0), 0);
  assert.ok(spendScale(1) >= 0.45);
  assert.ok(spendScale(1) < spendScale(10) && spendScale(10) < spendScale(100));
  assert.equal(spendScale(1e9), 1);
});

test('a season batch plays one spend sound, then a sale tinkle a moment later', () => {
  const {FakeContext, log} = fakeContext();
  const timers = [];
  // Music off, so the only oscillators are the effects under test.
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"music":0}'}), AudioContextClass: FakeContext, schedule: (fn, ms) => { timers.push({fn, ms}); return null; }, cancel: () => {}});
  audio.unlock();
  const before = log.oscillators;
  assert.equal(audio.announceSpend({spent: 120, earned: 0, count: 2}), true);
  const spendOscillators = log.oscillators - before;
  assert.ok(spendOscillators >= 3, `spend made ${spendOscillators} oscillators`);
  assert.equal(audio.announceSpend({spent: 0, earned: 0, count: 0}), false);
  assert.equal(log.oscillators - before, spendOscillators, 'an empty batch makes no sound');
  audio.announceSpend({spent: 0, earned: 40, count: 1});
  assert.equal(log.oscillators - before, spendOscillators, 'a sale waits for its moment');
  timers.find(t => t.ms === 0).fn();
  assert.ok(log.oscillators > before + spendOscillators, 'the sale tinkle plays');
});

test('a press taps once per 60 ms on pointerdown, keyboard clicks still tap, and disabled controls and text inputs stay silent', () => {
  let clock = 1000;
  const {FakeContext, log} = fakeContext();
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"music":0}'}), AudioContextClass: FakeContext, now: () => clock, schedule: () => null, cancel: () => {}});
  audio.unlock();
  const listeners = [];
  const sources = [];
  class FakeSource {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
  }
  const doc = {addEventListener: (type, fn, capture) => listeners.push({type, fn, capture}), removeEventListener() {}};
  const feed = attachUiSounds({doc, audio, EventSourceClass: FakeSource, now: () => clock, schedule: () => null});
  const control = props => ({tagName: props.tag, getAttribute: n => (n === 'type' ? props.type ?? null : n === 'aria-disabled' && props.ariaDisabled ? 'true' : null), matches: s => s === ':disabled' && !!props.disabled, isContentEditable: false});
  const on = type => listeners.find(l => l.type === type);
  const clickOn = el => on('pointerdown').fn({target: {closest: () => el}, pointerType: 'touch', button: 0});
  const oscillatorsFor = fn => { const start = log.oscillators; fn(); return log.oscillators - start; };
  const button = control({tag: 'BUTTON'});
  assert.equal(on('pointerdown').capture, true, 'capture, so no page handler can stop the tap');
  assert.equal(on('click').capture, true);
  assert.ok(oscillatorsFor(() => clickOn(button)) > 0, 'the first click taps');
  assert.equal(oscillatorsFor(() => clickOn(button)), 0, 'a second click within 60 ms does not');
  clock = 1061;
  assert.ok(oscillatorsFor(() => clickOn(button)) > 0, 'after 60 ms it taps again');
  clock = 3000;
  assert.equal(oscillatorsFor(() => clickOn(control({tag: 'BUTTON', disabled: true}))), 0);
  assert.equal(oscillatorsFor(() => clickOn(control({tag: 'DIV', ariaDisabled: true}))), 0);
  assert.equal(oscillatorsFor(() => clickOn(control({tag: 'INPUT', type: 'text'}))), 0);
  assert.equal(oscillatorsFor(() => on('pointerdown').fn({target: {closest: () => null}, pointerType: 'touch', button: 0})), 0, 'presses outside a control are silent');
  clock = 5000;
  assert.equal(oscillatorsFor(() => on('click').fn({target: {closest: () => button}, detail: 1})), 0, 'the click after a press does not sound twice');
  assert.ok(oscillatorsFor(() => on('click').fn({target: {closest: () => button}, detail: 0})) > 0, 'a keyboard click (no pointer) taps');
  clock = 6000;
  assert.equal(oscillatorsFor(() => on('pointerdown').fn({target: {closest: () => button}, pointerType: 'mouse', button: 2})), 0, 'a right button does not tap');
  clock = 7000;
  const tab = {...button, getAttribute: n => (n === 'role' ? 'tab' : null)};
  assert.ok(oscillatorsFor(() => clickOn(tab)) > 0, 'a tab has its own cue');
  assert.equal(tapKind(tab), 'tab');
  assert.equal(tapKind({getAttribute: () => null, matches: q => q === '.cat-button'}), 'select');
  assert.equal(tapKind(button), 'tap');
  assert.equal(sources[0].url, '/api/events?only=season');
  assert.ok(oscillatorsFor(() => sources[0].handlers.season({data: JSON.stringify({spent: 50, earned: 0, count: 1})})) > 0, 'a season frame plays the spend sound');
  assert.equal(oscillatorsFor(() => sources[0].handlers.season({data: 'not json'})), 0, 'a malformed frame is silent');
  feed.dispose();
  assert.equal(sources[0].closed, true);
});

test('wantedTrack: the Memorial plays space unless Memorial music is off', () => {
  assert.equal(wantedTrack(), TRACK_TOWN);
  assert.equal(wantedTrack({memorial: true}), TRACK_SPACE);
  assert.equal(wantedTrack({memorial: true, memorialMusic: false}), TRACK_TOWN);
  assert.equal(wantedTrack({memorial: false, memorialMusic: true}), TRACK_TOWN);
  assert.equal(wantedTrack({memorial: true, memorialMusic: undefined}), TRACK_SPACE, 'on by default');
});

test('a switch is two complementary linear fades; no switch means no steps; a first start is instant', () => {
  assert.deepEqual(crossfadePlan(TRACK_TOWN, TRACK_TOWN), []);
  const plan = crossfadePlan(TRACK_TOWN, TRACK_SPACE);
  assert.deepEqual(plan.map(s => s.track), [TRACK_TOWN, TRACK_SPACE]);
  assert.equal(CROSSFADE_S, 2);
  for (const step of plan) assert.equal(step.seconds, CROSSFADE_S);
  for (let t = 0; t <= CROSSFADE_S; t += 0.25) {
    const sum = plan.reduce((total, step) => total + fadeGainAt(step, t), 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `the pair adds to ${sum} at ${t}s`);
  }
  assert.equal(fadeGainAt(plan[0], 0), 1);
  assert.equal(fadeGainAt(plan[0], CROSSFADE_S), 0);
  assert.equal(fadeGainAt(plan[1], CROSSFADE_S + 5), 1, 'clamped past the end');
  assert.deepEqual(crossfadePlan(TRACK_SPACE, TRACK_TOWN).map(s => s.track), [TRACK_SPACE, TRACK_TOWN]);
  assert.deepEqual(crossfadePlan(null, TRACK_TOWN), [{track: TRACK_TOWN, from: 0, to: 1, seconds: 0}]);
});

test('space choices are seeded, never repeat the last pick, stay in range and use every chord', () => {
  const walk = seed => { const rng = createRng(seed); let prev = -1; return Array.from({length: 200}, () => (prev = nextSpaceIndex(rng, prev))); };
  const seq = walk(11);
  assert.deepEqual(seq, walk(11), 'the same seed gives the same walk');
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
  assert.ok(seq.every(i => i >= 0 && i < SPACE_CHORDS.length));
  assert.equal(new Set(seq).size, SPACE_CHORDS.length);
  const rng = createRng(3);
  let bell = -1;
  const bells = Array.from({length: 200}, () => (bell = nextBellIndex(rng, bell)));
  for (let i = 1; i < bells.length; i++) assert.notEqual(bells[i], bells[i - 1]);
  assert.ok(bells.every(i => i >= 0 && i < SPACE_BELLS.length));
  for (const chord of SPACE_CHORDS) for (const midi of chord) assert.ok(midi >= 24 && midi <= 96, `${midi} is a usable pitch`);
  const gapRng = createRng(5);
  for (let i = 0; i < 500; i++) {
    const gap = nextBellGap(gapRng);
    assert.ok(gap >= 9 && gap < 20, `bell gap ${gap}s`);
  }
});

test('the reverb impulse is seeded, stays within full scale and decays to near silence', () => {
  const a = impulseSamples(createRng(9), 1000), b = impulseSamples(createRng(9), 1000);
  assert.equal(a.length, 1000);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.ok(a.every(v => Math.abs(v) <= 1));
  const peak = (from, to) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p; };
  assert.ok(peak(900, 1000) < peak(0, 100) / 10, 'the tail is much quieter than the start');
});

test('space music schedules its pads, shimmers and bells up to the horizon and no further', () => {
  const {FakeContext, log} = fakeContext();
  const ctx = new FakeContext();
  const space = new SpaceMusic(ctx, ctx.createGain(), ctx.createConvolver(), createRng(4));
  const before = log.oscillators;
  space.tick(3);
  assert.ok(log.oscillators > before, 'the first chord and a shimmer are scheduled');
  assert.ok(space.nextChord >= 3 && space.nextShimmer >= 3 && space.nextBell >= 3, 'nothing is scheduled past the horizon');
  const after = log.oscillators;
  space.tick(3);
  assert.equal(log.oscillators, after, 'ticking again at the same horizon adds nothing');
  space.tick(40);
  assert.ok(log.oscillators > after, 'later ticks add more');
});

test('opening the Memorial crossfades to space over 2 s, and closing brings the town back', () => {
  const {FakeContext, log} = fakeContext();
  const win = new EventTarget();
  const audio = createAudio({storage: memory(), win, AudioContextClass: FakeContext, schedule: () => null, cancel: () => {}});
  audio.unlock();
  const pairs = from => log.ramps.slice(from).map(r => [r.v, r.t]).sort((x, y) => x[0] - y[0]);
  let mark = log.ramps.length;
  win.dispatchEvent(new CustomEvent('memorial-view', {detail: {open: true}}));
  assert.deepEqual(pairs(mark), [[0, 2], [1, 2]], 'town falls and space rises over 2 s from now');
  log.created[0].currentTime = 10;
  mark = log.ramps.length;
  win.dispatchEvent(new CustomEvent('memorial-view', {detail: {open: false}}));
  assert.deepEqual(pairs(mark), [[0, 12], [1, 12]], 'space falls and town rises back');
  audio.dispose();
});

test('Memorial music off, or muted, keeps the town track; turning the setting on mid-view crossfades in', () => {
  const {FakeContext, log} = fakeContext();
  const win = new EventTarget();
  const audio = createAudio({storage: memory(), win, AudioContextClass: FakeContext, schedule: () => null, cancel: () => {}});
  audio.unlock();
  audio.update({memorialMusic: false});
  let mark = log.ramps.length;
  win.dispatchEvent(new CustomEvent('memorial-view', {detail: {open: true}}));
  assert.equal(log.ramps.length, mark, 'no crossfade when Memorial music is off');
  mark = log.ramps.length;
  audio.update({memorialMusic: true});
  assert.ok(log.ramps.length > mark, 'the setting applies at once while the Memorial is open');
  win.dispatchEvent(new CustomEvent('memorial-view', {detail: {open: false}}));
  audio.update({muted: true});
  mark = log.ramps.length;
  win.dispatchEvent(new CustomEvent('memorial-view', {detail: {open: true}}));
  assert.equal(log.ramps.length, mark, 'muted: nothing plays, so nothing fades');
  audio.update({muted: false});
  // The generators' own pad and shimmer ramps start later; the two fades are the ones at t = 0.
  const starts = log.ramps.slice(mark).filter(r => r.t === 0).map(r => [r.v, r.t]).sort((x, y) => x[0] - y[0]);
  assert.deepEqual(starts, [[0, 0], [1, 0]], 'unmuting inside the Memorial starts space straight away');
  audio.dispose();
});

test('the Memorial zoom sounds: a rising whoosh in, a falling one out, silent when muted or effects are off', () => {
  const {FakeContext, log} = fakeContext();
  const audio = createAudio({storage: memory(), AudioContextClass: FakeContext, schedule: () => null, cancel: () => {}});
  assert.equal(audio.zoomIn(), false, 'nothing before unlock');
  audio.unlock();
  const bands = () => log.filters.filter(f => f.type === 'bandpass');
  assert.equal(audio.zoomIn(1.1), true);
  assert.equal(log.noises, 1);
  assert.ok(bands()[0].frequency.value < bands()[0].frequency.to, 'zoom in sweeps up');
  assert.ok(ZOOM.shimmer.every(n => n.from < 4200), 'the shimmer stays under the 4.2 kHz effects roll-off');
  assert.equal(audio.zoomOut(1.1), true);
  assert.ok(bands()[1].frequency.value > bands()[1].frequency.to, 'zoom out sweeps down');
  audio.update({muted: true});
  assert.equal(audio.zoomIn(), false);
  assert.equal(audio.zoomOut(), false);
  audio.update({muted: false, effects: 0, interface: 0});
  assert.equal(audio.zoomIn(), false);
  assert.equal(log.noises, 2, 'muted and zero-effects calls schedule nothing');
});

test('unlock puts one compressor between master and destination, and the effects low-pass is raised to 9 kHz', () => {
  const {FakeContext, log} = fakeContext();
  const audio = createAudio({storage: memory(), AudioContextClass: FakeContext, schedule: () => null, cancel: () => {}});
  audio.unlock();
  assert.equal(log.limiters, 1);
  assert.ok(log.filters.some(f => f.frequency.value === EFFECTS_LOWPASS_HZ) && EFFECTS_LOWPASS_HZ === 9000);
  assert.ok(LIMITER.threshold <= -10 && LIMITER.ratio >= 4);
});

test('only the chime ducks the music, on its own gain stage; chirps, coins and taps leave it alone', () => {
  const {FakeContext, log} = fakeContext();
  let clock = 0;
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"music":0}'}), AudioContextClass: FakeContext, now: () => clock, schedule: () => null, cancel: () => {}});
  audio.unlock();
  const ducked = () => log.gains.filter(g => g.gain.targets?.includes(DUCK_LEVEL));
  for (const kind of ['chirp', 'coin', 'spend', 'tap']) { clock += 5000; audio.play(kind); }
  assert.equal(ducked().length, 0, 'no other cue ducks');
  clock += 5000;
  audio.play('chime');
  assert.equal(ducked().length, 1, 'one stage ducks');
  assert.deepEqual(ducked()[0].gain.targets.slice(-2), [DUCK_LEVEL, 1], 'down, then back to unity over its own stage');
});

test('every cue envelope ends on a ramp to zero before its oscillator stops', () => {
  const {FakeContext, log} = fakeContext();
  let clock = 0;
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"music":0}'}), AudioContextClass: FakeContext, now: () => clock, schedule: () => null, cancel: () => {}});
  audio.unlock();
  for (const kind of SFX_KINDS) {
    clock += 10000;
    log.ramps.length = 0; log.stops = []; const before = log.oscillators;
    assert.equal(audio.play(kind), true, kind);
    const zero = log.ramps.filter(r => r.v === 0), made = log.oscillators - before;
    assert.equal(zero.length, made, `${kind}: one ramp to zero per oscillator`);
    assert.ok(Math.max(...zero.map(r => r.t)) < Math.max(...log.stops), `${kind}: stops after the last ramp`);
  }
});

test('a cue sounds again only after its own cooldown, and cooldowns are per cue', () => {
  const {FakeContext} = fakeContext();
  let clock = 1000;
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"music":0}'}), AudioContextClass: FakeContext, now: () => clock, schedule: () => null, cancel: () => {}});
  audio.unlock();
  assert.equal(cueAllowed(-Infinity, 0, 500), true);
  assert.equal(cueAllowed(1000, 1299, CUES.chime.cooldown), false);
  assert.equal(cueAllowed(1000, 1300, CUES.chime.cooldown), true);
  assert.equal(audio.play('chime'), true);
  assert.equal(audio.play('chime'), false, 'the same cue straight away is held back');
  assert.equal(audio.play('coin'), true, 'another cue is not');
  clock += CUES.chime.cooldown;
  assert.equal(audio.play('chime'), true);
  for (const kind of SFX_KINDS) assert.ok(CUES[kind].cooldown > 0, `${kind} has a cooldown`);
});

test('jitter stays within +-2.5% pitch and +-1 dB gain, at both ends and in the middle', () => {
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    const {recipe, gain} = jitterCue(SFX.spend, () => r);
    SFX.spend.forEach((n, i) => {
      assert.ok(Math.abs(recipe[i].from / n.from - 1) <= JITTER.pitch + 1e-9, `pitch at ${r}`);
      assert.ok(Math.abs(recipe[i].to / n.to - recipe[i].from / n.from) < 1e-9, 'a glide keeps its shape');
    });
    assert.ok(Math.abs(20 * Math.log10(gain)) <= JITTER.gainDb + 1e-9, `gain at ${r}`);
  }
  assert.equal(jitterCue(SFX.tap, () => 0.5).gain, 1);
  assert.notEqual(jitterCue(SFX.tap, () => 0).recipe[0].from, jitterCue(SFX.tap, () => 0.9).recipe[0].from);
});

test('interface, quiet and vibrate defaults: quiet follows reduced motion on first run, and a stored choice wins', () => {
  assert.equal(DEFAULTS.interface, 70);
  assert.equal(DEFAULTS.vibrate, false);
  const reduced = {matchMedia: q => ({matches: q.includes('reduce')})}, normal = {matchMedia: () => ({matches: false})};
  const fresh = win => createAudio({storage: memory(), win}).settings();
  assert.equal(fresh(reduced).quiet, true);
  assert.equal(fresh(normal).quiet, false);
  assert.equal(fresh(null).quiet, false);
  assert.equal(createAudio({storage: memory({[STORAGE_KEY]: '{"quiet":false}'}), win: reduced}).settings().quiet, false);
  assert.equal(createAudio({storage: memory({[STORAGE_KEY]: '{"vibrate":"yes"}'}), win: normal}).settings().vibrate, false, 'only true turns the buzz on');
});

test('quiet keeps the decision chime and silences every other cue; interface 0 silences interface cues only', () => {
  const {FakeContext} = fakeContext();
  let clock = 0;
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"music":0,"quiet":true}'}), AudioContextClass: FakeContext, now: () => clock, schedule: () => null, cancel: () => {}});
  audio.unlock();
  for (const kind of SFX_KINDS) { clock += 10000; assert.equal(audio.play(kind), kind === 'chime', kind); }
  audio.update({quiet: false, interface: 0});
  for (const kind of SFX_KINDS) { clock += 10000; assert.equal(audio.play(kind), !CUES[kind].ui, kind); }
});

test('vibrate on tap is off by default, buzzes 8 ms only when chosen, visible and supported, and never throws', () => {
  const calls = [];
  const nav = {vibrate: ms => { calls.push(ms); return true; }};
  const make = (stored, extra = {}) => createAudio({storage: memory(stored ? {[STORAGE_KEY]: JSON.stringify(stored)} : {}), nav, ...extra});
  assert.equal(make().haptic(), false, 'off until chosen');
  assert.deepEqual(calls, []);
  assert.equal(make({vibrate: true}).haptic(), true);
  assert.deepEqual(calls, [HAPTIC_MS]);
  assert.equal(HAPTIC_MS, 8);
  assert.equal(make({vibrate: true}, {doc: {hidden: true, addEventListener() {}}}).haptic(), false, 'not while the page is hidden');
  assert.equal(createAudio({storage: memory({[STORAGE_KEY]: '{"vibrate":true}'}), nav: {}}).haptic(), false, 'no vibrator, as on iOS');
  assert.equal(createAudio({storage: memory({[STORAGE_KEY]: '{"vibrate":true}'}), nav: {vibrate() { throw new Error('blocked'); }}}).haptic(), false);
  const audio = make({vibrate: true});
  audio.update({vibrate: false});
  assert.equal(audio.haptic(), false, 'turning it off takes effect at once');
});

test('a press buzzes once with the tap when vibrate is on, even before sound is unlocked', () => {
  const calls = [];
  const audio = createAudio({storage: memory({[STORAGE_KEY]: '{"vibrate":true}'}), nav: {vibrate: ms => { calls.push(ms); return true; }}, now: () => 1000});
  const listeners = [];
  attachUiSounds({doc: {addEventListener: (type, fn) => listeners.push({type, fn}), removeEventListener() {}}, audio, EventSourceClass: null});
  const button = {tagName: 'BUTTON', getAttribute: () => null, matches: () => false, isContentEditable: false};
  listeners.find(l => l.type === 'pointerdown').fn({target: {closest: () => button}, pointerType: 'touch', button: 0});
  assert.deepEqual(calls, [8]);
});

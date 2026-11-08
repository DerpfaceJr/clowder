// Clowder sound. Everything is synthesised with the Web Audio API, so there are no audio files to license or download.
// Pure settings and music helpers are exported for tests; nothing at import time touches window, storage or AudioContext.
import {diffTownState,isCatChat,isMayorToOwner} from './town-events.js';

export const STORAGE_KEY = 'clowder-audio';
// interface: the volume of taps, toggles, sheets and other interface cues. quiet: only decision chimes sound
// (its first-run default follows prefers-reduced-motion). vibrate: a short buzz on taps, phones only, off until chosen.
export const DEFAULTS = Object.freeze({master: 100, music: 35, effects: 60, interface: 70, muted: false, memorialMusic: true, quiet: false, vibrate: false});

export function clampVolume(value, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function normalizeSettings(raw, fallback = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    master: clampVolume(source.master, DEFAULTS.master),
    music: clampVolume(source.music, DEFAULTS.music),
    effects: clampVolume(source.effects, DEFAULTS.effects),
    interface: clampVolume(source.interface, DEFAULTS.interface),
    muted: source.muted === true,
    memorialMusic: source.memorialMusic !== false,
    quiet: typeof source.quiet === 'boolean' ? source.quiet : fallback?.quiet === true,
    vibrate: source.vibrate === true,
  };
}

export const patchSettings = (current, patch) => normalizeSettings({...normalizeSettings(current), ...(patch && typeof patch === 'object' ? patch : {})});

/** Stored settings. `fallback` holds the first-run defaults a stored value overrides (quiet, from reduced motion). */
export function loadSettings(storage, fallback = {}) {
  try {
    const text = storage ? storage.getItem(STORAGE_KEY) : null;
    return normalizeSettings(text ? JSON.parse(text) : null, fallback);
  } catch {
    return normalizeSettings(null, fallback);
  }
}

export function saveSettings(storage, settings) {
  const clean = normalizeSettings(settings);
  try {
    if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Blocked or full storage: the settings still hold for this page.
  }
  return clean;
}

/** Linear gains for the three buses. Mute silences the master only, so the sliders keep their values. */
export function busGains(settings) {
  const s = normalizeSettings(settings);
  return {
    master: s.muted ? 0 : s.master / 100,
    music: (s.music / 100) * 0.45,
    nature: (s.music / 100) * 0.4,
    effects: (s.effects / 100) * 0.9,
    ui: (s.interface / 100) * UI_BUS_GAIN,
  };
}

// Day and night. The 3D worker dispatches town-time; without it the town is assumed to be in daylight.
export function isNightTime(detail) {
  if (!detail || typeof detail !== 'object') return false;
  if (typeof detail.night === 'boolean') return detail.night;
  if (typeof detail.isNight === 'boolean') return detail.isNight;
  if (typeof detail.phase === 'string') return detail.phase === 'night';
  if (typeof detail.hour === 'number' && Number.isFinite(detail.hour)) return detail.hour < 6 || detail.hour >= 20;
  return false;
}

export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Music material. Pads are seventh chords voiced low; melody is C major pentatonic, played sparsely by a seeded walk.
export const PADS = Object.freeze({I: [48, 52, 55, 59], V: [43, 47, 50, 53], vi: [45, 48, 52, 55], IV: [41, 45, 48, 52], ii: [38, 41, 45, 48]});
export const PROGRESSIONS = Object.freeze([['I', 'vi', 'IV', 'V'], ['vi', 'IV', 'I', 'V'], ['I', 'IV', 'ii', 'V'], ['IV', 'I', 'vi', 'V'], ['I', 'ii', 'vi', 'V']]);
export const MELODY = Object.freeze([72, 74, 76, 79, 81, 84, 86, 88]);
export const BPM = 64;
export const BEAT = 60 / BPM;
export const BEATS_PER_CHORD = 8;

export function nextProgression(rng, previous) {
  const pool = PROGRESSIONS.filter(p => p !== previous);
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

// One melodic step: mostly stepwise, sometimes a leap, and often silence. The walk stays inside MELODY.
const STEPS = [-2, -1, -1, 0, 1, 1, 2];
export function nextMelodyIndex(rng, index) {
  if (rng() < 0.42) return -1;
  const moved = index + STEPS[Math.floor(rng() * STEPS.length)];
  return Math.min(MELODY.length - 1, Math.max(0, moved));
}

// Space music: pads in the low register under 14 s chords, partials shimmering above them, distant bells, all through one long reverb.
export const TRACK_TOWN = 'town', TRACK_SPACE = 'space';
/** Seconds of a fade between the two tracks. */
export const CROSSFADE_S = 2;
export const SPACE_CHORD_S = 14;
export const SPACE_CHORDS = Object.freeze([[38, 45, 52, 57, 64], [36, 43, 47, 55, 62], [33, 40, 48, 52, 59], [31, 38, 45, 50, 57], [34, 41, 48, 53, 60]]);
export const SPACE_BELLS = Object.freeze([74, 78, 81, 86, 89, 93]);

/** The track that should sound. The Memorial plays space unless the player has turned Memorial music off. */
export function wantedTrack({memorial = false, memorialMusic = true} = {}) {
  return memorial && memorialMusic !== false ? TRACK_SPACE : TRACK_TOWN;
}

/**
 * Gain steps for a switch. The outgoing track falls 1 to 0 and the incoming one rises 0 to 1, linearly over the same
 * seconds, so the pair always adds to full level. With no outgoing track (a first start) the incoming one is instant.
 */
export function crossfadePlan(from, to, seconds = CROSSFADE_S) {
  if (from === to) return [];
  const steps = [];
  if (from) steps.push({track: from, from: 1, to: 0, seconds});
  steps.push({track: to, from: 0, to: 1, seconds: from ? seconds : 0});
  return steps;
}

/** The gain of one step t seconds in, clamped to its ends. */
export function fadeGainAt(step, t) {
  const k = step.seconds > 0 ? Math.min(1, Math.max(0, t / step.seconds)) : 1;
  return step.from + (step.to - step.from) * k;
}

// A seeded pick that never repeats the previous one, so the walk always moves.
function pickOther(rng, length, previous) {
  const pool = [];
  for (let i = 0; i < length; i++) if (i !== previous) pool.push(i);
  return pool[Math.floor(rng() * pool.length) % pool.length];
}
export const nextSpaceIndex = (rng, previous = -1) => pickOther(rng, SPACE_CHORDS.length, previous);
export const nextBellIndex = (rng, previous = -1) => pickOther(rng, SPACE_BELLS.length, previous);
/** Seconds until the next bell: 9 to 20, so the bells never settle into a rhythm. */
export const nextBellGap = rng => 9 + rng() * 11;

/** Reverb impulse: seeded noise under a power-law decay, so the tail is soft and the room long. */
export function impulseSamples(rng, length, decay = 3) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (rng() * 2 - 1) * Math.pow(1 - i / length, decay);
  return out;
}

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

// Sound effects: short soft recipes, "Felt and glass". Each note is {wave, from, to, start, dur, peak, attack?, partial?}, where
// partial is one [ratio, amount] pair or a list of them. All pitches are C major pentatonic (C D E G A), like the music, and
// no note's tail is longer than 400 ms except the decision chime's. Felt and wood taps are a sine with a 3.97 overtone, glass is a
// sine with 2.01 and 3.97, and toggles are a low triangle "thock".
const hz = mtof;
export const SFX = Object.freeze({
  chirp: [
    {wave: 'sine', from: 1320, to: 1760, start: 0, dur: 0.11, peak: 0.14, attack: 0.012},
    {wave: 'sine', from: 1760, to: 1320, start: 0.09, dur: 0.1, peak: 0.09, attack: 0.012},
  ],
  chime: [
    {wave: 'sine', from: 659, to: 659, start: 0, dur: 0.8, peak: 0.14, attack: 0.01, partial: [2.01, 0.12]},
    {wave: 'sine', from: 880, to: 880, start: 0.2, dur: 1, peak: 0.12, attack: 0.01, partial: [2, 0.1]},
  ],
  coin: [
    {wave: 'triangle', from: 1760, to: 1760, start: 0, dur: 0.14, peak: 0.12, attack: 0.004},
    {wave: 'triangle', from: 2637, to: 2637, start: 0.07, dur: 0.3, peak: 0.1, attack: 0.004, partial: [2.4, 0.08]},
  ],
  // Coins leaving: a soft descending clink.
  spend: [
    {wave: 'triangle', from: 1568, to: 1568, start: 0, dur: 0.12, peak: 0.09, attack: 0.004},
    {wave: 'triangle', from: 1175, to: 1175, start: 0.07, dur: 0.13, peak: 0.08, attack: 0.004},
    {wave: 'triangle', from: 880, to: 880, start: 0.14, dur: 0.24, peak: 0.07, attack: 0.004, partial: [2.4, 0.08]},
  ],
  // A felt tap: G5, a quiet wooden overtone, dead in under 100 ms.
  tap: [{wave: 'sine', from: hz(79), to: hz(79) * 0.97, start: 0, dur: 0.09, peak: 0.07, attack: 0.002, partial: [3.97, 0.14]}],
  // A tab: the same felt, a third quieter and a little higher (E5).
  tab: [{wave: 'sine', from: hz(76), to: hz(76) * 0.98, start: 0, dur: 0.07, peak: 0.045, attack: 0.002, partial: [3.97, 0.1]}],
  // Toggles: a low soft thock, up a minor third (A3 to C4) for on and down for off.
  toggleOn: [
    {wave: 'triangle', from: hz(57), to: hz(57), start: 0, dur: 0.11, peak: 0.09, attack: 0.003, partial: [2.01, 0.2]},
    {wave: 'triangle', from: hz(60), to: hz(60), start: 0.055, dur: 0.15, peak: 0.09, attack: 0.003, partial: [2.01, 0.2]},
  ],
  toggleOff: [
    {wave: 'triangle', from: hz(60), to: hz(60), start: 0, dur: 0.11, peak: 0.08, attack: 0.003, partial: [2.01, 0.2]},
    {wave: 'triangle', from: hz(57), to: hz(57), start: 0.055, dur: 0.15, peak: 0.07, attack: 0.003, partial: [2.01, 0.2]},
  ],
  // A sheet or dialog opening rises D5 to G5; closing falls and is quieter.
  open: [
    {wave: 'sine', from: hz(74), to: hz(74), start: 0, dur: 0.14, peak: 0.05, attack: 0.012, partial: [2.01, 0.1]},
    {wave: 'sine', from: hz(79), to: hz(79), start: 0.05, dur: 0.2, peak: 0.05, attack: 0.012, partial: [2.01, 0.1]},
  ],
  close: [
    {wave: 'sine', from: hz(79), to: hz(79), start: 0, dur: 0.12, peak: 0.04, attack: 0.012, partial: [2.01, 0.1]},
    {wave: 'sine', from: hz(74), to: hz(74), start: 0.05, dur: 0.16, peak: 0.04, attack: 0.012, partial: [2.01, 0.1]},
  ],
  // Send: one soft glide up, A4 to G5.
  send: [{wave: 'sine', from: hz(69), to: hz(79), start: 0, dur: 0.16, peak: 0.06, attack: 0.008, partial: [2.01, 0.12]}],
  // Success: a glass bell, two notes rising, C6 then E6.
  success: [
    {wave: 'sine', from: hz(84), to: hz(84), start: 0, dur: 0.3, peak: 0.1, attack: 0.004, partial: [[2.01, 0.2], [3.97, 0.08]]},
    {wave: 'sine', from: hz(88), to: hz(88), start: 0.09, dur: 0.4, peak: 0.09, attack: 0.004, partial: [[2.01, 0.2], [3.97, 0.08]]},
  ],
  // Error: a low felt thud, two notes falling (D4 then A3), with no buzz.
  error: [
    {wave: 'sine', from: hz(62), to: hz(57), start: 0, dur: 0.2, peak: 0.1, attack: 0.004, partial: [2.01, 0.1]},
    {wave: 'sine', from: hz(57), to: hz(52), start: 0.1, dur: 0.26, peak: 0.09, attack: 0.004, partial: [2.01, 0.1]},
  ],
  // A cat chosen: a short meow in the key, D5 up to A5 and back to E5.
  select: [
    {wave: 'triangle', from: hz(74), to: hz(81), start: 0, dur: 0.09, peak: 0.055, attack: 0.012},
    {wave: 'sine', from: hz(81), to: hz(76), start: 0.09, dur: 0.16, peak: 0.045, attack: 0.015, partial: [2, 0.12]},
  ],
  // A quest done: a glass arpeggio, C6 E6 G6.
  quest: [
    {wave: 'sine', from: hz(84), to: hz(84), start: 0, dur: 0.3, peak: 0.1, attack: 0.004, partial: [[2.01, 0.2], [3.97, 0.08]]},
    {wave: 'sine', from: hz(88), to: hz(88), start: 0.1, dur: 0.3, peak: 0.09, attack: 0.004, partial: [[2.01, 0.2], [3.97, 0.08]]},
    {wave: 'sine', from: hz(91), to: hz(91), start: 0.2, dur: 0.4, peak: 0.09, attack: 0.004, partial: [[2.01, 0.2], [3.97, 0.08]]},
  ],
});
export const SFX_KINDS = Object.freeze(Object.keys(SFX));

// The Memorial zoom: band-passed noise swept up as the camera flies in (down as it flies out), loudest mid-flight where
// the ease-in-out camera moves fastest. As the sky appears: a shimmer of high bells, then the chime. All under 4.2 kHz.
export const ZOOM = Object.freeze({
  in: {from: 260, to: 2600, peak: 0.2, q: 1.6},
  out: {from: 2200, to: 200, peak: 0.16, q: 1.6},
  shimmer: [1568, 2093, 2349, 3136, 2637].map((f, i) => ({wave: 'sine', from: f, to: f * 1.005, start: i * 0.05, dur: 0.9, peak: 0.035, attack: 0.03})),
});

/** One whoosh: white noise through a band-pass whose centre glides from `from` to `to` over `seconds`. */
function scheduleWhoosh(ctx, dest, sweep, t0, seconds) {
  const rate = ctx.sampleRate || 44100, frames = Math.max(1, Math.round((seconds + 0.1) * rate));
  const buffer = ctx.createBuffer(1, frames, rate), data = buffer.getChannelData(0), rng = createRng(0x200d);
  for (let i = 0; i < frames; i++) data[i] = rng() * 2 - 1;
  const noise = ctx.createBufferSource(), band = ctx.createBiquadFilter(), gain = ctx.createGain();
  noise.buffer = buffer;
  band.type = 'bandpass';
  band.Q.setValueAtTime(sweep.q, t0);
  band.frequency.setValueAtTime(sweep.from, t0);
  band.frequency.exponentialRampToValueAtTime(sweep.to, t0 + seconds);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(sweep.peak, t0 + seconds * 0.55);
  gain.gain.linearRampToValueAtTime(0, t0 + seconds);
  noise.connect(band).connect(gain).connect(dest);
  noise.start(t0);
  noise.stop(t0 + seconds + 0.05);
}

/** How long a tap buzzes, in ms. */
export const HAPTIC_MS = 8;
/** The music's level under a chime, as a fraction of its own. */
export const DUCK_LEVEL = 0.35;
// Every interface cue varies a little each time: pitch within +-2.5%, gain within +-1 dB.
export const JITTER = Object.freeze({pitch: 0.025, gainDb: 1});
/** The recipe with its pitch moved by up to JITTER.pitch either way, and the linear gain factor (+-JITTER.gainDb) to play it at. */
export function jitterCue(recipe, random = Math.random) {
  const k = 1 + (random() * 2 - 1) * JITTER.pitch;
  return {recipe: recipe.map(n => ({...n, from: n.from * k, to: n.to * k})), gain: Math.pow(10, (random() * 2 - 1) * JITTER.gainDb / 20)};
}

// What each cue does besides its notes. cooldown: ms before it may sound again. duck: it lowers the music. ui: it plays on the
// interface bus (the Interface sounds slider). lp: its own low-pass, which shapes the highs per cue.
export const CUES = Object.freeze({
  chirp: {cooldown: 250, lp: 6500}, chime: {cooldown: 300, duck: true}, coin: {cooldown: 100}, spend: {cooldown: 100, lp: 7000},
  tap: {cooldown: 60, ui: true, lp: 5200}, tab: {cooldown: 90, ui: true, lp: 4800},
  toggleOn: {cooldown: 80, ui: true, lp: 2200}, toggleOff: {cooldown: 80, ui: true, lp: 2200},
  open: {cooldown: 140, ui: true, lp: 4200}, close: {cooldown: 140, ui: true, lp: 4200},
  send: {cooldown: 200, ui: true, lp: 7000}, success: {cooldown: 250, ui: true, lp: 8500}, error: {cooldown: 300, ui: true, lp: 1400},
  select: {cooldown: 110, ui: true, lp: 5500}, quest: {cooldown: 500, ui: true, lp: 9000},
});
/** Whether a cue with this cooldown may sound now. lastAt starts at -Infinity so the first always does. */
export const cueAllowed = (lastAt, now, cooldown) => now - lastAt >= cooldown;

export const TAP_GAP_MS = 60;
/** At most one tap per gap. lastAt starts at -Infinity so the first tap always sounds. */
export const tapAllowed = (lastAt, now, gap = TAP_GAP_MS) => now - lastAt >= gap;

/** The tap with its pitch jittered, so repeated taps never sound identical. */
export const tapRecipe = (random = Math.random) => jitterCue(SFX.tap, random).recipe;

/** Volume for a spend or sale: grows with the amount and is capped at full. */
export function spendScale(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, 0.45 + Math.log10(1 + n) * 0.22);
}

// Only real controls tap. Text entry, disabled controls and anything aria-disabled stay silent.
export const TAP_SELECTOR = 'button, [role=button], [role=tab], .cat-button';
/** The cue a control makes: tabs and cat choices have their own, everything else taps. */
export const tapKind = control => (control?.getAttribute?.('role') === 'tab' ? 'tab' : control?.matches?.('.cat-button') ? 'select' : 'tap');
const SOUNDLESS_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file']);
export function tapEligible({tag = '', type = '', disabled = false, ariaDisabled = false, editable = false} = {}) {
  if (disabled || ariaDisabled || editable) return false;
  const name = String(tag).toUpperCase();
  if (name === 'TEXTAREA' || name === 'SELECT') return false;
  if (name === 'INPUT' && !SOUNDLESS_INPUTS.has(String(type).toLowerCase())) return false;
  return true;
}

function controlFacts(el) {
  return {
    tag: el.tagName,
    type: el.getAttribute?.('type') ?? el.type ?? '',
    disabled: el.matches?.(':disabled') ?? !!el.disabled,
    ariaDisabled: el.getAttribute?.('aria-disabled') === 'true',
    editable: !!el.isContentEditable,
  };
}

/**
 * One note's gain envelope: a linear attack, a short hold, an exponential fall to -40 dB, then a linear ramp to true
 * zero. The oscillator stops after that, so no note ever ends mid-level (a click).
 */
function envelope(param, start, attack, peak, end) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  if (peak <= 0) return;
  param.setValueAtTime(peak, start + attack + (end - start - attack) * 0.2);
  param.exponentialRampToValueAtTime(peak * 0.01, end);
  param.linearRampToValueAtTime(0, end + RELEASE_S);
}
const RELEASE_S = 0.03;

/** Schedules one recipe on a Web Audio destination. Pure data in, nodes out, so the audio graph is the only browser part. */
function scheduleRecipe(ctx, dest, recipe, t0) {
  for (const note of recipe) {
    const start = t0 + note.start, end = start + note.dur, attack = Math.min(note.attack ?? 0.008, note.dur * 0.5);
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = note.wave;
    osc.frequency.setValueAtTime(note.from, start);
    if (note.to !== note.from) osc.frequency.exponentialRampToValueAtTime(note.to, end);
    envelope(gain.gain, start, attack, note.peak, end);
    osc.connect(gain).connect(dest);
    osc.start(start);
    osc.stop(end + RELEASE_S + 0.02);
    // partial: one [ratio, amount] pair, or a list of them. Higher partials die sooner, like a struck bell.
    const partials = !note.partial ? [] : Array.isArray(note.partial[0]) ? note.partial : [note.partial];
    for (const [ratio, amount] of partials) {
      const high = ctx.createOscillator(), highGain = ctx.createGain(), highEnd = start + attack + (note.dur - attack) * 0.8;
      high.type = 'sine';
      high.frequency.setValueAtTime(note.from * ratio, start);
      envelope(highGain.gain, start, attack, note.peak * amount, highEnd);
      high.connect(highGain).connect(dest);
      high.start(start);
      high.stop(highEnd + RELEASE_S + 0.02);
    }
  }
}

/** Generative music: scheduled a little ahead, so the JavaScript timer never has to be exact. */
class Music {
  constructor(ctx, bus, nature, rng) {
    this.ctx = ctx;
    this.bus = bus;
    this.nature = nature;
    this.rng = rng;
    this.nextBeat = ctx.currentTime + 0.4;
    this.beat = 0;
    this.progression = nextProgression(rng, null);
    this.index = 3;
    this.nextBird = ctx.currentTime + 2;
    this.nextCricket = ctx.currentTime + 1;
  }
  tick(horizon, night) {
    while (this.nextBeat < horizon) {
      this.step(this.nextBeat, night);
      this.nextBeat += BEAT;
    }
  }
  step(t, night) {
    const inChord = this.beat % BEATS_PER_CHORD;
    if (inChord === 0) {
      if (this.beat > 0 && this.beat % (BEATS_PER_CHORD * this.progression.length) === 0) this.progression = nextProgression(this.rng, this.progression);
      this.pad(t, PADS[this.progression[(this.beat / BEATS_PER_CHORD) % this.progression.length]]);
    }
    // Beats 0 and 4 of each chord carry no melody, so the phrases breathe.
    if (inChord !== 0 && inChord !== 4 && this.rng() < 0.5) {
      const index = nextMelodyIndex(this.rng, this.index);
      if (index >= 0) {
        this.index = index;
        this.note(t, MELODY[index], 0.1 + this.rng() * 0.08, 0.3 + this.rng() * 0.2);
      }
    }
    this.beat++;
  }
  pad(t, chord) {
    const ctx = this.ctx, span = BEAT * BEATS_PER_CHORD;
    for (const midi of chord) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(mtof(midi), t);
      osc.detune.setValueAtTime((this.rng() - 0.5) * 8, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.05, t + 2.5);
      gain.gain.setTargetAtTime(0, t + span, 0.9);
      osc.connect(gain).connect(this.bus);
      osc.start(t);
      osc.stop(t + span + 5);
    }
  }
  note(t, midi, velocity, length) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(mtof(midi), t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity, t + 0.015);
    gain.gain.setTargetAtTime(0, t + length, 0.5);
    osc.connect(gain).connect(this.bus);
    osc.start(t);
    osc.stop(t + length + 3);
  }
  natureTick(horizon, night) {
    while (this.nextBird < horizon) {
      if (!night) this.bird(this.nextBird);
      this.nextBird += 2 + this.rng() * 4;
    }
    while (this.nextCricket < horizon) {
      if (night) this.cricket(this.nextCricket);
      this.nextCricket += 2.5 + this.rng() * 1.5;
    }
  }
  bird(t) {
    const ctx = this.ctx, chirps = 2 + Math.floor(this.rng() * 2), base = 2400 + this.rng() * 1200;
    for (let i = 0; i < chirps; i++) {
      const start = t + i * (0.13 + this.rng() * 0.05);
      scheduleRecipe(ctx, this.nature, [{wave: 'sine', from: base, to: base * 1.3, start: start - t, dur: 0.09, peak: 0.035, attack: 0.01}], t);
    }
  }
  cricket(t) {
    const ctx = this.ctx;
    const burst = ctx.createOscillator(), gain = ctx.createGain(), filter = ctx.createBiquadFilter();
    burst.type = 'square';
    burst.frequency.setValueAtTime(4600, t);
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(4600, t);
    filter.Q.setValueAtTime(8, t);
    gain.gain.setValueAtTime(0, t);
    for (let i = 0; i < 6; i++) {
      const on = t + i * 0.1;
      gain.gain.setValueAtTime(0.012, on);
      gain.gain.setValueAtTime(0, on + 0.045);
    }
    burst.connect(filter).connect(gain).connect(this.nature);
    burst.start(t);
    burst.stop(t + 0.7);
  }
}

/** Space music, scheduled ahead like Music: chords every 14 s, shimmers every 3 to 7 s, a bell every 9 to 20 s. */
export class SpaceMusic {
  constructor(ctx, bus, reverb, rng) {
    this.ctx = ctx;
    this.bus = bus;
    this.reverb = reverb;
    this.rng = rng;
    this.nextChord = ctx.currentTime + 0.2;
    this.chord = nextSpaceIndex(rng, -1);
    this.nextShimmer = ctx.currentTime + 2;
    this.nextBell = ctx.currentTime + 6 + rng() * 4;
    this.bell = -1;
  }
  tick(horizon) {
    while (this.nextChord < horizon) {
      this.pad(this.nextChord, SPACE_CHORDS[this.chord]);
      this.chord = nextSpaceIndex(this.rng, this.chord);
      this.nextChord += SPACE_CHORD_S;
    }
    while (this.nextShimmer < horizon) {
      this.shimmer(this.nextShimmer, SPACE_CHORDS[this.chord]);
      this.nextShimmer += 3 + this.rng() * 4;
    }
    while (this.nextBell < horizon) {
      this.ring(this.nextBell);
      this.nextBell += nextBellGap(this.rng);
    }
  }
  pad(t, chord) {
    const ctx = this.ctx, end = t + SPACE_CHORD_S;
    const tone = ctx.createBiquadFilter(), swell = ctx.createGain(), send = ctx.createGain();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(1100, t);
    swell.gain.setValueAtTime(0, t);
    swell.gain.linearRampToValueAtTime(1, t + 5);
    swell.gain.setTargetAtTime(0, end, 1.6);
    send.gain.setValueAtTime(0.8, t);
    tone.connect(swell);
    swell.connect(this.bus);
    swell.connect(send).connect(this.reverb);
    for (const midi of chord) {
      for (const detune of [-5, 5]) {
        const osc = ctx.createOscillator(), level = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(mtof(midi), t);
        osc.detune.setValueAtTime(detune + (this.rng() - 0.5) * 4, t);
        level.gain.setValueAtTime(0.018, t);
        osc.connect(level).connect(tone);
        osc.start(t);
        osc.stop(end + 9);
      }
    }
  }
  shimmer(t, chord) {
    const ctx = this.ctx, octave = [24, 31][Math.floor(this.rng() * 2)];
    const midi = chord[Math.floor(this.rng() * chord.length)] + octave;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(mtof(midi), t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.008, t + 2);
    gain.gain.setTargetAtTime(0, t + 2.5, 0.8);
    osc.connect(gain);
    gain.connect(this.bus);
    gain.connect(this.reverb);
    osc.start(t);
    osc.stop(t + 7);
  }
  ring(t) {
    const ctx = this.ctx;
    this.bell = nextBellIndex(this.rng, this.bell);
    const base = mtof(SPACE_BELLS[this.bell]);
    const body = ctx.createOscillator(), overtone = ctx.createOscillator(), overGain = ctx.createGain();
    const gain = ctx.createGain(), dry = ctx.createGain();
    body.type = 'sine';
    overtone.type = 'sine';
    body.frequency.setValueAtTime(base, t);
    overtone.frequency.setValueAtTime(base * 2.01, t);
    overGain.gain.setValueAtTime(0.25, t);
    dry.gain.setValueAtTime(0.4, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.05, t + 0.02);
    gain.gain.setTargetAtTime(0, t + 0.4, 2.2);
    body.connect(gain);
    overtone.connect(overGain).connect(gain);
    gain.connect(dry).connect(this.bus);
    gain.connect(this.reverb);
    body.start(t);
    overtone.start(t);
    body.stop(t + 9);
    overtone.stop(t + 9);
  }
}

// Cinematic sounds. The cinematics (intro-cinematic.js, construction.js, world-travel.js) never hold the audio
// controller: they dispatch window 'sfx' events through sfx() and the controller plays them on the effects bus, so
// effects volume and mute apply. Each event name has one plan: its group (a later {stops: group} event fades that
// group out), an optional low-pass, and the notes it schedules.
/** Fires one cinematic sound. detail.set names a sound set (one building site); see sfxGate. */
export const sfx = (name, detail = {}, win = globalThis) => win.dispatchEvent?.(new CustomEvent('sfx', {detail: {...detail, name}}));

/** Two notes up then down, like a short meow. pitch scales both. */
const meow = (pitch = 1, peak = 0.1) => [
  {wave: 'triangle', from: 620 * pitch, to: 930 * pitch, start: 0, dur: 0.1, peak, attack: 0.012},
  {wave: 'sine', from: 880 * pitch, to: 700 * pitch, start: 0.1, dur: 0.16, peak: peak * 0.8, attack: 0.015, partial: [2, 0.15]},
];
const chord = (notes, {start = 0, dur = 2.4, peak = 0.035, attack = 0.9, wave = 'sine'} = {}) => notes.map(m => ({wave, from: mtof(m), to: mtof(m), start, dur, peak, attack}));
const twinkles = (rng, seconds) => {
  const out = [];
  for (let t = 0.3; t < seconds; t += 0.35 + rng() * 0.5) { const f = mtof(SPACE_BELLS[Math.floor(rng() * SPACE_BELLS.length)] - 12); out.push({wave: 'sine', from: f, to: f * 1.003, start: t, dur: 0.7, peak: 0.018 + rng() * 0.012, attack: 0.02}); }
  return out;
};
/** How long a travel drone may sound if nothing stops it (the travel's own timeout plus its fade). */
export const DRONE_MAX_S = 12;
export const SFX_EVENTS = Object.freeze({
  // The intro: a swell as the letterbox comes in, a whoosh on the glide, a meow per Mayor bubble, sparkles at the
  // treasury and the observatory, a warm resolve at the end. Skip fades the group out.
  'intro-swell': {group: 'intro', play: (p, t) => p.recipe(chord([48, 55, 60, 64], {dur: 2.6, peak: 0.03, attack: 1.1}), t)},
  'intro-whoosh': {group: 'intro', play: (p, t, d) => p.whoosh({from: 240, to: 1300, peak: 0.1, q: 1.1}, t, d.seconds || 3)},
  'intro-chirp': {group: 'intro', play: (p, t) => p.recipe(meow(1 + (p.rng() - 0.5) * 0.08), t)},
  'intro-sparkle': {group: 'intro', play: (p, t) => p.recipe(ZOOM.shimmer, t)},
  'intro-resolve': {group: 'intro', play: (p, t) => { p.recipe(chord([43, 55, 60, 64, 67], {dur: 3.2, peak: 0.035, attack: 0.08}), t); p.recipe(SFX.chime, t + 0.15); }},
  'intro-stop': {stops: 'intro', fade: 0.6},
  // Building: low-passed wooden taps on the Builder's strikes (pitch varied), a creak as the walls rise, a thump and
  // sparkle when the roof lands, a chirp when the new cat hops out. Magic builds shimmer instead of hammering.
  'build-tap': {group: 'build', lowpass: 900, play: (p, t) => { const k = Math.pow(2, (p.rng() * 2 - 1) * 1.5 / 12); p.recipe([{wave: 'triangle', from: 300 * k, to: 230 * k, start: 0, dur: 0.09, peak: 0.16, attack: 0.002, partial: [2.6, 0.25]}], t); }},
  'build-creak': {group: 'build', lowpass: 1300, play: (p, t, d) => p.creak(t, d.seconds || 1.6)},
  'build-roof': {group: 'build', lowpass: 2600, play: (p, t) => { p.recipe([{wave: 'sine', from: 140, to: 58, start: 0, dur: 0.3, peak: 0.2, attack: 0.004}], t); p.recipe(ZOOM.shimmer, t + 0.12); }},
  'build-chirp': {group: 'build', play: (p, t) => p.recipe([...meow(1.25, 0.09), ...meow(1.5, 0.07).map(n => ({...n, start: n.start + 0.22}))], t)},
  'build-shimmer': {group: 'build', play: (p, t) => p.recipe(ZOOM.shimmer.map(n => ({...n, peak: n.peak * 1.2})), t)},
  // World travel: a deep whoosh up off the town, a spacey drone with soft twinkles, a falling whoosh and a chime on landing.
  'travel-out': {group: 'travel', play: (p, t) => { p.whoosh({from: 900, to: 140, peak: 0.2, q: 0.9}, t, 1.1); p.recipe([{wave: 'sine', from: 65, to: 52, start: 0, dur: 1.4, peak: 0.08, attack: 0.5}], t); }},
  'travel-drone': {group: 'travel', lowpass: 2400, play: (p, t) => { p.recipe(chord([33, 40, 45, 52], {dur: DRONE_MAX_S, peak: 0.03, attack: 0.35}), t); p.recipe(twinkles(p.rng, DRONE_MAX_S), t); }},
  'travel-in': {group: 'arrive', stops: 'travel', fade: 0.6, play: (p, t) => p.whoosh({from: 2400, to: 220, peak: 0.16, q: 1.4}, t, 1.1)},
  'travel-land': {group: 'arrive', play: (p, t) => { p.recipe([{wave: 'sine', from: 98, to: 70, start: 0, dur: 0.35, peak: 0.12, attack: 0.01}], t); p.recipe(SFX.chime, t + 0.05); }},
  'travel-stop': {stops: 'travel', fade: 0.4},
});

/** Seconds a sound set keeps the voice after its last sound. */
export const SFX_SET_HOLD_MS = 2500;
/**
 * One construction sound set at a time: an event with detail.set plays only when no other set has sounded in the last
 * hold ms, so many builds at once never stack. Events without a set always play. Pure: returns {ok, gate}.
 */
export function sfxGate(gate, detail, now, hold = SFX_SET_HOLD_MS) {
  const set = detail?.set;
  if (set === undefined || set === null) return {ok: true, gate};
  if (gate && gate.set !== set && now < gate.until) return {ok: false, gate};
  return {ok: true, gate: {set, until: now + hold}};
}

/** Highs the effects and interface buses let through. Per-cue tone (CUES.lp) shapes them further. */
export const EFFECTS_LOWPASS_HZ = 9000;
/** Interface cues sit about 10 dB under the music. MEASURED: the music peaks near -22 dBFS over a run and near -28 dBFS in a typical second at default settings (n=2 seeds, about 25 s each, real AudioContext in headless Chrome). At the default Interface sounds slider a tap peaks near -39 dBFS, toggles and sheets near -32 to -39, and the loudest cues (success, quest) near -28 (OfflineAudioContext, one render per cue, jitter off). 0.08 left a tap 20 dB under the music, too faint on phone speakers. The slider is the knob. */
export const UI_BUS_GAIN = 0.25;
export const LIMITER = Object.freeze({threshold: -12, knee: 10, ratio: 4, attack: 0.004, release: 0.18});

/**
 * The output stage, shared by the live graph and the offline renderer: effects and interface buses, one low-pass,
 * a master gain, then a compressor so stacked sounds can never clip the destination.
 */
export function buildOutput(ctx) {
  const t = ctx.currentTime;
  const master = ctx.createGain(), effects = ctx.createGain(), ui = ctx.createGain(), tone = ctx.createBiquadFilter(), limiter = ctx.createDynamicsCompressor();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(EFFECTS_LOWPASS_HZ, t);
  for (const [name, value] of Object.entries(LIMITER)) limiter[name]?.setValueAtTime?.(value, t);
  effects.connect(tone);
  ui.connect(tone);
  tone.connect(master);
  master.connect(limiter).connect(ctx.destination);
  return {master, effects, ui, tone, limiter};
}

/** Starts one cue on the effects or interface bus: jittered notes into a gain, then the cue's own low-pass. Returns its nodes, to disconnect later. */
function startCue(ctx, buses, kind, recipe, scale, random, t0) {
  const cue = CUES[kind] ?? {cooldown: 0}, jittered = jitterCue(recipe, random), out = ctx.createGain(), nodes = [out];
  out.gain.setValueAtTime(Math.max(0, Math.min(1, scale)) * jittered.gain, ctx.currentTime);
  const bus = cue.ui ? buses.ui : buses.effects;
  if (cue.lp) {
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(cue.lp, ctx.currentTime);
    out.connect(tone).connect(bus);
    nodes.push(tone);
  } else out.connect(bus);
  scheduleRecipe(ctx, out, jittered.recipe, t0);
  return nodes;
}

/**
 * Test and listening hook: schedules one cue into any context (an OfflineAudioContext, for the WAV renders) through the same
 * output stage and cue chain the page uses, at the given settings. Deterministic with the default random.
 */
export function renderCue(ctx, kind, {settings = DEFAULTS, random = () => 0.5, at = 0.02} = {}) {
  const out = buildOutput(ctx), g = busGains({...settings, muted: false}), t = ctx.currentTime;
  out.master.gain.setValueAtTime(g.master, t);
  out.effects.gain.setValueAtTime(g.effects, t);
  out.ui.gain.setValueAtTime(g.ui, t);
  startCue(ctx, out, kind, SFX[kind], 1, random, at);
  return Math.max(...SFX[kind].map(n => n.start + n.dur)) + 0.1;
}

/**
 * The browser controller. Nothing starts until unlock(), which must run from a user gesture.
 * Options are injectable so the wiring can be exercised without a real page.
 */
export function createAudio({storage = null, win = null, doc = null, AudioContextClass = null, seed = Date.now() >>> 0, now: clock = () => Date.now(), random = Math.random, nav = win?.navigator ?? null, schedule = (fn, ms) => setTimeout(fn, ms), cancel = t => clearTimeout(t)} = {}) {
  const reducedMotion = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  let settings = loadSettings(storage, {quiet: reducedMotion});
  let ctx = null, buses = null, fades = null, reverb = null, music = null, space = null, timer = null, night = false, unlocked = false, rngSeed = seed;
  // memorial: the Memorial is open. current: the track whose fade is up (null before the first start).
  let memorial = false, current = null;
  const nextSeed = () => (rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0);

  const applyGains = () => {
    if (!ctx) return;
    const g = busGains(settings), now = ctx.currentTime;
    buses.master.gain.setTargetAtTime(g.master, now, 0.05);
    buses.music.gain.setTargetAtTime(g.music, now, 0.05);
    buses.space.gain.setTargetAtTime(g.music, now, 0.05);
    buses.nature.gain.setTargetAtTime(g.nature, now, 0.05);
    buses.effects.gain.setTargetAtTime(g.effects, now, 0.05);
    buses.ui.gain.setTargetAtTime(g.ui, now, 0.05);
    if (settings.music === 0 || settings.master === 0 || settings.muted) stopMusic();
    else if (unlocked && !doc?.hidden) { startMusic(); applyTrack(); }
  };

  const tick = () => {
    timer = null;
    if ((!music && !space) || !ctx) return;
    // Still resuming (or suspended while hidden): poll cheaply until the context runs, then schedule.
    if (ctx.state !== 'running') {
      timer = schedule(tick, 250);
      return;
    }
    const horizon = ctx.currentTime + 2.5;
    music?.tick(horizon, night);
    music?.natureTick(horizon, night);
    space?.tick(horizon);
    timer = schedule(tick, 250);
  };

  // Effects sound only when unlocked, running and not muted or turned down; each effect gets its own gain into the effects bus.
  const audible = (ui = false) => !!ctx && unlocked && !settings.muted && settings.master !== 0 && (ui ? settings.interface : settings.effects) !== 0 && ctx.state === 'running';
  const lastCue = new Map();
  const effectOut = () => { const out = ctx.createGain(); out.connect(buses.effects); return out; };

  // World travel plays the space track for its flight, whatever the Memorial setting.
  let travelling = false;
  const wanted = () => (travelling ? TRACK_SPACE : wantedTrack({memorial, memorialMusic: settings.memorialMusic}));

  // Fades to the wanted track. The steps come from crossfadePlan; this only turns them into gain ramps and generators.
  function applyTrack() {
    if (!ctx || !unlocked) return;
    const next = wanted();
    if (next === current) return;
    const now = ctx.currentTime, plan = crossfadePlan(current, next);
    for (const name of [TRACK_TOWN, TRACK_SPACE]) {
      const step = plan.find(s => s.track === name) ?? {track: name, to: name === next ? 1 : 0, seconds: 0};
      const gain = fades[name].gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(step.to, now + step.seconds);
    }
    if (next === TRACK_TOWN && !music) music = new Music(ctx, buses.music, buses.nature, createRng(nextSeed()));
    if (next === TRACK_SPACE && !space) space = new SpaceMusic(ctx, buses.space, reverb, createRng(nextSeed()));
    current = next;
    // The track that just faded out keeps scheduling until its fade ends, then it goes quiet and is dropped.
    schedule(() => {
      if (current !== TRACK_TOWN) music = null;
      if (current !== TRACK_SPACE) space = null;
    }, (CROSSFADE_S + 0.5) * 1000);
  }

  function startMusic() {
    if (music || space || !ctx || !unlocked) return;
    current = null;
    applyTrack();
    tick();
  }

  function stopMusic() {
    if (timer !== null) cancel(timer);
    timer = null;
    music = null;
    space = null;
    current = null;
  }

  // Ducking: its own gain stage after both music tracks, so it never fights the cinematic duck on the music buses.
  // The music steps down under the chime and comes back over about a second.
  function duck() {
    if (!ctx) return;
    const now = ctx.currentTime, gain = buses.duck.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(DUCK_LEVEL, now, 0.03);
    gain.setTargetAtTime(1, now + 0.9, 0.35);
  }

  // The intro cinematic dispatches cinematic {on}: the music sits lower until it ends.
  function cinematicDuck(on) {
    if (!ctx) return;
    const g = busGains(settings).music, now = ctx.currentTime;
    for (const bus of [buses.music.gain, buses.space.gain]) { bus.cancelScheduledValues(now); bus.setTargetAtTime(on ? g * 0.6 : g, now, 0.4); }
  }
  const onCinematic = event => cinematicDuck(!!event?.detail?.on);

  const onVisibility = () => {
    if (!ctx) return;
    if (doc.hidden) {
      stopMusic();
      ctx.suspend().catch(() => {});
    } else if (unlocked) {
      ctx.resume().then(() => { if (!doc.hidden && settings.music > 0 && !settings.muted) startMusic(); }).catch(() => {});
    }
  };

  const onTownTime = event => { night = isNightTime(event.detail); };

  // memorial-view.js dispatches this when the Memorial opens or closes: the music crossfades, the town pauses (town.js).
  const onMemorialView = event => {
    memorial = event.detail?.open === true;
    if (music || space) applyTrack();
  };
  win?.addEventListener?.('memorial-view', onMemorialView);
  const onWorldTravel = event => {
    travelling = event.detail?.on === true;
    if (music || space) applyTrack();
  };
  win?.addEventListener?.('world-travel', onWorldTravel);

  // Cinematic sounds (SFX_EVENTS). groups: the outputs still sounding per group, so a stop can fade them.
  let gate = null;
  const groups = new Map(), sfxRng = createRng(seed ^ 0x5f5);
  function voice(group, lowpass) {
    const out = ctx.createGain();
    out.gain.setValueAtTime(1, ctx.currentTime);
    if (lowpass) { const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.setValueAtTime(lowpass, ctx.currentTime); out.connect(tone).connect(buses.effects); }
    else out.connect(buses.effects);
    if (group) { if (!groups.has(group)) groups.set(group, new Set()); groups.get(group).add(out); }
    return out;
  }
  function release(group, out, ms) { schedule(() => { out.disconnect?.(); groups.get(group)?.delete(out); }, ms); }
  function stopGroup(group, seconds) {
    const outs = groups.get(group);
    if (!ctx || !outs) return;
    const now = ctx.currentTime;
    for (const out of outs) { out.gain.cancelScheduledValues(now); out.gain.setValueAtTime(out.gain.value, now); out.gain.linearRampToValueAtTime(0, now + seconds); release(group, out, (seconds + 0.1) * 1000); }
  }
  /** Plays one SFX_EVENTS sound. Returns false when nothing sounds (unknown, inaudible, or held back by the set gate). */
  function cinema(detail = {}) {
    const plan = SFX_EVENTS[detail?.name];
    if (!plan) return false;
    if (plan.stops) stopGroup(plan.stops, plan.fade ?? 0.5);
    if (!plan.play || !audible()) return false;
    const passed = sfxGate(gate, detail, ctx.currentTime * 1000);
    if (!passed.ok) return false;
    gate = passed.gate;
    const out = voice(plan.group, plan.lowpass), t0 = ctx.currentTime + 0.01;
    let longest = 1.5;
    const recipe = (notes, t) => { scheduleRecipe(ctx, out, notes, t); longest = Math.max(longest, t - t0 + Math.max(...notes.map(n => n.start + n.dur))); };
    const whoosh = (sweep, t, seconds) => { scheduleWhoosh(ctx, out, sweep, t, seconds); longest = Math.max(longest, t - t0 + seconds); };
    // A creak: a buzzy tone rising with a slow wobble, low-passed so it reads as wood.
    const creak = (t, seconds) => {
      const osc = ctx.createOscillator(), wobble = ctx.createOscillator(), depth = ctx.createGain(), gain = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.setValueAtTime(95, t); osc.frequency.exponentialRampToValueAtTime(170, t + seconds);
      wobble.frequency.setValueAtTime(7, t); depth.gain.setValueAtTime(5, t); wobble.connect(depth).connect(osc.frequency);
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.025, t + 0.15); gain.gain.setTargetAtTime(0, t + seconds * 0.7, seconds * 0.15);
      osc.connect(gain).connect(out); for (const o of [osc, wobble]) { o.start(t); o.stop(t + seconds + 0.3); }
      longest = Math.max(longest, t - t0 + seconds);
    };
    plan.play({recipe, whoosh, creak, rng: sfxRng}, t0, detail);
    release(plan.group, out, (longest + 0.6) * 1000);
    return true;
  }
  const onSfx = event => { cinema(event?.detail); };

  return {
    settings: () => ({...settings}),
    update(patch) {
      settings = saveSettings(storage, patchSettings(settings, patch));
      applyGains();
      return {...settings};
    },
    /** Creates and starts the AudioContext. Call only from a user gesture; later calls are no-ops. */
    unlock() {
      if (unlocked) return true;
      const Ctor = AudioContextClass || win?.AudioContext || win?.webkitAudioContext;
      if (!Ctor) return false;
      ctx = new Ctor();
      if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
      const out = buildOutput(ctx), master = out.master, effects = out.effects, ui = out.ui;
      const musicBus = ctx.createGain(), natureBus = ctx.createGain(), lowpass = ctx.createBiquadFilter();
      const duckStage = ctx.createGain(), townFade = ctx.createGain(), spaceBus = ctx.createGain(), spaceFade = ctx.createGain(), reverbOut = ctx.createGain();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(1400, ctx.currentTime);
      lowpass.Q.setValueAtTime(0.5, ctx.currentTime);
      // A slow drift in the filter keeps the pad from sitting still for long stretches.
      const drift = ctx.createOscillator(), depth = ctx.createGain();
      drift.frequency.setValueAtTime(0.03, ctx.currentTime);
      depth.gain.setValueAtTime(300, ctx.currentTime);
      drift.connect(depth).connect(lowpass.frequency);
      drift.start();
      // Town music and nature share one fade, so birds fall silent with the town track.
      musicBus.connect(lowpass).connect(townFade);
      natureBus.connect(townFade);
      townFade.connect(duckStage);
      // Space has its own bus and reverb, with no 1400 Hz roll-off, so its partials and bells keep their air.
      const rate = ctx.sampleRate || 44100, frames = Math.round(3.5 * rate);
      reverb = ctx.createConvolver();
      const impulse = ctx.createBuffer(2, frames, rate);
      for (let channel = 0; channel < 2; channel++) impulse.getChannelData(channel).set(impulseSamples(createRng(0x5eed + channel), frames));
      reverb.buffer = impulse;
      reverb.connect(reverbOut).connect(spaceBus);
      spaceBus.connect(spaceFade).connect(duckStage);
      duckStage.connect(master);
      buses = {master, duck: duckStage, music: musicBus, nature: natureBus, effects, ui, space: spaceBus};
      fades = {[TRACK_TOWN]: townFade, [TRACK_SPACE]: spaceFade};
      unlocked = true;
      applyGains();
      if (doc?.hidden) onVisibility();
      if (win) {
        win.addEventListener('town-time', onTownTime);
        win.addEventListener('cinematic', onCinematic);
        win.addEventListener('sfx', onSfx);
        doc?.addEventListener('visibilitychange', onVisibility);
      }
      return true;
    },
    /** Plays one cinematic sound by its SFX_EVENTS name (what the window 'sfx' event does). */
    cinema,
    /**
     * Plays one synthesised effect at a scale of 0 to 1, with its own cooldown and a little pitch and gain jitter. Returns
     * false when nothing sounds (silent, unknown, quiet, or too soon after the last one), so callers can skip work.
     */
    play(kind, scale = 1, recipe = SFX[kind]) {
      const cue = CUES[kind] ?? {cooldown: 0};
      if (!recipe || !audible(cue.ui)) return false;
      // Quiet keeps decision chimes and nothing else.
      if (settings.quiet && kind !== 'chime') return false;
      const at = clock();
      if (!cueAllowed(lastCue.get(kind) ?? -Infinity, at, cue.cooldown)) return false;
      lastCue.set(kind, at);
      // Only the chime, a decision for the owner, ducks the music; chat chirps, coins and taps never do.
      if (cue.duck) duck();
      const nodes = startCue(ctx, buses, kind, recipe, scale, random, ctx.currentTime + 0.01);
      schedule(() => nodes.forEach(n => n.disconnect?.()), 1500);
      return true;
    },
    /** The Memorial zoom in, timed to a camera flight of `seconds`: a rising whoosh, then shimmer and chime as the sky opens. */
    zoomIn(seconds = 1.1) {
      if (!audible()) return false;
      const out = effectOut(), t0 = ctx.currentTime + 0.01;
      scheduleWhoosh(ctx, out, ZOOM.in, t0, seconds);
      scheduleRecipe(ctx, out, ZOOM.shimmer, t0 + seconds - 0.05);
      scheduleRecipe(ctx, out, SFX.chime, t0 + seconds + 0.12);
      schedule(() => out.disconnect?.(), (seconds + 2) * 1000);
      return true;
    },
    /** The Memorial zoom out: a falling whoosh over the camera's `seconds` back to the town. */
    zoomOut(seconds = 1.1) {
      if (!audible()) return false;
      const out = effectOut();
      scheduleWhoosh(ctx, out, ZOOM.out, ctx.currentTime + 0.01, seconds);
      schedule(() => out.disconnect?.(), (seconds + 0.5) * 1000);
      return true;
    },
    /**
     * A short buzz for a tap, only when the owner turned "Vibrate on tap" on, the page is visible and this device has a vibrator
     * (iOS and most desktops have none, so there it does nothing). Needs no audio unlock. Returns whether it buzzed.
     */
    haptic() {
      if (!settings.vibrate || doc?.hidden || typeof nav?.vibrate !== 'function') return false;
      try { return nav.vibrate(HAPTIC_MS) === true; } catch { return false; }
    },
    /** A button tap, pitch-varied. Callers apply the rate limit with tapAllowed. */
    tap() {
      return this.play('tap');
    },
    /** Totals from one season batch: one spend sound, then a sale's coin tinkle a moment later. */
    announceSpend(totals) {
      const spent = Number(totals?.spent) || 0, earned = Number(totals?.earned) || 0;
      if (spent <= 0 && earned <= 0) return false;
      if (spent > 0) this.play('spend', spendScale(spent));
      if (earned > 0) schedule(() => this.play('coin', spendScale(earned)), spent > 0 ? 220 : 0);
      return true;
    },
    /** Maps town-state changes to sounds. Used by notify.js, which passes its own diff. */
    announce(prev, next) {
      const diff = diffTownState(prev, next);
      if (diff.baseline) return;
      if (diff.approvals.length) this.play('chime');
      else if (diff.messages.some(isMayorToOwner)) this.play('chime');
      else if (diff.messages.some(isCatChat)) this.play('chirp');
    },
    get state() { return ctx ? ctx.state : 'none'; },
    dispose() {
      stopMusic();
      win?.removeEventListener?.('town-time', onTownTime);
      win?.removeEventListener?.('memorial-view', onMemorialView);
      win?.removeEventListener?.('world-travel', onWorldTravel);
      win?.removeEventListener?.('sfx', onSfx);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      ctx?.close?.().catch?.(() => {});
    },
  };
}

/**
 * Wires the page's clicks and the season feed to the controller. One capture listener on the document covers every
 * button. The season feed is its own EventSource on /api/events?only=season (main and paired remote), retried if the browser gives up.
 */
export function attachUiSounds({win = null, doc = null, audio, EventSourceClass = win?.EventSource, url = '/api/events?only=season', now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms)}) {
  let lastTap = -Infinity;
  const press = event => {
    const control = event.target?.closest?.(TAP_SELECTOR);
    if (!control || !tapEligible(controlFacts(control))) return;
    const at = now();
    if (!tapAllowed(lastTap, at)) return;
    lastTap = at;
    audio.haptic?.();
    audio.play(tapKind(control));
  };
  // A tap sounds the moment the finger or button goes down, not when it is released. Keyboard activation (Enter or Space)
  // arrives as a click with no pointer (detail 0), so it still sounds; a click that follows a pointerdown (detail 1 or more) does not.
  const onPointerDown = event => { if (event.pointerType === 'mouse' && event.button > 0) return; press(event); };
  const onClick = event => { if (event.detail === 0) press(event); };
  doc?.addEventListener('pointerdown', onPointerDown, true);
  doc?.addEventListener('click', onClick, true);

  let source = null, stopped = false;
  const connect = () => {
    if (stopped || !EventSourceClass) return;
    source = new EventSourceClass(url);
    source.addEventListener('season', event => {
      try { audio.announceSpend(JSON.parse(event.data)); } catch { /* a malformed frame makes no sound */ }
    });
    // A closed stream (for example a 401 before pairing) never reconnects by itself, so try again later.
    source.onerror = () => { if (source.readyState === 2) schedule(connect, 15000); };
  };
  connect();

  return {
    dispose() {
      stopped = true;
      doc?.removeEventListener?.('pointerdown', onPointerDown, true);
      doc?.removeEventListener?.('click', onClick, true);
      source?.close?.();
    },
  };
}

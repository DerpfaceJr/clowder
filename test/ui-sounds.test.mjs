import test from 'node:test';
import assert from 'node:assert/strict';
import {SFX, SFX_KINDS, CUES} from '../public/audio.js';
import {installUiSounds, sheetCue, uiSound} from '../public/ui-sounds.js';

const element = (selectors, attrs = {}, extra = {}) => ({
  matches: q => q.split(',').some(part => selectors.includes(part.trim())),
  hasAttribute: n => n in attrs,
  getAttribute: n => (n in attrs ? attrs[n] : null),
  ...extra,
});
const sheet = attrs => element(['dialog', 'aside.panel', '.town-menu', '[role=dialog]'], attrs);

test('every cue is tuned to C major pentatonic (its fundamentals sit on C D E G A, within a tenth of a semitone)', () => {
  const pentatonic = new Set([0, 2, 4, 7, 9]);
  for (const kind of SFX_KINDS) {
    for (const note of SFX[kind]) {
      const midi = 69 + 12 * Math.log2(note.from / 440), nearest = Math.round(midi);
      assert.ok(Math.abs(midi - nearest) < 0.1 && pentatonic.has(((nearest % 12) + 12) % 12), `${kind} ${note.from} Hz is midi ${midi.toFixed(2)}`);
    }
  }
});

test('every cue has a recipe, a cooldown and tails of 400 ms or less (the decision chime keeps its long ring)', () => {
  assert.deepEqual(Object.keys(CUES).sort(), [...SFX_KINDS].sort());
  for (const kind of SFX_KINDS) {
    assert.ok(CUES[kind].cooldown > 0, kind);
    if (kind !== 'chime') assert.ok(SFX[kind].every(n => n.dur <= 0.4 + 1e-9), `${kind} has a note longer than 400 ms`);
  }
  assert.equal('yawn' in SFX, false, 'the dead yawn cue is gone');
});

test('a dialog or panel opening or closing is one cue; other elements and unchanged states are silent', () => {
  assert.equal(sheetCue(sheet({open: ''}), 'open', null), 'open');
  assert.equal(sheetCue(sheet({}), 'open', ''), 'close');
  assert.equal(sheetCue(sheet({open: ''}), 'open', ''), null, 'already open');
  assert.equal(sheetCue(sheet({}), 'hidden', ''), 'open', 'hidden removed');
  assert.equal(sheetCue(sheet({hidden: ''}), 'hidden', null), 'close', 'hidden added');
  assert.equal(sheetCue(sheet({hidden: ''}), 'hidden', ''), null);
  assert.equal(sheetCue(element([], {hidden: ''}), 'hidden', null), null, 'a list item hiding is not a sheet');
});

test('the watchers sound toggles, one cue per batch of sheet changes, and a quest marked done', () => {
  const played = [], audio = {play: kind => played.push(kind)};
  const listeners = {};
  const doc = {documentElement: {}, addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {}};
  let callback = null;
  class FakeObserver { constructor(fn) { callback = fn; } observe(target, options) { this.options = options; } disconnect() { this.gone = true; } }
  const watch = installUiSounds({doc, audio, MutationObserverClass: FakeObserver});
  const box = (checked, type = 'checkbox') => ({type, checked, matches: q => q.includes(`input[type=${type}]`)});
  listeners.change({target: box(true)});
  listeners.change({target: box(false)});
  listeners.change({target: box(false, 'radio')});
  listeners.change({target: box(true, 'radio')});
  listeners.change({target: {type: 'range', matches: () => false}});
  assert.deepEqual(played.splice(0), ['toggleOn', 'toggleOff', 'toggleOn']);
  callback([{target: sheet({hidden: ''}), attributeName: 'hidden', oldValue: null}, {target: sheet({}), attributeName: 'hidden', oldValue: ''}]);
  callback([{target: sheet({}), attributeName: 'hidden', oldValue: ''}]);
  callback([{target: sheet({hidden: ''}), attributeName: 'hidden', oldValue: null}]);
  callback([{target: element([], {}), attributeName: 'hidden', oldValue: null}]);
  assert.deepEqual(played.splice(0), ['open', 'open', 'close'], 'open wins a mixed batch; unrelated changes are silent');
  const switchOn = element(['[role=switch]'], {'aria-checked': 'true'});
  callback([{target: switchOn, attributeName: 'aria-checked', oldValue: 'false'}]);
  assert.deepEqual(played.splice(0), ['toggleOn']);
  const quest = text => ({closest: () => ({textContent: text})});
  listeners.click({target: quest('Mark done')});
  listeners.click({target: quest('Open chat')});
  assert.deepEqual(played.splice(0), ['quest']);
  watch.dispose();
});

test('uiSound is a safe no-op before sound starts, and plays through the installed controller afterwards', () => {
  assert.equal(uiSound('send'), false);
  const played = [];
  const watch = installUiSounds({doc: null, audio: {play: kind => { played.push(kind); return true; }}});
  assert.equal(uiSound('send'), true);
  assert.deepEqual(played, ['send']);
  watch.dispose();
  assert.equal(uiSound('send'), false, 'disposed');
});

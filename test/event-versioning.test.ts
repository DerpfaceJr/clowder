// Event versioning (plan 7.4), on copies of the golden journal: an older version upcasts in memory, an unknown type or a newer v is kept,
// counted and not applied, the journal is never rewritten, and every type this build writes is one it knows.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EVENT_TYPES, Store, UPCAST} from '../src/store.ts';
import {ReadModel} from '../src/read-model.ts';
import {stateHash} from './fixtures/golden/state-hash.ts';

const GOLDEN = new URL('./fixtures/golden/', import.meta.url);
const goldenText = readFileSync(new URL('events.jsonl', GOLDEN), 'utf8');
const goldenHash = readFileSync(new URL('state.sha256', GOLDEN), 'utf8').trim();
const goldenCount = goldenText.split('\n').filter(Boolean).length;
const line = (id: string, type: string, data: unknown, v?: number) => JSON.stringify({id, at: '2026-01-01T00:00:00.000Z', type, ...(v ? {v} : {}), data}) + '\n';

function withCopy(fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'event-versioning-'));
  try {
    const file = join(dir, 'events.jsonl');
    copyFileSync(new URL('events.jsonl', GOLDEN), file);
    fn(file);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
// The golden state with the test's own lines taken back out of state.events, so the rest compares with the frozen hash.
const restHash = (state: any) => stateHash({...Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'unknown')), events: state.events.slice(0, goldenCount)});

test('the golden journal replays with no unknown events and no v field, and its hash is unchanged', () => {
  withCopy(file => {
    const store = new Store(file, []);
    assert.equal(store.state.unknown, undefined);
    assert.equal(stateHash(store.state), goldenHash);
    assert.ok(!goldenText.includes('"v":'), 'every golden line is v1 by omission');
  });
});

test('an unknown type and a newer v are kept, counted in state.unknown, not applied, and the town opens', () => {
  withCopy(file => {
    const paused = new Store(file, []).state.paused;
    const extra = line('future-type', 'garden.planted', {id: 'x'}) + line('future-v', 'paused', {value: !paused, why: 'v9'}, 9);
    appendFileSync(file, extra);
    const store = new Store(file, []);
    assert.deepEqual(store.state.unknown, {'garden.planted': 1, paused: 1});
    assert.equal(store.state.paused, paused, 'the v9 paused event is never half-applied');
    assert.deepEqual(store.state.events.slice(-2).map(e => e.id), ['future-type', 'future-v'], 'both stay in state.events');
    assert.equal(store.state.events.at(-1)!.v, 9, 'untouched');
    assert.equal(restHash(store.state), goldenHash, 'nothing else moved');
    assert.equal(readFileSync(file, 'utf8'), goldenText + extra, 'the journal is never rewritten');
  });
});

test('a v1 line upcasts in memory to the version this build knows, and emit writes v only above 1', () => {
  // A throwaway upcaster: paused v1 {value} becomes v2 {value, by}. The real table ships empty, so no journal changes shape.
  UPCAST['paused@1'] = (d: any) => ({...d, by: 'upcast'});
  try {
    withCopy(file => {
      appendFileSync(file, line('old-paused', 'paused', {value: true}) + line('new-paused', 'paused', {value: false, by: 'v2'}, 2) + line('newer-paused', 'paused', {value: true}, 3));
      const before = readFileSync(file, 'utf8');
      const store = new Store(file, []);
      const [oldP, newP] = store.state.events.filter(e => e.id === 'old-paused' || e.id === 'new-paused');
      assert.deepEqual([oldP!.v, oldP!.data], [2, {value: true, by: 'upcast'}], 'the v1 line is read as v2');
      assert.deepEqual(newP!.data, {value: false, by: 'v2'}, 'a v2 line is applied as it is');
      assert.equal(store.state.paused, false, 'v1 then v2 applied; the v3 line is not');
      assert.deepEqual(store.state.unknown, {paused: 1});
      assert.equal(readFileSync(file, 'utf8'), before, 'upcasting never rewrites the journal');
      store.emit('paused', {value: true, by: 'owner'});
      assert.equal(JSON.parse(readFileSync(file, 'utf8').trimEnd().split('\n').at(-1)!).v, 2);
      store.emit('message', {from: 'mayor', to: 'mayor', text: 'hi'});
      assert.ok(!('v' in JSON.parse(readFileSync(file, 'utf8').trimEnd().split('\n').at(-1)!)), 'a v1 type writes no v');
    });
  } finally {
    delete UPCAST['paused@1'];
  }
});

test('the read-model fingerprint changes with the upcaster table and the known types, so a snapshot from other rules is never loaded', () => {
  const fp = () => ReadModel.fingerprint(Store.replayCode());
  const base = fp();
  UPCAST['paused@1'] = (d: any) => d;
  try { assert.notEqual(fp(), base); } finally { delete UPCAST['paused@1']; }
  EVENT_TYPES.add('garden.planted');
  try { assert.notEqual(fp(), base); } finally { EVENT_TYPES.delete('garden.planted'); }
  assert.equal(fp(), base);
});

test('every event type this build writes or applies is in EVENT_TYPES, so none of its own events count as unknown', () => {
  const dir = new URL('../src/', import.meta.url), found = new Set<string>();
  for (const name of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const body = readFileSync(new URL(name, dir), 'utf8');
    // The literals in an emit's or a journal write's first argument (a ternary gives two), and apply()'s type checks (other files' e.type checks read other journals).
    for (const m of body.matchAll(/\b(?:emit|journal)\(\s*([^,()]*?),/g)) for (const t of m[1]!.matchAll(/['"`]([a-z][a-z.-]*)['"`]/g)) found.add(t[1]!);
    if (name === 'store.ts') for (const m of body.matchAll(/e\.type===['"]([^'"]+)['"]/g)) found.add(m[1]!);
  }
  for (const s of ['done', 'failed', 'unknown']) found.add(`effect.${s}`);
  assert.ok(found.size >= 60, `found ${found.size} types; the scan found too few`);
  assert.deepEqual([...found].filter(t => !EVENT_TYPES.has(t)), []);
});

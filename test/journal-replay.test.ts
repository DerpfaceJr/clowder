// Replay hardening (plan 7.3), on copies of the golden journal: a torn last line is moved aside and the town opens, a bad middle line
// still fails closed and names the line, and an update for a record that is not there is skipped and counted instead of throwing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {stateHash} from './fixtures/golden/state-hash.ts';

const GOLDEN = new URL('./fixtures/golden/', import.meta.url);
const goldenText = readFileSync(new URL('events.jsonl', GOLDEN), 'utf8');
const goldenHash = readFileSync(new URL('state.sha256', GOLDEN), 'utf8').trim();

function withCopy(fn: (file: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-replay-'));
  try {
    const file = join(dir, 'events.jsonl');
    copyFileSync(new URL('events.jsonl', GOLDEN), file);
    fn(file, dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
// A Store's state minus the parts a test line itself adds, so the rest can be compared with the golden state.
const without = (state: any, keys: string[]) => Object.fromEntries(Object.entries(state).filter(([k]) => !keys.includes(k)));

test('a torn last line is moved to events.jsonl.torn-<time>, the journal is cut to the last newline, and the town opens with the golden state', () => {
  withCopy((file, dir) => {
    // Cut inside a two-byte character, so the bytes kept aside are not valid UTF-8 on their own.
    const torn = Buffer.concat([Buffer.from('{"id":"x","at":"2026-01-01T00:00:00.000Z","type":"message","data":{"text":"caf'), Buffer.from('\u00e9').subarray(0, 1)]);
    appendFileSync(file, torn);
    const warnings: string[] = [], warn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    let store: Store;
    try { store = new Store(file, []); } finally { console.warn = warn; }
    assert.equal(stateHash(store.state), goldenHash, 'the torn append was never applied');
    assert.equal(readFileSync(file, 'utf8'), goldenText, 'the journal is back to its last complete line');
    const aside = readdirSync(dir).filter(f => f.startsWith('events.jsonl.torn-'));
    assert.equal(aside.length, 1, 'the torn bytes are kept next to the journal');
    assert.deepEqual(readFileSync(join(dir, aside[0]!)), torn, 'byte for byte');
    assert.ok(warnings.some(w => w.includes(aside[0]!)), 'and the move is logged with the file name');
    // The next append starts on a clean line, so the next boot replays everything.
    store.emit('paused', {value: true});
    assert.equal(new Store(file, []).state.paused, true);
  });
});

test('a last line that parses but lost its newline is kept and applied, and gets its newline back', () => {
  withCopy((file, dir) => {
    appendFileSync(file, JSON.stringify({id: 'last', at: '2026-01-01T00:00:00.000Z', type: 'paused', data: {value: true}}));
    const warn = console.warn; console.warn = () => {};
    try { assert.equal(new Store(file, []).state.paused, true); } finally { console.warn = warn; }
    assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
    assert.deepEqual(readdirSync(dir).filter(f => f.includes('.torn-')), [], 'nothing is moved aside');
  });
});

test('a bad middle line still fails closed, naming the line and Restore, and leaves the journal as it was', () => {
  withCopy(file => {
    const lines = goldenText.split('\n');
    // A blank line first: the error names the line in the file, not the count of events before it. The bad line is never quoted.
    lines.splice(3, 0, '');
    lines.splice(5, 0, '{"id":"secret-looking","data":{"token":"abc123"');
    const broken = lines.join('\n');
    writeFileSync(file, broken);
    assert.throws(() => new Store(file, []), (err: Error) => /line 6\b/.test(err.message) && /restore/i.test(err.message) && !err.message.includes('abc123'));
    assert.equal(readFileSync(file, 'utf8'), broken, 'nothing is cut or moved');
  });
});

test('an update for a task, approval, council or cat that is not there is skipped and counted; the rest of the state is the golden one', () => {
  withCopy(file => {
    const orphans: [string, any][] = [
      ['task.updated', {id: 'no-task', status: 'done'}],
      ['approval.resolved', {id: 'no-approval', status: 'approved'}],
      ['council.voted', {id: 'no-council', ballot: {cat: 'mayor', vote: 'keep', reason: ''}}],
      ['council.closed', {id: 'no-council', status: 'retired', result: ''}],
      ['home.styled', {id: 'no-cat', style: 'a', color: '#000', icon: 'x'}],
      ['home.looked', {id: 'no-cat', look: null}],
      ['home.moved', {id: 'no-cat', home: {x: 0, z: 0, style: 'a'}}],
      ['cat.customized', {id: 'no-cat', appearance: {}}],
      ['homes.planned', {homes: [{id: 'no-cat', home: {x: 0, z: 0, style: 'a'}}]}],
    ];
    appendFileSync(file, orphans.map(([type, data], i) => JSON.stringify({id: `orphan-${i}`, at: '2026-01-01T00:00:00.000Z', type, data})).join('\n') + '\n');
    const store = new Store(file, []);
    assert.equal(store.replayed, goldenText.split('\n').filter(Boolean).length + orphans.length);
    assert.equal(Object.values(store.state.skipped ?? {}).reduce((a, b) => a + b, 0), orphans.length, 'each orphan is counted once');
    const cleanFile = join(file, '..', 'golden.jsonl');
    writeFileSync(cleanFile, goldenText);
    const clean = new Store(cleanFile, []);
    assert.equal(stateHash(without(store.state, ['events', 'skipped'])), stateHash(without(clean.state, ['events'])));
  });
});

// The golden journal (plan 7.2): replaying the frozen events gives the frozen state hash, every event type apply() handles is in the
// fixture, and the fixture holds no personal data. Regenerate with `npx tsx test/fixtures/golden/make.ts`.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {stateHash} from './fixtures/golden/state-hash.ts';

const GOLDEN = new URL('./fixtures/golden/', import.meta.url);
const golden = (name: string) => readFileSync(new URL(name, GOLDEN), 'utf8');

// Replays a copy, so the replay never writes into the fixture folder.
function replay() {
  const dir = mkdtempSync(join(tmpdir(), 'golden-replay-'));
  try {
    const file = join(dir, 'events.jsonl');
    copyFileSync(new URL('events.jsonl', GOLDEN), file);
    const store = new Store(file, []);
    return {store, lines: golden('events.jsonl').split('\n').filter(Boolean).length};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

// Every event type apply() handles: the literal `e.type==='x'` checks, and the regex branch for the effect settles.
function appliedTypes(): Set<string> {
  const body = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
  const types = new Set<string>();
  for (const m of body.matchAll(/e\.type===['"]([^'"]+)['"]/g)) types.add(m[1]!);
  const settle = body.match(/\^effect\\\.\(([a-z|]+)\)\$/);
  assert.ok(settle, 'apply() still has the effect.(done|failed|unknown) branch this test reads');
  for (const s of settle[1]!.split('|')) types.add(`effect.${s}`);
  return types;
}

test('replaying the golden journal gives the frozen state hash', () => {
  const {store, lines} = replay();
  assert.equal(store.replayed, lines, 'every line is applied, none skipped');
  assert.equal(stateHash(store.state), golden('state.sha256').trim());
});

test('every event type apply() handles appears in the golden journal', () => {
  const inFixture = new Set(golden('events.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l).type));
  const applied = appliedTypes();
  assert.ok(applied.size >= 40, `apply() handles ${applied.size} types; the scan found too few`);
  const missing = [...applied].filter(t => !inFixture.has(t));
  assert.deepEqual(missing, [], 'types with no event in the fixture');
});

test('the golden journal holds no personal data: no emails, no Windows user paths, no app data folders', () => {
  const text = golden('events.jsonl') + golden('state.sha256');
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'an email address');
  assert.doesNotMatch(text, /C:\\\\?Users|AppData|APPDATA|Clowder/i, 'a user path or app data folder');
});

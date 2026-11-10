// Plan 9.5: Clowder's own collectors (repeat work, quiet goals) over a real Store replayed from a temp journal. Offline; no fetch is used.
// The journal lines are written with fixed times, so the windows are exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ForYou} from '../src/for-you.ts';
import {clowderCollectors, quietGoal, repeatWork} from '../src/for-you-clowder.ts';
import {Store} from '../src/store.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));

// Three wordings of one Request (overlap 0.75 to 0.875 with the first), and one that shares nothing with them.
const A = 'Draft the weekly newsletter summary for subscribers';
const B = `${A} please`;
const C = 'Write the weekly newsletter summary for subscribers';
const D = `${A} now`;
const OTHER = 'Plan the garden irrigation schedule';

let n = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const day = (daysAgo: number) => NOW - daysAgo * DAY;
const event = (type: string, at: number, data: object) => ({id: `ev-${++n}`, at: iso(at), type, data});
const request = (text: string, daysAgo: number, extra: object = {}) => event('task.created', day(daysAgo), {id: `task-${++n}`, cat: 'mayor', from: 'owner', text, mode: 'demo', status: 'queued', ...extra});
const goal = (id: string, title: string, daysAgo: number, status = 'active') => event('goal.created', day(daysAgo), {id, title, success: '', status, mode: 'demo', rounds: 0, roundsToday: 0, day: '', failures: 0, log: [], summary: null, maxRoundsPerDay: null, tokenBudget: null, pausedBy: null, note: null, endedBy: null});
const logLine = (id: string, daysAgo: number) => event('goal.updated', day(daysAgo), {id, logLine: 'Round done.'});

/** A journal with these events, replayed by a real Store. */
function world(events: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'for-you-clowder-')), file = join(dir, 'events.jsonl');
  writeFileSync(file, events.map(e => `${JSON.stringify(e)}\n`).join(''));
  return {dir, file, store: () => new Store(file, []), close: () => rmSync(dir, {recursive: true, force: true})};
}
const ctx = (state: Store['state']) => ({account: null, token: async () => '', fetch: globalThis.fetch, now: NOW, state});

test('three similar Requests raise one repeat card, on the oldest; a fourth raises no second', async () => {
  const w3 = world([request(A, 10), request(B, 6), request(C, 2), request(OTHER, 1)]);
  try {
    const found = await repeatWork.collect(ctx(w3.store().state));
    assert.equal(found.length, 1, 'one card');
    assert.equal(found[0]!.subject, A);
    assert.equal(found[0]!.account, null);
    assert.equal(found[0]!.sourceAt, iso(day(10)), 'the oldest Request is the source time');
  } finally { w3.close(); }

  const w4 = world([request(A, 10), request(B, 6), request(C, 2), request(D, 1)]);
  try {
    const found = await repeatWork.collect(ctx(w4.store().state));
    assert.equal(found.length, 1, 'the fourth adds no card');
    assert.equal(found[0]!.sourceAt, iso(day(10)), 'and does not move the card');
  } finally { w4.close(); }
});

test('two similar Requests raise nothing, and Requests outside the 30 days do not count', async () => {
  const two = world([request(A, 10), request(B, 6), request(OTHER, 1)]);
  try { assert.deepEqual(await repeatWork.collect(ctx(two.store().state)), [], 'below 3'); } finally { two.close(); }
  const old = world([request(A, 40), request(B, 35), request(C, 2)]);
  try { assert.deepEqual(await repeatWork.collect(ctx(old.store().state)), [], 'only one is in the window'); } finally { old.close(); }
});

test('an existing similar routine raises none; a routine run, a child task and a goal round are not Requests', async () => {
  const routine = event('routine.saved', day(60), {id: 'routine-news', title: 'Newsletter', prompt: `${A} every Monday`, cat: 'mayor', schedule: null, mode: 'demo', tokenBudget: null, enabled: true});
  const w = world([request(A, 10), request(B, 6), request(C, 2), routine]);
  try { assert.deepEqual(await repeatWork.collect(ctx(w.store().state)), [], 'the routine already does this'); } finally { w.close(); }

  const notRequests = world([request(A, 10), request(B, 6, {parent: 'task-x'}), request(C, 2, {routine: 'routine-news'}), request(D, 1, {goal: 'goal-1'})]);
  try { assert.deepEqual(await repeatWork.collect(ctx(notRequests.store().state)), [], 'only the owner\'s own Requests count'); } finally { notRequests.close(); }
});

test('a goal with no log line for 7 days is quiet; a recent line, a paused goal and a goal that never started are not', async () => {
  const w = world([
    goal('g-quiet', 'Spring menu', 10),                       // active, nothing logged: quiet since it was created
    goal('g-busy', 'Garden plan', 10), logLine('g-busy', 2),  // logged 2 days ago
    goal('g-old-line', 'Fence quote', 20), logLine('g-old-line', 9), // logged 9 days ago: quiet
    goal('g-paused', 'Holiday cards', 10, 'paused'),
    goal('g-new', 'Office move', 3),                          // three days old: too new
  ]);
  try {
    const found = await quietGoal.collect(ctx(w.store().state));
    assert.deepEqual(found.map(f => f.sourceId).sort(), ['g-old-line', 'g-quiet']);
    assert.equal(found.find(f => f.sourceId === 'g-old-line')!.sourceAt, iso(day(9)), 'the last log line is the source time');
    assert.equal(found.find(f => f.sourceId === 'g-quiet')!.subject, 'Spring menu');
  } finally { w.close(); }
});

test('the loop: three similar Requests raise one card, and a restart with a fourth raises no second', async () => {
  const w = world([request(A, 10), request(B, 6), request(C, 2)]);
  let now = NOW;
  try {
    const mk = () => new ForYou({dir: () => w.dir, store: w.store, token: async () => '', config: () => ({...config.forYou, categories: {repeat: true, quiet: true}}),
      collectors: clowderCollectors, now: () => now});
    const first = mk();
    await first.update({enabled: true});
    await first.poll();
    assert.equal(readFileSync(w.file, 'utf8').split('\n').filter(l => l.includes('"suggestion.raised"')).length, 1);

    appendFileSync(w.file, `${JSON.stringify(request(D, 1))}\n`);
    now = NOW + 1000;
    const restarted = mk(); // a new process: the journal and the settings are read again
    await restarted.poll();
    await restarted.poll();
    assert.equal(readFileSync(w.file, 'utf8').split('\n').filter(l => l.includes('"suggestion.raised"')).length, 1, 'nothing raised twice');
    const open = Object.values(w.store().state.suggestions ?? {}).filter(c => c.status === 'open');
    assert.deepEqual(open.map(c => c.category), ['repeat']);
  } finally { w.close(); }
});

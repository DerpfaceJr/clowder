import test from 'node:test';
import assert from 'node:assert/strict';
import {goalDetails, goalReviews, goalTokens, goalUsage, weekTokens} from '../src/goals.ts';
import {projects} from '../src/projects.ts';
import type {Approval, Cat, Goal, State, Task} from '../src/store.ts';

// Fixed clock: every "ago" is a fixed ISO string, so the tests never depend on when they run.
const NOW = new Date('2026-10-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const cat = (id: string, name: string): Cat => ({id, name, role: '', color: '#336699', icon: name[0]});
const task = (id: string, catId: string, extra: Partial<Task> = {}): Task => ({id, cat: catId, from: 'owner', text: id, mode: 'demo', status: 'done', ...extra});
const goal = (id: string, extra: Partial<Goal> = {}): Goal => ({id, title: `Goal ${id}`, success: '', status: 'active', mode: 'claude', rounds: 1, roundsToday: 0, day: '', failures: 0, log: [], summary: null, maxRoundsPerDay: null, tokenBudget: null, pausedBy: null, note: null, endedBy: null, createdAt: ago(3 * DAY), updatedAt: ago(DAY), ...extra});
const state = (parts: Partial<State>): State => ({cats: [], roads: [], tasks: [], approvals: [], messages: [], events: [], paused: false, usage: [], treasury: null, retiredCats: [], councils: [], layoutVersion: 0, groups: [], introduced: true, goals: [], ownerSteps: [], hiddenQuests: {}, accounts: {}, effects: {}, routines: [], ...parts});
const review = (id: string, extra: Partial<Approval> = {}): Approval => ({id, task: 'R1', cat: 'mayor', question: 'Remove goal ‘x’?', options: ['Remove', 'Keep'], status: 'pending', messages: [], toolCallId: 'call', turn: 1, depth: 0, gate: 'goal-removal', ...extra});
const A1 = '11111111-1111-4111-8111-111111111111', A2 = '22222222-2222-4222-8222-222222222222';

test('goal tokens come from the goal tree, and a goal with no reported number is not known', () => {
  const s = state({
    goals: [goal('g1'), goal('g2')],
    tasks: [task('R1', 'mayor', {goal: 'g1'}), task('C1', 'gardener', {parent: 'R1'}), task('R2', 'mayor', {goal: 'g2'})],
    usage: [
      {task: 'R1', input: 100, output: null, at: ago(DAY)},
      {task: 'C1', input: null, output: 50, at: ago(DAY)},
      {task: 'R2', input: null, output: null, at: ago(DAY)},
    ],
  });
  assert.equal(goalTokens(s, 'g1'), 150, 'a child task counts toward its goal, and a null adds nothing');
  assert.equal(goalTokens(s, 'g2'), 0);
  assert.equal(goalUsage(s).get('g2')?.reported, false);
  assert.equal(goalDetails(s).get('g2')!.tokensKnown, false, 'the panel shows a dash for this goal, not a made-up zero');
  assert.equal(goalDetails(s).get('g1')!.tokensKnown, true);
});

test('tokens this week count only rows from the last seven days, and null means nothing reported', () => {
  const s = state({usage: [
    {task: 'R1', input: 100, output: 5, at: ago(DAY)},
    {task: 'R1', input: 1000, output: 0, at: ago(8 * DAY)},
    {task: 'R1', input: null, output: null, at: ago(2 * DAY)},
  ]});
  assert.equal(weekTokens(s, NOW), 105);
  assert.equal(weekTokens(state({usage: [{task: 'R1', input: null, output: null, at: ago(DAY)}]}), NOW), null);
  assert.equal(weekTokens(state({}), NOW), null);
});

test('goal details: last round, open owner steps, artifacts newest first, and the cats in the rounds', () => {
  const s = state({
    cats: [cat('mayor', 'Mayor'), cat('gardener', 'Gardener')],
    goals: [goal('g1'), goal('g2'), goal('g3')],
    tasks: [task('R1', 'mayor', {goal: 'g1'}), task('C1', 'gardener', {parent: 'R1'}), task('R2', 'mayor', {goal: 'g1'}), task('X1', 'mayor', {goal: 'g2'})],
    events: [
      {id: 'e1', at: ago(2 * DAY), type: 'task.created', data: task('R1', 'mayor', {goal: 'g1'})},
      {id: 'e2', at: ago(DAY), type: 'task.created', data: task('R2', 'mayor', {goal: 'g1'})},
      {id: 'e3', at: ago(DAY - 1000), type: 'artifact.created', data: {id: A1, title: 'Map', kind: 'html', mime: 'text/html', cat: 'gardener', task: 'R1', project: 'R1', file: 'map.html', size: 10}},
      {id: 'e4', at: ago(3000), type: 'artifact.created', data: {id: A2, title: 'Note', kind: 'markdown', mime: 'text/plain', cat: 'gardener', task: 'C1', project: 'R1', file: 'note.md', size: 5}},
    ],
    ownerSteps: [
      {id: 's1', goal: 'g1', status: 'open', title: 'Log in', cat: 'mayor', steps: '', blocking: false, at: ago(DAY)},
      {id: 's2', goal: 'g1', status: 'done', title: 'Pay', cat: 'mayor', steps: '', blocking: false, at: ago(DAY)},
      {id: 's3', goal: 'g2', status: 'open', title: 'Sign', cat: 'mayor', steps: '', blocking: false, at: ago(DAY)},
    ] as any,
  });
  const d = goalDetails(s);
  assert.equal(d.get('g1')!.lastRoundAt, ago(DAY), 'the newest round start, not the first');
  assert.equal(d.get('g1')!.ownerStepsOpen, 1, 'a done step is not open');
  assert.equal(d.get('g2')!.ownerStepsOpen, 1);
  assert.deepEqual(d.get('g1')!.artifacts, [A2, A1], 'a child-task artifact counts for its goal; newest first');
  assert.deepEqual(d.get('g1')!.cats.map(c => c.id), ['mayor', 'gardener'], 'distinct cats in first-seen order');
  assert.equal(d.get('g1')!.cats[1].name, 'Gardener');
  assert.deepEqual(d.get('g3'), {tokensUsed: 0, tokensKnown: false, lastRoundAt: null, ownerStepsOpen: 0, artifacts: [], cats: []}, 'a goal with no rounds has nothing to show, not zeros it did not measure');
});

test('goal reviews: only pending removal suggestions, with the merge target read from the question', () => {
  const s = state({
    goals: [goal('old', {title: 'Goal old'}), goal('new', {title: 'Goal new'})],
    approvals: [
      review('A1', {goal: 'old', reason: 'Stale.', question: 'Remove goal ‘Goal old’? Stale. Duplicate of ‘Goal new’.'}),
      review('A2', {goal: 'new', reason: 'Kept earlier.', status: 'rejected'}),
      review('A3', {goal: 'new', reason: 'Round go-ahead.', gate: 'goal', question: 'Start round 2 of “Goal new”?'}),
      review('A4', {goal: 'gone', reason: 'Archived.', question: 'Remove goal ‘Gone’? Archived.'}),
    ],
  });
  const list = goalReviews(s);
  assert.deepEqual(list.map(r => r.id), ['A1', 'A4']);
  assert.deepEqual(list[0], {id: 'A1', goal: 'old', goalTitle: 'Goal old', cat: 'mayor', reason: 'Stale.', question: 'Remove goal ‘Goal old’? Stale. Duplicate of ‘Goal new’.', mergeInto: 'Goal new', options: ['Remove', 'Keep']});
  assert.equal(list[1].goalTitle, null, 'a goal no longer in the list has no title');
  assert.equal(list[1].mergeInto, null, 'no duplicate note means no merge target');
});

test('a goal-removal suggestion is not a pending decision on the request that filed it', () => {
  const s = state({cats: [cat('mayor', 'Mayor')], tasks: [task('R9', 'mayor')], approvals: [review('A9', {task: 'R9', goal: 'g1', reason: 'Stale.'})]});
  const p = projects(s)[0];
  assert.equal(p.status, 'done', 'the request reads as finished, not waiting for you');
  assert.deepEqual(p.pendingApprovals, []);
});

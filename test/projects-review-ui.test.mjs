import test from 'node:test';
import assert from 'node:assert/strict';
import {goalBucket, goalSections, daysRunning, daysLabel, tokenMeter, durationLabel, compactCount, summaryTiles, SECTION_TITLES, GOAL_ORDER, createProjectsPanel} from '../public/projects-panel.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const ago = ms => new Date(NOW.getTime() - ms).toISOString();
const DAY = 86400000;
const goal = (id, extra = {}) => ({id, title: `Goal ${id}`, status: 'active', pausedBy: null, createdAt: ago(3 * DAY), updatedAt: ago(DAY), rounds: 1, roundsToday: 0, tokensUsed: 0, tokensKnown: false, tokenBudget: null, ...extra});

test('every goal lands in exactly one group, and the groups add up to the goal count', () => {
  const goals = [
    goal('a'),
    goal('b', {status: 'paused', pausedBy: 'owner-step'}),
    goal('c', {status: 'paused', pausedBy: 'approval'}),
    goal('d', {status: 'paused', pausedBy: 'budget'}),
    goal('e', {status: 'paused', pausedBy: 'owner'}),
    goal('f', {status: 'paused', pausedBy: 'town'}),
    goal('g', {status: 'achieved'}),
    goal('h', {status: 'stopped', endedBy: 'owner'}),
    goal('i', {status: 'paused', pausedBy: null}),
  ];
  const s = goalSections(goals);
  assert.deepEqual(s.active.map(g => g.id), ['a']);
  assert.deepEqual(s.waiting.map(g => g.id).sort(), ['b', 'c'], 'paused for an owner step or a round go-ahead waits on the owner');
  assert.deepEqual(s.paused.map(g => g.id).sort(), ['d', 'e', 'f', 'i'], 'budget, owner, town and unknown pauses are Paused');
  assert.deepEqual(s.done.map(g => g.id).sort(), ['g', 'h'], 'achieved and stopped are Done');
  assert.equal(s.active.length + s.waiting.length + s.paused.length + s.done.length, goals.length, 'no goal is dropped or counted twice');
  assert.equal(goalBucket(goal('x', {status: 'achieved'})), 'done');
  assert.deepEqual(Object.keys(SECTION_TITLES), ['active', 'waiting', 'paused', 'done']);
  assert.deepEqual(GOAL_ORDER, ['waiting', 'active', 'paused', 'done'], 'Waiting on you is shown first');
});

test('a preview line drops markdown marks', async () => {
  const {clip} = await import('../public/projects-panel.js');
  assert.equal(clip('**Decision made:** use `A + F`.  Next', 60), 'Decision made: use A + F. Next');
});

test('days running counts whole days to now, or to the last update once a goal has ended', () => {
  assert.equal(daysRunning(goal('a'), NOW), 3);
  assert.equal(daysRunning(goal('b', {status: 'achieved', updatedAt: ago(DAY)}), NOW), 2, 'an ended goal stops at its last update');
  assert.equal(daysRunning(goal('c', {createdAt: 'not a date'}), NOW), null);
  assert.equal(daysLabel(null), '—');
  assert.equal(daysLabel(0), 'Today');
  assert.equal(daysLabel(1), '1 day');
  assert.equal(daysLabel(12), '12 days');
});

test('tokens: a bar against the budget when one is set, a dash when nothing was reported', () => {
  assert.deepEqual(tokenMeter(goal('a', {tokensKnown: true, tokensUsed: 1200, tokenBudget: 4000})), {text: '1,200 of 4,000', ratio: 0.3, hint: 'provider-reported'});
  assert.equal(tokenMeter(goal('a', {tokensKnown: true, tokensUsed: 9000, tokenBudget: 4000})).ratio, 1, 'the bar stops at full');
  assert.deepEqual(tokenMeter(goal('a', {tokensKnown: false, tokensUsed: 0})), {text: '—', ratio: null, hint: 'Not reported yet'}, 'never a made-up zero');
  assert.equal(tokenMeter(goal('a', {tokensKnown: false, tokensUsed: 0, tokenBudget: 4000})).text, '— of 4,000');
  assert.equal(tokenMeter(goal('a', {tokensKnown: true, tokensUsed: 50})).ratio, null, 'no budget, so no bar');
});

test('durations: minutes, hours, then days; an unreadable time is a dash', () => {
  const start = '2026-10-30T10:00:00.000Z';
  assert.equal(durationLabel(start, '2026-10-30T10:00:20.000Z'), 'under a minute');
  assert.equal(durationLabel(start, '2026-10-30T10:45:00.000Z'), '45 min');
  assert.equal(durationLabel(start, '2026-10-30T13:00:00.000Z'), '3 h');
  assert.equal(durationLabel(start, '2026-11-02T10:00:00.000Z'), '3 days');
  assert.equal(durationLabel(null, start), '—');
  assert.equal(durationLabel(start, 'nope'), '—');
});

test('big counts are compact and a missing count is a dash', () => {
  assert.equal(compactCount(5380279), '5.4M');
  assert.equal(compactCount(0), '0');
  assert.equal(compactCount(null), '—');
  assert.equal(compactCount(undefined), '—');
});

test('summary tiles: failed sources show dashes, not zeros', () => {
  const goals = [goal('a'), goal('b', {status: 'paused', pausedBy: 'owner-step'})];
  const artifacts = [
    {id: '1', createdAt: ago(DAY)},
    {id: '2', createdAt: ago(10 * DAY)},
  ];
  const ok = summaryTiles({goals, goalsKnown: true, needsYou: 3, week: {tokens: 5380279}, artifacts, now: NOW});
  assert.deepEqual(ok.map(t => t.value), ['1', '3', '5.4M', '1'], 'Needs you is the one count the dock badge shows');
  assert.deepEqual(ok.map(t => t.label), ['Active goals', 'Needs you', 'Tokens, 7 days', 'Artifacts, 7 days']);
  assert.equal(ok[0].hint, '0 paused', 'the paused hint counts the Paused group, not the waiting one');
  const failed = summaryTiles({goals: [], goalsKnown: false, needsYou: null, week: {tokens: null}, artifacts: null, now: NOW});
  assert.deepEqual(failed.map(t => t.value), ['—', '—', '—', '—']);
  const quiet = summaryTiles({goals: [], goalsKnown: true, needsYou: 0, week: {tokens: null}, artifacts: [], now: NOW});
  assert.deepEqual(quiet.map(t => t.value), ['0', '0', '—', '0'], 'a loaded zero is a zero; tokens nobody reported are a dash');
});

test('the panel factory builds without a document in Node and is still a function', () => {
  assert.equal(typeof createProjectsPanel, 'function');
});

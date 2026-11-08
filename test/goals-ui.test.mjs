import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {goalStatusLine, goalTone, canPause, canResume, canStop, goalCountsLine, goalLastLine, goalBannerText, budgetPatch, groupGoals, canRemove, goalModeLabel, createdLabel} from '../public/projects-panel.js';
import {goalRound, roundStarted} from '../public/town-events.js';

const goal = (patch = {}) => ({
  id: 'g1', title: 'Write the report', status: 'active', pausedBy: null, note: null, endedBy: null,
  rounds: 2, roundsToday: 2, maxRoundsPerDay: 24, tokenBudget: null, tokensUsed: 0,
  log: ['Round 1: Done.', 'Round 2: Drafted the intro.'], ...patch,
});

test('each goal state has a plain status line and a tone', () => {
  assert.equal(goalStatusLine(goal()), 'Working');
  assert.equal(goalStatusLine(goal({status: 'paused', pausedBy: 'approval'})), 'Waiting for you');
  assert.equal(goalStatusLine(goal({status: 'paused', pausedBy: 'budget'})), 'Budget reached');
  assert.equal(goalStatusLine(goal({status: 'paused', pausedBy: 'failures'})), 'Paused after failures');
  assert.equal(goalStatusLine(goal({status: 'paused', pausedBy: 'town'})), 'Town paused');
  assert.equal(goalStatusLine(goal({status: 'achieved'})), 'Achieved');
  assert.equal(goalStatusLine(goal({status: 'stopped', endedBy: 'mayor'})), 'Stopped by the Mayor');
  assert.equal(goalTone(goal({status: 'paused', pausedBy: 'approval'})), 'attention');
  assert.equal(goalTone(goal({status: 'paused', pausedBy: 'town'})), 'quiet');
  assert.equal(goalTone(goal({status: 'achieved'})), 'done');
});

test('the buttons offered match what the server accepts', () => {
  assert.deepEqual([canPause(goal()), canResume(goal()), canStop(goal())], [true, false, true]);
  // An approval or a town pause resumes through its own path, never a Resume button.
  assert.equal(canResume(goal({status: 'paused', pausedBy: 'approval'})), false);
  assert.equal(canResume(goal({status: 'paused', pausedBy: 'town'})), false);
  assert.equal(canResume(goal({status: 'paused', pausedBy: 'owner'})), true);
  assert.equal(canResume(goal({status: 'paused', pausedBy: 'budget'})), true);
  assert.equal(canStop(goal({status: 'achieved'})), false);
  assert.equal(canPause(goal({status: 'paused', pausedBy: 'owner'})), false);
});

test('counts name rounds, today against the budget, and tokens only when reported', () => {
  assert.equal(goalCountsLine(goal()), '2 rounds · 2 of 24 today');
  assert.equal(goalCountsLine(goal({rounds: 1, roundsToday: 1})), '1 round · 1 of 24 today');
  assert.equal(goalCountsLine(goal({tokenBudget: 5000, tokensUsed: 1200})), '2 rounds · 2 of 24 today · 1,200 of 5,000 tokens');
  assert.equal(goalCountsLine(goal({tokensUsed: 0})), '2 rounds · 2 of 24 today');
});

test('the last line is the newest round, or a plain note before the first round', () => {
  assert.equal(goalLastLine(goal()), 'Round 2: Drafted the intro.');
  assert.equal(goalLastLine(goal({log: []})), 'No rounds yet.');
});

test('the Mayor banner appears only while a goal is active', () => {
  assert.equal(goalBannerText([goal()]), 'Working on: Write the report · round 2');
  assert.equal(goalBannerText([goal({status: 'paused', pausedBy: 'owner'})]), null);
  assert.equal(goalBannerText([]), null);
});

test('budget fields: whole numbers only, and a blank field means no limit', () => {
  assert.deepEqual(budgetPatch('5', ''), {maxRoundsPerDay: 5, tokenBudget: null});
  assert.deepEqual(budgetPatch('', ''), {maxRoundsPerDay: null, tokenBudget: null});
  assert.deepEqual(budgetPatch('24', '5000'), {maxRoundsPerDay: 24, tokenBudget: 5000});
  for (const [rounds, tokens] of [['0', ''], ['1001', ''], ['2.5', ''], ['3', '1.5'], ['3', '0']]) {
    assert.throws(() => budgetPatch(rounds, tokens), /whole number/, `${rounds}/${tokens}`);
  }
});

test('goals group into active, paused and ended, newest first; achieved and stopped are ended', () => {
  const goals = [
    goal({id: 'old', createdAt: '2026-10-01T10:00:00.000Z', status: 'achieved'}),
    goal({id: 'new', createdAt: '2026-10-20T10:00:00.000Z', status: 'active'}),
    goal({id: 'mid', createdAt: '2026-10-10T10:00:00.000Z', status: 'paused', pausedBy: 'approval'}),
    goal({id: 'stop', createdAt: '2026-10-15T10:00:00.000Z', status: 'stopped', endedBy: 'owner'}),
  ];
  const groups = groupGoals(goals);
  assert.deepEqual(groups.active.map(g => g.id), ['new']);
  assert.deepEqual(groups.paused.map(g => g.id), ['mid']);
  assert.deepEqual(groups.ended.map(g => g.id), ['stop', 'old']);
  assert.deepEqual(groupGoals([]), {active: [], paused: [], ended: []});
  assert.equal(goals[0].id, 'old', 'the input is not reordered');
});

test('only a goal that is not active can be removed', () => {
  assert.equal(canRemove(goal({status: 'active'})), false);
  assert.equal(canRemove(goal({status: 'paused', pausedBy: 'owner'})), true);
  assert.equal(canRemove(goal({status: 'achieved'})), true);
  assert.equal(canRemove(goal({status: 'stopped', endedBy: 'mayor'})), true);
});

test('the mode names the provider, and a demonstration goal says so', () => {
  assert.equal(goalModeLabel(goal({mode: 'demo'})), 'Demonstration');
  assert.equal(goalModeLabel(goal({mode: 'claude'})), 'Claude');
  assert.equal(goalModeLabel(goal({mode: 'chatgpt'})), 'ChatGPT');
  assert.equal(goalModeLabel(goal({mode: 'mystery'})), 'mystery');
});

test('the created date is shown, or the card says it is unknown', () => {
  assert.match(createdLabel('2026-10-20T10:00:00.000Z'), /^Created .*2026/);
  assert.equal(createdLabel(undefined), 'Created date unknown');
  assert.equal(createdLabel('not a date'), 'Created date unknown');
});

test('a goal round’s prompt is the town’s, from either sender, and reads as a quiet line', () => {
  const round = {from: 'town', to: 'mayor', text: 'Goal round 17: Go viral'};
  assert.deepEqual(goalRound(round), {round: 17, title: 'Go viral'});
  assert.equal(roundStarted(goalRound(round)), 'Round 17 of “Go viral” started');
  // Older journals sent the same prompt in the owner's name.
  assert.deepEqual(goalRound({from: 'owner', to: 'mayor', text: 'Goal round 1: Open a small online cat cafe shop'}), {round: 1, title: 'Open a small online cat cafe shop'});
  assert.deepEqual(goalRound({from: 'town', to: 'mayor', text: 'Goal round 2:\n  Keep a weekly\n digest'}), {round: 2, title: 'Keep a weekly digest'});
});

test('only the round prompt to the Mayor is a round: the owner’s own words and the Mayor’s replies stay messages', () => {
  assert.equal(goalRound({from: 'owner', to: 'mayor', text: 'Can you start goal round 2 sooner?'}), null);
  assert.equal(goalRound({from: 'owner', to: 'mayor', text: 'Make the shop page.'}), null);
  assert.equal(goalRound({from: 'owner', to: 'scholar', text: 'Goal round 3: Research'}), null, 'rounds only ever go to the Mayor');
  assert.equal(goalRound({from: 'mayor', to: 'owner', text: 'Goal round 3: done, here is the summary.'}), null);
  assert.equal(goalRound({from: 'mayor', to: 'town', text: 'Goal round 3: Research'}), null);
  assert.equal(goalRound({from: 'scholar', to: 'mayor', text: 'Goal round 3: Research'}), null);
  assert.equal(goalRound(null), null);
  assert.equal(goalRound({from: 'town', to: 'mayor'}), null);
});

test('a long round title is cut at a word as everywhere else, and a missing one still reads as a round', async () => {
  const {oneLiner} = await import('../public/hologram.js');
  for (const title of ['word '.repeat(40).trim(), 'x'.repeat(120), 'A short title']) {
    assert.equal(roundStarted({round: 4, title}), `Round 4 of “${oneLiner(title, 90)}” started`);
  }
  assert.equal(roundStarted({round: 5, title: ''}), 'Goal round 5 started');
});

test('chat and the diary show rounds through the same line, and the town has a name', () => {
  // Line endings are normalised: a Windows checkout has CRLF, and the patterns below expect \n.
  const app = ['app.js', 'chat-thread.js'].map(f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')).join('\n').replace(/\r\n/g, '\n');
  assert.match(app, /import \{goalRound,roundStarted\} from '\.\/town-events\.js';/);
  assert.match(app, /messages\.map\(m=>\{const round=goalRound\(m\);if\(round\)return `<p class="chat-event">\$\{escape\(roundStarted\(round\)\)\}&nbsp;·&nbsp;<time>/, 'chat: a quiet line, never a "You" bubble');
  assert.match(app, /const round=goalRound\(d\);\n\s*return round\?\{e,text:roundStarted\(round\)\}/, 'diary: the same line');
  assert.match(app, /\{owner:'You',system:'Town',town:'Town'\}\[id\]/);
  assert.ok(!/from==='owner'&&\/\^Goal round/.test(app), 'no second copy of the round rule');
});

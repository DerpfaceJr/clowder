import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusTone, progressPercent, countsLine, usageLine, stamp, siteFocus, nameFor, waitingLabel, snapshotKey, createProjectsPanel,
} from '../public/projects-panel.js';

test('every server status maps to a tone, and an unknown status stays quiet', () => {
  assert.equal(statusTone('running'), 'working');
  assert.equal(statusTone('waiting for you'), 'attention');
  assert.equal(statusTone('done'), 'done');
  assert.equal(statusTone('failed'), 'failed');
  assert.equal(statusTone('stopped'), 'quiet');
  assert.equal(statusTone('something new'), 'quiet');
});

test('progress is clamped to a whole percentage, and unreadable values show as zero', () => {
  assert.equal(progressPercent(0.456), 46);
  assert.equal(progressPercent(1), 100);
  assert.equal(progressPercent(1.4), 100);
  assert.equal(progressPercent(-1), 0);
  assert.equal(progressPercent(undefined), 0);
  assert.equal(progressPercent(Number.NaN), 0);
});

test('the counts line names only the non-zero parts, and singular task for one', () => {
  assert.equal(countsLine({tasks: 1, done: 0, running: 0, waiting: 0, failed: 0}), '1 task');
  assert.equal(countsLine({tasks: 5, done: 3, running: 1, waiting: 0, failed: 1}), '5 tasks · 3 done · 1 running · 1 failed');
  assert.equal(countsLine({tasks: 2, done: 0, running: 1, waiting: 1, failed: 0}), '2 tasks · 1 running · 1 waiting');
});

test('usage says not reported when nothing was reported, and never shows a made-up zero', () => {
  assert.equal(usageLine({input: null, output: null}), 'Tokens: not reported');
  assert.equal(usageLine(undefined), 'Tokens: not reported');
  assert.equal(usageLine({input: 1200, output: null}), `Tokens: ${(1200).toLocaleString()} in · unreported out · provider-reported`);
});

test('a missing or invalid time reads as unknown', () => {
  assert.equal(stamp(null), 'time unknown');
  assert.equal(stamp('not a date'), 'time unknown');
  assert.notEqual(stamp('2026-10-25T09:05:00.000Z'), 'time unknown');
});

test('Show nook only has a target when the request founded a nook with a site', () => {
  assert.deepEqual(siteFocus({site: {index: 2, x: 12, z: -4}}), {x: 12, z: -4});
  assert.equal(siteFocus(null), null);
  assert.equal(siteFocus({site: {x: Number.NaN, z: 1}}), null);
});

test('names come from the project, with You and Town for the owner and the town', () => {
  const project = {cats: [{id: 'gardener', name: 'Gardener'}], group: {members: [{id: 'reviewer', name: 'Reviewer'}]}};
  assert.equal(nameFor(project, 'owner'), 'You');
  assert.equal(nameFor(project, 'system'), 'Town');
  assert.equal(nameFor(project, 'town'), 'Town', 'goal rounds come from the town');
  assert.equal(nameFor(project, 'gardener'), 'Gardener');
  assert.equal(nameFor(project, 'reviewer'), 'Reviewer');
  assert.equal(nameFor(project, 'ghost'), 'ghost');
});

test('the waiting label is one line and keeps the decision readable', () => {
  assert.equal(waitingLabel({question: 'Publish the history page?'}), 'Waiting for you: Publish the history page?');
  assert.ok(waitingLabel({question: 'word '.repeat(80)}).length < 110);
});

test('the snapshot key changes only when the data changes', () => {
  const a = [{id: 'R1', status: 'running'}];
  assert.equal(snapshotKey(a), snapshotKey([{id: 'R1', status: 'running'}]));
  assert.notEqual(snapshotKey(a), snapshotKey([{id: 'R1', status: 'done'}]));
});

test('the panel factory is exported; its DOM is not exercised here (no DOM in Node)', () => {
  assert.equal(typeof createProjectsPanel, 'function');
});

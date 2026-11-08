import test from 'node:test';
import assert from 'node:assert/strict';
import {askToggleShown, asideClass, asideLabel, catIsBusy, inboxCount, inboxNote, syncAskToggle} from '../public/ask-mayor.js';

test('a cat is busy while it has live work, including waiting on a child', () => {
  assert.equal(catIsBusy({tasks: [{cat: 'scholar', status: 'running'}]}, 'scholar'), true);
  assert.equal(catIsBusy({tasks: [{cat: 'mayor', status: 'waiting'}]}, 'mayor'), true);
  assert.equal(catIsBusy({tasks: [{cat: 'mayor', status: 'waiting_child'}]}, 'mayor'), true);
  assert.equal(catIsBusy({tasks: [{cat: 'mayor', status: 'done'}]}, 'mayor'), false);
  assert.equal(catIsBusy({tasks: [{cat: 'mayor', status: 'running'}]}, 'scholar'), false);
});

test('the Mayor is busy only with an active goal, not a paused one, and no other cat is', () => {
  assert.equal(catIsBusy({tasks: [], goals: [{status: 'active'}]}, 'mayor'), true);
  assert.equal(catIsBusy({tasks: [], goals: [{status: 'paused'}]}, 'mayor'), false);
  assert.equal(catIsBusy({tasks: [], goals: [{status: 'active'}]}, 'scholar'), false);
  assert.equal(catIsBusy(undefined, 'mayor'), false);
});

test('the ask toggle shows only while the selected cat is busy, and never in view-only mode', () => {
  const state = {tasks: [{cat: 'scholar', status: 'running'}], goals: []};
  assert.equal(askToggleShown(state, 'scholar', false), true);
  assert.equal(askToggleShown(state, 'critic', false), false);
  assert.equal(askToggleShown(state, 'scholar', true), false);
  assert.equal(askToggleShown({tasks: [{cat: 'scholar', status: 'done'}]}, 'scholar', false), false);
});

test('asides get the aside class and the Q&A label; ordinary messages do not', () => {
  assert.equal(asideClass({aside: true}), ' aside');
  assert.equal(asideClass({from: 'mayor'}), '');
  assert.equal(asideLabel({aside: true}), '<em class="aside-label">Q&amp;A</em>');
  assert.equal(asideLabel({from: 'mayor'}), '');
});

test('the Mayor’s busy toggle starts off so messages queue; the other cats still start on for questions', () => {
  const toggle = {label: {hidden: true}, box: {checked: true}};
  const busyMayor = {tasks: [{cat: 'mayor', status: 'running'}], goals: []};
  assert.equal(syncAskToggle(toggle, busyMayor, 'mayor'), false);
  assert.equal(toggle.box.checked, false);
  toggle.box.checked = true;
  assert.equal(syncAskToggle(toggle, busyMayor, 'mayor'), true, 'an owner who ticks it keeps it while the Mayor stays busy');
  const busyScholar = {tasks: [{cat: 'scholar', status: 'running'}], goals: []};
  assert.equal(syncAskToggle({label: {hidden: true}, box: {checked: true}}, busyScholar, 'scholar'), true);
});

test('the inbox counts queued messages, and only queued ones carry a note', () => {
  const state = {tasks: [{id: 'a', cat: 'mayor', status: 'queued', inbox: {goal: false}}, {id: 'b', cat: 'mayor', status: 'queued', inbox: {goal: false}}, {id: 'c', cat: 'mayor', status: 'running'}]};
  assert.equal(inboxCount(state), 2);
  assert.equal(inboxCount(undefined), 0);
  assert.equal(inboxNote(state.tasks[0]), 'Queued · the Mayor will pick this up next');
  assert.equal(inboxNote(state.tasks[2]), '');
  assert.equal(inboxNote(undefined), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {demoCats, isDemo} from '../public/demo-state.js';
import {startingReasoning} from '../public/ai-settings.js';

// The shape the server's modelList() returns: demo always, then only the providers that are usable.
const models = [
  {id: 'demo', name: 'Demonstration · scripted', label: 'Demonstration', models: []},
  {id: 'local', name: 'Local AI · qwen3.5:4b', label: 'Local AI', models: ['qwen3.5:4b', 'llama3:8b']},
  {id: 'claude', name: 'Claude plan · haiku', label: 'Claude plan', models: ['haiku', 'sonnet']},
];
const task = (cat, mode, status) => ({id: `${cat}-${mode}-${status}`, cat, mode, status, text: 't', from: 'owner'});
const goal = (mode, status) => ({id: `g-${mode}-${status}`, title: 'Goal', success: 'Goal', mode, status});

test('a cat is in Demonstration only while a live demo task or demo chat is on it', () => {
  for (const status of ['queued', 'running', 'waiting', 'waiting_child']) {
    assert.equal(isDemo({tasks: [task('scholar', 'demo', status)]}, 'scholar'), true, `${status} demo task`);
  }
  for (const status of ['done', 'failed', 'stopped']) {
    assert.equal(isDemo({tasks: [task('scholar', 'demo', status)]}, 'scholar'), false, `${status} demo task is over`);
  }
  assert.equal(isDemo({tasks: [task('scholar', 'local', 'running')]}, 'scholar'), false, 'a real task is not Demonstration');
  assert.equal(isDemo({tasks: [task('scholar', 'demo', 'running')]}, 'mayor'), false, 'only the cat that runs the task');
});

test('a demo goal puts the Mayor in Demonstration while it is active or paused, not after it ends', () => {
  assert.equal(demoCats({goals: [goal('demo', 'active')]}).has('mayor'), true);
  assert.equal(demoCats({goals: [goal('demo', 'paused')]}).has('mayor'), true);
  assert.equal(demoCats({goals: [goal('demo', 'achieved')]}).has('mayor'), false);
  assert.equal(demoCats({goals: [goal('demo', 'stopped')]}).has('mayor'), false);
  assert.equal(demoCats({goals: [goal('local', 'active')]}).has('mayor'), false);
});

test('the open chat counts: its cat is in Demonstration only when the chat is set to demo', () => {
  assert.equal(isDemo({}, 'scholar', {cat: 'scholar', mode: 'demo'}), true);
  assert.equal(isDemo({}, 'scholar', {cat: 'scholar', mode: 'local'}), false);
  assert.equal(isDemo({}, 'mayor', {cat: 'scholar', mode: 'demo'}), false, 'a demo chat does not spread to other cats');
  assert.equal(isDemo(undefined, 'scholar'), false, 'no state is no demonstration');
});

test('a stored demonstration is ignored: the chat starts on the cat, then the town default, then a real provider', () => {
  const town = {provider: 'claude', model: 'sonnet', usable: true};
  assert.equal(startingReasoning(models, town, undefined, 'demo'), 'claude|sonnet', 'stored demo never wins');
  assert.equal(startingReasoning(models, null, undefined, 'demo'), 'local|qwen3.5:4b', 'with no town default, the first real provider');
  assert.equal(startingReasoning([models[0]], null, undefined, 'demo'), 'demo', 'demo only when nothing real is set up');
});

test('a stored provider that is no longer enabled is ignored', () => {
  const town = {provider: 'claude', model: 'sonnet', usable: true};
  assert.equal(startingReasoning(models, town, undefined, 'hosted|x'), 'claude|sonnet');
  assert.equal(startingReasoning(models, town, undefined, 'local|gone:1b'), 'claude|sonnet', 'a model the provider no longer lists is not offered');
});

test('a real remembered choice for this cat still starts the chat there', () => {
  const town = {provider: 'claude', model: 'sonnet', usable: true};
  assert.equal(startingReasoning(models, town, undefined, 'local|llama3:8b'), 'local|llama3:8b');
});

test('the cat own AI setting comes before the town default, and a disabled provider in it is skipped', () => {
  const town = {provider: 'claude', model: 'sonnet', usable: true};
  assert.equal(startingReasoning(models, town, {local: {model: 'llama3:8b'}}, null), 'local|llama3:8b');
  assert.equal(startingReasoning(models, town, {claude: {effort: 'high'}}, null), 'claude|haiku', 'no model set: the first listed');
  assert.equal(startingReasoning(models, town, {chatgpt: {model: 'gpt-5'}}, null), 'claude|sonnet', 'chatgpt is not offered');
});

test('an unusable town default is not used, and a model it names but the list lacks falls back to the first listed', () => {
  assert.equal(startingReasoning(models, {provider: 'claude', model: 'sonnet', usable: false}, undefined, null), 'local|qwen3.5:4b');
  assert.equal(startingReasoning(models, {provider: 'claude', model: 'opus', usable: true}, undefined, null), 'claude|haiku');
});

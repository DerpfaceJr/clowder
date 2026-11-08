import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reasoningGroups, defaultReasoning, parseReasoning, reasoningValue, modelOptions, OTHER_MODEL} from '../public/ai-settings.js';
import {thinkingText} from '../public/models-panel.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// The shape the server's modelList() returns: only usable providers are present.
const list = [
  {id: 'demo', name: 'Demonstration · scripted', label: 'Demonstration', models: []},
  {id: 'local', name: 'Local AI · qwen3.5:4b', label: 'Local AI', models: ['qwen3.5:4b', 'llama3:8b']},
  {id: 'claude', name: 'Claude plan · haiku', label: 'Claude plan', models: ['haiku', 'sonnet', 'opus']},
];

test('the Reasoning menu groups every usable provider with its models, and demonstration is a plain option', () => {
  const groups = reasoningGroups(list);
  assert.deepEqual(groups.map(g => g.label), [null, 'Local AI', 'Claude plan']);
  assert.deepEqual(groups[0].options, [{value: 'demo', label: 'Demonstration'}]);
  assert.deepEqual(groups[1].options.map(o => o.value), ['local|qwen3.5:4b', 'local|llama3:8b']);
  assert.deepEqual(groups[2].options.map(o => o.label), ['haiku', 'sonnet', 'opus']);
});

test('a disabled provider is left out of the Reasoning menu', () => {
  const groups = reasoningGroups(list.filter(m => m.id !== 'local'));
  assert.equal(groups.some(g => g.label === 'Local AI'), false);
  assert.deepEqual(groups.map(g => g.label), [null, 'Claude plan']);
});

test('reasoning values round-trip provider and model, and a model name may contain a colon', () => {
  assert.deepEqual(parseReasoning('demo'), {mode: 'demo'});
  assert.deepEqual(parseReasoning(reasoningValue('local', 'qwen3.5:4b')), {mode: 'local', model: 'qwen3.5:4b'});
  assert.deepEqual(parseReasoning(reasoningValue('hosted', '')), {mode: 'hosted'});
});

test('the menu starts on the town default when it is ready, else on the demonstration', () => {
  assert.equal(defaultReasoning(list, {provider: 'claude', model: 'sonnet', usable: true}), 'claude|sonnet');
  assert.equal(defaultReasoning(list, {provider: 'claude', model: 'sonnet', usable: false}), 'demo');
  assert.equal(defaultReasoning(list, {provider: 'chatgpt', model: 'gpt-5', usable: true}), 'demo', 'a provider that is not offered');
  assert.equal(defaultReasoning(list, null), 'demo');
});

test('the model select lists every model, a blank choice first, and Other… last, with no duplicates', () => {
  assert.deepEqual(modelOptions(['opus', 'sonnet', 'opus'], 'Not set'), [
    {value: '', label: 'Not set'}, {value: 'opus', label: 'opus'}, {value: 'sonnet', label: 'sonnet'}, {value: OTHER_MODEL, label: 'Other…'},
  ]);
});

test('the summary strip names the town default from the status, and says so when it is not ready', () => {
  assert.equal(thinkingText({townDefault: {provider: 'claude', model: 'sonnet', effort: 'high', usable: true}}), 'Claude plan · sonnet · effort high');
  assert.equal(thinkingText({townDefault: {provider: 'local', model: 'qwen3.5:4b', effort: null, usable: false}}), 'Local AI (Ollama) · qwen3.5:4b · effort not set · not ready');
  assert.equal(thinkingText({}), 'Demonstration · scripted');
});

test('the model names come from the server status: no client file hardcodes them', () => {
  for (const file of ['public/app.js', 'public/models-panel.js', 'public/ai-settings.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /'opus'|'sonnet'|'haiku'|gpt-6/, `${file} must not hardcode model names`);
  }
  const suggestions = read('src/ai-options.ts').match(/MODEL_SUGGESTIONS[^\n]*/)[0];
  assert.match(suggestions, /opus/);
});

test('the diary is a flex column whose list scrolls on its own, and it is wide enough to read', () => {
  const css = read('public/immersive.css');
  const panel = css.match(/\.immersive \.world #diary-panel\{[^}]*\}/)?.[0] ?? '';
  assert.match(panel, /display:flex/);
  assert.match(panel, /flex-direction:column/);
  const width = Number(panel.match(/width:(\d+)px/)?.[1]);
  assert.ok(width >= 420 && width <= 480, `diary width ${width}px`);
  // The list is the panel body; the shared .panel-body rule gives it a bounded height and its own scrollbar.
  assert.match(read('public/index.html'), /id="diary" class="panel-body"/);
  assert.match(css, /\.immersive \.panel-body\{[^}]*overflow-y:auto/);
  assert.match(css, /\.immersive #diary span\{[^}]*overflow:visible/);
});

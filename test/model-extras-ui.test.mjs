import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {anthropicCard, anthropicDraft, readHermes, probeHermes, hermesCard, withHermes, createAnthropicSection, createHermesSection, HERMES_LABEL, ANTHROPIC_KEYS} from '../public/model-extras.js';
import {reasoningGroups, parseReasoning, startingReasoning} from '../public/ai-settings.js';
import {approvalDetail} from '../public/connectors-panel.js';
import {PROVIDERS} from '../public/models-panel.js';
import {fakeDocument, fakeFetch, settle} from './fixtures/fake-dom.mjs';

test('the Anthropic card reads the status block; the key never comes back, only its last four', () => {
  assert.deepEqual(anthropicCard({available: false, hasKey: false, keyLast4: null, detail: 'Not set. Add an API key.'}),
    {badge: 'Not set', tone: 'off', hint: 'Not set. Add an API key.', keyLine: 'No key saved', removable: false, use: 'Not listed in the chat Reasoning menu until a key is saved.'});
  const ready = anthropicCard({available: true, hasKey: true, keyLast4: 'Ab12', detail: 'Ready.'});
  assert.equal(ready.keyLine, 'Key saved ••••Ab12');
  assert.equal(ready.tone, 'ok');
  assert.equal(anthropicCard(null).badge, 'Not set', 'an older server without the block');
});

test('the key form makes the settings body, and a blank field asks for a key instead of a no-op', () => {
  assert.deepEqual(anthropicDraft(' sk-ant-api03-x '), {body: {anthropic: {key: 'sk-ant-api03-x'}}});
  assert.match(anthropicDraft('', null).error, /Paste an Anthropic API key/);
  assert.match(anthropicDraft('', {hasKey: true}).error, /Paste a new one to replace it/);
  assert.match(anthropicDraft('sk ant').error, /no spaces/);
  assert.match(anthropicDraft('x'.repeat(501)).error, /500/);
});

test('Hermes is off when its status route is not there, on with its setup state when it is', async () => {
  const at = status => fakeFetch({'GET /api/hermes/runtime': status}).fetchImpl;
  assert.deepEqual(await readHermes(fakeFetch({}).fetchImpl), {on: false}, 'a 404: hermes.enabled is off');
  assert.deepEqual(await readHermes(at({status: 403, body: {error: 'Hermes is set up on the host computer.'}})), {on: false, denied: true});
  assert.deepEqual(await readHermes(at({state: 'external'})), {on: true, runtime: {state: 'external'}});
  assert.equal(await probeHermes(at({state: 'done'})), true);
  assert.equal(await probeHermes(fakeFetch({}).fetchImpl), false);
});

test('the Hermes card says where setup stands, and offers Retry only after a failed setup', () => {
  assert.equal(hermesCard({on: false}).badge, 'Off');
  assert.equal(hermesCard({on: true, runtime: {state: 'external'}}).tone, 'ok');
  assert.equal(hermesCard({on: true, runtime: {state: 'done'}}).text, 'On. Hermes is set up on this computer.');
  const running = hermesCard({on: true, runtime: {state: 'running', label: 'Installing Python', done: ['source'], total: 3, lines: ['a', 'b']}});
  assert.equal(running.text, 'Setting Hermes up: Installing Python (step 2 of 3).');
  assert.deepEqual(running.lines, ['a', 'b']);
  const failed = hermesCard({on: true, runtime: {state: 'failed', error: 'uv sync failed', offline: true}});
  assert.equal(failed.retry, true);
  assert.equal(failed.text, 'Setup did not finish because this computer is offline: uv sync failed');
  assert.match(hermesCard({on: true, runtime: {state: 'unavailable'}}).text, /hermes\.python/);
});

test('Hermes joins the Reasoning menu for the Mayor only, as one option whose value carries no model', () => {
  const models = [{id: 'demo', label: 'Demonstration', models: []}, {id: 'local', label: 'Local AI', models: ['qwen']}];
  assert.equal(withHermes(models, {enabled: false, cat: 'mayor'}), models);
  assert.equal(withHermes(models, {enabled: true, cat: 'scholar'}), models);
  const mayor = withHermes(models, {enabled: true, cat: 'mayor'});
  const groups = reasoningGroups(mayor);
  assert.deepEqual(groups.at(-1), {label: HERMES_LABEL, options: [{value: 'hermes|', label: 'Mayor on Hermes'}]});
  assert.deepEqual(parseReasoning('hermes|'), {mode: 'hermes'}, 'the chat sends mode hermes and no model');
  assert.equal(startingReasoning(mayor, null, null, 'hermes|'), 'hermes|', 'a remembered Hermes pick comes back while it is on');
  assert.equal(startingReasoning(models, null, null, 'hermes|'), 'local|qwen', 'and falls back once it is off');
  assert.deepEqual(reasoningGroups([{id: 'x', label: 'X', models: []}]), [], 'a provider with no models and no single option is still left out');
});

test('a Hermes card shows the call’s arguments like a connector card; other gates still show nothing', () => {
  const call = {function: {name: 'write_file', arguments: JSON.stringify({path: 'notes/today.md', content: 'hello'})}};
  assert.equal(approvalDetail({gate: 'hermes', detail: call.function.arguments, call}), 'path: notes/today.md\ncontent: hello');
  assert.equal(approvalDetail({gate: 'connector', detail: call.function.arguments, call}), 'path: notes/today.md\ncontent: hello');
  assert.equal(approvalDetail({gate: 'goal', detail: 'x', call}), '');
});

test('the AI models nav lists Anthropic after the API key and Hermes after Jev', () => {
  const ids = PROVIDERS.map(p => p.id);
  assert.equal(ids.indexOf('anthropic'), ids.indexOf('hosted') + 1);
  assert.equal(ids.indexOf('hermes'), ids.indexOf('jev') + 1);
  const panel = readFileSync(new URL('../public/models-panel.js', import.meta.url), 'utf8');
  assert.match(panel, /\['anthropic',anth\]\]\)node\['use-all'\]/, 'Use for all cats works for Anthropic too');
});

test('the Anthropic card saves a key, never shows it again, and removes it', async () => {
  fakeDocument();
  const sent = [];
  let status = {anthropic: {available: false, hasKey: false, detail: 'Not set. Add an API key.'}};
  const api = async (path, body) => { sent.push([path, body]); status = {anthropic: body.anthropic ? {available: true, hasKey: true, keyLast4: body.anthropic.key.slice(-4), detail: 'Ready.'} : {available: false, hasKey: false}}; return status; };
  const card = createAnthropicSection({api, onStatus: s => card.paint(s), flashMs: 0});
  card.paint(status);
  const s = card.section;
  assert.equal(s.querySelector('a.cx-open').getAttribute('href'), ANTHROPIC_KEYS);
  assert.equal(s.querySelector('.model-key').textContent, 'No key saved');
  assert.equal(s.querySelector('[data-role="remove"]').hidden, true);
  const form = s.querySelector('form.model-form'), key = form.querySelector('input');
  await form.onsubmit({preventDefault() {}});
  assert.match(s.querySelector('.model-error').textContent, /Paste an Anthropic API key/);
  assert.equal(sent.length, 0);
  key.value = 'sk-ant-api03-secretWXYZ';
  await form.onsubmit({preventDefault() {}});
  assert.deepEqual(sent[0], ['models/settings', {anthropic: {key: 'sk-ant-api03-secretWXYZ'}}]);
  assert.equal(key.value, '', 'the typed key leaves the page');
  assert.equal(s.querySelector('.model-key').textContent, 'Key saved ••••WXYZ');
  assert.equal(s.querySelector('[data-role="badge"]').getAttribute('data-tone'), 'ok');
  s.querySelector('[data-role="remove"]').click();
  await settle();
  assert.deepEqual(sent[1], ['models/settings', {anthropic: null}]);
  assert.equal(s.querySelector('.model-key').textContent, 'No key saved');
});

test('the Hermes card’s switch follows the server and cannot change it; Retry setup posts the retry route', async () => {
  fakeDocument();
  const posted = [];
  let runtime = {state: 'failed', error: 'offline', offline: true};
  const {fetchImpl} = fakeFetch({'GET /api/hermes/runtime': () => runtime});
  const card = createHermesSection({api: async path => { posted.push(path); runtime = {state: 'running', label: 'Getting the source', done: [], total: 3}; return {ok: true}; }, fetchImpl});
  const r = await card.refresh();
  assert.deepEqual(r, {tone: 'error', denied: false, on: true});
  const toggle = card.section.querySelector('input');
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, true, 'town.config.json decides');
  const retry = card.section.querySelector('button');
  assert.equal(retry.hidden, false);
  retry.click();
  await settle();
  assert.deepEqual(posted, ['hermes/runtime/retry']);
  assert.match(card.section.textContent, /Setting Hermes up: Getting the source \(step 1 of 3\)\./);
  assert.equal(card.section.querySelector('button').hidden, true);
  const off = createHermesSection({api: async () => ({}), fetchImpl: fakeFetch({}).fetchImpl});
  assert.equal((await off.refresh()).on, false);
  assert.equal(off.section.querySelector('input').checked, false);
  assert.match(off.section.textContent, /set "hermes": \{"enabled": true\}/);
});

test('app.js puts Hermes in the Mayor’s Reasoning menu while it is on, with its own note', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const models=withHermes\(state\.models,\{enabled:hermesOn,cat:selected\}\);/);
  assert.match(app, /void probeHermes\(\)\.then\(on=>\{hermesOn=on;/);
  assert.match(app, /MODE_NOTES=\{hermes:'Experimental:/);
});

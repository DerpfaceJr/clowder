import test from 'node:test';
import assert from 'node:assert/strict';
import {aiDraft, effortChoices, providerChoices, suggestionText, usingText, MODEL_PATTERN} from '../public/ai-settings.js';

const claude={efforts:['low','medium','high','xhigh','max'],models:['haiku','sonnet'],default:{model:'haiku'}};

test('aiDraft: blank is null, valid values pass, bad values give a message', () => {
  assert.deepEqual(aiDraft('claude',{model:' sonnet ',effort:'high'},claude),{body:{model:'sonnet',effort:'high'}});
  assert.deepEqual(aiDraft('claude',{model:'',effort:''},claude),{body:{model:null,effort:null}});
  assert.match(aiDraft('claude',{model:'a b'},claude).error,/Model names/);
  assert.match(aiDraft('claude',{model:'-x'},claude).error,/Model names/);
  assert.match(aiDraft('claude',{effort:'ultra'},claude).error,/Choose an effort/);
  assert.equal(MODEL_PATTERN.test('x'.repeat(121)),false);
});

test('effortChoices lists only the given values behind a blank first choice', () => {
  assert.deepEqual(effortChoices(['low','high'],'Town default: none'),[{value:'',label:'Town default: none'},{value:'low',label:'low'},{value:'high',label:'high'}]);
  assert.equal(effortChoices(undefined,'x').length,1);
});

test('suggestionText reads Mayor suggests model · effort: reason, with either part optional', () => {
  assert.equal(suggestionText({provider:'claude',model:'sonnet',effort:'high',reason:'Research needs care.'}),'Mayor suggests sonnet · high: Research needs care.');
  assert.equal(suggestionText({provider:'hosted',effort:'low',reason:'Simple role.'}),'Mayor suggests low: Simple role.');
  assert.equal(suggestionText(null),'');
});

test('usingText names the resolved model and effort', () => {
  assert.equal(usingText({default:{model:'haiku',effort:'low'}}),'Now using haiku · effort low');
  assert.equal(usingText({default:{}}),'Now using no model set · effort not set');
});

test('providerChoices keeps model providers with a catalog entry and drops demo', () => {
  const models=[{id:'demo',name:'Demo'},{id:'claude',name:'Claude plan · haiku'},{id:'local',name:'Local'}];
  const catalog={claude:{ai:{}},local:{ai:{}}};
  assert.deepEqual(providerChoices(models,catalog).map(p=>p.id),['claude','local']);
  assert.deepEqual(providerChoices(models,{}),[]);
});

test('savingButton: Saving…, then Saved ✓ after the flash, and the label comes back', async () => {
  const {savingButton} = await import('../public/ai-settings.js');
  const button = {textContent: 'Save', disabled: false, dataset: {}};
  const states = [];
  const work = new Promise(resolve => setTimeout(resolve, 5));
  const pending = savingButton(button, work, {flashMs: 20});
  states.push([button.textContent, button.disabled, button.dataset.state]);
  assert.deepEqual(states[0], ['Saving…', true, 'saving']);
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(button.textContent, 'Saved ✓', 'the flash shows once the save has worked');
  assert.equal(button.dataset.state, 'saved');
  assert.equal(await pending, true, 'resolves true so the caller can close its disclosure');
  assert.equal(button.textContent, 'Save');
  assert.equal(button.disabled, false);
  assert.equal('state' in button.dataset, false);
});

test('savingButton: a failed save restores the button and writes the error inline, and resolves false', async () => {
  const {savingButton} = await import('../public/ai-settings.js');
  const button = {textContent: 'Save defaults', disabled: false, dataset: {}};
  const errorNode = {textContent: ''};
  const ok = await savingButton(button, Promise.reject(new Error('Model is not available.')), {errorNode, flashMs: 5});
  assert.equal(ok, false, 'no close on failure');
  assert.equal(errorNode.textContent, 'Model is not available.');
  assert.equal(button.textContent, 'Save defaults');
  assert.equal(button.disabled, false);
  assert.equal('state' in button.dataset, false);
});

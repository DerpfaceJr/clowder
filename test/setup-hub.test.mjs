import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  OLLAMA_DOWNLOAD, appsStep, brainStep, buildSteps, localReady, notifyStep, pairLinkFor, phoneStep, pullLabel, pullPercent, safeSvg, shouldAutoOpen, summarize, workshopStep, SEEN_KEY,
} from '../public/setup-hub.js';
import {pairLink} from '../src/setup-routes.ts';

const ollamaReady = (model = 'qwen3.5:4b') => ({enabled: true, configured: true, available: true, ai: {models: [model], default: {model}}});
const memoryStorage = (seen = false) => {
  const store = new Map(seen ? [[SEEN_KEY, '1']] : []);
  return {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value))};
};
const nothingUsable = {
  claude: {installed: false, loggedIn: false, available: false},
  chatgpt: {installed: false, loggedIn: false, available: false},
  hosted: {available: false},
  local: {enabled: true, configured: false, available: false, ai: {models: [], default: {model: 'qwen3.5:4b'}}},
};

test('the brain is ready when any provider is usable, and local AI counts only with its model installed', () => {
  assert.equal(brainStep({...nothingUsable, claude: {installed: true, loggedIn: true, available: true}}).state, 'ready');
  assert.equal(brainStep({...nothingUsable, local: ollamaReady()}).state, 'ready');
  assert.equal(localReady({...ollamaReady(), ai: {models: ['llama3'], default: {model: 'qwen3.5:4b'}}}), false);
});

test('the brain picks one action in order: sign in to Claude, then download the model, then get Ollama', () => {
  const signIn = brainStep({...nothingUsable, claude: {installed: true, loggedIn: false, available: false}});
  assert.deepEqual(signIn.action, {kind: 'claude-login', label: 'Sign in with Claude'}, 'one tap starts the sign-in itself');
  const pull = brainStep({...nothingUsable, local: {...ollamaReady(), ai: {models: ['llama3'], default: {model: 'qwen3.5:4b'}}, available: true}});
  assert.equal(pull.state, 'needs');
  assert.deepEqual(pull.action, {kind: 'pull', label: 'Download qwen3.5:4b', model: 'qwen3.5:4b'});
  const none = brainStep(nothingUsable);
  assert.deepEqual(none.action, {kind: 'link', label: 'Get Ollama', href: OLLAMA_DOWNLOAD});
  assert.equal(brainStep({...nothingUsable, local: {...nothingUsable.local, enabled: false}}).action.kind, 'models');
  assert.equal(brainStep(undefined).state, 'needs');
});

test('the phone step is ready with a paired device and pluralises the sentence', () => {
  assert.equal(phoneStep({devices: []}).state, 'needs');
  assert.equal(phoneStep({devices: []}).action.label, 'Pair your phone');
  assert.match(phoneStep({devices: [{id: 'a'}]}).text, /^1 device is paired/);
  assert.match(phoneStep({devices: [{id: 'a'}, {id: 'b'}]}).text, /^2 devices are paired/);
});

test('apps: a sign-in or error needs you, connected apps are named, and none connected is optional', () => {
  assert.equal(appsStep([{name: 'docs', status: 'needs-auth'}, {name: 'search', status: 'connected'}]).state, 'needs');
  assert.equal(appsStep([{name: 'docs', status: 'error'}]).text, 'docs needs you.');
  const connected = appsStep([{name: 'context7', status: 'connected'}, {name: 'deepwiki', status: 'connected'}, {name: 'off', status: 'off'}]);
  assert.equal(connected.state, 'ready');
  assert.equal(connected.text, 'context7, deepwiki connected.');
  assert.equal(appsStep([]).state, 'optional');
  assert.equal(appsStep([{name: 'a', status: 'connected'}, {name: 'b', status: 'connected'}, {name: 'c', status: 'connected'}, {name: 'd', status: 'connected'}]).text, 'a, b, c and 1 more connected.');
});

test('notifications: hidden without push support, asks to turn on, and says why when blocked or on iPhone', () => {
  assert.equal(notifyStep({push: false}, 'default'), null);
  assert.equal(notifyStep({push: true, needsInstall: false}, 'default').action.label, 'Turn on notifications');
  assert.equal(notifyStep({push: true, needsInstall: false}, 'granted').state, 'ready');
  assert.match(notifyStep({push: true, needsInstall: false}, 'denied').text, /Blocked/);
  const ios = notifyStep({push: true, needsInstall: true, note: 'Open it from the Home Screen.'}, 'default');
  assert.equal(ios.action, null);
  assert.equal(ios.text, 'Open it from the Home Screen.');
});

test('the workshop is ready when installed and optional otherwise', () => {
  assert.equal(workshopStep({distro: {present: true}}).state, 'ready');
  assert.equal(workshopStep({distro: {present: false}}).state, 'optional');
  assert.equal(workshopStep(null).kind, 'optional');
  assert.match(workshopStep(null).text, /Could not check/);
  assert.match(workshopStep(undefined).text, /Checking/, 'the hub draws before the slow workshop check answers');
  assert.equal(workshopStep(undefined).action, undefined);
  assert.match(appsStep(null).text, /Could not check/);
});

test('N of M counts required and recommended steps only; the badge is how many of those are not ready', () => {
  const steps = buildSteps({models: {...nothingUsable, local: ollamaReady()}, remote: {devices: []}, connectors: [], workshop: null, support: {push: false}});
  assert.deepEqual(steps.map(s => s.id), ['brain', 'phone', 'apps', 'workshop']);
  assert.deepEqual(summarize(steps), {ready: 1, total: 2, badge: 1, text: '1 of 2 ready'});
  const all = buildSteps({models: {...nothingUsable, local: ollamaReady()}, remote: {devices: [{id: 'a'}]}});
  assert.equal(summarize(all).text, '2 of 2 ready');
  assert.equal(summarize(all).badge, 0);
  const optionalOnly = summarize([{kind: 'optional', state: 'needs'}]);
  assert.deepEqual(optionalOnly, {ready: 0, total: 0, badge: 0, text: '0 of 0 ready'});
});

test('the hub opens by itself once, only while the brain is not ready, and never when storage is blocked', () => {
  const notReady = [brainStep(nothingUsable)];
  const ready = [brainStep({...nothingUsable, local: ollamaReady()})];
  assert.equal(shouldAutoOpen(notReady, memoryStorage()), true);
  assert.equal(shouldAutoOpen(ready, memoryStorage()), false);
  assert.equal(shouldAutoOpen(notReady, memoryStorage(true)), false);
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  assert.equal(shouldAutoOpen(notReady, broken), false);
});

test('pull progress: percent is zero until totals arrive, and the label reads sizes', () => {
  assert.equal(pullPercent({completed: 5, total: 0}), 0);
  assert.equal(pullPercent({completed: 50, total: 200}), 25);
  assert.equal(pullPercent({completed: 300, total: 200}), 100);
  assert.equal(pullLabel({completed: 0, total: 0}), 'Starting the download…');
  assert.equal(pullLabel({completed: 1.2e9, total: 2.5e9}), '1.2 GB of 2.5 GB · 48%');
});

test('the client link matches the server link, and only server SVG with no script is inserted', () => {
  const invite = {origin: 'https://town.example.com', code: 'ABCD-EFGH'};
  assert.equal(pairLinkFor(invite), pairLink(invite.origin, invite.code));
  assert.equal(safeSvg('<svg viewBox="0 0 1 1"></svg>'), '<svg viewBox="0 0 1 1"></svg>');
  assert.equal(safeSvg('<svg><script>alert(1)</script></svg>'), '');
  assert.equal(safeSvg(undefined), '');
});

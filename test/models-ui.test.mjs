import test from 'node:test';
import assert from 'node:assert/strict';
import {thinkingText, PROVIDERS} from '../public/models-panel.js';
import {
  ollamaModel, localCard, planCard, hostedCard, hostedDraft, loginMessage, httpsLink, availabilityKey,
} from '../public/models-panel.js';

const plan=(over={})=>({installed:true,loggedIn:false,authMethod:null,configured:false,enabled:false,installHint:null,detail:'',available:false,...over});

test('ollamaModel reads the model after the status separator', () => {
  assert.equal(ollamaModel('Local AI · qwen2.5:7b'), 'qwen2.5:7b');
  assert.equal(ollamaModel('Local AI'), '');
});

test('local card shows detected or not detected with a pull command only when missing', () => {
  const up = localCard({name:'Local AI · qwen2.5:7b', available:true});
  assert.equal(up.badge, 'Detected');
  assert.equal(up.copy, null);
  assert.equal(up.model, 'qwen2.5:7b');
  const down = localCard({name:'Local AI · qwen2.5:7b', available:false});
  assert.equal(down.badge, 'Not detected');
  assert.equal(down.tone, 'off');
  assert.equal(down.copy, 'ollama pull qwen2.5:7b');
  assert.match(down.hint, /Install Ollama/);
});

test('claude card: not installed offers the install command and no sign-in', () => {
  const c = planCard('claude', plan({installed:false, installHint:'npm install -g @anthropic-ai/claude-code', enabled:true}));
  assert.equal(c.badge, 'Not installed');
  assert.equal(c.copy, 'npm install -g @anthropic-ai/claude-code');
  assert.equal(c.signIn, false);
  assert.equal(c.toggle.disabled, true);
  assert.equal(c.toggle.checked, true);
});

test('claude card: installed but signed out offers sign-in and keeps the toggle usable', () => {
  const c = planCard('claude', plan({installed:true, loggedIn:false, enabled:false}));
  assert.equal(c.badge, 'Not signed in');
  assert.equal(c.signIn, true);
  assert.equal(c.toggle.disabled, false);
  assert.equal(c.use, 'Off. Cats will not use this plan.');
});

test('claude card: signed in and enabled is in use with no sign-in button', () => {
  const c = planCard('claude', plan({loggedIn:true, configured:true, enabled:true}));
  assert.equal(c.badge, 'Signed in');
  assert.equal(c.tone, 'ok');
  assert.equal(c.signIn, false);
  assert.equal(c.use, 'In use for cats.');
});

test('claude card: enabled but not signed in says cats cannot use it yet', () => {
  const c = planCard('claude', plan({enabled:true, loggedIn:false, configured:false}));
  assert.equal(c.use, 'On, but cats cannot use it until it is signed in.');
});

test('chatgpt card: an API-key login is not ready and asks for a ChatGPT sign-in', () => {
  const c = planCard('chatgpt', plan({loggedIn:true, authMethod:'api_key', configured:false}));
  assert.equal(c.badge, 'Signed in with an API key');
  assert.equal(c.signIn, true);
  assert.match(c.hint, /ChatGPT sign-in/);
});

test('chatgpt card: not installed shows the npm command as text, not a run action', () => {
  const c = planCard('chatgpt', plan({installed:false, installHint:'npm install -g @openai/codex'}));
  assert.equal(c.copy, 'npm install -g @openai/codex');
  assert.equal(c.signIn, false);
});

test('hosted card: the key is shown only by its last four characters and env config cannot be removed', () => {
  const saved = hostedCard({enabled:true, configured:true, source:'settings', hasKey:true, keyLast4:'1234', detail:'Ready.'});
  assert.equal(saved.keyLine, 'Key saved ••••1234');
  assert.equal(saved.removable, true);
  const env = hostedCard({enabled:true, configured:true, source:'env', hasKey:true, keyLast4:'9999', detail:'Ready.'});
  assert.equal(env.removable, false);
  assert.match(env.hint, /environment/);
  assert.equal(hostedCard({enabled:false, configured:false, source:null, hasKey:false}).keyLine, 'No key saved');
});

test('hosted draft accepts only https without login, query or fragment', () => {
  assert.match(hostedDraft({base:'http://example.invalid/v1', model:'m', key:'k'}, null).error, /HTTPS/);
  assert.match(hostedDraft({base:'not a url', model:'m', key:'k'}, null).error, /full HTTPS URL/);
  assert.match(hostedDraft({base:'https://user:pw@example.invalid/v1', model:'m', key:'k'}, null).error, /login, query/);
  assert.match(hostedDraft({base:'https://example.invalid/v1?x=1', model:'m', key:'k'}, null).error, /login, query/);
  assert.match(hostedDraft({base:'https://example.invalid/v1#f', model:'m', key:'k'}, null).error, /login, query/);
  assert.match(hostedDraft({base:'https://example.invalid/v1', model:'  ', key:'k'}, null).error, /model name/);
});

test('hosted draft requires a key for a new endpoint, but reuses the saved key for the same endpoint', () => {
  const fresh = hostedDraft({base:'https://example.invalid/v1', model:'m', key:''}, null);
  assert.match(fresh.error, /API key/);
  const saved = {base:'https://example.invalid/v1', hasKey:true};
  const same = hostedDraft({base:'https://example.invalid/v1', model:'m', key:''}, saved);
  assert.deepEqual(same.body, {base:'https://example.invalid/v1', model:'m'});
  assert.ok(!('key' in same.body));
  const moved = hostedDraft({base:'https://other.invalid/v1', model:'m', key:''}, saved);
  assert.match(moved.error, /API key/);
});

test('hosted draft sends a normalised https base and the typed key', () => {
  const d = hostedDraft({base:'  https://example.invalid/v1  ', model:' gpt ', key:' sk-test-0000000000001234 '}, null);
  assert.deepEqual(d.body, {base:'https://example.invalid/v1', model:'gpt', key:'sk-test-0000000000001234'});
});

test('login message links only an https URL', () => {
  const ok = loginMessage({started:true, url:'https://claude.ai/oauth/authorize?x=1'});
  assert.equal(ok.href, 'https://claude.ai/oauth/authorize?x=1');
  assert.match(ok.text, /Finish signing in in the browser window/);
  assert.equal(loginMessage({started:true, url:'javascript:alert(1)'}).href, null);
  assert.equal(loginMessage({started:true}).href, null);
  assert.match(loginMessage({started:true, alreadyRunning:true}).text, /already running/);
  const auto = loginMessage({started:true, auto:true, url:'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5%2Fcallback'});
  assert.equal(auto.auto, true, 'a link that returns to this computer needs no code box');
  assert.match(auto.text, /Click Authorize there, and Clowder finishes by itself/);
  assert.equal(ok.auto, false);
  assert.match(loginMessage({started:true, auto:true, vpn:'ProTUN', url:'https://claude.com/x'}).text, /^A VPN is on \(ProTUN\)\. .*turn the VPN off/);
  assert.equal(httpsLink('http://example.invalid'), null);
});

test('availability key changes only when a provider becomes usable', () => {
  const base = {local:{available:false}, hosted:{available:false}, claude:{available:false}, chatgpt:{available:false}};
  const signedIn = {...base, claude:{available:true}};
  assert.notEqual(availabilityKey(base), availabilityKey(signedIn));
  assert.equal(availabilityKey(base), availabilityKey({...base, claude:{available:false, detail:'changed'}}));
});

test('a sign-in note drops as soon as the plan reports signed in, even if it was still waiting', async () => {
  const {visibleLogin} = await import('../public/models-panel.js');
  const note = {text: 'Finish signing in in the browser window that opened.', href: 'https://claude.ai/oauth/authorize?x=1'};
  assert.equal(visibleLogin(note, {configured: false}), note, 'shown while not signed in');
  assert.equal(visibleLogin(note, {configured: true}), null, 'gone once signed in');
  assert.equal(visibleLogin(undefined, {configured: false}), null, 'nothing pending, nothing shown');
});

test('the summary strip names the town default: provider, model, effort, and whether it is ready', () => {
  const s = {townDefault:{provider:'claude', model:'sonnet', effort:'high', usable:true}, hosted:{model:'gpt-x'}};
  assert.equal(thinkingText(s), 'Claude plan · sonnet · effort high');
  assert.equal(thinkingText({townDefault:{provider:'hosted', model:null, effort:null, usable:true}, hosted:{model:'gpt-x'}}), 'API key · gpt-x · effort not set');
  assert.equal(thinkingText({townDefault:{provider:'local', model:'qwen3.5:4b', effort:null, usable:false}}), 'Local AI (Ollama) · qwen3.5:4b · effort not set · not ready');
  assert.equal(thinkingText({}), 'Demonstration · scripted');
});

test('the dialog lists the providers in one fixed order, with Images last', () => {
  assert.deepEqual(PROVIDERS.map(p => p.id), ['local', 'claude', 'chatgpt', 'hosted', 'anthropic', 'jev', 'hermes', 'workshop', 'images']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {loginMessage, providerOrder, sameBase} from '../public/models-panel.js';

test('a preset chip is pressed for the saved address, whatever its trailing slash', () => {
  assert.equal(sameBase('https://api.deepseek.com/', 'https://api.deepseek.com'), true);
  assert.equal(sameBase('https://api.openai.com/v1', 'https://api.openai.com/v1'), true);
  assert.equal(sameBase('https://api.openai.com/v2', 'https://api.openai.com/v1'), false);
  assert.equal(sameBase('', 'https://api.openai.com/v1'), false);
});

test('the nav orders ready providers first, then needs attention, then not set; ties keep the fixed order', () => {
  assert.deepEqual(providerOrder({}), ['local', 'claude', 'chatgpt', 'hosted', 'anthropic', 'jev', 'hermes', 'workshop', 'images']);
  assert.deepEqual(providerOrder({hosted: 'ok', claude: 'warn', workshop: 'ok'}),
    ['hosted', 'workshop', 'claude', 'local', 'chatgpt', 'anthropic', 'jev', 'hermes', 'images']);
});

test('sign-in text does not name one plan: the same line serves Claude and ChatGPT', () => {
  const auto = loginMessage({started: true, auto: true, url: 'https://example.com/x'});
  assert.match(auto.text, /^The sign-in page opened in your browser/);
  assert.doesNotMatch(loginMessage({started: true, auto: true, vpn: 'ProTUN', url: 'https://example.com/x'}).text, /Claude/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {secretsNote, PLAINTEXT_NOTE} from '../public/settings-menu.js';

// GET /api/state secrets is the SecretStore's status (src/secret-store.ts): {mode, note}. The note is null when the keys are encrypted.
test('saved keys in plain text read as one quiet line; locked or unmoved keys read plainer; encrypted keys say nothing', () => {
  const plain = {mode: 'plaintext', note: 'Saved keys are stored unencrypted on this computer. Open Clowder from the desktop app to encrypt them.'};
  assert.deepEqual(secretsNote(plain), {text: plain.note, quiet: true});
  assert.deepEqual(secretsNote({mode: 'plaintext', note: null}), {text: PLAINTEXT_NOTE, quiet: true}, 'plain text with no note still says so');
  assert.deepEqual(secretsNote({mode: 'locked', note: 'Saved keys are locked: they were encrypted by the desktop app. Open Clowder from the desktop app.'}).quiet, false);
  assert.equal(secretsNote({mode: 'encrypted', note: null}), null);
  assert.equal(secretsNote(null), null);
  assert.equal(secretsNote(undefined), null);
  assert.equal(secretsNote('plaintext'), null);
});

test('the line sits under the settings list with the build, for the owner only', () => {
  const menu = readFileSync(new URL('../public/settings-menu.js', import.meta.url), 'utf8');
  assert.match(menu, /secrets = event\.detail\?\.next\?\.readOnly \? null : event\.detail\?\.next\?\.secrets \?\? null;/, 'a viewer never sees it');
  assert.match(menu, /make\('p', `settings-secrets\$\{note\.quiet \? '' : ' warn'\}`, note\.text\)/);
  const css = readFileSync(new URL('../public/settings-menu.css', import.meta.url), 'utf8');
  const rules = css.split('\n').filter(line => line.startsWith('.settings-secrets'));
  assert.equal(rules.length, 2);
  for (const rule of rules) assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rule), `no raw colours: ${rule}`);
  assert.match(rules[0], /font:12px\/1\.4 var\(--font-ui\);color:var\(--muted\)/, 'quiet: small and muted');
});

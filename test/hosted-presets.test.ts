import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HOSTED_PRESETS, ModelHub, parseHostedBase} from '../src/models.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));

test('the status hands the presets to the API key form', async () => {
  const hub = new ModelHub({file: join(mkdtempSync(join(tmpdir(), 'hosted-presets-')), 'models.json'), config,
    env: {CAT_OLLAMA_BASE: 'http://127.0.0.1:9', CAT_CODEX: 'C:\\nope\\codex.exe', CAT_CLAUDE: 'C:\\nope\\claude.exe', CAT_PROBE_MS: '2000'}});
  assert.deepEqual((await hub.status()).hosted.presets, HOSTED_PRESETS);
});

test('every API key preset is a base the server accepts, with a model and an https key page', () => {
  assert.ok(HOSTED_PRESETS.length >= 5);
  assert.equal(new Set(HOSTED_PRESETS.map(p => p.id)).size, HOSTED_PRESETS.length, 'preset ids are unique');
  for (const p of HOSTED_PRESETS) {
    assert.equal(parseHostedBase(p.base), new URL(p.base).href, `${p.label} base`);
    assert.ok(p.model.length > 0 && p.model.length <= 120, `${p.label} model`);
    assert.match(p.keyUrl, /^https:\/\//, `${p.label} key page`);
  }
});

test('presets never include Groq, whose docs could not be checked', () => {
  assert.ok(!HOSTED_PRESETS.some(p => /groq/i.test(p.label + p.base)));
});

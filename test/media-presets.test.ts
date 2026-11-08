import test from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA_SPECS, checkMedia} from '../src/media.ts';
import {mediaStatus} from '../src/models.ts';

test('every media preset fills a saved set that checkMedia accepts, with only the key left to type', () => {
  let presets = 0;
  for (const [id, spec] of Object.entries(MEDIA_SPECS)) {
    for (const preset of spec.presets ?? []) {
      presets++;
      assert.match(preset.keyUrl, /^https:\/\//, `${id} ${preset.label} key page is https`);
      const saved = checkMedia(id, {...preset.values, key: 'sk-test-0000000000001234'});
      assert.deepEqual(saved, {...preset.values, key: 'sk-test-0000000000001234'}, `${id} ${preset.label}`);
    }
  }
  assert.ok(presets >= 1);
});

test('the OpenAI images preset is the only image preset and names the endpoint the adapter calls', () => {
  const presets = MEDIA_SPECS['openai-images'].presets ?? [];
  assert.deepEqual(presets.map(p => p.label), ['OpenAI']);
  assert.equal(presets[0].values.base, 'https://api.openai.com/v1');
});

test('mediaStatus carries the hint and presets, and MoneyPrinterTurbo is a video provider', () => {
  const status = mediaStatus({moneyprinter: {base: 'http://127.0.0.1:8080'}});
  const byId = Object.fromEntries(status.map(s => [s.id, s]));
  assert.equal(byId['openai-images'].presets[0].label, 'OpenAI');
  assert.ok(byId['openai-images'].hint);
  assert.deepEqual(byId.moneyprinter.kinds, ['video']);
  assert.equal(byId.moneyprinter.configured, true);
  assert.deepEqual(byId['openai-images'].kinds, ['image']);
  const base = byId['openai-images'].fields.find((f: {name: string}) => f.name === 'base');
  assert.equal(base?.url, true, 'the address field is flagged so the form can span the row');
});

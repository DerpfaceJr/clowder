import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {WorldHost, readWorldTownDefault} from '../src/worlds.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig(root);
// Only local is built here. claude is named by the global default in some tests but is not built, so it cannot be used.
const providers: Record<string, unknown> = {local: {}};

function hostWith(globalDefault: {provider: 'local' | 'claude'; model?: string; effort?: string} | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'world-default-'));
  return {dir, host: new WorldHost({root, dataDir: dir, config, providers, townDefault: () => globalDefault})};
}

test('a world keeps the default chosen at creation, and cats in it resolve to that default only while it is active', () => {
  const {host} = hostWith({provider: 'local', model: 'qwen3.5:4b'});
  const meadow = host.create('Meadow', {provider: 'local', model: 'llama3:8b', effort: 'low'});
  host.activate(meadow.id);
  assert.deepEqual(host.town.townDefault?.(), {provider: 'local', model: 'llama3:8b', effort: 'low'});
  assert.deepEqual(host.town.aiFor('scholar', 'local'), {model: 'llama3:8b', effort: 'low'}, 'a fresh cat takes the world default');
  assert.equal(host.town.aiFor('scholar', 'claude'), undefined, 'the default is for its own provider only');
  host.activate('home');
  assert.deepEqual(host.town.townDefault?.(), {provider: 'local', model: 'qwen3.5:4b'}, 'home keeps the global default');
  host.close();
});

test('two worlds keep their own defaults side by side', () => {
  const {host} = hostWith(null);
  const a = host.create('Alpha', {provider: 'local', model: 'llama3:8b'});
  const b = host.create('Beta', {provider: 'local', model: 'qwen3.5:4b'});
  host.activate(a.id);
  assert.equal(host.town.townDefault?.()?.model, 'llama3:8b');
  host.activate(b.id);
  assert.equal(host.town.townDefault?.()?.model, 'qwen3.5:4b');
  host.close();
});

test('a world with no default of its own uses the global default, and none when there is none', () => {
  const {host} = hostWith({provider: 'local', model: 'qwen3.5:4b'});
  const plain = host.create('Plain');
  host.activate(plain.id);
  assert.deepEqual(host.town.townDefault?.(), {provider: 'local', model: 'qwen3.5:4b'});
  host.close();
  const bare = hostWith(null);
  const made = bare.host.create('Bare');
  bare.host.activate(made.id);
  assert.equal(bare.host.town.townDefault?.(), null, 'no default anywhere: the chat falls back to its own choice');
  bare.host.close();
});

test('a saved world default whose provider is not built, or whose file is damaged, falls back to the global default', () => {
  const {dir, host} = hostWith({provider: 'local', model: 'qwen3.5:4b'});
  const made = host.create('Stale');
  const file = join(dir, 'worlds', made.id, 'town-default.json');
  writeFileSync(file, JSON.stringify({provider: 'claude', model: 'sonnet'}));
  host.activate(made.id);
  assert.deepEqual(host.town.townDefault?.(), {provider: 'local', model: 'qwen3.5:4b'}, 'claude is not built here');
  writeFileSync(file, '{ not json');
  assert.equal(readWorldTownDefault(join(dir, 'worlds', made.id)), null, 'a damaged file reads as unset');
  assert.deepEqual(host.town.townDefault?.(), {provider: 'local', model: 'qwen3.5:4b'});
  host.close();
});

test('a world cannot be created with a demonstration, an unbuilt provider or a bad value, and the failed folder is not left behind', () => {
  const {dir, host} = hostWith(null);
  assert.throws(() => host.create('Demo', {provider: 'demo'}), /Choose a provider/);
  assert.throws(() => host.create('Hosted', {provider: 'hosted', model: 'x'}), /API settings/);
  assert.throws(() => host.create('Claude', {provider: 'claude', model: 'sonnet'}), /not ready/);
  assert.throws(() => host.create('Effort', {provider: 'local', effort: 'ultra'}), /Effort for local/);
  assert.equal(existsSync(join(dir, 'worlds')), false, 'nothing is written for a refused world');
  assert.equal(host.list().worlds.length, 1, 'only home is listed');
  // A null or missing default is the same as no choice.
  const plain = host.create('Null', null);
  assert.equal(existsSync(join(dir, 'worlds', plain.id, 'town-default.json')), false);
  host.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {WorldHost, WorldError, registerWorldDeleteRoute} from '../src/worlds.ts';
import {isOwner} from '../src/access.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig(root);
const ids = (host: WorldHost) => host.list().worlds.map(w => w.id).sort();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'worlds-del-'));
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  return {dir, host};
}

test('delete refuses the home world, the active world, unknown ids and traversal ids, and changes nothing', () => {
  const {dir, host} = setup();
  const meadow = host.create('Meadow');
  host.activate(meadow.id);
  assert.throws(() => host.delete('home'), (err: any) => err instanceof WorldError && err.statusCode === 409 && /archive it instead/.test(err.message));
  assert.throws(() => host.delete(meadow.id), (err: any) => err.statusCode === 409 && /cannot be deleted/.test(err.message));
  for (const id of ['nope-000000', '../home', '..', 'Home', 'a/b', '', '..%2Fworlds']) {
    assert.throws(() => host.delete(id), (err: any) => err.statusCode === 404, id);
  }
  assert.ok(existsSync(join(dir, 'worlds', meadow.id, 'events.jsonl')));
  assert.equal(host.list().worlds.length, 2);
  host.close();
});

test('delete removes only that world folder and its registry entry, and survives a restart', () => {
  const {dir, host} = setup();
  const alpha = host.create('Alpha');
  const beta = host.create('Beta');
  writeFileSync(join(dir, 'worlds', beta.id, 'sentinel.txt'), 'keep');
  const rootJournal = readFileSync(join(dir, 'events.jsonl'));
  host.delete(alpha.id);
  assert.equal(existsSync(join(dir, 'worlds', alpha.id)), false);
  assert.equal(readFileSync(join(dir, 'worlds', beta.id, 'sentinel.txt'), 'utf8'), 'keep');
  assert.deepEqual(readFileSync(join(dir, 'events.jsonl')), rootJournal, 'the home journal is byte-identical');
  const registry = JSON.parse(readFileSync(join(dir, 'worlds.json'), 'utf8'));
  assert.deepEqual(registry.worlds.map((w: {id: string}) => w.id).sort(), ['home', beta.id].sort());
  assert.equal(readdirSync(dir).some(f => f.endsWith('.tmp')), false, 'no temp file is left behind');
  host.close();
  const again = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.deepEqual(ids(again), ['home', beta.id].sort());
  again.close();
});

test('an archived world can be deleted, and unarchive brings a world back to the list', () => {
  const {host} = setup();
  const alpha = host.create('Alpha');
  host.archive(alpha.id);
  assert.deepEqual(host.list().archived.map(w => w.id), [alpha.id]);
  host.unarchive(alpha.id);
  assert.deepEqual(ids(host), ['home', alpha.id].sort());
  assert.deepEqual(host.list().archived, []);
  host.archive(alpha.id);
  host.delete(alpha.id);
  assert.deepEqual(host.list().archived, []);
  assert.deepEqual(ids(host), ['home']);
  host.close();
});

test('delete refuses a world with a running season, and the lock is named in the refusal', () => {
  const {dir, host} = setup();
  const alpha = host.create('Alpha');
  writeFileSync(join(dir, 'worlds', alpha.id, 'season-s1.lock'), String(process.pid));
  assert.throws(() => host.delete(alpha.id), (err: any) => err.statusCode === 409 && /A season is running in Alpha/.test(err.message));
  assert.ok(existsSync(join(dir, 'worlds', alpha.id, 'events.jsonl')));
  assert.deepEqual(ids(host), ['home', alpha.id].sort());
  host.close();
});

test('a world folder that is a junction is refused, and the target survives', () => {
  const {dir, host} = setup();
  const alpha = host.create('Alpha');
  const outside = mkdtempSync(join(tmpdir(), 'worlds-outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'x');
  rmSync(join(dir, 'worlds', alpha.id), {recursive: true, force: true});
  symlinkSync(outside, join(dir, 'worlds', alpha.id), 'junction');
  assert.throws(() => host.delete(alpha.id), /is a link, not a world folder/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'x');
  assert.deepEqual(ids(host), ['home', alpha.id].sort(), 'the refused world stays registered');
  host.close();
});

test('a worlds folder that is itself a junction is refused, and nothing moves', () => {
  const {dir, host} = setup();
  const alpha = host.create('Alpha');
  const elsewhere = mkdtempSync(join(tmpdir(), 'worlds-elsewhere-'));
  renameSync(join(dir, 'worlds'), join(elsewhere, 'worlds'));
  symlinkSync(join(elsewhere, 'worlds'), join(dir, 'worlds'), 'junction');
  assert.throws(() => host.delete(alpha.id), /worlds folder is not inside the data folder/);
  assert.equal(existsSync(join(elsewhere, 'worlds', alpha.id, 'events.jsonl')), true);
  host.close();
});

test('a registry entry that points at another world folder is refused', () => {
  const {dir, host} = setup();
  const alpha = host.create('Alpha');
  const beta = host.create('Beta');
  host.close();
  const registry = JSON.parse(readFileSync(join(dir, 'worlds.json'), 'utf8'));
  registry.worlds.find((w: {id: string}) => w.id === alpha.id).dir = `worlds/${beta.id}`;
  writeFileSync(join(dir, 'worlds.json'), JSON.stringify(registry));
  const again = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.throws(() => again.delete(alpha.id), /does not match its registry entry/);
  assert.equal(existsSync(join(dir, 'worlds', beta.id, 'events.jsonl')), true, 'the other world is untouched');
  again.close();
});

test('delete is owner-only: proxied and remote requests get 403 and change nothing', async () => {
  const {host} = setup();
  const alpha = host.create('Alpha');
  const app = Fastify();
  registerWorldDeleteRoute(app, host, isOwner);
  await app.ready();
  const json = {'content-type': 'application/json'};
  const url = `/api/worlds/${alpha.id}/delete`;
  assert.equal((await app.inject({method: 'POST', url, headers: json, payload: {}, remoteAddress: '192.168.1.20'})).statusCode, 403);
  assert.equal((await app.inject({method: 'POST', url, headers: {...json, 'x-forwarded-for': '203.0.113.9'}, payload: {}})).statusCode, 403);
  assert.deepEqual(ids(host), ['home', alpha.id].sort(), 'refused requests change nothing');
  assert.equal((await app.inject({method: 'POST', url, headers: json, payload: {}})).statusCode, 200);
  assert.deepEqual(ids(host), ['home']);
  await app.close();
  host.close();
});

test('the delete route refuses a listener whose guard refuses writes', async () => {
  const {host} = setup();
  const alpha = host.create('Alpha');
  const app = Fastify();
  registerWorldDeleteRoute(app, host, () => false);
  await app.ready();
  const res = await app.inject({method: 'POST', url: `/api/worlds/${alpha.id}/delete`, headers: {'content-type': 'application/json'}, payload: {}});
  assert.equal(res.statusCode, 403);
  assert.deepEqual(ids(host), ['home', alpha.id].sort());
  await app.close();
  host.close();
});

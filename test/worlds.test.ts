import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {WorldHost, WorldError, readRegistry, registerWorldRoutes} from '../src/worlds.ts';
import {SeasonHost} from '../src/season-host.ts';
import {isOwner} from '../src/access.ts';
import {Pairing} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig(root);
const FOUNDERS = config.cats.map((c: {id: string}) => c.id).sort();

function setup(seed?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'worlds-'));
  seed?.(dir);
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  return {dir, host};
}
const ids = (host: WorldHost) => host.store.state.cats.map(c => c.id).sort();

test('a fresh data dir is one home world and writes no registry until a change', () => {
  const {dir, host} = setup();
  assert.equal(host.activeId, 'home');
  assert.equal(host.dir, dir);
  assert.equal(existsSync(join(dir, 'worlds.json')), false);
  assert.deepEqual(host.list().worlds.map(w => w.id), ['home']);
  assert.deepEqual(ids(host), FOUNDERS, 'home is founded with the config cats');
  host.close();
});

test('creating a world founds it like a fresh install and writes the registry atomically', () => {
  const {dir, host} = setup();
  const made = host.create('Meadow Hall');
  assert.match(made.id, /^meadow-hall-[0-9a-f]{6}$/);
  assert.equal(made.name, 'Meadow Hall');
  const worldDir = join(dir, 'worlds', made.id);
  assert.ok(existsSync(join(worldDir, 'events.jsonl')), 'the new world has its own journal');
  assert.equal(readdirSync(dir).some(f => f.endsWith('.tmp')), false, 'no temp file is left behind');
  const registry = JSON.parse(readFileSync(join(dir, 'worlds.json'), 'utf8'));
  assert.equal(registry.active, 'home');
  assert.equal(registry.worlds.at(-1).dir, `worlds/${made.id}`);
  host.close();
});

test('the new world has the founding cats, and the switch shows the other world', () => {
  const {host} = setup();
  const meadow = host.create('Meadow');
  host.activate(meadow.id);
  assert.deepEqual(ids(host), FOUNDERS);
  host.town.recruit('owner', 'Pip', 'Tester');
  assert.ok(ids(host).includes('pip'));
  host.activate('home');
  assert.equal(ids(host).includes('pip'), false, 'home does not see the cat recruited in Meadow');
  host.activate(meadow.id);
  assert.ok(ids(host).includes('pip'), 'switching back restores the Meadow cats from its journal');
  host.close();
});

test('the home world keeps its root files unchanged across boot, create and switch', () => {
  const {dir, host} = setup(dir => {
    const store = new Store(join(dir, 'events.jsonl'), config.cats);
    new Town(store, config, {}).recruit('owner', 'Rowan', 'Gardener');
  });
  const before = readFileSync(join(dir, 'events.jsonl'));
  host.close();
  const again = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.ok(again.store.state.cats.some(c => c.id === 'rowan'), 'the pre-existing history is replayed as-is');
  const world = again.create('Elsewhere');
  again.activate(world.id);
  again.activate('home');
  assert.deepEqual(readFileSync(join(dir, 'events.jsonl')), before, 'the root journal is byte-identical');
  assert.equal(existsSync(join(dir, 'worlds', world.id)), true);
  again.close();
});

test('a switch refuses while a task is running, and proceeds once it finishes', () => {
  const {host} = setup();
  const meadow = host.create('Meadow');
  host.store.emit('task.created', {id: 't1', cat: 'mayor', from: 'owner', text: 'busy', mode: 'demo', status: 'running'});
  assert.throws(() => host.activate(meadow.id), (err: any) => err instanceof WorldError && err.statusCode === 409 && /Finish or pause current work first/.test(err.message));
  assert.equal(host.activeId, 'home');
  host.store.emit('task.updated', {id: 't1', status: 'completed'});
  host.activate(meadow.id);
  assert.equal(host.activeId, meadow.id);
  host.close();
});

test('a switch refuses while a season is running for the current world', () => {
  const {host} = setup();
  const meadow = host.create('Meadow');
  const seasons = host.seasons as any;
  seasons.child = {proc: {pid: 1}, name: 's1', mode: 'demo', startedAt: 'now'};
  assert.throws(() => host.activate(meadow.id), /Finish or pause current work first: a season is running/);
  seasons.child = undefined;
  host.close();
});

test('a damaged target journal leaves the current world running and the registry unchanged', () => {
  const {dir, host} = setup();
  const meadow = host.create('Meadow');
  writeFileSync(join(dir, 'worlds', meadow.id, 'events.jsonl'), 'not json\n');
  assert.throws(() => host.activate(meadow.id));
  assert.equal(host.activeId, 'home');
  assert.equal(readRegistry(dir).active, 'home');
  host.close();
});

test('switching notifies every client, and archived worlds leave the list but keep their files', () => {
  const {dir, host} = setup();
  const meadow = host.create('Meadow');
  let pings = 0;
  const client = () => pings++;
  host.clients.add(client);
  host.activate(meadow.id);
  assert.equal(pings, 1, 'one changed frame per switch');
  assert.throws(() => host.archive(meadow.id), /cannot be archived/);
  host.activate('home');
  host.archive(meadow.id);
  assert.deepEqual(host.list().worlds.map(w => w.id), ['home']);
  assert.ok(existsSync(join(dir, 'worlds', meadow.id, 'events.jsonl')));
  assert.throws(() => host.activate(meadow.id), /Unknown world/);
  host.clients.delete(client);
  host.close();
});

test('rename changes the name and survives a reload of the registry', () => {
  const {dir, host} = setup();
  const meadow = host.create('Meadow');
  host.rename(meadow.id, '  Lantern Hill ');
  host.close();
  const again = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.equal(again.list().worlds.find(w => w.id === meadow.id)?.name, 'Lantern Hill');
  again.close();
});

test('seasons are per world: a journal in one world is not listed by another', () => {
  const {dir, host} = setup(dir => writeFileSync(join(dir, 'season-a.jsonl'), ''));
  assert.deepEqual(host.seasons.list().seasons.map(s => s.name), ['a']);
  const meadow = host.create('Meadow');
  host.activate(meadow.id);
  assert.deepEqual(host.seasons.list().seasons.map(s => s.name), []);
  writeFileSync(join(dir, 'worlds', meadow.id, 'season-b.jsonl'), '');
  assert.deepEqual(host.seasons.list().seasons.map(s => s.name), ['b']);
  host.close();
});

test('names are 1 to 40 characters, and a name cannot build a path', () => {
  const {dir, host} = setup();
  assert.throws(() => host.create('   '), /Give the world a name/);
  assert.throws(() => host.create('x'.repeat(41)), /at most 40/);
  assert.equal(host.create('x'.repeat(40)).name.length, 40);
  const traversal = host.create('../../escape');
  assert.match(traversal.id, /^escape-[0-9a-f]{6}$/);
  assert.equal(existsSync(join(dir, '..', 'escape')), false);
  host.close();
});

test('a season child gets the shared dir for models and its own world dir for the journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worlds-'));
  const worldDir = join(dir, 'worlds', 'w1');
  const host = new SeasonHost({
    root, dataDir: worldDir, sharedDataDir: dir,
    launch: () => ({file: process.execPath, args: ['-e', 'console.log(process.env.CAT_TOWN_SHARED_DATA+"|"+process.env.CAT_TOWN_DATA)']}),
  });
  await host.start({name: 's1', mode: 'demo'});
  for (let i = 0; i < 200 && host.running(); i++) await new Promise(r => setTimeout(r, 50));
  const [sharedSeen, worldSeen] = readFileSync(join(worldDir, 'season-s1.log'), 'utf8').trim().split('|');
  assert.equal(sharedSeen, dir);
  assert.equal(worldSeen, worldDir);
});

test('ids that do not match the slug pattern are refused before any lookup', () => {
  const {host} = setup();
  for (const id of ['../home', '..', 'Home', 'a/b', '', 'x'.repeat(80)]) {
    assert.throws(() => host.activate(id), (err: any) => err.statusCode === 404, id);
  }
  host.close();
});

test('a hand-edited registry that points outside the data dir is refused', () => {
  const {dir, host} = setup();
  host.create('Meadow');
  host.close();
  const registry = JSON.parse(readFileSync(join(dir, 'worlds.json'), 'utf8'));
  registry.worlds.push({id: 'evil-000000', name: 'Evil', createdAt: 'now', dir: '../outside'});
  writeFileSync(join(dir, 'worlds.json'), JSON.stringify(registry));
  assert.throws(() => readRegistry(dir), /outside the data dir/);
});

test('a damaged registry is reported, never replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worlds-'));
  writeFileSync(join(dir, 'worlds.json'), '{ broken');
  assert.throws(() => readRegistry(dir), /is damaged/);
  assert.throws(() => new WorldHost({root, dataDir: dir, config, providers: {}}), /is damaged/, 'the host will not boot over it');
  assert.equal(readFileSync(join(dir, 'worlds.json'), 'utf8'), '{ broken');
});

test('a listener whose guard refuses writes returns 403 on every write, even from loopback', async () => {
  const {host} = setup();
  const app = Fastify();
  registerWorldRoutes(app, host, () => false);
  await app.ready();
  const json = {'content-type': 'application/json'};
  const created = await app.inject({method: 'POST', url: '/api/worlds', headers: json, payload: {name: 'Nope'}});
  assert.equal(created.statusCode, 403);
  for (const action of ['activate', 'rename', 'archive']) {
    const res = await app.inject({method: 'POST', url: `/api/worlds/home/${action}`, headers: json, payload: {name: 'X'}});
    assert.equal(res.statusCode, 403, action);
  }
  assert.equal(host.list().worlds.length, 1);
  await app.close();
  host.close();
});

test('the tunnel listener shows worlds to paired devices and lets only an owner device write', async () => {
  const {host} = setup();
  const dir = mkdtempSync(join(tmpdir(), 'worlds-remote-'));
  const pairing = new Pairing(join(dir, 'devices.json'), config.remote);
  const origin = 'https://test-town.trycloudflare.com';
  const app = Fastify();
  installRemoteAccess(app, pairing, () => origin);
  registerWorldRoutes(app, host, isOwner);
  await app.ready();
  const viewer = pairing.pair(pairing.create('viewer').code, 'Viewer');
  const phone = pairing.pair(pairing.create('owner').code, 'Phone');
  const as = (device: {token: string}) => ({host: new URL(origin).host, origin, 'x-town-action': 'owner', 'content-type': 'application/json', cookie: `__Host-town_device=${device.token}`});
  const listed = await app.inject({method: 'GET', url: '/api/worlds', headers: as(viewer)});
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().active, 'home');
  const unpaired = await app.inject({method: 'GET', url: '/api/worlds', headers: {host: new URL(origin).host, origin}});
  assert.equal(unpaired.statusCode, 401, 'an unpaired request gets nothing');
  assert.equal((await app.inject({method: 'POST', url: '/api/worlds', headers: as(viewer), payload: {name: 'Nope'}})).statusCode, 403);
  assert.equal(host.list().worlds.length, 1);
  assert.equal((await app.inject({method: 'POST', url: '/api/worlds', headers: as(phone), payload: {name: 'Phone world'}})).statusCode, 200);
  assert.equal(host.list().worlds.length, 2);
  await app.close();
  host.close();
});

test('listing is open, and every write is owner-only', async () => {
  const {host} = setup();
  const app = Fastify();
  registerWorldRoutes(app, host, isOwner);
  await app.ready();
  const json = {'content-type': 'application/json'};
  const remote = {remoteAddress: '192.168.1.20'};
  assert.equal((await app.inject({method: 'GET', url: '/api/worlds', ...remote})).statusCode, 200);
  assert.equal((await app.inject({method: 'POST', url: '/api/worlds', headers: json, payload: {name: 'Nope'}, ...remote})).statusCode, 403);
  assert.equal((await app.inject({method: 'POST', url: '/api/worlds', headers: {...json, 'x-forwarded-for': '203.0.113.9'}, payload: {name: 'Nope'}})).statusCode, 403);
  assert.equal(host.list().worlds.length, 1, 'refused writes change nothing');
  const ok = await app.inject({method: 'POST', url: '/api/worlds', headers: json, payload: {name: 'Meadow'}});
  assert.equal(ok.statusCode, 200);
  const id = ok.json().world.id;
  assert.equal((await app.inject({method: 'POST', url: `/api/worlds/${id}/activate`, headers: json, payload: {}, ...remote})).statusCode, 403);
  assert.equal((await app.inject({method: 'POST', url: `/api/worlds/${id}/rename`, headers: json, payload: {name: 'X'}, ...remote})).statusCode, 403);
  assert.equal((await app.inject({method: 'POST', url: `/api/worlds/${id}/archive`, headers: json, payload: {}, ...remote})).statusCode, 403);
  const travel = await app.inject({method: 'POST', url: '/api/worlds/..%2Fhome/activate', headers: json, payload: {}});
  assert.equal(travel.statusCode, 404);
  assert.equal(host.activeId, 'home');
  await app.close();
  host.close();
});

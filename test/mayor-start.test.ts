// A new world starts with the Mayor alone; the other roles are a catalogue the Mayor recruits from. Covers the founding,
// the home world staying intact, catalogue recruiting, delegation to a missing cat, the Mayor's brief and the intro flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {WorldHost, registerWorldIntroRoute} from '../src/worlds.ts';
import {isOwner} from '../src/access.ts';
import {allRoles, catalogueRole} from '../src/roles.ts';
import {townLayout} from '../public/hamlet-layout.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig(root);
const tmp = (name: string) => mkdtempSync(join(tmpdir(), name));
// The roster the home journal was founded with before this change: the Mayor and the seven specialists, no Artist.
const legacyRoster = () => allRoles(config).filter(c => c.id !== 'artist');
const ids = (store: Store) => store.state.cats.map(c => c.id);
const fixture = () => {
  const file = join(tmp('mayor-start-'), 'events.jsonl');
  const store = new Store(file, config.cats);
  return {file, store, town: new Town(store, config)};
};
const call = (name: string, args: unknown) => ({role: 'assistant', content: null, tool_calls: [{id: `${name}-${Math.random()}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
const say = (content: string) => ({role: 'assistant', content});
// Runs one Mayor task through a scripted model: each reply is returned in order.
async function runMayor(town: Town, replies: any[], mode = 'test') {
  const task = town.createTask('mayor', 'owner', 'Staff the town', mode);
  const ctx = town.context(task, 0);
  let turn = 0;
  town.providers[mode] = async () => ({message: replies[turn++]});
  await town.run(task, ctx);
  return ctx;
}
const toolResults = (ctx: {messages: any[]}) => ctx.messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n');

test('a new world has exactly the Mayor, the main plaza and the memorial road', () => {
  const {store} = fixture();
  assert.deepEqual(ids(store), ['mayor']);
  assert.equal(store.state.cats[0].home?.style, 'mayor');
  assert.ok(store.state.groups.some(g => g.id === 'main'), 'the main plaza is founded');
  assert.ok(townLayout(store.state.cats, store.state.groups, config.world.layout).roads.some((r: any) => r.memorial), 'the memorial road is laid with the Mayor alone');
});

test('an empty journal gets the Mayor alone, and a brand-new world is pending its intro', () => {
  const file = join(tmp('mayor-empty-'), 'events.jsonl');
  writeFileSync(file, '');
  const store = new Store(file, config.cats);
  assert.deepEqual(ids(store), ['mayor']);
  assert.equal(store.state.introduced, false);
  assert.match(readFileSync(file, 'utf8'), /"type":"world\.introduced","data":\{"introduced":false\}/);
});

test('a fresh install and a created world both start with the Mayor alone', () => {
  const dir = tmp('mayor-fresh-');
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.deepEqual(ids(host.store), ['mayor']);
  const meadow = host.create('Meadow');
  host.activate(meadow.id);
  assert.deepEqual(ids(host.store), ['mayor']);
  host.close();
});

test('the home world keeps its eight cats and its journal bytes when the config changes', () => {
  const dir = tmp('mayor-home-');
  const file = join(dir, 'events.jsonl');
  // A journal from before the intro flag: founded with the old roster, then planned by the town.
  const store = new Store(file, legacyRoster());
  new Town(store, config);
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(line => !line.includes('"type":"world.introduced"')).join('\n'));
  const before = readFileSync(file);
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.deepEqual(ids(host.store).sort(), legacyRoster().map(c => c.id).sort(), 'the eight cats are replayed from the journal');
  assert.equal(host.introPending, false, 'an old journal is never pending an intro');
  host.close();
  assert.deepEqual(readFileSync(file), before, 'the root journal is byte-identical');
});

test('the demo Mayor recruits the roles its script needs in a new world, with no tool error', async () => {
  const {store, town} = fixture();
  const task = town.createTask('mayor', 'owner', 'Start a small experiment', 'demo');
  const ctx = town.context(task, 0);
  await town.run(task, ctx);
  assert.deepEqual(['scholar', 'critic', 'banker'].filter(id => !ids(store).includes(id)), [], 'the cats the script delegates to now exist');
  assert.doesNotMatch(toolResults(ctx), /not in town yet|Unknown cat|Tool error/);
});

test('create_cat with a catalogue name and a blank role uses the catalogue role', async () => {
  const {store, town} = fixture();
  await runMayor(town, [call('create_cat', {name: 'Critic', role: ''}), say('Done.')]);
  assert.equal(store.state.cats.find(c => c.id === 'critic')?.role, catalogueRole(config, 'Critic')!.role);
});

test('create_cat with a catalogue name fills in its role, colour, icon and house', async () => {
  const {store, town} = fixture();
  const ctx = await runMayor(town, [call('create_cat', {name: 'Builder'}), say('Recruited.')]);
  const entry = catalogueRole(config, 'Builder')!;
  const builder = store.state.cats.find(c => c.id === 'builder')!;
  assert.equal(builder.role, entry.role);
  assert.equal(builder.color, entry.color);
  assert.equal(builder.icon, entry.icon);
  assert.equal(builder.home?.style, 'builder');
  assert.match(toolResults(ctx), /Recruited builder\./);
});

test('create_cat keeps the Mayor model suggestion and applies it at once', async () => {
  const {store, town} = fixture();
  await runMayor(town, [call('create_cat', {name: 'Scholar', suggestedEffort: 'high', suggestionReason: 'Research needs depth'}), say('Done.')], 'local');
  assert.deepEqual(store.state.cats.find(c => c.id === 'scholar')?.ai, {local: {effort: 'high'}});
});

test('delegating to a cat that is not in town yet asks the Mayor to recruit it first', async () => {
  const {store, town} = fixture();
  const ctx = await runMayor(town, [call('delegate', {cat: 'builder', task: 'Draft a plan'}), say('Noted.')]);
  assert.match(toolResults(ctx), /builder is not in town yet\. Recruit it first with create_cat/);
  assert.equal(store.state.tasks.length, 1, 'no child task was started');
});

test("the Mayor's prompt lists the catalogue and who is already in town", () => {
  const {store, town} = fixture();
  town.recruit('owner', 'Pip', 'Tester');
  const prompt = (cat: string) => String(town.context({id: 't', cat, from: 'owner', text: 'hi', mode: 'demo', status: 'running'} as any, 0).messages[0].content);
  const mayor = prompt('mayor');
  assert.match(mayor, /Catalogue: .*Artist \(/);
  assert.match(mayor, /Builder \(Plan and draft/);
  assert.match(mayor, /In town now: mayor, pip\./);
  assert.doesNotMatch(prompt('pip'), /Catalogue:/, 'only the Mayor recruits, so only its brief lists the catalogue');
  assert.equal(store.state.cats.length, 2);
});

test('the intro flag is pending for a new world and cleared once the owner has seen it, even after a reopen', () => {
  const dir = tmp('mayor-intro-');
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.equal(host.introPending, true);
  assert.equal(host.markIntroSeen(), false);
  assert.equal(host.introPending, false);
  host.close();
  const again = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.equal(again.introPending, false);
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /"introduced":true/);
  again.close();
});

test('the intro-seen route is owner-only: a proxied request and the remote listener get 403', async () => {
  const dir = tmp('mayor-route-');
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  const app = Fastify();
  registerWorldIntroRoute(app, host, isOwner);
  const remote = Fastify();
  registerWorldIntroRoute(remote, host, () => false);
  const proxied = await app.inject({method: 'POST', url: '/api/world/intro-seen', headers: {'x-forwarded-for': '203.0.113.9'}});
  assert.equal(proxied.statusCode, 403);
  assert.equal(host.introPending, true, 'a refused request changes nothing');
  assert.equal((await remote.inject({method: 'POST', url: '/api/world/intro-seen'})).statusCode, 403);
  const owner = await app.inject({method: 'POST', url: '/api/world/intro-seen'});
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.json().introPending, false);
  await app.close();
  await remote.close();
  host.close();
});

test('catalogue roles settle around the Mayor plaza; project-specific recruits found their own hamlet', async () => {
  const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {Store}=await import('../src/store.ts');const {Town}=await import('../src/engine.ts');
  const cfg=JSON.parse((await import('node:fs')).readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
  const store=new Store(join(mkdtempSync(join(tmpdir(),'plaza-')),'events.jsonl'),cfg.cats),town=new Town(store,cfg);
  const root={id:'project-1',cat:'mayor',from:'owner',text:'Open a bakery',mode:'demo',status:'running'} as any;
  const scholar=town.recruit('mayor','Scholar','',undefined,root);
  const baker=town.recruit('mayor','Baker','Bakes bread for the bakery project',undefined,root);
  const group=(id:string)=>store.state.cats.find(c=>c.id===id)!.group;
  assert.equal(group(scholar),group('mayor'),'a catalogue role joins the main hamlet');
  assert.notEqual(group(baker),group('mayor'),'a project recruit founds the project hamlet');
});

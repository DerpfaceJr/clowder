// A new world starts with the Mayor and the Mailman; the other roles are a catalogue the Mayor recruits from. Covers the founding,
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
import {allRoles, catalogueRole, foundingCats} from '../src/roles.ts';
import {townLayout} from '../public/hamlet-layout.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig(root);
const tmp = (name: string) => mkdtempSync(join(tmpdir(), name));
// The roster the home journal was founded with before this change: the Mayor and the seven specialists, no Artist.
const legacyRoster = () => allRoles(config).filter(c => c.id !== 'artist' && c.id !== 'mailman');
// The config before the Mailman: no founder role in the catalogue.
const noMailman = () => ({...config, roleCatalogue: config.roleCatalogue.filter((r: {id: string}) => r.id !== 'mailman')});
const ids = (store: Store) => store.state.cats.map(c => c.id);
const fixture = () => {
  const file = join(tmp('mayor-start-'), 'events.jsonl');
  const store = new Store(file, foundingCats(config));
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

test('a new world has exactly the Mayor and the Mailman, the main plaza and the memorial road', () => {
  const {store, file} = fixture();
  assert.deepEqual(ids(store), ['mayor', 'mailman']);
  assert.equal(store.state.cats[0].home?.style, 'mayor');
  assert.equal(store.state.cats[1].home?.style, 'mailman', 'the Mailman lives in the post office');
  assert.equal(store.state.cats[1].group, 'main', 'beside the Mayor');
  assert.ok(store.state.roads.some(r => r.id.includes('mailman') && r.id.includes('mayor')), 'a founder has a road to the Mayor');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /"type":"cat\.created"/, 'a founder is founded, not recruited');
  assert.ok(store.state.groups.some(g => g.id === 'main'), 'the main plaza is founded');
  assert.ok(townLayout(store.state.cats, store.state.groups, config.world.layout).roads.some((r: any) => r.memorial), 'the memorial road is laid');
});

test('an empty journal gets the founders, and a brand-new world is pending its intro', () => {
  const file = join(tmp('mayor-empty-'), 'events.jsonl');
  writeFileSync(file, '');
  const store = new Store(file, foundingCats(config));
  assert.deepEqual(ids(store), ['mayor', 'mailman']);
  assert.equal(store.state.introduced, false);
  assert.match(readFileSync(file, 'utf8'), /"type":"world\.introduced","data":\{"introduced":false\}/);
});

test('a fresh install and a created world both start with the Mayor and the Mailman', () => {
  const dir = tmp('mayor-fresh-');
  const host = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.deepEqual(ids(host.store), ['mayor', 'mailman']);
  const meadow = host.create('Meadow');
  host.activate(meadow.id);
  assert.deepEqual(ids(host.store), ['mayor', 'mailman']);
  host.close();
});

test('the home world keeps its eight cats, gains the Mailman once, and is then byte-identical', () => {
  const dir = tmp('mayor-home-');
  const file = join(dir, 'events.jsonl');
  // A journal from before the intro flag and the Mailman: founded with the old roster, then planned by the town.
  const store = new Store(file, legacyRoster());
  new Town(store, noMailman());
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(line => !line.includes('"type":"world.introduced"')).join('\n'));
  const before = readFileSync(file, 'utf8');
  let host = new WorldHost({root, dataDir: dir, config, providers: {}});
  assert.deepEqual(ids(host.store).sort(), [...legacyRoster().map(c => c.id), 'mailman'].sort(), 'the eight cats are replayed, and the Mailman joins');
  assert.equal(host.introPending, false, 'an old journal is never pending an intro');
  host.close();
  const after = readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before), 'the old journal is kept as it was');
  const added = after.slice(before.length).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(added.filter(e => e.type === 'cat.created').map(e => [e.data.id, e.data.home.style, e.data.group]), [['mailman', 'mailman', 'main']], 'one journaled recruit');
  host = new WorldHost({root, dataDir: dir, config, providers: {}});
  host.close();
  assert.equal(readFileSync(file, 'utf8'), after, 'a second load recruits nothing');
});

test('an older world recruits the Mailman once: a retired one stays retired, and a full town logs and goes on', () => {
  const old = () => {const file = join(tmp('mailman-old-'), 'events.jsonl'), store = new Store(file, config.cats);new Town(store, noMailman());return {file, store};};
  const a = old();
  assert.deepEqual(ids(a.store), ['mayor'], 'the old config founds the Mayor alone');
  new Town(a.store, config);
  assert.deepEqual(ids(a.store), ['mayor', 'mailman']);
  assert.equal(a.store.state.cats[1].role, catalogueRole(config, 'Mailman')!.role);
  assert.equal(a.store.state.cats[1].icon, '✉');
  // Retired: off the town and on the retired list, as a council retirement leaves it.
  a.store.state.retiredCats.push({...a.store.state.cats[1]} as any);a.store.state.cats = a.store.state.cats.filter(c => c.id !== 'mailman');
  const size = readFileSync(a.file, 'utf8').length;
  new Town(a.store, config);
  assert.deepEqual(ids(a.store), ['mayor'], 'a retired Mailman is not brought back');
  assert.equal(readFileSync(a.file, 'utf8').length, size, 'nothing journaled');
  const b = old(), warn = console.warn, said: string[] = [];
  console.warn = (m: string) => { said.push(m); };
  try { new Town(b.store, {...config, maxCats: 1}); } finally { console.warn = warn; }
  assert.deepEqual(ids(b.store), ['mayor'], 'never past maxCats');
  assert.match(said.join('\n'), /No Mailman recruited: Town capacity reached/);
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
  assert.match(mayor, /In town now: mayor, mailman, pip\./);
  assert.doesNotMatch(prompt('pip'), /Catalogue:/, 'only the Mayor recruits, so only its brief lists the catalogue');
  assert.equal(store.state.cats.length, 3);
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

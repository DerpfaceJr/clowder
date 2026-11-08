import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EVERY_WORLD, grantIn, type Accounts} from '../src/accounts.ts';
import {ConnectorHub} from '../src/connectors.ts';
import {Store} from '../src/store.ts';

const PORT = 4321;
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
async function until(fn: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('Timed out waiting for the connectors');
}
const fakeClient = {info: {}, listTools: async () => [{name: 'search', annotations: {readOnlyHint: true}}, {name: 'write_page'}], callTool: async (name: string) => ({text: `ran ${name}`, isError: false}), close: async () => {}};
const fakeConnect = (async () => fakeClient) as any;
const TOOLS = ['search', 'write_page'];

// Today's files, shaped like the owner's (8 connectors: 3 Instagram over stdio, 4 every-cat, 3 naming the Mayor; 3 worlds), with fake values only.
const ig = (id: string, name: string, cats: string[], tools = {}) => ({id, name, source: 'custom', transport: {type: 'stdio', command: 'node', args: ['ig-mcp.js'], env: {INSTAGRAM_ACCESS_TOKEN: '${INSTAGRAM_ACCESS_TOKEN}', INSTAGRAM_ACCOUNT_ID: '${INSTAGRAM_ACCOUNT_ID}'}}, enabled: true, cats, tools, addedAt: 1});
const http = (id: string, name: string, url: string, cats: string[], tools = {}, extra = {}) => ({id, name, source: 'directory', transport: {type: 'http', url}, enabled: true, cats, tools, addedAt: 1, ...extra});
const LEGACY = [
  http('context7', 'Context7', 'https://mcp.context7.com/mcp', ['*'], {}, {trust: 'read-only'}),
  http('deepwiki', 'DeepWiki', 'https://mcp.deepwiki.com/mcp', ['*'], {}, {trust: 'read-only'}),
  {...http('github', 'GitHub', 'https://api.githubcopilot.com/mcp/', ['mayor'], {write_page: 'allow'}), transport: {type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: {Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}'}}},
  ig('instagram', 'Instagram @alpha', ['*'], {write_page: 'allow'}),
  http('vercel', 'Vercel', 'https://mcp.vercel.com', ['mayor', 'builder', 'scholar', 'critic', 'reel_builder'], {write_page: 'off'}),
  ig('instagram-beta', 'Instagram @beta', ['*']),
  ig('instagram-gamma', 'Instagram @gamma', ['*']),
  {...http('notes', 'Notes', 'https://notes.example/mcp', ['reel_builder', 'mayor'], {search: 'off'}), source: 'custom'},
] as {id: string; name: string; cats: string[]; tools: Record<string, string>}[];
const FAKE = ['fake-gh-token-111', 'fake-ig-token-aaa', 'fake-ig-token-bbb', 'fake-ig-token-ccc', '17841400000000001', '17841400000000002', '17841400000000003', 'fake-vercel-access', 'fake-vercel-refresh', 'fake-vercel-client', 'fake-hosted-key-999', 'fake-jev-key-888', 'fake-media-key-777', 'fake-ext-token-123'];
const igVars = (n: number) => ({vars: {INSTAGRAM_ACCESS_TOKEN: FAKE[1 + n], INSTAGRAM_ACCOUNT_ID: FAKE[4 + n]}});
const FILES: Record<string, unknown> = {
  'connectors.json': {connectors: LEGACY, plugins: [], marketplaces: []},
  'connector-secrets.json': {github: {vars: {GITHUB_PERSONAL_ACCESS_TOKEN: FAKE[0]}}, instagram: igVars(0), 'instagram-beta': igVars(1), 'instagram-gamma': igVars(2), vercel: {vars: {}, oauth: {accessToken: FAKE[7], refreshToken: FAKE[8], clientId: FAKE[9], expiresAt: 4102444800000}}},
  'models.json': {claude: {enabled: true}, chatgpt: {enabled: false}, hosted: {base: 'https://api.openai.com/v1', model: 'gpt-test', key: FAKE[10]}, jev: {enabled: true, key: FAKE[11]}, media: {seedance: {imageModel: 'seedream-test', key: FAKE[12]}}, defaults: {}},
  'cat-browser.json': {mode: 'chrome', token: FAKE[13]},
  'worlds.json': {active: 'social-abc123', worlds: [{id: 'home', name: 'Clowder', createdAt: '2026-10-01T00:00:00.000Z', dir: '.'}, {id: 'social-abc123', name: 'Social', createdAt: '2026-10-02T00:00:00.000Z', dir: 'worlds/social-abc123'}, {id: 'lab-def456', name: 'Lab', createdAt: '2026-10-03T00:00:00.000Z', dir: 'worlds/lab-def456'}]},
};
function fixture() {
  const dir = tmp('accounts-data-');
  for (const [name, value] of Object.entries(FILES)) writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
  return dir;
}
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');
const hubAt = (dataDir: string, world?: () => string) => new ConnectorHub({dataDir, port: PORT, home: tmp('accounts-home-'), connect: fakeConnect, ...(world ? {world} : {})});
// What today's connectors.json gives a cat, worked out from the file itself: every tool of each connector naming it (or '*') that is not off.
const expected = (cat: string, only = (_c: {cats: string[]}) => true) => LEGACY.filter(c => only(c) && (c.cats.includes('*') || c.cats.includes(cat))).flatMap(c => TOOLS.filter(t => c.tools[t] !== 'off').map(t => `mcp__${c.id}__${t}`)).sort();
const offered = (hub: ConnectorHub, cat: string) => hub.toolsFor(cat).map(t => t.function.name).sort();

test('the boot migration turns today’s files into Accounts and Grants without loss, holds no secret value, and a second boot changes nothing', async () => {
  const dir = fixture(), before = Object.fromEntries(Object.keys(FILES).map(f => [f, read(dir, f)]));
  await hubAt(dir).dispose();
  const text = read(dir, 'accounts.json'), a: Accounts = JSON.parse(text);
  for (const f of Object.keys(FILES)) assert.equal(read(dir, f), before[f], `${f} is only read`);
  for (const v of FAKE) assert.ok(!text.includes(v), 'accounts.json holds metadata only');
  const kinds = (pred: (s: string) => boolean) => a.accounts.filter(x => pred(x.service)).length;
  // 5 every-world grants; the 3 naming the Mayor get one per world (no journal here, so their other cats stay in the open world).
  assert.deepEqual([a.accounts.length, a.grants.length, kinds(s => s === 'instagram'), a.accounts.filter(x => x.connector).length, kinds(s => /plan$|^api:|^jev$|^media:/.test(s)), kinds(s => s === 'playwright-ext')], [14, 14, 3, 8, 5, 1]);
  for (const c of LEGACY) {
    const g = grantIn(a.grants, c.id, 'social-abc123')!, acct = a.accounts.find(x => x.id === c.id)!;
    assert.deepEqual([g.cats, g.tools, g.world], [c.cats, c.tools, c.cats.includes('*') ? EVERY_WORLD : 'social-abc123'], `${c.id}: cats and tools as connectors.json had them`);
    assert.deepEqual([acct.label, acct.connector, acct.identity], [c.name, c.id, null]);
  }
  const by = (id: string) => a.accounts.find(x => x.id === id)!;
  assert.deepEqual(['context7', 'github', 'vercel', 'instagram-beta'].map(id => [by(id).service, by(id).kind, by(id).secretRef, by(id).status]), [
    ['context7', 'none', null, 'unchecked'], ['github', 'token', 'connector-secrets.json#github', 'unchecked'],
    ['vercel', 'oauth', 'connector-secrets.json#vercel', 'unchecked'], ['instagram', 'token', 'connector-secrets.json#instagram-beta', 'unchecked']]);
  assert.deepEqual([by('vercel').expiresAt, by('vercel').refreshable, by('github').refreshable], [4102444800000, true, false]);
  assert.deepEqual(['models:claude', 'models:chatgpt', 'models:hosted', 'models:jev', 'models:media:seedance', 'cat-browser:playwright'].map(id => [by(id).service, by(id).kind, by(id).secretRef]), [
    ['claude-plan', 'cli', null], ['chatgpt-plan', 'cli', null], ['api:openai', 'key', 'models.json#hosted.key'], ['jev', 'key', 'models.json#jev.key'],
    ['media:seedance', 'key', 'models.json#media.seedance.key'], ['playwright-ext', 'token', 'cat-browser.json#token']]);

  await hubAt(dir).dispose();
  assert.equal(read(dir, 'accounts.json'), text, 'a second run changes nothing');
  assert.equal(read(dir, 'connectors.json'), before['connectors.json']);

  // The first write leaves cats and tools out of connectors.json; the grants keep them, so the next boot is the same.
  const hub = hubAt(dir);
  hub.patchConnector('notes', {enabled: true});
  await hub.dispose();
  assert.ok(JSON.parse(read(dir, 'connectors.json')).connectors.every((c: object) => !('cats' in c) && !('tools' in c)));
  assert.equal(read(dir, 'accounts.json'), text);
  const after = hubAt(dir);
  assert.deepEqual(after.publicConnectors().map(c => c.cats), LEGACY.map(c => c.cats));
  await after.dispose();
  assert.equal(read(dir, 'accounts.json'), text);
});

test('a grant in one world is invisible in another; the migrated Mayor keeps its connectors in every world, and an every-cat grant reaches every world', async () => {
  const dir = fixture();
  let world = 'social-abc123';
  const hub = hubAt(dir, () => world);
  try {
    hub.start();
    await until(() => hub.publicConnectors().every(c => c.status === 'connected'));
    world = 'lab-def456';
    const everyCat = (c: {cats: string[]}) => c.cats.includes('*');
    for (const cat of ['scholar', 'reel_builder']) assert.deepEqual(offered(hub, cat), expected(cat, everyCat), `${cat}, in no journal here, only gets the every-cat connectors`);
    assert.deepEqual(offered(hub, 'mayor'), expected('mayor'), 'the Mayor had them in every world before, and still does');
    assert.deepEqual(hub.publicConnectors().find(c => c.id === 'vercel')!.cats, ['mayor'], 'the panel shows this world’s cats');
    assert.ok(hub.grantable('github', 'critic'), 'connected and given in this world, so it is a grant approval, not a second connect');
    hub.grant('github', 'critic');
    hub.patchConnector('github', {tools: {write_page: 'off'}});
    hub.patchConnector('context7', {cats: ['scholar']});
    assert.deepEqual([hub.canUse('critic', 'github'), hub.resolve('critic', 'mcp__github__write_page'), hub.resolve('mayor', 'mcp__github__write_page')], [true, null, null]);
    assert.ok(!hub.canUse('critic', 'context7') && hub.canUse('scholar', 'context7'), 'this world’s own choice replaces the every-world grant here');
    world = 'social-abc123';
    assert.deepEqual(hub.publicConnectors().find(c => c.id === 'github')!.cats, ['mayor'], 'the other world keeps its grant');
    assert.ok(!hub.canUse('critic', 'github') && hub.resolve('mayor', 'mcp__github__write_page')?.permission === 'allow', 'and its tool choices');
    assert.ok(hub.canUse('critic', 'context7'), 'and the every-cat grant');
    hub.grant('notes', 'scholar');
    world = 'home';
    assert.ok(hub.canUse('critic', 'context7') && !hub.canUse('critic', 'github') && !hub.canUse('scholar', 'notes'), 'a third world sees neither world’s change');
    assert.ok(!hub.brief('critic').includes('GitHub'));
  } finally { await hub.dispose(); }
});

test('the migration places a named cat’s grant by the journals, not by the world open at boot: a cat only world B created gets it in B with A open', async () => {
  const dir = tmp('accounts-worlds-'), cats = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8')).cats;
  writeFileSync(join(dir, 'worlds.json'), JSON.stringify({active: 'a-111111', worlds: [{id: 'home', name: 'Clowder', createdAt: '2026-10-01T00:00:00.000Z', dir: '.'}, {id: 'a-111111', name: 'A', createdAt: '2026-10-02T00:00:00.000Z', dir: 'worlds/a-111111'}, {id: 'b-222222', name: 'B', createdAt: '2026-10-03T00:00:00.000Z', dir: 'worlds/b-222222'}]}));
  // Real journals: each founded with the Mayor. Scholar was recruited in home and B, X only in B.
  const journal = (d: string, ...ids: string[]) => { const s = new Store(join(dir, d, 'events.jsonl'), cats); for (const id of ids) s.emit('cat.created', {id, name: id, role: 'Works.'}); };
  journal('.', 'scholar');
  journal('worlds/a-111111');
  journal('worlds/b-222222', 'x_cat', 'scholar');
  const conn = (id: string, cats: string[]) => http(id, id, `https://${id}.example/mcp`, cats, {write_page: 'allow'}, {source: 'custom'});
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [conn('only-x', ['x_cat']), conn('x-and-mayor', ['x_cat', 'mayor']), conn('crew', ['scholar']), conn('ghost', ['gone_cat']), conn('none', [])], plugins: []}));
  let world = 'a-111111';
  const hub = hubAt(dir, () => world);
  try {
    const grants = (JSON.parse(read(dir, 'accounts.json')) as Accounts).grants.map(g => `${g.account}@${g.world}:${g.cats.join('+')}`).sort();
    assert.deepEqual(grants, [
      'crew@b-222222:scholar', 'crew@home:scholar', // each world that recruited it, and not A
      'ghost@a-111111:gone_cat', // in no journal: the open world
      'none@a-111111:', // no cats: its tool choices are kept in the open world
      'only-x@b-222222:x_cat',
      'x-and-mayor@a-111111:mayor', 'x-and-mayor@b-222222:x_cat+mayor', 'x-and-mayor@home:mayor']);
    hub.start();
    await until(() => hub.publicConnectors().every(c => c.status === 'connected'));
    assert.deepEqual([hub.canUse('x_cat', 'only-x'), hub.canUse('x_cat', 'x-and-mayor'), hub.canUse('mayor', 'x-and-mayor')], [false, false, true], 'world A, open at boot, never had X');
    world = 'b-222222';
    assert.deepEqual([hub.canUse('x_cat', 'only-x'), hub.canUse('x_cat', 'x-and-mayor'), hub.resolve('x_cat', 'mcp__only-x__write_page')?.permission], [true, true, 'allow']);
  } finally { await hub.dispose(); }
});

test('today’s connect and grant flows give the same cats the same tools as before the migration', async () => {
  const dir = fixture(), hub = hubAt(dir);
  try {
    hub.start();
    await until(() => hub.publicConnectors().every(c => c.status === 'connected'));
    for (const cat of ['mayor', 'scholar', 'builder', 'critic', 'reel_builder', 'artist']) assert.deepEqual(offered(hub, cat), expected(cat), `${cat} is offered what connectors.json gave it`);
    for (const c of LEGACY) for (const [t, p] of Object.entries(c.tools)) if (p !== 'off') assert.equal(hub.resolve(c.cats.includes('*') ? 'artist' : c.cats[0]!, `mcp__${c.id}__${t}`)?.permission, p);
    // A grant approval's Allow, as the engine calls it: the cat and the Mayor get the connector with the same tools as the cats that had it.
    assert.ok(hub.grantable('notes', 'scholar'));
    hub.grant('notes', 'scholar');
    const notes = (cat: string) => offered(hub, cat).filter(n => n.startsWith('mcp__notes__'));
    assert.deepEqual(notes('scholar'), notes('reel_builder'));
    assert.deepEqual(hub.publicConnectors().find(c => c.id === 'notes')!.cats, ['reel_builder', 'mayor', 'scholar']);
    // A connect step for a service every cat has already changes nothing.
    assert.equal(await hub.connectService('context7', 'builder'), undefined);
    assert.deepEqual(hub.publicConnectors().find(c => c.id === 'context7')!.cats, ['*']);
  } finally { await hub.dispose(); }
});

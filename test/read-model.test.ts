import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {SNAPSHOT_EVERY} from '../src/read-model.ts';

const cats = [{id: 'mayor', name: 'Mayor', role: 'Runs the town.', color: '', icon: ''}, {id: 'scout', name: 'Scout', role: 'Finds things.', color: '', icon: ''}];
const limits = {messages: 50, events: 50, approvals: 5};
// A JSON round trip drops undefined-valued keys that structuredClone keeps; neither reaches a client, so states are compared as JSON.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const world = () => {const dir = mkdtempSync(join(tmpdir(), 'read-model-')); return {dir, file: join(dir, 'events.jsonl'), db: join(dir, 'read-model.db')};};
// A small town: chat both ways, tasks created and updated, memory notes.
function fill(store: Store, n = 30) {
  store.emit('cat.created', {id: 'baker', name: 'Baker', role: 'Bakes.', color: '', icon: ''});
  for (let i = 0; i < n; i++) {
    store.emit('message', {from: i % 3 ? 'owner' : 'scout', to: i % 3 ? (i % 2 ? 'scout' : 'baker') : 'owner', text: `note ${i} about ${i === 7 ? 'marmalade' : 'bread'}`});
    store.emit('task.created', {id: `t${i}`, cat: i % 2 ? 'scout' : 'baker', from: 'owner', text: `job ${i}`, mode: 'local', status: 'queued'});
    if (i % 4 === 0) store.emit('task.updated', {id: `t${i}`, status: 'done', result: `done ${i}`});
    if (i % 5 === 0) store.emit('memory.noted', {cat: 'scout', task: `t${i}`, title: `lesson ${i}`, text: i === 10 ? 'the quokka likes shade' : 'ordinary'});
  }
}

test('deleting the database rebuilds it from the journal with the same row counts as a replay', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  fill(store); store.readModel!.flush();
  // Search rows: messages, memory notes, and each root task that has a result (fill() gives every fourth task one).
  const expected = {messages: store.state.messages.length, tasks: store.state.tasks.length, search: store.state.messages.length + store.state.events.filter(e => e.type === 'memory.noted').length + store.state.tasks.filter(t => !t.parent && t.result).length};
  assert.deepEqual(store.readModel!.counts(), expected);
  rmSync(w.db);
  const again = new Store(w.file, [], {readModel: w.db});
  assert.equal(again.replayed, again.state.events.length, 'no db: a full replay');
  again.readModel!.flush();
  assert.deepEqual(again.readModel!.counts(), expected);
  rmSync(w.dir, {recursive: true});
});

test('a restart with a snapshot replays only the newer events and reaches the same state as a full replay', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  fill(store); store.readModel!.flush({snapshot: true});
  const at = store.state.events.length;
  // Newer events after the snapshot, including updates to tasks the snapshot already holds.
  store.emit('task.updated', {id: 't1', status: 'done', result: 'late'});
  store.emit('message', {from: 'owner', to: 'scout', text: 'after the snapshot'});
  store.emit('memory.noted', {cat: 'baker', title: 'tail', text: 'written after'});
  const restarted = new Store(w.file, [], {readModel: w.db}), full = new Store(w.file, []);
  assert.equal(restarted.replayed, store.state.events.length - at);
  assert.equal(full.replayed, store.state.events.length);
  assert.deepEqual(plain(restarted.state), plain(full.state));
  assert.deepEqual(plain(restarted.snapshot(limits)), plain(full.snapshot(limits)));
  // Its rows catch up to the tail as well.
  restarted.readModel!.flush();
  assert.equal(restarted.readModel!.search('written after')[0]?.kind, 'note');
  rmSync(w.dir, {recursive: true});
});

test('the snapshot is rewritten only every SNAPSHOT_EVERY events, and a rewritten journal is never trusted', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  store.readModel!.flush();
  for (let i = 0; i < 10; i++) store.emit('message', {from: 'owner', to: 'scout', text: `m${i}`});
  store.readModel!.flush();
  assert.equal(new Store(w.file, [], {readModel: w.db}).replayed, 10, 'ten events newer than the first snapshot');
  for (let i = 0; i < SNAPSHOT_EVERY; i++) store.emit('paused', {value: false});
  store.readModel!.flush();
  assert.equal(new Store(w.file, [], {readModel: w.db}).replayed, 0);
  // Same events and ids, different content (as compact-journals.mjs does): the length no longer matches, so it replays in full.
  const text = store.state.events.map(e => JSON.stringify(e.type === 'message' && e.data.text === 'm3' ? {...e, data: {...e.data, text: 'x'}} : e)).join('\n') + '\n';
  writeFileSync(w.file, text);
  const warn = console.warn; console.warn = () => {};
  try {
    const reread = new Store(w.file, [], {readModel: w.db});
    assert.equal(reread.replayed, reread.state.events.length);
    assert.equal(reread.state.messages.find(m => m.text === 'x')?.text, 'x');
  } finally {console.warn = warn;}
  rmSync(w.dir, {recursive: true});
});

test('a corrupt database falls back to a full replay with a warning, then rebuilds', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  fill(store); store.readModel!.flush({snapshot: true});
  writeFileSync(w.db, 'this is not a sqlite database'.repeat(200));
  const warnings: string[] = [], warn = console.warn; console.warn = (m: string) => warnings.push(m);
  try {
    const reread = new Store(w.file, [], {readModel: w.db});
    assert.equal(reread.replayed, reread.state.events.length);
    assert.deepEqual(plain(reread.state), plain(new Store(w.file, []).state));
    assert.equal(warnings.length, 1);
    reread.readModel!.flush();
    assert.equal(reread.readModel!.counts().messages, reread.state.messages.length);
  } finally {console.warn = warn;}
  rmSync(w.dir, {recursive: true});
});

test('full-text search finds a message and a memory note by a word', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  fill(store); store.readModel!.flush();
  const hits = store.readModel!.search('Marmalade');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'message');
  assert.equal(hits[0].ref, store.state.messages.find(m => m.text.includes('marmalade')).id);
  assert.equal(store.readModel!.search('quokka')[0].kind, 'note');
  // FTS5 query syntax in the owner's words cannot break the search.
  assert.deepEqual(store.readModel!.search('"bread" OR (*'), store.readModel!.search('bread OR'));
  assert.deepEqual(store.readModel!.search('!!!'), []);
  rmSync(w.dir, {recursive: true});
});

const ART_TEXT = '11111111-1111-4111-8111-111111111111', ART_IMAGE = '22222222-2222-4222-8222-222222222222';
// Two artifacts (a saved page and a picture), a root request with a result, and a child task whose result must not be indexed.
function artifacts(store: Store, dir: string) {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, `${ART_TEXT}.html`), '<html><style>.zebra{}</style><body><h1>Lighthouse plan</h1><p>Tide tables</p></body></html>');
  writeFileSync(join(dir, `${ART_IMAGE}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  store.emit('artifact.created', {id: ART_TEXT, title: 'Harbour notes', kind: 'html', mime: 'text/html; charset=utf-8', cat: 'scout', task: null, project: null, file: `${ART_TEXT}.html`, size: 90});
  store.emit('artifact.created', {id: ART_IMAGE, title: 'Cover art', kind: 'image', mime: 'image/png', cat: 'baker', task: null, project: null, file: `${ART_IMAGE}.png`, size: 4});
  store.emit('task.created', {id: 'req1', cat: 'scout', from: 'owner', text: 'Find a bakery', mode: 'local', status: 'queued'});
  store.emit('task.created', {id: 'kid1', cat: 'baker', from: 'scout', text: 'Bake', mode: 'local', status: 'queued', parent: 'req1'});
  store.emit('task.updated', {id: 'req1', status: 'done', result: 'Found a sourdough place called Marrow'});
  store.emit('task.updated', {id: 'kid1', status: 'done', result: 'Child only kestrel'});
}

test('an artifact is found by its title or its text, a request by its result, and nothing else is', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  artifacts(store, join(w.dir, 'artifacts'));
  const rm = store.readModel!;
  rm.flush();
  assert.deepEqual(rm.search('Harbour').map(h => [h.kind, h.ref, h.title]), [['artifact', ART_TEXT, 'Harbour notes']], 'a word from the title');
  assert.deepEqual(rm.search('Lighthouse').map(h => [h.kind, h.ref]), [['artifact', ART_TEXT]], 'a word from the text');
  assert.deepEqual(rm.search('zebra'), [], 'a style block is not text');
  assert.deepEqual(rm.search('body'), [], 'tags are not text');
  assert.deepEqual(rm.search('Cover').map(h => [h.kind, h.ref]), [['artifact', ART_IMAGE]], 'an image has a title and no text');
  assert.deepEqual(rm.search('Marrow').map(h => [h.kind, h.ref, h.title, h.text]), [['request', 'req1', 'Find a bakery', 'Found a sourdough place called Marrow']]);
  assert.deepEqual(rm.search('kestrel'), [], 'a child task\'s result is not a request');
  assert.deepEqual(rm.search('Lighthouse', 20, 'request'), [], 'the kind filter keeps other kinds out');
  assert.equal(rm.search('Harbour', 20, 'artifact').length, 1);
  store.emit('task.updated', {id: 'req1', status: 'done', result: 'Second answer pelican'});
  rm.flush();
  assert.deepEqual(rm.search('Marrow'), [], 'a later result replaces the earlier one');
  assert.deepEqual(rm.search('pelican').map(h => h.ref), ['req1']);
  rmSync(w.dir, {recursive: true});
});

test('deleting the database rebuilds the artifact and request hits from the journal and the files', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  artifacts(store, join(w.dir, 'artifacts'));
  store.readModel!.flush();
  const before = ['Harbour', 'Lighthouse', 'Marrow'].map(q => store.readModel!.search(q).map(h => `${h.kind}:${h.ref}`));
  rmSync(w.db);
  const again = new Store(w.file, [], {readModel: w.db});
  again.readModel!.flush();
  assert.deepEqual(['Harbour', 'Lighthouse', 'Marrow'].map(q => again.readModel!.search(q).map(h => `${h.kind}:${h.ref}`)), before);
  assert.deepEqual(before.map(h => h.length), [1, 1, 1]);
  rmSync(w.dir, {recursive: true});
});

test('a database from the previous schema is dropped and rebuilt on start, with its stale rows gone', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  fill(store); store.readModel!.flush({snapshot: true});
  // What an older build left behind: its version, and a row the rebuild must not keep.
  const sqlite = process.getBuiltinModule('node:sqlite')!;
  const old = new sqlite.DatabaseSync(w.db);
  old.exec("PRAGMA user_version=2; INSERT INTO search(kind,ref,cat,at,title,text) VALUES('note','stale','x','x','','ghost'); DELETE FROM meta WHERE key='rows';");
  old.close();
  const reread = new Store(w.file, [], {readModel: w.db});
  assert.equal(reread.replayed, reread.state.events.length, 'no usable snapshot: a full replay');
  reread.readModel!.flush();
  assert.deepEqual(reread.readModel!.search('ghost'), []);
  assert.equal(reread.readModel!.search('marmalade').length, 1, 'the journal rows are back');
  assert.equal(reread.readModel!.counts().search, store.readModel!.counts().search);
  rmSync(w.dir, {recursive: true});
});

test('chat pages from the database are the pages chat() serves from memory', () => {
  const w = world(), store = new Store(w.file, cats, {readModel: w.db});
  fill(store, 60); store.readModel!.flush();
  for (const cat of ['scout', 'baker', 'owner', 'nobody']) {
    let before: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const opts = {before, limit: 7, tasks: 5}, mem = store.chat(cat, opts), db = store.readModel!.chat(cat, opts);
      assert.deepEqual(plain(db), plain(mem), `${cat} page ${pages}`);
      if (!mem.more) break;
      before = mem.messages[0].id;
    }
  }
  assert.throws(() => store.readModel!.chat('scout', {before: 'missing', limit: 5, tasks: 0}), /not in this town/);
  rmSync(w.dir, {recursive: true});
});

test('a store without a read model writes no database', () => {
  const w = world(), store = new Store(w.file, cats);
  fill(store, 3);
  assert.equal(store.readModel, undefined);
  assert.equal(existsSync(w.db), false);
  rmSync(w.dir, {recursive: true});
});

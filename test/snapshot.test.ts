// Plan 7.1: the pre-upgrade snapshot. Boot commit A, then B; pre-B-* holds the journals as they were before boot B and none of the
// files that stay out; a fourth snapshot prunes the oldest pre-* and leaves a world-* folder alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preUpgradeSnapshot} from '../src/snapshot.ts';
import {buildStamp} from '../src/build-info.ts';

const walk = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const pres = (data: string) => readdirSync(join(data, 'backups')).filter(f => f.startsWith('pre-')).sort();
const clock = (iso: string) => () => new Date(iso);

function seed() {
  const data = mkdtempSync(join(tmpdir(), 'snapshot-'));
  const put = (rel: string, text: string) => { mkdirSync(join(data, rel, '..'), {recursive: true}); writeFileSync(join(data, rel), text); };
  put('events.jsonl', '{"id":1}\n');
  put('workshop.jsonl', '{"id":"w"}\n');
  put('purchases.jsonl', '{"p":1}\n');
  put('worlds.json', '{"worlds":[]}');
  put('models.json', '{}');
  put('secrets.v2.json', '{"v":2,"cipher":"safeStorage","items":{}}');
  put('town-settings.json', '{}');
  put('checkpoints/t1.json', '{}');
  put('artifacts/a.txt', 'art');
  put('plugins/p/plugin.json', '{}');
  put('worlds/w2/events.jsonl', '{"id":2}\n');
  put('worlds/w2/accounts.json', '{}');
  put('worlds/w2/artifacts/b.txt', 'b');
  // Everything below stays out.
  put('read-model.db', 'db');
  put('worlds/w2/read-model.db', 'db');
  put('events.jsonl.pre-compact-2026-01-01', 'old');
  put('models.json.pre-secrets-1700000000000.bak', 'plaintext');
  put('devices.json', '{"cookie":"x"}');
  put('push-subscriptions.json', '{}');
  put('remote-settings.json', '{}');
  put('rendezvous.json', '{}');
  put('vapid.json', '{}');
  put('cat-browser.json', '{}');
  put('tunnel/cert.pem', 'x');
  put('browser/Default/Cookies', 'x');
  put('wiki/page.md', 'x');
  put('backups/world-2026-01-01T00-00-00-000Z/events.jsonl', 'kept');
  return data;
}

test('boot A then B: pre-B holds the journals from before boot B and nothing that stays out', () => {
  const data = seed();
  const a = preUpgradeSnapshot(data, {commit: 'aaaa111', builtAt: null}, clock('2026-11-07T10:00:00.000Z'));
  assert.ok('folder' in a && a.folder);
  // Boot A replays and appends.
  appendFileSync(join(data, 'events.jsonl'), '{"id":3}\n');
  appendFileSync(join(data, 'worlds/w2/events.jsonl'), '{"id":4}\n');
  const before = {main: readFileSync(join(data, 'events.jsonl')), w2: readFileSync(join(data, 'worlds/w2/events.jsonl')), ws: readFileSync(join(data, 'workshop.jsonl'))};
  // Same build again: no copy.
  assert.deepEqual(preUpgradeSnapshot(data, {commit: 'aaaa111', builtAt: null}, clock('2026-11-07T10:30:00.000Z')), {skipped: 'same-build'});
  const b = preUpgradeSnapshot(data, {commit: 'bbbb222', builtAt: null}, clock('2026-11-07T11:00:00.000Z'));
  assert.ok('folder' in b && b.folder);
  assert.match(b.folder!, /pre-bbbb222-2026-11-07T11-00-00-000Z$/);
  assert.deepEqual(readFileSync(join(b.folder!, 'events.jsonl')), before.main);
  assert.deepEqual(readFileSync(join(b.folder!, 'worlds/w2/events.jsonl')), before.w2);
  assert.deepEqual(readFileSync(join(b.folder!, 'workshop.jsonl')), before.ws);
  // Appends after the snapshot do not reach it (a copy, not a hard link).
  appendFileSync(join(data, 'events.jsonl'), '{"id":5}\n');
  assert.deepEqual(readFileSync(join(b.folder!, 'events.jsonl')), before.main);
  const files = walk(b.folder!).map(f => relative(b.folder!, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(files, ['artifacts/a.txt', 'checkpoints/t1.json', 'events.jsonl', 'models.json', 'plugins/p/plugin.json', 'purchases.jsonl',
    'secrets.v2.json', 'town-settings.json', 'workshop.jsonl', 'worlds.json', 'worlds/w2/accounts.json', 'worlds/w2/artifacts/b.txt', 'worlds/w2/events.jsonl']);
  assert.ok(!files.some(f => /\.bak$|read-model\.db|pre-compact|devices|tunnel|browser|backups/.test(f)));
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'last-boot.json'), 'utf8')), {commit: 'bbbb222', builtAt: null});
  // A packaged rebuild of the same commit has a new builtAt, so it snapshots too.
  const c = preUpgradeSnapshot(data, {commit: 'bbbb222', builtAt: '2026-11-07T12:00:00.000Z'}, clock('2026-11-07T12:00:00.000Z'));
  assert.ok('folder' in c && c.folder);
});

test('a fourth snapshot prunes the oldest pre-* and leaves world-* alone', () => {
  const data = seed();
  // Commits are not in time order, so pruning must go by the time in the name.
  for (const [i, commit] of ['ffff', 'aaaa', 'cccc', 'bbbb'].entries()) preUpgradeSnapshot(data, {commit, builtAt: null}, clock(`2026-11-0${i + 1}T00:00:00.000Z`));
  assert.deepEqual(pres(data), ['pre-aaaa-2026-11-02T00-00-00-000Z', 'pre-bbbb-2026-11-04T00-00-00-000Z', 'pre-cccc-2026-11-03T00-00-00-000Z']);
  assert.equal(readFileSync(join(data, 'backups/world-2026-01-01T00-00-00-000Z/events.jsonl'), 'utf8'), 'kept');
});

test('no commit: skips and records nothing; a leftover partial copy is cleared; an empty folder makes no snapshot', () => {
  const data = seed();
  assert.deepEqual(preUpgradeSnapshot(data, {commit: null, builtAt: null}), {skipped: 'no-commit'});
  assert.ok(!existsSync(join(data, 'last-boot.json')));
  mkdirSync(join(data, 'backups/tmp-pre-dead-2026-01-01T00-00-00-000Z'), {recursive: true});
  preUpgradeSnapshot(data, {commit: 'aaaa', builtAt: null});
  assert.ok(!readdirSync(join(data, 'backups')).some(f => f.startsWith('tmp-')));
  const empty = mkdtempSync(join(tmpdir(), 'snapshot-empty-'));
  const r = preUpgradeSnapshot(empty, {commit: 'aaaa', builtAt: null});
  assert.ok('folder' in r && r.folder === null);
  assert.ok(existsSync(join(empty, 'last-boot.json')));
});

test('builtAt comes from a packaged stamp only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-stamp-'));
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({commit: 'pack999', builtAt: '2026-11-07T00:00:00.000Z'}));
  assert.equal(buildStamp(dir, () => null).get().builtAt, '2026-11-07T00:00:00.000Z');
  assert.equal(buildStamp(dir, () => 'dev1234').get().builtAt, null);
});

test('server.ts takes the snapshot before the secret store opens and before any world replays', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
  const at = src.indexOf('preUpgradeSnapshot(dataPath');
  assert.ok(at > src.indexOf('const dataPath='));
  assert.ok(at < src.indexOf('await openSecretStore('));
  assert.ok(at < src.indexOf('new WorldHost('));
  assert.ok(at < src.indexOf('new ModelHub('));
});

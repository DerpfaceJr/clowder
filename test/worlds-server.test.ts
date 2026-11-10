// Runs the real server (src/server.ts) on scratch ports with a temp data dir, and checks a world switch over HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function waitFor(child: ChildProcess, pattern: RegExp, ms: number) {
  return new Promise<void>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${text}`)), ms);
    const check = (chunk: Buffer) => { text += chunk.toString(); if (pattern.test(text)) { clearTimeout(timer); resolve(); } };
    child.stdout!.on('data', check);
    child.stderr!.on('data', check);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${text}`)); });
  });
}

test('over HTTP the switch swaps the cats, notifies /api/events, and refuses proxied writes', {timeout: 120_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worlds-server-'));
  // An empty connectors file: no starter connectors are seeded, so the server makes no network calls here.
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src', 'server.ts')], {
    cwd: root,
    env: {...process.env, PORT: String(port), CAT_REMOTE_PORT: String(port + 1), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_OWNER_KEY: 'worlds-server-owner'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  // The owner session, as the desktop window holds it (access.ts).
  const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, {...init, headers: {...init.headers as Record<string, string>, cookie: `town_owner_${port}=worlds-server-owner`}});
  const owner = {'content-type': 'application/json', 'x-town-action': 'owner'};
  const post = (path: string, body: unknown, headers: Record<string, string> = owner) =>
    fetch(base + path, {method: 'POST', headers, body: JSON.stringify(body)});
  const cats = async () => ((await (await fetch(base + '/api/state')).json()) as {cats: {id: string}[]}).cats.map(c => c.id);
  try {
    await waitFor(child, /Clowder:/, 60_000);
    const events = await fetch(base + '/api/events');
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const changes = () => (seen.match(/data: changed/g) || []).length;
    const readFrame = async () => { const {value} = await reader.read(); seen += decoder.decode(value); };
    await readFrame();
    const before = changes();
    // For you's settings belong to the open world (plan 9.3): the home world's guidance does not follow the switch.
    assert.equal((await fetch(base + '/api/for-you', {method: 'PUT', headers: owner, body: JSON.stringify({guidance: 'Home only.'})})).status, 200);

    const created = await post('/api/worlds', {name: 'Meadow'});
    assert.equal(created.status, 200);
    const {world} = await created.json() as {world: {id: string}};
    assert.equal((await post(`/api/worlds/${world.id}/activate`, {})).status, 200);
    await readFrame();
    assert.ok(changes() > before, 'the switch sends data: changed to the open event stream');

    const state = await (await fetch(base + '/api/state')).json() as {activeWorld: {id: string; name: string}; introPending: boolean};
    assert.equal(state.activeWorld.id, world.id);
    assert.deepEqual(await cats(), ['mayor', 'mailman'], 'a new world starts with the Mayor and the Mailman');
    const forYou = await (await fetch(base + '/api/for-you')).json() as {guidance: string; enabled: boolean; intervalSeconds: number};
    assert.deepEqual([forYou.guidance, forYou.enabled, forYou.intervalSeconds], ['', false, 900], 'the new world has its own For you settings, off');
    assert.equal(state.introPending, true, 'a new world is pending its intro');
    assert.equal((await post('/api/world/intro-seen', {}, {...owner, 'x-forwarded-for': '203.0.113.9'})).status, 403, 'a proxied intro mark is refused');
    assert.equal((await post('/api/world/intro-seen', {})).status, 200);
    assert.equal(((await (await fetch(base + '/api/state')).json()) as {introPending: boolean}).introPending, false, 'the intro is cleared');
    assert.equal((await post('/api/cats', {name: 'Pip', role: 'Tester'})).status, 200);
    assert.ok((await cats()).includes('pip'));

    assert.equal((await post('/api/worlds/home/activate', {})).status, 200);
    assert.equal((await cats()).includes('pip'), false, 'home has its own cats');

    const proxied = await post('/api/worlds', {name: 'Nope'}, {...owner, 'x-forwarded-for': '203.0.113.9'});
    assert.equal(proxied.status, 403);
    const proxiedDelete = await post(`/api/worlds/${world.id}/delete`, {}, {...owner, 'x-forwarded-for': '203.0.113.9'});
    assert.equal(proxiedDelete.status, 403, 'a proxied delete is refused');
    assert.equal(((await (await fetch(base + '/api/worlds')).json()) as {worlds: unknown[]}).worlds.length, 2, 'and removes nothing');
    reader.cancel().catch(() => {});
  } finally {
    child.kill();
  }
});

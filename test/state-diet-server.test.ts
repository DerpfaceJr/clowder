// Runs the real server (src/server.ts) on scratch ports: one demo task reaches an open /api/events as frames (no bare
// `changed`), the frames keep the snapshot's projection, and the chat's history comes from /api/chats.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function waitFor(child: ChildProcess, pattern: RegExp, ms: number) {
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${text}`)), ms);
    const check = (chunk: Buffer) => { text += chunk.toString(); if (pattern.test(text)) { clearTimeout(timer); resolve(text); } };
    child.stdout!.on('data', check);
    child.stderr!.on('data', check);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${text}`)); });
  });
}

test('a demo task streams as frames, keeps the projection, and its chat pages from /api/chats', {timeout: 120_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-diet-server-'));
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src', 'server.ts')], {
    cwd: root, env: {...process.env, PORT: String(port), CAT_REMOTE_PORT: String(port + 1), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  try {
    // npm start prints the owner link (security pass H2): without opening it this computer gets no town data and no writes; opening it sets the session.
    const link = /Clowder: (\S+)\s/.exec(await waitFor(child, /Clowder: \S+\s/, 60_000))![1]!;
    assert.equal((await globalThis.fetch(base + '/api/state')).status, 401);
    assert.equal((await globalThis.fetch(base + '/api/chat', {method: 'POST', headers: {'content-type': 'application/json', 'x-town-action': 'owner'}, body: '{}'})).status, 403);
    const opened = await globalThis.fetch(link, {redirect: 'manual'});
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.get('location'), '/');
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!;
    const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, {...init, headers: {...init.headers as Record<string, string>, cookie}});
    const stream = await fetch(base + '/api/events', {signal: controller.signal});
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let text = '';
    const frames = () => [...text.matchAll(/^data: (.*)$/gm)].map(m => m[1]);
    const until = async (done: () => boolean) => { const end = Date.now() + 30_000; while (!done() && Date.now() < end) text += decoder.decode((await reader.read()).value); };
    await until(() => frames().length > 0);
    const hello = JSON.parse(frames()[0]);
    const state = await (await fetch(base + '/api/state')).json() as any;
    assert.equal(hello.hello, true);
    assert.equal(hello.seq, state.seq);
    assert.equal(hello.world, state.activeWorld.id);
    assert.ok(state.limits.messagesPerChat > 0 && state.limits.events > 0);

    const sent = await fetch(base + '/api/chat', {method: 'POST', headers: {'content-type': 'application/json', 'x-town-action': 'owner'}, body: JSON.stringify({cat: 'mayor', text: 'Review a small service.', mode: 'demo'})});
    assert.equal(sent.status, 200);
    await until(() => frames().some(f => f.includes('"approval"')));
    const all = frames().slice(1).map(f => JSON.parse(f));
    // This page is the owner's, so activity and live-text frames (plan 8.2, 8.3) arrive between the journal's: each repeats the seq before it.
    const parsed = all.filter(f => !f.activity && !f.delta);
    all.forEach((f, i) => { if (f.activity || f.delta) assert.equal(f.seq, i ? all[i - 1].seq : state.seq, 'a transient frame never moves seq'); });
    assert.ok(all.some(f => f.activity?.label === 'asking a cat'), 'the demo’s delegation shows as activity');
    assert.ok(parsed.length > 5, `${parsed.length} frames`);
    assert.ok(!frames().includes('changed'), 'no bare changed ping');
    assert.deepEqual(parsed.map(f => f.seq), parsed.map((_, i) => state.seq + i + 1), 'one frame per journal event, in order');
    for (const f of parsed) {
      if (f.task) assert.ok(!('context' in f.task), 'no task context');
      if (f.approval) assert.ok(!('messages' in f.approval), 'no approval messages');
      if (f.event) assert.ok(!('context' in f.event.data) && !('messages' in f.event.data));
    }
    assert.ok(parsed.some(f => f.message?.text === 'Review a small service.'), 'the owner message arrives as a frame');

    const chat = await (await fetch(base + '/api/chats/mayor')).json() as any;
    assert.ok(chat.messages.some((m: any) => m.text === 'Review a small service.'));
    assert.equal(chat.more, false);
    assert.ok(Array.isArray(chat.tasks) && chat.tasks.length > 0 && chat.tasks.every((t: any) => !('context' in t)));
    assert.equal((await fetch(base + '/api/chats/mayor?before=missing')).status, 400);
    assert.equal((await fetch(base + '/api/chats/mayor?limit=0')).status, 400);

    // audio.js's season-only stream gets no state frames.
    const season = await fetch(base + '/api/events?only=season', {signal: controller.signal});
    const first = await Promise.race([season.body!.getReader().read().then(r => decoder.decode(r.value)), new Promise<string>(r => setTimeout(() => r(''), 1500))]);
    assert.ok(!first.includes('hello'), 'no hello on the season stream');
  } finally {
    controller.abort();
    child.kill();
  }
});

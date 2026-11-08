import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SeasonWatch, seasonFrame, tallyCoins} from '../src/season-watch.ts';

const settled = (amount: number, purpose = 'stock for shop') => `${JSON.stringify({type: 'coins.settled', id: 'r1', amount, purpose, cat: 'secretcat'})}\n`;
const earned = (amount: number) => `${JSON.stringify({type: 'coins.earned', business: 'bakery', amount})}\n`;

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'season-watch-'));
  try { run(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('tallyCoins sums spends and sales and ignores everything else', () => {
  const text = [settled(50), earned(30), settled(0), earned(-4), '{"type":"tick.closed"}\n', '{torn\n', '\n', settled(20)].join('');
  assert.deepEqual(tallyCoins(text), {spent: 70, earned: 30, count: 3});
  assert.deepEqual(tallyCoins(''), {spent: 0, earned: 0, count: 0});
});

test('the SSE frame carries exactly the three totals, never journal text', () => {
  const frame = seasonFrame({spent: 12, earned: 0, count: 2});
  assert.ok(frame.startsWith('event: season\n'));
  const data = frame.split('\n').find(line => line.startsWith('data: '));
  assert.deepEqual(Object.keys(JSON.parse(data!.slice(6))).sort(), ['count', 'earned', 'spent']);
  const leaking = seasonFrame({spent: 1, earned: 2, count: 3, purpose: 'secret', cat: 'secretcat'} as any);
  assert.ok(!leaking.includes('secret'));
});

test('the watcher reads only appended bytes and aggregates each batch', () => {
  withDir(dir => {
    const file = join(dir, 'season-spring.jsonl');
    writeFileSync(file, settled(999));
    const watch = new SeasonWatch(dir, 1e9);
    watch.start();
    try {
      assert.equal(watch.poll(), null, 'history from before start is not replayed');
      const first = settled(50, 'a secret purpose');
      appendFileSync(file, first);
      assert.deepEqual(watch.poll(), {spent: 50, earned: 0, count: 1});
      assert.equal(watch.bytesRead, Buffer.byteLength(first), 'only the appended bytes were read');
      const second = settled(20) + earned(30);
      appendFileSync(file, second);
      assert.deepEqual(watch.poll(), {spent: 20, earned: 30, count: 2});
      assert.equal(watch.bytesRead, Buffer.byteLength(first) + Buffer.byteLength(second));
      assert.equal(watch.poll(), null, 'no growth, no event and no read');
      assert.equal(watch.bytesRead, Buffer.byteLength(first) + Buffer.byteLength(second));
    } finally {
      watch.stop();
    }
  });
});

test('a line still being written waits for its newline', () => {
  withDir(dir => {
    const file = join(dir, 'season-spring.jsonl');
    writeFileSync(file, '');
    const watch = new SeasonWatch(dir, 1e9);
    watch.start();
    try {
      const line = settled(40);
      appendFileSync(file, line.slice(0, 15));
      assert.equal(watch.poll(), null);
      assert.equal(watch.bytesRead, 0);
      appendFileSync(file, line.slice(15));
      assert.deepEqual(watch.poll(), {spent: 40, earned: 0, count: 1});
    } finally {
      watch.stop();
    }
  });
});

test('a season that starts after the server does is read from its first byte', () => {
  withDir(dir => {
    writeFileSync(join(dir, 'season-old.jsonl'), settled(500));
    utimesSync(join(dir, 'season-old.jsonl'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const watch = new SeasonWatch(dir, 1e9);
    watch.start();
    try {
      writeFileSync(join(dir, 'season-new.jsonl'), settled(60) + earned(10));
      assert.deepEqual(watch.poll(), {spent: 60, earned: 10, count: 2});
    } finally {
      watch.stop();
    }
  });
});

test('a journal that shrinks is read again from the start', () => {
  withDir(dir => {
    const file = join(dir, 'season-spring.jsonl');
    writeFileSync(file, settled(5) + settled(5) + settled(5));
    const watch = new SeasonWatch(dir, 1e9);
    watch.start();
    try {
      writeFileSync(file, settled(7));
      assert.deepEqual(watch.poll(), {spent: 7, earned: 0, count: 1});
    } finally {
      watch.stop();
    }
  });
});

test('listeners receive totals only, once per batch', () => {
  withDir(dir => {
    const file = join(dir, 'season-spring.jsonl');
    writeFileSync(file, '');
    const watch = new SeasonWatch(dir, 1e9);
    const seen: unknown[] = [];
    watch.listeners.add(totals => seen.push(totals));
    watch.start();
    try {
      appendFileSync(file, settled(3, 'secret') + settled(4, 'secret') + earned(9));
      watch.poll();
      assert.deepEqual(seen, [{spent: 7, earned: 9, count: 3}]);
      assert.deepEqual(Object.keys(seen[0] as object).sort(), ['count', 'earned', 'spent']);
    } finally {
      watch.stop();
    }
  });
});

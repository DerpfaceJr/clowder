// Plan 9.4: the Gmail and Calendar collectors over the seeded fake (fixtures/for-you), offline: fetch is injected and the fake refuses other hosts.
// A real Store on a temp journal, and the real forYou block of town.config.json (the thresholds).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ForYou} from '../src/for-you.ts';
import {googleCollectors, prepMeeting, replyWaiting} from '../src/for-you-google.ts';
import type {CalendarEvent} from '../src/google-rest.ts';
import {ROUTINE_TEMPLATES} from '../src/routine-templates.ts';
import {Store} from '../src/store.ts';
import {OWNER, TOKEN, fakeGoogle} from './fixtures/for-you/fake-google.ts';

const HOUR = 3_600_000, DAY = 86_400_000;
const ACCOUNT = 'google-made-up';
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
// A timed event tomorrow morning with one other attendee: the one meeting in the fixtures that needs prep.
const PREP: CalendarEvent = {id: 'evt-prep', status: 'confirmed', summary: 'Fence quote call', start: {dateTime: '2026-11-10T09:00:00Z'}, end: {dateTime: '2026-11-10T09:30:00Z'},
  attendees: [{email: OWNER, self: true, responseStatus: 'accepted'}, {email: 'sam@stranger.example', responseStatus: 'accepted'}]};

function env(now: string, extra: CalendarEvent[] = [PREP]) {
  const dir = mkdtempSync(join(tmpdir(), 'for-you-google-')), g = fakeGoogle(extra), store = new Store(join(dir, 'events.jsonl'), []);
  const ctx = {account: ACCOUNT, token: async () => TOKEN, fetch: g.fetch, now: Date.parse(now), state: store.state};
  return {ctx, g, store, close: () => rmSync(dir, {recursive: true, force: true})};
}

test('a reply waiting: only the thread from someone the owner has written to, 4 h to 7 d old, is a card', async () => {
  const t = env('2026-11-09T20:00:00Z');
  try {
    const found = await replyWaiting.collect(t.ctx);
    // thr-answered (the owner's message is last), thr-stranger (never written to), thr-promo, thr-social, thr-sent-only, thr-archived (out of the
    // inbox), thr-colleague, thr-injection and thr-long-subject (inbox, but never written to) all give none.
    assert.deepEqual(found.map(f => f.sourceId), ['thr-asked-again']);
    const [card] = found;
    assert.equal(card!.subject, 'Re: Budget draft');
    assert.equal(card!.sourceAt, iso('2026-11-09T14:00:00Z'), 'the newest message is the source time');
    assert.equal(card!.account, ACCOUNT);
    assert.match(card!.person!, /^[0-9a-f]{16}$/, 'an opaque person key');
    assert.ok(!JSON.stringify(found).includes('line 4'), 'no body in the card');
    assert.ok(t.g.calls.some(c => new URL(c.url).searchParams.get('q') === 'in:sent to:"dana@example.org"'), 'the owner has written to Dana: a Sent search');
    for (const c of t.g.calls.filter(x => x.url.includes('/threads/'))) assert.equal(new URL(c.url).searchParams.get('format'), 'metadata', 'headers only');
  } finally { t.close(); }
});

test('the reply window: 4 h exactly is in, 7 d exactly is in, and one second past either edge is out', async () => {
  const cases: [string, string[]][] = [
    ['2026-11-09T17:59:59Z', []], // 3 h 59 m 59 s after Dana's 14:00 message: too new
    ['2026-11-09T18:00:00Z', ['thr-asked-again']],
    ['2026-11-16T14:00:00Z', ['thr-asked-again']],
    ['2026-11-16T14:00:01Z', []], // older than 7 d
  ];
  for (const [now, want] of cases) {
    const t = env(now);
    try { assert.deepEqual((await replyWaiting.collect(t.ctx)).map(f => f.sourceId), want, now); } finally { t.close(); }
  }
});

test('a meeting needs prep: a timed event with another attendee, starting in the next 24 h; solo, declined and all-day give none', async () => {
  const t = env('2026-11-09T12:00:00Z', [PREP, {id: 'evt-allday-prep', status: 'confirmed', summary: 'Owner away', start: {date: '2026-11-10'}, end: {date: '2026-11-11'}, attendees: [{email: 'sam@stranger.example'}]}]);
  try {
    const found = await prepMeeting.collect(t.ctx);
    // Focus block (solo), Dentist sync (the owner declined), Owner away (all-day with an attendee): none. Fence quote call starts 21 h on: in.
    assert.deepEqual(found.map(f => f.sourceId), ['evt-prep']);
    assert.equal(found[0]!.sourceAt, iso('2026-11-10T09:00:00Z'));
    assert.equal(found[0]!.subject, 'Fence quote call');
  } finally { t.close(); }
  const later = env('2026-11-08T12:00:00Z');
  try { assert.deepEqual(await prepMeeting.collect(later.ctx), [], 'more than 24 h ahead: not yet'); } finally { later.close(); }
});

test('no prep card once one has been started, or once the meeting-prep routine has run today', async () => {
  const started = env('2026-11-09T12:00:00Z');
  try {
    started.store.emit('suggestion.raised', {id: 'prep:calendar:evt-prep', source: 'calendar', account: ACCOUNT, sourceId: 'evt-prep', category: 'prep', subject: 'x', person: null, sourceAt: iso('2026-11-10T09:00:00Z')});
    started.store.emit('suggestion.started', {id: 'prep:calendar:evt-prep', task: 'task-1'});
    assert.deepEqual(await prepMeeting.collect({...started.ctx, state: started.store.state}), [], 'a started card is the prep');
  } finally { started.close(); }

  const now = Date.parse('2026-11-09T12:00:00Z');
  const briefed = env('2026-11-09T12:00:00Z');
  try {
    const prompt = ROUTINE_TEMPLATES.find(r => r.id === 'meeting-prep')!.prompt;
    briefed.store.emit('routine.saved', {id: 'routine-prep', title: 'Meeting prep', prompt, cat: 'mayor', schedule: null, mode: 'demo', tokenBudget: null, enabled: true, lastRunAt: new Date(now).toISOString()});
    assert.deepEqual(await prepMeeting.collect({...briefed.ctx, state: briefed.store.state}), [], 'the briefing ran today: it covers every meeting');
  } finally { briefed.close(); }

  const yesterday = env('2026-11-09T12:00:00Z');
  try {
    const prompt = ROUTINE_TEMPLATES.find(r => r.id === 'meeting-prep')!.prompt;
    yesterday.store.emit('routine.saved', {id: 'routine-prep', title: 'Meeting prep', prompt, cat: 'mayor', schedule: null, mode: 'demo', tokenBudget: null, enabled: true, lastRunAt: new Date(now - 26 * HOUR).toISOString()});
    assert.deepEqual((await prepMeeting.collect({...yesterday.ctx, state: yesterday.store.state})).map(f => f.sourceId), ['evt-prep'], 'a run on an earlier day does not count');
  } finally { yesterday.close(); }
});

test('the loop raises the reply and the prep cards on their days and nothing else, with the real config', async () => {
  const g = fakeGoogle([PREP]), dir = mkdtempSync(join(tmpdir(), 'for-you-google-loop-')), store = new Store(join(dir, 'events.jsonl'), []);
  const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
  let now = Date.parse('2026-11-09T12:00:00Z');
  try {
    const fy = new ForYou({dir: () => dir, store: () => store, token: async a => a === ACCOUNT ? TOKEN : null,
      config: () => ({...config.forYou, categories: {reply: true, prep: true}}), collectors: googleCollectors, fetch: g.fetch, now: () => now});
    await fy.update({enabled: true, account: ACCOUNT});
    await fy.poll();
    assert.deepEqual(Object.values(store.state.suggestions ?? {}).filter(c => c.status === 'open').map(c => c.sourceId), ['evt-prep']);
    now = Date.parse('2026-11-09T20:00:00Z');
    await fy.poll();
    assert.deepEqual(Object.values(store.state.suggestions ?? {}).filter(c => c.status === 'open').map(c => c.sourceId).sort(), ['evt-prep', 'thr-asked-again']);
    assert.equal(fy.status().error, null);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a crafted From address never reaches the Sent search: braces, quotes or spaces give no card and no search', async () => {
  const now = Date.parse('2026-11-09T20:00:00Z'), searches: string[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), {status: 200, headers: {'content-type': 'application/json'}});
  const froms = ['Eve <eve@x.example} OR {dana@example.org>', 'Eve <"eve"@x.example>', 'eve @x.example'];
  const fetch = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/threads')) return json({threads: froms.map((_, i) => ({id: `t${i}`}))});
    if (u.pathname.endsWith('/messages')) { searches.push(u.searchParams.get('q') ?? ''); return json({messages: [{id: 'm'}]}); }
    const i = Number(u.pathname.split('/').at(-1)!.slice(1));
    return json({messages: [{id: `m${i}`, labelIds: ['INBOX'], internalDate: String(now - 6 * HOUR), payload: {headers: [{name: 'From', value: froms[i]}, {name: 'Subject', value: 'Hi'}]}}]});
  }) as typeof globalThis.fetch;
  const found = await replyWaiting.collect({account: ACCOUNT, token: async () => TOKEN, fetch, now, state: new Store(join(mkdtempSync(join(tmpdir(), 'for-you-crafted-')), 'events.jsonl'), []).state});
  assert.deepEqual(found, []);
  assert.deepEqual(searches, []);
});

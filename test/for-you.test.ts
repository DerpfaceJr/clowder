// Plan 9.1 and 9.13: the Google REST reader against the seeded fake sources. Offline: fetch is injected and the fake refuses any other host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarEvents, gmail, GoogleError, type CalendarEvent} from '../src/google-rest.ts';
import {OWNER, THREADS, TOKEN, fakeGoogle} from './fixtures/for-you/fake-google.ts';

type Thread = {id: string; messages: {id: string; labelIds?: string[]; payload?: {headers?: {name: string; value: string}[]}}[]};
const header = (m: Thread['messages'][number], name: string) => m.payload?.headers?.find(h => h.name === name)?.value ?? '';

test('calendar events.list returns the three seeded events, each identifiable by its mark', async () => {
  const g = fakeGoogle();
  const events = await calendarEvents(g.fetch, TOKEN);
  assert.equal(events.length, 3);
  const by = (summary: string) => events.find(e => e.summary === summary) as CalendarEvent;

  const solo = by('Focus block');
  assert.equal(solo.attendees, undefined, 'a solo event has no attendees');

  const declined = by('Dentist sync');
  assert.ok(declined.attendees?.some(a => a.self && a.responseStatus === 'declined'), 'the owner declined it');

  const allDay = by('Owner away');
  assert.ok(allDay.start?.date && !allDay.start.dateTime, 'an all-day event carries a date, not a dateTime');

  const url = new URL(g.calls[0]!.url);
  assert.equal(url.pathname, '/calendar/v3/calendars/primary/events');
  assert.equal(url.searchParams.get('singleEvents'), 'true', 'recurring events are expanded');
  assert.equal(g.calls[0]!.auth, `Bearer ${TOKEN}`);
});

test('Gmail lists the ten seeded threads and reads each; the answered, stranger and promotions marks are as seeded', async () => {
  const g = fakeGoogle();
  const list = await gmail<{threads: {id: string}[]}>(g.fetch, '/threads', TOKEN);
  assert.deepEqual(list.threads.map(t => t.id).sort(), THREADS.map(t => t.id).sort());
  assert.equal(list.threads.length, 10);

  const read = async (id: string) => gmail<Thread>(g.fetch, `/threads/${id}?format=full`, TOKEN);
  const answered = await read('thr-answered');
  const last = answered.messages.at(-1)!;
  assert.ok(last.labelIds?.includes('SENT') && header(last, 'From').includes(OWNER), 'the owner has answered: the last message is theirs and was sent');

  const stranger = await read('thr-stranger');
  assert.ok(stranger.messages.every(m => !header(m, 'From').includes(OWNER)) && stranger.messages[0]!.labelIds?.includes('INBOX'), 'a stranger in the inbox');

  const promo = await read('thr-promo');
  assert.ok(promo.messages[0]!.labelIds?.includes('CATEGORY_PROMOTIONS'), 'in Promotions');
});

test('a bad token is refused with the status only: no token and no body in the error', async () => {
  const g = fakeGoogle();
  const err = await calendarEvents(g.fetch, 'wrong-token').then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GoogleError);
  assert.equal(err.status, 401);
  assert.equal(err.message, 'Google Calendar 401');
  assert.ok(!err.message.includes('wrong-token') && !err.message.includes('code'), 'no token or body in the message');
});

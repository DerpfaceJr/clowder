// Google's REST reads (plan 9.1): the one place that calls Gmail and Calendar over plain fetch. Every call takes the bearer token from the caller
// (the connector hub renews it), a 20 s timeout, and errors that carry the HTTP status only: never the response body or the token.
const GMAIL = {base: 'https://gmail.googleapis.com/gmail/v1/users/me', name: 'Gmail'};
const CALENDAR = {base: 'https://www.googleapis.com/calendar/v3', name: 'Google Calendar'};
const TIMEOUT_MS = 20_000;

export class GoogleError extends Error {
  constructor(readonly service: string, readonly status: number) { super(`${service} ${status}`); }
}

export type GoogleInit = {method?: string; body?: unknown};
type Api = {base: string; name: string};

async function call<T>(f: typeof fetch, api: Api, path: string, token: string, init: GoogleInit = {}): Promise<T> {
  const json: Record<string, string> = init.body === undefined ? {} : {'Content-Type': 'application/json'};
  const res = await f(`${api.base}${path}`, {method: init.method ?? 'GET', headers: {Authorization: `Bearer ${token}`, ...json}, ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)}), signal: AbortSignal.timeout(TIMEOUT_MS)});
  if (!res.ok) throw new GoogleError(api.name, res.status);
  return (await res.json().catch(() => ({}))) as T;
}

/** A Gmail REST call under users/me. `path` starts with a slash, e.g. `/profile` or `/history?...`. */
export function gmail<T>(f: typeof fetch, path: string, token: string, init?: GoogleInit): Promise<T> {
  return call<T>(f, GMAIL, path, token, init);
}

export type CalendarAttendee = {email?: string; self?: boolean; responseStatus?: string};
export type CalendarEvent = {
  id: string; status?: string; summary?: string; htmlLink?: string;
  start?: {dateTime?: string; date?: string}; end?: {dateTime?: string; date?: string};
  attendees?: CalendarAttendee[];
};

/** Calendar events.list for one calendar, recurring events expanded, in start order. Empty when there are none. */
export async function calendarEvents(f: typeof fetch, token: string, o: {calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number} = {}): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({singleEvents: 'true', orderBy: 'startTime', maxResults: String(o.maxResults ?? 50)});
  if (o.timeMin) q.set('timeMin', o.timeMin);
  if (o.timeMax) q.set('timeMax', o.timeMax);
  const cal = encodeURIComponent(o.calendarId ?? 'primary');
  const r = await call<{items?: CalendarEvent[]}>(f, CALENDAR, `/calendars/${cal}/events?${q}`, token);
  return r.items ?? [];
}

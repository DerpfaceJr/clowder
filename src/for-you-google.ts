// For you (plan 9.4): the Gmail and Calendar collectors, by the rules in docs/for-you-and-teams-plan.md §3.1. Rule-based, no model call.
// Headers and event fields only: no message body is fetched. The ASSUMED thresholds come from town.config.json (forYou.rules), read on every pass.
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.ts';
import {personKey, type CollectContext, type Collector, type Found} from './for-you.ts';
import {GoogleError, calendarEvents, gmail} from './google-rest.ts';
import {address, header} from './mail-inbox.ts';
import {dayKey} from './goals.ts';
import {ROUTINE_TEMPLATES} from './routine-templates.ts';
import {tokenize} from './memory.ts';
import {DUPLICATE, overlap} from './wiki.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOUR = 3_600_000, DAY = 86_400_000;
const RULE_KEYS = ['replyAfterHours', 'replyWithinDays', 'prepWithinHours', 'repeatWindowDays', 'repeatMin', 'quietDays'] as const;
export type ForYouRules = Record<(typeof RULE_KEYS)[number], number>;

/** The thresholds in town.config.json (forYou.rules), read now. A missing or bad value gives null: the collector reads nothing, so it does less, never more. */
export function forYouRules(): ForYouRules | null {
  let r: Record<string, unknown>;
  try { r = loadConfig(ROOT).forYou?.rules ?? {}; } catch { return null; }
  const out = {} as ForYouRules;
  for (const k of RULE_KEYS) { const v = r[k]; if (typeof v !== 'number' || !(v >= 0)) return null; out[k] = v; }
  return out;
}

// Gmail's own categories the reply rule leaves out, and the labels of a message the owner sent.
const LEFT_OUT = ['SENT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];
// ponytail: the first 50 inbox threads per pass; page through when 50 proves too few.
const THREADS_MAX = 50;
type Meta = {id: string; labelIds?: string[]; internalDate?: string; payload?: {headers?: {name: string; value: string}[]}};

/** "A reply is waiting" (3.1): the newest message is in the inbox, not the owner's, not in Promotions or Social, 4 h to 7 d old, and from an
 *  address the owner has written to (a Sent search, one hit is enough). */
export const replyWaiting: Collector = {category: 'reply', async collect(c) {
  const rules = forYouRules();
  if (!rules) return [];
  const token = await c.token();
  const list = await gmail<{threads?: {id: string}[]}>(c.fetch, `/threads?labelIds=INBOX&maxResults=${THREADS_MAX}`, token);
  const out: Found[] = [];
  for (const {id} of list.threads ?? []) {
    let t: {messages?: Meta[]};
    try { t = await gmail(c.fetch, `/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token); }
    catch (e) { if (e instanceof GoogleError && e.status === 404) continue; throw e; } // deleted since the list: its card closes
    const last = t.messages?.at(-1), labels = last?.labelIds ?? [], at = Number(last?.internalDate);
    if (!last || !Number.isFinite(at) || !labels.includes('INBOX') || labels.some(l => LEFT_OUT.includes(l))) continue;
    const age = c.now - at;
    if (age < rules.replyAfterHours * HOUR || age > rules.replyWithinDays * DAY) continue;
    const addr = address(header(last, 'From'));
    // The From header is the sender's to write: only a plain address reaches the search, so braces, quotes or spaces cannot turn it into "anyone".
    if (!/^[^\s"{}()<>]+@[^\s"{}()<>]+$/.test(addr)) continue;
    const sent = await gmail<{messages?: unknown[]}>(c.fetch, `/messages?${new URLSearchParams({q: `in:sent to:"${addr}"`, maxResults: '1'})}`, token);
    if (!sent.messages?.length) continue; // a stranger: the owner has never written to them
    out.push({source: 'gmail', account: c.account, sourceId: id, subject: header(last, 'Subject') || '(no subject)', person: personKey(addr), sourceAt: new Date(at).toISOString()});
  }
  return out;
}};

const prepTemplate = ROUTINE_TEMPLATES.find(t => t.id === 'meeting-prep')!;
/** The meeting-prep routine briefs the whole day once. Its run today (same prompt, same local day) covers every meeting. */
function briefedToday(c: CollectContext) {
  const want = new Set(tokenize(prepTemplate.prompt));
  return c.state.routines.some(r => r.lastRunAt && dayKey(new Date(r.lastRunAt)) === dayKey(new Date(c.now)) && overlap(new Set(tokenize(r.prompt)), want) >= DUPLICATE);
}

/** "A meeting needs prep" (3.1): a timed event starting in the next 24 h, with another attendee, not declined by the owner, not cancelled,
 *  with no prep card started for it yet, and the day's briefing not run. All-day events and solo events are not meetings. */
export const prepMeeting: Collector = {category: 'prep', async collect(c) {
  const rules = forYouRules();
  if (!rules) return [];
  const token = await c.token();
  const horizon = c.now + rules.prepWithinHours * HOUR;
  const events = await calendarEvents(c.fetch, token, {timeMin: new Date(c.now).toISOString(), timeMax: new Date(horizon).toISOString(), maxResults: 50});
  if (briefedToday(c)) return [];
  const started = new Set(Object.values(c.state.suggestions ?? {}).filter(s => s.category === 'prep' && s.status === 'started').map(s => s.sourceId));
  const out: Found[] = [];
  for (const ev of events) {
    const start = Date.parse(ev.start?.dateTime ?? ''); // an all-day event has a date only: NaN, not a meeting
    if (!Number.isFinite(start) || start < c.now || start > horizon || ev.status === 'cancelled' || started.has(ev.id)) continue;
    if (ev.attendees?.find(a => a.self)?.responseStatus === 'declined') continue;
    const others = (ev.attendees ?? []).filter(a => !a.self && a.email);
    if (!others.length) continue;
    out.push({source: 'calendar', account: c.account, sourceId: ev.id, subject: ev.summary || '(no title)', person: personKey(others[0]!.email!), sourceAt: new Date(start).toISOString()});
  }
  return out;
}};

/** The collectors for the Gmail and Calendar categories, for ForYou's collectors list. */
export const googleCollectors: Collector[] = [replyWaiting, prepMeeting];

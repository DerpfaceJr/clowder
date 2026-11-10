// For you (plan 9.5): Clowder's own collectors, rule-based, over ctx.state (the world's journal). Repeat work: owner Requests that say the same
// thing again. A quiet goal: an active goal with no log line for a while. Thresholds: town.config.json (forYou.rules), read on every pass.
import type {Collector, Found} from './for-you.ts';
import {forYouRules} from './for-you-google.ts';
import {tokenize} from './memory.ts';
import {DUPLICATE, overlap} from './wiki.ts';

const DAY = 86_400_000;

/** Owner Requests in the window that overlap a group of at least repeatMin (3.1). The card is the oldest of the group, so a 4th similar
 *  Request leaves the same card as it was; a routine whose prompt overlaps the group raises none. Routine runs, goal rounds and a Mayor's
 *  child tasks are not Requests. */
export const repeatWork: Collector = {category: 'repeat', async collect(c) {
  const rules = forYouRules();
  if (!rules) return [];
  const since = c.now - rules.repeatWindowDays * DAY;
  const requests = c.state.events
    .filter(e => e.type === 'task.created' && e.data?.from === 'owner' && !e.data?.parent && !e.data?.routine && !e.data?.goal && Date.parse(e.at) >= since)
    .map(e => ({id: String(e.data.id), at: Date.parse(e.at), text: String(e.data.text ?? '')}))
    .map(r => ({...r, words: new Set(tokenize(r.text))}))
    .filter(r => r.words.size > 0 && Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
  const routines = c.state.routines.map(r => new Set(tokenize(r.prompt)));
  const used = new Set<string>(), out: Found[] = [];
  for (const a of requests) {
    if (used.has(a.id)) continue;
    const group = requests.filter(x => overlap(a.words, x.words) >= DUPLICATE);
    if (group.length < rules.repeatMin) continue;
    for (const x of group) used.add(x.id);
    if (routines.some(p => overlap(p, a.words) >= DUPLICATE)) continue;
    out.push({source: 'clowder', account: null, sourceId: a.id, subject: a.text, person: null, sourceAt: new Date(a.at).toISOString()});
  }
  return out;
}};

/** A goal that has gone quiet (3.1): active, and no log line (goal.updated with logLine) for quietDays. A goal with no line yet counts from its creation. */
export const quietGoal: Collector = {category: 'quiet', async collect(c) {
  const rules = forYouRules();
  if (!rules) return [];
  const lastLine = new Map<string, number>();
  for (const e of c.state.events) if (e.type === 'goal.updated' && e.data?.logLine) lastLine.set(e.data.id, Math.max(lastLine.get(e.data.id) ?? 0, Date.parse(e.at)));
  const out: Found[] = [];
  for (const g of c.state.goals) {
    if (g.status !== 'active') continue;
    const at = lastLine.get(g.id) ?? Date.parse(g.createdAt);
    if (!Number.isFinite(at) || c.now - at < rules.quietDays * DAY) continue;
    out.push({source: 'clowder', account: null, sourceId: g.id, subject: g.title, person: null, sourceAt: new Date(at).toISOString()});
  }
  return out;
}};

/** The collectors for the repeat and quiet categories, for ForYou's collectors list. */
export const clowderCollectors: Collector[] = [repeatWork, quietGoal];

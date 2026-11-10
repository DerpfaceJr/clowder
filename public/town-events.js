import {cutAtWord} from './one-liner.js';

// Pure diff of two town snapshots, shared by audio.js and notify.js so both agree on what is new, and the message kinds they
// and app.js's chat and diary agree on. The first refresh only sets a baseline: history already on the page must never chime or notify.

// Not a cat: the owner, or the town itself ('system' for failures, 'town' for goal rounds).
export const isOwnerSide = id => id === 'owner' || id === 'system' || id === 'town';
export const isMayorToOwner = message => !!message && message.from === 'mayor' && message.to === 'owner';
export const isCatChat = message => !!message && !isOwnerSide(message.from) && !isOwnerSide(message.to) && message.from !== message.to;

// A goal round's opening message to the Mayor, "Goal round N: <goal title>". The town sends it ('town'); older journals have it
// in the owner's name, though the owner never typed it. {round, title} for one, null for any other message.
const ROUND = /^Goal round (\d+):\s*(.*)$/s;
export function goalRound(message) {
  if (!message || message.to !== 'mayor' || (message.from !== 'town' && message.from !== 'owner')) return null;
  const match = ROUND.exec(String(message.text ?? ''));
  return match ? {round: Number(match[1]), title: match[2].replace(/\s+/g, ' ').trim()} : null;
}
// The quiet line chat and the diary show for a round. Goal titles are one line of at most 80 characters; a longer one is cut at a word (one-liner.js cutAtWord).
export function roundStarted({round, title}, max = 90) {
  const cut = cutAtWord(title, max);
  return cut ? `Round ${round} of “${cut}” started` : `Goal round ${round} started`;
}

export function diffTownState(prev, next) {
  const out = {baseline: !prev || !next, messages: [], approvals: []};
  if (out.baseline) return out;
  const seen = new Set((prev.messages || []).map(m => m && m.id));
  for (const message of next.messages || []) if (message && !seen.has(message.id)) out.messages.push(message);
  const pending = new Set((prev.approvals || []).filter(a => a.status === 'pending').map(a => a.id));
  for (const approval of next.approvals || []) if (approval.status === 'pending' && !pending.has(approval.id)) out.approvals.push(approval);
  return out;
}

// The cat that did a task, for the diary. /api/state keeps only recent top-level tasks, so a delegated task is often
// missing there. Its messages say who did it: the one that said the result, else the one the brief went to. Null when
// nothing says, so the diary never prints "undefined".
export function taskCatOf(id, tasks, events, result) {
  const task = (tasks || []).find(t => t && t.id === id);
  if (task) return task.cat;
  const said = (events || []).filter(e => e && e.type === 'message' && e.data && e.data.task === id);
  const reply = result ? said.find(e => e.data.text === result) : null;
  if (reply) return reply.data.from;
  return said.length ? said[0].data.to : null;
}

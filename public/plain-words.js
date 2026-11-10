// Plain words for the panels (D12, plan 3.9). Four nouns: a Goal, a Request (what you asked a cat to do), a Decision (what a cat asks
// you to decide) and a To-do (what only you can do), and ✓ for done instead of a grade. For you (D16, plan 9.11) adds two card nouns: a
// Heads-up (nothing to do but know) and a Suggestion (a proposed Request). The game's words (quests, ranks) stay in
// the 3D town and in seasons. The server still writes some titles in older words ("Owner step: …"), so panels read them through
// plainWords. The pure helpers here touch no DOM.

const NOUN = {approval: 'Decision', purchase: 'Decision', capability: 'Decision', 'ai-suggestion': 'Decision', 'owner-step': 'To-do', goal: 'Goal', project: 'Request',
  model: 'AI model', season: 'Season', workshop: 'Workshop', council: 'Council'};
const GLYPH = {Decision: '?', 'To-do': '☐', Goal: '⚑', Request: '✉', 'Heads-up': 'ℹ', Suggestion: '→'};
// A For you card's id is `<category>:<source>:<source id>` (src/for-you.ts cardId). A goal gone quiet asks nothing: a Heads-up. Every
// other category proposes a Request: a Suggestion.
const HEADS_UP = new Set(['quiet']);

/** A For you card's category ('reply', 'prep', 'repeat', 'quiet'), from its card id. Empty for anything else. */
export function forYouCategory(item) {
  const kind = item?.source?.kind ?? item?.kind;
  return kind === 'suggestion' ? String(item?.source?.id ?? '').split(':')[0] : '';
}

/** D16's noun for a For you card: Heads-up or Suggestion. */
export const forYouNoun = item => (HEADS_UP.has(forYouCategory(item)) ? 'Heads-up' : 'Suggestion');

/** What an item on the Needs you list is, in one of the four nouns (or For you's two) where it is one of them. Done items carry their kind as kind. */
export function nounOf(item) {
  const kind = item?.source?.kind ?? item?.kind;
  // An approved, unpaid purchase (plan 11.16, N1) is the owner's to pay: a To-do, labelled Payment. A pending one is still a Decision.
  if (item?.payment) return 'To-do';
  if (kind === 'connect') return 'To-do';
  if (kind === 'purchase' && item?.rank === 'F') return 'Payment';
  if (kind === 'suggestion') return forYouNoun(item);
  return NOUN[kind] ?? 'Notice';
}

/** The card's badge: ✓ for a finished item, otherwise a glyph for its noun. Never a letter grade. */
export function glyphOf(item) {
  if (item?.rank === 'F') return '✓';
  return GLYPH[nounOf(item)] ?? '!';
}

// Older server words, as plain ones. Each pattern is anchored to the server's own wording, so a cat's text is changed only where it
// says "owner step", which is the server's term for a to-do.
const REWRITES = [
  [/^Owner step done: /, 'To-do done: '],
  [/^Owner step removed: /, 'To-do removed: '],
  [/^Owner step: /, 'To-do: '],
  [/^Goal turned in: /, 'Goal done: '],
  [/^Turned in: /, 'Done: '],
  [/^Turned in\.$/, 'Done.'],
  [/^Waiting on you: /, 'Waiting for you: '],
  [/^(Approved|Rejected|Cancelled): \1$/, '$1'],
  [/^Rejected\b/, 'Declined'],
  [/\bowner steps\b/g, 'to-dos'],
  [/\bOwner steps\b/g, 'To-dos'],
  [/\bowner step\b/g, 'to-do'],
];
export function plainWords(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The Inbox's bands (plan 11.16, N6), from the server's band (src/quests.ts): only Needs you is counted. Trouble is a failed or stopped
 * request or goal, shown open with Retry where it can run again. Handled is quiet work, folded. Finished items fold on their own (F13).
 */
export const BANDS = {needs: 'Needs you', trouble: 'Trouble', handled: 'Your cats are handling these', finished: 'Recently finished'};

/** When an approved purchase's approval ends (plan 11.16, N1): "Approval ends in 2 days". Rounded down, so it never promises more time than is left. */
export function approvalEnds(iso, now = Date.now()) {
  const left = Date.parse(iso ?? '') - now;
  if (!Number.isFinite(left)) return '';
  if (left <= 0) return 'Approval has ended';
  const minutes = Math.max(1, Math.floor(left / 60000)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return `Approval ends in ${days >= 2 ? `${days} days` : hours >= 1 ? `${hours} h` : `${minutes} min`}`;
}

/** The one "needs you" line, worded the same wherever the count shows. */
export function needsYouLabel(count) {
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

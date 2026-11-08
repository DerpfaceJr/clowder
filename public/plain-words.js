// Plain words for the panels (D12, plan 3.9). Four nouns: a Goal, a Request (what you asked a cat to do), a Decision (what a cat asks
// you to decide) and a To-do (what only you can do), and ✓ for done instead of a grade. The game's words (quests, ranks, coins) stay in
// the 3D town and in seasons. The server still writes some titles in older words ("Owner step: …"), so panels read them through
// plainWords. The pure helpers here touch no DOM.

const NOUN = {approval: 'Decision', purchase: 'Decision', capability: 'Decision', 'ai-suggestion': 'Decision', 'owner-step': 'To-do', goal: 'Goal', project: 'Request',
  model: 'AI model', season: 'Season', workshop: 'Workshop', council: 'Council'};
const GLYPH = {Decision: '?', 'To-do': '☐', Goal: '⚑', Request: '✉'};

/** What an item on the Needs you list is, in one of the four nouns where it is one of them. Done items carry their kind as kind. */
export function nounOf(item) {
  const kind = item?.source?.kind ?? item?.kind;
  if (kind === 'purchase' && item?.rank === 'F') return 'Payment';
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

/** The one "needs you" line, worded the same wherever the count shows. */
export function needsYouLabel(count) {
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

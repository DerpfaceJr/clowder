// Pure: which cats are in Demonstration right now. A cat is in it when it has a queued, running or waiting task in
// demo mode, when a goal the Mayor runs is active or paused in demo mode, or when the chat open to it is set to demo.
// Shared by the cat header pill, the composer warning, the goal cards and the 3D town (town.js); one rule, one place.
const LIVE_TASK = ['queued', 'running', 'waiting', 'waiting_child'];
const LIVE_GOAL = ['active', 'paused'];

// chat: {cat, mode} for the chat open now, where mode is the Reasoning provider ('demo' when it is Demonstration), or null.
export function demoCats(state, chat = null) {
  const cats = new Set();
  for (const task of state?.tasks ?? []) {
    if (task.mode === 'demo' && LIVE_TASK.includes(task.status)) cats.add(task.cat);
  }
  // Goals are run by the Mayor, so a demo goal puts the Mayor in Demonstration.
  for (const goal of state?.goals ?? []) {
    if (goal.mode === 'demo' && LIVE_GOAL.includes(goal.status)) cats.add('mayor');
  }
  if (chat?.cat && chat.mode === 'demo') cats.add(chat.cat);
  return cats;
}

export function isDemo(state, catId, chat = null) {
  return demoCats(state, chat).has(catId);
}

// A canned Demonstration reply starts with this tag (src/provider.ts demoProvider). The chat shows the reply without the
// tag and says plainly above it that the script never read the owner's words (plan 5.8, ux-audit F8).
const DEMO_TAG = /^\[Demonstration\]\s*/;
const NOT_A_CAT = ['owner', 'system', 'town'];
export const DEMO_REPLY_NOTE = 'Demonstration reply. It did not read your request.';

/** A cat's canned Demonstration reply: its text without the tag. Null for anything else, the owner's own words included. */
export function demoReply(message) {
  if (!message || NOT_A_CAT.includes(message.from)) return null;
  const text = String(message.text ?? '');
  return DEMO_TAG.test(text) ? text.replace(DEMO_TAG, '') : null;
}

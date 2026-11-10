import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {nounOf, glyphOf, plainWords, needsYouLabel} from '../public/plain-words.js';
import {createQuestsPanel, needsYouCount, badgeLabel, splitNeeds} from '../public/quests-panel.js';
import {summaryTiles, SECTION_TITLES, goalCount, goalStatusLine} from '../public/projects-panel.js';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('each item on Needs you is a Decision, a To-do, a Goal or a Request where it is one, and a finished one is ✓', () => {
  assert.equal(nounOf({source: {kind: 'approval'}}), 'Decision');
  assert.equal(nounOf({source: {kind: 'purchase'}, rank: 'S'}), 'Decision');
  assert.equal(nounOf({source: {kind: 'capability'}}), 'Decision');
  assert.equal(nounOf({source: {kind: 'owner-step'}}), 'To-do');
  assert.equal(nounOf({source: {kind: 'goal'}}), 'Goal');
  assert.equal(nounOf({source: {kind: 'project'}}), 'Request');
  assert.equal(nounOf({kind: 'owner-step', rank: 'F'}), 'To-do', 'a Done-tab item carries its kind as kind');
  assert.equal(nounOf({source: {kind: 'purchase'}, rank: 'F'}), 'Payment', 'Autopay’s paid notice is a payment, not a decision');
  assert.equal(nounOf({source: {kind: 'something-new'}}), 'Notice');
  for (const rank of ['S', 'A', 'B', 'C', 'D', 'E']) assert.ok(!/^[A-F]$/.test(glyphOf({rank, source: {kind: 'approval'}})), `no letter grade for ${rank}`);
  assert.equal(glyphOf({rank: 'F', source: {kind: 'goal'}}), '✓');
  assert.equal(glyphOf({rank: 'F', kind: 'approval'}), '✓');
});

test('the server’s older words read as plain ones, and a repeated answer is said once', () => {
  assert.equal(plainWords('Owner step: Connect GitHub'), 'To-do: Connect GitHub');
  assert.equal(plainWords('Owner step done: Connect GitHub'), 'To-do done: Connect GitHub');
  assert.equal(plainWords('Owner step removed: Pay the invoice'), 'To-do removed: Pay the invoice');
  assert.equal(plainWords('Goal turned in: Launch the shop'), 'Goal done: Launch the shop');
  assert.equal(plainWords('Turned in.'), 'Done.');
  assert.equal(plainWords('Waiting on you: Launch the shop'), 'Waiting for you: Launch the shop');
  assert.equal(plainWords('Mark the owner steps done and the goal resumes.'), 'Mark the to-dos done and the goal resumes.');
  assert.equal(plainWords('Rejected: Rejected'), 'Declined');
  assert.equal(plainWords('Rejected: Not this week'), 'Declined: Not this week');
  assert.equal(plainWords('Approved: Approved'), 'Approved');
  assert.equal(plainWords('Approved: Allow'), 'Approved: Allow');
  assert.equal(plainWords(undefined), '');
  assert.equal(plainWords('A request about turned in homework'), 'A request about turned in homework', 'only the server’s own phrasing changes');
});

test('one "needs you" count: the badge, its label and the Projects summary show the same number', () => {
  const list = [
    {rank: 'S', needsYou: true, source: {kind: 'approval'}},
    {rank: 'A', needsYou: true, source: {kind: 'owner-step'}},
    {rank: 'B', needsYou: true, source: {kind: 'owner-step'}},
    {rank: 'A', needsYou: false, source: {kind: 'season'}},
    {rank: 'F', needsYou: false, source: {kind: 'goal'}},
  ];
  const n = needsYouCount(list);
  assert.equal(n, 3);
  assert.equal(n, splitNeeds(list).needs.length);
  assert.equal(badgeLabel(n), '3 things need you');
  assert.equal(needsYouLabel(1), '1 thing needs you');
  const needsTile = summaryTiles({goals: [], goalsKnown: true, needsYou: n, week: null, artifacts: [], now: new Date()}).find(t => t.label === 'Inbox');
  assert.equal(needsTile.value, String(n));
  // The goal groups count goals in words, so their number never reads as a second "needs you" count.
  assert.equal(SECTION_TITLES.waiting, 'Waiting for you');
  assert.equal(goalCount(1), '1 goal');
  assert.equal(goalCount(2), '2 goals');
  assert.equal(goalStatusLine({status: 'paused', pausedBy: 'owner-step'}), goalStatusLine({status: 'paused', pausedBy: 'approval'}), 'one phrase for a goal held for you');
});

test('app.js feeds the same number to the dock badge, the Mayor’s notice, the town’s marker and the Projects summary', () => {
  const app = read('app.js');
  assert.match(app, /onCount:n=>\{const changed=n!==questCount;questCount=n;questAlert=n>0;scene\?\.setAttention\(questAlert\);paintQuestNotice\(\);if\(changed\)void projectsPanel\.refresh\(\);dispatchEvent\(new CustomEvent\('quest-list',\{detail:questList\}\)\);openWantedLink\(\);\}/, 'and the list reaches notify.js, which retries a waiting #item= link (plan 11.20)');
  assert.match(app, /needsYou:\(\)=>questCount\}/);
  assert.match(app, /text:`\$\{badgeLabel\(questCount\)\} ›`/);
  const panel = read('quests-panel.js');
  assert.match(panel, /const count=needsYouCount\(active\);\n\s*badge\.textContent=String\(count\);badge\.hidden=count===0;badge\.setAttribute\('aria-label',badgeLabel\(count\)\);onCount\(count\);/);
  // "waiting" next to a number is the Mayor's queue, so it says queued and never reads as a needs-you count.
  assert.ok(!/\$\{inboxCount\(state\)\} waiting|\$\{waiting\} waiting/.test(app));
});

test('a grep of the panels finds no quests, ranks, owner steps or "turned in" in what the owner reads', () => {
  const html = read('index.html');
  const visible = [...html.matchAll(/>([^<>]+)</g)].map(m => m[1]).concat([...html.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1]));
  assert.deepEqual(visible.filter(t => /\bquests?\b/i.test(t)), [], 'index.html text and labels');
  // The 3D town and seasons keep the game's words; plain-words.js holds the old phrases only to rewrite them.
  const game = new Set(['town.js', 'hologram.js', 'season-panel.js', 'plain-words.js', 'world-art.js', 'town-ground.js']);
  const files = readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.js') && !game.has(f));
  const banned = /['`"][^'`"\n]*(?:\bquests? (?:need|log)|Quest log|Owner steps?\b|Turned in|Rank \$\{|[SABCDEF] · )[^'`"\n]*['`"]/;
  const hits = files.flatMap(f => read(f).split('\n').map((line, i) => [f, i + 1, line]).filter(([, , line]) => !/^\s*\/\//.test(line) && banned.test(line)));
  assert.deepEqual(hits.map(([f, n, line]) => `${f}:${n}: ${line.trim().slice(0, 120)}`), []);
});

// A small stand-in for the browser DOM (as in quests-panel.test.mjs): enough for the panel to build its cards in Node.
class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, ownText: ''});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])); }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { this.onclick?.({type: 'click', currentTarget: this}); }
  matches(selector) { const [tag, ...classes] = selector.split('.'), own = this.className.split(/\s+/); return (!tag || this.tagName === tag.toUpperCase()) && classes.every(c => own.includes(c)); }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
async function mount(active, done = []) {
  const saved = globalThis.document, doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  globalThis.document = doc;
  const panel = doc.createElement('section'), body = doc.createElement('div'), status = doc.createElement('p'), badge = doc.createElement('span');
  panel.append(body, status, badge); doc.body.append(panel);
  const counts = [];
  const fetchImpl = async url => ({ok: true, json: async () => (url === '/api/artifacts' ? {artifacts: []} : url === '/api/quests/done' ? done : active)});
  const quests = createQuestsPanel({panel, body, status, badge, fetchImpl, onCount: n => counts.push(n)});
  await quests.refresh();
  return {doc, body, badge, counts, restore: () => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }};
}
const step = {id: 'owner-step:s1', rank: 'A', title: 'Owner step: Connect GitHub', detail: 'Sign in so the Scribe can push files.', at: '2026-11-06T18:00:00.000Z', source: {kind: 'owner-step', id: 's1'}, stepKind: 'account', action: {label: 'Mark done', panel: 'projects'}, needsYou: true};
const decision = {id: 'approval:a1', rank: 'S', title: 'May the Scribe push to the repo', detail: 'Scribe is blocked until you answer.', at: '2026-11-06T18:01:00.000Z', source: {kind: 'approval', id: 'a1'}, action: {label: 'Answer', panel: 'chat', cat: 'scribe'}, needsYou: true};
const finished = {id: 'goal:g1', rank: 'F', title: 'Goal turned in: Launch the shop', detail: 'Turned in.', at: '2026-11-06T17:00:00.000Z', source: {kind: 'goal', id: 'g1'}, action: {label: 'Open goal', panel: 'projects'}, needsYou: false};

test('cards say what they are in plain words, headings carry no letters, and the badge counts what is listed', async () => {
  const {body, badge, counts, restore} = await mount([decision, step, finished]);
  try {
    const cards = body.querySelectorAll('li.quest');
    assert.deepEqual(cards.map(c => c.querySelector('.quest-kind').textContent), ['Decision', 'To-do · Account', 'Goal']);
    assert.deepEqual(cards.map(c => c.querySelector('.rank-badge').textContent), ['?', '☐', '✓']);
    assert.equal(cards[2].querySelector('.rank-badge').getAttribute('aria-label'), 'Done');
    assert.equal(cards[1].querySelector('.quest-title').textContent, 'Connect GitHub', 'the kind line says To-do, so the title does not');
    assert.equal(cards[2].querySelector('.quest-title').textContent, 'Goal done: Launch the shop');
    assert.equal(cards[2].querySelector('.quest-summary').textContent, 'Done.');
    assert.deepEqual(body.querySelectorAll('h3.rank-heading').map(h => h.textContent), ['Needs you'], 'one band for what the badge counts (plan 11.16)');
    assert.equal(body.querySelector('.quest-tabs').getAttribute('aria-label'), 'Inbox', 'the Active and Done tabs name the panel the dock calls Inbox');
    assert.equal(badge.textContent, '2');
    assert.equal(badge.getAttribute('aria-label'), '2 things need you');
    assert.deepEqual(counts, [2], 'the panel reports the same number it shows');
    assert.equal(body.querySelectorAll('ul.quest-list')[0].children.length, 2, 'two cards above the fold, in the one Needs you band');
  } finally { restore(); }
});

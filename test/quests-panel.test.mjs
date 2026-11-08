import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  splitSteps, stepParts, summaryOf, progressOf, textParts, splitNeeds, needsYouCount, kindLabel, needsOwner, groupQuests, linkParts, linksIn,
  createQuestsPanel,
} from '../public/quests-panel.js';

test('inline numbered steps split out of the intro, in order', () => {
  const text = 'Follow checklist X. All files are drafts. 1. In the app, check the handle. 2. Create the account. 3. Paste the key here.';
  assert.deepEqual(splitSteps(text), {
    intro: 'Follow checklist X. All files are drafts.',
    steps: ['In the app, check the handle.', 'Create the account.', 'Paste the key here.'],
  });
});

test('numbered steps on their own lines split the same way', () => {
  assert.deepEqual(splitSteps('Sign in first.\n1. Open the site\n2. Sign in'), {intro: 'Sign in first.', steps: ['Open the site', 'Sign in']});
});

test('a version number or a count is not a step', () => {
  assert.deepEqual(splitSteps('Calendar v2.1 is ready, 15/17 checks passed.'), {intro: 'Calendar v2.1 is ready, 15/17 checks passed.', steps: []});
});

test('text with no numbered items is one intro and no steps', () => {
  assert.deepEqual(splitSteps('Publish the notice.'), {intro: 'Publish the notice.', steps: []});
  assert.deepEqual(splitSteps(''), {intro: '', steps: []});
  assert.deepEqual(splitSteps(undefined), {intro: '', steps: []});
});

test('steps must count up from 1', () => {
  assert.deepEqual(splitSteps('Do it. 2. Second 3. Third'), {intro: 'Do it. 2. Second 3. Third', steps: []});
});

test('a list that starts at 0 is steps, and the intro stops before the 0', () => {
  assert.deepEqual(splitSteps('Everything is drafted. Nothing has been listed. 0. Get the account live e8603d80. 1. Add keys.'), {
    intro: 'Everything is drafted. Nothing has been listed.',
    steps: ['Get the account live e8603d80.', 'Add keys.'],
  });
  assert.deepEqual(splitSteps('Go. 0. A 1. B'), {intro: 'Go.', steps: ['A', 'B']});
});

test('the 1) style is a step too', () => {
  assert.deepEqual(splitSteps('Plan it. 1) Open 2) Sign in'), {intro: 'Plan it.', steps: ['Open', 'Sign in']});
});

test('with no numbers, lines starting with - or • are steps; a line that wraps joins its step', () => {
  assert.deepEqual(splitSteps('Before you start.\n- Open the app\n  Sign in there\n• Pay'), {
    intro: 'Before you start.',
    steps: ['Open the app Sign in there', 'Pay'],
  });
});

test('a hyphen inside a word is not a bullet', () => {
  assert.deepEqual(splitSteps('A study-pack, with e-mail.'), {intro: 'A study-pack, with e-mail.', steps: []});
});

test('a step splits at its first sentence or its colon, and a long one is cut', () => {
  assert.deepEqual(stepParts('Add the Resend keys in Vercel and redeploy. Then sign up.'), {
    title: 'Add the Resend keys in Vercel and redeploy', body: 'Then sign up.',
  });
  assert.deepEqual(stepParts('Weeks 1-2: have a lawyer check the pages.'), {title: 'Weeks 1-2', body: 'have a lawyer check the pages.'});
  assert.deepEqual(stepParts('Short step'), {title: 'Short step', body: ''});
  assert.equal(stepParts('a'.repeat(100)).title.length, 80);
});

test('the card summary is the first sentence of the intro, cut to about 110 characters', () => {
  assert.equal(summaryOf('Everything is drafted. Nothing has been listed. 0. Get it live.'), 'Everything is drafted.');
  assert.equal(summaryOf('Costs $7.50 a day. More.'), 'Costs $7.50 a day.');
  const long = summaryOf('x'.repeat(200));
  assert.equal(long.length, 110);
  assert.ok(long.endsWith('…'));
  assert.equal(summaryOf('1. Only steps'), '');
  assert.equal(summaryOf(''), '');
});

test('progress counts ticked steps, and ticks past the last step do not count', () => {
  assert.deepEqual(progressOf('Intro. 1. a 2. b 3. c', [0, 2]), {done: 2, total: 3});
  assert.deepEqual(progressOf('Intro. 1. a 2. b', [0, 1, 7, -1]), {done: 2, total: 2});
  assert.deepEqual(progressOf('Intro. 1. a 2. b', [0, 0]), {done: 1, total: 2});
  assert.deepEqual(progressOf('Just text.', [0]), {done: 0, total: 0});
});

test('step text splits into plain text, artifact chips and highlights', () => {
  assert.deepEqual(textParts('Use e8603d80 for $75 in 60-day runs.'), [
    {text: 'Use '}, {id: 'e8603d80'}, {text: ' for '}, {hl: '$75'}, {text: ' in '}, {hl: '60-day'}, {text: ' runs.'},
  ]);
  assert.deepEqual(textParts('See 1B2C3D4E-0000-4111-8222-333344445555.'), [
    {text: 'See '}, {id: '1b2c3d4e-0000-4111-8222-333344445555'}, {text: '.'},
  ]);
  assert.deepEqual(textParts('20261029 deadbeef 15/17'), [{text: '20261029 deadbeef 15/17'}]);
  assert.deepEqual(textParts('$25/h minimum, 10 h/week limit'), [{hl: '$25/h'}, {text: ' minimum, '}, {hl: '10 h/week'}, {text: ' limit'}]);
  assert.deepEqual(textParts('Weeks 1-2: review'), [{hl: 'Weeks 1-2'}, {text: ': review'}]);
  assert.deepEqual(textParts('Costs $75.'), [{text: 'Costs '}, {hl: '$75'}, {text: '.'}]);
  assert.deepEqual(textParts(''), []);
});

test('quests the owner does not need are split out; a missing needsYou counts as needing the owner', () => {
  const list = [{id: 'a', needsYou: true}, {id: 'b'}, {id: 'c', needsYou: false}];
  assert.deepEqual(splitNeeds(list), {needs: [list[0], list[1]], handled: [list[2]]});
  assert.deepEqual(splitNeeds(undefined), {needs: [], handled: []});
  assert.equal(needsOwner({}), true);
  assert.equal(needsOwner({needsYou: false}), false);
});

test('only needing quests are grouped and counted, whatever their rank; handled ones never reach a group or the badge', () => {
  const list = [{rank: 'S', needsYou: true}, {rank: 'A', needsYou: false}, {rank: 'B'}, {rank: 'C', needsYou: false}];
  assert.deepEqual(groupQuests(splitNeeds(list).needs).map(([rank]) => rank), ['S', 'B']);
  assert.equal(needsYouCount(list), 2, 'a to-do that blocks nothing (rank B) needs the owner too, so it counts');
  assert.equal(needsYouCount(list), splitNeeds(list).needs.length, 'the count is the cards above the fold');
  assert.equal(needsYouCount(undefined), 0);
});

test('owner step kinds read as plain labels; unknown or inherited names read as none', () => {
  assert.equal(kindLabel('account'), 'Account');
  assert.equal(kindLabel('physical'), 'In person');
  assert.equal(kindLabel('design'), 'Design');
  assert.equal(kindLabel('constructor'), '');
  assert.equal(kindLabel(undefined), '');
});

test('web addresses in a step become links, without trailing punctuation, http and https only', () => {
  const step = 'Open https://vercel.com/sso/session-requests/fiDadaX0 (it works once). Then visit https://github.com/settings/tokens. Not ftp://x.y';
  assert.deepEqual(linksIn(step), ['https://vercel.com/sso/session-requests/fiDadaX0', 'https://github.com/settings/tokens']);
  const parts = linkParts('See https://a.example/x, then done.');
  assert.deepEqual(parts, [{text: 'See '}, {url: 'https://a.example/x'}, {text: ', then done.'}]);
  assert.deepEqual(linksIn('no links here'), []);
});

test('a long address reads as its site and the start of its path', async () => {
  const {shortUrl} = await import('../public/quests-panel.js');
  assert.equal(shortUrl('https://vercel.com/sso/session-requests/fiDadaX0XtzLMA1WjJS2SIlH359fC4bP'), 'vercel.com/sso/session-request…');
  assert.equal(shortUrl('https://www.github.com/settings/tokens/'), 'github.com/settings/tokens');
});

test('a page opened after a wait reports whether it opened; the desktop app always counts as opened', async () => {
  const {openPage} = await import('../public/quests-panel.js');
  const tab = {opener: 'x'};
  assert.equal(openPage('https://a.example', {navigator: {userAgent: 'Chrome'}, open: () => tab}), true);
  assert.equal(tab.opener, null, 'the new tab cannot reach back into Clowder');
  assert.equal(openPage('https://a.example', {navigator: {userAgent: 'Chrome'}, open: () => null}), false, 'a blocked popup is reported');
  assert.equal(openPage('https://a.example', {navigator: {userAgent: 'Mozilla/5.0 Clowder Electron/45'}, open: () => null}), true);
});

test('a chat message is escaped, **bold** turns bold, and an address becomes a short link that opens in a new tab', async () => {
  const {chatHtml} = await import('../public/quests-panel.js');
  assert.equal(chatHtml('Log in as **@example_cafe** <b>now</b>'), 'Log in as <strong>@example_cafe</strong> &lt;b&gt;now&lt;/b&gt;');
  assert.equal(chatHtml('Open https://developers.facebook.com/apps/.'), 'Open <a class="chat-link" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">developers.facebook.com/apps ↗</a>.');
  assert.ok(!chatHtml('javascript:alert(1) "x"').includes('<a'), 'only http and https become links');
  assert.equal(chatHtml('a & b'), 'a &amp; b');
  assert.equal(chatHtml('see https://ollama'), 'see https://ollama', 'a cut-short address stays text');
});

// A small stand-in for the browser DOM: enough for the panel to build its cards and its Details sheet in Node.
// Selectors are a tag, classes or both ("li.quest", ".quest-primary"). A dialog's close event fires at once.
class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, ownText: ''});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return true; }
  click() { this.onclick?.({type: 'click', currentTarget: this}); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) { const [tag, ...classes] = selector.split('.'), own = this.className.split(/\s+/); return (!tag || this.tagName === tag.toUpperCase()) && classes.every(c => own.includes(c)); }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
async function withDocument(fn) {
  const saved = globalThis.document, doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  globalThis.document = doc;
  try { return await fn(doc); } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
}
// The panel over a fixed quest list, as GET /api/quests returns it. The sheet is the dialog the panel hangs off the body.
async function mountQuests(doc, quests, options = {}) {
  const panel = doc.createElement('section'), body = doc.createElement('div'), status = doc.createElement('p'), badge = doc.createElement('span');
  panel.append(body, status, badge);doc.body.append(panel);
  const fetchImpl = async url => ({ok: true, json: async () => (url === '/api/artifacts' ? {artifacts: []} : quests)});
  const quest = createQuestsPanel({panel, body, status, badge, fetchImpl, ...options});
  await quest.refresh();
  return {body, sheet: doc.body.querySelector('dialog.quest-sheet')};
}
// An approval quest as src/quests.ts builds it: the title is the question's first sentence, the detail says who waits.
const QUESTION = 'May the town continue by drafting a sample offer? This approval permits only a draft inside this chat.';
const approvalQuest = {id: 'approval:a1', rank: 'S', title: 'May the town continue by drafting a sample offer', detail: 'Mayor is blocked until you answer.', at: '2026-11-06T18:00:00.000Z', source: {kind: 'approval', id: 'a1'}, action: {label: 'Answer', panel: 'chat', cat: 'mayor'}, needsYou: true};
const goalQuest = {id: 'goal:g1', rank: 'A', title: 'Waiting on you: Launch the shop', detail: 'Mark the owner steps done and the goal resumes.', at: '2026-11-06T17:00:00.000Z', source: {kind: 'goal', id: 'g1'}, action: {label: 'Open goal', panel: 'projects'}, needsYou: true};

test('an approval’s Details sheet shows the whole question, and Answer closes the sheet before the decision opens', () => withDocument(async doc => {
  const seen = [];
  const {body, sheet} = await mountQuests(doc, [approvalQuest], {questionOf: id => (id === 'a1' ? QUESTION : undefined), onAction: q => seen.push([q.id, sheet.open])});
  body.querySelector('li.quest').querySelector('button.quest-more').click();
  assert.equal(sheet.open, true);
  assert.equal(sheet.querySelector('.quest-question').textContent, QUESTION, 'the full question, not only its first sentence');
  assert.equal(sheet.querySelector('.quest-callout').textContent, QUESTION + 'Mayor is blocked until you answer.', 'then who waits on it');
  const answer = sheet.querySelector('.quest-primary');
  assert.equal(answer.textContent, 'Answer');
  answer.click();
  assert.equal(sheet.open, false, 'the sheet is closed');
  assert.deepEqual(seen, [['approval:a1', false]], 'the decision opens once, with no sheet over it');
}));

test('Answer on the card opens the decision once, and every action from a sheet closes the sheet first', () => withDocument(async doc => {
  const seen = [];
  const {body, sheet} = await mountQuests(doc, [approvalQuest, goalQuest], {onAction: q => seen.push([q.id, sheet.open])});
  const [approval, goal] = body.querySelectorAll('li.quest');
  approval.querySelector('button.quest-primary').click();
  assert.deepEqual(seen, [['approval:a1', false]]);
  goal.querySelector('button.quest-more').click();
  assert.equal(sheet.open, true);
  sheet.querySelector('.quest-primary').click();
  assert.equal(sheet.open, false);
  assert.deepEqual(seen.at(-1), ['goal:g1', false], 'Open goal shows the panel, not a sheet over it');
}));

test('a decision answered in the meantime has no question to show: its sheet keeps the detail line', () => withDocument(async doc => {
  const {body, sheet} = await mountQuests(doc, [approvalQuest], {questionOf: () => undefined});
  body.querySelector('li.quest').querySelector('button.quest-more').click();
  assert.equal(sheet.querySelector('.quest-question'), null);
  assert.equal(sheet.querySelector('.quest-callout').textContent, 'Mayor is blocked until you answer.');
}));

test('app.js opens an approval quest’s decision dialog, falls back to the chat when it is gone, and gives the panel the full question', () => {
  // Line endings are normalised: a Windows checkout has CRLF, and the patterns below expect \n.
  const app = ['app.js', 'decision-strip.js'].map(f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')).join('\n').replace(/\r\n/g, '\n');
  assert.match(app, /function openQuest\(quest\)\{const \{panel,cat\}=quest\.action;if\(quest\.source\?\.kind==='approval'&&openApprovalSheet\(quest\.source\.id\)\)return;/);
  assert.match(app, /function openApprovalSheet\(id\)\{\n[^\n]*\n  if\(!a\)return false;[\s\S]*?showModal\(\);\n  return true;\n\}/);
  assert.match(app, /createQuestsPanel\(\{[^\n]*questionOf:id=>state\?\.approvals\.find\(a=>a\.id===id\)\?\.question/);
});

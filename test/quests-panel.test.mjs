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
  replaceWith(node) { const parent = this.parentNode; parent.children[parent.children.indexOf(this)] = node; node.parentNode = parent; this.parentNode = null; }
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
  doc.createElementNS = (_, tag) => new FakeNode(tag, doc); // the empty state's picture
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
  assert.match(app, /function openApprovalSheet\(id\)\{\n[^\n]*\n\s*if\(!a\)return false;[\s\S]*?showModal\(\);\n\s*return true;\n\s*\}/);
  assert.match(app, /createQuestsPanel\(\{[^\n]*questionOf:id=>state\?\.approvals\.find\(a=>a\.id===id\)\?\.question/);
});

// ---- Plan 11.16: the Inbox in bands ----
// N4's seeded state as src/quests.ts (11.2) serves it: one to-do that holds a goal (the goal row folds), one Payment to-do (an approved,
// unpaid purchase), one connect to-do. Plus a failed request (Trouble), a quiet running request and a finished one. Times are noon UTC.
const NOON = '2026-11-09T12:00:00.000Z';
const heldStep = {id: 'owner-step:s1', rank: 'A', title: 'Owner step: Sign the pop-up lease', detail: 'Sign it at the landlord’s office.', at: NOON, source: {kind: 'owner-step', id: 's1'}, action: {label: 'Mark done', panel: 'projects'}, needsYou: true, band: 'needs', holds: 'Open the cat cafe pop-up'};
const heldGoal = {id: 'goal:g1', rank: 'A', title: 'Waiting on you: Open the cat cafe pop-up', detail: 'Waiting on you: Sign the pop-up lease', at: NOON, source: {kind: 'goal', id: 'g1'}, action: {label: 'Open goal', panel: 'projects'}, needsYou: false, band: 'handled'};
const payment = (endsAt = new Date(Date.now() + 60 * 3_600_000).toISOString()) => ({id: 'purchase:p1', rank: 'S', title: 'Pay Namecheap 12.00 USD', detail: 'Approved. Pay the vendor, then tap Mark paid.', at: NOON, source: {kind: 'purchase', id: 'p1'}, action: {label: 'Mark paid', panel: 'moonvault'}, needsYou: true, band: 'needs', payment: {vendor: 'Namecheap', url: 'https://www.namecheap.com/domains/', amount: '12.00 USD', endsAt}});
const connectStep = {id: 'owner-step:s2', rank: 'B', title: 'Owner step: Connect Notion', detail: 'The Scribe files notes there.', at: NOON, source: {kind: 'owner-step', id: 's2'}, action: {label: 'Connect Notion', panel: 'projects'}, needsYou: true, band: 'needs', connect: {id: 'notion', name: 'Notion'}};
const failed = {id: 'project:t1', rank: 'B', title: 'Book a stall at the fair', detail: '1 of 1 tasks failed.', at: NOON, source: {kind: 'project', id: 't1'}, action: {label: 'Open project', panel: 'projects', project: 't1'}, needsYou: false, band: 'trouble'};
const quietRun = {id: 'project:t2', rank: 'D', title: 'Draft the fair flyer', detail: 'No update for over 30 minutes.', at: NOON, source: {kind: 'project', id: 't2'}, action: {label: 'Open project', panel: 'projects', project: 't2'}, needsYou: false, band: 'handled'};
const finishedRun = {id: 'project:t3', rank: 'F', title: 'Price the cat toys', detail: 'Turned in.', at: NOON, source: {kind: 'project', id: 't3'}, action: {label: 'Open project', panel: 'projects', project: 't3'}, needsYou: false, band: 'handled'};
const seeded = () => [payment(), heldStep, heldGoal, connectStep, failed, quietRun, finishedRun];

// The panel over a small server: routes by "METHOD path" answer {status, body} (or a body, status 200); anything else is a 404.
async function mountBands(doc, routes, options = {}) {
  const panel = doc.createElement('section'), body = doc.createElement('div'), status = doc.createElement('p'), badge = doc.createElement('span');
  panel.append(body, status, badge); doc.body.append(panel);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET', payload = init.body ? JSON.parse(init.body) : null;
    calls.push([method, url, payload]);
    const route = routes[`${method} ${url}`] ?? (url === '/api/artifacts' ? () => ({artifacts: []}) : null);
    const out = route ? route(payload) : {status: 404, body: {error: 'Not here'}};
    const r = out && typeof out.status === 'number' && 'body' in out ? out : {status: 200, body: out};
    return {ok: r.status < 400, status: r.status, json: async () => r.body};
  };
  const api = createQuestsPanel({panel, body, status, badge, fetchImpl, ...options});
  await api.refresh();
  const card = id => body.querySelectorAll('li').find(n => n.getAttribute('data-id') === id);
  const buttons = node => node.querySelectorAll('button').map(b => b.textContent);
  return {api, body, status, badge, calls, card, buttons, sheet: doc.body.querySelectorAll('dialog.quest-sheet').at(-1)};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const bandOrder = body => body.querySelector('div.quest-groups').children.map(n => n.querySelector('h3')?.textContent ?? n.querySelector('summary')?.textContent);

test('11.16: sections in order Needs you, Trouble, the cats’ quiet work and what finished, and the badge counts the 3 owner actions (baseline 4)', () => withDocument(async doc => {
  const m = await mountBands(doc, {'GET /api/quests': () => seeded()});
  assert.deepEqual(bandOrder(m.body), ['Needs you', 'Trouble', 'Your cats are handling these (2)', 'Recently finished (1)']);
  assert.equal(m.badge.textContent, '3', 'the to-do, the payment and the connect step; the goal the to-do holds folds');
  const [needs, trouble] = m.body.querySelectorAll('ul.quest-list');
  assert.deepEqual(needs.children.map(li => li.getAttribute('data-id')), ['purchase:p1', 'owner-step:s1', 'owner-step:s2'], 'the cards above the fold are the count');
  assert.deepEqual(trouble.children.map(li => li.getAttribute('data-id')), ['project:t1']);
  const finished = m.body.querySelectorAll('details.quest-handled')[1];
  assert.equal(finished.getAttribute('data-band'), 'finished');
  assert.deepEqual(finished.querySelectorAll('li').map(li => li.getAttribute('data-id')), ['project:t3'], 'a finished request no longer sits under “Your cats are handling these” (F13)');
}));

test('11.16: a to-do names the goal it holds, as a link to that goal’s thread when the folded goal row gives its id (N4)', () => withDocument(async doc => {
  const opened = [];
  const m = await mountBands(doc, {'GET /api/quests': () => seeded()}, {openThread: t => opened.push(t)});
  const line = m.card('owner-step:s1').querySelector('.quest-for');
  assert.equal(line.textContent, 'Holds goal: Open the cat cafe pop-up');
  assert.equal(line.tagName, 'A');
  line.onclick({preventDefault() {}});
  assert.deepEqual(opened, [{kind: 'goal', id: 'g1'}]);
  // Without a goal row to read the id from, the line is plain text.
  const alone = await mountBands(doc, {'GET /api/quests': () => [heldStep]}, {openThread: t => opened.push(t)});
  assert.equal(alone.card('owner-step:s1').querySelector('.quest-for').tagName, 'P');
  assert.equal(alone.card('owner-step:s1').querySelector('.quest-for').textContent, 'Holds goal: Open the cat cafe pop-up');
}));

test('11.16: a connect to-do has Connect as its only main button, and Remove reads Not now, on the card and in its sheet (N5, baseline 4 buttons)', () => withDocument(async doc => {
  const m = await mountBands(doc, {'GET /api/quests': () => seeded()});
  const card = m.card('owner-step:s2');
  // 11.23 adds Remind me tomorrow to every to-do, on the card and in the sheet.
  assert.deepEqual(m.buttons(card), ['Connect Notion', 'Remind me tomorrow', 'Not now', 'Details']);
  assert.equal(card.querySelector('button.quest-primary'), null, 'no Mark done');
  card.querySelector('button.quest-more').click();
  assert.deepEqual(m.buttons(m.sheet.querySelector('.quest-sheet-foot')), ['Not now', 'Remind me tomorrow', 'Connect Notion']);
  assert.deepEqual(m.buttons(m.card('owner-step:s1')), ['Mark done', 'Remind me tomorrow', 'Remove', 'Details'], 'any other to-do keeps Mark done and Remove');
}));

test('11.16: an approved purchase is a Payment card: amount, vendor link, when the approval ends, and Mark paid records it from the sheet (N1)', () => withDocument(async doc => {
  let list = seeded();
  const m = await mountBands(doc, {'GET /api/quests': () => list, 'POST /api/purchases/p1/paid': () => { list = list.filter(q => q.id !== 'purchase:p1'); return {purchase: {id: 'p1', status: 'paid'}}; }});
  const card = m.card('purchase:p1');
  assert.equal(card.querySelector('.quest-kind').textContent, 'To-do · Payment');
  assert.equal(card.querySelector('.quest-title').textContent, 'Pay Namecheap 12.00 USD');
  assert.equal(card.querySelector('.quest-ends').textContent, 'Approval ends in 2 days');
  const link = card.querySelector('a.quest-open');
  assert.equal(link.textContent, 'Pay on namecheap.com ↗');
  assert.equal(link.getAttribute('href'), 'https://www.namecheap.com/domains/');
  assert.deepEqual(m.buttons(card), ['Mark paid'], 'one main button and nothing else');
  card.querySelector('button.quest-primary').click();
  assert.equal(m.sheet.open, true, 'Mark paid opens the sheet, where the amount is');
  assert.equal(m.sheet.querySelector('.quest-amount').getAttribute('value'), '12.00', 'filled with the approved amount');
  assert.equal(m.sheet.querySelector('label.quest-amount-label').ownText, 'Amount you paid, in USD');
  m.sheet.querySelector('.quest-amount').value = '11.50';
  m.sheet.querySelector('.quest-sheet-foot').querySelector('button.quest-primary').click();
  await settle(); await settle();
  assert.deepEqual(m.calls.find(c => c[0] === 'POST'), ['POST', '/api/purchases/p1/paid', {amount: '11.50'}]);
  assert.equal(m.sheet.open, false);
  assert.equal(m.card('purchase:p1'), undefined, 'the paid purchase leaves Needs you');
  assert.equal(m.status.textContent, 'Recorded as paid: Namecheap.');
  assert.equal(m.badge.textContent, '2');
}));

test('11.16: on a phone without a passkey step-up, Mark paid opens the passkey page where one is offered, else offers Continue on your computer (N1)', () => withDocument(async doc => {
  const refused = {'GET /api/quests': () => [payment()], 'POST /api/purchases/p1/paid': () => ({status: 403, body: {error: 'Mark purchases paid on the host computer.'}}), 'POST /api/quests/purchase%3Ap1/handoff': () => ({ok: true})};
  // The stand-in DOM does not read an input's value from its attribute, as a browser does: tap() fills it first.
  const tap = page => { page.card('purchase:p1').querySelector('button.quest-primary').click(); const box = page.sheet.querySelector('.quest-amount'); box.value = box.getAttribute('value'); page.sheet.querySelector('.quest-sheet-foot').querySelector('button.quest-primary').click(); };
  const m = await mountBands(doc, refused, {onPhone: () => true});
  tap(m);
  await settle(); await settle();
  assert.equal(m.sheet.open, false);
  assert.deepEqual(m.buttons(m.card('purchase:p1')), ['Mark paid', 'Continue on your computer']);
  assert.equal(m.status.textContent, 'This phone cannot mark money paid. Continue on your computer sends it there.');
  m.card('purchase:p1').querySelectorAll('button')[1].click();
  await settle(); await settle();
  assert.ok(m.calls.some(c => c[0] === 'POST' && c[1] === '/api/quests/purchase%3Ap1/handoff'));
  // A phone that offers a passkey (the ☰ Passkey entry is shown) opens it instead.
  const entry = doc.createElement('button');
  let taps = 0;
  entry.click = () => { taps++; };
  doc.getElementById = id => (id === 'step-up-open' ? entry : null);
  const p = await mountBands(doc, refused, {onPhone: () => true});
  tap(p);
  await settle(); await settle();
  assert.equal(taps, 1);
  assert.equal(p.status.textContent, 'Confirm it’s you with your passkey, then tap Mark paid again.');
  assert.deepEqual(p.buttons(p.card('purchase:p1')), ['Mark paid'], 'no hand-off while a passkey can do it here');
}));

test('11.16: a failed request sits under Trouble, not counted, with Retry; Retry runs it again inside the same request (N6)', () => withDocument(async doc => {
  const m = await mountBands(doc, {'GET /api/quests': () => [failed], 'POST /api/tasks/t1/retry': () => ({task: 't9'})});
  assert.deepEqual(bandOrder(m.body), [undefined, 'Trouble'], 'the empty Needs you line, then Trouble');
  assert.equal(m.body.querySelector('div.empty-state').textContent, 'Nothing needs you.See the diary');
  assert.equal(m.badge.textContent, '0');
  const card = m.card('project:t1');
  assert.deepEqual(m.buttons(card), ['Retry', 'Open project', 'Hide', 'Details']);
  assert.equal(card.querySelector('button.quest-primary').textContent, 'Retry', 'Retry is the main button');
  card.querySelector('button.quest-primary').click();
  await settle(); await settle();
  assert.deepEqual(m.calls.find(c => c[0] === 'POST'), ['POST', '/api/tasks/t1/retry', {}]);
  assert.equal(m.status.textContent, 'Running it again, inside the same request.');
}));

test('11.16: Done rows say where the owner answered: this computer, your phone, Telegram', () => withDocument(async doc => {
  const {answeredFrom} = await import('../public/quests-panel.js');
  assert.deepEqual(['host', 'phone-1', 'telegram', 'discord', undefined].map(d => answeredFrom(d)), ['From this computer', 'From your phone', 'From Telegram', 'From Discord', '']);
  assert.equal(answeredFrom('host', {phone: true}), 'From your computer', 'on the phone the host is “your computer”');
  const done = [
    {id: 'e1', rank: 'F', kind: 'approval', title: 'May the Scribe push', detail: 'Approved', at: NOON, device: 'host'},
    {id: 'e2', rank: 'F', kind: 'purchase', title: 'Paid Namecheap', detail: '12.00 USD, paid by the owner', at: NOON, device: 'phone-1'},
    {id: 'e3', rank: 'F', kind: 'connect', title: 'Connect step done: Notion', detail: 'Marked done.', at: NOON},
  ];
  const m = await mountBands(doc, {'GET /api/quests': () => [], 'GET /api/quests/done': () => done});
  m.body.querySelectorAll('button.quest-tab')[1].click();
  await settle(); await settle();
  const rows = m.body.querySelectorAll('li.quest');
  assert.deepEqual(rows.map(r => r.querySelector('.quest-from')?.textContent ?? null), ['From this computer', 'From your phone', null]);
  assert.deepEqual(rows.map(r => r.querySelector('.quest-kind').textContent), ['Decision', 'Payment', 'To-do'], 'a connect is a to-do, not a Notice');
}));

test('11.16: openItem opens a card’s Details for #item= links, a decision opens its own card, and an unknown id says false', () => withDocument(async doc => {
  const seen = [];
  const m = await mountBands(doc, {'GET /api/quests': () => [heldStep, approvalQuest]}, {onAction: q => seen.push(q.id)});
  assert.equal(await m.api.openItem('owner-step:s1'), true);
  assert.equal(m.sheet.open, true);
  assert.equal(m.sheet.querySelector('.quest-sheet-title').textContent, 'To-do: Sign the pop-up lease');
  m.sheet.close();
  assert.equal(await m.api.openItem('approval:a1'), true);
  assert.deepEqual(seen, ['approval:a1']);
  assert.equal(await m.api.openItem('owner-step:gone'), false);
}));

test('11.16: the load error names the Inbox in plain words, and a host that does not answer is said so, not “Failed to fetch”', () => withDocument(async doc => {
  const panel = doc.createElement('section'), body = doc.createElement('div'), status = doc.createElement('p'), badge = doc.createElement('span');
  panel.append(body, status, badge); doc.body.append(panel);
  let fail = () => Promise.reject(new TypeError('Failed to fetch'));
  const api = createQuestsPanel({panel, body, status, badge, fetchImpl: () => fail()});
  await api.refresh();
  assert.equal(status.textContent, 'The Inbox could not load. Clowder is not answering.');
  fail = async () => ({ok: false, status: 500, json: async () => ({error: 'The journal is busy.'})});
  await api.refresh();
  assert.equal(status.textContent, 'The Inbox could not load. The journal is busy.');
}));

test('11.16: Payment words: when the approval ends, rounded down, from noon UTC; no coin or season copy', async () => {
  const {approvalEnds, nounOf, BANDS} = await import('../public/plain-words.js');
  const noon = Date.parse(NOON), at = hours => new Date(noon + hours * 3_600_000).toISOString();
  assert.deepEqual([72, 60, 47.9, 5, 0.5, 0.001, -1].map(h => approvalEnds(at(h), noon)),
    ['Approval ends in 3 days', 'Approval ends in 2 days', 'Approval ends in 47 h', 'Approval ends in 5 h', 'Approval ends in 30 min', 'Approval ends in 1 min', 'Approval has ended']);
  assert.equal(approvalEnds(null, noon), '', 'no end, no line');
  assert.equal(nounOf(payment()), 'To-do', 'an approved purchase is the owner’s to pay');
  assert.equal(nounOf({source: {kind: 'purchase'}, rank: 'S'}), 'Decision', 'a pending one is still a Decision');
  assert.deepEqual(Object.values(BANDS), ['Needs you', 'Trouble', 'Your cats are handling these', 'Recently finished']);
  assert.ok(!/coin|season/i.test(JSON.stringify(BANDS)), 'no coin or season copy');
});

// ---- Plan 11.23: to-do cards say what happens next and when it is due, put off to tomorrow, and tick on the server ----
// A to-do as src/quests.ts serves it after 11.9 and 11.18: its request, its due date and its steps, one line each. `after` is the line
// the cat wrote for "After you mark it done" (the quest list does not carry it yet: see the row's report). The due date is far ahead so
// the card reads the same on any day; dueLabel's words are checked against noon UTC below.
const dueStep = {id: 'owner-step:s3', rank: 'B', title: 'Owner step: Renew the shop domain', detail: 'Renew it before it lapses.\n1. Open the registrar\n2. Pay the renewal', at: NOON, source: {kind: 'owner-step', id: 's3'}, stepKind: 'payment', action: {label: 'Mark done', panel: 'projects'}, needsYou: true, band: 'needs', due: '2099-11-13', request: {id: 't1', title: 'Keep the shop online'}, after: 'Scholar saves the receipt to Notion'};
const paidFor = () => ({...payment(), request: {id: 't2', title: 'Buy the fair domain'}});

test('11.23: the line each step starts on is the line the server ticks; steps that share a line share it', async () => {
  const {stepLines} = await import('../public/quests-panel.js');
  assert.deepEqual(stepLines('Sign in first.\n1. Open the site\n2. Sign in'), [1, 2], 'the intro line is not a step');
  assert.deepEqual(stepLines('Before you start.\n- Open the app\n  Sign in there\n• Pay'), [1, 3], 'a wrapped line belongs to its step');
  assert.deepEqual(stepLines('Intro. 1. a 2. b'), [0, 0], 'inline steps share line 0');
  assert.deepEqual(stepLines('Just text.'), []);
  assert.deepEqual(splitSteps('Before you start.\n- Open the app\n  Sign in there\n• Pay'), {intro: 'Before you start.', steps: ['Open the app Sign in there', 'Pay']}, 'splitSteps reads as before');
});

test('11.23: a due date in words from noon UTC: today, tomorrow, the weekday within the week, else the date; past is "Was due"', async () => {
  const {dueLabel} = await import('../public/quests-panel.js');
  const noon = Date.parse(NOON); // Monday 9 November 2026
  assert.deepEqual(['2026-11-09', '2026-11-10', '2026-11-13', '2026-11-15', '2026-11-16', '2026-11-20', '2026-11-06'].map(d => dueLabel(d, noon)),
    ['Due today', 'Due tomorrow', 'Due Fri', 'Due Sun', 'Due 16 Nov', 'Due 20 Nov', 'Was due 6 Nov']);
  assert.deepEqual(['soon', '', undefined, '2026-11-9'].map(d => dueLabel(d, noon)), ['', '', '', ''], 'not a date, no line');
});

test('11.23: Remind me tomorrow is 9:00 tomorrow on this device’s clock', async () => {
  const {tomorrowAt} = await import('../public/quests-panel.js');
  assert.equal(tomorrowAt(Date.parse(NOON)), new Date(2026, 10, 10, 9, 0, 0, 0).toISOString());
  assert.equal(tomorrowAt(Date.parse('2026-11-30T12:00:00.000Z')), new Date(2026, 11, 1, 9).toISOString(), 'across the month');
});

test('11.23: Add to calendar is a one-day .ics event, built here, with its text escaped', async () => {
  const {icsOf} = await import('../public/quests-panel.js');
  const ics = icsOf({...dueStep, due: '2026-11-30', title: 'Owner step: Renew; the domain, now', detail: 'Line one\nLine two'}, Date.parse(NOON));
  assert.deepEqual(ics.split('\r\n'), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Clowder//Inbox//EN', 'BEGIN:VEVENT', 'UID:owner-step:s3@clowder', 'DTSTAMP:20261109T120000Z',
    'DTSTART;VALUE=DATE:20261130', 'DTEND;VALUE=DATE:20261201', 'SUMMARY:Renew\\; the domain\\, now', 'DESCRIPTION:Line one\\nLine two', 'END:VEVENT', 'END:VCALENDAR', '']);
  assert.equal(icsOf({...dueStep, due: undefined}), '', 'no due date, no event');
});

test('11.23: a to-do card reads kind and due, title, For: <request> linking to its thread, and what happens next; then Mark done, Remind me tomorrow, Remove, Details', () => withDocument(async doc => {
  const m = await mountBands(doc, {'GET /api/quests': () => [dueStep], 'GET /api/owner-steps/s3/ticks': () => ({ticks: []})});
  const card = m.card('owner-step:s3');
  assert.equal(card.querySelector('.quest-kind').textContent, 'To-do · Payment', 'the kind line reads as before');
  assert.equal(card.querySelector('.quest-head').querySelector('.quest-due').textContent, 'Due 13 Nov', 'the due date sits on line 1');
  assert.equal(card.querySelector('.quest-title').textContent, 'Renew the shop domain');
  const link = card.querySelector('a.quest-for');
  assert.equal(link.textContent, 'For: Keep the shop online');
  assert.equal(link.getAttribute('href'), '#thread=t1', 'as the decision card links its request');
  assert.ok(link.className.split(' ').includes('decision-for'), 'drawn as the decision card draws it');
  assert.equal(card.querySelector('.quest-after').textContent, 'After you mark it done: Scholar saves the receipt to Notion');
  assert.deepEqual(m.buttons(card), ['Mark done', 'Remind me tomorrow', 'Remove', 'Details']);
  // Its Details sheet says the same, and offers the .ics.
  card.querySelector('button.quest-more').click();
  const facts = m.sheet.querySelector('.quest-facts');
  assert.deepEqual(facts.children.map(n => n.textContent), ['Due 13 Nov', 'For: Keep the shop online', 'After you mark it done: Scholar saves the receipt to Notion', 'Add to calendar']);
  const ics = facts.querySelector('a.quest-ics');
  assert.equal(ics.getAttribute('download'), 'clowder-to-do.ics');
  assert.match(decodeURIComponent(ics.getAttribute('href').replace(/^data:text\/calendar;charset=utf-8,/, '')), /\r\nDTSTART;VALUE=DATE:20991113\r\nDTEND;VALUE=DATE:20991114\r\nSUMMARY:Renew the shop domain\r\n/);
  assert.deepEqual(m.buttons(m.sheet.querySelector('.quest-sheet-foot')), ['Remove', 'Remind me tomorrow', 'Mark done']);
  // A to-do with no due date has no due line and no Add to calendar; one with no request or `after` has no line for them.
  const bare = await mountBands(doc, {'GET /api/quests': () => [heldStep]});
  const plain = bare.card('owner-step:s1');
  assert.equal(plain.querySelector('.quest-head'), null);
  assert.equal(plain.querySelector('.quest-after'), null);
  assert.equal(plain.querySelectorAll('.quest-for').length, 1, 'only the goal it holds');
  plain.querySelector('button.quest-more').click();
  assert.equal(bare.sheet.querySelector('a.quest-ics'), null);
}));

test('11.23: a Payment card says when its approval ends on line 1 and names its request; it has no Remind me tomorrow', () => withDocument(async doc => {
  const m = await mountBands(doc, {'GET /api/quests': () => [paidFor()]});
  const card = m.card('purchase:p1');
  assert.equal(card.querySelector('.quest-head').querySelector('.quest-ends').textContent, 'Approval ends in 2 days');
  assert.equal(card.querySelectorAll('.quest-ends').length, 1, 'said once');
  assert.equal(card.querySelector('a.quest-for').getAttribute('href'), '#thread=t2');
  assert.deepEqual(m.buttons(card), ['Mark paid'], 'its 72 h approval could end while put off');
}));

test('11.23: on a phone-width screen a to-do card is kind and due, title and one main button; the rest is in Details', () => withDocument(async doc => {
  const m = await mountBands(doc, {'GET /api/quests': () => [paidFor(), dueStep, connectStep], 'GET /api/owner-steps/s3/ticks': () => ({ticks: []})}, {compact: () => true});
  const card = m.card('owner-step:s3');
  assert.equal(card.getAttribute('data-compact'), 'true');
  assert.deepEqual(card.querySelector('div.quest-main').children.map(n => n.className), ['quest-head', 'quest-title', 'quest-buttons'], 'no For, summary, After, tally or time on the card');
  assert.deepEqual(m.buttons(card), ['Mark done', 'Details']);
  assert.deepEqual(m.buttons(m.card('owner-step:s2')), ['Connect Notion', 'Details'], 'a connect to-do’s one main button is Connect');
  assert.deepEqual(m.buttons(m.card('purchase:p1')), ['Mark paid'], 'Mark paid opens the Payment’s sheet');
  assert.equal(m.card('purchase:p1').querySelector('a.quest-open'), null, 'the vendor link is in the sheet');
  card.querySelector('button.quest-more').click();
  assert.equal(m.sheet.querySelector('.quest-facts').querySelector('a.quest-for').textContent, 'For: Keep the shop online');
  assert.ok(m.sheet.querySelector('.quest-after'));
  assert.ok(m.sheet.querySelector('.quest-sheet-progress'), 'the tally is in the sheet');
  assert.deepEqual(m.buttons(m.sheet.querySelector('.quest-sheet-foot')), ['Remove', 'Remind me tomorrow', 'Mark done']);
}));

test('11.23: Remind me tomorrow hides the to-do until 9:00 tomorrow through the hide route, and the card leaves', () => withDocument(async doc => {
  const {tomorrowAt} = await import('../public/quests-panel.js');
  let list = [dueStep, heldStep];
  const m = await mountBands(doc, {'GET /api/quests': () => list, 'GET /api/owner-steps/s3/ticks': () => ({ticks: []}), 'POST /api/quests/owner-step%3As3/hide': () => { list = list.filter(q => q.id !== 'owner-step:s3'); return {ok: true}; }});
  assert.equal(m.badge.textContent, '2');
  m.card('owner-step:s3').querySelectorAll('button')[1].click();
  await settle(); await settle(); await settle();
  const [method, url, payload] = m.calls.find(c => c[0] === 'POST');
  assert.deepEqual([method, url, payload.at], ['POST', '/api/quests/owner-step%3As3/hide', NOON], 'at: the hide holds while the to-do is unchanged');
  assert.equal(payload.until, tomorrowAt());
  assert.equal(m.card('owner-step:s3'), undefined, 'the card leaves');
  assert.equal(m.badge.textContent, '1');
  assert.equal(m.status.textContent, 'It comes back tomorrow at 9:00.');
}));

test('11.23: ticks live on the server: read with the list, written one line at a time, and read back by a second device (N12)', () => withDocument(async doc => {
  let lines = [2]; // the server has line 2 ticked: step 2, "Pay the renewal"
  const routes = {
    'GET /api/quests': () => [dueStep],
    'GET /api/owner-steps/s3/ticks': () => ({ticks: lines}),
    'POST /api/owner-steps/s3/tick': ({line, done}) => { lines = done ? [...new Set([...lines, line])].sort() : lines.filter(n => n !== line); return {ok: true, ticks: lines}; },
  };
  const a = await mountBands(doc, routes);
  assert.equal(a.card('owner-step:s3').querySelector('.quest-tally').textContent, '1 of 2 done', 'read from the server');
  a.card('owner-step:s3').querySelector('button.quest-more').click();
  const boxes = a.sheet.querySelectorAll('input');
  assert.deepEqual(boxes.slice(0, 2).map(b => b.checked), [false, true]);
  boxes[0].checked = true; boxes[0].onchange();
  await settle(); await settle();
  assert.deepEqual(a.calls.find(c => c[0] === 'POST'), ['POST', '/api/owner-steps/s3/tick', {line: 1, done: true}], 'step 1 is line 1: the intro is line 0');
  assert.equal(a.sheet.querySelector('.quest-sheet-progress').textContent, '2 of 2 done');
  // Device B opens the Inbox afterwards and reads both ticks.
  const b = await mountBands(doc, routes);
  assert.equal(b.card('owner-step:s3').querySelector('.quest-tally').textContent, '2 of 2 done');
  // A refused tick is undone and said.
  const refused = await mountBands(doc, {...routes, 'POST /api/owner-steps/s3/tick': () => ({status: 403, body: {error: 'Owner steps are closed on the host computer or an owner device.'}})});
  refused.card('owner-step:s3').querySelector('button.quest-more').click();
  const box = refused.sheet.querySelectorAll('input')[0];
  box.checked = false; box.onchange();
  await settle(); await settle();
  assert.equal(box.checked, true, 'back as the server has it');
  assert.equal(refused.sheet.querySelector('.quest-sheet-msg').textContent, 'Could not save the tick. Owner steps are closed on the host computer or an owner device.');
}));

test('11.23: Needs you keeps the server’s order, so a to-do due soon is not pushed under an undated goal by its rank (11.18)', () => withDocument(async doc => {
  const goal = {...goalQuest, band: 'needs'};
  const m = await mountBands(doc, {'GET /api/quests': () => [dueStep, goal], 'GET /api/owner-steps/s3/ticks': () => ({ticks: []})});
  assert.deepEqual(m.body.querySelector('ul.quest-list').children.map(li => li.getAttribute('data-id')), ['owner-step:s3', 'goal:g1']);
}));

test('11.23: the panel keeps no ticks in localStorage and draws no coin or season copy', () => {
  const src = readFileSync(new URL('../public/quests-panel.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/quest-steps:/.test(src), 'ticks are not kept in this browser');
  assert.ok(!/\bcoins?\b|\bseasons?\b/i.test(src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')), 'no coin or season copy');
});

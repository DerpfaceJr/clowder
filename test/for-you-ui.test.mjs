import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {forYouCategory, forYouNoun, glyphOf, nounOf} from '../public/plain-words.js';
import {GLOSSARY, createQuestsPanel, needsYouCount} from '../public/quests-panel.js';
import {CATEGORIES, cardOf, dismissedLine, forYouLine, reasonsFor, relTime, sourceLink, validStatus} from '../public/for-you.js';
import {SEEN_KEY} from '../public/setup-hub.js';

// Plan 9.11: For you in the Inbox. A section under Decisions for the owner's Heads-ups and Suggestions (D16), with Open, Start, Dismiss (a
// reason menu and the 4 s Undo) and a settings sheet over GET/PUT /api/for-you. The pure helpers and the panel run in Node over a small fake
// DOM; the proof runs in a real browser on a scratch server (its own port, a temporary CAT_TOWN_DATA, made-up cards, nothing leaves).

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// A card as GET /api/quests gives it (src/quests.ts rank E): every subject and id here is made up.
const card = (n, category = 'reply', source = 'gmail', subject = `Lunch on Friday? ${n}`) => ({id: `suggestion:${category}:${source}:thr-${n}`, rank: 'E', title: subject,
  detail: 'For you. Start asks the Mayor to take it on.', at: '2026-11-09T09:00:00.000Z', source: {kind: 'suggestion', id: `${category}:${source}:thr-${n}`},
  action: {label: 'Start', panel: 'chat', cat: 'mayor'}, needsYou: false});
const decision = {id: 'approval:a1', rank: 'S', title: 'May the Scribe push to the repo', detail: 'Scribe is blocked until you answer.', at: '2026-11-09T08:00:00.000Z', source: {kind: 'approval', id: 'a1'}, action: {label: 'Answer', panel: 'chat', cat: 'scribe'}, needsYou: true};
const step = {id: 'owner-step:s1', rank: 'A', title: 'Owner step: Connect GitHub', detail: 'Sign in so the Scribe can push files.', at: '2026-11-09T07:00:00.000Z', source: {kind: 'owner-step', id: 's1'}, stepKind: 'account', action: {label: 'Mark done', panel: 'projects'}, needsYou: true};
const season = {id: 'season:x', rank: 'E', title: 'A sandbox request', detail: 'Waiting for a town decision.', at: null, source: {kind: 'capability', id: 'x'}, action: {label: 'Open coins', panel: 'season'}, needsYou: false};
const ON = {enabled: true, account: null, categories: {reply: true, prep: true, repeat: true, quiet: true}, guidance: '', reasonsClearedAt: null, triage: false, lastPassAt: null, error: null, intervalSeconds: 900};

test('D16’s two nouns: a goal gone quiet is a Heads-up, every other card a Suggestion, each with a glyph and a glossary line, never a grade', () => {
  assert.equal(forYouCategory(card(1)), 'reply');
  assert.equal(forYouCategory({source: {kind: 'goal', id: 'quiet:clowder:g1'}}), '', 'only For you cards have a category');
  assert.equal(nounOf(card(1, 'quiet', 'clowder')), 'Heads-up');
  for (const c of ['reply', 'prep', 'repeat', 'later-kind']) assert.equal(nounOf(card(1, c)), 'Suggestion', c);
  assert.equal(forYouNoun(card(1, 'quiet', 'clowder')), 'Heads-up');
  for (const noun of ['Heads-up', 'Suggestion']) assert.ok(GLOSSARY[noun]?.length > 10, `${noun} is in the glossary`);
  assert.equal(glyphOf(card(1, 'quiet', 'clowder')), 'ℹ');
  assert.equal(glyphOf(card(1)), '→');
  assert.ok(!/^[A-F]$/.test(glyphOf(card(1))));
});

test('a card’s parts come from its id, and its source opens where it lives: Gmail, the day in Calendar, or a thread here', () => {
  const c = cardOf(card(7, 'reply', 'gmail'));
  assert.deepEqual([c.quest, c.card, c.category, c.source, c.sourceId, c.subject, c.noun], ['suggestion:reply:gmail:thr-7', 'reply:gmail:thr-7', 'reply', 'gmail', 'thr-7', 'Lunch on Friday? 7', 'Suggestion']);
  assert.equal(cardOf({id: 'suggestion:prep:calendar:a:b', source: {kind: 'suggestion', id: 'prep:calendar:a:b'}}).sourceId, 'a:b', 'a source id may hold a colon');
  assert.equal(sourceLink(c).url, 'https://mail.google.com/mail/#all/thr-7');
  const day = new Date('2026-11-10T15:00:00.000Z');
  assert.equal(sourceLink({...c, source: 'calendar', category: 'prep', at: day.toISOString()}).url, `https://calendar.google.com/calendar/r/day/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`);
  assert.deepEqual(sourceLink({...c, source: 'clowder', category: 'repeat', sourceId: 't1'}).thread, {kind: 'request', id: 't1'});
  assert.deepEqual(sourceLink({...c, source: 'clowder', category: 'quiet', sourceId: 'g1'}).thread, {kind: 'goal', id: 'g1'});
  assert.equal(sourceLink({...c, source: 'drive'}), null, 'an unknown source has no link');
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  assert.equal(relTime('2026-11-09T09:00:00.000Z', now), '3 h ago');
  assert.equal(relTime('2026-11-09T15:00:00.000Z', now), 'in 3 h', 'a meeting still to come is not "just now"');
  assert.equal(relTime(null, now), 'time unknown');
});

test('Dismiss offers the reasons the server reads, "Not about this person" only where a card keeps one, and says what it did', () => {
  const words = c => reasonsFor(cardOf(c)).map(r => [r.label, r.reason]);
  assert.deepEqual(words(card(1, 'reply')), [['Less of this kind', 'category'], ['Not about this person', 'person'], ['Not this topic', 'topic'], ['Just this one', null]]);
  assert.deepEqual(words(card(1, 'prep', 'calendar')).map(([, r]) => r), ['category', 'person', 'topic', null]);
  assert.deepEqual(words(card(1, 'repeat', 'clowder')).map(([, r]) => r), ['category', 'topic', null], 'Clowder’s own cards have no person');
  assert.equal(dismissedLine('Lunch on Friday?', 'person'), 'Dismissed “Lunch on Friday?”. No more about this person.');
  assert.equal(dismissedLine('Lunch on Friday?', null), 'Dismissed “Lunch on Friday?”.');
  assert.deepEqual(Object.keys(CATEGORIES), ['reply', 'prep', 'repeat', 'quiet'], 'the settings list the four categories in order');
  assert.equal(forYouLine({enabled: false}).text, 'Off. Nothing is checked for you.');
  assert.equal(forYouLine({...ON, lastPassAt: Date.parse('2026-11-09T11:55:00.000Z')}, Date.parse('2026-11-09T12:00:00.000Z')).text, 'On. Checks every 15 min; last checked 5 min ago.');
  assert.equal(forYouLine({...ON, intervalSeconds: null}).tone, 'error');
  assert.equal(validStatus([card(1)]), null, 'a list is not a status');
});

// A small stand-in for the browser DOM (as in quests-panel.test.mjs), with createElementNS for the toast's icon.
class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, disabled: false, ownText: ''});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get id() { return this.attributes.id ?? ''; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return true; }
  click() { if (!this.disabled) this.onclick?.({type: 'click', currentTarget: this}); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) { const [tag, ...classes] = selector.split('.'), own = this.className.split(/\s+/); return (!tag || this.tagName === tag.toUpperCase()) && classes.every(c => own.includes(c)); }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
// The panel over a fixed list. routes[path] answers {status, body} for that path; every call is logged as [method, path, body].
async function mount(active, routes = {}, options = {}) {
  const saved = globalThis.document, doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createElementNS = (_, tag) => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  globalThis.document = doc;
  const panel = doc.createElement('section'), body = doc.createElement('div'), status = doc.createElement('p'), badge = doc.createElement('span');
  panel.append(body, status, badge); doc.body.append(panel);
  const calls = [], counts = [];
  const answer = {'/api/quests': {status: 200, body: active}, '/api/artifacts': {status: 200, body: {artifacts: []}}, '/api/for-you': {status: 200, body: ON}, ...routes};
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : null]);
    const r = typeof answer[url] === 'function' ? answer[url](init) : answer[url] ?? {status: 404, body: {error: 'Not here'}};
    return {ok: r.status < 400, status: r.status, json: async () => r.body};
  };
  const panelApi = createQuestsPanel({panel, body, status, badge, fetchImpl, onCount: n => counts.push(n), ...options});
  await panelApi.refresh();
  return {doc, body, badge, status, calls, counts, panel: panelApi, restore: () => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const sectionOf = body => body.querySelector('section.for-you');

test('For you is a section under Decisions, the subject is plain text, the folded list keeps the rest, and the badge count is unchanged', async () => {
  const subject = '<img src=x onerror="alert(1)">Lunch on Friday?';
  const withCards = [decision, step, season, card(1, 'reply', 'gmail', subject), card(2, 'quiet', 'clowder', 'Launch the shop')];
  const {body, badge, counts, restore} = await mount(withCards);
  try {
    const order = body.querySelector('div.quest-groups').children.map(n => n.className.includes('for-you') ? 'For you' : n.querySelector('h3')?.textContent ?? n.querySelector('summary')?.textContent);
    assert.deepEqual(order, ['Needs you', 'For you', 'Your cats are handling these (1)'], 'under the one Needs you band (plan 11.16), above the rest; only the sandbox request stays folded');
    const cards = sectionOf(body).querySelectorAll('li.for-you-card');
    assert.equal(cards.length, 2);
    const title = cards[0].querySelector('.for-you-subject');
    assert.equal(title.textContent, subject, 'the subject reads as written');
    assert.equal(title.children.length, 0, 'and becomes no element: textContent only');
    assert.deepEqual(cards.map(c => c.querySelector('.quest-kind').textContent), ['Suggestion · Gmail', 'Heads-up · Your goals']);
    assert.deepEqual(cards.map(c => c.querySelector('.glossary-note')?.textContent), [GLOSSARY.Suggestion, GLOSSARY['Heads-up']], 'the first card of each noun says what it means');
    assert.deepEqual(cards[0].querySelectorAll('button').map(b => b.textContent), ['Start', 'Dismiss', 'Open']);
    for (const b of cards[0].querySelectorAll('button')) assert.equal(b.getAttribute('aria-describedby'), title.id, `${b.textContent} names its card`);
    assert.equal(badge.textContent, '2');
    assert.deepEqual(counts, [2]);
    assert.equal(needsYouCount(withCards), needsYouCount([decision, step, season]), 'the count is the same with and without cards');
  } finally { restore(); }
  const without = await mount([decision, step, season]);
  try { assert.equal(without.badge.textContent, '2', 'and the badge shows it'); } finally { without.restore(); }
});

test('a viewer sees no section; an owner with For you off sees how to turn it on', async () => {
  const viewer = await mount([decision], {'/api/for-you': {status: 403, body: {error: 'The owner sets up For you.'}}});
  try {
    assert.equal(sectionOf(viewer.body), null);
    await viewer.panel.refresh();
    assert.equal(viewer.calls.filter(([, url]) => url === '/api/for-you').length, 1, 'a 403 is not asked again');
  } finally { viewer.restore(); }
  const off = await mount([], {'/api/for-you': {status: 200, body: {...ON, enabled: false}}});
  try {
    const section = sectionOf(off.body);
    assert.match(section.querySelector('p.for-you-empty').textContent, /^Off\. Turn it on in Settings/);
    assert.equal(section.querySelector('button.for-you-settings').getAttribute('aria-label'), 'For you settings');
  } finally { off.restore(); }
});

test('Dismiss: a reason menu, then the card folds behind a 4 s Undo; Undo sends nothing, and the hide goes out only when time is up', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let list = [decision, card(1), card(2, 'repeat', 'clowder', 'Summarise the made-up inbox')];
  const {doc, body, badge, calls, restore} = await mount(null, {'/api/quests': () => ({status: 200, body: list}), '/api/quests/suggestion%3Areply%3Agmail%3Athr-1/hide': () => ({status: 200, body: {ok: true}})});
  const hides = () => calls.filter(([method, url]) => method === 'POST' && url.endsWith('/hide'));
  try {
    const first = () => sectionOf(body).querySelectorAll('li.for-you-card')[0];
    const dismiss = first().querySelector('button.for-you-dismiss');
    assert.equal(dismiss.getAttribute('aria-expanded'), 'false');
    dismiss.click();
    const menu = first().querySelector('div.for-you-why');
    assert.equal(menu.getAttribute('role'), 'group');
    assert.deepEqual(menu.querySelectorAll('button').map(b => b.textContent), ['Less of this kind', 'Not about this person', 'Not this topic', 'Just this one', 'Keep it']);
    assert.equal(doc.activeElement.textContent, 'Less of this kind', 'focus moves into the menu');
    assert.equal(first().querySelector('button.for-you-dismiss').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(sectionOf(body).querySelectorAll('li.for-you-card')[1].querySelectorAll('div.for-you-why'), [], 'one menu at a time');

    menu.querySelectorAll('button')[1].click();
    const toast = doc.body.querySelector('div.for-you-toast');
    assert.equal(toast.hidden, false);
    assert.equal(toast.querySelector('p').textContent, 'Dismissed “Lunch on Friday? 1”. No more about this person.');
    assert.equal(doc.activeElement, toast.querySelector('button'), 'focus moves to Undo');
    assert.ok(first().className.includes('for-you-folded'), 'the card folds at once');
    t.mock.timers.tick(3_900);await flush();
    assert.deepEqual(hides(), [], 'nothing is sent inside the 4 s');
    toast.querySelector('button').click();
    assert.equal(toast.hidden, true);
    assert.ok(!first().className.includes('for-you-folded'), 'Undo opens the card again');
    assert.equal(doc.activeElement.textContent, 'Dismiss', 'and focus goes back to its Dismiss');
    t.mock.timers.tick(10_000);await flush();
    assert.deepEqual(hides(), [], 'an Undo never reaches the server');

    first().querySelector('button.for-you-dismiss').click();
    first().querySelector('div.for-you-why').querySelectorAll('button')[1].click();
    t.mock.timers.tick(3_999);await flush();
    assert.deepEqual(hides(), []);
    list = [decision, card(2, 'repeat', 'clowder', 'Summarise the made-up inbox')];
    t.mock.timers.tick(1);await flush();await flush();
    assert.deepEqual(hides(), [['POST', '/api/quests/suggestion%3Areply%3Agmail%3Athr-1/hide', {reason: 'person'}]], 'at 4 s the hide goes out with the reason (the id encoded, as every hide is)');
    assert.deepEqual(sectionOf(body).querySelectorAll('li.for-you-card').map(c => c.dataset.id), ['suggestion:repeat:clowder:thr-2'], 'and the list reloads without it');
    assert.equal(badge.textContent, '1', 'the badge never moved');

    // A card from Clowder has no person; Escape and Keep it close the menu without dismissing.
    const repeat = () => sectionOf(body).querySelectorAll('li.for-you-card')[0];
    repeat().querySelector('button.for-you-dismiss').click();
    assert.deepEqual(repeat().querySelector('div.for-you-why').querySelectorAll('button').map(b => b.dataset.answer), ['category', 'topic', 'none', undefined]);
    repeat().querySelector('div.for-you-why').dispatchEvent({type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {}});
    assert.equal(repeat().querySelector('div.for-you-why'), null);
    assert.equal(doc.activeElement.textContent, 'Dismiss');
  } finally { restore(); }
});

test('Start posts once, then opens the Request it made; a 409 says the card is no longer open', async () => {
  const opened = [];
  const {body, status, calls, restore} = await mount([card(1), card(2)], {
    '/api/suggestions/reply%3Agmail%3Athr-1/start': {status: 200, body: {task: 'task-made-up'}},
    '/api/suggestions/reply%3Agmail%3Athr-2/start': {status: 409, body: {error: 'That card is no longer open.'}},
  }, {openThread: t => opened.push(t)});
  try {
    const [one, two] = sectionOf(body).querySelectorAll('li.for-you-card');
    one.querySelector('button.for-you-start').click();
    await flush();await flush();
    assert.deepEqual(calls.filter(([m]) => m === 'POST'), [['POST', '/api/suggestions/reply%3Agmail%3Athr-1/start', {}]]);
    assert.deepEqual(opened, [{kind: 'request', id: 'task-made-up'}]);
    two.querySelector('button.for-you-start').click();
    await flush();await flush();
    assert.equal(status.textContent, 'That card is no longer open.');
    assert.equal(opened.length, 1);
  } finally { restore(); }
});

test('Open shows the card in a sheet: what it is, where it came from, a link to it, and the subject as plain text', async () => {
  const {doc, body, restore} = await mount([card(1)]);
  try {
    const open = sectionOf(body).querySelector('button.for-you-open');
    open.click();
    const sheet = doc.body.querySelector('dialog.for-you-sheet');
    assert.equal(sheet.open, true);
    assert.equal(sheet.querySelector('.quest-sheet-title').textContent, 'Lunch on Friday? 1');
    assert.equal(sheet.querySelector('a.quest-open').getAttribute('href'), 'https://mail.google.com/mail/#all/thr-1');
    assert.equal(sheet.querySelector('a.quest-open').getAttribute('rel'), 'noopener noreferrer');
    assert.match(sheet.querySelector('.for-you-facts').textContent, /^From Gmail · Last message /);
    assert.deepEqual(sheet.querySelector('.quest-sheet-foot').querySelectorAll('button').map(b => b.textContent), ['Dismiss…', 'Start']);
    sheet.querySelector('.quest-sheet-back').click();
    assert.equal(sheet.open, false);
    assert.equal(doc.activeElement, open, 'focus goes back to Open');
  } finally { restore(); }
});

test('the settings sheet: four categories, triage off and explained, guidance and Clear saved reasons, each saved with PUT /api/for-you', async () => {
  let saved = {...ON};
  const {doc, body, calls, restore} = await mount([], {
    // As src/for-you.ts update(): categories merge, Clear stamps the time.
    '/api/for-you': init => {
      if (init.method === 'PUT') { const {categories, clearReasons, ...rest} = JSON.parse(init.body);saved = {...saved, ...rest, categories: {...saved.categories, ...categories}, ...(clearReasons ? {reasonsClearedAt: '2026-11-09T12:00:00.000Z'} : {})}; }
      return {status: 200, body: saved};
    },
    '/api/connectors': {status: 200, body: {directory: [{id: 'google-workspace', client: 'google'}], connectors: [{id: 'google-made-up', name: 'Made-up account', entry: 'google-workspace', auth: 'signed-in'}]}},
  });
  try {
    sectionOf(body).querySelector('button.for-you-settings').click();
    await flush();await flush();
    const dialog = doc.body.querySelector('dialog.op-dialog');
    assert.equal(dialog.open, true);
    const switches = dialog.querySelectorAll('input').filter(i => i.getAttribute('role') === 'switch');
    assert.deepEqual(switches.map(s => s.getAttribute('aria-label')), ['For you', 'Replies waiting', 'Meeting prep', 'Repeat work', 'Quiet goals', 'Triage with your AI model']);
    const triage = switches.at(-1);
    assert.equal(triage.checked, false, 'triage is off by default');
    assert.match(dialog.textContent, /It spends model tokens: within a cap per check and a cap per day/);
    triage.checked = true;triage.onchange();
    await flush();await flush();
    assert.deepEqual(calls.filter(([m]) => m === 'PUT').at(-1), ['PUT', '/api/for-you', {triage: true}]);
    const quiet = dialog.querySelectorAll('input').find(i => i.getAttribute('aria-label') === 'Quiet goals');
    quiet.checked = false;quiet.onchange();
    await flush();await flush();
    assert.deepEqual(calls.filter(([m]) => m === 'PUT').at(-1), ['PUT', '/api/for-you', {categories: {quiet: false}}]);
    const account = dialog.querySelector('select');
    assert.equal(account.getAttribute('aria-label'), 'Google account');
    const clear = dialog.querySelectorAll('button').find(b => b.textContent === 'Clear saved reasons');
    clear.click();
    await flush();await flush();
    assert.deepEqual(calls.filter(([m]) => m === 'PUT').at(-1), ['PUT', '/api/for-you', {clearReasons: true}]);
    assert.match(dialog.textContent, /Cleared\. Cards you dismissed with a reason can come back\./);
    assert.match(dialog.textContent, /Last cleared /);
  } finally { restore(); }
});

test('the module writes no markup and its stylesheet uses the tokens only', () => {
  const source = read('for-you.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), 'textContent and createElement only');
  assert.match(source, /ensureStyles\(doc,'for-you\.css','for-you'\)/, 'the module links its own stylesheet');
  const css = read('for-you.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...css.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]).join(';');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(declarations), 'no colour literals');
  assert.ok(!/font-family|font:/.test(css), 'no fonts');
  assert.ok(!/:root|--[\w-]+\s*:/.test(css), 'no new tokens');
  assert.match(read('app.js'), /createQuestsPanel\(\{[^\n]*openThread:t=>\{showPane\('inspector'\);chatThread\.open\(t\);\}/, 'Start opens the thread in the chat');
});

// The proof (plan 9.11, Gate 9's 375 px line) in a real browser. Skipped where no Chromium, Edge or Chrome is installed; CLOWDER_TEST_BROWSER
// names another one.
const browserPath = [process.env.CLOWDER_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

test('proof (plan 9.11) in a real browser: at 1024 and 375 px with 10 cards, no sideways scroll, 44 px targets, every control named, Undo works, the badge holds', {skip: !browserPath && 'no Chromium, Edge or Chrome here', timeout: 300_000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'for-you-ui-')), key = 'for-you-ui-owner-key', port = await freePort();
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  Object.assign(process.env, {PORT: String(port), CAT_REMOTE_PORT: String(await freePort()), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_TOWN_LAN: '0', CAT_OWNER_KEY: key});
  // The server never reaches the Internet from here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, {status: 503}));
  const {app: server, worlds} = await import('../src/server.ts');
  const {suggestionRaised} = await import('../src/store.ts');
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({executablePath: browserPath, headless: true});
  // One decision, so the badge count is 1 and not 0 = 0. Every card is made up; one subject looks like markup.
  worlds.store.emit('approval.requested', {id: 'a-ui', task: 't-none', cat: 'mayor', question: 'Send the made-up draft?', options: ['Allow', 'Deny'], status: 'pending', toolCallId: 'c-ui', turn: 1, depth: 0, detail: ''});
  let seq = 0;
  const raise = () => {
    const n = ++seq, kind = [['reply', 'gmail'], ['prep', 'calendar'], ['repeat', 'clowder'], ['quiet', 'clowder']][n % 4];
    const subject = n === 1 ? '<img src=x onerror="window.__pwned=1">Lunch on Friday?' : `Made-up card number ${n} with a subject long enough to wrap on a phone`;
    worlds.store.emit('suggestion.raised', suggestionRaised({id: `${kind[0]}:${kind[1]}:ui-${n}`, source: kind[1], account: kind[1] === 'clowder' ? null : 'google-made-up', sourceId: `ui-${n}`, category: kind[0], subject, person: kind[1] === 'clowder' ? null : `person-${n}`, sourceAt: new Date(Date.now() + (kind[0] === 'prep' ? 3 : -3) * 3_600_000).toISOString()}));
  };
  const open = () => Object.values(worlds.store.state.suggestions ?? {}).filter(c => c.status === 'open');
  try {
    for (const {width, height, phone} of [{width: 1024, height: 768, phone: false}, {width: 375, height: 812, phone: true}]) {
      while (open().length < 10) raise();
      const context = await browser.newContext({viewport: {width, height}, ...(phone ? {isMobile: true, hasTouch: true} : {})});
      await context.addInitScript(seen => { try { localStorage.setItem(seen, '1'); } catch { /* storage off: the hub may open */ } }, SEEN_KEY);
      // The 3D town is not needed, and headless WebGL is slow.
      await context.route('**/town.js', route => route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?owner=${key}&perf`); // perf exposes window.__chatThread (chat-thread.js)
      await page.waitForFunction(() => !document.body.classList.contains('connecting') && !!document.querySelector('#cats .cat-button'));
      await page.click('#toggle-quests');
      await page.waitForFunction(() => document.querySelectorAll('#quests-body section.for-you li.for-you-card').length === 10, null, {timeout: 30_000});
      const badge = () => page.evaluate(() => document.getElementById('quests-badge').textContent);
      // The server's own count of what needs the owner: every needsYou quest. No card is one.
      const needsNow = () => page.evaluate(() => fetch('/api/quests').then(r => r.json()).then(list => ({n: list.filter(q => q.needsYou).length, cards: list.filter(q => q.source.kind === 'suggestion').length, cardsNeeding: list.filter(q => q.source.kind === 'suggestion' && q.needsYou).length})));
      const before = await needsNow();
      assert.deepEqual([before.cards, before.cardsNeeding], [10, 0], `${width}: 10 cards, none of them counted`);
      assert.ok(before.n >= 1, `${width}: at least one decision, so the count is not 0 = 0`);
      await page.waitForFunction(n => document.getElementById('quests-badge').textContent === String(n), before.n);
      const base = await badge();

      // Under Decisions; the markup-looking subject stays text.
      const layout = await page.evaluate(async () => ({
        order: [...document.querySelectorAll('#quests-body .quest-groups > *')].map(n => n.matches('.for-you') ? 'For you' : n.querySelector('h3')?.textContent ?? n.className),
        pwned: window.__pwned ?? null, imgs: document.querySelectorAll('#quests-body section.for-you img').length,
        shown: [...document.querySelectorAll('#quests-body .for-you-subject')].map(n => n.textContent).find(s => s.startsWith('<img')) ?? null,
        // The server's one-line title (src/quests.ts oneLiner) is what the card shows, character for character.
        sent: (await fetch('/api/quests').then(r => r.json())).find(q => q.source.kind === 'suggestion' && q.title.startsWith('<img'))?.title ?? null,
      }));
      assert.deepEqual(layout.order.slice(0, 2), ['Needs you', 'For you'], `${width}: For you sits under Needs you (plan 11.16)`);
      assert.deepEqual([layout.pwned, layout.imgs], [null, 0], `${width}: the subject is never markup`);
      assert.ok(layout.sent?.startsWith('<img src=x'), `${width}: the markup-looking subject is on the list`);
      assert.equal(layout.shown, layout.sent, `${width}: and shows as text`);

      // Every control in the section, the reason menu, the toast, the card sheet and the settings sheet: at least 44 px and named.
      const check = async (scope, what) => {
        const found = await page.evaluate(selector => {
          const nameOf = el => {
            const label = el.getAttribute('aria-label')?.trim();if (label) return label;
            const by = el.getAttribute('aria-labelledby');if (by) { const s = by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();if (s) return s; }
            if (el.labels?.length) { const s = [...el.labels].map(l => l.textContent).join(' ').trim();if (s) return s; }
            if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) { const s = el.textContent.trim();if (s) return s; }
            return el.getAttribute('title')?.trim() ?? '';
          };
          return [...document.querySelectorAll(selector)].flatMap(root => [...root.querySelectorAll('button, a[href], input, select, textarea, summary')])
            .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
            .map(el => { const r = el.getBoundingClientRect();return {what: `${el.tagName.toLowerCase()} “${nameOf(el) || el.className}”`, w: Math.round(r.width), h: Math.round(r.height), name: nameOf(el)}; });
        }, scope);
        assert.ok(found.length > 0, `${width}: ${what} has controls`);
        const small = found.filter(c => c.w < 44 || c.h < 44).map(c => `${c.what} ${c.w}x${c.h}`);
        assert.deepEqual(small, [], `${width}: ${what}: every target is at least 44 px`);
        assert.deepEqual(found.filter(c => !c.name).map(c => c.what), [], `${width}: ${what}: every control has a name`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}: ${what}: no sideways scroll`);
        t.diagnostic(`${width} px, ${what}: ${found.length} controls, smallest ${Math.min(...found.map(c => c.w))}x${Math.min(...found.map(c => c.h))} px`);
      };
      await check('#quests-body section.for-you', 'the section with 10 cards');

      // Dismiss with a reason, then Undo inside the 4 s: nothing reaches the server.
      const target = await page.evaluate(() => document.querySelector('#quests-body li.for-you-card[data-category=reply]').dataset.id);
      const cardOn = `#quests-body li[data-id="${target}"]`, id = target.slice('suggestion:'.length);
      await page.click(`${cardOn} button.for-you-dismiss`);
      await page.waitForSelector(`${cardOn} .for-you-why`);
      await check(`${cardOn} .for-you-why`, 'the reason menu');
      await page.click(`${cardOn} .for-you-why button[data-answer=person]`);
      await page.waitForSelector('.for-you-toast:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'decision-toast-undo', `${width}: focus is on Undo`);
      await check('.for-you-toast', 'the Undo toast');
      await page.click('.for-you-toast button');
      await page.waitForSelector(`${cardOn}:not(.for-you-folded) button.for-you-dismiss`);
      await page.waitForTimeout(4_500);
      assert.equal(worlds.store.state.suggestions[id].status, 'open', `${width}: after Undo the card is still open on the server`);
      assert.equal(await page.locator(`${cardOn}.for-you-folded`).count(), 0, `${width}: and in the list`);

      // Dismiss again and let the 4 s run out: the hide goes out with the reason and the card leaves the list.
      const t0 = Date.now();
      await page.click(`${cardOn} button.for-you-dismiss`);
      await page.click(`${cardOn} .for-you-why button[data-answer=person]`);
      await page.waitForFunction(selector => !document.querySelector(selector), cardOn, {timeout: 15_000});
      const held = Date.now() - t0;
      t.diagnostic(`${width} px: the dismissed card left the list ${held} ms after the reason`);
      assert.ok(held >= 4_000, `${width}: nothing went before the 4 s (${held} ms)`);
      assert.deepEqual([worlds.store.state.suggestions[id].status, worlds.store.state.suggestions[id].reason], ['dismissed', 'person']);
      assert.equal(await badge(), base, `${width}: dismissing moved no count`);

      // Open: the card's sheet.
      await page.click('#quests-body li.for-you-card button.for-you-open');
      await page.waitForSelector('dialog.for-you-sheet[open]');
      await check('dialog.for-you-sheet[open]', 'the card sheet');
      await page.click('dialog.for-you-sheet[open] .quest-sheet-back');

      // Settings: triage is off and explained; turning it on saves it.
      await page.click('#quests-body button.for-you-settings');
      await page.waitForSelector('#for-you-dialog[open] input[aria-label="Triage with your AI model"]');
      await check('#for-you-dialog[open]', 'the settings sheet');
      const triage = page.locator('#for-you-dialog input[aria-label="Triage with your AI model"]');
      assert.equal(await triage.isChecked(), phone, `${width}: triage starts as the last run left it`);
      // A person taps the switch's label: its drawn track sits over the checkbox (owner-dialog.js switchControl).
      await page.click('#for-you-dialog label.op-switch:has(input[aria-label="Triage with your AI model"])');
      await page.waitForFunction(on => fetch('/api/for-you').then(r => r.json()).then(s => s.triage === on), !phone);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('for-you-dialog').open);

      // Start: the Request it makes opens in the chat.
      const startId = await page.evaluate(() => document.querySelector('#quests-body li.for-you-card').dataset.id);
      await page.click(`#quests-body li[data-id="${startId}"] button.for-you-start`);
      await page.waitForFunction(() => window.__chatThread?.current?.().kind === 'request', null, {timeout: 30_000});
      const started = worlds.store.state.suggestions[startId.slice('suggestion:'.length)];
      assert.equal(started.status, 'started');
      assert.equal(await page.evaluate(() => window.__chatThread.current().id), started.task, `${width}: the thread is the Request the card made`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}: no sideways scroll with the thread open`);
      // The Request may fail here (the server's network is stubbed), and a failed Request needs the owner: the badge then counts that, never a card.
      const needs = await page.evaluate(() => fetch('/api/quests').then(r => r.json()).then(list => ({n: list.filter(q => q.needsYou).length, kinds: list.filter(q => q.needsYou).map(q => q.source.kind), cards: list.filter(q => q.source.kind === 'suggestion' && q.needsYou).length})));
      t.diagnostic(`${width} px after Start: needs you = ${needs.n} (${needs.kinds.join(', ')})`);
      assert.equal(needs.cards, 0, `${width}: no card needs you`);
      await page.waitForFunction(n => document.getElementById('quests-badge').textContent === String(n), needs.n);
      assert.deepEqual(errors, [], `${width}: no page errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    globalThis.fetch = realFetch;
    rmSync(dir, {recursive: true, force: true});
  }
});

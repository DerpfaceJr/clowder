import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ROLES, roleLabel, budgetLine, budgetDraft, onlineNow, onlineLine, roleOf, memberOptions, mayAnswer, ownWork, statusWords, goalWords, refusalText, memberMode,
  createPeoplePanel, createMemberView, HOST_ONLY, START_REMOTE} from '../public/people-panel.js';
import {scopeOf, scopeLine, SCOPES, createAccountsPanel} from '../public/accounts-panel.js';
import {fakeDocument, fakeWindow, fakeServer, settle, byKey, buttonByText} from './fixtures/fake-dom-accounts.mjs';

// Plan 10.11: the owner's People panel and a member's own view, Yours (public/people-panel.js), and the account scope toggle in Accounts &
// connections (public/accounts-panel.js). The browser checks at 1024 and 375 px were run by hand against a scratch server (see the PR).

const OWNER = {id: 'owner', name: 'Owner', role: 'owner', createdAt: 0};
const SAM = {id: 'p-sam', name: 'Sam <img src=x onerror=alert(1)>', role: 'member', createdAt: 1, budget: 200000};
const VEE = {id: 'p-vee', name: 'Vee', role: 'viewer', createdAt: 2};

test('roles, budgets and who is online read in plain words; a bad budget never becomes a number', () => {
  assert.deepEqual(ROLES.map(([r]) => r), ['member', 'viewer'], 'no admin in G1 (D18)');
  assert.equal(roleLabel('owner'), 'Owner');
  assert.equal(roleLabel('viewer'), 'Viewer');
  assert.equal(roleLabel('admin'), 'Person');
  assert.equal(budgetLine(SAM, 'en-GB'), 'Budget: 200,000 tokens a month. Past it, their new work waits for you.');
  assert.equal(budgetLine({...SAM, budget: null}), 'No budget of their own. The town’s monthly cap still applies.');
  assert.equal(budgetLine(VEE), null, 'a viewer runs no work, so has no budget');
  assert.deepEqual(budgetDraft('200k'), {tokens: 200000});
  assert.deepEqual(budgetDraft('1,500,000'), {tokens: 1500000});
  assert.deepEqual(budgetDraft('2m'), {tokens: 2000000});
  for (const bad of ['', '0', '-5', 'lots', '1.2.3']) assert.match(budgetDraft(bad).error, /whole number of tokens a month/, bad);
  assert.equal(onlineNow(undefined), null);
  assert.deepEqual(onlineNow([{name: 'Sam', role: 'member'}, {name: '  '}, null]), [{name: 'Sam', role: 'member'}]);
  assert.equal(onlineLine(undefined), 'Who is online shows once the live feed connects.');
  assert.equal(onlineLine([{id: 'owner', name: 'Owner', role: 'owner'}], 'owner'), 'Only you are here right now.');
  assert.equal(onlineLine([{id: 'owner', name: 'Owner', role: 'owner'}, {id: 'p-sam', name: 'Sam', role: 'member'}], 'owner'), '1 other person is here now.');
});

test('the page reads its role from /api/state me; a server from before me reads by readOnly', () => {
  assert.equal(roleOf({me: {role: 'member', id: 'p-sam'}, readOnly: true}), 'member');
  assert.equal(roleOf({me: {role: 'viewer'}, readOnly: true}), 'viewer');
  assert.equal(roleOf({me: {role: 'owner'}, readOnly: false}), 'owner');
  assert.equal(roleOf({readOnly: true}), 'viewer');
  assert.equal(roleOf({readOnly: false}), 'owner');
  assert.equal(roleOf(null), 'owner');
});

test('a member answers only their own plain, goal or connector decisions, never an owner-only one, and is never offered Always allow', () => {
  const mine = {id: 't1', by: 'p-sam'}, theirs = {id: 't2', by: 'p-ana'}, owners = {id: 't3'};
  assert.equal(mayAnswer({task: 't1'}, mine, 'p-sam'), true);
  assert.equal(mayAnswer({task: 't1', gate: 'goal'}, mine, 'p-sam'), true);
  assert.equal(mayAnswer({task: 't1', gate: 'connector', call: {function: {name: 'mcp__linear__create_issue'}}}, mine, 'p-sam'), true);
  assert.equal(mayAnswer({task: 't1', gate: 'connector', call: {function: {name: 'browse'}}}, mine, 'p-sam'), false, 'the cats’ browser is the owner’s');
  assert.equal(mayAnswer({task: 't1', ownerOnly: true}, mine, 'p-sam'), false);
  assert.equal(mayAnswer({task: 't1', gate: 'budget'}, mine, 'p-sam'), false);
  assert.equal(mayAnswer({task: 't2'}, theirs, 'p-sam'), false);
  assert.equal(mayAnswer({task: 't3'}, owners, 'p-sam'), false);
  assert.deepEqual(memberOptions({options: ['Allow once', 'Always allow (this cat)', 'Always allow (every cat)', 'Deny']}), ['Allow once', 'Deny']);
  assert.deepEqual(memberOptions({}), []);
});

const STATE = {
  me: {role: 'member', id: 'p-sam', name: 'Sam'}, readOnly: true,
  cats: [{id: 'mayor', name: 'Mayor', ai: {}}, {id: 'scout', name: 'Scout'}], models: [], townDefault: null,
  tasks: [
    {id: 't-open', cat: 'mayor', from: 'owner', text: 'Draft the team newsletter', status: 'running', mode: 'demo', by: 'p-sam'},
    {id: 't-child', cat: 'scout', from: 'mayor', text: 'Find three headlines', status: 'running', mode: 'demo', parent: 't-open', by: 'p-sam'},
    {id: 't-round', cat: 'mayor', from: 'owner', text: 'Goal round', status: 'running', mode: 'demo', goal: 'g-1', by: 'p-sam'},
    {id: 't-ana', cat: 'mayor', from: 'owner', text: 'Ana’s request', status: 'running', mode: 'demo', by: 'p-ana'},
    {id: 't-own', cat: 'mayor', from: 'owner', text: 'The owner’s own request', status: 'running', mode: 'demo'},
  ],
  goals: [{id: 'g-1', title: 'Grow the newsletter', status: 'active', rounds: 3, by: 'p-sam'}, {id: 'g-2', title: 'Owner goal', status: 'active', rounds: 1}],
  approvals: [
    {id: 'a-mine', task: 't-child', cat: 'scout', question: 'May I use Linear?', options: ['Allow once', 'Always allow (this cat)', 'Deny'], status: 'pending', gate: 'connector', call: {function: {name: 'mcp__linear__create_issue'}}},
    {id: 'a-owner-only', task: 't-open', cat: 'mayor', question: 'May I use the owner’s Gmail?', options: ['Allow once', 'Deny'], status: 'pending', gate: 'connector', ownerOnly: true, call: {function: {name: 'mcp__gmail__send'}}},
    {id: 'a-ana', task: 't-ana', cat: 'mayor', question: 'Ana’s question', options: ['Yes', 'No'], status: 'pending'},
    {id: 'a-done', task: 't-open', cat: 'mayor', question: 'Old', options: ['Yes'], status: 'approved'},
  ],
};
const MAYOR_CHAT = {messages: [], more: false, tasks: [{id: 't-old', cat: 'mayor', from: 'owner', text: 'Last week’s summary', status: 'done', mode: 'demo', by: 'p-sam'}, {id: 't-open', cat: 'mayor', from: 'owner', text: 'Draft the team newsletter', status: 'pending', mode: 'demo', by: 'p-sam'}]};

test('a member’s own work: their root Requests (finished ones from the Mayor’s chat too), their Goals and the decisions in their trees', () => {
  const work = ownWork(STATE, 'p-sam', MAYOR_CHAT.tasks);
  assert.deepEqual(work.requests.map(t => t.id), ['t-open', 't-old'], 'newest first; goal rounds, children and other people’s work left out');
  assert.equal(work.requests[0].status, 'running', 'the state’s newer status wins over the chat page’s');
  assert.deepEqual(work.goals.map(g => g.id), ['g-1']);
  assert.deepEqual(work.decisions.map(d => [d.a.id, d.canAnswer]), [['a-mine', true], ['a-owner-only', false]]);
  assert.deepEqual(ownWork(STATE, undefined), {requests: [], goals: [], decisions: []}, 'no person, nothing is theirs');
  assert.equal(statusWords({status: 'queued'}), 'Waiting for the Mayor');
  assert.equal(statusWords({status: 'running', held: 'budget'}), 'Held: past your monthly budget. The owner decides.');
  assert.equal(goalWords({status: 'paused', rounds: 1}), 'Paused · 1 round');
  assert.equal(refusalText(Object.assign(new Error('Members talk to the Mayor.'), {status: 403})), 'Members talk to the Mayor.');
  assert.equal(refusalText(Object.assign(new Error('That did not work.'), {status: 403})), 'That part of the town is the owner’s.');
  assert.match(refusalText({status: 401}), /no longer paired/);
  assert.match(refusalText(new TypeError('Failed to fetch')), /^The town did not answer: the host computer may be asleep\./, 'the closed gate, in words');
  assert.equal(memberMode(STATE), 'demo', 'with no model set up, the scripted demonstration, as the owner’s composer');
});

// ---- The owner's panel ----

function mountPeople(routes = {}, {people = [OWNER, SAM, VEE], ask = async () => true} = {}) {
  const doc = fakeDocument(), win = fakeWindow(), surfaces = [];
  win.openSurface = name => surfaces.push(name);
  const server = fakeServer({'GET /api/remote/people': () => ({people: server.people}), ...routes});
  server.people = people.map(p => ({...p}));
  const panel = createPeoplePanel({doc, win, fetchImpl: server.fetch, ask, locale: 'en-GB'});
  const body = () => panel.dialog.querySelector('div.op-body');
  const row = id => body().querySelector(`li[data-id="${id}"]`);
  return {doc, win, server, panel, body, row, surfaces};
}
const posts = server => server.calls.filter(c => c[0] !== 'GET').map(c => [c[0], c[1], c[2]]);
// Every button, field and text box has a name a screen reader says: its aria-label, its text, or the label around it.
const unnamed = root => root.querySelectorAll('button').concat(root.querySelectorAll('input'), root.querySelectorAll('textarea'))
  .filter(n => !(n.getAttribute('aria-label') || n.getAttribute('aria-labelledby') || n.textContent.trim() || n.parentNode?.tagName === 'LABEL'));

test('People lists everyone with their role and budget, names as text, and every control named; a viewer of the route gets the host sentence', async t => {
  const p = mountPeople();
  t.after(() => p.doc.restore());
  assert.equal(await p.panel.probe(), true);
  assert.equal(p.panel.summary(), '2 people besides you · invites and budgets');
  await p.panel.open();
  await settle();
  const sam = p.row('p-sam');
  const name = sam.querySelector('strong.pp-name');
  assert.equal(name.textContent, SAM.name);
  assert.equal(name.children.length, 0, 'a name is text: no element is made from it');
  assert.match(sam.textContent, /Member/);
  assert.match(sam.textContent, /Budget: 200,000 tokens a month/);
  assert.deepEqual(p.row('owner').querySelectorAll('button'), [], 'the owner cannot be invited, budgeted or removed');
  assert.equal(buttonByText(p.row('p-vee'), 'Budget'), null, 'a viewer has no budget');
  assert.deepEqual(unnamed(p.body()), []);
  assert.equal(sam.querySelector('button[aria-label="Invite Sam <img src=x onerror=alert(1)>"]').textContent, 'Invite', 'the visible word is in the name');
  assert.doesNotMatch(p.body().textContent, /\bnull\b|\bundefined\b/);

  const remote = mountPeople({'GET /api/remote/people': () => ({status: 403, json: {error: 'Device access is managed on the host computer.'}})});
  t.after(() => remote.doc.restore());
  assert.equal(await remote.panel.probe(), false);
  await remote.panel.open();
  await settle();
  assert.equal(remote.body().textContent, HOST_ONLY);
});

test('who is online comes from the presence frame: Online now lists them and their row says Online', async t => {
  const p = mountPeople();
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  assert.match(p.body().textContent, /Who is online shows once the live feed connects\./);
  p.win.dispatchEvent({type: 'town-state', detail: {next: {presence: [{id: 'owner', name: 'Owner', role: 'owner'}, {id: 'p-sam', name: SAM.name, role: 'member'}]}}});
  const online = p.body().querySelector('ul.pp-online');
  assert.deepEqual(online.querySelectorAll('li').map(li => li.querySelector('span.pp-name').textContent), ['You', SAM.name]);
  assert.match(p.body().textContent, /1 other person is here now\./);
  assert.match(p.row('p-sam').querySelector('p.op-status').textContent, /Online/);
  assert.equal(p.row('p-vee').querySelector('p.op-status'), null);
});

test('Add person posts the name and the chosen role; an empty name never posts', async t => {
  const p = mountPeople({'POST /api/remote/people': body => { const made = {id: 'p-new', name: body.name, role: body.role, createdAt: 3}; p.server.people.push(made); return made; }});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  const form = () => p.body().querySelectorAll('form').at(-1);
  form().onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(posts(p.server), []);
  assert.match(p.body().textContent, /Name this person first\./);
  const role = p.body().querySelector('div.cx-seg');
  assert.equal(role.getAttribute('role'), 'group');
  assert.deepEqual(role.querySelectorAll('button').map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['Member', 'true'], ['Viewer', 'false']]);
  buttonByText(role, 'Viewer').click();
  assert.match(p.body().textContent, /Watches the town\. Changes nothing\./);
  const field = byKey(p.body(), 'add:name');
  field.value = '  Robin  '; field.oninput();
  form().onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(posts(p.server), [['POST', '/api/remote/people', {name: 'Robin', role: 'viewer'}]]);
  assert.match(p.row('p-new').textContent, /Added Robin as a viewer\./);
});

test('Invite shows the link to copy and the QR as an image; with remote access off it says so and offers Devices', async t => {
  const qr = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const p = mountPeople({'POST /api/remote/people/p-sam/invite': () => ({code: 'AB12-CD34', permission: 'member', link: 'https://town.example/#pair=AB12-CD34', qr, expiresAt: Date.parse('2026-11-09T12:30:00Z')})});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  byKey(p.row('p-sam'), 'p:p-sam:invite').click();
  await settle();
  assert.deepEqual(posts(p.server), [['POST', '/api/remote/people/p-sam/invite', {}]]);
  const box = p.row('p-sam').querySelector('div.pp-invite');
  assert.match(box.textContent, /pairs one device as a member, works once/);
  const link = box.querySelector('input.op-copy-input');
  assert.equal(link.value, 'https://town.example/#pair=AB12-CD34');
  assert.match(link.getAttribute('aria-label'), /^Invite link for Sam/);
  const img = box.querySelector('img');
  assert.equal(img.src, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`, 'the server’s SVG as an image source, never as markup');
  assert.match(img.getAttribute('alt'), /^QR code for Sam/);
  assert.match(box.textContent, /Code: AB12-CD34/);

  const off = mountPeople({'POST /api/remote/people/p-vee/invite': () => Object.assign(new Error(START_REMOTE), {status: 400})});
  t.after(() => off.doc.restore());
  await off.panel.open();
  await settle();
  byKey(off.row('p-vee'), 'p:p-vee:invite').click();
  await settle();
  assert.match(off.row('p-vee').textContent, /Start remote access first\./);
  assert.equal(off.row('p-vee').querySelector('div.pp-invite'), null);
  buttonByText(off.row('p-vee'), 'Open Devices').click();
  assert.deepEqual(off.surfaces, ['devices']);
  assert.equal(off.panel.dialog.open, false);
});

test('Budget saves a whole number, refuses anything else without posting, and Clear budget posts null', async t => {
  const p = mountPeople({'POST /api/remote/people/p-sam/budget': body => { p.server.people = p.server.people.map(x => x.id === 'p-sam' ? {...x, budget: body.tokens} : x); return {ok: true, people: p.server.people}; }});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  const toggle = byKey(p.row('p-sam'), 'p:p-sam:budget');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  const field = byKey(p.row('p-sam'), 'p:p-sam:budget-input');
  assert.equal(field.value, '200000');
  assert.match(field.getAttribute('aria-label'), /^Monthly token budget for Sam/);
  field.value = 'lots'; field.oninput();
  p.row('p-sam').querySelector('form').onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(posts(p.server), []);
  assert.match(p.row('p-sam').textContent, /Enter a whole number of tokens a month/);
  byKey(p.row('p-sam'), 'p:p-sam:budget-input').value = '50k';
  byKey(p.row('p-sam'), 'p:p-sam:budget-input').oninput();
  p.row('p-sam').querySelector('form').onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(posts(p.server).at(-1), ['POST', '/api/remote/people/p-sam/budget', {tokens: 50000}]);
  assert.match(p.row('p-sam').textContent, /Budget: 50,000 tokens a month/);
  assert.match(p.row('p-sam').textContent, /Sam.*’s budget is 50,000 tokens a month\./);
  byKey(p.row('p-sam'), 'p:p-sam:budget').click();
  byKey(p.row('p-sam'), 'p:p-sam:budget-clear').click();
  await settle();
  assert.deepEqual(posts(p.server).at(-1), ['POST', '/api/remote/people/p-sam/budget', {tokens: null}]);
  assert.match(p.row('p-sam').textContent, /No budget of their own\./);
});

test('Remove asks first: Keep them posts nothing, Remove posts and the person leaves the list', async t => {
  const asked = [];
  let answer = false;
  const p = mountPeople({'POST /api/remote/people/p-vee/remove': () => { p.server.people = p.server.people.filter(x => x.id !== 'p-vee'); return {ok: true}; }}, {ask: async o => { asked.push(o); return answer; }});
  t.after(() => p.doc.restore());
  await p.panel.open();
  await settle();
  byKey(p.row('p-vee'), 'p:p-vee:remove').click();
  await settle();
  assert.equal(asked[0].title, 'Remove Vee?');
  assert.equal(asked[0].danger, true);
  assert.equal(asked[0].cancelLabel, 'Keep them');
  assert.deepEqual(posts(p.server), []);
  answer = true;
  byKey(p.row('p-vee'), 'p:p-vee:remove').click();
  await settle();
  assert.deepEqual(posts(p.server), [['POST', '/api/remote/people/p-vee/remove', {}]]);
  assert.equal(p.row('p-vee'), null);
  assert.match(p.body().textContent, /Removed Vee\./);
});

// ---- A member's view ----

function mountMember(routes = {}) {
  const doc = fakeDocument(), win = fakeWindow();
  doc.getElementById = id => doc.body.querySelectorAll(`[id="${id}"]`)[0] ?? null;
  win.location = {hash: ''};
  // The page parts Yours sits in: the dock with Inbox, and the chat panel's composer.
  const dock = doc.createElement('nav'), inbox = doc.createElement('button'), panel = doc.createElement('aside'), form = doc.createElement('form');
  dock.className = 'town-dock'; inbox.setAttribute('id', 'toggle-quests'); form.setAttribute('id', 'chat-form');
  dock.append(inbox); panel.append(form); doc.body.append(dock, panel);
  const server = fakeServer({'GET /api/chats/mayor?limit=1': () => MAYOR_CHAT, ...routes});
  const view = createMemberView({doc, win, fetchImpl: server.fetch, locale: 'en-GB'});
  const body = () => view.dialog.querySelector('div.op-body');
  const send = state => win.dispatchEvent({type: 'town-state', detail: {next: state}});
  return {doc, win, server, view, body, send, dock};
}

test('a member’s page gets Yours in the dock and the body’s member class; an owner’s or a viewer’s page never does', async t => {
  const m = mountMember();
  t.after(() => m.doc.restore());
  assert.equal(m.view.entry.hidden, true);
  assert.equal(m.view.entry.getAttribute('aria-label'), 'Yours');
  assert.equal(m.dock.querySelector('button[id="toggle-member"]'), m.view.entry);
  await m.view.open();
  assert.equal(m.view.dialog.open, false, 'nothing opens before the page knows it is a member’s');
  m.send(STATE);
  assert.equal(m.doc.body.classList.contains('member'), true);
  assert.equal(m.view.entry.hidden, false);
  assert.equal(m.view.pointer.hidden, false);
  assert.equal(m.view.entry.getAttribute('aria-label'), 'Yours, 1 decision waits for you');
  m.send({...STATE, me: {role: 'viewer'}});
  assert.equal(m.doc.body.classList.contains('member'), false);
  assert.equal(m.view.entry.hidden, true);
  assert.equal(m.view.pointer.hidden, true);
  m.send({...STATE, me: {role: 'owner', id: 'owner', name: 'Owner'}, readOnly: false});
  assert.equal(m.view.entry.hidden, true);
});

test('Yours lists the member’s own decisions, Requests and Goals only, with Always allow left off and owner-only cards waiting', async t => {
  const m = mountMember();
  t.after(() => m.doc.restore());
  m.send(STATE);
  await m.view.open();
  await settle();
  assert.match(m.view.dialog.textContent, /You’re Sam, a member here\./);
  const text = m.body().textContent;
  assert.doesNotMatch(text, /Ana’s|The owner’s own request|Owner goal|Goal round|Find three headlines/, 'nobody else’s work, and no goal round or child task as a request');
  const decisions = m.body().querySelectorAll('li').filter(li => li.dataset.id?.startsWith('a-'));
  assert.deepEqual(decisions.map(li => li.dataset.id), ['a-mine', 'a-owner-only']);
  assert.deepEqual(decisions[0].querySelectorAll('button').map(b => b.textContent), ['Allow once', 'Deny'], 'never an Always allow');
  assert.equal(decisions[0].querySelector('div.op-actions').getAttribute('aria-label'), 'Answer Scout');
  assert.deepEqual(decisions[1].querySelectorAll('button'), []);
  assert.match(decisions[1].textContent, /waits for the owner: it needs an account or money only the owner can allow/);
  const requests = m.body().querySelectorAll('li.pp-request');
  assert.deepEqual(requests.map(li => li.dataset.id), ['t-open', 't-old']);
  assert.match(requests[0].textContent, /Draft the team newsletter.*In progress/);
  assert.match(requests[1].textContent, /Last week’s summary.*Done/);
  assert.equal(requests[0].querySelector('button').getAttribute('aria-label'), 'Open: Draft the team newsletter');
  assert.match(m.body().textContent, /Grow the newsletter.*Active · 3 rounds/);
  assert.deepEqual(unnamed(m.body()), []);
  // A frame about someone else's work leaves the box being typed in alone; one about the member's own work repaints.
  const box = byKey(m.body(), 'ask:text');
  m.send({...STATE, tasks: [...STATE.tasks, {id: 't-ana-2', cat: 'mayor', text: 'Ana again', status: 'queued', by: 'p-ana'}]});
  assert.equal(byKey(m.body(), 'ask:text'), box);
  m.send({...STATE, approvals: STATE.approvals.filter(a => a.id !== 'a-owner-only')});
  assert.notEqual(byKey(m.body(), 'ask:text'), box);
  assert.equal(m.body().querySelector('li[data-id="a-owner-only"]'), null);
  m.send(STATE);
  requests[0].querySelector('button').click();
  assert.equal(m.win.location.hash, 'thread=t-open', 'app.js opens the thread from #thread=');
  assert.equal(m.view.dialog.open, false);
});

test('Ask the Mayor posts to the Mayor with the town’s reasoning and the goal switch; a refusal shows the server’s own sentence', async t => {
  let refuse = false;
  const m = mountMember({'POST /api/chat': () => refuse ? Object.assign(new Error('Members talk to the Mayor.'), {status: 403}) : {task: 't-new'}});
  t.after(() => m.doc.restore());
  m.send(STATE);
  await m.view.open();
  await settle();
  const form = () => m.body().querySelector('form');
  form().onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(posts(m.server), [], 'an empty message never posts');
  assert.match(m.body().textContent, /Write what you need first\./);
  const text = byKey(m.body(), 'ask:text');
  assert.equal(text.getAttribute('aria-label'), 'Message to the Mayor');
  text.value = 'Plan the launch'; text.oninput();
  const goal = byKey(m.body(), 'ask:goal');
  goal.checked = true; goal.onchange();
  form().onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(posts(m.server), [['POST', '/api/chat', {cat: 'mayor', text: 'Plan the launch', mode: 'demo', goal: true}]]);
  assert.match(m.body().textContent, /Sent as a goal\./);
  assert.equal(byKey(m.body(), 'ask:text').value, '', 'the box clears');
  refuse = true;
  byKey(m.body(), 'ask:text').value = 'Ask the Scout'; byKey(m.body(), 'ask:text').oninput();
  form().onsubmit({preventDefault() {}});
  await settle();
  assert.match(m.body().textContent, /Members talk to the Mayor\./);
  assert.equal(byKey(m.body(), 'ask:text').value, 'Ask the Scout', 'what was typed stays');
});

test('a member answers their own decision; one the server refuses says it waits for the owner', async t => {
  let refuse = false;
  const m = mountMember({'POST /api/approvals/a-mine': () => refuse ? Object.assign(new Error('This decision waits for the owner.'), {status: 403}) : {ok: true}});
  t.after(() => m.doc.restore());
  m.send(STATE);
  await m.view.open();
  await settle();
  refuse = true;
  buttonByText(m.body().querySelector('li[data-id="a-mine"]'), 'Deny').click();
  await settle();
  assert.deepEqual(posts(m.server), [['POST', '/api/approvals/a-mine', {answer: 'Deny', approved: false}]]);
  assert.match(m.body().querySelector('li[data-id="a-mine"]').textContent, /This decision waits for the owner\./);
  refuse = false;
  buttonByText(m.body().querySelector('li[data-id="a-mine"]'), 'Allow once').click();
  await settle();
  assert.deepEqual(posts(m.server).at(-1), ['POST', '/api/approvals/a-mine', {answer: 'Allow once', approved: true}]);
  assert.match(m.body().textContent, /Answered Scout: Allow once\./);
});

// ---- The account scope toggle (D14 a) ----

test('Accounts & connections shows who may use each account, owner-only by default, and the toggle puts the scope', async t => {
  assert.deepEqual(SCOPES.map(([s]) => s), ['owner', 'team']);
  assert.equal(scopeOf({}), 'owner');
  assert.equal(scopeOf({scope: 'team'}), 'team');
  assert.match(scopeLine('owner'), /Only you \(the default\)/);
  assert.match(scopeLine('team'), /work a team member starts may use this account/);
  const doc = fakeDocument(), win = fakeWindow();
  t.after(() => doc.restore());
  const linear = {id: 'linear', name: 'Linear', source: 'directory', enabled: true, status: 'connected', auth: 'signed-in', vars: [], cats: ['*'], tools: [], scope: 'owner', account: {status: 'connected', identity: {email: 'team@example.com'}}};
  const server = fakeServer({
    'GET /api/connectors': () => ({connectors: [linear], directory: [{id: 'linear', name: 'Linear', auth: 'oauth'}], cats: [{id: 'mayor', name: 'Mayor'}], builtins: {}, sites: []}),
    'GET /api/cat-browser': () => null, 'GET /api/models/status': () => null, 'GET /api/telegram': () => null, 'GET /api/discord': () => null,
    'PUT /api/accounts/linear/scope': body => { linear.scope = body.scope; return {id: 'linear', scope: body.scope}; },
  });
  const panel = createAccountsPanel({doc, win, fetchImpl: server.fetch, ask: async () => true});
  await panel.open();
  await settle();
  const row = () => panel.dialog.querySelector('li[data-id="linear"]');
  assert.equal(row().querySelector('p.ac-scope'), null, 'owner-only by default: no team line');
  byKey(row(), 'ac:linear:more').click();
  const group = row().querySelector('div.cx-seg');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(panel.dialog.querySelector(`[id="${group.getAttribute('aria-labelledby')}"]`).textContent, 'Who may use it');
  assert.deepEqual(group.querySelectorAll('button').map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['Only my work', 'true'], ['Team members too', 'false']]);
  assert.match(row().textContent, /Only you \(the default\)/);
  buttonByText(group, 'Team members too').click();
  await settle();
  assert.deepEqual(server.calls.filter(c => c[0] === 'PUT'), [['PUT', '/api/accounts/linear/scope', {scope: 'team'}]]);
  assert.equal(row().querySelector('p.ac-scope').textContent, 'Team members’ work may use it.');
  assert.deepEqual(row().querySelector('div.cx-seg').querySelectorAll('button').map(b => b.getAttribute('aria-pressed')), ['false', 'true']);
});

test('devices-status.js starts People; its stylesheet uses theme tokens only and hides the owner’s surfaces on a member’s page', () => {
  const entry = readFileSync(new URL('../public/devices-status.js', import.meta.url), 'utf8');
  assert.match(entry, /import \{initPeople\} from '\.\/people-panel\.js';/);
  assert.match(entry, /if\(globalThis\.document\?\.getElementById\?\.\('settings-devices'\)\)initPeople\(\);/);
  const css = readFileSync(new URL('../public/people-panel.css', import.meta.url), 'utf8');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css.replace(/#(toggle-quests|chat-form|worlds-button|treasury-button)\b/g, '')), false, 'theme tokens only, no raw colours');
  for (const id of ['#toggle-quests', '#chat-form', '#worlds-button', '#treasury-button', '.menu-row[data-category="worlds"]']) assert.ok(css.includes(id), id);
  assert.match(css, /body\.member :is\(/);
});

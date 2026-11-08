import test from 'node:test';
import assert from 'node:assert/strict';
import {signInPlan, planLine, pasteDraft, tokenLine, signInBox, PASTE_PATH} from '../public/connect-flow.js';
import {createQuestsPanel} from '../public/quests-panel.js';
import {fakeDocument, fakeServer, settle, buttonByText} from './fixtures/fake-dom-accounts.mjs';

test('a sign-in answer becomes one plan: callback, paste-back or a device code, and anything without a web page is nothing', () => {
  assert.deepEqual(signInPlan({url: 'https://mcp.linear.app/authorize?x=1', finish: 'callback'}), {finish: 'callback', url: 'https://mcp.linear.app/authorize?x=1'});
  assert.deepEqual(signInPlan({url: 'https://mcp.linear.app/authorize', finish: 'paste'}), {finish: 'paste', url: 'https://mcp.linear.app/authorize'});
  assert.deepEqual(signInPlan({url: 'https://github.com/login/device', finish: 'device', device: {userCode: 'WDJB-MJHT', expiresAt: 5}}), {finish: 'device', url: 'https://github.com/login/device', userCode: 'WDJB-MJHT', expiresAt: 5});
  assert.equal(signInPlan({url: 'https://x.test/d', finish: 'device', device: {userCode: '<b>'}}).finish, 'callback', 'an odd code is never shown');
  assert.equal(signInPlan({url: 'https://x.test/a'}).finish, 'callback');
  assert.equal(signInPlan({url: 'javascript:alert(1)', finish: 'paste'}), null);
  assert.equal(signInPlan(null), null);
});

test('each plan’s first line tells the owner what to do next', () => {
  assert.match(planLine({finish: 'device'}, 'GitHub'), /^Open the GitHub sign-in page and enter this code\. This updates by itself once you approve\.$/);
  assert.match(planLine({finish: 'paste'}, 'Linear'), /stops on a page that does not load\. Copy that whole address and paste it here\.$/);
  assert.equal(planLine({finish: 'callback'}, 'Notion'), 'The Notion sign-in page opened. Finish there; this updates by itself.');
  assert.match(planLine({finish: 'callback', opened: false}, 'Notion'), /^Your browser did not open the Notion sign-in page\./);
});

test('a pasted address must carry the sign-in code (or the service’s error) and the state', () => {
  assert.deepEqual(pasteDraft('  http://127.0.0.1:8787/api/connectors/oauth/callback?code=abc&state=xyz '), {body: {url: 'http://127.0.0.1:8787/api/connectors/oauth/callback?code=abc&state=xyz'}});
  assert.deepEqual(pasteDraft('http://127.0.0.1:8787/api/connectors/oauth/callback?error=access_denied&state=xyz'), {body: {url: 'http://127.0.0.1:8787/api/connectors/oauth/callback?error=access_denied&state=xyz'}});
  assert.match(pasteDraft('').error, /^Paste the address/);
  assert.match(pasteDraft('http://127.0.0.1:8787/api/connectors/oauth/callback?code=abc').error, /has no sign-in code/);
  assert.match(pasteDraft('http://127.0.0.1:8787/?barcode=1&state=2').error, /has no sign-in code/, 'barcode= is not code=');
  assert.match(pasteDraft('x'.repeat(4001)).error, /longer than a sign-in address/);
});

test('a pasted token reads as who it signs in as, the service’s reason, or that the check did not run', () => {
  assert.equal(tokenLine({status: 'connected', identity: '@octocat', reason: ''}, 'GitHub'), 'Signed in as @octocat.');
  assert.equal(tokenLine({status: 'expiring', identity: '@examplecat', reason: 'The sign-in ends in 5 days and cannot renew itself.'}), 'Signed in as @examplecat. The sign-in ends in 5 days and cannot renew itself.');
  assert.equal(tokenLine({status: 'wrong-account', identity: null, reason: 'Signed in as @a, not @b.'}), 'Signed in as @a, not @b.');
  assert.equal(tokenLine({status: 'unchecked', identity: null, reason: ''}, 'Composio'), 'Saved. Composio has no way to say who the token belongs to, so it is not checked.');
  assert.match(tokenLine(null, 'GitHub'), /^Saved\. Clowder could not reach GitHub to check who it signs in as/);
});

test('the paste box posts the address and says when the sign-in finished, or why not', async t => {
  const doc = fakeDocument();
  t.after(() => doc.restore());
  const server = fakeServer({[`POST ${PASTE_PATH}`]: body => (body.url.includes('state=good') ? {ok: true, name: 'Linear'} : Object.assign(new Error('Sign-in did not match a request from Clowder. Start sign-in again.'), {status: 409}))});
  const done = [];
  const box = signInBox({finish: 'paste', url: 'https://mcp.linear.app/authorize'}, {name: 'Linear', fetchImpl: server.fetch, onDone: name => done.push(name)});
  const input = box.querySelector('input.cf-paste-input'), form = box.querySelector('form.cf-paste'), msg = box.querySelector('.cx-msg');
  assert.equal(box.querySelector('a.cx-open').getAttribute('href'), 'https://mcp.linear.app/authorize');
  input.value = 'http://127.0.0.1/cb?code=1&state=stale';
  await form.onsubmit({preventDefault() {}});
  assert.equal(msg.textContent, 'Sign-in did not match a request from Clowder. Start sign-in again.');
  assert.equal(msg.classList.contains('bad'), true);
  input.value = 'http://127.0.0.1/cb?code=1&state=good';
  await form.onsubmit({preventDefault() {}});
  assert.equal(msg.textContent, 'Signed in to Linear.');
  assert.deepEqual(done, ['Linear']);
  assert.deepEqual(server.calls.map(c => c.slice(0, 2)), [['POST', PASTE_PATH], ['POST', PASTE_PATH]]);
  const device = signInBox({finish: 'device', url: 'https://github.com/login/device', userCode: 'WDJB-MJHT', expiresAt: Date.now() + 600_000}, {name: 'GitHub'});
  assert.equal(device.querySelector('.cf-code').textContent, 'WDJB-MJHT');
  assert.match(device.textContent, /The code works until /);
  assert.equal(device.querySelector('form'), null, 'nothing to paste for a device code');
});

// ---- Needs you on a phone (plan 1.6) ----

const at = '2026-11-07T10:00:00.000Z';
const step = (id, extra) => ({id: `owner-step:${id}`, rank: 'S', title: `Owner step: ${id}`, detail: 'A cat needs it.', at, source: {kind: 'owner-step', id}, action: {label: 'Mark done', panel: 'projects'}, needsYou: true, ...extra});
async function mountQuests(doc, quests, routes = {}, {phone = true} = {}) {
  const panel = doc.createElement('section'), body = doc.createElement('div'), status = doc.createElement('p'), badge = doc.createElement('span');
  panel.append(body, status, badge); doc.body.append(panel);
  const server = fakeServer({'GET /api/quests': () => quests(), 'GET /api/artifacts': () => ({artifacts: []}), ...routes});
  const q = createQuestsPanel({panel, body, status, badge, fetchImpl: server.fetch, onPhone: () => phone});
  await q.refresh();
  return {q, server, body, status, sheet: doc.body.querySelector('dialog.quest-sheet'), card: id => body.querySelectorAll('li.quest').find(n => n.dataset.id === id)};
}

test('Connect from the phone on Quick Tunnel opens the paste box in the step’s sheet, and the paste finishes the sign-in', async t => {
  const doc = fakeDocument();
  t.after(() => doc.restore());
  let open = true;
  const m = await mountQuests(doc, () => (open ? [step('s1', {connect: {id: 'linear', name: 'Linear'}})] : []), {
    'POST /api/owner-steps/s1/connect': () => ({ok: true, url: 'https://mcp.linear.app/authorize?x=1', finish: 'paste'}),
    [`POST ${PASTE_PATH}`]: () => { open = false; return {ok: true, name: 'Linear'}; },
  });
  buttonByText(m.card('owner-step:s1'), 'Connect Linear').click();
  await settle();
  assert.equal(m.sheet.open, true, 'the sheet holds the paste box');
  const box = m.sheet.querySelector('.cf-box');
  assert.equal(box.dataset.finish, 'paste');
  box.querySelector('input.cf-paste-input').value = 'http://127.0.0.1:8787/api/connectors/oauth/callback?code=c&state=s';
  await box.querySelector('form.cf-paste').onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(m.server.calls.find(c => c[1] === PASTE_PATH), ['POST', PASTE_PATH, {url: 'http://127.0.0.1:8787/api/connectors/oauth/callback?code=c&state=s'}]);
  assert.equal(m.card('owner-step:s1'), undefined, 'the finished step leaves the list');
});

test('a device-code sign-in shows the code in the sheet; when the server finishes it, the sheet says so', async t => {
  const doc = fakeDocument();
  t.after(() => doc.restore());
  let open = true;
  const m = await mountQuests(doc, () => (open ? [step('s2', {connect: {id: 'notion', name: 'Notion'}})] : []), {
    'POST /api/owner-steps/s2/connect': () => ({ok: true, url: 'https://www.notion.so/device', finish: 'device', device: {userCode: 'BDWP-HQPK', expiresAt: Date.now() + 900_000}}),
  });
  buttonByText(m.card('owner-step:s2'), 'Connect Notion').click();
  await settle();
  assert.equal(m.sheet.querySelector('.cf-code').textContent, 'BDWP-HQPK');
  open = false;
  await m.q.refresh();
  assert.equal(m.sheet.querySelector('.cf-code'), null, 'no stale code');
  assert.match(m.sheet.querySelector('.quest-sheet-msg').textContent, /Signed in\. This to-do is done\./);
});

test('a token pasted in a step says who it signs in as, and a 409 says why the service refused it', async t => {
  const doc = fakeDocument();
  t.after(() => doc.restore());
  let answer = {ok: true, account: {status: 'connected', identity: '@octocat', reason: ''}};
  const m = await mountQuests(doc, () => [step('s3', {connect: {id: 'github', name: 'GitHub', token: {url: 'https://github.com/settings/tokens/new', help: 'Make a token.'}}})], {
    'POST /api/owner-steps/s3/connect': () => answer,
  });
  buttonByText(m.card('owner-step:s3'), 'Connect GitHub').click();
  await settle();
  m.sheet.querySelector('.quest-token-input').value = 'ghp_ok';
  buttonByText(m.sheet, 'Connect GitHub').click();
  await settle();
  assert.deepEqual(m.server.calls.find(c => c[0] === 'POST'), ['POST', '/api/owner-steps/s3/connect', {token: 'ghp_ok'}]);
  assert.equal(m.sheet.querySelector('.quest-sheet-msg').textContent, 'Signed in as @octocat.');
  answer = Object.assign(new Error('Signed in as @someone, not @octocat.'), {status: 409});
  m.sheet.querySelector('.quest-token-input').value = 'ghp_other';
  buttonByText(m.sheet, 'Connect GitHub').click();
  await settle();
  assert.equal(m.sheet.querySelector('.quest-sheet-msg').textContent, 'Could not connect. Signed in as @someone, not @octocat.');
});

test('a quest that finishes only on the computer offers Continue on your computer on the phone, and the computer shows it came from there', async t => {
  const doc = fakeDocument();
  t.after(() => doc.restore());
  let handoff = null;
  const quests = () => [step('s4', {browser: true, url: 'https://x.com/login', computer: true, ...(handoff ? {handoff} : {})})];
  const m = await mountQuests(doc, quests, {'POST /api/quests/owner-step%3As4/handoff': () => { handoff = '2026-11-07T10:05:00.000Z'; return {ok: true}; }});
  const card = () => m.card('owner-step:s4');
  assert.equal(buttonByText(card(), 'Open the cats’ browser'), null, 'the phone cannot open the computer’s browser');
  buttonByText(card(), 'Continue on your computer').click();
  await settle();
  assert.deepEqual(m.server.calls.find(c => c[0] === 'POST').slice(0, 2), ['POST', '/api/quests/owner-step%3As4/handoff']);
  assert.equal(buttonByText(card(), 'Sent to your computer ✓').disabled, true);
  assert.equal(m.status.textContent, 'Sent to your computer. It waits at the top of Needs you there.');
  const host = await mountQuests(doc, quests, {}, {phone: false});
  assert.equal(buttonByText(host.card('owner-step:s4'), 'Continue on your computer'), null);
  assert.ok(buttonByText(host.card('owner-step:s4'), 'Open the cats’ browser'));
  assert.match(host.card('owner-step:s4').querySelector('.quest-sent').textContent, /^Sent from your phone .*\. Finish it here\.$/);
});

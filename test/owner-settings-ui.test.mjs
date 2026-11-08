import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {httpsLink, clientLine, clientDraft, entrySummary as clientsSummary, createOwnerClientsPanel, HOST_ONLY as CLIENTS_HOST_ONLY} from '../public/owner-clients-panel.js';
import {googleAccounts, watchLine, watchFacts, mailDraft, createMailWatchPanel} from '../public/mail-watch-panel.js';
import {subscribeParts, entrySummary as ntfySummary, createNtfyPanel, HOST_ONLY as NTFY_HOST_ONLY} from '../public/ntfy-panel.js';
import {setupGuide, publicClients, saveClient} from '../src/owner-clients.ts';
import {fakeDocument, fakeFetch, settle, button} from './fixtures/fake-dom.mjs';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Sign-in clients.
test('a saved client reads in one line; a Google client without its secret is not ready', () => {
  assert.deepEqual(clientLine('google', null), {tone: 'off', text: 'Not set up yet.'});
  const g = clientLine('google', {clientId: '123-abc.apps.googleusercontent.com', hasSecret: true, savedAt: Date.UTC(2026, 10, 7, 12)}, 'en-GB');
  assert.equal(g.tone, 'ok');
  assert.match(g.text, /^Ready: client 123-abc\.apps\.googleusercontent\.com, /);
  assert.match(g.text, /secret saved, saved 7 Nov 2026\.$/);
  assert.equal(clientLine('google', {clientId: 'x.apps.googleusercontent.com', hasSecret: false}).tone, 'warn');
  assert.match(clientLine('microsoft', {clientId: 'abc', hasSecret: false}).text, /tenant common/);
  assert.equal(httpsLink('javascript:alert(1)'), null);
  assert.equal(httpsLink('http://example.com'), null);
  assert.equal(httpsLink('https://console.cloud.google.com/projectcreate'), 'https://console.cloud.google.com/projectcreate');
  assert.equal(clientsSummary({google: {}, microsoft: null}), 'Google set up');
});

test('the client form makes the PUT body, and Google asks for its secret every time', () => {
  const gid = '1234-abcd.apps.googleusercontent.com', guid = '0b5f7c1e-1111-4a2b-9c3d-123456789abc';
  assert.deepEqual(clientDraft('google', {clientId: ` ${gid} `, clientSecret: ' GOCSPX-x '}), {body: {clientId: gid, clientSecret: 'GOCSPX-x'}});
  assert.match(clientDraft('google', {clientId: gid}).error, /secret too/);
  assert.match(clientDraft('google', {clientId: 'abc', clientSecret: 's'}).error, /apps\.googleusercontent\.com/);
  assert.match(clientDraft('google', {}).error, /client ID/);
  assert.deepEqual(clientDraft('microsoft', {clientId: guid}), {body: {clientId: guid}});
  assert.deepEqual(clientDraft('microsoft', {clientId: guid, tenant: 'consumers'}), {body: {clientId: guid, tenant: 'consumers'}});
  assert.match(clientDraft('microsoft', {clientId: 'nope'}).error, /00000000-/);
  assert.match(clientDraft('microsoft', {clientId: guid, tenant: 'a b'}).error, /tenant/);
});

test('the panel renders the server’s own steps, links, redirect and scopes, and saves to the host route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-clients-'));
  try {
    const guide = setupGuide(dir, 8787, {google: ['openid', 'https://www.googleapis.com/auth/gmail.modify'], microsoft: ['Mail.ReadWrite']});
    const doc = fakeDocument(), asked = [];
    const {fetchImpl, calls} = fakeFetch({
      'GET /api/owner-clients/setup': () => setupGuide(dir, 8787, {google: guide.google.scopes, microsoft: guide.microsoft.scopes}),
      'GET /api/owner-clients': () => ({clients: publicClients(dir)}),
      'PUT /api/owner-clients/google': body => { saveClient(dir, 'google', body); return {clients: publicClients(dir)}; },
      'DELETE /api/owner-clients/google': () => { saveClient(dir, 'google', null); return {clients: publicClients(dir)}; },
      'PUT /api/owner-clients/microsoft': {status: 403, body: {error: 'Sign-in clients are managed on the host computer.'}},
    });
    const panel = createOwnerClientsPanel({doc, win: {navigator: {}}, fetchImpl, ask: async o => { asked.push(o.title); return true; }});
    assert.equal(await panel.probe(), true);
    await panel.open();
    await settle();
    const d = panel.dialog;
    assert.deepEqual(d.querySelector('ol.op-steps').querySelectorAll('strong').map(n => n.textContent), guide.google.steps.map(s => s.title));
    assert.equal(d.querySelectorAll('a.cx-open').length, guide.google.steps.filter(s => s.link).length, 'one Open link per step that has one');
    assert.equal(d.querySelector('input.op-copy-input').value, 'http://127.0.0.1:8787/api/connectors/oauth/callback');
    assert.match(d.querySelector('details.op-more').textContent, /2 permissions.*gmail\.modify/);
    const form = d.querySelector('form.op-form');
    assert.equal(form.getAttribute('data-owner'), '');
    const [id, secret] = form.querySelectorAll('input');
    id.value = '42-x.apps.googleusercontent.com'; id.oninput();
    secret.value = 'GOCSPX-s'; secret.oninput();
    form.onsubmit({preventDefault() {}});
    await settle();
    assert.deepEqual(calls.find(c => c[0] === 'PUT'), ['PUT', '/api/owner-clients/google', {clientId: '42-x.apps.googleusercontent.com', clientSecret: 'GOCSPX-s'}]);
    assert.match(d.querySelector('.op-status').textContent, /^Ready: client 42-x\.apps\.googleusercontent\.com, secret saved/);
    assert.match(d.textContent, /Saved\. Add Google accounts in Connectors & plugins/);
    assert.equal(button(d, 'Google ✓').getAttribute('aria-pressed'), 'true');
    button(d, 'Remove').click();
    await settle();
    assert.deepEqual(asked, ['Remove your Google client?']);
    assert.ok(calls.some(c => c[0] === 'DELETE' && c[1] === '/api/owner-clients/google'));
    assert.match(d.querySelector('.op-status').textContent, /Not set up yet\./);
    // Microsoft: the redirect to register, a tenant field, and the host-only sentence away from the host.
    button(d, 'Microsoft').click();
    assert.equal(d.querySelector('input.op-copy-input').value, 'http://localhost/api/connectors/oauth/callback');
    const mf = d.querySelector('form.op-form'), [mid, tenant] = mf.querySelectorAll('input');
    assert.equal(tenant.getAttribute('aria-label'), 'Tenant');
    mid.value = '0b5f7c1e-1111-4a2b-9c3d-123456789abc'; mid.oninput();
    mf.onsubmit({preventDefault() {}});
    await settle();
    assert.match(d.querySelector('form.op-form').textContent, new RegExp(CLIENTS_HOST_ONLY));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// Email to the Mayor.
test('Google accounts are the connectors made from a google-client directory entry', () => {
  const data = {directory: [{id: 'google-workspace', client: 'google'}, {id: 'github'}],
    connectors: [{id: 'gw', name: 'Google Workspace · Work', entry: 'google-workspace', auth: 'signed-in'}, {id: 'gh', name: 'GitHub', entry: 'github', auth: 'signed-in'}, {id: 'custom', name: 'Mine'}]};
  assert.deepEqual(googleAccounts(data), [{id: 'gw', name: 'Google Workspace · Work', signedIn: true}]);
  assert.deepEqual(googleAccounts(null), []);
});

test('the watcher’s line, facts and form read plainly', () => {
  assert.deepEqual(watchLine({enabled: false}), {tone: 'off', text: 'Off. Clowder reads no mail.'});
  assert.deepEqual(watchLine({enabled: true, account: 'gw', label: 'Clowder'}, [{id: 'gw', name: 'Work'}]), {tone: 'ok', text: 'On. Watching the label “Clowder” in Work.'});
  assert.equal(watchLine({enabled: true, error: 'Gmail did not list the labels.'}).tone, 'error');
  const facts = Object.fromEntries(watchFacts({taken: 3, ignored: 1, lastPollAt: Date.parse('2026-11-07T11:58:00Z'), intervalSeconds: 120}, Date.parse('2026-11-07T12:00:00Z')));
  assert.deepEqual(facts, {'Sent to the Mayor': '3', Ignored: '1', 'Last checked': '2 min ago', Checks: 'Every 2 min'});
  assert.equal(Object.fromEntries(watchFacts({intervalSeconds: 45})).Checks, 'Every 45 s');
  assert.equal(Object.fromEntries(watchFacts({})).Checks, 'Every 10 min', 'no config: the server’s 600 s fallback');
  assert.deepEqual(mailDraft({account: 'gw', label: ' Clowder ', owners: 'me@example.com,\n you@example.org '}), {body: {account: 'gw', label: 'Clowder', owners: ['me@example.com', 'you@example.org']}});
  assert.deepEqual(mailDraft({account: 'gw', label: 'L', owners: ''}).body.owners, []);
  assert.match(mailDraft({label: 'L'}).error, /account/);
  assert.match(mailDraft({account: 'gw', label: ''}).error, /label/);
  assert.match(mailDraft({account: 'gw', label: 'L', owners: 'not-an-address'}).error, /not an email address/);
});

const connectors = {directory: [{id: 'google-workspace', client: 'google'}], connectors: [{id: 'gw', name: 'Google Workspace · Work', entry: 'google-workspace', auth: 'signed-in'}]};
async function mountMail(status, routes = {}) {
  const doc = fakeDocument(), opened = [];
  const {fetchImpl, calls} = fakeFetch({'GET /api/mail-watch': status, 'GET /api/connectors': connectors, 'PUT /api/mail-watch': body => ({...status, ...body, label: body.label ?? status.label}), ...routes});
  const panel = createMailWatchPanel({doc, win: {}, fetchImpl, now: () => Date.parse('2026-11-07T12:00:00Z'), openClients: () => opened.push('clients'), openConnectors: () => opened.push('connectors')});
  await panel.open();
  await settle();
  return {panel, dialog: panel.dialog, calls, opened};
}
const off = {enabled: false, account: null, label: null, owners: [], taken: 0, ignored: 0, lastPollAt: null, error: null, intervalSeconds: 120};

test('with no Google account the panel points to Sign-in clients and Connectors instead of a form', async () => {
  const {dialog, opened} = await mountMail(off, {'GET /api/connectors': {directory: [], connectors: []}});
  assert.equal(dialog.querySelector('form.op-form'), null);
  button(dialog, 'Set up sign-in clients').click();
  button(dialog, 'Open Connectors & plugins').click();
  assert.deepEqual(opened, ['clients', 'connectors']);
});

test('Save checks the form, then PUTs the account, label and addresses; the switch turns it on or shows the server’s reason', async () => {
  const {dialog, calls} = await mountMail(off);
  const form = dialog.querySelector('form.op-form');
  assert.equal(form.querySelector('select').value, 'gw', 'the signed-in account is chosen');
  form.onsubmit({preventDefault() {}});
  await settle();
  assert.match(dialog.querySelector('form.op-form').textContent, /Type the Gmail label/);
  assert.equal(calls.some(c => c[0] === 'PUT'), false);
  const label = dialog.querySelector('form.op-form').querySelector('input');
  label.value = 'Clowder'; label.oninput();
  dialog.querySelector('form.op-form').onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(calls.find(c => c[0] === 'PUT'), ['PUT', '/api/mail-watch', {account: 'gw', label: 'Clowder', owners: []}]);
  assert.match(dialog.textContent, /Saved\. Turn the switch on to start\./);

  const refused = await mountMail(off, {'PUT /api/mail-watch': {status: 400, body: {error: 'Pick the Google account and the Gmail label first.'}}});
  const sw = refused.dialog.querySelector('input[data-key="enabled"]');
  sw.checked = true; sw.onchange();
  await settle();
  assert.deepEqual(refused.calls.find(c => c[0] === 'PUT')[2], {enabled: true});
  assert.match(refused.dialog.textContent, /Pick the Google account and the Gmail label first\./);
  assert.equal(refused.dialog.querySelector('input[data-key="enabled"]').checked, false, 'the switch shows the server’s state, not the tap');
});

// Android ping.
test('a subscribe address splits into the topic and, off ntfy.sh, the server to add', () => {
  assert.deepEqual(subscribeParts('https://ntfy.sh/clowder-abc', 'https://ntfy.sh'), {topic: 'clowder-abc', server: 'https://ntfy.sh', otherServer: false});
  assert.deepEqual(subscribeParts('https://push.example.org/clowder-abc', 'https://push.example.org'), {topic: 'clowder-abc', server: 'https://push.example.org', otherServer: true});
  assert.equal(subscribeParts('nonsense').topic, '');
  assert.equal(ntfySummary([{enabled: true}, {enabled: false}]), '1 phone gets a ping when Clowder needs you');
});

async function mountNtfy(devices, routes = {}, answer = true) {
  const doc = fakeDocument(), asked = [], opened = [];
  let list = devices;
  const {fetchImpl, calls} = fakeFetch({
    'GET /api/ntfy': () => ({server: 'https://ntfy.sh', devices: list}),
    'POST /api/ntfy/devices/d1/enable': () => { list = list.map(d => (d.id === 'd1' ? {...d, enabled: true, url: 'https://ntfy.sh/clowder-xyz'} : d)); return {url: 'https://ntfy.sh/clowder-xyz'}; },
    'POST /api/ntfy/devices/d1/disable': () => { list = list.map(d => (d.id === 'd1' ? {id: d.id, name: d.name, enabled: false} : d)); return {removed: true}; },
    ...routes,
  });
  const panel = createNtfyPanel({doc, win: {navigator: {}}, fetchImpl, ask: async o => { asked.push(o.title); return answer; }, openDevices: () => opened.push('devices')});
  await panel.open();
  await settle();
  return {panel, dialog: panel.dialog, calls, asked, opened};
}

test('turning a phone on shows its private address to subscribe to; turning it off asks first', async () => {
  const {dialog, calls, asked} = await mountNtfy([{id: 'd1', name: 'Pixel 9', enabled: false}]);
  const sw = dialog.querySelector('input[data-key="d:d1"]');
  sw.checked = true; sw.onchange();
  await settle();
  assert.deepEqual(calls.find(c => c[0] === 'POST').slice(0, 2), ['POST', '/api/ntfy/devices/d1/enable']);
  assert.equal(dialog.querySelector('input.op-copy-input').value, 'https://ntfy.sh/clowder-xyz');
  assert.match(dialog.textContent, /enter the topic clowder-xyz/);
  assert.match(dialog.textContent, /Subscribe to the address above in ntfy now/);
  const on = dialog.querySelector('input[data-key="d:d1"]');
  on.checked = false; on.onchange();
  await settle();
  assert.deepEqual(asked, ['Stop pinging Pixel 9?']);
  assert.ok(calls.some(c => c[1] === '/api/ntfy/devices/d1/disable'));
  assert.equal(dialog.querySelector('input.op-copy-input'), null, 'the address is gone with the topic');
});

test('a no keeps pinging; no paired phone points to Devices; away from the host the panel says so', async () => {
  const kept = await mountNtfy([{id: 'd1', name: 'Pixel 9', enabled: true, url: 'https://ntfy.sh/clowder-xyz'}], {}, false);
  const sw = kept.dialog.querySelector('input[data-key="d:d1"]');
  sw.checked = false; sw.onchange();
  await settle();
  assert.equal(kept.calls.some(c => c[0] === 'POST'), false);
  assert.equal(kept.dialog.querySelector('input[data-key="d:d1"]').checked, true);

  const none = await mountNtfy([]);
  assert.match(none.dialog.textContent, /No phone is paired yet/);
  button(none.dialog, 'Open Devices').click();
  assert.deepEqual(none.opened, ['devices']);

  const away = await mountNtfy([], {'GET /api/ntfy': {status: 403, body: {error: 'x'}}});
  assert.equal(await away.panel.probe(), false);
  assert.match(away.dialog.textContent, new RegExp(NTFY_HOST_ONLY));
});

test('app.js adds the three entries to Devices & AI and to openSurface', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const ownerClientsPanel=initOwnerClientsPanel\(\);/);
  assert.match(app, /initMailWatchPanel\(\{openClients:\(\)=>openSurface\('clients'\),openConnectors:\(\)=>openSurface\('connectors'\)\}\)/);
  assert.match(app, /initNtfyPanel\(\{openDevices:\(\)=>openSurface\('devices'\)\}\)/);
  assert.match(app, /clients:\(\)=>void ownerClientsPanel\.open\(\),mail:\(\)=>void mailWatchPanel\.open\(\),ntfy:\(\)=>void ntfyPanel\.open\(\)/);
});

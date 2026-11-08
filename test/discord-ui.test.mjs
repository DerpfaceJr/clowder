import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {statusLine, createDiscordPanel, HOST_ONLY, PORTAL} from '../public/discord-panel.js';
import {fakeDocument, fakeServer, settle, byKey} from './fixtures/fake-dom-accounts.mjs';

test('the status line says where setup stands, in plain words', () => {
  assert.deepEqual(statusLine(null), {tone: 'off', text: 'Not set up'});
  assert.deepEqual(statusLine({configured: false}), {tone: 'off', text: 'Not set up'});
  assert.deepEqual(statusLine({configured: true, bot: 'mayor_bot', paired: false, connected: false, error: null}), {tone: 'warn', text: 'mayor_bot is not connected yet.'});
  assert.deepEqual(statusLine({configured: true, bot: 'mayor_bot', paired: false, connected: true, error: null}), {tone: 'warn', text: 'mayor_bot is online. Pair your DM next.'});
  assert.deepEqual(statusLine({configured: true, bot: 'mayor_bot', paired: true, connected: true, error: null}), {tone: 'ok', text: 'Paired with your DM on mayor_bot'});
  assert.deepEqual(statusLine({configured: true, bot: 'mayor_bot', paired: true, connected: false, error: null}), {tone: 'warn', text: 'Paired with mayor_bot, reconnecting to Discord…'});
  assert.deepEqual(statusLine({configured: true, bot: 'mayor_bot', paired: true, connected: false, error: 'Discord refused the bot token. Add it again.'}), {tone: 'error', text: 'Discord says: Discord refused the bot token. Add it again.'});
  assert.equal(PORTAL, 'https://discord.com/developers/applications');
});

function mount({status = {configured: false, bot: null, paired: false, connected: false, error: null}, denied = false, routes = {}, clock = () => Date.now()} = {}) {
  const doc = fakeDocument();
  const server = fakeServer({'GET /api/discord': (_, s) => (denied ? Object.assign(new Error(HOST_ONLY), {status: 403}) : s.status), ...routes});
  server.status = status;
  const asked = [], button = doc.createElement('button');
  button.hidden = true;
  const panel = createDiscordPanel({button, doc, win: {navigator: {}}, fetchImpl: server.fetch, now: clock, ask: async opts => { asked.push(opts.title); return true; }});
  return {doc, panel, server, asked, button, body: () => panel.dialog.querySelector('div.dc-body')};
}

test('the entry shows only where the host route answers', async t => {
  const host = mount();
  t.after(() => host.doc.restore());
  assert.equal(await host.panel.probe(), true);
  assert.equal(host.button.hidden, false);
  const phone = mount({denied: true});
  assert.equal(await phone.panel.probe(), false);
  assert.equal(phone.button.hidden, true);
  await phone.panel.open();
  assert.equal(phone.body().textContent, HOST_ONLY);
});

test('step 1 asks for the token, sends it trimmed, and keeps Discord’s reason by the box', async t => {
  const p = mount({routes: {'POST /api/discord/token': ({token}, s) => (token === 'good' ? (s.status = {configured: true, bot: 'mayor_bot', paired: false, connected: false, error: null}) : new Error('Paste the bot token from the Discord Developer Portal (Bot, Reset Token).'))}});
  t.after(() => p.doc.restore());
  await p.panel.open();
  assert.equal(p.body().querySelector('a.dc-open').getAttribute('href'), PORTAL);
  const form = () => p.body().querySelector('form.dc-token-form');
  await form().onsubmit({preventDefault() {}});
  assert.match(p.body().querySelector('.dc-token-box').textContent, /Paste the bot token from the Developer Portal\./);
  assert.equal(p.server.calls.some(c => c[0] === 'POST'), false, 'an empty box never posts');
  form().querySelector('input.dc-token').value = '  bad  ';
  await form().onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(p.server.calls.find(c => c[0] === 'POST'), ['POST', '/api/discord/token', {token: 'bad'}]);
  assert.match(p.body().querySelector('.dc-token-box').textContent, /Reset Token/);
  form().querySelector('input.dc-token').value = 'good';
  await form().onsubmit({preventDefault() {}});
  await settle();
  assert.match(p.body().textContent, /Saved\. Clowder now listens to mayor_bot\./);
  // Step 2 says how to reach the bot: a shared server or a user install. Step 3 gets the code.
  assert.match(p.body().textContent, /2 · Reach your bot/);
  assert.match(p.body().textContent, /Share a server with it/);
  assert.match(p.body().textContent, /install it to your account.*User Install.*Add to my apps/);
  assert.ok(byKey(p.body(), 'pair'));
});

test('step 3 shows the one-time code, pairs when the DM sends it, and then drops the reach step', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const p = mount({status: {configured: true, bot: 'mayor_bot', paired: false, connected: true, error: null}, routes: {'POST /api/discord/pair': () => ({code: 'K7Q2-M9XD', expiresAt: Date.now() + 600_000, bot: 'mayor_bot'})}});
  t.after(() => p.doc.restore());
  await p.panel.open();
  byKey(p.body(), 'pair').click();
  await settle();
  assert.equal(p.body().querySelector('p.dc-code').textContent, 'K7Q2-M9XD');
  assert.match(p.body().querySelector('.dc-code-box').textContent, /Send this code to mayor_bot in a direct message\. It works once, until /);
  p.server.status = {...p.server.status, paired: true};
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(p.body().querySelector('p.dc-code'), null, 'the code is gone once used');
  assert.match(p.body().textContent, /Paired with your DM on mayor_bot/);
  assert.match(p.body().textContent, /shows in Devices as Discord/);
  assert.doesNotMatch(p.body().textContent, /Reach your bot/);
});

test('a code that runs out says so, and closing the panel stops asking the server', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let clock = 1_000_000;
  const p = mount({status: {configured: true, bot: 'mayor_bot', paired: false, connected: true, error: null}, clock: () => clock, routes: {'POST /api/discord/pair': () => ({code: 'K7Q2', expiresAt: clock + 5000, bot: 'mayor_bot'})}});
  t.after(() => p.doc.restore());
  await p.panel.open();
  byKey(p.body(), 'pair').click();
  await settle();
  clock += 6000;
  t.mock.timers.tick(2000);
  await settle();
  assert.match(p.body().textContent, /The code ran out\. Get a new one to pair your DM\./);
  byKey(p.body(), 'pair').click();
  await settle();
  p.panel.close();
  const before = p.server.calls.length;
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(p.server.calls.length, before, 'no polling after close');
});

test('Remove asks first, then takes the token off this computer', async t => {
  const p = mount({status: {configured: true, bot: 'mayor_bot', paired: true, connected: true, error: null}, routes: {'POST /api/discord/remove': (_, s) => (s.status = {configured: false, bot: null, paired: false, connected: false, error: null})}});
  t.after(() => p.doc.restore());
  await p.panel.open();
  byKey(p.body(), 'remove').click();
  await settle();
  assert.deepEqual(p.asked, ['Remove Discord?']);
  assert.deepEqual(p.server.calls.filter(c => c[0] === 'POST').map(c => c[1]), ['/api/discord/remove']);
  assert.match(p.body().textContent, /Not set up/);
  assert.match(p.body().textContent, /Discord is removed\./);
});

test('☰ > Devices & AI links to Discord on the host only, right after Telegram, and app.js wires it', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, />Telegram<\/button><button id="discord-open" data-owner data-host hidden aria-haspopup="dialog" data-note="[^"]+">Discord<\/button>/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /const discordPanel=createDiscordPanel\(\{button:\$\('discord-open'\)\}\);\nvoid discordPanel\.probe\(\);/);
  assert.match(app, /discord:\(\)=>void discordPanel\.open\(\)/);
  const css = readFileSync(new URL('../public/discord-panel.css', import.meta.url), 'utf8');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css.replace(/#discord-dialog/g, '')), false, 'theme tokens only');
  assert.match(css, /#discord-dialog\{inset:0;width:100%;max-width:none;height:100dvh/, 'a full-screen page on phones');
});

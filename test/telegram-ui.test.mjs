import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {statusLine, startLink, untilText, createTelegramPanel, HOST_ONLY, BOTFATHER} from '../public/telegram-panel.js';

test('the status line says where setup stands, in plain words', () => {
  assert.deepEqual(statusLine({configured: false}), {tone: 'off', text: 'Not set up'});
  assert.deepEqual(statusLine(null), {tone: 'off', text: 'Not set up'});
  assert.deepEqual(statusLine({configured: true, bot: '@town_bot', paired: false, polling: true, error: null}), {tone: 'warn', text: '@town_bot is ready. Pair your chat next.'});
  assert.deepEqual(statusLine({configured: true, bot: '@town_bot', paired: true, polling: true, error: null}), {tone: 'ok', text: 'Paired with your chat on @town_bot'});
  assert.deepEqual(statusLine({configured: true, bot: '@town_bot', paired: true, polling: false, error: 'Telegram 401: Unauthorized'}), {tone: 'error', text: 'Telegram says: Telegram 401: Unauthorized'});
  assert.deepEqual(statusLine({configured: true, bot: '@town_bot', paired: false, polling: false, error: null}), {tone: 'warn', text: '@town_bot is not connected yet.'});
});

test('the Open in Telegram link starts the bot with the code; an odd name or code gives no link', () => {
  assert.equal(startLink('@clowder_town_bot', 'AB12-CD34-EF56-7890'), 'https://t.me/clowder_town_bot?start=AB12-CD34-EF56-7890');
  assert.equal(startLink('clowder_town_bot', 'ab12cd34'), 'https://t.me/clowder_town_bot?start=ab12cd34');
  assert.equal(startLink('@evil.example/x', 'AB12'), null);
  assert.equal(startLink('@clowder_town_bot', 'AB 12'), null);
  assert.equal(startLink(null, 'AB12'), null);
  assert.equal(BOTFATHER, 'https://t.me/BotFather');
});

test('a code’s end reads as a clock time, and an unreadable one as nothing', () => {
  assert.equal(untilText(Date.UTC(2026, 10, 7, 14, 5), 'en-GB').length > 0, true);
  assert.equal(untilText(undefined), '');
  assert.equal(untilText('soon'), '');
});

// A small stand-in for the browser DOM: enough for the panel to build its steps in Node. Selectors are one compound of a tag,
// classes and [attr] or [attr="value"] parts.
class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, ownText: '', disabled: false, value: ''});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return true; }
  click() { this.onclick?.({type: 'click'}); for (const fn of this.listeners.click ?? []) fn({type: 'click'}); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector);
    const own = this.className.split(/\s+/), classes = m[2].split('.').filter(Boolean), attrs = [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    return (!m[1] || this.tagName === m[1].toUpperCase()) && classes.every(c => own.includes(c)) && attrs.every(([, k, v]) => k in this.attributes && (v === undefined || this.attributes[k] === v));
  }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
function mount({status = {configured: false, bot: null, paired: false, polling: false, error: null}, code = 200, answers = {}, clock = () => Date.now()} = {}) {
  const doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  // projects-panel.js el() builds on the global document, as in the browser.
  globalThis.document = doc;
  const server = {status, code, calls: []};
  const fetchImpl = async (url, init = {}) => {
    server.calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : undefined]);
    if (server.code === 403) return {ok: false, status: 403, json: async () => ({error: 'Telegram is set up on the host computer.'})};
    const answer = init.method === 'POST' ? answers[url]?.(JSON.parse(init.body), server) : server.status;
    const failed = answer instanceof Error;
    return {ok: !failed, status: failed ? 400 : 200, json: async () => (failed ? {error: answer.message} : answer)};
  };
  const asked = [];
  const button = doc.createElement('button');
  button.hidden = true;
  const panel = createTelegramPanel({button, doc, win: {navigator: {}}, fetchImpl, now: clock, ask: async opts => { asked.push(opts.title); return true; }});
  return {doc, panel, server, asked, button, dialog: panel.dialog, body: () => panel.dialog.querySelector('div.tg-body')};
}
const byKey = (root, key) => root.querySelectorAll('[data-key]').find(n => n.dataset.key === key);
const before = globalThis.document;
test.after(() => { if (before === undefined) delete globalThis.document; else globalThis.document = before; });

test('the entry shows only where the host route answers', async () => {
  const host = mount();
  assert.equal(await host.panel.probe(), true);
  assert.equal(host.button.hidden, false);
  const phone = mount({code: 403});
  assert.equal(await phone.panel.probe(), false);
  assert.equal(phone.button.hidden, true);
  await phone.panel.open();
  assert.equal(phone.body().textContent, HOST_ONLY);
});

test('step 1 asks for the token, sends it as typed, and keeps the server’s reason by the box', async () => {
  const p = mount({answers: {'/api/telegram/token': ({token}) => (token === 'good:token' ? {configured: true, bot: '@town_bot', paired: false, polling: true, error: null} : new Error('Paste the token BotFather gave you.'))}});
  await p.panel.open();
  const form = p.body().querySelector('form.tg-token-form');
  assert.ok(p.body().querySelector('a.tg-open').getAttribute('href') === BOTFATHER, 'a full-size link to BotFather');
  await form.onsubmit({preventDefault() {}});
  assert.equal(p.body().querySelector('.tg-token-box').querySelector('.cx-msg').textContent, 'Paste the token BotFather gave you.', 'an empty box never posts');
  assert.equal(p.server.calls.some(c => c[0] === 'POST'), false);
  const again = p.body().querySelector('form.tg-token-form');
  again.querySelector('input.tg-token').value = '  12345:bad  ';
  await again.onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(p.server.calls.find(c => c[0] === 'POST'), ['POST', '/api/telegram/token', {token: '12345:bad'}]);
  assert.equal(p.body().querySelector('.tg-token-box').querySelector('.cx-msg').textContent, 'Paste the token BotFather gave you.');
  const third = p.body().querySelector('form.tg-token-form');
  third.querySelector('input.tg-token').value = 'good:token';
  await third.onsubmit({preventDefault() {}});
  await settle();
  assert.match(p.body().textContent, /Saved\. Clowder now listens to @town_bot\./);
  assert.ok(byKey(p.body(), 'pair'), 'step 2 appears once the bot is saved');
});

test('step 2 shows the one-time code with an Open in Telegram link, and pairs when the chat sends it', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const p = mount({status: {configured: true, bot: '@town_bot', paired: false, polling: true, error: null},
    answers: {'/api/telegram/pair': () => ({code: 'AB12-CD34-EF56-7890', expiresAt: Date.now() + 600_000, bot: '@town_bot'})}});
  await p.panel.open();
  byKey(p.body(), 'pair').click();
  await settle();
  assert.equal(p.body().querySelector('p.tg-code').textContent, 'AB12-CD34-EF56-7890');
  assert.equal(p.body().querySelector('a.tg-open').getAttribute('href'), 'https://t.me/town_bot?start=AB12-CD34-EF56-7890');
  assert.match(p.body().querySelector('.tg-code-box').textContent, /Send this code to @town_bot in Telegram.*It works once, until /);
  p.server.status = {...p.server.status, paired: true};
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(p.body().querySelector('p.tg-code'), null, 'the code is gone once used');
  assert.match(p.body().querySelector('.tg-status').textContent, /^Paired with your chat on @town_bot$/);
  assert.match(p.body().textContent, /Paired: your own chat with @town_bot\./);
  assert.match(p.body().textContent, /shows in Devices as Telegram/);
});

test('a code that runs out says so, and closing the panel stops asking the server', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let clock = 1_000_000;
  const p = mount({status: {configured: true, bot: '@town_bot', paired: false, polling: true, error: null}, clock: () => clock,
    answers: {'/api/telegram/pair': () => ({code: 'AB12-CD34-EF56-7890', expiresAt: clock + 5000, bot: '@town_bot'})}});
  await p.panel.open();
  byKey(p.body(), 'pair').click();
  await settle();
  clock += 6000;
  t.mock.timers.tick(2000);
  await settle();
  assert.match(p.body().textContent, /The code ran out\. Get a new one to pair your chat\./);
  byKey(p.body(), 'pair').click();
  await settle();
  p.dialog.close();
  const before = p.server.calls.length;
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(p.server.calls.length, before, 'no polling after close');
});

test('Remove asks first, then takes the token off this computer', async () => {
  const p = mount({status: {configured: true, bot: '@town_bot', paired: true, polling: true, error: null},
    answers: {'/api/telegram/remove': (_, server) => (server.status = {configured: false, bot: null, paired: false, polling: false, error: null})}});
  await p.panel.open();
  byKey(p.body(), 'remove').click();
  await settle();
  assert.deepEqual(p.asked, ['Remove Telegram?']);
  assert.deepEqual(p.server.calls.filter(c => c[0] === 'POST').map(c => c[1]), ['/api/telegram/remove']);
  assert.match(p.body().textContent, /Not set up/);
  assert.match(p.body().textContent, /Telegram is removed\./);
});

test('☰ > Devices & AI links to Telegram on the host only, and app.js wires it', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<section id="settings-devices"[^]*?<button id="telegram-open" data-owner data-host hidden aria-haspopup="dialog" data-note="[^"]+">Telegram<\/button>/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /const telegramPanel=createTelegramPanel\(\{button:\$\('telegram-open'\)\}\);\nvoid telegramPanel\.probe\(\);/);
  assert.match(app, /telegram:\(\)=>void telegramPanel\.open\(\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PROMPT_KEY, shouldPrompt, pushStatus, maybePromptNotifications} from '../public/notify-prompt.js';
import {approvalFromHash, approvalLink} from '../public/notify.js';

const pushable = {push: true, ios: false, needsInstall: false, note: ''};

test('the card is offered only to an owner device that can show notifications and does not get them yet', () => {
  const base = {support: pushable, permission: 'default', status: {subscribed: false}, hasSubscription: false, seen: false};
  assert.equal(shouldPrompt(base), true);
  assert.equal(shouldPrompt({...base, seen: true}), false, 'asked once already, whatever the answer');
  assert.equal(shouldPrompt({...base, status: null}), false, 'a viewer, or a server that refused');
  assert.equal(shouldPrompt({...base, permission: 'denied'}), false, 'blocked in the browser: only its settings undo that');
  assert.equal(shouldPrompt({...base, support: {...pushable, push: false}}), false, 'no push in this browser');
  assert.equal(shouldPrompt({...base, support: {...pushable, ios: true, needsInstall: true}}), false, 'iPhone before Add to Home Screen');
  assert.equal(shouldPrompt({...base, desktopApp: true}), false, 'the desktop app has no push service');
  assert.equal(shouldPrompt({...base, status: {subscribed: true}}), false, 'this device already gets them (another browser on it)');
  assert.equal(shouldPrompt({...base, hasSubscription: true, status: {subscribed: true, endpoint: true}}), false, 'this very browser is subscribed');
  assert.equal(shouldPrompt({...base, hasSubscription: true, status: {subscribed: true, endpoint: false}}), true, 'a subscription the server lost is offered again');
  assert.equal(shouldPrompt({...base, permission: 'granted'}), true, 'allowed but never subscribed still gets the card');
});

test('the status read sends this browser’s endpoint, and a refusal or an outage reads as null', async () => {
  const seen = [];
  const ok = async url => { seen.push(url); return {ok: true, json: async () => ({subscribed: false, endpoint: false, kinds: null})}; };
  assert.deepEqual(await pushStatus(ok, 'https://fcm.googleapis.com/fcm/send/a b'), {subscribed: false, endpoint: false, kinds: null});
  assert.equal(seen[0], '/api/push/status?endpoint=https%3A%2F%2Ffcm.googleapis.com%2Ffcm%2Fsend%2Fa%20b');
  await pushStatus(ok);
  assert.equal(seen[1], '/api/push/status');
  assert.equal(await pushStatus(async () => ({ok: false, status: 403, json: async () => ({})})), null);
  assert.equal(await pushStatus(async () => { throw new Error('offline'); }), null);
});

test('a notification’s link names its decision; anything else in the fragment is ignored', () => {
  assert.equal(approvalLink('a1-B_2'), '/#approval=a1-B_2');
  assert.equal(approvalFromHash('#approval=a1-B_2'), 'a1-B_2');
  assert.equal(approvalFromHash('approval=4802ef4a-e1aa-4c42-ad9d-b9ec30c2f936'), '4802ef4a-e1aa-4c42-ad9d-b9ec30c2f936');
  assert.equal(approvalFromHash(new URL(`https://town.example${approvalLink('x9')}`).hash), 'x9', 'the link survives a round trip');
  assert.equal(approvalFromHash('#pair=ABCD'), null);
  assert.equal(approvalFromHash('#approval=<script>'), null, 'only the server’s id characters');
  assert.equal(approvalFromHash(`#approval=${'a'.repeat(81)}`), null);
  assert.equal(approvalFromHash(''), null);
  assert.equal(approvalFromHash(undefined), null);
});

// A small stand-in for the page: storage, the browser's notification and push objects, and a body the card is appended to.
class Node {
  constructor(tag) { Object.assign(this, {tagName: tag.toUpperCase(), children: [], attributes: {}, className: '', textContent: '', hidden: false, disabled: false, parent: null}); }
  append(...nodes) { for (const n of nodes) { if (typeof n === 'object') n.parent = this; this.children.push(n); } }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  find(pred) { for (const c of this.children) { if (typeof c !== 'object') continue; if (pred(c)) return c; const deeper = c.find(pred); if (deeper) return deeper; } return null; }
  get dataset() { return this.attributes; }
}
function page({stored = null, storageThrows = false, permission = 'default', subscription = null, status = {subscribed: false, kinds: null}, statusCode = 200, blockers = 0} = {}) {
  const store = new Map(stored === null ? [] : [[PROMPT_KEY, stored]]);
  let open = blockers;
  const doc = {head: null, body: new Node('body'), createElement: tag => new Node(tag), querySelector: () => (open-- > 0 ? {} : null)};
  const calls = [];
  const win = {
    navigator: {userAgent: 'Mozilla/5.0 Chrome/140', serviceWorker: {ready: Promise.resolve({pushManager: {getSubscription: async () => subscription}})}},
    PushManager: function PushManager() {},
    Notification: {permission},
    get localStorage() { if (storageThrows) throw new Error('blocked'); return {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)}; },
  };
  // server: what GET /api/push/status answers now; a test changes it as the device subscribes.
  const server = {status, code: statusCode};
  const fetchImpl = async url => { calls.push(url); return {ok: server.code < 400, status: server.code, json: async () => server.status}; };
  return {doc, win, calls, store, server, fetchImpl, card: () => doc.body.find(n => n.className === 'notify-prompt')};
}
const button = (card, text) => card.find(n => n.tagName === 'BUTTON' && n.textContent === text);

test('the card shows on an owner device that does not get notifications, and Not now is remembered', async () => {
  const p = page();
  assert.equal(await maybePromptNotifications({controller: {}, win: p.win, doc: p.doc, fetchImpl: p.fetchImpl, wait: 1}), true);
  const card = p.card();
  assert.ok(card, 'the card is on the page');
  assert.equal(card.find(n => n.tagName === 'H2').textContent, 'Know when a cat needs you');
  assert.deepEqual(p.calls, ['/api/push/status']);
  button(card, 'Not now').onclick();
  assert.equal(p.card(), null, 'gone');
  assert.equal(p.store.get(PROMPT_KEY), 'later');
});

test('Turn on runs the existing subscribe flow and says so once the server lists this browser', async () => {
  const p = page();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/me';
  // notify.js enable(): the browser subscribes and the server records it for this device.
  const controller = {gesture() {}, enable: async () => {
    p.win.navigator.serviceWorker.ready = Promise.resolve({pushManager: {getSubscription: async () => ({endpoint})}});
    p.server.status = {subscribed: true, endpoint: true, kinds: {}};
    return 'Notifications are on.';
  }};
  await maybePromptNotifications({controller, win: p.win, doc: p.doc, fetchImpl: p.fetchImpl, wait: 1});
  const card = p.card();
  await button(card, 'Turn on').onclick();
  assert.equal(p.store.get(PROMPT_KEY), 'asked');
  assert.equal(p.calls.at(-1), `/api/push/status?endpoint=${encodeURIComponent(endpoint)}`, 'checked with this browser’s own subscription');
  assert.equal(card.find(n => n.className === 'notify-prompt-msg').textContent, 'Notifications are on for this device.');
  assert.equal(button(card, 'Turn on').hidden, true);
});

test('a refused Turn on leaves the reason on the card and a Close button', async () => {
  const p = page();
  await maybePromptNotifications({controller: {enable: async () => 'Notifications are blocked. Allow them in your browser or app settings, then try again.'}, win: p.win, doc: p.doc, fetchImpl: p.fetchImpl, wait: 1});
  const card = p.card();
  await button(card, 'Turn on').onclick();
  assert.match(card.find(n => n.className === 'notify-prompt-msg').textContent, /^Notifications are blocked/);
  const close = button(card, 'Close');
  assert.ok(close && !close.disabled);
  close.onclick();
  assert.equal(p.card(), null);
});

test('nothing is shown, and nothing is asked of the server, when the answer is already known', async () => {
  for (const [why, options] of [['asked before', {stored: 'later'}], ['storage blocked', {storageThrows: true}], ['blocked in the browser', {permission: 'denied'}]]) {
    const p = page(options);
    assert.equal(await maybePromptNotifications({controller: {}, win: p.win, doc: p.doc, fetchImpl: p.fetchImpl, wait: 1}), false, why);
    assert.deepEqual(p.calls, [], `${why}: no request`);
    assert.equal(p.card(), null);
  }
  for (const [why, options] of [['a viewer', {statusCode: 403}], ['already on for this device', {status: {subscribed: true, kinds: {}}}], ['this browser is on', {subscription: {endpoint: 'https://fcm.googleapis.com/x'}, status: {subscribed: true, endpoint: true}}]]) {
    const p = page(options);
    assert.equal(await maybePromptNotifications({controller: {}, win: p.win, doc: p.doc, fetchImpl: p.fetchImpl, wait: 1}), false, why);
    assert.equal(p.card(), null, why);
  }
});

test('the card waits while a dialog or the intro is open, then appears', async () => {
  const p = page({blockers: 3});
  assert.equal(await maybePromptNotifications({controller: {}, win: p.win, doc: p.doc, fetchImpl: p.fetchImpl, wait: 1}), true);
  assert.ok(p.card());
});

test('app.js opens a linked decision on load and on a fragment change, after the state loads, and offers notifications to owners', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /function takeApprovalLink\(\)\{const id=approvalFromHash\(location\.hash\);if\(!id\)return;wantedApproval=id;history\.replaceState\(null,'',location\.pathname\+location\.search\);openWantedApproval\(\);\}/);
  assert.match(app, /\ntakeApprovalLink\(\);\n/, 'read once on load');
  assert.match(app, /addEventListener\('hashchange',\(\)=>\{[^\n]*else takeApprovalLink\(\);\}\);/, 'and again when only the fragment changes');
  assert.match(app, /render\(\);openWantedApproval\(\);\}catch/, 'opened once the state is there');
  assert.match(app, /if\(openApprovalSheet\(id\)\)return;/);
  assert.match(app, /function offerNotifications\(\)\{if\(state&&!state\.readOnly\)void maybePromptNotifications\(\{controller:sound\}\);\}/);
  assert.match(app, /await refresh\(\);await ensureScene\(\);offerNotifications\(\);\}/, 'after the town loads');
  assert.match(app, /else offerNotifications\(\);\}catch\(error\)\{\$\('pair-error'\)/, 'and right after a phone pairs');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PREF_KINDS, PREF_STORAGE_KEY, buildSoundSettings, inAppNotices, initSound, itemNotices, linkFromHash, loadPrefs, noticeText, normalizePrefs, pushSupport, savePrefs, urlBase64ToBytes} from '../public/notify.js';
import {diffTownState, isCatChat, isMayorToOwner} from '../public/town-events.js';
import {PushService, questNotice} from '../src/push.ts';

const memory = () => {
  const data = new Map();
  return {data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v))};
};

const snapshot = (over = {}) => ({
  cats: [{id: 'mira', name: 'Mira'}],
  messages: [],
  approvals: [],
  ...over,
});

test('the first refresh is a baseline: history on the page never chimes or notifies', () => {
  const next = snapshot({messages: [{id: 'm1', from: 'mayor', to: 'owner', text: 'old'}], approvals: [{id: 'a1', cat: 'mira', question: 'old?', status: 'pending'}]});
  assert.deepEqual(diffTownState(undefined, next).messages, []);
  assert.deepEqual(diffTownState(undefined, next).approvals, []);
  assert.equal(diffTownState(undefined, next).baseline, true);
  assert.equal(diffTownState(next, undefined).baseline, true);
});

test('only new messages and newly pending approvals count as changes', () => {
  const prev = snapshot({messages: [{id: 'm1', from: 'mira', to: 'owner', text: 'hi'}], approvals: [{id: 'a1', cat: 'mira', question: 'q', status: 'pending'}]});
  const next = snapshot({
    messages: [...prev.messages, {id: 'm2', from: 'mayor', to: 'owner', text: 'Good morning'}, {id: 'm3', from: 'mira', to: 'bob', text: 'psst'}],
    approvals: [{id: 'a1', cat: 'mira', question: 'q', status: 'approved'}, {id: 'a2', cat: 'mira', question: 'new', status: 'pending'}],
  });
  const diff = diffTownState(prev, next);
  assert.equal(diff.baseline, false);
  assert.deepEqual(diff.messages.map(m => m.id), ['m2', 'm3']);
  assert.deepEqual(diff.approvals.map(a => a.id), ['a2']);
  assert.deepEqual(diffTownState(next, next).messages, []);
  assert.deepEqual(diffTownState(next, next).approvals, []);
});

test('message kinds: the Mayor to the owner, and cat to cat chatter', () => {
  assert.equal(isMayorToOwner({from: 'mayor', to: 'owner'}), true);
  assert.equal(isMayorToOwner({from: 'mira', to: 'owner'}), false);
  assert.equal(isCatChat({from: 'mira', to: 'bob'}), true);
  assert.equal(isCatChat({from: 'owner', to: 'mira'}), false);
  assert.equal(isCatChat({from: 'system', to: 'mira'}), false);
  assert.equal(isCatChat({from: 'town', to: 'mayor'}), false, 'a goal round is the town speaking, not cat chatter');
  assert.equal(isCatChat({from: 'mayor', to: 'town'}), false);
  assert.equal(isCatChat({from: 'mira', to: 'mira'}), false);
});

test('preferences default to on, reject non-booleans and survive storage failure', () => {
  assert.deepEqual(normalizePrefs(null), {approvals: true, mayor: true, seasons: true, routines: true, problems: true});
  assert.deepEqual(normalizePrefs({approvals: false, mayor: 'no', seasons: 0}), {approvals: false, mayor: true, seasons: true, routines: true, problems: true});
  const storage = memory();
  assert.deepEqual(savePrefs(storage, {approvals: false, mayor: true, seasons: false, problems: false}), {approvals: false, mayor: true, seasons: false, routines: true, problems: false});
  assert.deepEqual(loadPrefs(storage), {approvals: false, mayor: true, seasons: false, routines: true, problems: false});
  assert.ok(storage.data.has(PREF_STORAGE_KEY));
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  assert.deepEqual(loadPrefs(broken), {approvals: true, mayor: true, seasons: true, routines: true, problems: true});
  assert.doesNotThrow(() => savePrefs(broken, {approvals: false}));
  assert.deepEqual(PREF_KINDS, ['approvals', 'mayor', 'seasons', 'routines', 'problems']);
});

test('notice text is one line, free of control characters, and cut by code point', () => {
  assert.equal(noticeText('a\nb\u0007c‮d', 100), 'a b c d');
  assert.equal(noticeText('😺'.repeat(10), 5), '😺😺...');
  assert.equal(Array.from(noticeText('😺'.repeat(10), 5)).length, 5);
  assert.equal(noticeText(undefined, 10), '');
});

test('in-app Mayor notices match the server push, and a decision is left to the list (one notice, not two)', () => {
  const next = snapshot();
  const diff = {baseline: false, messages: [{id: 'm9', from: 'mayor', to: 'owner', text: 'Hello'}], approvals: [{id: 'a7', cat: 'mira', question: 'Plant the north field?'}]};
  assert.deepEqual(inAppNotices(diff, next, {approvals: true, mayor: true}), [{kind: 'mayor', title: 'Mayor', body: 'Hello', tag: 'mayor-m9', url: '/'}]);
  assert.deepEqual(inAppNotices(diff, next, {approvals: true, mayor: false}), []);
});

// Quests as /api/quests lists them (src/quests.ts): a to-do, a pending purchase and a decision in Needs you, a failed request in Trouble,
// a goal-removal suggestion and a finished project folded under Handled. Times at noon UTC.
const AT = '2026-11-09T12:00:00.000Z';
const item = (id, band, title, detail = '', needsYou = band === 'needs') => ({id, rank: 'S', title, detail, at: AT, source: {kind: id.split(':')[0], id: id.split(':').slice(1).join(':')}, action: {label: 'Open', panel: 'projects'}, needsYou, band});
const TODO = item('owner-step:s1', 'needs', 'Owner step: Sign the lease', 'Sign it at the office.');
const PURCHASE = item('purchase:p1', 'needs', 'Approve purchase: Acme 12.00 USD', 'Domain renewal');
const DECISION = item('approval:a7', 'needs', 'Plant the north field?');
const FAILED = item('project:r1', 'trouble', 'Write the launch post', 'The model stopped answering.', false);
const REMOVAL = item('approval:a8', 'handled', 'Remove the goal: Tidy the docs?', '', false);
const TURNED_IN = item('project:r2', 'handled', 'Old report', 'Turned in.', false);
const ON = {approvals: true, mayor: true, seasons: true, routines: true, problems: true};

test('list notices: text, tag and #item= link are the server push notice (11.10), for to-dos, payments, decisions and trouble', () => {
  const before = itemNotices(null, [], ON);
  assert.deepEqual(before.notices, [], 'the first list is a baseline');
  const {notices} = itemNotices(before.ids, [TODO, PURCHASE, DECISION, FAILED, REMOVAL, TURNED_IN], ON);
  assert.deepEqual(notices.map(n => n.tag), ['item-owner-step:s1', 'item-purchase:p1', 'item-approval:a7', 'item-project:r1'], 'Needs you and trouble only');
  for (const [q, notice] of [[TODO, notices[0]], [PURCHASE, notices[1]], [DECISION, notices[2]], [FAILED, notices[3]]]) {
    const pushed = questNotice(q);
    assert.deepEqual({title: notice.title, body: notice.body, url: notice.url, tag: notice.tag}, {title: pushed.title, body: pushed.body, url: pushed.url, tag: pushed.tag}, q.id);
  }
  assert.equal(notices[0].url, '/#item=owner-step%3As1');
  assert.deepEqual(linkFromHash(new URL(`https://town.example${notices[0].url}`).hash), {kind: 'item', id: 'owner-step:s1'}, 'the link opens the same item');
  assert.deepEqual(notices.map(n => n.kind), ['approvals', 'approvals', 'approvals', 'problems']);
  assert.deepEqual(itemNotices(before.ids, [TODO, FAILED], {...ON, problems: false}).notices.map(n => n.tag), ['item-owner-step:s1'], 'Problems off: no trouble notice');
  assert.deepEqual(itemNotices(before.ids, [TODO, FAILED], {...ON, approvals: false}).notices.map(n => n.tag), ['item-project:r1']);
});

test('list notices: each id once while listed, and again after it leaves and comes back', () => {
  let ids = itemNotices(null, [DECISION], ON).ids;
  const step = list => { const out = itemNotices(ids, list, ON); ids = out.ids; return out.notices.map(n => n.tag); };
  assert.deepEqual(step([DECISION, TODO]), ['item-owner-step:s1']);
  assert.deepEqual(step([DECISION, TODO]), []);
  assert.deepEqual(step([DECISION, {...TODO, title: 'Owner step: Sign the lease today'}]), [], 'an edit is not a new item');
  assert.deepEqual(step([DECISION]), []);
  assert.deepEqual(step([DECISION, TODO]), ['item-owner-step:s1'], 'back in the list (Remind me tomorrow, 11.18)');
  assert.deepEqual(step([DECISION, TODO, {...REMOVAL, band: 'needs', needsYou: true}]), ['item-approval:a8'], 'joining Needs you from Handled is new');
});

test('#item= links carry quest ids; #approval=, #thread= and #cat= keep their own', () => {
  assert.deepEqual(linkFromHash('#item=approval%3Aa1-B_2'), {kind: 'item', id: 'approval:a1-B_2'});
  assert.deepEqual(linkFromHash('#item=purchase:p.1'), {kind: 'item', id: 'purchase:p.1'});
  assert.deepEqual(linkFromHash('#item=x&approval=a1'), {kind: 'item', id: 'x'}, 'an item first');
  assert.deepEqual(linkFromHash('#approval=a1'), {kind: 'approval', id: 'a1'}, 'the older decision link still reads (app.js opens it as approval:a1)');
  assert.equal(linkFromHash('#item=%3Cscript%3E'), null);
  assert.equal(linkFromHash(`#item=${'a'.repeat(201)}`), null);
});

// A page for initSound: window and document are event targets; the service worker records each notice it is asked to show.
function fakePage({hidden = true} = {}) {
  const shown = [], posts = [];
  const node = tag => ({tag, children: [], listeners: {}, append(...c) { this.children.push(...c); }, addEventListener(t, f) { this.listeners[t] = f; }});
  const doc = Object.assign(new EventTarget(), {hidden, createElement: node, getElementById: () => null});
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const sub = {toJSON: () => ({endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser', keys: {p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url')}})};
  const reg = {showNotification: async (title, options) => { shown.push({title, ...options}); }, pushManager: {getSubscription: async () => sub}};
  const win = Object.assign(new EventTarget(), {localStorage: memory(), Notification: {permission: 'granted'}});
  const nav = {serviceWorker: {ready: Promise.resolve(reg)}};
  const fetchImpl = async (path, init) => { posts.push({path, body: JSON.parse(init.body)}); return {ok: true, json: async () => ({})}; };
  const controller = initSound({win, doc, nav, fetchImpl, mountSettings: false});
  const send = (type, detail) => win.dispatchEvent(new CustomEvent(type, {detail}));
  const settle = () => new Promise(r => setTimeout(r, 0));
  return {doc, win, controller, shown, posts, send, settle};
}

test('a to-do filed while the page is hidden gives exactly one notice, opening its card', async () => {
  const page = fakePage();
  page.send('quest-list', [DECISION]);
  page.send('quest-list', [DECISION, TODO]);
  page.send('quest-list', [DECISION, TODO]);
  page.send('town-state', {prev: snapshot(), next: snapshot({approvals: [{id: 'a9', cat: 'mira', question: 'More seeds?', status: 'pending'}]})});
  await page.settle();
  assert.deepEqual(page.shown.map(n => [n.tag, n.body, n.data.url]), [['item-owner-step:s1', 'Needs you: Owner step: Sign the lease', '/#item=owner-step%3As1']]);
  const visible = fakePage({hidden: false});
  visible.send('quest-list', []);
  visible.send('quest-list', [TODO]);
  visible.doc.hidden = true;
  visible.send('quest-list', [TODO]);
  await visible.settle();
  assert.deepEqual(visible.shown, [], 'seen while the page was visible: not announced once it is hidden');
});

test('the Problems box round-trips to the push subscription kinds; Season results shows only with the coin economy on', async () => {
  const page = fakePage();
  const labels = root => (root.children ?? []).flatMap(c => [c.tag === 'span' ? c.textContent : null, ...labels(c)]).filter(Boolean);
  const find = (node, id) => (node.id === id ? node : (node.children ?? []).map(c => find(c, id)).find(Boolean));
  let root = buildSoundSettings(page.doc, page.controller);
  assert.ok(labels(root).includes('Problems (a request failed)'));
  assert.ok(!labels(root).includes('Season results'), 'economy unknown: hidden');
  page.send('town-state', {prev: undefined, next: snapshot({economy: {enabled: true}})});
  assert.ok(labels(buildSoundSettings(page.doc, page.controller)).includes('Season results'));
  page.send('town-state', {prev: undefined, next: snapshot({economy: {enabled: false}})});
  root = buildSoundSettings(page.doc, page.controller);
  assert.ok(!labels(root).includes('Season results'));
  const box = find(root, 'notify-problems');
  assert.equal(box.checked, true, 'on by default');
  box.checked = false;
  await box.listeners.change();
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].path, '/api/push/subscribe');
  assert.equal(page.posts[0].body.kinds.problems, false);
  assert.equal(page.posts[0].body.kinds.seasons, true, 'the hidden choice is kept');
  const dir = mkdtempSync(join(tmpdir(), 'notify-kinds-'));
  try {
    const service = new PushService({dataDir: dir, windowMs: 0, send: async () => 201});
    assert.deepEqual(service.subscribe(page.posts[0].body, 'this-browser').kinds, page.posts[0].body.kinds, 'the server keeps what the page sent');
    assert.deepEqual(service.status('this-browser', page.posts[0].body.endpoint).kinds, normalizePrefs({...ON, problems: false}));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('base64url keys decode to bytes for applicationServerKey', () => {
  assert.deepEqual([...urlBase64ToBytes('AQID')], [1, 2, 3]);
  assert.deepEqual([...urlBase64ToBytes('_-8')], [255, 239]);
});

test('iOS needs the home-screen install; other browsers do not', () => {
  const iphone = {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5};
  const safari = {matchMedia: () => ({matches: false}), navigator: {standalone: false}};
  const installed = {matchMedia: () => ({matches: true}), navigator: {standalone: false}};
  const nav = {...iphone, serviceWorker: {}};
  const hasPush = win => ({...win, PushManager: function () {}, Notification: function () {}});
  const notInstalled = pushSupport(hasPush(safari), nav);
  assert.equal(notInstalled.ios, true);
  assert.equal(notInstalled.needsInstall, true);
  assert.match(notInstalled.note, /Home Screen/);
  assert.equal(pushSupport(hasPush(installed), nav).needsInstall, false);
  const desktop = pushSupport(hasPush(installed), {userAgent: 'Windows NT 10.0', serviceWorker: {}});
  assert.equal(desktop.push, true);
  assert.equal(desktop.note, '');
  assert.equal(pushSupport({}, {userAgent: 'x'}).push, false);
});

test('the sound settings offer Interface sounds, Quiet and (only with a vibrator) Vibrate on tap, in plain words', async () => {
  const {buildSoundSettings} = await import('../public/notify.js');
  const {createAudio} = await import('../public/audio.js');
  const tree = {createElement: tag => ({tag, children: [], listeners: {}, append(...c) { this.children.push(...c); }, addEventListener(t, f) { this.listeners[t] = f; }})};
  const texts = node => [node.textContent, ...(node.children ?? []).flatMap(texts)].filter(Boolean);
  const build = nav => {
    const audio = createAudio({storage: {getItem: () => null, setItem() {}}});
    return {audio, root: buildSoundSettings(tree, {audio, nav, win: {}, prefs: {}, gesture() {}})};
  };
  const withBuzz = texts(build({vibrate() {}}).root), without = texts(build({}).root);
  for (const label of ['Interface sounds', 'Quiet (only decision chimes)']) assert.ok(withBuzz.includes(label) && without.includes(label), label);
  assert.ok(withBuzz.includes('Vibrate on tap (phone)'));
  assert.ok(!without.includes('Vibrate on tap (phone)'), 'hidden where there is no vibrator');
  const {audio, root} = build({vibrate() {}});
  const find = (node, id) => (node.id === id ? node : (node.children ?? []).map(c => find(c, id)).find(Boolean));
  assert.equal(find(root, 'sound-vibrate').checked, false, 'off by default');
  const quiet = find(root, 'sound-quiet');
  quiet.checked = true; quiet.listeners.change();
  assert.equal(audio.settings().quiet, true);
  const slider = find(root, 'sound-interface');
  slider.value = 25; slider.listeners.input();
  assert.equal(audio.settings().interface, 25);
});

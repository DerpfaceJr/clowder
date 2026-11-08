import test from 'node:test';
import assert from 'node:assert/strict';
import {PREF_KINDS, PREF_STORAGE_KEY, inAppNotices, loadPrefs, noticeText, normalizePrefs, pushSupport, savePrefs, urlBase64ToBytes} from '../public/notify.js';
import {diffTownState, isCatChat, isMayorToOwner} from '../public/town-events.js';

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
  assert.deepEqual(normalizePrefs(null), {approvals: true, mayor: true, seasons: true, routines: true});
  assert.deepEqual(normalizePrefs({approvals: false, mayor: 'no', seasons: 0}), {approvals: false, mayor: true, seasons: true, routines: true});
  const storage = memory();
  assert.deepEqual(savePrefs(storage, {approvals: false, mayor: true, seasons: false}), {approvals: false, mayor: true, seasons: false, routines: true});
  assert.deepEqual(loadPrefs(storage), {approvals: false, mayor: true, seasons: false, routines: true});
  assert.ok(storage.data.has(PREF_STORAGE_KEY));
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  assert.deepEqual(loadPrefs(broken), {approvals: true, mayor: true, seasons: true, routines: true});
  assert.doesNotThrow(() => savePrefs(broken, {approvals: false}));
  assert.deepEqual(PREF_KINDS, ['approvals', 'mayor', 'seasons', 'routines']);
});

test('notice text is one line, free of control characters, and cut by code point', () => {
  assert.equal(noticeText('a\nb\u0007c‮d', 100), 'a b c d');
  assert.equal(noticeText('😺'.repeat(10), 5), '😺😺...');
  assert.equal(Array.from(noticeText('😺'.repeat(10), 5)).length, 5);
  assert.equal(noticeText(undefined, 10), '');
});

test('in-app notices match the server push text and tags, and respect the checklist', () => {
  const next = snapshot();
  const diff = {baseline: false, messages: [{id: 'm9', from: 'mayor', to: 'owner', text: 'Hello'}], approvals: [{id: 'a7', cat: 'mira', question: 'Plant the north field?'}]};
  assert.deepEqual(inAppNotices(diff, next, {approvals: true, mayor: true, seasons: true}), [
    {kind: 'approvals', title: 'Clowder', body: 'Mira needs you: Plant the north field?', tag: 'approval-a7', url: '/#approval=a7'},
    {kind: 'mayor', title: 'Mayor', body: 'Hello', tag: 'mayor-m9', url: '/'},
  ]);
  assert.deepEqual(inAppNotices(diff, next, {approvals: false, mayor: true, seasons: true}).map(n => n.kind), ['mayor']);
  assert.deepEqual(inAppNotices(diff, next, {approvals: true, mayor: false, seasons: true}).map(n => n.kind), ['approvals']);
  assert.deepEqual(inAppNotices({baseline: true, messages: [], approvals: []}, next, {approvals: true, mayor: true, seasons: true}), []);
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

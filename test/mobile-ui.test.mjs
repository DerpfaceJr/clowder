import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nextSheetState, COMPACT_QUERY, PHONE_QUERY, LABEL_KEY, LABEL_MODES, normalizeLabelMode, readLabelMode, writeLabelMode, applyLabelMode} from '../public/mobile-ui.js';
import {confirmDialog} from '../public/dialogs.js';
import {registerSettingsSection} from '../public/settings-menu.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'immersive.css'), 'utf8');
const app = ['app.js', 'decision-strip.js', 'chat-thread.js'].map(f => readFileSync(join(root, f), 'utf8')).join('\n');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
// The ☰ menu is the one place for settings: everything between its opening and closing tags.
const menuStart = html.indexOf('<dialog id="town-menu"');
const menuEnd = html.indexOf('</dialog>', menuStart);
const menu = html.slice(menuStart, menuEnd);

test('a grip gesture decides the sheet: tap or swipe down closes, swipe up expands, small moves snap back', () => {
  assert.equal(nextSheetState('half', 2), 'closed', 'a tap closes');
  assert.equal(nextSheetState('full', -3), 'closed', 'a tap closes a full sheet too');
  assert.equal(nextSheetState('half', 120), 'closed', 'a long swipe down closes a half sheet');
  assert.equal(nextSheetState('full', 120), 'half', 'a swipe down from full drops to half');
  assert.equal(nextSheetState('half', -120), 'full', 'a swipe up expands to full');
  assert.equal(nextSheetState('full', -120), 'full', 'swiping up on full stays full');
  assert.equal(nextSheetState('half', 30), 'half', 'a short drag snaps back to the same size');
});

test('every settings control exists exactly once, inside the ☰ menu, in its section', () => {
  const moved = {
    'world-view-switch': 'settings-view', 'label-mode': 'settings-labels',
    'edit-town': 'settings-town', 'pause': 'settings-town', 'replay-visits': 'settings-town',
    'share': 'settings-devices', 'models-open': 'settings-devices', 'logout': 'settings-devices',
    'fullscreen': 'settings-screen',
  };
  for (const [id, section] of Object.entries(moved)) {
    assert.ok(ids.has(id), `${id} is in index.html`);
    assert.equal([...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length, 1, `${id} appears once`);
    const at = menu.indexOf(` id="${id}"`);
    assert.ok(at > 0, `${id} is inside the town menu`);
    assert.ok(menu.slice(0, at).includes(`id="${section}"`), `${id} sits in ${section}`);
    assert.ok(menu.slice(at).split('</section>')[0].includes(`id="${id}"`), `${id} is inside its own section`);
  }
  assert.ok(html.includes('id="town-menu"') && html.includes('id="menu-toggle"'), 'menu dialog and toggle exist');
  assert.ok(html.includes('aria-controls="town-menu"'), 'toggle points at the menu');
});

test('the ☰ menu lists the sections in order and leaves a container for the sound worker', () => {
  const order = ['settings-view', 'settings-labels', 'settings-town', 'settings-devices', 'settings-screen', 'settings-sound'];
  let last = -1;
  for (const id of order) {
    const at = menu.indexOf(`id="${id}"`);
    assert.ok(at > last, `${id} comes after the previous section`);
    last = at;
  }
  assert.match(menu, /<section id="settings-sound"[^>]*>(?:(?!<\/section>)[\s\S])*?<div class="menu-items"><\/div><\/section>/, 'settings-sound is an empty container');
  assert.match(menu, /data-world-view="dawn"[\s\S]*data-world-view="day"[\s\S]*data-world-view="sunset"[\s\S]*data-world-view="night"/, 'four times of day');
});

test('the left floating settings row is gone from the world view', () => {
  assert.ok(!html.includes('class="world-settings"'), 'no world settings row');
  const title = html.slice(html.indexOf('<div class="world-title">'), html.indexOf('<div id="canvas-wrap">'));
  assert.ok(!title.includes('view-switch') && !title.includes('edit-town'), 'nothing in the world title');
});

test('the menu toggle shows at every width', () => {
  assert.ok(!/min-width:1101px\)\{\.immersive \.menu-toggle\{display:none\}/.test(css), 'no desktop hide for ☰');
  assert.match(html, /<button id="menu-toggle"[^>]*aria-label="Town menu"/);
});

test('the dock keeps the panels that stay on the world view', () => {
  const dock = html.slice(html.indexOf('<nav class="town-dock"'), html.indexOf('</nav>', html.indexOf('<nav class="town-dock"')));
  const labels = [...dock.matchAll(/<span class="dock-label">([^<]+)<\/span>/g)].map(m => m[1]);
  // Six buttons show. Coins and Memorial stay in the markup, hidden: their surfaces open from the treasury and the ☰ menu.
  assert.deepEqual(labels, ['Cats', 'Chat', 'Projects', 'Needs you', 'Diary', 'Archive', 'Coins', 'Memorial']);
  assert.equal([...dock.matchAll(/<button id="[^"]+"[^>]*\shidden>/g)].length, 2, 'Coins and Memorial are hidden');
  for (const [, target] of dock.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(ids.has(target), `${target} exists`);
  for (const id of ['toggle-projects', 'toggle-quests', 'toggle-memorial']) {
    assert.equal([...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length, 1, `${id} appears once`);
    assert.ok(dock.includes(` id="${id}"`), `${id} is in the dock`);
    assert.ok(!menu.includes(` id="${id}"`), `${id} is no longer in the ☰ menu`);
  }
  assert.equal([...html.matchAll(/\sid="quests-badge"/g)].length, 1, 'quests badge appears once');
  assert.ok(dock.indexOf('id="quests-badge"') > dock.indexOf('id="toggle-quests"'), 'the needs-you badge sits on the Needs you button');
  assert.ok(dock.includes('id="decision-badge"') && dock.indexOf('id="decision-badge"') > dock.indexOf('id="toggle-inspector"'), 'the decision badge sits on Chat');
});

test('phones (up to 768px) scroll the dock sideways with snap, no scrollbar and edge fades', () => {
  const block = css.slice(css.indexOf('@media(max-width:768px)'), css.indexOf('@media(prefers-reduced-motion:no-preference)'));
  assert.ok(block.includes('.town-dock{') && block.includes('overflow-x:auto'), 'the dock scrolls sideways');
  assert.ok(block.includes('scroll-snap-type:x mandatory') && block.includes('scroll-snap-align:start'), 'the dock snaps');
  assert.ok(block.includes('scrollbar-width:none') && block.includes('::-webkit-scrollbar{display:none}'), 'no visible scrollbar');
  assert.match(block, /\.town-dock button\{[^}]*min-width:72px/, 'items keep a tap target');
  assert.ok(block.includes('[data-fade~=right]'), 'a fade shows more items to the right');
  assert.ok(app.includes("dataset.fade="), 'app.js sets the fade state from the scroll position');
});

test('the settings helper and confirm dialog are plain modules that can be imported without a DOM', () => {
  assert.equal(typeof registerSettingsSection, 'function');
  assert.equal(typeof confirmDialog, 'function');
});

test('no native confirm, alert or prompt is left in the client', () => {
  const files = readdirSync(root).filter(f => f.endsWith('.js'));
  const offenders = files.filter(f => /(?<![.\w])(confirm|alert|prompt)\s*\(/.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use confirmDialog from dialogs.js');
});

test('the approval sheet holds the full question, the options, a text field and both answers', () => {
  const sheet = html.slice(html.indexOf('<dialog id="approval-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="approval-dialog"')));
  for (const id of ['approval-question', 'approval-options', 'approval-custom', 'approval-send', 'approval-decline']) assert.ok(sheet.includes(`id="${id}"`), `${id} in the sheet`);
  assert.match(sheet, /<textarea id="approval-custom"[^>]*maxlength="2000"/);
  assert.match(sheet, />Send answer</);
  assert.match(sheet, />Decline</);
  assert.ok(app.includes("$('approvals').addEventListener('click'"), 'strips open the sheet');
  assert.ok(app.includes('declineApproval') && app.includes('confirmDialog'), 'Decline asks first');
});

test('camera controls keep accessible names and the phone hides only the zoom pair', () => {
  for (const id of ['zoom-out', 'zoom-in', 'reset-view', 'focus-home']) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`))[0];
    assert.match(tag, /aria-label="[^"]+"/, `${id} has aria-label`);
  }
  assert.match(css, /\.cam-zoom\{display:none\}/);
});

test('phone and tablet breakpoints, safe-area insets and reduced motion are wired in CSS', () => {
  assert.equal(COMPACT_QUERY, '(max-width:1100px)');
  assert.equal(PHONE_QUERY, '(max-width:599px)');
  assert.ok(css.includes('@media(max-width:599px)'), 'phone block');
  assert.ok(css.includes('env(safe-area-inset-bottom)'), 'bottom safe area');
  assert.ok(css.includes('prefers-reduced-motion:reduce'), 'reduced motion honoured');
  assert.ok(css.includes('body.immersive[data-labels=auto] .world-label:not(.selected):not([data-cat=mayor])'), 'phone shows only the selected cat and the Mayor');
});

test('app wiring uses the shared breakpoint and opens chat at full height', () => {
  assert.ok(!app.includes("max-width:800px"), 'no stale 800px breakpoint in app.js');
  assert.ok(app.includes("id==='inspector'?'full':'half'"), 'chat opens full on phones');
  assert.ok(app.includes("from './mobile-ui.js'"), 'imports the mobile module');
});

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }};
}
const blockedStorage = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }};

test('house names: unknown or missing values read as auto, and only a known mode is kept', () => {
  assert.deepEqual(LABEL_MODES, ['auto', 'on', 'off']);
  assert.equal(readLabelMode(memoryStorage()), 'auto', 'nothing stored');
  assert.equal(readLabelMode(memoryStorage({[LABEL_KEY]: 'loud'})), 'auto', 'unknown stored value');
  assert.equal(readLabelMode(blockedStorage), 'auto', 'blocked storage reads as auto');
  assert.equal(readLabelMode(null), 'auto', 'no storage at all');
  const s = memoryStorage();
  assert.equal(writeLabelMode(s, 'off'), 'off');
  assert.equal(readLabelMode(s), 'off', 'the choice survives a reload');
  assert.equal(writeLabelMode(s, '<b>'), 'auto', 'junk is not stored');
  assert.equal(s.map.get(LABEL_KEY), 'auto');
  assert.equal(writeLabelMode(blockedStorage, 'on'), 'on', 'a blocked write still applies for this page');
  assert.equal(normalizeLabelMode(undefined), 'auto');
});

test('house names map to one body attribute that the CSS keys on', () => {
  const body = {dataset: {}};
  assert.equal(applyLabelMode(body, 'on'), 'on');
  assert.equal(body.dataset.labels, 'on');
  assert.equal(applyLabelMode(body, 'bogus'), 'auto');
  assert.equal(body.dataset.labels, 'auto');
});

test('the House names switch lives in the menu and has CSS for each mode', () => {
  assert.ok(menu.slice(0, menu.indexOf('id="label-mode"')).includes('id="settings-labels"'), 'House names sits in its own menu section');
  const sw = html.match(/<div id="label-mode"[^>]*>[\s\S]*?<\/div>/)[0];
  for (const mode of LABEL_MODES) assert.ok(sw.includes(`data-label-mode="${mode}"`), `${mode} option`);
  assert.match(sw, /role="group" aria-label="House names"/);
  assert.match(css, /body\.immersive\[data-labels=off\] \.world-label:not\(\.selected\)/, 'off hides every label but the selected cat');
  assert.ok(css.includes('body.immersive[data-labels=auto] .world-label:not(.selected):not([data-cat=mayor])'), 'auto keeps the phone rule');
  assert.ok(app.includes("initHouseNames(document,$('label-mode'))"), 'app wires the switch');
});

test('Android browsers are offered the native app, but not inside it or on other phones', async () => {
  const {offersAndroidApp} = await import('../public/mobile-ui.js');
  assert.equal(offersAndroidApp('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131 Mobile'), true);
  assert.equal(offersAndroidApp('Mozilla/5.0 (Linux; Android 14; wv) Chrome/131 Mobile ClowderAndroid'), false);
  assert.equal(offersAndroidApp('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), false);
  assert.equal(offersAndroidApp(''), false);
});

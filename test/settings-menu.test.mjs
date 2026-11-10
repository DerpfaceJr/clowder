import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerSettingsSection, summarizeAppearance, summarizeTown, buildLine, STALE_BUILD_NOTICE, ROWS, openSettingsPage, MENU_NAME, closeLabel} from '../public/settings-menu.js';
import {townStatus} from '../public/manage.js';
import {soundSummary} from '../public/notify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = file => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const app = read('app.js');
const menuStart = html.indexOf('<dialog id="town-menu"');
const menu = html.slice(menuStart, html.indexOf('</dialog>', menuStart));

test('☰ is one flat list of seven device and app settings; Devices & AI is gone (menu-chat-mailman.md)', () => {
  assert.deepEqual([...ROWS], ['appearance', 'sound', 'screen', 'devices', 'models', 'worlds', 'backup']);
  const pages = [...menu.matchAll(/<section id="settings-(\w+)" class="menu-group menu-page"/g)].map(m => m[1]);
  assert.deepEqual(pages, ['appearance', 'town', 'devices', 'models', 'screen', 'sound'], 'the static pages; Worlds, Backups and the Mayor’s autonomy register theirs');
  assert.match(menu, /<nav id="settings-list" class="settings-list" aria-label="Settings categories"><\/nav>/);
  assert.match(menu, /id="settings-back"[^>]*aria-label="Back to settings"[^>]*hidden/, 'back control starts hidden');
  assert.ok(!html.includes('id="menu-devices"') && !html.includes('id="menu-devices-more"') && !html.includes('Devices &amp; AI'), 'the Devices & AI group is gone');
  const devices = menu.slice(menu.indexOf('<section id="settings-devices"'), menu.indexOf('<section id="settings-models"'));
  assert.deepEqual([...devices.matchAll(/<button id="([^"]+)"/g)].map(m => m[1]), ['share', 'step-up-open', 'logout'], 'Devices keeps pairing, the passkey and Unpair');
  assert.match(menu, /<section id="settings-models" class="menu-group menu-page" aria-labelledby="menu-models"><h3 id="menu-models">AI models<\/h3><div class="menu-items"><button id="models-open"/);
  for (const id of ['accounts-open', 'connectors-open', 'telegram-open', 'discord-open', 'menu-memorial-open', 'setup-open']) assert.ok(!menu.includes(`id="${id}"`), `${id} left ☰`);
  const js = read('settings-menu.js');
  assert.ok(!/registerSettingsSection\('(setup|memorial)'/.test(js), 'no Set up or Memorial row');
  for (const file of ['routines-panel.js', 'memory-panel.js', 'usage-panel.js']) assert.ok(!read(file).includes('registerSettingsSection'), `${file} adds no ☰ row`);
});

test('a page that is not a row opens on its own: the Town panel, the Mayor’s autonomy, and Backups from the chat', () => {
  const js = read('settings-menu.js');
  assert.match(js, /const rowPages = \(\) => ROWS\.map\(/, 'only ROWS are listed');
  assert.match(js, /menu\.querySelector\('#settings-back'\)\.hidden = !active \|\| direct;/, 'no Back on a page opened on its own');
  assert.match(js, /if \(!activePage\(\) \|\| direct\) return;/, 'and Escape closes it');
  assert.match(js, /return ROWS\.includes\(key\) \? key : null;/, 'the list never comes back on a page that is not a row');
  assert.equal(openSettingsPage('town'), false, 'nothing opens before the menu is wired');
  assert.match(app, /\$\('town-status'\)\.onclick=\(\)=>\{if\(!openSettingsPage\('town'\)\)\$\('menu-toggle'\)\.click\(\);\};/, 'the header status dot opens the Town panel');
  assert.match(app, /autonomy:\(\)=>openSettingsPage\('autonomy',\{over:'thread'\}\)/);
  assert.match(app, /backups:\(\)=>openSettingsPage\('backup',\{over:'thread'\}\)/);
  assert.match(read('manage.css'), /@media\(min-width:900px\)\{body\.immersive \.town-menu\[data-over=thread\]\{inset:0 0 0 auto\}\}/, 'from 900px it docks over the chat pane');
  assert.match(read('mobile-ui.js'), /menu\.dataset\?\.over !== 'thread'/, 'and does not fold the chat to its rail');
});

// docs/ux-ui-improvements.md row 5: a control is called what it opens. The real-browser proof is test/naming-setup-ui.test.mjs.
test('☰ is called Settings and opens Settings; the status dot says town controls and opens Town controls', () => {
  assert.equal(MENU_NAME, 'Settings');
  assert.match(html, /<button id="menu-toggle" class="menu-toggle" aria-haspopup="dialog" aria-controls="town-menu" aria-expanded="false" aria-label="Settings" title="Settings">/);
  assert.ok(!html.includes('Town menu'), 'the old name is gone from the page');
  assert.match(menu, /<h2 id="town-menu-title" tabindex="-1">Settings<\/h2>/);
  const js = read('settings-menu.js');
  assert.match(js, /menu\.querySelector\('#town-menu-title'\)\.textContent = active \? titleOf\(active\) : MENU_NAME;/);

  // The Town page is headed by the words the dot uses, in every state the dot offers to open it.
  const heading = /<section id="settings-town" class="menu-group menu-page" aria-labelledby="menu-town"><h3 id="menu-town">([^<]+)<\/h3>/.exec(menu)[1];
  assert.equal(heading, 'Town controls');
  assert.match(html, /id="town-status"[^>]*aria-controls="town-menu" aria-label="Town controls"/);
  for (const state of [{loaded: true}, {loaded: true, paused: true}, {loaded: true, connected: false, connection: 'Gate closed'}]) {
    assert.ok(townStatus(state).label.toLowerCase().includes(heading.toLowerCase()), `"${townStatus(state).label}" names ${heading}`);
  }

  // A page opened on its own closes under its own name; the list and its rows stay "settings".
  assert.equal(closeLabel('Town controls', true), 'Close Town controls');
  assert.equal(closeLabel('Mayor’s autonomy', true), 'Close Mayor’s autonomy');
  assert.equal(closeLabel('Appearance', false), 'Close settings', 'a row’s page is still inside Settings');
  assert.equal(closeLabel('', false), 'Close settings');
  assert.equal(closeLabel('', true), 'Close settings');
  assert.match(js, /menu\.querySelector\('\.menu-tools > \.close-x'\)\?\.setAttribute\('aria-label', closeLabel\(active \? titleOf\(active\) : '', direct\)\);/);
});

test('Appearance keeps the time-of-day and house-name switches as two subsections', () => {
  const page = menu.slice(menu.indexOf('id="settings-appearance"'), menu.indexOf('id="settings-town"'));
  assert.ok(page.includes('id="settings-view"') && page.includes('id="settings-labels"'));
  assert.ok(page.includes('id="world-view-switch"') && page.includes('id="label-mode"'));
});

test('rare and destructive actions sit under a More heading, and the new-world button is placed there', () => {
  assert.match(menu, /<section id="settings-more" class="menu-more"[^>]*><h4[^>]*>More<\/h4><div id="settings-more-items" class="menu-items"><\/div><\/section>/);
  assert.ok(app.includes("$('settings-more-items').append(newWorld)"), 'app.js puts Start new world under More');
  const devices = menu.slice(menu.indexOf('id="settings-devices"'), menu.indexOf('id="settings-models"'));
  assert.ok(devices.indexOf('id="logout"') > devices.indexOf('More'), 'Unpair sits under More');
});

test('row subtitles read the live values: appearance, town, sound', () => {
  assert.equal(summarizeAppearance('Day', 'on'), 'Day · House names on');
  assert.equal(summarizeAppearance(undefined, undefined), 'House names auto');
  assert.equal(summarizeTown({paused: true, editing: true}), 'Paused · Editing');
  assert.equal(summarizeTown(), 'Running');
  assert.equal(soundSummary({music: 35, muted: false}, 'granted'), 'Music 35% · notifications on');
  assert.equal(soundSummary({music: 0, muted: false}, 'denied'), 'Music off · notifications off');
  assert.equal(soundSummary({music: 80, muted: true}, 'default'), 'Music off · notifications off');
});

test('the running build reads as a short commit and when it started; a stale one adds the restart notice', () => {
  const now = Date.parse('2026-11-06T18:00:00.000Z');
  const sha = '20d9d216b9adc194279e7b7b3e714606774be645';
  assert.deepEqual(buildLine({commit: sha, startedAt: '2026-11-06T17:55:00.000Z', stale: false}, now), {text: 'Running build 20d9d21 · started 5 min ago', commit: sha, stale: false});
  assert.deepEqual(buildLine({commit: '20d9d21', startedAt: '2026-11-06T15:00:00.000Z', stale: true}, now), {text: 'Running build 20d9d21 · started 3 h ago', commit: '20d9d21', stale: true});
  assert.equal(STALE_BUILD_NOTICE, 'Newer code is on disk. Restart Clowder to run it.');
  assert.equal(buildLine({commit: sha, startedAt: '2026-11-06T17:00:00.000Z', stale: 'yes'}, now).stale, false, 'only true is stale');
});

test('a build with no commit or an unreadable start time says only what is known; no build info hides the line', () => {
  const now = Date.parse('2026-11-06T18:00:00.000Z');
  assert.equal(buildLine({commit: null, startedAt: '2026-11-06T17:59:50.000Z', stale: false}, now).text, 'Running build (commit unknown) · started just now');
  assert.equal(buildLine({commit: 'v0.1.0-local', startedAt: 'not a date', stale: false}, now).text, 'Running build v0.1.0-local');
  assert.equal(buildLine({commit: 'x'.repeat(60), startedAt: null}, now).text, `Running build ${'x'.repeat(23)}…`);
  for (const missing of [undefined, null, 'abc1234', 7]) assert.equal(buildLine(missing, now), null);
});

test('the build line sits under the category list, styled with the theme tokens only', () => {
  const menuJs = readFileSync(join(root, 'settings-menu.js'), 'utf8');
  const css = readFileSync(join(root, 'settings-menu.css'), 'utf8');
  assert.ok(menuJs.includes("menu.querySelector('#settings-list').after(buildBox)"));
  assert.ok(menuJs.includes("window.addEventListener('town-state'"), 'it reads each refreshed state');
  const rules = css.split('\n').filter(line => line.startsWith('.settings-build'));
  assert.equal(rules.length, 3);
  for (const rule of rules) assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rule), `no raw colours: ${rule}`);
});

test('the menu stylesheet is linked, and the registration helper is exported', () => {
  assert.ok(html.includes('<link rel="stylesheet" href="/settings-menu.css">'));
  assert.equal(typeof registerSettingsSection, 'function');
});

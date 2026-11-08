import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerSettingsSection, summarizeAppearance, summarizeTown, buildLine, STALE_BUILD_NOTICE} from '../public/settings-menu.js';
import {soundSummary} from '../public/notify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const app = readFileSync(join(root, 'app.js'), 'utf8');
const menuStart = html.indexOf('<dialog id="town-menu"');
const menu = html.slice(menuStart, html.indexOf('</dialog>', menuStart));

test('the menu opens on a short list: one page per category, each a top-level .menu-page', () => {
  const pages = [...menu.matchAll(/<section id="settings-(\w+)" class="menu-group menu-page"/g)].map(m => m[1]);
  assert.deepEqual(pages, ['appearance', 'town', 'devices', 'screen', 'sound']);
  assert.match(menu, /<nav id="settings-list" class="settings-list" aria-label="Settings categories"><\/nav>/);
  assert.match(menu, /id="settings-back"[^>]*aria-label="Back to settings"[^>]*hidden/, 'back control starts hidden');
});

test('Appearance keeps the time-of-day and house-name switches as two subsections', () => {
  const page = menu.slice(menu.indexOf('id="settings-appearance"'), menu.indexOf('id="settings-town"'));
  assert.ok(page.includes('id="settings-view"') && page.includes('id="settings-labels"'));
  assert.ok(page.includes('id="world-view-switch"') && page.includes('id="label-mode"'));
});

test('rare and destructive actions sit under a More heading, and the new-world button is placed there', () => {
  assert.match(menu, /<section id="settings-more" class="menu-more"[^>]*><h4[^>]*>More<\/h4><div id="settings-more-items" class="menu-items"><\/div><\/section>/);
  assert.ok(app.includes("$('settings-more-items').append(newWorld)"), 'app.js puts Start new world under More');
  const devices = menu.slice(menu.indexOf('id="settings-devices"'), menu.indexOf('id="settings-screen"'));
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

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {settingsOpenAfter, escapeClosesSettings, settingsTitle, PHONE_SHEET_QUERY} from '../public/cat-settings-flyout.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = file => readFileSync(join(root, file), 'utf8');
const html = read('index.html');
const css = read('immersive.css');
const app = read('app.js');
const flyoutSource = read('cat-settings-flyout.js');

test('open and close state: Settings toggles, × / back / save close, unknown events keep the state', () => {
  assert.equal(settingsOpenAfter(false, 'toggle'), true, 'Settings opens');
  assert.equal(settingsOpenAfter(true, 'toggle'), false, 'clicking Settings again closes');
  assert.equal(settingsOpenAfter(true, 'close'), false, '× and back close');
  assert.equal(settingsOpenAfter(true, 'escape'), false, 'Esc closes');
  assert.equal(settingsOpenAfter(true, 'save'), false, 'a saved change closes');
  assert.equal(settingsOpenAfter(false, 'open'), true);
  assert.equal(settingsOpenAfter(true, 'something-else'), true, 'an unknown event changes nothing');
});

test('Esc closes only an open flyout, and only on the Escape key', () => {
  assert.equal(escapeClosesSettings(true, 'Escape'), true);
  assert.equal(escapeClosesSettings(false, 'Escape'), false);
  assert.equal(escapeClosesSettings(true, 'Enter'), false);
});

test('the header reads "<Cat>\'s settings" and the phone breakpoint is 767px', () => {
  assert.equal(settingsTitle('Miso'), 'Miso’s settings');
  assert.equal(settingsTitle(''), 'Cat’s settings');
  assert.equal(PHONE_SHEET_QUERY, '(max-width:767px)');
});

test('the settings nodes move into the flyout: the module moves the body and never clones it', () => {
  assert.match(flyoutSource, /flyout\.append\(body\)/);
  assert.match(flyoutSource, /body\.append\(suggestion\)/, 'the Mayor suggestion is the last section');
  assert.doesNotMatch(flyoutSource, /cloneNode|innerHTML\s*=\s*[^;]*settings-body/);
});

test('each settings control has one id in the page, so nothing is duplicated when it moves', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(duplicates)], [], 'no duplicate ids in index.html');
  for (const id of ['customize', 'mode', 'mode-note', 'cat-ai', 'cat-ai-provider', 'cat-ai-model', 'cat-ai-effort', 'cat-ai-save', 'cat-ai-error']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} appears once`);
  }
  assert.match(html, /<details class="chat-settings" data-owner><summary>Settings<\/summary><div class="settings-body">/, 'the controls start inside the Settings disclosure, which the module moves');
});

test('the save flow closes the flyout instead of reaching into a details element that no longer holds the controls', () => {
  assert.doesNotMatch(app, /closest\('details'\)/);
  assert.match(app, /catSettings\?\.close\(\)/);
  assert.match(app, /catSettings\?\.setCatName\(cat\.name\)/);
  assert.match(app, /import \{initCatSettingsFlyout\} from '\.\/cat-settings-flyout\.js'/);
});

test('CSS: the flyout hides with [hidden], covers the chat panel on wider screens, and is a bottom sheet on phones', () => {
  assert.match(css, /\.cat-settings-flyout\[hidden\]\{display:none\}/);
  assert.match(css, /\.cat-settings-flyout\{position:absolute;inset:0;/, 'inside the chat panel, covering it');
  assert.match(css, /@media\(max-width:767px\)\{\s*\.cat-settings-flyout\{position:fixed;[^}]*inset:auto 0 var\(--dock-stack\) 0;/, 'a bottom sheet above the dock on phones');
  assert.match(css, /body\.immersive:has\(#inspector-panel\[hidden\]\) #cat-settings-flyout/);
  assert.doesNotMatch(css, /\.immersive \.inspector \.settings-body/, 'the old overlay rules are gone');
});

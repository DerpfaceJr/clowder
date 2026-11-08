import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'immersive.css'), 'utf8');
const panels = ['residents', 'inspector', 'diary', 'season', 'projects', 'quests'];

test('every side panel shares one header row: a title, then the panel-close button', () => {
  const headers = [...html.matchAll(/<div class="panel-tools"><span>[^<]*<\/span><button class="panel-close" data-collapse="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual([...headers].sort(), [...panels].sort());
});

test('each scrolling side panel keeps its scroll in one .panel-body inside a clipped shell', () => {
  assert.equal(html.match(/class="panel-body"/g).length, 5, 'residents, diary, season, projects and quests');
  assert.match(css, /\.immersive \.panel-body\{flex:1 1 auto;min-height:0;overflow-y:auto/);
  assert.match(css, /\.immersive :is\(\.residents,\.inspector,\.season,\.memorial,\.activity,\.projects,\.quests\)\{overflow:hidden\}/);
});

test('Cats and Diary share a left column on desktop, and the diary has a bounded height', () => {
  assert.match(css, /--diary-h:min\(220px,34dvh\)/);
  assert.match(css, /main:has\(#diary-panel:not\(\[hidden\]\)\) \.residents\{bottom:calc\(88px \+ var\(--diary-h\) \+ 12px\)\}/);
});

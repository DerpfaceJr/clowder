import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  KINDS, groupByKind, byText, pageMeta, lineParts, bodyLines, shownLine, sourceLabel, sourceSummary, organiseText, editDraft, rowSummary, kindLabel,
  createMemoryPanel, DENIED,
} from '../public/memory-panel.js';
import {wikiLines} from '../src/memory.ts';
import {fakeDocument, fakeFetch, settle, button} from './fixtures/fake-dom.mjs';

test('pages group by kind in the order people, projects, topics, preferences; an unknown kind reads as a topic', () => {
  const pages = [{slug: 'a', kind: 'topic'}, {slug: 'b', kind: 'person'}, {slug: 'c', kind: 'project'}, {slug: 'd', kind: 'odd'}, {slug: 'e', kind: 'preference'}];
  assert.deepEqual(groupByKind(pages).map(g => [g.kind, g.pages.map(p => p.slug)]), [['person', ['b']], ['project', ['c']], ['topic', ['a', 'd']], ['preference', ['e']]]);
  assert.deepEqual(groupByKind([]), []);
  assert.deepEqual(KINDS.map(k => k[0]), ['person', 'project', 'topic', 'preference'], 'the server’s four kinds (wiki.ts KINDS)');
  assert.equal(kindLabel('person'), 'Person');
});

test('a row says how long the page is and who last wrote it, in plain words', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(pageMeta({lines: 12, updated: '2026-11-07T09:00:00Z', by: 'owner'}, now), '12 lines · updated 3 h ago by you');
  assert.equal(pageMeta({lines: 1, updated: '2026-11-07T11:58:00Z', by: 'organiser'}, now), '1 line · updated 2 min ago by the organiser');
  assert.equal(byText('archivist'), 'archivist');
});

test('a line splits into text and [[page]] links, and lines split as the server splits them', () => {
  assert.deepEqual(lineParts('Related: [[daily-tower]], [[instagram]]'), [{text: 'Related: '}, {link: 'daily-tower'}, {text: ', '}, {link: 'instagram'}]);
  assert.deepEqual(lineParts('no links'), [{text: 'no links'}]);
  assert.deepEqual(lineParts('[[Not A Slug]]'), [{text: '[[Not A Slug]]'}], 'only real page names link');
  const body = '  - one\n\n- two  \n three';
  assert.deepEqual(bodyLines(body), wikiLines(body), 'owner-line marks match the server’s line list');
  assert.equal(shownLine('- (2026-11-02) Daily Tower: posted'), '(2026-11-02) Daily Tower: posted');
});

test('sources read as notes and tasks with short ids', () => {
  assert.deepEqual(sourceLabel('note:3f2a9c1d-aaaa'), {kind: 'note', id: '3f2a9c1d-aaaa', label: 'Note 3f2a9c1d'});
  assert.equal(sourceLabel('task:t1').label, 'Task t1');
  assert.equal(sourceSummary(['note:a', 'note:b', 'task:c']), 'Built from 2 notes and 1 task.');
  assert.equal(sourceSummary([]), 'No sources: you wrote this page.');
});

test('Organise reports what it filed; the edit form makes the PUT body or names the problem', () => {
  assert.equal(organiseText({notes: 0}), 'Every note is already on a page.');
  assert.equal(organiseText({notes: 12, pages: 3, created: 1, duplicates: 2}), 'Filed 12 notes into 3 pages, 1 new page. 2 possible duplicates flagged for you.');
  assert.deepEqual(editDraft({title: ' Sam ', kind: 'person', body: 'a\r\nb'}), {body: {title: 'Sam', kind: 'person', body: 'a\nb'}});
  assert.match(editDraft({title: 'x', kind: 'topic', body: ' \n '}).error, /Forget/);
  assert.match(editDraft({title: 'x'.repeat(121), body: 'a'}).error, /120/);
  assert.equal(editDraft({body: 'a', kind: 'nope'}).body.kind, 'topic');
  assert.equal(rowSummary([], false), 'What the cats know');
  assert.equal(rowSummary([{}, {}], true), '2 pages the cats read');
});

const pages = [
  {slug: 'sam', title: 'Sam', kind: 'person', updated: '2026-11-07T10:00:00Z', by: 'owner', lines: 1, owner: true, duplicates: 0},
  {slug: 'daily-tower', title: 'Daily Tower', kind: 'project', updated: '2026-11-07T09:00:00Z', by: 'organiser', lines: 3, owner: false, duplicates: 1},
  {slug: 'daily-tower-3d', title: 'Daily Tower 3D', kind: 'project', updated: '2026-11-06T09:00:00Z', by: 'organiser', lines: 1, owner: false, duplicates: 0},
];
const tower = {slug: 'daily-tower', title: 'Daily Tower', kind: 'project', updated: '2026-11-07T09:00:00Z', by: 'organiser', sources: ['note:n1', 'note:n2', 'task:t1'],
  body: 'Related: [[sam]]\n- (2026-11-02) Daily Tower: posted each morning.\n- Posts go out at nine.', owner: ['- Posts go out at nine.'],
  duplicates: [{a: {id: 'note:n1', title: 'Daily Tower'}, b: {id: 'note:n2', title: 'Daily tower post'}}]};

async function mount(routes = {}, {answer = true} = {}) {
  const doc = fakeDocument(), asked = [], focused = [];
  const {fetchImpl, calls} = fakeFetch({
    'GET /api/wiki': (_, url) => (url.includes('?q=') ? {hits: [{...pages[1], snippet: 'posted each morning'}]} : {pages, suggestions: [{a: 'daily-tower', b: 'daily-tower-3d', score: 0.67}], forgotten: ['old-page'], notes: 9}),
    'GET /api/wiki/daily-tower': tower,
    'GET /api/wiki/sam': {...tower, slug: 'sam', title: 'Sam', kind: 'person', body: 'Sam reviews reels.', owner: [], duplicates: [], sources: []},
    'PUT /api/wiki/daily-tower': {ok: true},
    'POST /api/wiki/daily-tower/forget': {ok: true},
    'POST /api/wiki/merge': {ok: true},
    'POST /api/wiki/organise': {notes: 4, pages: 2, created: 1, duplicates: 0},
    ...routes,
  });
  const panel = createMemoryPanel({doc, win: {addEventListener() {}}, fetchImpl, now: () => Date.parse('2026-11-07T12:00:00Z'),
    ask: async opts => { asked.push(opts); return answer; },
    graph: async () => ({update() {}, focus: id => focused.push(id)})});
  await panel.open();
  await settle();
  return {panel, dialog: panel.dialog, calls, asked, focused};
}

test('the list leads with search and the kind filter, then the merge suggestion, the pages by kind, Organise and the forgotten pages', async () => {
  const {dialog} = await mount();
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('h2').textContent, 'Memory');
  assert.deepEqual(dialog.querySelector('.mp-kinds').querySelectorAll('button').map(b => b.textContent), ['All 3', 'People 1', 'Projects 2']);
  assert.match(dialog.querySelector('.mp-suggestions').textContent, /Daily Tower and Daily Tower 3D/);
  assert.deepEqual(dialog.querySelectorAll('section.mp-group').map(s => s.querySelector('h4').textContent), ['People · 1', 'Projects · 2']);
  const tower = dialog.querySelector('[data-slug="daily-tower"]');
  assert.match(tower.textContent, /1 possible duplicate/);
  assert.match(tower.textContent, /3 lines · updated 3 h ago by the organiser/);
  assert.match(dialog.querySelector('[data-slug="sam"]').textContent, /Has your lines/);
  assert.match(dialog.querySelector('.mp-organise').textContent, /9 notes remembered/);
  assert.match(dialog.querySelector('.mp-forgotten').textContent, /old-page/);
  button(dialog, 'People 1').click();
  assert.deepEqual(dialog.querySelectorAll('section.mp-group').map(s => s.querySelector('h4').textContent), ['People · 1']);
  assert.equal(dialog.querySelector('.mp-suggestions'), null, 'suggestions show with every kind only');
});

test('a search lists the matching pages with their snippet, and Clear goes back', async () => {
  const {dialog, calls} = await mount();
  const form = dialog.querySelector('form.mp-search');
  form.querySelector('input').value = 'morning tower';
  form.onsubmit({preventDefault() {}});
  await settle();
  assert.ok(calls.some(c => c[1] === '/api/wiki?q=morning%20tower'), 'the query goes to the server’s search');
  assert.match(dialog.querySelector('.mp-count').textContent, /1 page matches “morning tower”/);
  assert.match(dialog.querySelector('[data-slug="daily-tower"]').textContent, /posted each morning/);
  button(dialog, 'Clear search').click();
  assert.ok(dialog.querySelector('.mp-kinds'));
});

test('a page shows its lines with yours marked, its links, duplicates and sources; a note source opens the graph on it', async () => {
  const {dialog, focused} = await mount();
  dialog.querySelector('[data-slug="daily-tower"]').click();
  await settle();
  assert.equal(dialog.querySelector('h3').textContent, 'Daily Tower');
  const lines = dialog.querySelectorAll('li.mp-line');
  assert.equal(lines.length, 3);
  assert.equal(lines[2].className, 'mp-line mp-line-owner');
  assert.equal(lines[2].querySelector('.mp-you').textContent, 'You');
  assert.equal(lines[2].querySelector('.mp-text').textContent, 'Posts go out at nine.', 'the bullet is dropped for display');
  assert.equal(lines[1].querySelector('.mp-you'), null);
  assert.equal(lines[0].querySelector('button.mp-link').textContent, 'Sam', 'a [[link]] reads as the page’s title');
  assert.match(dialog.querySelector('.mp-dupes').textContent, /Daily Tower ~ Daily tower post/);
  assert.match(dialog.querySelector('.mp-sources').textContent, /Built from 2 notes and 1 task\./);
  button(dialog, 'Show in graph').click();
  await settle();
  assert.deepEqual(focused, ['note:n1']);
  assert.equal(dialog.querySelector('.mp-graph').hidden, false);
  assert.equal(dialog.querySelector('.mp-main').hidden, true);
});

test('Edit saves with PUT, keeps the typed text through a repaint, and opens the saved page again', async () => {
  const {dialog, calls} = await mount();
  dialog.querySelector('[data-slug="daily-tower"]').click();
  await settle();
  button(dialog, 'Edit').click();
  const text = dialog.querySelector('textarea');
  assert.equal(text.value, 'Related: [[sam]]\n- (2026-11-02) Daily Tower: posted each morning.\n- Posts go out at nine.');
  text.value = 'Posts go out at ten.'; text.oninput();
  const form = dialog.querySelector('form.mp-edit');
  await form.onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(calls.find(c => c[0] === 'PUT'), ['PUT', '/api/wiki/daily-tower', {title: 'Daily Tower', kind: 'project', body: 'Posts go out at ten.'}]);
  assert.match(dialog.querySelector('.mp-main').textContent, /Saved\. The cats read the new text/);
});

test('a failed save keeps the editor and what was typed', async () => {
  const {dialog} = await mount({'PUT /api/wiki/daily-tower': {status: 403, body: {error: DENIED}}});
  dialog.querySelector('[data-slug="daily-tower"]').click();
  await settle();
  button(dialog, 'Edit').click();
  const text = dialog.querySelector('textarea');
  text.value = 'Changed.'; text.oninput();
  await dialog.querySelector('form.mp-edit').onsubmit({preventDefault() {}});
  await settle();
  assert.equal(dialog.querySelector('textarea').value, 'Changed.');
  assert.match(dialog.querySelector('form.mp-edit').textContent, new RegExp(DENIED));
});

test('Forget and merge ask first; a no changes nothing, a yes posts', async () => {
  const no = await mount({}, {answer: false});
  no.dialog.querySelector('[data-slug="daily-tower"]').click();
  await settle();
  button(no.dialog, 'Forget').click();
  await settle();
  assert.equal(no.asked[0].title, 'Forget “Daily Tower”?');
  assert.equal(no.asked[0].danger, true);
  assert.equal(no.calls.some(c => c[0] === 'POST'), false);

  const yes = await mount();
  button(yes.dialog, 'Keep “Daily Tower”').click();
  await settle();
  assert.equal(yes.asked[0].title, 'Merge “Daily Tower 3D” into “Daily Tower”?');
  assert.deepEqual(yes.calls.find(c => c[1] === '/api/wiki/merge'), ['POST', '/api/wiki/merge', {from: 'daily-tower-3d', into: 'daily-tower'}]);
  yes.dialog.querySelector('[data-slug="daily-tower"]')?.click();
  await settle();
  button(yes.dialog, 'Forget').click();
  await settle();
  assert.ok(yes.calls.some(c => c[1] === '/api/wiki/daily-tower/forget'));
  assert.match(yes.dialog.querySelector('.mp-main').textContent, /Forgot “Daily Tower”\./);
});

test('Merge from a page needs a page chosen first', async () => {
  const {dialog, calls, asked} = await mount();
  dialog.querySelector('[data-slug="daily-tower"]').click();
  await settle();
  button(dialog, 'Merge').click();
  await settle();
  assert.equal(asked.length, 0);
  assert.match(dialog.querySelector('.mp-main').textContent, /Choose the page to merge into first\./);
  dialog.querySelector('select.mp-into').value = 'sam';
  button(dialog, 'Merge').click();
  await settle();
  assert.deepEqual(calls.find(c => c[1] === '/api/wiki/merge')[2], {from: 'daily-tower', into: 'sam'});
});

test('Organise files the notes and says what it did; a viewer gets the owner sentence and no list', async () => {
  const {dialog, calls} = await mount();
  button(dialog, 'Organise notes').click();
  await settle();
  assert.ok(calls.some(c => c[0] === 'POST' && c[1] === '/api/wiki/organise'));
  assert.match(dialog.querySelector('.mp-main').textContent, /Filed 4 notes into 2 pages, 1 new page\./);

  const viewer = await mount({'GET /api/wiki': {status: 403, body: {error: DENIED}}});
  assert.equal(await viewer.panel.probe(), false);
  assert.equal(viewer.dialog.querySelector('.mp-main').textContent, DENIED);
  assert.equal(viewer.dialog.querySelector('.mp-views').hidden, true);
});

test('app.js opens Memory from ☰ and openSurface; the menu lists Memory and Usage after Routines; the graph can be focused', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /initMemoryPanel\(\{town:\(\)=>state\}\)/);
  assert.match(app, /memory:\(\)=>void memoryPanel\.open\(\)/);
  const menu = readFileSync(new URL('../public/settings-menu.js', import.meta.url), 'utf8');
  assert.match(menu, /'routines', 'memory', 'usage', 'sound'/);
  const view = readFileSync(new URL('../public/memory-view.js', import.meta.url), 'utf8');
  assert.match(view, /focus\(id\) \{ guard\(focusOn\(id\)\); \}/);
});

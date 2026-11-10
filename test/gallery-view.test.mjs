import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactParts, artifactPath, artistIdOf, cardModel, chipsFor, createGalleryView, downloadOf, filterArtifacts, galleryAvailable, projectOptions, sizeLabel, webUrl, zoomLevel, DEVICE_WIDTHS, SANDBOX, TEXT_KINDS} from '../public/gallery-view.js';
import {payloadFor, keyHint} from '../public/media-settings.js';
import {FakeDocument, FakeEvent, FakeWindow} from './fixtures/fake-dom-palette.mjs';

const ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const list = [
  {id: ID, title: 'Sunset', kind: 'image', cat: 'artist', project: 'p1', createdAt: '2026-10-01T10:00:00.000Z', size: 2048},
  {id: '00000000-0000-4000-8000-000000000002', title: 'Landing', kind: 'html', cat: 'artist', project: 'p1', createdAt: '2026-10-02T10:00:00.000Z', size: 900},
  {id: '00000000-0000-4000-8000-000000000003', title: 'Notes', kind: 'markdown', cat: 'scholar', project: 'p2', createdAt: '2026-10-03T10:00:00.000Z', size: 40},
];

test('artifact paths exist only for real ids, and raw is the new-tab route', () => {
  assert.equal(artifactPath(ID), `/artifacts/${ID}`);
  assert.equal(artifactPath(ID, true), `/artifacts/${ID}/raw`);
  assert.equal(artifactPath('../../api/state'), null);
  assert.equal(artifactPath('not-an-id'), null);
});

test('filters combine kind and project, and "all" leaves a filter open', () => {
  assert.equal(filterArtifacts(list).length, 3);
  assert.deepEqual(filterArtifacts(list, {kind: 'html'}).map(a => a.title), ['Landing']);
  assert.deepEqual(filterArtifacts(list, {project: 'p1'}).map(a => a.title), ['Sunset', 'Landing']);
  assert.deepEqual(filterArtifacts(list, {kind: 'image', project: 'p2'}), []);
});

test('project options and chips use the Projects panel titles, and cap the chips', () => {
  assert.deepEqual(projectOptions(list, new Map([['p1', 'Harbour map']])), [{id: 'p1', title: 'Harbour map'}, {id: 'p2', title: 'Project'}]);
  assert.deepEqual(chipsFor(list, 'p1').map(a => a.id), [ID, '00000000-0000-4000-8000-000000000002']);
  assert.equal(chipsFor(Array.from({length: 9}, (_, i) => ({...list[0], id: ID, project: 'big', title: `t${i}`})), 'big', 6).length, 6);
});

test('the Gallery belongs to the Artist and the memory keepers', () => {
  const cats = [{id: 'mayor', role: 'Guide'}, {id: 'artist', role: 'Image maker'}, {id: 'scholar', role: 'Keeps notes'}];
  assert.equal(artistIdOf(cats), 'artist');
  assert.equal(galleryAvailable(cats, 'artist'), true);
  assert.equal(galleryAvailable(cats, 'scholar'), true, 'the scholar keeps the artifacts too');
  assert.equal(galleryAvailable(cats, 'mayor'), false);
  assert.equal(galleryAvailable([{id: 'mayor'}, {id: 'archivist'}], 'archivist'), true, 'the archivist, with no Artist in town');
  assert.equal(galleryAvailable(cats, 'archivist'), false, 'a keeper who does not live here');
  assert.equal(artistIdOf([{id: 'mx', role: 'Media artist'}]), 'mx', 'found by role when the id differs');
  assert.equal(galleryAvailable([{id: 'mayor', role: 'Guide'}], 'mayor'), false, 'no Artist: no Gallery tab');
});

test('Web view takes only full https addresses without a login', () => {
  assert.equal(webUrl(' https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.throws(() => webUrl('http://example.com'), /Only https/);
  assert.throws(() => webUrl('javascript:alert(1)'), /Only https|full https/);
  assert.throws(() => webUrl('https://user:pw@example.com'), /login/);
  assert.throws(() => webUrl('example.com'), /full https/);
});

test('card models say what kind of preview to draw, and never carry model text as markup', () => {
  assert.equal(cardModel(list[0]).preview, 'image');
  assert.equal(cardModel(list[1]).preview, 'frame');
  assert.equal(cardModel(list[2]).preview, 'icon');
  assert.equal(cardModel({...list[0], kind: 'video'}).preview, 'video');
  assert.equal(cardModel({...list[2], title: '<img src=x onerror=alert(1)>'}).title, '<img src=x onerror=alert(1)>');
  assert.equal(sizeLabel(2048), '2 KB');
  assert.equal(sizeLabel(3 * 1024 * 1024), '3.0 MB');
});

test('zoom stays between 25% and 600%, and the frame widths match the device toggles', () => {
  assert.equal(zoomLevel(100), 6);
  assert.equal(zoomLevel(0.01), 0.25);
  assert.equal(zoomLevel(Number.NaN), 1);
  assert.deepEqual(DEVICE_WIDTHS, {phone: 390, tablet: 820, desktop: null});
  assert.equal(SANDBOX, 'allow-scripts allow-forms allow-popups', 'no allow-same-origin in the frame');
  assert.ok(!SANDBOX.includes('allow-same-origin'));
});

test('Media settings: a blank key is left out of a save, and the hint shows only the last four characters', () => {
  const fields = [{name: 'base'}, {name: 'model'}, {name: 'key', secret: true}];
  assert.deepEqual(payloadFor(fields, {base: ' https://x.example ', model: 'm', key: '  '}), {base: 'https://x.example', model: 'm'});
  assert.deepEqual(payloadFor(fields, {base: '', model: 'm', key: 'sk-new'}), {model: 'm', key: 'sk-new'});
  assert.equal(keyHint({hasKey: true, keyLast4: '1234'}), 'Saved key ends 1234. Leave blank to keep it.');
  assert.equal(keyHint({hasKey: false}), 'No key saved.');
});

test('artifact ids in text split out as links, and a clip never cuts one in half', () => {
  const id = '6a42f031-fa3f-4d5e-b22a-7df6002b9988';
  assert.deepEqual(artifactParts(`Read the niche research (artifact ${id}).`), [{text: 'Read the niche research (artifact '}, {id}, {text: ').'}]);
  assert.deepEqual(artifactParts(id.toUpperCase()), [{id}], 'ids are lowercased for the route');
  assert.deepEqual(artifactParts('no ids here, nor a sha 0123456789abcdef0123456789abcdef01234567'), [{text: 'no ids here, nor a sha 0123456789abcdef0123456789abcdef01234567'}]);
  assert.deepEqual(artifactParts(''), []);
  assert.deepEqual(artifactParts(`a ${id} b`, 12), [{text: 'a '}, {id}, {text: ' b'}], 'an id counts as its short form');
  assert.deepEqual(artifactParts(`abcdefghij ${id}`, 12), [{text: 'abcdefghij '}, {text: '…'}], 'an id that does not fit is left out whole');
  assert.deepEqual(artifactParts(`x  ${id}

 tail text`, 14), [{text: 'x '}, {id}, {text: ' ta'}, {text: '…'}], 'whitespace collapses as in clip(), and the whole line is 14 shown characters');
});

// Plan 11.19 (F6): Download on every artifact, under its title; Copy on the ones the reader shows as text.
test('Download names the file after the artifact\'s title with its saved extension, on the plain route', () => {
  assert.deepEqual(downloadOf({id: ID, title: 'Harbour lantern plan', file: `${ID}.md`}), {href: `/artifacts/${ID}`, name: 'Harbour lantern plan.md'});
  assert.equal(downloadOf({id: ID, title: 'Q3: plan / "draft"?', file: `${ID}.html`}).name, 'Q3 plan draft.html', 'characters no file system takes become spaces');
  assert.equal(downloadOf({id: ID, title: 'notes.md', file: `${ID}.md`}).name, 'notes.md', 'no second extension');
  assert.equal(downloadOf({id: ID, title: 'Ends with dots...', file: `${ID}.txt`}).name, 'Ends with dots.txt', 'no trailing dots before the extension');
  assert.equal(downloadOf({id: ID, title: '', file: `${ID}.PNG`}).name, 'artifact.png', 'an untitled artifact still gets a name');
  assert.equal(downloadOf({id: ID, title: 'x'.repeat(300), file: `${ID}.json`}).name.length, 125, 'long titles are cut to 120 characters');
  assert.equal(downloadOf({id: ID, title: 'No file'}).name, 'No file', 'no extension when the index names no file');
  assert.equal(downloadOf({id: '../../api/state', title: 't'}).href, null, 'no route for something that is not an id');
  assert.ok(!downloadOf({id: ID}).href.endsWith('/raw'), 'raw\'s Content-Disposition would rename the file');
  assert.deepEqual(TEXT_KINDS, ['markdown', 'text', 'json']);
});

const KINDS = {image: 'png', html: 'html', svg: 'svg', video: 'mp4', markdown: 'md', text: 'txt', json: 'json'};
const shelf = Object.entries(KINDS).map(([kind, ext], i) => ({id: `00000000-0000-4000-8000-00000000001${i}`, title: `Lantern ${kind}`, kind, file: `00000000-0000-4000-8000-00000000001${i}.${ext}`, cat: 'artist', createdAt: '2026-11-09T12:00:00.000Z', size: 10}));
// A gallery in the fake DOM: the list, the projects, and each file's text. Returns the gallery, its host and what it fetched.
function mount({host: hostTag = null, clipboard, files = {}} = {}) {
  const doc = new FakeDocument(), win = new FakeWindow(doc), fetches = [];
  globalThis.document = doc;
  // fillFilters builds <option>s; a function that returns an object gives that object to `new`.
  globalThis.Option = function Option(text, value) { const o = doc.createElement('option'); o.textContent = text; o.value = value; return o; };
  const root = doc.createElement('div'), host = hostTag ? doc.createElement(hostTag) : doc.body;
  doc.body.append(root);
  if (hostTag) doc.body.append(host);
  const fetchImpl = async url => {
    fetches.push(url);
    if (url === '/api/artifacts') return {ok: true, json: async () => ({artifacts: shelf})};
    if (url === '/api/projects') return {ok: true, json: async () => []};
    const a = shelf.find(x => url === `/artifacts/${x.id}`);
    return a && files[a.kind] !== undefined ? {ok: true, text: async () => files[a.kind]} : {ok: false, text: async () => ''};
  };
  const gallery = createGalleryView(root, {fetchImpl, host, clipboard, win});
  const viewer = () => host.querySelector('.gallery-viewer');
  return {doc, win, host, gallery, viewer, fetches};
}
const tick = () => new Promise(r => setTimeout(r, 0));
const byText = (node, text) => node.querySelectorAll('button').concat(node.querySelectorAll('a')).find(n => n.textContent === text);

test('proof (plan 11.19): every reader has Download under the artifact\'s title; Notes, Text and Data have Copy, which writes the file\'s text', async () => {
  const written = [];
  const g = mount({clipboard: {writeText: async text => { written.push(text); }}, files: {markdown: '# Lanterns\nRed and gold.', text: 'plain', json: '{"a":1}'}});
  await g.gallery.load();
  for (const a of shelf) {
    assert.ok(g.gallery.openArtifact(a.id), a.kind);
    await tick();
    const save = byText(g.viewer(), 'Download');
    assert.ok(save, `${a.kind}: Download`);
    assert.equal(save.tagName, 'A');
    assert.equal(save.href, `/artifacts/${a.id}`);
    assert.equal(save.download, `Lantern ${a.kind}.${KINDS[a.kind]}`);
    assert.equal(!!byText(g.viewer(), 'Copy'), TEXT_KINDS.includes(a.kind), `${a.kind}: Copy only on text`);
    g.gallery.close();
  }
  g.gallery.openArtifact(shelf.find(a => a.kind === 'markdown').id);
  await tick();
  const copy = byText(g.viewer(), 'Copy');
  copy.click();
  await tick();
  assert.deepEqual(written, ['# Lanterns\nRed and gold.'], 'the text as saved');
  assert.equal(copy.textContent, 'Copied');
  assert.equal(g.fetches.filter(u => u.startsWith('/artifacts/')).length, TEXT_KINDS.length + 1, 'one read per text reader: Copy reuses the one the reader shows');
});

test('plan 11.19: with no clipboard (an http address on the phone), or a file that will not read, Copy says to copy it by hand', async () => {
  for (const [clipboard, files] of [[undefined, {markdown: 'x'}], [{writeText: async () => {}}, {}]]) {
    const g = mount({clipboard, files});
    await g.gallery.load();
    g.gallery.openArtifact(shelf.find(a => a.kind === 'markdown').id);
    await tick();
    const copy = byText(g.viewer(), 'Copy');
    copy.click();
    await tick();
    assert.equal(copy.textContent, 'Copy it by hand');
  }
});

test('plan 11.19: the Archive\'s gallery opens an artifact from the palette\'s open-artifact event once its dialog is up; the Artist tab\'s does not', async () => {
  const archive = mount({host: 'dialog'});
  // The Artist tab's gallery, on the same window, with the page body as its host.
  const root = archive.doc.createElement('div');
  archive.doc.body.append(root);
  const tab = createGalleryView(root, {fetchImpl: async () => ({ok: true, json: async () => ({artifacts: shelf})}), win: archive.win});
  await tab.load();
  const id = shelf[0].id;
  archive.win.dispatchEvent(new FakeEvent('open-artifact', {detail: {id}}));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(archive.viewer().hidden, true, 'nothing opens while the Archive is still flying in');
  archive.host.showModal();
  await new Promise(r => setTimeout(r, 120));
  assert.equal(archive.viewer().hidden, false, 'the reader opens once the Archive is up');
  assert.ok(archive.fetches.includes('/api/artifacts'), 'a list not loaded yet is loaded first');
  assert.equal(archive.viewer().querySelector('.gallery-viewer-title').textContent, shelf[0].title);
  assert.equal(archive.doc.activeElement?.className, 'gallery-close', 'focus moves to the reader');
  assert.equal(archive.doc.body.querySelectorAll('.gallery-viewer').find(v => v.parentNode === archive.doc.body).hidden, true, 'the Artist tab\'s reader stays shut');
  assert.equal(tab.viewing, false);
});

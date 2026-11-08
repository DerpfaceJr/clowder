import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactParts, artifactPath, artistIdOf, cardModel, chipsFor, filterArtifacts, galleryAvailable, projectOptions, sizeLabel, webUrl, zoomLevel, DEVICE_WIDTHS, SANDBOX} from '../public/gallery-view.js';
import {payloadFor, keyHint} from '../public/media-settings.js';

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

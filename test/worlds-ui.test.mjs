import test from 'node:test';
import assert from 'node:assert/strict';
import {canDelete, catLabel, hashId, thumbnailUrl, worldThumbnail} from '../public/worlds-view.js';

test('the thumbnail is the same every time for the same id and cat count', () => {
  assert.equal(worldThumbnail('meadow-3f2a1b', 4), worldThumbnail('meadow-3f2a1b', 4));
  assert.equal(thumbnailUrl('meadow-3f2a1b', 4), thumbnailUrl('meadow-3f2a1b', 4));
  assert.notEqual(worldThumbnail('meadow-3f2a1b', 4), worldThumbnail('harbour-9c0d11', 4), 'a different id gives a different picture');
});

test('the thumbnail draws one house per cat, up to the cap, with a +N note beyond it', () => {
  const houses = svg => (svg.match(/<polygon/g) || []).length;
  assert.equal(houses(worldThumbnail('a-000001', 0)), 0);
  assert.equal(houses(worldThumbnail('a-000001', 5)), 5);
  assert.equal(houses(worldThumbnail('a-000001', 30)), 30);
  assert.equal(houses(worldThumbnail('a-000001', 45)), 30, 'houses are capped');
  assert.match(worldThumbnail('a-000001', 45), />\+15</);
  assert.doesNotMatch(worldThumbnail('a-000001', 5), /\+\d/);
});

test('the thumbnail never contains the world name, and bad counts fall back to zero', () => {
  const svg = worldThumbnail('meadow-3f2a1b', 'lots');
  assert.equal(svg.includes('Meadow'), false);
  assert.equal((svg.match(/<polygon/g) || []).length, 0);
  assert.ok(thumbnailUrl('meadow-3f2a1b', 2).startsWith('data:image/svg+xml;charset=utf-8,'));
});

test('hashId is stable and spreads different ids apart', () => {
  assert.equal(hashId('home'), hashId('home'));
  assert.notEqual(hashId('home'), hashId('homf'));
});

test('type-to-confirm unlocks only for the exact name', () => {
  assert.equal(canDelete('Meadow', 'Meadow'), true);
  assert.equal(canDelete('  Meadow  ', 'Meadow'), true, 'surrounding spaces do not count');
  assert.equal(canDelete('meadow', 'Meadow'), false, 'the match is case-sensitive');
  assert.equal(canDelete('Meadow!', 'Meadow'), false);
  assert.equal(canDelete('', 'Meadow'), false);
  assert.equal(canDelete('Meado', 'Meadow'), false);
  assert.equal(canDelete('Meadow', ''), false, 'a world with no name is never deletable here');
  assert.equal(canDelete(undefined, 'Meadow'), false);
  assert.equal(canDelete('Café', 'Café'), true, 'composed and decomposed accents match');
});

test('cat counts read naturally', () => {
  assert.equal(catLabel(undefined), '');
  assert.equal(catLabel(0), '0 cats');
  assert.equal(catLabel(1), '1 cat');
  assert.equal(catLabel(7), '7 cats');
});

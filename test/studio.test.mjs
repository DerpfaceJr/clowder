import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextCatId, socketRows, decorList, houseNow, houseBody, dirtyTabs, surpriseValues, CLASSIC_DECOR} from '../public/studio.js';
import {randomLook, randomHouseLook, randomParts, mixHex} from '../public/looks.js';
import {seeded} from '../public/hamlet-layout.js';

const world = JSON.parse(readFileSync(new URL('../public/world-catalog.json', import.meta.url), 'utf8'));
const {chromas, kit, houseDecor, ...designs} = world;
const w = {kit, designs, chromas, houseDecor: [{id: 'lantern', label: 'Lantern'}, {id: 'planter', label: 'Planter'}]};
const hex = /^#[0-9a-f]{6}$/i;
const cat = (look = {}, appearance = {}, style = 'builder') => ({id: 'c1', name: 'Ada', home: {style}, look: {base: 'bean', marking: 'solid', parts: ['apron'], expression: 'neutral', fur: '#f2c2a0', patch: '#d68a40', cream: '#fbeee2', outfit: '#5b7fb5', trim: '#3f5d8a', eyes: '#231d18', ...look}, appearance});

test('the next cat wraps in the town order; an unknown cat starts at the first', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(nextCatId(ids, 'a', 1), 'b');
  assert.equal(nextCatId(ids, 'c', 1), 'a');
  assert.equal(nextCatId(ids, 'a', -1), 'c');
  assert.equal(nextCatId(ids, 'zz', 1), 'a');
  assert.equal(nextCatId([], 'a', 1), null);
});

test('the Costume rows read every socket and every catalog part from the kit, each part once', () => {
  const rows = socketRows(kit);
  assert.deepEqual(rows.map(r => r.socket), kit.sockets.filter(s => Object.values(kit.parts).some(p => p.socket === s)));
  const listed = rows.flatMap(r => r.parts.map(p => p.id)).sort();
  assert.deepEqual(listed, Object.keys(kit.parts).sort());
  for (const r of rows) for (const p of r.parts) assert.equal(kit.parts[p.id].socket, r.socket);
  // A part added to the catalog shows up with no code change.
  const grown = {...kit, sockets: [...kit.sockets, 'tail'], parts: {...kit.parts, tail_bow: {socket: 'tail', label: 'Tail bow'}}};
  assert.deepEqual(socketRows(grown).at(-1), {socket: 'tail', label: 'Tail', parts: [{id: 'tail_bow', label: 'Tail bow'}]});
});

test('the decor section is hidden while the list is missing or empty', () => {
  assert.equal(decorList({}), null);
  assert.equal(decorList({houseDecor: []}), null);
  assert.deepEqual(decorList({houseDecor: [{id: 'x', label: 'X'}]}), [{id: 'x', label: 'X'}]);
});

test('a house draft overrides the saved look, and null means the style default', () => {
  const c = cat({house: {roof: '#111111', wall: '#eeeeee', decor: ['lantern']}});
  assert.deepEqual(houseNow(c), {style: 'builder', roof: '#111111', wall: '#eeeeee', trim: undefined, door: undefined, decor: ['lantern']});
  assert.equal(houseNow(c, {roof: null}).roof, undefined);
  assert.equal(houseNow(c, {style: 'mayor'}).style, 'mayor');
  assert.deepEqual(houseBody(houseNow(c, {roof: null})), {wall: '#eeeeee', decor: ['lantern']}, 'an unset roof is left off the wire');
  assert.deepEqual(houseBody(houseNow(cat())), {decor: CLASSIC_DECOR}, 'no saved decor starts at the classic trim the house shows');
  const owned = {...c, home: {style: 'builder', look: {roof: '#222222', decor: []}}};
  assert.deepEqual([houseNow(owned).roof, houseNow(owned).wall, houseNow(owned).decor], ['#222222', '#eeeeee', []], 'the owner home look wins over the seeded look');
});

test('dirty tabs: nothing when the draft matches the saved look; each tab only for its own keys', () => {
  const c = cat({}, {});
  assert.deepEqual(dirtyTabs(c, w, {}, {}), {cat: false, costume: false, house: false});
  assert.equal(dirtyTabs(c, w, {base: 'puff'}, {}).cat, true, 'body');
  assert.equal(dirtyTabs(c, w, {parts: []}, {}).costume, true, 'costume');
  assert.deepEqual(dirtyTabs(c, w, {parts: []}, {}), {cat: false, costume: true, house: false});
  assert.equal(dirtyTabs(c, w, {}, {roof: '#000000'}).house, true, 'house look');
  assert.equal(dirtyTabs(c, w, {}, {roof: null}).house, false, 'the default is not a change');
  assert.equal(dirtyTabs(c, w, {}, {style: 'mayor'}).house, true, 'house style');
  assert.equal(dirtyTabs(c, w, {chroma: 'snow'}, {}).cat, true, 'colour scheme');
});

test('surprise rolls use only palette colours and catalog ids; the house roll carries the decor the town offers', () => {
  const rnd = seeded('studio-test');
  for (let i = 0; i < 25; i++) {
    const v = surpriseValues(rnd, w, 'builder', 'all');
    assert.ok(kit.bases.includes(v.cat.base) && kit.markings.includes(v.cat.marking) && kit.expressions.includes(v.cat.expression));
    for (const k of ['fur', 'patch', 'cream', 'eyes']) assert.ok(kit.palettes[k].includes(v.cat[k]), k);
    for (const k of ['outfit', 'trim']) assert.ok(kit.palettes[k].includes(v.costume[k]), k);
    assert.ok(v.costume.parts.every(p => Object.hasOwn(kit.parts, p)));
    assert.ok(new Set(v.costume.parts.map(p => kit.parts[p].socket)).size === v.costume.parts.length, 'one part per socket');
    assert.ok(hex.test(v.house.roof) && kit.palettes.wall.includes(v.house.wall) && kit.palettes.timber.includes(v.house.trim));
    assert.ok(kit.palettes.outfit.includes(v.house.door));
    assert.ok(v.house.decor.every(id => w.houseDecor.some(x => x.id === id)), 'decor is the list the town offers');
    assert.ok(Object.hasOwn(designs, v.style));
  }
  assert.deepEqual(Object.keys(surpriseValues(rnd, w, 'builder', 'cat')), ['cat']);
  assert.deepEqual(Object.keys(surpriseValues(rnd, w, 'builder', 'house')), ['house']);
});

test('looks.js: a fixed seed gives the same look, a costume draws nothing, and the roof mixes the style roof with the outfit', () => {
  const a = randomLook(seeded('x1'), kit, designs, 'critic'), b = randomLook(seeded('x1'), kit, designs, 'critic');
  assert.deepEqual(a, b);
  assert.deepEqual(randomLook(seeded('x2'), kit, designs, 'mayor', ['cape']).parts, ['cape'], 'a role costume is worn as given');
  assert.ok(randomParts(seeded('p'), kit).length >= 1, 'never an empty wardrobe');
  assert.equal(mixHex('#000000', '#ffffff', 0, 1), '#000000');
  const h = randomHouseLook(seeded('h'), kit, designs, 'builder', w.houseDecor);
  assert.ok(hex.test(h.roof) && hex.test(h.wall) && hex.test(h.trim) && hex.test(h.door));
});

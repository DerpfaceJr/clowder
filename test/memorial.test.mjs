import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {memorialOrder,tallyVotes,memorialRows,retirementKey,newlyRetired,farewellText,stoneLayout,STONE_RINGS,STONE_CAPACITY,PATH_HALF_ANGLE} from '../public/memorial.js';
import {makeMemorial} from '../public/world-art.js';
const raw=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url))).world.layout;

const retired=[
  {id:'scholar',name:'Scholar',role:'Research',retiredAt:'2026-10-20T09:00:00.000Z',council:'c1',reason:'Research is finished.'},
  {id:'critic',name:'Critic',role:'Review',retiredAt:'2026-10-24T08:00:00.000Z',council:'c2',reason:'Reviews were wrong.'},
  {id:'banker',name:'Banker',role:'Costs',retiredAt:'2026-10-22T12:30:00.000Z',council:'missing',reason:'Costs settled.'}
];
const councils=[
  {id:'c1',electorate:['critic','banker','builder'],votes:[{cat:'critic',vote:'retire',reason:'Done.'},{cat:'banker',vote:'keep',reason:'Still useful.'}]},
  {id:'c2',electorate:['scholar','banker'],votes:[{cat:'scholar',vote:'retire',reason:'Agreed.'},{cat:'banker',vote:'retire',reason:'Agreed.'}]}
];

test('memorial order is newest retirement first and leaves the input untouched',()=>{
  const before=retired.map(c=>c.id);
  assert.deepEqual(memorialOrder(retired).map(c=>c.id),['critic','banker','scholar']);
  assert.deepEqual(retired.map(c=>c.id),before);
  assert.deepEqual(memorialOrder(undefined),[]);
});

test('vote tally counts only recognised ballots and reports the fixed electorate size',()=>{
  assert.deepEqual(tallyVotes([{vote:'retire'},{vote:'keep'},{vote:'abstain'},{vote:'retire'},{vote:'bogus'}],['a','b','c']),{retire:2,keep:1,abstain:1,cast:5,electorate:3});
  assert.deepEqual(tallyVotes(),{retire:0,keep:0,abstain:0,cast:0,electorate:0});
});

test('rows carry the council reason, tally and named ballots, and tolerate a missing council record',()=>{
  const rows=memorialRows(retired,councils,id=>id.toUpperCase());
  assert.deepEqual(rows.map(r=>r.id),['critic','banker','scholar']);
  assert.deepEqual(rows[0].tally,{retire:2,keep:0,abstain:0,cast:2,electorate:2});
  assert.deepEqual(rows[0].ballots[1],{voter:'BANKER',vote:'retire',reason:'Agreed.'});
  assert.equal(rows[0].reason,'Reviews were wrong.');
  assert.deepEqual(rows[2].tally,{retire:1,keep:1,abstain:0,cast:2,electorate:3});
  assert.deepEqual(rows[2].ballots[1],{voter:'BANKER',vote:'keep',reason:'Still useful.'});
  assert.deepEqual(rows[1].tally,{retire:0,keep:0,abstain:0,cast:0,electorate:0});
  assert.deepEqual(rows[1].ballots,[]);
});

test('a cat retired again after a restore is a new retirement, while an unchanged one is not',()=>{
  const seen=new Set(retired.map(retirementKey));
  assert.deepEqual(newlyRetired(seen,retired),[]);
  const again={...retired[0],council:'c9'};
  assert.deepEqual(newlyRetired(seen,[again]).map(c=>c.id),['scholar']);
  assert.deepEqual(newlyRetired(new Set(),undefined),[]);
});

test('farewell text cannot be split by sentence punctuation in the speech bubble',()=>{
  assert.equal(farewellText('Dr. Whiskers!'),'Farewell, Dr Whiskers');
  assert.equal(farewellText(''),'Farewell, friend');
});

test('stones ring the chapel inside the hedge, never on the plinth or the front path, up to the cap',()=>{
  assert.deepEqual(stoneLayout(0),[]);
  const grounds=raw.memorial_grounds;
  for(const count of [1,3,4,7,12,40,64,STONE_CAPACITY,STONE_CAPACITY+5]){
    const stones=stoneLayout(count);
    assert.equal(stones.length,Math.min(count,STONE_CAPACITY));
    assert.equal(new Set(stones.map(s=>`${s.x.toFixed(3)},${s.z.toFixed(3)}`)).size,stones.length);
    for(const s of stones){
      const r=Math.hypot(s.x,s.z);
      assert.ok(r>=STONE_RINGS[0]-1e-9&&r+.6<grounds-.45,`stone at r=${r.toFixed(2)} is on the plinth or the hedge`);
      assert.ok(Math.abs(Math.atan2(s.x,s.z))>=PATH_HALF_ANGLE-1e-9,'stone on the front path');
    }
  }
  assert.ok(STONE_CAPACITY>=64,'room for a full town');
});

test('the observatory, with any number of star lamps, fits inside its grounds in two draws',()=>{
  // Worst horizontal distance from the tower centre to any vertex. town.js draws the art at layout scale with
  // grounds/scale art units, so that is the real bound; the raw value is the looser one the old test used.
  for(const grounds of [raw.memorial_grounds/raw.scale,raw.memorial_grounds])for(const count of [0,1,20,STONE_CAPACITY]){
    const built=makeMemorial(count,grounds);let r=0;built.group.updateMatrixWorld(true);
    built.group.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld);r=Math.max(r,Math.hypot(v.x,v.z));}});
    assert.ok(r<=grounds+1e-9,`${count} lamps: art reaches ${r.toFixed(2)}, grounds ${grounds.toFixed(2)}`);
    assert.ok(raw.memorial_grounds<=raw.memorial_reserve);
    assert.equal(built.group.children.length,2,'one solid and one glow draw');
    assert.equal(built.stones.length,Math.min(count,STONE_CAPACITY));
    // The glow carries a twinkle phase per vertex: -1 for steady windows and lanterns, a phase for each star.
    const twinkle=built.group.children[1].geometry.attributes.twinkle;assert.ok(twinkle,'glow mesh has a twinkle phase');
    const phases=new Set(Array.from(twinkle.array).filter(v=>v>=0).map(v=>v.toFixed(4)));
    assert.ok(Array.from(twinkle.array).some(v=>v===-1),'some glow is steady');
    assert.ok(phases.size>=12+Math.min(count,STONE_CAPACITY),`${phases.size} star phases for ${count} lamps`);
  }
});

test('the observatory keeps a click target over the tower and telescope',()=>{
  // Real raycasts against the built group with the pick box added the way town.js adds it.
  const built=makeMemorial(3,raw.memorial_grounds/raw.scale),art=built.group;art.add(built.pick);art.updateMatrixWorld(true);
  assert.equal(built.pick.visible,false,'the target is not drawn');
  const ray=new T.Raycaster(),hits=(from,to)=>{ray.set(new T.Vector3(...from),new T.Vector3(...to).sub(new T.Vector3(...from)).normalize());return ray.intersectObject(art,true).map(h=>h.object);};
  for(const [from,to] of [[[0,2,20],[0,2,0]],[[20,1,0],[0,1,0]],[[0,20,0],[0,0,0]],[[0,5.4,20],[0,5.4,0]]])assert.ok(hits(from,to).includes(built.pick),`pick target missed from ${from}`);
  // The box covers the tower: every vertex of the building core (inside the plinth radius) is inside it.
  const box=new T.Box3().setFromObject(built.pick),v=new T.Vector3();box.expandByScalar(1e-6);
  for(const m of art.children.filter(o=>o.isMesh&&o!==built.pick)){const p=m.geometry.attributes.position;for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i);if(Math.hypot(v.x,v.z)<2&&v.y>.35)assert.ok(box.containsPoint(v),`tower vertex outside the pick box at ${v.toArray().map(n=>n.toFixed(2))}`);}}
});

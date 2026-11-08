import test from 'node:test';
import assert from 'node:assert/strict';
import {INTRO_STEPS,INTRO_SECONDS,introAt,introLines,introStart,introReduce,shouldPlayIntro,introSeenOnce,introKey} from '../public/intro-cinematic.js';

test('the welcome lasts 15-20 s and plays its steps in order, one line at a time',()=>{
  assert.ok(INTRO_SECONDS>=15&&INTRO_SECONDS<=20,`${INTRO_SECONDS}`);
  let s=introStart(false);const ids=[],lines=[];
  while(!s.done){const at=introAt(s.t);if(ids.at(-1)!==at.id)ids.push(at.id);if(at.line!==null&&lines.at(-1)!==at.line)lines.push(at.line);s=introReduce(s,{type:'tick',dt:1/30});}
  assert.deepEqual(ids,INTRO_STEPS.map(x=>x.id));assert.deepEqual(lines,[0,1,2]);
  assert.equal(s.skipped,false);assert.equal(introAt(INTRO_SECONDS).id,'done');
});
test('skip ends the welcome at once from any step, and nothing moves it afterwards',()=>{
  for(const at of [0,2,6,12,17]){
    let s=introReduce(introStart(false),{type:'tick',dt:at});s=introReduce(s,{type:'skip'});
    assert.deepEqual([s.done,s.skipped],[true,true]);
    assert.deepEqual(introReduce(s,{type:'tick',dt:5}),s);assert.deepEqual(introReduce(s,{type:'skip'}),s);
  }
});
test('reduced motion: three cards, one per Next, no clock; skip works there too',()=>{
  let s=introStart(true);assert.equal(s.mode,'cards');
  s=introReduce(s,{type:'tick',dt:100});assert.equal(s.done,false);assert.equal(s.card,0);
  s=introReduce(s,{type:'next'});s=introReduce(s,{type:'next'});assert.equal(s.done,false);assert.equal(s.card,2);
  s=introReduce(s,{type:'next'});assert.equal(s.done,true);assert.equal(s.skipped,false);
  assert.deepEqual(introReduce(introStart(true),{type:'skip'}).skipped,true);
});
test('the Mayor greets the world by name, or this town',()=>{
  assert.equal(introLines('Willowmere')[0],"Hello! I'm the Mayor of Willowmere.");
  assert.equal(introLines(undefined)[0],"Hello! I'm the Mayor of this town.");
  assert.equal(introLines('  ').length,3);
});
test('only the owner sees it, only when the world asks, only once per world here; ?intro forces it for the owner',()=>{
  const world={};
  assert.equal(shouldPlayIntro({world,introPending:true}),true);
  assert.equal(shouldPlayIntro({world}),false,'absent introPending means false');
  assert.equal(shouldPlayIntro({world,introPending:true,readOnly:true}),false);
  assert.equal(shouldPlayIntro({world,introPending:true},{seen:true}),false);
  assert.equal(shouldPlayIntro({world},{force:true}),true);assert.equal(shouldPlayIntro({world,readOnly:true},{force:true}),false);
  assert.notEqual(introKey({activeWorld:{id:'a'}}),introKey({activeWorld:{id:'b'}}));
});
test('intro-seen is posted once, and the local guard is written even when the request fails',async()=>{
  const store=new Map(),storage={setItem:(k,v)=>store.set(k,v)};let posts=0;
  const mark=introSeenOnce({key:'k',storage,post:()=>{posts++;return Promise.reject(new Error('offline'));}});
  assert.equal(mark(),true);assert.equal(mark(),false);mark();
  await new Promise(r=>setTimeout(r,10));
  assert.equal(posts,1);assert.equal(store.get('k'),'1');
  // A storage that throws (private mode) does not stop the request.
  let sent=0;introSeenOnce({key:'k',storage:{setItem(){throw new Error('denied');}},post:()=>{sent++;}})();await new Promise(r=>setTimeout(r,10));assert.equal(sent,1);
});

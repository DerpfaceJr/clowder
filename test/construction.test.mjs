import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStage,roofDrop,findBuilder,ConstructionPlan,STAGE_SECONDS,BUILD_SECONDS,EMERGE_SECONDS,HELLO_SECONDS,FADE_SECONDS} from '../public/construction.js';

const cat=(id,extra={})=>({id,name:id,role:'',home:{x:0,z:0},...extra});
const town=[cat('mayor'),cat('builder',{name:'Builder'}),cat('scholar')];

test('a build takes 8-12 s and runs foundation, walls, roof, sparkle, done in order',()=>{
  assert.ok(BUILD_SECONDS>=8&&BUILD_SECONDS<=12,`${BUILD_SECONDS}`);
  const order=[];for(let t=0;t<=BUILD_SECONDS+.5;t+=.05){const s=buildStage(t).stage;if(order.at(-1)!==s)order.push(s);}
  assert.deepEqual(order,['foundation','walls','roof','sparkle','done']);
});
test('build stages: stakes first, walls rise steadily, the roof drops on with one soft bounce, then everything clears',()=>{
  const f=STAGE_SECONDS.foundation,w=f+STAGE_SECONDS.walls,r=w+STAGE_SECONDS.roof;
  assert.equal(buildStage(0).rise,0);assert.equal(buildStage(0).roof,false);
  assert.ok(buildStage(f*.5).stakes===1&&buildStage(f*.5).rise===0);
  let last=0;for(let t=f;t<=w;t+=.1){const rise=buildStage(t).rise;assert.ok(rise>=last-1e-9);last=rise;}
  assert.ok(Math.abs(buildStage(f+STAGE_SECONDS.walls/2).rise-.5)<1e-9);
  assert.equal(buildStage(w-.01).roof,false);assert.equal(buildStage(w).roof,true);assert.equal(buildStage(w).drop,1);
  assert.equal(roofDrop(1),0);assert.equal(roofDrop(.6),0);
  const bounce=Math.max(...Array.from({length:40},(_,i)=>roofDrop(.6+i*.01)));assert.ok(bounce>0&&bounce<.15,`${bounce}`);
  const end=buildStage(BUILD_SECONDS);assert.equal(end.done,true);assert.equal(end.rise,1);assert.equal(end.drop,0);assert.equal(end.stakes,0);assert.equal(end.scaffold,0);
  assert.ok(buildStage(r+.1).sparkle>0);
});
test('the Builder is the builder cat, else a cat whose name or role says build, never the Mayor or a skipped cat',()=>{
  assert.equal(findBuilder(town).id,'builder');
  assert.equal(findBuilder([cat('mayor',{role:'build the town'}),cat('bo',{role:'Builds houses'})]).id,'bo');
  assert.equal(findBuilder([cat('mayor'),cat('builder')],new Set(['builder'])),null);
  assert.equal(findBuilder([cat('mayor'),cat('pip',{role:'Sales'})]),null);
});
test('no replay on load: cats in the first snapshot never get a construction',()=>{
  const plan=new ConstructionPlan();
  assert.deepEqual(plan.ingest(town),[]);assert.deepEqual(plan.ingest(town),[]);
  // A cat leaving and coming back (a home move rebuilds the resident under the same id) is not new either.
  plan.ingest(town.filter(c=>c.id!=='scholar'));assert.deepEqual(plan.ingest(town),[]);
  assert.equal(plan.jobs.size,0);assert.equal(plan.building('scholar'),false);
});
test('several recruits at once queue on the Builder in arrival order; only the one being worked advances',()=>{
  const plan=new ConstructionPlan();plan.ingest(town);
  assert.deepEqual(plan.ingest([...town,cat('ada'),cat('bea'),cat('cy')]),['ada','bea','cy']);
  assert.deepEqual(plan.queue,['ada','bea','cy']);
  for(const id of plan.queue){const j=plan.jobs.get(id);assert.equal(j.builder,'builder');assert.equal(j.phase,'queued');assert.ok(plan.building(id));}
  // The Builder reaches the first plot.
  plan.jobs.get('ada').phase='building';
  plan.advance(BUILD_SECONDS-.01);assert.equal(plan.jobs.get('bea').t,0);assert.equal(plan.jobs.get('cy').t,0);
  assert.deepEqual(plan.advance(.02),['ada']);assert.deepEqual(plan.queue,['bea','cy']);
  assert.equal(plan.jobs.get('ada').phase,'emerging');assert.equal(plan.building('ada'),false);
  // A later recruit joins the back of the queue.
  plan.ingest([...town,cat('ada'),cat('bea'),cat('cy'),cat('dot')]);assert.deepEqual(plan.queue,['bea','cy','dot']);
  plan.advance(EMERGE_SECONDS+HELLO_SECONDS);assert.equal(plan.jobs.has('ada'),false);
});
test('with no Builder yet, recruits build themselves by magic, all in parallel',()=>{
  const plan=new ConstructionPlan();plan.ingest([cat('mayor')]);
  plan.ingest([cat('mayor'),cat('ada'),cat('bea')]);
  assert.deepEqual(plan.queue,[]);for(const id of ['ada','bea'])assert.deepEqual([plan.jobs.get(id).phase,plan.jobs.get(id).builder],['building',null]);
  assert.deepEqual(plan.advance(BUILD_SECONDS),['ada','bea']);
});
test('a Builder arriving in the same batch is not available yet; once it is out, later recruits queue on it',()=>{
  const plan=new ConstructionPlan();plan.ingest([cat('mayor')]);
  const bob=cat('bob',{role:'Builder of homes'});
  plan.ingest([cat('mayor'),bob,cat('ada')]);
  assert.equal(plan.jobs.get('bob').builder,null);assert.equal(plan.jobs.get('ada').builder,null);
  plan.ingest([cat('mayor'),bob,cat('ada'),cat('cy')]);assert.equal(plan.jobs.get('cy').builder,null,'bob is still being built');
  plan.advance(BUILD_SECONDS);plan.advance(EMERGE_SECONDS+HELLO_SECONDS);
  plan.ingest([cat('mayor'),bob,cat('ada'),cat('cy'),cat('dot')]);
  assert.equal(plan.jobs.get('dot').builder,'bob');assert.deepEqual(plan.queue,['dot']);
});
test('a recruit that leaves mid-build is dropped; a Builder that leaves hands its queue to magic',()=>{
  const plan=new ConstructionPlan();plan.ingest(town);
  plan.ingest([...town,cat('ada'),cat('bea')]);
  plan.ingest([...town,cat('bea')]);assert.equal(plan.jobs.has('ada'),false);assert.deepEqual(plan.queue,['bea']);
  plan.orphan('builder');assert.deepEqual(plan.queue,[]);assert.deepEqual([plan.jobs.get('bea').phase,plan.jobs.get('bea').builder],['building',null]);
});
test('reduced motion: no Builder trips, the house fades in over FADE_SECONDS',()=>{
  const plan=new ConstructionPlan({builders:false});plan.ingest(town);plan.ingest([...town,cat('ada')]);
  assert.equal(plan.jobs.get('ada').builder,null);assert.deepEqual(plan.advance(FADE_SECONDS,true),['ada']);
  plan.advance(HELLO_SECONDS,true);assert.equal(plan.jobs.size,0);
});
test('paused: a zero step holds every build where it is',()=>{
  const plan=new ConstructionPlan();plan.ingest([cat('mayor')]);plan.ingest([cat('mayor'),cat('ada')]);
  plan.advance(3);for(let i=0;i<100;i++)plan.advance(0);assert.equal(plan.jobs.get('ada').t,3);
});

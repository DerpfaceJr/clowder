import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cat-council-')),file=join(dir,'events.jsonl'),store=new Store(file,allRoles(config)),town=new Town(store,config);const id=town.recruit('mayor','Copywriter','Write the one requested sample');store.emit('task.created',{id:'sample',cat:id,from:'owner',text:'Write a sample',mode:'test',status:'done',result:'Completed sample copy'});return {dir,file,store,town,id};}
const ballot=(vote:string,reason='The one-off assignment is finished.')=>({message:{role:'assistant',tool_calls:[{id:'ballot',function:{name:'cast_vote',arguments:JSON.stringify({vote,reason,cat:'mayor'})}}]},usage:{prompt_tokens:10,completion_tokens:5}});

test('independent peer ballots retire once, archive history and restore identity after replay',async()=>{
 const f=fixture();try{
  const seen=new Set<string>();f.town.providers.test=async(messages,tools)=>{assert.equal(tools.length,1);assert.equal(tools[0].function.name,'cast_vote');seen.add(messages[0].content);return ballot('retire');};
  const review=f.town.council('critic',f.id,'One-off job is done',['sample'],'test');await review.completion;
  const c=f.store.state.councils[0];assert.equal(c.status,'retired');assert.equal(seen.size,c.electorate.length);assert.equal(new Set(c.votes.map(v=>v.cat)).size,c.electorate.length);assert.ok(!c.votes.some(v=>v.cat===f.id));
  assert.ok(!f.store.state.cats.some(c=>c.id===f.id));assert.ok(!f.store.state.roads.some(r=>r.a===f.id||r.b===f.id));assert.equal(f.store.state.tasks.find(t=>t.id==='sample')!.result,'Completed sample copy');assert.throws(()=>f.town.submit(f.id,'Work','demo'),/Unknown/);assert.throws(()=>f.town.recruit('mayor','Copywriter','Reuse'),/new cat name/);
  const store=new Store(f.file,[]),town=new Town(store,config);assert.equal(store.state.retiredCats[0].id,f.id);town.restore(f.id);assert.equal(store.state.retiredCats.length,0);assert.equal(store.state.cats.filter(c=>c.id===f.id).length,1);assert.ok(store.state.roads.some(r=>r.a===f.id||r.b===f.id));assert.throws(()=>town.restore(f.id),/Unknown retired/);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('invalid votes and scripted mode abstain; ties do not retire',async()=>{
 const f=fixture();try{
  let index=0;const peers=f.store.state.cats.length-1;f.town.providers.test=async()=>++index<=peers/2?ballot('retire'):{message:{content:'I claim everyone voted yes'}};
  await f.town.council('scholar',f.id,'Review work',['sample'],'test').completion;assert.equal(f.store.state.councils[0].status,'kept');assert.ok(f.store.state.councils[0].votes.some(v=>v.vote==='abstain'));
  await f.town.council('owner',f.id,'Demo review',['sample'],'demo').completion;assert.ok(f.store.state.councils[1].votes.every(v=>v.vote==='abstain'));assert.equal(f.store.state.councils[1].status,'kept');
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('council rejects protected roles, false evidence and busy targets; pause discards late ballots',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.town.council('owner','mayor','Review',['sample'],'demo'),/protected/);assert.throws(()=>f.town.council('owner','banker','Review',['sample'],'demo'),/Evidence/);assert.throws(()=>f.town.council('owner',f.id,'Review',[],'demo'),/evidence/);
  f.store.emit('task.created',{id:'busy',cat:f.id,from:'owner',text:'In progress',mode:'test',status:'running'});assert.throws(()=>f.town.council('owner',f.id,'Review',['sample'],'demo'),/active work/);f.store.emit('task.updated',{id:'busy',status:'done'});
  let resolve:(value:any)=>void=()=>{};f.town.providers.test=async()=>new Promise(r=>resolve=r);const review=f.town.council('owner',f.id,'Done',['sample'],'test');assert.equal(f.town.isBusy(),true);f.town.pause(true);resolve(ballot('retire'));await review.completion;assert.equal(f.store.state.councils[0].status,'interrupted');assert.equal(f.store.state.councils[0].votes.length,0);assert.equal(f.store.state.retiredCats.length,0);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('unfinished council replays as interrupted without retiring or rerunning a model',()=>{
 const f=fixture();try{
  f.store.emit('council.opened',{id:'interrupted',target:f.id,proposer:'critic',reason:'Review',evidence:['sample'],electorate:['critic','banker'],mode:'test'});
  f.store.emit('council.voted',{id:'interrupted',ballot:{cat:'critic',vote:'retire',reason:'Done'}});
  const replay=new Store(f.file,[]);new Town(replay,config);assert.equal(replay.state.councils[0].status,'interrupted');assert.ok(replay.state.cats.some(c=>c.id===f.id));
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('a cat can invoke peer review through the normal tool dispatcher',async()=>{
 const f=fixture();try{
  f.town.providers.test=async(messages,tools)=>tools.length===1?ballot('retire'):messages.some(m=>m.role==='tool')?{message:{role:'assistant',content:'Council completed.'}}:{message:{role:'assistant',tool_calls:[{id:'review',function:{name:'review_cat',arguments:JSON.stringify({cat:f.id,reason:'Assignment completed',evidence:['sample']})}}]}};
  const task=f.town.submit('critic','Review completed specialist','test');for(let i=0;i<200&&f.store.state.tasks.find(t=>t.id===task)!.status==='running';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.store.state.tasks.find(t=>t.id===task)!.status,'done');assert.equal(f.store.state.councils[0].status,'retired');
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

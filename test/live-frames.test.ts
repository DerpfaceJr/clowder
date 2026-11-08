// Plan 8.2 and 8.3: activity and live-text frames reach owner pages beside the journal's own frames and never touch the journal; Stop ends a
// request's whole task tree as cancelled.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyFrame} from '../public/state-delta.js';
import {fixture,until} from './live-helpers.ts';

const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',content:null,tool_calls:[{id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
const transient=(frames:any[])=>frames.filter(f=>f.activity||f.delta);

test('one tool call gives one activity frame to the owner, none to a viewer, and no journal line', async()=>{
  const {store,town,owner,viewer,lines}=fixture({test:async(messages)=>messages.some((m:any)=>m.role==='tool')?reply('Found nothing on the harbour.'):call('lookup',{query:'harbour'})});
  const before=lines();
  town.submit('mayor','What do we know about the harbour?','test');
  await until(()=>store.state.tasks[0]?.status==='done');
  const activity=owner.filter(f=>f.activity);
  assert.equal(activity.length,1);
  assert.deepEqual(activity[0].activity,{task:store.state.tasks[0].id,cat:'mayor',label:'looking things up'});
  assert.equal(activity[0].seq,store.state.events.findIndex(e=>e.type==='tool.started')+1,'it carries the seq of the tool.started it rides beside');
  assert.deepEqual(transient(viewer),[],'a viewer gets only the journal’s frames');
  // Every journal line made exactly one seq frame, and the activity frame made none.
  const seqFrames=viewer.filter(f=>!f.hello);
  assert.equal(lines()-before,seqFrames.length);
  assert.deepEqual(owner.filter(f=>!f.activity&&!f.delta),viewer);
  assert.equal(lines(),store.state.events.length);
  assert.ok(!store.state.events.some(e=>/activity|delta/.test(e.type)));
});

test('the page keeps activity by task without moving seq, and drops it when the task ends', ()=>{
  const state={seq:5,activeWorld:{id:'home'},limits:{events:10},events:[],messages:[],tasks:[{id:'t1',cat:'mayor',status:'running'}],approvals:[]};
  const a=applyFrame(state,{seq:5,world:'home',activity:{task:'t1',cat:'mayor',label:'reading a page'}});
  assert.equal(a.seq,5);assert.deepEqual(a.live.t1,{cat:'mayor',label:'reading a page'});
  const b=applyFrame(a,{seq:5,world:'home',delta:{task:'t1',cat:'mayor',text:'Hel'}});
  assert.deepEqual(b.live.t1,{cat:'mayor',label:'reading a page',text:'Hel'});
  assert.equal(applyFrame(b,{seq:4,world:'other',delta:{task:'t1',cat:'mayor',text:'x'}}),null,'another world refetches');
  const c=applyFrame(b,{seq:6,world:'home',task:{id:'t1',cat:'mayor',status:'cancelled'}});
  assert.equal(c.seq,6);assert.equal(c.live.t1,undefined);
});

test('Stop ends a running task as cancelled and aborts its model call', async()=>{
  let aborted=false;
  const {store,town}=fixture({test:(_m,_t,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('This operation was aborted'));}))});
  town.submit('mayor','Plan the harbour festival','test');
  await until(()=>store.state.tasks[0]?.status==='running'&&town.controllers.size>0);
  const id=store.state.tasks[0].id;
  assert.throws(()=>town.stop('viewer',id),/Only the owner/);
  assert.equal(town.stop('owner',id),'Stopped.');
  await until(()=>store.state.tasks[0].status==='cancelled');
  assert.ok(aborted);
  assert.equal(store.state.tasks[0].result,'Stopped by owner.');
  assert.equal(town.controllers.size,0);
  assert.throws(()=>town.stop('owner',id),/not running/);
});

test('Stop ends a demo request’s whole tree as cancelled, with its decision', async()=>{
  const {store,town}=fixture();
  town.submit('mayor','Help the town explore a small digital service.','demo');
  await until(()=>store.state.approvals.some(a=>a.status==='pending'),15000);
  const root=store.state.tasks.find(t=>!t.parent)!;
  assert.ok(store.state.tasks.length>1,'the demo delegated');
  town.stop('owner',root.id);
  await until(()=>store.state.tasks.find(t=>t.id===root.id)!.status==='cancelled');
  assert.ok(!store.state.tasks.some(t=>['running','waiting','waiting_child'].includes(t.status)));
  assert.ok(store.state.approvals.every(a=>a.status!=='pending'));
  assert.equal(town.controllers.size,0);
});

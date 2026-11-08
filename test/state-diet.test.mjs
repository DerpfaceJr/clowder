// Snapshot diet and SSE deltas (product plan 2.2, 2.3): /api/state carries recent data only, chats page back through
// Store.chat, and every frame from DeltaFeed, applied by the page's own applyFrame, gives the state a fresh snapshot shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {DeltaFeed} from '../src/state-delta.ts';
import {applyFrame,chatMessages} from '../public/state-delta.js';
import {chatTokens,usageSummary} from '../public/treasury-view.js';
import {MessageVisits} from '../public/world-motion.js';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const LIMITS=config.snapshot;
const cats=[{id:'mayor',name:'Mayor',role:'r',color:'#fff',icon:'x'}];
const temp=()=>join(mkdtempSync(join(tmpdir(),'state-diet-')),'events.jsonl');
const line=(type,data,i)=>JSON.stringify({id:`e${i}`,at:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),type,data});
const SMALL=['cats','roads','paused','treasury','retiredCats','councils','layoutVersion','groups','introduced','goals','usage'];

test('a live-scale journal gives a snapshot under 300 KB with recent messages, unfinished tasks and summed usage', () => {
  // About the owner's world: 2,400 messages of ~1.2 KB over 23 cats, 1,059 tasks of ~2 KB, 4,777 usage rows (ux-audit F1).
  const file=temp(),text='x'.repeat(1200),lines=[line('founded',{cats},0)];let i=1;
  for(let c=1;c<23;c++)lines.push(line('cat.created',{id:`c${c}`,name:`Cat ${c}`,role:'r',color:'#fff',icon:'x'},i++));
  for(let t=0;t<1059;t++){lines.push(line('task.created',{id:`t${t}`,cat:`c${t%22+1}`,from:'mayor',text,mode:'claude',status:'running',context:'secret-context'},i++));lines.push(line('task.updated',{id:`t${t}`,status:t<1050?'done':'running',result:text},i++));}
  for(let m=0;m<2400;m++)lines.push(line('message',{from:m%2?'mayor':`c${m%22+1}`,to:m%2?`c${m%22+1}`:'mayor',text,task:`t${m%1059}`},i++));
  for(let u=0;u<4777;u++)lines.push(line('usage',{task:`t${u%1059}`,cat:'mayor',mode:u%3?'claude':'local',input:u%10?100:null,output:5},i++));
  writeFileSync(file,lines.join('\n')+'\n');
  const store=new Store(file,cats),snap=store.snapshot(LIMITS),bytes=Buffer.byteLength(JSON.stringify(snap));
  assert.ok(bytes<=300_000,`snapshot is ${bytes} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(store.state))>5_000_000,'the journal itself is live-scale');
  assert.equal(snap.messages.length,LIMITS.messages);
  assert.deepEqual(snap.messages.map(m=>m.id),store.state.messages.slice(-LIMITS.messages).map(m=>m.id));
  assert.deepEqual(snap.tasks.map(t=>t.id),store.state.tasks.filter(t=>t.status==='running').map(t=>t.id),'only unfinished work');
  assert.ok(!JSON.stringify(snap).includes('secret-context'),'no task context');
  assert.equal(snap.seq,store.state.events.length);
  // Summed usage says what the rows say.
  assert.deepEqual(chatTokens(snap.usage),chatTokens(store.state.usage));
  assert.ok(snap.usage.length<=2);
  assert.ok(snap.events.length<=LIMITS.events&&snap.events.every(e=>['message','task.updated'].includes(e.type)));
});

test('a chat pages back through every message of that cat, newest page first, and the first page brings its tasks', () => {
  const file=temp(),lines=[line('founded',{cats},0)];let i=1;
  for(let m=0;m<130;m++)lines.push(line('message',{from:m%3?'mayor':'owner',to:m%3===1?'c1':m%3===2?'c2':'mayor',text:`m${m}`},i++));
  for(let t=0;t<30;t++)lines.push(line('task.created',{id:`t${t}`,cat:'c1',from:'mayor',text:'x',mode:'demo',status:'done',context:'secret-context'},i++));
  writeFileSync(file,lines.join('\n')+'\n');
  const store=new Store(file,cats),mine=store.state.messages.filter(m=>m.from==='c1'||m.to==='c1');
  let page=store.chat('c1',{limit:20,tasks:5}),seen=[...page.messages],pages=1;
  assert.deepEqual(page.tasks.map(t=>t.id),['t25','t26','t27','t28','t29']);
  assert.ok(page.tasks.every(t=>!('context' in JSON.parse(JSON.stringify(t)))));
  while(page.more){page=store.chat('c1',{before:seen[0].id,limit:20,tasks:5});assert.equal(page.tasks,undefined);seen=[...page.messages,...seen];pages++;}
  assert.deepEqual(seen.map(m=>m.id),mine.map(m=>m.id));
  assert.equal(pages,Math.ceil(mine.length/20));
  assert.throws(()=>store.chat('c1',{before:'nope',limit:20,tasks:5}),/not in this town/);
  // The page merges with what the state already has, without duplicates, in time order.
  assert.deepEqual(chatMessages(seen.slice(0,-3),store.state.messages.slice(-10),'c1').map(m=>m.id),mine.map(m=>m.id));
});

test('frames applied by the page give the same state as a fresh snapshot, and carry no context or approval messages', () => {
  const file=temp(),store=new Store(file,cats),source={store,activeWorld:()=>({id:'home'})},feed=new DeltaFeed(source),frames=[];
  feed.clients.add(data=>frames.push(data));
  store.listeners.add(e=>feed.publish(e));
  const page=()=>({...store.snapshot(LIMITS),activeWorld:{id:'home'},limits:LIMITS});
  let state=JSON.parse(JSON.stringify(page()));
  const hello=JSON.parse(feed.hello());assert.deepEqual(hello,{hello:true,seq:state.seq,world:'home'});
  store.emit('cat.created',{id:'c1',name:'Cat',role:'r',color:'#fff',icon:'x'});
  store.emit('message',{from:'owner',to:'mayor',text:'hello',task:'t1'});
  store.emit('task.created',{id:'t1',cat:'mayor',from:'owner',text:'hello',mode:'demo',status:'running',context:'secret-context'});
  store.emit('tool.started',{task:'t1',cat:'mayor',name:'x'});
  store.emit('approval.requested',{id:'a1',task:'t1',cat:'mayor',question:'ok?',options:['Yes'],status:'pending',messages:['secret-approval'],toolCallId:'x',turn:0,depth:0});
  store.emit('usage',{task:'t1',cat:'mayor',mode:'claude',input:10,output:2});
  store.emit('approval.resolved',{id:'a1',status:'approved',answer:'Yes'});
  store.emit('goal.created',{id:'g1',title:'Goal',success:'s',status:'active',mode:'demo',rounds:0,roundsToday:0,day:'',failures:0,log:[],summary:null,maxRoundsPerDay:null,tokenBudget:null,pausedBy:null,note:null,endedBy:null});
  store.emit('task.updated',{id:'t1',status:'done',result:'done',context:'secret-context'});
  store.emit('paused',{value:true});
  assert.equal(frames.length,10);
  assert.ok(frames.every(f=>!f.includes('secret-context')&&!f.includes('secret-approval')),'frames use the snapshot projection');
  const parsed=frames.map(f=>JSON.parse(f));
  assert.deepEqual(parsed.map(f=>f.seq),parsed.map((_,i)=>state.seq+i+1),'one frame per event, in journal order');
  assert.equal(parsed[3].event,undefined,'a type no reader uses sends no event body');
  assert.deepEqual(Object.keys(parsed[3]).sort(),['seq','world'],'and nothing else when it changed nothing a page sees');
  const prev=state;
  for(const f of parsed){const next=applyFrame(state,f);assert.ok(next&&next!==state);state=next;}
  assert.equal(prev.messages.length,0,'applying never mutates the previous state');
  const fresh=JSON.parse(JSON.stringify(page())); // what the page receives
  for(const key of SMALL)assert.deepEqual(state[key],fresh[key],key);
  for(const key of ['seq','messages','events','approvals'])assert.deepEqual(state[key],fresh[key],key);
  // The page keeps finished work it saw finish; a fresh snapshot leaves it to the cat's chat page.
  assert.deepEqual(state.tasks.filter(t=>t.status!=='done'),fresh.tasks);
  assert.equal(state.tasks.find(t=>t.id==='t1').status,'done');
  // A missed frame, a frame from another world, and one the snapshot already had.
  assert.equal(applyFrame(prev,parsed[1]),null);
  assert.equal(applyFrame(prev,{...parsed[0],world:'other'}),null);
  assert.equal(applyFrame(state,parsed[0]),state);
  // A switch tells pages to refetch, and the next frame sends every small key again.
  feed.publish();assert.equal(frames.at(-1),'changed');
  store.emit('paused',{value:false});
  assert.deepEqual(Object.keys(JSON.parse(frames.at(-1)).patch).sort(),[...SMALL].sort());
});

test('summed usage sums like the rows it came from', () => {
  const rows=[{mode:'claude',input:5,output:1},{mode:'plan',input:2,output:2},{mode:'local',input:null,output:3},{mode:'demo',input:1,output:1},{mode:'claude',input:1,output:1}];
  assert.deepEqual(chatTokens(usageSummary(rows)),chatTokens(rows));
  assert.deepEqual(usageSummary([...usageSummary(rows.slice(0,2)),...rows.slice(2)]),usageSummary(rows));
  assert.deepEqual(chatTokens(rows),{rows:[{provider:'Claude plan',calls:3,input:8,output:4,unknown:0},{provider:'Local AI',calls:1,input:0,output:0,unknown:1}],calls:4,input:8,output:4,unknown:1});
});

test('a refetched window that starts past the visit cursor is a new baseline, not a burst of old visits', () => {
  const visits=new MessageVisits(),cats=[{id:'a'},{id:'b'}],m=id=>({id,from:'a',to:'b'});
  visits.ingest([m('1'),m('2')],cats);
  visits.ingest([m('1'),m('2'),m('3')],cats);
  assert.deepEqual(visits.queue.map(x=>x.id),['3'],'a frame appended one message: one visit');
  visits.queue=[];
  visits.ingest([m('7'),m('8'),m('9')],cats);
  assert.deepEqual(visits.queue,[],'the cursor fell out of the window');
  visits.ingest([m('8'),m('9'),m('10')],cats);
  assert.deepEqual(visits.queue.map(x=>x.id),['10']);
});

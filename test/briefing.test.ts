import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {briefingBlock,BRIEF,registerRoutineRoutes} from '../src/routines.ts';
import {quests,type QuestInput} from '../src/quests.ts';
import {ROUTINE_TEMPLATES} from '../src/routine-templates.ts';
import {PushService} from '../src/push.ts';
import type {Provider} from '../src/provider.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const reply=(content:string)=>({message:{role:'assistant',content}});
// Lets queued immediates and promise chains run. No real time passes.
const settle=async(n=40)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const towns:Town[]=[];
after(()=>{for(const t of towns)t.dispose();});
const fixture=(providers:Record<string,Provider>={test:async()=>reply('Briefing ready: two things need you.\nDetails follow.')})=>{
  const file=join(mkdtempSync(join(tmpdir(),'briefing-')),'events.jsonl');
  const store=new Store(file,allRoles(config)),town=new Town(store,config,providers);towns.push(town);
  return {store,town};
};
// The same input the briefing builds when no host sets one: the journal only.
const inputOf=(store:Store):QuestInput=>({state:store.state,projects:[],capabilities:[],seasons:[],models:null,now:new Date()});
const pendingDecision=(store:Store,id:string,question:string)=>store.emit('approval.requested',{id,task:'t-none',cat:'mayor',question,options:['Allow','Deny'],status:'pending',toolCallId:`call-${id}`,turn:1,depth:0,detail:''});

test('every routine template saves and dry-runs on a scratch town',async()=>{
  const {store,town}=fixture();
  assert.equal(ROUTINE_TEMPLATES.length,10);
  assert.equal(new Set(ROUTINE_TEMPLATES.map(t=>t.id)).size,10,'template ids are unique');
  for(const t of ROUTINE_TEMPLATES){
    // The owner picks the model; the template only suggests the schedule and cat.
    const saved=town.routines.save({title:t.title,prompt:t.prompt,cat:t.cat,mode:'test',schedule:{cron:t.schedule.cron,timezone:'UTC'},tokenBudget:null,enabled:true});
    const task=town.routines.fire(saved.id,'manual');
    await settle();
    assert.equal(store.state.tasks.find(x=>x.id===task)?.status,'done',`${t.id} runs to done`);
  }
  assert.equal(store.state.routines.length,10);
});

test('the briefing lists every open decision and to-do, and the count equals the quests that need the owner',async()=>{
  const {store,town}=fixture();
  pendingDecision(store,'d1','Save the routine “Weekly review”?');
  pendingDecision(store,'d2','Allow Gmail send for Mayor?');
  store.emit('owner.step',{id:'s1',goal:null,cat:'mayor',title:'Connect your calendar',steps:'Sign in at calendar.example.com',blocking:false});
  const briefing=town.routines.save({title:'Daily briefing',prompt:`Write it.\n\n${BRIEF}`,cat:'mayor',mode:'test',schedule:{cron:'0 7 * * *',timezone:'UTC'},tokenBudget:null,enabled:true});
  const task=town.routines.fire(briefing.id,'manual');
  const text=store.state.tasks.find(t=>t.id===task)!.text;
  const needs=quests(inputOf(store)).filter(q=>q.needsYou);
  assert.ok(needs.length>=3,'the fixture has at least three open items');
  // Every open decision and to-do is in the text, and none is left as the marker.
  for(const q of needs)assert.ok(text.includes(q.title),`lists “${q.title}”`);
  assert.ok(!text.includes(BRIEF));
  // Decisions and to-dos add up to the quests count the Quests panel shows.
  const dec=/Open decisions \((\d+)\)/.exec(text),todo=/Open to-dos \((\d+)\)/.exec(text),total=/Needs you in total: (\d+)/.exec(text);
  assert.equal(Number(dec![1])+Number(todo![1]),needs.length);
  assert.equal(Number(total![1]),needs.length);
  assert.equal(Number(dec![1]),2);
  assert.equal(Number(todo![1]),1);
  // The block is also what briefingBlock gives for the same input, so the two paths agree.
  assert.equal(briefingBlock(store.state,null,new Date(),quests(inputOf(store))).split('\n').at(-1),`Needs you in total: ${needs.length}.`);
});

test('a briefing run pushes its first line once, and not when the owner turned routine pushes off',async()=>{
  const {store,town}=fixture();
  const sent:string[]=[];
  const dir=mkdtempSync(join(tmpdir(),'briefing-push-'));
  // windowMs 0: each notice goes out at once, so the count is the count of runs.
  const push=new PushService({dataDir:dir,windowMs:0,send:async(endpoint)=>{sent.push(endpoint);return 201;}});
  push.attach({get state(){return store.state;},listeners:store.listeners as any});
  const ecdh=createECDH('prime256v1');ecdh.generateKeys();
  const keys={p256dh:ecdh.getPublicKey(undefined,'uncompressed').toString('base64url'),auth:randomBytes(16).toString('base64url')};
  push.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/on',keys});
  push.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/off',keys,kinds:{routines:false}});
  const briefing=town.routines.save({title:'Daily briefing',prompt:`Write it.\n\n${BRIEF}`,cat:'mayor',mode:'test',schedule:{cron:'0 7 * * *',timezone:'UTC'},tokenBudget:null,enabled:true});
  town.routines.fire(briefing.id,'manual');
  await settle();
  assert.deepEqual(sent,['https://fcm.googleapis.com/fcm/send/on'],'one push, to the subscriber that allows routine pushes');
  const plain=town.routines.save({title:'Plain note',prompt:'Write a note.',cat:'mayor',mode:'test',schedule:null,tokenBudget:null,enabled:true});
  town.routines.fire(plain.id,'manual');
  await settle();
  assert.equal(sent.length,1,'a routine without the briefing marker does not push');
  town.routines.fire(briefing.id,'manual');
  await settle();
  assert.equal(sent.length,2,'the next briefing run pushes once more');
  const runs=store.state.events.filter(e=>e.type==='routine.briefed');
  assert.equal(runs.length,2);
  assert.equal(runs[0].data.line,'Briefing ready: two things need you');
  // The briefing text is on the routine's panel entry, from its last run.
  assert.match(town.routines.view().find(r=>r.id===briefing.id)!.briefing??'',/Details follow./);
  push.close();
});

test('the routine library route is owner-only',async()=>{
  const deny=Fastify();registerRoutineRoutes(deny,{town:()=>{throw new Error('unused');},canWrite:()=>false});
  assert.equal((await deny.inject({method:'GET',url:'/api/routines/templates'})).statusCode,403);
  await deny.close();
  const {town}=fixture();
  const app=Fastify();registerRoutineRoutes(app,{town:()=>town,canWrite:()=>true});
  const res=await app.inject({method:'GET',url:'/api/routines/templates'});
  assert.equal(res.statusCode,200);
  assert.equal(res.json().templates.length,10);
  await app.close();
});

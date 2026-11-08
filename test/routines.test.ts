import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {installAccess,isOwner} from '../src/access.ts';
import {Pairing} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {nextRunAt,registerRoutineRoutes,routineWarning} from '../src/routines.ts';
import type {Provider} from '../src/provider.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const reply=(content:string,usage?:any)=>({message:{role:'assistant',content},usage});
const call=(name:string,args:any)=>({message:{role:'assistant',content:null,tool_calls:[{id:`call-${Math.random()}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
// Lets queued immediates and promise chains run. No real time passes, so it works under a mocked clock.
const settle=async(n=30)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const towns:Town[]=[];
after(()=>{for(const t of towns)t.dispose();});
const fixture=(providers:Record<string,Provider>={test:async()=>reply('Briefing done.')},file=join(mkdtempSync(join(tmpdir(),'routines-')),'events.jsonl'),cfg=config)=>{
  const store=new Store(file,allRoles(cfg)),town=new Town(store,cfg,providers);towns.push(town);return {file,store,town};
};
const runsOf=(store:Store,id:string)=>store.state.tasks.filter(t=>t.routine===id);
const daily={cron:'0 7 * * *',timezone:'UTC'};

test('the next run keeps 07:00 local time across a DST change',()=>{
  const weekdays={cron:'0 7 * * 1-5',timezone:'America/New_York'};
  // New York moves to EDT on 8 March and back to EST on 1 November 2026: 07:00 local is 11:00 then 12:00 UTC.
  assert.equal(nextRunAt(weekdays,new Date('2026-03-06T13:00:00Z'))!.toISOString(),'2026-03-09T11:00:00.000Z');
  assert.equal(nextRunAt(weekdays,new Date('2026-10-30T13:00:00Z'))!.toISOString(),'2026-11-02T12:00:00.000Z');
  // London moves to BST on 29 March 2026.
  assert.equal(nextRunAt({cron:'0 7 * * *',timezone:'Europe/London'},new Date('2026-03-28T08:00:00Z'))!.toISOString(),'2026-03-29T06:00:00.000Z');
  assert.throws(()=>nextRunAt({cron:'* * * * * *',timezone:'UTC'}),/5-part/,'no seconds field');
});

test('a schedule missed over a long downtime runs once on start, not once per missed slot',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T08:00:00Z')});
  const first=fixture();
  const r=first.town.routines.save({title:'Daily note',prompt:'Write the daily note.',mode:'test',schedule:daily});
  first.town.dispose();
  // 36 daily slots pass while the server is off.
  t.mock.timers.setTime(Date.parse('2026-11-06T12:00:00Z'));
  const {store,town}=fixture(undefined,first.file);
  await settle();
  assert.equal(runsOf(store,r.id).length,1);
  assert.deepEqual(store.state.events.filter(e=>e.type==='routine.ran').map(e=>e.data.trigger),['catch-up']);
  assert.equal(store.state.routines[0].lastRunAt,'2026-11-06T12:00:00.000Z');
  assert.equal(town.routines.view()[0].nextRunAt,'2026-11-07T07:00:00.000Z');
  // Starting again the same day finds nothing missed.
  town.dispose();
  const third=fixture(undefined,first.file);await settle();
  assert.equal(runsOf(third.store,r.id).length,1);
});

test('a scheduled routine fires at its time',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-11-09T06:59:00Z')});
  const {store,town}=fixture();await settle();
  const r=town.routines.save({title:'Seven',prompt:'Run at seven.',mode:'test',schedule:{cron:'0 7 * * 1-5',timezone:'UTC'}});
  t.mock.timers.tick(59_000);
  assert.equal(runsOf(store,r.id).length,0);
  t.mock.timers.tick(1_000);await settle();
  assert.equal(runsOf(store,r.id).length,1);
  assert.equal(store.state.events.find(e=>e.type==='routine.ran')!.data.trigger,'schedule');
});

test('a routine never runs over itself',async()=>{
  const {store,town}=fixture({test:()=>new Promise(()=>{})});
  const r=town.routines.save({title:'Long job',prompt:'Do the long job.',mode:'test',schedule:daily});
  town.routines.fire(r.id,'manual');
  assert.throws(()=>town.routines.fire(r.id,'manual'),/still going/);
  assert.throws(()=>town.routines.fire(r.id,'schedule'),/still going/);
  assert.equal(runsOf(store,r.id).length,1);
  // The skipped slot is recorded, so it is not caught up later.
  assert.match(store.state.routines[0].note!,/Skipped: its last run is still going/);
});

test('the webhook runs a routine only with its own token, on the remote listener',async()=>{
  const {store,town}=fixture();
  const r=town.routines.save({title:'Hooked',prompt:'Check the form.',mode:'test',schedule:null});
  const app=Fastify(),host='town.example.com';
  installRemoteAccess(app,new Pairing(join(mkdtempSync(join(tmpdir(),'routines-remote-')),'devices.json'),config.remote),()=>`https://${host}`);
  registerRoutineRoutes(app,{town:()=>town,canWrite:()=>false});
  const post=(url:string)=>app.inject({method:'POST',url,headers:{host,'content-type':'application/json'},payload:{note:'outside text is dropped'}});
  try{
    assert.equal((await post(`/hooks/routines/${r.id}/${'A'.repeat(43)}`)).statusCode,404,'no hook yet');
    const token=town.routines.rotateHook(r.id);
    assert.ok(!JSON.stringify(store.state).includes(token),'the journal keeps only its hash');
    assert.equal((await post(`/hooks/routines/${r.id}/${token.slice(0,-1)}${token.endsWith('A')?'B':'A'}`)).statusCode,404);
    assert.equal((await post(`/hooks/routines/not-a-routine/${token}`)).statusCode,404);
    assert.equal(runsOf(store,r.id).length,0);
    const ok=await post(`/hooks/routines/${r.id}/${token}`);
    assert.equal(ok.statusCode,202);
    assert.equal(runsOf(store,r.id).length,1);
    assert.equal(store.state.events.find(e=>e.type==='routine.ran')!.data.trigger,'webhook');
    assert.ok(!store.state.messages.some(m=>String(m.text).includes('outside text')),'the body never reaches the prompt');
    // Owner routes stay closed on the remote listener.
    assert.equal((await post(`/api/routines/${r.id}/run`)).statusCode,403);
    // A new token retires the old one.
    town.routines.rotateHook(r.id);await settle();
    assert.equal((await post(`/hooks/routines/${r.id}/${token}`)).statusCode,404);
  }finally{await app.close();}
});

test('a token budget stops the routine and turns it off with the reason',async()=>{
  const {store,town}=fixture({test:async()=>reply('Done.',{prompt_tokens:600,completion_tokens:500})});
  const r=town.routines.save({title:'Costly',prompt:'Do it.',mode:'test',schedule:daily,tokenBudget:1000});
  town.routines.fire(r.id,'manual');await settle();
  assert.throws(()=>town.routines.fire(r.id,'manual'),/Token budget reached/);
  assert.equal(runsOf(store,r.id).length,1);
  assert.equal(store.state.routines[0].enabled,false);
  assert.match(store.state.routines[0].note!,/Raise the budget/);
  assert.equal(town.routines.view()[0].nextRunAt,null,'its schedule is off');
  // Raising the budget and turning it back on runs it again.
  town.routines.save({id:r.id,tokenBudget:5000,enabled:true});
  town.routines.fire(r.id,'manual');await settle();
  assert.equal(runsOf(store,r.id).length,2);
});

test('the Mayor’s save_routine files an approval, and only Allow saves the routine',async()=>{
  const draft={title:'Morning briefing',prompt:'Give me a briefing: what happened and what needs me.',cron:'0 7 * * 1-5',timezone:'Europe/London'};
  const mayor:Provider=async messages=>messages.some(m=>m.role==='tool')?reply('Asked you.'):call('save_routine',draft);
  const {store,town}=fixture({test:mayor});
  town.submit('mayor','Every weekday at 7 give me a briefing','test');await settle();
  const card=store.state.approvals.find(a=>a.gate==='routine')!;
  assert.equal(card.status,'pending');
  assert.match(card.question,/Morning briefing.*0 7 \* \* 1-5.*Europe\/London/);
  assert.equal(store.state.routines.length,0,'nothing is saved before Allow');
  assert.equal(store.state.tasks.find(t=>t.id===card.task)!.status,'done','the Mayor carried on');
  town.decide(card.id,'Allow',true);
  assert.equal(store.state.approvals.find(a=>a.id===card.id)!.status,'approved');
  const saved=store.state.routines[0];
  assert.deepEqual({title:saved.title,cat:saved.cat,mode:saved.mode,schedule:saved.schedule,enabled:saved.enabled},{title:'Morning briefing',cat:'mayor',mode:'test',schedule:{cron:'0 7 * * 1-5',timezone:'Europe/London'},enabled:true});
  assert.ok(town.routines.view()[0].nextRunAt);
  // Deny saves nothing.
  town.submit('mayor','And one at 8','test');await settle();
  const second=store.state.approvals.find(a=>a.gate==='routine'&&a.status==='pending')!;
  town.decide(second.id,'Deny',false);
  assert.equal(store.state.routines.length,1);
});

test('a run is shown as from the town, and waits in the inbox when the town is busy',async()=>{
  let release=()=>{};
  const busy:Provider=async messages=>{if(String(messages.at(-1)?.content).startsWith('Busy'))await new Promise<void>(r=>release=r);return reply('Briefing done.');};
  const {store,town}=fixture({test:busy},undefined,{...config,maxParallelWork:1});
  const r=town.routines.save({title:'Brief',prompt:'Brief me.',mode:'test',schedule:null});
  town.submit('scholar','Busy work','test');
  const id=town.routines.fire(r.id,'manual');
  assert.equal(store.state.tasks.find(t=>t.id===id)!.status,'queued');
  release();await settle();
  assert.equal(store.state.tasks.find(t=>t.id===id)!.status,'done');
  const lines=store.state.messages.filter(m=>m.task===id);
  assert.deepEqual([lines[0].from,lines[0].to],['town','mayor']);
  assert.ok(!lines.some(m=>m.from==='owner'),'never shown as the owner');
  assert.ok(lines.some(m=>m.from==='mayor'&&m.to==='owner'&&m.text==='Briefing done.'),'the reply still goes to the owner');
});

test('a paused town holds a slot, and resuming runs it once',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-06T06:00:00Z')});
  const {store,town}=fixture();
  const r=town.routines.save({title:'Seven',prompt:'Run at seven.',mode:'test',schedule:daily});
  town.pause(true);
  t.mock.timers.setTime(Date.parse('2026-11-08T09:00:00Z'));
  assert.throws(()=>town.routines.fire(r.id,'schedule'),/Resume the town/);
  assert.equal(store.state.routines[0].lastRunAt,null,'nothing is recorded while paused');
  town.pause(false);await settle();
  assert.equal(runsOf(store,r.id).length,1);
});

test('routines survive a store reopen, webhook included',async()=>{
  const {file,store,town}=fixture();
  const r=town.routines.save({title:'Kept',prompt:'Keep me.',mode:'test',schedule:{cron:'30 6 * * 1',timezone:'Asia/Tokyo'},tokenBudget:9000});
  const gone=town.routines.save({title:'Gone',prompt:'Remove me.',mode:'test',schedule:null});
  const token=town.routines.rotateHook(r.id);
  town.routines.remove(gone.id);
  town.routines.fire(r.id,'manual');await settle();
  const before=structuredClone(store.state.routines);
  town.dispose();
  const again=fixture(undefined,file);await settle();
  assert.deepEqual(again.store.state.routines,before);
  assert.ok(again.town.routines.hookMatches(r.id,token));
  assert.ok(again.town.routines.view()[0].nextRunAt);
});

test('a routine that mixes private data, outside input and sending carries a warning',()=>{
  assert.equal(routineWarning('Every weekday at 7 give me a briefing of what happened.'),null);
  assert.equal(routineWarning('Summarise my email and send me the summary.'),null);
  assert.match(routineWarning('Read my inbox and reply to every email from a customer.')!,/outside content/);
  const {town}=fixture();
  assert.match(town.routines.save({title:'Triage',prompt:'Read my inbox and reply to every email from a customer.',mode:'test',schedule:null}).warning!,/sends things out/);
});

test('owner routes save, list, run, rotate and remove; others are refused',async()=>{
  const {store,town}=fixture();
  const app=Fastify();installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  // As server.ts: a thrown check is the owner's 400 with its sentence.
  app.setErrorHandler((error:any,_req,res)=>{res.code(error.statusCode||400).send({error:error.message});});
  registerRoutineRoutes(app,{town:()=>town,canWrite:isOwner});
  const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  try{
    const made=await app.inject({method:'POST',url:'/api/routines',headers:owner,payload:{title:'Brief',prompt:'Brief me.',mode:'test',schedule:{cron:'0 7 * * 1-5'}}});
    assert.equal(made.statusCode,200);
    const id=made.json().routine.id;
    assert.equal(made.json().routine.schedule.timezone,Intl.DateTimeFormat().resolvedOptions().timeZone,'the host timezone by default');
    assert.equal((await app.inject({method:'POST',url:'/api/routines',headers:owner,payload:{title:'Bad',prompt:'x',mode:'test',schedule:{cron:'61 7 * * *'}}})).statusCode,400);
    const hook=(await app.inject({method:'POST',url:`/api/routines/${id}/hook`,headers:owner})).json();
    assert.equal(hook.path,`/hooks/routines/${id}/${hook.token}`);
    const list=(await app.inject({method:'GET',url:'/api/routines',headers:owner})).json().routines;
    assert.equal(list[0].hook,true);assert.equal('hookHash' in list[0],false);
    const run=(await app.inject({method:'POST',url:`/api/routines/${id}/run`,headers:owner})).json();
    assert.equal(store.state.tasks.find(t=>t.id===run.task)!.routine,id);
    assert.equal((await app.inject({method:'GET',url:'/api/routines',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-forwarded-for':'10.0.0.2'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:`/api/routines/${id}`,headers:owner,payload:{enabled:false}})).json().routine.enabled,false);
    assert.equal((await app.inject({method:'POST',url:`/api/routines/${id}/remove`,headers:owner})).statusCode,200);
    assert.equal(store.state.routines.length,0);
  }finally{await app.close();}
});

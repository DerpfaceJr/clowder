// Plan 3.10: the usage route and the town-wide monthly token cap.
// The owner's months are the host's local calendar; a fixed non-UTC zone makes "local" testable (a row at 02:00 UTC on 1 November is October in New York).
process.env.TZ='America/New_York';
import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import Fastify from 'fastify';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {installAccess} from '../src/access.ts';
import {CAP_NOTE,capReached,capStatus,monthKey,registerUsageRoutes,usageReport} from '../src/usage.ts';
import type {Provider} from '../src/provider.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
// No recorder: its follow-up tasks would spend the fake provider's tokens and calls.
const cfg={...config,recorder:null};
const settle=async(n=40)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const towns:Town[]=[];
after(()=>{for(const t of towns)t.dispose();});
const dir=()=>mkdtempSync(join(tmpdir(),'usage-cap-'));
const tmp=(file=join(dir(),'events.jsonl'))=>{const store=new Store(file,allRoles(cfg));return store;};
const fixture=(providers:Record<string,Provider>)=>{const store=tmp(),town=new Town(store,cfg,providers);towns.push(town);return {store,town};};
const usage=(input:number,output:number)=>({prompt_tokens:input,completion_tokens:output});
// A provider whose first reply calls a tool and spends `first` tokens; every later reply finishes with 1+1.
const stepper=(first:number)=>{const calls={n:0};const p:Provider=async()=>{calls.n++;return calls.n===1?{message:{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'lookup',arguments:JSON.stringify({query:'town'})}}]},usage:usage(first-10,10)}:{message:{role:'assistant',content:'Finished.'},usage:usage(1,1)};};return {calls,p};};
const cards=(store:Store)=>store.state.approvals.filter(a=>a.gate==='cap');
const app=(town:Town)=>{const a=Fastify();installAccess(a,false,[],8787,undefined,undefined,'test-owner');a.setErrorHandler((error:any,_req,res)=>{res.code(error.statusCode||400).send({error:error.message});});registerUsageRoutes(a,{town:()=>town});return a;};
const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
const NOW=Date.parse('2026-11-15T17:00:00Z');

test('the route totals equal a hand count, by day, cat, mode, goal and routine, in the owner’s months',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const file=join(dir(),'events.jsonl');
  const ev=(at:string,type:string,data:any)=>JSON.stringify({id:`${at}-${type}-${Math.random()}`,at,type,data});
  const task=(id:string,cat:string,extra:any={})=>ev('2026-09-01T12:00:00Z','task.created',{id,cat,from:'owner',text:id,mode:'claude',status:'done',...extra});
  const row=(at:string,data:any)=>ev(at,'usage',{cost:null,...data});
  writeFileSync(file,[
    task('g1','mayor',{goal:'goal-a'}),task('g1c','scholar',{parent:'g1'}),task('r1','mayor',{routine:'rt-1'}),task('o1','scholar'),
    row('2026-09-20T15:00:00Z',{task:'g1',cat:'mayor',mode:'claude',input:9999,output:9}),     // two months back: left out
    row('2026-10-05T15:00:00Z',{task:'g1',cat:'mayor',mode:'claude',input:300,output:30}),
    row('2026-11-01T02:00:00Z',{task:'o1',cat:'scholar',mode:'claude',input:1000,output:1}),   // 22:00 on 31 October in New York
    row('2026-11-10T15:00:00Z',{task:'g1',cat:'mayor',mode:'claude',input:100,output:20}),
    row('2026-11-10T16:00:00Z',{task:'g1c',cat:'scholar',mode:'claude',input:50,output:5}),   // a goal's delegated child counts to the goal
    row('2026-11-12T15:00:00Z',{task:'r1',cat:'mayor',mode:'codex',input:200,output:0}),
    row('2026-11-12T15:30:00Z',{task:'o1',cat:'scholar',mode:'codex',input:null,output:null}),// plan row with no count: a call, no tokens
    row('2026-11-13T15:00:00Z',{cat:'mayor',mode:'claude',input:7,output:3}),                 // an aside: no task
    row('2026-11-14T15:00:00Z',{council:'k1',cat:'mayor',mode:'claude',input:4,output:1}),
  ].join('\n')+'\n');
  const store=tmp(file),town=new Town(store,cfg,{});towns.push(town);
  const a=app(town);
  try{
    const res=await a.inject({url:'/api/usage',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}}),body=res.json();assert.equal(res.statusCode,200,res.body);
    const T=(tokens:number,input:number,output:number,calls:number,unreported=0)=>({tokens,input,output,calls,unreported});
    assert.equal(body.current.month,'2026-11');assert.equal(body.previous.month,'2026-10');
    assert.deepEqual(body.current.total,T(390,361,29,6,1));
    assert.equal(body.current.cost,null,'plan and API rows carry no cost: unknown, never 0');
    assert.deepEqual(body.current.days,{'2026-11-10':T(175,150,25,2),'2026-11-12':T(200,200,0,2,1),'2026-11-13':T(10,7,3,1),'2026-11-14':T(5,4,1,1)});
    assert.deepEqual(body.current.cats,{mayor:T(335,311,24,4),scholar:T(55,50,5,2,1)});
    assert.deepEqual(body.current.modes,{claude:T(190,161,29,4),codex:T(200,200,0,2,1)});
    assert.deepEqual(body.current.goals,{'goal-a':T(175,150,25,2)});
    assert.deepEqual(body.current.routines,{'rt-1':T(200,200,0,1)});
    assert.deepEqual(body.previous.total,T(1331,1300,31,2));
    assert.deepEqual(body.previous.days,{'2026-10-05':T(330,300,30,1),'2026-10-31':T(1001,1000,1,1)});
    assert.deepEqual(body.cap,{month:'2026-11',cap:null,used:390,override:false,reached:false,card:null});
  }finally{await a.close();}
});

test('reaching the cap holds new work behind exactly one card',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const calls={n:0},p:Provider=async()=>{calls.n++;return {message:{role:'assistant',content:'Done.'},usage:usage(100,10)};},{store,town}=fixture({test:p});
  town.setUsageCap('owner',100);
  const first=town.submit('mayor','First job.','test');await settle();
  assert.equal(store.state.tasks.find(t=>t.id===first)!.status,'done');
  assert.equal(capReached(store.state),true);
  const before=calls.n;
  const queued=[town.submit('mayor','Second job.','test'),town.submit('mayor','Start a goal.','test',{goal:true})];await settle();
  assert.deepEqual(queued.map(id=>store.state.tasks.find(t=>t.id===id)!.status),['queued','queued'],'the Mayor’s inbox keeps them');
  const other=store.state.cats.find(c=>c.id!=='mayor')!.id;
  assert.throws(()=>town.submit(other,'Do a thing.','test'),new RegExp(CAP_NOTE.slice(0,20)));
  const r=town.routines.save({title:'Brief',prompt:'Brief me.',mode:'test',schedule:null});
  assert.throws(()=>town.routines.fire(r.id,'manual'),/cap/);
  assert.equal(store.state.events.filter(e=>e.type==='routine.ran').length,0,'a capped slot is not recorded, so it runs once on a lift');
  assert.equal(calls.n,before,'no model call past the cap');
  assert.equal(cards(store).length,1);
  assert.deepEqual([cards(store)[0].status,cards(store)[0].month,cards(store)[0].options],['pending','2026-11',['Raise the cap','Allow this once','Wait for next month']]);
  // Answered Wait: the month gets no second card, and work still waits.
  town.decide(cards(store)[0].id,'Wait for next month',false);
  town.submit('mayor','Third job.','test');await settle();
  assert.equal(cards(store).length,1);assert.equal(cards(store)[0].status,'rejected');
});

test('running work pauses after its current step; raising the cap lets it and the inbox continue',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {calls,p}=stepper(150),{store,town}=fixture({test:p});
  town.setUsageCap('owner',100);
  const id=town.submit('mayor','Look this up.','test');await settle();
  const task=()=>store.state.tasks.find(t=>t.id===id)!;
  assert.deepEqual([task().status,task().held],['waiting','cap']);
  assert.ok(store.state.events.some(e=>e.type==='tool.started'&&e.data.task===id),'the step that was running finished');
  assert.equal(calls.n,1,'no next step past the cap');
  const queued=town.submit('mayor','Next job.','test');
  assert.equal(cards(store).length,1);
  const card=cards(store)[0].id;
  assert.throws(()=>town.decide(card,'Raise the cap',true),/new monthly cap/);
  assert.throws(()=>town.decide(card,'120',true),/above that/);
  const a=app(town);
  try{
    assert.equal((await a.inject({method:'POST',url:'/api/usage/cap',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-forwarded-for':'10.0.0.2'},payload:{tokens:1000}})).statusCode,403,'not from a viewer');
    const res=await a.inject({method:'POST',url:'/api/usage/cap',headers:owner,payload:{tokens:1000}});
    assert.equal(res.statusCode,200);assert.equal(res.json().cap.reached,false);
  }finally{await a.close();}
  await settle();
  assert.deepEqual([task().status,task().held],['done',null]);
  assert.equal(store.state.tasks.find(t=>t.id===queued)!.status,'done');
  assert.equal(cards(store)[0].status,'approved');
  assert.equal(store.state.events.filter(e=>e.type==='usage.cap').at(-1)!.data.tokens,1000,'journaled');
});

test('allow this once lets this month run past the cap; the next month has the cap again',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {p}=stepper(110),{store,town}=fixture({test:p});
  town.setUsageCap('owner',100);
  town.submit('mayor','First job.','test');await settle();
  const queued=town.submit('mayor','Second job.','test');await settle();
  town.decide(cards(store)[0].id,'Allow this once',true);await settle();
  assert.equal(store.state.tasks.find(t=>t.id===queued)!.status,'done');
  assert.deepEqual([capStatus(store.state).override,capReached(store.state)],[true,false]);
  assert.equal(capReached(store.state,new Date('2026-12-15T17:00:00Z')),false,'December starts from 0');
  store.emit('usage',{cat:'mayor',mode:'test',input:100,output:0,cost:null});
  assert.equal(capReached(store.state,new Date('2026-11-20T17:00:00Z')),false,'still overridden in November');
});

test('a new month resets the cap: held work runs on and the inbox drains by itself',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  const {calls,p}=stepper(150),{store,town}=fixture({test:p});
  town.setUsageCap('owner',100);
  const held=town.submit('mayor','Look this up.','test');await settle();
  const queued=town.submit('mayor','Next job.','test');await settle();
  assert.equal(store.state.tasks.find(t=>t.id===held)!.status,'waiting');
  // Midnight on 1 December in New York, plus the timer's second.
  t.mock.timers.tick(Date.parse('2026-12-01T05:00:01Z')-NOW);await settle();
  assert.equal(monthKey(),'2026-12');
  assert.deepEqual([held,queued].map(id=>store.state.tasks.find(t=>t.id===id)!.status),['done','done']);
  assert.equal(calls.n,3);
  assert.deepEqual(capStatus(store.state),{month:'2026-12',cap:100,used:4,override:false,reached:false,card:null});
  assert.equal(cards(store).length,1,'November’s card only');
});

// The measured route time on a copy of a live journal. Set USAGE_JOURNAL to a scratch copy (never the live file); without it this is skipped.
test('route time on a real journal',{skip:!process.env.USAGE_JOURNAL||!existsSync(process.env.USAGE_JOURNAL)},async t=>{
  const file=process.env.USAGE_JOURNAL!,lines=readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
  let t0=performance.now();const store=new Store(file,[]);const load=performance.now()-t0;
  const town={store} as unknown as Town,a=app(town),n=30;
  try{
    const body=(await a.inject({url:'/api/usage',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}})).json();
    // Reconcile: every usage row of the two months is one call in the route, counted from the raw lines.
    const keys=new Set([body.current.month,body.previous.month]);
    assert.equal(body.current.total.calls+body.previous.total.calls,lines.filter(e=>e.type==='usage'&&keys.has(monthKey(new Date(e.at)))).length);
    const times:number[]=[];
    for(let i=0;i<n;i++){t0=performance.now();await a.inject({url:'/api/usage',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}});times.push(performance.now()-t0);}
    t0=performance.now();for(let i=0;i<n;i++)usageReport(store.state);const report=(performance.now()-t0)/n;
    t0=performance.now();for(let i=0;i<n;i++)capReached(store.state);const cap=(performance.now()-t0)/n;
    const mean=times.reduce((s,x)=>s+x,0)/n;
    t.diagnostic(`journal ${lines.length} events, ${store.state.usage.length} usage rows; replay ${load.toFixed(0)} ms; GET /api/usage n=${n} mean ${mean.toFixed(2)} ms (max ${Math.max(...times).toFixed(2)}); usageReport mean ${report.toFixed(2)} ms; capReached mean ${cap.toFixed(3)} ms; MEASURED`);
  }finally{await a.close();}
});

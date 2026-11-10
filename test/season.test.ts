import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSeason, seasonStatus, view} from '../src/season.ts';
import type {Provider} from '../src/provider.ts';
import {act, checkInvariants, replay, startSeason} from '../src/economy.ts';
import type {EconomyEvent} from '../src/economy.ts';

const loaded=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
// Seasons run for the founders of their world; these tests use the full roster the season was written for.
const config={...loaded,cats:allRoles(loaded)};
const tmp=()=>mkdtempSync(join(tmpdir(),'season-'));
const journal=(dir:string,name:string)=>join(dir,`season-${name}.jsonl`);
const lines=(dir:string,name:string)=>readFileSync(journal(dir,name),'utf8').split('\n');
const readEvents=(dir:string,name:string):EconomyEvent[]=>lines(dir,name).filter(Boolean).map(l=>JSON.parse(l));
const shared=tmp();

test('a two-day demo season finishes with invariants, hand-offs, sales, approvals and rejections', async()=>{
  const r=await runSeason({name:'demo',mode:'demo',seed:1,days:2,dataDir:shared,config});
  assert.equal(r.done,true);
  const events=readEvents(shared,'demo');
  assert.deepEqual(checkInvariants(events),[]);
  const requester=new Map(events.filter(e=>e.type==='spend.requested').map(e=>[e.id,e.cat]));
  const handoffs=events.filter(e=>e.type==='spend.decided'&&e.by!=='system'&&requester.get(e.id)!==e.by);
  assert.ok(handoffs.length>0,'no spend decided by another cat');
  assert.ok(events.some(e=>e.type==='spend.decided'&&e.approved===true&&e.by!=='system'));
  assert.ok(events.some(e=>e.type==='business.sold'));
  assert.ok(events.some(e=>e.type==='spend.decided'&&e.approved===false&&e.by!=='system')||events.some(e=>e.type==='action'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='action'&&e.name==='message'));
  const upkeepIds=new Set(events.filter(e=>e.type==='coins.reserved'&&String(e.purpose).startsWith('upkeep')).map(e=>e.id));
  assert.ok(events.some(e=>e.type==='coins.settled'&&upkeepIds.has(e.id)),'no upkeep settlement');
});

test('seasonStatus reports progress, balance, hand-offs and invariants after a finished run', ()=>{
  const status=seasonStatus('demo',shared,config);
  assert.match(status,/progress: 8 of 8 ticks closed; finished/);
  assert.match(status,/balance: \d+ \(start 1000/);
  assert.match(status,/hand-offs [1-9]/);
  assert.match(status,/upkeep paid: \d+; businesses closed for upkeep: \d+/);
  assert.match(status,/actions: \d+ ok \(\d+ passes, of which \d+ model fallbacks\), \d+ rejected/);
  assert.match(status,/invariants OK/);
});

test('a season stopped after 3 ticks and resumed matches an uninterrupted run byte for byte', async()=>{
  const a=tmp(),b=tmp();
  const first=await runSeason({name:'r',mode:'demo',seed:7,days:2,dataDir:a,config,stopAfterTicks:3});
  assert.equal(first.done,false);
  const second=await runSeason({name:'r',mode:'demo',seed:7,days:2,dataDir:a,config});
  assert.equal(second.done,true);
  await runSeason({name:'r',mode:'demo',seed:7,days:2,dataDir:b,config});
  assert.deepEqual(lines(a,'r'),lines(b,'r'));
});

test('resuming mid-tick after a partly acted tick matches an uninterrupted run', async()=>{
  const full=tmp(),cut=tmp();
  await runSeason({name:'m',mode:'demo',seed:3,days:2,dataDir:full,config});
  const all=lines(full,'m');
  const starts=all.flatMap((l,i)=>JSON.parse(l||'{}').type==='tick.started'?[i]:[]);
  const actions=all.flatMap((l,i)=>JSON.parse(l||'{}').type==='action'&&i>starts[1]?[i]:[]);
  // Keep the second tick's start and its first action batch only, as if the process died mid-tick.
  writeFileSync(journal(cut,'m'),all.slice(0,actions[1]).join('\n')+'\n');
  const r=await runSeason({name:'m',mode:'demo',seed:3,days:2,dataDir:cut,config});
  assert.equal(r.done,true);
  assert.deepEqual(lines(cut,'m'),all);
});

test('a journal with a damaged last line is refused', async()=>{
  const dir=tmp();
  await runSeason({name:'bad',mode:'demo',seed:1,days:1,dataDir:dir,config,stopAfterTicks:1});
  appendFileSync(journal(dir,'bad'),'{"type":"acti');
  await assert.rejects(runSeason({name:'bad',mode:'demo',seed:1,days:1,dataDir:dir,config}),/damaged/);
  assert.match(seasonStatus('bad',dir,config),/DAMAGED/);
});

test('model mode: merchant tool call opens a business, malformed replies become pass, prompts never show fit', async()=>{
  const dir=tmp();
  const prompts:string[]=[];
  const provider:Provider=async(messages)=>{
    prompts.push(messages.map((m:any)=>String(m.content)).join('\n'));
    const cat=/cat id: (\w+)/.exec(messages[0].content)?.[1];
    if(cat!=='merchant')return {message:{role:'assistant',content:null,tool_calls:[{id:'x',type:'function',function:{name:'open_business',arguments:'{"name":'}}]}};
    const args={name:'Moonlit Fish Stall',pitch:'Fresh catch',category:'fish',price:12,unitCost:5,startup:30};
    return {message:{role:'assistant',content:null,tool_calls:[{id:'y',type:'function',function:{name:'open_business',arguments:JSON.stringify(args)}}]}};
  };
  const r=await runSeason({name:'m',mode:'local',days:1,dataDir:dir,config,provider,stopAfterTicks:1});
  assert.equal(r.done,false);
  const actions=r.events.filter(e=>e.type==='action');
  const merchant=actions.find(e=>e.cat==='merchant')!;
  assert.equal(merchant.name,'open_business');
  assert.equal(merchant.ok,true);
  for(const c of config.cats.map((c:any)=>c.id).filter((c:string)=>c!=='merchant'))
    assert.equal(actions.find(e=>e.cat===c)?.name,'pass',`${c} should pass`);
  assert.equal(prompts.length,config.cats.length);
  assert.equal(prompts.some(p=>p.includes('"fit"')),false);
});

test('a lock held by a live pid blocks the runner and is left in place', async()=>{
  const dir=tmp();
  const lock=join(dir,'season-locked.lock');
  writeFileSync(lock,String(process.pid));
  await assert.rejects(runSeason({name:'locked',mode:'demo',days:1,dataDir:dir,config}),/already running/);
  assert.equal(existsSync(lock),true);
});

test('the two-day demo requests a package and an account, escalates the account, and keeps invariants',async()=>{
  const dir=tmp();
  await runSeason({name:'caps',mode:'demo',seed:1,days:2,dataDir:dir,config});
  const events=readEvents(dir,'caps');
  assert.deepEqual(checkInvariants(events),[]);
  const requested=events.filter(e=>e.type==='capability.requested');
  assert.ok(requested.some(e=>e.cat==='scholar'&&e.kind==='package'&&e.tier==='sandbox'&&e.source==='npm:csv-parse'));
  assert.ok(requested.some(e=>e.cat==='builder'&&e.kind==='account'&&e.tier==='owner'));
  assert.ok(events.some(e=>e.type==='capability.escalated'&&requested.some(r=>r.id===e.id&&r.tier==='owner')));
  assert.ok(events.some(e=>e.type==='capability.decided'&&e.by==='mayor'&&e.approved===true));
});

test('each cat sees its own open businesses, and only the right ones are marked yours', ()=>{
  const cfg=config.economy;
  const opened=(id:string,owner:string,name:string)=>({type:'business.opened',id,owner,name,pitch:'p',category:'fish',price:10,unitCost:4,fit:1,startup:30});
  const events:EconomyEvent[]=[
    ...startSeason(cfg,['mayor','merchant','builder'],1),
    {type:'tick.started',day:0,tick:0},
    opened('b1','merchant','Moonlit Fish Stall'),
    opened('b2','builder','Yarn Works'),
    opened('b3','merchant','Tea Garden'),
    {type:'business.closed',id:'b3',reason:'test'},
  ];
  const s=replay(events);
  const merchant=view(s,events,'merchant',tmp(),cfg);
  const builder=view(s,events,'builder',tmp(),cfg);
  assert.deepEqual(merchant.yourBusinesses,[{id:'b1',name:'Moonlit Fish Stall'}]);
  assert.deepEqual(builder.yourBusinesses,[{id:'b2',name:'Yarn Works'}]);
  assert.deepEqual(merchant.businesses.map(b=>[b.id,b.yours]),[['b1',true],['b2',false],['b3',true]]);
  assert.deepEqual(builder.businesses.map(b=>[b.id,b.yours]),[['b1',false],['b2',true],['b3',false]]);
});

test('the view lists REA as a known tool, and a repo request for its exact source is a sandbox request', ()=>{
  const cfg=config.economy;
  const rea=cfg.knownTools.find((t:any)=>t.source==='https://github.com/morluto/rea');
  assert.equal(rea?.kind,'repo');
  const events:EconomyEvent[]=[...startSeason(cfg,['mayor','scholar'],1),{type:'tick.started',day:0,tick:0}];
  const s=replay(events);
  assert.deepEqual(view(s,events,'scholar',tmp(),cfg).knownTools,cfg.knownTools);
  const r=act(s,cfg,'scholar','k-rea','request_capability',{kind:'repo',source:rea.source,need:'reverse-engineer a binary',purpose:'Inspect how a tool works before asking for it.'});
  assert.equal(r.ok,true,r.result);
  const requested=r.events.find(e=>e.type==='capability.requested') as EconomyEvent|undefined;
  assert.equal(requested?.tier,'sandbox');
  assert.equal(requested?.source,rea.source);
});

test('a season enrolls the town as it is now: founders, then recruits, without a retired cat',async()=>{
  const dir=tmp(),ev=(type:string,data:any)=>JSON.stringify({type,data,at:new Date().toISOString()});
  writeFileSync(join(dir,'events.jsonl'),[ev('founded',{cats:[{id:'mayor'}]}),ev('cat.created',{id:'builder'}),ev('cat.created',{id:'merchant'}),
    ev('council.opened',{id:'c1',target:'merchant'}),ev('council.closed',{id:'c1',status:'retired'}),''].join('\n'));
  await runSeason({name:'roster',mode:'demo',days:1,dataDir:dir,sharedDataDir:shared,config:loaded,workshop:null,stopAfterTicks:1});
  assert.deepEqual(replay(readEvents(dir,'roster')).cats,['mayor','builder']);
});

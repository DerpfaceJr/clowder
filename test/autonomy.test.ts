import {allRoles,withFullRoster} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {AUTONOMY_LEVELS, DEFAULT_AUTONOMY, SETTINGS_FILE, autonomyPrompt, envelopeMultiplier, loadAutonomy, offeredTools, registerAutonomyRoutes, saveAutonomy, type AutonomyLevel} from '../src/autonomy.ts';
import {mayorTools, toolDefinitions} from '../src/provider.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {runSeason} from '../src/season.ts';
import {act, apply, ownerTierKinds, replay, startSeason} from '../src/economy.ts';
import type {EconomyConfig} from '../src/economy.ts';

const config=withFullRoster(JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')));
const newDir=()=>mkdtempSync(join(tmpdir(),'autonomy-'));
const economyAt=(level:AutonomyLevel):EconomyConfig=>({...config.economy,defaultEnvelope:Math.round(config.economy.defaultEnvelope*envelopeMultiplier(config,level))});
const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};

test('autonomy validation: only three known levels save, and bad or damaged files read as balanced', () => {
  const dir=newDir();
  assert.deepEqual([...AUTONOMY_LEVELS],['full','balanced','cautious']);
  assert.equal(DEFAULT_AUTONOMY,'balanced');
  for(const bad of ['turbo','Full',' cautious','',undefined,null,7]) assert.throws(()=>saveAutonomy(dir,bad),/Choose full, balanced or cautious/);
  assert.equal(loadAutonomy(dir),'balanced','missing file');
  writeFileSync(join(dir,SETTINGS_FILE),'{not json');
  assert.equal(loadAutonomy(dir),'balanced','damaged file');
  writeFileSync(join(dir,SETTINGS_FILE),JSON.stringify({level:'turbo'}));
  assert.equal(loadAutonomy(dir),'balanced','unknown level');
});

test('autonomy persists in the data dir and survives a fresh read', () => {
  const dir=newDir();
  assert.equal(saveAutonomy(dir,'cautious'),'cautious');
  assert.equal(loadAutonomy(dir),'cautious');
  assert.deepEqual(JSON.parse(readFileSync(join(dir,SETTINGS_FILE),'utf8')),{level:'cautious'});
  saveAutonomy(dir,'full');
  assert.equal(loadAutonomy(dir),'full');
});

test('autonomy routes are owner-only; the owner reads and saves a validated level', async () => {
  const dir=newDir();
  const app=Fastify();
  installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  registerAutonomyRoutes(app,{dataDir:dir});
  const body={level:'cautious'};
  // Proxied loopback and LAN requests: the same owner-only rule as every other owner route.
  assert.equal((await app.inject({url:'/api/autonomy',headers:{...owner,'x-forwarded-for':'127.0.0.1'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/autonomy',headers:{...owner,'x-forwarded-for':'127.0.0.1'},payload:body})).statusCode,403);
  assert.equal((await app.inject({url:'/api/autonomy',remoteAddress:'192.168.1.21',headers:{host:'192.168.1.21:8787'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/autonomy',remoteAddress:'192.168.1.21',headers:{host:'192.168.1.21:8787','x-town-action':'owner'},payload:body})).statusCode,403);
  assert.equal(loadAutonomy(dir),'balanced','refused writes change nothing');
  // Owner: schema rejects an unknown level before the handler runs.
  assert.equal((await app.inject({method:'POST',url:'/api/autonomy',headers:owner,payload:{level:'turbo'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/autonomy',headers:owner,payload:{}})).statusCode,400);
  assert.deepEqual((await app.inject({url:'/api/autonomy',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}})).json(),{level:'balanced'});
  const ok=await app.inject({method:'POST',url:'/api/autonomy',headers:owner,payload:body});
  assert.equal(ok.statusCode,200);
  assert.deepEqual(ok.json(),{level:'cautious'});
  assert.deepEqual((await app.inject({url:'/api/autonomy',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}})).json(),{level:'cautious'});
  await app.close();
});

test('each level puts its sentence in the season prompt and the chat prompt', async () => {
  for(const level of AUTONOMY_LEVELS){
    const dataDir=newDir();
    const seen:string[]=[];
    const provider=async(messages:any[])=>{seen.push(messages[0].content);return {message:{role:'assistant',content:'',tool_calls:[{id:'p',type:'function',function:{name:'pass',arguments:JSON.stringify({note:'test'})}}]}};};
    await runSeason({name:`prompt-${level}`,mode:'local',seed:1,days:1,dataDir,config,provider:provider as any,stopAfterTicks:1,jev:null,workshop:null,autonomy:level});
    assert.ok(seen.length>1);
    for(const prompt of seen){
      assert.ok(prompt.includes(autonomyPrompt(level)),`season prompt has the ${level} sentence`);
      for(const other of AUTONOMY_LEVELS.filter(x=>x!==level))assert.ok(!prompt.includes(autonomyPrompt(other)),`no ${other} sentence at ${level}`);
    }
    const store=new Store(join(newDir(),'events.jsonl'),allRoles(config));
    const town=new Town(store,config);
    town.autonomy=()=>level;
    const cat=allRoles(config)[0].id;
    const chat=town.context({id:'t1',cat,from:'owner',text:'hello',mode:'demo',status:'running'},0).messages[0].content;
    assert.ok(chat.includes(autonomyPrompt(level)),`chat prompt has the ${level} sentence`);
  }
  // Without a setting the town is balanced.
  const store=new Store(join(newDir(),'events.jsonl'),allRoles(config));
  assert.ok(new Town(store,config).context({id:'t2',cat:allRoles(config)[0].id,from:'owner',text:'hi',mode:'demo',status:'running'},0).messages[0].content.includes(autonomyPrompt('balanced')));
});

test('the envelope multiplier from town.config.json is applied once, at season start', async () => {
  assert.equal(envelopeMultiplier(config,'full'),config.economy.autonomy.full.envelopeMultiplier);
  assert.equal(envelopeMultiplier(config,'cautious'),config.economy.autonomy.cautious.envelopeMultiplier);
  assert.equal(envelopeMultiplier({economy:{}},'full'),1,'missing multiplier means the config default');
  assert.equal(envelopeMultiplier({economy:{autonomy:{full:{envelopeMultiplier:NaN}}}},'full'),1,'invalid multiplier means the config default');
  const expected=(level:AutonomyLevel)=>Math.round(config.economy.defaultEnvelope*config.economy.autonomy[level].envelopeMultiplier);
  assert.ok(expected('full')>config.economy.defaultEnvelope&&expected('cautious')<config.economy.defaultEnvelope);
  for(const level of AUTONOMY_LEVELS){
    const dataDir=newDir();
    const events=(await runSeason({name:`env-${level}`,mode:'demo',seed:1,days:1,dataDir,config,jev:null,workshop:null,stopAfterTicks:1,autonomy:level})).events;
    const started=events.find(e=>e.type==='season.started');
    assert.equal(started?.defaultEnvelope,expected(level),`${level} season envelope`);
    // Replay only the season start: a demo tick may already have spent some of an envelope.
    const start=replay([started!]);
    for(const cat of start.cats)assert.equal(start.envelopes[cat],expected(level),`${level} envelope for ${cat}`);
  }
});

test('owner-tier capabilities stay needs_owner at every autonomy level', () => {
  const kinds=ownerTierKinds();
  assert.deepEqual([...kinds].sort(),['account','api','money','network']);
  for(const level of AUTONOMY_LEVELS){
    const economy=economyAt(level);
    for(const kind of kinds){
      const start=replay(startSeason(economy,['scholar','mayor'],1));
      const out=act(start,economy,'scholar',`cap-${kind}`,'request_capability',{kind,need:'a real account',purpose:'Run the shop the owner asked for.',source:null});
      assert.equal(out.ok,true,`${kind} request accepted at ${level}`);
      const state=out.events.reduce(apply,start);
      const cap=state.capabilities.at(-1)!;
      assert.equal(cap.tier,'owner');
      assert.equal(cap.status,'needs_owner',`${kind} at ${level}`);
      // The Mayor cannot grant it at any level, and the cat cannot grant it either.
      const decided=act(state,economy,'mayor',`grant-${kind}`,'decide_capability',{id:cap.id,approved:true,reason:'Looks fine.'});
      assert.equal(decided.ok,false,`mayor cannot grant ${kind} at ${level}`);
    }
  }
});

test('the real chat loop: full blocks a request_approval call, balanced still asks the owner', async () => {
  const cat=allRoles(config)[0].id;
  for(const level of ['full','balanced'] as const){
    const store=new Store(join(newDir(),'events.jsonl'),allRoles(config));
    const offered:string[][]=[];
    const seen:any[][]=[];
    // The fake asks for approval on its first call, whatever tools it was offered, then replies in plain text.
    const provider=async(messages:any[],tools:any[])=>{
      offered.push(tools.map(t=>t.function.name));seen.push(messages);
      if(seen.length===1)return {message:{role:'assistant',content:null,tool_calls:[{id:'ask1',type:'function',function:{name:'request_approval',arguments:JSON.stringify({question:'Start a bakery?',options:['Yes','No']})}}]}};
      return {message:{role:'assistant',content:'Done.'}};
    };
    const town=new Town(store,config,{test:provider as any});
    town.autonomy=()=>level;
    const task=town.createTask(cat,'owner','Plan a bakery','test');
    const result=await town.run(task,town.context(task,0));
    assert.equal(offered[0].includes('request_approval'),level!=='full',`${level}: offered tools`);
    if(level==='full'){
      assert.equal(store.state.approvals.length,0,'full: no approval is created');
      assert.equal(result,'Done.');
      const toolResult=seen[1].find(m=>m.role==='tool');
      assert.match(toolResult.content,/not asked at full autonomy/);
    }else{
      assert.equal(store.state.approvals.length,1,'balanced: the owner is asked');
      assert.equal(store.state.approvals[0].status,'pending');
      assert.equal(result,null);
    }
  }
});

test('full autonomy withdraws only the approval tool from the Mayor and cats', () => {
  const mayor=mayorTools('demo');
  assert.ok(mayor.some(t=>t.function.name==='request_approval'));
  assert.ok(!offeredTools(mayor,'full').some(t=>t.function.name==='request_approval'));
  for(const level of ['balanced','cautious'] as const)assert.ok(offeredTools(mayor,level).some(t=>t.function.name==='request_approval'));
  assert.equal(offeredTools(toolDefinitions,'full').length,toolDefinitions.length-1);
});

test('a task that uses all its steps ends with the model summary instead of an error', async () => {
  const {mkdtempSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {Store}=await import('../src/store.ts');const {Town}=await import('../src/engine.ts');const {allRoles}=await import('../src/roles.ts');
  const cfg={...JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')),maxTurns:2};
  const store=new Store(join(mkdtempSync(join(tmpdir(),'wrap-')),'events.jsonl'),allRoles(cfg));
  let calls=0;const seen:any[]=[];
  const fake=async(messages:any[],tools:any[])=>{calls++;seen.push(tools.length);
    if(tools.length)return {message:{role:'assistant',tool_calls:[{id:'c'+calls,type:'function',function:{name:'build_road',arguments:JSON.stringify({a:'mayor',b:'scholar'})}}]}};
    return {message:{role:'assistant',content:'Roads are planned; reply continue to finish.'}};};
  const town=new Town(store,cfg,{fake} as any);
  const id=town.submit('mayor','Plan roads','fake');
  for(let i=0;i<300&&!['done','failed'].includes(store.state.tasks.find(t=>t.id===id)?.status??'');i++)await new Promise(r=>setTimeout(r,10));
  const task=store.state.tasks.find(t=>t.id===id)!;
  assert.equal(task.status,'done');
  assert.equal(task.result,'Roads are planned; reply continue to finish.');
  assert.equal(seen.at(-1),0,'the wrap-up call offers no tools');
});

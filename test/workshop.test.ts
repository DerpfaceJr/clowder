import {withFullRoster} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSeason, toolOutcome} from '../src/season.ts';
import type {Provider} from '../src/provider.ts';
import {checkInvariants} from '../src/economy.ts';
import type {EconomyEvent} from '../src/economy.ts';
import {Workshop, approvedTools, capture, checkArgs, licenseAllowed, registerWorkshopRoutes, repoLicense, runArgv} from '../src/workshop.ts';
import type {Spawner} from '../src/workshop.ts';

const config=withFullRoster(JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')));
const tmp=()=>mkdtempSync(join(tmpdir(),'workshop-'));
const ENTRY='/home/catworker/workshop/cap1/node_modules/.bin/csv-parse';
const utf16=(s:string)=>Buffer.from(`﻿${s}`,'utf16le');

// A fake wsl.exe. Records every argv, answers from a script, and never starts a real process.
function fakeWsl(reply:(args:string[])=>{code?:number|null;stdout?:Buffer|string;hang?:boolean}){
  const calls:string[][]=[];
  const kills:string[]=[];
  const spawn:Spawner=args=>{
    calls.push(args);
    const r=reply(args);
    const child:any=new EventEmitter();
    child.stdout=new EventEmitter();
    child.stderr=new EventEmitter();
    // kill() only records the signal; the timer in capture() settles the call itself.
    child.kill=(sig:string)=>{kills.push(sig);return true;};
    setImmediate(()=>{
      if(r.hang)return;
      if(r.stdout!==undefined)child.stdout.emit('data',Buffer.isBuffer(r.stdout)?r.stdout:Buffer.from(r.stdout));
      child.emit('close',r.code??0);
    });
    return child;
  };
  return {spawn,calls,kills};
}
const distroList=(...names:string[])=>utf16(names.map(n=>`${n}\r\n`).join(''));
// Isolated: the distro exists, /mnt/c is absent (test exits 1) and interop is absent (test exits 1).
const isolatedReply=(args:string[])=>{
  if(args.includes('--list'))return {code:0,stdout:distroList('cat-workshop')};
  if(args.includes('test'))return {code:1};
  return {code:0,stdout:'hello\n'};
};

// Season journal with one approved package (cap1), one owner-tier request (cap2) and one approved repo (cap3).
function seedJournal(dir:string){
  const events=[
    {type:'season.started',seed:1,startingCoins:1000,cats:['merchant'],ticksPerDay:1,days:1,defaultEnvelope:0,maxCapabilities:10},
    {type:'capability.requested',id:'cap1',cat:'scholar',need:'parse csv',purpose:'read price tables',kind:'package',source:'npm:csv-parse',tier:'sandbox'},
    {type:'capability.decided',id:'cap1',by:'mayor',approved:true,reason:'ok'},
    {type:'capability.requested',id:'cap2',cat:'builder',need:'shop',purpose:'a shop',kind:'account',source:null,tier:'owner'},
    {type:'capability.decided',id:'cap2',by:'mayor',approved:true,reason:'should never count'},
    {type:'capability.requested',id:'cap3',cat:'scholar',need:'repo tool',purpose:'a repo',kind:'repo',source:'https://github.com/a/b',tier:'sandbox'},
    {type:'capability.decided',id:'cap3',by:'mayor',approved:true,reason:'ok'},
  ];
  writeFileSync(join(dir,'season-s1.jsonl'),events.map(e=>`${JSON.stringify(e)}\n`).join(''));
}
function seedRecords(dir:string){
  const recs=[
    {id:'cap1',kind:'package',source:'npm:csv-parse',status:'installed',license:'MIT',reason:null,entry:[ENTRY],at:'2026-10-25T00:00:00Z'},
  ];
  writeFileSync(join(dir,'workshop.jsonl'),recs.map(r=>`${JSON.stringify(r)}\n`).join(''));
}

test('argv keeps hostile text inside single elements and refuses NUL and oversize input', async()=>{
  const hostile=['a b','"quoted"','x;rm -rf /','a && b','$(id)','`id`'];
  assert.deepEqual(checkArgs(hostile),hostile);
  const fake=fakeWsl(()=>({code:0}));
  await capture(fake.spawn,runArgv('/home/catworker/work/scholar',[ENTRY],hostile));
  assert.deepEqual(fake.calls[0],['-d','cat-workshop','-u','catworker','--cd','/home/catworker/work/scholar','--exec',ENTRY,...hostile]);
  assert.throws(()=>checkArgs(['a\0b']),/NUL/);
  assert.throws(()=>checkArgs(Array(9).fill('a')),/at most 8/);
  assert.throws(()=>checkArgs(['x'.repeat(201)]),/200 characters/);
  assert.throws(()=>checkArgs('ls -la'),/list/);
});

test('run refuses when the distro can see the Windows C: drive, and never starts the tool', async()=>{
  const dir=tmp();
  seedJournal(dir);seedRecords(dir);
  const fake=fakeWsl(args=>{
    if(args.includes('--list'))return {code:0,stdout:distroList('cat-workshop')};
    if(args.includes('/mnt/c'))return {code:0};
    return {code:1};
  });
  const w=new Workshop({dataDir:dir,spawn:fake.spawn});
  await assert.rejects(w.run('scholar','cap1',['x']),/not isolated/);
  assert.equal(fake.calls.some(c=>c.includes(ENTRY)),false);
  assert.equal((await w.status()).isolated,false);
});

test('run executes the recorded entry with argv and a fixed working directory when isolated', async()=>{
  const dir=tmp();
  seedJournal(dir);seedRecords(dir);
  const fake=fakeWsl(isolatedReply);
  const w=new Workshop({dataDir:dir,spawn:fake.spawn});
  const r=await w.run('scholar','cap1',['a b','$(id)']);
  assert.equal(r.ok,true);
  assert.equal(r.output,'hello');
  // The tool sees its out folder through CLOWDER_OUT; hostile args still arrive as single elements.
  const expected=['-d','cat-workshop','-u','catworker','--cd','/home/catworker/work/scholar','--exec','env','CLOWDER_OUT=/home/catworker/work/scholar/out',ENTRY,'a b','$(id)'];
  assert.ok(fake.calls.some(c=>c.join('\u0000')===expected.join('\u0000')));
  assert.ok(fake.calls.some(c=>c.includes('mkdir')&&c.some(a=>a.startsWith('/home/catworker/work/scholar'))));
  await assert.rejects(w.run('scholar','cap2',[]),/not an installed tool/);
  await assert.rejects(w.run('scholar','cap1',Array(9).fill('a')),/at most 8/);
  await assert.rejects(w.run('../bad','cap1',[]),/Unknown cat/);
});

test('a hung tool is killed at the timeout and reported as timed out', async()=>{
  const fake=fakeWsl(()=>({hang:true}));
  const r=await capture(fake.spawn,['--exec','sleep','999'],{timeoutMs:20});
  assert.equal(r.timedOut,true);
  assert.equal(r.code,null);
  assert.deepEqual(fake.kills,['SIGKILL']);
});

test('output is capped at 4 KB and marked as truncated', async()=>{
  const fake=fakeWsl(()=>({code:0,stdout:'x'.repeat(10_000)}));
  const r=await capture(fake.spawn,['--exec','yes'],{maxBytes:4096});
  assert.equal(r.output.length,4096);
  assert.equal(r.truncated,true);
  const small=await capture(fakeWsl(()=>({code:0,stdout:'ok'})).spawn,['--exec','true']);
  assert.equal(small.truncated,false);
});

test('status reports a missing distro without running anything inside it', async()=>{
  const dir=tmp();
  seedJournal(dir);seedRecords(dir);
  const fake=fakeWsl(()=>({code:0,stdout:distroList('pta-one','pta-two')}));
  const s=await new Workshop({dataDir:dir,spawn:fake.spawn}).status();
  assert.equal(s.distro.present,false);
  assert.equal(s.isolated,false);
  assert.equal(fake.calls.length,1);
  assert.deepEqual(s.tools.map(t=>[t.id,t.state]),[['cap1','installed'],['cap3','not installed']]);
});

test('status reports an isolated distro with its approved tools', async()=>{
  const dir=tmp();
  seedJournal(dir);seedRecords(dir);
  const s=await new Workshop({dataDir:dir,spawn:fakeWsl(isolatedReply).spawn}).status();
  assert.equal(s.distro.present,true);
  assert.equal(s.isolated,true);
  assert.equal(s.isolation.mountedC,false);
  assert.equal(s.isolation.interop,false);
});

test('install refuses when not isolated and records nothing', async()=>{
  const dir=tmp();
  seedJournal(dir);
  const fake=fakeWsl(args=>args.includes('--list')?{code:0,stdout:distroList('cat-workshop')}:args.some(a=>a.includes('base64 -d | sh'))?{code:10}:{code:0});
  const w=new Workshop({dataDir:dir,spawn:fake.spawn});
  await assert.rejects(w.install('cap1'),/not isolated/);
  assert.equal(fake.calls.some(c=>c.includes('npm')),false);
  assert.equal(existsSync(join(dir,'workshop.jsonl')),false);
  await assert.rejects(new Workshop({dataDir:dir,spawn:fakeWsl(isolatedReply).spawn}).install('cap9'),/not an approved/);
  await assert.rejects(new Workshop({dataDir:dir,spawn:fakeWsl(isolatedReply).spawn}).install('../cap1'),/Unknown capability id/);
});

test('approved sandbox tools come from the newest journal; owner-tier approvals never count', () => {
  const dir=tmp();
  seedJournal(dir);
  const {items}=approvedTools(dir);
  assert.deepEqual(items.map(i=>i.id),['cap1','cap3']);
  assert.equal(items.find(i=>i.id==='cap3')?.kind,'repo');
});

test('licence and repo licence checks use the allowlist', () => {
  assert.equal(licenseAllowed('MIT'),true);
  assert.equal(licenseAllowed('MIT OR Apache-2.0'),true);
  assert.equal(licenseAllowed('GPL-3.0'),false);
  assert.equal(licenseAllowed('MIT AND GPL-3.0'),false);
  assert.equal(licenseAllowed(null),false);
  assert.equal(repoLicense('MIT License\n\nCopyright'),'MIT');
  assert.equal(repoLicense('All rights reserved'),null);
});

test('use_tool flows through a season with a fake workshop and changes no coins', async()=>{
  const dir=tmp();
  const runs:{cat:string;toolId:string;args:unknown}[]=[];
  const fakeWorkshop={
    installedTools:()=>[{id:'cap1',kind:'package',source:'npm:csv-parse',need:'parse csv',purpose:'read price tables'}],
    run:async(cat:string,toolId:string,args:unknown)=>{runs.push({cat,toolId,args});return {ok:true,exitCode:0,timedOut:false,truncated:false,output:'fake ran',files:[],skipped:[]};},
  };
  const seen:{cat:string;names:string[];content:string}[]=[];
  const provider:Provider=async(messages,tools)=>{
    const cat=/cat id: (\w+)/.exec(String(messages[0].content))?.[1]??'';
    const names=tools.map((t:any)=>t.function.name);
    seen.push({cat,names,content:String(messages[1].content)});
    if(cat==='merchant'&&names.includes('use_tool'))return {message:{role:'assistant',content:null,tool_calls:[{id:'u',type:'function',function:{name:'use_tool',arguments:JSON.stringify({toolId:'cap1',args:['hello']})}}]}};
    return {message:{role:'assistant',content:null,tool_calls:[{id:'p',type:'function',function:{name:'pass',arguments:'{}'}}]}};
  };
  const r=await runSeason({name:'t',mode:'local',days:1,dataDir:dir,config,provider,workshop:fakeWorkshop,stopAfterTicks:1});
  assert.deepEqual(runs,[{cat:'merchant',toolId:'cap1',args:['hello']}]);
  const action=r.events.find(e=>e.type==='action'&&e.name==='use_tool') as EconomyEvent;
  assert.equal(action.cat,'merchant');
  assert.equal(action.ok,true);
  assert.equal(action.result,'exit 0: fake ran');
  const merchantPrompt=seen.find(s=>s.cat==='merchant')!;
  assert.ok(merchantPrompt.names.includes('use_tool'));
  assert.match(merchantPrompt.content,/"installedTools":\[\{"id":"cap1"/);
  assert.match(merchantPrompt.content,/read price tables/);
  assert.equal(r.events.some(e=>e.type==='coins.reserved'&&String(e.key).startsWith('use_tool')),false);
  assert.deepEqual(checkInvariants(r.events),[]);
});

test('use_tool is not offered when no tool is installed', async()=>{
  const dir=tmp();
  const names:string[][]=[];
  const provider:Provider=async(_m,tools)=>{names.push(tools.map((t:any)=>t.function.name));return {message:{role:'assistant',content:null,tool_calls:[{id:'p',type:'function',function:{name:'pass',arguments:'{}'}}]}};};
  await runSeason({name:'n',mode:'local',days:1,dataDir:dir,config,provider,workshop:null,stopAfterTicks:1});
  assert.ok(names.length>0);
  assert.equal(names.every(n=>!n.includes('use_tool')),true);
});

test('demo never runs a tool and returns a fixed result', async()=>{
  let ran=0;
  const fake={installedTools:()=>[],run:async()=>{ran++;return {ok:true,exitCode:0,timedOut:false,truncated:false,output:'',files:[],skipped:[]};}};
  assert.deepEqual(await toolOutcome(fake,'merchant',{toolId:'cap1',args:[]},true),{ok:false,result:'demo: not run'});
  assert.equal(ran,0);
  const broken={installedTools:()=>[],run:async()=>{throw new Error('boom');}};
  assert.deepEqual(await toolOutcome(broken,'merchant',{toolId:'cap1'},false),{ok:false,result:'boom'});
});

test('workshop routes are owner-only: proxied requests get 403', async()=>{
  const dir=tmp();
  const app=Fastify({logger:false});
  registerWorkshopRoutes(app,new Workshop({dataDir:dir,spawn:fakeWsl(()=>({code:0,stdout:distroList()})).spawn}));
  const proxied={host:'localhost:3000','x-forwarded-for':'203.0.113.5'};
  const get=await app.inject({method:'GET',url:'/api/workshop',headers:proxied});
  assert.equal(get.statusCode,403);
  const post=await app.inject({method:'POST',url:'/api/workshop/install',headers:proxied,payload:{id:'cap1'}});
  assert.equal(post.statusCode,403);
  const owner=await app.inject({method:'GET',url:'/api/workshop',headers:{host:'localhost:3000'}});
  assert.equal(owner.statusCode,200);
  assert.equal(owner.json().distro.present,false);
  const bad=await app.inject({method:'POST',url:'/api/workshop/install',headers:{host:'localhost:3000'},payload:{id:'../x'}});
  assert.equal(bad.statusCode,400);
  await app.close();
});

test('a read-only status writes no results file', async()=>{
  const dir=tmp();
  seedJournal(dir);
  await new Workshop({dataDir:dir,spawn:fakeWsl(()=>({code:0,stdout:distroList()})).spawn}).status();
  assert.equal(existsSync(join(dir,'workshop.jsonl')),false);
});

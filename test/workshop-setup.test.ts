import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workshop, registerWorkshopRoutes, readWorkshopSettings, saveWorkshopSettings, type Spawner} from '../src/workshop.ts';
import {WorkshopSetup, WSL_MISSING, setupRetryDue, SETUP_BACKOFF_MS} from '../src/workshop-setup.ts';

const tmp=()=>mkdtempSync(join(tmpdir(),'wssetup-'));
const ROOT=join(tmpdir(),'clowder-root');

// wsl.exe answers: present or absent WSL, and whether the distro is listed.
function fakeWsl({wsl,distro}:{wsl:boolean;distro:boolean}){
  const calls:string[][]=[];
  const spawn:Spawner=args=>{
    calls.push(args);
    const child:any=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;
    setImmediate(()=>{
      if(args.includes('--status')){child.emit('close',wsl?0:1);return;}
      if(args.includes('--list')){
        if(distro)child.stdout.emit('data',Buffer.from('cat-workshop\r\n','utf8'));
        child.emit('close',wsl?0:1);return;
      }
      child.emit('close',0);
    });
    return child;
  };
  return {spawn,calls};
}

// powershell.exe stand-ins. Each child stays open until the test ends it.
function fakeProc(){
  const calls:{file:string;args:string[];env:Record<string,string>}[]=[];
  const children:any[]=[];
  const proc=(file:string,args:string[],env:Record<string,string>)=>{
    calls.push({file,args,env});
    const c:any=new EventEmitter();
    c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>true;
    children.push(c);
    return c;
  };
  return {proc,calls,children};
}

function harness({wsl=true,distro=false,settingsDir=tmp(),dataDir=tmp(),now=()=>Date.parse('2026-10-26T10:00:00Z'),autoSetup=true}:{wsl?:boolean;distro?:boolean;settingsDir?:string;dataDir?:string;now?:()=>number;autoSetup?:boolean}={}){
  const w=fakeWsl({wsl,distro});
  const p=fakeProc();
  const workshop=new Workshop({dataDir,settingsDir,spawn:w.spawn});
  const setup=new WorkshopSetup({settingsDir,root:ROOT,defaultAutoSetup:autoSetup,wsl:w.spawn,proc:p.proc,current:()=>({dataDir,workshop}),now});
  return {setup,workshop,w,p,settingsDir,dataDir};
}

test('auto setup starts the installer with argv only, in the background, when WSL is present and the distro is missing', async()=>{
  const h=harness();
  assert.equal(await h.setup.autoStart(),'started');
  assert.equal(h.p.calls.length,1);
  assert.equal(h.p.calls[0].file,'powershell.exe');
  assert.deepEqual(h.p.calls[0].args.slice(0,4),['-NoProfile','-ExecutionPolicy','Bypass','-File']);
  assert.match(h.p.calls[0].args[4],/install-workshop\.ps1$/);
  assert.equal(h.p.calls[0].env.CAT_TOWN_DATA,h.dataDir);
  // It returned while the installer is still running: the card shows progress, and nothing waited.
  h.p.children[0].stdout.emit('data',Buffer.from('Downloading the base image\nChecking SHA256\n'));
  assert.deepEqual(h.setup.snapshot(true).lines,['Downloading the base image','Checking SHA256']);
  assert.equal(await h.setup.autoStart(),'once');
});

test('auto setup does nothing without WSL, when the distro exists, or when the owner turned it off', async()=>{
  assert.equal(await harness({wsl:false}).setup.autoStart(),'no-wsl');
  const present=harness({distro:true});
  assert.equal(await present.setup.autoStart(),'present');
  assert.equal(present.p.calls.length,0);
  const off=harness({autoSetup:true});
  saveWorkshopSettings(off.settingsDir,{autoSetup:false});
  assert.equal(await off.setup.autoStart(),'off');
  assert.equal(off.p.calls.length,0);
  // The config default applies when the owner has not chosen.
  assert.equal(await harness({autoSetup:false}).setup.autoStart(),'off');
});

test('a failed setup raises a failure, and the next start retries once it is due', async()=>{
  const t0=Date.parse('2026-10-26T10:00:00Z');
  let clock=t0;
  const h=harness({now:()=>clock});
  await h.setup.autoStart();
  h.p.children[0].stderr.emit('data',Buffer.from('Ubuntu download failed'));
  h.p.children[0].emit('close',1);
  const failure=h.setup.failure();
  assert.ok(failure);
  assert.match(failure.error,/exit code 1/);
  assert.equal(failure.failures,1);
  // Next start, too soon: backoff, no installer.
  // Each start is a new process: a new WorkshopSetup over the same settings folder.
  const restart=()=>new WorkshopSetup({settingsDir:h.settingsDir,root:ROOT,defaultAutoSetup:true,wsl:h.w.spawn,proc:h.p.proc,current:()=>({dataDir:h.dataDir,workshop:h.workshop}),now:()=>clock});
  // The failure survives the restart, so the quest is still raised.
  assert.equal(restart().failure()?.failures,1);
  clock=t0+60_000;
  assert.equal(await restart().autoStart(),'backoff');
  assert.equal(h.p.calls.length,1);
  // Once due: one attempt per start, and no second one in the same process.
  clock=t0+SETUP_BACKOFF_MS+1000;
  const later=restart();
  assert.equal(await later.autoStart(),'started');
  assert.equal(await later.autoStart(),'once');
  assert.equal(h.p.calls.length,2);
});

test('retry backoff doubles and is capped', () => {
  const at='2026-10-26T10:00:00Z',t=Date.parse(at);
  assert.equal(setupRetryDue(0,null,t),true);
  assert.equal(setupRetryDue(1,at,t+SETUP_BACKOFF_MS-1),false);
  assert.equal(setupRetryDue(1,at,t+SETUP_BACKOFF_MS),true);
  assert.equal(setupRetryDue(2,at,t+SETUP_BACKOFF_MS),false);
  assert.equal(setupRetryDue(2,at,t+2*SETUP_BACKOFF_MS),true);
  assert.equal(setupRetryDue(50,at,t+24*3600_000-1),false);
  assert.equal(setupRetryDue(50,at,t+25*3600_000),true);
});

test('Create workshop refuses without WSL and points to wsl --install', async()=>{
  const h=harness({wsl:false});
  await assert.rejects(h.setup.create(),(e:Error)=>e.message===WSL_MISSING&&/wsl --install/.test(e.message));
  assert.equal(h.p.calls.length,0);
  const ok=harness({wsl:true});
  assert.deepEqual(await ok.setup.create(),{started:true});
  await assert.rejects(ok.setup.create(),/already being set up/);
});

test('Install WSL needs a confirmation, then starts an elevated Start-Process and nothing else', async()=>{
  const h=harness({wsl:false});
  await assert.rejects(h.setup.installWsl({}),/Confirm first/);
  assert.equal(h.p.calls.length,0);
  await h.setup.installWsl({confirm:true});
  assert.equal(h.p.calls[0].file,'powershell.exe');
  const command=h.p.calls[0].args.at(-1)??'';
  assert.match(command,/Start-Process -FilePath wsl\.exe -ArgumentList '--install','--no-distribution' -Verb RunAs/);
  assert.equal(h.p.calls[0].args.some(a=>/cat-town|install-workshop/.test(a)),false);
  const installed=harness({wsl:true});
  await assert.rejects(installed.setup.installWsl({confirm:true}),/already installed/);
});

test('owner routes: non-owners get 403, a missing WSL is a 409, and the decision route needs a waiting recipe', async()=>{
  const h=harness({wsl:false});
  const app=Fastify({logger:false});
  registerWorkshopRoutes(app,h.workshop,h.setup.owner());
  const proxied={host:'localhost:3000','x-forwarded-for':'203.0.113.5'};
  const owner={host:'localhost:3000'};
  assert.equal((await app.inject({method:'POST',url:'/api/workshop/setup',headers:proxied})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/workshop/install-wsl',headers:proxied,payload:{confirm:true}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/workshop/settings',headers:proxied,payload:{autoSetup:false}})).statusCode,403);
  const setup=await app.inject({method:'POST',url:'/api/workshop/setup',headers:owner});
  assert.equal(setup.statusCode,409);
  assert.match(setup.json().error,/wsl --install/);
  assert.equal(h.p.calls.length,0);
  const view=await app.inject({method:'GET',url:'/api/workshop',headers:owner});
  assert.equal(view.statusCode,200);
  assert.equal(view.json().setup.wsl,false);
  assert.equal(view.json().settings.autoSetup,true);
  const settings=await app.inject({method:'POST',url:'/api/workshop/settings',headers:owner,payload:{autoSetup:false,allowLongJobs:true}});
  assert.equal(settings.statusCode,200);
  assert.deepEqual(readWorkshopSettings(h.settingsDir),{autoSetup:false,allowLongJobs:true});
  const badSetting=await app.inject({method:'POST',url:'/api/workshop/settings',headers:owner,payload:{autoSetup:'maybe'}});
  assert.equal(badSetting.statusCode,400);
  const noRecipe=await app.inject({method:'POST',url:'/api/workshop/recipe',headers:owner,payload:{id:'cap1',approved:true,reason:'ok'}});
  assert.equal(noRecipe.statusCode,409);
  await app.close();
});

test('the owner decides a recipe that waited for them, and the decision is journaled', async()=>{
  const dataDir=tmp();
  const events=[
    {type:'season.started',seed:1,startingCoins:1000,cats:['scholar'],ticksPerDay:1,days:1,defaultEnvelope:0,maxCapabilities:10},
    {type:'capability.requested',id:'cap1',cat:'scholar',need:'video maker',purpose:'make videos',kind:'repo',source:'https://github.com/a/b',tier:'sandbox'},
    {type:'capability.decided',id:'cap1',by:'mayor',approved:true,reason:'ok'},
    {type:'recipe.proposed',id:'cap1',cat:'scholar',recipe:{entry:['node','index.js'],workdir:null,setup:[],description:'run it',long:false,status:'needs_owner'}},
  ];
  writeFileSync(join(dataDir,'season-s1.jsonl'),events.map(e=>`${JSON.stringify(e)}\n`).join(''));
  const h=harness({dataDir,settingsDir:dataDir});
  assert.deepEqual(await h.setup.decideRecipe({id:'cap1',approved:true,reason:'yes, run it'}),{id:'cap1',approved:true});
  const last=readFileSync(join(dataDir,'season-s1.jsonl'),'utf8').trim().split('\n').at(-1)??'';
  assert.deepEqual(JSON.parse(last),{type:'recipe.decided',id:'cap1',by:'owner',approved:true,reason:'yes, run it'});
  await assert.rejects(h.setup.decideRecipe({id:'cap1',approved:true,reason:'again'}),/no run recipe waiting/);
});

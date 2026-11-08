import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workshop, runSecondsFor, type Spawner} from '../src/workshop.ts';
import {importWorkshopOutbox} from '../src/workshop-outbox.ts';

// A fake wsl.exe. Records every argv and answers from a script. It never starts a real process.
type Reply={code?:number;stdout?:Buffer|string};
function fakeWsl(reply:(args:string[])=>Reply){
  const calls:string[][]=[];
  const spawn:Spawner=args=>{
    calls.push(args);
    const r=reply(args);
    const child:any=new EventEmitter();
    child.stdout=new EventEmitter();
    child.stderr=new EventEmitter();
    child.kill=()=>true;
    setImmediate(()=>{
      if(r.stdout!==undefined)child.stdout.emit('data',Buffer.isBuffer(r.stdout)?r.stdout:Buffer.from(r.stdout));
      child.emit('close',r.code??0);
    });
    return child;
  };
  return {spawn,calls};
}
const tmp=()=>mkdtempSync(join(tmpdir(),'wsrun-'));
const PNG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const REPO='https://github.com/harry0703/MoneyPrinterTurbo';
const json=(v:unknown)=>`${JSON.stringify(v)}\n`;
const join2=(...xs:string[])=>xs.join('\u0000');

// A season with one approved repo request (cap1) and an approved run recipe, written as the season journal.
function seedRepo(dir:string,recipe:Record<string,unknown>,status:'pending'|'approved'='approved'){
  const events:any[]=[
    {type:'season.started',seed:1,startingCoins:1000,cats:['scholar'],ticksPerDay:1,days:1,defaultEnvelope:0,maxCapabilities:10},
    {type:'capability.requested',id:'cap1',cat:'scholar',need:'video maker',purpose:'make videos',kind:'repo',source:REPO,tier:'sandbox'},
    {type:'capability.decided',id:'cap1',by:'mayor',approved:true,reason:'ok'},
    {type:'recipe.proposed',id:'cap1',cat:'scholar',recipe:{...recipe,status:'pending'}},
  ];
  if(status==='approved')events.push({type:'recipe.decided',id:'cap1',by:'mayor',approved:true,reason:'runs'});
  writeFileSync(join(dir,'season-s1.jsonl'),events.map(e=>json(e)).join(''));
}
const RECIPE={entry:['python3','main.py'],workdir:null,setup:[['python3','-m','venv','.venv'],['npm','ci']],description:'make a video',long:true};
const isolated=(args:string[]):Reply|undefined=>{
  if(args.includes('--list'))return {code:0,stdout:'cat-workshop\r\n'};
  if(args.includes('test'))return {code:1};
  return undefined;
};

test('the repo is cloned once, setup runs once, and the entry is recorded', async()=>{
  const dir=tmp();
  seedRepo(dir,RECIPE);
  const fake=fakeWsl(args=>isolated(args)??(args.includes('head')?{stdout:'MIT License\n\nCopyright'}:{code:0}));
  const w=new Workshop({dataDir:dir,spawn:fake.spawn});
  const rec=await w.install('cap1');
  assert.equal(rec.status,'installed');
  assert.equal(rec.setupDone,true);
  assert.deepEqual(rec.entry,['python3','main.py']);
  assert.equal(fake.calls.filter(c=>c.includes('clone')).length,1);
  const setupSteps=fake.calls.filter(c=>c.includes('--cd')&&c.includes('/home/catworker/workshop/cap1/src'));
  assert.equal(setupSteps.length,2);
  assert.deepEqual(setupSteps[1].slice(-3),['npm','ci','--ignore-scripts']);
  // A second install returns the runnable record without another clone or setup.
  const again=await w.install('cap1');
  assert.equal(again.status,'installed');
  assert.equal(fake.calls.filter(c=>c.includes('clone')).length,1);
  assert.equal(fake.calls.filter(c=>c.includes('--cd')&&c.includes('/home/catworker/workshop/cap1/src')).length,2);
  // Running uses the recorded entry, in the work folder, with the out folder named in the environment.
  await w.run('scholar','cap1',['x']);
  assert.ok(fake.calls.some(c=>c.join('\u0000')===join2('-d','cat-workshop','-u','catworker','--cd','/home/catworker/work/scholar','--exec','env','CLOWDER_OUT=/home/catworker/work/scholar/out','python3','main.py','x')));
});

test('a repo without an approved recipe is installed but not runnable', async()=>{
  const dir=tmp();
  seedRepo(dir,RECIPE,'pending');
  const fake=fakeWsl(args=>isolated(args)??(args.includes('head')?{stdout:'MIT License'}:{code:0}));
  const w=new Workshop({dataDir:dir,spawn:fake.spawn});
  const rec=await w.install('cap1');
  assert.equal(rec.status,'installed');
  assert.equal(rec.entry,null);
  assert.equal((await w.status()).tools.find(t=>t.id==='cap1')?.state,'not runnable');
  await assert.rejects(w.run('scholar','cap1',[]),/not an installed tool/);
});

test('a failed setup step records a failed install and no entry', async()=>{
  const dir=tmp();
  seedRepo(dir,RECIPE);
  const fake=fakeWsl(args=>{
    const base=isolated(args);if(base)return base;
    if(args.includes('head'))return {stdout:'MIT License'};
    if(args.includes('-m')&&args.includes('venv'))return {code:2,stdout:'venv failed'};
    return {code:0};
  });
  const rec=await new Workshop({dataDir:dir,spawn:fake.spawn}).install('cap1');
  assert.equal(rec.status,'failed');
  assert.equal(rec.entry,null);
  assert.match(rec.reason??'',/setup step python3 failed/);
});

test('a run copies new out files into the outbox, skipping unsupported and oversize files', async()=>{
  const dir=tmp();
  seedRepo(dir,RECIPE);
  writeFileSync(join(dir,'workshop.jsonl'),json({id:'cap1',kind:'repo',source:REPO,status:'installed',license:'MIT',reason:null,entry:['python3','main.py'],workdir:null,long:true,setupDone:true,at:'2026-10-25T00:00:00Z'}));
  const fake=fakeWsl(args=>{
    const base=isolated(args);if(base)return base;
    if(args.includes('find'))return {stdout:'5\tout.txt\n104857601\tbig.mp4\n3\tdata.bin\n8\tpix.png\n'};
    if(args.includes('cat')&&args.some(a=>a.endsWith('/out/out.txt')))return {stdout:'hello'};
    if(args.includes('cat')&&args.some(a=>a.endsWith('/out/pix.png')))return {stdout:PNG};
    return {code:0,stdout:'made files\n'};
  });
  const w=new Workshop({dataDir:dir,spawn:fake.spawn});
  const r=await w.run('scholar','cap1',[]);
  assert.equal(r.ok,true);
  assert.deepEqual(r.files,['out.txt','pix.png']);
  assert.ok(r.skipped.includes('big.mp4: over the size limit'));
  assert.ok(r.skipped.includes('data.bin: type not supported'));
  const outbox=join(dir,'workshop-outbox');
  assert.equal(readdirSync(outbox).filter(f=>f.endsWith('.json')).length,2);
  // The server copies the outbox into the world's gallery.
  const events:any[]=[];
  const journal={state:{events},emit(type:string,data:any){const e={type,data,at:new Date().toISOString()};events.push(e);return e;}};
  assert.deepEqual(importWorkshopOutbox(dir,journal as any),{imported:2,refused:0});
  const kinds=events.filter(e=>e.type==='artifact.created').map(e=>e.data.kind).sort();
  assert.deepEqual(kinds,['image','text']);
  assert.equal(readdirSync(outbox).length,0);
  assert.ok(existsSync(join(dir,'artifacts')));
});

test('long runs need a long recipe and the owner\'s switch; everything else is capped at 60 seconds', () => {
  assert.equal(runSecondsFor(true,true,900),900);
  assert.equal(runSecondsFor(true,true,undefined),60);
  assert.equal(runSecondsFor(true,true,30),30);
  assert.equal(runSecondsFor(true,false,900),60);
  assert.equal(runSecondsFor(false,true,900),60);
  assert.throws(()=>runSecondsFor(true,true,0),/1 to 900/);
  assert.throws(()=>runSecondsFor(true,true,901),/1 to 900/);
  assert.throws(()=>runSecondsFor(true,true,'10'),/1 to 900/);
});

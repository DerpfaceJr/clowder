import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installAccess} from '../src/access.ts';
import {Pairing} from '../src/pairing.ts';
import {runSeason,seasonLock} from '../src/season.ts';
import {SeasonHost,registerSeasonRoutes} from '../src/season-host.ts';
import type {Launcher} from '../src/season-host.ts';
import {untilEvery} from './helpers/until.ts';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tmp=()=>mkdtempSync(join(tmpdir(),'season-host-'));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const until = untilEvery(50);

// A stand-in season: it holds a lock like the real runner, exits cleanly with a pause line, or fails.
const FAKE=join(tmp(),'fake-season.mjs');
writeFileSync(FAKE,`
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
const flag=f=>{const i=args.indexOf(f);return i<0?undefined:args[i+1];};
const name=flag('--name'),mode=flag('--mode');
const lock=join(process.env.CAT_TOWN_DATA,'season-'+name+'.lock');
if(mode==='paused'){console.log('season paused: plan limit reached; run the same command again later to continue');process.exit(0);}
if(mode==='fail'){console.error('boom');process.exit(3);}
writeFileSync(lock,String(process.pid));
const done=()=>{try{rmSync(lock,{force:true});}catch{}process.exit(130);};
process.on('SIGINT',done);process.on('SIGTERM',done);
setInterval(()=>{},1000);
`);
const fake:Launcher=({name,mode})=>({file:process.execPath,args:[FAKE,'--name',name,'--mode',mode]});

async function partialSeason(dataDir:string,name:string){
  await runSeason({name,mode:'demo',seed:1,days:2,dataDir,config,stopAfterTicks:2});
}

test('start, single instance, and stop of a fake season', async()=>{
  const dir=tmp();
  await partialSeason(dir,'a1');
  const host=new SeasonHost({root:ROOT,dataDir:dir,defaultDays:7,launch:fake});
  const before=host.list();
  assert.equal(before.nextName,'s1');
  assert.equal(before.seasons.find(s=>s.name==='a1')?.status,'paused');
  assert.equal(before.defaultDays,7);

  await host.start({name:'live',mode:'local'});
  await until(()=>seasonLock('live',dir).running);
  assert.equal(host.list().running?.name,'live');
  assert.equal(host.list().seasons.find(s=>s.name==='live'),undefined,'a run with no journal yet is not listed');

  await assert.rejects(host.start({name:'other',mode:'local'}),/Season live is running\. Stop it first\./);
  await assert.rejects(host.start({name:'live',mode:'local'}),/already running/);
  await assert.rejects(host.start({name:'../bad',mode:'local'}),/Season name must be/);
  await assert.rejects(host.stop('a1'),/Season a1 is not running/);

  await host.stop('live');
  assert.equal(host.running(),null);
  assert.equal(seasonLock('live',dir).running,false);
});

test('a season started before a server restart is found again through its lock', async()=>{
  const dir=tmp();
  const first=new SeasonHost({root:ROOT,dataDir:dir,launch:fake});
  await first.start({name:'kept',mode:'local'});
  await until(()=>seasonLock('kept',dir).running);

  const restarted=new SeasonHost({root:ROOT,dataDir:dir,launch:fake});
  const running=restarted.running();
  assert.equal(running?.name,'kept');
  assert.equal(running?.source,'lock');
  await assert.rejects(restarted.start({name:'second',mode:'local'}),/Season kept is running/);

  await restarted.stop('kept');
  assert.equal(restarted.running(),null);
});

test('a season paused by a plan limit shows the reason from its log', async()=>{
  const dir=tmp();
  await partialSeason(dir,'a1');
  const host=new SeasonHost({root:ROOT,dataDir:dir,launch:fake});
  await host.start({name:'a1',mode:'paused'});
  await until(()=>host.running()===null&&existsSync(join(dir,'season-a1.log')) && readFileSync(join(dir,'season-a1.log'),'utf8').includes('season paused'));
  const entry=host.list().seasons.find(s=>s.name==='a1');
  assert.equal(entry?.status,'paused');
  assert.equal(entry?.reason,'plan limit reached');
});

test('a season whose run exits with an error reports the exit code', async()=>{
  const dir=tmp();
  await partialSeason(dir,'a1');
  const host=new SeasonHost({root:ROOT,dataDir:dir,launch:fake});
  await host.start({name:'a1',mode:'fail'});
  await until(()=>host.running()===null);
  await until(()=>host.list().seasons.find(s=>s.name==='a1')?.reason!==undefined);
  assert.equal(host.list().seasons.find(s=>s.name==='a1')?.reason,'exited with code 3');
});

test('the real runner starts through the tsx loader and finishes a one-day demo season', async()=>{
  const dir=tmp();
  const host=new SeasonHost({root:ROOT,dataDir:dir});
  await host.start({name:'real',mode:'demo',seed:5,days:1});
  await until(()=>host.list().seasons.find(s=>s.name==='real')?.status==='finished',60000);
  assert.equal(host.running(),null);
});

test('routes are owner-only and validate names and enabled modes', async()=>{
  const dir=tmp();
  await partialSeason(dir,'a1');
  const host=new SeasonHost({root:ROOT,dataDir:dir,launch:fake});
  const hub={list:async()=>[{id:'demo',name:'Demonstration'},{id:'local',name:'Local'}]};
  const app=Fastify();installAccess(app,true,['192.168.1.20'],8787,new Pairing(join(dir,'devices.json'),config.remote),undefined,'test-owner');registerSeasonRoutes(app,{host,hub});await app.ready();
  try{
    const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
    const listed=await app.inject({url:'/api/seasons',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}});
    assert.equal(listed.statusCode,200);
    assert.equal(listed.json().nextName,'s1');
    assert.deepEqual(listed.json().modes.map((m:{id:string})=>m.id),['demo','local']);

    const share=await app.inject({url:'/api/sharing',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}});
    const token=new URL(share.json().urls[0]).hash.slice(6);
    const remote={host:'192.168.1.20:8787'};
    const login=await app.inject({method:'POST',url:'/api/viewer-session',remoteAddress:'192.168.1.21',headers:remote,payload:{token}});
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const viewer={...remote,cookie};
    assert.equal((await app.inject({url:'/api/seasons',remoteAddress:'192.168.1.21',headers:viewer})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/seasons/start',remoteAddress:'192.168.1.21',headers:{...viewer,'x-town-action':'owner'},payload:{name:'v1',mode:'demo'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/seasons/stop',remoteAddress:'192.168.1.21',headers:{...viewer,'x-town-action':'owner'},payload:{name:'a1'}})).statusCode,403);

    const hosted=await app.inject({method:'POST',url:'/api/seasons/start',headers:owner,payload:{name:'h1',mode:'hosted'}});
    assert.equal(hosted.statusCode,400);
    assert.match(hosted.json().error,/hosted is not enabled/);
    const badName=await app.inject({method:'POST',url:'/api/seasons/start',headers:owner,payload:{name:'../x',mode:'demo'}});
    assert.equal(badName.statusCode,400);
    const notRunning=await app.inject({method:'POST',url:'/api/seasons/stop',headers:owner,payload:{name:'a1'}});
    assert.equal(notRunning.statusCode,409);

    const started=await app.inject({method:'POST',url:'/api/seasons/start',headers:owner,payload:{name:'r1',mode:'local',days:2}});
    assert.equal(started.statusCode,200);
    await until(()=>host.running()?.name==='r1');
    assert.equal((await app.inject({method:'POST',url:'/api/seasons/stop',headers:owner,payload:{name:'r1'}})).statusCode,200);
    assert.equal(host.running(),null);
  }finally{
    const run=host.running();
    if(run)await host.stop(run.name);
    await app.close();
  }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import Fastify from 'fastify';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {installStateGzip} from '../src/state-gzip.ts';
import {buildStamp} from '../src/build-info.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

const config={...JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')),maxParallelWork:3};
const fixture=(provider:Provider)=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'phase0-')),'events.jsonl'),config.cats);
  return {store,town:new Town(store,config,{test:provider})};
};
const until = untilEvery(5);
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
const last=(messages:any[])=>String(messages.at(-1)?.content??'');

// 0.9: a goal round's chat line is from the town; its task still comes from the owner, so the Mayor's reply goes to the owner.
test('a goal round message is from town, its task is from owner',()=>{
  const {store,town}=fixture(async()=>reply('ok'));
  store.emit('goal.created',{id:'g1',title:'Plan the launch',success:'x',status:'active',mode:'demo',rounds:0,roundsToday:0,day:'',failures:0,log:[],summary:null,maxRoundsPerDay:24,tokenBudget:null,pausedBy:null,note:null,endedBy:null});
  const {task}=(town as any).beginRound(store.state.goals[0],1);
  assert.equal(task.from,'owner');
  const round=store.state.messages.find(m=>m.task===task.id);
  assert.equal(round?.from,'town');
  assert.equal(round?.to,'mayor');
  assert.match(round?.text??'',/^Goal round 1: Plan the launch$/);
});

// 0.10: a remember call with no text is refused with the schema and the shape received, never the value.
test('a remember call without text says what text should look like',async()=>{
  let refusal='';
  const {store,town}=fixture(async(messages,tools)=>{
    const q=last(messages);
    if(q.startsWith('Record for the town'))return call('remember',{title:'Niche: cosy reading'});
    if(messages.at(-1)?.role==='tool'){refusal=last(messages);return reply('Noted.');}
    return reply('We picked the cosy-reading niche because three rivals post daily and none post book reviews.');
  });
  town.submit('mayor','Pick a niche','test');
  await until(()=>refusal!=='');
  assert.equal(refusal,'Tool error: Invalid text: expected text as a string of 1–1200 characters; got none.');
  assert.equal(store.state.events.filter(e=>e.type==='memory.noted').length,0);
});

// 0.12: /api/state is gzipped only when asked; the body decompresses to the same JSON.
test('/api/state is gzipped when the browser accepts it, and plain otherwise',async()=>{
  const app=Fastify();
  const body={cats:Array.from({length:500},(_,i)=>({id:`cat-${i}`,name:'Cat '+i,role:'a long role description that repeats '.repeat(4)}))};
  installStateGzip(app);
  app.get('/api/state',async()=>body);
  app.get('/api/other',async()=>body);
  const plain=JSON.stringify(body);
  const zipped=await app.inject({url:'/api/state',headers:{'accept-encoding':'gzip, deflate, br','x-forwarded-for':'100.64.0.7'}});
  assert.equal(zipped.headers['content-encoding'],'gzip');
  assert.match(String(zipped.headers['vary']),/accept-encoding/i);
  assert.equal(gunzipSync(zipped.rawPayload).toString('utf8'),plain);
  assert.ok(zipped.rawPayload.length<plain.length);
  // This computer's own window gets plain JSON: compressing costs more than copying it over loopback.
  const local=await app.inject({url:'/api/state',headers:{'accept-encoding':'gzip'}});
  assert.equal(local.headers['content-encoding'],undefined);
  assert.equal(local.body,plain);
  const none=await app.inject({url:'/api/state'});
  assert.equal(none.headers['content-encoding'],undefined);
  assert.equal(none.body,plain);
  const other=await app.inject({url:'/api/other',headers:{'accept-encoding':'gzip'}});
  assert.equal(other.headers['content-encoding'],undefined);
  await app.close();
});

// 0.13: the running build's commit comes from build-info.json, else git at startup; stale flips once git's HEAD moves, checked at most once a minute.
test('the build stamp reads the packaged commit, and stale flips when HEAD moves',()=>{
  const dir=mkdtempSync(join(tmpdir(),'build-'));
  let head:string|null='abc1234',t=0;
  const dev=buildStamp(dir,()=>head,()=>t);
  assert.deepEqual({commit:dev.get().commit,stale:dev.get().stale},{commit:'abc1234',stale:false});
  head='def5678';
  t=30_000;
  assert.equal(dev.get().stale,false,'cached for 60 s');
  t=60_000;
  assert.equal(dev.get().stale,true,'HEAD moved on');
  head=null;
  t=120_000;
  assert.equal(dev.get().stale,false,'no git, no stale');
  writeFileSync(join(dir,'build-info.json'),JSON.stringify({commit:'pack999'}));
  const packed=buildStamp(dir,()=>null,()=>t);
  assert.equal(packed.get().commit,'pack999');
  assert.equal(packed.get().stale,false);
  // A dev checkout keeps the stamp of its last desktop build; git still wins there.
  assert.equal(buildStamp(dir,()=>'live111',()=>t).get().commit,'live111');
});

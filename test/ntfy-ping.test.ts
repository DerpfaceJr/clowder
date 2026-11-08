import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {NtfyService,PING_BODY,PING_CLICK,registerNtfyRoutes} from '../src/ntfy.ts';
import {PushService,type Sender} from '../src/push.ts';

// Fake fetch only: the real ntfy.sh is never called. Every value is fake.
const RELAY='https://ntfy.example';
const dir=()=>mkdtempSync(join(tmpdir(),'clowder-ntfy-'));
const sent=():{endpoint:string;headers:Record<string,string>;body:string}[]=>calls;
let calls:{endpoint:string;headers:Record<string,string>;body:string}[]=[];
const fakeSender:Sender=async(endpoint,headers,body)=>{calls.push({endpoint,headers,body:body.toString('utf8')});return 200;};
const clock=()=>{
  let now=0;const timers:{at:number;fn:()=>void}[]=[];
  return {now:()=>now,later:(fn:()=>void,ms:number)=>{timers.push({at:now+ms,fn});return timers.at(-1);},
    stopTimer:()=>{},
    advance(ms:number){now+=ms;for(const t of timers.filter(t=>t.at<=now)){timers.splice(timers.indexOf(t),1);t.fn();}}};
};
const ntfyAt=(d:string,c=clock())=>({ntfy:new NtfyService({dataDir:d,server:RELAY,send:fakeSender,now:c.now,later:c.later,stopTimer:c.stopTimer}),c});
const topicOf=(url:string)=>url.slice(`${RELAY}/`.length);
const DECISION={events:[{id:'ev-1',type:'approval.requested',data:{id:'appr-7',cat:'mabel',status:'pending',question:'Buy 40 fish for the Mayor?',options:['Allow','Deny'],gate:'connector',effectClass:'write'}}],cats:[{id:'mabel',name:'Mabel'}]};

test('ntfy is off by default: a notice sends nothing and no status is enabled', async()=>{
  calls=[];const d=dir();
  const {ntfy}=ntfyAt(d);
  const push=new PushService({dataDir:d,send:fakeSender});
  push.onNotify(k=>ntfy.ping(k));
  push.notify('approvals',{title:'Clowder',body:'x',tag:'t'});
  assert.equal(calls.filter(c=>c.endpoint.startsWith(RELAY)).length,0);
  assert.deepEqual(ntfy.status('dev-1'),{enabled:false});
  assert.equal(existsSync(join(d,'ntfy.json')),false);
  push.close();ntfy.close();rmSync(d,{recursive:true,force:true});
});

test('a decision sends exactly one content-free ping on the device topic', async()=>{
  calls=[];const d=dir();
  const {ntfy}=ntfyAt(d);
  const push=new PushService({dataDir:d,send:fakeSender});
  push.onNotify(k=>ntfy.ping(k));
  const {url}=ntfy.enable('dev-1');
  assert.match(url,/^https:\/\/ntfy\.example\/clowder-[0-9a-f]{48}$/);
  push.onStore({state:DECISION as any,listeners:new Set()});
  const pings=sent().filter(c=>c.endpoint.startsWith(RELAY));
  assert.equal(pings.length,1);
  assert.equal(pings[0]!.endpoint,url);
  assert.equal(pings[0]!.body,PING_BODY);
  assert.equal(pings[0]!.headers.Click,PING_CLICK);
  const everything=JSON.stringify(pings);
  for(const secret of ['Buy 40','fish','Mayor','Mabel','mabel','appr-7','ev-1','Allow','Deny'])assert.equal(everything.includes(secret),false,`ping leaks ${secret}`);
  push.close();ntfy.close();rmSync(d,{recursive:true,force:true});
});

test('pings coalesce: at most one per minute per device, the rest arrive as one ping when the window ends', async()=>{
  calls=[];const d=dir();
  const {ntfy,c}=ntfyAt(d);
  ntfy.enable('dev-1');
  ntfy.ping('approvals');
  c.advance(10_000);ntfy.ping('approvals');ntfy.ping('mayor');ntfy.ping('seasons');
  assert.equal(sent().filter(x=>x.endpoint.startsWith(RELAY)).length,1,'only the first ping inside the minute is sent');
  c.advance(60_000);
  assert.equal(sent().filter(x=>x.endpoint.startsWith(RELAY)).length,2,'the coalesced rest is one more ping');
  ntfy.close();rmSync(d,{recursive:true,force:true});
});

test('revoking a device stops pings and deletes its topic from the file', async()=>{
  calls=[];const d=dir();
  const {ntfy}=ntfyAt(d);
  const {url}=ntfy.enable('dev-1');
  const topic=topicOf(url);
  ntfy.forget('dev-1');
  assert.deepEqual(ntfy.status('dev-1'),{enabled:false});
  assert.equal(readFileSync(join(d,'ntfy.json'),'utf8').includes(topic),false);
  ntfy.ping('approvals');
  assert.equal(sent().filter(x=>x.endpoint.startsWith(RELAY)).length,0);
  ntfy.close();rmSync(d,{recursive:true,force:true});
});

test('the topic is not written to any other file in the data folder (journal, push, state)', async()=>{
  calls=[];const d=dir();
  const {ntfy}=ntfyAt(d);
  const push=new PushService({dataDir:d,send:fakeSender});
  push.onNotify(k=>ntfy.ping(k));
  const {url}=ntfy.enable('dev-1');
  const topic=topicOf(url);
  push.onStore({state:DECISION as any,listeners:new Set()});
  // The topic may sit in the SecretStore (secrets.v2.json) or, with no store open, in ntfy.json. Nowhere else.
  const holders=readdirSync(d).filter(f=>readFileSync(join(d,f),'utf8').includes(topic));
  assert.equal(holders.filter(f=>f!=='ntfy.json'&&f!=='secrets.v2.json').length,0,`topic leaked into ${holders}`);
  assert.equal(holders.length,1,`topic should be held once, found in ${holders}`);
  push.close();ntfy.close();rmSync(d,{recursive:true,force:true});
});

test('routes are owner-only and refuse an unknown device', async()=>{
  const d=dir();const {ntfy}=ntfyAt(d);
  const app=Fastify();
  registerNtfyRoutes(app,{service:ntfy,allowed:req=>req.headers['x-owner']==='1',devices:()=>[{id:'dev-1',name:'Phone'}]});
  assert.equal((await app.inject({method:'GET',url:'/api/ntfy'})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/ntfy/devices/dev-1/enable',headers:{'x-owner':'0'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/ntfy/devices/nope/enable',headers:{'x-owner':'1'}})).statusCode,404);
  const enabled=await app.inject({method:'POST',url:'/api/ntfy/devices/dev-1/enable',headers:{'x-owner':'1'}});
  assert.equal(enabled.statusCode,200);
  assert.match(enabled.json().url,/^https:\/\/ntfy\.example\/clowder-/);
  const status=(await app.inject({method:'GET',url:'/api/ntfy',headers:{'x-owner':'1'}})).json();
  assert.deepEqual(status.devices,[{id:'dev-1',name:'Phone',enabled:true,url:enabled.json().url}]);
  await app.inject({method:'POST',url:'/api/ntfy/devices/dev-1/disable',headers:{'x-owner':'1'}});
  assert.equal((await app.inject({method:'GET',url:'/api/ntfy',headers:{'x-owner':'1'}})).json().devices[0].enabled,false);
  await app.close();ntfy.close();rmSync(d,{recursive:true,force:true});
});

test('a non-https ntfy server is refused at start', ()=>{
  assert.throws(()=>new NtfyService({dataDir:dir(),server:'http://ntfy.example'}),/https/);
});

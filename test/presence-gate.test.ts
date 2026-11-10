// Plan 10.10 (docs/for-you-and-teams-plan.md §4.6, §4.7): the presence frame names who has a page open, by person, and the closed gate tells a
// page the host stopped answering within one poll. The real server (src/server.ts) runs in this process on scratch ports with a temp data dir.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request,type ClientRequest} from 'node:http';
import type {FastifyInstance} from 'fastify';
import {applyFrame,createGate} from '../public/state-delta.js';
import {untilEvery} from './helpers/until.ts';

const ORIGIN='https://presence.trycloudflare.com',DAY=24*60*60*1000,OWNER_KEY='presence-owner-key';
const pollMs:number=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote.pollMs;
const sha=(token:string)=>createHash('sha256').update(token).digest('hex');
const token={owner:randomBytes(32).toString('hex'),member:randomBytes(32).toString('hex'),viewer:randomBytes(32).toString('hex')};
const devices=(now:number)=>[
  {id:'dev-owner-phone',name:'Owner phone',permission:'owner',person:'owner',tokenHash:sha(token.owner),createdAt:now,expiresAt:now+20*DAY},
  {id:'dev-mia-phone',name:'Mia phone',permission:'member',person:'p-mia',tokenHash:sha(token.member),createdAt:now,expiresAt:now+20*DAY},
  {id:'dev-vic-tablet',name:'Vic tablet',permission:'viewer',person:'p-vic',tokenHash:sha(token.viewer),createdAt:now,expiresAt:now+20*DAY},
];
let dir='',app:FastifyInstance,remoteApp:FastifyInstance;
const realFetch=globalThis.fetch;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'presence-'));
  writeFileSync(join(dir,'connectors.json'),JSON.stringify({connectors:[],plugins:[]}));
  writeFileSync(join(dir,'workshop-settings.json'),JSON.stringify({autoSetup:false}));
  writeFileSync(join(dir,'devices.json'),JSON.stringify(devices(Date.now())));
  writeFileSync(join(dir,'people.json'),JSON.stringify([{id:'p-mia',name:'Mia',role:'member',createdAt:Date.now()},{id:'p-vic',name:'Vic',role:'viewer',createdAt:Date.now()}]));
  globalThis.fetch=(async()=>new Response(null,{status:503})) as typeof fetch;
  const port=30000+Math.floor(Math.random()*20000);
  Object.assign(process.env,{PORT:String(port),CAT_REMOTE_PORT:String(port+1),CAT_TOWN_DATA:dir,CAT_TUNNEL_AUTOSTART:'0',CAT_TOWN_LAN:'0',CAT_OWNER_KEY:OWNER_KEY});
  const server=await import('../src/server.ts');
  app=server.app;remoteApp=server.remoteApp;server.tunnel.origin=ORIGIN;
});
after(async()=>{await remoteApp?.close();await app?.close();globalThis.fetch=realFetch;});

// One page's stream on the tunnel listener: every data frame, parsed, as it arrives.
function open(cookieToken:string){
  const frames:any[]=[],raw:string[]=[];let req!:ClientRequest;
  const ready=new Promise<void>((done,fail)=>{
    const port=(remoteApp.server.address() as {port:number}).port;
    req=request({host:'127.0.0.1',port,path:'/api/events',headers:{host:new URL(ORIGIN).host,origin:ORIGIN,cookie:`__Host-town_device=${cookieToken}`}},res=>{
      assert.equal(res.statusCode,200);res.setEncoding('utf8');let buf='';
      res.on('data',(chunk:string)=>{raw.push(chunk);buf+=chunk;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);const data=block.split('\n').find(l=>l.startsWith('data: '));if(data)frames.push(JSON.parse(data.slice(6)));}});
      done();
    });
    req.on('error',fail);req.end();
  });
  return {frames,raw,ready,close:()=>req.destroy(),presence:()=>frames.filter(f=>f.presence).at(-1)?.presence};
}
const until = untilEvery(10);
const names=(list:any[]|undefined)=>(list??[]).map(p=>p.name).sort();

test('presence names the people connected, by person and never by device or token, and drops a person with their last page',async()=>{
  const seq=()=>owner.frames.find(f=>f.hello).seq;
  const owner=open(token.owner);await owner.ready;
  await until(()=>names(owner.presence()).join()==='Owner');
  const mia1=open(token.member);await mia1.ready;
  await until(()=>names(owner.presence()).join()==='Mia,Owner');
  const vic=open(token.viewer);await vic.ready;
  await until(()=>names(owner.presence()).length===3&&names(vic.presence()).length===3);
  // The owner sees each person's id; a member or viewer sees names and roles only.
  assert.deepEqual(owner.presence().sort((a:any,b:any)=>a.name<b.name?-1:1),[{id:'p-mia',name:'Mia',role:'member'},{id:'owner',name:'Owner',role:'owner'},{id:'p-vic',name:'Vic',role:'viewer'}]);
  for(const p of [...vic.presence(),...mia1.presence()])assert.deepEqual(Object.keys(p).sort(),['name','role']);
  // A second page of Mia's is the same person: one entry, and the others hear nothing new.
  const before=owner.frames.length;
  const mia2=open(token.member);await mia2.ready;
  await until(()=>names(mia2.presence()).length===3);
  assert.equal(owner.frames.length,before,'a page of a person already present changes nobody else\'s list');
  mia1.close();await new Promise(r=>setTimeout(r,200));
  assert.deepEqual(names(owner.presence()),['Mia','Owner','Vic'],'Mia stays while one of her pages is open');
  mia2.close();
  await until(()=>names(owner.presence()).join()==='Owner,Vic'&&names(vic.presence()).join()==='Owner,Vic');
  // Nothing in any stream names a device or carries a token, and presence never moved the journal.
  const text=[owner,mia1,mia2,vic].flatMap(s=>s.raw).join('');
  for(const secret of ['dev-owner-phone','dev-mia-phone','dev-vic-tablet',token.owner,token.member,token.viewer,sha(token.member)])assert.ok(!text.includes(secret),secret);
  const later=open(token.owner);await later.ready;await until(()=>later.frames.some(f=>f.hello));
  assert.equal(later.frames.find(f=>f.hello).seq,seq(),'no journal line for presence');
  owner.close();vic.close();later.close();
});

test('the page keeps presence beside its state without moving seq, in any world',()=>{
  const state={seq:5,activeWorld:{id:'home'},limits:{events:10},events:[],messages:[],tasks:[],approvals:[]};
  const next=applyFrame(state,{presence:[{name:'Mia',role:'member'}]});
  assert.equal(next.seq,5);assert.deepEqual(next.presence,[{name:'Mia',role:'member'}]);
  assert.equal(applyFrame(undefined,{presence:[]}),undefined,'no state yet: held, not applied');
});

// A fake clock and a fake connection, the shape of an EventSource as app.js opens it.
function fakes(){
  let t=1_000;const timers:{at:number;fn:()=>void}[]=[];
  const listeners:Record<string,(()=>void)[]>={};
  const source={addEventListener:(type:string,fn:()=>void)=>{(listeners[type]??=[]).push(fn);},emit:(type:string)=>{for(const fn of listeners[type]??[])fn();}};
  const advance=(ms:number)=>{t+=ms;for(const timer of timers.filter(x=>x.at<=t)){timers.splice(timers.indexOf(timer),1);timer.fn();}};
  return {now:()=>t,schedule:(fn:()=>void,ms:number)=>{timers.push({at:t+ms,fn});},source,advance};
}

test('the gate closes within one poll of the host going away, records when it last answered, and opens on the next answer',()=>{
  const f=fakes(),changes:any[]=[];
  const gate=createGate({every:pollMs,now:f.now,schedule:f.schedule,onChange:s=>changes.push(s)});
  gate.watch(f.source);
  f.source.emit('open');f.advance(500);f.source.emit('message');
  const answered=f.now();
  assert.deepEqual(gate.gateState(),{open:true,lastSeenAt:answered});
  // The host stops: the stream errors and nothing answers.
  f.advance(100);f.source.emit('error');
  f.advance(pollMs-1);
  assert.equal(gate.gateState().open,true,'not before a poll has passed');
  f.advance(1);
  assert.deepEqual(gate.gateState(),{open:false,lastSeenAt:answered},'closed within one poll, with the last time the host answered');
  assert.deepEqual(changes,[{open:false,lastSeenAt:answered}]);
  // The browser retries and keeps failing: still closed, no new change.
  f.source.emit('error');f.advance(pollMs);
  assert.equal(changes.length,1);
  // The host wakes: the stream opens again.
  f.advance(10_000);f.source.emit('open');
  assert.deepEqual(gate.gateState(),{open:true,lastSeenAt:f.now()});
  assert.equal(changes.length,2);
});

test('a blip the host answers within the poll never closes the gate',()=>{
  const f=fakes(),changes:any[]=[];
  const gate=createGate({every:pollMs,now:f.now,schedule:f.schedule,onChange:s=>changes.push(s)});
  gate.watch(f.source);f.source.emit('open');
  f.advance(50);f.source.emit('error');f.advance(pollMs/2);f.source.emit('open');f.advance(pollMs);
  assert.equal(gate.gateState().open,true);assert.deepEqual(changes,[]);
  // A successful refetch is an answer too.
  f.source.emit('error');f.advance(10);gate.seen();f.advance(pollMs);
  assert.equal(gate.gateState().open,true);
});

import test from 'node:test';
import {withSecrets} from '../src/secret-store.ts';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {isOwner} from '../src/access.ts';
import {DEFAULT_RELAY,Rendezvous,open,registerRendezvousRoute,rendezvousFor,seal} from '../src/rendezvous.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
const vector=JSON.parse(readFileSync(new URL('./fixtures/rendezvous-vector.json',import.meta.url),'utf8'));
const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const HOUR=3_600_000;
const newKey=()=>randomBytes(32).toString('base64url');
const dir=()=>mkdtempSync(join(tmpdir(),'cat-rendezvous-'));
const origin='https://town.trycloudflare.com';
// A fake relay: records every POST, answers 200, or fails every call when asked.
function relayFake(fail=false){
  const posts:{url:string;body:string;signal?:AbortSignal}[]=[];
  const fetcher=async(url:string,init:RequestInit)=>{posts.push({url,body:String(init.body),signal:init.signal??undefined});if(fail)throw new TypeError('fetch failed');return new Response('{}',{status:200});};
  return {posts,fetcher};
}

test('seal and open round-trip, and the text is base64url without padding',()=>{
  const key=newKey(),text=seal(origin,1234,key);
  assert.deepEqual(open(text,key),{origin,at:1234});
  assert.match(text,/^[A-Za-z0-9_-]+$/);
});

test('a flipped byte, a wrong key or a damaged text opens as null',()=>{
  const key=newKey(),raw=Buffer.from(seal(origin,1,key),'base64url');
  for(const index of [0,12,20,raw.length-1]){const bad=Buffer.from(raw);bad[index]^=0x01;assert.equal(open(bad.toString('base64url'),key),null,`byte ${index}`);}
  assert.equal(open(raw.toString('base64url'),newKey()),null);
  assert.equal(open('not base64!',key),null);
  assert.equal(open(raw.toString('base64url').slice(0,20),key),null);
});

test('an origin that is not a bare https origin opens as null',()=>{
  const key=newKey();
  for(const bad of ['http://town.example.com','https://town.example.com/','https://town.example.com/app','https://town.example.com?x=1','https://town.example.com/#pair','not a url'])assert.equal(open(seal(bad,1,key),key),null,bad);
  assert.deepEqual(open(seal('https://town.example.com:8443',1,key),key),{origin:'https://town.example.com:8443',at:1});
});

test('the known-answer vector for the Android app reseals byte for byte and opens',()=>{
  assert.equal(seal(vector.origin,vector.at,vector.key,Buffer.from(vector.iv,'base64url')),vector.sealed);
  assert.deepEqual(open(vector.sealed,vector.key),{origin:vector.origin,at:vector.at});
});

test('a new town creates rendezvous.json once with mode 0600 and keeps its topic and key',()=>{
  const d=dir();
  try{
    const file=join(d,'rendezvous.json'),first=new Rendezvous(file,DEFAULT_RELAY,undefined,undefined,()=>{});
    assert.match(first.topic,/^clowder-[0-9a-f]{48}$/);assert.equal(Buffer.from(first.key,'base64url').length,32);
    if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);
    const again=new Rendezvous(file,DEFAULT_RELAY,undefined,undefined,()=>{});assert.equal(again.topic,first.topic);assert.equal(again.key,first.key);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{relay:DEFAULT_RELAY,topic:first.topic},'the key is in the SecretStore');
    assert.deepEqual(withSecrets(file,JSON.parse(readFileSync(file,'utf8'))),{relay:DEFAULT_RELAY,topic:first.topic,key:first.key});
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('a damaged rendezvous.json is never replaced; the relay turns off with one log line',()=>{
  const d=dir();
  try{
    writeFileSync(join(d,'rendezvous.json'),'{"topic":"nope"}');const lines:string[]=[];
    assert.equal(rendezvousFor(d,{},m=>lines.push(m)),null);assert.equal(lines.length,1);
    assert.equal(readFileSync(join(d,'rendezvous.json'),'utf8'),'{"topic":"nope"}');
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('remote.rendezvous:false turns the relay off without a file; the relay must be https and is read from config',()=>{
  const d=dir();
  try{
    assert.equal(rendezvousFor(d,{rendezvous:false}),null);assert.equal(existsSync(join(d,'rendezvous.json')),false);
    const lines:string[]=[];assert.equal(rendezvousFor(d,{rendezvousRelay:'http://relay.example.com'},m=>lines.push(m)),null);assert.equal(lines.length,1);assert.match(lines[0],/https/);
    assert.equal(rendezvousFor(d,{rendezvousRelay:'https://relay.example.com/'},()=>{})?.relay,'https://relay.example.com');
    assert.equal(rendezvousFor(d,{},()=>{})?.relay,DEFAULT_RELAY);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('announce posts the sealed origin to relay/topic, and it opens to the origin',async()=>{
  const d=dir();
  try{
    const relay=relayFake(),r=new Rendezvous(join(d,'rendezvous.json'),'https://relay.example.com',relay.fetcher,()=>1000,()=>{});
    await r.announce(origin);
    assert.equal(relay.posts.length,1);assert.equal(relay.posts[0].url,`https://relay.example.com/${r.topic}`);
    assert.deepEqual(open(relay.posts[0].body,r.key),{origin,at:1000});assert.ok(relay.posts[0].signal);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('a failing relay never throws, logs its first failure once, and is retried in five minutes',async()=>{
  const d=dir();
  try{
    let now=0;const relay=relayFake(true),lines:string[]=[];
    const r=new Rendezvous(join(d,'rendezvous.json'),'https://relay.example.com',relay.fetcher,()=>now,m=>lines.push(m));
    await r.tick(origin);await r.tick(origin);
    assert.equal(relay.posts.length,1);assert.equal(lines.length,1);
    now+=5*60_000-1;await r.tick(origin);assert.equal(relay.posts.length,1);
    now+=1;await r.tick(origin);assert.equal(relay.posts.length,2);assert.equal(lines.length,1);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('a tunnel origin change triggers an announce, and the six-hour timer re-announces',async()=>{
  const d=dir();
  try{
    let now=1_000_000;const relay=relayFake(),r=new Rendezvous(join(d,'rendezvous.json'),'https://relay.example.com',relay.fetcher,()=>now,()=>{});
    await r.tick(undefined);assert.equal(relay.posts.length,0);
    await r.tick(origin);assert.equal(relay.posts.length,1);
    await r.tick(origin);assert.equal(relay.posts.length,1);
    now+=6*HOUR-1;await r.tick(origin);assert.equal(relay.posts.length,1);
    now+=1;await r.tick(origin);assert.equal(relay.posts.length,2);
    await r.tick('https://other.trycloudflare.com');assert.equal(relay.posts.length,3);
    assert.equal(open(relay.posts[2].body,r.key)?.origin,'https://other.trycloudflare.com');
    await r.tick(undefined);await r.tick('https://other.trycloudflare.com');assert.equal(relay.posts.length,4);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('the topic and key go to paired devices on the remote listener, and to the owner on the main app only',async()=>{
  const d=dir();
  try{
    const r=new Rendezvous(join(d,'rendezvous.json'),DEFAULT_RELAY,undefined,undefined,()=>{}),pairing=new Pairing(join(d,'devices.json'),config);
    let current:Rendezvous|null=r;const host={host:new URL(origin).host};
    const remote=Fastify({logger:false});installRemoteAccess(remote,pairing,()=>origin);registerRendezvousRoute(remote,()=>current,()=>true);
    const {token}=pairing.pair(pairing.create('viewer').code,'Phone'),paired={...host,cookie:`__Host-town_device=${token}`};
    assert.equal((await remote.inject({url:'/api/remote/rendezvous',headers:host})).statusCode,401);
    assert.equal(pairing.list()[0].followAt,undefined);
    const found=await remote.inject({url:'/api/remote/rendezvous',headers:paired});
    assert.equal(found.statusCode,200);assert.deepEqual(found.json(),{relay:DEFAULT_RELAY,topic:r.topic,key:r.key});
    assert.equal(typeof pairing.list()[0].followAt,'number');
    current=null;assert.equal((await remote.inject({url:'/api/remote/rendezvous',headers:paired})).statusCode,404);
    const main=Fastify({logger:false});registerRendezvousRoute(main,()=>r,isOwner);
    assert.equal((await main.inject({url:'/api/remote/rendezvous',remoteAddress:'192.168.1.20',headers:{host:'192.168.1.20:8787'}})).statusCode,403);
    assert.equal((await main.inject({url:'/api/remote/rendezvous',remoteAddress:'127.0.0.1',headers:{host:'localhost:8787'}})).json().topic,r.topic);
    await remote.close();await main.close();
  }finally{rmSync(d,{recursive:true,force:true});}
});

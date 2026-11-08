import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {isOwner} from '../src/access.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;

test('invalid security limits and damaged credentials fail closed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cat-invalid-'));try{
    const path=join(dir,'devices.json');
    assert.throws(()=>new Pairing(path,{...config,deviceTtlMs:NaN}),/limits/);
    writeFileSync(path,'[{"name":"missing credentials"}]');assert.throws(()=>new Pairing(path,config),/Invalid paired-device/);
    writeFileSync(path,'broken');assert.throws(()=>new Pairing(path,config));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('pairing survives restart, uses each code once, expires and revokes credentials',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cat-pair-'));let now=1000;
  try{
    const path=join(dir,'devices.json'),p=new Pairing(path,config,()=>now);
    const old=p.create('owner'),invite=p.create('viewer');
    assert.throws(()=>p.pair(old.code,'old'),/incorrect/);
    const {token,device}=p.pair(invite.code,'My tablet');
    assert.equal(device.permission,'viewer');assert.throws(()=>p.pair(invite.code,'duplicate'),/used/);
    assert.ok(!readFileSync(path,'utf8').includes(token));assert.ok(!JSON.stringify(p.list()).includes(device.tokenHash));
    const reopened=new Pairing(path,config,()=>now);assert.equal(reopened.authenticate(token)?.name,'My tablet');
    reopened.revoke(device.id);assert.equal(reopened.authenticate(token),undefined);assert.equal(new Pairing(path,config,()=>now).authenticate(token),undefined);
    const expired=reopened.create('owner');now+=config.pairingTtlMs;assert.throws(()=>reopened.pair(expired.code,'late'),/expired/);
    const next=reopened.pair(reopened.create('owner').code,'Phone');now+=config.deviceTtlMs;assert.equal(reopened.authenticate(next.token),undefined);
    const cancelled=reopened.create('viewer');reopened.cancel();assert.throws(()=>reopened.pair(cancelled.code,'cancelled'),/incorrect/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('pairing attempts are bounded and become available after the configured window',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cat-rate-'));let now=1000;
  try{const p=new Pairing(join(dir,'devices.json'),config,()=>now),invite=p.create('viewer');for(let i=0;i<config.maxPairAttempts;i++)assert.throws(()=>p.pair('wrong','Phone'));
    assert.throws(()=>p.pair(invite.code,'Phone'),/Too many/);now+=config.attemptWindowMs;assert.equal(p.pair(invite.code,'Phone').device.name,'Phone');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('public gateway requires pairing even from loopback; owner, viewer, CSRF, logout and revocation are enforced',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cat-gateway-')),p=new Pairing(join(dir,'devices.json'),config);
  const origin='https://test-town.trycloudflare.com';let enabled:string|undefined=origin;
  const app=Fastify();installRemoteAccess(app,p,()=>enabled);
  app.setErrorHandler((err:any,_req,res)=>res.code(err.statusCode||400).send({error:err.message}));
  app.get('/api/state',async req=>({readOnly:!isOwner(req)}));let commands=0;app.post('/api/pause',async()=>({commands:++commands}));await app.ready();
  const headers={host:new URL(origin).host,origin,'x-town-action':'owner'};
  try{
    assert.equal((await app.inject({url:'/api/state',headers,remoteAddress:'127.0.0.1'})).statusCode,401);
    assert.equal((await app.inject({url:'/api/state',headers:{...headers,host:'localhost:8787'}})).statusCode,403);
    assert.equal((await app.inject({url:'/api/remote-access',headers})).json().paired,false);
    const login=await app.inject({method:'POST',url:'/api/pair',headers,payload:{code:p.create('owner').code,name:'Phone'}});
    assert.equal(login.statusCode,200);assert.match(String(login.headers['set-cookie']),/Secure; HttpOnly; SameSite=Strict; Path=\//);
    const control={...headers,cookie:String(login.headers['set-cookie']).split(';')[0]};
    const state=await app.inject({url:'/api/state',headers:control});assert.equal(state.statusCode,200);assert.equal(state.json().readOnly,false);
    assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:control})).statusCode,200);assert.equal(commands,1);
    for(const bad of [{...control,origin:'https://evil.example'},{host:control.host,cookie:control.cookie,'x-town-action':'owner'},{...control,'x-town-action':'not-owner'}])assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:bad})).statusCode,403);
    assert.equal((await app.inject({url:'/api/remote/status',headers:control})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/remote/invite',headers:control,payload:{permission:'owner'}})).statusCode,403);
    const viewer=p.pair(p.create('viewer').code,'Viewer'),view={...headers,cookie:`__Host-town_device=${viewer.token}`};
    assert.equal((await app.inject({url:'/api/state',headers:view})).json().readOnly,true);
    assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:view})).statusCode,403);assert.equal(commands,1);
    assert.equal((await app.inject({method:'POST',url:'/api/logout',headers:view})).statusCode,200);
    assert.equal((await app.inject({url:'/api/state',headers:view})).statusCode,401);
    p.revoke(p.list()[0].id);assert.equal((await app.inject({url:'/api/state',headers:control})).statusCode,401);
    enabled=undefined;assert.equal((await app.inject({url:'/api/remote-access',headers})).statusCode,403);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('markFollow stamps a device at most once an hour, saves the stamp, and loads old and new records',()=>{
  const HOUR=60*60*1000,dir=mkdtempSync(join(tmpdir(),'cat-follow-'));let now=1000;
  try{
    const path=join(dir,'devices.json'),p=new Pairing(path,config,()=>now);
    const {device}=p.pair(p.create('viewer').code,'Phone');
    assert.equal(p.list()[0].followAt,undefined);
    p.markFollow(device.id);assert.equal(p.list()[0].followAt,1000);assert.equal(JSON.parse(readFileSync(path,'utf8'))[0].followAt,1000);
    now+=HOUR-1;const throttled=readFileSync(path,'utf8');p.markFollow(device.id);assert.equal(readFileSync(path,'utf8'),throttled);
    now+=1;p.markFollow(device.id);assert.equal(new Pairing(path,config,()=>now).list()[0].followAt,1000+HOUR);
    p.markFollow('not-a-device');assert.ok(!JSON.stringify(p.list()).includes('tokenHash'));
    const expired=readFileSync(path,'utf8');now+=config.deviceTtlMs;p.markFollow(device.id);assert.equal(readFileSync(path,'utf8'),expired);
    const records=JSON.parse(readFileSync(path,'utf8'));delete records[0].followAt;writeFileSync(path,JSON.stringify(records));
    assert.equal(new Pairing(path,config,()=>1000).list()[0].followAt,undefined);
    records[0].followAt='soon';writeFileSync(path,JSON.stringify(records));assert.throws(()=>new Pairing(path,config,()=>1000),/Invalid paired-device/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

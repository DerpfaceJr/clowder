import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {isOwner} from '../src/access.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const DAY=24*60*60*1000,HOUR=60*60*1000;
const dir=()=>mkdtempSync(join(tmpdir(),'cat-renew-'));
const storedExpiry=(path:string,id:string)=>JSON.parse(readFileSync(path,'utf8')).find((d:{id:string})=>d.id===id).expiresAt;

test('a device two days into its TTL is renewed in full and saved; one an hour in is not rewritten; an expired one is not revived',()=>{
  const d=dir();let now=1000;
  try{
    const path=join(d,'devices.json'),p=new Pairing(path,config,()=>now);
    const early=p.pair(p.create('viewer').code,'Early'),late=p.pair(p.create('viewer').code,'Late');
    now+=HOUR;const before=readFileSync(path,'utf8');
    assert.equal(p.authenticate(early.token)?.renewed,undefined);assert.equal(readFileSync(path,'utf8'),before);
    now+=2*DAY;const renewedAt=now;
    const renewed=p.authenticate(early.token);
    assert.equal(renewed?.renewed,true);assert.equal(renewed?.name,'Early');
    assert.equal(storedExpiry(path,early.device.id),renewedAt+config.deviceTtlMs);
    assert.ok(!readFileSync(path,'utf8').includes('renewed'));
    assert.equal(p.authenticate(early.token)?.renewed,undefined);
    // Early has two days left after a day-plus of use since its last renewal, so it is renewed again; late has run out.
    now+=config.deviceTtlMs-2*DAY+1;
    assert.equal(p.authenticate(late.token),undefined);assert.equal(storedExpiry(path,late.device.id),1000+config.deviceTtlMs);
    assert.equal(p.authenticate(early.token)?.renewed,true);const lastUse=now;
    assert.equal(storedExpiry(path,early.device.id),lastUse+config.deviceTtlMs);
    now+=config.deviceTtlMs+1;
    assert.equal(p.authenticate(early.token),undefined);assert.equal(storedExpiry(path,early.device.id),lastUse+config.deviceTtlMs);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('the gate re-sends the device cookie with the full Max-Age when it renewed a device, and not otherwise',async()=>{
  const d=dir();let now=1000;
  const origin='https://renew-town.trycloudflare.com',p=new Pairing(join(d,'devices.json'),config,()=>now);
  const app=Fastify({logger:false});installRemoteAccess(app,p,()=>origin);
  app.get('/api/state',async req=>({readOnly:!isOwner(req)}));await app.ready();
  try{
    const {token}=p.pair(p.create('viewer').code,'Phone'),headers={host:new URL(origin).host,cookie:`__Host-town_device=${token}`};
    now+=2*DAY;
    const renewed=await app.inject({url:'/api/remote-access',headers});
    assert.equal(renewed.statusCode,200);
    assert.equal(renewed.headers['set-cookie'],`__Host-town_device=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.deviceTtlMs/1000}`);
    assert.equal((await app.inject({url:'/api/state',headers})).headers['set-cookie'],undefined);
  }finally{await app.close();rmSync(d,{recursive:true,force:true});}
});

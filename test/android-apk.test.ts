import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {registerAndroidApk} from '../src/android-apk.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const origin='https://town-test.trycloudflare.com';
const apk=Buffer.from('PK\u0003\u0004 test package bytes');

test('serves the APK with the Android package type, and 404 until it is built',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cat-apk-'));
  try{
    const file=join(dir,'Clowder.apk');
    const app=Fastify({logger:false});registerAndroidApk(app,file);
    assert.equal((await app.inject({method:'GET',url:'/app/clowder.apk'})).statusCode,404);
    writeFileSync(file,apk);
    const found=await app.inject({method:'GET',url:'/app/clowder.apk'});
    assert.equal(found.statusCode,200);
    assert.equal(found.headers['content-type'],'application/vnd.android.package-archive');
    assert.deepEqual(found.rawPayload,apk);
    await app.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the remote listener serves the APK to unpaired devices, and the rest of /app/ to paired ones only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cat-apk-remote-'));
  try{
    const file=join(dir,'Clowder.apk');writeFileSync(file,apk);
    const pairing=new Pairing(join(dir,'devices.json'),config);
    const app=Fastify({logger:false});
    installRemoteAccess(app,pairing,()=>origin);
    registerAndroidApk(app,file);
    const headers={host:'town-test.trycloudflare.com'};
    // The APK holds no secrets, so a first install works before pairing.
    const unpaired=await app.inject({method:'GET',url:'/app/clowder.apk',headers});
    assert.equal(unpaired.statusCode,200);assert.deepEqual(unpaired.rawPayload,apk);
    assert.equal((await app.inject({method:'GET',url:'/app/other.js',headers})).statusCode,401);
    const {token}=pairing.pair(pairing.create('viewer').code,'Phone');
    const paired=await app.inject({method:'GET',url:'/app/clowder.apk',headers:{...headers,cookie:`__Host-town_device=${token}`}});
    assert.equal(paired.statusCode,200);
    assert.deepEqual(paired.rawPayload,apk);
    // The static pairing client must stay public: only /app/ and /api/ are gated.
    assert.equal((await app.inject({method:'GET',url:'/app.js',headers})).statusCode,404);
    await app.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

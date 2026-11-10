import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {androidApkPath,registerAndroidApk} from '../src/android-apk.ts';
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

// The tracked APK is what a clean build and a release ship (.gitignore keeps only dist-android/Clowder.apk). A change under android/ that is
// not followed by `npm run android` and a commit of the new APK would ship the old app, as happened between 2026-10-29 and 2026-11-10.
// A shallow or single-commit history gives both paths the same commit, so this holds there by itself.
test('the tracked APK is not older than the newest change under android/',()=>{
  const root=new URL('../',import.meta.url);
  const stamp=(path:string)=>{try{return Number(execFileSync('git',['log','-1','--format=%ct','--',path],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim())||0;}catch{return 0;}};
  const sources=stamp('android'),built=stamp('dist-android/Clowder.apk');
  if(!sources)return; // no git history here (an exported tree)
  assert.ok(existsSync(androidApkPath),'dist-android/Clowder.apk is in the tree');
  assert.ok(built>=sources,'android/ changed after the APK was last committed: run npm run android and commit dist-android/Clowder.apk');
});

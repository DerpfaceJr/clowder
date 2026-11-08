// Plan 5.5: passkey step-up on stable origins. A software authenticator (a real P-256 key, real CBOR) answers the server's WebAuthn
// requests, so every check in src/webauthn.ts runs: RP ID hash, origin, challenge, user verification, signature and counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify,{type FastifyInstance} from 'fastify';
import {createHash,generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {ALLOW_MS,CHALLENGE_MS,NEEDS_ALLOW,NEEDS_STABLE,STEP_UP_COOKIE,STEP_UP_MS,installRemoteAccess,isSteppedUp} from '../src/remote-access.ts';
import {readCbor,verifyAssertion} from '../src/webauthn.ts';

const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const TAILNET='https://pc-name.tail1234.ts.net',QUICK='https://cheap-words-here.trycloudflare.com';
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest();
const b64=(data:Buffer)=>data.toString('base64url');

// The smallest CBOR writer the authenticator needs: unsigned and negative integers, byte and text strings, maps.
function cbor(value:unknown):Buffer{
  const head=(major:number,n:number)=>n<24?Buffer.from([major<<5|n]):n<256?Buffer.from([major<<5|24,n]):Buffer.from([major<<5|25,n>>8,n&255]);
  if(typeof value==='number')return value>=0?head(0,value):head(1,-1-value);
  if(Buffer.isBuffer(value))return Buffer.concat([head(2,value.length),value]);
  if(typeof value==='string'){const text=Buffer.from(value);return Buffer.concat([head(3,text.length),text]);}
  if(value instanceof Map)return Buffer.concat([head(5,value.size),...[...value].flatMap(([k,v])=>[cbor(k),cbor(v)])]);
  throw new Error('unsupported');
}

// A passkey on a phone: one key pair, a counter, and what the browser would put in clientDataJSON.
class Authenticator{
  readonly key:KeyObject;counter=0;flags=0x05;
  private publicKey:Map<number,unknown>;
  constructor(readonly id=Buffer.from('software-passkey-credential-0001')){
    const pair=generateKeyPairSync('ec',{namedCurve:'P-256'});this.key=pair.privateKey;
    const jwk=pair.publicKey.export({format:'jwk'});
    this.publicKey=new Map<number,unknown>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]);
  }
  private authData(rpId:string,attested:boolean){
    const count=Buffer.alloc(4);count.writeUInt32BE(this.counter);
    const parts:Buffer[]=[sha(rpId),Buffer.from([this.flags|(attested?0x40:0)]),count];
    if(attested){const length=Buffer.alloc(2);length.writeUInt16BE(this.id.length);parts.push(Buffer.alloc(16),length,this.id,cbor(this.publicKey));}
    return Buffer.concat(parts);
  }
  private clientData(type:string,challenge:string,origin:string){return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false}));}
  create(options:any,{origin=TAILNET,rpId=options.rp.id as string}={}){
    const attestationObject=cbor(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',this.authData(rpId,true)]]));
    return {id:b64(this.id),rawId:b64(this.id),type:'public-key',response:{clientDataJSON:b64(this.clientData('webauthn.create',options.challenge,origin)),attestationObject:b64(attestationObject)}};
  }
  get(options:any,{origin=TAILNET,rpId=options.rpId as string,counter=true}={}){
    if(counter)this.counter++;
    const authenticatorData=this.authData(rpId,false),clientDataJSON=this.clientData('webauthn.get',options.challenge,origin);
    const signature=sign('sha256',Buffer.concat([authenticatorData,sha(clientDataJSON)]),this.key);
    return {id:b64(this.id),rawId:b64(this.id),type:'public-key',response:{clientDataJSON:b64(clientDataJSON),authenticatorData:b64(authenticatorData),signature:b64(signature)}};
  }
}

// The remote listener with the real gateway and a stand-in for one host-only setting: it answers only isHost (never true here) or a step-up.
async function town({origin=TAILNET,stable=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'step-up-'));
  const clock={now:1_800_000_000_000};
  const pairing=new Pairing(join(dir,'devices.json'),config,()=>clock.now);
  const place={origin,stable};
  const app:FastifyInstance=Fastify({logger:false});
  const remote=installRemoteAccess(app,pairing,()=>place.origin,()=>place.stable,()=>clock.now);
  app.post('/api/real-money/policy',async(req,res)=>isSteppedUp(req)?{ok:true}:res.code(403).send({error:'Real money is managed on the host computer.'}));
  const pair=(permission:'owner'|'viewer',name:string)=>{const invite=pairing.create(permission);const {token,device}=pairing.pair(invite.code,name);return {id:device.id,cookie:`__Host-town_device=${token}`};};
  // The phone's browser: a confirm's step-up cookie goes back with that device's later requests. withJar:false sends only the cookie given.
  const jar=new Map<string,string>();
  const headers=(cookie:string,withJar=true)=>({host:new URL(place.origin).host,origin:place.origin,'x-town-action':'owner','content-type':'application/json',cookie:withJar&&jar.has(cookie)?`${cookie}; ${jar.get(cookie)}`:cookie});
  const post=(cookie:string,url:string,payload:unknown={},withJar=true)=>app.inject({method:'POST',url,headers:headers(cookie,withJar),payload:JSON.stringify(payload)});
  const get=(cookie:string,url:string,withJar=true)=>app.inject({method:'GET',url,headers:headers(cookie,withJar)});
  const settings=async(cookie:string,withJar=true)=>(await post(cookie,'/api/real-money/policy',{},withJar)).statusCode;
  // Adding a passkey as the phone does it, after the host opened the window.
  const enrol=async(cookie:string,auth:Authenticator,how?:{origin?:string;rpId?:string})=>{
    const options=await post(cookie,'/api/step-up/register/options');assert.equal(options.statusCode,200,options.body);
    return post(cookie,'/api/step-up/register',auth.create(options.json(),how));
  };
  const confirm=async(cookie:string,auth:Authenticator,how?:{origin?:string;rpId?:string;counter?:boolean})=>{
    const options=await post(cookie,'/api/step-up/options');assert.equal(options.statusCode,200,options.body);
    const r=await post(cookie,'/api/step-up',auth.get(options.json(),how));
    const set=[r.headers['set-cookie']??[]].flat().find(c=>c.startsWith(STEP_UP_COOKIE+'='));
    if(set)jar.set(cookie,set.split(';')[0]!);
    return r;
  };
  return {dir,clock,pairing,place,app,remote,pair,post,get,settings,enrol,confirm};
}

test('the option is hidden on a Quick Tunnel, and every passkey route refuses there',async()=>{
  const t=await town({origin:QUICK,stable:false});
  try{
    const owner=t.pair('owner','Phone');
    assert.deepEqual((await t.get(owner.cookie,'/api/step-up')).json(),{available:false});
    t.remote.stepUp.allow(owner.id);
    for(const url of ['/api/step-up/register/options','/api/step-up/options']){
      const r=await t.post(owner.cookie,url);assert.equal(r.statusCode,409);assert.equal(r.json().error,NEEDS_STABLE);
    }
    const r=await t.post(owner.cookie,'/api/step-up',{id:'x',type:'public-key',response:{}});assert.equal(r.statusCode,409);
    assert.equal(await t.settings(owner.cookie),403);
    // A passkey made while Tailscale was on gives nothing once the town is back on a Quick Tunnel.
    t.place.origin=TAILNET;t.place.stable=true;
    const auth=new Authenticator();
    assert.equal((await t.enrol(owner.cookie,auth)).statusCode,200);
    assert.equal((await t.confirm(owner.cookie,auth)).statusCode,200);
    assert.equal(await t.settings(owner.cookie),200);
    t.place.origin=QUICK;t.place.stable=false;
    assert.equal(await t.settings(owner.cookie),403,'a fresh step-up does not carry over to a Quick Tunnel');
    assert.deepEqual((await t.get(owner.cookie,'/api/step-up')).json(),{available:false});
  }finally{await t.app.close();}
});

test('adding a passkey needs the host to allow it for that owner device, within a few minutes',async()=>{
  const t=await town();
  try{
    const owner=t.pair('owner','Phone'),viewer=t.pair('viewer','Tablet');
    assert.deepEqual((await t.get(owner.cookie,'/api/step-up')).json(),{available:true,passkey:false,canAdd:false,until:null,minutes:STEP_UP_MS/60_000});
    assert.deepEqual((await t.get(viewer.cookie,'/api/step-up')).json(),{available:false});
    const early=await t.post(owner.cookie,'/api/step-up/register/options');
    assert.equal(early.statusCode,409);assert.equal(early.json().error,NEEDS_ALLOW);
    assert.throws(()=>t.remote.stepUp.allow(viewer.id),/control/);
    assert.equal((await t.post(viewer.cookie,'/api/step-up/register/options')).statusCode,403,'the gateway refuses a viewer\'s write');
    t.remote.stepUp.allow(owner.id);
    assert.equal((await t.get(owner.cookie,'/api/step-up')).json().canAdd,true);
    t.clock.now+=ALLOW_MS+1;
    assert.equal((await t.post(owner.cookie,'/api/step-up/register/options')).statusCode,409,'the window closes by itself');
    t.remote.stepUp.allow(owner.id);
    const auth=new Authenticator();
    assert.equal((await t.enrol(owner.cookie,auth)).statusCode,200);
    const saved=JSON.parse(readFileSync(join(t.dir,'devices.json'),'utf8')).find((d:{id:string})=>d.id===owner.id).passkey;
    assert.deepEqual([saved.rpId,saved.alg,saved.id,saved.jwk.kty],['pc-name.tail1234.ts.net',-7,b64(auth.id),'EC']);
    assert.ok(!('d' in saved.jwk),'only the public key is kept');
    assert.deepEqual(t.pairing.list().find(d=>d.id===owner.id)?.passkey,{rpId:'pc-name.tail1234.ts.net',createdAt:t.clock.now},'Devices lists where it works, not the key');
    assert.equal((await t.post(owner.cookie,'/api/step-up/register/options')).statusCode,409,'the window closes once a passkey is added');
    // The saved record loads again.
    assert.equal(new Pairing(join(t.dir,'devices.json'),config,()=>t.clock.now).passkey(owner.id)?.id,b64(auth.id));
  }finally{await t.app.close();}
});

test('a wrong RP ID is refused, when adding a passkey and when confirming with one',async()=>{
  const t=await town();
  try{
    const owner=t.pair('owner','Phone'),auth=new Authenticator();
    t.remote.stepUp.allow(owner.id);
    const wrongRp=await t.enrol(owner.cookie,auth,{rpId:'tail1234.ts.net'});
    assert.equal(wrongRp.statusCode,400);assert.equal(wrongRp.json().error,'This passkey belongs to another address.');
    const wrongOrigin=await t.enrol(owner.cookie,auth,{origin:'https://evil.example'});
    assert.equal(wrongOrigin.statusCode,400);assert.equal(wrongOrigin.json().error,'The passkey answer came from another address.');
    assert.equal(t.pairing.passkey(owner.id),undefined,'nothing was saved');
    assert.equal((await t.enrol(owner.cookie,auth)).statusCode,200);
    const badRp=await t.confirm(owner.cookie,auth,{rpId:'evil.example'});
    assert.equal(badRp.statusCode,400);assert.equal(badRp.json().error,'This passkey belongs to another address.');
    const badOrigin=await t.confirm(owner.cookie,auth,{origin:'https://pc-name.tail1234.ts.net.evil.example'});
    assert.equal(badOrigin.statusCode,400);
    assert.equal(await t.settings(owner.cookie),403,'no step-up after refused answers');
    // A passkey made for one tailnet name is not offered on another one.
    t.place.origin='https://other-pc.tail1234.ts.net';
    assert.equal((await t.post(owner.cookie,'/api/step-up/options')).statusCode,409);
    assert.equal((await t.get(owner.cookie,'/api/step-up')).json().passkey,false);
  }finally{await t.app.close();}
});

test('host-only routes still refuse an owner device without a fresh step-up, and open for a few minutes after one',async()=>{
  const t=await town();
  try{
    const owner=t.pair('owner','Phone'),other=t.pair('owner','Second phone'),auth=new Authenticator();
    assert.equal(await t.settings(owner.cookie),403,'paired with control is not enough');
    t.remote.stepUp.allow(owner.id);
    assert.equal((await t.enrol(owner.cookie,auth)).statusCode,200);
    assert.equal(await t.settings(owner.cookie),403,'adding a passkey is not a step-up');
    const ok=await t.confirm(owner.cookie,auth);
    assert.equal(ok.statusCode,200,ok.body);assert.deepEqual(ok.json(),{until:t.clock.now+STEP_UP_MS,minutes:5});
    const set=[ok.headers['set-cookie']??[]].flat().find(c=>c.startsWith(STEP_UP_COOKIE+'='))??'';
    assert.match(set,/^__Host-town_stepup=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=300$/,'a 32-byte step-up cookie, host-only, for five minutes');
    assert.equal(await t.settings(owner.cookie),200);
    assert.equal(await t.settings(other.cookie),403,'the step-up belongs to the device that made it');
    assert.equal((await t.get(owner.cookie,'/api/step-up')).json().until,t.clock.now+STEP_UP_MS);
    t.clock.now+=STEP_UP_MS;
    assert.equal(await t.settings(owner.cookie),403,'stale after five minutes');
    // Each answer works once: a replay of a good answer is refused.
    const options=await t.post(owner.cookie,'/api/step-up/options');
    const answer=auth.get(options.json());
    assert.equal((await t.post(owner.cookie,'/api/step-up',answer)).statusCode,200);
    const replay=await t.post(owner.cookie,'/api/step-up',answer);
    assert.equal(replay.statusCode,400);assert.equal(replay.json().error,'That passkey request expired. Try again.');
    // An answer to an expired challenge, and one whose counter went back, are refused.
    t.clock.now+=STEP_UP_MS;
    const late=await t.post(owner.cookie,'/api/step-up/options');t.clock.now+=CHALLENGE_MS+1;
    assert.equal((await t.post(owner.cookie,'/api/step-up',auth.get(late.json()))).statusCode,400);
    auth.counter=0;
    const copied=await t.confirm(owner.cookie,auth,{counter:false});
    assert.equal(copied.statusCode,400);assert.match(copied.json().error,/counter went back/);
    assert.equal(await t.settings(owner.cookie),403);
    // Without user verification (the phone was not unlocked) there is no step-up.
    auth.counter=10;auth.flags=0x01;
    const unverified=await t.confirm(owner.cookie,auth);
    assert.equal(unverified.statusCode,400);assert.match(unverified.json().error,/did not confirm it was you/);
    assert.equal(await t.settings(owner.cookie),403);
    // Removing the passkey on the host, or revoking the device, ends a step-up at once.
    auth.flags=0x05;
    assert.equal((await t.confirm(owner.cookie,auth)).statusCode,200);assert.equal(await t.settings(owner.cookie),200);
    t.remote.stepUp.remove(owner.id);
    assert.equal(await t.settings(owner.cookie),403);
    assert.equal((await t.post(owner.cookie,'/api/step-up/options')).statusCode,409);
    t.remote.stepUp.allow(owner.id);assert.equal((await t.enrol(owner.cookie,auth)).statusCode,200);
    assert.equal((await t.confirm(owner.cookie,auth)).statusCode,200);assert.equal(await t.settings(owner.cookie),200);
    t.pairing.revoke(owner.id);
    assert.equal(await t.settings(owner.cookie),401);
  }finally{await t.app.close();}
});

test('the step-up window opens only with its own cookie: a copy of the device cookie alone, or a wrong cookie, is refused',async()=>{
  const t=await town();
  try{
    const owner=t.pair('owner','Phone'),auth=new Authenticator();
    t.remote.stepUp.allow(owner.id);
    assert.equal((await t.enrol(owner.cookie,auth)).statusCode,200);
    assert.equal((await t.confirm(owner.cookie,auth)).statusCode,200);
    assert.equal(await t.settings(owner.cookie,false),403,'the same device without the step-up cookie, inside the window');
    assert.equal((await t.get(owner.cookie,'/api/step-up',false)).json().until,null,'and it does not see the window either');
    assert.equal(await t.settings(owner.cookie),200,'with the step-up cookie');
    assert.equal((await t.get(owner.cookie,'/api/step-up')).json().until,t.clock.now+STEP_UP_MS);
    const wrong=`${owner.cookie}; ${STEP_UP_COOKIE}=${'A'.repeat(43)}`;
    assert.equal(await t.settings(wrong,false),403,'a wrong step-up cookie');
    assert.equal((await t.get(wrong,'/api/step-up',false)).json().until,null);
    t.clock.now+=STEP_UP_MS;
    assert.equal(await t.settings(owner.cookie),403,'the right cookie after the window ends');
    assert.equal((await t.get(owner.cookie,'/api/step-up')).json().until,null);
  }finally{await t.app.close();}
});

test('a passkey whose key id is under 16 or over 1023 bytes is refused, and a bad saved passkey is dropped on load instead of stopping Clowder',async()=>{
  const t=await town();
  try{
    const owner=t.pair('owner','Phone'),second=t.pair('owner','Second phone'),viewer=t.pair('viewer','Tablet');
    t.remote.stepUp.allow(owner.id);
    for(const id of [Buffer.alloc(15,1),Buffer.alloc(1024,2)]){
      const r=await t.enrol(owner.cookie,new Authenticator(id));
      assert.equal(r.statusCode,400,r.body);assert.match(r.json().error,/key id of the wrong length/);
      assert.equal(t.pairing.passkey(owner.id),undefined,'nothing was saved');
    }
    assert.equal((await t.enrol(owner.cookie,new Authenticator(Buffer.alloc(16,3)))).statusCode,200,'16 bytes is enough');
    // A store written before this check (or edited by hand): a short id on one owner and a passkey on a viewer.
    const file=join(t.dir,'devices.json'),saved=JSON.parse(readFileSync(file,'utf8'));
    const good=saved.find((d:{id:string})=>d.id===owner.id).passkey;
    saved.find((d:{id:string})=>d.id===second.id).passkey={...good,id:'c2hvcnQ'};
    saved.find((d:{id:string})=>d.id===viewer.id).passkey=good;
    writeFileSync(file,JSON.stringify(saved));
    const loaded=new Pairing(file,config,()=>t.clock.now);
    assert.equal(loaded.passkey(owner.id)?.id,good.id,'a good passkey stays');
    assert.equal(loaded.passkey(second.id),undefined,'a bad one is dropped');
    assert.equal(loaded.passkey(viewer.id),undefined,'a viewer never keeps one');
    assert.deepEqual(loaded.list().map(d=>d.id).sort(),[owner.id,second.id,viewer.id].sort(),'every device stays paired');
    const rewritten=JSON.parse(readFileSync(file,'utf8'));
    assert.deepEqual(rewritten.map((d:{passkey?:unknown})=>!!d.passkey),saved.map((d:{id:string})=>d.id===owner.id),'the drop is saved, so the next start loads clean');
    // Everything else in the store is checked as before.
    writeFileSync(file,JSON.stringify([{...rewritten[0],tokenHash:'not-a-hash'}]));
    assert.throws(()=>new Pairing(file,config,()=>t.clock.now),/Invalid paired-device store/);
  }finally{await t.app.close();}
});

test('the verifier refuses a signature from another key, an answer for another passkey, and CBOR that lies about its length',()=>{
  const auth=new Authenticator(),stranger=new Authenticator();
  const jwk=auth.key.export({format:'jwk'});
  const passkey={id:b64(auth.id),jwk:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},alg:-7,rpId:'pc-name.tail1234.ts.net',signCount:0,createdAt:0};
  const expected={challenge:'c2FtZS1jaGFsbGVuZ2U',origin:TAILNET,rpId:'pc-name.tail1234.ts.net'};
  assert.equal(verifyAssertion(auth.get({challenge:expected.challenge,rpId:expected.rpId}),passkey,expected),1);
  const forged=stranger.get({challenge:expected.challenge,rpId:expected.rpId});
  assert.throws(()=>verifyAssertion(forged,passkey,expected),/signature does not match/);
  assert.throws(()=>verifyAssertion({...forged,id:'another-credential-id'},passkey,expected),/not this phone's passkey/);
  assert.throws(()=>verifyAssertion(auth.get({challenge:'b3RoZXI',rpId:expected.rpId}),passkey,expected),/another request/);
  assert.throws(()=>readCbor(Buffer.from([0x5a,0xff,0xff,0xff,0xff,0x00])),/cut short/);
  assert.throws(()=>readCbor(Buffer.from([0x9b,0,0,0,0,0xff,0xff,0xff,0xff])),/cut short/);
  assert.deepEqual(readCbor(cbor(new Map<unknown,unknown>([[1,2],[-2,Buffer.from([7])],['fmt','none']]))).value,new Map<unknown,unknown>([[1,2],[-2,Buffer.from([7])],['fmt','none']]));
});

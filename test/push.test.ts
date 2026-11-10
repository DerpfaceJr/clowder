import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv,createECDH,createPublicKey,hkdfSync,randomBytes,verify} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess,isOwner} from '../src/access.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {ListNotices} from '../src/chat-channel.ts';
import {PushService,RateLimiter,buildPayload,clean,encryptPayload,pushEndpointAllowed,registerPushRoutes,vapidAuthorization,verifyVapidSignature,type Sender} from '../src/push.ts';

const remoteConfig:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const b64u=(buf:Buffer)=>buf.toString('base64url');
const dir=()=>mkdtempSync(join(tmpdir(),'clowder-push-'));

// RFC 8291 Appendix A, copied from the RFC text (whitespace removed).
const RFC={
  plaintext:'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate:'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt:'DGv6ra1nlYgDCS1FRnbzlw',
  auth:'BTBZMqHH6r4Tts7J_aSIgg',
  header:'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext:'8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

// The receiving side of RFC 8291, used to read back what the server sent.
function decrypt(body:Buffer,uaPrivate:Buffer,auth:Buffer){
  const idLength=body[20],asPublic=body.subarray(21,21+idLength),sealed=body.subarray(21+idLength);
  const ua=createECDH('prime256v1');ua.setPrivateKey(uaPrivate);
  const uaPublic=ua.getPublicKey(undefined,'uncompressed');
  const ikm=Buffer.from(hkdfSync('sha256',ua.computeSecret(asPublic),auth,Buffer.concat([Buffer.from('WebPush: info\0'),uaPublic,asPublic]),32));
  const salt=body.subarray(0,16);
  const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
  const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
  const decipher=createDecipheriv('aes-128-gcm',cek,nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length-16));
  const plain=Buffer.concat([decipher.update(sealed.subarray(0,sealed.length-16)),decipher.final()]);
  let end=plain.length-1;while(plain[end]===0)end--;
  assert.equal(plain[end],2,'last-record delimiter');
  return plain.subarray(0,end);
}

function clientKeys(){
  const ua=createECDH('prime256v1');ua.generateKeys();
  return {ua,p256dh:b64u(ua.getPublicKey(undefined,'uncompressed')),auth:b64u(randomBytes(16))};
}

const okSender=(calls:{endpoint:string;headers:Record<string,string>;body:Buffer}[],status=201):Sender=>async(endpoint,headers,body)=>{calls.push({endpoint,headers,body});return status;};
async function settle(){for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));}

test('RFC 8291 Appendix A: the encrypted body matches the RFC byte for byte',()=>{
  const body=encryptPayload({p256dh:RFC.uaPublic,auth:RFC.auth},Buffer.from(RFC.plaintext,'base64url'),{salt:Buffer.from(RFC.salt,'base64url'),asPrivateKey:Buffer.from(RFC.asPrivate,'base64url')});
  const expected=Buffer.concat([Buffer.from(RFC.header,'base64url'),Buffer.from(RFC.ciphertext,'base64url')]);
  assert.equal(body.toString('hex'),expected.toString('hex'));
  assert.equal(decrypt(body,Buffer.from(RFC.uaPrivate,'base64url'),Buffer.from(RFC.auth,'base64url')).toString(),'When I grow up, I want to be a watermelon');
});

test('VAPID authorization is a valid ES256 JWT with a raw signature, the right audience and a short life',()=>{
  const pair=createECDH('prime256v1');pair.generateKeys();
  const vapid={publicKey:b64u(pair.getPublicKey(undefined,'uncompressed')),privateKey:b64u(pair.getPrivateKey())};
  const now=1_800_000_000;
  const endpoint='https://fcm.googleapis.com/fcm/send/abc';
  const header=vapidAuthorization(endpoint,vapid,now);
  const match=header.match(/^vapid t=([^,]+), k=(\S+)$/);
  assert.ok(match,'header shape');
  assert.equal(match![2],vapid.publicKey);
  const [h,c,s]=match![1].split('.');
  assert.equal(JSON.parse(Buffer.from(h,'base64url').toString()).alg,'ES256');
  const claims=JSON.parse(Buffer.from(c,'base64url').toString());
  assert.equal(claims.aud,'https://fcm.googleapis.com');
  assert.ok(claims.exp-now>0&&claims.exp-now<24*3600);
  assert.equal(Buffer.from(s,'base64url').length,64,'raw r||s signature');
  assert.equal(verifyVapidSignature(match![1],vapid.publicKey),true);
  const other=createECDH('prime256v1');other.generateKeys();
  assert.equal(verifyVapidSignature(match![1],b64u(other.getPublicKey(undefined,'uncompressed'))),false);
  const pub=createPublicKey({key:{kty:'EC',crv:'P-256',x:b64u(Buffer.from(vapid.publicKey,'base64url').subarray(1,33)),y:b64u(Buffer.from(vapid.publicKey,'base64url').subarray(33,65))},format:'jwk'});
  assert.equal(verify('sha256',Buffer.from(`${h}.${c}`),{key:pub,dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')),true);
});

test('only https endpoints on the browser push services are accepted',()=>{
  for(const ok of ['https://fcm.googleapis.com/fcm/send/x','https://updates.push.services.mozilla.com/wpush/v2/x','https://web.push.apple.com/x','https://wns2-pn1p.notify.windows.com/w/?x=1'])assert.equal(pushEndpointAllowed(ok),true,ok);
  for(const bad of ['http://fcm.googleapis.com/x','https://evil.example/x','https://fcm.googleapis.com.evil.example/x','https://user:pw@fcm.googleapis.com/x','https://127.0.0.1:9/x','not a url',`https://fcm.googleapis.com/${'a'.repeat(3000)}`])assert.equal(pushEndpointAllowed(bad),false,bad);
});

test('payloads truncate by code point, drop control and bidi characters and neutralise markup',()=>{
  assert.equal(Array.from(clean('😺'.repeat(10),4)).length,4);
  assert.equal(clean('😺'.repeat(10),4),'😺😺😺…');
  assert.equal(clean('a‮b\nc\u0000d<script>',100),'a b c d‹script›');
  const long=buildPayload({title:'T'.repeat(200),body:'x'.repeat(500),url:'/chat',tag:'approval-a1 b/2'});
  assert.equal(Array.from(long.title).length,80);
  assert.equal(Array.from(long.body).length,240);
  assert.equal(long.tag,'approval-a1_b_2');
  assert.equal(buildPayload({title:'t',body:'b',url:'//evil.example',tag:'x'}).url,'/');
  assert.equal(buildPayload({title:'t',body:'b',url:'https://evil.example',tag:'x'}).url,'/');
  assert.equal(buildPayload({title:'t',body:'b',tag:'x'},3).body,'b (+3 more)');
});

test('the rate limiter sends at once, then at most one per window, coalescing the rest',()=>{
  let now=0;const timers:{at:number;fn:()=>void}[]=[];const sent:[string,string,number][]=[];
  const limiter=new RateLimiter<string>(30_000,(kind,item,more)=>sent.push([kind,item,more]),()=>now,(fn,ms)=>{timers.push({at:now+ms,fn});return timers.length;},()=>{});
  assert.equal(limiter.submit('approvals','first'),'sent');
  assert.equal(limiter.submit('approvals','second'),'queued');
  assert.equal(limiter.submit('approvals','third'),'queued');
  assert.equal(limiter.submit('mayor','other kind is independent'),'sent');
  assert.equal(timers.length,1,'one timer per kind');
  assert.equal(timers[0].at,30_000);
  now=30_000;timers[0].fn();
  assert.deepEqual(sent,[['approvals','first',0],['mayor','other kind is independent',0],['approvals','third',1]]);
  assert.equal(limiter.submit('approvals','fourth'),'queued','window restarts after the flush');
  assert.equal(timers.at(-1)!.at,60_000);
});

test('the VAPID key is created once, is reused on restart and is never written to a route',async()=>{
  const data=dir();
  try{
    const first=new PushService({dataDir:data,send:okSender([])});
    const file=join(data,'vapid.json');const before=statSync(file).mtimeMs;const key=first.publicKey();
    const privateKey=JSON.parse(readFileSync(file,'utf8')).privateKey as string;
    const second=new PushService({dataDir:data,send:okSender([])});
    assert.equal(second.publicKey(),key);
    assert.equal(statSync(file).mtimeMs,before);
    const app=Fastify();installAccess(app,false,[],8961,undefined,undefined,'test-owner');registerPushRoutes(app,{service:second,allowed:isOwner});
    await app.ready();
    const res=await app.inject({url:'/api/push/config',headers:{host:'localhost:8961',cookie:'town_owner_8961=test-owner'}});
    assert.equal(res.statusCode,200);
    assert.equal(res.json().publicKey,key);
    assert.equal(res.body.includes(privateKey),false);
    const bad=await app.inject({method:'POST',url:'/api/push/subscribe',headers:{host:'localhost:8961',cookie:'town_owner_8961=test-owner','x-town-action':'owner'},payload:{endpoint:'https://evil.example/x',keys:{p256dh:'AA',auth:'AA'}}});
    assert.equal(bad.statusCode,400);
    assert.equal(bad.body.includes(privateKey),false);
    await app.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('subscriptions persist across restarts and can be removed',()=>{
  const data=dir();
  try{
    const keys=clientKeys();const endpoint='https://fcm.googleapis.com/fcm/send/device-1';
    const service=new PushService({dataDir:data,send:okSender([])});
    assert.deepEqual(service.subscribe({endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth},kinds:{mayor:false}}).kinds,{approvals:true,mayor:false,seasons:true,routines:true,problems:true});
    assert.equal(new PushService({dataDir:data,send:okSender([])}).count(),1);
    const again=new PushService({dataDir:data,send:okSender([])});
    assert.equal(again.unsubscribe(endpoint),true);
    assert.equal(new PushService({dataDir:data,send:okSender([])}).count(),0);
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('server.ts: both listeners save a subscription under the device that made it, so revoking a Same Wi-Fi owner phone drops it',()=>{
  const src=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  assert.ok(src.includes('registerPushRoutes(app,{service:push,allowed:isOwner,device:access.device})'),'the main listener, which Same Wi-Fi devices use');
  assert.ok(src.includes('registerPushRoutes(remoteApp,{service:push,allowed:isOwner,device:remoteAccess.device})'),'the tunnel listener');
});

test('owner-only on the main app, paired owner device on the remote app, 403 otherwise',async()=>{
  const data=dir();
  try{
    const service=new PushService({dataDir:data,send:okSender([])});
    const keys=clientKeys();
    const payload={endpoint:'https://fcm.googleapis.com/fcm/send/main',keys:{p256dh:keys.p256dh,auth:keys.auth}};
    const app=Fastify();installAccess(app,true,['192.168.1.20'],8961,undefined,undefined,'test-owner');registerPushRoutes(app,{service,allowed:isOwner});
    await app.ready();
    const owner={host:'localhost:8961',cookie:'town_owner_8961=test-owner','x-town-action':'owner'};
    assert.equal((await app.inject({method:'POST',url:'/api/push/subscribe',headers:owner,payload})).statusCode,200);
    assert.equal((await app.inject({url:'/api/push/config',headers:owner})).statusCode,200);
    const lan={host:'192.168.1.20:8961'};
    assert.notEqual((await app.inject({method:'POST',url:'/api/push/subscribe',remoteAddress:'192.168.1.21',headers:lan,payload:{...payload,endpoint:'https://fcm.googleapis.com/fcm/send/lan'}})).statusCode,200);
    assert.notEqual((await app.inject({url:'/api/push/config',remoteAddress:'192.168.1.21',headers:lan})).statusCode,200);
    assert.equal(service.count(),1);
    await app.close();

    const pairing=new Pairing(join(data,'devices.json'),remoteConfig);
    const remote=Fastify();const access=installRemoteAccess(remote,pairing,()=>'https://remote.example');
    registerPushRoutes(remote,{service,allowed:isOwner,device:access.device});
    await remote.ready();
    const control=pairing.create('owner');const controlToken=pairing.pair(control.code,'phone').token;
    const view=pairing.create('viewer');const viewToken=pairing.pair(view.code,'tablet').token;
    const remoteHeaders=(token:string)=>({host:'remote.example',origin:'https://remote.example','x-town-action':'owner',cookie:`__Host-town_device=${token}`});
    const phoneKeys=clientKeys();
    const phone={endpoint:'https://web.push.apple.com/phone-1',keys:{p256dh:phoneKeys.p256dh,auth:phoneKeys.auth}};
    assert.equal((await remote.inject({method:'POST',url:'/api/push/subscribe',headers:remoteHeaders(viewToken),payload:phone})).statusCode,403);
    assert.equal((await remote.inject({method:'POST',url:'/api/push/subscribe',headers:{host:'remote.example',origin:'https://remote.example','x-town-action':'owner'},payload:phone})).statusCode,401);
    assert.equal((await remote.inject({url:'/api/push/config',headers:remoteHeaders(viewToken)})).statusCode,403);
    assert.equal((await remote.inject({method:'POST',url:'/api/push/subscribe',headers:remoteHeaders(controlToken),payload:phone})).statusCode,200);
    assert.equal(service.count(),2);
    assert.equal((await remote.inject({method:'POST',url:'/api/push/unsubscribe',headers:remoteHeaders(viewToken),payload:{endpoint:phone.endpoint}})).statusCode,403);
    assert.equal((await remote.inject({method:'POST',url:'/api/push/unsubscribe',headers:remoteHeaders(controlToken),payload:{endpoint:phone.endpoint}})).statusCode,200);
    assert.equal(service.count(),1);
    await remote.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('a control-less predicate denies every push route',async()=>{
  const data=dir();
  try{
    const app=Fastify();registerPushRoutes(app,{service:new PushService({dataDir:data,send:okSender([])}),allowed:()=>false});
    await app.ready();
    assert.equal((await app.inject({url:'/api/push/config'})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/push/unsubscribe',payload:{endpoint:'x'}})).statusCode,403);
    await app.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('store events become encrypted pushes for the subscribed kinds only, and a gone subscription is dropped',async()=>{
  const data=dir();
  try{
    const calls:{endpoint:string;headers:Record<string,string>;body:Buffer}[]=[];
    let now=1_000_000;
    const service=new PushService({dataDir:data,send:okSender(calls,201),now:()=>now,windowMs:30_000,later:()=>undefined});
    const keys=clientKeys();
    service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/a',keys:{p256dh:keys.p256dh,auth:keys.auth},kinds:{approvals:true,mayor:false,seasons:true}});
    const store={state:quietState({cats:[{id:'mira',name:'Mira'}]}) as any,listeners:new Set<()=>void>()};
    service.attach(store);
    // A decision is listed by quests() from state.approvals; the event only says the store changed (11.10).
    const emit=(e:{id:string;type:string;data:any},approval?:Record<string,unknown>)=>{store.state.events.push(e);if(approval)store.state.approvals.push(approval);for(const l of store.listeners)l();};
    emit({id:'e1',type:'approval.requested',data:{id:'a1',cat:'mira',question:'Shall I plant the north field?',status:'pending'}},{id:'a1',cat:'mira',question:'Shall I plant the north field?',status:'pending'});
    await settle();
    assert.equal(calls.length,1);
    const text=JSON.parse(decrypt(calls[0].body,keys.ua.getPrivateKey(),Buffer.from(keys.auth,'base64url')).toString());
    assert.deepEqual(text,{title:'Clowder',body:'Needs you: Shall I plant the north field',url:'/#item=approval%3Aa1',tag:'item-approval:a1'});
    assert.match(calls[0].headers.Authorization,/^vapid t=/);
    emit({id:'e2',type:'message',data:{from:'mayor',to:'owner',text:'Hello'}});
    await settle();
    assert.equal(calls.length,1,'mayor kind is switched off for this subscription');
    now+=5_000;
    emit({id:'e3',type:'approval.requested',data:{id:'a2',cat:'mira',question:'Second',status:'pending'}},{id:'a2',cat:'mira',question:'Second',status:'pending'});
    await settle();
    assert.equal(calls.length,1,'inside the window the second approval is held');
    now+=25_000;
    emit({id:'e4',type:'message',data:{from:'owner',to:'mayor',text:'not a push'}});
    await settle();
    assert.equal(calls.length,1);
    service.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('a 410 from the push service removes that subscription',async()=>{
  const data=dir();
  try{
    const service=new PushService({dataDir:data,send:okSender([],410),later:()=>undefined});
    const keys=clientKeys();
    service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/gone',keys:{p256dh:keys.p256dh,auth:keys.auth}});
    service.notify('test',{title:'t',body:'b',tag:'x'});
    await settle();
    assert.equal(service.count(),0);
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('season completion pushes once, and existing finished seasons are not announced at start',async()=>{
  const data=dir();
  try{
    const calls:{endpoint:string;headers:Record<string,string>;body:Buffer}[]=[];
    const service=new PushService({dataDir:data,send:okSender(calls),later:()=>undefined});
    const keys=clientKeys();
    service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/s',keys:{p256dh:keys.p256dh,auth:keys.auth}});
    let seasons=[{name:'s1',status:'finished'},{name:'s2',status:'running'}];
    service.checkSeasons(()=>seasons);
    await settle();
    assert.equal(calls.length,0,'baseline is silent');
    seasons=[{name:'s1',status:'finished'},{name:'s2',status:'finished'}];
    service.checkSeasons(()=>seasons);
    await settle();
    assert.equal(calls.length,1);
    service.checkSeasons(()=>seasons);
    await settle();
    assert.equal(calls.length,1,'announced once');
    service.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

// 11.10: notices come from the Needs-you list (quests()), not from events. Fixtures are plain states; the ids are the list's own.
const quietState=(extra:Record<string,unknown>={})=>({events:[],cats:[{id:'mabel',name:'Mabel'}],retiredCats:[],approvals:[],goals:[],councils:[],ownerSteps:[],hiddenQuests:{},handoffs:{},...extra});
const approvalOf=(id:string,over:Record<string,unknown>={})=>({id,cat:'mabel',status:'pending',question:`Question ${id}?`,gate:'connector',effectClass:'read',options:['Allow once','Deny'],task:'t1',...over});
const failedProject={id:'p1',title:'Launch post',status:'failed',counts:{failed:1,tasks:2},updatedAt:'2026-11-09T10:00:00.000Z'};
const pendingPurchase={id:'buy1',vendor:'Fishmonger',status:'pending',reason:'Fish for the Mayor',requestedAt:'2026-11-09T09:00:00.000Z',amountMinor:4000,currency:'USD',url:'https://fish.example/cart'};
const openStep={id:'os1',title:'Connect GitHub',steps:'Sign in',at:'2026-11-09T08:00:00.000Z',status:'open',blocking:true};
const extraInput={projects:[failedProject],purchases:[pendingPurchase],capabilities:[],seasons:[],models:null};

test('11.10 parity: the announced ids are the needsYou ids, plus trouble under Problems, each once, every url /#item=<id>',async()=>{
  const data=dir();
  try{
    const calls:{endpoint:string;headers:Record<string,string>;body:Buffer}[]=[];
    const service=new PushService({dataDir:data,send:okSender(calls),windowMs:0,questInput:state=>({...extraInput,state,now:new Date('2026-11-09T12:00:00Z')}) as any});
    const a=clientKeys(),b=clientKeys();
    service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/a',keys:{p256dh:a.p256dh,auth:a.auth}});
    service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/b',keys:{p256dh:b.p256dh,auth:b.auth},kinds:{problems:false}});
    const state=quietState({approvals:[approvalOf('a1'),approvalOf('a2',{gate:'effect',options:undefined}),approvalOf('g1',{gate:'goal-removal'})],ownerSteps:[openStep]});
    service.onStore({state:state as any,listeners:new Set()});
    await settle();
    const read=(keys:typeof a,call:typeof calls[number])=>JSON.parse(decrypt(call.body,keys.ua.getPrivateKey()!,Buffer.from(keys.auth,'base64url')).toString());
    const toA=calls.filter(c=>c.endpoint.endsWith('/a')).map(c=>read(a,c));
    const toB=calls.filter(c=>c.endpoint.endsWith('/b')).map(c=>read(b,c));
    const ids=(ps:{url:string}[])=>ps.map(p=>decodeURIComponent(p.url.slice('/#item='.length)));
    assert.deepEqual(ids(toA).sort(),['approval:a1','approval:a2','owner-step:os1','project:p1','purchase:buy1'].sort());
    assert.deepEqual(ids(toB).sort(),['approval:a1','approval:a2','owner-step:os1','purchase:buy1'].sort(),'a Problems-off device gets no trouble item');
    assert.ok(toA.every(p=>/^\/#item=/.test(p.url)));
    assert.equal(toA.find(p=>p.url.includes('buy1'))!.actions,undefined,'a pending purchase has no buttons');
    assert.equal(toA.find(p=>p.url.includes('a1'))!.actions?.length,2,'a connector read decision keeps its two buttons');
    assert.match(toA.find(p=>p.url.includes('p1'))!.body,/^Your request 'Launch post' failed: 1 of 2 tasks failed\. Retry\?$/);
    service.onStore({state:state as any,listeners:new Set()});
    await settle();
    assert.equal(calls.length,9,'a second look at the same list announces nothing');
    service.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('11.10: an id that leaves the list and comes back is announced again; a goal-removal suggestion never is',async()=>{
  const data=dir();
  try{
    const calls:{endpoint:string;headers:Record<string,string>;body:Buffer}[]=[];
    const service=new PushService({dataDir:data,send:okSender(calls),windowMs:0,questInput:state=>({projects:[],purchases:[],capabilities:[],seasons:[],models:null,state,now:new Date('2026-11-09T12:00:00Z')}) as any});
    const keys=clientKeys();
    service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/c',keys:{p256dh:keys.p256dh,auth:keys.auth}});
    const pending=quietState({approvals:[approvalOf('a1'),approvalOf('g1',{gate:'goal-removal'})]});
    // No project or purchase here: only the decision is on the list.
    service.onStore({state:pending as any,listeners:new Set()});
    await settle();
    const first=calls.length;
    assert.equal(first,1,'a1 only: the goal-removal suggestion is not listed');
    service.onStore({state:quietState({approvals:[approvalOf('a1',{status:'approved'})]}) as any,listeners:new Set()});
    await settle();
    assert.equal(calls.length,first,'a1 leaving the list sends nothing');
    service.onStore({state:pending as any,listeners:new Set()});
    await settle();
    assert.equal(calls.length,first+1,'a1 back on the list is announced again');
    service.close();
  }finally{rmSync(data,{recursive:true,force:true});}
});

test('11.10 chat channels: ListNotices announces the same ids once each, with the link when a remote address exists',()=>{
  const state=quietState({approvals:[approvalOf('a1'),approvalOf('g1',{gate:'goal-removal'})]});
  const notices=new ListNotices(()=>'https://remote.example');
  const first=notices.fresh(state as any);
  assert.equal(first.length,1,'the goal-removal suggestion is not announced');
  assert.equal(first[0]!.text,'Needs you: Question a1\n\nhttps://remote.example/#item=approval%3Aa1');
  assert.deepEqual(first[0]!.buttons.map(b=>b.label),['Allow once','Deny']);
  assert.deepEqual(notices.fresh(state as any),[],'a second look announces nothing');
  notices.fresh(quietState({approvals:[approvalOf('a1',{status:'approved'})]}) as any);
  assert.equal(notices.fresh(state as any).length,1,'back on the list, announced again');
  const plain=new ListNotices();
  assert.equal(plain.fresh(state as any)[0]!.text,'Needs you: Question a1');
  assert.deepEqual(new ListNotices().fresh({...state,approvals:undefined} as any),[],'no approvals array lists none, and does not throw');
})


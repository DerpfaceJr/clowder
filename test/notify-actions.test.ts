// Plan 3.4: answer from a notification. A real Town and ConnectorHub (only the MCP client is a stand-in), the real PushService with a
// recording sender, the real service worker's answer picker, and the real remote gate with a paired phone's cookie.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv,createECDH,hkdfSync,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {PushService,quickActions,registerPushRoutes,type Payload} from '../src/push.ts';
import {deskTown,tmp,until,PUBLISH,WRITE} from './fixtures/desk-town.ts';

const remoteConfig:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const ORIGIN='https://phone.example';
// The service worker's own answerFor, loaded as pwa.test.mjs loads its router.
const answerFor=(()=>{const sandbox={self:{location:{origin:ORIGIN}},URL,console};vm.createContext(sandbox);return vm.runInContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8')+'\n;answerFor',sandbox);})();

// RFC 8291, the receiving side: reads back what the push service would deliver.
function decrypt(body:Buffer,ua:ReturnType<typeof createECDH>,auth:Buffer):Payload{
  const idLength=body[20]!,asPublic=body.subarray(21,21+idLength),sealed=body.subarray(21+idLength),salt=body.subarray(0,16);
  const ikm=Buffer.from(hkdfSync('sha256',ua.computeSecret(asPublic),auth,Buffer.concat([Buffer.from('WebPush: info\0'),ua.getPublicKey(undefined,'uncompressed'),asPublic]),32));
  const decipher=createDecipheriv('aes-128-gcm',Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16)),Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12)));
  decipher.setAuthTag(sealed.subarray(sealed.length-16));
  const plain=Buffer.concat([decipher.update(sealed.subarray(0,sealed.length-16)),decipher.final()]);
  return JSON.parse(plain.subarray(0,plain.lastIndexOf(2)).toString());
}

async function pushed(){
  const bodies:Buffer[]=[];
  const service=new PushService({dataDir:tmp('notify-push-'),send:async(_e,_h,body)=>{bodies.push(body);return 201;},windowMs:0});
  const ua=createECDH('prime256v1');ua.generateKeys();const auth=randomBytes(16);
  service.subscribe({endpoint:'https://fcm.googleapis.com/fcm/send/phone',keys:{p256dh:ua.getPublicKey(undefined,'uncompressed').toString('base64url'),auth:auth.toString('base64url')}},'phone');
  return {service,payloads:()=>bodies.map(b=>decrypt(b,ua,auth))};
}

test('Allow on a private-write notification resolves the approval with the paired device id, through the remote gate',async()=>{
  const desk=await deskTown(),{service,payloads}=await pushed();
  try{
    service.attach({state:desk.store.state,listeners:desk.store.listeners as Set<any>});
    const approval=await desk.ask(WRITE,{note:'groceries',text:'milk'});
    assert.equal(approval.effectClass,'write');
    await until(()=>payloads().length===1);
    const payload=payloads()[0]!;
    assert.equal(payload.approval,approval.id);
    assert.deepEqual(payload.actions?.map(a=>[a.title,a.answer,a.approved]),[['Allow once','Allow once',true],['Deny','Deny',false]],'Allow and Deny only, never Always allow');
    assert.equal(payload.url,`/#item=approval%3A${approval.id}`);

    // The tap: the worker builds the request from the payload alone.
    const request=answerFor({url:payload.url,approval:payload.approval,actions:payload.actions},'0');
    assert.deepEqual({...request,body:{...request.body}},{path:`/api/approvals/${approval.id}`,body:{answer:'Allow once',approved:true}});
    assert.equal(answerFor({url:payload.url,approval:payload.approval,actions:payload.actions},''),null,'a tap on the notice itself is not an answer');

    // The remote listener as server.ts builds it: the gate, then the approvals route with the device from the cookie.
    const pairing=new Pairing(join(tmp('notify-devices-'),'devices.json'),remoteConfig);
    const remote=Fastify();const access=installRemoteAccess(remote,pairing,()=>ORIGIN);
    remote.post('/api/approvals/:id',async req=>{const b=req.body as any;desk.town.decide((req.params as any).id,b.answer,b.approved,access.device(req)??'unpaired');return {ok:true};});
    await remote.ready();
    const invite=pairing.create('owner'),phone=pairing.pair(invite.code,'Phone');
    // What a service worker's fetch carries: its origin, the owner header, and the device cookie (credentials: same-origin).
    const res=await remote.inject({method:'POST',url:request.path,payload:request.body,headers:{host:new URL(ORIGIN).host,origin:ORIGIN,'x-town-action':'owner',cookie:`__Host-town_device=${phone.token}`}});
    assert.equal(res.statusCode,200,res.body);
    const resolved=desk.store.state.events.find(e=>e.type==='approval.resolved'&&e.data.id===approval.id)!;
    assert.deepEqual(resolved.data,{id:approval.id,status:'approved',answer:'Allow once',device:phone.device.id});
    await until(()=>desk.calls.length===1);
    assert.equal(desk.calls[0]!.name,'update_note');
    await remote.close();
  }finally{service.close();await desk.close();}
});

test('a publish notification carries no action buttons and opens its card',async()=>{
  const desk=await deskTown(),{service,payloads}=await pushed();
  try{
    service.attach({state:desk.store.state,listeners:desk.store.listeners as Set<any>});
    const approval=await desk.ask(PUBLISH,{to:'alice@example.com',subject:'Hello'});
    assert.equal(approval.effectClass,'public');
    await until(()=>payloads().length===1);
    const payload=payloads()[0]!;
    assert.equal(payload.actions,undefined);assert.equal(payload.approval,undefined);
    assert.equal(payload.url,`/#item=approval%3A${approval.id}`);
    assert.equal(answerFor(payload,'0'),null);
  }finally{service.close();await desk.close();}
});

test('the class rule: only read and private-write calls and plain questions get buttons',()=>{
  const connector=(effectClass?:string)=>quickActions({gate:'connector',effectClass,options:['Allow','Always allow','Deny']}).map(a=>a.answer);
  assert.deepEqual(connector('read'),['Allow','Deny']);
  assert.deepEqual(connector('write'),['Allow','Deny']);
  for(const c of ['public','money','delete',undefined,'weird'])assert.deepEqual(connector(c),[],String(c));
  assert.deepEqual(quickActions({options:['Blue','No thanks']}),[{answer:'Blue',approved:true},{answer:'No thanks',approved:false}]);
  for(const gate of ['goal','grant','effect','routine','goal-removal'])assert.deepEqual(quickActions({gate,options:['Allow','Deny']}),[],gate);
});

test('push status tells a device whether it is subscribed',async()=>{
  const {service}=await pushed();
  const app=Fastify();registerPushRoutes(app,{service,allowed:()=>true,device:req=>String(req.headers['x-device'])});
  await app.ready();
  assert.deepEqual((await app.inject({url:'/api/push/status',headers:{'x-device':'phone'}})).json(),{subscribed:true,kinds:{approvals:true,mayor:true,seasons:true,routines:true,problems:true}});
  assert.equal((await app.inject({url:'/api/push/status?endpoint=https://fcm.googleapis.com/fcm/send/other',headers:{'x-device':'phone'}})).json().endpoint,false);
  assert.deepEqual((await app.inject({url:'/api/push/status',headers:{'x-device':'tablet'}})).json(),{subscribed:false,kinds:null});
  await app.close();service.close();
});

// Item 1.5 of docs/product-plan.md, device roles v2. The real server (src/server.ts) runs in this process on scratch ports with a temp
// data dir, and every route of both listeners is asked by an owner device, a viewer and an unpaired client. Routes come from Fastify's own
// route tree, so a route added later is in the matrix without editing this file.
import test,{after,before} from 'node:test';
import {withSecrets} from '../src/secret-store.ts';
import assert from 'node:assert/strict';
import {createECDH,createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {spawnSync} from 'node:child_process';
import type {FastifyInstance} from 'fastify';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {variants} from './route-variants.ts';

const remoteConfig:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const ORIGIN='https://device-roles.trycloudflare.com',DAY=24*60*60*1000,OWNER_KEY='device-roles-owner-key';
const sha=(token:string)=>createHash('sha256').update(token).digest('hex');
const legacy={phone:randomBytes(32).toString('hex'),tablet:randomBytes(32).toString('hex')};
const legacyRecords=(now:number)=>[
  {id:'legacy-phone',name:'Old phone',permission:'control',tokenHash:sha(legacy.phone),createdAt:now,expiresAt:now+20*DAY,followAt:now},
  {id:'legacy-tablet',name:'Old tablet',permission:'view',tokenHash:sha(legacy.tablet),createdAt:now,expiresAt:now+20*DAY},
];
const pushKeys=()=>{const ecdh=createECDH('prime256v1');ecdh.generateKeys();return {p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};};

let dir='',port=0,app:FastifyInstance,remoteApp:FastifyInstance;
const realFetch=globalThis.fetch;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'device-roles-'));
  // No starter connectors and no workshop install: the server makes no outside calls here, and fetch is stubbed besides.
  writeFileSync(join(dir,'connectors.json'),JSON.stringify({connectors:[],plugins:[]}));
  writeFileSync(join(dir,'workshop-settings.json'),JSON.stringify({autoSetup:false}));
  writeFileSync(join(dir,'devices.json'),JSON.stringify(legacyRecords(Date.now())));
  writeFileSync(join(dir,'push-subscriptions.json'),JSON.stringify([{endpoint:'https://fcm.googleapis.com/fcm/send/legacy',keys:pushKeys(),kinds:{approvals:true,mayor:true,seasons:true},createdAt:new Date().toISOString()}]));
  // The relay announce (once the origin is set below), push sends and model probes all go through fetch: none leaves this process.
  globalThis.fetch=(async()=>new Response(null,{status:503})) as typeof fetch;
  port=30000+Math.floor(Math.random()*20000);
  Object.assign(process.env,{PORT:String(port),CAT_REMOTE_PORT:String(port+1),CAT_TOWN_DATA:dir,CAT_TUNNEL_AUTOSTART:'0',CAT_TOWN_LAN:'0',CAT_OWNER_KEY:OWNER_KEY});
  const server=await import('../src/server.ts');
  app=server.app;remoteApp=server.remoteApp;
  // What a started tunnel sets; nothing is started.
  server.tunnel.origin=ORIGIN;
});
after(async()=>{await app?.close();globalThis.fetch=realFetch;});

// Security pass M3: the server takes the desktop app's owner key out of the environment as it reads it, so any child (Codex, Hermes, uv) starts without it.
test('the owner session key leaves the environment at start, so no child process inherits it',()=>{
  assert.equal(process.env.CAT_OWNER_KEY,undefined);
  assert.equal(spawnSync(process.execPath,['-e',"process.stdout.write(String('CAT_OWNER_KEY' in process.env))"],{encoding:'utf8',windowsHide:true}).stdout,'false');
});

// The host: this computer with this launch's owner session, as the desktop window holds it (access.ts).
const host=()=>({host:`localhost:${port}`,'x-town-action':'owner','content-type':'application/json',cookie:`town_owner_${port}=${OWNER_KEY}`});
const remote=(cookie?:string)=>({host:new URL(ORIGIN).host,origin:ORIGIN,'x-town-action':'owner','content-type':'application/json',...(cookie?{cookie}:{})});
const subs=()=>JSON.parse(readFileSync(join(dir,'push-subscriptions.json'),'utf8')) as {endpoint:string;device?:string}[];
async function pairDevice(permission:'owner'|'viewer',name:string){
  const invite=await app.inject({method:'POST',url:'/api/remote/invite',headers:host(),payload:{permission}});
  assert.equal(invite.statusCode,200,invite.body);
  const paired=await remoteApp.inject({method:'POST',url:'/api/pair',headers:remote(),payload:{code:invite.json().code,name}});
  assert.equal(paired.statusCode,200,paired.body);assert.equal(paired.json().permission,permission);
  const id=(await app.inject({url:'/api/remote/status',headers:host()})).json().devices.find((d:{name:string})=>d.name===name).id as string;
  return {id,cookie:String(paired.headers['set-cookie']).split(';')[0]!};
}

// Every route Fastify registered, read from its route tree. HEAD twins are dropped: Fastify adds one to every GET.
function routes(server:FastifyInstance){
  const out:{method:string;url:string}[]=[],path:string[]=[];
  for(const line of server.printRoutes().split('\n')){
    const m=/^([│ ]*)[├└]── (.+?)(?: \(([A-Z, ]+)\))?$/.exec(line);if(!m)continue;
    path.length=m[1]!.length/4;path.push(m[2]!);
    if(m[3])for(const method of m[3].split(', '))if(method!=='HEAD')out.push({method,url:path.join('')});
  }
  // Logout revokes the asking device, so it goes last.
  return out.sort((a,b)=>Number(a.url==='/api/logout')-Number(b.url==='/api/logout'));
}
const concrete=(url:string)=>url.replace(/:[^/]+/g,'matrix-x').replace(/\*$/,'matrix.txt');
const ask=(server:FastifyInstance,route:{method:string;url:string},headers:Record<string,string>,remoteAddress?:string)=>
  server.inject({method:route.method as any,url:concrete(route.url),headers,...(route.method==='GET'?{}:{payload:'{}'}),...(remoteAddress?{remoteAddress}:{})});
const statusClass=(s:number)=>[401,403,404].includes(s)?String(s):`${Math.floor(s/100)}xx`;
// The gateway's own public list (remote-access.ts): the pairing page, the pairing call, the APK, Stripe's signed webhook, the routine webhooks (their token
// is the credential) and the sign-in callback (the pending state is).
const isPublic=({method,url}:{method:string;url:string})=>(method==='GET'&&url==='/api/remote-access')||(method==='POST'&&url==='/api/pair')||(method==='GET'&&url==='/app/clowder.apk')||(method==='GET'&&url==='/api/connectors/oauth/callback')
  ||(method==='POST'&&url==='/stripe/webhook')||(method==='POST'&&url.startsWith('/hooks/routines/'))||(method==='GET'&&!/^\/(api|app|artifacts)\//.test(url));

test('migration: v1 control and view records become owner and viewer, keep their token hashes, and a second load writes nothing',async()=>{
  const stored=JSON.parse(readFileSync(join(dir,'devices.json'),'utf8')) as {id:string;permission:string;tokenHash:string;followAt?:number}[];
  const byId=Object.fromEntries(stored.map(d=>[d.id,d]));
  assert.deepEqual([byId['legacy-phone']!.permission,byId['legacy-tablet']!.permission],['owner','viewer']);
  assert.deepEqual([byId['legacy-phone']!.tokenHash,byId['legacy-tablet']!.tokenHash],[sha(legacy.phone),sha(legacy.tablet)],'hashes kept');
  assert.equal(typeof byId['legacy-phone']!.followAt,'number','other fields kept');
  // The saved tokens still work: no re-pair, and each device has its new role.
  const state=async(token:string)=>(await remoteApp.inject({url:'/api/state',headers:remote(`__Host-town_device=${token}`)})).json().readOnly;
  assert.equal(await state(legacy.phone),false,'the old control phone is an owner device');
  assert.equal(await state(legacy.tablet),true,'the old view tablet is a viewer');
  // Idempotent, on a file of its own: the first load renames and saves, the next load changes nothing.
  const file=join(mkdtempSync(join(tmpdir(),'device-roles-migrate-')),'devices.json');
  writeFileSync(file,JSON.stringify(legacyRecords(Date.now())));
  new Pairing(file,remoteConfig);
  const once=readFileSync(file,'utf8'),at=statSync(file).mtimeMs;
  assert.ok(!/"(control|view)"/.test(once));
  const again=new Pairing(file,remoteConfig);
  assert.equal(readFileSync(file,'utf8'),once);assert.equal(statSync(file).mtimeMs,at,'no write on the second load');
  assert.deepEqual(again.list().map(d=>[d.id,d.permission]),[['legacy-phone','owner'],['legacy-tablet','viewer']]);
});

test('viewers get no relay key; owner devices do',async()=>{
  const owner=await pairDevice('owner','Relay owner'),viewer=await pairDevice('viewer','Relay viewer');
  const key=withSecrets(join(dir,'rendezvous.json'),JSON.parse(readFileSync(join(dir,'rendezvous.json'),'utf8'))).key as string;
  const read=(cookie?:string)=>remoteApp.inject({url:'/api/remote/rendezvous',headers:remote(cookie)});
  const asViewer=await read(viewer.cookie);
  assert.equal(asViewer.statusCode,403);assert.ok(!asViewer.body.includes(key));
  assert.equal((await read()).statusCode,401);
  const asOwner=await read(owner.cookie);
  assert.equal(asOwner.statusCode,200);assert.equal(asOwner.json().key,key);
  for(const d of [owner,viewer])assert.equal((await app.inject({method:'POST',url:`/api/remote/revoke/${d.id}`,headers:host(),payload:'{}'})).statusCode,200);
});

test('push subscriptions are keyed by device: revoke and logout remove that device\'s endpoints only',async()=>{
  const a=await pairDevice('owner','Push phone'),b=await pairDevice('owner','Push tablet');
  const subscribe=(server:FastifyInstance,headers:Record<string,string>,name:string)=>server.inject({method:'POST',url:'/api/push/subscribe',headers,payload:{endpoint:`https://fcm.googleapis.com/fcm/send/${name}`,keys:pushKeys()}});
  assert.equal((await subscribe(app,host(),'host')).statusCode,200);
  assert.equal((await subscribe(remoteApp,remote(a.cookie),'a')).statusCode,200);
  assert.equal((await subscribe(remoteApp,remote(b.cookie),'b')).statusCode,200);
  const devices=()=>Object.fromEntries(subs().map(s=>[s.endpoint.split('/').at(-1),s.device??null]));
  assert.deepEqual(devices(),{legacy:null,host:'host',a:a.id,b:b.id});
  assert.equal((await app.inject({method:'POST',url:`/api/remote/revoke/${a.id}`,headers:host(),payload:'{}'})).statusCode,200);
  assert.deepEqual(devices(),{legacy:null,host:'host',b:b.id},'revoking the phone removes its endpoint');
  assert.equal((await remoteApp.inject({method:'POST',url:'/api/logout',headers:remote(b.cookie),payload:'{}'})).statusCode,200);
  assert.deepEqual(devices(),{legacy:null,host:'host'},'logging out removes the tablet\'s endpoint; the host and the pre-device subscription stay');
});

test('route matrix: every route of both listeners, asked by an owner device, a viewer and an unpaired client',{timeout:120_000},async t=>{
  const owner=await pairDevice('owner','Matrix owner'),viewer=await pairDevice('viewer','Matrix viewer');
  // The live event stream never ends, so inject would wait forever: it is checked over a real socket in its own test below.
  const streaming=(r:{method:string;url:string})=>r.method==='GET'&&r.url==='/api/events';
  const mainRoutes=routes(app).filter(r=>!streaming(r)),remoteRoutes=routes(remoteApp).filter(r=>!streaming(r));
  const key=(r:{method:string;url:string})=>`${r.method} ${r.url}`,onRemote=new Set(remoteRoutes.map(key));
  const mainOnly=mainRoutes.filter(r=>!onRemote.has(key(r)));
  assert.ok(mainRoutes.length>=80&&remoteRoutes.length>=40&&mainOnly.length>=30,`the route tree was read: ${mainRoutes.length} main, ${remoteRoutes.length} remote`);
  const counts:Record<string,number>={};const tally=(name:string,status:number)=>{const k=`${name} ${statusClass(status)}`;counts[k]=(counts[k]??0)+1;};
  const roles={owner:owner.cookie,viewer:viewer.cookie,unpaired:undefined} as const;

  // The remote listener: an owner device passes every isOwner gate; a viewer reads; an unpaired client gets only the public pages.
  for(const [role,cookie] of Object.entries(roles)){
    for(const route of remoteRoutes){
      const {statusCode:s,body}=await ask(remoteApp,route,remote(cookie));const at=`remote ${role} ${key(route)} -> ${s} ${body.slice(0,120)}`;
      tally(`remote ${role}`,s);
      assert.ok(s<500,at);
      // Money settings, Stripe connect, marking paid and new webhook links stay host-only without a fresh passkey step-up (plan 5.5, which this
      // Quick Tunnel never offers); deciding a purchase is open to owner devices.
      // An empty body can stop at schema validation (400) before the gate, so the check is that it never succeeds.
      const hostMoney=route.method!=='GET'&&(route.url.startsWith('/api/real-money/')||route.url==='/api/routines/:id/hook');
      if(role==='owner')assert.ok(hostMoney?s===403||s===400:s!==401&&s!==403,at);
      if(role==='viewer'){
        assert.notEqual(s,401,at);
        if(route.method!=='GET'&&!isPublic(route)&&route.url!=='/api/logout')assert.equal(s,403,at);
      }
      if(role==='unpaired')assert.equal(s===401,!isPublic(route),at);
    }
  }
  // The exceptions: device management, the tunnel and every main-only route (connectors, models, the cats' browser, secrets) never answer an owner device.
  const ownerAgain=await pairDevice('owner','Matrix owner 2');
  for(const route of mainOnly){
    const {statusCode:s}=await ask(remoteApp,route,remote(ownerAgain.cookie));tally('remote owner, main-only route',s);
    const managed=route.url.startsWith('/api/remote/')||route.url==='/api/sharing'||route.url==='/api/viewer-session';
    assert.equal(s,managed?403:404,`${key(route)} -> ${s}`);
  }
  // The main listener: a device's cookie, owner or viewer, grants nothing to a client that is not the host.
  const lanCookies={owner:`__Host-town_device=${ownerAgain.cookie.split('=')[1]}; town_device=${ownerAgain.cookie.split('=')[1]}`,viewer:`town_device=${viewer.cookie.split('=')[1]}`,unpaired:''};
  for(const [role,cookie] of Object.entries(lanCookies)){
    for(const route of mainRoutes){
      const {statusCode:s}=await ask(app,route,{...host(),...(cookie?{cookie}:{})},'192.168.1.21');tally(`main ${role}`,s);
      assert.equal(s,403,`main ${role} ${key(route)} -> ${s}`);
    }
  }
  // This computer without the owner session (security pass H2): the cats' browser or a CLI run, sending every header the town's own page sends.
  // It gets the app's pages and nothing else: town data 401, writes 403. Only routes with their own credential answer it, and they refuse a made-up one.
  const stranger={host:`localhost:${port}`,origin:`http://localhost:${port}`,'x-town-action':'owner','content-type':'application/json'};
  for(const route of mainRoutes){
    const {statusCode:s,body}=await ask(app,route,stranger);tally('main local stranger',s);
    const at=`main local stranger ${key(route)} -> ${s} ${body.slice(0,120)}`;
    assert.ok(s<500,at);
    // The sign-in comes back in the system browser, which has no owner session: the callback must answer it, on the pending state alone.
    if(route.method==='GET'&&route.url==='/api/connectors/oauth/callback'){assert.equal(s,200,at);assert.match(body,/did not match|expired|not found/i,at);continue;}
    if(route.method==='POST'&&route.url.startsWith('/hooks/routines/'))continue;
    if(route.method!=='GET')assert.equal(s,403,at);
    else if(/^\/(api|app|artifacts)\//.test(route.url))assert.equal(s,401,at);
  }
  t.diagnostic(`routes: main ${mainRoutes.length}, remote ${remoteRoutes.length}, main-only ${mainOnly.length}`);
  for(const [k,n] of Object.entries(counts).sort())t.diagnostic(`${k}: ${n}`);
});

test('encoded paths: every route of both listeners, bent six ways, gets nothing past the gates for an owner device, a viewer or an unpaired client',{timeout:300_000},async t=>{
  const owner=await pairDevice('owner','Variant owner'),viewer=await pairDevice('viewer','Variant viewer');
  const skip=(r:{method:string;url:string})=>(r.method==='GET'&&r.url==='/api/events')||r.url==='/api/logout';
  const at=(server:FastifyInstance,method:string,url:string,headers:Record<string,string>,remoteAddress?:string)=>
    server.inject({method:method as any,url,headers,...(method==='GET'?{}:{payload:'{}'}),...(remoteAddress?{remoteAddress}:{})});
  const lanCookie=(c:string)=>`town_device=${c.split('=')[1]}`;
  const askers:{name:string;server:FastifyInstance;headers:Record<string,string>;remoteAddress?:string}[]=[
    ...Object.entries({owner:owner.cookie,viewer:viewer.cookie,unpaired:undefined}).map(([role,c])=>({name:`remote ${role}`,server:remoteApp,headers:remote(c)})),
    ...Object.entries({owner:lanCookie(owner.cookie),viewer:lanCookie(viewer.cookie),unpaired:''}).map(([role,c])=>({name:`main ${role}`,server:app,headers:{...host(),...(c?{cookie:c}:{})},remoteAddress:'192.168.1.21'})),
  ];
  let n=0;
  for(const a of askers)for(const route of routes(a.server).filter(r=>!skip(r))){
    for(const v of variants(concrete(route.url))){
      const {statusCode:s,body}=await at(a.server,route.method,v.url,a.headers,a.remoteAddress);n++;
      const where=`${a.name} ${route.method} ${v.url} (${route.url}) -> ${s} ${body.slice(0,100)}`;
      assert.ok(s<500,where);
      if(v.refused)assert.equal(s,400,where);
      else if(s<400)assert.ok((await at(a.server,route.method,concrete(route.url),a.headers,a.remoteAddress)).statusCode<400,`${where}, where the plain path is refused`);
    }
  }
  // The finding itself (docs/research/security-pass.md H1): the encoded state read an unpaired client got 200 for.
  assert.equal((await at(remoteApp,'GET','/%61pi/state',remote())).statusCode,400);
  assert.equal((await at(remoteApp,'GET','/%61pi/state',{...remote(),'sec-fetch-site':'cross-site'})).statusCode,400);
  // Dot segments, sent as written over a socket (inject resolves them first), to both listeners.
  const raw=(listener:FastifyInstance,path:string,headers:Record<string,string>)=>new Promise<number>((done,fail)=>{
    const req=request({host:'127.0.0.1',port:(listener.server.address() as {port:number}).port,path,headers},res=>{done(res.statusCode??0);res.resume();});req.on('error',fail);req.end();});
  for(const path of ['/matrix/../api/state','/./api/state','/api/./state','/api/chats/..'])
    for(const [name,listener,headers] of [['remote',remoteApp,remote()],['main',app,{host:`localhost:${port}`}]] as const)
      assert.equal(await raw(listener,path,headers),400,`${name} ${path}`);
  t.diagnostic(`variants asked: ${n}`);
});

test('on the Quick Tunnel the passkey step-up is not offered: the phone sees none and the host cannot allow one',async()=>{
  const owner=await pairDevice('owner','Passkey owner');
  assert.deepEqual((await remoteApp.inject({url:'/api/step-up',headers:remote(owner.cookie)})).json(),{available:false});
  assert.equal((await remoteApp.inject({method:'POST',url:'/api/step-up/register/options',headers:remote(owner.cookie),payload:'{}'})).statusCode,409);
  assert.equal((await app.inject({url:'/api/remote/status',headers:host()})).json().stable,false);
  const allow=await app.inject({method:'POST',url:`/api/remote/passkey/${owner.id}`,headers:host(),payload:'{}'});
  assert.equal(allow.statusCode,409);assert.match(allow.json().error,/stays the same/);
  assert.equal((await remoteApp.inject({method:'POST',url:'/api/real-money/policy',headers:remote(owner.cookie),payload:JSON.stringify({enabled:false,mode:'prepay',currency:'CAD',perPurchaseLimitMinor:100,monthlyLimitMinor:100})})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/api/remote/revoke/${owner.id}`,headers:host(),payload:'{}'})).statusCode,200);
});

test('the live event stream answers paired owner and viewer devices and refuses an unpaired client',async()=>{
  const owner=await pairDevice('owner','Stream owner'),viewer=await pairDevice('viewer','Stream viewer');
  const port=(remoteApp.server.address() as {port:number}).port;
  // Status only: the stream is read up to its headers, then dropped. node:http, because fetch may not set the tunnel's Host header.
  const status=(cookie?:string)=>new Promise<number>((done,fail)=>{const req=request({host:'127.0.0.1',port,path:'/api/events',headers:remote(cookie)},res=>{done(res.statusCode??0);res.destroy();req.destroy();});req.on('error',fail);req.end();});
  assert.equal(await status(owner.cookie),200);
  assert.equal(await status(viewer.cookie),200);
  assert.equal(await status(),401);
});

// Plan 8.4: the read routes are in the matrix's route tree on both listeners, as /api/chats is (registerTown). The matrix above asks every one of them.
test('the search and thread routes are in the route matrix, on both listeners, as /api/chats is', () => {
  const main = routes(app).map(r => r.method + ' ' + r.url), remote = routes(remoteApp).map(r => r.method + ' ' + r.url);
  assert.ok(main.includes('GET /api/search'), 'search is in the route tree');
  assert.ok(main.includes('GET /api/threads/:task'), 'threads are in the route tree');
  assert.ok(remote.includes('GET /api/search') && remote.includes('GET /api/threads/:task') && remote.includes('GET /api/chats/:cat'), 'the tunnel listener has them, like /api/chats');
});

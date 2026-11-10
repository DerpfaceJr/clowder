// Item 5.2 of docs/product-plan.md: control from the same Wi-Fi after pairing. The real server runs with LAN sharing on (bound to loopback, so no
// firewall prompt), and every route of the main listener is asked by a LAN owner device, a LAN viewer, a LAN member and an unpaired LAN client.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {variants} from './route-variants.ts';

let dir='',port=0,app:FastifyInstance,remoteApp:FastifyInstance;
const realFetch=globalThis.fetch,PHONE='192.168.1.21',OWNER_KEY='lan-control-owner-key';
// A member device (plan 10.3), on file before the start. Invites (10.4) are asked in test/device-roles.test.ts.
const MEMBER=randomBytes(32).toString('hex');
// The member allow-list of plan §4.4, written out by hand as in test/device-roles.test.ts, so a wrong list in access.ts fails here too.
const MEMBER_ROUTES=new Set(['GET /api/state','GET /api/events','GET /api/chats/:cat','GET /api/threads/:task','GET /api/search','GET /api/projects',
  'GET /api/season','GET /api/goals','GET /api/artifacts','GET /artifacts/:id','GET /artifacts/:id/raw','GET /api/remote-access','GET /api/step-up',
  'POST /api/chat','POST /api/approvals/:id','POST /api/logout','POST /api/step-up/register/options','POST /api/step-up/register']);
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'lan-control-'));
  writeFileSync(join(dir,'connectors.json'),JSON.stringify({connectors:[],plugins:[]}));
  writeFileSync(join(dir,'workshop-settings.json'),JSON.stringify({autoSetup:false}));
  writeFileSync(join(dir,'devices.json'),JSON.stringify([{id:'lan-member',name:'Member laptop',permission:'member',person:'p-member',tokenHash:createHash('sha256').update(MEMBER).digest('hex'),createdAt:Date.now(),expiresAt:Date.now()+86_400_000}]));
  writeFileSync(join(dir,'people.json'),JSON.stringify([{id:'p-member',name:'Member',role:'member',createdAt:Date.now()}]));
  globalThis.fetch=(async()=>new Response(null,{status:503})) as typeof fetch;
  port=30000+Math.floor(Math.random()*20000);
  Object.assign(process.env,{PORT:String(port),CAT_REMOTE_PORT:String(port+1),CAT_TOWN_DATA:dir,CAT_TUNNEL_AUTOSTART:'0',CAT_TOWN_LAN:'1',CAT_TOWN_BIND:'127.0.0.1',CAT_OWNER_KEY:OWNER_KEY});
  const server=await import('../src/server.ts');
  app=server.app;remoteApp=server.remoteApp;
});
after(async()=>{await app?.close();globalThis.fetch=realFetch;});

// The host: this computer with this launch's owner session (access.ts).
const host=()=>({host:`localhost:${port}`,'x-town-action':'owner','content-type':'application/json',cookie:`town_owner_${port}=${OWNER_KEY}`});
// A phone on the Wi-Fi: not loopback, so never the host, whatever Host header it sends.
const lan=(cookie?:string)=>({host:`localhost:${port}`,'x-town-action':'owner','content-type':'application/json',...(cookie?{cookie}:{})});
async function pairLan(permission:'owner'|'viewer'){
  const share=await app.inject({url:`/api/sharing?permission=${permission}`,headers:host()});
  assert.equal(share.statusCode,200,share.body);
  const code=new URL(share.json().urls[0]).hash.slice(6);
  const paired=await app.inject({method:'POST',url:'/api/viewer-session',remoteAddress:PHONE,headers:{host:`localhost:${port}`,'content-type':'application/json'},payload:{token:code}});
  assert.equal(paired.statusCode,200,paired.body);
  return String(paired.headers['set-cookie']).split(';')[0]!;
}
// Every route Fastify registered (the parser test/device-roles.test.ts uses). HEAD twins are dropped.
function routes(server:FastifyInstance){
  const out:{method:string;url:string}[]=[],path:string[]=[];
  for(const line of server.printRoutes().split('\n')){
    const m=/^([│ ]*)[├└]── (.+?)(?: \(([A-Z, ]+)\))?$/.exec(line);if(!m)continue;
    path.length=m[1]!.length/4;path.push(m[2]!);
    if(m[3])for(const method of m[3].split(', '))if(method!=='HEAD')out.push({method,url:path.join('')});
  }
  return out;
}
const concrete=(url:string)=>url.replace(/:[^/]+/g,'matrix-x').replace(/\*$/,'matrix.txt');
const ask=(route:{method:string;url:string},cookie?:string)=>app.inject({method:route.method as any,url:concrete(route.url),headers:lan(cookie),remoteAddress:PHONE,...(route.method==='GET'?{}:{payload:'{}'})});

test('a LAN owner device controls the town; device management, the tunnel, secrets and money settings stay host-only',async()=>{
  const owner=await pairLan('owner'),viewer=await pairLan('viewer');
  const names=(await app.inject({url:'/api/remote/status',headers:host()})).json().devices.map((d:{name:string;permission:string})=>`${d.name}:${d.permission}`);
  assert.deepEqual(names.sort(),['Member laptop:member','Same Wi-Fi owner:owner','Same Wi-Fi viewer:viewer'],'Devices names each LAN device by its permission');
  const state=(cookie:string)=>app.inject({url:'/api/state',headers:lan(cookie),remoteAddress:PHONE});
  assert.equal((await state(owner)).json().readOnly,false);
  assert.equal((await state(viewer)).json().readOnly,true);
  // Owner routes: the same calls the tunnel serves.
  const pause=(cookie:string,headers:Record<string,string>={})=>app.inject({method:'POST',url:'/api/pause',headers:{...lan(cookie),...headers},remoteAddress:PHONE,payload:{value:false}});
  assert.equal((await pause(owner)).statusCode,200);
  assert.equal((await pause(viewer)).statusCode,403,'a viewer stays view-only');
  assert.equal((await pause(owner,{'x-town-action':''})).statusCode,403,'a write still needs the action header');
  assert.equal((await pause(owner,{origin:'http://evil.example'})).statusCode,403,'and the town origin');
  // Host-only, named.
  for(const [method,url] of [['GET','/api/sharing'],['GET','/api/remote/status'],['POST','/api/remote/invite'],['POST','/api/remote/start'],['POST','/api/remote/revoke/x'],['GET','/api/remote/rendezvous'],['POST','/api/real-money/policy'],['POST','/api/real-money/stripe'],['POST','/api/routines/x/hook'],['GET','/api/connectors'],['POST','/api/connectors'],['POST','/api/models/settings'],['POST','/api/models/claude/login/open']] as const){
    const {statusCode:s,body}=await app.inject({method,url,headers:lan(owner),remoteAddress:PHONE,...(method==='GET'?{}:{payload:'{}'})});
    assert.ok(s===403||s===400,`${method} ${url} -> ${s} ${body.slice(0,100)}`);
  }
});

test('route matrix on the LAN listener: an owner device gets exactly the tunnel listener\'s owner surface, a viewer reads, a member gets the allow-list, an unpaired client gets nothing',{timeout:120_000},async t=>{
  const owner=await pairLan('owner'),viewer=await pairLan('viewer');
  const key=(r:{method:string;url:string})=>`${r.method} ${r.url}`,onRemote=new Set(routes(remoteApp).map(key));
  const mainRoutes=routes(app).filter(r=>!(r.method==='GET'&&r.url==='/api/events'));
  assert.ok(mainRoutes.length>=80,`the route tree was read: ${mainRoutes.length}`);
  const guarded=(url:string)=>/^\/(api|app|artifacts)\//.test(url),pairing=(r:{method:string;url:string})=>r.method==='POST'&&r.url==='/api/viewer-session';
  const counts:Record<string,number>={};
  for(const [role,cookie] of [['owner',owner],['viewer',viewer],['member',`town_device=${MEMBER}`],['unpaired',undefined]] as const){
    for(const route of mainRoutes){
      const {statusCode:s,body}=await ask(route,cookie),at=`lan ${role} ${key(route)} -> ${s} ${body.slice(0,120)}`;
      const k=`${role} ${onRemote.has(key(route))?'tunnel route':'main-only'} ${s}`;counts[k]=(counts[k]??0)+1;
      assert.ok(s<500,at);
      const write=route.method!=='GET';
      // The host-only exceptions on routes the tunnel also serves: device management (/api/remote/), money settings, new webhook links.
      const hostOnly=route.url.startsWith('/api/remote/')||(write&&(route.url.startsWith('/api/real-money/')||route.url==='/api/routines/:id/hook'||route.url==='/api/owner-key/rotate'||route.url.startsWith('/api/owner-tokens')));
      if(role==='owner'&&onRemote.has(key(route))&&!pairing(route))assert.ok(hostOnly?s===403||s===400:s!==401&&s!==403,at);
      if(role==='owner'&&!onRemote.has(key(route))&&write&&!pairing(route))assert.equal(s,403,at);
      if(role==='viewer'){assert.notEqual(s,401,at);if(write&&!pairing(route))assert.equal(s,403,at);}
      // The member gate (plan 10.5): past the gate on an allow-listed tunnel route (an empty body may still stop at its schema), 403 on every other
      // town route or write. The app's own pages load, as for anyone on the Wi-Fi.
      if(role==='member'&&!pairing(route)){if(MEMBER_ROUTES.has(key(route))&&onRemote.has(key(route)))assert.ok(s!==401&&s!==403,at);else if(write||guarded(route.url))assert.equal(s,403,at);}
      if(role==='unpaired'&&!pairing(route))assert.ok(write?s===403:guarded(route.url)?s===401:s!==401,at);
    }
  }
  for(const [k,n] of Object.entries(counts).sort())t.diagnostic(`${k}: ${n}`);
});

test('encoded paths on the LAN listener: every route bent six ways gets nothing past the gate for an owner device, a viewer, a member or an unpaired client',{timeout:300_000},async()=>{
  const owner=await pairLan('owner'),viewer=await pairLan('viewer');
  const at=(method:string,url:string,cookie?:string)=>app.inject({method:method as any,url,headers:lan(cookie),remoteAddress:PHONE,...(method==='GET'?{}:{payload:'{}'})});
  for(const [role,cookie] of [['owner',owner],['viewer',viewer],['member',`town_device=${MEMBER}`],['unpaired',undefined]] as const){
    for(const route of routes(app).filter(r=>!(r.method==='GET'&&r.url==='/api/events'))){
      for(const v of variants(concrete(route.url))){
        const {statusCode:s,body}=await at(route.method,v.url,cookie),where=`lan ${role} ${route.method} ${v.url} (${route.url}) -> ${s} ${body.slice(0,100)}`;
        assert.ok(s<500,where);
        if(v.refused)assert.equal(s,400,where);
        else if(s<400)assert.ok((await at(route.method,concrete(route.url),cookie)).statusCode<400,`${where}, where the plain path is refused`);
      }
    }
  }
  // Not probed by the security pass, named there: a viewer's encoded /api/remote/ read past the host-only hook.
  assert.equal((await at('GET','/api/%72emote/status',viewer)).statusCode,400);
  assert.equal((await at('GET','/%61pi/state')).statusCode,400);
});

// Plan 10.5 on the Same Wi-Fi listener: a LAN member device reads the town and talks to the Mayor, and is refused another cat, worlds, money and
// main-only routes, as on the tunnel listener.
test('the member gate on the LAN listener: a member reads and talks to the Mayor; other cats, worlds, money and main-only routes answer 403',async()=>{
  const as=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:lan(`town_device=${MEMBER}`),remoteAddress:PHONE,...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
  const state=await as('GET','/api/state');
  assert.equal(state.statusCode,200,state.body);assert.equal(state.json().readOnly,true);
  assert.equal((await as('POST','/api/chat',{cat:'mayor',text:'Hello from the Wi-Fi.',mode:'demo'})).statusCode,200);
  assert.equal((await as('POST','/api/chat',{cat:'scout',text:'Hello.',mode:'demo'})).statusCode,403);
  const noAction=await app.inject({method:'POST',url:'/api/chat',headers:{...lan(`town_device=${MEMBER}`),'x-town-action':''},remoteAddress:PHONE,payload:{cat:'mayor',text:'Hi.',mode:'demo'}});
  assert.equal(noAction.statusCode,403,'a write still needs the action header');
  for(const [method,url,payload] of [['GET','/api/worlds'],['GET','/api/real-money'],['GET','/api/usage'],['GET','/api/connectors'],['GET','/api/sharing'],['GET','/api/remote/status'],
    ['GET','/api/for-you'],['POST','/api/remote/people',{name:'Me'}],['POST','/api/approvals/x',{answer:'Yes',approved:true}],['POST','/api/pause',{value:true}]] as const)
    assert.equal((await as(method,url,payload)).statusCode,403,`${method} ${url}`);
});

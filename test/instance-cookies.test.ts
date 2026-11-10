// Plan 10.2: two Clowder instances on one PC and one host name. Cookies are not kept apart by port (RFC 6265 §8.5), so the browser below
// keeps one jar per host name, sends every cookie to both ports, and enforces the __Host- prefix rules (Secure, Path=/, no Domain).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify,{type LightMyRequestResponse} from 'fastify';
import {installAccess,instanceCookie,isOwner} from '../src/access.ts';
import {STEP_UP_COOKIE,installRemoteAccess} from '../src/remote-access.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {TailscaleServe,detectTailscale,serveArgs,serveCommand,serveOffArgs,serveOrigin,servePort,type Run} from '../src/tailscale.ts';
const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const DNS='pc-name.tail1234.ts.net',PRIVATE=`https://${DNS}`,TEAM=`https://${DNS}:8798`;

class Jar{
  cookies=new Map<string,string>();
  take(res:LightMyRequestResponse){
    for(const line of [res.headers['set-cookie']??[]].flat()){
      const [pair,...attrs]=String(line).split(';').map(s=>s.trim());
      const at=pair!.indexOf('='),name=pair!.slice(0,at),value=pair!.slice(at+1),has=(a:string)=>attrs.some(x=>x.toLowerCase().startsWith(a));
      if(name.startsWith('__Host-')&&(!has('secure')||!attrs.includes('Path=/')||has('domain=')))throw new Error(`A browser drops ${line}`);
      if(attrs.includes('Max-Age=0'))this.cookies.delete(name);else this.cookies.set(name,value);
    }
    return res;
  }
  get header(){return [...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ');}
}
const scratch=()=>mkdtempSync(join(tmpdir(),'cat-instances-'));

test('the private instance keeps today\'s cookie names, Serve port and address byte for byte',async()=>{
  assert.equal(instanceCookie('__Host-town_device'),'__Host-town_device');
  assert.equal(instanceCookie('town_device'),'town_device');
  assert.equal(instanceCookie(STEP_UP_COOKIE),'__Host-town_stepup');
  assert.equal(instanceCookie('town_device',''),'town_device','an empty CAT_TEAM is the private town');
  assert.equal(servePort(8788),443);
  assert.deepEqual(serveArgs(8788,servePort(8788)),['serve','--bg','--https=443','http://127.0.0.1:8788']);
  assert.deepEqual(serveOffArgs(servePort(8788)),['serve','--https=443','off']);
  assert.equal(serveCommand(8788,servePort(8788)),'tailscale serve --bg --https=443 http://127.0.0.1:8788');
  assert.equal(serveOrigin(DNS,servePort(8788)),PRIVATE);
  // A device paired before 10.2 (a token in devices.json, today's cookie name) is still in, and pairing and logout send today's exact headers.
  const dir=scratch(),pairing=new Pairing(join(dir,'devices.json'),config),app=Fastify({logger:false});
  installRemoteAccess(app,pairing,()=>PRIVATE);await app.ready();
  try{
    const old=pairing.pair(pairing.create('owner').code,'Android');
    const headers={host:DNS,origin:PRIVATE,'x-town-action':'owner'};
    assert.equal((await app.inject({url:'/api/step-up',headers:{host:DNS,cookie:`__Host-town_device=${old.token}`}})).statusCode,200,'no re-pair');
    const paired=await app.inject({method:'POST',url:'/api/pair',headers,payload:{code:pairing.create('viewer').code,name:'Phone'}});
    assert.match(String(paired.headers['set-cookie']),new RegExp(`^__Host-town_device=[a-f0-9]{64}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.deviceTtlMs/1000}$`));
    const out=await app.inject({method:'POST',url:'/api/logout',headers:{...headers,cookie:String(paired.headers['set-cookie']).split(';')[0]}});
    assert.equal(out.headers['set-cookie'],'__Host-town_device=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('a team slug goes into the cookie name; anything that cannot sit in one stops the server',()=>{
  assert.equal(instanceCookie('__Host-town_device','team-1'),'__Host-town_device_team-1');
  assert.equal(instanceCookie('town_device','team-12'),'town_device_team-12');
  for(const bad of ['Team 1','team;1','team=1','team_1','x'.repeat(41)])assert.throws(()=>instanceCookie('town_device',bad),/CAT_TEAM/,bad);
  assert.equal(servePort(8798,'team-1'),8798,'a team serves on its own remote port');
});

// Two remote listeners on one tailnet host name: the private town on 443, team-1 on 8798. withTeam false is the pre-10.2 build.
async function twoRemote(withTeam:boolean){
  const dirs=[scratch(),scratch()],pairings=dirs.map(d=>new Pairing(join(d,'devices.json'),config));
  const apps=[Fastify({logger:false}),Fastify({logger:false})];
  installRemoteAccess(apps[0]!,pairings[0]!,()=>PRIVATE);
  installRemoteAccess(apps[1]!,pairings[1]!,()=>TEAM,undefined,Date.now,withTeam?'team-1':undefined);
  await Promise.all(apps.map(a=>a.ready()));
  const jar=new Jar(),hosts=[DNS,`${DNS}:8798`],origins=[PRIVATE,TEAM];
  const write=(i:number)=>({host:hosts[i]!,origin:origins[i]!,'x-town-action':'owner',cookie:jar.header});
  const pair=async(i:number)=>jar.take(await apps[i]!.inject({method:'POST',url:'/api/pair',headers:write(i),payload:{code:pairings[i]!.create('owner').code,name:'Phone'}})).statusCode;
  const open=async(i:number)=>jar.take(await apps[i]!.inject({url:'/api/step-up',headers:{host:hosts[i]!,cookie:jar.header}})).statusCode;
  const close=async()=>{await Promise.all(apps.map(a=>a.close()));for(const d of dirs)rmSync(d,{recursive:true,force:true});};
  return {apps,jar,pair,open,write,close};
}

test('one browser paired to both instances on one host name keeps both pairings',async()=>{
  const t=await twoRemote(true);
  try{
    assert.equal(await t.pair(0),200);assert.equal(await t.pair(1),200);
    assert.deepEqual([...t.jar.cookies.keys()].sort(),['__Host-town_device','__Host-town_device_team-1']);
    assert.equal(await t.open(0),200,'the private town still knows this browser');
    assert.equal(await t.open(1),200,'and so does the team');
    // The team answers on its own port only, and its logout clears its own cookie, not the private town's.
    assert.equal((await t.apps[1]!.inject({url:'/api/step-up',headers:{host:DNS,cookie:t.jar.header}})).statusCode,403);
    t.jar.take(await t.apps[1]!.inject({method:'POST',url:'/api/logout',headers:t.write(1)}));
    assert.deepEqual([...t.jar.cookies.keys()],['__Host-town_device']);
    assert.equal(await t.open(0),200);assert.equal(await t.open(1),401);
  }finally{await t.close();}
});

test('control: before 10.2 the second pairing replaced the first, which is what the test above would catch',async()=>{
  const t=await twoRemote(false);
  try{
    assert.equal(await t.pair(0),200);assert.equal(await t.pair(1),200);
    assert.deepEqual([...t.jar.cookies.keys()],['__Host-town_device']);
    assert.equal(await t.open(0),401,'the private town lost this browser');
    assert.equal(await t.open(1),200);
  }finally{await t.close();}
});

test('Same Wi-Fi: one browser paired to both instances on one LAN address keeps both',async()=>{
  const dirs=[scratch(),scratch()],pairings=dirs.map(d=>new Pairing(join(d,'devices.json'),config));
  const ports=[8787,8797],keys=['private-owner-key','team-owner-key'],apps=[Fastify({logger:false}),Fastify({logger:false})];
  installAccess(apps[0]!,true,['192.168.1.20'],ports[0]!,pairings[0],undefined,keys[0]);
  installAccess(apps[1]!,true,['192.168.1.20'],ports[1]!,pairings[1],undefined,keys[1],'team-1');
  for(const app of apps)app.get('/api/state',async req=>({readOnly:!isOwner(req)}));
  await Promise.all(apps.map(a=>a.ready()));
  const jar=new Jar(),phone=(i:number)=>({remoteAddress:'192.168.1.21',headers:{host:`192.168.1.20:${ports[i]}`,cookie:jar.header}});
  try{
    for(const i of [0,1]){
      const share=await apps[i]!.inject({url:'/api/sharing',headers:{host:`localhost:${ports[i]}`,cookie:`town_owner_${ports[i]}=${keys[i]}`}});
      const token=new URL(share.json().urls[0]).hash.slice(6);
      assert.equal(jar.take(await apps[i]!.inject({method:'POST',url:'/api/viewer-session',...phone(i),payload:{token}})).statusCode,200);
    }
    assert.deepEqual([...jar.cookies.keys()].sort(),['town_device','town_device_team-1']);
    for(const i of [0,1])assert.equal((await apps[i]!.inject({url:'/api/state',...phone(i)})).statusCode,200,`instance ${i} keeps its viewer`);
  }finally{await Promise.all(apps.map(a=>a.close()));for(const d of dirs)rmSync(d,{recursive:true,force:true});}
});

test('a team instance serves on its own port, turns off only that entry, and gives an address with the port',async()=>{
  const calls:string[][]=[];
  const run=async(_file:string,args:string[]):Promise<Run>=>{calls.push(args);return {code:0,stdout:args[0]==='status'?JSON.stringify({BackendState:'Running',Self:{DNSName:`${DNS}.`},CertDomains:[DNS]}):'',stderr:''};};
  const https=servePort(8798,'team-1'),tailscale=new TailscaleServe(run,https);
  assert.equal(await tailscale.start(8798),TEAM);
  assert.deepEqual(calls.at(-1),['serve','--bg','--https=8798','http://127.0.0.1:8798']);
  await tailscale.stop();
  assert.deepEqual(calls.at(-1),['serve','--https=8798','off'],'the private town\'s 443 entry is left alone');
  assert.equal((await detectTailscale(run,https)).origin,TEAM,'Devices shows the address the team will get');
  assert.equal(serveCommand(8798,https),'tailscale serve --bg --https=8798 http://127.0.0.1:8798');
  assert.ok(calls.every(args=>!args.includes('funnel')));
});

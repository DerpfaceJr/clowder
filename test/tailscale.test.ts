import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TailscaleServe,NOT_INSTALLED,NOT_RUNNING,NO_CERTIFICATES,detectTailscale,parseTailscaleStatus,serveCommand,type Run} from '../src/tailscale.ts';
import {remoteProvider} from '../src/remote-provider.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {Pairing} from '../src/pairing.ts';
import {loadConfig} from '../src/config.ts';

// The fake CLI replaces the real tailscale executable. No test below spawns it.
type Call={file:string;args:string[]};
const ok=(stdout=''):Run=>({code:0,stdout,stderr:''});
const enoent=()=>Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'});
const RUNNING=JSON.stringify({BackendState:'Running',Self:{DNSName:'pc-name.tail1234.ts.net.'}});
const ORIGIN='https://pc-name.tail1234.ts.net';

function fakeCli(script:(file:string,args:string[])=>Run|Error){
  const calls:Call[]=[];
  const run=async(file:string,args:string[]):Promise<Run>=>{
    calls.push({file,args:[...args]});
    const out=script(file,args);
    if(out instanceof Error)throw out;
    return out;
  };
  return {calls,run};
}
// Healthy machine: status reports Running, serve and serve-off succeed.
const healthy=(file:string,args:string[])=>args[0]==='status'?ok(RUNNING):ok('');
const SERVE_ARGS=['serve','--bg','--https=443','http://127.0.0.1:8788'];
const SERVE_OFF=['serve','--https=443','off'];

test('status JSON yields the MagicDNS name without the trailing dot',()=>{
  assert.equal(parseTailscaleStatus(RUNNING),'pc-name.tail1234.ts.net');
  assert.equal(parseTailscaleStatus(JSON.stringify({BackendState:'Running',Self:{DNSName:'pc.tail1234.ts.net'}})),'pc.tail1234.ts.net');
});

test('status without Running, without DNSName, or unreadable fails with the sign-in and MagicDNS message',()=>{
  assert.throws(()=>parseTailscaleStatus(JSON.stringify({BackendState:'NeedsLogin',Self:{DNSName:'pc.tail1234.ts.net.'}})),{message:NOT_RUNNING});
  assert.throws(()=>parseTailscaleStatus(JSON.stringify({BackendState:'Running',Self:{}})),{message:NOT_RUNNING});
  assert.throws(()=>parseTailscaleStatus(''),{message:NOT_RUNNING});
  assert.equal(NOT_RUNNING,'Tailscale is not signed in, or MagicDNS is off. Sign in to Tailscale on this PC and turn on MagicDNS in the Tailscale admin console.');
});

test('start publishes port 443 to the local listener and sets the stable origin',async()=>{
  const fake=fakeCli(healthy);
  const tailscale=new TailscaleServe(fake.run);
  assert.equal(await tailscale.start(8788),ORIGIN);
  assert.deepEqual(fake.calls.map(c=>c.args),[['status','--json'],SERVE_ARGS]);
  assert.equal(fake.calls[1].file,'tailscale');
  assert.deepEqual(tailscale.status(),{origin:ORIGIN,starting:false,error:undefined,named:false,provider:'tailscale'});
  assert.equal(await tailscale.start(8788),ORIGIN);
  assert.equal(fake.calls.length,2,'a second start reuses the origin');
});

test('missing CLI on PATH falls back to the Program Files install',async()=>{
  const fake=fakeCli((file,args)=>file==='tailscale'?enoent():healthy(file,args));
  const tailscale=new TailscaleServe(fake.run);
  assert.equal(await tailscale.start(8788),ORIGIN);
  assert.equal(fake.calls[1].file,'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.deepEqual(fake.calls[2].args,SERVE_ARGS);
});

test('not installed gives the install message and never runs serve',async()=>{
  const fake=fakeCli(()=>enoent());
  const tailscale=new TailscaleServe(fake.run);
  await assert.rejects(tailscale.start(8788),{message:'Tailscale is not installed. Install it from tailscale.com/download and sign in.'});
  assert.equal(NOT_INSTALLED,'Tailscale is not installed. Install it from tailscale.com/download and sign in.');
  assert.equal(tailscale.status().error,NOT_INSTALLED);
  assert.equal(tailscale.origin,undefined);
  assert.equal(fake.calls.some(c=>c.args[0]==='serve'),false);
});

test('signed-out or stopped Tailscale gives the sign-in message',async()=>{
  const stopped=fakeCli((file,args)=>args[0]==='status'?{code:1,stdout:'',stderr:'tailscaled is not running'}:ok());
  await assert.rejects(new TailscaleServe(stopped.run).start(8788),{message:NOT_RUNNING});
  const needsLogin=fakeCli(()=>ok(JSON.stringify({BackendState:'NeedsLogin',Self:{}})));
  const tailscale=new TailscaleServe(needsLogin.run);
  await assert.rejects(tailscale.start(8788),{message:NOT_RUNNING});
  assert.equal(tailscale.status().error,NOT_RUNNING);
  assert.equal(needsLogin.calls.length,1,'serve is not attempted without a running tailnet');
});

test('serve refused for missing HTTPS certificates gives the admin console message and is not turned off',async()=>{
  const fake=fakeCli((file,args)=>args[0]==='status'?ok(RUNNING):args[0]==='serve'?{code:1,stdout:'',stderr:'HTTPS certificates are not enabled for this tailnet'}:ok());
  const tailscale=new TailscaleServe(fake.run);
  await assert.rejects(tailscale.start(8788),{message:NO_CERTIFICATES});
  assert.equal(NO_CERTIFICATES,'Tailscale HTTPS certificates are not enabled. In the Tailscale admin console, open DNS and enable "HTTPS Certificates", then enable remote access again.');
  assert.equal(tailscale.origin,undefined);
  assert.equal(fake.calls.some(c=>c.args.includes('off')),false);
});

test('stop turns off only port 443 and clears the origin',async()=>{
  const fake=fakeCli(healthy);
  const tailscale=new TailscaleServe(fake.run);
  await tailscale.start(8788);
  await tailscale.stop();
  assert.deepEqual(fake.calls.at(-1)?.args,SERVE_OFF);
  assert.equal(tailscale.origin,undefined);
  assert.equal(tailscale.status().origin,undefined);
  assert.equal(tailscale.status().provider,'tailscale');
});

test('stop before any serve entry was published does not touch serve',async()=>{
  const fake=fakeCli(healthy);
  const tailscale=new TailscaleServe(fake.run);
  await tailscale.stop();
  assert.equal(fake.calls.length,0);
});

test('stop during start cancels the publish',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const fake=fakeCli(()=>ok(RUNNING));
  const run=async(file:string,args:string[])=>{
    if(args[0]==='serve'&&args.includes('--bg')){fake.calls.push({file,args:[...args]});await gate;return ok('');}
    return fake.run(file,args);
  };
  const tailscale=new TailscaleServe(run);
  const starting=tailscale.start(8788);
  await new Promise(resolve=>setTimeout(resolve,0));
  await tailscale.stop();
  release();
  await assert.rejects(starting,{message:'Remote access stopped.'});
  assert.equal(tailscale.origin,undefined);
  assert.equal(fake.calls.at(-1)?.args.join(' '),SERVE_OFF.join(' '));
});

test('no Tailscale command ever carries funnel',async()=>{
  const fake=fakeCli(healthy);
  const tailscale=new TailscaleServe(fake.run);
  await tailscale.start(8788);
  await tailscale.stop();
  for(const call of fake.calls)assert.equal(call.args.includes('funnel'),false);
  assert.ok(fake.calls.every(call=>!call.args.join(' ').includes('funnel')));
});

test('remote.provider accepts cloudflare and tailscale and defaults to cloudflare',()=>{
  assert.equal(remoteProvider(undefined),'cloudflare');
  assert.equal(remoteProvider('cloudflare'),'cloudflare');
  assert.equal(remoteProvider('tailscale'),'tailscale');
  assert.throws(()=>remoteProvider('funnel'),/remote\.provider/);
});

test('remote access accepts the tailnet host and rejects other hosts',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const dir=mkdtempSync(join(tmpdir(),'tailscale-remote-'));
  const pairing=new Pairing(join(dir,'devices.json'),loadConfig(root).remote);
  const app=Fastify({logger:false});
  installRemoteAccess(app,pairing,()=>ORIGIN);
  try{
    const tailnet=await app.inject({method:'GET',url:'/api/remote-access',headers:{host:'pc-name.tail1234.ts.net'}});
    assert.equal(tailnet.statusCode,200);
    assert.equal(JSON.parse(tailnet.body).remote,true);
    const other=await app.inject({method:'GET',url:'/api/remote-access',headers:{host:'attacker.example'}});
    assert.equal(other.statusCode,403);
    const lookalike=await app.inject({method:'GET',url:'/api/remote-access',headers:{host:'pc-name.tail1234.ts.net.evil.example'}});
    assert.equal(lookalike.statusCode,403);
    const wrongOrigin=await app.inject({method:'POST',url:'/api/logout',headers:{host:'pc-name.tail1234.ts.net',origin:'https://attacker.example','x-town-action':'owner'}});
    assert.equal(wrongOrigin.statusCode,403);
    const unpaired=await app.inject({method:'POST',url:'/api/logout',headers:{host:'pc-name.tail1234.ts.net',origin:ORIGIN,'x-town-action':'owner'}});
    assert.equal(unpaired.statusCode,401);
  }finally{
    await app.close();
  }
});

test('remote access stays off while no origin is set',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const dir=mkdtempSync(join(tmpdir(),'tailscale-off-'));
  const app=Fastify({logger:false});
  installRemoteAccess(app,new Pairing(join(dir,'devices.json'),loadConfig(root).remote),()=>undefined);
  try{
    const response=await app.inject({method:'GET',url:'/api/remote-access',headers:{host:'pc-name.tail1234.ts.net'}});
    assert.equal(response.statusCode,403);
  }finally{
    await app.close();
  }
});

// Devices (plan 5.1) checks Tailscale before anything is published: status only, never serve.
test('the Devices check reads install, sign-in, HTTPS certificates and the address, and never runs serve',async()=>{
  const withCerts=(certs:unknown)=>JSON.stringify({BackendState:'Running',Self:{DNSName:'pc-name.tail1234.ts.net.'},...(certs===undefined?{}:{CertDomains:certs})});
  const check=async(script:(file:string,args:string[])=>Run|Error)=>{const fake=fakeCli(script);const result=await detectTailscale(fake.run);assert.ok(fake.calls.every(c=>c.args[0]==='status'),'status only');return result;};
  assert.deepEqual(await check(()=>enoent()),{installed:false,signedIn:false});
  assert.deepEqual(await check(()=>({code:1,stdout:'',stderr:'tailscaled is not running'})),{installed:true,signedIn:false});
  assert.deepEqual(await check(()=>ok(JSON.stringify({BackendState:'NeedsLogin',Self:{}}))),{installed:true,signedIn:false});
  assert.deepEqual(await check(()=>new Error('spawn EPERM')),{installed:true,signedIn:false},'a CLI that cannot run is installed but not usable');
  assert.deepEqual(await check(()=>ok(withCerts(['pc-name.tail1234.ts.net']))),{installed:true,signedIn:true,https:true,origin:ORIGIN});
  assert.deepEqual(await check(()=>ok(withCerts(null))),{installed:true,signedIn:true,https:false,origin:ORIGIN},'HTTPS still off');
  assert.deepEqual(await check(()=>ok(withCerts(['other.tail1234.ts.net']))),{installed:true,signedIn:true,https:false,origin:ORIGIN});
  assert.deepEqual(await check(()=>ok(withCerts(undefined))),{installed:true,signedIn:true,https:undefined,origin:ORIGIN},'an older client says nothing about HTTPS');
  // The Windows install is found the same way serve finds it.
  const fallback=fakeCli((file,args)=>file==='tailscale'?enoent():ok(withCerts(['pc-name.tail1234.ts.net.'])));
  assert.equal((await detectTailscale(fallback.run)).https,true);
  assert.equal(fallback.calls[1]!.file,'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.equal(serveCommand(8788),'tailscale serve --bg --https=443 http://127.0.0.1:8788');
});

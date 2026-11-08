import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteKeeper,RemoteSettings} from '../src/remote-keeper.ts';
import {RemoteCarrier,type RemoteProvider,type RemoteStatus,type RemoteTunnel} from '../src/remote-provider.ts';

// A tunnel that hands out a new origin per start, can be made to fail, and can "die" the way cloudflared does.
class FakeTunnel implements RemoteTunnel{
  origin?:string;error?:string;starts=0;stops=0;fail=false;
  constructor(private provider:RemoteProvider='cloudflare'){}
  start(_port:number){this.starts++;if(this.fail)return Promise.reject(new Error('cloudflared could not start.'));this.origin=this.provider==='tailscale'?'https://pc.tail1234.ts.net':`https://t${this.starts}.trycloudflare.com`;return Promise.resolve(this.origin);}
  stop(){this.stops++;this.origin=undefined;}
  status():RemoteStatus{return {origin:this.origin,starting:false,named:false,provider:this.provider};}
  down(){this.origin=undefined;}
}
// Timers the test fires by hand, so backoff is checked without waiting.
function clock(){
  const live:{run:()=>void;ms:number}[]=[];
  return {live,timers:{set:(run:()=>void,ms:number)=>{const timer={run,ms};live.push(timer);return timer;},clear:(handle:unknown)=>{const index=live.indexOf(handle as {run:()=>void;ms:number});if(index>=0)live.splice(index,1);}}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fire(c:ReturnType<typeof clock>){const timer=c.live.shift();assert.ok(timer,'a retry is pending');timer.run();await flush();}
const dir=()=>mkdtempSync(join(tmpdir(),'cat-keeper-'));

test('start remembers the choice in remote-settings.json; stop forgets it and stops the tunnel',async()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json'),tunnel=new FakeTunnel(),keeper=new RemoteKeeper(tunnel,8788,new RemoteSettings(file),()=>{},clock().timers);
    assert.equal(new RemoteSettings(file).enabled,false);
    assert.equal(await keeper.start(),'https://t1.trycloudflare.com');
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:true});assert.equal(new RemoteSettings(file).enabled,true);
    await keeper.stop();
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:false});assert.equal(tunnel.stops,1);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('a new process with the saved choice starts the tunnel; CAT_TUNNEL_AUTOSTART=0 wins and =1 forces it without changing the choice',async()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json');writeFileSync(file,'{"enabled":true}');
    const tunnel=new FakeTunnel(),lines:string[]=[],keeper=new RemoteKeeper(tunnel,8788,new RemoteSettings(file),m=>lines.push(m),clock().timers);
    assert.equal(keeper.autostart({CAT_TUNNEL_AUTOSTART:'0'}),false);assert.equal(tunnel.starts,0);
    assert.equal(keeper.autostart({}),true);await flush();
    assert.equal(tunnel.starts,1);assert.equal(lines[0],'Remote access: https://t1.trycloudflare.com');
    writeFileSync(file,'{"enabled":false}');
    const off=new FakeTunnel(),forced=new RemoteKeeper(off,8788,new RemoteSettings(file),()=>{},clock().timers);
    assert.equal(forced.autostart({}),false);assert.equal(off.starts,0);
    assert.equal(forced.autostart({CAT_TUNNEL_AUTOSTART:'1'}),true);await flush();
    assert.equal(off.starts,1);assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:false});
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('a tunnel that dies while on comes back after 30 s, then 2 min, then every 10 min; a good start resets the backoff',async()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json');writeFileSync(file,'{"enabled":true}');
    const tunnel=new FakeTunnel(),c=clock(),keeper=new RemoteKeeper(tunnel,8788,new RemoteSettings(file),()=>{},c.timers);
    keeper.autostart({});await flush();assert.equal(tunnel.starts,1);
    tunnel.down();keeper.retry();keeper.retry();assert.deepEqual(c.live.map(t=>t.ms),[30_000]);
    tunnel.fail=true;await fire(c);assert.deepEqual(c.live.map(t=>t.ms),[120_000]);
    await fire(c);assert.deepEqual(c.live.map(t=>t.ms),[600_000]);
    await fire(c);assert.deepEqual(c.live.map(t=>t.ms),[600_000]);
    tunnel.fail=false;await fire(c);assert.equal(tunnel.origin,`https://t${tunnel.starts}.trycloudflare.com`);assert.equal(c.live.length,0);
    tunnel.down();keeper.retry();assert.deepEqual(c.live.map(t=>t.ms),[30_000]);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('stop cancels a pending retry; once off, a death schedules nothing; dispose blocks starts and writes nothing',async()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json');writeFileSync(file,'{"enabled":true}');
    const tunnel=new FakeTunnel(),c=clock(),keeper=new RemoteKeeper(tunnel,8788,new RemoteSettings(file),()=>{},c.timers);
    keeper.autostart({});await flush();
    tunnel.down();keeper.retry();assert.equal(c.live.length,1);
    await keeper.stop();assert.equal(c.live.length,0);
    tunnel.down();keeper.retry();assert.equal(c.live.length,0);
    writeFileSync(file,'{"enabled":true}');
    const second=new FakeTunnel(),k2=new RemoteKeeper(second,8788,new RemoteSettings(file),()=>{},c.timers);
    k2.autostart({CAT_TUNNEL_AUTOSTART:'1'});await flush();assert.equal(second.starts,1);
    k2.dispose();second.down();k2.retry();assert.equal(c.live.length,0);
    k2.autostart({CAT_TUNNEL_AUTOSTART:'1'});await flush();assert.equal(second.starts,1);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:true});
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('a damaged or missing remote-settings.json means off',()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json');
    assert.equal(new RemoteSettings(file).enabled,false);
    writeFileSync(file,'{broken');assert.equal(new RemoteSettings(file).enabled,false);
    writeFileSync(file,'[]');assert.equal(new RemoteSettings(file).enabled,false);
  }finally{rmSync(d,{recursive:true,force:true});}
});

// Devices picks the carrier (plan 5.1): remembered next to the on/off choice, and it wins over remote.provider in the config.
test('the carrier picked in Devices is saved with the on/off choice; an unknown one is ignored and leaves the choice alone',()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json');
    const settings=new RemoteSettings(file);assert.equal(settings.provider,undefined);
    settings.set(true);assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:true},'nothing picked, nothing saved');
    settings.choose('tailscale');assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:true,provider:'tailscale'});
    settings.set(false);assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:false,provider:'tailscale'});
    assert.equal(new RemoteSettings(file).provider,'tailscale');
    writeFileSync(file,'{"enabled":true,"provider":"funnel"}');
    const odd=new RemoteSettings(file);assert.equal(odd.provider,undefined);assert.equal(odd.enabled,true);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('switching carrier while on stops the old one, starts the new one and remembers it; while off it only remembers',async()=>{
  const d=dir();
  try{
    const file=join(d,'remote-settings.json'),quick=new FakeTunnel('cloudflare'),tailnet=new FakeTunnel('tailscale');
    const carrier=new RemoteCarrier({cloudflare:quick,tailscale:tailnet},'cloudflare');
    const keeper=new RemoteKeeper(carrier,8788,new RemoteSettings(file),()=>{},clock().timers);
    assert.equal(await keeper.start(),'https://t1.trycloudflare.com');
    assert.equal(carrier.status().provider,'cloudflare');
    assert.equal(await keeper.choose('tailscale'),'https://pc.tail1234.ts.net');
    assert.deepEqual([quick.stops,tailnet.starts],[1,1]);
    assert.deepEqual(carrier.status(),{origin:'https://pc.tail1234.ts.net',starting:false,named:false,provider:'tailscale'});
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:true,provider:'tailscale'});
    assert.equal(await keeper.choose('tailscale'),'https://pc.tail1234.ts.net','the same carrier again changes nothing');
    assert.deepEqual([quick.stops,tailnet.stops,tailnet.starts],[1,0,2]);
    await keeper.stop();
    assert.equal(await keeper.choose('cloudflare'),undefined,'off stays off');
    assert.equal(quick.starts,1);assert.equal(carrier.origin,undefined);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{enabled:false,provider:'cloudflare'});
    // The tests and the route matrix set an origin directly; it lands on the carrier in use.
    carrier.origin='https://matrix.trycloudflare.com';assert.equal(quick.origin,'https://matrix.trycloudflare.com');
    await assert.rejects(new RemoteKeeper(new FakeTunnel(),8788,new RemoteSettings(join(d,'other.json')),()=>{},clock().timers).choose('tailscale'),/one way to connect/);
  }finally{rmSync(d,{recursive:true,force:true});}
});

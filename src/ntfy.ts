import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {writeJsonAtomic} from './atomic-json.ts';
import {defaultSender,RateLimiter,type Sender} from './push.ts';
import {ErrorClock,healthOf,type Health} from './health.ts';
import {withSecrets,withoutSecrets} from './secret-store.ts';

// Ping channel for paired devices that have no Web Push (the Android WebView, plan 5.4). Each push-worthy notice POSTs one fixed,
// content-free line to the device's ntfy topic; the ntfy app shows it and a tap opens clowder://open. The topic is the only secret and
// lives in the SecretStore (ntfy.json devices.*.topic): whoever learns it can ping the phone, and reads nothing.
export const DEFAULT_NTFY='https://ntfy.sh';
export const PING_BODY='Clowder needs you — open the app';
export const PING_CLICK='clowder://open';
// Matches push.ts's per-kind window: at most one ping a minute per device, later notices coalesced into the next one.
const WINDOW_MS=60_000;

type Store={devices:Record<string,{topic:string;createdAt:string}>};
export type NtfyOptions={dataDir:string;server?:string;send?:Sender;now?:()=>number;
  later?:(fn:()=>void,ms:number)=>unknown;stopTimer?:(timer:any)=>void};

// https only, like the rendezvous relay: a topic is never sent over plain HTTP. A bad address stops the boot, since the owner set it.
export function ntfyServer(value:unknown):string{
  const url=new URL(String(value));
  if(url.protocol!=='https:'||url.search||url.hash||url.username||url.password)throw new Error('ntfy.server must be an https:// address.');
  return url.href.replace(/\/+$/,'');
}

export class NtfyService{
  readonly server:string;
  private readonly file:string;
  private readonly send:Sender;
  private readonly limiter:RateLimiter<null>;
  // The last ping that failed, while none has since succeeded (11.21). Kept in memory: a restart clears it.
  private readonly failing:ErrorClock;
  constructor(opts:NtfyOptions){
    this.server=ntfyServer(opts.server??DEFAULT_NTFY);
    this.file=resolve(opts.dataDir,'ntfy.json');
    this.send=opts.send??defaultSender;
    this.failing=new ErrorClock(opts.now??Date.now);
    // The limiter is keyed by device id; a delivery re-reads the store, so a device revoked while a ping waits gets nothing.
    this.limiter=new RateLimiter<null>(WINDOW_MS,id=>{void this.post(id);},opts.now??Date.now,opts.later,opts.stopTimer);
  }
  private read():Store{
    if(!existsSync(this.file))return {devices:{}};
    const data=withSecrets(this.file,JSON.parse(readFileSync(this.file,'utf8')));
    return {devices:data?.devices??{}};
  }
  private write(store:Store){writeJsonAtomic(this.file,withoutSecrets(this.file,store));}
  private urlFor(topic:string){return `${this.server}/${topic}`;}

  /** Opt in for one device: creates its topic (kept if it already has one) and returns the address the ntfy app subscribes to. */
  enable(device:string):{url:string}{
    const store=this.read();
    const topic=store.devices[device]?.topic??`clowder-${randomBytes(24).toString('hex')}`;
    store.devices[device]={topic,createdAt:store.devices[device]?.createdAt??new Date().toISOString()};
    this.write(store);
    return {url:this.urlFor(topic)};
  }
  /** Opt out, or revoke: the topic is deleted, so nothing more reaches it. */
  disable(device:string):boolean{
    const store=this.read();
    if(!store.devices[device])return false;
    delete store.devices[device];
    this.write(store);
    return true;
  }
  forget(device:string){this.disable(device);}
  /** The address is shown only while the device is enabled. */
  status(device:string):{enabled:boolean;url?:string}{
    const topic=this.read().devices[device]?.topic;
    return topic?{enabled:true,url:this.urlFor(topic)}:{enabled:false};
  }

  /** Called for every notice push.ts is asked to send. Test kind is push-only. Never throws: a damaged file loses pings, not notices. */
  ping(kind:string){
    if(kind==='test')return;
    let devices:string[];
    try{devices=Object.keys(this.read().devices);}catch{return;}
    for(const id of devices)this.limiter.submit(id,null);
  }
  private async post(device:string){
    const topic=this.read().devices[device]?.topic;
    if(!topic)return;
    // The error text is fixed: the topic is the secret, and a failure message may carry the address.
    try{const code=await this.send(this.urlFor(topic),{Title:'Clowder',Click:PING_CLICK,Priority:'default'},Buffer.from(PING_BODY));
      this.failing.set(code>=400?'The ntfy server refused a ping.':null);}
    catch{/* a failed ping is not retried; the next notice pings again */this.failing.set('The ntfy server could not be reached.');}
  }
  /** The integration contract (health.ts): off while no device is enabled; error while the last ping failed. */
  health():Health{
    let enabled:boolean;
    try{enabled=Object.keys(this.read().devices).length>0;}
    catch{return healthOf(true,'ntfy.json could not be read.',null);}
    return healthOf(enabled,this.failing.error,this.failing.since);
  }
  close(){this.limiter.close();}
}

// Owner on the main app only. devices: the paired devices that can be enabled (Devices lists the same ones).
export function registerNtfyRoutes(app:FastifyInstance,{service,allowed,devices}:{service:NtfyService;allowed:(req:FastifyRequest)=>boolean;devices:()=>{id:string;name:string}[]}){
  const deny=(res:FastifyReply)=>res.code(403).send({error:'Notifications are managed on the host computer.'});
  app.get('/api/ntfy',async(req,res)=>{
    if(!allowed(req))return deny(res);
    return {server:service.server,devices:devices().map(d=>({...d,...service.status(d.id)}))};
  });
  app.post('/api/ntfy/devices/:id/enable',async(req,res)=>{
    if(!allowed(req))return deny(res);
    const id=(req.params as {id:string}).id;
    if(!devices().some(d=>d.id===id))return res.code(404).send({error:'Unknown device.'});
    return service.enable(id);
  });
  app.post('/api/ntfy/devices/:id/disable',async(req,res)=>{
    if(!allowed(req))return deny(res);
    return {removed:service.disable((req.params as {id:string}).id)};
  });
}

import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {writeJsonAtomic} from './atomic-json.ts';
import {withSecrets,withoutSecrets} from './secret-store.ts';

// The town's current https address goes to a public relay (ntfy.sh by default), sealed with a key only paired devices hold.
// A paired app reads the topic and key from the town, then finds the new address after a restart. The relay sees the topic,
// the sealed text, and the IP addresses of the PC and the phone. remote.rendezvous:false turns it off.
export const DEFAULT_RELAY='https://ntfy.sh';
// ntfy keeps a message for 12 h (measured on ntfy.sh: expires - time = 43,200 s), so a message is re-sent every 6 h.
const REANNOUNCE_MS=6*60*60*1000,RETRY_MS=5*60*1000,WATCH_MS=5_000,SEND_TIMEOUT_MS=10_000;
const isOrigin=(value:string)=>{try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value;}catch{return false;}};

// AES-256-GCM over {"v":1,"origin","at"}, sent as base64url(iv || ciphertext || tag), no padding, no AAD.
// seal does not judge the origin; open does, so a tampered or foreign origin reads as null.
export function seal(origin:string,at:number,key:string,iv:Buffer=randomBytes(12)):string{
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64url'),iv);
  const body=Buffer.concat([cipher.update(JSON.stringify({v:1,origin,at}),'utf8'),cipher.final()]);
  return Buffer.concat([iv,body,cipher.getAuthTag()]).toString('base64url');
}
export function open(text:string,key:string):{origin:string;at:number}|null{
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(text))return null;
    const data=Buffer.from(text,'base64url');if(data.length<29)return null;
    const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64url'),data.subarray(0,12),{authTagLength:16});
    decipher.setAuthTag(data.subarray(-16));
    const plain=JSON.parse(Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]).toString('utf8'));
    if(plain?.v!==1||typeof plain.origin!=='string'||!isOrigin(plain.origin)||!Number.isFinite(plain.at))return null;
    return {origin:plain.origin,at:plain.at};
  }catch{return null;}
}

type Fetch=(url:string,init:RequestInit)=>Promise<Response>;
// <dataPath>/rendezvous.json holds the relay, topic and key, created on first use. A damaged file is never replaced silently:
// every paired app holds its topic, so a new one would strand them.
export class Rendezvous{
  readonly topic:string;readonly key:string;
  private last?:string;private sentAt=0;private failing=false;private timer?:ReturnType<typeof setInterval>;
  constructor(file:string,readonly relay:string,private fetcher:Fetch=(url,init)=>fetch(url,init),private now:()=>number=Date.now,private log:(message:string)=>void=message=>console.error(message)){
    const stored=existsSync(file)?withSecrets(file,JSON.parse(readFileSync(file,'utf8'))):undefined;
    if(stored!==undefined&&!(/^clowder-[0-9a-f]{48}$/.test(stored?.topic)&&/^[A-Za-z0-9_-]{43}$/.test(stored?.key)))throw new Error(`${file} is damaged. Delete it to make a new topic; paired apps then pair again.`);
    this.topic=stored?.topic??`clowder-${randomBytes(24).toString('hex')}`;
    this.key=stored?.key??randomBytes(32).toString('base64url');
    if(stored?.relay!==relay)writeJsonAtomic(file,withoutSecrets(file,{relay,topic:this.topic,key:this.key}));
  }
  // A failed announce is retried in five minutes, and only the first failure of a streak is logged. Never throws.
  async announce(origin:string){
    this.sentAt=this.now();
    try{
      const response=await this.fetcher(`${this.relay}/${this.topic}`,{method:'POST',body:seal(origin,this.now(),this.key),signal:AbortSignal.timeout(SEND_TIMEOUT_MS)});
      if(!response.ok)throw new Error(`the relay answered ${response.status}`);
      this.failing=false;
    }catch(error){
      this.sentAt=this.now()-REANNOUNCE_MS+RETRY_MS;
      if(!this.failing)this.log(`Remote access: the address was not announced to ${this.relay} (${(error as Error).message}). The town works without it.`);
      this.failing=true;
    }
  }
  // Announce a new or changed origin at once, and the same origin again every six hours while the tunnel is up.
  async tick(origin:string|undefined){
    if(origin!==this.last){this.last=origin;if(origin)await this.announce(origin);}
    else if(origin&&this.now()-this.sentAt>=REANNOUNCE_MS)await this.announce(origin);
  }
  // The tunnel's origin is polled, so a new address is announced within five seconds whatever path changed it.
  watch(read:()=>string|undefined){this.stop();this.timer=setInterval(()=>void this.tick(read()),WATCH_MS);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}

// remote.rendezvous:false turns the relay off. A bad relay address or a damaged file also turns it off, with one log line:
// the town never depends on the relay, so it must not fail to start over it.
export function rendezvousFor(dataDir:string,remote:{rendezvous?:unknown;rendezvousRelay?:unknown},log:(message:string)=>void=message=>console.error(message)):Rendezvous|null{
  if(remote.rendezvous===false)return null;
  try{
    const url=new URL(String(remote.rendezvousRelay??DEFAULT_RELAY));
    if(url.protocol!=='https:'||url.search||url.hash)throw new Error('remote.rendezvousRelay must be an https:// address.');
    return new Rendezvous(resolve(dataDir,'rendezvous.json'),url.href.replace(/\/+$/,''),undefined,undefined,log);
  }catch(error){log(`Rendezvous is off: ${(error as Error).message}`);return null;}
}

// The topic and key, for a paired device on the remote listener and for the owner on the main app. Off: 404.
export function registerRendezvousRoute(app:FastifyInstance,current:()=>Rendezvous|null,allowed:(req:FastifyRequest)=>boolean){
  app.get('/api/remote/rendezvous',async(req,reply)=>{
    if(!allowed(req))return reply.code(403).send({error:'Device access is managed on the host computer.'});
    const rendezvous=current();
    if(!rendezvous)return reply.code(404).send({error:'The address relay is off (remote.rendezvous is false).'});
    return {relay:rendezvous.relay,topic:rendezvous.topic,key:rendezvous.key};
  });
}

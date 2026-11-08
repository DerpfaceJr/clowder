import {existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';
import {dropSecrets,withSecrets,withoutSecrets} from './secret-store.ts';
import {ChannelPairing,answerTap,channelNotice,type ChatButton,type TownLike} from './chat-channel.ts';
import type {Pairing} from './pairing.ts';
import {clean} from './push.ts';
import type {State} from './store.ts';

// Discord channel (plan 3.5, D7): the official API with no dependency and no public URL. Messages and button taps arrive over the Gateway
// on the built-in WebSocket; sends go to the REST API with fetch. Owner only: the DM that sends the one-time code from Clowder is paired as
// a device named Discord (Devices revokes it), and every other user, the bot itself and every server (guild) are ignored. The owner rule,
// notices and button answers are chat-channel.ts, shared with telegram.ts; this module is the transport.
export type Rest=(method:'GET'|'POST',path:string,body?:unknown)=>Promise<any>;
export type Sock={send(data:string):void;close(code?:number):void;onmessage:((e:{data:unknown})=>void)|null;onclose:((e:{code:number})=>void)|null;onerror:((e:unknown)=>void)|null};
type Saved={token:string;bot:string;botId:string;user?:string;channel?:string;device?:string;deviceToken?:string};
export type DiscordOptions={dataDir:string;pairing:Pairing;town:()=>TownLike;mode:()=>string;rest?:(token:string)=>Rest;socket?:(url:string)=>Sock;retryMs?:number;now?:()=>number};

const API='https://discord.com/api/v10',GATEWAY='wss://gateway.discord.gg',QUERY='/?v=10&encoding=json';
// DIRECT_MESSAGES only: a DM's text needs no privileged Message Content intent, and button taps (interactions) need no intent at all.
const INTENTS=1<<12;
const MAX_TEXT=2000,SLOT='discord',DEVICE='discord',ID=/^\d{1,20}$/,RESUME=/^wss:\/\/[\w.-]+\.discord\.gg\/?$/;
// Close codes that fail again on every retry: bad token, sharding, API version, intents. Discord stays off until the token is added again.
const FATAL=new Set([4004,4010,4011,4012,4013,4014]);
const cut=(text:string)=>text.length>MAX_TEXT?`${text.slice(0,MAX_TEXT-1)}…`:text||'…';
// Model-written text cannot hide where a link goes: [text](url) needs the brackets, so they (and the escape itself) are escaped.
const plain=(text:string)=>text.replace(/[\\[\]]/g,'\\$&');

/** The real REST API. The token is only in a header, so an error carries Discord's status and message and never the token. */
export const restApi=(token:string,fetchImpl:typeof fetch=fetch):Rest=>async(method,path,body)=>{
  let res:Response;
  try{res=await fetchImpl(API+path,{method,headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json','User-Agent':'DiscordBot (https://github.com/DerpfaceJr/clowder, 0.1)'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15_000)});}
  catch{throw new Error('Discord is unreachable.');}
  const data=res.status===204?null:await res.json().catch(()=>null) as {message?:unknown}|null;
  if(!res.ok)throw new Error(`Discord ${res.status}: ${clean(data?.message??'no answer',160)}`);
  return data;
};

export class DiscordChannel{
  private saved:Saved|null=null;
  private rest:Rest|null=null;
  private ws?:Sock;
  private beat?:ReturnType<typeof setInterval>;
  private retry?:ReturnType<typeof setTimeout>;
  private acked=true;
  private running=false;
  private connected=false;
  // The Gateway session a new socket resumes, so nothing sent while it was down is lost. In memory: a restart identifies afresh.
  private session?:{id:string;url:string};
  private seq:number|null=null;
  private wait=0;
  private lastEventId?:string;
  private link:ChannelPairing;
  // ponytail: in memory, as in telegram.ts, so a restart stops relaying the Mayor's replies to messages sent before it.
  private relayed=new Set<string>();
  error:string|null=null;
  constructor(private o:DiscordOptions){
    this.link=new ChannelPairing(o.pairing,SLOT,'Discord',()=>this.now());
    // A damaged file leaves Discord off (the owner adds the token again) rather than stopping the server.
    try{const v=existsSync(this.file)?withSecrets(this.file,JSON.parse(readFileSync(this.file,'utf8'))):null;if(typeof v?.token==='string'){this.saved=v;this.rest=(o.rest??restApi)(v.token);}}
    catch{this.error='discord.json could not be read. Add the bot token again.';}
  }
  private get file(){return join(this.o.dataDir,'discord.json');}
  private now(){return (this.o.now??Date.now)();}
  // The token and device token go to the secret store; discord.json keeps the rest.
  private save(){if(this.saved)writeJsonAtomic(this.file,withoutSecrets(this.file,this.saved));}
  /** For secret masking (server.ts secrets()). */
  secret(){return this.saved?.token??'';}
  /** The paired DM channel, while its device is still in Devices. */
  private dm():string|null{const s=this.saved;return s?.channel&&this.link.listed(s.device)?s.channel:null;}
  status(){return {configured:!!this.saved,bot:this.saved?.bot??null,paired:this.dm()!==null,connected:this.connected,error:this.error};}

  /** Checks the token with /users/@me before keeping it. A new bot drops the old DM's pairing; a new token for the same bot keeps it. */
  async setToken(token:string){
    if(!/^[\w-]{20,40}\.[\w-]{4,12}\.[\w-]{20,60}$/.test(token))throw new Error('Paste the bot token from the Discord Developer Portal (Bot, Reset Token).');
    const rest=(this.o.rest??restApi)(token),me=await rest('GET','/users/@me');
    if(!me?.bot||typeof me.username!=='string'||!ID.test(String(me.id)))throw new Error('That token is not a bot’s.');
    this.stop();
    const same=this.saved?.botId===String(me.id);
    if(!same)this.unpair();
    this.saved={...(same?this.saved:{}),token,bot:clean(me.username,64),botId:String(me.id)};this.rest=rest;this.error=null;this.save();
    this.start();
  }
  remove(){this.stop();this.unpair();this.saved=null;this.rest=null;this.error=null;rmSync(this.file,{force:true});dropSecrets(this.file);}
  private unpair(){this.link.revoke(this.saved?.device);}
  /** A one-time owner code in its own slot: a phone's open code is untouched, and only this DM flow accepts it. */
  pairCode(){
    if(!this.saved)throw new Error('Add the bot token first.');
    const invite=this.link.code();
    return {code:invite.code,expiresAt:invite.expiresAt,bot:this.saved.bot};
  }

  start(){if(!this.rest||this.running)return;this.running=true;this.wait=this.o.retryMs??5000;this.connect();}
  stop(){this.running=false;clearTimeout(this.retry);this.drop(1000);this.forget();}
  /** Closes the socket with its handlers off. 1000 ends the session on Discord's side; 4000 keeps it to resume. */
  private drop(code:number){
    clearInterval(this.beat);this.connected=false;
    const ws=this.ws;this.ws=undefined;if(!ws)return;
    ws.onmessage=null;ws.onclose=null;ws.onerror=null;
    try{ws.close(code);}catch{/* already closed */}
  }
  private forget(){this.session=undefined;this.seq=null;}
  private connect(){
    const url=(this.session?.url??GATEWAY)+QUERY;
    try{this.ws=(this.o.socket??(u=>new WebSocket(u) as unknown as Sock))(url);}catch(err){this.error=clean((err as Error).message,160);return this.later();}
    const ws=this.ws;
    ws.onmessage=e=>{let p;try{p=JSON.parse(String(e.data));}catch{return;}this.frame(p).catch(err=>{this.error=clean((err as Error).message,160);});};
    ws.onclose=e=>this.closed(e.code);
    ws.onerror=()=>{};// a close follows
  }
  /** The next socket after the wait, which doubles up to five minutes and resets once Discord says READY or RESUMED. */
  private later(){
    clearTimeout(this.retry);
    this.retry=setTimeout(()=>{if(this.running&&!this.ws)this.connect();},this.wait);this.retry.unref?.();
    this.wait=Math.min(this.wait*2,300_000);
  }
  private reconnect(){this.drop(4000);this.later();}
  private closed(code:number){
    this.drop(4000);
    if(!this.running)return;
    if(FATAL.has(code)){this.running=false;this.forget();this.error=code===4004?'Discord refused the bot token. Add it again.':`Discord closed the connection (${code}).`;return;}
    if(code===4007||code===4009)this.forget();// bad sequence or timed out: the session cannot be resumed
    this.later();
  }
  private put(payload:object){try{this.ws?.send(JSON.stringify(payload));}catch{/* a close follows */}}
  /** A missed acknowledgement means a dead connection that has not closed yet: drop it and resume on a new one. */
  private heartbeat(){if(!this.acked)return this.reconnect();this.acked=false;this.put({op:1,d:this.seq});}

  /** One Gateway payload (op 10 hello, 11 heartbeat ack, 1 heartbeat now, 7 reconnect, 9 invalid session, 0 dispatch). */
  private async frame(p:any){
    if(typeof p?.s==='number')this.seq=p.s;
    const token=this.saved?.token;if(!token)return;
    if(p?.op===10){
      clearInterval(this.beat);this.acked=true;
      this.beat=setInterval(()=>this.heartbeat(),Math.max(1000,Number(p.d?.heartbeat_interval)||41_250));this.beat.unref?.();
      this.put(this.session?{op:6,d:{token,session_id:this.session.id,seq:this.seq}}:{op:2,d:{token,intents:INTENTS,properties:{os:process.platform,browser:'clowder',device:'clowder'}}});
      return;
    }
    if(p?.op===11){this.acked=true;return;}
    if(p?.op===1)return this.put({op:1,d:this.seq});
    if(p?.op===7)return this.reconnect();
    if(p?.op===9){if(!p.d)this.forget();return this.reconnect();}// d says whether the session can still be resumed
    if(p?.op!==0)return;
    const d=p.d;
    if(p.t==='READY'){const url=String(d?.resume_gateway_url??'');this.session={id:String(d?.session_id),url:RESUME.test(url)?url.replace(/\/$/,''):GATEWAY};}
    if(p.t==='READY'||p.t==='RESUMED'){this.connected=true;this.error=null;this.wait=this.o.retryMs??5000;return;}
    if(p.t==='MESSAGE_CREATE')return this.message(d);
    if(p.t==='INTERACTION_CREATE')return this.tap(d);
  }

  private async message(d:any){
    // Only a person's direct message: a server (guild) message, the bot's own messages and other bots never count.
    if(!d||d.guild_id!=null||d.author?.bot||typeof d.content!=='string'||!ID.test(String(d.channel_id))||!ID.test(String(d.author?.id))||String(d.author.id)===this.saved?.botId)return;
    const text=d.content.trim(),user=String(d.author.id),channel=String(d.channel_id);
    if(this.link.wants(text)&&!this.owner(user,channel))return this.pairDm(user,channel,text);
    if(!this.owner(user,channel)||!text)return;
    try{this.relayed.add(this.o.town().inbox(text,this.o.mode()));}
    catch(err){await this.send(channel,`Not sent: ${(err as Error).message}`);}
  }
  /** A button tap. Only a component tap from the owner in the paired DM is answered; any other gets nothing, as a stranger's message gets nothing. */
  private async tap(d:any){
    if(d?.type!==3||d.guild_id!=null||!ID.test(String(d.id))||!/^[\w.-]{1,500}$/.test(String(d.token))||!this.owner(String(d.user?.id),String(d.channel_id??d.channel?.id)))return;
    const r=answerTap(this.o.town(),d.data?.custom_id,DEVICE);
    // Answered: the buttons go and the answer is added under the notice. Not answered: a reply only the owner sees, and the buttons stay.
    const reply=r.ok?{type:7,data:{content:cut(`${String(d.message?.content??'')}\n\n${plain(r.reply)}`),components:[],allowed_mentions:{parse:[]}}}:{type:4,data:{content:plain(r.reply),flags:64,allowed_mentions:{parse:[]}}};
    try{await this.rest?.('POST',`/interactions/${d.id}/${d.token}/callback`,reply);}catch(err){this.error=(err as Error).message;}
  }
  private owner(user:string,channel:string){const s=this.saved;return !!s&&s.user===user&&s.channel===channel&&this.link.owner(s.device,s.deviceToken);}
  private async pairDm(user:string,channel:string,code:string){
    const paired=this.link.pair(code);if(!paired)return;
    this.unpair();
    Object.assign(this.saved!,{user,channel,...paired});this.save();
    await this.send(channel,'Paired with Clowder. What you write here goes to the Mayor, and decisions come here too.');
  }

  /** Hooks the store like push.ts: listeners get no arguments, so the newest event is read from the state. */
  attach(source:{readonly state:State;listeners:Set<()=>void>}){source.listeners.add(()=>this.onStore(source.state));}
  onStore(state:State){
    const event=state.events.at(-1);
    if(!event||event.id===this.lastEventId)return;
    this.lastEventId=event.id;
    const channel=this.dm();if(channel===null)return;
    const out=channelNotice(event,state,this.relayed);if(out)void this.send(channel,out.text,out.buttons);
  }
  // No mentions are parsed, so model-written text cannot ping anyone.
  private async send(channel:string,text:string,buttons:ChatButton[]=[]){
    const components=buttons.length?{components:[{type:1,components:buttons.map(b=>({type:2,style:b.approved?1:2,label:b.label,custom_id:b.data}))}]}:{};
    try{await this.rest?.('POST',`/channels/${channel}/messages`,{content:cut(plain(text)),allowed_mentions:{parse:[]},...components});}catch(err){this.error=(err as Error).message;}
  }
}

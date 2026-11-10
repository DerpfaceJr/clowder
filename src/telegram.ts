import {existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';
import {ChannelPairing,ListNotices,answerTap,channelNotice,type TownLike} from './chat-channel.ts';
import {dropSecrets,withSecrets,withoutSecrets} from './secret-store.ts';
import type {Pairing} from './pairing.ts';
import type {OwnerVerbs} from './owner-verbs.ts';
import {clean} from './push.ts';
import {ErrorClock,healthOf,type Health} from './health.ts';
import type {State} from './store.ts';

// Telegram channel (plan 3.5, D7): the official Bot API over plain fetch with long polling, so no public URL and no dependency. Owner only:
// the chat that sends the one-time code from Clowder is paired as a device named Telegram (Devices revokes it), and every other chat is
// ignored. The owner rule, notices and button answers are chat-channel.ts, shared with discord.ts; this module is the transport.
export type BotApi=(method:string,body:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>;
type Saved={token:string;bot:string;chat?:number;device?:string;deviceToken?:string;offset?:number};
// remote: the remote address when one exists, so a notice links to /#item=<id>.
// verbs: the owner verbs (11.25), so to-dos and failed requests get Mark done, Remind me tomorrow and Retry buttons.
export type TelegramOptions={dataDir:string;pairing:Pairing;town:()=>TownLike;mode:()=>string;api?:(token:string)=>BotApi;retryMs?:number;now?:()=>number;remote?:()=>string|undefined;verbs?:OwnerVerbs};

const POLL_SECONDS=25,MAX_TEXT=4000,SLOT='telegram',DEVICE='telegram';
const cut=(text:string)=>text.length>MAX_TEXT?`${text.slice(0,MAX_TEXT-1)}…`:text;

/** The real Bot API. The token is in every URL, so an error carries only Telegram's status and description, never the URL. */
export const botApi=(token:string,fetchImpl:typeof fetch=fetch):BotApi=>async(method,body,signal)=>{
  let res:Response;
  try{res=await fetchImpl(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout((POLL_SECONDS+15)*1000),...(signal?[signal]:[])])});}
  catch{throw new Error('Telegram is unreachable.');}
  const data=await res.json().catch(()=>null) as {ok?:boolean;result?:unknown;description?:string}|null;
  if(!data?.ok)throw new Error(`Telegram ${res.status}: ${clean(data?.description??'no answer',160)}`);
  return data.result;
};

export class TelegramChannel{
  private saved:Saved|null=null;
  private api:BotApi|null=null;
  private abort?:AbortController;
  private lastEventId?:string;
  private link:ChannelPairing;
  // ponytail: in memory, so a restart stops relaying the Mayor's replies to messages sent before it. Persist if that matters.
  private relayed=new Set<string>();
  private notices:ListNotices;
  // Every `this.error=` below goes through the clock, so health() knows when the current error began (11.21).
  private clock=new ErrorClock(()=>this.now());
  get error(){return this.clock.error;}
  set error(v:string|null){this.clock.set(v);}
  constructor(private o:TelegramOptions){
    this.link=new ChannelPairing(o.pairing,SLOT,'Telegram',()=>this.now());
    this.notices=new ListNotices(()=>o.remote?.(),o.verbs);
    // A damaged file leaves Telegram off (the owner adds the token again) rather than stopping the server.
    try{const v=existsSync(this.file)?withSecrets(this.file,JSON.parse(readFileSync(this.file,'utf8'))):null;if(typeof v?.token==='string'){this.saved=v;this.api=(o.api??botApi)(v.token);}}
    catch{this.error='telegram.json could not be read. Add the bot token again.';}
  }
  private get file(){return join(this.o.dataDir,'telegram.json');}
  private now(){return (this.o.now??Date.now)();}
  private save(){if(this.saved)writeJsonAtomic(this.file,withoutSecrets(this.file,this.saved));}
  /** For secret masking (server.ts secrets()). */
  secret(){return this.saved?.token??'';}
  /** The paired chat, while its device is still in Devices. */
  private chat():number|null{const s=this.saved;return s?.chat!==undefined&&this.link.listed(s.device)?s.chat:null;}
  status(){return {configured:!!this.saved,bot:this.saved?.bot??null,paired:this.chat()!==null,polling:!!this.abort,error:this.error};}
  /** The integration contract (health.ts): off without a token, error while the last call failed. */
  health():Health{return healthOf(!!this.saved,this.clock.error,this.clock.since);}

  /** Checks the token with getMe before keeping it. A new bot drops the old chat's pairing; a new token for the same bot keeps it. */
  async setToken(token:string){
    if(!/^\d{5,16}:[\w-]{30,64}$/.test(token))throw new Error('Paste the token BotFather gave you.');
    const api=(this.o.api??botApi)(token),me=await api('getMe',{});
    if(!me?.is_bot||typeof me.username!=='string')throw new Error('That token is not a bot’s.');
    this.stop();
    const same=this.saved?.token.split(':')[0]===token.split(':')[0];
    if(!same)this.unpair();
    this.saved={...(same?this.saved:{}),token,bot:`@${clean(me.username,64)}`};this.api=api;this.error=null;this.save();
    this.start();
  }
  remove(){this.stop();this.unpair();this.saved=null;this.api=null;this.error=null;rmSync(this.file,{force:true});dropSecrets(this.file);}
  private unpair(){this.link.revoke(this.saved?.device);}
  /** A one-time owner code in its own slot: a phone's open code is untouched, and only this chat flow accepts it. */
  pairCode(){
    if(!this.saved)throw new Error('Add the bot token first.');
    const invite=this.link.code();
    return {code:invite.code,expiresAt:invite.expiresAt,bot:this.saved.bot};
  }

  start(){
    if(!this.api||this.abort)return;
    const ctl=this.abort=new AbortController();
    void (async()=>{
      let wait=this.o.retryMs??5000;
      while(!ctl.signal.aborted){
        try{await this.pollOnce(ctl.signal);this.error=null;wait=this.o.retryMs??5000;}
        catch(err){
          if(ctl.signal.aborted)break;
          // A revoked token (401) or a webhook on the bot (409) fails every poll: back off to five minutes.
          this.error=(err as Error).message;
          await new Promise(r=>{const t=setTimeout(r,wait);ctl.signal.addEventListener('abort',()=>{clearTimeout(t);r(undefined);},{once:true});});
          wait=Math.min(wait*2,300_000);
        }
      }
    })();
  }
  stop(){this.abort?.abort();this.abort=undefined;}

  /** One long poll. The offset moves past each update before it is handled, so a failing update is never fetched again. */
  async pollOnce(signal?:AbortSignal){
    const api=this.api,saved=this.saved;if(!api||!saved)return;
    const updates=await api('getUpdates',{...(saved.offset?{offset:saved.offset}:{}),timeout:POLL_SECONDS,allowed_updates:['message','callback_query']},signal);
    if(!Array.isArray(updates)||!updates.length)return;
    for(const u of updates){
      if(Number.isSafeInteger(u?.update_id))saved.offset=u.update_id+1;
      try{await this.handle(u);}catch(err){this.error=(err as Error).message;}
    }
    if(this.saved===saved)this.save();
  }

  private async handle(u:any){
    const m=u?.message,q=u?.callback_query;
    if(m&&typeof m.text==='string'&&m.chat?.type==='private'&&Number.isSafeInteger(m.chat.id)){
      const text=m.text.trim(),code=text.replace(/^\/start\s+/,'');
      if(this.link.wants(code)&&m.chat.id!==this.chat())return this.pairChat(m.chat.id,code);
      if(!this.owner(m.chat.id)||!text||text==='/start')return;
      try{this.relayed.add(this.o.town().inbox(text,this.o.mode(),undefined,'Telegram'));}
      catch(err){await this.send(m.chat.id,`Not sent: ${(err as Error).message}`);}
      return;
    }
    if(q&&typeof q.id==='string'){
      const chat=q.message?.chat?.id;
      if(!this.owner(chat))return;
      const r=answerTap(this.o.town(),q.data,DEVICE,this.o.verbs);
      if(r.ok)await this.api!('editMessageReplyMarkup',{chat_id:chat,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}}).catch(()=>undefined);
      await this.api!('answerCallbackQuery',{callback_query_id:q.id,text:r.reply});
    }
  }
  private owner(chat:unknown){return chat!==undefined&&chat===this.chat()&&this.link.owner(this.saved?.device,this.saved?.deviceToken);}
  private async pairChat(chat:number,code:string){
    const paired=this.link.pair(code);if(!paired)return;
    this.unpair();
    Object.assign(this.saved!,{chat,...paired});this.save();
    await this.send(chat,'Paired with Clowder. What you write here goes to the Mayor, and decisions come here too.');
  }

  /** Hooks the store like push.ts: listeners get no arguments, so the newest event is read from the state. */
  attach(source:{readonly state:State;listeners:Set<()=>void>}){this.notices.baseline(source.state);source.listeners.add(()=>this.onStore(source.state));}
  onStore(state:State){
    // 11.10: decisions and to-dos that just joined the Needs-you list, each once.
    const chat=this.chat(),fresh=this.notices.fresh(state);
    if(chat!==null)for(const out of fresh)void this.send(chat,out.text,out.buttons.length?{inline_keyboard:[out.buttons.map(b=>({text:b.label,callback_data:b.data}))]}:undefined);
    const event=state.events.at(-1);
    if(!event||event.id===this.lastEventId)return;
    this.lastEventId=event.id;
    const out=channelNotice(event,this.relayed);
    if(out&&chat!==null)void this.send(chat,out.text);
  }
  // No parse_mode: model-written text is sent as plain text, so it cannot add links or formatting.
  private async send(chat:number,text:string,markup?:object){
    try{await this.api?.('sendMessage',{chat_id:chat,text:cut(text),...(markup?{reply_markup:markup}:{})});}catch(err){this.error=(err as Error).message;}
  }
}

import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {approvalDetail} from '../public/connectors-panel.js';
import type {Pairing} from './pairing.ts';
import type {Quest} from './quests.ts';
import type {OwnerVerbs} from './owner-verbs.ts';
import {ListAnnouncer,clean,questNotice,quickActions,storeQuestInput} from './push.ts';
import type {State} from './store.ts';

// What the outside chat channels (telegram.ts, discord.ts; plan 3.5, D7) share, so each rule is in one place: who the owner is, what a
// decision notice says and which buttons it has, and what a tapped button may answer. Each channel module is only its transport.
export type TownLike={store:{state:State};inbox(text:string,mode:string,origin?:'suggestion',via?:string):string;decide(id:string,answer:string,approved:boolean,device?:string):void};
export type ChatButton={label:string;data:string;approved:boolean};

const CODE=/^[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}$/i;

/** The owner rule. A chat becomes the owner's by sending the one-time code made in Clowder (its own pairing slot, so a phone's code is
 *  never touched and a phone never pairs with it), and is an owner device named after the channel that Devices can revoke. */
export class ChannelPairing{
  // Pairing is tried only while a code made in Clowder is open, so a stranger's texts never use up the shared pairing attempts.
  private codeUntil=0;
  constructor(private pairing:Pairing,private slot:string,private name:string,private now:()=>number){}
  code(){const invite=this.pairing.create('owner',this.slot);this.codeUntil=invite.expiresAt;return invite;}
  wants(text:string){return this.now()<this.codeUntil&&CODE.test(text);}
  /** A wrong code gives null and gets no answer: the chat is not the owner's yet. */
  pair(code:string){
    try{const p=this.pairing.pair(code,this.name,this.slot);this.codeUntil=0;return {device:p.device.id,deviceToken:p.token};}catch{return null;}
  }
  /** The paired device is still in Devices. */
  listed(device?:string){return !!device&&this.pairing.list().some(d=>d.id===device);}
  /** Checked with the device token on every message: that renews it, as a phone's requests renew its cookie. */
  owner(device?:string,deviceToken?:string){return this.listed(device)&&this.pairing.authenticate(deviceToken??'')?.id===device;}
  revoke(device?:string){if(device)this.pairing.revoke(device);}
}

/** A Mayor's reply to a message that came from this chat (relayed), or null. Decisions and owner steps come from ListNotices (11.10). */
export function channelNotice(event:{type:string;data:any},relayed:Set<string>):{text:string}|null{
  const d=event.data;
  if(event.type==='message'&&d?.from==='mayor'&&d?.to==='owner'&&relayed.has(d.task))return {text:String(d.text??'')};
  return null;
}

/** One Needs-you or trouble item as a chat notice: the push notice's own text, its link when a remote address exists, and buttons: answers
 *  only by class (quickActions on the decision's record), else the owner verbs it offers (11.25, owner-verbs.ts), as on a push. A purchase,
 *  or a decision that is public, money or delete, has none and says to open Clowder. verbs: the channel can act on a verb tap. */
export function listNotice(q:Quest,approvals:({id:string}&Parameters<typeof quickActions>[0])[],remote?:string,verbs?:OwnerVerbs):{text:string;buttons:ChatButton[]}{
  const item=questNotice(q,approvals);
  const record=q.source.kind==='approval'?approvals.find(a=>a.id===q.source.id):undefined;
  const detail=record&&q.band!=='trouble'?approvalDetail(record):'';
  const answers=(item.actions??[]).map((a,i)=>({label:clean(a.answer,40),data:`a:${item.approval}:${i}`,approved:a.approved}));
  const buttons=answers.length||!verbs?answers:verbs.buttons(q);
  return {text:[item.body,detail,remote?`${remote}${item.url}`:'',buttons.length?'':'Open Clowder to answer.'].filter(Boolean).join('\n\n'),buttons};
}

/** The chat channel's announcer: the same new Needs-you and trouble ids push announces, each once. remote: the remote address, when there
 *  is one, so the notice carries /#item=<id> as a full link. verbs: the owner verbs (11.25); with them the list is the host's full one, as
 *  push reads it (a failed request, a payment), and to-dos and trouble get verb buttons. Without them, the store's list and no verb buttons. */
export class ListNotices{
  private readonly list:ListAnnouncer;
  constructor(private remote:()=>string|undefined=()=>undefined,private verbs?:OwnerVerbs){this.list=new ListAnnouncer(verbs?state=>verbs.input(state):storeQuestInput);}
  baseline(state:State){this.list.baseline(state);}
  fresh(state:State):{text:string;buttons:ChatButton[]}[]{return this.list.fresh(state).map(q=>listNotice(q,state.approvals??[],this.remote(),this.verbs));}
}

/** A tapped button. The answer is worked out again from the stored decision, so made-up button data can never answer a publish, money or delete call.
 *  A verb button (v:, 11.25) goes to the owner verbs, which check the item and the verb again; a channel without them refuses it. */
export function answerTap(town:TownLike,data:unknown,device:string,verbs?:OwnerVerbs):{ok:boolean;reply:string}{
  if(String(data).startsWith('v:')){const r=verbs?.tap(data,device);return r?{ok:r.ok,reply:clean(r.reply,180)}:{ok:false,reply:'Open Clowder to do this one.'};}
  const [,id,n]=/^a:([\w-]{1,60}):(\d)$/.exec(String(data))??[];
  const a=town.store.state.approvals.find(x=>x.id===id),pick=a?quickActions(a)[Number(n)]:undefined;
  try{
    if(!a||!pick)throw new Error('Open Clowder to answer this one.');
    town.decide(a.id,pick.answer,pick.approved,device);return {ok:true,reply:`${pick.answer}: sent.`};
  }catch(err){return {ok:false,reply:clean((err as Error).message,180)};}
}

/** Host only: the token is a secret and the pairing code makes an owner device, like the phone invite in Devices. */
export function registerChannelRoutes(app:FastifyInstance,path:string,label:string,channel:{status():unknown;setToken(token:string):Promise<void>;pairCode():unknown;remove():void},allowed:(req:FastifyRequest)=>boolean){
  const gate=async(req:FastifyRequest,res:FastifyReply)=>{if(!allowed(req))return res.code(403).send({error:`${label} is set up on the host computer.`});};
  app.get(`/api/${path}`,{onRequest:gate},async()=>channel.status());
  app.post(`/api/${path}/token`,{onRequest:gate,schema:{body:{type:'object',required:['token'],additionalProperties:false,properties:{token:{type:'string',minLength:1,maxLength:100}}}}},async req=>{await channel.setToken((req.body as {token:string}).token.trim());return channel.status();});
  app.post(`/api/${path}/pair`,{onRequest:gate},async()=>channel.pairCode());
  app.post(`/api/${path}/remove`,{onRequest:gate},async()=>{channel.remove();return channel.status();});
}

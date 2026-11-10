// Plan 11.25 (N14): what the owner may do to a Needs-you item from outside the app: push actions (sw.js), Telegram and Discord buttons.
// One rule set. verbsFor() says which verbs a notice offers; act() checks the verb again on the server against the live list, as answerTap
// (chat-channel.ts) re-derives an answer, so a tap on an item that left the list, or was already settled, is refused and never applied twice.
// Answer stays answerTap and /api/approvals/:id, where quickActions decides: public, money and delete decisions open the card (D1), and a
// purchase has no verb at all. Open is the notice's own /#item= link. A chat message never reaches here: only button data and the route below.
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {quickActions} from './push.ts';
import {quests,type Quest,type QuestInput} from './quests.ts';
import type {State} from './store.ts';

export type Verb='done'|'remind'|'retry';
export const VERBS:Verb[]=['done','remind','retry'];
const LABEL:Record<Verb,string>={done:'Mark done',remind:'Remind me tomorrow',retry:'Retry'};
export type VerbButton={verb:Verb;label:string;primary:boolean};
// Mark done from outside is for a plain to-do. A connect needs its sign-in, a payment its money and an identity step its owner, so those
// close only on the card; so does a step that finishes on the computer running Clowder (the cats' browser), since the owner is away from it.
const CARD_ONLY_KINDS=new Set(['payment','identity']);

/** The verbs a Needs-you or trouble item offers outside the app, by the same rules as the card's buttons (quests-panel.js), never wider. */
export function verbsFor(q:Quest):VerbButton[]{
  const out:Verb[]=[];
  if(q.band==='needs'&&q.source.kind==='owner-step'){
    if(!q.connect&&!CARD_ONLY_KINDS.has(q.stepKind??'')&&!q.computer)out.push('done');
    // Only to-dos, as on the card: a Payment's 72 h approval could end while it is away.
    out.push('remind');
  }
  if(q.band==='trouble'&&q.source.kind==='project')out.push('retry');
  return out.map(verb=>({verb,label:LABEL[verb],primary:verb!=='remind'}));
}

/** 9:00 tomorrow on the host's clock. The card's tomorrowAt (quests-panel.js) uses the device's clock; that module is DOM-only. */
export function tomorrowNine(now:number):string{const d=new Date(now);d.setDate(d.getDate()+1);d.setHours(9,0,0,0);return d.toISOString();}

export type VerbTown={decide(id:string,answer:string,approved:boolean,device?:string):unknown;ownerStepDone(actor:string,id:string,note:string,device?:string):string;hideQuest(actor:string,id:string,at:string|null,until?:string|null):void;retry(rootId:string):string};
export type VerbResult={ok:boolean;status:number;reply:string};
// A chat button's data: Telegram allows 64 bytes, so a button that would not fit is dropped (the notice's link still opens the card).
const MAX_DATA=64,DATA=/^v:(done|remind|retry):([\w:-]{1,120})$/;
const SETTLED='This one is already settled.';

/** input: the quests() input for the owner's full list (the host's, as push uses). */
export class OwnerVerbs{
  constructor(private o:{town:()=>VerbTown;state:()=>State;input:(state:State)=>QuestInput;now?:()=>number}){}
  input(state:State){return this.o.input(state);}
  /** A chat notice's verb buttons for one item. */
  buttons(q:Quest){return verbsFor(q).map(v=>({label:v.label,data:`v:${v.verb}:${q.id}`,approved:v.primary})).filter(b=>Buffer.byteLength(b.data)<=MAX_DATA);}
  /** The owner acts on item id. The item must still be on the list, and the verb one it offers now; the town then checks its own rule again. */
  act(id:string,verb:string,device:string):VerbResult{
    const q=quests(this.o.input(this.o.state())).find(x=>x.id===id&&(x.band==='needs'||x.band==='trouble'));
    if(!q)return {ok:false,status:409,reply:SETTLED};
    if(!verbsFor(q).some(v=>v.verb===verb))return {ok:false,status:403,reply:'Open Clowder to do this one.'};
    try{
      const town=this.o.town();
      if(verb==='done')return {ok:true,status:200,reply:town.ownerStepDone('owner',q.source.id,'',device)};
      if(verb==='remind'){town.hideQuest('owner',q.id,q.at,tomorrowNine((this.o.now??Date.now)()));return {ok:true,status:200,reply:'It comes back tomorrow at 9:00.'};}
      town.retry(q.source.id);return {ok:true,status:200,reply:'Running it again.'};
    }catch(err){return {ok:false,status:409,reply:String((err as Error).message).slice(0,180)};}
  }
  /** Answer a decision by one of its quick answers' exact words (11.28, the owner MCP), as answerTap (chat-channel.ts) re-derives a button's:
   *  quickActions on the stored record decides, so a public, money or delete call, a purchase and every other gate open the card (D1). */
  answer(id:string,answer:unknown,device:string):VerbResult{
    const a=this.o.state().approvals.find(x=>x.id===id.replace(/^approval:/,''));
    if(!a||a.status!=='pending')return {ok:false,status:409,reply:SETTLED};
    const picks=quickActions(a),pick=picks.find(p=>p.answer===answer);
    if(!picks.length)return {ok:false,status:403,reply:'Open the card in Clowder to answer this one.'};
    if(!pick)return {ok:false,status:400,reply:`Answer with one of: ${picks.map(p=>p.answer).join(', ')}.`};
    try{this.o.town().decide(a.id,pick.answer,pick.approved,device);return {ok:true,status:200,reply:`${pick.answer}: sent.`};}
    catch(err){return {ok:false,status:409,reply:String((err as Error).message).slice(0,180)};}
  }
  /** A tapped chat button (v:<verb>:<item id>), from the paired owner chat only (the channel checks that first). */
  tap(data:unknown,device:string):VerbResult{
    const m=DATA.exec(String(data));
    return m?this.act(m[2]!,m[1]!,device):{ok:false,status:400,reply:'Open Clowder to do this one.'};
  }
}

/** POST /api/quests/:id/verb {verb}: the push action's route, on each listener (server.ts registerTown). Owner only: the host or a paired owner
 *  device. A member or a viewer gets 403 here, after the access hooks (which also want X-Town-Action and the town's own origin on a write). */
export function registerOwnerVerbRoutes(app:FastifyInstance,o:{verbs:OwnerVerbs;owner:(req:FastifyRequest)=>boolean;device:(req:FastifyRequest)=>string}){
  const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{if(!o.owner(req))return reply.code(403).send({error:'Only the owner acts on Needs you items.'});};
  app.post('/api/quests/:id/verb',{onRequest:ownerOnly,schema:{body:{type:'object',required:['verb'],additionalProperties:false,properties:{verb:{type:'string',enum:VERBS}}}}},async(req,res)=>{
    const r=o.verbs.act((req.params as {id:string}).id,(req.body as {verb:Verb}).verb,o.device(req));
    return r.ok?{ok:true,reply:r.reply}:res.code(r.status).send({error:r.reply});
  });
}

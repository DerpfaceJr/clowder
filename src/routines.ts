// Routines (plan 3.1): a prompt a cat runs at set times, on Run now, or from its webhook. Croner works out the times; the journal keeps
// lastRunAt, so a slot missed while the server was off or the town paused runs once, never once per missed slot.
// Goals keep their own rounds (engine.ts scheduleRound) for open-ended work; a routine is a fixed prompt at fixed times.
import {Cron} from 'croner';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {oneLiner} from '../public/hologram.js';
import {normalizeMode} from './ai-options.ts';
import {budgetSpent,goalOfTasks,goalUsage} from './goals.ts';
import {CAP_NOTE,capReached} from './usage.ts';
import type {Approval,Routine,RoutineSpec,State,Task} from './store.ts';
import type {Town} from './engine.ts';
import {quests,type Quest,type QuestInput} from './quests.ts';
import {ROUTINE_TEMPLATES} from './routine-templates.ts';

type Schedule={cron:string;timezone:string};
export type Trigger='schedule'|'catch-up'|'manual'|'webhook';
// A run counts as in flight from the inbox on, so a busy town never piles up runs of one routine.
const IN_FLIGHT=['queued','running','waiting','waiting_child'],BUSY=['running','waiting','waiting_child'];
const DAY=86_400_000;
const hash=(token:string)=>createHash('sha256').update(token).digest();
export const hostZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
// Standard 5-part cron only: a seconds field would let a routine run every second.
const OPTIONS={mode:'5-part'} as const;
/** The first time after `from` this schedule runs, or null when it never runs again. Throws on a bad pattern or timezone. */
export function nextRunAt(s:Schedule,from=new Date()):Date|null{return new Cron(s.cron,{...OPTIONS,timezone:s.timezone,paused:true}).nextRun(from);}
/** Provider-reported tokens over every run of the routine, children included. A missing count adds nothing, so this is a floor. */
export const routineTokens=(state:State,id:string)=>goalUsage(state,goalOfTasks(state,'routine')).get(id)?.total??0;

// Town-reference §3: private data, outside input and sending out in one routine is how a prompt injection walks data out of the town.
// ponytail: keywords in the prompt only, not the tools the cat can reach. Read the cat's connector effects if it misses real cases.
const PRIVATE=/\b(e-?mails?|inbox|gmail|outlook|calendar|contacts?|dms?|direct messages?|files?|drive|documents?|notes|bank\w*|financ\w*|accounts?|private|personal|health|passwords?)\b/i;
const UNTRUSTED=/\b(e-?mails?|inbox|web|internet|search\w*|brows\w*|fetch\w*|urls?|links?|rss|news|feeds?|comments?|mentions?|replies|reviews?|incoming|forms?|tweets?|posts?|webhooks?)\b/i;
const SENDING=/\b(send|sends|reply|respond|post|publish|tweet|share|upload|forward|dm|email (?:them|it|back|to)|message (?:them|people|someone|customers))\b(?!\s+(?:me|it to me|them to me)\b)/i;
export const RISK_WARNING='This routine reads private data, takes in outside content and sends things out. Outside content can tell a cat to send your data elsewhere. Keep its sending tools on Ask first.';
export const routineWarning=(prompt:string)=>PRIVATE.test(prompt)&&UNTRUSTED.test(prompt)&&SENDING.test(prompt)?RISK_WARNING:null;

// Daily briefing (plan 3.2): a prompt with the {{briefing}} marker gets, at run time, the facts since its last run and every open item
// that needs the owner. The needs-you list is quests() with the Quests panel's own input, so the counts agree with the panel.
export const BRIEF='{{briefing}}';
const TODO_KINDS=new Set(['owner-step','goal']),LIMIT=10;
let questInput:(()=>QuestInput)|null=null;
/** The host sets this to the Quests panel's input. Unset (tests, a bare town), the briefing reads the journal and no other sources. */
export const setBriefingQuestInput=(fn:()=>QuestInput)=>{questInput=fn;};
const trimList=(lines:string[])=>lines.length>LIMIT?[...lines.slice(0,LIMIT),`- (+${lines.length-LIMIT} more)`]:lines;
/** The block the cat reads. Decisions and to-dos are never trimmed: the owner must see every one. */
export function briefingBlock(state:State,since:string|null,now:Date,qs:Quest[]):string{
  const from=since??new Date(now.getTime()-DAY).toISOString(),news=state.events.filter(e=>e.at>from&&e.at<=now.toISOString());
  const finished=news.filter(e=>e.type==='task.updated'&&e.data?.status==='done').map(e=>state.tasks.find(t=>t.id===e.data.id))
    .filter((t):t is Task=>!!t&&!t.parent&&!t.routine&&!t.record).map(t=>`- ${oneLiner(t.text,140)}`);
  const moved=news.filter(e=>e.type==='goal.updated'&&e.data?.logLine).map(e=>`- ${oneLiner(state.goals.find(g=>g.id===e.data.id)?.title??'Goal',80)}: ${oneLiner(e.data.logLine,160)}`);
  const needs=qs.filter(q=>q.needsYou),todo=needs.filter(q=>TODO_KINDS.has(q.source.kind)),decisions=needs.filter(q=>!TODO_KINDS.has(q.source.kind));
  const line=(q:Quest)=>`- ${q.title}${q.detail?`: ${oneLiner(q.detail,160)}`:''}`;
  const trouble=qs.filter(q=>q.source.kind==='model').map(q=>`- ${q.title}: ${oneLiner(q.detail,160)}`);
  const list=(lines:string[])=>lines.length?lines:['- none'];
  return [
    `Since ${from.slice(0,16).replace('T',' ')} UTC.`,
    'Finished work:',...list(trimList(finished)),
    'Goals that moved:',...list(trimList(moved)),
    `Open decisions (${decisions.length}):`,...list(decisions.map(line)),
    `Open to-dos (${todo.length}):`,...list(todo.map(line)),
    'Account problems:',...list(trouble),
    `Needs you in total: ${needs.length}.`,
  ].join('\n');
}

/** One line for the owner's card: when it runs, who runs it, its budget. */
function describe(s:RoutineSpec){
  const next=s.schedule?nextRunAt(s.schedule):null;
  const when=s.schedule?`on “${s.schedule.cron}” (${s.schedule.timezone})${next?`, first run ${next.toLocaleString('en-GB',{timeZone:s.schedule.timezone,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:''}`:'run by hand or by its webhook';
  return `${when}${s.cat!=='mayor'?`, run by ${s.cat}`:''}${s.tokenBudget!==null?`, up to ${s.tokenBudget.toLocaleString()} tokens`:''}`;
}

/** Owned by Town: one Croner job per enabled schedule, cleared on dispose like the goal timers. */
export class Routines{
  private jobs=new Map<string,Cron>();
  private disposed=false;
  constructor(private town:Town){
    // Armed on the next tick: the host sets the town's connectors and autonomy after construction, and a catch-up run needs them.
    setImmediate(()=>this.armAll()).unref();
  }
  private get state(){return this.town.store.state;}
  private find(id:string){const r=this.state.routines.find(r=>r.id===id);if(!r)throw new Error('Unknown routine.');return r;}
  private inFlight(id:string){return this.state.tasks.some(t=>!t.parent&&t.routine===id&&IN_FLIGHT.includes(t.status));}
  /** Arms every routine. Also runs when the town resumes, so a slot missed while paused runs once then. */
  armAll(){for(const r of this.state.routines)try{this.arm(r.id);}catch{/* a schedule that no longer parses stays off (no next run), and the others still arm */}}
  private arm(id:string){
    this.jobs.get(id)?.stop();this.jobs.delete(id);
    const r=this.state.routines.find(r=>r.id===id);
    if(this.disposed||!r?.enabled||!r.schedule)return;
    // Catch-up: the first slot after the last run (or the last save) has passed, so it runs once now. Every later missed slot folds into it.
    const since=new Date(Math.max(Date.parse(r.lastRunAt??'')||0,Date.parse(r.updatedAt)));
    const due=nextRunAt(r.schedule,since);
    if(due&&due.getTime()<=Date.now()){try{this.fire(id,'catch-up');}catch{/* recorded on the routine, or held until the town resumes */}if(!this.state.routines.find(x=>x.id===id)?.enabled)return;}
    // protect is Croner's own overlap guard; the run outlives the callback, so fire's in-flight check is the one that holds.
    this.jobs.set(id,new Cron(r.schedule.cron,{...OPTIONS,timezone:r.schedule.timezone,protect:true,unref:true},()=>{try{this.fire(id,'schedule');}catch{/* recorded on the routine, or held until the town resumes */}}));
  }
  /**
   * Starts a run now and returns its task id. A scheduled or catch-up slot that cannot run is recorded with the reason, so it is not caught up
   * again; Run now and the webhook get the error instead. routine.ran is written as the run starts, so a crash mid-run never runs it twice.
   */
  fire(id:string,trigger:Trigger):string{
    const r=this.find(id),slot=trigger==='schedule'||trigger==='catch-up',s=this.state;
    if(this.disposed)throw new Error('This world is closed.');
    if((slot&&!r.schedule)||(trigger!=='manual'&&!r.enabled))throw new Error('This routine is off.');
    // Nothing is recorded while the town is paused: the slot is caught up once when it resumes.
    if(s.paused)throw new Error('Resume the town first.');
    // Past the monthly cap, likewise: nothing is recorded, so the slot runs once when the cap lifts (liftCap re-arms).
    if(capReached(s)){this.town.capCard();throw new Error(CAP_NOTE);}
    const skip=(note:string)=>{if(slot)this.town.store.emit('routine.ran',{id,lastRunAt:new Date().toISOString(),task:null,trigger,note:`Skipped: ${note}`});return new Error(note);};
    if(this.inFlight(id))throw skip('its last run is still going.');
    if(!s.cats.some(c=>c.id===r.cat))throw skip('its cat is no longer in town.');
    if(r.cat!=='mayor'&&s.tasks.some(t=>t.cat===r.cat&&BUSY.includes(t.status)))throw skip(`${r.cat} is busy with other work.`);
    if(r.mode!=='demo'&&!this.town.providers[r.mode])throw skip('its model is not configured.');
    const used=routineTokens(s,id);
    if(r.tokenBudget!==null&&budgetSpent(used,r.tokenBudget)){
      // Turned off, so a panel can tell a budget stop from the owner's own: raising the budget and turning it on runs it again.
      const note=`Token budget reached: ${used.toLocaleString()} of ${r.tokenBudget.toLocaleString()} tokens. Raise the budget, then turn the routine back on.`;
      this.town.store.emit('routine.saved',{id,enabled:false,note});this.arm(id);throw new Error(note);
    }
    const prompt=r.prompt.includes(BRIEF)?r.prompt.replace(BRIEF,()=>this.briefingFor(r)):r.prompt;
    const task=this.town.startRoutine(r.cat,`Routine “${r.title}”: ${prompt}`,r.mode,id);
    this.town.store.emit('routine.ran',{id,lastRunAt:new Date().toISOString(),task,trigger});
    return task;
  }
  /** The briefing's facts for a run starting now: since the routine's last run (a day back when it never ran). */
  private briefingFor(r:Routine){
    const now=new Date(),input=questInput?questInput():{state:this.state,projects:[],capabilities:[],seasons:[],models:null,now};
    return briefingBlock(this.state,r.lastRunAt,now,quests({...input,now}));
  }
  /** A run finished: a briefing routine's first line is announced once, as a store event the push service sends (push.ts). */
  finished(task:Task,result:string){
    const r=task.routine?this.state.routines.find(x=>x.id===task.routine):undefined;
    if(!r||!r.prompt.includes(BRIEF))return;
    const first=result.split('\n').find(l=>l.trim())??'';
    this.town.store.emit('routine.briefed',{id:r.id,task:task.id,line:oneLiner(first.replace(/^[\s#*>-]+/,''),200)||'Your briefing is ready.'});
  }
  /** Validates a whole routine; fields left out keep prev's. Throws a sentence the owner can act on. */
  private check(input:any,prev?:RoutineSpec):RoutineSpec{
    const pick=(k:keyof RoutineSpec):any=>input[k]!==undefined?input[k]:prev?.[k];
    const title=oneLiner(String(pick('title')??''),80),prompt=pick('prompt');
    if(!title)throw new Error('Give the routine a title.');
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw new Error('Write what the routine does, up to 4000 characters.');
    const cat=String(pick('cat')??'mayor');
    if(!this.state.cats.some(c=>c.id===cat))throw new Error('Unknown cat.');
    const raw=pick('schedule');let schedule:Schedule|null=null;
    if(raw!==null&&raw!==undefined){
      const cron=typeof raw.cron==='string'?raw.cron.trim().replace(/\s+/g,' '):'',timezone=typeof raw.timezone==='string'&&raw.timezone.trim()?raw.timezone.trim():hostZone();
      let next:Date|null;
      try{next=nextRunAt({cron,timezone});}catch(e){throw new Error(`Use a 5-part cron (minute hour day month weekday) and an IANA timezone such as Europe/London. ${(e as Error).message}`);}
      if(!next)throw new Error('This schedule never runs.');
      schedule={cron,timezone};
    }
    const mode=normalizeMode(String(pick('mode')??''));
    if(mode!=='demo'&&!this.town.providers[mode])throw new Error('This model is not configured.');
    const tokenBudget=pick('tokenBudget')??null,enabled=pick('enabled')??true;
    if(tokenBudget!==null&&(!Number.isInteger(tokenBudget)||tokenBudget<1))throw new Error('The token budget must be a whole number, or blank for none.');
    if(typeof enabled!=='boolean')throw new Error('Set enabled to true or false.');
    return {title,prompt:prompt.trim(),cat,schedule,mode,tokenBudget,enabled};
  }
  /** Owner-only (the routes), or the owner's Allow on the Mayor's draft. Without an id it creates; with one it updates, keeping fields left out. */
  save(input:any):Routine{
    const prev=input?.id===undefined?undefined:this.find(String(input.id));
    const spec=this.check(input??{},prev),id=prev?.id??randomUUID();
    this.town.store.emit('routine.saved',{id,...spec,warning:routineWarning(spec.prompt),note:null});
    this.arm(id);return this.find(id);
  }
  remove(id:string){this.find(id);this.jobs.get(id)?.stop();this.jobs.delete(id);this.town.store.emit('routine.removed',{id});}
  /** Owner-only. A new webhook token; the old one stops working. It is returned once: the journal keeps only its hash. */
  rotateHook(id:string){this.find(id);const token=randomBytes(32).toString('base64url');this.town.store.emit('routine.saved',{id,hookHash:hash(token).toString('hex')});return token;}
  /** The webhook's key check. An unknown routine, one with no hook and a wrong token all answer false; the compare is constant-time. */
  hookMatches(id:string,token:string){
    const stored=this.state.routines.find(r=>r.id===id)?.hookHash??null;
    return timingSafeEqual(hash(token),Buffer.from(stored??'0'.repeat(64),'hex'))&&stored!==null;
  }
  /** The Mayor's save_routine: files the draft for the owner and returns at once. A routine is a standing rule, so only Allow saves it. */
  propose(task:Task,args:any,call:{id:string},ctx:{turn:number;depth:number}){
    if(task.cat!=='mayor')throw new Error('Only the Mayor can draft a routine.');
    const spec=this.check({title:args.title,prompt:args.prompt,cat:args.cat,schedule:{cron:args.cron,timezone:args.timezone},mode:task.mode,tokenBudget:args.token_budget??null,enabled:true});
    const warning=routineWarning(spec.prompt);
    this.town.store.emit('approval.requested',{id:randomUUID(),task:task.id,cat:task.cat,question:`Save the routine “${spec.title}”, ${describe(spec)}?${warning?` Warning: ${warning}`:''}`,options:['Allow','Deny'],status:'pending',toolCallId:call.id,turn:ctx.turn,depth:ctx.depth,gate:'routine',routine:spec,detail:spec.prompt.slice(0,600)});
    return `Asked the owner to save the routine “${spec.title}”. Nothing runs until they allow it. Carry on.`;
  }
  /** Allow saves the draft; anything else drops it. Saved before the approval closes, so a draft that no longer checks stays pending. */
  decide(a:Approval,answer:string,approved:boolean,device:string){
    const yes=approved&&answer===a.options[0];
    if(yes)this.save(a.routine);
    this.town.store.emit('approval.resolved',{id:a.id,status:yes?'approved':'rejected',answer,device});
  }
  /** What a routines panel reads: no hook hash, plus whether a run is going, the next run and the tokens spent so far. */
  view(){
    const used=goalUsage(this.state,goalOfTasks(this.state,'routine'));
    return this.state.routines.map(({hookHash,...r})=>({...r,hook:hookHash!==null,running:this.inFlight(r.id),nextRunAt:this.jobs.get(r.id)?.nextRun()?.toISOString()??null,tokensUsed:used.get(r.id)?.total??0,
      // A briefing's text is its last run's result, so the panel can show it (Listen is a later cloud item).
      briefing:r.prompt.includes(BRIEF)&&r.lastTask?this.state.tasks.find(t=>t.id===r.lastTask)?.result??null:null}));
  }
  dispose(){this.disposed=true;for(const job of this.jobs.values())job.stop();this.jobs.clear();}
}

// Owner routes: canWrite is the host on the main listener and false on the remote one, the same gate as the other owner settings.
// The webhook is the one route open to callers without a session (remote-access.ts lets it past): the token in its path is the key.
// canReveal: who may see a new webhook token. It is a secret URL, so it stays on the host, as other secrets do.
export function registerRoutineRoutes(app:FastifyInstance,opts:{town:()=>Town;canWrite:(req:FastifyRequest)=>boolean;canReveal?:(req:FastifyRequest)=>boolean}){
  const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{if(!opts.canWrite(req))return reply.code(403).send({error:'Routines are managed on the host computer.'});};
  const routines=()=>opts.town().routines,param=(req:FastifyRequest)=>(req.params as {id:string}).id;
  const fields={title:{type:'string',maxLength:200},prompt:{type:'string',maxLength:4000},cat:{type:'string',maxLength:60},mode:{type:'string',maxLength:40},tokenBudget:{type:['integer','null'],minimum:1},enabled:{type:'boolean'},
    schedule:{type:['object','null'],additionalProperties:false,required:['cron'],properties:{cron:{type:'string',maxLength:100},timezone:{type:'string',maxLength:64}}}};
  const one=(id:string)=>{const r=routines().view().find(r=>r.id===id)!;return {routine:r,warning:r.warning};};
  app.get('/api/routines',{onRequest:ownerOnly},async()=>({routines:routines().view(),timezone:hostZone()}));
  // The routine library (routine-templates.ts): drafts the owner saves with one tap. Read-only.
  app.get('/api/routines/templates',{onRequest:ownerOnly},async()=>({templates:ROUTINE_TEMPLATES}));
  app.post('/api/routines',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,required:['title','prompt','mode'],properties:fields}}},async req=>one(routines().save({...(req.body as object),id:undefined}).id));
  app.post('/api/routines/:id',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,properties:fields}}},async req=>one(routines().save({...(req.body as object),id:param(req)}).id));
  app.post('/api/routines/:id/remove',{onRequest:ownerOnly},async req=>{routines().remove(param(req));return {ok:true};});
  app.post('/api/routines/:id/run',{onRequest:ownerOnly},async req=>({task:routines().fire(param(req),'manual')}));
  const hostOnly=async(req:FastifyRequest,reply:FastifyReply)=>{if(!(opts.canReveal??opts.canWrite)(req))return reply.code(403).send({error:'Webhook links are shown on the host computer.'});};
  app.post('/api/routines/:id/hook',{onRequest:hostOnly},async req=>{const id=param(req),token=routines().rotateHook(id);return {token,path:`/hooks/routines/${id}/${token}`};});
  void app.register(async scope=>{
    // Any body is read and dropped: the webhook only starts a run, so no outside text reaches the prompt.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*',{parseAs:'buffer'},(_req,_body,done)=>done(null,undefined));
    scope.post('/hooks/routines/:id/:token',async(req,reply)=>{
      const {id,token}=req.params as {id:string;token:string};
      // An unknown routine and a wrong token answer the same, so the webhook says nothing about which routines exist.
      if(!routines().hookMatches(id,token))return reply.code(404).send({error:'Unknown routine hook.'});
      try{return reply.code(202).send({ok:true,task:routines().fire(id,'webhook')});}
      catch(error){return reply.code(409).send({error:(error as Error).message});}
    });
  });
}

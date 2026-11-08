import { mkdirSync, readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, ftruncateSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {HomeLook,Look} from './world.ts';
import type {Card} from './card-templates.ts';
import {applyCatAi,type AiProvider,type CatAi} from './ai-options.ts';
import {FINISHED} from './projects.ts';
import {usageSummary} from '../public/treasury-view.js';
import {ReadModel} from './read-model.ts';
import {quickActions} from './push.ts';
/** Owner overrides. Anything left out falls back to the cat's generated look. */
export type Appearance = {chroma?:string; fur?:string; outfit?:string; eyes?:string; accessory?:string; patch?:string; cream?:string; trim?:string; base?:string; marking?:string; parts?:string[]; expression?:string};
// ai: owner-set model and effort per provider; absent means the town default. aiSuggestion: the Mayor's note on a new cat's model; applied:true when the Mayor chose it, otherwise pending for the owner.
export type AiSuggestion = {provider:AiProvider; model?:string; effort?:string; reason:string; at:string};
// manager: the cat that recruited this one (the Mayor or a director). directs: the project id a director runs.
export type Cat = {id:string; name:string; role:string; color:string; icon:string; manager?:string; directs?:string; group?:string; home?:{x:number;z:number;style:string;plot?:number;manual?:boolean;look?:HomeLook}; appearance?:Appearance; look?:Look; ai?:CatAi; aiSuggestion?:AiSuggestion|null; skills?:string[]};
/** A hamlet: a site on the map with a hall (its lead) and plots. main is the town centre. */
export type Group = {id:string; name:string; lead:string; site:{index:number;x:number;z:number}; rootTask?:string|null};
export type Road = {id:string; a:string; b:string; messages:number};
// v: the event's version, written only when it is above 1 (absent means 1). See UPCAST.
export type Event = {id:string; at:string; type:string; v?:number; data:any};
// ai: the model and effort this task was given. A root task has the owner's Reasoning pick; a delegated child has its parent's effective choice.
// inbox: the owner's message waiting for the Mayor (status 'queued'). goal: it starts a goal when picked up.
// routine: the routine this root task is a run of (routines.ts). hermes: the Hermes session (and current run) a Mayor task runs in; the bridge sets it (plan 4.10).
export type Task = {id:string; cat:string; from:string; text:string; parent?:string; mode:string; status:string; result?:string; goal?:string; ai?:{model?:string; effort?:string}; inbox?:{goal:boolean}; record?:boolean; routine?:string; resumed?:{at:string; turn:number}; held?:'cap'|null; hermes?:{session:string; run?:string}};
// messages: written only by older journals; the paused task's checkpoint file holds its context now.
// gate connector: a connector tool the cat wants to call. call is that tool call, run once on Allow; detail is its arguments, cut at 600.
// gate grant: give a directory service (service) already connected for another cat to this one; its task does not wait.
// gate effect: did a call with an unknown outcome go through? effect is its ledger key. No task waits on it.
// gate routine: the Mayor's draft of a standing routine (routine); only Allow saves it. No task waits on it.
// gate cap: the town's monthly token cap is reached (usage.ts); one per month (month), and no task waits on it: held work resumes when the cap lifts.
// gate hermes: a Hermes tool call parked by the gate plugin (plan 4.9). hermes: its session, Hermes's own tool name, a hash of its arguments, the run
// when the bridge knows it, and reply: the owner's answer is the call's result (request_approval), so Hermes runs it whatever the answer.
export type Approval = {id:string; task:string; cat:string; question:string; options:string[]; status:string; answer?:string; messages?:any[]; toolCallId:string; turn:number; depth:number; gate?:'goal'|'goal-removal'|'connector'|'grant'|'effect'|'routine'|'cap'|'hermes'; month?:string; goal?:string; service?:string; reason?:string; call?:{id:string; type:'function'; function:{name:string; arguments:string}}; detail?:string; card?:Card; effect?:string; effectClass?:string; routine?:RoutineSpec; hermes?:{session:string; tool:string; digest:string; run?:string; reply?:boolean}};
/** A routine (routines.ts): a prompt a cat runs on a schedule (5-part cron in an IANA timezone), on Run now, or from its webhook. mode is the model provider, as on a goal.
 *  tokenBudget counts every run, children included; null is none. */
export type RoutineSpec = {title:string; prompt:string; cat:string; schedule:{cron:string; timezone:string}|null; mode:string; tokenBudget:number|null; enabled:boolean};
// hookHash: sha256 of the webhook token, which is shown once and never kept. warning: the save-time safety warning. note: why the last slot did not run, or why it was turned off.
export type Routine = RoutineSpec & {id:string; hookHash:string|null; warning:string|null; note:string|null; lastRunAt:string|null; lastTask:string|null; createdAt:string; updatedAt:string};
/** The publish ledger's latest entry per key: one public, money or delete call. account is the connector id; hash stands for the arguments, which are never kept. */
export type Effect = {key:string; account:string; tool:string; hash:string; kind:string; cat:string; task:string; status:'intended'|'done'|'failed'|'unknown'; result?:string; error?:string; at:string; settledAt?:string};
/** An ongoing goal. Rounds are Mayor tasks; `log` keeps one line per round, the newest 100. */
/** An owner step: work only the owner can do. `goal` is null outside a goal; `ownerNotes` are finished-step lines for the goal's next round. */
// kind: why only the owner can act (request_owner_step requires one). Steps written before kinds existed have none. connect: a directory id, for a connect step.
// signInAt: when this connect step last handed out a sign-in page; past mcp-oauth's PENDING_MS with no callback, it needs sign-in again.
export const OWNER_KINDS=['account','payment','legal','identity','physical','design'] as const;
export type OwnerKind=typeof OWNER_KINDS[number];
// account: the Account this step is about, set only on steps the account monitor files (accounts.ts), so it files one per account per state change.
export type OwnerStep = {id:string; goal:string|null; cat:string; title:string; steps:string; blocking:boolean; status:'open'|'done'|'dismissed'; kind?:OwnerKind; connect?:string; account?:string; signInAt?:string; browser?:boolean; url?:string; mode?:string; note?:string; at:string};
// One account's health in this world, replayed from account.state. by: a probe's verdict or a cat's report; since: the monitor's clock then; step: its open quest.
export type AccountHealth = {status:string; service:string; label:string; identity:string|null; expected:string|null; reason:string; by:'probe'|'report'; since:number; step:string|null; at:string};
export type Goal = {id:string; title:string; success:string; status:'active'|'paused'|'achieved'|'stopped'; mode:string; rounds:number; roundsToday:number; day:string; failures:number; log:string[]; summary:string|null; maxRoundsPerDay:number|null; tokenBudget:number|null; pausedBy:string|null; note:string|null; endedBy:string|null; asleep?:boolean; ownerNotes?:string[]; ai?:{model?:string; effort?:string}; createdAt:string; updatedAt:string};
export type Treasury = {amountMinor:number;currency:string;note:string;source:'owner-recorded';recordedAt:string};
export type Council = {id:string;target:string;proposer:string;reason:string;evidence:string[];electorate:string[];mode:string;status:string;votes:{cat:string;vote:'retire'|'keep'|'abstain';reason:string}[];at:string;result?:string};
export type RetiredCat = Cat & {retiredAt:string;council:string;reason:string;roads:Road[]};
export type State = {routines:Routine[]; effects:Record<string,Effect>; cats:Cat[]; roads:Road[]; tasks:Task[]; approvals:Approval[]; messages:any[]; events:Event[]; paused:boolean; usage:any[];treasury:Treasury|null;retiredCats:RetiredCat[];councils:Council[];layoutVersion:number;groups:Group[];introduced:boolean;goals:Goal[];ownerSteps:OwnerStep[];hiddenQuests:Record<string,string|null>;accounts:Record<string,AccountHealth>;handoffs?:Record<string,string>;skipped?:Record<string,number>;unknown?:Record<string,number>;usageCap?:number|null;capOverride?:string|null};
export const roadId = (a:string,b:string) => [a,b].sort().join(':');
// Keys in a stable order, so the same arguments always give the same hash.
export const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
/** The publish ledger's key: account (connector id) + tool + a hash of the normalised arguments. */
export const effectKey=(account:string,tool:string,args:unknown)=>{const hash=createHash('sha256').update(JSON.stringify(sorted(args))).digest('hex');return {key:`${account}:${tool}:${hash}`,hash};};
/** The cats a world was founded with, read from its own journal. A world keeps these even if town.config.json later changes. */
export function foundingCats(file:string,fallback:{id:string}[]):{id:string}[]{
  if(!existsSync(file))return fallback;
  const founded=readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(e=>e.type==='founded');
  return founded?.data?.cats??fallback;
}
/** A journal's bytes split at the last newline: the complete lines, and a tail that an append was still writing (empty when the file ends in a newline). */
export function splitJournal(buf:Buffer):{lines:Buffer;tail:Buffer}{const end=buf.lastIndexOf(10)+1;return {lines:buf.subarray(0,end),tail:buf.subarray(end)};}
// A torn last append never reached apply(): emit applies only after writeSync and fsyncSync return. Its bytes go to events.jsonl.torn-<time>
// beside the journal, durably, before the journal is cut back to its last newline. A tail that parses only lost its newline, so it gets one.
function repairTail(file:string):string{
  const buf=readFileSync(file),{lines,tail}=splitJournal(buf);
  if(!tail.toString('utf8').trim())return buf.toString('utf8');
  const sync=(path:string,flags:string,fn:(fd:number)=>void)=>{const fd=openSync(path,flags);try{fn(fd);fsyncSync(fd);}finally{closeSync(fd);}};
  try{JSON.parse(tail.toString('utf8'));sync(file,'a',fd=>writeSync(fd,'\n'));console.warn(`${file}: the last line had no newline; added one.`);return buf.toString('utf8')+'\n';}catch{}
  const aside=`${file}.torn-${new Date().toISOString().replace(/[:.]/g,'-')}`;
  sync(aside,'wx',fd=>writeSync(fd,tail));
  sync(file,'r+',fd=>ftruncateSync(fd,lines.length));
  console.warn(`${file}: the last line was cut off mid-write (${tail.length} bytes). Moved it to ${aside} and replayed up to the line before.`);
  return lines.toString('utf8');
}
/** Every event type this build writes or applies. Any other type comes from a newer Clowder: replay keeps it and does not apply it.
 *  A test scans src/ for emit and journal calls, so a new type cannot be left out. */
export const EVENT_TYPES=new Set(['founded','homes.planned','town.planned','group.founded','council.opened','council.voted','council.closed','cat.restored',
  'home.styled','home.looked','home.moved','cat.customized','cat.ai','cat.skills','cat.ai.suggested','looks.planned','cat.created','road.created','message',
  'task.created','task.updated','approval.requested','approval.resolved','paused','usage','usage.cap','usage.cap.override','world.introduced','treasury.recorded',
  'purchase.requested','purchase.decided','purchase.paid','purchase.authorization','owner.step','owner.step.done','owner.step.sign-in','owner.step.dismissed',
  'quest.hidden','quest.handoff','goal.created','goal.archived','goal.updated','effect.intended','effect.done','effect.failed','effect.unknown',
  'routine.saved','routine.removed','routine.ran','routine.briefed','account.state','account.error','tool.started','tool.finished','memory.noted',
  'diary.entry','artifact.created','wiki.saved','wiki.line','wiki.removed','hermes.hello','hermes.ready','hermes.started','hermes.stopped',
  'hermes.crashed','hermes.answered','hermes.refused','hermes.undelivered']);
/** Upcasters, UPCAST['type@v'], each taking one version's data to the next. Replay steps an older event up to the version this build knows,
 *  in memory only: the journal is never rewritten. Empty while every type is at v1. */
export const UPCAST:Record<string,(data:any)=>any>={};
/** The version of `type` this build writes: 1 plus the unbroken run of upcasters from v1. */
export const eventVersion=(type:string)=>{let v=1;while(UPCAST[`${type}@${v}`])v++;return v;};
export class Store {
  state:State = {routines:[],effects:{},cats:[],roads:[],tasks:[],approvals:[],messages:[],events:[],paused:false,usage:[],treasury:null,retiredCats:[],councils:[],layoutVersion:0,groups:[],introduced:true,goals:[],ownerSteps:[],hiddenQuests:{},accounts:{},handoffs:{},usageCap:null,capOverride:null};
  listeners = new Set<(event:Event)=>void>();
  // size: the journal's length in characters, so the read model can tell a rewritten journal from this one. replayed: events apply()d at boot (all of them without a snapshot).
  size=0; replayed=0; readModel?:ReadModel;
  /** readModel: the SQLite file beside the journal (read-model.ts). Only the open world passes one; a throwaway Store (a world list count, a test) replays as before. */
  constructor(public file:string, cats:Cat[], opts:{readModel?:string}={}) {
    mkdirSync(dirname(file),{recursive:true});
    // The fingerprint of the replay code: a snapshot written by other code is never loaded.
    if(opts.readModel)this.readModel=new ReadModel(opts.readModel,ReadModel.fingerprint(Store.replayCode()),()=>({state:this.state,size:this.size}));
    if (existsSync(file)) {
      const lines:string[]=[],events:Event[]=[],prefix=(n:number)=>{let size=0;for(let i=0;i<n;i++)size+=lines[i].length+1;return size;};
      // Fail closed on damaged history; never quietly reset a town. Every line is parsed before anything else reads the journal.
      // The line itself is never quoted: it may hold a secret.
      repairTail(file).split('\n').forEach((line,n)=>{
        if(!line)return;
        try{events.push(JSON.parse(line));}catch{throw new Error(`${file}, line ${n+1}, is damaged, so this town will not open. Nothing was changed. Restore a backup: data/backups holds a copy from before each upgrade.`);}
        lines.push(line);
      });
      // A snapshot counts only while the journal still has the same events up to it: same count, last id and length.
      const snap=this.readModel?.load(m=>m.seq>0&&m.seq<=events.length&&events[m.seq-1].id===m.id&&prefix(m.seq)===m.size)??null;
      let i=0;
      // Events up to the snapshot are kept (every reader of state.events needs them) but not applied: the snapshot already holds their effect.
      if(snap){Object.assign(this.state,snap.state);for(;i<snap.seq;i++)this.state.events.push(events[i]);}
      for(;i<events.length;i++){this.apply(events[i]);this.replayed++;}
      this.size=prefix(lines.length);
    }
    if(!this.state.events.length){ this.emit('founded',{cats}); this.emit('world.introduced',{introduced:false}); }
    this.readModel?.schedule();
  }
  /** What replay depends on, for the read-model fingerprint: apply(), the upcasters and the known types. */
  static replayCode(){return [Store.prototype.apply.toString(),applyCatAi.toString(),...Object.entries(UPCAST).map(([k,f])=>`${k}=${f}`),[...EVENT_TYPES].join()].join('\n');}
  emit(type:string,data:any) {
    const v=eventVersion(type),event:Event={id:randomUUID(),at:new Date().toISOString(),type,...(v>1?{v}:{}),data},line=JSON.stringify(event)+'\n';
    const fd=openSync(this.file,'a');
    try {writeSync(fd,line);fsyncSync(fd);} finally {closeSync(fd);}
    this.size+=line.length;this.apply(event);for(const listener of this.listeners)listener(event);
    // The read model catches up once per tick, after this emit has returned.
    this.readModel?.schedule();return event;
  }
  apply(e:Event) {
    const s=this.state,now=eventVersion(e.type);
    // A type this build does not know, or a newer version of one it does, stays in state.events and is never half-applied; state.unknown counts it per type.
    if(!EVENT_TYPES.has(e.type)||(e.v??1)>now){s.events.push(structuredClone(e));(s.unknown??={})[e.type]=(s.unknown[e.type]??0)+1;return;}
    if((e.v??1)<now){let data=e.data;for(let v=e.v??1;v<now;v++)data=UPCAST[`${e.type}@${v}`](structuredClone(data));e={...e,v:now,data};}
    const d=structuredClone(e.data);s.events.push(structuredClone(e));
    // Replay never throws: an update for a record that is not there is skipped and counted once per event in state.skipped, so one stale line cannot brick the town.
    let missed=false;const cat=(id:string)=>{const c=s.cats.find(x=>x.id===id);if(!c)missed=true;return c;};
    if(e.type==='founded'){s.cats=d.cats;for(const cat of s.cats.filter(c=>c.id!=='mayor'))s.roads.push({id:roadId('mayor',cat.id),a:'mayor',b:cat.id,messages:0});}
    if(e.type==='homes.planned')for(const plan of d.homes){const c=cat(plan.id);if(c)Object.assign(c,plan);}
    if(e.type==='town.planned'){s.groups=d.groups;for(const plan of d.homes){const c=cat(plan.id);if(c)Object.assign(c,plan);}s.layoutVersion=d.version;}
    if(e.type==='group.founded')s.groups.push(d);
    if(e.type==='council.opened')s.councils.push({...d,votes:[],status:'voting',at:e.at});
    if(e.type==='council.voted'){const council=s.councils.find(c=>c.id===d.id);if(council)council.votes.push(d.ballot);else missed=true;}
    if(e.type==='council.closed'){
      const council=s.councils.find(c=>c.id===d.id);if(council)Object.assign(council,{status:d.status,result:d.result});else missed=true;
      const target=council&&d.status==='retired'?cat(council.target):undefined;
      if(council&&target){const cat=target;s.retiredCats.push({...cat,retiredAt:e.at,council:council.id,reason:council.reason,roads:s.roads.filter(r=>r.a===cat.id||r.b===cat.id)});s.cats=s.cats.filter(c=>c.id!==cat.id);s.roads=s.roads.filter(r=>r.a!==cat.id&&r.b!==cat.id);}
    }
    if(e.type==='cat.restored'){s.retiredCats=s.retiredCats.filter(c=>c.id!==d.cat.id);s.cats.push(d.cat);s.roads.push(...d.roads);}
    if(e.type==='home.styled'){const c=cat(d.id);if(c?.home){c.home.style=d.style;c.color=d.color;c.icon=d.icon;}else missed=true;}
    if(e.type==='home.looked'){const home=cat(d.id)?.home;if(!home)missed=true;else if(d.look)home.look=d.look;else delete home.look;}
    if(e.type==='home.moved'){const c=cat(d.id);if(c)c.home=d.home;}
    if(e.type==='cat.customized'){const c=cat(d.id);if(c)c.appearance=d.appearance;}
    // Emitters validate first; these lookups skip quietly, as they always have.
    if(e.type==='cat.ai'){const cat=s.cats.find(c=>c.id===d.id);if(cat)cat.ai=applyCatAi(cat.ai,d);}
    if(e.type==='cat.skills'){const cat=s.cats.find(c=>c.id===d.id);if(cat){if(Array.isArray(d.skills)&&d.skills.length)cat.skills=d.skills.filter((x:unknown)=>typeof x==='string');else delete cat.skills;}}
    if(e.type==='cat.ai.suggested'){const cat=s.cats.find(c=>c.id===d.id);if(cat)cat.aiSuggestion=d.suggestion?{...d.suggestion,at:e.at}:null;}
    if(e.type==='looks.planned')for(const plan of d.looks){const cat=s.cats.find(c=>c.id===plan.id);if(cat)cat.look=plan.look;}
    if(e.type==='cat.created'){s.cats.push(d);s.roads.push({id:roadId('mayor',d.id),a:'mayor',b:d.id,messages:0});}
    if(e.type==='road.created')s.roads.push({...d,messages:0});
    if(e.type==='message'){s.messages.push({...d,id:e.id,at:e.at});const road=s.roads.find(r=>r.id===roadId(d.from,d.to));if(road)road.messages++;}
    if(e.type==='task.created')s.tasks.push(d);
    if(e.type==='task.updated'){const t=s.tasks.find(x=>x.id===d.id);if(t)Object.assign(t,d);else missed=true;}
    if(e.type==='approval.requested')s.approvals.push(d);
    if(e.type==='approval.resolved'){const a=s.approvals.find(x=>x.id===d.id);if(a)Object.assign(a,d);else missed=true;}
    if(e.type==='paused')s.paused=d.value;
    if(e.type==='usage')s.usage.push({...d,at:e.at});
    // The town-wide monthly token cap (usage.ts): null is none. An override lets this month (a month key) run past it.
    if(e.type==='usage.cap')s.usageCap=d.tokens??null;
    if(e.type==='usage.cap.override')s.capOverride=d.month??null;
    if(e.type==='world.introduced')s.introduced=d.introduced===true;
    if(e.type==='treasury.recorded')s.treasury={...d,recordedAt:e.at};
    // A paid real-money purchase lowers the recorded balance when it is in the same currency.
    if(e.type==='purchase.paid'&&s.treasury&&s.treasury.currency===d.currency&&Number.isInteger(d.paidMinor))s.treasury={...s.treasury,amountMinor:s.treasury.amountMinor-d.paidMinor};
    if(e.type==='owner.step')s.ownerSteps.push({...d,status:'open',at:e.at});
    if(e.type==='owner.step.done'){const step=s.ownerSteps.find(x=>x.id===d.id);if(step){step.status='done';step.note=d.note||'';}}
    if(e.type==='owner.step.sign-in'){const step=s.ownerSteps.find(x=>x.id===d.id);if(step)step.signInAt=e.at;}
    if(e.type==='owner.step.dismissed'){const step=s.ownerSteps.find(x=>x.id===d.id);if(step)step.status='dismissed';}
    // A hidden quest stays hidden only while its time is the one it was hidden at (see quests()).
    if(e.type==='quest.hidden')s.hiddenQuests[d.id]=d.at??null;
    // A quest handed off to the computer (item 1.6): when, so the host lists it first while it is fresh (see quests()).
    if(e.type==='quest.handoff')(s.handoffs??={})[d.id]=e.at;
    if(e.type==='goal.created')s.goals.push({...d,createdAt:e.at,updatedAt:e.at});
    // An archived goal leaves the state (its events stay in the journal), so every reader drops it at once.
    if(e.type==='goal.archived')s.goals=s.goals.filter(g=>g.id!==d.id);
    // Replay skips a patch for an unknown goal, like the other updates. logLine appends to the progress log.
    // The publish ledger. intended is written before the call; done, failed or unknown after it, or when the owner answers an unknown one.
    if(e.type==='effect.intended')s.effects[d.key]={...d,status:'intended',at:e.at};
    if(/^effect\.(done|failed|unknown)$/.test(e.type)&&s.effects[d.key])Object.assign(s.effects[d.key],d,{status:e.type.slice(7),settledAt:e.at});
    if(e.type==='goal.updated'){const g=s.goals.find(x=>x.id===d.id);if(g){const {id,logLine,...patch}=d;if(logLine)g.log=[...g.log,logLine].slice(-100);Object.assign(g,patch,{updatedAt:e.at});}}
    // Routines. saved merges into the routine, so a partial save (a budget stop, a new webhook) keeps the rest. ran is written as a run starts.
    if(e.type==='routine.saved'){const r=s.routines.find(x=>x.id===d.id);if(r)Object.assign(r,d,{updatedAt:e.at});else s.routines.push({hookHash:null,warning:null,note:null,lastRunAt:null,lastTask:null,...d,createdAt:e.at,updatedAt:e.at});}
    // Account health (accounts.ts): each state change is one event, so a reopened store knows every account's last state and open quest.
    if(e.type==='account.state'){const {id,to,from:_from,...rest}=d;s.accounts[id]={...rest,status:to,at:e.at};}
    if(e.type==='routine.removed')s.routines=s.routines.filter(r=>r.id!==d.id);
    if(e.type==='routine.ran'){const r=s.routines.find(x=>x.id===d.id);if(r)Object.assign(r,{lastRunAt:d.lastRunAt,note:d.note??null},d.task?{lastTask:d.task}:{});}

    if(missed)(s.skipped??={})[e.type]=(s.skipped[e.type]??0)+1;
  }
  /** The small part of what clients see. state-delta.ts diffs it per event. Owner steps, account health, the publish ledger and hidden quests reach the page through their own routes, never here. */
  // Routines are read through /api/routines, so their webhook hashes never reach a viewer's state.
  // The monthly cap reaches the page through /api/usage (usage.ts).
  small(){const {tasks,messages,events,approvals,usage,ownerSteps,effects,hiddenQuests,handoffs,routines,accounts,usageCap,capOverride,...rest}=this.state;return {...rest,usage:usageSummary(usage)};}
  /** What /api/state carries: recent data only (ux-audit F1: the full state was 6.7 MB). Older chat history and finished tasks load per cat through chat(). seq is the journal position, so the page can tell which SSE frames it already has. */
  snapshot(l:SnapshotLimits){
    const s=this.state,keep=new Set([...s.cats.map(c=>c.directs),...s.groups.map(g=>g.rootTask)]);
    return {...this.small(),seq:s.events.length,messages:tail(s.messages,l.messages),
      // Unfinished work drives the busy marks, the inbox and the 3D town; a director's or hamlet's task names its project.
      tasks:s.tasks.filter(t=>!FINISHED.has(t.status)||keep.has(t.id)).map(publicTask),
      // Pending ones, plus the newest few so an approval answered elsewhere still shows as approved.
      approvals:s.approvals.filter((a,i)=>a.status==='pending'||i>=s.approvals.length-l.approvals).map(publicApproval),
      events:tail(s.events.filter(e=>FEED_EVENTS.has(e.type)),l.events).map(publicEvent)};
  }
  /** One cat's chat, newest `limit` messages before the message `before` (or the end), in journal order; the first page also brings the cat's newest tasks. Same shapes as the snapshot. */
  chat(cat:string,{before,limit,tasks}:{before?:string;limit:number;tasks:number}){
    const all=this.state.messages,mine=(m:any)=>m.from===cat||m.to===cat,page:any[]=[];
    let i=before===undefined?all.length:all.findIndex(m=>m.id===before);
    if(i<0)throw new Error('That message is not in this town.');
    for(i--;i>=0&&page.length<limit;i--)if(mine(all[i]))page.push(all[i]);
    let more=false;for(;i>=0&&!more;i--)more=mine(all[i]);
    return {messages:page.reverse(),more,...(before===undefined?{tasks:tail(this.state.tasks.filter(t=>t.cat===cat),tasks).map(publicTask)}:{})};
  }
  /** One thread: the root task, every task it delegated to (parent chains), and the messages on any of them, newest `limit` before `before`,
   *  in journal order. Tasks go through publicTask, so no model context leaves. Null when the root task is not in this town. */
  thread(root:string,{before,limit}:{before?:string;limit:number}){
    const tasks=this.state.tasks;
    if(!tasks.some(t=>t.id===root))return null;
    // ponytail: fixed-point over the task list, O(depth x tasks); a town has a few hundred tasks at most.
    const ids=new Set([root]);
    for(let grew=true;grew;){grew=false;for(const t of tasks)if(t.parent&&ids.has(t.parent)&&!ids.has(t.id)){ids.add(t.id);grew=true;}}
    const all=this.state.messages.filter(m=>m.task&&ids.has(m.task));
    const i=before===undefined?all.length:all.findIndex(m=>m.id===before);
    if(i<0)throw new Error('That message is not in this town.');
    return {messages:all.slice(Math.max(0,i-limit),i),more:i-limit>0,tasks:tasks.filter(t=>ids.has(t.id)).map(publicTask)};
  }
}
export type SnapshotLimits={messages:number;events:number;approvals:number};
// slice(-0) would return everything.
const tail=<T>(list:T[],n:number)=>n>0?list.slice(-n):[];
// What any client, on this computer or a paired phone, may see. The snapshot and every SSE frame go through these: no model context, no approval messages.
export const publicTask=(t:Task)=>({...t,context:undefined});
// quick: the buttons a channel may offer for this decision (push.ts quickActions, the same rule the push notice uses). Nothing else of the model's is sent.
export const publicApproval=({messages,...a}:Approval)=>({...a,quick:quickActions(a)});
export const publicEvent=(e:Event)=>({...e,data:{...e.data,messages:undefined,context:undefined}});
// The event types the page reads from state.events: the diary in public/app.js render() and the archive's artifact.created. Add a type here when a reader needs it.
export const FEED_EVENTS=new Set(['founded','town.planned','homes.planned','home.styled','home.looked','cat.created','cat.restored','council.closed','road.created','message','task.updated','approval.requested','approval.resolved','paused','artifact.created']);

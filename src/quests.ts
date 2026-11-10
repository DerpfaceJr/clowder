import {oneLiner} from '../public/one-liner.js';
import type {Project} from './projects.ts';
import type {Event,OwnerStep,State,Suggestion} from './store.ts';
import type {Purchase} from './real-money.ts';
import {formatMinor} from './treasury.ts';
import {directoryEntry,tokenVar} from './connector-directory.ts';
import {PENDING_MS} from './mcp-oauth.ts';
import type {BootstrapStatus} from './hermes-bootstrap.ts';
import {stoppedIntegrations,type Integration} from './health.ts';

// The Quest log: one ordered table of rank rules. Each rule turns one kind of attention into quests. Pure over its input.
// needsYou: only the owner can act on it (a decision, a payment, an owner step, a sign-in). The rest are shown folded.
// band: needs (needsYou; counted), trouble (a failed or stopped request, shown open, not counted), handled (folded). See quests().
export type Rank='S'|'A'|'B'|'C'|'D'|'E'|'F';
export type Panel='chat'|'projects'|'season'|'models'|'moonvault';
export type Band='needs'|'trouble'|'handled';
export type Quest={id:string;rank:Rank;title:string;detail:string;at:string|null;source:{kind:string;id:string};action:{label:string;panel:Panel;cat?:string;project?:string};connect?:{id:string;name:string};browser?:true;url?:string;stepKind?:string;needsYou:boolean;band:Band;holds?:string;payment?:{vendor:string;url:string;amount:string;endsAt:string|null};computer?:true;handoff?:string;due?:string;after?:string;request?:{id:string;title:string}};
// computer: it finishes only on the computer running Clowder (the cats' browser, a CLI sign-in), so a phone offers "Continue on your computer".
// handoff: when the owner did that; the host then lists it first for a day.
// holds: on a to-do, the title of the goal its live step is holding (the goal row folds, N4).
// payment: an approved, unpaid purchase (N1): the vendor link, the amount, and when the 72 h approval ends.
// due: on a to-do, the date the cat stated (YYYY-MM-DD, 11.9). It orders the Needs you band (11.18).
// request: the root request a to-do or a payment belongs to (11.9 stores its task), so the Inbox can read "For: <request>".
export type SeasonCapability={id:string;cat:string;need:string;kind:string;tier:string;status:string};
export type SeasonRun={name:string;status:string;reason?:string};
export type ModelStatus=Record<string,{name:string;enabled:boolean;available:boolean;detail?:string}>;
export type SetupFailure={error:string;failures:number;at:string};
export type QuestInput={state:State;projects:Project[];latestSeason?:string;capabilities:SeasonCapability[];seasons:SeasonRun[];models:ModelStatus|null;config?:{staleMinutes?:unknown;recentHours?:unknown};now:Date;workshopSetup?:SetupFailure|null;hermesSetup?:BootstrapStatus|null;purchases?:Purchase[];host?:boolean;suggestions?:Suggestion[];economy?:boolean;integrations?:Integration[]};
// suggestions: the open For you cards (plan 9.6), filled for the owner only, so a viewer never reads a subject line from the owner's mail.
// integrations: each integration's health() (health.ts, 11.21). An error older than 15 min is one Needs you item. Missing means none.
// economy: the coin economy is on (economyOn(config)). Missing means off, so no season quest and no "Open coins" action.

const RANKS:Rank[]=['S','A','B','C','D','E','F'];
const OWNER_ALERT_KINDS=new Set(['money','account']);
const MINUTE=60_000,HOUR=3_600_000,DAY=24*HOUR;
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;

type Ctx={
  s:State;now:Date;nowIso:string;
  name:(id:string)=>string;
  approvalAt:Map<string,string>;
  projects:Project[];
  capabilities:SeasonCapability[];
  runs:SeasonRun[];
  models:ModelStatus|null;
  staleMinutes:number|null;
  recentHours:number|null;
  setupFailure:SetupFailure|null;
  hermesSetup:BootstrapStatus|null;
  purchases:Purchase[];
  suggestions:Suggestion[];
  economy:boolean;
  integrations:Integration[];
};
type Rule={rank:Rank;reason:string;collect:(c:Ctx)=>Quest[]};

const requestOf=(c:Ctx,id:string|null|undefined):Quest['request']=>{const t=id?c.s.tasks.find(x=>x.id===id):undefined;return t?{id:t.id,title:oneLiner(t.text,90)||'Untitled request'}:undefined;};
const quest=(rank:Rank,kind:string,id:string,title:string,detail:string,at:string|null,action:Quest['action'],needsYou=false):Quest=>({id:`${kind}:${id}`,rank,title:oneLiner(title,90)||'Untitled quest',detail,at,source:{kind,id},action,needsYou,band:'handled'});
// A request that failed or was stopped: shown open under Trouble, never counted.
const trouble=(q:Quest):Quest=>({...q,band:'trouble'});
// Coins are retired while economy is off: a capability offers Open chat instead, and no quest offers Open coins.
const coinsAction=(c:Ctx,x:SeasonCapability):Quest['action']=>c.economy?{label:'Open coins',panel:'season'}:{label:'Open chat',panel:'chat',cat:x.cat};
const capability=(rank:Rank,c:Ctx,x:SeasonCapability,detail:string,needsYou=false):Quest=>quest(rank,'capability',x.id,x.need,detail,null,coinsAction(c,x),needsYou);
const elapsed=(c:Ctx,iso:string|null)=>iso?c.now.getTime()-Date.parse(iso):NaN;

// Councils have no "waiting on owner" state. An interrupted council counts until the owner asks again for that cat.
// An owner step is live while its goal is still running or held (or it belongs to no goal).
const stepLive=(c:Ctx,s:OwnerStep)=>s.status==='open'&&(!s.goal||c.s.goals.some(g=>g.id===s.goal&&(g.status==='active'||g.status==='paused')));
// The page a step opens in the cats' browser: the one its cat named, else the first web address in its text (https://… or a bare
// host such as developers.facebook.com). File names like config.js are not hosts.
export function stepUrl(s:Pick<OwnerStep,'url'|'steps'>):string|undefined{
  if(s.url)return s.url;
  const full=s.steps.match(/https:\/\/[^\s)\]>"']+/)?.[0]?.replace(/[.,;:!?]+$/,'');if(full)return full;
  const host=s.steps.match(/(?<![\w./@-])(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co)(?![\w-])/i)?.[0];
  return host?`https://${host.toLowerCase()}/`:undefined;
}
// Every owner step needs the owner. A connect step names its directory service, and its action connects it.
const ownerStepQuest=(rank:Rank,s:OwnerStep,c:Ctx):Quest=>{
  // A sign-in step that is not a one-tap connect gets the Open the cats' browser button when it has a page to open: a blank window helps nobody.
  const url=s.connect?undefined:stepUrl(s);
  const request=requestOf(c,s.task),base={...quest(rank,'owner-step',s.id,`Owner step: ${s.title}`,s.steps,s.at,{label:'Mark done',panel:'projects'},true),...(s.kind?{stepKind:s.kind}:{}),...(s.due?{due:s.due}:{}),...(s.after?{after:s.after}:{}),...(request?{request}:{}),...(url&&(s.browser||s.kind==='account')?{browser:true as const,url,computer:true as const}:{})};
  const service=s.connect?directoryEntry(s.connect):undefined;
  // A token service carries where to make the token and how, so the owner pastes it in the quest instead of hunting through Connectors.
  const token=service&&tokenVar(service)?{token:{url:service.tokenUrl??service.homepage,help:service.tokenHelp??`Create a token on ${service.name}, copy it and paste it here.`}}:{};
  // A sign-in page handed out longer ago than the sign-in itself waits was abandoned: the step says so, and Connect starts a fresh one.
  const again=!!service&&!!s.signInAt&&elapsed(c,s.signInAt)>PENDING_MS;
  return service?{...base,...(again?{detail:`Sign-in to ${service.name} was not finished. Tap Connect ${service.name} to sign in again.\n\n${s.steps}`}:{}),action:{label:`Connect ${service.name}`,panel:'projects'},connect:{id:service.id,name:service.name,...token}}:base;
};
// A to-do whose live step holds a goal says which goal (N4): the goal row folds, and the to-do carries its title.
const ownerStep=(rank:Rank,s:OwnerStep,c:Ctx):Quest=>{
  const q=ownerStepQuest(rank,s,c),g=s.goal?c.s.goals.find(x=>x.id===s.goal):undefined;
  return g&&stepLive(c,s)?{...q,holds:g.title}:q;
};
const interruptedCouncils=(c:Ctx)=>c.s.councils.filter((k,i)=>k.status==='interrupted'&&c.s.cats.some(x=>x.id===k.target)&&!c.s.councils.slice(i+1).some(later=>later.target===k.target));

// One rule per rank, listed S to F. Each source matches exactly one rule, so ranks never overlap.
const RULES:Rule[]=[
  {rank:'S',reason:'A cat is blocked until the owner answers, money or account access needs the owner, or a real-money purchase waits for approval or payment.',collect:c=>[
    // A goal-removal suggestion blocks nothing: the Mayor's task already went on.
    ...c.s.approvals.filter(a=>a.status==='pending').map(a=>quest(a.gate==='goal-removal'?'C':'S','approval',a.id,a.question,a.gate==='goal-removal'?`${c.name(a.cat)} suggests removing this goal. Nothing changes until you answer.`:a.gate==='grant'?`${c.name(a.cat)} asks for a service another cat already has connected. Allow gives it at once.`:a.gate==='effect'?`No cat repeats that exact call until you say whether it went through. ${c.name(a.cat)}’s work carries on.`:a.gate==='routine'?`${c.name(a.cat)} asks to save a routine that runs on its own. Nothing runs until you allow it.`:a.gate==='cap'?'New work waits and running work pauses until you raise the monthly token cap, allow it this once, or wait for next month.':a.gate==='budget'?`${c.name(a.cat)}’s work waits until you raise their monthly token budget, or until next month. The rest of the town keeps running.`:`${c.name(a.cat)} is blocked until you answer.`,c.approvalAt.get(a.id)??null,{label:'Answer',panel:'chat',cat:a.cat},a.gate!=='goal-removal')),
    ...c.capabilities.filter(x=>x.status==='needs_owner'&&OWNER_ALERT_KINDS.has(x.kind)).map(x=>capability('S',c,x,`${c.name(x.cat)} asks for ${x.kind} access. Only you can grant it.`,true)),
    // N1: an approved purchase the owner still has to pay (Pre-pay). It stops being a to-do when its 72 h approval ends.
    ...c.purchases.filter(p=>p.status==='approved'&&!(p.expiresAt&&Date.parse(p.expiresAt)<=c.now.getTime())).map(p=>({...quest('S','purchase',p.id,p.vendor,'Approved. Pay the vendor, then tap Mark paid.',p.decidedAt??null,{label:'Mark paid',panel:'moonvault'},true),title:`Pay ${p.vendor} ${formatMinor(p.amountMinor,p.currency)}`,payment:{vendor:p.vendor,url:p.url,amount:formatMinor(p.amountMinor,p.currency),endsAt:p.expiresAt??null},...(requestOf(c,p.task)?{request:requestOf(c,p.task)}:{})})),
    // A real-money purchase waiting for the owner (Pre-pay, or over the Autopay limits).
    // The title is set after quest(): its one-line trim would stop at the decimal point of the amount.
    ...c.purchases.filter(p=>p.status==='pending').map(p=>({...quest('S','purchase',p.id,p.vendor,[p.reason,p.note,p.url].filter(Boolean).join(' · '),p.requestedAt,{label:'Review',panel:'moonvault'},true),title:`Approve purchase: ${p.vendor} ${formatMinor(p.amountMinor,p.currency)}`})),
  ]},
  {rank:'A',reason:'Any other capability needs the owner, a goal on hold for owner steps, a blocking owner step, a goal paused after two failed rounds in a row, or the latest season is paused or damaged with a reason (coins on only).',collect:c=>[
    ...c.s.goals.filter(g=>g.status==='paused'&&g.pausedBy==='owner-step').map(g=>quest('A','goal',g.id,`Waiting on you: ${g.title}`,g.note??'Mark the owner steps done and the goal resumes.',g.updatedAt,{label:'Open goal',panel:'projects'},true)),
    ...(c.s.ownerSteps??[]).filter(s=>s.blocking&&stepLive(c,s)).map(s=>ownerStep('A',s,c)),
    ...c.s.goals.filter(g=>g.status==='paused'&&g.pausedBy==='failures').map(g=>trouble(quest('A','goal',g.id,`Goal paused: ${g.title}`,g.note??'Two rounds failed in a row.',g.updatedAt,{label:'Open goal',panel:'projects'}))),
    ...c.capabilities.filter(x=>x.status==='needs_owner'&&!OWNER_ALERT_KINDS.has(x.kind)).map(x=>capability('A',c,x,`${c.name(x.cat)} asks for ${x.kind}. Only you can grant it.`,true)),
    ...c.runs.filter(r=>c.economy&&(r.status==='paused'||r.status==='damaged')&&r.reason).map(r=>quest('A','season',r.name,`Season ${r.name} is ${r.status}`,r.reason??'',null,{label:'Open coins',panel:'season'})),
  ]},
  {rank:'B',reason:'An integration (Telegram, Discord, mail, backup, ntfy) has had an error for over 15 minutes (health.ts). A project failed, a council was interrupted and the owner has not asked again, the cats workshop or Hermes did not finish setting up, a goal ran out of budget or was stopped, or a non-blocking owner step is open.',collect:c=>[
    ...(c.s.ownerSteps??[]).filter(s=>!s.blocking&&stepLive(c,s)).map(s=>ownerStep('B',s,c)),
    // 11.21: one owner item per integration whose error has lasted 15 min. It closes itself when health is ok again.
    ...stoppedIntegrations(c.integrations,c.now.getTime()).map(x=>quest('B','health',x.id,`${x.name} stopped working${x.since===null?'':` at ${new Date(x.since).toTimeString().slice(0,5)}`}: ${x.error}`,x.error,x.since===null?null:new Date(x.since).toISOString(),{label:'Open',panel:'chat'},true)),
    ...c.projects.filter(p=>p.status==='failed').map(p=>trouble(quest('B','project',p.id,p.title,`${p.counts.failed} of ${p.counts.tasks} tasks failed.`,p.updatedAt,{label:'Open project',panel:'projects',project:p.id}))),
    // The cats cannot fix a failed setup, so it needs the owner (N6). Retry is the owner's action.
    ...(c.setupFailure?[quest('B','workshop','setup',"The cats' workshop did not finish setting up",c.setupFailure.error,c.setupFailure.at,{label:'Retry',panel:'models'},true)]:[]),
    // Hermes's first-enable setup (hermes-bootstrap.ts): failed. Retry is POST /api/hermes/runtime/retry.
    ...(c.hermesSetup?.state==='failed'?[quest('B','hermes','setup','Hermes did not finish setting up',c.hermesSetup.error??'Setup failed.',c.hermesSetup.at,{label:'Retry',panel:'models'},true)]:[]),
    ...interruptedCouncils(c).map(k=>trouble(quest('B','council',k.id,`Council on ${c.name(k.target)} was interrupted`,k.reason,k.at,{label:'Open chat',panel:'chat',cat:k.target}))),
    // A goal that hit its daily or token budget, or that the Mayor stopped as impossible, needs the owner.
    ...c.s.goals.filter(g=>g.status==='paused'&&g.pausedBy==='budget').map(g=>trouble(quest('B','goal',g.id,`Goal paused: ${g.title}`,g.note??'Its budget is spent.',g.updatedAt,{label:'Open goal',panel:'projects'}))),
    ...c.s.goals.filter(g=>g.status==='stopped'&&g.endedBy==='mayor').map(g=>trouble(quest('B','goal',g.id,`Goal stopped: ${g.title}`,g.note??'The Mayor found it impossible.',g.updatedAt,{label:'Open goal',panel:'projects'}))),
  ]},
  {rank:'C',reason:'An AI model the owner enabled is not signed in or not reachable. Owner only, and counted: the cats cannot sign a model in. Local is skipped because it is always enabled.',collect:c=>Object.entries(c.models??{})
    .filter(([id,m])=>id!=='local'&&m.enabled&&!m.available)
    .map(([id,m])=>({computer:true as const,...quest('C','model',id,`${m.name} is not reachable`,m.detail??'Not reachable.',c.nowIso,{label:'Open AI models',panel:'models'},true)}))},
  {rank:'D',reason:'A running project has had no update for longer than quests.staleMinutes. Skipped when the config is missing.',collect:c=>c.staleMinutes===null?[]:c.projects
    .filter(p=>p.status==='running'&&elapsed(c,p.updatedAt)>c.staleMinutes!*MINUTE)
    .map(p=>quest('D','project',p.id,p.title,`No update for over ${c.staleMinutes} minutes.`,p.updatedAt,{label:'Open project',panel:'projects',project:p.id}))},
  {rank:'E',reason:'A sandbox capability request waits for a town decision, the Mayor suggests a model for a new cat, Hermes is setting up, or a For you card is open (owner only). Informational: none of them needs the owner.',collect:c=>[
    ...(c.hermesSetup?.state==='running'?[quest('E','hermes','setup','Setting up Hermes',`${c.hermesSetup.label??'Starting'} (step ${c.hermesSetup.done.length+1} of ${c.hermesSetup.total}).`,c.hermesSetup.startedAt,{label:'Open AI models',panel:'models'})]:[]),
    ...c.capabilities.filter(x=>x.status==='pending'&&x.tier==='sandbox')
      .map(x=>capability('E',c,x,`${c.name(x.cat)} asks for ${x.kind}. Waiting for a town decision.`)),
    // Owner only, like the model rank above: a null models status means the viewer is not the owner.
    ...(c.models===null?[]:c.s.cats.filter(x=>x.aiSuggestion&&!(x.aiSuggestion as any).applied).map(x=>quest('E','ai-suggestion',x.id,`Review the Mayor's model suggestion for ${x.name}`,x.aiSuggestion!.reason,x.aiSuggestion!.at,{label:'Review',panel:'chat',cat:x.id}))),
    // A For you card (plan 9.6): a Heads-up or a Suggestion. Start sends the Mayor a Request; Dismiss is the hide route.
    ...c.suggestions.map(x=>quest('E','suggestion',x.id,x.subject,'For you. Start asks the Mayor to take it on.',x.sourceAt,{label:'Start',panel:'chat',cat:'mayor'})),
  ]},
  {rank:'F',reason:'A project or goal finished, or Autopay charged the card, within quests.recentHours. A turned-in quest. Skipped when the config is missing.',collect:c=>c.recentHours===null?[]:[
    ...c.projects.filter(p=>p.status==='done'&&elapsed(c,p.updatedAt)<=c.recentHours!*HOUR)
      .map(p=>quest('F','project',p.id,p.title,'Turned in.',p.updatedAt,{label:'Open project',panel:'projects',project:p.id})),
    ...c.s.goals.filter(g=>g.status==='achieved'&&elapsed(c,g.updatedAt)<=c.recentHours!*HOUR)
      .map(g=>quest('F','goal',g.id,`Goal turned in: ${g.title}`,g.summary??'Turned in.',g.updatedAt,{label:'Open goal',panel:'projects'})),
    // Autopay notice: the card was charged for an auto-approved purchase.
    ...c.purchases.filter(p=>p.status==='paid'&&p.paidBy==='card'&&elapsed(c,p.paidAt??null)<=c.recentHours!*HOUR)
      .map(p=>({...quest('F','purchase',p.id,p.vendor,p.reason,p.paidAt??null,{label:'Open Moonvault',panel:'moonvault'}),title:`Paid ${p.vendor} ${formatMinor(p.paidMinor!,p.currency)}`})),
  ]},
];

export const rankRules=RULES.map(({rank,reason})=>({rank,reason}));

/** Quests sorted S first, then newest first. Unknown times sort last within their rank. On the host, quests handed off from a phone come first. */
export function quests(input:QuestInput):Quest[]{
  const approvalAt=new Map<string,string>(),untilOf=new Map<string,string>();
  // The latest hide per quest decides its snooze (11.18): a hide with `until` ends at that time; a later hide without one makes it permanent.
  for(const e of input.state.events){
    if(e.type==='approval.requested')approvalAt.set(e.data?.id,e.at);
    else if(e.type==='quest.hidden'){if(typeof e.data?.until==='string')untilOf.set(e.data.id,e.data.until);else untilOf.delete(e.data?.id);}
  }
  const name=(id:string)=>input.state.cats.find(c=>c.id===id)?.name??input.state.retiredCats.find(c=>c.id===id)?.name??id;
  const cfg=input.config??{};
  const ctx:Ctx={
    s:input.state,now:input.now,nowIso:input.now.toISOString(),name,approvalAt,
    projects:input.projects,
    capabilities:input.capabilities,
    runs:input.seasons.filter(r=>r.name===input.latestSeason),
    models:input.models,
    staleMinutes:positive(cfg.staleMinutes)?cfg.staleMinutes:null,
    recentHours:positive(cfg.recentHours)?cfg.recentHours:null,
    setupFailure:input.workshopSetup??null,
    hermesSetup:input.hermesSetup??null,
    purchases:input.purchases??[],
    suggestions:input.suggestions??[],
    economy:input.economy===true,
    integrations:input.integrations??[],
  };
  // A hidden quest is dropped only while its time is unchanged; a new failure or update brings it back.
  const hidden=input.state.hiddenQuests??{};
  // A hand-off is fresh for a day: a model quest that comes back next week is not still on its way to the computer.
  const handoffs=input.state.handoffs??{},handoff=(q:Quest):Quest=>handoffs[q.id]&&elapsed(ctx,handoffs[q.id]!)<DAY?{...q,handoff:handoffs[q.id]}:q;
  const first=(q:Quest)=>input.host&&q.handoff?0:1;
  // N4: a goal that a live owner step holds is context, not a task, so its row folds (the to-do carries the goal's title).
  const held=new Set((input.state.ownerSteps??[]).filter(s=>s.goal&&stepLive(ctx,s)).map(s=>s.goal!));
  // One band rule: a counted quest is needs; any other quest is trouble when a rule marked it so, else handled.
  const band=(q:Quest):Quest=>{const needsYou=q.needsYou&&!(q.source.kind==='goal'&&held.has(q.source.id));return {...q,needsYou,band:needsYou?'needs':q.band==='trouble'?'trouble':'handled'};};
  // A snoozed quest (11.18) is back once its `until` has passed; its hidden record still matches until then.
  const snoozed=(q:Quest)=>{const u=untilOf.get(q.id);return u!==undefined&&ctx.now.getTime()>=Date.parse(u);};
  return RULES.flatMap(r=>r.collect(ctx)).map(band).filter(q=>!(q.id in hidden&&hidden[q.id]===q.at&&!snoozed(q))).map(handoff).sort((a,b)=>first(a)-first(b)||(a.band==='needs'?0:1)-(b.band==='needs'?0:1)||(a.band==='needs'&&b.band==='needs'?needsOrder(a,b):RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank)||(b.at??'').localeCompare(a.at??'')||a.id.localeCompare(b.id)));
}
// Needs you order (11.18): money and blocking items first (rank S, or a blocking owner step), then the dated ones by due, then oldest first.
const needsOrder=(a:Quest,b:Quest)=>{
  const tier=(q:Quest)=>q.rank==='S'||(q.source.kind==='owner-step'&&q.rank==='A')?0:1;
  if(tier(a)!==tier(b))return tier(a)-tier(b);
  if(a.due&&b.due&&a.due!==b.due)return a.due<b.due?-1:1;
  if(!!a.due!==!!b.due)return a.due?-1:1;
  if(a.at===b.at)return a.id.localeCompare(b.id);
  if(a.at===null)return 1;
  if(b.at===null)return -1;
  return a.at.localeCompare(b.at)||a.id.localeCompare(b.id);
}

// The Done tab: finished items derived from resolved events, newest first. No store of its own; the journal is the record.
// device: who answered, where the event carries it. request: the task the item belongs to, where the event names one.
export type DoneQuest={id:string;rank:'F';title:string;detail:string;at:string;kind:string;device?:string;request?:string};
// owner: false for a viewer device. For you subjects come from the owner's mail and calendar, so only the owner reads them (plan 9.11);
// anyone else gets the card's generic name and no dismiss reason.
export function doneQuests(state:State,limit=50,owner=true):DoneQuest[]{
  const titles=new Map<string,string>(),questions=new Map<string,string>(),tasks=new Map<string,string>();
  for(const e of state.events){
    if(e.type==='goal.created')titles.set(e.data.id,e.data.title);
    if(e.type==='approval.requested'){questions.set(e.data.id,e.data.question);if(e.data.task)tasks.set(e.data.id,e.data.task);}
  }
  const subject=(id:string)=>(owner?state.suggestions?.[id]?.subject:undefined)??'For you card';
  const done=(e:Event,kind:string,title:string,detail:string,extra:{device?:unknown;request?:unknown}={}):DoneQuest=>({id:e.id,rank:'F',title:oneLiner(title,90)||'Untitled',detail:oneLiner(detail,200),at:e.at,kind,...(typeof extra.device==='string'&&extra.device?{device:extra.device}:{}),...(typeof extra.request==='string'&&extra.request?{request:extra.request}:{})});
  const out:DoneQuest[]=[];
  for(const e of state.events){
    const d=e.data??{};
    if(e.type==='approval.resolved'){
      const label=d.status==='approved'?'Approved':d.status==='rejected'?'Rejected':'Cancelled';
      out.push(done(e,'approval',questions.get(d.id)??'Decision',[label,d.answer].filter(Boolean).join(': '),{device:d.device,request:tasks.get(d.id)}));
    }else if(e.type==='owner.step.done'){
      const step=(state.ownerSteps??[]).find(x=>x.id===d.id);
      if(step?.connect)out.push(done(e,'connect',`Connect step done: ${directoryEntry(step.connect)?.name??step.connect}`,d.note||'Marked done.',{device:d.device}));
      else out.push(done(e,'owner-step',`Owner step done: ${step?.title??'step'}`,d.note||'Marked done.',{device:d.device}));
    }else if(e.type==='goal.updated'&&(d.status==='achieved'||d.status==='stopped')){
      out.push(done(e,'goal',`Goal ${d.status}: ${titles.get(d.id)??'goal'}`,d.summary??d.note??''));
    }else if(e.type==='owner.step.dismissed'){
      const step=(state.ownerSteps??[]).find(x=>x.id===d.id);
      out.push(done(e,'owner-step',`Owner step removed: ${step?.title??'step'}`,'Removed without being marked done.',{device:d.device}));
    }else if(e.type==='goal.archived'){
      out.push(done(e,'goal',`Goal removed: ${titles.get(d.id)??'goal'}`,d.reason??''));
    }else if(e.type==='purchase.decided'){
      out.push(done(e,'purchase',`${d.status==='approved'?'Approved':'Rejected'} purchase: ${d.vendor}`,[formatMinor(d.amountMinor,d.currency),d.reason].filter(Boolean).join('. ')));
    }else if(e.type==='purchase.paid'){
      out.push(done(e,'purchase',`Paid ${d.vendor}`,`${formatMinor(d.paidMinor,d.currency)}, ${d.paidBy==='card'?'charged to the card':'paid by the owner'}`));
    }else if(e.type==='suggestion.started'){
      out.push(done(e,'suggestion',`Started: ${subject(d.id)}`,'For you. The Mayor takes it on.',{request:d.task}));
    }else if(e.type==='suggestion.dismissed'){
      out.push(done(e,'suggestion',`Dismissed: ${subject(d.id)}`,(owner&&d.reason)||'Dismissed.'));
    }else if(e.type==='quest.hidden'){
      out.push(done(e,'hidden','Hidden from Needs you','Comes back when it changes.',{device:d.device}));
    }
  }
  return out.reverse().slice(0,limit);
}

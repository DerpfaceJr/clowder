import {oneLiner} from '../public/hologram.js';
import type {Project} from './projects.ts';
import type {Event,OwnerStep,State} from './store.ts';
import type {Purchase} from './real-money.ts';
import {formatMinor} from './treasury.ts';
import {directoryEntry,tokenVar} from './connector-directory.ts';
import {PENDING_MS} from './mcp-oauth.ts';
import type {BootstrapStatus} from './hermes-bootstrap.ts';

// The Quest log: one ordered table of rank rules. Each rule turns one kind of attention into quests. Pure over its input.
// needsYou: only the owner can act on it (a decision, a payment, an owner step, a sign-in). The rest are shown folded.
export type Rank='S'|'A'|'B'|'C'|'D'|'E'|'F';
export type Panel='chat'|'projects'|'season'|'models'|'moonvault';
export type Quest={id:string;rank:Rank;title:string;detail:string;at:string|null;source:{kind:string;id:string};action:{label:string;panel:Panel;cat?:string;project?:string};connect?:{id:string;name:string};browser?:true;url?:string;stepKind?:string;needsYou:boolean;computer?:true;handoff?:string};
// computer: it finishes only on the computer running Clowder (the cats' browser, a CLI sign-in), so a phone offers "Continue on your computer".
// handoff: when the owner did that; the host then lists it first for a day.
export type SeasonCapability={id:string;cat:string;need:string;kind:string;tier:string;status:string};
export type SeasonRun={name:string;status:string;reason?:string};
export type ModelStatus=Record<string,{name:string;enabled:boolean;available:boolean;detail?:string}>;
export type SetupFailure={error:string;failures:number;at:string};
export type QuestInput={state:State;projects:Project[];latestSeason?:string;capabilities:SeasonCapability[];seasons:SeasonRun[];models:ModelStatus|null;config?:{staleMinutes?:unknown;recentHours?:unknown};now:Date;workshopSetup?:SetupFailure|null;hermesSetup?:BootstrapStatus|null;purchases?:Purchase[];host?:boolean};

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
};
type Rule={rank:Rank;reason:string;collect:(c:Ctx)=>Quest[]};

const quest=(rank:Rank,kind:string,id:string,title:string,detail:string,at:string|null,action:Quest['action'],needsYou=false):Quest=>({id:`${kind}:${id}`,rank,title:oneLiner(title,90)||'Untitled quest',detail,at,source:{kind,id},action,needsYou});
const capability=(rank:Rank,c:Ctx,x:SeasonCapability,detail:string,needsYou=false):Quest=>quest(rank,'capability',x.id,x.need,detail,null,{label:'Open coins',panel:'season'},needsYou);
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
const ownerStep=(rank:Rank,s:OwnerStep,c:Ctx):Quest=>{
  // A sign-in step that is not a one-tap connect gets the Open the cats' browser button when it has a page to open: a blank window helps nobody.
  const url=s.connect?undefined:stepUrl(s);
  const base={...quest(rank,'owner-step',s.id,`Owner step: ${s.title}`,s.steps,s.at,{label:'Mark done',panel:'projects'},true),...(s.kind?{stepKind:s.kind}:{}),...(url&&(s.browser||s.kind==='account')?{browser:true as const,url,computer:true as const}:{})};
  const service=s.connect?directoryEntry(s.connect):undefined;
  // A token service carries where to make the token and how, so the owner pastes it in the quest instead of hunting through Connectors.
  const token=service&&tokenVar(service)?{token:{url:service.tokenUrl??service.homepage,help:service.tokenHelp??`Create a token on ${service.name}, copy it and paste it here.`}}:{};
  // A sign-in page handed out longer ago than the sign-in itself waits was abandoned: the step says so, and Connect starts a fresh one.
  const again=!!service&&!!s.signInAt&&elapsed(c,s.signInAt)>PENDING_MS;
  return service?{...base,...(again?{detail:`Sign-in to ${service.name} was not finished. Tap Connect ${service.name} to sign in again.\n\n${s.steps}`}:{}),action:{label:`Connect ${service.name}`,panel:'projects'},connect:{id:service.id,name:service.name,...token}}:base;
};
const interruptedCouncils=(c:Ctx)=>c.s.councils.filter((k,i)=>k.status==='interrupted'&&c.s.cats.some(x=>x.id===k.target)&&!c.s.councils.slice(i+1).some(later=>later.target===k.target));

// One rule per rank, listed S to F. Each source matches exactly one rule, so ranks never overlap.
const RULES:Rule[]=[
  {rank:'S',reason:'A cat is blocked until the owner answers, money or account access needs the owner, or a real-money purchase waits for approval.',collect:c=>[
    // A goal-removal suggestion blocks nothing: the Mayor's task already went on.
    ...c.s.approvals.filter(a=>a.status==='pending').map(a=>quest(a.gate==='goal-removal'?'C':'S','approval',a.id,a.question,a.gate==='goal-removal'?`${c.name(a.cat)} suggests removing this goal. Nothing changes until you answer.`:a.gate==='grant'?`${c.name(a.cat)} asks for a service another cat already has connected. Allow gives it at once.`:a.gate==='effect'?`No cat repeats that exact call until you say whether it went through. ${c.name(a.cat)}’s work carries on.`:a.gate==='routine'?`${c.name(a.cat)} asks to save a routine that runs on its own. Nothing runs until you allow it.`:a.gate==='cap'?'New work waits and running work pauses until you raise the monthly token cap, allow it this once, or wait for next month.':`${c.name(a.cat)} is blocked until you answer.`,c.approvalAt.get(a.id)??null,{label:'Answer',panel:'chat',cat:a.cat},a.gate!=='goal-removal')),
    ...c.capabilities.filter(x=>x.status==='needs_owner'&&OWNER_ALERT_KINDS.has(x.kind)).map(x=>capability('S',c,x,`${c.name(x.cat)} asks for ${x.kind} access. Only you can grant it.`,true)),
    // A real-money purchase waiting for the owner (Pre-pay, or over the Autopay limits).
    // The title is set after quest(): its one-line trim would stop at the decimal point of the amount.
    ...c.purchases.filter(p=>p.status==='pending').map(p=>({...quest('S','purchase',p.id,p.vendor,[p.reason,p.note,p.url].filter(Boolean).join(' · '),p.requestedAt,{label:'Review',panel:'moonvault'},true),title:`Approve purchase: ${p.vendor} ${formatMinor(p.amountMinor,p.currency)}`})),
  ]},
  {rank:'A',reason:'Any other capability needs the owner, a goal on hold for owner steps, a blocking owner step, a goal paused after two failed rounds in a row, or the latest season is paused or damaged with a reason.',collect:c=>[
    ...c.s.goals.filter(g=>g.status==='paused'&&g.pausedBy==='owner-step').map(g=>quest('A','goal',g.id,`Waiting on you: ${g.title}`,g.note??'Mark the owner steps done and the goal resumes.',g.updatedAt,{label:'Open goal',panel:'projects'},true)),
    ...(c.s.ownerSteps??[]).filter(s=>s.blocking&&stepLive(c,s)).map(s=>ownerStep('A',s,c)),
    ...c.s.goals.filter(g=>g.status==='paused'&&g.pausedBy==='failures').map(g=>quest('A','goal',g.id,`Goal paused: ${g.title}`,g.note??'Two rounds failed in a row.',g.updatedAt,{label:'Open goal',panel:'projects'})),
    ...c.capabilities.filter(x=>x.status==='needs_owner'&&!OWNER_ALERT_KINDS.has(x.kind)).map(x=>capability('A',c,x,`${c.name(x.cat)} asks for ${x.kind}. Only you can grant it.`,true)),
    ...c.runs.filter(r=>(r.status==='paused'||r.status==='damaged')&&r.reason).map(r=>quest('A','season',r.name,`Season ${r.name} is ${r.status}`,r.reason??'',null,{label:'Open coins',panel:'season'})),
  ]},
  {rank:'B',reason:'A project failed, a council was interrupted and the owner has not asked again, the cats workshop did not finish setting up, or a non-blocking owner step is open.',collect:c=>[
    ...(c.s.ownerSteps??[]).filter(s=>!s.blocking&&stepLive(c,s)).map(s=>ownerStep('B',s,c)),
    ...c.projects.filter(p=>p.status==='failed').map(p=>quest('B','project',p.id,p.title,`${p.counts.failed} of ${p.counts.tasks} tasks failed.`,p.updatedAt,{label:'Open project',panel:'projects',project:p.id})),
    ...(c.setupFailure?[quest('B','workshop','setup',"The cats' workshop did not finish setting up",c.setupFailure.error,c.setupFailure.at,{label:'Retry',panel:'models'})]:[]),
    // Hermes's first-enable setup (hermes-bootstrap.ts): failed, or offline. Retry is POST /api/hermes/runtime/retry.
    ...(c.hermesSetup?.state==='failed'?[quest('B','hermes','setup','Hermes did not finish setting up',c.hermesSetup.error??'Setup failed.',c.hermesSetup.at,{label:'Retry',panel:'models'})]:[]),
    ...interruptedCouncils(c).map(k=>quest('B','council',k.id,`Council on ${c.name(k.target)} was interrupted`,k.reason,k.at,{label:'Open chat',panel:'chat',cat:k.target})),
    // A goal that hit its daily or token budget, or that the Mayor stopped as impossible, needs the owner.
    ...c.s.goals.filter(g=>g.status==='paused'&&g.pausedBy==='budget').map(g=>quest('B','goal',g.id,`Goal paused: ${g.title}`,g.note??'Its budget is spent.',g.updatedAt,{label:'Open goal',panel:'projects'})),
    ...c.s.goals.filter(g=>g.status==='stopped'&&g.endedBy==='mayor').map(g=>quest('B','goal',g.id,`Goal stopped: ${g.title}`,g.note??'The Mayor found it impossible.',g.updatedAt,{label:'Open goal',panel:'projects'})),
  ]},
  {rank:'C',reason:'An AI model the owner enabled is not signed in or not reachable. Owner only. Local is skipped because it is always enabled.',collect:c=>Object.entries(c.models??{})
    .filter(([id,m])=>id!=='local'&&m.enabled&&!m.available)
    .map(([id,m])=>({computer:true as const,...quest('C','model',id,`${m.name} is not reachable`,m.detail??'Not reachable.',c.nowIso,{label:'Open AI models',panel:'models'})}))},
  {rank:'D',reason:'A running project has had no update for longer than quests.staleMinutes. Skipped when the config is missing.',collect:c=>c.staleMinutes===null?[]:c.projects
    .filter(p=>p.status==='running'&&elapsed(c,p.updatedAt)>c.staleMinutes!*MINUTE)
    .map(p=>quest('D','project',p.id,p.title,`No update for over ${c.staleMinutes} minutes.`,p.updatedAt,{label:'Open project',panel:'projects',project:p.id}))},
  {rank:'E',reason:'A sandbox capability request waits for a town decision, the Mayor suggests a model for a new cat, or Hermes is setting up. Informational.',collect:c=>[
    ...(c.hermesSetup?.state==='running'?[quest('E','hermes','setup','Setting up Hermes',`${c.hermesSetup.label??'Starting'} (step ${c.hermesSetup.done.length+1} of ${c.hermesSetup.total}).`,c.hermesSetup.startedAt,{label:'Open AI models',panel:'models'})]:[]),
    ...c.capabilities.filter(x=>x.status==='pending'&&x.tier==='sandbox')
      .map(x=>capability('E',c,x,`${c.name(x.cat)} asks for ${x.kind}. Waiting for a town decision.`)),
    // Owner only, like the model rank above: a null models status means the viewer is not the owner.
    ...(c.models===null?[]:c.s.cats.filter(x=>x.aiSuggestion&&!(x.aiSuggestion as any).applied).map(x=>quest('E','ai-suggestion',x.id,`Review the Mayor's model suggestion for ${x.name}`,x.aiSuggestion!.reason,x.aiSuggestion!.at,{label:'Review',panel:'chat',cat:x.id}))),
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
  const approvalAt=new Map<string,string>();
  for(const e of input.state.events)if(e.type==='approval.requested')approvalAt.set(e.data?.id,e.at);
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
  };
  // A hidden quest is dropped only while its time is unchanged; a new failure or update brings it back.
  const hidden=input.state.hiddenQuests??{};
  // A hand-off is fresh for a day: a model quest that comes back next week is not still on its way to the computer.
  const handoffs=input.state.handoffs??{},handoff=(q:Quest):Quest=>handoffs[q.id]&&elapsed(ctx,handoffs[q.id]!)<DAY?{...q,handoff:handoffs[q.id]}:q;
  const first=(q:Quest)=>input.host&&q.handoff?0:1;
  return RULES.flatMap(r=>r.collect(ctx)).filter(q=>!(q.id in hidden&&hidden[q.id]===q.at)).map(handoff).sort((a,b)=>first(a)-first(b)||RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank)||(b.at??'').localeCompare(a.at??'')||a.id.localeCompare(b.id));
}

// The Done tab: finished items derived from resolved events, newest first. No store of its own; the journal is the record.
export type DoneQuest={id:string;rank:'F';title:string;detail:string;at:string;kind:string};
export function doneQuests(state:State,limit=50):DoneQuest[]{
  const titles=new Map<string,string>(),questions=new Map<string,string>();
  for(const e of state.events){
    if(e.type==='goal.created')titles.set(e.data.id,e.data.title);
    if(e.type==='approval.requested')questions.set(e.data.id,e.data.question);
  }
  const done=(e:Event,kind:string,title:string,detail:string):DoneQuest=>({id:e.id,rank:'F',title:oneLiner(title,90)||'Untitled',detail:oneLiner(detail,200),at:e.at,kind});
  const out:DoneQuest[]=[];
  for(const e of state.events){
    const d=e.data??{};
    if(e.type==='approval.resolved'){
      const label=d.status==='approved'?'Approved':d.status==='rejected'?'Rejected':'Cancelled';
      out.push(done(e,'approval',questions.get(d.id)??'Decision',[label,d.answer].filter(Boolean).join(': ')));
    }else if(e.type==='owner.step.done'){
      const step=(state.ownerSteps??[]).find(x=>x.id===d.id);
      out.push(done(e,'owner-step',`Owner step done: ${step?.title??'step'}`,d.note||'Marked done.'));
    }else if(e.type==='goal.updated'&&(d.status==='achieved'||d.status==='stopped')){
      out.push(done(e,'goal',`Goal ${d.status}: ${titles.get(d.id)??'goal'}`,d.summary??d.note??''));
    }else if(e.type==='owner.step.dismissed'){
      const step=(state.ownerSteps??[]).find(x=>x.id===d.id);
      out.push(done(e,'owner-step',`Owner step removed: ${step?.title??'step'}`,'Removed without being marked done.'));
    }else if(e.type==='goal.archived'){
      out.push(done(e,'goal',`Goal removed: ${titles.get(d.id)??'goal'}`,d.reason??''));
    }
  }
  return out.reverse().slice(0,limit);
}

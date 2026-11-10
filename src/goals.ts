// Ongoing goals: the Mayor works a goal in rounds, with pauses between them. The round engine lives in engine.ts (Town);
// this file holds the settings, the budget arithmetic, the round prompt and the owner-only routes.
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {oneLiner} from '../public/one-liner.js';
import {isOwner} from './access.ts';
import type {Goal,State} from './store.ts';
import type {Town} from './engine.ts';
import {artifactIndex} from './artifacts.ts';

export type GoalSettings={roundPauseSeconds:number;maxRoundsPerDay:number|null;tokenBudget:number|null};
export const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
/** One usage row's provider-reported tokens, or null when it reported none. Every token count in town (goal and routine budgets, the week, the monthly cap) adds rows through this. */
export const rowTokens=(u:any):number|null=>{let n:number|null=null;for(const x of [u?.input,u?.output])if(finite(x))n=(n??0)+x;return n;};
/** A budget is spent once the floor count reaches it; null is no budget. Goal, routine and town-wide caps all ask this. */
export const budgetSpent=(used:number,budget:number|null)=>budget!==null&&used>=budget;

// The config's goals block, read when a goal is created or a round is scheduled. Missing or damaged values take the shipped defaults.
export function goalSettings(config:any):GoalSettings{
  const g=config?.goals??{};
  return {
    roundPauseSeconds:finite(g.roundPauseSeconds)&&g.roundPauseSeconds>=0?g.roundPauseSeconds:60,
    // No daily round cap unless the config sets one: an ongoing goal runs until it is achieved, paused or stopped.
    maxRoundsPerDay:finite(g.maxRoundsPerDay)&&g.maxRoundsPerDay>=1?Math.floor(g.maxRoundsPerDay):null,
    tokenBudget:finite(g.tokenBudget)&&g.tokenBudget>0?Math.floor(g.tokenBudget):null,
  };
}

// Local calendar day. A goal's round count restarts when the day changes.
export const dayKey=(now=new Date())=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
export const roundsToday=(goal:Goal,now=new Date())=>goal.day===dayKey(now)?goal.roundsToday:0;

/** The goal a task belongs to: the round task that carries the goal id, or any task under one. Undefined outside a goal.
 *  key routine: the routine whose run it is (routines.ts), by the same walk. */
export function goalOfTasks(state:State,key:'goal'|'routine'='goal'){
  const tasks=new Map(state.tasks.map(t=>[t.id,t]));
  return (id:string|undefined):string|undefined=>{
    let t=id?tasks.get(id):undefined;const seen=new Set<string>();
    while(t&&!seen.has(t.id)){if(t[key])return t[key];seen.add(t.id);t=t.parent?tasks.get(t.parent):undefined;}
    return undefined;
  };
}

// Provider-reported tokens per goal, children included. A row with no number adds nothing; reported is false when no row had one.
export function goalUsage(state:State,goalOf=goalOfTasks(state)):Map<string,{total:number;reported:boolean}>{
  const out=new Map<string,{total:number;reported:boolean}>();
  for(const u of state.usage){
    const id=goalOf(u.task);if(!id)continue;
    const row=out.get(id)??{total:0,reported:false},n=rowTokens(u);
    if(n!==null){row.total+=n;row.reported=true;}
    out.set(id,row);
  }
  return out;
}
// A missing count adds nothing, so this is a floor. The engine's token budget check reads it, so it stays a plain number.
export function goalTokens(state:State,goalId:string):number{return goalUsage(state).get(goalId)?.total??0;}

export const WEEK_MS=7*24*60*60*1000;
/** Provider-reported tokens over the last seven days, town-wide. null when no row in that span reported a number. */
export function weekTokens(state:State,now=new Date()):number|null{
  const since=now.getTime()-WEEK_MS;let total=0,reported=false;
  for(const u of state.usage){
    if(!(Date.parse(u.at)>=since))continue;
    const n=rowTokens(u);if(n!==null){total+=n;reported=true;}
  }
  return reported?total:null;
}

export type CatChip={id:string; name:string; icon:string; color:string};
export type GoalDetail={tokensUsed:number; tokensKnown:boolean; lastRoundAt:string|null; ownerStepsOpen:number; artifacts:string[]; cats:CatChip[]};
/** Per-goal figures for the Projects panel, read from the journal. tokensKnown is false when no row reported a number, so the panel shows a dash, not 0. */
export function goalDetails(state:State):Map<string,GoalDetail>{
  const goalOf=goalOfTasks(state),usage=goalUsage(state,goalOf);
  const lastRound=new Map<string,string>();
  for(const e of state.events){
    const goal=e.type==='task.created'?e.data?.goal:undefined;
    if(typeof goal==='string'&&(!lastRound.get(goal)||e.at>lastRound.get(goal)!))lastRound.set(goal,e.at);
  }
  // Artifacts are saved by a task, so each one belongs to the goal of its task. Index order is oldest first; the panel wants newest first.
  const artifacts=new Map<string,string[]>();
  for(const a of artifactIndex(state.events).reverse()){
    const id=goalOf(a.task??undefined);if(!id)continue;
    const list=artifacts.get(id)??[];list.push(a.id);artifacts.set(id,list);
  }
  const catById=new Map([...state.cats,...state.retiredCats].map(c=>[c.id,c]));
  const cats=new Map<string,CatChip[]>();
  for(const t of state.tasks){
    const id=goalOf(t.id);if(!id)continue;
    const list=cats.get(id)??[];
    if(!list.some(c=>c.id===t.cat)){const c=catById.get(t.cat);list.push({id:t.cat,name:c?.name??t.cat,icon:c?.icon??'',color:c?.color??'#8c8a7d'});}
    cats.set(id,list);
  }
  const steps=new Map<string,number>();
  for(const s of state.ownerSteps)if(s.status==='open'&&s.goal)steps.set(s.goal,(steps.get(s.goal)??0)+1);
  return new Map(state.goals.map(g=>{const u=usage.get(g.id);return [g.id,{tokensUsed:u?.total??0,tokensKnown:!!u?.reported,lastRoundAt:lastRound.get(g.id)??null,ownerStepsOpen:steps.get(g.id)??0,artifacts:artifacts.get(g.id)??[],cats:cats.get(g.id)??[]}] as [string,GoalDetail];}));
}

export type GoalReview={id:string; goal:string; goalTitle:string|null; cat:string; reason:string; question:string; mergeInto:string|null; options:string[]};
/** Pending removal suggestions, for the Projects panel's Review strip. mergeInto is the duplicate's title when the Mayor named one (it is only in the question text). */
export function goalReviews(state:State):GoalReview[]{
  return state.approvals.filter(a=>a.status==='pending'&&a.gate==='goal-removal').map(a=>({
    id:a.id,
    goal:a.goal??'',
    goalTitle:state.goals.find(g=>g.id===a.goal)?.title??null,
    cat:a.cat,
    reason:a.reason??'',
    question:a.question,
    mergeInto:/Duplicate of ‘(.+)’\.$/.exec(a.question)?.[1]??null,
    options:a.options,
  }));
}

// The full prompt for one round. The progress log and last summary keep it compact: only the newest lines are sent.
// notes: owner steps finished since the last round. open: titles of owner steps still waiting on the owner.
export function roundPrompt(goal:Goal,n:number,extra:{notes?:string[];open?:string[]}={}):string{
  const recent=goal.log.slice(-8).map(line=>`- ${line}`).join('\n')||'- none yet';
  return [
    `This is round ${n} of the ongoing goal "${goal.title}".`,
    `Success criteria: ${goal.success}`,
    `Progress log, one line per round:\n${recent}`,
    goal.summary?`Last summary: ${oneLiner(goal.summary,600)}`:'',
    extra.notes?.length?`Since the last round:\n${extra.notes.map(line=>`- ${oneLiner(line,700)}`).join('\n')}`:'',
    extra.open?.length?`Still waiting on the owner (do not file these again): ${extra.open.map(t=>oneLiner(t,120)).join('; ')}`:'',
    'Work toward the goal now, using your tools and delegation. If the success criteria are met, call complete_goal with a summary of the result. If the goal is abandoned or cannot be done at all, call stop_goal with the reason. If the owner must act for part of the work, file request_owner_step and keep going on what you can do. If the owner’s steps are the only work left, file the last one with blocking_remaining true: the goal then waits until the owner marks the steps done. Never call stop_goal just because the owner must act. Otherwise finish with a short summary of what you did and what comes next.',
  ].filter(Boolean).join('\n');
}

// The Mayor's list of ongoing goals with the review guidance. Archived goals are not in state, so they never appear. Capped at 20 lines.
const STATUS_ORDER:Record<Goal['status'],number>={active:0,paused:1,achieved:2,stopped:3};
type CouncilPolicy={protectedCats:string[];maxEvidenceTasks:number;idleDays?:number};
// Cats a goal review may put to a retirement vote, with their finished task ids as evidence: every goal they served has ended,
// or (config council.idleDays) they have had no work for that long and serve no ongoing goal. Cats with running work, protected cats and cats kept since their last work are left out.
export function retirementCandidates(state:State,policy:CouncilPolicy,now=Date.now()):{cat:string;why:string;evidence:string[]}[]{
  const goalOf=goalOfTasks(state),catOf=new Map(state.tasks.map(t=>[t.id,t.cat])),last=new Map<string,string>();
  for(const e of state.events)if(e.type==='task.created'||e.type==='task.updated'){const cat=catOf.get(e.data?.id);if(cat)last.set(cat,e.at);}
  const ended=(id:string)=>{const g=state.goals.find(g=>g.id===id);return !g||g.status==='achieved'||g.status==='stopped';};
  return state.cats.flatMap(c=>{
    if(policy.protectedCats.includes(c.id))return [];
    const mine=state.tasks.filter(t=>t.cat===c.id),open=['running','waiting','waiting_child','queued'];
    if(mine.some(t=>open.includes(t.status)))return [];
    const evidence=mine.slice(-policy.maxEvidenceTasks).map(t=>t.id);
    const at=last.get(c.id);
    if(!evidence.length||!at||state.councils.some(k=>k.target===c.id&&k.status==='kept'&&k.at>=at))return [];
    const goals=[...new Set(mine.map(t=>goalOf(t.id)).filter((g):g is string=>!!g))];
    if(!goals.every(ended))return [];
    const idle=Math.floor((now-Date.parse(at))/86_400_000);
    const why=goals.length?'every goal it worked on has ended':policy.idleDays&&idle>=policy.idleDays?`no work for ${idle} days`:'';
    return why?[{cat:c.id,why:`${why}, last work ${at.slice(0,10)}`,evidence}]:[];
  });
}

// now: the clock, injectable so a test's fixed dates do not age into different answers.
export function goalReviewBrief(state:State,policy?:CouncilPolicy,now=Date.now()):string{
  const goals=[...state.goals].sort((a,b)=>STATUS_ORDER[a.status]-STATUS_ORDER[b.status]||b.createdAt.localeCompare(a.createdAt));
  if(!goals.length)return '';
  const idle=policy?retirementCandidates(state,policy,now).slice(0,10):[];
  const retire=idle.length?`\nCats that may be done (ids and evidence for review_cat):\n${idle.map(c=>`- ${c.cat} | ${c.why} | evidence ${c.evidence.join(',')}`).join('\n')}\nWhen the owner asks you to review goals or the town (not during a goal round), call review_cat once for each listed cat that no ongoing goal still needs, with the listed task ids as evidence and the reason. Keep a cat whose role an active or paused goal still uses.`:'';
  const lines=goals.slice(0,20).map(g=>`- ${g.id} | ${oneLiner(g.title,80)} | ${g.status}${g.pausedBy?` (${g.pausedBy})`:''} | ${g.mode==='demo'?'Demonstration':g.mode} | ${g.rounds} rounds | created ${g.createdAt.slice(0,10)} | last: ${oneLiner(g.log.at(-1)??'no rounds yet',120)}`);
  if(goals.length>20)lines.push(`- ${goals.length-20} more not listed`);
  return `\nOngoing goals (ids for suggest_goal_removal):\n${lines.join('\n')}\nWhen you start a goal (set_goal) or begin a goal round, if two goals cover the same thing, or one is stale, finished in practice, or a Demonstration goal, call suggest_goal_removal once for each such goal. Never suggest the goal you are working on, and do not suggest a goal that already has a pending or kept suggestion.${retire}`;
}

// Owner-only, like every other owner route: the isOwner rule (the host or a paired owner device) gives proxied, LAN and viewer devices a 403. Closing owner steps follows `decide`.
// decide: who may close owner steps, the same rule as answering approvals; left out, isOwner. device: the paired device id, or 'host'.
export function registerGoalRoutes(app:FastifyInstance,opts:{town:()=>Town;decide?:(req:FastifyRequest)=>boolean;device?:(req:FastifyRequest)=>string}){
  const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{if(!isOwner(req))return reply.code(403).send({error:'Goals are managed on the host computer.'});};
  const decider=async(req:FastifyRequest,reply:FastifyReply)=>{if(!(opts.decide??isOwner)(req))return reply.code(403).send({error:'Owner steps are closed on the host computer or an owner device.'});};
  const device=(req:FastifyRequest)=>opts.device?.(req)??'host';
  // The panel's read: goals with their per-goal figures, the pending removal reviews, and the town's tokens over the last seven days.
  app.get('/api/goals',async req=>{
    const s=opts.town().store.state,details=goalDetails(s);
    return {owner:isOwner(req),goals:s.goals.map(g=>({...g,roundsToday:roundsToday(g),...details.get(g.id)!})),reviews:goalReviews(s),week:{tokens:weekTokens(s)}};
  });
  app.post('/api/goals/:id/action',{onRequest:ownerOnly,schema:{body:{type:'object',required:['action'],additionalProperties:false,properties:{action:{type:'string',enum:['pause','resume','stop']}}}}},async req=>{
    opts.town().goalAction('owner',(req.params as {id:string}).id,(req.body as {action:'pause'|'resume'|'stop'}).action);
    return {ok:true};
  });
  app.post('/api/goals/:id/archive',{onRequest:ownerOnly},async req=>{
    opts.town().archiveGoal('owner',(req.params as {id:string}).id,'Removed by you.');
    return {ok:true};
  });
  // The host or an owner device. Marking a step done adds its note to the goal's next round; a goal held for it resumes once no step is open.
  app.post('/api/owner-steps/:id/done',{onRequest:decider,schema:{body:{type:'object',additionalProperties:false,properties:{note:{type:'string',maxLength:600}}}}},async req=>{
    const message=opts.town().ownerStepDone('owner',(req.params as {id:string}).id,String((req.body as {note?:string}|undefined)?.note??''),device(req));
    return {ok:true,message};
  });
  // Plan 11.9: the owner's ticks on an open step's lines. A tick from one device reads back on another.
  app.get('/api/owner-steps/:id/ticks',{onRequest:decider},async req=>{
    const step=opts.town().store.state.ownerSteps.find(s=>s.id===(req.params as {id:string}).id);
    return {ticks:step?.ticks??[]};
  });
  app.post('/api/owner-steps/:id/tick',{onRequest:decider,schema:{body:{type:'object',required:['line','done'],additionalProperties:false,properties:{line:{type:'integer',minimum:0,maximum:99},done:{type:'boolean'}}}}},async req=>{
    const body=req.body as {line:number;done:boolean};
    const ticks=opts.town().ownerStepTick('owner',(req.params as {id:string}).id,body.line,body.done,device(req));
    return {ok:true,ticks};
  });
  // The host or an owner device. Removing a step without doing it: a goal held for it resumes once no step is open.
  app.post('/api/owner-steps/:id/dismiss',{onRequest:decider},async req=>{
    opts.town().ownerStepDismiss('owner',(req.params as {id:string}).id,device(req));
    return {ok:true};
  });
  app.post('/api/goals/:id/budget',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,properties:{maxRoundsPerDay:{type:['integer','null'],minimum:1,maximum:1000},tokenBudget:{type:['integer','null'],minimum:1}}}}},async req=>{
    opts.town().setGoalBudget('owner',(req.params as {id:string}).id,req.body as {maxRoundsPerDay?:number|null;tokenBudget?:number|null});
    return {ok:true};
  });
}

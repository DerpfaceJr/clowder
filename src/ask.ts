// Asides: the owner asks a cat about progress while it works. One tool-less provider call answers from a compact
// context. Nothing here creates a task, touches a running task's context or a goal, or blocks or cancels work.
import type {FastifyInstance} from 'fastify';
import {oneLiner} from '../public/hologram.js';
import {normalizeMode} from './ai-options.ts';
import {projects} from './projects.ts';
import type {Cat, State} from './store.ts';
import type {Town} from './engine.ts';

const LIVE=['running','waiting','waiting_child'];
export const ASK_SYSTEM='You answer the owner’s question about progress on the work in Clowder. Answer honestly from the context below, and say plainly what is not known. Do not start work, do not promise changes, and do not call tools. Be brief.';

/** The compact context an aside is answered from: this cat’s live work with its latest messages, goals, project progress and the memory brief. */
export function askContext(state:State,cat:Cat,brief:string):string{
  // ponytail: scans the whole message list once per live task; index messages by task id if the log grows.
  const recent=(taskId:string)=>state.messages.filter(m=>m.task===taskId).slice(-4).map(m=>`    ${m.from} to ${m.to}: ${oneLiner(String(m.text),160)}`);
  const work=state.tasks.filter(t=>t.cat===cat.id&&LIVE.includes(t.status));
  const goals=state.goals.filter(g=>g.status==='active'||g.status==='paused');
  const list=projects(state).slice(0,5);
  return [
    `Cat: ${cat.name} (${cat.id}). Role: ${oneLiner(cat.role,200)}`,
    'Live work for this cat:',
    ...(work.length?work.flatMap(t=>[`- ${t.status}: ${oneLiner(t.text,160)}`,...recent(t.id)]):['- none']),
    'Ongoing goals:',
    ...(goals.length?goals.flatMap(g=>[`- "${oneLiner(g.title,120)}" (${g.status}${g.pausedBy?`, paused by ${g.pausedBy}`:''}), ${g.rounds} rounds. Success: ${oneLiner(g.success,200)}`,...g.log.slice(-4).map(l=>`    ${oneLiner(l,160)}`)]):['- none']),
    'Projects, newest first (done counts finished tasks, not verified results):',
    ...(list.length?list.map(p=>`- "${oneLiner(p.title,80)}": ${p.status}, ${p.counts.done} of ${p.counts.tasks} tasks done, led by ${p.lead}`):['- none']),
    brief?`Town memory: ${brief}`:'',
  ].filter(Boolean).join('\n');
}

/** The demo answer: a fixed template filled from the same state, with no model call. */
export function askDemo(state:State,cat:Cat):string{
  const live=state.tasks.filter(t=>t.cat===cat.id&&LIVE.includes(t.status));
  const waiting=live.filter(t=>t.status==='waiting').length;
  const goal=state.goals.find(g=>g.status==='active'||g.status==='paused');
  const count=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
  const goalLine=goal?`Goal “${oneLiner(goal.title,60)}” is ${goal.status}, after ${count(goal.rounds,'round')}.`:'No goal is running.';
  return `[Demonstration] ${cat.name} has ${count(live.length,'live task')}, ${waiting} waiting. ${goalLine} Nothing was started or changed by this question.`;
}

/** Owner aside route. Writes follow the /api/chat rule: the access hooks decide who may call it, so paired owner devices can too. */
export function registerAskRoute(app:FastifyInstance,opts:{town:()=>Town}){
  const string={type:'string',minLength:1,maxLength:12000};
  app.post('/api/ask',{schema:{body:{type:'object',required:['cat','text','mode'],additionalProperties:false,properties:{cat:string,text:string,mode:{type:'string',enum:['demo','local','hosted','claude','chatgpt','anthropic','plan']}}}}},async req=>{
    const b=req.body as {cat:string;text:string;mode:string};
    return {reply:await opts.town().ask(b.cat,b.text,normalizeMode(b.mode))};
  });
}

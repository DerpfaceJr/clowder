import {oneLiner} from '../public/one-liner.js';
import type {Cat, Event, State} from './store.ts';

/** A cat as the Projects panel shows it: name plus the avatar colour and icon. */
export type CatRef = {id:string; name:string; icon:string; color:string};
export type ProjectStatus = 'queued' | 'running' | 'waiting for you' | 'done' | 'failed' | 'stopped' | 'interrupted';
export type Project = {
  /** The root task of one owner request. Every root is an owner request, so there is no separate upkeep project. */
  id:string;
  title:string;
  status:ProjectStatus;
  /** The root's result when it was interrupted (why it stopped), else null. */
  reason:string|null;
  startedAt:string|null;
  updatedAt:string|null;
  group:{id:string; name:string; lead:string; members:CatRef[]; site:{x:number; z:number}} | null;
  /** The cat that owns the conversation to open: the group lead, or the cat the request was sent to. */
  lead:string;
  cats:CatRef[];
  counts:{tasks:number; done:number; running:number; waiting:number; failed:number};
  /** Finished tasks / total tasks, 0..1. A task-count proxy, not real completion: a 1-task project that is still running reads 0. */
  progress:number;
  pendingApprovals:{id:string; question:string; cat:string}[];
  lastMessage:{from:string; to:string; text:string; at:string|null} | null;
  /** Provider-reported tokens. null means no event in this project reported that field. */
  usage:{input:number|null; output:number|null};
};

export const FINISHED=new Set(['done','failed','cancelled','interrupted']);
const ACTIVE=new Set(['running','waiting','waiting_child']);
const latest=(a:string|null,b:string|null)=>!b?a:!a||b>a?b:a;
const sum=(values:(number|null|undefined)[])=>{const known=values.filter((v):v is number=>Number.isFinite(v));return known.length?known.reduce((a,b)=>a+b,0):null;};

/**
 * One project per owner request, newest first. Pure over the store state: nothing is written and no
 * event is replayed. Timestamps come from the event log, so the full history is needed (not the 150-event snapshot).
 */
export function projects(state:State):Project[]{
  const tasks=new Map(state.tasks.map(t=>[t.id,t]));
  const approvals=new Map(state.approvals.map(a=>[a.id,a]));
  const cats=new Map(state.cats.map(c=>[c.id,c]));
  const retired=new Map(state.retiredCats.map(c=>[c.id,c]));
  const ref=(id:string):CatRef=>{const c:Cat|undefined=cats.get(id)??retired.get(id);return {id,name:c?.name??id,icon:c?.icon??'',color:c?.color??'#8c8a7d'};};

  // Walk up the delegation chain to the root. The guard stops a malformed cycle from looping forever.
  const rootOf=new Map<string,string|null>();
  const rootId=(taskId:string|undefined):string|null=>{
    if(!taskId||!tasks.has(taskId))return null;
    if(rootOf.has(taskId))return rootOf.get(taskId)!;
    const seen=new Set<string>();let t=tasks.get(taskId)!;
    while(t.parent&&tasks.has(t.parent)&&!seen.has(t.id)){seen.add(t.id);t=tasks.get(t.parent)!;}
    rootOf.set(taskId,t.id);return t.id;
  };

  // Timestamps from the event log: the task's creation, and the last event that touched any task in its tree.
  const startedAt=new Map<string,string>(),updatedAt=new Map<string,string>();
  const touch=(root:string|null,at:string)=>{if(root)updatedAt.set(root,latest(updatedAt.get(root)??null,at)!);};
  for(const e of state.events as Event[]){
    const d=e.data??{};
    if(e.type==='task.created'){startedAt.set(d.id,e.at);touch(rootId(d.id),e.at);continue;}
    if(e.type==='task.updated'){touch(rootId(d.id),e.at);continue;}
    if(e.type==='message'||e.type==='usage'||e.type==='approval.requested'||e.type==='tool.started'||e.type==='tool.finished'){touch(rootId(d.task),e.at);continue;}
    if(e.type==='approval.resolved'){touch(rootId(approvals.get(d.id)?.task),e.at);}
  }

  // Each message and usage row carries its task; the latest message per project wins by log order.
  const lastMessage=new Map<string,Project['lastMessage']>();
  for(const m of state.messages){const root=rootId(m.task);if(root)lastMessage.set(root,{from:m.from,to:m.to,text:m.text,at:m.at??null});}
  const usageRows=new Map<string,{input:(number|null)[];output:(number|null)[]}>();
  for(const u of state.usage){const root=rootId(u.task);if(!root)continue;const row=usageRows.get(root)??{input:[],output:[]};row.input.push(u.input);row.output.push(u.output);usageRows.set(root,row);}

  const out:Project[]=[];
  const trees=new Map<string,typeof state.tasks>();
  for(const t of state.tasks){const root=rootId(t.id);if(root)trees.set(root,[...(trees.get(root)??[]),t]);}
  // Goal rounds are shown as goal cards, not as one project per round.
  for(const root of state.tasks.filter(t=>!t.parent&&!t.goal)){
    const tree=trees.get(root.id)??[];
    const counts={tasks:tree.length,done:0,running:0,waiting:0,failed:0};
    let finished=0;
    for(const t of tree){
      if(t.status==='done')counts.done++;
      if(t.status==='failed')counts.failed++;
      if(t.status==='waiting')counts.waiting++;
      if(ACTIVE.has(t.status)&&t.status!=='waiting')counts.running++;
      if(FINISHED.has(t.status))finished++;
    }
    // A goal-removal suggestion is reviewed in the Projects panel's Review strip, not as a decision on this request.
    const pendingApprovals=state.approvals.filter(a=>a.status==='pending'&&a.gate!=='goal-removal'&&rootId(a.task)===root.id).map(a=>({id:a.id,question:a.question,cat:a.cat}));
    // Overall status: a pending decision outranks everything; otherwise the request's newest owner turn decides: the root, or its latest
    // follow-up or Retry (plan 11.1, a child the owner sent), so a request retried to done reads done, not interrupted. Trees keep journal
    // order. A failed child the Mayor recovered from under a finished turn still reads done; the failure shows in counts.
    const head=tree.filter(t=>t.parent===root.id&&t.from==='owner').at(-1)??root;
    const status:ProjectStatus=pendingApprovals.length?'waiting for you'
      :head.status==='queued'?'queued'
      :head.status==='done'?'done'
      :head.status==='failed'?'failed'
      :head.status==='interrupted'?'interrupted'
      :head.status==='cancelled'?'stopped'
      :'running';
    const group=state.groups.find(g=>g.rootTask===root.id)??null;
    const members=group?state.cats.filter(c=>c.group===group.id).map(c=>ref(c.id)):[];
    const involved=[...new Set(tree.map(t=>t.cat))].map(ref);
    const usage=usageRows.get(root.id);
    out.push({
      id:root.id,
      title:oneLiner(root.text,60)||'Untitled request',
      status,
      reason:status==='interrupted'?root.result??null:null,
      startedAt:startedAt.get(root.id)??null,
      updatedAt:updatedAt.get(root.id)??startedAt.get(root.id)??null,
      group:group?{id:group.id,name:group.name,lead:group.lead,members,site:{x:group.site.x,z:group.site.z}}:null,
      lead:group?.lead??root.cat,
      cats:involved,
      counts,
      progress:tree.length?finished/tree.length:0,
      pendingApprovals,
      lastMessage:lastMessage.get(root.id)??null,
      usage:{input:sum(usage?.input??[]),output:sum(usage?.output??[])},
    });
  }
  // The Mayor's inbox first, oldest first (the order it will pick them up). Then newest first; an unknown start time sorts last.
  return out.sort((a,b)=>{
    const qa=a.status==='queued',qb=b.status==='queued';
    if(qa!==qb)return qa?-1:1;
    if(qa)return (a.startedAt??'').localeCompare(b.startedAt??'')||a.id.localeCompare(b.id);
    return (b.startedAt??'').localeCompare(a.startedAt??'')||a.id.localeCompare(b.id);
  });
}


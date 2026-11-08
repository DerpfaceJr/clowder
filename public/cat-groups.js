import {oneLiner} from './hologram.js';

// The Cats list as groups. Pure: plain state in, plain data out, so the test runs the code the page runs.
// A director is a cat with `directs` (the project key: a goal id, or a request's root task id). Each director leads one
// group, and its team is every cat whose manager chain reaches it. Two directors can share one project key (the Mayor
// appointed two projects in one request), so groups are keyed by the director's id, never by `directs` or the hamlet.
// Town: the Mayor and manager-less cats in the town centre. Unassigned: a dangling or looping manager, or a manager-less cat in a project hamlet.

const TOWN='town', UNASSIGNED='unassigned', ROLE_PROJECT=/Direct the project “([^”]+)”/;
const FIXED_TITLE={[TOWN]:'Town',[UNASSIGNED]:'Unassigned'};

/** The project a director runs: the title the Mayor gave it (in the default role), else the goal or request it runs, else its hamlet's name. */
function projectTitle(director,{goals,groups,tasks}){
  const named=ROLE_PROJECT.exec(director.role??'')?.[1];
  const goal=goals.find(g=>g.id===director.directs);
  const hamlet=groups.find(g=>g.rootTask&&g.rootTask===director.directs);
  const task=tasks.find(t=>t.id===director.directs);
  return oneLiner(named||goal?.title||hamlet?.name||task?.text||'',60)||'Untitled project';
}

/**
 * The Cats list as groups, in order: Town, one per director (cats order), Unassigned. Each group is
 * {key, kind:'town'|'project'|'unassigned', title, lead, cats, count, working}; cats are director first (Mayor first in Town).
 * query filters cats by name or role (case-insensitive) and drops groups left empty. working: a cat in the group is working.
 */
export function catGroups(cats,{groups=[],goals=[],tasks=[],isWorking=()=>false,query=''}={}){
  const byId=new Map(cats.map(c=>[c.id,c]));
  const hamletLead=new Map(groups.map(g=>[g.id,g.lead]));
  // The group key a cat belongs to. seen stops a manager loop.
  const place=(c,seen)=>{
    if(c.id==='mayor')return TOWN;
    if(c.directs)return `lead:${c.id}`;
    if(seen.has(c.id))return UNASSIGNED;
    seen.add(c.id);
    const lead=byId.get(hamletLead.get(c.group));
    const hamlet=lead?.directs?`lead:${lead.id}`:null;
    if(c.manager==='mayor')return hamlet??TOWN;
    if(c.manager){const boss=byId.get(c.manager);return boss?place(boss,seen):UNASSIGNED;}
    return hamlet??(!c.group||c.group==='main'?TOWN:UNASSIGNED);
  };
  const members=new Map();
  for(const c of cats){const key=place(c,new Set());members.set(key,[...(members.get(key)??[]),c]);}
  const q=query.trim().toLowerCase();
  const keys=[TOWN,...cats.filter(c=>c.directs).map(c=>`lead:${c.id}`),UNASSIGNED];
  const out=[];
  for(const key of keys){
    const all=members.get(key);
    if(!all)continue;
    const director=key.startsWith('lead:')?byId.get(key.slice(5)):null;
    const ordered=director?[director,...all.filter(c=>c!==director)]:[...all].sort((a,b)=>(b.id==='mayor')-(a.id==='mayor'));
    const shown=q?ordered.filter(c=>`${c.name} ${c.role??''}`.toLowerCase().includes(q)):ordered;
    if(!shown.length)continue;
    out.push({key,kind:director?'project':key,title:director?projectTitle(director,{goals,groups,tasks}):FIXED_TITLE[key],lead:director,cats:shown,count:shown.length,working:ordered.some(c=>isWorking(c.id))});
  }
  return out;
}

/** Whether a group is open: a choice saved for it wins; with none, it opens when a cat in it is working. A filter opens every group it still shows. */
export function groupIsOpen(group,{saved=null,query=''}={}){
  if(query.trim())return true;
  return saved==='open'||saved==='closed'?saved==='open':group.working;
}

import {KIND_SYMBOL} from './gallery-view.js';
import {confirmDialog} from './dialogs.js';
import {humanizeText} from './humanize-ids.js';
import {plainWords} from './plain-words.js';
// Projects panel, top to bottom: the Mayor's goal review (removal suggestions, owner decisions), a summary row, ongoing goals in four
// collapsible groups (Active, Waiting for you, Paused, Done), then the owner's requests. Reads GET /api/goals (goals, reviews, week),
// GET /api/projects and GET /api/artifacts. Paired viewers see everything; only the owner gets the buttons.
// The pure helpers are exported for Node tests; the DOM is built with createElement and textContent only. Styles: public/projects-panel.css.

const DAY=86400000,WEEK=7*DAY;
// Interrupted reads as broken, not as the owner's own Stop (plan 11.13, F3): the failed tone, its own word, and Retry.
const TONE={queued:'quiet',running:'working','waiting for you':'attention',done:'done',failed:'failed',stopped:'quiet',interrupted:'failed'};
export const statusTone=status=>TONE[status]??'quiet';
const STATUS_WORDS={queued:'Queued',running:'Running','waiting for you':'Waiting for you',done:'Done',failed:'Failed',stopped:'Stopped',interrupted:'Interrupted'};
export const statusLabel=status=>STATUS_WORDS[status]??String(status??'Unknown');
// Retry (11.1's route) is for a failed or interrupted request with nothing of it still running: the root keeps its status while a retry runs.
export const canRetry=project=>['failed','interrupted'].includes(project?.status)&&!project.counts?.running&&!project.counts?.waiting;
// A fetch that got no answer at all, in the words of the header's bar (plan 11.5), not the browser's "Failed to fetch" (F7).
export const NOT_ANSWERING='Clowder is not answering.';

// Progress is a 0..1 task-count proxy from the server. Anything unreadable shows as 0, never as a made-up value.
export function progressPercent(progress){const n=Number(progress);return Number.isFinite(n)?Math.round(Math.min(1,Math.max(0,n))*100):0;}

export function countsLine(counts){
  const parts=[`${counts.tasks} ${counts.tasks===1?'task':'tasks'}`];
  if(counts.done)parts.push(`${counts.done} done`);
  if(counts.running)parts.push(`${counts.running} running`);
  if(counts.waiting)parts.push(`${counts.waiting} waiting`);
  if(counts.failed)parts.push(`${counts.failed} failed`);
  return parts.join(' · ');
}

// null means the provider reported nothing for that field, so the line says so instead of showing 0.
export function usageLine(usage){
  const fmt=n=>Number.isFinite(n)?n.toLocaleString():null;
  const input=fmt(usage?.input),output=fmt(usage?.output);
  if(input===null&&output===null)return 'Tokens: not reported';
  return `Tokens: ${input??'unreported'} in · ${output??'unreported'} out · provider-reported`;
}

export function stamp(iso){
  const t=iso?new Date(iso):null;
  return t&&!Number.isNaN(t.getTime())?t.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'time unknown';
}

// The hamlet's site in world coordinates, or null when the request founded no hamlet.
export function siteFocus(group){
  const x=group?.site?.x,z=group?.site?.z;
  return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null;
}

// Display name for a cat id in this project. Unknown ids are shown as-is rather than hidden.
export function nameFor(project,id){
  if(id==='owner')return 'You';
  if(id==='system'||id==='town')return 'Town';
  return project.cats.find(c=>c.id===id)?.name??project.group?.members.find(c=>c.id===id)?.name??id;
}

// Keeps the whole sentence, punctuation included; only the length is capped.
// A one-line preview: markdown marks (**bold**, `code`) are dropped, since the line is plain text.
export function clip(text,max){const s=String(text??'').replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/`([^`\n]+)`/g,'$1').replace(/\s+/g,' ').trim();return s.length<=max?s:s.slice(0,max-1).trimEnd()+'…';}
export function waitingLabel(approval,known={}){return `Waiting for you: ${clip(humanizeText(approval.question,known),90)||'a decision'}`;}

// Goals. The server decides what is allowed; these helpers only name the state and the buttons.
const PAUSE_WORDS={approval:'Waiting for you',town:'Town paused',budget:'Budget reached',failures:'Paused after failures',owner:'Paused by you',demo:'Demonstration ended','owner-step':'Waiting for you'};
const ATTENTION_PAUSES=['approval','budget','failures','demo','owner-step'];
const RESUMABLE_PAUSES=['owner','budget','failures','owner-step'];
export function goalStatusLine(goal){
  if(goal.status==='active')return 'Working';
  if(goal.status==='paused')return PAUSE_WORDS[goal.pausedBy]??'Paused';
  if(goal.status==='achieved')return 'Achieved';
  if(goal.status==='stopped')return goal.endedBy==='mayor'?'Stopped by the Mayor':'Stopped';
  return 'Unknown';
}
export function goalTone(goal){
  if(goal.status==='active')return 'working';
  if(goal.status==='paused')return ATTENTION_PAUSES.includes(goal.pausedBy)?'attention':'quiet';
  if(goal.status==='achieved')return 'done';
  if(goal.status==='stopped')return goal.endedBy==='mayor'?'attention':'quiet';
  return 'quiet';
}
export const canPause=goal=>goal.status==='active';
export const canResume=goal=>goal.status==='paused'&&RESUMABLE_PAUSES.includes(goal.pausedBy);
export const canStop=goal=>goal.status==='active'||goal.status==='paused';

// Rounds today come from the server (roundsToday already accounts for the day). Tokens are provider-reported, so a missing count is left out.
export function goalCountsLine(goal){
  const parts=[`${goal.rounds} ${goal.rounds===1?'round':'rounds'}`,goal.maxRoundsPerDay?`${goal.roundsToday??0} of ${goal.maxRoundsPerDay} today`:`${goal.roundsToday??0} today`];
  if(goal.tokenBudget)parts.push(`${Number(goal.tokensUsed??0).toLocaleString()} of ${goal.tokenBudget.toLocaleString()} tokens`);
  else if(Number.isFinite(goal.tokensUsed)&&goal.tokensUsed>0)parts.push(`${goal.tokensUsed.toLocaleString()} tokens`);
  return parts.join(' · ');
}
export function goalLastLine(goal,known={}){const last=(goal.log??[]).at(-1);return last?clip(humanizeText(last,known),160):'No rounds yet.';}
// The slim line above the Mayor's composer. Null when no goal is active.
export function goalBannerText(goals=[]){const goal=goals.find(g=>g.status==='active');return goal?`Working on: ${clip(goal.title,70)} · round ${goal.rounds}`:null;}
// The owner's budget fields in, the request body out. A blank field means no limit. Bad values throw with the server's wording.
export function budgetPatch(maxText,tokenText){
  const maxRaw=String(maxText??'').trim(),max=maxRaw===''?null:Number(maxRaw);
  if(max!==null&&(!Number.isInteger(max)||max<1||max>1000))throw new Error('Rounds a day must be a whole number from 1 to 1000, or blank for no limit.');
  const token=String(tokenText??'').trim();
  if(token==='')return {maxRoundsPerDay:max,tokenBudget:null};
  const tokens=Number(token);
  if(!Number.isInteger(tokens)||tokens<1)throw new Error('The token budget must be a whole number, or blank for none.');
  return {maxRoundsPerDay:max,tokenBudget:tokens};
}

// Goal sections: active and paused, then ended (achieved or stopped). Each list is newest first. Removal is allowed for any goal that is not active.
export function groupGoals(goals=[]){
  const sorted=[...goals].sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??'')));
  return {
    active:sorted.filter(g=>g.status==='active'),
    paused:sorted.filter(g=>g.status==='paused'),
    ended:sorted.filter(g=>g.status==='achieved'||g.status==='stopped'),
  };
}
export const canRemove=goal=>goal.status!=='active';
const MODE_WORDS={local:'Local',hosted:'Hosted',claude:'Claude',chatgpt:'ChatGPT',plan:'Plan'};
export function goalModeLabel(goal){return goal.mode==='demo'?'Demonstration':(MODE_WORDS[goal.mode]??String(goal.mode??'Unknown'));}
export function createdLabel(iso){
  const t=iso?new Date(iso):null;
  return t&&!Number.isNaN(t.getTime())?`Created ${t.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`:'Created date unknown';
}

// The four goal groups. Waiting for you is a goal paused for a to-do or a round go-ahead; every other pause, and any unknown one, is Paused.
// Each group counts goals ("2 goals"), so its number never reads as the one "needs you" count.
const WAITING_PAUSES=['owner-step','approval'];
export const SECTION_TITLES={active:'Active',waiting:'Waiting for you',paused:'Paused',done:'Done'};
export const countOf=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
export const goalCount=n=>countOf(n,'goal');
export const GOAL_ORDER=['waiting','active','paused','done'];
export function goalBucket(goal){
  if(goal.status==='active')return 'active';
  if(goal.status==='achieved'||goal.status==='stopped')return 'done';
  if(goal.status==='paused'&&WAITING_PAUSES.includes(goal.pausedBy))return 'waiting';
  return 'paused';
}
// Every goal lands in exactly one group, newest first within it.
export function goalSections(goals=[]){
  const sorted=[...goals].sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??'')));
  const out={active:[],waiting:[],paused:[],done:[]};
  for(const goal of sorted)out[goalBucket(goal)].push(goal);
  return out;
}

// Whole days from a goal's start to now, or to its last update once it has ended. null when the start time cannot be read.
export function daysRunning(goal,now=new Date()){
  const start=Date.parse(goal.createdAt);
  if(!Number.isFinite(start))return null;
  const ended=goal.status==='achieved'||goal.status==='stopped';
  const end=ended?Date.parse(goal.updatedAt):now.getTime();
  return Number.isFinite(end)?Math.max(0,Math.floor((end-start)/DAY)):null;
}
// A field the server left out or set to null: not reported, as opposed to a real 0.
const unset=v=>v===null||v===undefined;
export function daysLabel(n){
  if(unset(n))return '—';
  if(n===0)return 'Today';
  return n===1?'1 day':`${n} days`;
}
// A short date for a hint ("Oct 27"), or a dash when the time cannot be read.
export function dateLabel(iso){const t=iso?new Date(iso):null;return t&&!Number.isNaN(t.getTime())?t.toLocaleDateString([],{month:'short',day:'numeric'}):'—';}

// Tokens for a goal: a bar against its budget when one is set. Tokens the provider never reported read as a dash, never as zero.
export function tokenMeter(goal){
  const budget=goal.tokenBudget??null;
  if(goal.tokensKnown!==true||!Number.isFinite(goal.tokensUsed))return {text:budget?`— of ${budget.toLocaleString()}`:'—',ratio:null,hint:'Not reported yet'};
  const used=goal.tokensUsed;
  if(!budget)return {text:`${used.toLocaleString()} tokens`,ratio:null,hint:'No budget set'};
  return {text:`${used.toLocaleString()} of ${budget.toLocaleString()}`,ratio:Math.min(1,used/budget),hint:'provider-reported'};
}

// How long a request ran, from its start to the end given. An unreadable time reads as a dash.
export function durationLabel(startIso,endIso){
  const a=Date.parse(startIso),b=Date.parse(endIso);
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '—';
  const minutes=Math.round((b-a)/60000);
  if(minutes<1)return 'under a minute';
  if(minutes<60)return `${minutes} min`;
  const hours=Math.floor(minutes/60);
  return hours<48?`${hours} h`:`${Math.floor(hours/24)} days`;
}

const COMPACT=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1});
// Big counts fit a tile: 5380279 reads 5.4M. A missing count reads as a dash.
export const compactCount=n=>Number.isFinite(n)?COMPACT.format(n):'—';

// The four summary tiles. A figure whose source failed to load is a dash, never a zero. needsYou is the one "needs you" count
// (quests-panel.js needsYouCount, the dock badge's number), or null before it has loaded.
export function summaryTiles({goals=[],goalsKnown=true,needsYou=null,week=null,artifacts=null,now=new Date()}={}){
  const sections=goalSections(goals);
  const since=now.getTime()-WEEK;
  const made=artifacts?artifacts.filter(a=>Date.parse(a.createdAt)>=since).length:null;
  return [
    {label:'Active goals',value:goalsKnown?String(sections.active.length):'—',hint:goalsKnown?`${sections.paused.length} paused`:''},
    {label:'Inbox',value:Number.isFinite(needsYou)?String(needsYou):'—',hint:'decisions and to-dos'},
    {label:'Tokens, 7 days',value:compactCount(week?.tokens??null),hint:'provider-reported'},
    {label:'Artifacts, 7 days',value:made===null?'—':String(made),hint:'saved by the cats'},
  ];
}

// Used to skip re-rendering when nothing visible changed, so open cards and focus survive a poll.
export const snapshotKey=projects=>JSON.stringify(projects);

export function el(tag,{className,text,attrs,style}={},children=[]){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  for(const [k,v] of Object.entries(attrs??{}))node.setAttribute(k,v);
  for(const [k,v] of Object.entries(style??{}))node.style.setProperty(k,v);
  node.append(...children);
  return node;
}

function avatar(cat){
  return el('span',{className:'avatar',text:cat.icon||'•',attrs:{'aria-hidden':'true'},style:{background:cat.color||'#6b6657'}});
}

function person(cat){
  return el('li',{className:'person'},[avatar(cat),el('span',{text:cat.name||cat.id})]);
}

// The stylesheet loads once, after the app's own styles, so its rules win. Node has no document, so this does nothing there.
function ensureStyles(doc=globalThis.document){
  if(!doc||doc.querySelector('link[data-projects-panel-css]'))return;
  const link=doc.createElement('link');
  link.rel='stylesheet';link.href='/projects-panel.css';link.dataset.projectsPanelCss='';
  doc.head.append(link);
}

const EMPTY={active:'No goal is running right now.',waiting:'No goal is waiting for you.',paused:'No goal is paused.',done:'No goal has finished yet.'};

// needsYou(): the one "needs you" count from the Inbox panel, or null before it has loaded.
export function createProjectsPanel({panel,body,status,onOpenChat=()=>{},onShowHamlet=()=>{},onOpenArtifact=()=>{},onAskMayorReview=null,needsYou=()=>null,fetchImpl=(...args)=>fetch(...args),act=()=>Promise.reject(new Error('Goals cannot be changed here.'))}){
  ensureStyles();
  let busy=false,again=false,lastKey=null,goalsOwner=false,goalsKnown=false;
  let artifacts=null,reviews=[],week={tokens:null},view={goals:[],projects:[]};
  // Which groups are open, kept across polls. Done starts closed.
  const disclosure=new Map([['active',true],['waiting',true],['paused',true],['done',false],['requests',true]]);
  // Groups the owner opened or closed by hand: an empty one they opened stays open.
  const touched=new Set();
  // Cards whose artifact list is open, kept across polls. Keys are "g:<goal id>" or "p:<project id>".
  const openArtifacts=new Set();
  // Ids in user text read as titles, from the artifacts and goals this panel already fetched. Unknown ids are dropped.
  let known=new Map();

  const button=(label,onclick,className)=>{const b=el('button',{text:label,className,attrs:{type:'button'}});b.onclick=onclick;return b;};

  // One figure on a card: a label, a value, an optional hint and an optional bar (ratio 0..1, null for no bar).
  function statChildren(label,value,{hint='',ratio=null}={}){
    const kids=[el('span',{className:'pp-label',text:label}),el('span',{className:'pp-value',text:value})];
    if(ratio!==null){
      const pct=Math.round(Math.min(1,Math.max(0,ratio))*100);
      kids.push(el('span',{className:'pp-meter',attrs:{role:'meter','aria-label':`${label} used`,'aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(pct)}},[el('i',{style:{width:`${pct}%`}})]));
    }
    if(hint)kids.push(el('span',{className:'pp-hint',text:hint}));
    return kids;
  }
  const stat=(label,value,opts={},wide=false)=>el('div',{className:`pp-stat${wide?' pp-wide':''}`},statChildren(label,value,opts));

  // The artifact count. With artifacts, it is a button that opens the card's list; each chip in the list opens the viewer.
  function artifactTile(key,count){
    if(count===null)return stat('Artifacts','—',{hint:'Not loaded'});
    if(!count)return stat('Artifacts','None yet');
    const opened=openArtifacts.has(key);
    const b=el('button',{className:'pp-stat pp-tap',attrs:{type:'button','aria-expanded':String(opened)}},statChildren('Artifacts',`${count} made`,{hint:opened?'Hide list':'Show list'}));
    b.onclick=()=>{if(opened)openArtifacts.delete(key);else openArtifacts.add(key);render();};
    return b;
  }
  function artifactChips(key,list){
    if(!openArtifacts.has(key)||!list?.length)return [];
    return [el('div',{className:'artifact-chips',attrs:{'aria-label':'Artifacts'}},list.map(a=>{
      const chip=el('button',{className:'artifact-chip',text:`${KIND_SYMBOL[a.kind]??'•'} ${a.title||'Untitled'}`,attrs:{type:'button'}});
      chip.onclick=()=>onOpenArtifact(a.id);
      return chip;
    }))];
  }

  function card(project){
    const titleId=`project-title-${project.id}`;
    const chip=el('span',{className:'status-chip',text:statusLabel(project.status),attrs:{'data-tone':statusTone(project.status)}});
    const reason=project.status==='interrupted'&&project.reason?[el('p',{className:'goal-note request-reason',text:clip(plainWords(humanizeText(project.reason,known)),200)})]:[];
    const percent=progressPercent(project.progress);
    const bar=el('div',{className:'progress',attrs:{role:'progressbar','aria-label':'Task progress','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(percent)}},[
      el('i',{style:{width:`${percent}%`}}),
    ]);
    const people=project.group?project.group.members:project.cats;
    const members=el('ul',{className:'people','aria-label':project.group?`${project.group.name} members`:'Cats involved'},people.map(person));
    const approvals=project.pendingApprovals.map(a=>el('button',{className:'needs-you',text:waitingLabel(a,known),attrs:{type:'button',title:'Open the decision in chat'}},[]));
    approvals.forEach((b,i)=>b.onclick=()=>onOpenChat(project.pendingApprovals[i].cat));
    const last=project.lastMessage;
    const lastLine=last?el('p',{className:'project-last'},[
      el('strong',{text:`${nameFor(project,last.from)} → ${nameFor(project,last.to)}`}),
      document.createTextNode(` ${clip(humanizeText(last.text,known),160)}`),
    ]):el('p',{className:'muted',text:'No messages yet.'});
    const live=['queued','running','waiting for you'].includes(project.status);
    const tokens=unset(project.usage?.input)&&unset(project.usage?.output)?null:(project.usage.input??0)+(project.usage.output??0);
    const projectArtifacts=artifacts?artifacts.filter(a=>a.project===project.id):null;
    const stats=el('div',{className:'pp-stats'},[
      stat('Tasks',String(project.counts.tasks),{hint:`${project.counts.done} done${project.counts.failed?` · ${project.counts.failed} failed`:''}`}),
      stat('Time',durationLabel(project.startedAt,live?new Date().toISOString():project.updatedAt),{hint:live?'so far':'start to finish'}),
      stat('Tokens',tokens===null?'—':tokens.toLocaleString(),{hint:tokens===null?'Not reported':'provider-reported'}),
      artifactTile(`p:${project.id}`,projectArtifacts?projectArtifacts.length:null),
    ]);
    const hamlet=el('button',{text:'Show nook',attrs:{type:'button'}});
    const site=siteFocus(project.group);
    hamlet.disabled=!site;
    if(!site)hamlet.title='This request did not found a nook';
    hamlet.onclick=()=>{
      if(!site)return;
      window.dispatchEvent(new CustomEvent('focus-site',{detail:site}));
      onShowHamlet();
    };
    const chat=el('button',{text:'Open in chat',attrs:{type:'button'}});
    chat.onclick=()=>onOpenChat(project.lead);
    const actions=[hamlet,chat];
    if(goalsOwner&&canRetry(project)){const retry=button('Retry',()=>retryRequest(project,retry),'request-retry');actions.unshift(retry);}
    return el('li',{},[el('article',{className:'project-card request-card',attrs:{'data-status':project.status,'aria-labelledby':titleId}},[
      el('div',{className:'project-head'},[el('h3',{text:humanizeText(project.title,known),attrs:{id:titleId}}),chip]),
      ...reason,
      bar,
      el('p',{className:'project-counts',text:countsLine(project.counts)}),
      stats,
      members,
      ...approvals,
      lastLine,
      ...artifactChips(`p:${project.id}`,projectArtifacts),
      el('p',{className:'project-meta muted',text:`Started ${stamp(project.startedAt)} · updated ${stamp(project.updatedAt)}`}),
      el('p',{className:'project-meta muted',text:usageLine(project.usage)}),
      el('div',{className:'project-actions'},actions),
    ])]);
  }

  // One tap, one retry: a second tap before the list reloads does nothing. A refusal stays on screen, so the list is not reloaded over it.
  async function retryRequest(project,b){
    if(b.disabled)return;
    b.disabled=true;
    try{await act(`tasks/${encodeURIComponent(project.id)}/retry`,{});}
    catch(error){b.disabled=false;status.hidden=false;status.textContent=error instanceof TypeError?`Retry did not go through. ${NOT_ANSWERING}`:error.message;return;}
    status.hidden=true;status.textContent='';
    lastKey=null;
    await refresh();
  }

  // Owner buttons call the owner routes; the server says what is allowed. A refusal shows in the status line.
  async function goalAction(goal,path,body){
    try{await act(`goals/${encodeURIComponent(goal.id)}/${path}`,body);status.hidden=true;status.textContent='';}
    catch(error){status.hidden=false;status.textContent=error.message;}
    lastKey=null;
    await refresh();
  }

  // Removal and stop ask first, in the app's styled dialog. The server refuses an active goal's removal, so the button is never offered for one.
  async function removeGoal(goal){
    const ok=await confirmDialog({title:`Remove “${clip(goal.title,60)}”?`,message:'It leaves the goal list, the Inbox and the Mayor’s banner. The journal keeps the record.',confirmLabel:'Remove goal',cancelLabel:'Keep it',danger:true});
    if(ok)await goalAction(goal,'archive',{});
  }

  // Queues a normal Mayor task that reviews the goals. Its suggestions come back here as Review items, so nothing is removed by asking.
  async function askReview(b){
    b.disabled=true;
    try{await onAskMayorReview();status.hidden=true;status.textContent='';}
    catch(error){status.hidden=false;status.textContent=error.message;}
    finally{b.disabled=false;}
  }
  const askButton=()=>{const b=button('Ask the Mayor to review goals',()=>askReview(b),'goal-ask');return b;};

  // One removal suggestion. Approve removes the goal (it asks first); Keep records the answer and the goal stays.
  async function decideReview(review,approve,buttons){
    if(approve){
      const ok=await confirmDialog({title:`Remove ${review.goalTitle?`“${clip(humanizeText(review.goalTitle),60)}”`:'this goal'}?`,message:'It leaves the goal list, the Inbox and the Mayor’s banner. The journal keeps the record.',confirmLabel:'Remove goal',cancelLabel:'Keep it',danger:true});
      if(!ok)return;
    }
    const [removeWord='Remove',keepWord='Keep']=review.options??[];
    buttons.forEach(b=>b.disabled=true);
    try{await act(`approvals/${encodeURIComponent(review.id)}`,approve?{answer:removeWord,approved:true}:{answer:keepWord,approved:false});status.hidden=true;status.textContent='';}
    catch(error){status.hidden=false;status.textContent=error.message;}
    finally{buttons.forEach(b=>b.disabled=false);}
    lastKey=null;
    await refresh();
  }
  function reviewItem(review){
    const named=review.goalTitle?`“${clip(humanizeText(review.goalTitle,known),80)}”`:'a goal no longer listed';
    const title=review.mergeInto?`Remove ${named}, a duplicate of “${clip(humanizeText(review.mergeInto,known),60)}”`:`Remove ${named}`;
    const kids=[el('p',{className:'review-title',text:title}),el('p',{className:'review-reason',text:clip(humanizeText(review.reason||review.question,known),200)})];
    if(goalsOwner){
      const approve=button('Approve',()=>decideReview(review,true,[approve,keep]),'review-approve');
      const keep=button('Keep',()=>decideReview(review,false,[approve,keep]),'review-keep');
      kids.push(el('div',{className:'review-actions'},[approve,keep]));
    }
    return el('li',{className:'review-item'},kids);
  }
  function reviewStrip(){
    const foot=goalsOwner&&onAskMayorReview?[el('div',{className:'review-foot'},[askButton()])]:[];
    return el('section',{className:'review-strip',attrs:{'aria-label':'Mayor’s goal review'}},[
      el('div',{className:'review-head'},[el('h3',{className:'pp-title',text:'Mayor’s goal review'}),el('span',{className:'pp-count',text:countOf(reviews.length,'suggestion')})]),
      el('ol',{className:'review-list'},reviews.map(reviewItem)),
      ...foot,
    ]);
  }

  function goalCard(goal){
    const titleId=`goal-title-${goal.id}`;
    const chip=el('span',{className:'status-chip',text:goalStatusLine(goal),attrs:{'data-tone':goalTone(goal)}});
    const notes=[];
    if(goal.note&&goal.status!=='achieved')notes.push(el('p',{className:'goal-note',text:clip(plainWords(humanizeText(goal.note,known)),200)}));
    if(goal.status==='achieved'&&goal.summary)notes.push(el('p',{className:'project-last',text:clip(humanizeText(`Done: ${goal.summary}`,known),220)}));
    const meter=tokenMeter(goal);
    const rounds=goal.maxRoundsPerDay?`${goal.roundsToday??0} of ${goal.maxRoundsPerDay} today`:`${goal.roundsToday??0} today`;
    const artCount=Array.isArray(goal.artifacts)?goal.artifacts.length:null;
    const byId=new Map((artifacts??[]).map(a=>[a.id,a]));
    const artList=Array.isArray(goal.artifacts)?goal.artifacts.map(id=>byId.get(id)).filter(Boolean):null;
    const steps=goal.ownerStepsOpen;
    const stats=el('div',{className:'pp-stats goal-stats'},[
      stat('Rounds',String(goal.rounds),{hint:rounds}),
      stat('Running',daysLabel(daysRunning(goal)),{hint:goal.createdAt?`since ${dateLabel(goal.createdAt)}`:''}),
      stat('Last round',goal.lastRoundAt?stamp(goal.lastRoundAt):'—',{hint:goal.lastRoundAt?'':'No round yet'}),
      stat('To-dos',Number.isFinite(steps)?String(steps):'—',{hint:steps?'open for you':'none open'}),
      artifactTile(`g:${goal.id}`,artCount),
      stat('Tokens',meter.text,{hint:meter.hint,ratio:meter.ratio},true),
    ]);
    const cats=Array.isArray(goal.cats)&&goal.cats.length?el('ul',{className:'people','aria-label':'Cats in this goal'},goal.cats.map(person)):null;
    const actions=[];
    if(goalsOwner){
      if(canPause(goal))actions.push(button('Pause',()=>goalAction(goal,'action',{action:'pause'})));
      if(canResume(goal))actions.push(button('Resume',()=>goalAction(goal,'action',{action:'resume'})));
      if(canStop(goal))actions.push(button('Stop',async()=>{const ok=await confirmDialog({title:'Stop this goal?',message:'Its rounds end and the Mayor will not resume it.',confirmLabel:'Stop goal',cancelLabel:'Keep it going',danger:true});if(ok)goalAction(goal,'action',{action:'stop'});}));
      if(canRemove(goal))actions.push(button('Remove',()=>removeGoal(goal)));
    }
    const budget=goalsOwner?(()=>{
      const max=el('input',{attrs:{type:'number',min:'1',max:'1000',step:'1',placeholder:'No limit','aria-label':'Rounds a day',value:goal.maxRoundsPerDay?String(goal.maxRoundsPerDay):''}});
      const tokens=el('input',{attrs:{type:'number',min:'1',step:'1',placeholder:'No limit','aria-label':'Token budget',value:goal.tokenBudget?String(goal.tokenBudget):''}});
      const save=el('button',{text:'Save budget',attrs:{type:'button'}});
      const error=el('p',{className:'goal-note',attrs:{role:'status'}});
      save.onclick=()=>{
        let patch;
        try{patch=budgetPatch(max.value,tokens.value);}catch(err){error.textContent=err.message;return;}
        goalAction(goal,'budget',patch);
      };
      return el('details',{className:'goal-budget'},[el('summary',{text:'Budget'}),el('label',{},[el('span',{text:'Rounds a day'}),max]),el('label',{},[el('span',{text:'Token budget'}),tokens]),save,error]);
    })():null;
    return el('li',{},[el('article',{className:`project-card goal-card${goal.mode==='demo'?' is-demo':''}`,attrs:{'data-status':goal.status,'aria-labelledby':titleId}},[
      el('div',{className:'project-head'},[el('h3',{text:humanizeText(goal.title,known),attrs:{id:titleId}}),chip]),
      el('p',{className:'project-last',text:goalLastLine(goal,known)}),
      stats,
      ...artifactChips(`g:${goal.id}`,artList),
      ...(cats?[cats]:[]),
      ...notes,
      el('p',{className:goal.mode==='demo'?'project-meta demo-goal-mode':'project-meta muted',text:`${goalModeLabel(goal)} · ${createdLabel(goal.createdAt)} · updated ${stamp(goal.updatedAt)}`}),
      ...(actions.length?[el('div',{className:'project-actions'},actions)]:[]),
      ...(budget?[budget]:[]),
    ])]);
  }

  // The four goal groups, each a disclosure with its count. Open state is kept across polls.
  function goalsSection(goals){
    const sections=goalSections(goals);
    // Waiting for you leads, since it is what the owner acts on; an empty group starts folded so the goals that exist come first.
    const groups=GOAL_ORDER.map(key=>{
      const list=sections[key];
      const d=el('details',{className:`goal-section goal-section-${key}`},[
        el('summary',{className:'goal-section-summary'},[el('span',{className:'goal-section-title',text:SECTION_TITLES[key]}),el('span',{className:'pp-count',text:goalCount(list.length)})]),
        ...(list.length?[el('ol',{className:'project-list'},list.map(goalCard))]:[el('p',{className:'pp-empty muted',text:EMPTY[key]})]),
      ]);
      d.open=disclosure.get(key)===true&&(list.length>0||touched.has(key));
      d.addEventListener('toggle',()=>{disclosure.set(key,d.open);touched.add(key);});
      return d;
    });
    // The review strip carries its own Ask button while a suggestion is pending; here it stays available when there is none.
    const heading=el('div',{className:'goal-heading-row'},[el('h3',{className:'goal-heading',text:'Ongoing goals'}),...(goalsOwner&&onAskMayorReview&&!reviews.length?[askButton()]:[])]);
    return el('section',{className:'goal-list',attrs:{'aria-label':'Ongoing goals'}},[heading,...groups]);
  }

  function requestsSection(list){
    const d=el('details',{className:'goal-section requests-section'},[
      el('summary',{className:'goal-section-summary'},[el('span',{className:'goal-section-title',text:'Requests'}),el('span',{className:'pp-count',text:countOf(list.length,'request')})]),
      el('ol',{className:'project-list'},list.map(card)),
    ]);
    d.open=disclosure.get('requests')===true;
    d.addEventListener('toggle',()=>disclosure.set('requests',d.open));
    return d;
  }

  function summaryRow(){
    const tiles=summaryTiles({goals:view.goals,goalsKnown,needsYou:needsYou(),week,artifacts,now:new Date()});
    return el('section',{className:'pp-summary',attrs:{'aria-label':'Summary'}},tiles.map(t=>el('div',{className:'pp-tile'},[
      el('span',{className:'pp-label',text:t.label}),
      el('span',{className:'pp-big',text:t.value}),
      ...(t.hint?[el('span',{className:'pp-hint',text:t.hint})]:[]),
    ])));
  }

  function render(){
    const {goals,projects}=view;
    const parts=[];
    if(reviews.length)parts.push(reviewStrip());
    if(goals.length||projects.length)parts.push(summaryRow());
    if(goals.length)parts.push(goalsSection(goals));
    if(projects.length)parts.push(requestsSection(projects));
    body.replaceChildren(...(parts.length?parts:[el('div',{className:'empty'},[el('span',{className:'big',text:'ฅ',attrs:{'aria-hidden':'true'}}),el('p',{text:'No requests yet. Give your Mayor a goal in Chat and its work will appear here.'})])]));
  }

  async function refresh(){
    if(panel.hidden)return;
    if(busy){again=true;return;}
    busy=true;
    try{
      const [r,a,g]=await Promise.all([Promise.resolve().then(()=>fetchImpl('/api/projects')).catch(()=>null),Promise.resolve().then(()=>fetchImpl('/api/artifacts')).catch(()=>null),Promise.resolve().then(()=>fetchImpl('/api/goals')).catch(()=>null)]);
      // No answer at all: the host is down or asleep. The list comes back on its own, since the page reloads it when Clowder answers.
      if(!r)throw new Error(`${NOT_ANSWERING} The list comes back when it does.`);
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Try again in a moment.');
      const list=await r.json();
      // Artifacts and goals are extra reads. When one fails, the figures that need it show a dash.
      const artifactData=a?.ok?await a.json().catch(()=>null):null;
      artifacts=artifactData?.artifacts??null;
      const goalData=g?.ok?await g.json().catch(()=>null):null;
      goalsKnown=!!goalData;
      const goals=goalData?.goals??[];
      reviews=goalData?.reviews??[];
      week=goalData?.week??{tokens:null};
      goalsOwner=!!goalData?.owner;
      view={goals,projects:list};
      known=new Map([...(artifacts??[]).map(art=>[art.id,{title:humanizeText(art.title||'Untitled')}]),...goals.map(goal=>[goal.id,{title:humanizeText(goal.title)}])]);
      const key=snapshotKey([list,artifacts,goals,goalsOwner,reviews,week,goalsKnown,needsYou()]);
      status.textContent='';status.hidden=true;
      if(key!==lastKey){lastKey=key;render();}
    }catch(error){
      status.hidden=false;status.textContent=`Projects could not load. ${error.message}`;
    }finally{
      busy=false;
      if(again){again=false;void refresh();}
    }
  }

  return {refresh};
}

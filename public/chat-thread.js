import {h,render} from './vendor/preact/preact.js';
import {useEffect,useLayoutEffect,useRef,useState} from './vendor/preact/hooks.js';
import {signal} from './vendor/preact/signals.js';
import htm from './vendor/preact/htm.js';
import {chatMessages} from './state-delta.js';
import {asideClass,inboxNote} from './ask-mayor.js';
import {goalRound,roundStarted} from './town-events.js';
import {chatHtml} from './quests-panel.js';
import {demoReply,DEMO_REPLY_NOTE} from './demo-state.js';
import {artifactParts,artifactNodes,deliverMenu,readServices} from './gallery-view.js';
import {distanceFromBottom} from './scroll-latest.js';
import {icon} from './icons.js';
import {requestOf} from './decision-strip.js';
import {rootTask} from './chat-composer.js';
import {parseReasoning,startingReasoning} from './ai-settings.js';
const html=htm.bind(h);
// The thread view (plan 8.1, 8.6): the selected cat's chat, a request thread (a root task and all it delegated) or a goal thread (a row per round).
// In the Mayor's chat, cat-to-cat work folds into one-line work rows. A decision sits where it was asked, drawn by decision-strip.js the same
// whatever asked it (Gate 8). The owner's sends show at once (page.pending, plan 8.7). Under the log, outside role="log", the working line and
// the streamed draft (plan 8.2, 8.3). app.js hands it the page and state on each render, and live frames to live().
const LIVE=['running','waiting','waiting_child'],OUTSIDE=['owner','system','town'];
const REQUEST={queued:'Queued',running:'Working',waiting:'Needs you',waiting_child:'Working',done:'Done',failed:'Failed',interrupted:'Interrupted',cancelled:'Stopped'};
const TROUBLE=['failed','interrupted'];
// The empty Mayor thread's starters (plan 11.12, F10): asks from the website's scenarios (site/src/pages/solutions.astro). A chip fills the
// composer and sends nothing. The mail scenario is left out: its ask is about a forwarded email that a chat does not have.
export const STARTERS=Object.freeze([
  {label:'Monday brief',text:'Every Monday at eight, look into what changed for small bookkeeping apps last week and give me a one-page brief.'},
  {label:'Posts with your OK',text:'Write three posts about Saturday’s pottery open day, with a picture. When I pick one, post it.'},
  {label:'Money only when you say',text:'Look at this month’s model costs, then tell me what you would need to do in Stripe for my workshop deposits.'},
  {label:'A report when something happens',text:'When the sign-up form gets a new entry, sum up this week’s sign-ups for me.'},
  {label:'Decide from your phone',text:'I’m out today. What needs me?'},
]);
// A request's latest turn (plan 11.1): its root, or the newest follow-up or Retry the owner sent into it, by when its words were journaled.
// Its status is the request's. tasks: freshest first.
export function latestTurn(root,messages,tasks){
  const turns=new Set(tasks.filter(t=>t.id===root.id||(t.parent===root.id&&t.from==='owner')).map(t=>t.id)),id=messages.findLast(m=>m.from==='owner'&&turns.has(m.task))?.task;
  return tasks.find(t=>t.id===id)??root;
}
// Results (F6): each finished task's last message to the owner. tasks: a Map by id.
export function resultIds(messages,tasks){
  const last=new Map();for(const m of messages)if(m.to==='owner'&&m.task&&!OUTSIDE.includes(m.from)&&!m.aside)last.set(m.task,m.id);
  return new Set([...last].filter(([task])=>tasks.get(task)?.status==='done').map(([,id])=>id));
}
// Plan 11.24 (N17): what one "Deliver to" tap sends, as the body of POST /api/chat. Inside the owner's own request it is a follow-up there
// (engine.ts submit takes one on a root that is not a goal round, record or routine, nor on Hermes), in the request's own reasoning, as
// Retry runs. Anything else is a new request to the Mayor in the town's default reasoning, which needs an artifact to name; else null.
// The cat writes through the connector, so its Allow, Ask or Off and the publish ledger (row 0.1) gate the write as any other.
export function deliverPlan({task,ids=[],service},{tasks=[],models,townDefault,cats=[]}={}){
  const root=rootTask(tasks,task),what=ids.length?`Save artifact${ids.length>1?'s':''} ${names(ids)}`:'Save your result in this request';
  const text=`${what} to ${service.to}. Use the ${service.name} connector.`;
  if(root&&!root.parent&&!root.goal&&!root.record&&!root.routine&&!root.by&&root.mode!=='hermes')return {cat:root.cat,text,mode:root.mode,parent:root.id};
  return ids.length?{cat:'mayor',text,...parseReasoning(startingReasoning(models,townDefault,cats.find(c=>c.id==='mayor')?.ai,null))}:null;
}
const idsIn=text=>[...new Set(artifactParts(text).flatMap(p=>p.id?[p.id]:[]))];
const GOAL={active:'Active',paused:'Paused',achieved:'Achieved',stopped:'Stopped'};
export const isWork=m=>!OUTSIDE.includes(m.from)&&!OUTSIDE.includes(m.to)&&!m.aside;
// A team member's words keep from 'owner' and carry their display name (plan 10.6, src/engine.ts message), so they read as theirs, not "You".
export const memberName=m=>m.from==='owner'&&typeof m.name==='string'&&m.name.trim()?m.name.trim():'';
export const sender=(m,name)=>{const who=memberName(m);return who?`${who} (team member)`:name(m.from);};
// Who is in a request thread (plan 10.12, /api/threads participants): the owner, named as the rest of the page names them, then each team member.
export const peopleOf=(participants,name)=>(Array.isArray(participants)?participants:[]).map(p=>p?.id==='owner'?{id:'owner',name:name('owner')}:{id:String(p?.id??''),name:String(p?.name??'').trim()||'A team member',member:true});
const names=list=>list.length<2?list.join(''):`${list.slice(0,-1).join(', ')} and ${list.at(-1)}`;
const merged=(a=[],b=[])=>[...new Map([...a,...b].map(m=>[m.id,m])).values()].sort((x,y)=>x.at<y.at?-1:x.at>y.at?1:0);
// A decision sits after the messages that were in when it was asked (its approval.requested event), else after the last message of its task,
// else at the end while it waits. -1: an answered one with no place, left out.
export function placeOf(a,messages,events=[]){
  const at=events.findLast(e=>e.type==='approval.requested'&&e.data?.id===a.id)?.at;
  if(at){const i=messages.findIndex(m=>m.at>at);return i<0?messages.length:i;}
  const i=messages.findLastIndex(m=>m.task===a.task);
  return i>=0?i+1:a.status==='pending'?messages.length:-1;
}
// A thread's rows, oldest first: messages, goal-round lines, decisions and, with fold, work rows (each run of cat-to-cat messages).
export function threadItems({messages,approvals=[],events=[],fold=false}){
  const at=new Map(),items=[],put=i=>{for(const a of at.get(i)??[])items.push({kind:'decision',key:'d'+a.id,a});};
  for(const a of approvals){const i=placeOf(a,messages,events);if(i>=0)at.set(i,[...at.get(i)??[],a]);}
  messages.forEach((m,i)=>{
    put(i);const round=goalRound(m),prev=items.at(-1),work=fold&&isWork(m);
    if(round)items.push({kind:'round',key:m.id,m,round});else if(work&&prev?.kind==='work')prev.messages.push(m);
    else items.push(work?{kind:'work',key:'w'+m.id,messages:[m]}:{kind:'message',key:m.id,m});
  });
  put(messages.length);return items;
}
// "Mayor asked Scholar and Critic · 2 replies", or "Scholar replied" for replies alone. The Mailman's lines are deliveries (engine.ts inbox), not replies.
export function workLabel(messages,cat,name){
  const asked=[...new Set(messages.filter(m=>m.from===cat).map(m=>m.to))].map(name),replies=messages.filter(m=>m.to===cat).length;
  if(!asked.length&&messages.every(m=>m.from==='mailman'))return `${name('mailman')} brought post`;
  return asked.length?`${name(cat)} asked ${names(asked)}${replies?` · ${replies} ${replies===1?'reply':'replies'}`:''}`:`${names([...new Set(messages.map(m=>m.from))].map(name))} replied`;
}
// The owner's sends on their way (plan 8.7 keeps them on page.pending as {id,text,at,afterId,status}): each shows until an owner message with
// the same words is journaled after afterId. A plugin command is journaled as "Command /x:" and its expansion (src/connectors.ts commandMessage).
export function unsent(pending,messages){
  const used=new Set(),same=(m,typed)=>{const s=String(m.text??'').trim();return s===typed||s.startsWith(`Command ${typed.split('\n')[0].slice(0,200)}:`);};
  return (pending??[]).filter(p=>{
    const typed=String(p.text??'').trim(),hit=messages.slice(messages.findIndex(m=>m.id===p.afterId)+1).find(m=>m.from==='owner'&&!used.has(m.id)&&same(m,typed));
    if(hit)used.add(hit.id);return !hit;
  });
}
// A root task and every task under it, from whatever tasks the page has.
export function treeOf(root,tasks){const ids=new Set([root]);for(let grew=true;grew;){grew=false;for(const t of tasks)if(t.parent&&ids.has(t.parent)&&!ids.has(t.id)){ids.add(t.id);grew=true;}}return ids;}
// A goal's rounds, oldest first: one per log line ("Round 3: …") and the round not logged yet, each with its Mayor task when the page has it.
export function roundsOf(goal,tasks){
  const rows=(goal.log??[]).map(line=>/^Round (\d+): ([\s\S]*)$/.exec(line)).filter(Boolean).map(([,n,text])=>({n:+n,text}));
  if(goal.rounds>(rows.at(-1)?.n??0))rows.push({n:goal.rounds,text:goal.status==='active'?'Under way':'Not finished'});
  return rows.map(r=>({...r,task:tasks.find(t=>t.goal===goal.id&&String(t.text).startsWith(`Goal round ${r.n}:`))}));
}
// The working line's words for one running task: who, and what it waits on or is doing.
export function liveText(t,tasks,live,name){
  const kids=[...new Set(tasks.filter(k=>k.parent===t.id&&LIVE.includes(k.status)).map(k=>name(k.cat)))];
  return t.status==='waiting'?`${name(t.cat)} needs your answer`:t.status==='waiting_child'?`${name(t.cat)} is waiting on ${names(kids)||'its cats'}`:`${name(t.cat)} is working${live?.label?` · ${live.label}`:''}`;
}
// How long a task has run: 14 s, 3 min, 1 h 5 min.
export const ago=(at,now=Date.now())=>{const s=Math.max(0,Math.round((now-Date.parse(at))/1000));return s<60?`${s} s`:s<3600?`${Math.floor(s/60)} min`:`${Math.floor(s/3600)} h ${Math.floor(s/60)%60} min`;};
// focusCat(id) eases the town to a request's cat or a goal's Mayor (a cat's own chat goes through select); replay(messages) replays a work row's visits (plan 8.10).
// fill(text) puts a starter's words in the composer (plan 11.12); clipboard takes a result's Copy; win hears the Archive's Deliver to.
export function createChatThread({chat,name,time,openArchiveOn,api,notify,select,decisionSlot,focusCat=()=>{},replay=()=>{},fill=()=>{},clipboard=globalThis.navigator?.clipboard,win=globalThis}){
  let following=true,shownCat=null,view=null,last=null,pendingCount=0,mounted=false,services=[],servicesAt=-Infinity,showsResults=false;
  const opened=new Set(),threads=new Map(),now=signal(Date.now()),markup=n=>icon(n,{size:16}).outerHTML;
  const live=Object.assign(document.createElement('div'),{id:'chat-live',className:'chat-live',hidden:true});chat.after(live);
  chat.addEventListener('scroll',()=>{if(chat.clientHeight)following=distanceFromBottom(chat)<70;},{passive:true});
  // The thread opens at the newest message (on open, cat switch, tab switch and own send). New replies follow only while the reader is already at the bottom.
  function pin(){chat.scrollTop=chat.scrollHeight;following=true;}
  const repaint=()=>{if(last)paint(last);};
  // The owner's write services for Deliver to (plan 11.24), read after a paint that showed a result.
  // ponytail: re-read at most every 30 s, so a service connected since shows within 30 s; a push from the connectors panel if that is too slow.
  function freshServices(state){
    if(state.readOnly||Date.now()-servicesAt<30_000)return;servicesAt=Date.now();
    void readServices((...a)=>fetch(...a)).then(list=>{if(list.map(s=>s.id).join()!==services.map(s=>s.id).join()){services=list;repaint();}});
  }
  const planState=({state,page})=>({tasks:known(state,page),models:state.models,townDefault:state.townDefault,cats:state.cats});
  // One tap, one request: the plan is made again at the tap, from what the page knows then. Resolves to the line the menu shows.
  function deliver(what){
    const plan=last&&!last.state.readOnly?deliverPlan(what,planState(last)):null;
    return plan?api('chat',plan).then(()=>`Asked ${name(plan.cat)}.`):Promise.reject(new Error('Ask the Mayor in its chat instead.'));
  }
  // The Archive's reader (gallery-view.js) asks through this event: only this view knows the requests and the reasoning.
  win.addEventListener?.('deliver-to',event=>{if(event.detail)event.detail.sent=deliver(event.detail);});
  // A request or round thread from /api/threads (plan 8.4): the newest page, then older ones on Earlier. Live frames add to it in paint.
  async function load(task,older=false){
    const t=threads.get(task)??{messages:[],tasks:[]};if(t.loading||(t.done&&!older))return;t.loading=true;threads.set(task,t);
    try{
      const before=older?t.messages[0]?.id:'',r=await fetch(`/api/threads/${encodeURIComponent(task)}${before?`?before=${encodeURIComponent(before)}`:''}`),d=await r.json();
      if(!r.ok)throw new Error(d.error||'Cannot read this thread');
      const fromBottom=chat.scrollHeight-chat.scrollTop;Object.assign(t,{messages:older?[...d.messages,...t.messages]:d.messages,more:d.more,tasks:merged(t.tasks,d.tasks),participants:d.participants??t.participants,done:true,error:''});
      repaint();if(older)chat.scrollTop=chat.scrollHeight-fromBottom;else aim();
    }catch(error){t.error=error.message;repaint();}finally{t.loading=false;}
  }
  // Plan 8.7's thread switcher: kind 'mayor' (or 'cat' with an id) is a cat's own chat, selected through app.js; 'request' a root task; 'goal' a goal.
  function open({kind='mayor',id}={}){
    const cat=kind==='mayor'?'mayor':kind==='cat'?id:null;
    view=cat||!id?null:{kind,id:String(id)};aim();if(view?.kind==='request')void load(view.id);
    if(cat&&cat!==shownCat){select(cat);return;}
    // The working line follows what is open (with its For: labels in a cat's chat), not the thread left behind.
    following=true;repaint();if(last)paintLive(last);
  }
  // The town eases once per open: to a goal's Mayor, or to a request's cat as soon as the root task is known (now, or when its thread loads).
  function aim(){
    if(!view||view.aimed)return;
    const cat=view.kind==='goal'?'mayor':[...threads.get(view.id)?.tasks??[],...last?.state.tasks??[],...last?.page?.tasks??[]].find(t=>t.id===view.id)?.cat;
    if(cat){view.aimed=true;focusCat(cat);}
  }
  const current=()=>view?{kind:view.kind,id:view.id}:{kind:(shownCat??'mayor')==='mayor'?'mayor':'cat',id:shownCat??'mayor'};
  // Every task the page knows, and the tasks of the open request or goal thread (null for a cat's chat).
  const known=(state,page)=>[...state.tasks,...page?.tasks??[],...[...threads.values()].flatMap(t=>t.tasks)];
  function openIds(state,page){
    if(!view)return null;const tasks=known(state,page);if(view.kind==='request')return treeOf(view.id,tasks);
    const goal=state.goals?.find(g=>g.id===view.id);return new Set(goal?roundsOf(goal,tasks).flatMap(r=>r.task?[...treeOf(r.task.id,tasks)]:[]):[]);
  }
  // Markup from the shared helpers (sprite icons from icons.js, linked message text, the decision card) goes in as it is.
  const Raw=({tag='span',markup:__html,...props})=>h(tag,{...props,dangerouslySetInnerHTML:{__html}});
  const Ico=({n})=>html`<${Raw} class="ico" markup=${markup(n)}/>`;
  // Message text with its links; artifact ids in it become links once the escaped markup is in.
  function Text({text}){
    const ref=useRef(),__html=chatHtml(text);
    useLayoutEffect(()=>{const t=ref.current;if(artifactParts(t.textContent).some(p=>p.id))t.replaceChildren(...artifactNodes(t.textContent,openArchiveOn));},[__html]);
    return h('div',{class:'text',ref,dangerouslySetInnerHTML:{__html}});
  }
  // ponytail: inline min-height on the new buttons (Copy, Retry, starters); move it to chat-sheet.css once 11.15, which owns that file this wave, merges.
  const TAP='min-height:var(--tap)';
  // Copy (F6) puts the words the bubble shows on the clipboard, and says for a moment whether it could. Deliver to sits beside it.
  function Copy({text,children}){
    const [said,say]=useState('');
    const copy=async()=>{try{await clipboard.writeText(text);say('Copied');}catch{say('Copy it by hand');}setTimeout(()=>say(''),1500);};
    // Top-aligned, so the open menu's second row does not stretch Copy past its 44px.
    return html`<p class="pending-actions" style=${children?'align-items:flex-start':undefined}><button type="button" class="chat-copy" style=${TAP} onClick=${copy}>${said||'Copy'}</button>${children}</p>`;
  }
  // Deliver to (plan 11.24): gallery-view.js's menu, the Archive's own, put in as nodes as a decision card is. Keyed by the services, so a
  // change draws it anew; Preact never touches what is inside.
  function Deliver({task,ids}){
    const ref=useRef();
    useLayoutEffect(()=>{const menu=deliverMenu(services,service=>deliver({task,ids,service}));if(menu)ref.current.append(menu);},[]);
    return html`<span class="chat-deliver" style="display:contents" ref=${ref}/>`;
  }
  // One message bubble: sender, a Demonstration note, the text with its links, Copy on a result, and a queued inbox message's note with Cancel.
  function Message({m,ctx:{tasks,readOnly,result,results,plan}}){
    const task=tasks.get(m.task),note=inboxNote(task),demo=demoReply(m),ids=results?.has(m.id)?idsIn(m.text):[];
    const send=!readOnly&&services.length>0&&results?.has(m.id)&&!!deliverPlan({task:m.task,ids,service:services[0]},plan);
    return html`<article class=${`chat-message ${m.from}${memberName(m)?' member':''}${asideClass(m)}${m.id===result?' result':''}`}><div class="sender"><span>${m.aside&&html`<em class="aside-label">Q&A</em>`}${sender(m,name)}${m.from!=='owner'&&m.to!=='owner'&&` → ${name(m.to)}`}${m.id===result&&' · Result'}</span><time>${time(m.at)}</time></div>${demo!==null&&html`<p class="demo-warning demo-reply-note">${DEMO_REPLY_NOTE}</p>`}<${Text} text=${demo??m.text}/>${results?.has(m.id)&&html`<${Copy} text=${demo??m.text}>${send&&html`<${Deliver} key=${services.map(s=>s.id).join()} task=${m.task} ids=${ids}/>`}<//>`}${note&&html`<p class="inbox-note">${note}${task.status==='queued'&&!readOnly&&html` <button type="button" class="inbox-cancel" data-cancel=${task.id}>Cancel</button>`}</p>`}</article>`;
  }
  // A one-line row that opens in place and stays put: a work row, or a goal round (which loads its thread when opened).
  function Fold({k,label,at,task,onOpen,children}){
    const open=opened.has(k),toggle=()=>{following=false;if(!opened.delete(k)){opened.add(k);if(task)void load(task);onOpen?.();}repaint();};
    return html`<div class="fold"><button type="button" class="work-row" aria-expanded=${open} onClick=${toggle}><${Ico} n="chevron-right"/><span class="work-label">${label}</span>${at&&html`<time>${time(at)}</time>`}</button>${open&&html`<div class="work-body">${children()}</div>`}</div>`;
  }
  // A decision is decision-strip.js's live card (decisionCardFor), the one the strip and the Inbox show: inline answers where its quick list
  // allows, folded while an answer is held. Preact keeps this node by key and never touches what is inside; the strip redraws the card.
  function Decision({id}){
    const ref=useRef();
    useLayoutEffect(()=>{const slot=decisionSlot(id,{surface:'thread'});if(slot)ref.current.append(slot);},[id]);
    return html`<div class="thread-decision" ref=${ref}/>`;
  }
  function Item({item,ctx}){
    if(item.kind==='round')return html`<p class="chat-event">${roundStarted(item.round)}\u00a0·\u00a0<time>${time(item.m.at)}</time></p>`;
    if(item.kind==='decision')return html`<${Decision} id=${item.a.id}/>`;
    if(item.kind==='work')return html`<${Fold} k=${item.key} label=${workLabel(item.messages,ctx.cat,name)} at=${item.messages[0].at} onOpen=${()=>replay(item.messages)}>${()=>item.messages.map(m=>html`<${Message} key=${m.id} m=${m} ctx=${ctx}/>`)}<//>`;
    return html`<${Message} m=${item.m} ctx=${ctx}/>`;
  }
  const note=t=>t.error?html`<p class="chat-event" key="error">${t.error}</p>`:!t.done&&html`<p class="chat-event" key="loading">Loading the thread…</p>`;
  // Under the head, who is in the thread once a team member is (plan 10.12): "In this thread: You and Ana (team member)". Names go in as text.
  const People=({list})=>html`<p class="thread-people"><span class="thread-people-label">In this thread: </span>${list.map((p,i)=>[i===0?'':i===list.length-1?' and ':', ',html`<span class="thread-person">${p.name}${p.member&&html`<span class="thread-person-role"> (team member)</span>`}</span>`])}</p>`;
  const Head=({kind,title,state,people=[]})=>html`<div class="thread-head"><button type="button" class="thread-back" aria-label=${`Back to ${name(shownCat)}’s chat`} onClick=${()=>open({kind:'cat',id:shownCat})}><${Ico} n="chevron-left"/></button><p><span>${kind}</span> <strong>${title}</strong></p>${state&&html`<span class="thread-state">${state}</span>`}</div>${people.some(p=>p.member)&&html`<${People} list=${people}/>`}`;
  // What is open: the cat's chat, a request thread or a goal thread, then the sends still on their way. A failed one offers Retry and
  // Discard, which chat-composer.js handles ([data-retry], [data-discard]).
  // The starter chips (F10) under the empty Mayor thread; "Try a delegation" above them stays the no-model option.
  const Starters=()=>html`<div class="pending-actions" role="group" aria-label="Start from an example" style="justify-content:center">${STARTERS.map(s=>html`<button type="button" class="starter" style=${TAP} title=${s.text} onClick=${()=>fill(s.text)}>${s.label}</button>`)}</div>`;
  // A failed or interrupted request (F3): why, under the head, and Retry while the root itself is the one that broke (POST /api/tasks/:id/retry).
  const Trouble=({turn,root,readOnly})=>html`<p class="pending-actions thread-trouble"><span>${turn.result||''}</span>${!readOnly&&TROUBLE.includes(root.status)&&html`<button type="button" class="thread-retry" style=${TAP} onClick=${e=>act(e.currentTarget,root.id,'retry')}>Retry</button>`}</p>`;
  function Thread({page,state,selected,messages,waiting}){
    // Freshest first: the state's tasks, then the page's and the loaded threads' (a thread keeps the copy it loaded).
    const fresh=known(state,page),byId=new Map([...fresh].reverse().map(t=>[t.id,t]));
    const ctx={tasks:new Map(state.tasks.map(t=>[t.id,t])),readOnly:state.readOnly,cat:selected,plan:planState({state,page})},list=items=>items.map(i=>html`<${Item} key=${i.key} item=${i} ctx=${ctx}/>`),ids=openIds(state,page);let out;
    if(!view){
      ctx.results=resultIds(messages,byId);
      out=[page?.more&&html`<button key="earlier" type="button" class="chat-earlier" data-earlier>Earlier messages</button>`,...list(threadItems({messages,approvals:selected==='mayor'?state.approvals:state.approvals.filter(a=>a.cat===selected),events:state.events,fold:selected==='mayor'}))].filter(Boolean);
      if(!out.length&&!waiting.length)out=[html`<div class="empty" key="empty"><span class="big">ฅ</span><p>A little idea can become<br/>something worth working on.</p><button id="try-demo" style=${TAP}>Try a delegation</button>${selected==='mayor'&&!state.readOnly&&html`<${Starters}/>`}</div>`];
    }else if(view.kind==='request'){
      const t=threads.get(view.id)??{},root=byId.get(view.id),thread=merged(t.messages,state.messages.filter(m=>ids.has(m.task))),turn=root&&latestTurn(root,thread,fresh);
      Object.assign(ctx,{cat:root?.cat,result:root?.status==='done'?thread.findLast(m=>m.task===root.id&&m.to==='owner')?.id:null,results:resultIds(thread,byId)});
      out=[html`<${Head} key="head" kind="Request" title=${root?.text??''} state=${REQUEST[turn?.status]} people=${peopleOf(t.participants,name)}/>`,TROUBLE.includes(turn?.status)&&html`<${Trouble} key="trouble" turn=${turn} root=${root} readOnly=${state.readOnly}/>`,t.more&&html`<button key="earlier" type="button" class="chat-earlier" onClick=${()=>{following=false;void load(view.id,true);}}>Earlier messages</button>`,...list(threadItems({messages:thread,approvals:state.approvals.filter(a=>ids.has(a.task)),events:state.events})),note(t)];
    }else{
      const goal=state.goals?.find(g=>g.id===view.id);if(!goal)return html`<${Head} kind="Goal" title="No longer in this town"/>`;
      const round=r=>{const t=threads.get(r.task.id)??{},tree=treeOf(r.task.id,[...t.tasks??[],...state.tasks]);return note(t)||list(threadItems({messages:merged(t.messages,state.messages.filter(m=>tree.has(m.task)))}));};
      out=[html`<${Head} key="head" kind="Goal" title=${goal.title} state=${GOAL[goal.status]}/>`,...roundsOf(goal,known(state,page)).map(r=>r.task?html`<${Fold} key=${'r'+r.n} k=${`r:${goal.id}:${r.n}`} label=${`Round ${r.n} · ${r.text}`} task=${r.task.id}>${()=>round(r)}<//>`:html`<p class="work-row" key=${'r'+r.n}><span class="work-label">Round ${r.n} · ${r.text}</span></p>`),
        goal.note&&html`<p class="chat-event" key="note">${goal.note}</p>`,...state.approvals.filter(a=>a.goal===goal.id||ids.has(a.task)).map(a=>html`<${Item} key=${'d'+a.id} item=${{kind:'decision',a}} ctx=${ctx}/>`)];
    }
    showsResults=!!ctx.results?.size;
    return [...out,...waiting.map(p=>html`<article key=${'p'+p.id} class=${`chat-message owner pending${p.status==='failed'?' failed':''}`} aria-hidden=${p.status==='failed'?undefined:'true'}><div class="sender"><span>You</span><span>${p.status==='failed'?'Not sent':'Sending…'}</span></div><div class="text">${p.text}</div>${p.status==='failed'&&!state.readOnly&&html`<p class="pending-actions"><button type="button" data-retry=${p.id}>Retry</button><button type="button" data-discard=${p.id}>Discard</button></p>`}</article>`)];
  }
  function paint(props){
    last=props;const {page,state,selected}=props,switched=shownCat!==selected;if(switched){if(shownCat!==null)view=null;shownCat=selected;}
    const messages=chatMessages(page?.messages,state.messages,selected),waiting=unsent(page?.pending,messages);
    // Something else emptied the log (app.js showPairing): start from nothing rather than diff against nodes that are gone.
    if(mounted&&!chat.firstChild)render(null,chat);
    render(html`<${Thread} ...${props} messages=${messages} waiting=${waiting}/>`,chat);mounted=true;
    if(switched||following||waiting.length>pendingCount)pin();pendingCount=waiting.length;
    if(showsResults)freshServices(state);
  }
  // The working line (plan 8.2, 8.3): each running task of what is open, what it is doing, for how long, Stop, and its live text in a draft that the
  // journaled message replaces. Outside the role="log" chat; Preact keeps each node, so a status line is read when its words change, never per word or tick.
  const Since=({at})=>html`<span class="live-time" aria-hidden="true"> · ${ago(at,now.value)}</span>`;
  function Draft({who,text}){const ref=useRef();useLayoutEffect(()=>{ref.current.scrollTop=ref.current.scrollHeight;});return html`<div class="chat-message draft" aria-live="off" ref=${ref}><div class="sender"><span>${who} is writing…</span></div><div class="text">${text}</div></div>`;}
  // Stop on a working line, Retry on a broken request: the button waits until the POST settles, so a second tap sends nothing.
  const act=(b,id,what)=>{b.disabled=true;api(`tasks/${encodeURIComponent(id)}/${what}`,{}).catch(error=>{b.disabled=false;notify(error);});};
  // In a cat's chat, lines of several requests sit together, so each says which it serves (F2), as the decision card does (decision-strip.js,
  // the same classes). A request or goal thread's head already names it. It sits in the line, beside Stop (chat-sheet.css: one 44px row).
  const For=({r})=>html`<a class="decision-for" href=${`#thread=${encodeURIComponent(r.id)}`} title=${`Open the request: ${r.title}`}><span class="decision-for-label">For:</span> <span class="decision-for-title">${r.title}</span></a>`;
  function Live({page,state,selected}){
    const ids=openIds(state,page),said=[...page?.messages??[],...state.messages],tasks=state.tasks.filter(t=>LIVE.includes(t.status)&&(ids?ids.has(t.id):t.cat===selected)),on=tasks.length>0&&!chat.hidden;
    useEffect(()=>{if(!on)return;const timer=setInterval(()=>{now.value=Date.now();},1000);return ()=>clearInterval(timer);},[on]);
    live.hidden=!on;
    return tasks.flatMap(t=>{const since=said.find(m=>m.task===t.id)?.at,text=state.live?.[t.id]?.text,r=!ids&&requestOf({task:t.id},{tasks:known(state,page),goals:state.goals});return [
      html`<p class="live-line" key=${'s'+t.id}><${Ico} n="paw-print"/><span role="status">${liveText(t,state.tasks,state.live?.[t.id],name)}</span>${since&&html`<${Since} at=${since}/>`}${r&&html`<${For} r=${r}/>`}${!state.readOnly&&html`<button type="button" class="live-stop" aria-label=${`Stop ${name(t.cat)}’s work`} onClick=${e=>act(e.currentTarget,t.id,'stop')}>Stop</button>`}</p>`,
      text&&html`<${Draft} key=${'d'+t.id} who=${name(t.cat)} text=${text}/>`];});
  }
  function paintLive(props){if(last)last={...last,state:props.state};render(html`<${Live} ...${props}/>`,live);}
  if(/[?&]perf\b/.test(globalThis.location?.search??''))globalThis.__chatThread={open,current};
  return {paint,live:paintLive,pin,setFollow:value=>{following=value;},forget:()=>{if(mounted)render(null,chat);},open,current};
}

// Applies one SSE frame from src/state-delta.ts to the page's state. Pure: a new state object with new arrays, so the
// town-state listeners (town-events.js diffs prev against next by id) see what changed. Null means refetch /api/state:
// another world, or a frame missed (seq is the journal position and each frame is exactly one event).
const upsert=(list,item)=>{const i=list.findIndex(x=>x.id===item.id);return i<0?[...list,item]:list.map((x,j)=>j===i?item:x);};
export function applyFrame(state,frame){
  // Presence (plan 10.10): who has a page open, by person. Not a journal event and the same in every world, so it carries no seq.
  if(frame.presence)return state&&{...state,presence:frame.presence};
  if(!state||frame.world!==state.activeWorld?.id||frame.seq>state.seq+1)return null;
  if(frame.activity||frame.delta)return applyLive(state,frame);
  if(frame.seq<=state.seq)return state;
  const next={...state,...frame.patch,seq:frame.seq};
  if(frame.event)next.events=[...state.events,frame.event].slice(-state.limits.events);
  if(frame.message)next.messages=[...state.messages,frame.message];
  if(frame.task)next.tasks=upsert(state.tasks,frame.task);
  if(frame.task&&state.live?.[frame.task.id]&&!LIVE.has(frame.task.status)){const {[frame.task.id]:_,...rest}=state.live;next.live=rest;}
  if(frame.approval)next.approvals=upsert(state.approvals,frame.approval);
  return next;
}
// One cat's chat: the pages loaded from /api/chats plus what the state has (recent messages and every frame since), by id, in time order.
export function chatMessages(page,messages,cat){
  const byId=new Map((page||[]).map(m=>[m.id,m]));
  for(const m of messages)if(m.from===cat||m.to===cat)byId.set(m.id,m);
  return [...byId.values()].sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:0);
}
// One cat's tasks: its newest from /api/chats, updated and extended by the state's (unfinished work and every frame since).
export function catTasks(page,tasks,cat){
  const byId=new Map((page||[]).map(t=>[t.id,t]));
  for(const t of tasks)if(t.cat===cat)byId.set(t.id,t);
  return [...byId.values()];
}
// A transient frame (src/state-delta.ts transient): what a running task is doing (activity), its live text so far (delta.text, the whole
// redacted text, not a piece), the end of one model call (delta.done) or a heartbeat (a bare delta). state.live is by task; seq never moves.
const LIVE=new Set(['queued','running','waiting','waiting_child']);
export function applyLive(state,frame){
  if(frame.seq>state.seq)return state;
  const f=frame.activity??frame.delta,was=state.live?.[f.task]??{cat:f.cat};
  const now=frame.activity?{...was,label:f.label}:f.done?{cat:was.cat,label:was.label}:f.text!==undefined?{...was,text:f.text}:{...was,beats:(was.beats??0)+1};
  return {...state,live:{...state.live,[f.task]:now}};
}
// The closed gate (plan 10.10, §4.3): whether the host still answers. Every open, frame and successful refetch is an answer (seen); a stream
// error that no answer follows within `every` ms (pollMs) closes the gate, so a stopped host reads as closed within one poll. Nothing queues
// while it is closed. ponytail: a host that sleeps without closing the connection shows only once the browser drops the stream (TCP timeout);
// a heartbeat the page can see would catch it sooner.
export function createGate({every,now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),onChange=()=>{}}){
  let open=true,lastSeenAt=null;
  const gateState=()=>({open,lastSeenAt});
  const set=next=>{if(next!==open){open=next;onChange(gateState());}};
  const seen=()=>{lastSeenAt=now();set(true);};
  const lost=()=>{const at=now();schedule(()=>{if(lastSeenAt===null||lastSeenAt<at)set(false);},every);};
  // watch: one page stream (an EventSource), whose open and frames are answers and whose error starts the wait.
  return {gateState,seen,watch(source){source.addEventListener('open',seen);source.addEventListener('message',seen);source.addEventListener('error',lost);}};
}

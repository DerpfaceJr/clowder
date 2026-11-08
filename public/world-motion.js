// Pure movement rules shared by the renderer and runtime tests.
export function distanceToSegment(x,z,a,b){
  const dx=b[0]-a[0],dz=b[1]-a[1],d=dx*dx+dz*dz;
  const t=d?Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/d)):0;
  return Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);
}
export function makePath(points){
  const clean=points.filter((p,i)=>!i||Math.hypot(p[0]-points[i-1][0],p[1]-points[i-1][1])>.001);
  let length=0;const segments=[];
  for(let i=1;i<clean.length;i++){const a=clean[i-1],b=clean[i],size=Math.hypot(b[0]-a[0],b[1]-a[1]);segments.push({a,b,start:length,size});length+=size;}
  return {length,at(distance){
    const d=Math.max(0,Math.min(length,distance));
    const s=segments.find(s=>d<=s.start+s.size)||segments.at(-1);
    if(!s)return {x:clean[0]?.[0]||0,z:clean[0]?.[1]||0,yaw:0};
    const t=(d-s.start)/s.size;
    return {x:s.a[0]+(s.b[0]-s.a[0])*t,z:s.a[1]+(s.b[1]-s.a[1])*t,yaw:Math.atan2(s.b[0]-s.a[0],s.b[1]-s.a[1])};
  }};
}
/** Every new message is visited, even if polling receives a whole burst at once. */
export class MessageVisits{
  cursor; queue=[]; current=null;
  ingest(messages,cats){
    if(this.cursor===undefined){this.cursor=messages.at(-1)?.id||null;return;}
    const index=this.cursor===null?-1:messages.findIndex(m=>m.id===this.cursor);
    // /api/state carries only recent messages: after a long disconnect the refetched window can start past the cursor. That is a new baseline, not a burst of old visits.
    if(this.cursor!==null&&index<0){this.cursor=messages.at(-1)?.id||null;return;}
    const fresh=messages.slice(index+1),ids=new Set(cats.map(c=>c.id));
    this.queue.push(...fresh.filter(m=>m.from!==m.to&&ids.has(m.from)&&ids.has(m.to)));
    this.cursor=messages.at(-1)?.id||null;
  }
  /** A new world: its messages are history again, and no visit is under way. */
  reset(){this.cursor=undefined;this.queue=[];this.current=null;}
  replay(messages,cats){
    const ids=new Set(cats.map(c=>c.id));this.queue=messages.filter(m=>m.from!==m.to&&ids.has(m.from)&&ids.has(m.to)).slice(-8);
  }
  /** layout is the town geometry from hamlet-layout townLayout; its visitPath follows the physical roads. */
  /** ready(message) may hold the next visit back, e.g. until a sleeping sender has woken. */
  /** spot(message) -> {gap, ok}: the courier stops short of the recipient (see talkStop); omitted, it walks the whole path. */
  start(cats,layout,ready=()=>true,spot=null){
    if(this.current||!this.queue.length||!ready(this.queue[0]))return this.current;
    const message=this.queue.shift(),a=cats.find(c=>c.id===message.from),b=cats.find(c=>c.id===message.to);
    if(!a?.home||!b?.home)return null;
    const points=layout?layout.visitPath(a,b):[[a.home.x,a.home.z],[b.home.x,b.home.z]],s=spot?.(message),plain=makePath(points);
    const {path,stop}=s?talkPath(points,s.gap,s.ok,s.yard):{path:plain,stop:plain.length};
    this.current={message,path,stop,phase:'walk',distance:0,elapsed:0,position:path.at(0)};
    return this.current;
  }
  advance(dt,{speed,talkSeconds,paused=false,reduced=false}){
    const v=this.current;if(!v||paused)return v;
    if(v.phase==='talk'){
      v.elapsed+=dt;if(v.elapsed>=talkSeconds){v.phase='return';v.elapsed=0;}
    }else{
      v.distance=Math.max(0,Math.min(v.stop,v.distance+(v.phase==='walk'?1:-1)*(reduced?v.stop:speed*dt)));
      v.position=v.path.at(v.distance);if(v.phase==='return')v.position.yaw+=Math.PI;
      if(v.phase==='walk'&&v.distance>=v.stop){v.phase='talk';v.elapsed=0;}
      else if(v.phase==='return'&&v.distance<=0)this.current=null;
    }
    return this.current;
  }
  retainCats(cats){const ids=new Set(cats.map(c=>c.id)),valid=m=>ids.has(m.from)&&ids.has(m.to);this.queue=this.queue.filter(valid);
    // A courier whose recipient left walks home along its own lane instead of snapping back.
    const v=this.current;if(v&&!valid(v.message)){if(ids.has(v.message.from)&&v.phase!=='return'){v.phase='return';v.elapsed=0;}else if(!ids.has(v.message.from))this.current=null;}}
  cancelTasks(ids){this.queue=this.queue.filter(m=>!ids.has(m.task));if(this.current&&ids.has(this.current.message.task)){this.current.phase='return';this.current.elapsed=0;}}
}

/**
 * Where a courier stops to talk, as a distance along its path (which ends on the recipient's stand point). The spot
 * stays on the path, so it is road or the recipient's yard. Walking back from the end in 5 cm steps, it is the first
 * point at least `gap` (straight line) from the recipient where ok(x,z) holds; the sender's own end if none does.
 */
export function talkStop(path,gap,ok=()=>true,step=.05){
  const end=path.at(path.length);
  for(let d=path.length;d>0;d-=step){const p=path.at(d);if(Math.hypot(p.x-end.x,p.z-end.z)>=gap&&ok(p.x,p.z))return d;}
  return 0;
}
/**
 * The courier's walk and stop: {path, stop}. Usually the stop on the visit path (talkStop). When the path only meets the
 * rule well past the gap (the hall's walking link from the far end of its ring passes the door, inside the house
 * radius), the courier leaves the path there for one straight step across the paved yard (yard(x,z): both ends inside
 * one disc, so the whole step is) to the nearest spot exactly `gap` from the recipient (72 bearings) that passes ok()
 * and whose step never comes closer than `gap`, so the two never overlap on the way in. Off a yard it keeps the stop.
 */
export function talkPath(points,gap,ok,yard=()=>false,step=.05){
  const path=makePath(points),stop=talkStop(path,gap,ok,step),p=path.at(stop),[ex,ez]=points.at(-1);
  if(Math.hypot(p.x-ex,p.z-ez)<=gap+.25||!yard(p.x,p.z))return {path,stop};
  let best=null;
  for(let k=0;k<72;k++){
    const x=ex+Math.sin(k*Math.PI/36)*gap,z=ez+Math.cos(k*Math.PI/36)*gap,length=Math.hypot(x-p.x,z-p.z);
    if(best&&length>=best.length||!ok(x,z)||!yard(x,z))continue;
    let clear=true;for(let t=step;t<length&&clear;t+=step){const f=t/length;clear=Math.hypot(p.x+(x-p.x)*f-ex,p.z+(z-p.z)*f-ez)>=gap-1e-6;}
    if(clear)best={x,z,length};
  }
  if(!best)return {path,stop};
  // Path points up to the stop, then the step. makePath drops the duplicate when the stop is itself a point.
  const kept=[];let walked=0;kept.push(points[0]);
  for(let i=1;i<points.length;i++){walked+=Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);if(walked>=stop)break;kept.push(points[i]);}
  const detour=makePath([...kept,[p.x,p.z],[best.x,best.z]]);return {path:detour,stop:detour.length};
}
/**
 * The talk-spot rule for talkStop. ra, rb: sender and recipient bounding-circle radii; the circles keep talkGap apart.
 * The spot is outside every house radius (homes: house centres), on held ground above the water (bridge decks do not
 * count) and keeps the same gap from every other resident (others: [{x, z, r}] stand points and radii). yards: the
 * paved hall discs [{x, z, r}] a courier may cut across (talkPath).
 */
export function talkRule({ra,rb,talkGap,houseRadius,homes,others,height,water,yards=[]}){
  return {gap:ra+rb+talkGap,yard:(x,z)=>yards.some(y=>Math.hypot(x-y.x,z-y.z)<=y.r),ok:(x,z)=>height(x,z)>water&&homes.every(h=>Math.hypot(x-h.x,z-h.z)>=houseRadius)&&others.every(o=>Math.hypot(x-o.x,z-o.z)>=ra+o.r+talkGap)};
}
/** Yaw that turns a model whose front is local +z (kit cats, the Mayor, the procedural cats) from one point to another. */
export const faceYaw=(from,to)=>Math.atan2(to.x-from.x,to.z-from.z);
/**
 * Eases a yaw toward a target along the shorter arc: about 95% of any turn in 0.3 s (time constant 0.1 s), frame-rate
 * independent, settling exactly once within 1e-3 rad. dt 0 (paused) holds it; reduced motion turns at once.
 */
export function turnToward(yaw,target,dt,reduced=false){
  if(!Number.isFinite(yaw)||reduced)return target;
  const delta=Math.atan2(Math.sin(target-yaw),Math.cos(target-yaw));
  return Math.abs(delta)<1e-3?target:yaw+delta*(1-Math.exp(-dt/.1));
}

/** Idle: no running or waiting task, no pending approval, and not in the current or next visit as sender or receiver. */
export function idleCat(cat,id,current,next){return !cat.busy&&!cat.waiting&&!cat.alert&&![current?.message,next].some(m=>m&&(m.from===id||m.to===id));}
/**
 * Per-cat sleep clock. rest = {idle, amount, state}; amount runs 0 (awake) .. 1 (asleep).
 * Idle for sleepAfter seconds -> settles over settleSeconds -> 'sleeping'. Not idle -> wakes over wakeSeconds.
 * Paused freezes it; reduced motion makes the transitions instant.
 */
export function restStep(rest,{idle,dt,sleepAfter,paused=false,reduced=false,settleSeconds=1.2,wakeSeconds=.6}){
  if(paused)return rest;
  rest.idle=idle?rest.idle+dt:0;
  const down=idle&&rest.idle>=sleepAfter,rate=down?settleSeconds:wakeSeconds;
  rest.amount=Math.max(0,Math.min(1,rest.amount+(down?1:-1)*(reduced||!rate?1:dt/rate)));
  rest.state=down?(rest.amount<1?'settling':'sleeping'):rest.amount>0?'waking':'awake';
  return rest;
}

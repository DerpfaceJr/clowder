// The welcome for a new world: letterbox bars, the camera drifting down from high over the meadow to the Mayor, three
// lines from the Mayor (the last one while the camera passes the treasury and the observatory), then back to the usual
// view with Chat open on the Mayor. Owner only, once per world (POST /api/world/intro-seen plus a localStorage guard).
// Reduced motion shows the same three lines as a card sequence with no camera flight. Pure rules first (tested in
// test/intro-cinematic.test.mjs); nothing touches document or window until play starts.
import * as T from 'three';
import {faceYaw} from './world-motion.js';
import {sfx} from './audio.js';

/** The flight, step by step (seconds). line: which of the Mayor's lines shows during the step. */
export const INTRO_STEPS=[{id:'open',seconds:1.2},{id:'descend',seconds:3.2},{id:'hello',seconds:3.6,line:0},{id:'ask',seconds:3.6,line:1},{id:'tour',seconds:5,line:2},{id:'outro',seconds:2}];
export const INTRO_SECONDS=INTRO_STEPS.reduce((a,s)=>a+s.seconds,0);
export function introLines(worldName){
  return [`Hello! I'm the Mayor of ${String(worldName||'').trim()||'this town'}.`,"Tell me what you'd like to build, and I'll gather the right cats for the job.",'The Moonvault keeps count of what we spend, and the observatory remembers every cat who rests.'];
}
/** The step at t seconds into the flight: {id, k (0..1 inside it), line}; past the end, {id:'done', k:1}. */
export function introAt(t){
  let start=0;for(const s of INTRO_STEPS){if(t<start+s.seconds)return {id:s.id,k:Math.max(0,(t-start)/s.seconds),line:s.line??null};start+=s.seconds;}
  return {id:'done',k:1,line:null};
}
/**
 * The cinematic as a state machine. mode 'flight' runs on time ({type:'tick', dt}); mode 'cards' (reduced motion)
 * steps one line per {type:'next'}. {type:'skip'} ends either at once. done: finished; skipped: ended by skip.
 */
export function introStart(reduced){return {mode:reduced?'cards':'flight',t:0,card:0,done:false,skipped:false};}
export function introReduce(s,e){
  if(s.done)return s;
  if(e.type==='skip')return {...s,done:true,skipped:true};
  if(e.type==='tick'&&s.mode==='flight'){const t=s.t+Math.max(0,e.dt||0);return {...s,t,done:t>=INTRO_SECONDS};}
  if(e.type==='next'&&s.mode==='cards'){const card=s.card+1;return {...s,card,done:card>=introLines().length};}
  return s;
}
/** Whether this viewer should see the welcome: the owner (not view-only), the world says so, not seen here before. force: ?intro. */
export function shouldPlayIntro(state,{seen=false,force=false}={}){
  if(!state?.world||state.readOnly)return false;
  return force||(state.introPending===true&&!seen);
}
export const introKey=state=>'clowder-intro-seen:'+(state?.activeWorld?.id||'town');
/** Marks the intro seen: the localStorage guard first (so a failed request still never replays it), then one POST. */
export function introSeenOnce({post,storage,key}){
  let sent=false;
  return ()=>{try{storage?.setItem(key,'1');}catch{}if(sent)return false;sent=true;Promise.resolve().then(post).catch(()=>{});return true;};
}

const STYLE=`
.intro-cinema{position:fixed;inset:0;z-index:60;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none}
.intro-cinema .intro-bar{position:absolute;left:0;right:0;height:11vh;background:#0b1214;transition:transform .9s cubic-bezier(.2,.7,.2,1)}
.intro-cinema .intro-bar.top{top:0;transform:translateY(-100%)}.intro-cinema .intro-bar.bottom{bottom:0;transform:translateY(100%)}
.intro-cinema.on .intro-bar{transform:none}
.intro-cinema .intro-skip{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:calc(5.5vh - 18px);z-index:1;font:600 14px Inter,"Segoe UI",sans-serif;color:#ddfff6;background:rgba(35,91,115,.5);border:1px solid #acf9ee;border-radius:999px;padding:8px 16px;cursor:pointer;opacity:0;transition:opacity .6s .6s}
.intro-cinema.on .intro-skip{opacity:1}
.intro-cinema .intro-hold{position:absolute;left:16px;bottom:calc(5.5vh - 9px);font:500 12px Inter,"Segoe UI",sans-serif;color:#9fc9c2;opacity:0;transition:opacity .6s .6s}
.intro-cinema.on .intro-hold{opacity:.8}
.intro-bubble{position:absolute;left:0;top:0;max-width:min(520px,82vw);padding:14px 20px;border-radius:18px;background:rgba(35,91,115,.8);border:2px solid #acf9ee;box-shadow:0 0 16px #8df5ed;color:#ddfff6;font:600 20px/1.35 Inter,"Segoe UI",sans-serif;text-align:center;opacity:0;transition:opacity .35s;will-change:translate}
.intro-bubble.show{opacity:1}
.intro-bubble::after{content:'';position:absolute;left:50%;bottom:-10px;margin-left:-8px;border:8px solid transparent;border-top-color:#acf9ee;border-bottom:0}
.intro-bubble.free::after{display:none}
.intro-card{position:absolute;left:50%;top:50%;translate:-50% -50%;width:min(440px,calc(100vw - 32px));box-sizing:border-box;padding:24px;border-radius:20px;background:#fdf8ea;color:#2f3b37;box-shadow:0 12px 40px rgba(0,0,0,.35);font:16px/1.45 Inter,"Segoe UI",sans-serif}
.intro-card .eyebrow{font:700 11px Inter,"Segoe UI",sans-serif;letter-spacing:.14em;color:#7b8f6f}
.intro-card p{font-size:20px;margin:10px 0 20px}
.intro-card .actions{display:flex;justify-content:flex-end;gap:10px}
.intro-card button{font:600 15px Inter,"Segoe UI",sans-serif;border-radius:999px;padding:9px 18px;border:1px solid #c9bfa6;background:#fff;color:#2f3b37;cursor:pointer}
.intro-card button.primary{background:var(--accent,#526854);border-color:var(--accent,#526854);color:#fff}
body.cinematic :is(header,.town-dock,footer,#labels,.world-controls,.world-hint,.world-title,.panel:not(.world)){opacity:0!important;pointer-events:none!important;transition:opacity .6s}
body.cinematic-out :is(header,.town-dock,footer,#labels,.world-controls,.world-hint,.world-title,.panel:not(.world)){transition:opacity .8s}
@media (max-width:700px){.intro-bubble{font-size:17px;padding:12px 16px}}
`;
const ease=t=>t*t*(3-2*t);
/**
 * The runtime. town.js calls check(state) on every update, frame(dt) before controls.update(), and asks holds/actor for
 * the Mayor. spot(name) -> world position of 'mayor' | 'treasury' | 'memorial' (or null); head(): the Mayor's head;
 * ready(): the Mayor's model is in (waited for at most 3 s); onEnd(): open Chat on the Mayor.
 */
export function createIntro({camera,controls,canvas,reduced,spot,head,ready,onEnd}){
  let s=null,lines=[],markSeen=null,overlay=null,bubble=null,card=null,shownLine=-1,waited=0,keys=null,played=false,hold=null,rect=null;
  // Sounds (audio.js SFX_EVENTS): each cue plays once per intro.
  const cued=new Set(),cue=(key,name,detail)=>{if(!cued.has(key)){cued.add(key);sfx(name,detail);}};
  const saved={target:new T.Vector3(),position:new T.Vector3(),zoom:1},v=new T.Vector3();
  const frames={};// camera keyframes: {target, polar, az, zoom}
  const orbit=(target,position)=>{v.copy(position).sub(target);const d=v.length();return {polar:Math.acos(v.y/d),az:Math.atan2(v.x,v.z),d};};
  function key(target,polar,az,zoom){return {target:target.clone(),polar,az,zoom};}
  function shoot(a,b,k){
    const e=ease(Math.max(0,Math.min(1,k))),target=a.target.clone().lerp(b.target,e),polar=a.polar+(b.polar-a.polar)*e,az=a.az+(b.az-a.az)*e,zoom=Math.exp(Math.log(a.zoom)+(Math.log(b.zoom)-Math.log(a.zoom))*e);
    controls.target.copy(target);camera.position.set(target.x+frames.d*Math.sin(polar)*Math.sin(az),target.y+frames.d*Math.cos(polar),target.z+frames.d*Math.sin(polar)*Math.cos(az));
    camera.zoom=zoom;camera.lookAt(target);camera.updateProjectionMatrix();
  }
  function plan(){
    saved.target.copy(controls.target0);saved.position.copy(controls.position0);saved.zoom=controls.zoom0;
    const home=orbit(saved.target,saved.position),mayor=(spot('mayor')||saved.target).clone().add(v.set(0,1.1,0));frames.d=home.d;
    frames.wide=key(new T.Vector3(mayor.x*.3,0,mayor.z*.3),.22,home.az-.35,.4);
    frames.mayor=key(mayor,home.polar*.92,home.az,3);
    frames.treasury=key(spot('treasury')||mayor,home.polar,home.az+.25,2.3);
    frames.memorial=key((spot('memorial')||mayor).clone().add(v.set(0,2,0)),home.polar*.95,home.az-.2,1.5);
    frames.home=key(saved.target,home.polar,home.az,saved.zoom);
  }
  function build(){
    if(!document.getElementById('intro-style')){const style=document.createElement('style');style.id='intro-style';style.textContent=STYLE;document.head.append(style);}
    overlay=document.createElement('div');overlay.className='intro-cinema';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','Welcome to your new world');
    if(s.mode==='flight'){
      overlay.innerHTML='<div class="intro-bar top"></div><div class="intro-bar bottom"></div><span class="intro-hold" aria-hidden="true">Hold to skip</span><button class="intro-skip" type="button">Skip</button>';
      bubble=document.createElement('div');bubble.className='intro-bubble';bubble.setAttribute('role','status');bubble.setAttribute('aria-live','polite');overlay.append(bubble);
      // Tap and hold anywhere skips; a short tap does nothing.
      overlay.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;clearTimeout(hold);hold=setTimeout(skip,700);});
      for(const type of ['pointerup','pointercancel','pointerleave'])overlay.addEventListener(type,()=>clearTimeout(hold));
    }else{
      overlay.innerHTML='<div class="intro-card"><div class="eyebrow">WELCOME</div><p aria-live="polite"></p><div class="actions"><button type="button" class="intro-skip-card">Skip</button><button type="button" class="primary intro-next">Next</button></div></div>';
      card=overlay.querySelector('p');overlay.querySelector('.intro-next').onclick=()=>step({type:'next'});overlay.querySelector('.intro-skip-card').onclick=skip;
    }
    overlay.querySelector('.intro-skip')?.addEventListener('click',skip);
    keys=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();skip();}};document.addEventListener('keydown',keys,true);
    document.body.append(overlay);document.body.classList.add('cinematic');
    requestAnimationFrame(()=>overlay?.classList.add('on'));sfx('intro-swell');
  }
  function showCard(){sfx('intro-chirp');card.textContent=lines[s.card];const next=overlay.querySelector('.intro-next');next.textContent=s.card===lines.length-1?"Let's begin":'Next';next.focus();}
  function step(e){s=introReduce(s,e);if(s.done)finish();else if(s.mode==='cards')showCard();}
  function skip(){if(s&&!s.done)step({type:'skip'});}
  function finish(){
    clearTimeout(hold);document.removeEventListener('keydown',keys,true);
    // The bars slide away and the chrome fades back in; on skip the camera returns to the town square at once.
    if(s.skipped||s.mode==='cards'){if(s.mode==='flight')controls.reset();}else shoot(frames.home,frames.home,1);
    controls.enabled=true;
    const leaving=overlay;overlay=bubble=card=null;if(leaving){leaving.classList.remove('on');leaving.style.pointerEvents='none';setTimeout(()=>leaving.remove(),900);}
    document.body.classList.add('cinematic-out');document.body.classList.remove('cinematic');setTimeout(()=>document.body.classList.remove('cinematic-out'),900);
    dispatchEvent(new CustomEvent('cinematic',{detail:{on:false}}));
    sfx(s.skipped?'intro-stop':'intro-resolve');
    markSeen();onEnd?.();
  }
  function placeBubble(line){
    if(line!==shownLine){shownLine=line;bubble.classList.remove('show');if(line!==null){sfx('intro-chirp');bubble.textContent=lines[line];requestAnimationFrame(()=>bubble?.classList.add('show'));}}
    if(line===null)return;
    rect??=canvas.getBoundingClientRect();
    const p=head();if(!p)return;p.project(camera);
    const w=bubble.offsetWidth,h=bubble.offsetHeight,bar=innerHeight*.11,x=rect.left+(p.x*.5+.5)*rect.width,y=rect.top+(-p.y*.5+.5)*rect.height-16;
    // Kept between the bars and inside the view; the tail shows only while it points at the Mayor.
    const left=Math.max(16,Math.min(innerWidth-16-w,x-w/2)),top=Math.max(bar+12,Math.min(innerHeight-bar-12-h,y-h));
    bubble.classList.toggle('free',Math.abs(left-(x-w/2))>2||Math.abs(top-(y-h))>2||p.z>1);
    bubble.style.translate=`${Math.round(left)}px ${Math.round(top)}px`;
  }
  function start(state){
    played=true;const key=introKey(state);
    markSeen=introSeenOnce({key,storage:(()=>{try{return localStorage;}catch{return null;}})(),
      post:()=>fetch('/api/world/intro-seen',{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:'{}'})});
    lines=introLines(state.activeWorld?.name||state.world?.name);s=introStart(reduced);cued.clear();
    dispatchEvent(new CustomEvent('cinematic',{detail:{on:true}}));
    if(s.mode==='flight'){controls.enabled=false;plan();shoot(frames.wide,frames.wide,1);}
    build();if(s.mode==='cards')showCard();
    addEventListener('resize',()=>{rect=null;});
  }
  const seen=state=>{try{return localStorage.getItem(introKey(state))==='1';}catch{return false;}};
  return {
    check(state){
      if(played||!state)return;
      const force=new URLSearchParams(location.search).has('intro');
      // The welcome plays over a quiet first screen only. With a dialog open or words in the composer the owner has begun: the flight
      // would run behind the dialog, or hide the box being typed in, so it is left for the next launch (not marked seen).
      if(!force&&state.introPending===true&&(document.querySelector('dialog:modal')||document.getElementById('message')?.value)){played=true;return;}
      if(shouldPlayIntro(state,{seen:seen(state),force}))try{start(state);}catch(error){console.warn('Intro could not start:',error);if(s){s={...s,done:true};finish();}}
    },
    /** Drives the camera while the flight plays; returns true while it does (town.js then drops its own camera glide). */
    frame(dt){
      if(!s||s.done||s.mode!=='flight')return false;
      // The opening holds on the wide shot until the Mayor's model is in (at most 3 s), so it never pops in on camera.
      if(s.t<INTRO_STEPS[0].seconds&&!ready()&&waited<3){waited+=dt;return true;}
      step({type:'tick',dt});if(s.done)return false;
      const at=introAt(s.t),f=frames;
      if(at.id==='open')shoot(f.wide,f.wide,1);
      else if(at.id==='descend'){cue('descend','intro-whoosh',{seconds:INTRO_STEPS[1].seconds});shoot(f.wide,f.mayor,at.k);}
      else if(at.id==='hello'||at.id==='ask')shoot(f.mayor,f.mayor,1);
      else if(at.id==='tour'){if(at.k>=.3)cue('treasury','intro-sparkle');if(at.k>=.75)cue('memorial','intro-sparkle');if(at.k<.35)shoot(f.mayor,f.treasury,at.k/.35);else if(at.k<.8)shoot(f.treasury,f.memorial,(at.k-.35)/.45);else shoot(f.memorial,f.memorial,1);}
      else if(at.id==='outro')shoot(f.memorial,f.home,at.k);
      placeBubble(at.line);
      return true;
    },
    /** The Mayor stays awake for the welcome. */
    holds:id=>id==='mayor'&&!!s&&!s.done,
    /** The Mayor turns to the camera, waves hello, then talks. */
    actor(id){
      if(id!=='mayor'||!s||s.done||s.mode!=='flight')return null;
      const at=introAt(s.t),p=spot('mayor');if(!p||at.id==='open')return null;
      return {yaw:faceYaw(p,camera.position),mode:at.id==='hello'?'wave':at.id==='ask'||at.id==='tour'?'talk':'idle'};
    },
    get playing(){return !!s&&!s.done;},
    /** A new world: a welcome still playing ends, and the next check may play the new world's. */
    reset(){if(s&&!s.done)skip();s=null;played=false;waited=0;},
  };
}

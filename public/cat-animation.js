import * as T from 'three';

export function sampleMotion(clip,time){
  if(!clip?.frames?.length)return null;
  const f=(time%clip.duration)/clip.duration*(clip.frames.length-1),i=Math.floor(f),a=clip.frames[i],b=clip.frames[Math.min(i+1,clip.frames.length-1)],t=f-i;
  return a.map((v,n)=>v+(b[n]-v)*t);
}
export function bindMayor(asset){
  asset.updateMatrixWorld(true);const bones={},faces=[];
  asset.traverse(o=>{
    if(o.isBone)bones[o.name]={node:o,rest:o.quaternion.clone(),basis:o.getWorldQuaternion(new T.Quaternion())};
    if(o.morphTargetDictionary)faces.push(o);
  });
  return {bones,faces};
}
const q=new T.Quaternion(),basis=new T.Quaternion(),rotation=new T.Euler();
function bonePose(rig,name,x=0,y=0,z=0){
  const b=rig.bones[name];if(!b)return;
  q.setFromEuler(rotation.set(x,y,z));basis.copy(b.basis).invert();
  b.node.quaternion.copy(b.rest).multiply(basis.multiply(q).multiply(b.basis));
}
const smooth=t=>t*t*(3-2*t);
/** One hammer stroke of the 'build' pose, in seconds. construction.js times its dust puffs and hammer prop off it. */
export const STRIKE_SECONDS=.7;
/** Arm lift (radians, negative raises the paw) through a stroke: a slow wind-up, then a quick strike that lands as the cycle wraps. */
export function buildSwing(time){
  const u=((time%STRIKE_SECONDS)+STRIKE_SECONDS)%STRIKE_SECONDS/STRIKE_SECONDS;
  return u<.72?-1.7*smooth(u/.72):-1.7*(1-((u-.72)/.28)**2);
}
// Bounding-circle radius of an actor about its own origin: the farthest horizontal reach of any skinned vertex, in the
// actor's local frame (so its yaw and sleep roll do not matter). Every vertex, once per model: the Mayor LOD is ~58k
// vertices. With a rig, measured in the rest pose and the current pose put back.
const reach=new T.Vector3(),toActor=new T.Matrix4();
export function footprintRadius(actor,rig){
  const bones=rig?Object.values(rig.bones):[],held=bones.map(b=>b.node.quaternion.clone());for(const b of bones)b.node.quaternion.copy(b.rest);
  actor.updateMatrixWorld(true);toActor.copy(actor.matrixWorld).invert();let r=0;
  actor.traverse(m=>{
    if(!m.isMesh)return;if(m.isSkinnedMesh)m.skeleton.update();
    const p=m.geometry.attributes.position;for(let i=0;i<p.count;i++){m.getVertexPosition(i,reach).applyMatrix4(m.matrixWorld).applyMatrix4(toActor);r=Math.max(r,Math.hypot(reach.x,reach.z));}
  });
  bones.forEach((b,i)=>b.node.quaternion.copy(held[i]));if(rig)actor.updateMatrixWorld(true);
  return r;
}
// Lying down: the whole actor sinks (legs fold into the grass) and leans on one side. Applied every frame after the
// renderer places the cat, so it holds while paused or skipped; item.rest.amount (0..1) blends it in and out.
const SINK=.3,ROLL=.24;
export function settle(item){
  const e=smooth(item.rest?.amount||0),m=item.catModel;m.rotation.order='YXZ';m.position.y-=SINK*e;m.rotation.z=ROLL*e;
}
// Weather reactions: animation only. town.js sets item.weather (weather.js mood: {kind,strength,startle,toward,since}) on
// every cat that is not walking a message or acted by a set piece; this only returns pose offsets, never positions,
// facing, rest or work state. Each awake cat at home picks one reaction from its weather's list for a stretch of 7 to 13 s
// (by its seed, so neighbours differ), eased in and out at the stretch's ends; onset is staggered up to 2.5 s per cat. A
// startle (lightning, a meteor impact) is latched per cat with a short per-cat delay and plays a fixed flinch. Busy or
// talking cats only flatten their ears and flinch; sleepers only twitch an ear, curl the tail or lift the head. None of it
// with reduced motion. The result object and its arrays are reused per cat: no per-frame allocations.
export const REACTIONS={
  rain:['hunch','shake','cover','lookUp'],
  thunder:['hunch','cover','watch','shake'],
  snow:['fluff','shiver','gaze','bat'],
  sakura:['gaze','bat','sway'],
  tornado:['brace','lean','watch'],
  tsunami:['watch','wary','hunch'],
  meteors:['gaze','watch','point'],
};
const frac=x=>x-Math.floor(x),hash=(a,b)=>frac(Math.sin(a*127.1+b*311.7)*43758.5453);
const pulseAt=(time,seed,rate)=>{const c=frac(time*rate+seed*3.7);return c<.45?Math.sin(c/.45*Math.PI):0;};
const wrap=a=>a-Math.PI*2*Math.floor((a+Math.PI)/(Math.PI*2));
const clampTo=(v,m)=>Math.max(-m,Math.min(m,v));
/** Which reaction a cat plays now and how far in (0..1), from its seed and the clock. Returns one shared object. */
const picked={name:null,env:0,u:0,len:1};
export function pickReaction(kind,seed,time){
  const list=REACTIONS[kind];picked.name=null;picked.env=0;if(!list)return picked;
  const len=7+6*frac(seed*13.1),local=time+seed*41,slot=Math.floor(local/len),u=local/len-slot,ramp=x=>{x=Math.min(1,x/.1);return x*x*(3-2*x);};
  picked.name=list[Math.floor(hash(slot,seed*97+kind.length)*list.length)%list.length];picked.env=ramp(u)*ramp(1-u);picked.u=u;picked.len=len;return picked;
}
function reset(r){r.armLv[0]=r.armLv[1]=r.armLv[2]=r.armRv[0]=r.armRv[1]=r.armRv[2]=0;r.head[0]=r.head[1]=r.head[2]=0;r.ear=0;r.tail=0;r.armW=0;r.lean[0]=r.lean[1]=r.lean[2]=0;r.hop=0;r.fluff=0;r.armL=null;r.armR=null;return r;}
export function weatherReaction(item,time,dt,{awake,active,reduced}){
  const w=item.weather,kind=w?.kind||'clear',r=item.wxr||(item.wxr={head:[0,0,0],ear:0,tail:0,armL:null,armR:null,armLv:[0,0,0],armRv:[0,0,0],armW:0,lean:[0,0,0],hop:0,fluff:0});
  reset(r);
  // Strength eases in per cat, after a per-cat delay since the weather began; `full` eases between at home and busy.
  const late=(w?.since??99)<(item.seed||0)*2.5,want=kind==='clear'||reduced||late?0:Math.min(1,w.strength||0);
  item.wx=(item.wx||0)+(want-(item.wx||0))*Math.min(1,dt*1.5);item.wxa=(item.wxa||0)+((active?1:0)-(item.wxa||0))*Math.min(1,dt*3);
  // Startle: any rise in the shared flash is a new event; this cat flinches after its own short delay.
  const st=reduced?0:w?.startle||0;if(st>(item.wxS||0)+.05)item.wxStartAt=time+.05+(item.seed||0)*.25;item.wxS=st;
  const age=time-(item.wxStartAt??-99),flinch=age<0||age>1.4?0:age<.12?age/.12:Math.exp(-(age-.12)*3.2);
  const s=item.wx,a=item.wxa;
  if(s<.01&&flinch<.01)return r;
  const seed=item.seed||0,look=Math.sin(time*.4+seed*6),pulse=pulseAt(time,seed,.32);
  const sea=clampTo(wrap((w?.toward||0)-(item.facing||0)),1.1);
  if(!awake){
    if(kind==='rain'||kind==='thunder'||kind==='tsunami'){r.ear=.25*pulse*s;r.tail=.25*s;}
    else if(kind==='snow'){r.tail=.35*s;r.head[0]=.08*s;r.fluff=.04*s;}
    else if(kind==='sakura')r.ear=.2*pulse*s;
    else if(kind==='tornado'){r.tail=.2*Math.sin(time*7+seed*9)*s;r.ear=.3*s;}
    else if(kind==='meteors')r.ear=-.15*pulse*s;
    if(flinch>.01){r.head[0]-=.3*flinch;r.ear-=.4*flinch;}// lifts the head and pricks the ears, stays asleep
    return r;
  }
  // A base posture every awake cat shares in this weather, then its own picked reaction on top.
  const wet=kind==='rain'||kind==='thunder'||kind==='tsunami';
  if(wet){r.ear=.25*s;r.tail=.2*s;}else if(kind==='tornado')r.ear=.35*s;else if(kind==='meteors'||kind==='sakura')r.head[0]=-.15*s*a;else if(kind==='snow')r.fluff=.03*s;
  if(a>.01){
    const {name,env,u,len}=pickReaction(kind,seed,time),e=env*s*a;
    if(name==='hunch'){r.head[0]+=.22*e;r.ear+=.25*e;r.tail+=.25*e;r.lean[0]+=.1*e;}
    else if(name==='shake'){const b=Math.max(0,1-Math.abs((u-.5)*len)/.6),k=b*b*e;r.lean[2]+=Math.sin(time*30)*.14*k;r.head[2]+=Math.sin(time*30+1.2)*.3*k;r.ear+=.3*k;r.head[0]+=.1*e;}
    else if(name==='cover'){r.armW=e;r.armRv[0]=-1.9*pulse;r.head[0]+=.15*e;r.ear+=.2*e;if(kind==='thunder')r.armLv[0]=-1.7*pulseAt(time,seed+.5,.32);}
    else if(name==='lookUp'){r.head[0]-=.32*e;r.head[1]+=look*.15*e;r.ear+=.15*e;}
    else if(name==='gaze'){const track=Math.sin(time*.55+seed*6)+.35*Math.sin(time*1.3+seed);r.head[0]-=(kind==='meteors'?.5:.35)*e;r.head[1]+=track*.45*e;r.lean[1]+=track*.08*e;r.ear-=.15*e;}
    else if(name==='watch'){r.head[0]-=(kind==='meteors'?.35:.08)*e;r.head[1]+=sea*.75*e;r.lean[1]+=sea*.25*e;r.ear+=(kind==='meteors'?-.2:.35)*e;}
    else if(name==='point'){r.head[0]-=.45*e;r.head[1]+=look*.3*e;r.armW=e*smoothBump(u);r.armRv[0]=-2.5;r.armRv[2]=-.2;}
    else if(name==='fluff'){r.fluff+=.05*e;r.tail+=.4*e;r.head[0]+=.08*e;r.lean[2]+=Math.sin(time*26+seed)*.01*e;}
    else if(name==='shiver'){r.lean[2]+=Math.sin(time*31+seed)*.02*e;r.ear+=.2*e;r.fluff+=.04*e;r.head[0]+=.06*e;}
    else if(name==='bat'){const swipe=pulseAt(time,seed,.7);r.head[0]-=.35*e;r.head[1]+=look*.2*e;r.armW=e;r.armLv[0]=-1.6*swipe;r.armLv[2]=.35*swipe;r.ear-=.12*e;}
    else if(name==='sway'){r.head[2]+=.12*Math.sin(time*.9+seed*4)*e;r.tail+=.3*Math.sin(time*1.6+seed*5)*e;r.ear-=.1*e;}
    else if(name==='brace'){r.head[0]+=.12*e;r.ear+=.2*e;r.lean[0]+=.1*e;r.lean[2]+=.12*e;r.armW=e;r.armLv[0]=-.6;r.armRv[0]=-.6;r.tail+=.5*Math.sin(time*8+seed*9)*e;}
    else if(name==='lean'){r.lean[0]+=.06*e;r.lean[2]+=.16*(1+.25*Math.sin(time*5+seed))*e;r.ear+=.15*e;r.tail+=.4*Math.sin(time*7+seed*9)*e;r.head[1]+=sea*.4*e;}
    else if(name==='wary'){r.head[1]+=sea*.6*e;r.head[0]-=.05*e;r.lean[0]-=.08*e;r.ear+=.4*e;r.tail+=.35*e;}
  }
  if(flinch>.01){r.hop=.24*flinch*a*(age<.35?1:0)*Math.sin(Math.min(1,age/.35)*Math.PI);r.ear+=.5*flinch;r.head[0]+=.2*flinch;
    if(a>.5){r.armW=Math.max(r.armW,flinch);r.armLv[0]=-1.2;r.armRv[0]=-1.2;r.armLv[2]=r.armRv[2]=0;}}
  if(r.armW>0){r.armL=r.armLv;r.armR=r.armRv;}
  return r;
}
const smoothBump=u=>{const x=Math.max(0,Math.min(1,(u-.2)/.6));return Math.sin(x*Math.PI);};
export function animateCat(item,mode,time,dt,clips,reduced){
  const phase=time+item.seed*5,walking=mode==='walk',talking=mode==='talk',working=mode==='work',sleeping=mode==='sleep',building=mode==='build',waving=mode==='wave';
  // e: how far asleep; w: the stretch-and-yawn arc while waking; breath: slow chest rise, none with reduced motion.
  const e=sleeping?smooth(item.rest?.amount??1):0,w=sleeping&&item.rest?.state==='waking'?Math.sin(Math.PI*(1-item.rest.amount)):0,breath=reduced?0:Math.sin(phase*1.7)*e;
  const pose=!reduced?sampleMotion(clips?.[mode],phase):null;
  // Authored idle motion remains usable when optional downloaded clips cannot load.
  const p=pose||[walking?Math.sin(phase*9)*.35:0,0,walking?-Math.sin(phase*9)*.35:0,0,walking?-Math.sin(phase*9)*.5:0,walking?Math.sin(phase*9)*.5:0,0,0,0,0,0,0];
  const target={armL:[p[0],0,p[1]],armR:[p[2],0,p[3]],footL:[walking?p[4]:0,0,0],footR:[walking?p[5]:0,0,0],body:[p[8],p[9],p[10]]};
  // build: the right paw swings a hammer (buildSwing), the left steadies, the chest leans in on each strike.
  // wave: the right paw swung out and up beside the head, waving. The arms are short, so it lifts sideways (about z):
  // the kit and Mayor rigs have the right arm on -x, the procedural cats on +x.
  if(building){const lift=buildSwing(phase);target.armR=[-.55+lift,0,-.12];target.armL=[-.5,0,.15];target.body=[lift>-.25?.12:.04,0,0];}
  if(waving){target.armR=[-.35,0,(item.rig?-1:1)*(2.3+Math.sin(time*9)*.35)];target.armL=[0,0,0];target.body=[-.05,0,0];}
  const R=weatherReaction(item,time,dt,{awake:!sleeping,active:!walking&&!talking&&!working&&!building&&!waving,reduced});item.hop=R.hop;
  for(let n=0;n<3;n++){if(R.armL)target.armL[n]+=(R.armL[n]-target.armL[n])*R.armW;if(R.armR)target.armR[n]+=(R.armR[n]-target.armR[n])*R.armW;target.body[n]+=R.lean[n];}
  const blend=reduced?1:1-Math.exp(-dt*(building||waving?30:12));item.pose ||=Object.fromEntries(Object.keys(target).map(k=>[k,[0,0,0]]));
  for(const key of Object.keys(target))for(let n=0;n<3;n++)item.pose[key][n]+=(target[key][n]-item.pose[key][n])*blend;
  const body=item.catModel.userData.parts;
  if(body){
    for(const key of Object.keys(target))if(body[key])body[key].rotation.set(...item.pose[key]);
    body.armL.rotation.x-=1*e+1.3*w;body.armR.rotation.x-=1*e+1.3*w;body.footL.rotation.x-=1.2*e;body.footR.rotation.x-=1.2*e;
    body.body.rotation.x+=.3*e+.25*w;body.body.scale.set(1+breath*.012+R.fluff,1+breath*.025+R.fluff*.6,1+breath*.012+R.fluff);
    body.footL.position.y=.21+(pose&&walking?p[6]:0);body.footR.position.y=.21+(pose&&walking?p[7]:0);
    body.body.position.y=reduced?0:(pose?p[11]:Math.sin(phase*2)*.012);
    for(const eye of body.eyes)eye.scale.y=(!reduced&&phase%4.7<.12)?.006:.056+(.006-.056)*e;
    body.mouth.visible=(talking||w>.3)&&!reduced;body.mouth.scale.y=.047*(talking?.5+Math.abs(Math.sin(time*12))*.5:1);
  }
  if(item.rig){
    for(const b of Object.values(item.rig.bones))b.node.quaternion.copy(b.rest);
    const [ax,ay,az]=item.pose.armL,[bx,by,bz]=item.pose.armR,[cx,cy,cz]=item.pose.body;
    bonePose(item.rig,'armL',ax-1*e-1.3*w,ay,az);bonePose(item.rig,'armR',bx-1*e-1.3*w,by,bz);
    bonePose(item.rig,'footL',item.pose.footL[0]-1.2*e);bonePose(item.rig,'footR',item.pose.footR[0]-1.2*e);
    // Asleep: chest curls forward and breathes, head drops and tips, ears droop, tail wraps round the side.
    bonePose(item.rig,'chest',cx+.3*e+.03*breath+.25*w,cy,cz);bonePose(item.rig,'head',(talking?Math.sin(time*4)*.05:0)+.45*e-.35*w+(building?.18:0)+R.head[0],R.head[1],.2*e+(waving?.12:0)+R.head[2]);
    bonePose(item.rig,'earL',0,0,.3*e+R.ear);bonePose(item.rig,'earR',0,0,-.3*e-R.ear);
    const chest=item.rig.bones.chest;if(chest&&(R.fluff||chest.fluffed)){chest.restScale||=chest.node.scale.clone();chest.node.scale.set(chest.restScale.x*(1+R.fluff),chest.restScale.y*(1+R.fluff*.6),chest.restScale.z*(1+R.fluff));chest.fluffed=R.fluff>0;}// snow: fluffed up
    for(const tail of ['tail1','tail2','tail3','tail4'])bonePose(item.rig,tail,0,.4*e+R.tail,0);
    for(const face of item.rig.faces){const d=face.morphTargetDictionary,v=face.morphTargetInfluences;for(const key of ['MouthOpen','Blink_L','Blink_R'])if(d[key]!==undefined)v[d[key]]=key==='MouthOpen'?(talking?.3+Math.abs(Math.sin(time*11))*.5:w*.7):Math.max(e,!reduced&&!sleeping&&phase%4.7<.12?1:0);}
  }
  item.motion=walking?'Walking':talking?'Talking':working?'Working':building?'Building':waving?'Waving':sleeping?(item.rest?.state==='waking'?'Waking up':'Sleeping'):'At home';
}

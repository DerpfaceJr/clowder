// New houses are built, not popped in. A recruit that appears while the page is open gets a building site: the Builder
// walks over and hammers while the house rises (stakes and scaffold, walls, roof, sparkles), then the recruit steps out
// and says hello. With no Builder yet the house builds itself with a sparkle spiral. Houses already in the first
// snapshot never replay. Pure rules first (tested in test/construction.test.mjs), then the Three.js site.
import * as T from 'three';
import {bakedMeshes,glowBaked} from './world-art.js';
import {makePath,faceYaw} from './world-motion.js';
import {buildSwing,STRIKE_SECONDS} from './cat-animation.js';
import {speechBubble,disposeSprite,fitBubble} from './hologram.js';
import {sfx} from './audio.js';

/** Seconds per stage of a build, from the moment work starts (the Builder's arrival, or at once by magic). */
export const STAGE_SECONDS={foundation:2,walls:4.5,roof:2,sparkle:1.5};
export const BUILD_SECONDS=Object.values(STAGE_SECONDS).reduce((a,b)=>a+b,0);
/** After the build: the recruit hops from the door to its stand point, then its hello bubble stays a while. */
export const EMERGE_SECONDS=1.2,HELLO_SECONDS=3;
/** Reduced motion: the finished house fades in over this long, with no scaffold, no Builder trip and no hop. */
export const FADE_SECONDS=1.2;
const clamp01=t=>Math.max(0,Math.min(1,t)),ease=t=>t*t*(3-2*t);
/** Roof height above its seat as a fraction of the drop: falls in 60% of the stage, then one soft bounce. */
export function roofDrop(k){
  k=clamp01(k);if(k<.6){const u=k/.6;return 1-u*u;}
  const u=(k-.6)/.4;return Math.sin(Math.PI*u)*.12*(1-u);
}
/**
 * Where a build stands t seconds after work started. Pure. stage: foundation | walls | roof | sparkle | done; k: 0..1
 * inside it. stakes / scaffold: how far the stakes and scaffold have risen (both clear away during the sparkles); rise:
 * how much of the walls stand; roof: whether the roof is placed; drop: roofDrop; sparkle: 0..1 through the last stage.
 */
export function buildStage(t){
  const {foundation:f,walls:w,roof:r,sparkle:s}=STAGE_SECONDS,ends=[f,f+w,f+w+r,f+w+r+s],names=['foundation','walls','roof','sparkle'];
  t=Math.max(0,t);const i=ends.findIndex(e=>t<e),stage=i<0?'done':names[i],start=i<=0?0:ends[i-1];
  const k=i<0?1:(t-start)/(ends[i]-start),sparkle=clamp01((t-ends[2])/s),clear=1-sparkle;
  return {stage,k,stakes:clamp01(t/(f*.4))*clear,scaffold:clamp01((t-f*.35)/(f*.65))*clear,rise:ease(clamp01((t-f)/w)),
    roof:t>=ends[1],drop:roofDrop((t-ends[1])/r),sparkle,done:i<0};
}
/** The town's Builder: the cat with id 'builder', else the first whose name or role says build. skip: ids not available. */
export function findBuilder(cats,skip=new Set()){
  const free=cats.filter(c=>!skip.has(c.id)&&c.id!=='mayor');
  return free.find(c=>c.id==='builder')||free.find(c=>/build/i.test(`${c.name||''} ${c.role||''}`))||null;
}
/**
 * Which cats are being built, in what order. The first ingest is history (no jobs). Each later recruit gets a job:
 * with a Builder already in town (and not itself new or still being built) the job queues on the Builder in arrival
 * order and waits as 'queued' until the Builder reaches it; otherwise it builds by magic at once, in parallel.
 * Job phases: queued -> building -> emerging -> (gone). t: build seconds; e: seconds since the house was finished.
 */
export class ConstructionPlan{
  seen=null;jobs=new Map();queue=[];
  constructor({builders=true}={}){this.builders=builders;}
  ingest(cats){
    const ids=new Set(cats.map(c=>c.id));
    if(!this.seen){this.seen=ids;return [];}
    for(const id of [...this.jobs.keys()])if(!ids.has(id))this.drop(id);
    const fresh=cats.filter(c=>!this.seen.has(c.id));for(const c of fresh)this.seen.add(c.id);
    if(!fresh.length)return [];
    const busy=new Set([...fresh.map(c=>c.id),...[...this.jobs].filter(([,j])=>j.phase!=='emerging').map(([id])=>id)]);
    const builder=this.builders?findBuilder(cats,busy):null;
    for(const c of fresh){this.jobs.set(c.id,{id:c.id,builder:builder?.id??null,phase:builder?'queued':'building',t:0,e:0});if(builder)this.queue.push(c.id);}
    return fresh.map(c=>c.id);
  }
  drop(id){this.jobs.delete(id);this.queue=this.queue.filter(q=>q!==id);}
  /** The Builder left town: its queue builds by magic, and a build in progress carries on without it. */
  orphan(builder){for(const j of this.jobs.values())if(j.builder===builder){j.builder=null;if(j.phase==='queued')j.phase='building';}this.queue=[];}
  /** Advances every job by dt (0 while paused). Returns the ids whose house was finished this step. */
  advance(dt,reduced=false){
    const built=[];
    for(const j of [...this.jobs.values()]){
      if(j.phase==='building'){j.t+=dt;if(j.t>=(reduced?FADE_SECONDS:BUILD_SECONDS)){j.phase='emerging';j.e=0;this.queue=this.queue.filter(q=>q!==j.id);built.push(j.id);}}
      else if(j.phase==='emerging'){j.e+=dt;if(j.e>=(reduced?0:EMERGE_SECONDS)+HELLO_SECONDS)this.jobs.delete(j.id);}
    }
    return built;
  }
  /** Still being built: the house is not merged into its hamlet yet and the recruit is not out. */
  building(id){const p=this.jobs.get(id)?.phase;return p==='queued'||p==='building';}
}

// Wall top as a fraction of each house's art height (makeHouse): the walls rise to it, the roof drops onto it.
// ponytail: per-style constants read off makeHouse; a new house style falls back to the default.
const ROOF_FROM={mayor:.4,scholar:.55,banker:.49,merchant:.57,archivist:.6,builder:.51,critic:.46,operator:.38};
const DROP=2.4,WORK_GAP=2,SPARKS=64,DUST=24,HALF_X=1.6,HALF_Z=1.45,SCAFFOLD=20;
const hash=(n,k)=>{const v=Math.sin(n*127.1+k*311.7)*43758.5453;return v-Math.floor(v);};

/**
 * The building sites, the Builder's trip and the recruit's hello. town.js calls ingest(state) before it merges the
 * hamlets, frame() once per frame before the resident loop, and asks building / hidden / busy / actor per cat.
 * world() -> {layout, ground, cats}; onBuilt() re-merges the hamlets once a house is finished.
 */
export function createConstruction({scene,renderer,reduced,residents,world,walkSpeed,onBuilt}){
  renderer.localClippingEnabled=true;
  const plan=new ConstructionPlan({builders:!reduced}),sites=new Map(),hellos=new Map();
  const trip={phase:'idle',path:null,d:0,stop:0,at:null,job:null};let builderId=null;
  const box=new T.BoxGeometry(1,1,1).translate(0,.5,0),wood=new T.MeshStandardMaterial({color:'#a77b52',roughness:.9});
  // Sparkles and dust are soft round dots (a small radial-gradient texture), not square points.
  const dot=document.createElement('canvas');dot.width=dot.height=32;{const g=dot.getContext('2d'),r=g.createRadialGradient(16,16,0,16,16,16);r.addColorStop(0,'#fff');r.addColorStop(.35,'rgba(255,255,255,.85)');r.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=r;g.fillRect(0,0,32,32);}
  const sparkMat=new T.PointsMaterial({size:5,map:new T.CanvasTexture(dot),vertexColors:true,transparent:true,depthWrite:false,sizeAttenuation:false});
  // Clipped (or, with reduced motion, fading) copies of the two baked house materials. Material.clone drops the glow
  // material's shader hook, so it is copied by hand; emissiveIntensity follows the town glow every frame.
  const variant=(source,plane)=>{const m=source.clone();m.onBeforeCompile=source.onBeforeCompile;m.customProgramCacheKey=source.customProgramCacheKey;
    m.clippingPlanes=plane?[plane]:[];m.clipShadows=true;if(reduced){m.transparent=true;m.opacity=0;}return m;};
  const hammer=makeHammer();
  // The shared baked solid material is not exported: read it off a one-box bake.
  const probe=bakedMeshes([{baked:{solid:tinted(new T.BoxGeometry(.01,.01,.01).toNonIndexed(),'#ffffff')},matrix:new T.Matrix4()}]).children[0],solidSource=probe.material;
  // Every variant sits hidden in the scene from the start, so warmShaders compiles it at load and not mid-frame on the
  // first build.
  {const warm=new T.Group(),plane=new T.Plane();probe.material=variant(solidSource,reduced?null:plane);
    warm.add(probe,new T.Mesh(probe.geometry,variant(glowBaked(),reduced?null:plane)),new T.InstancedMesh(box,wood,1),hammer.clone(),
      new T.Points(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute([0,0,0],3)).setAttribute('color',new T.Float32BufferAttribute([1,1,1],3)),sparkMat));
    warm.visible=false;scene.add(warm);}

  function makeSite(id){
    const r=residents.get(id);if(!r)return null;
    const group=new T.Group(),body=new T.Group(),roof=new T.Group(),bodyPlane=new T.Plane(new T.Vector3(0,-1,0),0),roofPlane=new T.Plane(new T.Vector3(0,1,0),0);
    for(const mesh of [...bakedMeshes([{baked:r.baked,matrix:new T.Matrix4()}]).children]){
      const source=mesh.material,glowing=source!==solidSource;
      mesh.material=variant(source,reduced?null:bodyPlane);mesh.userData.glowing=glowing;body.add(mesh);
      if(!reduced){const top=new T.Mesh(mesh.geometry,variant(source,roofPlane));top.castShadow=top.receiveShadow=true;top.userData.glowing=glowing;roof.add(top);}
    }
    roof.visible=false;group.add(body,roof);
    const scaffold=new T.InstancedMesh(box,wood,SCAFFOLD);scaffold.count=0;scaffold.castShadow=true;scaffold.frustumCulled=false;if(!reduced)group.add(scaffold);
    const sparks=new T.Points(new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(new Float32Array(SPARKS*3),3)).setAttribute('color',new T.BufferAttribute(new Float32Array(SPARKS*3),3)),sparkMat);
    sparks.frustumCulled=false;if(!reduced)scene.add(sparks);scene.add(group);
    return {group,body,roof,scaffold,sparks,bodyPlane,roofPlane,cued:new Set()};
  }
  function disposeSite(id){
    const s=sites.get(id);if(!s)return;sites.delete(id);
    const geos=new Set();s.group.traverse(o=>{if(o.isMesh&&!o.isInstancedMesh){geos.add(o.geometry);o.material.dispose();}});geos.forEach(g=>g.dispose());
    s.scaffold.dispose();s.sparks.geometry.dispose();s.group.removeFromParent();s.sparks.removeFromParent();
  }
  const catOf=id=>world().cats.find(c=>c.id===id);
  const groundAt=(x,z)=>world().ground.walk(x,z)+.14;
  // Walks from where the Builder stands now along the roads; ends short of the plot (site) or on its own stand point (home).
  function walk(phase,points,stop){
    const at=trip.at||residents.get(builderId)?.base;
    const path=makePath([...(at?[[at.x,at.z]]:[]),...points]);
    Object.assign(trip,{phase,path,d:0,stop:phase==='home'?path.length:Math.max(0,path.length-WORK_GAP)});trip.at=path.at(0);
  }
  function nextTrip(){
    const layout=world().layout,builder=catOf(builderId),from=trip.job&&catOf(trip.job)||builder,next=plan.queue.find(id=>plan.jobs.get(id)?.phase==='queued');
    if(next){const to=catOf(next);trip.job=next;walk('site',layout&&from?.home&&to?.home?layout.visitPath(from,to):[[to?.home?.x||0,to?.home?.z||0]]);return;}
    hammer.removeFromParent();
    if(trip.at&&builder&&from&&from!==builder&&layout){trip.job=null;walk('home',layout.visitPath(from,builder));}
    else Object.assign(trip,{phase:'idle',at:null,job:null});
  }
  function tripFrame(dt,inVisit){
    if(!builderId)return;
    const b=residents.get(builderId);
    if(!b){plan.orphan(builderId);hammer.removeFromParent();Object.assign(trip,{phase:'idle',at:null,job:null});builderId=null;return;}
    // Waits until the Builder is awake and not on a message visit, then sets off.
    if(trip.phase==='idle'){if(plan.queue.length&&!(b.rest.amount>0)&&!inVisit(builderId))nextTrip();return;}
    if(trip.phase==='site'||trip.phase==='home'){
      trip.d=Math.min(trip.stop,trip.d+walkSpeed*dt);trip.at=trip.path.at(trip.d);
      if(trip.d<trip.stop)return;
      if(trip.phase==='home'){Object.assign(trip,{phase:'idle',at:null});return;}
      const job=plan.jobs.get(trip.job);if(job?.phase==='queued'){job.phase='building';trip.phase='work';}else nextTrip();
      return;
    }
    // The Builder stays to see the recruit out of the door, then moves on.
    const job=plan.jobs.get(trip.job);
    if(trip.phase==='work'&&(!job||job.phase==='emerging'&&job.e>=(reduced?0:EMERGE_SECONDS)))nextTrip();
  }
  // Scaffold: four stakes and four boards outlining the foundation, four poles and eight planks at two levels.
  const m4=new T.Matrix4(),q=new T.Quaternion(),v=new T.Vector3(),sc=new T.Vector3();
  function layScaffold(s,st,wallTop,magic){
    let n=0;const put=(x,y,z,w,h,d)=>{s.scaffold.setMatrixAt(n++,m4.compose(v.set(x,y,z),q,sc.set(w,Math.max(h,1e-4),d)));};
    const a=st.stakes,p=magic?0:st.scaffold,px=HALF_X+.25,pz=HALF_Z+.25,levels=[wallTop*.45,wallTop*.9],reach=(wallTop+.4)*p;
    for(const [x,z] of [[-1,-1],[1,-1],[1,1],[-1,1]])put(x*HALF_X,0,z*HALF_Z,.12*a,.7*a,.12*a);
    for(const z of [-1,1])put(0,.02,z*HALF_Z,HALF_X*2*a,.08*a,.08*a);for(const x of [-1,1])put(x*HALF_X,.02,0,.08*a,.08*a,HALF_Z*2*a);
    for(const [x,z] of [[-1,-1],[1,-1],[1,1],[-1,1]])put(x*px,0,z*pz,.1*p,reach,.1*p);
    for(const y of levels){const on=p>0&&reach>=y?p:0;for(const z of [-1,1])put(0,y,z*pz,(px*2+.2)*on,.07*on,.32*on);for(const x of [-1,1])put(x*px,y,0,.32*on,.07*on,(pz*2+.2)*on);}
    s.scaffold.count=n;s.scaffold.instanceMatrix.needsUpdate=true;
  }
  const gold=new T.Color('#ffe08a'),teal=new T.Color('#b8fff2'),dust=new T.Color('#e3cfae'),c=new T.Color();
  function laySparks(s,st,{x,y,z,height,radius,time,worker,magic}){
    const pos=s.sparks.geometry.attributes.position,col=s.sparks.geometry.attributes.color;
    const spiral=magic?(st.done?0:1):st.sparkle>0?1:0,u=((time%STRIKE_SECONDS)+STRIKE_SECONDS)%STRIKE_SECONDS/STRIKE_SECONDS,puff=u>=.72?0:u/.72;
    for(let i=0;i<SPARKS;i++){
      const a=hash(i,1),b=hash(i,2),h=hash(i,3);let px=0,py=-1e3,pz=0;
      if(worker&&i<DUST&&!st.done&&st.stage!=='sparkle'&&puff<.6){
        // A dust puff off each hammer strike (the strike lands as the swing cycle wraps; see buildSwing).
        const ang=a*Math.PI*2,spread=.25+puff*.9;px=worker.x+Math.sin(ang)*spread;pz=worker.z+Math.cos(ang)*spread;py=worker.y+.1+puff*(.4+b*.5);c.copy(dust);
      }else if(spiral&&i>=(worker?DUST:0)){
        const k=(b+time*.35)%1,ang=a*Math.PI*2+time*2.4,r=radius*(1.15-.55*k);px=x+Math.cos(ang)*r;pz=z+Math.sin(ang)*r;py=y+k*height*1.15;c.copy(gold).lerp(teal,h);
      }
      pos.setXYZ(i,px,py,pz);col.setXYZ(i,c.r,c.g,c.b);
    }
    pos.needsUpdate=col.needsUpdate=true;
  }
  function siteFrame(id,job,{time,ppm}){
    const s=sites.get(id),r=residents.get(id);if(!s||!r)return;
    const g=r.group;s.group.position.copy(g.position);s.group.rotation.copy(g.rotation);s.group.scale.copy(g.scale);
    const scale=g.scale.x,base=g.position.y,wallTop=(ROOF_FROM[r.style]??.45)*r.height,glowLevel=glowBaked().emissiveIntensity;
    s.group.traverse(o=>{if(o.userData.glowing)o.material.emissiveIntensity=glowLevel;});
    if(reduced){const k=job.phase==='queued'?0:clamp01(job.t/FADE_SECONDS);s.body.traverse(o=>{if(o.isMesh)o.material.opacity=k;});s.group.updateMatrixWorld(true);return;}
    // A queued plot waits with its stakes in; the clock runs once work starts.
    const st=buildStage(job.phase==='queued'?STAGE_SECONDS.foundation*.4:job.t);
    if(job.phase==='building')cue(s,id,st,!job.builder);
    s.bodyPlane.constant=base+(st.roof?wallTop:wallTop*st.rise)*scale-(st.rise>0?0:.05);
    s.roof.visible=st.roof;s.roof.position.y=st.drop*DROP;s.roofPlane.constant=-(base+(wallTop+st.drop*DROP)*scale);
    layScaffold(s,st,wallTop,!job.builder);
    const b=job.builder&&trip.phase==='work'&&trip.job===id&&residents.get(job.builder);let worker=null;
    if(b){const yaw=faceYaw(trip.at,g.position);worker={x:trip.at.x+Math.sin(yaw)*.75,y:groundAt(trip.at.x,trip.at.z),z:trip.at.z+Math.cos(yaw)*.75};}
    laySparks(s,st,{x:g.position.x,y:base,z:g.position.z,height:r.height*scale,radius:HALF_X*1.5*scale,time:time+(b?b.seed*5:0),worker,magic:!job.builder});
    sparkMat.size=Math.max(5,Math.min(16,ppm*.24));
    s.group.updateMatrixWorld(true);s.sparks.updateMatrixWorld();
  }
  // The recruit's first steps: out of the door to its stand point with a little hop, then a hello bubble.
  function emerging(id,job){
    const r=residents.get(id);if(!r)return null;
    const k=reduced?1:clamp01(job.e/EMERGE_SECONDS),g=r.group.position,yaw=r.yaw||0,door=1.25*r.group.scale.x;
    const x=g.x+Math.sin(yaw)*door+(r.base.x-g.x-Math.sin(yaw)*door)*ease(k),z=g.z+Math.cos(yaw)*door+(r.base.z-g.z-Math.cos(yaw)*door)*ease(k);
    return {position:new T.Vector3(x,groundAt(x,z)+(reduced?0:Math.sin(Math.PI*k)*.45),z),yaw,mode:k<1?'walk':'idle'};
  }
  function helloFrame(camera,viewH){
    for(const [id,job] of plan.jobs){
      if(job.phase!=='emerging'){continue;}
      let sprite=hellos.get(id);if(!sprite){sfx('build-chirp',{set:id});sprite=speechBubble('Hello, neighbours');if(!sprite)continue;sprite.material.depthTest=false;sprite.renderOrder=3;scene.add(sprite);hellos.set(id,sprite);}
      const r=residents.get(id);if(!r)continue;
      const left=(reduced?0:EMERGE_SECONDS)+HELLO_SECONDS-job.e;sprite.material.opacity=Math.min(1,left/.5);
      sprite.position.copy(r.catModel.position);sprite.position.y+=2.9;fitBubble(sprite,camera,viewH);sprite.updateMatrixWorld();
    }
    for(const [id,sprite] of hellos)if(plan.jobs.get(id)?.phase!=='emerging'){disposeSprite(sprite);hellos.delete(id);}
  }
  // Sounds (audio.js SFX_EVENTS), once per moment of each site: the walls creak as they rise, the roof thumps down, magic
  // builds shimmer at each stage. The audio gate lets one site at a time be heard. The Builder's taps are in hammerFrame.
  function cue(s,id,st,magic){
    const once=(key,name,detail)=>{if(!s.cued.has(key)){s.cued.add(key);sfx(name,{set:id,...detail});}};
    if(magic&&st.stage!=='done')once('shimmer:'+st.stage,'build-shimmer');
    if(st.stage==='walls')once('creak','build-creak',{seconds:STAGE_SECONDS.walls*.8});
    if(st.stage==='roof'&&st.k>=.6||st.stage==='sparkle')once('roof','build-roof');
  }
  let strike=null;
  const swingAt=new T.Vector3();
  function hammerFrame(time){
    const b=trip.phase==='work'&&plan.jobs.get(trip.job)?.phase==='building'&&residents.get(builderId);
    if(!b){hammer.removeFromParent();strike=null;return;}
    // Re-attached whenever the Builder's body is rebuilt (kit loaded, look changed): pivot at its right shoulder.
    if(hammer.parent!==b.catModel){
      b.catModel.add(hammer);b.catModel.updateMatrixWorld(true);
      const arm=b.rig?.bones.armR?.node||b.catModel.userData.parts?.armR;
      if(arm)b.catModel.worldToLocal(arm.getWorldPosition(swingAt));else swingAt.set(.55,.85,.3);
      hammer.position.copy(swingAt);
    }
    hammer.rotation.x=-.55+buildSwing(time+b.seed*5);
    // A strike lands as the swing cycle wraps (see buildSwing): one wooden tap per cycle.
    const n=Math.floor((time+b.seed*5)/STRIKE_SECONDS);if(strike!==null&&n!==strike)sfx('build-tap',{set:trip.job});strike=n;
  }
  return {
    ingest(state){
      if(!state?.cats)return;
      for(const id of plan.ingest(state.cats)){const job=plan.jobs.get(id),site=makeSite(id);if(job.builder&&!builderId)builderId=job.builder;if(site)sites.set(id,site);}
      for(const id of [...sites.keys()])if(!plan.jobs.has(id))disposeSite(id);
    },
    /** dt is 0 while the town is paused: the build, the trip and the hello all hold. */
    frame({dt,time,camera,viewH,inVisit}){
      if(!plan.jobs.size&&trip.phase==='idle'){hammer.removeFromParent();return;}
      const ppm=viewH*camera.zoom/(camera.top-camera.bottom);
      tripFrame(dt,inVisit);
      const built=plan.advance(dt,reduced);
      for(const [id,job] of plan.jobs)if(plan.building(id))siteFrame(id,job,{time,ppm});
      if(built.length){for(const id of built)disposeSite(id);onBuilt();}
      for(const id of [...sites.keys()])if(!plan.jobs.has(id))disposeSite(id);
      hammerFrame(time);helloFrame(camera,viewH);
    },
    /** A new world: its sites, hellos and the Builder's trip go, and the next ingest is history again. */
    reset(){
      for(const id of [...sites.keys()])disposeSite(id);for(const sprite of hellos.values())disposeSprite(sprite);hellos.clear();
      plan.seen=null;plan.jobs.clear();plan.queue=[];hammer.removeFromParent();Object.assign(trip,{phase:'idle',path:null,d:0,stop:0,at:null,job:null});builderId=null;
    },
    plan,
    building:id=>plan.building(id),
    hidden:id=>plan.building(id),
    busy:id=>plan.jobs.has(id)||(id===builderId&&(trip.phase!=='idle'||plan.queue.length>0)),
    /** Position, facing and pose that override the resident loop for the Builder on its trip and the newcomer. */
    actor(id){
      const job=plan.jobs.get(id);if(job?.phase==='emerging')return emerging(id,job);
      if(id!==builderId||trip.phase==='idle'||!trip.at)return null;
      const position=new T.Vector3(trip.at.x,groundAt(trip.at.x,trip.at.z),trip.at.z);
      if(trip.phase!=='work')return {position,yaw:trip.at.yaw,mode:'walk'};
      const target=residents.get(trip.job)?.group.position,working=plan.jobs.get(trip.job)?.phase==='building';
      return {position,yaw:target?faceYaw(trip.at,target):trip.at.yaw,mode:working?'build':'idle'};
    },
  };
}
// A small mallet held at the grip: one merged, vertex-coloured mesh (one draw), handle pointing forward out of the paw.
function tinted(geo,colour){const c=new T.Color(colour),n=geo.attributes.position.count,a=new Float32Array(n*3);for(let i=0;i<n;i++)c.toArray(a,i*3);geo.setAttribute('color',new T.BufferAttribute(a,3));return geo;}
function makeHammer(){
  const paint=(geo,colour)=>tinted(geo.toNonIndexed(),colour);
  const handle=paint(new T.CylinderGeometry(.035,.04,.6,8).rotateX(Math.PI/2).translate(0,-.38,.22),'#8a6440');
  const head=paint(new T.BoxGeometry(.3,.15,.15).translate(0,-.38,.5),'#8e8b88');
  const geo=new T.BufferGeometry();
  for(const k of ['position','normal','color']){const list=[handle,head].map(g=>g.attributes[k]);const out=new Float32Array(list.reduce((n,a)=>n+a.array.length,0));let o=0;for(const a of list){out.set(a.array,o);o+=a.array.length;}geo.setAttribute(k,new T.BufferAttribute(out,3));}
  const mesh=new T.Mesh(geo,new T.MeshStandardMaterial({vertexColors:true,roughness:.7}));mesh.castShadow=false;
  const pivot=new T.Group();pivot.add(mesh);return pivot;
}

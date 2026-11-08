import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MessageVisits,distanceToSegment,idleCat,restStep,makePath,talkPath,talkRule,faceYaw,turnToward} from '../public/world-motion.js';
import {terrain,heldGround,townHolds} from '../public/terrain.js';
import {townLayout,resolveLayout,placeInGroup,frontVector} from '../public/hamlet-layout.js';
import {makeAnimatedCat,makeHouse,compact,applyExpression,expressionFor,prepareKit,buildKitCat} from '../public/world-art.js';
import {sampleMotion,animateCat,bindMayor,settle,footprintRadius} from '../public/cat-animation.js';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url)));
const settings=JSON.parse(readFileSync(new URL('../public/presentation.config.json',import.meta.url)));
const clips=JSON.parse(readFileSync(new URL('../public/assets/cat-motions.json',import.meta.url))).clips;
const {chromas,kit,houseDecor,...designs}=JSON.parse(readFileSync(new URL('../public/world-catalog.json',import.meta.url)));
// Three real plots in the main hamlet, placed by the same rules the server uses.
const groups=[{id:'main',name:'Town centre',lead:'mayor',site:{index:0,x:0,z:0},rootTask:null}],resolved=resolveLayout(config.world.layout),cats=[];
for(const id of ['mayor','scholar','banker']){const homes=cats.map(c=>({x:c.home.x,z:c.home.z,group:c.group,plot:c.home.plot}));const spot=placeInGroup(groups[0],homes,groups,resolved);cats.push({id,group:'main',home:{x:spot.x,z:spot.z,style:'builder',plot:spot.plot}});}
const layout=townLayout(cats,groups,config.world.layout);
const message=(id,from,to,task='task')=>({id,from,to,task,text:'A message'});
const opts={speed:settings.walkingSpeed,talkSeconds:settings.talkSeconds};

test('message bursts retain every cat-to-cat delivery exactly once, excluding saved history and owner messages',()=>{
  const visits=new MessageVisits(),history=[message('old','mayor','scholar')];visits.ingest(history,cats);
  const burst=[...history,message('a','owner','mayor'),message('b','mayor','scholar'),message('c','scholar','mayor'),message('d','mayor','banker')];
  visits.ingest(burst,cats);visits.ingest(burst,cats);assert.deepEqual(visits.queue.map(m=>m.id),['b','c','d']);
  const empty=new MessageVisits();empty.ingest([],cats);empty.ingest([message('new','mayor','scholar')],cats);assert.equal(empty.queue.length,1);
});

test('a courier follows lanes, meets the recipient, returns home, and freezes without jumping when paused',()=>{
  const visits=new MessageVisits();visits.ingest([],cats);visits.ingest([message('a','mayor','banker')],cats);
  let v=visits.start(cats,layout);const start={...v.position};
  visits.advance(.1,opts);assert.notDeepEqual(v.position,start);const frozen={...v.position};
  visits.advance(30,{...opts,paused:true});assert.deepEqual(v.position,frozen);
  const phases=new Set();let steps=0;
  while(visits.current&&steps++<2000){phases.add(visits.current.phase);visits.advance(.05,opts);}
  assert.equal(visits.current,null);assert.deepEqual([...phases],['walk','talk','return']);assert.equal(v.distance,0);
  const points=layout.visitPath(cats[0],cats[2]);
  for(const p of points.slice(1,-1))assert.ok(Math.hypot(p[0]-cats[1].home.x,p[1]-cats[1].home.z)>=resolved.house_radius+resolved.road_clearance-.05,'roads keep a neighbouring house clear');
});

test('cancelled tasks turn couriers home and remove queued work without replaying it',()=>{
  const visits=new MessageVisits();visits.ingest([],cats);visits.ingest([message('a','mayor','scholar'),message('b','scholar','mayor')],cats);
  const v=visits.start(cats,layout);visits.advance(.5,opts);const point={...v.position};
  visits.cancelTasks(new Set(['task']));assert.equal(v.phase,'return');assert.deepEqual(v.position,point);assert.equal(visits.queue.length,0);
});

test('downloaded Mixamo curves animate articulated specialists with finite, bounded geometry',()=>{
  for(const [style,palette] of Object.entries(designs)){
    const cat=makeAnimatedCat(style,palette),house=compact(makeHouse(style,palette));
    for(const model of [cat,house])assert.ok([...new T.Box3().setFromObject(model).min,...new T.Box3().setFromObject(model).max].every(Number.isFinite));
    const item={catModel:cat,seed:0};
    for(const mode of ['walk','talk','work']){
      const clip=clips[mode];assert.ok(clip.frames.length>1);assert.ok(clip.frames.flat().every(Number.isFinite));
      const first=sampleMotion(clip,.1);assert.notDeepEqual(first,sampleMotion(clip,clip.duration*.6));
      animateCat(item,mode,.1,1,clips,false);const q=cat.userData.parts.armL.quaternion.clone();
      animateCat(item,mode,clip.duration*.6,1,clips,false);assert.ok(q.angleTo(cat.userData.parts.armL.quaternion)>1e-4,`${style} ${mode} has motion`);
      const bounds=new T.Box3().setFromObject(cat).getSize(new T.Vector3());assert.ok(bounds.y<3&&bounds.x<4&&bounds.z<4,'compact cat stays bounded');
    }
  }
});

// The game draws mayor-lod.glb (decimated by scripts/blender/build_mayor_lod.py); both must rig and talk the same.
// Load actual skeleton/mesh data; omit textures only because Node has no image decoder.
async function loadMayor(file){
  const src=readFileSync(new URL('../public/assets/'+file,import.meta.url)),len=src.readUInt32LE(12),j=JSON.parse(src.subarray(20,20+len));
  delete j.images;delete j.textures;j.materials=[];for(const m of j.meshes)for(const p of m.primitives)delete p.material;
  const raw=Buffer.from(JSON.stringify(j)),json=Buffer.alloc(Math.ceil(raw.length/4)*4,32);raw.copy(json);
  const bin=src.subarray(20+len),buf=Buffer.alloc(20+json.length+bin.length);buf.writeUInt32LE(0x46546c67,0);buf.writeUInt32LE(2,4);buf.writeUInt32LE(buf.length,8);buf.writeUInt32LE(json.length,12);buf.writeUInt32LE(0x4e4f534a,16);json.copy(buf,20);bin.copy(buf,20+json.length);
  return new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength),'');
}
for(const file of ['mayor.glb','mayor-lod.glb'])test(`Mixamo adaptation deforms the shipped Mayor skeleton (${file}) and talking opens its facial morph`,async()=>{
  const asset=await loadMayor(file);
  const item={catModel:asset.scene,rig:bindMayor(asset.scene),seed:0};
  assert.ok(item.rig.bones.armL);const arm=item.rig.bones.armL;
  animateCat(item,'walk',.1,1,clips,false);assert.ok(arm.node.quaternion.angleTo(arm.rest)>1e-4);
  const meshes=[];asset.scene.traverse(o=>{if(o.isSkinnedMesh)meshes.push(o);});
  function sample(){asset.scene.updateMatrixWorld(true);const points=[];for(const m of meshes){m.skeleton.update();for(let i=0;i<m.geometry.attributes.position.count;i+=Math.max(1,Math.floor(m.geometry.attributes.position.count/20))){const v=m.getVertexPosition(i,new T.Vector3());assert.ok(v.toArray().every(Number.isFinite));points.push(...v.toArray());}}return points;}
  const walk=sample();animateCat(item,'talk',clips.talk.duration*.5,1,clips,false);const talk=sample();assert.ok(talk.some((v,i)=>Math.abs(v-walk[i])>1e-5));
  assert.ok(item.rig.faces.some(face=>face.morphTargetInfluences[face.morphTargetDictionary.MouthOpen]>0));
});

// ---------------------------------------------------------------- sleep
const fresh=()=>({idle:0,amount:0,state:'awake'}),asleep=()=>({idle:99,amount:1,state:'sleeping'});
const rest=(r,seconds,o,step=.05)=>{for(let t=step;t<=seconds+1e-9;t+=step)restStep(r,{dt:step,sleepAfter:settings.sleepAfterSeconds,...o});return r;};

test('an idle cat falls asleep after sleepAfterSeconds, pausing freezes it, and a task wakes it in about 0.6 s',()=>{
  assert.ok(settings.sleepAfterSeconds>=4&&settings.sleepAfterSeconds<=15,'presentation.config.json sets the grace period');
  const cat={busy:false,waiting:false},r=fresh(),idle=()=>idleCat(cat,'mayor',null,null);
  rest(r,settings.sleepAfterSeconds-.1,{idle:idle()});assert.deepEqual([r.state,r.amount],['awake',0],'awake through the grace period');
  rest(r,.6,{idle:idle()});assert.equal(r.state,'settling');assert.ok(r.amount>0&&r.amount<1,'lies down gradually');
  rest(r,1,{idle:idle()});assert.deepEqual([r.state,r.amount],['sleeping',1]);
  cat.busy=true;const frozen={...r};rest(r,30,{idle:idle(),paused:true});assert.deepEqual(r,frozen,'paused: frozen even when a task arrives');
  rest(r,.3,{idle:idle()});assert.equal(r.state,'waking');assert.ok(r.amount>.3&&r.amount<.7);
  rest(r,.3,{idle:idle()});assert.deepEqual([r.state,r.amount],['awake',0],'awake within 0.6 s');
  // Pending approvals and visits, as sender or receiver, current or next in line, keep a cat awake.
  assert.equal(idleCat({waiting:true},'mayor',null,null),false);
  assert.equal(idleCat({},'mayor',{message:message('a','scholar','mayor')},null),false);
  assert.equal(idleCat({},'mayor',null,message('a','mayor','banker')),false);
  assert.equal(idleCat({},'mayor',{message:message('a','scholar','banker')},null),true);
  const instant=rest(fresh(),settings.sleepAfterSeconds+.05,{idle:true,reduced:true});assert.equal(instant.amount,1,'reduced motion: no settle animation');
});

test('a courier whose recipient leaves walks home along its lane, then sleeps at its stand point after the delay',()=>{
  const visits=new MessageVisits();visits.ingest([],cats);visits.ingest([message('a','mayor','banker')],cats);
  const v=visits.start(cats,layout),lane=layout.visitPath(cats[0],cats[2]);for(let i=0;i<20;i++)visits.advance(.1,opts);
  const away={...v.position};assert.equal(v.phase,'walk');assert.ok(Math.hypot(away.x-lane[0][0],away.z-lane[0][1])>2,'mid-walk, away from home');
  visits.retainCats(cats.filter(c=>c.id!=='banker'));assert.equal(v.phase,'return','walks back instead of snapping home');assert.deepEqual(v.position,away);
  const r=fresh();let t=0,homeAt=null,last=away;
  for(let i=0;i<4000&&r.state!=='sleeping';i++){
    const visit=visits.advance(.05,opts);t+=.05;
    if(visit){last=visit.position;assert.ok(lane.slice(1).some((b,j)=>distanceToSegment(last.x,last.z,lane[j],b)<1e-6),'stays on its lane');}
    else homeAt??=t;
    restStep(r,{idle:idleCat({},'mayor',visit,visits.queue[0]),dt:.05,sleepAfter:settings.sleepAfterSeconds});
    if(visit)assert.equal(r.amount,0,'never sleeps on the road');
  }
  assert.equal(r.state,'sleeping');assert.ok(homeAt!==null&&t-homeAt>=settings.sleepAfterSeconds);
  assert.ok(Math.hypot(last.x-lane[0][0],last.z-lane[0][1])<.2,'last step of the walk ends at its own stand point');
});

test('a queued visit waits until its sleeping sender has woken, so the walk never starts from the lying pose',()=>{
  const visits=new MessageVisits();visits.ingest([],cats);visits.ingest([message('a','mayor','scholar')],cats);
  const rests={mayor:asleep(),scholar:fresh()},ready=m=>[m.from,m.to].every(id=>!(rests[id].amount>0));
  let t=0;
  while(!visits.start(cats,layout,ready)&&t<5){const next=visits.queue[0];for(const id of Object.keys(rests))restStep(rests[id],{idle:idleCat({},id,null,next),dt:.05,sleepAfter:settings.sleepAfterSeconds});t+=.05;}
  assert.ok(visits.current&&t>=.55&&t<=.7,`started after ${t.toFixed(2)} s of waking`);assert.equal(rests.mayor.state,'awake');
});

function finiteSkin(root){
  root.updateMatrixWorld(true);let n=0;
  root.traverse(m=>{if(!m.isSkinnedMesh)return;m.skeleton.update();const c=m.geometry.attributes.position.count;for(let i=0;i<c;i+=Math.max(1,Math.floor(c/30))){assert.ok(m.getVertexPosition(i,new T.Vector3()).toArray().every(Number.isFinite));n++;}});
  assert.ok(n>0,'sampled skinned vertices');
}
function sleepRig(item,label){
  const moved=['chest','head','armL','tail1'].filter(name=>item.rig.bones[name]);assert.ok(moved.length>=3,label+' has the sleep bones');
  item.rest=asleep();animateCat(item,'sleep',1,1/60,clips,false);applyExpression(item.rig.faces,expressionFor({mode:'sleep',night:true}),1);
  for(const name of moved){const b=item.rig.bones[name];assert.ok(b.node.quaternion.angleTo(b.rest)>.05,`${label} ${name} leaves its rest pose`);}
  const blinks=item.rig.faces.filter(f=>f.morphTargetDictionary.Blink_L!==undefined);assert.ok(blinks.length,label+' has blink morphs');
  for(const f of blinks){const d=f.morphTargetDictionary,v=f.morphTargetInfluences;assert.ok(v[d.Blink_L]>.99&&v[d.Blink_R]>.99,label+' eyes closed');for(const k of ['Happy','Curious','Sleepy'])if(d[k]!==undefined)assert.ok(v[d[k]]<1e-6,`${label} ${k} eased out`);}
  assert.equal(item.motion,'Sleeping');finiteSkin(item.catModel);
  const chest=item.rig.bones.chest.node.quaternion.clone();animateCat(item,'sleep',2,1/60,clips,false);assert.ok(chest.angleTo(item.rig.bones.chest.node.quaternion)>1e-4,label+' breathes');
  animateCat(item,'sleep',1,1/60,clips,true);const still=item.rig.bones.chest.node.quaternion.clone();animateCat(item,'sleep',2,1/60,clips,true);
  assert.ok(still.angleTo(item.rig.bones.chest.node.quaternion)<1e-6,label+' reduced motion: static pose');
  item.rest={idle:0,amount:.5,state:'waking'};animateCat(item,'sleep',1,1/60,clips,false);
  assert.ok(item.rig.faces.some(f=>f.morphTargetInfluences[f.morphTargetDictionary.MouthOpen]>.5),label+' yawns while waking');assert.equal(item.motion,'Waking up');finiteSkin(item.catModel);
}

for(const file of ['mayor.glb','mayor-lod.glb'])test(`the Mayor skinned rig (${file}) curls up asleep with blink-closed eyes and yawns awake`,async()=>{
  const asset=await loadMayor(file);sleepRig({catModel:asset.scene,rig:bindMayor(asset.scene),seed:0},file);
});

test('kit cats curl up asleep with closed eyes; the procedural fallback lies down with squashed eyes',async()=>{
  const bytes=readFileSync(new URL('../public/assets/cat-kit.glb',import.meta.url));
  const gltf=prepareKit(await new Promise((ok,fail)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',ok,fail)));
  const cat=buildKitCat(gltf,{...Object.values(kit.roles)[0],expression:'neutral',eyes:'#231d18'},kit);
  sleepRig({catModel:cat.root,rig:bindMayor(cat.root),seed:0},'kit');
  for(const [style,palette] of Object.entries(designs)){
    const model=makeAnimatedCat(style,palette),item={catModel:model,seed:0,rest:asleep()},parts=model.userData.parts;
    animateCat(item,'sleep',1,1,clips,false);assert.ok(parts.eyes.every(e=>e.scale.y<.01),style+' eyes shut');assert.ok(parts.armL.rotation.x<-.5,style+' paws tucked');
    model.position.set(0,0,0);settle(item);assert.ok(model.position.y<-.2&&model.rotation.z>.1,style+' lies down');
    const size=new T.Box3().setFromObject(model);assert.ok([...size.min,...size.max].every(Number.isFinite));
    const breath=parts.body.scale.y;animateCat(item,'sleep',1.9,1,clips,false);assert.notEqual(parts.body.scale.y,breath,style+' breathes');
    animateCat(item,'sleep',1,1,clips,true);const a=parts.body.scale.y;animateCat(item,'sleep',1.9,1,clips,true);assert.equal(parts.body.scale.y,a,style+' reduced motion: no breathing');
    item.rest=fresh();model.position.set(0,0,0);settle(item);assert.equal(model.position.y,0);assert.equal(model.rotation.z,0);
  }
});

// ---------------------------------------------------------------- talking stance
// Bodies as town.js shows them: kit cats at KIT_SCALE (installKit), the Mayor GLB normalised to 1.75 m tall (installMayor).
const KIT_SCALE=1.75/1.915,flat=v=>new T.Vector2(v.x,v.z);
async function talkBodies(){
  const bytes=readFileSync(new URL('../public/assets/cat-kit.glb',import.meta.url));
  const gltf=prepareKit(await new Promise((ok,fail)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',ok,fail)));
  const bodies={};
  for(const base of kit.bases){
    const role=Object.values(kit.roles).find(r=>r.base===base)||{...Object.values(kit.roles)[0],base};
    const cat=buildKitCat(gltf,{...role,expression:'neutral',eyes:'#231d18'},kit),actor=new T.Group();cat.root.scale.setScalar(KIT_SCALE);actor.add(cat.root);actor.updateMatrixWorld(true);
    let face;cat.root.traverse(o=>{if(o.isMesh&&o.name.startsWith('face'))face=o;});
    // Forward from the geometry: actor origin to the centre of the face mesh.
    bodies[base]={actor,rig:bindMayor(cat.root),front:()=>{actor.updateMatrixWorld(true);return flat(new T.Box3().setFromObject(face).getCenter(new T.Vector3()).sub(actor.position)).normalize();}};
  }
  for(const file of ['mayor.glb','mayor-lod.glb']){
    const asset=(await loadMayor(file)).scene,box=new T.Box3().setFromObject(asset),size=box.getSize(new T.Vector3()),c=box.getCenter(new T.Vector3()),s=1.75/size.y;
    asset.scale.setScalar(s);asset.position.set(-c.x*s,-box.min.y*s,-c.z*s);const actor=new T.Group();actor.add(asset);actor.updateMatrixWorld(true);
    const bone=name=>{let b;asset.traverse(o=>{if(o.isBone&&o.name===name)b=o;});return b;},medal=bone('medal'),chest=bone('chest');
    // Forward from the geometry: chest bone to the medal pinned on the front of the coat.
    bodies[file.replace('.glb','')]={actor,rig:bindMayor(asset),front:()=>{actor.updateMatrixWorld(true);return flat(medal.getWorldPosition(new T.Vector3()).sub(chest.getWorldPosition(new T.Vector3()))).normalize();}};
  }
  // radius: what town.js measures (rest pose). talkRadius: widest of 16 samples over the talk clip, where the gap is seen.
  // talkGap (0.46) carries the Mayor's arm swing (kit cats do not grow), so circles stay 0.4 m apart while talking.
  for(const b of Object.values(bodies)){b.radius=footprintRadius(b.actor,b.rig);const item={catModel:b.actor,rig:b.rig,seed:0};b.talkRadius=0;for(let k=0;k<16;k++){animateCat(item,'talk',clips.talk.duration*k/16,1,clips,false);b.talkRadius=Math.max(b.talkRadius,footprintRadius(b.actor));}for(const bone of Object.values(b.rig.bones))bone.node.quaternion.copy(bone.rest);}
  return bodies;
}
const bodiesReady=talkBodies();
// A dense hamlet: the Mayor in the hall (plot 0, reached by the unpaved walking link) and eleven kit cats round it.
const townCats=[];for(let i=0;i<10;i++){const homes=townCats.map(c=>({x:c.home.x,z:c.home.z,group:c.group,plot:c.home.plot}));const spot=placeInGroup(groups[0],homes,groups,resolved);townCats.push({id:i?'cat'+i:'mayor',group:'main',body:i?kit.bases[i%kit.bases.length]:'mayor-lod',home:{x:spot.x,z:spot.z,style:'builder',plot:spot.plot}});}
const town=townLayout(townCats,groups,config.world.layout),land=terrain(resolved.terrain);
const height=heldGround(land,townHolds(land,town.sites,townCats.map(c=>({...c.home,group:c.group})),{x:resolved.memorial[0],z:resolved.memorial[1],r:resolved.memorial_reserve},resolved));
const standOf=c=>{const p=town.visitPath(townCats.find(o=>o!==c),c).at(-1);return {x:p[0],z:p[1]};};
const distanceToSegmentPath=(q,points)=>Math.min(...points.slice(1).map((b,i)=>distanceToSegment(q.x,q.z,points[i],b)));
// Widest house art without its garden, unscaled (a step must not pass through the building).
const houseArt=Math.max(...Object.entries(designs).map(([style,p])=>{const g=compact(makeHouse(style,p));g.updateMatrixWorld(true);let r=0;const v=new T.Vector3();g.traverse(o=>{if(!o.isMesh)return;const a=o.geometry.attributes.position;for(let i=0;i<a.count;i++){v.fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld);r=Math.max(r,Math.hypot(v.x,v.z));}});return r;}));
const ruleFor=(a,b,bodies)=>talkRule({ra:bodies[a.body].radius,rb:bodies[b.body].radius,talkGap:settings.talkGap,houseRadius:resolved.house_radius,height,water:land.water,yards:town.yards,
  homes:townCats.map(c=>c.home),others:townCats.filter(c=>c!==a&&c!==b).map(c=>({...standOf(c),r:bodies[c.body].radius}))});

test('a courier stops short of the recipient: bounding circles keep talkGap apart, on its path, outside every house and above water',async()=>{
  const bodies=await bodiesReady;assert.equal(townCats[0].home.plot,0,'the Mayor lives in the hall');
  for(const [name,b] of Object.entries(bodies)){assert.ok(b.radius>.5&&b.radius<1.6,`${name} radius ${b.radius.toFixed(3)} m is a cat, not a house`);assert.ok(b.talkRadius-b.radius<.06,`${name} talking reaches ${(b.talkRadius-b.radius).toFixed(3)} m past its rest radius`);}
  let minGap=Infinity,maxGap=0,minTalk=Infinity,pairs=0,detours=0;
  for(const hall of ['mayor-lod','mayor'])for(const a of townCats)for(const b of townCats){townCats[0].body=hall;
    if(a===b)continue;const rule=ruleFor(a,b,bodies),points=town.visitPath(a,b),{path,stop}=talkPath(points,rule.gap,rule.ok,rule.yard),p=path.at(stop),end={x:points.at(-1)[0],z:points.at(-1)[1]};
    const label=`${a.body} ${a.id} -> ${b.body} ${b.id}`;assert.ok(stop>0,label+' leaves home');
    const centre=Math.hypot(p.x-end.x,p.z-end.z),gap=centre-bodies[a.body].radius-bodies[b.body].radius;minGap=Math.min(minGap,gap);maxGap=Math.max(maxGap,gap);pairs++;
    minTalk=Math.min(minTalk,centre-bodies[a.body].talkRadius-bodies[b.body].talkRadius);assert.ok(minTalk>=.4-1e-9,`${label}: ${minTalk.toFixed(3)} m apart while talking`);
    assert.ok(gap>=settings.talkGap-1e-9,`${label}: ${gap.toFixed(3)} m between bounding circles`);
    assert.ok(gap<=settings.talkGap+.7,`${label}: stands ${gap.toFixed(2)} m off, too far to talk`);
    for(const c of townCats)assert.ok(Math.hypot(p.x-c.home.x,p.z-c.home.z)>=resolved.house_radius,`${label}: inside ${c.id}'s house radius`);
    assert.ok(height(p.x,p.z)>land.water,label+' stands on water');
    // Walkable: on the visit path up to the last metres; any step off it stays out of the recipient's house art and
    // never closer to the recipient than the talking gap.
    if(Math.abs(path.length-makePath(points).length)>1e-9){detours++;assert.ok(town.yards.some(y=>Math.hypot(p.x-y.x,p.z-y.z)<=y.r),label+' steps off the path outside a paved yard');}
    for(let d=0;d<=stop;d+=.05){const q=path.at(d);if(distanceToSegmentPath(q,points)<1e-6)continue;
      assert.ok(Math.hypot(q.x-b.home.x,q.z-b.home.z)>=houseArt*resolved.scale,label+' steps through the house');assert.ok(Math.hypot(q.x-end.x,q.z-end.z)>=rule.gap-1e-6,label+' brushes the recipient on the way in');}
    for(const c of townCats)if(c!==a&&c!==b){const s=standOf(c);assert.ok(Math.hypot(p.x-s.x,p.z-s.z)>=bodies[a.body].radius+bodies[c.body].radius,`${label}: inside ${c.id}`);}
  }
  townCats[0].body='mayor-lod';
  console.log(`rest-pose gap between bounding circles: min ${minGap.toFixed(3)} m, max ${maxGap.toFixed(3)} m (talk pose min ${minTalk.toFixed(3)} m) over ${pairs} ordered pairs (${detours} step off the path); radii rest/talk ${Object.entries(bodies).map(([k,b])=>k+' '+b.radius.toFixed(3)+'/'+b.talkRadius.toFixed(3)).join(', ')}`);
  // MessageVisits walks exactly to that stop, talks there, and walks home from it. A step off the path across the hall's yard
  // (talkPath) ends the path at the stop, so the stop may equal its length.
  const visits=new MessageVisits();visits.ingest([],townCats);visits.ingest([message('m','cat1','mayor')],townCats);
  const [a,b]=[townCats[1],townCats[0]],v=visits.start(townCats,town,()=>true,()=>ruleFor(a,b,bodies));let far=0;
  while(visits.current&&v.phase==='walk'){visits.advance(.05,opts);far=Math.max(far,v.distance);}
  assert.equal(v.phase,'talk');assert.ok(Math.abs(far-v.stop)<1e-9&&v.stop<=v.path.length);assert.deepEqual(v.position,v.path.at(v.stop));
});

test('talking cats turn over about 0.3 s to face each other within 10 degrees, then turn back to home yaw and the return path',async()=>{
  const bodies=await bodiesReady,step=1/60,worst={talk:0};
  const turn=(body,from,to,seconds)=>{let yaw=from,biggest=0;const delta=Math.abs(Math.atan2(Math.sin(to-from),Math.cos(to-from)));
    for(let t=step;t<=seconds+1e-9;t+=step){const next=turnToward(yaw,to,step);biggest=Math.max(biggest,Math.abs(Math.atan2(Math.sin(next-yaw),Math.cos(next-yaw))));yaw=next;
      if(Math.abs(t-.3)<step/2)assert.ok(Math.abs(Math.atan2(Math.sin(to-yaw),Math.cos(to-yaw)))<=.06*delta+1e-9,'about 95% turned at 0.3 s');}
    assert.ok(biggest<=.16*delta+1e-9,`no snap: largest 60 fps step ${biggest.toFixed(3)} of ${delta.toFixed(3)} rad`);body.actor.rotation.y=yaw;return yaw;};
  const angle=(body,toward)=>{const f=body.front(),d=toward.clone().normalize();return Math.acos(Math.max(-1,Math.min(1,f.dot(d))))*180/Math.PI;};
  for(const hall of ['mayor','mayor-lod'])for(const [a,b] of [[townCats[1],townCats[0]],[townCats[0],townCats[2]],[townCats[3],townCats[5]],[townCats[2],townCats[4]],[townCats[4],townCats[0]]]){townCats[0].body=hall;
    const rule=ruleFor(a,b,bodies),{path,stop}=talkPath(town.visitPath(a,b),rule.gap,rule.ok,rule.yard),spot=path.at(stop),stand=standOf(b);
    const A=bodies[a.body],B=bodies[b.body],home=town.yaw.get(b.id);
    A.actor.position.set(spot.x,0,spot.z);B.actor.position.set(stand.x,0,stand.z);
    turn(A,spot.yaw,faceYaw(spot,stand),.6);turn(B,home,faceYaw(stand,spot),.6);
    const ga=angle(A,new T.Vector2(stand.x-spot.x,stand.z-spot.z)),gb=angle(B,new T.Vector2(spot.x-stand.x,spot.z-stand.z));
    worst.talk=Math.max(worst.talk,ga,gb);assert.ok(ga<10&&gb<10,`${a.body} faces ${b.body} off by ${ga.toFixed(1)} deg, ${b.body} back by ${gb.toFixed(1)} deg`);
    // Afterwards: the recipient settles exactly on its home yaw (front toward its door), the sender onto its way home.
    const back=turn(B,B.actor.rotation.y,home,1);assert.equal(back,home);const [fx,fz]=frontVector(home);assert.ok(angle(B,new T.Vector2(fx,fz))<1,'recipient faces its door again');
    const way=path.at(stop).yaw+Math.PI;assert.equal(turn(A,A.actor.rotation.y,way,1),way);
  }
  assert.equal(turnToward(1,2,30,true),2,'reduced motion turns at once');assert.equal(turnToward(1,2,0),1,'paused holds');
  // The procedural fallback faces local +z too: its eyes sit in front of its origin.
  for(const [style,palette] of Object.entries(designs)){const m=makeAnimatedCat(style,palette);m.updateMatrixWorld(true);const z=m.userData.parts.eyes.reduce((s,e)=>s+e.getWorldPosition(new T.Vector3()).z,0)/m.userData.parts.eyes.length;assert.ok(z>.1,`${style} eyes face +z (${z.toFixed(2)})`);}
  console.log(`talk facing: worst ${worst.talk.toFixed(2)} deg off the other cat`);
});

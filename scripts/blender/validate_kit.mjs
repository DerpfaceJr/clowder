// Loads cat-kit.glb with Three's real GLTFLoader and drives it with the game's own animation code.
// Usage: node scripts/blender/validate_kit.mjs [path/to/cat-kit.glb]
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {bindMayor,animateCat} from '../../public/cat-animation.js';
import {cloneBase} from '../../public/world-art.js';
const file=process.argv[2]||new URL('../../public/assets/cat-kit.glb',import.meta.url);
const bytes=readFileSync(file),buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const gltf=await new Promise((ok,fail)=>new GLTFLoader().parse(buffer,'',ok,fail));
const {kit}=JSON.parse(readFileSync(new URL('../../public/world-catalog.json',import.meta.url)));
const clips=JSON.parse(readFileSync(new URL('../../public/assets/cat-motions.json',import.meta.url))).clips;
const fail=m=>{console.error('FAIL',m);process.exitCode=1;};
const tris=g=>(g.index?g.index.count:g.attributes.position.count)/3;
console.log('bytes',bytes.length);
gltf.scene.traverse(o=>{if(o.isMesh)console.log('mesh',o.name,o.isSkinnedMesh?'skinned':'static',tris(o.geometry),'tris',Object.keys(o.geometry.attributes).join(','),o.morphTargetDictionary?'morphs='+Object.keys(o.morphTargetDictionary).join(','):'','mat='+[o.material].flat().map(m=>m.name).join(','));});
const bases=['bean','puff','sprout'],pivots={};
for(const base of bases){
  const cat=cloneBase(gltf,base);   // the game's own clone + bone/socket name normalisation
  const actor=new T.Group();actor.add(cat);
  const rig=bindMayor(cat);
  console.log('  '+base+' bones',Object.keys(rig.bones).join(','));
  const wp=k=>rig.bones[k].node.getWorldPosition(new T.Vector3()).y;pivots[base]={head:wp('head'),arm:wp('armL')};
  for(const k of ['chest','head','armL','armR','footL','footR'])if(!rig.bones[k])fail(base+' missing bone '+k);
  if(!rig.faces.length)fail(base+' no morph meshes');
  const item={seed:.3,catModel:actor,rig};
  const before=Object.fromEntries(Object.entries(rig.bones).map(([k,b])=>[k,b.node.quaternion.clone()]));
  animateCat(item,'walk',.4,1,clips,false);
  const moved=k=>rig.bones[k]?1-Math.abs(before[k].dot(rig.bones[k].node.quaternion)):0;
  for(const k of ['armL','armR','footL','footR'])if(!(moved(k)>1e-6))fail(base+' walk did not move '+k);
  // The skin must follow the cloned bones: an arm vertex has to move once the walk pose is applied.
  const body=cat.getObjectByName('base_'+base),w=body.geometry.attributes.skinWeight,j=body.geometry.attributes.skinIndex;
  const armIndex=body.skeleton.bones.indexOf(rig.bones.armL.node);let vi=-1;
  for(let i=0;i<w.count&&vi<0;i++)if(j.getX(i)===armIndex&&w.getX(i)>0.99)vi=i;
  const restPos=new T.Vector3(),posed=new T.Vector3();
  for(const k of Object.values(rig.bones))k.node.quaternion.copy(k.rest);cat.updateMatrixWorld(true);body.getVertexPosition(vi,restPos);
  animateCat(item,'talk',1.13,1,clips,false);cat.updateMatrixWorld(true);body.getVertexPosition(vi,posed);
  if(vi<0||!(restPos.distanceTo(posed)>0.01))fail(base+' arm skin did not follow armL (moved '+restPos.distanceTo(posed).toFixed(4)+')');
  else console.log('  '+base+' arm vertex',vi,'moved',restPos.distanceTo(posed).toFixed(3),'with talk pose');
  const mouth=rig.faces.map(f=>f.morphTargetInfluences[f.morphTargetDictionary.MouthOpen]).filter(v=>v!==undefined);
  if(!mouth.length||!(Math.max(...mouth)>0))fail(base+' MouthOpen not driven');
  const sockets=['socket_head','socket_face','socket_neck','socket_back','socket_hip'].map(n=>cat.getObjectByName(n));
  if(sockets.some(s=>!s))fail(base+' missing socket');
  cat.updateMatrixWorld(true);
  for(const s of sockets.filter(Boolean)){for(const k of Object.values(rig.bones))k.node.quaternion.copy(k.rest);}
  cat.updateMatrixWorld(true);
  const q=new T.Quaternion();for(const s of sockets.filter(Boolean)){s.getWorldQuaternion(q);if(1-Math.abs(q.w)>1e-4)fail(base+' '+s.name+' not axis-aligned at rest');}
  for(const k of Object.values(rig.bones))k.node.quaternion.copy(k.rest);cat.updateMatrixWorld(true);
  const bb=new T.Box3().setFromObject(cat.getObjectByName('base_'+base)),fb=new T.Box3().setFromObject(cat.getObjectByName('face__'+base));
  if(Math.abs(bb.min.y)>0.02)fail(base+' feet not on y=0 (min y '+bb.min.y.toFixed(3)+')');
  if(!(fb.getCenter(new T.Vector3()).z>0.3))fail(base+' face not toward +Z');
  console.log('  '+base+' height',bb.max.y.toFixed(2),'width',(bb.max.x-bb.min.x).toFixed(2),'face z',fb.getCenter(new T.Vector3()).z.toFixed(2));
  // Attach every part exactly as docs/cat-kit/README.md says and check it lands on this base.
  const SOCKET=Object.fromEntries(Object.entries(kit.parts).map(([n,p])=>[n,'socket_'+p.socket]));
  const pos=cat.getObjectByName('base_'+base).geometry.attributes.position;let crown=0;
  for(let i=0;i<pos.count;i++)if(Math.abs(pos.getX(i))<0.08&&Math.abs(pos.getZ(i))<0.08)crown=Math.max(crown,pos.getY(i));
  for(const [n,sock] of Object.entries(SOCKET)){
    const part=gltf.scene.getObjectByName(`part_${n}__${base}`)?.clone();if(!part){fail(base+' missing part '+n);continue;}
    cat.getObjectByName(sock).add(part);cat.updateMatrixWorld(true);const box=new T.Box3().setFromObject(part),c=box.getCenter(new T.Vector3());
    const ok=sock==='socket_head'?box.min.y>crown-0.2&&box.min.y<crown&&box.max.y>crown+0.05:sock==='socket_face'?c.z>0.45&&Math.abs(c.y-(crown-0.58))<0.15:c.y>0.15&&c.y<crown-0.4;
    if(!ok)fail(`${base} ${n} misplaced: centre ${c.toArray().map(v=>v.toFixed(2))} min.y ${box.min.y.toFixed(2)} crown ${crown.toFixed(2)}`);
    part.removeFromParent();
  }
  console.log('  '+base+' crown',crown.toFixed(2),'- all',Object.keys(SOCKET).length,'parts attach via socket.add() in place');
  console.log('base',base,'ok: bones',Object.keys(rig.bones).length,'faces',rig.faces.length,'walk+talk driven, MouthOpen',Math.max(...mouth).toFixed(2));
}
if(!(pivots.sprout.head>pivots.bean.head+0.2&&pivots.sprout.arm>pivots.bean.arm))fail('Sprout pivots are not raised above Bean');
else console.log('pivots (y): head bean',pivots.bean.head.toFixed(2),'sprout',pivots.sprout.head.toFixed(2),'| armL bean',pivots.bean.arm.toFixed(2),'sprout',pivots.sprout.arm.toFixed(2));
const parts=[];gltf.scene.traverse(o=>{if(/^part_/.test(o.name)&&o.parent===gltf.scene)parts.push(o.name);});
console.log('parts',parts.join(','));
if(!process.exitCode)console.log('VALID');

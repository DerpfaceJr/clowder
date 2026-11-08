import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {buildKitCat,setKitColours,prepareKit,applyExpression,expressionFor,kitKey,cloneBase} from '../public/world-art.js';
import {bindMayor,animateCat} from '../public/cat-animation.js';

const {kit}=JSON.parse(readFileSync(new URL('../public/world-catalog.json',import.meta.url)));
const bytes=readFileSync(new URL('../public/assets/cat-kit.glb',import.meta.url));
const gltf=prepareKit(await new Promise((ok,fail)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',ok,fail)));
const clips=JSON.parse(readFileSync(new URL('../public/assets/cat-motions.json',import.meta.url))).clips;
const look=(role,extra={})=>({...kit.roles[role],expression:'neutral',eyes:'#231d18',...extra});
const meshes=root=>{const out=[];root.traverse(o=>{if(o.isMesh)out.push(o);});return out;};

test('every base clones with plain bone and socket names the game animation binds to',()=>{
  for(const base of kit.bases){
    const rig=cloneBase(gltf,base),bound=bindMayor(rig),names=[];rig.traverse(o=>{if(o.name.startsWith('socket_'))names.push(o.name);});
    for(const bone of ['chest','head','armL','armR','footL','footR'])assert.ok(bound.bones[bone],`${base} ${bone}`);
    assert.deepEqual(names.sort(),kit.sockets.map(s=>'socket_'+s).sort());
    assert.ok(bound.faces.some(f=>f.morphTargetDictionary.Happy!==undefined));
    const skeletons=new Set();rig.traverse(o=>{if(o.isSkinnedMesh)skeletons.add(o.skeleton);});assert.equal(skeletons.size,1,'body and face share one skeleton');
  }
});

test('role looks put each part on its socket and share geometry but not materials between cats',()=>{
  const a=buildKitCat(gltf,look('merchant'),kit),b=buildKitCat(gltf,look('merchant',{fur:'#000000'}),kit);
  const parts={};a.root.traverse(o=>{if(o.userData.kitPart)parts[o.userData.kitPart]=o.parent.name;});
  assert.deepEqual(parts,{apron:'socket_hip',satchel:'socket_back'});
  const bodyA=meshes(a.root).find(m=>m.material.name==='fur'),bodyB=meshes(b.root).find(m=>m.material.name==='fur');
  assert.equal(bodyA.geometry,bodyB.geometry,'geometry is shared');assert.notEqual(bodyA.material,bodyB.material,'each cat owns its fur material');
  assert.equal(bodyA.material.customProgramCacheKey(),bodyB.material.customProgramCacheKey(),'one shader program for every cat');
  assert.notEqual(bodyA.material.userData.kit.kitFur.value.getHexString(),bodyB.material.userData.kit.kitFur.value.getHexString());
  assert.ok(bodyA.geometry.attributes.kitMask&&bodyA.geometry.attributes.kitSpot,'mask attributes are exposed to the shader');
  assert.equal(a.key,kitKey(look('merchant')));
});

test('a catalog part the loaded kit lacks (old cached GLB) is skipped, the rest still attach',()=>{
  const catalog={...kit,parts:{...kit.parts,jetpack:{socket:'back',label:'Jetpack'}}};
  const cat=buildKitCat(gltf,look('builder',{parts:['jetpack','apron']}),catalog),parts=[];
  cat.root.traverse(o=>{if(o.userData.kitPart)parts.push(o.userData.kitPart);});
  assert.deepEqual(parts,['apron']);
});

test('every catalog part has a node on every base',()=>{
  for(const part of Object.keys(kit.parts))for(const base of kit.bases)assert.ok(gltf.scene.getObjectByName(`part_${part}__${base}`),`${part} on ${base}`);
});

test('recolouring changes uniforms and part cloth only; marking switches the mask channels',()=>{
  const cat=buildKitCat(gltf,look('builder'),kit),fur=cat.materials.find(m=>m.userData.kit);
  setKitColours(cat,look('builder',{marking:'tabby',fur:'#123456',outfit:'#abcdef'}));
  assert.equal(fur.userData.kit.kitFur.value.getHexString(),new T.Color('#123456').getHexString());
  assert.deepEqual(fur.userData.kit.kitUse.value.toArray(),[0,1,0,0]);
  const part=cat.materials.find(m=>m.userData.part);assert.equal(part.userData.part.cloth.value.getHexString(),new T.Color('#abcdef').getHexString());
  setKitColours(cat,look('builder',{marking:'calico'}));assert.deepEqual(fur.userData.kit.kitUse.value.toArray(),[0,0,1,1]);
});

test('a kit cat draws as fur + one face + one mesh per part (merged primitives keep morphs and skin)',()=>{
  const cat=buildKitCat(gltf,look('merchant'),kit),list=meshes(cat.root);
  assert.equal(list.filter(m=>m.material.name==='fur').length,1);
  const faces=list.filter(m=>m.material.name==='face');assert.equal(faces.length,1);assert.ok(faces[0].isSkinnedMesh&&faces[0].morphTargetDictionary.Blink_L!==undefined);
  assert.ok(faces[0].geometry.morphAttributes.position.length>=6,'morph targets survive the merge');
  assert.ok(list.length<=2+(look('merchant').parts||[]).length*1+1,`${list.length} meshes`);
});

test('falling asleep changes no shader input (same programs awake and asleep)',()=>{
  const cat=buildKitCat(gltf,look('merchant'),kit),actor=new T.Group();actor.add(cat.root);
  const rig=bindMayor(cat.root),item={seed:.2,catModel:actor,rig,rest:{amount:1,state:'sleeping'}},list=meshes(cat.root);
  const inputs=()=>list.map(m=>[m.material.customProgramCacheKey(),m.material.version,JSON.stringify(m.material.defines||{}),m.morphTargetInfluences?.length]);
  animateCat(item,'idle',.5,1,clips,false);applyExpression(rig.faces,'neutral');const awake=inputs();
  animateCat(item,'sleep',.5,1,clips,false);applyExpression(rig.faces,'asleep');
  assert.ok(rig.faces.some(f=>f.morphTargetInfluences[f.morphTargetDictionary.Blink_L]===1),'eyes close');
  assert.deepEqual(inputs(),awake,'same programs awake and asleep');
});

test('rest bounds hold every pose of every base, so skinned meshes are never CPU-skinned for culling',()=>{

  for(const role of ['scholar','builder','merchant']){
    const cat=buildKitCat(gltf,look(role),kit),actor=new T.Group();actor.add(cat.root);
    const rig=bindMayor(cat.root),item={seed:.2,catModel:actor,rig,rest:{amount:1,state:'sleeping'}};
    const skinned=meshes(cat.root).filter(m=>m.isSkinnedMesh),rest=skinned.map(m=>m.boundingSphere?.clone());
    assert.ok(rest.every(b=>b?.radius>0),'rest bounds set');
    for(const [mode,state] of [['sleep','sleeping'],['sleep','waking'],['walk','awake'],['talk','awake'],['work','awake'],['idle','awake']])for(const time of [.3,1.3,2.9]){
      Object.assign(item.rest,{state,amount:state==='sleeping'?1:state==='waking'?.5:0});animateCat(item,mode,time,1,clips,false);cat.root.updateMatrixWorld(true);
      skinned.forEach((m,i)=>{m.skeleton.update();const posed=new T.SkinnedMesh(m.geometry,m.material);posed.bind(m.skeleton,m.bindMatrix);posed.computeBoundingSphere();
        const reach=(rest[i].center.distanceTo(posed.boundingSphere.center)+posed.boundingSphere.radius)/rest[i].radius;
        assert.ok(reach<=1,`${role} ${mode}/${state} ${m.name} reaches ${reach.toFixed(3)} of its rest sphere`);});
    }
  }
});

test('kit cats walk with the existing clips and wear expressions without double-closing eyes',()=>{
  const cat=buildKitCat(gltf,look('scholar'),kit),actor=new T.Group();actor.add(cat.root);
  const rig=bindMayor(cat.root),item={seed:.2,catModel:actor,rig},before=rig.bones.armL.node.quaternion.clone();
  animateCat(item,'walk',.5,1,clips,false);assert.ok(1-Math.abs(before.dot(rig.bones.armL.node.quaternion))>1e-6,'arm swings');
  animateCat(item,'talk',.12,1,clips,false);applyExpression(rig.faces,'happy');
  for(const f of rig.faces){const d=f.morphTargetDictionary,v=f.morphTargetInfluences;assert.equal(v[d.Happy],1);assert.equal(v[d.Blink_L],0);assert.equal(v[d.Curious],0);}
});

test('expression rules: talk or approval is happy, research work is curious, idle nights are sleepy',()=>{
  assert.equal(expressionFor({mode:'talk'}),'happy');assert.equal(expressionFor({mode:'idle',happy:true}),'happy');
  assert.equal(expressionFor({mode:'work',busy:true,style:'scholar'}),'curious');assert.equal(expressionFor({mode:'work',busy:true,style:'builder'}),'neutral');
  assert.equal(expressionFor({mode:'idle',night:true}),'sleepy');assert.equal(expressionFor({mode:'idle',night:true,waiting:true,fallback:'curious'}),'curious');
});

test('a click ray from the front hits the kit cat body or its parts, tagged for selection',()=>{
  for(const role of ['builder','merchant','mayor']){
    const cat=buildKitCat(gltf,look(role),kit),actor=new T.Group();actor.add(cat.root);actor.traverse(o=>{o.userData.cat=role;});actor.updateMatrixWorld(true);bindMayor(cat.root);
    const hit=new T.Raycaster(new T.Vector3(0,.9,6),new T.Vector3(0,0,-1)).intersectObject(actor,true)[0];
    assert.ok(hit&&hit.object.userData.cat===role,role);
  }
});

// House art that is not plain primitives: the roof palette, the Blender shingle kit, and the life round each home
// (chimney smoke and warm window light on the ground at night). world-art.js makeHouse builds the houses with these.
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {glow,wind} from './world-art.js';

/** The curated roof colours (premium-visual-plan §5): soft, close in value, so a street of homes reads as one palette. */
export const ROOF_PALETTE={terracotta:'#c47d63',sage:'#93aa88',slate:'#7f8ea4',butter:'#d1b067',rose:'#c4919a',plum:'#977a9b',moss:'#82945c',teal:'#619b98'};
const roofHues=Object.values(ROOF_PALETTE).map(hex=>({hex,h:new T.Color(hex).getHSL({}).h}));
/**
 * The palette roof nearest a stored roof colour, by hue round the colour wheel (greys go slate). Applied when a house is
 * drawn, never when a look is generated: seeded looks and saved data stay byte-identical.
 */
export function snapRoof(hex){
  if(!/^#[0-9a-f]{6}$/i.test(hex||''))return ROOF_PALETTE.terracotta;
  const {h,s}=new T.Color(hex).getHSL({});if(s<.06)return ROOF_PALETTE.slate;
  let best=roofHues[0],gap=2;for(const r of roofHues){const d=Math.min(Math.abs(h-r.h),1-Math.abs(h-r.h));if(d<gap){gap=d;best=r;}}
  return best.hex;
}

// ---------------------------------------------------------------- shingle kit (public/assets/house-roofs.glb)
// Built by scripts/blender/build_house_roofs.py in unit space; each piece is a face mesh and a dark lip mesh whose vertex
// colour is the shade the roof colour is multiplied by. Loaded once before the first house is built (town.js); until
// then, or if it fails, roofs stay plain lathes.
let kit=null;
export async function loadRoofKit(){
  if(kit)return kit;
  try{
    const url=new URL('./assets/house-roofs.glb',import.meta.url);
    let bytes;if(url.protocol==='file:'){const b=(await import('node:fs')).readFileSync(url);bytes=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}
    else{const r=await fetch(url);if(!r.ok)throw Error(r.status);bytes=await r.arrayBuffer();}
    const gltf=await new Promise((ok,fail)=>new GLTFLoader().parse(bytes,'',ok,fail)),found={};
    gltf.scene.traverse(o=>{
      if(!o.isMesh)return;const [name,part]=o.name.split(/_(?=face$|lip$)/),geo=o.geometry;
      const shade=geo.attributes.color?geo.attributes.color.getX(0):1;geo.deleteAttribute('color');
      (found[name]??={})[part]={geo,shade};
    });
    kit=found;
  }catch(error){console.warn('Roof shingles could not load; roofs stay plain.',error?.message||error);kit={};}
  return kit;
}
/** {face:{geo,shade},lip:{geo,shade}} for cap_large, cap_small, gable or dome; null before the kit loads. */
export const shingles=name=>kit?.[name]?.face&&kit[name].lip?kit[name]:null;

// ---------------------------------------------------------------- life: smoke and window light
// Both are one draw for the whole town, built from the anchor points each house records (makeHouse userData.life,
// house-local) and the house matrices: life = [{points:{smoke:[[x,y,z]],spill:[[x,z,yaw,w,l]]}, matrix}].
const PUFFS=5;
let smokeMaterial=null,spillMaterial=null;
const puffGeo=new T.IcosahedronGeometry(1,1);
/** Smoke rises, drifts and fades in the vertex shader on wind.uTime, which town.js holds at 0 under reduced motion: the
 *  puffs then stand still as a wisp. */
function smoke(){
  if(smokeMaterial)return smokeMaterial;
  const m=new T.MeshLambertMaterial({color:'#f2efe9',transparent:true,opacity:.82,depthWrite:false});
  m.onBeforeCompile=shader=>{
    shader.uniforms.uTime=wind.uTime;
    shader.vertexShader='attribute float aPuff;uniform float uTime;varying float vPuff;\n'+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
  float pt=fract(uTime*.12+aPuff);
  transformed=transformed*mix(.13,.42,pt)+vec3(.45*pt+.06*sin(uTime*.8+aPuff*6.28)*pt,1.7*pt,-.15*pt);
  vPuff=smoothstep(0.,.12,pt)*(1.-pt);`);
    shader.fragmentShader='varying float vPuff;\n'+shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n  diffuseColor.a*=vPuff;');
  };
  m.customProgramCacheKey=()=>'house-smoke';return smokeMaterial=m;
}
/** Window light on the ground: a registered glow material (setWorldGlow drives it with every window), drawn additive and
 *  faded at the edges. It shows only once the glow passes sunset strength, so day draws nothing visible. */
function spill(){
  if(spillMaterial)return spillMaterial;
  const m=glow('#ffb46a');m.color.set('#000000');Object.assign(m,{transparent:true,blending:T.AdditiveBlending,depthWrite:false,fog:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-4});
  m.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec2 vSpill;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n  vSpill=position.xz*2.;');
    shader.fragmentShader='varying vec2 vSpill;\n'+shader.fragmentShader.replace('#include <opaque_fragment>',`float spillFall=1.-smoothstep(.15,1.,length(vSpill));
  float spillOn=smoothstep(.45,1.8,max(emissive.r,max(emissive.g,emissive.b)));
  gl_FragColor=vec4(emissive*.32*spillFall*spillFall*spillOn,1.);`);
  };
  m.customProgramCacheKey=()=>'house-spill';return spillMaterial=m;
}
const spillGeo=new T.PlaneGeometry(1,1).rotateX(-Math.PI/2);
/** The smoke and the window light of a set of houses, as one group of at most two instanced draws. */
export function buildHouseLife(life){
  const out=new T.Group(),p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3(),m=new T.Matrix4(),local=new T.Matrix4(),yawQ=new T.Quaternion(),up=new T.Vector3(0,1,0);
  const puffs=life.flatMap(({points,matrix})=>(points?.smoke||[]).map(at=>({at,matrix}))),spots=life.flatMap(({points,matrix})=>(points?.spill||[]).map(at=>({at,matrix})));
  if(puffs.length){
    const mesh=new T.InstancedMesh(puffGeo,smoke(),puffs.length*PUFFS),phase=new Float32Array(puffs.length*PUFFS);
    puffs.forEach(({at,matrix},i)=>{
      matrix.decompose(p,q,s);p.set(...at).applyMatrix4(matrix);const seed=(Math.sin(p.x*12.9898+p.z*78.233)*43758.5453)%1;
      for(let k=0;k<PUFFS;k++){const n=i*PUFFS+k;mesh.setMatrixAt(n,m.compose(p,q.identity(),s));phase[n]=Math.abs(seed)+k/PUFFS;}
    });
    // Instanced attribute on a per-build copy of the shared puff (the copy is this group's to dispose).
    mesh.geometry=puffGeo.clone();mesh.geometry.setAttribute('aPuff',new T.InstancedBufferAttribute(phase,1));mesh.userData.ownedGeometry=true;
    mesh.castShadow=false;mesh.receiveShadow=false;mesh.frustumCulled=false;mesh.renderOrder=1;out.add(mesh);
  }
  if(spots.length){
    const mesh=new T.InstancedMesh(spillGeo,spill(),spots.length);
    spots.forEach(({at:[x,z,yaw,w,l],matrix},i)=>{local.compose(p.set(x,.14,z),yawQ.setFromAxisAngle(up,yaw),s.set(w,1,l));mesh.setMatrixAt(i,m.multiplyMatrices(matrix,local));});
    mesh.castShadow=false;mesh.receiveShadow=false;mesh.frustumCulled=false;mesh.renderOrder=1;out.add(mesh);
  }
  return out;
}

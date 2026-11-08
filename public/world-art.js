import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {EYE_DEFAULT} from './editor.js';
import {stoneLayout} from './memorial.js';
import {BOARD,FOUNTAIN} from './hamlet-layout.js';
import {createWaterMaterial} from './water.js';
import {snapRoof,shingles} from './house-art.js';

// Shared geometry/materials keep the growing town inexpensive to redraw.
const materials=new Map(),geometries=new Map(),glows=new Map();
export function glow(color){if(!glows.has(color))glows.set(color,new T.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.18,roughness:.55}));return glows.get(color);}
/** One glow material for baked meshes: the vertex colour is both the base and the emitted colour, so every lantern,
 *  window and crystal of a whole hamlet is one draw. Registered with the glows, so day/night drives it too. */
export function glowBaked(){
  if(glows.has('baked'))return glows.get('baked');
  const m=new T.MeshStandardMaterial({vertexColors:true,emissive:'#ffffff',emissiveIntensity:.18,roughness:.55});
  m.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
  #ifdef USE_COLOR
  totalEmissiveRadiance*=vColor.rgb;
  #endif`);};
  m.customProgramCacheKey=()=>'glow-baked';glows.set('baked',m);return m;
}
const bakedMaterial=new T.MeshStandardMaterial({vertexColors:true,roughness:.9});
/** Emissive intensity of every window, lantern and lamp head (time-of-day presets set it; .18 by day, 2.6 at night). */
export function setWorldGlow(intensity){for(const m of glows.values())m.emissiveIntensity=intensity;}
export function setWorldNight(night){setWorldGlow(night?2.4:.18);}
const material=color=>{if(!materials.has(color))materials.set(color,new T.MeshStandardMaterial({color,roughness:.9}));return materials.get(color);};
const geometry=(key,build)=>{if(!geometries.has(key))geometries.set(key,build());return geometries.get(key);};
function mesh(parent,geo,color,x=0,y=0,z=0){const m=new T.Mesh(geo,material(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
// Two bevel segments (a soft edge highlight) where the bevel shows: boxes half a metre or more with a bevel of 7 cm or
// more (walls, crates, the bank). Thin trim, frames and the procedural cats keep one: a second segment there is invisible
// at the town's zoom and nearly triples the box's triangles.
export function round(parent,w,h,d,color,x=0,y=0,z=0,r=.08){const b=Math.min(r,w/3,h/3,d/3),s=b>=.07&&Math.max(w,h,d)>=.5?2:1;return mesh(parent,geometry(`box:${w}:${h}:${d}:${r}:${s}`,()=>new RoundedBoxGeometry(w,h,d,s,b)),color,x,y,z);}
// Small balls (ivy, hedges, buttons) use a coarser sphere: they are a few pixels wide and there are dozens per house.
export function ball(parent,sx,sy,sz,color,x=0,y=0,z=0){const small=Math.max(sx,sy,sz)<.36,m=mesh(parent,small?geometry('sphere-small',()=>new T.SphereGeometry(1,8,5)):geometry('sphere',()=>new T.SphereGeometry(1,10,7)),color,x,y,z);m.scale.set(sx,sy,sz);return m;}
export function cylinder(parent,r,h,color,x=0,y=0,z=0,rTop=r){return mesh(parent,geometry(`cylinder:${r}:${h}:${rTop}`,()=>new T.CylinderGeometry(rTop,r,h,14)),color,x,y,z);}
function ring(parent,r,t,color,x,y,z){return mesh(parent,geometry(`ring:${r}:${t}`,()=>new T.TorusGeometry(r,t,6,20)),color,x,y,z);}
function line(parent,a,b,r,color){const start=new T.Vector3(...a),end=new T.Vector3(...b),delta=end.clone().sub(start);const m=cylinder(parent,r,delta.length(),color);m.position.copy(start.add(end).multiplyScalar(.5));m.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());return m;}
function ear(parent,color,x,y,z){const shape=new T.Shape();shape.moveTo(-.19,0);shape.lineTo(0,.34);shape.lineTo(.19,0);shape.closePath();return mesh(parent,geometry('ear',()=>new T.ExtrudeGeometry(shape,{depth:.17,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.045,bevelThickness:.045})),color,x,y,z);}
function book(parent,x,y,z,color,scale=1){const g=new T.Group();g.position.set(x,y,z);g.scale.setScalar(scale);parent.add(g);round(g,.3,.42,.12,color);round(g,.23,.34,.13,'#f6e4bd',.02,0,.005);round(g,.035,.42,.14,color,-.14,0,0);return g;}
const dark=EYE_DEFAULT,wood='#987254',ivory='#f4e5cb',gold='#dfad55';
export function compact(group){
  group.updateMatrixWorld(true);const buckets=new Map(),result=new T.Group();
  group.traverse(o=>{if(!o.isMesh)return;const geo=o.geometry.clone().applyMatrix4(o.matrixWorld);const key=o.material;const list=buckets.get(key)||[];list.push(geo.index?geo.toNonIndexed():geo);if(geo.index)geo.dispose();buckets.set(key,list);});
  for(const [mat,list] of buckets){const merged=mergeGeometries(list);list.forEach(g=>g.dispose());const m=new T.Mesh(merged,mat);m.castShadow=true;m.receiveShadow=true;m.userData.ownedGeometry=true;result.add(m);}
  result.userData={...group.userData};return result;
}

/**
 * Bakes a group into vertex-coloured geometry in the group's own space: {solid, glow} BufferGeometries (either may be null).
 * Plain materials become vertex colours; glow materials go to the glow geometry. place(solid,glow) merges many bakes.
 */
export const bake=group=>{const parts=bakeCollect(group);while(!bakeCopy(parts));return bakeMerge(parts);};
/** bake in steps, so a caller can put frames between them: collect the meshes, copy them `count` at a time
 *  (bakeCopy returns true once all are copied), then merge and weld. */
export function bakeCollect(group){
  group.updateMatrixWorld(true);const meshes=[];group.traverse(o=>{if(o.isMesh)meshes.push(o);});
  return {meshes,next:0,solid:[],lit:[],userData:{...group.userData}};
}
export function bakeCopy(parts,count=Infinity){
  const c=new T.Color(),glowing=new Set(glows.values()),end=Math.min(parts.meshes.length,parts.next+count);
  for(;parts.next<end;parts.next++){
    const o=parts.meshes[parts.next];
    let geo=o.geometry.clone().applyMatrix4(o.matrixWorld);if(geo.index){const n=geo.toNonIndexed();geo.dispose();geo=n;}
    for(const k of Object.keys(geo.attributes))if(k!=='position'&&k!=='normal')geo.deleteAttribute(k);
    c.copy(o.material.color);const n=geo.attributes.position.count,col=new Float32Array(n*3);for(let i=0;i<n;i++)c.toArray(col,i*3);
    geo.setAttribute('color',new T.BufferAttribute(col,3));
    (glowing.has(o.material)?parts.lit:parts.solid).push(geo);
  }
  return parts.next>=parts.meshes.length;
}
export function bakeMerge({solid,lit,userData}){
  // Welded back into an indexed mesh: the GPU then shades each shared corner once, not once per triangle (about 4x
  // fewer vertex shader runs for rounded boxes and spheres, in the main and the shadow pass).
  const merge=list=>{if(!list.length)return null;const m=mergeGeometries(list);list.forEach(g=>g.dispose());const w=mergeVertices(m);m.dispose();return w;};
  const baked=merge(solid);if(baked)bakeAO(baked);
  return {solid:baked,glow:merge(lit),userData};
}
// Ambient occlusion baked into the vertex colours of a bake (the glow half stays bright). The bake's triangles are
// rasterised into a coarse occupancy grid; each vertex marches a few short rays over its hemisphere (directions on a
// Fibonacci sphere), and the ground plane (y < 0, the bake's own floor) counts as solid, so walls, posts and hedges
// darken where they meet the ground and under eaves. About 1.1 art units of reach; 15-60 ms per house look, once, at bake.
const AO_DIRS=(()=>{const out=[],n=14,g=Math.PI*(3-Math.sqrt(5));for(let i=0;i<n;i++){const y=1-(i+.5)/n*2,r=Math.sqrt(1-y*y);out.push([Math.cos(i*g)*r,y,Math.sin(i*g)*r]);}return out;})();
export function bakeAO(geo,{cell=.16,steps=7,strength=.55}={}){
  const P=geo.attributes.position,N=geo.attributes.normal,C=geo.attributes.color,I=geo.index;if(!P||!N||!C)return geo;
  geo.computeBoundingBox();const {min,max}=geo.boundingBox,ox=min.x-2*cell,oy=Math.min(min.y,0)-2*cell,oz=min.z-2*cell;
  const nx=Math.ceil((max.x-ox)/cell)+3,ny=Math.ceil((max.y-oy)/cell)+3,nz=Math.ceil((max.z-oz)/cell)+3,grid=new Uint8Array(nx*ny*nz);
  const at=(x,y,z)=>{const i=Math.floor((x-ox)/cell),j=Math.floor((y-oy)/cell),k=Math.floor((z-oz)/cell);return i>=0&&j>=0&&k>=0&&i<nx&&j<ny&&k<nz?(k*ny+j)*nx+i:-1;};
  const v=n=>I?I.getX(n):n,count=(I?I.count:P.count)/3;
  for(let t=0;t<count;t++){
    const a=v(t*3),b=v(t*3+1),c=v(t*3+2),ax=P.getX(a),ay=P.getY(a),az=P.getZ(a),bx=P.getX(b),by=P.getY(b),bz=P.getZ(b),cx=P.getX(c),cy=P.getY(c),cz=P.getZ(c);
    const n=Math.max(1,Math.ceil(Math.max(Math.hypot(bx-ax,by-ay,bz-az),Math.hypot(cx-ax,cy-ay,cz-az),Math.hypot(cx-bx,cy-by,cz-bz))/cell*1.4));
    for(let i=0;i<=n;i++)for(let j=0;j<=n-i;j++){const u=i/n,w=j/n,s=1-u-w,k=at(ax*s+bx*u+cx*w,ay*s+by*u+cy*w,az*s+bz*u+cz*w);if(k>=0)grid[k]=1;}
  }
  const solid=(x,y,z)=>{if(y<0)return true;const k=at(x,y,z);return k>=0&&grid[k]===1;};
  for(let p=0;p<P.count;p++){
    const qx=N.getX(p),qy=N.getY(p),qz=N.getZ(p),px=P.getX(p)+qx*cell*.6,py=P.getY(p)+qy*cell*.6,pz=P.getZ(p)+qz*cell*.6;let hit=0,total=0;
    for(const [dx,dy,dz] of AO_DIRS){
      const cos=dx*qx+dy*qy+dz*qz;if(cos<.15)continue;total+=cos;
      for(let s=1;s<=steps;s++){const d=cell*(.9+s);if(solid(px+dx*d,py+dy*d,pz+dz*d)){hit+=cos*(1-(s-1)/steps*.6);break;}}
    }
    const ao=1-strength*(total?hit/total:0);C.setXYZ(p,C.getX(p)*ao,C.getY(p)*ao,C.getZ(p)*ao);
  }
  C.needsUpdate=true;return geo;
}
/** Merges baked pieces placed by matrices into at most two meshes (solid + glow). items: [{baked, matrix}]. */
export function bakedMeshes(items,{castShadow=true}={}){
  const out=new T.Group();
  for(const [key,material] of [['solid',bakedMaterial],['glow',glowBaked()]]){
    const list=items.filter(i=>i.baked[key]).map(i=>i.baked[key].clone().applyMatrix4(i.matrix));if(!list.length)continue;
    const mesh=new T.Mesh(mergeGeometries(list),material);list.forEach(g=>g.dispose());mesh.castShadow=castShadow;mesh.receiveShadow=true;mesh.userData.ownedGeometry=true;out.add(mesh);
  }
  return out;
}

export function makeCat(style,palette,limbs=true){
  const g=new T.Group(),{fur,cream,patch,outfit}=palette;
  ball(g,.68,.72,.52,fur,0,.76,0);ball(g,.7,.57,.51,fur,0,1.13,0);
  ball(g,.53,.57,.12,cream,0,.69,.435);ball(g,.5,.33,.11,cream,0,1.02,.467);
  for(const x of [-.43,.43]){ear(g,(style==='scholar'||style==='operator')?patch:fur,x,1.49,-.04);const inner=ear(g,'#d39b86',x,1.53,.105);inner.scale.set(.5,.6,.4);}
  const tailCurve=new T.CatmullRomCurve3([new T.Vector3(.48,.3,-.18),new T.Vector3(.84,.32,-.22),new T.Vector3(1.02,.55,-.24),new T.Vector3(.96,.79,-.22)]);
  mesh(g,geometry('tail',()=>new T.TubeGeometry(tailCurve,20,.145,10,false)),style==='scholar'?patch:fur);
  if(['mayor','builder','banker','archivist','operator'].includes(style)){
    for(const x of [-.46,.46])for(let n=0;n<2;n++){const stripe=ball(g,.19,.055,.06,patch,x,1.27+n*.13,.365);stripe.rotation.z=x>0?-.25:.25;}
    for(const x of [-.19,0,.19])ball(g,.055,.13,.04,patch,x,1.57,.26);
    for(const t of [.3,.65]){const p=tailCurve.getPoint(t);ball(g,.151,.085,.15,patch,p.x,p.y,p.z);}
  }
  if(style==='critic'||style==='merchant'){
    ball(g,.31,.43,.09,patch,-.38,1.25,.4);
    if(style==='merchant')ball(g,.26,.36,.08,'#efa45c',.43,1.23,.4);
  }
  if(style==='scholar')for(const x of [-.23,.23])ball(g,.24,.23,.055,patch,x,1.18,.5);
  // Clothing sits around the lower body so the characteristic round face stays visible.
  ball(g,.707,.32,.54,outfit,0,.55,.01);
  if(['builder','archivist','banker','critic','merchant','operator'].includes(style)){
    for(const x of [-.3,.3])round(g,.3,.37,.09,outfit,x,.58,.52,.07);
    for(const y of [.45,.63])ball(g,.05,.05,.025,gold,0,y,.57);
  }
  if(style==='mayor'||style==='scholar'||style==='merchant'||style==='operator'){
    const scarf=style==='merchant'?'#627c50':style==='operator'?'#e4b15c':outfit;
    ball(g,.725,.12,.54,scarf,0,.91,0);round(g,.23,.28,.1,scarf,.2,.78,.53,.05).rotation.z=-.35;
    ball(g,.09,.08,.05,style==='mayor'?gold:scarf,0,.88,.56);
  }
  if(style==='mayor'){const medal=cylinder(g,.13,.05,gold,0,.65,.6);medal.rotation.x=Math.PI/2;ring(g,.1,.015,'#ad803d',0,.65,.635);}
  if(style==='builder'){
    for(const x of [-.36,.36]){round(g,.13,.42,.08,outfit,x,.76,.5);ball(g,.06,.06,.03,gold,x,.76,.55);}
    round(g,.35,.2,.09,outfit,0,.51,.56);round(g,.23,.26,.15,'#bf8c47',.61,.51,.29);line(g,[.42,1.68,.17],[.72,1.55,.2],.04,gold);
  }
  if(style==='banker'){round(g,.21,.15,.06,ivory,0,.85,.54);round(g,.065,.2,.045,dark,0,.76,.59).rotation.z=.15;}
  if(limbs)for(const x of [-.58,.58]){ball(g,.17,.22,.19,style==='scholar'?patch:cream,x,.65,.4);ball(g,.17,.09,.19,cream,x*.58,.1,.23);}
  for(const x of [-.23,.23]){
    ball(g,.042,.056,.03,dark,x,1.2,.548).name=x<0?'eyeL':'eyeR';
    if(style==='critic')round(g,.15,.045,.035,patch,x,1.24,.575,.015).rotation.z=x<0?-.14:.14;
    ball(g,.1,.05,.015,'#e6b0a0',x*1.5,1.04,.51);
    for(const y of [1.1,1.18])line(g,[x<0?-.53:.43,y,.43],[x<0?-.43:.53,y+.02,.43],.012,dark);
  }
  ball(g,.04,.026,.025,'#bc8266',0,1.1,.59);
  for(const x of [-.045,.045]){const smile=ring(g,.048,.011,dark,x,1.055,.578);smile.scale.y=.6;}
  if(['banker','scholar','archivist'].includes(style)){
    const size=style==='scholar'?.185:style==='archivist'?.145:.12;
    for(const x of [-.23,.23])ring(g,size,.024,style==='banker'?gold:dark,x,1.2,.599);
    line(g,[-.075,1.2,.6],[.075,1.2,.6],.018,dark);
  }
  if(style==='scholar'){book(g,.61,.48,.54,'#886042',.85);line(g,[.35,.9,.55],[.56,.48,.64],.035,wood);}
  if(style==='critic'){const clip=round(g,.33,.46,.065,wood,.67,.48,.6);clip.rotation.z=-.2;round(g,.26,.35,.025,ivory,.67,.48,.645);round(g,.13,.07,.04,'#7d7b72',.67,.7,.65);}
  if(style==='merchant'){round(g,.34,.31,.32,'#d7ac76',.67,.38,.53);round(g,.05,.32,.33,wood,.67,.38,.53);}
  if(style==='operator'){
    const headset=ring(g,.64,.055,'#514b43',0,1.18,0);headset.rotation.y=Math.PI/2;
    for(const x of [-.69,.69])ball(g,.08,.16,.16,gold,x,1.21,.05);
    line(g,[.65,1.17,.14],[.36,.99,.57],.035,'#514b43');ball(g,.1,.06,.06,'#514b43',.3,.99,.6);
  }
  if(style==='archivist')for(let n=0;n<3;n++)book(g,.62,.4+n*.12,.5,['#657f8c','#c89f58','#7e8862'][n],.7).rotation.z=Math.PI/2;
  return g;
}

function roof(g,w,h,d,color,y){
  const s=new T.Shape();s.moveTo(-w/2,0);s.lineTo(0,h);s.lineTo(w/2,0);s.closePath();
  return mesh(g,geometry(`roof:${w}:${h}:${d}`,()=>{const geo=new T.ExtrudeGeometry(s,{depth:d,bevelEnabled:true,bevelSegments:2,bevelSize:.07,bevelThickness:.07,steps:1});geo.translate(0,0,-d/2);return geo;}),color,0,y,0);
}
// userData.spill = [width, length] of the warm light a glowing pane or door casts on the ground at night (house-art.js).
function window(g,x,y,z,color='#a4bfbb'){
  round(g,.55,.63,.12,wood,x,y,z,.1);const pane=round(g,.43,.5,.05,color,x,y,z+.07,.09);pane.material=glow('#ffcf7a');pane.userData.spill=[1.3,1.5];
  round(g,.045,.5,.06,ivory,x,y,z+.11,.01);round(g,.44,.045,.06,ivory,x,y,z+.11,.01);
  round(g,.68,.09,.24,ivory,x,y-.35,z+.04,.03);
}
// The door has a little lamp over it, so the doorstep is lit at night.
function door(g,z,color='#b99672'){
  round(g,.7,1.1,.16,wood,0,.68,z,.24);round(g,.52,.9,.07,color,0,.66,z+.1,.2).userData.spill=[1.5,1.4];ball(g,.04,.04,.03,gold,.18,.65,z+.15);round(g,.94,.12,.5,ivory,0,.1,z+.2);
  round(g,.06,.06,.18,wood,0,1.38,z+.1,.02);round(g,.15,.14,.13,gold,0,1.33,z+.22,.03).material=glow('#ffd78c');
}
function flowerbox(g,x,z){round(g,.65,.22,.32,wood,x,.3,z);for(let i=-1;i<=1;i++){ball(g,.14,.13,.12,'#91a46c',x+i*.18,.5,z);ball(g,.08,.08,.07,i?'#e5b0a3':'#f1d186',x+i*.18,.6,z);}}
function shelves(g,x,y,z){round(g,.9,1.2,.3,wood,x,y,z);for(let j=0;j<2;j++)for(let i=0;i<4;i++)book(g,x-.3+i*.2,y-.24+j*.5,z+.18,['#81929e','#b57f7c','#b8a06c','#8b9c78'][i],.58);}
function sign(g,color,symbol,y=1.8,z=1.25){round(g,1.14,.42,.14,color,0,y,z);if(symbol==='coin'){const m=cylinder(g,.14,.05,gold,0,y,z+.1);m.rotation.x=Math.PI/2;}else if(symbol==='book'){book(g,0,y,z+.1,ivory,.65).rotation.z=Math.PI/2;}else if(symbol==='parcel')round(g,.21,.21,.08,ivory,0,y,z+.11);else{for(let i=-1;i<=1;i++)ball(g,.045,.045,.03,ivory,i*.18,y,z+.1);}}

// Curved, flared roofs and hand-built silhouettes give every trade its own fairy-tale home.
function cap(g,r,h,color,x,y,z){
  const points=[[r*1.08,0],[r,.12*h],[r*.77,.3*h],[r*.48,.57*h],[r*.22,.8*h],[.035,h]].map(p=>new T.Vector2(...p));
  return mesh(g,geometry(`cap:${r}:${h}`,()=>new T.LatheGeometry(points,16)),color,x,y,z);
}
const shade=(hex,k)=>'#'+new T.Color(hex).multiplyScalar(k).getHexString();
/** A house roof on cap()'s profile: a finer lathe, an eave trim ring and the Blender shingle rows (house-roofs.glb) scaled
 *  onto it. Before the kit loads (or if it cannot) the lathe alone stands, in the roof colour. */
function roofCap(g,r,h,color,x,y,z){
  const kit=shingles(r>=1.4?'cap_large':'cap_small'),points=[[r*1.08,0],[r,.12*h],[r*.77,.3*h],[r*.48,.57*h],[r*.22,.8*h],[.035,h]].map(p=>new T.Vector2(...p));
  const m=mesh(g,geometry(`roofcap:${r}:${h}`,()=>new T.LatheGeometry(points,28)),kit?shade(color,.8):color,x,y,z);
  mesh(g,geometry(`eave:${r}`,()=>new T.TorusGeometry(r*1.08,.035+.02*r,6,28).rotateX(Math.PI/2)),shade(color,.68),x,y+.02,z);
  if(kit)for(const part of ['face','lip'])mesh(g,kit[part].geo,shade(color,kit[part].shade),x,y,z).scale.set(r,h,r);
  return m;
}
/** The cottage gable roof with shingle rows down both slopes and a ridge cap. */
function roofGable(g,w,h,d,color,y){
  const kit=shingles('gable'),m=roof(g,w,h,d,kit?shade(color,.8):color,y);if(!kit)return m;
  const L=Math.hypot(w/2,h),slope=Math.atan2(h,w/2),bevel=.07,eave=.08;
  for(const side of [-1,1]){
    // The kit's x runs up the slope, y out of it, z along the ridge; the right slope is turned over (x stays, y and z flip).
    const nx=side*Math.sin(slope),ny=Math.cos(slope),dx=-side*Math.cos(slope),dy=Math.sin(slope);
    for(const part of ['face','lip']){
      const s=mesh(g,kit[part].geo,shade(color,kit[part].shade),side*w/2+nx*bevel-dx*eave,y+ny*bevel-dy*eave,0);
      s.rotation.set(side>0?Math.PI:0,0,side>0?Math.PI-slope:slope,'ZYX');s.scale.set(L+eave,1,d+.14);
    }
  }
  mesh(g,geometry(`ridge:${d}`,()=>new T.CylinderGeometry(.1,.1,d+.24,10).rotateX(Math.PI/2)),shade(color,.68),0,y+h+bevel*.6,0);
  return m;
}
/** The merchant's onion dome: a smooth ellipsoid under shingle rows. */
function roofDome(g,rx,ry,rz,color,x,y,z){
  const kit=shingles('dome'),m=mesh(g,geometry('dome',()=>new T.SphereGeometry(1,28,14)),kit?shade(color,.8):color,x,y,z);m.scale.set(rx,ry,rz).multiplyScalar(kit?.97:1);
  if(kit)for(const part of ['face','lip'])mesh(g,kit[part].geo,shade(color,kit[part].shade),x,y,z).scale.set(rx,ry,rz);
  return m;
}
/** Where a house's life goes, house-local: chimney tops for smoke, and for every glowing pane or door the ground spot it
 *  lights at night [x, z, yaw, width, length], laid out from the wall it sits in. */
function houseLife(g){
  g.updateMatrixWorld(true);const spill=[],v=new T.Vector3(),n=new T.Vector3();
  g.traverse(o=>{
    const s=o.userData.spill;if(!s)return;o.getWorldPosition(v);n.set(0,0,1).transformDirection(o.matrixWorld).setY(0).normalize();const out=s[1]/2+.1;
    spill.push([v.x+n.x*out,v.z+n.z*out,Math.atan2(n.x,n.z),s[0],s[1]].map(k=>Math.round(k*1000)/1000));
  });
  const smoke=g.userData.smoke||[];delete g.userData.smoke;return {smoke,spill};
}
function crystal(g,x,y,z,color,scale=.35){const m=mesh(g,geometry('crystal',()=>new T.OctahedronGeometry(1)),color,x,y,z);m.material=glow(color);m.scale.set(scale,scale*1.7,scale);return m;}
function lantern(g,x,y,z){
  line(g,[x,y+.35,z],[x,y-.2,z],.025,wood);round(g,.25,.35,.25,gold,x,y,z,.05).material=glow('#ffd78c');cap(g,.22,.18,wood,x,y+.18,z);
}
function ivy(g,x,z){for(let n=0;n<9;n++){const y=.3+n*.22;ball(g,.17,.09,.07,n%2?'#649665':'#8db26c',x+Math.sin(n*1.9)*.12,y,z);}}

// Owner decor (cat.home.look.decor, ids in world-catalog houseDecor). Spots per style sit each piece on that shape:
// sill = window boxes [x,y,z], chimney [x,z,base,top], vane [x,y,z], ivy [x,z], bunting {y,sag,arc:[rx,rz,spread]} round the eave lip
// or {gable:[halfWidth,eave,peak,z]} down both rakes of the front gable (anything under the eave is hidden from the camera).
// The garden is the same for every style, so the fence, lantern post and birdhouse share one place (clear of bench, mailbox and the cat's spot).
const cottage=h=>({sill:[[-.85,.55,1.38],[.85,.55,1.38]],chimney:[-.85,-.45,h+.3,h+1.55],vane:[0,h+1.45,.5],bunting:{gable:[1.5,h+.22,h+1.32,1.48]},ivy:[[-1.25,1.22],[1.25,1.22]]});
const SPOTS={
  scholar:{sill:[[-.65,1.38,1.22],[.65,1.38,1.22]],chimney:[-.55,-.55,3.6,4.6],vane:[0,5.33,0],bunting:{y:3,sag:.14,arc:[1.84,1.84,.85]},ivy:[[-.95,.87],[.95,.87]]},
  banker:{sill:[[-1.25,.9,1.42],[1.25,.9,1.42]],chimney:[-.6,-.65,2.3,3.35],chimneyFront:[-.4,.5,2.3,3.35],vane:[0,3.22,0],bunting:{y:1.8,sag:.12,arc:[2.15,2.15,.7]},ivy:[[-1.25,1.36],[1.25,1.36]]},
  merchant:{sill:[[-.75,.58,1.3],[.75,.58,1.3]],chimney:[-.6,-.6,2.9,3.75],vane:[0,3.2,0],bunting:{y:2.3,sag:.1,arc:[2,1.8,.9]},ivy:[[-1.2,.69],[1.2,.69]]},
  archivist:{sill:[[-.72,1.48,1.3],[.72,1.48,1.3]],chimney:[-.6,-.6,3.1,4.1],vane:[0,4,0],bunting:{y:2.54,sag:.14,arc:[2.05,2.05,.8]},ivy:[[-1.1,1.04]]},
  mayor:{...cottage(2.3),chimney:[-.8,.6,2.6,3.85],chimneyBack:[-.3,-.95,2.6,3.85],vane:[-1.35,4.55,-.65]},critic:{...cottage(1.85),chimney:[.85,-.45,2.15,3.4]}
};
const FENCE=[[[-2.45,.95],[-2.45,2.15],[-2.1,2.5],[-.85,2.55]],[[2.45,.95],[2.45,2.1]]];
function sillBox(g,x,y,z){round(g,.62,.16,.3,wood,x,y,z,.04);for(let i=-1;i<=1;i++){ball(g,.13,.1,.1,'#7fa063',x+i*.19,y+.12,z);ball(g,.08,.07,.07,i?'#ec9fa6':'#f6d27a',x+i*.19,y+.2,z+.03);}}
// Smoke rises from the stack: house-art.js draws it for the whole town from userData.life.smoke (one instanced draw).
function chimney(g,x,z,base,top){
  round(g,.4,top-base,.4,'#a8695c',x,(base+top)/2,z,.04);round(g,.52,.12,.52,'#7c4b42',x,top,z,.03);
  smokeFrom(g,x,top+.12,z);
}
const smokeFrom=(g,x,y,z)=>(g.userData.smoke??=[]).push([x,y,z]);
/** The chimney on the side of the house that faces the town's camera: the back when the back faces it (p.back). */
function chimneySpot(spot,back){const [x,z,base,top]=spot.chimney;return back?spot.chimneyBack||[x,-Math.abs(z),base,top]:spot.chimneyFront||[x,Math.abs(z),base,top];}
// The back of every home (the camera sees it on the near side of each plaza): a lit window, timber bands, and a woodpile
// or barrels under the window. Built facing +z in a group turned round, so window() serves the back as it does the front.
function woodpile(g,x,z){
  for(const [dx,y] of [[-.21,.21],[0,.21],[.21,.21],[-.105,.38],[.105,.38],[0,.55]]){
    cylinder(g,.1,.5,dx%.2?'#7d5a40':'#8f6a4a',x+dx,y,z).rotation.x=Math.PI/2;cylinder(g,.085,.02,'#dcc196',x+dx,y,z+.25).rotation.x=Math.PI/2;
  }
}
function barrel(g,x,z){cylinder(g,.24,.56,'#9a7050',x,.39,z,.22);for(const [y,r] of [[.24,.24],[.54,.226]])ring(g,r,.022,'#5d5a63',x,y,z).rotation.x=Math.PI/2;cylinder(g,.2,.02,'#7a5638',x,.675,z);}
const BACK={
  scholar:{window:[0,1.85,1.2],rings:[[1.27,.5],[1.27,2.62]],pile:[0,1.6]},
  banker:{window:[0,1.05,1.24],bands:[2.2,1.25,[.4,1.55]],barrels:[[-.5,1.62],[.5,1.62]]},
  merchant:{window:[0,1,1.3],rings:[[1.38,.35],[1.38,1.66]],barrels:[[-.5,1.72],[.5,1.72]]},
  archivist:{window:[0,1.95,1.3],rings:[[1.47,.3],[1.29,2.45]],pile:[0,1.75]},
};
function backFacade(g,style,timber,h){
  const b=new T.Group();b.rotation.y=Math.PI;g.add(b);
  const spec=BACK[style]||{window:[0,1.05,1.2],posts:true,bands:[2.7,1.2,[.45,1.65]],pile:[0,1.6]};
  window(b,...spec.window);
  if(spec.posts)for(const x of [-1.25,1.25])round(b,.13,h,.13,timber,x,h/2+.13,1.17);
  if(spec.bands){const [w,z,ys]=spec.bands;for(const y of ys)round(b,w,.1,.12,timber,0,y,z);}
  for(const [r,y] of spec.rings||[])cylinder(g,r,.1,timber,0,y,0);
  if(spec.pile)woodpile(b,...spec.pile);
  for(const [x,z] of spec.barrels||[])barrel(b,x,z);
}
function vane(g,x,y,z){
  cylinder(g,.035,.75,'#5d5a63',x,y+.37,z);for(const r of [0,Math.PI/2])round(g,.5,.035,.035,'#5d5a63',x,y+.48,z).rotation.y=r;
  const arrow=new T.Group();arrow.position.set(x,y+.72,z);arrow.rotation.y=.6;g.add(arrow);
  round(arrow,.7,.04,.04,gold);round(arrow,.13,.13,.04,gold,.36,0,0,.01).rotation.z=Math.PI/4;round(arrow,.2,.2,.03,gold,-.33,.04,0,.02);ball(g,.06,.06,.06,gold,x,y+.78,z);
}
function bunting(g,b,colors){
  const n=9,sag=t=>.1*(1-t*t),spans=b.gable?[-1,1].map(side=>Array.from({length:n},(_,i)=>{const t=i/(n-1),[w,eave,peak,z]=b.gable;return [side*w*(1-t),eave+(peak-eave)*t-sag(t*2-1),z,0];}))
    :[Array.from({length:n},(_,i)=>{const t=i/(n-1)*2-1,a=t*b.arc[2];return [Math.sin(a)*b.arc[0],b.y-b.sag*(1-t*t),Math.cos(a)*b.arc[1],a];})];
  const size=.28,flag=geometry('pennant',()=>new T.ConeGeometry(.5,1,3).rotateX(Math.PI).scale(1,1,.25));
  for(const pts of spans)for(let i=0;i<n;i++){const [x,y,z,a]=pts[i];if(i)line(g,pts[i-1].slice(0,3),[x,y,z],.016,'#6d5a4a');if(i%(n-1)){const m=mesh(g,flag,colors[i%3],x,y-size/2,z);m.scale.set(size*.85,size,size);m.rotation.y=a;}}
}
function fence(g,path){
  for(let i=1;i<path.length;i++){
    const [ax,az]=path[i-1],[bx,bz]=path[i],len=Math.hypot(bx-ax,bz-az),n=Math.max(1,Math.round(len/.24)),yaw=Math.atan2(az-bz,bx-ax);
    for(const y of [.22,.44])line(g,[ax,y,az],[bx,y,bz],.025,ivory);
    for(let k=i>1?1:0;k<=n;k++){const t=k/n,px=ax+(bx-ax)*t,pz=az+(bz-az)*t;round(g,.09,.6,.05,ivory,px,.3,pz,.03).rotation.y=yaw;}
  }
}
function lanternPost(g,x,z){cylinder(g,.14,.12,'#5d4a3a',x,.06,z);cylinder(g,.05,1.6,'#5d4a3a',x,.85,z);lantern(g,x,1.85,z);}
function birdhouse(g,x,z,color){
  cylinder(g,.045,1.5,wood,x,.75,z);round(g,.34,.36,.32,ivory,x,1.68,z,.04);ball(g,.06,.06,.02,'#4b3b33',x,1.72,z+.16);line(g,[x,1.58,z+.16],[x,1.58,z+.28],.015,wood);
  roof(g,.5,.24,.42,color,1.84).position.set(x,1.84,z);
}
function decorate(g,style,p){
  const spot=SPOTS[style]||cottage(1.85),decor=new Set(p.decor);
  if(decor.has('flower_boxes'))for(const [x,y,z] of spot.sill)sillBox(g,x,y,z);
  if(decor.has('chimney'))chimney(g,...chimneySpot(spot,p.back));
  if(decor.has('weathervane'))vane(g,...spot.vane);
  if(decor.has('bunting'))bunting(g,spot.bunting,[p.roof||'#c98b6b',ivory,'#e8b45a']);
  if(decor.has('ivy'))for(const [x,z] of spot.ivy)ivy(g,x,z);
  if(decor.has('lantern'))lanternPost(g,-.6,2);
  if(decor.has('picket_fence'))for(const path of FENCE)fence(g,path);
  if(decor.has('birdhouse'))birdhouse(g,-2.1,1.6,p.roof||'#c98b6b');
}
export function makeHouse(style,p){
  // p.wall / p.trim / p.door are optional tints (a recruit's seeded house look, then the owner's home look); p.decor lists decor ids.
  // The roof colour snaps to the curated palette here, at draw time; the stored look keeps its own colour.
  p={...p,roof:snapRoof(p.roof)};const g=new T.Group(),wall=p.wall||'#f0dfbf',timber=p.trim||wood;let height=4.4,h=0;
  cylinder(g,2.15,.16,'#cabda0',0,.03,0);
  if(style==='scholar'){
    cylinder(g,1.24,3,wall,0,1.55,0);roofCap(g,1.65,1.9,p.roof,0,3.04,0);crystal(g,0,5.05,0,'#b4e4ee',.18);
    door(g,1.23,p.door);window(g,-.65,1.85,1.09);window(g,.65,1.85,1.09);shelves(g,-1.55,.72,.7);
    for(let i=0;i<3;i++){const star=crystal(g,Math.sin(i*2.1)*.72,3.6+i*.3,.9-i*.2,'#ffe29b',.075);star.rotation.z=.6;}
    const scope=cylinder(g,.18,1,'#b5905f',1.1,2.85,.55);scope.rotation.z=-.9;line(g,[.95,2.2,.55],[1.1,2.85,.55],.06,wood);height=5.5;
  }else if(style==='banker'){
    round(g,2.65,1.7,2.4,'#c9c7b1',0,.95,0,.32);roofCap(g,1.95,1.4,p.roof,0,1.85,0);
    for(const x of [-1.25,1.25]){cylinder(g,.47,2.1,'#ddd5b8',x,1.1,.85);roofCap(g,.64,1.1,p.roof,x,2.15,.85);crystal(g,x,3.3,.85,'#b9ecc1',.12);}
    door(g,1.24,p.door);const coin=cylinder(g,.29,.1,gold,0,2.28,1.34);coin.rotation.x=Math.PI/2;ring(g,.21,.035,ivory,0,2.28,1.41);
    for(const x of [-.8,.8])crystal(g,x,.4,1.65,'#a6d9b2',.19);height=3.7;
  }else if(style==='merchant'){
    cylinder(g,1.35,1.7,wall,0,.95,0);roofDome(g,1.95,.9,1.75,p.roof,0,2.35,0);cylinder(g,1.94,.15,'#efc5a0',0,2.07,0,1.8);
    for(let i=0;i<7;i++){const a=i*2.4;ball(g,.2,.06,.18,ivory,Math.sin(a)*1.25,2.8+Math.cos(i)*.1,Math.cos(a)*1.05);}
    door(g,1.33,p.door);window(g,-.75,1,1.11);window(g,.75,1,1.11);
    for(let i=0;i<5;i++)round(g,.43,.12,.9,i%2?ivory:'#789e78',-.86+i*.43,1.68,1.7).rotation.x=.16;
    for(const x of [-1,1]){round(g,.65,.43,.55,wood,x,.35,1.85);for(let n=0;n<3;n++)ball(g,.12,.12,.12,x<0?'#e9a154':'#a3bd6b',x-.18+n*.18,.64,1.85);}height=3.5;
  }else if(style==='archivist'){
    cylinder(g,1.45,2.5,'#aa8765',0,1.35,0,1.25);roofCap(g,1.85,1.45,p.roof,0,2.58,0);
    for(let i=0;i<9;i++){const a=i/9*Math.PI*2;line(g,[Math.sin(a)*1.43,.22,Math.cos(a)*1.43],[Math.sin(a)*1.24,2.5,Math.cos(a)*1.24],.055,wood);}
    door(g,1.42,p.door);window(g,-.72,1.95,1.12);window(g,.72,1.95,1.12);shelves(g,-1.65,.75,.65);shelves(g,1.65,.75,.65);
    const scroll=round(g,.85,.35,.13,ivory,0,2.53,1.26);for(const x of [-.46,.46])cylinder(g,.09,.44,gold,x,2.53,1.28);ivy(g,1.1,1.04);height=4.3;
  }else{
    h=style==='mayor'?2.3:1.85;
    round(g,2.7,h,2.3,wall,0,h/2+.13,0,.25);roofGable(g,3.1,1.3,2.65,p.roof,h+.12);
    for(const x of [-1.25,1.25])round(g,.13,h,.13,timber,x,h/2+.13,1.17);
    for(const y of [.45,1.65])round(g,2.7,.1,.12,timber,0,y,1.2);
    // Deep timber ribs on a plain roof; shingle rows (when the kit has loaded) replace them.
    if(!shingles('gable'))for(const side of [-1,1])for(let n=0;n<5;n++){const rib=round(g,.12,1.8,.1,timber,side*.72,h+.7,-1.2+n*.6);rib.rotation.z=side*-.87;}
    door(g,1.2,p.door);window(g,-.85,1.05,1.2);window(g,.85,1.05,1.2);
    if(style==='mayor'){
      for(const x of [-1.35,1.35]){cylinder(g,.46,2.8,wall,x,1.45,-.65);roofCap(g,.7,1.45,p.roof,x,2.85,-.65);crystal(g,x,4.35,-.65,'#ffe7aa',.12);}
      cylinder(g,.61,1.25,wall,0,3.3,0);roofCap(g,.85,1.4,p.roof,0,3.94,0);
      const clock=cylinder(g,.27,.09,ivory,0,3.45,.65);clock.rotation.x=Math.PI/2;line(g,[0,3.45,.71],[0,3.63,.71],.02,wood);line(g,[0,3.45,.71],[.15,3.4,.71],.02,wood);
      cylinder(g,.035,.6,gold,0,5.55,0);round(g,.55,.25,.045,'#e9b86d',.27,5.7,0);height=6;
    }else if(style==='builder'){
      round(g,.65,1.5,.65,'#987c70',1.05,2.72,-.3);cap(g,.5,.28,wood,1.05,3.47,-.3);smokeFrom(g,1.05,3.8,-.3);
      const forge=round(g,.65,.5,.06,'#fbb46c',1.35,.7,1.19);forge.material=glow('#ffb568');
      round(g,1.1,.16,.65,wood,-1.5,.75,1.1);for(const x of [-1.9,-1.1])round(g,.1,.65,.1,wood,x,.4,1.1);
      ring(g,.32,.08,gold,0,2.5,1.4);for(let n=0;n<8;n++){const a=n*Math.PI/4;round(g,.13,.2,.1,gold,Math.cos(a)*.36,2.5+Math.sin(a)*.36,1.4).rotation.z=a;}height=3.9;
    }else if(style==='critic'){
      cylinder(g,.55,2.3,wall,-1.35,1.23,-.5);roofCap(g,.75,1.65,p.roof,-1.35,2.4,-.5);
      round(g,.85,1,.12,wood,-1.65,.8,1.1);round(g,.7,.8,.04,ivory,-1.65,.8,1.19);
      for(let n=0;n<3;n++){crystal(g,-1.88,.58+n*.2,1.23,p.outfit,.04);round(g,.32,.025,.03,wood,-1.57,.58+n*.2,1.23);}height=4.35;
    }else if(style==='operator'){
      roofCap(g,.7,1.3,p.roof,1.12,2.8,-.55);cylinder(g,.055,1.25,gold,1.12,4.15,-.55);
      const orb=ball(g,.27,.27,.27,'#9edee2',1.12,4.7,-.55);orb.material=glow('#9edee2');ring(g,.43,.025,gold,1.12,4.7,-.55).rotation.y=.6;
      for(let n=0;n<3;n++){round(g,.55,.48,.5,'#bf9562',-1.65,.32+n*.43,.5);round(g,.08,.49,.51,ivory,-1.65,.32+n*.43,.5);}height=5.2;
    }
  }
  backFacade(g,style,timber,h);
  // No decor list keeps the classic trim (lantern, ivy, back flower boxes, a chimney); a list, even empty, draws exactly what it names.
  if(Array.isArray(p.decor))decorate(g,style,p);else{lantern(g,.61,1.4,1.65);ivy(g,-.98,1.19);flowerbox(g,-1.1,-1.55);flowerbox(g,1.1,-1.55);chimney(g,...chimneySpot(SPOTS[style]||cottage(1.85),p.back));}
  g.userData.life=houseLife(g);
  g.userData.height=height;return g;
}

// Recolourable parts get their own materials: fur, outfit and eye materials are otherwise shared by every cat.
function tagColourSlots(root,palette){
  const slots=[['fur',material(palette.fur)],['outfit',material(palette.outfit)]];
  root.traverse(o=>{
    if(!o.isMesh)return;
    const role=o.name==='eyeL'||o.name==='eyeR'?'eyes':slots.find(([,m])=>m===o.material)?.[0];
    if(!role)return;
    o.material=o.material.clone();o.userData.appearanceRole=role;
  });
}
// Applies a resolved look ({fur,outfit,eyes}) to tagged parts only. The Mayor GLB has no tags, so it stays as modelled.
export function applyAppearance(actor,look={}){
  actor.traverse(o=>{const role=o.userData.appearanceRole;if(role&&look[role])o.material.color.set(look[role]);});
  return actor;
}

export function makeAnimatedCat(style,palette){
  const source=makeCat(style,palette,false),eyes=[];
  source.traverse(o=>{if(o.name==='eyeL'||o.name==='eyeR')eyes.push(o);});eyes.forEach(o=>source.remove(o));
  const actor=new T.Group(),body=new T.Group();actor.add(body);body.add(compact(source));eyes.forEach(o=>body.add(o));
  tagColourSlots(body,palette);
  const parts={body,eyes};
  for(const [side,x] of [['L',-.58],['R',.58]]){
    const arm=new T.Group();arm.position.set(x,.83,.38);body.add(arm);ball(arm,.17,.22,.19,style==='scholar'?palette.patch:palette.cream,0,-.18,.02);parts['arm'+side]=arm;
    const foot=new T.Group();foot.position.set(x*.58,.21,.19);actor.add(foot);ball(foot,.18,.11,.22,palette.cream,0,-.1,.04);parts['foot'+side]=foot;
  }
  const mouth=ball(body,.038,.047,.02,dark,0,1.06,.603);mouth.visible=false;parts.mouth=mouth;
  actor.userData.parts=parts;return actor;
}

export function makeWildflower(seed){
  const g=new T.Group();if(seed%3===0){cylinder(g,.045,.25,ivory,0,.12,0);ball(g,.2,.09,.18,'#d99a88',0,.3,0);for(const x of [-.07,.07])ball(g,.04,.02,.04,ivory,x,.38,.02);}
  else{cylinder(g,.018,.35,'#6b9155',0,.17,0);for(let n=0;n<5;n++){const a=n*Math.PI*2/5;ball(g,.07,.045,.07,seed%2?'#f1cf7b':'#c9b4df',Math.sin(a)*.08,.36,Math.cos(a)*.08);}ball(g,.04,.04,.04,'#fff1bf',0,.39,0);}return g;
}

// ---------------------------------------------------------------- meadow props (instanced)
// Each prop is ONE vertex-coloured geometry, so a whole streamed area of oaks (or reeds, or tufts) is one InstancedMesh.
const painted=(geo,color,top)=>{
  for(const k of Object.keys(geo.attributes))if(k!=='position'&&k!=='normal')geo.deleteAttribute(k);
  const p=geo.attributes.position,a=new T.Color(color),b=new T.Color(top||color),col=new Float32Array(p.count*3);
  geo.computeBoundingBox();const {min,max}=geo.boundingBox,span=max.y-min.y||1;
  for(let i=0;i<p.count;i++)a.clone().lerp(b,(p.getY(i)-min.y)/span).toArray(col,i*3);
  geo.setAttribute('color',new T.BufferAttribute(col,3));return geo;
};
const blob=(r,x,y,z,sy=1,color='#7fa86a',top='#a3c47f')=>painted(new T.SphereGeometry(r,r>.7?9:7,r>.7?6:5).scale(1,sy,1).translate(x,y,z),color,top);
const trunk=(r,h,color='#8a6446')=>painted(new T.CylinderGeometry(r*.7,r,h,7).translate(0,h/2,0),color,color);
function rounded(r,h,y,color,top){
  const pts=[[0,0],[r*.92,.04*h],[r,.16*h],[r*.7,.5*h],[r*.3,.85*h],[0,h]].map(p=>new T.Vector2(...p));
  return painted(new T.LatheGeometry(pts,9).translate(0,y,0),color,top);
}
let props=null;
/** Shared prop geometries: tree variants (oak, pine, birch, blossom), bush, rock, reed clump, two wildflower clumps, grass tuft. */
export function propGeometries(){
  if(props)return props;
  // Props stay indexed (painted keeps the index): instanced across the whole streamed land, a de-indexed tree ran its
  // vertex shader 5x per corner and trees cost more than everything else on the GPU. Lists that mix in an unindexed
  // piece (blades, polyhedra) are merged unindexed.
  const m=list=>mergeGeometries(list.some(g=>!g.index)?list.map(g=>g.index?g.toNonIndexed():g):list);
  // Foliage normals: every leaf of a crown faces out from the crown's middle (a little more upward, as a flattened
  // dome), so the light rolls round the crown as one soft mass instead of shading each faceted blob on its own.
  const crown=list=>{const box=new T.Box3(),c=new T.Vector3(),d=new T.Vector3();for(const g of list){g.computeBoundingBox();box.union(g.boundingBox);}box.getCenter(c);c.y-=(box.max.y-box.min.y)*.15;
    for(const g of list){const p=g.attributes.position,n=g.attributes.normal;for(let i=0;i<p.count;i++){d.fromBufferAttribute(p,i).sub(c);d.y*=1.3;d.normalize();n.setXYZ(i,d.x,d.y,d.z);}}return list;};
  const oak=m([trunk(.2,1.5),...crown([blob(1.05,0,2.15,0,.92,'#6f9a5e','#93b873'),blob(.78,.62,1.95,.25,.9,'#78a263','#9ec27c'),blob(.72,-.5,2.05,-.32,.9,'#6d955c','#8fb46f'),blob(.62,.1,2.75,-.1,.95,'#86ad6b','#b0cf88')])]);
  const pine=m([trunk(.16,1.1,'#7b5a40'),rounded(1.25,1.5,.75,'#4f7d57','#5f8e60'),rounded(1,1.35,1.55,'#557f58','#6a9965'),rounded(.68,1.2,2.35,'#5e8a5d','#7aa66d')]);
  const birch=m([trunk(.13,2,'#ece5d3'),...crown([blob(.75,0,2.5,0,1.55,'#93b56a','#bcd889'),blob(.5,.35,2.1,.2,1.2,'#9cbd70','#c3dc91')])]);
  const blossom=m([trunk(.17,1.2,'#7d5a46'),...crown([blob(.9,0,1.85,0,.85,'#e9b1bd','#f7d3da'),blob(.62,.55,1.7,.2,.85,'#eab8c3','#f8dce1'),blob(.58,-.42,1.8,-.25,.85,'#e3a9b6','#f3cdd4')])]);
  const bush=m(crown([blob(.62,0,.42,0,.75,'#5f8d5d','#86ad6c'),blob(.48,.5,.34,.15,.75,'#679562','#8fb573'),blob(.44,-.42,.32,-.12,.75,'#5d8a5a','#7fa86a')]));
  const rock=painted(new T.DodecahedronGeometry(.6,0).scale(1,.62,.85).translate(0,.18,0),'#8f8b80','#b9b4a6');
  const blade=(a,h,lean,color,top)=>{const c=Math.cos(a),s=Math.sin(a),w=.05;return painted(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute([-w*c,0,-w*s,w*c,0,w*s,lean*c,h,lean*s],3)).setAttribute('normal',new T.Float32BufferAttribute([0,1,0,0,1,0,0,1,0],3)),color,top);};
  const reed=m([...[0,1,2,3,4,5].map(n=>blade(n*1.05,1.1+(n%3)*.3,.12*(n%2?1:-1),'#6f8a4c','#b2c47a')),painted(new T.CylinderGeometry(.045,.045,.28,5).translate(.05,1.35,0),'#7a5233','#8d6240'),painted(new T.CylinderGeometry(.04,.04,.24,5).translate(-.12,1.15,.06),'#7a5233','#8d6240')]);
  // A clump of three blooms: a stem blade and a squashed octahedron head each (about 30 triangles for the clump).
  const flower=(petal,centre)=>m([0,1,2].flatMap(n=>{const a=n*2.1,x=Math.cos(a)*.13,z=Math.sin(a)*.13,h=.26+n*.05;return [blade(a,h,0,'#5f8a4e','#7aa25f').translate(x,0,z),painted(new T.OctahedronGeometry(.085,0).scale(1,.5,1).translate(x,h,z),petal,centre)];}));
  // Grass clump: five soft, chunky leaves (open cones flattened into blades) leaning out from the centre, dark at the base
  // and light at the tips like the painted ground under them. 20 triangles; radius about 0.17 m, inside TUFT_RADIUS (0.24 m).
  const leaf=(a,h,lean)=>{const g=new T.ConeGeometry(.1,h*1.3,4,1,true).translate(0,h*.65,0).scale(1.5,1,.55);g.rotateZ(-lean);g.rotateY(a);return painted(g,'#6f9650','#adc77f');};
  // Its normals point straight up, so a clump takes the light like the ground under it instead of as five lit facets.
  const tuft=m([0,1,2,3,4].map(n=>leaf(n*1.257+(n%2)*.3,.2+(n*37%5)*.03,.32+(n%3)*.08)));{const n=tuft.attributes.normal;for(let i=0;i<n.count;i++)n.setXYZ(i,0,1,0);}
  // Odds and ends of the wild (vegetation.js DECOR), all low: mushrooms 0.3 m, a stump 0.4 m, a log 0.45 m, a cairn and a
  // broken fence end 0.8 m. Each is one geometry, so each kind is one draw for the whole streamed land.
  const cap=(r,x,h,z,color)=>[painted(new T.CylinderGeometry(r*.32,r*.42,h,6).translate(x,h/2,z),'#e9dfc6','#f4ecd8'),painted(new T.SphereGeometry(r,8,4,0,Math.PI*2,0,Math.PI/2).scale(1,.62,1).translate(x,h*.92,z),'#f1e3c4',color)];
  const mushrooms=m([...cap(.11,0,.2,0,'#c45a45'),...cap(.075,.16,.13,.06,'#cf6a52'),...cap(.06,-.1,.1,.12,'#d9a271'),blob(.09,-.05,.02,-.1,.5,'#6f9a5e','#93b873')]);
  const stump=m([painted(new T.CylinderGeometry(.27,.36,.38,9).translate(0,.19,0),'#6f5039','#9a7451'),painted(new T.CylinderGeometry(.23,.23,.02,9).translate(0,.385,0),'#d9bd8e','#e6cfa3'),...cap(.06,.3,.08,.05,'#d9a271')]);
  const log=m([painted(new T.CylinderGeometry(.21,.24,1.9,9).rotateZ(Math.PI/2).translate(0,.22,0),'#6b5646','#927a60'),painted(new T.CylinderGeometry(.18,.18,.03,9).rotateZ(Math.PI/2).translate(.96,.22,0),'#d3b585','#e3c99b'),
    blob(.2,-.35,.4,0,.45,'#6f9a5e','#9ec27c'),blob(.13,.3,.42,.04,.45,'#78a263','#a3c47f')]);
  const stone=(r,y,sy,a)=>painted(new T.DodecahedronGeometry(r,0).scale(1,sy,1).rotateY(a).translate(0,y,0),'#8f8b80','#c3beb0');
  const cairn=m([stone(.36,.12,.45,0),stone(.27,.36,.5,.7),stone(.2,.55,.55,1.9),stone(.12,.71,.6,.4)]);
  const board=(w,h,d,x,y,z,rz=0)=>painted(new T.BoxGeometry(w,h,d).rotateZ(rz).translate(x,y,z),'#7a5a40','#a6825e');
  const fence=m([board(.11,.8,.11,-.6,.4,0,.06),board(.11,.62,.11,.62,.31,0,-.12),board(1.35,.09,.05,0,.6,.06,.03),board(1.2,.09,.05,.1,.3,.06,-.22),board(1.1,.05,.09,.15,.03,.38).rotateY(.35)]);
  props={trees:[oak,pine,birch,blossom],bush,rock,reed,flowers:[flower('#f6efe0','#f1cf6b'),flower('#c9b4df','#fff1bf')],tuft,mushrooms,stumps:stump,logs:log,cairns:cairn,fences:fence};
  return props;
}
/** Wind for grass, reeds and flowers: one time uniform; sway grows with height above the prop's base. */
export const wind={uTime:{value:0},uStrength:{value:1}};
const windy=new Map();
export function propMaterial({sway=0,side=T.FrontSide,flat=false}={}){
  const key=sway+':'+side+':'+flat;if(windy.has(key))return windy.get(key);
  const m=new T.MeshStandardMaterial({vertexColors:true,roughness:.95,side,flatShading:flat});
  if(sway){
    m.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,wind);
      shader.vertexShader='uniform float uTime,uStrength;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        vec3 windAt=vec3(0.);
        #ifdef USE_INSTANCING
        windAt=instanceMatrix[3].xyz;
        #endif
        float windSway=(sin(uTime*1.6+windAt.x*.31+windAt.z*.23)*.6+sin(uTime*2.7+windAt.x*.9-windAt.z*.4)*.25)*uStrength*${sway.toFixed(3)};
        transformed.x+=windSway*position.y*position.y;transformed.z+=windSway*.5*position.y*position.y;`);
    };
    m.customProgramCacheKey=()=>'prop-wind-'+key;
  }
  windy.set(key,m);return m;
}

export function makePlaza(){
  const g=new T.Group();cylinder(g,2.7,.12,'#ded6bd');cylinder(g,1.8,.2,'#b9a9c0',0,.16,0);cylinder(g,1.55,.15,'#e1d4c7',0,.32,0);
  round(g,2.05,1.3,1.25,'#766387',0,1.05,0,.2);round(g,2.12,.42,1.32,'#ad91b9',0,1.86,0,.2);
  for(const x of [-.75,.75]){round(g,.13,1.5,1.4,gold,x,1.2,0,.04);ball(g,.12,.12,.12,gold,x,1.98,.53);}
  round(g,.4,.45,.12,gold,0,1.46,.69,.05);ball(g,.12,.15,.05,'#6a516b',0,1.47,.77);
  const crystal=mesh(g,geometry('treasury-crystal',()=>new T.OctahedronGeometry(.44)),'#a9e9dc',0,2.5,0);crystal.material=glow('#a9e9dc');crystal.rotation.z=.2;
  for(const x of [-2,2]){cylinder(g,.14,1.15,gold,x,.7,0);ball(g,.23,.28,.23,'#ffe3a3',x,1.4,0).material=glow('#ffe3a3');}
  // Square dressing round the vault: two planters at its sides, and a small market stall with crates on its west side,
  // turned to the fountain (the vault stands .45 of the way out from the fountain at -z; the lamp and bench stand further
  // out at the plaza's edge). Baked with the vault: no extra draws.
  const planter=(x,z)=>{round(g,1.1,.5,.7,'#c9b79c',x,.25,z,.08);round(g,.98,.08,.58,'#7a5a40',x,.5,z,.03);for(let i=-1;i<=1;i++){ball(g,.26,.22,.24,i?'#78a263':'#6d955c',x+i*.3,.66,z);ball(g,.09,.08,.08,i?'#f1cf7b':'#e5a9b6',x+i*.3+.06,.86,z+.08);}};
  planter(-3.4,.2);planter(3.4,.2);
  const stall=new T.Group();stall.position.set(-5.4,0,-1.2);stall.rotation.y=2.16;g.add(stall);
  for(const [x,z] of [[-.9,-.5],[.9,-.5],[-.9,.5],[.9,.5]])cylinder(stall,.05,1.9,wood,x,.95,z);
  round(stall,2,.75,.8,'#a77f59',0,.42,.1,.06);round(stall,2.1,.08,.9,'#c79a6c',0,.82,.1,.03);
  for(let i=0;i<6;i++){const s=round(stall,.37,.05,1.25,i%2?'#f4ead8':'#c8655a',-.92+i*.37,2,-.02,.02);s.rotation.x=-.32;}
  for(const [x,c] of [[-.6,'#e0a04f'],[0,'#b8cf7a'],[.6,'#d86a55']])ball(stall,.2,.12,.2,c,x,.94,.25);
  const crate=(x,z,s,ry,y=0)=>{const c=round(g,.55*s,.5*s,.55*s,'#a07650',x,y+.25*s,z,.05);c.rotation.y=ry;const top=round(g,.5*s,.04,.5*s,'#7b5a40',x,y+.5*s+.01,z,.02);top.rotation.y=ry;};
  crate(-6.3,-2.5,1,.3);crate(-6.9,-1.8,.85,-.2);crate(-6.35,-2.35,.7,.6,.52);
  return g;
}

/** The town's street lamp, baked once: a stone foot, a dark post with a bracket arm, and the houses' own lantern() hanging
 *  from it. {solid, glow, head: the lantern's middle [x, y, z], materials} for town-ground.js buildLamps (instanced). */
let lampBake=null;
export function streetLamp(){
  if(lampBake)return lampBake;
  const g=new T.Group(),post='#4f4339';cylinder(g,.17,.14,'#bba68d',0,.07,0);cylinder(g,.06,2.05,post,0,1.1,0,.045);ball(g,.08,.08,.08,post,0,2.16,0);
  round(g,.52,.06,.07,post,.22,2.06,0,.02);lantern(g,.42,1.72,0);
  // Own material objects (same programs as the hamlet bakes): one material drawn both instanced (lamps) and plain (the
  // hamlets) makes three re-derive its program on every switch, each frame (getParameters in a CPU profile).
  const baked=glowBaked(),glass=new T.MeshStandardMaterial({vertexColors:true,emissive:'#ffffff',emissiveIntensity:baked.emissiveIntensity,roughness:.55});
  glass.onBeforeCompile=baked.onBeforeCompile;glass.customProgramCacheKey=baked.customProgramCacheKey;glows.set('lamp-glass',glass);
  return lampBake={...bake(g),head:[.42,1.72,0],materials:{solid:new T.MeshStandardMaterial({vertexColors:true,roughness:.9}),glow:glass}};
}
export function makeStreetCorner(){
  const g=new T.Group();cylinder(g,.22,.16,'#bba68d',0,.08,0);cylinder(g,.07,1.6,wood,0,.9,0);lantern(g,0,1.8,0);
  return g;
}
/** A park bench at x,z on parent. Shared by house gardens and site plazas. */
export function makeBench(parent,x,z,yaw=0){
  const b=new T.Group();b.position.set(x,0,z);b.rotation.y=yaw;parent.add(b);
  round(b,.85,.12,.4,wood,0,.52,0);round(b,.85,.42,.1,wood,0,.78,-.15);
  for(const dx of [-.3,.3])round(b,.1,.45,.3,'#6b6251',dx,.24,0);
  return b;
}
/** The Town Archive's notice board at x,z on parent, face to local +z: a framed cork board on stone-footed posts under a
 *  little gable roof, pinned notes in five colours and a glowing ▤ plaque, crystal finials on the ridge (the glow half,
 *  like a house's windows). Sized by BOARD; about 1,400 triangles, baked into the plaza like the bench. */
export function makeNoticeBoard(parent,x,z,yaw=0){
  const b=new T.Group(),{half,top,face}=BOARD,roofTone='#8a6f96',slope=.55,eave=.56;b.position.set(x,0,z);b.rotation.y=yaw;parent.add(b);
  for(const dx of [-1,1]){round(b,.3,.18,.3,'#bba68d',dx,.09,0);cylinder(b,.09,top-.15,wood,dx,(top-.15)/2,0);crystal(b,dx*(half-.08),top+.16,0,'#ffe7aa',.1);}
  round(b,2.2,1.5,.14,'#7a5a3f',0,face,0,.05);round(b,1.96,1.26,.06,'#d8c29a',0,face,.06,.03);
  // Notes: x, y above the face's middle, width, height, colour, tilt; each with a red pin near its top.
  for(const [nx,ny,w,h,color,tilt] of [[-.62,.2,.42,.5,'#fff3d6',.06],[-.1,.24,.38,.44,'#f3c3cc',-.05],[.52,.18,.5,.36,'#bcd7e8',.04],[-.5,-.3,.46,.36,'#cfe3b4',-.07],[.06,-.28,.4,.48,'#f6dc8f',.05],[.6,-.26,.36,.42,'#fff3d6',-.04]]){
    round(b,w,h,.02,color,nx,face+ny,.1,.01).rotation.z=tilt;ball(b,.035,.035,.03,'#c9574a',nx,face+ny+h/2-.07,.12);}
  // Gable roof: two planks sloping front and back from a gold ridge. The ▤ plaque glows on the front slope, where the
  // town's high camera sees it (under the eave it would be hidden).
  for(const side of [-1,1]){const plank=round(b,half*2,.08,eave,roofTone,0,top-.1-Math.sin(slope)*eave/2,side*Math.cos(slope)*eave/2,.03);plank.rotation.x=side*slope;
    if(side>0){round(plank,.44,.03,.38,gold,0,.05,0,.01).material=glow('#ffcf7a');for(const dz of [-.1,0,.1])round(plank,.3,.03,.045,'#6a516b',0,.07,dz,.01);}}
  round(b,half*2+.08,.1,.12,gold,0,top-.06,0,.04);
  return b;
}
/** The Mayor's square fountain at x,z on parent: the stone only (baked into the plaza like the bench), turned on a
 *  lathe so the basin, pedestal and bowl read round. Its water is makeFountainWater, drawn apart because it moves. */
const lathe=(key,pts,segments=40)=>geometry('fountain:'+key,()=>new T.LatheGeometry(pts.map(([r,y])=>new T.Vector2(r,y)),segments));
export function makeFountain(parent,x,z){
  const f=new T.Group(),r=FOUNTAIN.r;f.position.set(x,0,z);parent.add(f);
  mesh(f,lathe('basin',[[0,0],[r+.32,0],[r+.32,.1],[r+.06,.13],[r,.2],[r,.62],[r-.3,.62],[r-.3,.42],[0,.42]]),'#ad9a7d');
  mesh(f,geometry('fountain:coping',()=>new T.TorusGeometry(r-.15,.12,8,48).rotateX(Math.PI/2)),'#cdbd9f').position.y=.66;
  mesh(f,lathe('pedestal',[[0,.42],[.46,.42],[.46,.52],[.32,.6],[.25,.86],[.22,1.18],[.3,1.28],[.3,1.34],[.2,1.42],[0,1.42]],20),'#bba68d');
  mesh(f,lathe('bowl',[[0,1.36],[.24,1.38],[.6,1.48],[.9,1.62],[1.02,1.76],[1,1.8],[.9,1.72],[0,1.7]]),'#c4b194');
  mesh(f,lathe('finial',[[0,1.7],[.14,1.7],[.1,1.8],[.07,1.96],[.13,2.03],[.12,2.1],[.05,2.14],[0,2.14]],14),'#bba68d');
  return f;
}
// The fountain's moving water. One clock (wind.uTime, held at 0 under reduced motion) and every motion in the shaders:
// no per-frame JS. Pools use the river's water shader (ripples, glint, foam where `depth` nears 0: their rims, and the
// rings where water lands); the overflow curtain and the jet carry streaks that scroll down and up; droplets arc from
// the jet into the bowl. Heights match makeFountain's lathe profiles.
const FALL=`uniform float uTime;varying vec2 vFall;
float fHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
// Value noise that wraps every P cells across, so the streaks have no seam round the curtain.
float fNoise(vec2 p,float P){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);float a=mod(i.x,P),b=mod(i.x+1.,P);
  return mix(mix(fHash(vec2(a,i.y)),fHash(vec2(b,i.y)),u.x),mix(fHash(vec2(a,i.y+1.)),fHash(vec2(b,i.y+1.)),u.x),u.y);}`;
/** Streaked falling (speed > 0) or rising (speed < 0) water. fade: GLSL for the alpha falloff along y (object space). */
function streakWater(speed,fade,opacity){
  const m=new T.MeshStandardMaterial({color:'#dcf0f5',roughness:.12,metalness:0,transparent:true,opacity,side:T.DoubleSide,depthWrite:false});
  m.onBeforeCompile=shader=>{
    shader.uniforms.uTime=wind.uTime;
    shader.vertexShader='varying vec2 vFall;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvFall=vec2(atan(position.z,position.x)/6.2831853+.5,position.y);');
    shader.fragmentShader=FALL+'\n'+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
  float fs=fNoise(vec2(vFall.x*72.,vFall.y*5.+uTime*${speed.toFixed(2)}),72.)*.6+fNoise(vec2(vFall.x*150.,vFall.y*11.+uTime*${(speed*1.7).toFixed(2)}),150.)*.4;
  diffuseColor.rgb=mix(diffuseColor.rgb*.82,vec3(1.),smoothstep(.55,.9,fs)*.6);
  diffuseColor.a*=mix(.3,1.,smoothstep(.3,.7,fs))*(${fade});`);
  };
  m.customProgramCacheKey=()=>'fountain-streak:'+speed+':'+fade;
  return m;
}
/** A flat pool on a lathe of radii (finer where foam lies) with the river shader's per-vertex `depth`. */
function pool(radii,depthAt,y,bed){
  const g=new T.LatheGeometry(radii.map(r=>new T.Vector2(r,0)),48).translate(0,y,0),pos=g.attributes.position,d=new Float32Array(pos.count);
  for(let i=0;i<pos.count;i++)d[i]=depthAt(Math.hypot(pos.getX(i),pos.getZ(i)));
  g.setAttribute('depth',new T.BufferAttribute(d,1));
  const water=createWaterMaterial(wind.uTime,bed);water.material.side=T.DoubleSide;water.setTint('#4f9ab4');
  const m=new T.Mesh(g,water.material);m.receiveShadow=true;return m;
}
let fountainWater=null;
function fountainWaterParts(){
  if(fountainWater)return fountainWater;
  const r=FOUNTAIN.r,inner=r-.3,LAND=1.26,LIP=1.76,BASIN=.54,JET=.42,DROPS=72;
  // Basin: foam at the inner wall and where the curtain lands; the bowl: foam at the overflowing lip and the drops' ring.
  const basin=pool([.001,.5,.9,1.1,1.18,LAND-.03,LAND+.03,1.34,1.45,1.7,1.95,inner-.14,inner-.06,inner],x=>Math.min(.5,(inner-x)*.9,Math.abs(x-LAND)*.55+.01),BASIN,.5);
  const bowl=pool([.001,.3,.5,.56,.62,.68,.8,.88,.95],x=>Math.min(.3,(.95-x)*.7,Math.abs(x-.6)*.5+.01),LIP-.02,.3);
  // The overflow sheet leaves the lip level and falls on a parabola: its reach grows with the square root of the drop.
  const fall=LIP-BASIN,curtain=new T.Mesh(new T.LatheGeometry(Array.from({length:13},(_,i)=>{const d=fall*(1-i/12);return new T.Vector2(1.01+(LAND-1.01)*Math.sqrt(d/fall),LIP-d);}),56,0,Math.PI*2),streakWater(2.2,`smoothstep(${BASIN.toFixed(2)},${(BASIN+.1).toFixed(2)},vFall.y)`,.62));
  const jet=new T.Mesh(new T.CylinderGeometry(.045,.08,JET,10,1,true).translate(0,2.14+JET/2,0),streakWater(-3.4,`smoothstep(${(2.14+JET).toFixed(2)},${(2.14+JET*.55).toFixed(2)},vFall.y)`,.7));
  // Droplets: one instanced bead, each on its own arc from the jet's top into the bowl (about .46 s of flight).
  const drop=new T.InstancedBufferGeometry().copy(new T.IcosahedronGeometry(.055,0)),seed=new Float32Array(DROPS*3);
  for(let i=0;i<DROPS;i++)seed.set([(i*.618)%1,i/DROPS*Math.PI*2+((i*.37)%1)*.4,1.15+((i*.53)%1)*.35],i*3);
  drop.setAttribute('aSeed',new T.InstancedBufferAttribute(seed,3));drop.instanceCount=DROPS;
  drop.boundingSphere=new T.Sphere(new T.Vector3(0,2.2,0),1.2);
  const beads=new T.MeshStandardMaterial({color:'#e6f5f9',roughness:.1,transparent:true,opacity:.85,depthWrite:false});
  beads.onBeforeCompile=shader=>{
    shader.uniforms.uTime=wind.uTime;
    shader.vertexShader='attribute vec3 aSeed;uniform float uTime;\n'+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
  float ft=fract(uTime*2.2+aSeed.x),tt=ft*.455;
  transformed*=1.-.45*ft;
  transformed+=vec3(cos(aSeed.y)*aSeed.z*tt,${(2.14+JET).toFixed(2)}+.5*tt-4.9*tt*tt,sin(aSeed.y)*aSeed.z*tt);`);
  };
  beads.customProgramCacheKey=()=>'fountain-beads';
  fountainWater=[basin,bowl,curtain,jet,new T.Mesh(drop,beads)];
  return fountainWater;
}
/** The fountain's water at x,y,z (y: the plaza's ground height). Geometry and materials are shared and never disposed. */
export function makeFountainWater(x,y,z){
  const g=new T.Group();g.position.set(x,y,z);
  for(const part of fountainWaterParts()){const m=part.clone();m.castShadow=false;g.add(m);}
  return g;
}
export function makeGarden(){
  const g=new T.Group();
  for(const x of [-2.7,2.7]){round(g,.48,.32,1.9,'#a99275',x,.18,-.2,.08);for(let n=0;n<5;n++)ball(g,.32,.25,.31,n%2?'#9bb682':'#6f996b',x,.5,-.9+n*.35);}
  // A bench and mailbox leave the front path clear for visiting cats.
  makeBench(g,-1.8,2.2);
  cylinder(g,.05,.65,wood,2.1,.4,2.4);round(g,.36,.28,.3,'#a3b6aa',2.1,.8,2.4);
  return g;
}

// Memorial: a little stone observatory under a periwinkle dome, inside a hedge ring that opens at the front under a
// flowered arch. A brass telescope pokes out of the dome's starlit slit; a star-chart mosaic lies on the path in front.
// Retired cats get a star lamp in rings around the tower (memorial.js stoneLayout). Front is local +z (the door).
// grounds = hedge radius in art units; the caller scales it. Baked into one solid and one glow mesh (two draws), the
// glow on its own material whose star stones and lamps twinkle in the shader (per-vertex phase, no per-frame JS).
const archGeo=(r,t)=>geometry(`arch:${r}:${t}`,()=>new T.TorusGeometry(r,t,6,18,Math.PI));
/** glowBaked plus a per-vertex twinkle phase (-1 = steady). Clocked by wind.uTime, which town.js holds at 0 under reduced
 *  motion; registered with the glows, so day and night still set its strength. */
function glowTwinkle(){
  if(glows.has('twinkle'))return glows.get('twinkle');
  const m=new T.MeshStandardMaterial({vertexColors:true,emissive:'#ffffff',emissiveIntensity:.18,roughness:.55});
  m.onBeforeCompile=shader=>{
    shader.uniforms.uTime=wind.uTime;
    shader.vertexShader='attribute float twinkle;varying float vTwinkle;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+String.fromCharCode(10)+'vTwinkle=twinkle;');
    shader.fragmentShader='uniform float uTime;varying float vTwinkle;'+String.fromCharCode(10)+shader.fragmentShader.replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
  #ifdef USE_COLOR
  totalEmissiveRadiance*=vColor.rgb;
  #endif
  if(vTwinkle>=0.)totalEmissiveRadiance*=.35+.65*(.5+.5*sin(uTime*2.1+vTwinkle))*(.8+.2*sin(uTime*5.3+vTwinkle*1.7));`);
  };
  m.customProgramCacheKey=()=>'glow-twinkle';glows.set('twinkle',m);return m;
}
const withTwinkle=(geo,phase)=>{geo.setAttribute('twinkle',new T.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(phase),1));return geo;};
const domeStrip=(key,r,phi,width,from=.12)=>geometry(key,()=>new T.SphereGeometry(r,2,9,phi-width/2,width,from,Math.PI/2-from));
const pickBox=new T.BoxGeometry(1,1,1),pickMaterial=new T.MeshBasicMaterial();
export function makeMemorial(count,grounds){
  const g=new T.Group(),twinkles=[],stones=stoneLayout(count);
  const stone='#d9d2c3',wall='#ece4d2',trim='#cfc4ad',dome='#a7a9d6',brass='#c99a52',light='#ffe2a8',starlight='#d6e4ff',night='#3e4a7c',hedge='#6f996b';
  // A star stone that twinkles: its own little group, baked with a phase of its own.
  const twinkle=(x,y,z,s,color='#fff0c2')=>{const t=new T.Group();crystal(t,x,y,z,color,s);twinkles.push(t);return t.children[0];};
  // Hedge ring, open at the front for the path.
  const rh=grounds-.45,gap=.24;
  for(let a=gap,n=0;a<=Math.PI*2-gap;a+=.6/rh,n++)ball(g,.42,.36,.4,n%2?'#9bb682':hedge,Math.sin(a)*rh,.3,Math.cos(a)*rh);
  // Flowered arch over the gap, lantern-topped posts either side, a little star hanging where a bell would be.
  const half=Math.sin(gap)*rh+.05;
  for(const x of [-half,half]){round(g,.34,1.9,.34,trim,x,.95,rh,.06);lantern(g,x,2.2,rh);}
  mesh(g,archGeo(half,.09),'#b9a37e',0,1.9,rh);
  for(let i=1;i<8;i++){const a=i/8*Math.PI;ball(g,.09,.07,.09,i%2?'#e9b1bd':'#f1cf7b',Math.cos(a)*half,1.9+Math.sin(a)*half,rh+.06);}
  line(g,[0,1.9+half,rh],[0,1.9+half-.4,rh],.02,wood);twinkle(0,1.9+half-.55,rh,.1);
  // Tower: stone plinth and step, a stone base course, a cream drum and a trim cornice.
  cylinder(g,2.5,.3,trim,0,.15,0);round(g,1.5,.16,.7,trim,0,.08,2.7,.04);
  cylinder(g,1.95,.36,stone,0,.48,0,1.88);cylinder(g,1.75,2.45,wall,0,1.88,0);cylinder(g,1.95,.22,trim,0,3.14,0,1.98);
  // Dome with brass ribs, a dark slit up the front and a thread of starlight inside it.
  mesh(g,geometry('obs-dome',()=>new T.SphereGeometry(1.8,18,9,0,Math.PI*2,0,Math.PI/2)),dome,0,3.2,0);
  for(const phi of [Math.PI/2+1.15,Math.PI/2+2.3,Math.PI/2-1.15,Math.PI/2-2.3,Math.PI*1.5])mesh(g,domeStrip(`obs-rib:${phi}`,1.815,phi,.05,0),brass,0,3.2,0);
  mesh(g,domeStrip('obs-slit',1.81,Math.PI/2,.36),night,0,3.2,0);
  mesh(g,domeStrip('obs-slit-light',1.825,Math.PI/2,.1),starlight,0,3.2,0).material=glow(starlight);
  for(const side of [-1,1])mesh(g,domeStrip(`obs-rail:${side}`,1.835,Math.PI/2+side*.2,.05),brass,0,3.2,0);
  // Brass telescope out of the slit, aimed up at the sky, its glass catching the light.
  const from=[-.1,3.85,.2],to=[.4,5.75,1.45],at=t=>from.map((v,i)=>v+(to[i]-v)*t);
  line(g,from,to,.2,brass);line(g,at(.86),at(1.04),.26,'#a97c3f');line(g,at(.4),at(.46),.24,'#a97c3f');line(g,at(-.08),at(.05),.11,'#a97c3f');
  const lens=ball(g,.19,.08,.19,starlight,...at(1.05));lens.rotation.set(-.45,0,-.25);lens.material=glow(starlight);
  // Finial: a little spire with a glowing crescent moon and a star beside it.
  cylinder(g,.09,.3,brass,0,5.12,0,.05);
  const moon=mesh(g,geometry('obs-moon',()=>new T.TorusGeometry(.3,.075,6,14,Math.PI*1.3)),'#ffe7a6',0,5.62,0);moon.rotation.z=Math.PI*.55;moon.material=glow('#ffe7a6');
  twinkle(.32,5.95,0,.08);
  // Small stars on the dome, away from the slit.
  for(const [phi,t] of [[Math.PI/2+.75,.85],[Math.PI/2-.8,1.05],[Math.PI/2+1.7,.6],[Math.PI/2-1.75,.7],[Math.PI*1.5,.9]])twinkle(-Math.cos(phi)*Math.sin(t)*1.86,3.2+Math.cos(t)*1.86,Math.sin(phi)*Math.sin(t)*1.86,.075);
  // Arched door with a star window above, portholes round the drum, lanterns on brackets beside the door.
  round(g,.9,1.5,.16,'#7a5a43',0,1.05,1.88,.06);mesh(g,archGeo(.46,.07),gold,0,1.8,1.95);ball(g,.05,.05,.04,gold,.27,1.05,1.98);
  const rose=cylinder(g,.25,.06,starlight,0,2.55,1.76);rose.rotation.x=Math.PI/2;rose.material=glow(starlight);ring(g,.26,.035,gold,0,2.55,1.79);
  for(const a of [-.95,.95,-2.05,2.05,Math.PI]){
    const x=Math.sin(a)*1.74,z=Math.cos(a)*1.74;round(g,.52,.66,.12,wood,x,2.05,z,.12).rotation.y=a;
    const pane=round(g,.4,.54,.1,light,x+Math.sin(a)*.04,2.05,z+Math.cos(a)*.04,.1);pane.rotation.y=a;pane.material=glow(light);
  }
  for(const x of [-.82,.82]){line(g,[x,2.42,1.5],[x,2.42,2.05],.03,wood);lantern(g,x,2.05,2.05);}
  // Star-chart mosaic on the path: a night-blue disc in a brass ring, a little cat constellation picked out in brass,
  // and star stones that twinkle.
  const mz=4.1;cylinder(g,1.1,.12,night,0,.06,mz);ring(g,1.06,.045,brass,0,.12,mz).rotation.x=Math.PI/2;
  const chart=[[-.55,.35],[-.42,.68],[-.25,.42],[.1,.46],[.5,.18],[.42,-.3],[-.12,-.45],[-.5,-.15]].map(([x,z])=>[x*1.05,z*1.05+mz]);
  chart.forEach(([x,z],i)=>{const [nx,nz]=chart[(i+1)%chart.length];line(g,[x,.13,z],[nx,.13,nz],.02,brass);twinkle(x,.15,z,.08).scale.set(.08,.05,.08);});
  for(let i=0;i<12;i++){const a=i/12*Math.PI*2,x=Math.sin(a)*1.32,z=mz+Math.cos(a)*1.32;if(z>3.2)twinkle(x,.1,z,.07).scale.set(.07,.04,.07);}
  // Flowers around the plinth, clear of the door.
  for(let i=0;i<9;i++){const a=Math.PI*.3+i/8*Math.PI*1.4,f=makeWildflower(i);f.position.set(Math.sin(a)*2.75,0,Math.cos(a)*2.75);g.add(f);}
  for(const x of [-1.25,1.25])flowerbox(g,x,2.35);
  // A star lamp per retired cat: a stone foot, a slim post and a twinkling star.
  for(const {x,z} of stones){round(g,.26,.16,.26,stone,x,.08,z,.05);cylinder(g,.045,.85,'#6d6476',x,.58,z);twinkle(x,1.03,z,.12).rotation.y=Math.atan2(x,z);}
  // One solid mesh and one glow mesh; the glow carries each star's phase (golden-angle steps, so neighbours differ).
  const main=bake(g),lit=[withTwinkle(main.glow,-1),...twinkles.map((t,i)=>withTwinkle(bake(t).glow,(i*2.39996)%(Math.PI*2)))];
  const out=new T.Group(),glowGeo=mergeGeometries(lit);lit.forEach(geo=>geo.dispose());
  for(const [geo,mat] of [[main.solid,bakedMaterial],[glowGeo,glowTwinkle()]]){const m=new T.Mesh(geo,mat);m.castShadow=true;m.receiveShadow=true;m.userData.ownedGeometry=true;out.add(m);}
  // Invisible click target over the tower and telescope (raycasts ignore visibility); town.js adds it under the art.
  const pick=new T.Mesh(pickBox,pickMaterial);pick.visible=false;pick.scale.set(4.6,6.2,4.6);pick.position.y=3.1;
  return {group:out,stones,pick};
}

// ---------------------------------------------------------------- cat kit runtime
// public/assets/cat-kit.glb: clone one base per cat, recolour it from vertex masks, attach costume parts.
// Geometry is shared by every clone; each cat owns only the few materials it recolours.

export const EXPRESSIONS={happy:'Happy',curious:'Curious',sleepy:'Sleepy'};
const MARKING_USE={solid:[0,0,0,0],tuxedo:[1,0,0,0],tabby:[0,1,0,0],calico:[0,0,1,1]};
const PINK='#f2b9a2';

/** GLTFLoader numbers names repeated across the three rigs (armL_1, socket_head_2); the game's animation binds bones by plain name. */
export function cloneBase(gltf,base){
  const source=gltf.scene.getObjectByName('cat_rig__'+base);if(!source)throw Error('Unknown cat base: '+base);
  const rig=SkeletonUtils.clone(source);let shared=null;
  rig.traverse(o=>{
    if(o.isBone||o.name.startsWith('socket_'))o.name=o.name.replace(/_\d+$/,'');
    // SkeletonUtils gives every primitive its own skeleton; body and face use the same skin, so one skeleton (one bone upload) per cat.
    if(o.isSkinnedMesh){if(!shared)shared=o.skeleton;else if(o.skeleton.bones.every((b,i)=>b===shared.bones[i])&&o.skeleton.boneInverses.every((m,i)=>m.equals(shared.boneInverses[i])))o.skeleton=shared;}
  });
  return rig;
}

/** Vertex colour per corner from a material colour, plus a float slot per corner (what recolours it at runtime). */
function tagged(geo,color,slot,slotName){
  const n=geo.attributes.position.count,col=new Float32Array(n*3),tag=new Float32Array(n).fill(slot);
  for(let i=0;i<n;i++)color.toArray(col,i*3);
  geo.setAttribute('color',new T.BufferAttribute(col,3));geo.setAttribute(slotName,new T.BufferAttribute(tag,1));return geo;
}
const FACE_EYE=1,PART_SLOTS={cloth:1,trim:2};
/**
 * One-time: expose the mask attributes under shader-safe names, and merge each face's seven primitives (eye, highlight,
 * mouth, pink, blush, line, nose) and each costume part's cloth/trim/metal primitives into ONE mesh with vertex colours.
 * A cat then draws as fur + face + one mesh per part instead of ~14 draws. Clones share these geometries.
 */
export function prepareKit(gltf){
  if(gltf.userData.kitMerged)return gltf;gltf.userData.kitMerged=true;
  gltf.scene.traverse(o=>{
    const g=o.geometry;if(!g||g.userData.kitReady)return;g.userData.kitReady=true;
    if(g.attributes._mask)g.setAttribute('kitMask',g.attributes._mask);
    if(g.attributes._spot)g.setAttribute('kitSpot',g.attributes._spot);
  });
  const faces=[],parts=[];
  gltf.scene.traverse(o=>{if(o.name.startsWith('face__')&&!o.isMesh&&o.children.some(c=>c.isSkinnedMesh))faces.push(o);if(o.name.startsWith('part_')&&!o.isMesh&&o.children.some(c=>c.isMesh))parts.push(o);});
  for(const group of faces){
    const prims=group.children.filter(c=>c.isSkinnedMesh),first=prims[0];
    const geo=mergeGeometries(prims.map(m=>tagged(m.geometry.clone(),m.material.color||new T.Color(1,1,1),m.material.name==='eye'?FACE_EYE:0,'kitFace')));
    geo.morphTargetsRelative=first.geometry.morphTargetsRelative;
    const mat=new T.MeshStandardMaterial({vertexColors:true,roughness:.6,side:T.DoubleSide});mat.name='face';
    const face=new T.SkinnedMesh(geo,mat);face.name=group.name;face.position.copy(first.position);face.quaternion.copy(first.quaternion);face.scale.copy(first.scale);
    face.morphTargetDictionary={...first.morphTargetDictionary};face.morphTargetInfluences=first.morphTargetInfluences.map(()=>0);
    face.bind(first.skeleton,first.bindMatrix);
    for(const c of prims)group.remove(c);group.add(face);
  }
  for(const part of parts){
    part.updateMatrixWorld(true);const inv=part.matrixWorld.clone().invert(),prims=part.children.filter(c=>c.isMesh);
    const geo=mergeGeometries(prims.map(m=>{let g=m.geometry.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld));if(g.index){const n=g.toNonIndexed();g.dispose();g=n;}for(const k of Object.keys(g.attributes))if(k!=='position'&&k!=='normal')g.deleteAttribute(k);return tagged(g,m.material.color,PART_SLOTS[m.material.name]||0,'kitSlot');}));
    const mat=new T.MeshStandardMaterial({vertexColors:true,roughness:.8,side:T.DoubleSide});mat.name='part';
    const mesh=new T.Mesh(geo,mat);mesh.name=part.name+'_merged';mesh.userData.casts=prims.some(m=>m.material.name==='cloth'||m.material.name==='leather');
    for(const c of prims)part.remove(c);part.add(mesh);
  }
  return gltf;
}

/**
 * One-time: merge a rigged model's plain skinned meshes into one vertex-coloured mesh per skeleton, morph set and
 * material finish (the Mayor GLB: 50 draws to a handful; each draw cost about as much CPU as a whole hamlet).
 * Each piece's bind matrix is baked into its vertices, so the merged mesh binds with identity. Meshes with morph
 * targets merge only with pieces of the same bind matrix (morph deltas are not transformed). Textured, transparent
 * or multi-material meshes are left alone.
 */
export function mergeRig(root){
  if(root.userData.rigMerged)return root;root.userData.rigMerged=true;root.updateMatrixWorld(true);
  const groups=new Map(),keep=['position','normal','skinIndex','skinWeight'];
  root.traverse(o=>{
    const m=o.material;if(!o.isSkinnedMesh||Array.isArray(m)||m.map||m.transparent||m.normalMap||m.alphaMap||m.emissiveMap)return;
    const morph=Object.keys(o.morphTargetDictionary||{}).join(',');
    const key=[o.skeleton.uuid,morph,morph&&o.bindMatrix.elements.join(','),m.type,m.side,m.roughness,m.metalness,m.emissive?.getHexString(),m.emissiveIntensity,m.flatShading,m.vertexColors].join('|');
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);
  });
  for(const list of groups.values()){
    if(list.length<2)continue;
    const first=list[0],morph=!!first.morphTargetDictionary&&Object.keys(first.morphTargetDictionary).length>0;
    const geos=list.map(o=>{
      let g=o.geometry.clone();if(g.index)g=g.toNonIndexed();
      for(const k of Object.keys(g.attributes))if(!keep.includes(k)&&!(k==='color'&&o.material.vertexColors))g.deleteAttribute(k);
      const n=g.attributes.position.count,col=new Float32Array(n*3),c=o.material.color,src=g.attributes.color;
      for(let i=0;i<n;i++){col[i*3]=c.r*(src?src.getX(i):1);col[i*3+1]=c.g*(src?src.getY(i):1);col[i*3+2]=c.b*(src?src.getZ(i):1);}
      g.setAttribute('color',new T.BufferAttribute(col,3));
      // skinIndex arrays differ in type between primitives (Uint8/Uint16): normalise so they merge.
      const si=g.attributes.skinIndex,sw=g.attributes.skinWeight,idx=new Uint16Array(n*4),wt=new Float32Array(n*4);
      for(let i=0;i<n;i++){idx.set([si.getX(i),si.getY(i),si.getZ(i),si.getW(i)],i*4);wt.set([sw.getX(i),sw.getY(i),sw.getZ(i),sw.getW(i)],i*4);}
      g.setAttribute('skinIndex',new T.Uint16BufferAttribute(idx,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(wt,4));
      if(!morph)g.applyMatrix4(o.bindMatrix);
      return g;
    });
    const merged=mergeGeometries(geos);geos.forEach(g=>g.dispose());if(!merged)continue;
    const material=first.material.clone();material.color.set('#ffffff');material.vertexColors=true;
    const mesh=new T.SkinnedMesh(merged,material);mesh.name=first.name+'_merged';mesh.frustumCulled=first.frustumCulled;
    if(morph){mesh.morphTargetDictionary={...first.morphTargetDictionary};mesh.morphTargetInfluences=first.morphTargetInfluences.map(()=>0);}
    const parent=first.parent;parent.add(mesh);
    if(morph){mesh.position.copy(first.position);mesh.quaternion.copy(first.quaternion);mesh.scale.copy(first.scale);mesh.updateMatrixWorld(true);mesh.bind(first.skeleton,first.bindMatrix);}
    else mesh.bind(first.skeleton,new T.Matrix4());
    for(const o of list)o.removeFromParent();
  }
  return root;
}

/** Face: authored vertex colours; eye corners take the cat's eye colour. */
function faceMaterial(){
  const eye={value:new T.Color()},m=new T.MeshStandardMaterial({vertexColors:true,roughness:.6,side:T.DoubleSide});m.name='face';m.userData.face={eye};
  m.onBeforeCompile=shader=>{
    shader.uniforms.kitEye=eye;
    shader.vertexShader='attribute float kitFace;varying float vKitFace;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+String.fromCharCode(10)+'vKitFace=kitFace;');
    shader.fragmentShader='uniform vec3 kitEye;varying float vKitFace;'+String.fromCharCode(10)+shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>'+String.fromCharCode(10)+'diffuseColor.rgb=mix(diffuseColor.rgb,kitEye,step(.5,vKitFace));');
  };
  m.customProgramCacheKey=()=>'cat-kit-face';return m;
}
/** Part: authored vertex colours; cloth and trim corners take the cat's colours for this part. */
function partMaterial(info){
  const cloth={value:new T.Color()},trim={value:new T.Color()},m=new T.MeshStandardMaterial({vertexColors:true,roughness:.8,side:T.DoubleSide});m.name='part';m.userData.part={cloth,trim,info};
  m.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{kitCloth:cloth,kitTrim:trim});
    shader.vertexShader='attribute float kitSlot;varying float vKitSlot;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+String.fromCharCode(10)+'vKitSlot=kitSlot;');
    shader.fragmentShader='uniform vec3 kitCloth,kitTrim;varying float vKitSlot;'+String.fromCharCode(10)+shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>'+String.fromCharCode(10)+'diffuseColor.rgb=vKitSlot>1.5?kitTrim:vKitSlot>.5?kitCloth:diffuseColor.rgb;');
  };
  m.customProgramCacheKey=()=>'cat-kit-part';return m;
}

/** Fur shader: fur -> patch(R) -> stripe(G) -> calico spots -> cream(B) -> pink(A). Markings use the patch colour (calico's second spot is a dark shade of it). */
export function furMaterial(){
  const uniforms={kitFur:{value:new T.Color()},kitPatch:{value:new T.Color()},kitSpotB:{value:new T.Color()},kitCream:{value:new T.Color()},kitPink:{value:new T.Color(PINK)},kitUse:{value:new T.Vector4()}};
  const m=new T.MeshStandardMaterial({color:'#ffffff',roughness:.88});m.name='fur';m.userData.kit=uniforms;
  m.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);
    shader.vertexShader='attribute vec4 kitMask;\nattribute vec2 kitSpot;\nvarying vec4 vKitMask;\nvarying vec2 vKitSpot;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvKitMask=kitMask;vKitSpot=kitSpot;');
    shader.fragmentShader='uniform vec3 kitFur,kitPatch,kitSpotB,kitCream,kitPink;\nuniform vec4 kitUse;\nvarying vec4 vKitMask;\nvarying vec2 vKitSpot;\n'+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      vec3 kitC=kitFur;
      kitC=mix(kitC,kitPatch,kitUse.x*smoothstep(.15,.85,vKitMask.r));
      kitC=mix(kitC,kitPatch,kitUse.y*smoothstep(.3,.7,vKitMask.g));
      kitC=mix(kitC,kitPatch,kitUse.z*smoothstep(.15,.85,vKitSpot.x));
      kitC=mix(kitC,kitSpotB,kitUse.w*smoothstep(.15,.85,vKitSpot.y));
      kitC=mix(kitC,kitCream,smoothstep(.15,.85,vKitMask.b));
      kitC=mix(kitC,kitPink,vKitMask.a);
      diffuseColor.rgb*=kitC;`);
  };
  m.customProgramCacheKey=()=>'cat-kit-fur';
  return m;
}

/** Colour slots on parts: cloth follows the outfit unless the catalog routes it to trim (the bow is a trim-coloured accent). */
const slotColour=(slot,look,part)=>slot==='cloth'?look[part?.cloth||'outfit']:slot==='trim'?look.trim:null;

export function partSocket(catalog,part){return catalog.parts[part]?.socket;}

/**
 * Build a cat from a resolved look ({base, marking, parts, fur, patch, cream, outfit, trim, eyes}).
 * Returns {root, materials, key}; `root` is the rig to bind with bindMayor while it is unrotated.
 */
export function buildKitCat(gltf,look,catalog){
  const root=cloneBase(gltf,look.base),materials=[];
  const own=(mesh,material)=>{mesh.material=material;mesh.userData.appearanceRole='kit';materials.push(material);return material;};
  root.traverse(o=>{
    // Only bodies and cloth cast shadows: faces and trims would add skinned depth draws at 64 cats for no visible shadow.
    if(!o.isMesh)return;o.castShadow=o.material.name==='fur';o.receiveShadow=true;
    if(o.material.name==='fur')own(o,furMaterial());
    else if(o.material.name==='face')own(o,faceMaterial());
  });
  const sockets={};root.traverse(o=>{if(o.name.startsWith('socket_'))sockets[o.name.slice(7)]=o;});
  for(const part of look.parts||[]){
    const info=catalog.parts[part],source=gltf.scene.getObjectByName(`part_${part}__${look.base}`);if(!info||!source)continue;
    const node=source.clone();node.userData.kitPart=part;
    node.traverse(o=>{if(!o.isMesh)return;o.castShadow=!!o.userData.casts;o.receiveShadow=true;if(o.material.name==='part')own(o,partMaterial(info));});
    sockets[info.socket]?.add(node);
  }
  restBounds(root);const cat={root,materials,key:kitKey(look)};setKitColours(cat,look);return cat;
}
/**
 * Skinned cat meshes carry a rest-pose bounding sphere (around the geometry box) for three's frustum test and draw sort.
 * Left null, the first test skins every vertex on the CPU: 0.2-0.8 s in the frame where 64 kit cats and the Mayor
 * first draw (docs/perf.md). Widened by POSE_REACH so every kit pose stays inside and per-mesh culling stays on.
 * cullEach=false (the Mayor): small rigid pieces on moving bones (nose, medal) leave any scaled rest sphere when the
 * head tips, so those meshes skip the per-mesh test; the town still culls the whole Mayor, and the sphere only sorts.
 */
const POSE_REACH=1.2;// kit poses reach up to 1.16x the rest sphere (all three bases; test/cat-kit.test.mjs)
export function restBounds(root,cullEach=true){
  root.traverse(o=>{if(o.isSkinnedMesh){o.frustumCulled&&=cullEach;if(!o.geometry.boundingBox)o.geometry.computeBoundingBox();o.boundingSphere=o.geometry.boundingBox.getBoundingSphere(new T.Sphere());o.boundingSphere.radius*=POSE_REACH;}});
}
export const kitKey=look=>look.base+'|'+(look.parts||[]).join(',');

/** Cheap per-frame-safe recolour: uniforms and material colours only, no rebuild. */
export function setKitColours(cat,look){
  for(const m of cat.materials){
    if(m.userData.kit){
      const u=m.userData.kit,use=MARKING_USE[look.marking]||MARKING_USE.solid;
      u.kitFur.value.set(look.fur);u.kitPatch.value.set(look.patch);u.kitCream.value.set(look.cream);
      u.kitSpotB.value.set(look.patch).multiplyScalar(.32);u.kitUse.value.fromArray(use);
    }else if(m.userData.face)m.userData.face.eye.value.set(look.eyes);
    else if(m.userData.part){const p=m.userData.part;p.cloth.value.set(slotColour('cloth',look,p.info)||'#ffffff');p.trim.value.set(slotColour('trim',look,p.info)||'#ffffff');}
  }
}

/** Which face the cat should wear right now. */
export function expressionFor({mode,busy,waiting,night,happy,style,fallback}){
  // Asleep: every expression eases out; animateCat closes the eyes with the blink morphs (Mayor and kit alike).
  if(mode==='sleep')return 'asleep';
  if(mode==='talk'||happy)return 'happy';
  if(busy&&/scholar|critic|archivist/.test(style||''))return 'curious';
  if(night&&mode==='idle'&&!busy&&!waiting)return 'sleepy';
  return fallback||'neutral';
}

/** Ease morph weights toward one expression. Runs after animateCat, which writes the blinks every frame. */
export function applyExpression(faces,expression,blend=1){
  for(const face of faces){
    const d=face.morphTargetDictionary,v=face.morphTargetInfluences;if(!d)continue;
    for(const [id,key] of Object.entries(EXPRESSIONS))if(d[key]!==undefined)v[d[key]]+=((id===expression?1:0)-v[d[key]])*blend;
    // Closed-eye expressions own the eyelids; a blink on top would double-close them.
    if(expression==='happy'||expression==='sleepy')for(const key of ['Blink_L','Blink_R'])if(d[key]!==undefined)v[d[key]]=0;
  }
}

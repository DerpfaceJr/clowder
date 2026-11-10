// Rock kit: original low-poly stones made in code, so nothing ships but this file. Each variant is one vertex-coloured
// geometry, so every rock of a kind in the streamed land is one InstancedMesh (meadow.js). Footprints: vegetation.js ROCK_FOOT.
// A stone is an icosphere (80 faces) pushed in and out by seeded per-vertex noise, squashed, and flattened where it meets
// the ground. Its normals blend each face's own with the smooth vertex normal: the facets still read, but the edges
// round off like a soft bevel. Colour: grey stone, lighter and dustier on top, moss on the faces that look up.
import * as T from 'three';
import {mergeGeometries,mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {seeded} from './terrain.js';

const STONE=new T.Color('#8e897d'),DUST=new T.Color('#b7b1a2'),MOSS=new T.Color('#6f8c4e'),LICHEN=new T.Color('#93a964');
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};

/** One stone of radius about `r` at scale 1. sx, sy, sz: squash; bump: how far vertices wander; top: flat top (a slab) at
 *  that fraction of its height; moss: how mossy its upward faces are (0..1); detail: icosphere detail (1: 80 faces). */
function stone(seed,{r=.6,sx=1,sy=.65,sz=.85,bump=.2,top=0,moss=.6,detail=1}={}){
  const rnd=seeded('rock:'+seed),base=new T.IcosahedronGeometry(1,detail);base.deleteAttribute('normal');base.deleteAttribute('uv');
  const g=mergeVertices(base),p=g.attributes.position,v=new T.Vector3();
  for(let i=0;i<p.count;i++){
    v.fromBufferAttribute(p,i).multiplyScalar(1+(rnd()-.5)*2*bump);v.set(v.x*sx*r,v.y*sy*r,v.z*sz*r);
    if(top)v.y=Math.min(v.y,top*sy*r);v.y=Math.max(v.y,-.3*sy*r);p.setXYZ(i,v.x,v.y,v.z);
  }
  g.computeVertexNormals();g.computeBoundingBox();
  const lo=g.boundingBox.min.y,hi=g.boundingBox.max.y,n=g.attributes.normal,col=new Float32Array(p.count*3),c=new T.Color();
  for(let i=0;i<p.count;i++){
    const up=n.getY(i),h=(p.getY(i)-lo)/(hi-lo||1),patch=rnd();
    c.copy(STONE).lerp(DUST,h*.55+(patch-.5)*.15).lerp(patch<.5?MOSS:LICHEN,moss*smooth(.35,.85,up)*(.55+.45*patch));c.toArray(col,i*3);
  }
  g.setAttribute('color',new T.BufferAttribute(col,3));g.translate(0,-lo-.06*r,0);// sits just into the ground
  // Soft bevel: un-share the corners and give each the mean of its face normal and its smooth normal.
  const flat=g.toNonIndexed(),q=flat.attributes.position,m=flat.attributes.normal,a=new T.Vector3(),b=new T.Vector3(),f=new T.Vector3(),s=new T.Vector3();
  for(let i=0;i<q.count;i+=3){
    a.fromBufferAttribute(q,i+1).sub(f.fromBufferAttribute(q,i));b.fromBufferAttribute(q,i+2).sub(f);f.crossVectors(a,b).normalize();
    for(let k=0;k<3;k++){s.fromBufferAttribute(m,i+k).multiplyScalar(.55).addScaledVector(f,.45).normalize();m.setXYZ(i+k,s.x,s.y,s.z);}
  }
  return flat;
}

let kit=null;
/** The rock variants: a rounded boulder, a flat-topped slab for outcrops, and a cluster of five pebbles. */
export function rockGeometries(){
  if(kit)return kit;
  const boulder=stone('boulder',{r:.6,sx:1,sy:.72,sz:.86,bump:.2,moss:.7});
  const slab=stone('slab',{r:.6,sx:1.3,sy:.62,sz:.92,bump:.16,top:.5,moss:.85});
  const pebbles=mergeGeometries([[0,0,.11],[.17,.06,.08],[-.13,.11,.07],[.04,-.17,.09],[-.12,-.1,.06]].map(([x,z,r],k)=>
    stone('pebble:'+k,{r,sx:1.1,sy:.6,sz:.9,bump:.15,moss:.25,detail:0}).translate(x,0,z)));
  kit={boulder,slab,pebbles};return kit;
}

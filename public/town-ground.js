import * as T from 'three';
import {streetLamp,propGeometries} from './world-art.js';
import {deckY,noise2} from './terrain.js';
import {makeBlocker} from './vegetation.js';
import {PAL} from './meadow.js';
import {grassMaterial} from './grass.js';

// The ONE ground layering scheme. Every flat surface sits at its own lift above the held ground (metres), so no two
// surfaces that can overlap share a height, and the whole stack is polygon-offset above the terrain mesh. Ortho depth
// is linear (0.1..500 m over 24 bits, ~0.03 mm steps), so 3 mm apart is far above the depth resolution.
// Streets sit UNDER the paving: a street's end disappears under a common or a yard, so every join is the paving's own edge.
// Cobbled chains spread over local..local+.005 (longer above shorter), earth lanes alternate between and between+.002.
export const LIFT={between:.04,local:.045,common:.054,yard:.058,cap:.065,kerb:.07,rim:.073,inlay:.1};

// The ground atlas, drawn once (512x256): flagstones on the left half, and four 128 px tiles on the right: setts, kerb
// blocks, an earth lane's cross-section and bridge planks. The small tiles are near-white grey detail, so the ONE palette
// (COL) is the vertex colours; the ground material wraps each tile on its own (see groundMaterial).
const TILE={flag:0,sett:1,kerb:2,earth:3,plank:4},FLAG=4,SETT=1.2,KERB=.9,EARTH=2.4,PLANK=.9;// metres per repeat
export function flagstoneTexture(anisotropy=1){
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;const ctx=canvas.getContext('2d');
  ctx.fillStyle='#d8cdb3';ctx.fillRect(0,0,256,256);
  // Flagstones: each its own tint (about ±6%), worn paler in the middle and darker at its edges, with a few chips and
  // specks. Stones that wrap across the tile's edge (col -1 and 4, the half stones) share one seed, so it stays seamless.
  {let h=59;const rnd=()=>(h=(h*16807)%2147483647)/2147483647,seeds=new Map();
  for(let row=0;row<4;row++)for(let col=-1;col<5;col++){
    const x=col*64+(row%2?32:0),y=row*64,key=row+':'+(col+4)%4;if(!seeds.has(key))seeds.set(key,[rnd(),rnd(),rnd()]);const [a,b,c]=seeds.get(key),t=(a-.5)*.12;
    const r=(214+16*b)*(1+t),g=(203+14*b)*(1+t),bl=(178+12*b)*(1+t*1.2);ctx.fillStyle=`rgb(${r|0},${g|0},${bl|0})`;ctx.fillRect(x+3,y+3,58,58);
    const wear=ctx.createRadialGradient(x+32+(c-.5)*16,y+32+(a-.5)*16,4,x+32,y+32,42);wear.addColorStop(0,'rgba(255,250,236,.22)');wear.addColorStop(.6,'rgba(255,250,236,0)');wear.addColorStop(1,'rgba(90,70,40,.16)');
    ctx.fillStyle=wear;ctx.fillRect(x+3,y+3,58,58);
    let s=Math.floor(c*1e6)+1;const r2=()=>(s=(s*16807)%2147483647)/2147483647;
    for(let i=0;i<14;i++){ctx.fillStyle=`rgba(${r2()<.5?'120,104,80':'255,252,240'},.28)`;ctx.fillRect(x+5+r2()*52,y+5+r2()*52,1.5,1.5);}
    if(b>.6){ctx.fillStyle='rgba(150,132,104,.5)';ctx.beginPath();const cx=x+(a<.5?5:59),cy=y+(c<.5?5:59);ctx.moveTo(cx,cy);ctx.lineTo(cx+(a<.5?7:-7),cy);ctx.lineTo(cx,cy+(c<.5?6:-6));ctx.fill();}
  }}
  ctx.strokeStyle='#a99c82';ctx.lineWidth=3;
  for(let row=0;row<4;row++)for(let col=-1;col<5;col++){const x=col*64+(row%2?32:0),y=row*64;ctx.strokeRect(x+3,y+3,58,58);}
  // One seamless 128 px tile at (x0,y0): draw(rnd) runs for it and its 8 wrapped neighbours with the same seed.
  const grey=(v,a=1)=>`rgba(${v|0},${v|0},${v|0},${a})`,tile=(x0,y0,seed,draw)=>{
    ctx.save();ctx.beginPath();ctx.rect(x0,y0,128,128);ctx.clip();
    for(const dx of [-128,0,128])for(const dy of [-128,0,128]){let h=seed;ctx.save();ctx.translate(x0+dx,y0+dy);draw(()=>(h=(h*16807)%2147483647)/2147483647);ctx.restore();}
    ctx.restore();
  };
  // Setts: 8 courses of .15 m (along v), staggered .3 m stones with a worn highlight.
  tile(256,0,11,rnd=>{ctx.fillStyle=grey(150);ctx.fillRect(0,0,128,128);
    for(let r=0;r<8;r++)for(let c=0;c<4;c++){const x=c*32+(r%2?16:0),y=r*16;ctx.fillStyle=grey(228+rnd()*22);ctx.beginPath();ctx.roundRect(x+1.5,y+1.5,29,13,4);ctx.fill();
      ctx.fillStyle=grey(255,.22);ctx.beginPath();ctx.roundRect(x+5,y+3.5,19,3.5,2);ctx.fill();}});
  // Kerb blocks: two .45 m blocks (along u), speckled; the street side (v=0, bottom) in shadow, the top edge lit.
  tile(384,0,23,rnd=>{ctx.fillStyle=grey(120);ctx.fillRect(0,0,128,128);
    for(let k=0;k<2;k++){ctx.fillStyle=grey(206+rnd()*36);ctx.fillRect(k*64+2,0,60,128);for(let i=0;i<40;i++){ctx.fillStyle=grey(rnd()<.5?170:255,.5);ctx.fillRect(k*64+3+rnd()*57,rnd()*128,1.5,1.5);}}
    const g=ctx.createLinearGradient(0,90,0,128);g.addColorStop(0,grey(60,0));g.addColorStop(1,grey(60,.5));ctx.fillStyle=g;ctx.fillRect(0,90,128,38);
    ctx.fillStyle=grey(255,.22);ctx.fillRect(0,6,128,8);});
  // An earth lane across v: grass tufts on both fringes, wheel ruts at v .36 and .64 worn along u, pebbles, a tufted crown.
  tile(256,128,37,rnd=>{ctx.fillStyle=grey(232);ctx.fillRect(0,0,128,128);
    for(const y of [47,81]){ctx.fillStyle=grey(150,.3);ctx.fillRect(0,y-7,128,14);for(let i=0;i<14;i++){ctx.fillStyle=grey(rnd()<.5?120:255,.25);ctx.fillRect(rnd()*128,y-6+rnd()*12,20+rnd()*40,1+rnd()*1.5);}}
    for(let i=0;i<160;i++){ctx.fillStyle=grey(rnd()<.5?160:255,.6);ctx.beginPath();ctx.arc(rnd()*128,24+rnd()*80,.6+rnd()*1.2,0,7);ctx.fill();}
    ctx.lineWidth=1.2;for(let i=0;i<110;i++){const y=i<90?(rnd()<.5?rnd()*24:104+rnd()*24):58+rnd()*12,x=rnd()*128,len=3+rnd()*5;
      ctx.strokeStyle=grey(rnd()<.5?140:255,.55);ctx.beginPath();ctx.moveTo(x,y+len/2);ctx.lineTo(x+(rnd()-.5)*3,y-len/2);ctx.stroke();}});
  // Planks: eight boards across the deck (gaps along u), grain and two rows of nails.
  tile(384,128,41,rnd=>{ctx.fillStyle=grey(95);ctx.fillRect(0,0,128,128);
    for(let k=0;k<8;k++){const x=k*16+1;ctx.fillStyle=grey(200+rnd()*45);ctx.fillRect(x,0,14,128);
      for(let i=0;i<4;i++){ctx.fillStyle=grey(rnd()<.5?160:250,.35);ctx.fillRect(x+1+rnd()*12,0,1,128);}
      ctx.fillStyle=grey(80);for(const y of [14,112])ctx.fillRect(x+6,y,2,2);}});
  const texture=new T.CanvasTexture(canvas);texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.colorSpace=T.SRGBColorSpace;
  texture.anisotropy=anisotropy;texture.minFilter=T.LinearMipmapLinearFilter;texture.generateMipmaps=true;
  return texture;
}

// Buffers for one merged mesh: uvs in repeats of the vertex's atlas tile (tile attribute) times a vertex tint.
function builder(){
  const pos=[],col=[],uv=[],tile=[],index=[];
  const vert=(x,y,z,c,u,k)=>{pos.push(x,y,z);col.push(c.r,c.g,c.b);uv.push(u[0],u[1]);tile.push(k);return pos.length/3-1;};
  return {pos,index,
    // A disc, or with `from`/`to` (radians) a fan over that arc; uv(x,z).
    disc(cx,cz,r,y,c,uv,k,seg=40,from=0,to=Math.PI*2){
      const base=vert(cx,y(cx,cz),cz,c,uv(cx,cz),k);
      for(let i=0;i<=seg;i++){const a=from+i/seg*(to-from),x=cx+Math.cos(a)*r,z=cz+Math.sin(a)*r;vert(x,y(x,z),z,c,uv(x,z),k);}
      for(let i=0;i<seg;i++)index.push(base,base+2+i,base+1+i);
    },
    // An annulus r0..r1 of `seg` quads, each with its own vertices so col(x,z,i) can shade it alone; uv(angle,r).
    ring(cx,cz,r0,r1,y,col,uv,k,seg=48,keep=null){
      for(let i=0;i<seg;i++){
        const a0=i/seg*Math.PI*2,a1=(i+1)/seg*Math.PI*2,am=(a0+a1)/2,rm=(r0+r1)/2,mx=cx+Math.cos(am)*rm,mz=cz+Math.sin(am)*rm;
        if(keep&&!keep(mx,mz))continue;const c=col(mx,mz,i),base=pos.length/3;
        for(const a of [a0,a1])for(const r of [r0,r1]){const x=cx+Math.cos(a)*r,z=cz+Math.sin(a)*r;vert(x,y(x,z),z,c,uv(a,r),k);}
        // Wound to face up (it used to face down, so the single-sided ground material culled every kerb ring).
        index.push(base,base+2,base+1,base+1,base+2,base+3);
      }
    },
    // An annulus r0..r1 whose colour runs from cIn at r0 to cOut at r1 (the kerb band); uv(x,z) like disc.
    fade(cx,cz,r0,r1,y,cIn,cOut,uv,k,seg=64){
      const base=pos.length/3;
      for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2;for(const [r,c] of [[r0,cIn],[r1,cOut]]){const x=cx+Math.cos(a)*r,z=cz+Math.sin(a)*r;vert(x,y(x,z),z,c,uv(x,z),k);}}
      for(let i=0;i<seg;i++){const a=base+i*2;index.push(a,a+2,a+1,a+1,a+2,a+3);}
    },
    // A strip across columns of equal length (see lanes(); left first). col(i,j,x,z), uv(i,j,along); keep(x,z,j), when
    // given, drops the quads whose middle it rejects.
    band(lines,along,y,col,uv,k,keep=null){
      const m=lines.length,n=lines[0]?.length||0;if(n<2)return;const base=pos.length/3;
      for(let i=0;i<n;i++)lines.forEach((line,j)=>{const [x,z]=line[i];vert(x,y(x,z,j),z,col(i,j,x,z),uv(i,j,along[i]),k);});
      for(let i=0;i<n-1;i++)for(let j=0;j<m-1;j++){
        const p=[lines[j][i],lines[j+1][i],lines[j][i+1],lines[j+1][i+1]];
        if(keep&&!keep((p[0][0]+p[1][0]+p[2][0]+p[3][0])/4,(p[0][1]+p[1][1]+p[2][1]+p[3][1])/4,j))continue;
        const a=base+i*m+j,c=a+m;index.push(a,c,a+1,a+1,c,c+1);
      }
    },
    // A vertical strip (bridge rails and skirts) from y0(s) to y1(s) along a straight segment, both sides visible, in planks.
    wall(a,b,side,y0,y1,c,n=10){
      const base=pos.length/3,dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz)||1,nx=-dz/len*side,nz=dx/len*side;
      for(let i=0;i<=n;i++){const s=i/n,x=a[0]+dx*s+nx,z=a[1]+dz*s+nz;vert(x,y0(s),z,c,[s*len/PLANK,.02],TILE.plank);vert(x,y1(s),z,c,[s*len/PLANK,.98],TILE.plank);}
      // Both windings: the ground material is single-sided (see mesh()), and a wall must show from either side.
      for(let i=0;i<n;i++){const k=base+i*2;index.push(k,k+2,k+1,k+1,k+2,k+3,k,k+1,k+2,k+1,k+3,k+2);}
    },
    mesh(material){
      const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('color',new T.Float32BufferAttribute(col,3));
      // Single-sided on purpose: where a ribbon folds on a tight bend, its folded triangles face down and are culled.
      // Double-sided, they were lit from below and showed as a dark dotted streak across the road.
      // Normals point straight up: every surface here is nearly flat, and computed normals turned the odd folded sliver
      // on a tight bend (a ribbon offset wider than the bend's radius) into a dark streak across the road.
      const up=new Float32Array(pos.length);for(let i=1;i<up.length;i+=3)up[i]=1;
      geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.setAttribute('tile',new T.Float32BufferAttribute(tile,1));geo.setAttribute('normal',new T.BufferAttribute(up,3));geo.setIndex(index);
      const m=new T.Mesh(geo,material);m.receiveShadow=true;m.userData.ownedGeometry=true;return m;
    }};
}
/**
 * The two edges of a road strip along a centreline, as point lists of equal length (left = positive offset side).
 * Near-duplicate points are dropped, and so is a point where the line doubles back on a stub shorter than the strip is
 * wide (door stems). Edges are mitred, so the strip keeps its full width through a bend instead of pinching (the
 * mitre is limited to 2x), and an edge that would fold back on the inside of a bend tighter than its offset holds
 * its last point instead: a folded ribbon showed as a notch in the road edge and as kerb slivers across the road.
 */
export function strip(points,width,offset=0){
  const pts=[];for(const p of points)if(!pts.length||Math.hypot(p[0]-pts.at(-1)[0],p[1]-pts.at(-1)[1])>.05)pts.push(p);
  if(pts.length>1)pts[pts.length-1]=points.at(-1);
  for(let i=1;i<pts.length-1;){
    const a=pts[i-1],p=pts[i],b=pts[i+1],ux=p[0]-a[0],uz=p[1]-a[1],vx=b[0]-p[0],vz=b[1]-p[1],lu=Math.hypot(ux,uz),lv=Math.hypot(vx,vz);
    if((ux*vx+uz*vz)/(lu*lv)<-.85&&Math.min(lu,lv)<Math.abs(offset)+width){pts.splice(i,1);if(i>1)i--;}else i++;
  }
  if(pts.length<2)return {left:[],right:[],centre:pts};
  return {left:offsetLine(pts,offset+width/2),right:offsetLine(pts,offset-width/2),centre:pts};
}
/** Columns of a strip at `offsets` (left = positive, left first) along the centreline cleaned as strip() cleans a strip
 *  `clean` wide, resampled at most `step` metres apart so tints can vary along it; with the distance along each point. */
function lanes(points,offsets,clean,step=Infinity){
  const pts=strip(points,clean).centre,centre=pts.slice(0,1),along=[0];
  for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],d=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(1,Math.ceil(d/step));
    for(let k=1;k<=n;k++){centre.push([a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);along.push(along.at(-1)+d/n);}}
  return {lines:offsets.map(s=>centre.length>1?offsetLine(centre,s):[]),along};
}
const unitNormal=(a,b)=>{const dx=b[0]-a[0],dz=b[1]-a[1],l=Math.hypot(dx,dz);return l<1e-9?null:[-dz/l,dx/l];};
function offsetLine(pts,s){
  const out=[],n=pts.length;
  for(let i=0;i<n;i++){
    const a=pts[Math.max(0,i-1)],p=pts[i],b=pts[Math.min(n-1,i+1)],n1=unitNormal(a,p)||unitNormal(p,b),n2=unitNormal(p,b)||n1;
    let mx=n1[0]+n2[0],mz=n1[1]+n2[1];const ml=Math.hypot(mx,mz);if(ml<1e-6){mx=n1[0];mz=n1[1];}else{mx/=ml;mz/=ml;}
    const k=s*Math.min(2,1/Math.max(1e-6,mx*n1[0]+mz*n1[1]));let q=[p[0]+mx*k,p[1]+mz*k];
    if(out.length){const prev=out.at(-1);if((q[0]-prev[0])*(p[0]-a[0])+(q[1]-prev[1])*(p[1]-a[1])<0)q=prev.slice();}
    out.push(q);
  }
  return out;
}
const nodeKey=p=>p[0].toFixed(3)+','+p[1].toFixed(3);
/** Joins drawn road edges of the same kind through nodes where exactly two of them meet. A chain that starts at a
 *  doorstep keeps it as its first point (door: true). */
function chains(roads){
  const out=[];
  for(const kind of ['local','between']){
    const list=roads.filter(r=>r.kind===kind),at=new Map(),used=new Set();
    for(const r of list)for(const p of [r.points[0],r.points.at(-1)]){const k=nodeKey(p);if(!at.has(k))at.set(k,[]);at.get(k).push(r);}
    const through=k=>at.get(k)?.length===2;
    for(const r of list){
      if(used.has(r))continue;used.add(r);let pts=r.points.slice(),door=!!r.door;
      for(let grow=true;grow;){
        grow=false;
        const tail=nodeKey(pts.at(-1)),head=nodeKey(pts[0]);
        const next=through(tail)&&at.get(tail).find(e=>!used.has(e));
        if(next){used.add(next);pts=pts.concat((nodeKey(next.points[0])===tail?next.points:next.points.slice().reverse()).slice(1));grow=true;continue;}
        const prev=!door&&through(head)&&at.get(head).find(e=>!used.has(e));
        if(prev){used.add(prev);const seg=nodeKey(prev.points.at(-1))===head?prev.points:prev.points.slice().reverse();pts=seg.slice(0,-1).concat(pts);door=!!prev.door&&nodeKey(prev.points[0])===nodeKey(pts[0]);grow=true;}
      }
      out.push({kind,width:r.width,points:pts});
    }
  }
  // Ends that meet another road run on a little past the node; dead ends (doorsteps) stay exactly where they are.
  const degree=new Map();for(const r of roads)if(r.kind==='local'||r.kind==='between')for(const p of [r.points[0],r.points.at(-1)])degree.set(nodeKey(p),(degree.get(nodeKey(p))||0)+1);
  for(const c of out){const d=c.width*.8,joins=p=>(degree.get(nodeKey(p))||0)>1;
    if(joins(c.points[0]))c.points=[pushOut(c.points[0],c.points[1],d),...c.points.slice(1)];
    if(joins(c.points.at(-1)))c.points=[...c.points.slice(0,-1),pushOut(c.points.at(-1),c.points.at(-2),d)];}
  return out;
}
/** End point a moved `d` metres further away from its neighbour b. */
const pushOut=(a,b,d)=>{const dx=a[0]-b[0],dz=a[1]-b[1],l=Math.hypot(dx,dz)||1;return [a[0]+dx/l*d,a[1]+dz/l*d];};
const span=p=>{let d=0;for(let i=1;i<p.length;i++)d+=Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]);return d;};
/** The polyline with `cut` metres removed from both ends (empty when too short). */
function trim(points,cut){
  const len=[0];for(let i=1;i<points.length;i++)len.push(len[i-1]+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
  const total=len.at(-1);if(total<=cut*2+.5)return [];
  const at=d=>{let i=1;while(i<points.length-1&&len[i]<d)i++;const t=(d-len[i-1])/((len[i]-len[i-1])||1),a=points[i-1],b=points[i];return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];};
  return [at(cut),...points.filter((p,i)=>len[i]>cut&&len[i]<total-cut),at(total-cut)];
}
let groundMaterial=null;
const tint=c=>new T.Color(c),shade=(c,t)=>c.clone().multiplyScalar(1+t);
// The ONE street palette: cream paving, warm grey setts and kerbs, a pale sill where a street meets paving, earth that
// greens into the meadow's own colour at its fringe, and timber for bridges. The ground is not tinted by time of day
// (the meadow is, see meadow.js setTint), so the fringe is a shade darker than day meadow and glows less at night.
const COL={common:tint('#fcf3e3'),yard:tint('#efe6d6'),sett:tint('#ebdabb'),kerb:tint('#c9bda8'),sill:tint('#fff1d6'),dirt:tint('#d6b079'),
  verge:PAL.meadow.clone().lerp(PAL.lush,.4).multiply(tint('#fffcd0')).multiplyScalar(.8),plank:tint('#b07d52'),rail:tint('#815a3a'),skirt:tint('#75523a')};
// An earth lane's cross-section, fringe to fringe: verge, edge, rut, crown, rut, edge, verge.
const EARTH_TONES=(()=>{const edge=COL.dirt.clone().lerp(COL.verge,.3),rut=shade(COL.dirt,-.12),crown=COL.dirt.clone().lerp(COL.verge,.15);return [COL.verge,edge,rut,crown,rut,edge,COL.verge];})();

/**
 * Every stone and road surface of the town in ONE mesh: paved commons with a kerb ring, a stone yard around every house,
 * cobbled in-hamlet roads with kerbs, earth roads between hamlets, and bridge decks with rails where roads cross water.
 * height(x,z) is the held ground; walk(x,z) adds bridge decks (terrain.js roadHeight).
 */
export function buildTownGround({sites,yards,roads,junctions,common,homes,L,bridges},height,walk,texture){
  groundMaterial??=(()=>{const m=new T.MeshStandardMaterial({map:texture,vertexColors:true,roughness:.95,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-4});
    // Each vertex names its atlas tile; the fragment wraps the uv inside that tile and samples with the unwrapped uv's
    // derivatives, so the mip level never jumps at a wrap. Same draw, same texture, one extra varying.
    m.onBeforeCompile=shader=>{const NL=String.fromCharCode(10);
      shader.vertexShader='attribute float tile;varying float vTile;'+NL+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+NL+'vTile=tile;');
      shader.fragmentShader='varying float vTile;'+NL+shader.fragmentShader.replace('#include <map_fragment>',['#ifdef USE_MAP',
        'float k=floor(vTile+.5);vec4 box=k<.5?vec4(0.,0.,.5,1.):vec4(.5+.25*mod(k-1.,2.),.5-.5*floor((k-1.)/2.),.25,.5);',
        'vec2 px=vec2(1.5/512.,1.5/256.);box.xy+=px;box.zw-=2.*px;// inset, so filtering never reaches the next tile at a wrap',
        'diffuseColor*=textureGrad(map,box.xy+fract(vMapUv)*box.zw,dFdx(vMapUv)*box.zw,dFdy(vMapUv)*box.zw);','#endif'].join(NL));};
    m.customProgramCacheKey=()=>'town-ground-atlas';return m;})();
  const b=builder(),lift=k=>(x,z)=>height(x,z)+LIFT[k],onRoad=k=>(x,z)=>walk(x,z)+LIFT[k],flag=(x,z)=>[x/FLAG,z/FLAG];
  const streets=makeBlocker({roads:roads.filter(r=>r.kind==='local'||r.kind==='between')}),paved=makeBlocker({roads:roads.filter(r=>r.width>0)});
  const radius=s=>s.common??common,onCommon=(x,z,m=.3)=>sites.some(s=>Math.hypot(x-s.x,z-s.z)<radius(s)+m);
  const houseYards=homes.filter(h=>h.plot!==0).map(h=>({x:h.x,z:h.z,r:L.house_radius*.8})),inYard=(x,z,m=0)=>[...yards,...houseYards].some(y=>Math.hypot(x-y.x,z-y.z)<y.r+m);
  // A street's quads well inside a common or a yard are left out, not just buried: the paving is a coarse fan, and a
  // street a few mm below it poked through where the fan cuts under the held ground.
  const shown=(x,z)=>!onCommon(x,z,-.4)&&!inYard(x,z,-.4);
  // A kerb of .45 m blocks round a circle (at least 24 quads), each block its own shade; where a street leaves, the
  // block is a pale sill.
  const rim=(cx,cz,r0,r1,y,keep=null)=>{const blocks=2*Math.ceil(Math.PI*r1/.45),k=Math.ceil(24/blocks);
    b.ring(cx,cz,r0,r1,y,(x,z,i)=>shade(streets.onRoad(x,z,.05)?COL.sill:COL.kerb,.05*noise2((i/k|0)*1.7,cx,9)),(a,r)=>[a/(Math.PI*2)*blocks/2,r===r1?.02:.98],TILE.kerb,blocks*k,keep);};
  // Each common is one paved disc that also carries its ring street, edged by its kerb ring.
  // A band of worn, darker paving just inside the kerb, where feet and grime gather, fading into the open square: the
  // common's outer 1.1 m is that annulus, not a second layer over the disc (the overlap was overdraw on the costliest
  // ground shader, over a large part of the screen).
  for(const s of sites){const c=radius(s),seg=s.index===0?96:56;b.disc(s.x,s.z,c-1.1,lift('common'),COL.common,flag,TILE.flag,seg);b.fade(s.x,s.z,c-1.1,c,lift('common'),COL.common,shade(COL.common,-.15),flag,TILE.flag,seg);rim(s.x,s.z,c-.02,c+.22,lift('rim'));}
  // Yards: hall yards and house yards never overlap each other (homes stand 2 house radii apart); both sit above commons.
  for(const y of yards)b.disc(y.x,y.z,y.r,lift('yard'),COL.yard,flag,TILE.flag);
  for(const h of houseYards)b.disc(h.x,h.z,h.r,lift('yard'),COL.yard,flag,TILE.flag,28);
  // Streets: setts in town, packed earth between hamlets. Rings are part of the common's paving.
  // Streets are drawn as chains: road edges of one kind that continue through a node (a split made by a T-junction) are
  // joined back into one ribbon, so the only ribbon ends left are real junctions (capped below) and doorsteps.
  const all=chains(roads),cobbled=all.filter(c=>c.kind==='local').sort((p,q)=>span(p.points)-span(q.points));
  cobbled.forEach((chain,n)=>{
    // Longer chains sit a hair above shorter ones: a through street covers the end of a stem meeting it.
    const w=chain.width,y=(x,z)=>walk(x,z)+LIFT.local+.005*n/cobbled.length,{lines,along}=lanes(chain.points,[w,0,-w],2*w,1);
    // Courses of setts square across the street, lighter on the crown, darker in the gutters.
    b.band(lines,along,y,(i,j,x,z)=>shade(COL.sett,(j===1?.03:-.06)+.04*noise2(x*.4,z*.4,71)),(i,j,s)=>[(1-j)*w/SETT,s/SETT],TILE.sett,shown);
    // Kerbs line both sides, stopping short of each end so they never cross a junction or a doorstep.
    // A kerb never runs across another street, a common or a yard: they end under the common's kerb ring or the yard.
    const kerb=trim(chain.points,1.3);if(kerb.length>1)for(const side of [1,-1]){
      const o=side*(w+.05),k=lanes(kerb,[o+.08,o-.08],Math.abs(o)+.16,1);
      b.band(k.lines,k.along,onRoad('kerb'),(i,j,x,z)=>shade(COL.kerb,.05*noise2(x*.9,z*.9,72)),(i,j,s)=>[s/KERB,(j===0)===(side>0)?.98:.02],TILE.kerb,(x,z)=>!paved.onRoad(x,z,-.08)&&!onCommon(x,z,.1)&&!inYard(x,z));
    }
  });
  const earth=all.filter(c=>c.kind==='between').sort((p,q)=>span(p.points)-span(q.points));
  earth.forEach((chain,n)=>{
    // Earth lanes: worn ruts and a grassy crown, and a fringe whose outer edge wanders in and out of the meadow. Longer lanes
    // sit above shorter ones, and every fringe sits below every lane, so a lane meeting another never lays grass across it.
    const w=chain.width,f=.4,offs=[w+f,w*.8,w*.4,0,-w*.4,-w*.8,-w-f],y=(x,z,j)=>walk(x,z)+LIFT.between+(j%6?.003*n/earth.length:-.003),{lines,along}=lanes(chain.points,offs,2*w,.6);
    for(const [o,inner,seed] of [[0,1,73],[6,5,74]])lines[o]=lines[o].map((p,i)=>{const q=lines[inner][i],t=.45+.55*(noise2(along[i]*.8,0,seed)*.5+.5);return [q[0]+(p[0]-q[0])*t,q[1]+(p[1]-q[1])*t];});
    b.band(lines,along,y,(i,j,x,z)=>shade(EARTH_TONES[j],.06*noise2(x*.5,z*.5,75)),(i,j,s)=>[s/EARTH,.5+.48*offs[j]/(w+f)],TILE.earth,shown);
  });
  // Junction caps where streets meet off a common: a rosette of setts in rings round a keystone, a hair above the streets,
  // kerbed like a little common where no street leaves it, so a junction reads as laid on purpose and the street ends
  // meeting under it never show.
  for(const j of junctions||[]){
    // Earth roads get no cap: on slopes a flat-shaded disc reads as a patch.
    const kinds=j.kinds.filter(k=>k!=='ring');if(kinds.length!==1||kinds[0]!=='local'||onCommon(j.x,j.z))continue;
    const y=onRoad('cap'),r0=j.r*.25;b.disc(j.x,j.z,r0,y,COL.kerb,(x,z)=>[.25+(x-j.x)/KERB,.5+(z-j.z)/KERB],TILE.kerb,12);
    for(const [ra,rb] of [[r0,j.r*.62],[j.r*.62,j.r]]){const n=Math.max(1,Math.round(Math.PI*(ra+rb)/SETT));b.ring(j.x,j.z,ra,rb,y,()=>COL.sett,(a,r)=>[a/(Math.PI*2)*n,r/SETT],TILE.sett,24);}
    rim(j.x,j.z,j.r-.02,j.r+.16,onRoad('kerb'),(x,z)=>!paved.onRoad(x,z,.02));
  }
  for(const br of bridges){
    const n=12,pts=[],w=br.width*2+.5;for(let i=0;i<=n;i++){const s=i/n;pts.push([br.a[0]+(br.b[0]-br.a[0])*s,br.a[1]+(br.b[1]-br.a[1])*s]);}
    const dx=br.b[0]-br.a[0],dz=br.b[1]-br.a[1],len=Math.hypot(dx,dz)||1,deckAt=(x,z)=>{const s=Math.max(0,Math.min(1,((x-br.a[0])*dx+(z-br.a[1])*dz)/(len*len)));return deckY(br,s)+.02;};
    const deck=lanes(pts,[w/2,-w/2],w);b.band(deck.lines,deck.along,deckAt,()=>COL.plank,(i,j,s)=>[s/PLANK,j?.02:.98],TILE.plank);
    // Landings: a half disc of the road's own surface past each deck end, as wide as the deck. The deck is wider than
    // the road and its end is square to the bridge, so where the road turned off the bridge line a wedge of grass
    // showed between the deck corner and the road edge. Its setts or ruts run on the bridge's line.
    const axis=(x,z)=>[((x-br.a[0])*dx+(z-br.a[1])*dz)/len,(-(x-br.a[0])*dz+(z-br.a[1])*dx)/len],out=Math.atan2(dz,dx);
    const surface=br.kind==='local'?['local',COL.sett,(x,z)=>{const [s,l]=axis(x,z);return [l/SETT,s/SETT];},TILE.sett]:['between',COL.dirt,(x,z)=>{const [s,l]=axis(x,z);return [s/EARTH,.5+.48*Math.max(-1,Math.min(1,l/(br.width+.4)))];},TILE.earth];
    for(const [end,dir] of [[br.b,out],[br.a,out+Math.PI]])b.disc(end[0],end[1],w/2,onRoad(surface[0]),surface[1],surface[2],surface[3],12,dir-Math.PI/2,dir+Math.PI/2);
    for(const side of [1,-1]){
      b.wall(br.a,br.b,side*w/2,s=>deckY(br,s)-.32,s=>deckY(br,s)+.02,COL.skirt);
      b.wall(br.a,br.b,side*(w/2-.06),s=>deckY(br,s)+.02,s=>deckY(br,s)+.5,COL.rail);
    }
  }
  return b.mesh(groundMaterial);
}

// Shared clock for the animated ground effects (links and magic lights); town.js advances it.
export const groundClock={value:0};
// Delegation links of the selected cat: a trail of small paw prints along each walking path, left and right in turn,
// stamping forward in the direction of travel and fading in and out at both ends. One instanced draw. Hidden when
// nothing is selected, so the physical roads are the only network on the ground.
// PAW: print length (m), spacing along the path, offset either side of its line, toe-out, and the smallest size on
// screen (px), up to MAX_GROW times the print's own size when zoomed far out.
export const PAW={size:.28,step:.35,side:.12,toe:.14,minPx:18,maxGrow:4,opacity:.55};
// town.js sets uGrow (from pixels per metre) and uMotion (0 under reduced motion: still prints) every frame.
export const pawUniforms={uGrow:{value:1},uMotion:{value:1}};
let pawMaterial=null;
// The print: a pad and four toe beans in warm cream (--needs #fff3dc) with a soft ink rim (--ink #4b473d), so it
// reads on pale stone by day and on dark ground at night. Toes point to the top of the canvas.
function pawTexture(){
  const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d');
  const shapes=[[32,42,13,11,0],[17,25,5.2,6.6,-.35],[26.5,18,5.4,7,-.12],[37.5,18,5.4,7,.12],[47,25,5.2,6.6,.35]];
  const draw=(grow=0)=>{ctx.beginPath();for(const [x,y,rx,ry,a] of shapes){ctx.moveTo(x+(rx+grow)*Math.cos(a),y+(rx+grow)*Math.sin(a));ctx.ellipse(x,y,rx+grow,ry+grow,a,0,Math.PI*2);}ctx.fill();};
  ctx.fillStyle='rgba(75,71,61,.7)';ctx.filter='blur(2.5px)';draw(3);ctx.filter='none';
  ctx.fillStyle='#4b473d';draw(2);
  ctx.fillStyle='#fff3dc';draw();
  // The main pad's three lobes: two soft notches along its top edge.
  ctx.globalCompositeOperation='destination-out';ctx.fillStyle='rgba(0,0,0,.35)';for(const x of [27,37]){ctx.beginPath();ctx.ellipse(x,31.5,2.2,2.6,0,0,Math.PI*2);ctx.fill();}
  const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.anisotropy=4;return t;
}
export function buildLinks(paths,walk){
  pawMaterial??=(()=>{const m=new T.MeshBasicMaterial({map:pawTexture(),transparent:true,opacity:PAW.opacity,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-6});
    m.onBeforeCompile=shader=>{Object.assign(shader.uniforms,{uTime:groundClock},pawUniforms);
      // aPrint: x = metres from the path's start, y = metres to its end. A stamp wave runs forward along every path
      // (2.4 m/s, one every 1.7 s): each print presses in a little and brightens as it passes, then settles.
      shader.vertexShader='attribute vec2 aPrint;uniform float uTime,uGrow,uMotion;varying vec2 vPrint;varying float vStamp;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+String.fromCharCode(10)+
        'vPrint=aPrint;vStamp=uMotion*exp(-5.*fract(uTime*.6-aPrint.x/4.));transformed.xz*=uGrow*(1.+.12*uMotion*exp(-14.*fract(uTime*.6-aPrint.x/4.)));');
      shader.fragmentShader='varying vec2 vPrint;varying float vStamp;'+String.fromCharCode(10)+shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>'+String.fromCharCode(10)+
        'diffuseColor.a*=smoothstep(0.,1.4,vPrint.x)*smoothstep(0.,1.4,vPrint.y)*(.8+.2*vStamp);');};
    m.customProgramCacheKey=()=>'paw-trail';return m;})();
  // Prints every PAW.step metres, alternating sides; where two paths share a stretch, one print per spot.
  const prints=[],taken=new Set(),cell=PAW.step*.5;
  for(const points of paths){
    if(points.length<2)continue;
    const s=[0];for(let i=1;i<points.length;i++)s.push(s[i-1]+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
    const total=s.at(-1);let i=1,k=0;
    for(let d=PAW.step/2;d<total;d+=PAW.step,k++){
      while(i<points.length-1&&s[i]<d)i++;
      const a=points[i-1],b=points[i],len=s[i]-s[i-1]||1,t=(d-s[i-1])/len,dx=(b[0]-a[0])/len,dz=(b[1]-a[1])/len,side=k%2?1:-1;
      const x=a[0]+(b[0]-a[0])*t-dz*PAW.side*side,z=a[1]+(b[1]-a[1])*t+dx*PAW.side*side,key=Math.round(x/cell)+','+Math.round(z/cell);
      if(taken.has(key))continue;taken.add(key);
      prints.push({x,z,yaw:Math.atan2(-dx,-dz)-side*PAW.toe,from:d,to:total-d});
    }
  }
  const geo=new T.PlaneGeometry(PAW.size*.85,PAW.size).rotateX(-Math.PI/2),data=new Float32Array(Math.max(1,prints.length)*2);
  const mesh=new T.InstancedMesh(geo,pawMaterial,Math.max(1,prints.length)),m=new T.Matrix4(),q=new T.Quaternion(),up=new T.Vector3(0,1,0),p=new T.Vector3(),one=new T.Vector3(1,1,1);
  prints.forEach((pr,i)=>{mesh.setMatrixAt(i,m.compose(p.set(pr.x,walk(pr.x,pr.z)+LIFT.inlay,pr.z),q.setFromAxisAngle(up,pr.yaw),one));data[i*2]=pr.from;data[i*2+1]=pr.to;});
  geo.setAttribute('aPrint',new T.InstancedBufferAttribute(data,2));
  mesh.count=prints.length;mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();
  // The bounding sphere is from the prints' centres; zoomed out they grow (uGrow), so it is not used to cull them.
  mesh.frustumCulled=false;mesh.userData.ownedGeometry=true;mesh.renderOrder=3;return mesh;
}

// Night "magic lights": soft orbs floating beside every street toward every door. One Points draw, additive, no shadows.
let magicMaterial=null;
export function buildMagicLights(roads,walk,spacing=3.2){
  magicMaterial??=(()=>{const m=new T.PointsMaterial({size:16,map:poolTexture(),transparent:true,depthWrite:false,blending:T.AdditiveBlending,color:'#fff0c0'});
    m.onBeforeCompile=shader=>{shader.uniforms.uTime=groundClock;
      shader.vertexShader='uniform float uTime;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+String.fromCharCode(10)+'float magicPhase=fract(sin(dot(position.xz,vec2(12.9898,78.233)))*43758.5453)*6.2832;transformed.y+=sin(uTime*1.3+magicPhase)*.22;transformed.x+=sin(uTime*.7+magicPhase*2.)*.12;');};
    m.customProgramCacheKey=()=>'magic-lights';return m;})();
  const pos=[];let side=1;
  for(const road of roads){
    const p=road.points,off=road.width+.55;let next=spacing/2,travelled=0;
    for(let i=1;i<p.length;i++){
      const a=p[i-1],b=p[i],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!len)continue;const nx=-(b[1]-a[1])/len,nz=(b[0]-a[0])/len;
      for(;next<=travelled+len;next+=spacing){const t=(next-travelled)/len,x=a[0]+(b[0]-a[0])*t+nx*off*side,z=a[1]+(b[1]-a[1])*t+nz*off*side;pos.push(x,walk(x,z)+.9,z);side=-side;}
      travelled+=len;
    }
  }
  const pts=new T.Points(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(pos,3)),magicMaterial);pts.userData.ownedGeometry=true;pts.renderOrder=3;return pts;
}

// Street lamps: the baked lantern lamp (world-art.js streetLamp) as two InstancedMeshes (post and glass, the glass on the
// shared glow material, so night lighting applies), warm light pools on the ground under each lantern, and a soft glow
// sprite round every lantern (one instanced billboard, additive). Pools and glows are lit by the time of day's `lamps`
// and hidden at 0 (town.js applyLight), so day draws neither.
const poolGeo=new T.CircleGeometry(3.4,28).rotateX(-Math.PI/2),haloGeo=new T.PlaneGeometry(1,1);
let poolMaterial=null,haloMaterial=null;
function poolTexture(stops=[[0,'rgba(255,214,140,.55)'],[.5,'rgba(255,200,120,.2)'],[1,'rgba(255,190,110,0)']]){
  const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d'),g=ctx.createRadialGradient(32,32,0,32,32,32);
  for(const [at,colour] of stops)g.addColorStop(at,colour);ctx.fillStyle=g;ctx.fillRect(0,0,64,64);
  const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;return t;
}
const LAMP_LIGHT=[[0,'rgba(255,190,110,.85)'],[.4,'rgba(255,170,90,.36)'],[1,'rgba(255,150,70,0)']];
function haloMaterialFor(){
  const m=new T.MeshBasicMaterial({map:poolTexture(LAMP_LIGHT),color:'#ffe2b0',transparent:true,depthWrite:false,blending:T.AdditiveBlending,fog:false});
  // Billboard: each instance's quad faces the camera at the instance's position, as wide as the instance's x scale.
  m.onBeforeCompile=shader=>{shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',
    'vec4 mvPosition=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);mvPosition.xy+=position.xy*length(instanceMatrix[0].xyz);gl_Position=projectionMatrix*mvPosition;');};
  m.customProgramCacheKey=()=>'lamp-halo';return m;
}
export function buildLamps(spots,walk){
  poolMaterial??=new T.MeshBasicMaterial({map:poolTexture(LAMP_LIGHT),transparent:true,depthWrite:false,blending:T.AdditiveBlending,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-4});
  haloMaterial??=haloMaterialFor();
  const lamp=streetLamp(),n=spots.length,group=new T.Group(),m=new T.Matrix4(),q=new T.Quaternion(),up=new T.Vector3(0,1,0),one=new T.Vector3(1,1,1),at=new T.Vector3(),head=new T.Vector3();
  const post=new T.InstancedMesh(lamp.solid,lamp.materials.solid,n),glass=new T.InstancedMesh(lamp.glow,lamp.materials.glow,n),pool=new T.InstancedMesh(poolGeo,poolMaterial,n),halo=new T.InstancedMesh(haloGeo,haloMaterial,n);
  spots.forEach((s,i)=>{
    // Each lamp turns its arm its own way (a stable hash of its spot), so rows of lamps do not read as stamped.
    const h=walk(s.x,s.z);q.setFromAxisAngle(up,noise2(s.x*.7,s.z*.7,81)*Math.PI*2);
    m.compose(at.set(s.x,h,s.z),q,one);post.setMatrixAt(i,m);glass.setMatrixAt(i,m);
    head.set(...lamp.head).applyQuaternion(q).add(at);
    m.makeTranslation(head.x,h+.12,head.z);pool.setMatrixAt(i,m);
    m.makeScale(1.7,1.7,1.7).setPosition(head);halo.setMatrixAt(i,m);
  });
  for(const mesh of [post,glass,pool,halo]){mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();}
  pool.renderOrder=2;halo.renderOrder=4;group.userData.pools=pool;group.userData.halos=halo;group.add(post,glass,pool,halo);return group;
}

// Contact shadows: a soft dark ellipse under every house, plaza feature and lamp, so they sit on the ground at any time
// of day (the sun's shadow falls to one side only). One InstancedMesh, never in the shadow pass, alpha-blended a
// violet-grey over the paving and grass. items: [{x, y, z, w, d, yaw}] in metres (y = the ground under it).
let contactMaterial=null;
export function buildContactShadows(items){
  contactMaterial??=new T.MeshBasicMaterial({map:poolTexture([[0,'rgba(255,255,255,.6)'],[.55,'rgba(255,255,255,.38)'],[1,'rgba(255,255,255,0)']]),color:'#2e2638',transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-6});
  const mesh=new T.InstancedMesh(new T.PlaneGeometry(1,1).rotateX(-Math.PI/2),contactMaterial,Math.max(1,items.length)),m=new T.Matrix4(),q=new T.Quaternion(),up=new T.Vector3(0,1,0),p=new T.Vector3(),s=new T.Vector3();
  items.forEach((it,i)=>{m.compose(p.set(it.x,it.y+LIFT.inlay,it.z),q.setFromAxisAngle(up,it.yaw||0),s.set(it.w,1,it.d));mesh.setMatrixAt(i,m);});
  mesh.count=items.length;mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();mesh.renderOrder=1;mesh.userData.ownedGeometry=true;return mesh;
}

// Grass along the town's edges: tufts just outside every common's kerb ring and every cobbled street's kerbs, where the
// meadow's own grass keeps clear of the paving. One InstancedMesh with the meadow's grass clump and material (grass.js).
export function buildEdgeGrass({sites,roads,yards,homes,common,L},height,water){
  const pts=[],streets=makeBlocker({roads:roads.filter(r=>r.width>0)}),radius=s=>s.common??common,houseYards=homes.filter(h=>h.plot!==0).map(h=>({x:h.x,z:h.z,r:L.house_radius*.8}));
  const clear=(x,z)=>!streets.onRoad(x,z,.25)&&!sites.some(s=>Math.hypot(x-s.x,z-s.z)<radius(s)+.3)&&![...yards,...houseYards].some(y=>Math.hypot(x-y.x,z-y.z)<y.r+.2)&&height(x,z)>water+.6;
  const add=(x,z,k)=>{if(clear(x,z))pts.push([x,z,noise2(x*3.1,z*3.1,k)]);};
  for(const s of sites){const r=radius(s)+.45,n=Math.ceil(Math.PI*2*r/.42);for(let i=0;i<n;i++){const a=(i+.5*noise2(i,s.x,91))/n*Math.PI*2,rr=r+.15*noise2(i,s.z,92);add(s.x+Math.cos(a)*rr,s.z+Math.sin(a)*rr,93);}}
  for(const chain of chains(roads).filter(c=>c.kind==='local'))for(const side of [1,-1]){const k=lanes(chain.points,[side*(chain.width+.42)],2*chain.width,.45);for(const [x,z] of k.lines[0]||[])add(x,z,94);}
  // Roots in the ground colour by the kerbs (meadow.js colourAt leans the land there toward PAL.town), as the meadow's own clumps.
  const mesh=new T.InstancedMesh(propGeometries().tuft,grassMaterial(),Math.max(1,pts.length)),t=new T.Object3D(),tint=new T.Color(),root=PAL.meadow.clone().lerp(PAL.town,.35);
  // A little below the held ground: the meadow's own land dips under road edges (meadow.js), and a floating tuft shows.
  pts.forEach(([x,z,c],i)=>{t.position.set(x,height(x,z)-.12,z);t.rotation.set(0,c*Math.PI,0);const s=.95+.35*(c*.5+.5);t.scale.set(s,s*(.85+.3*((c*3.7%1+1)%1)),s);t.updateMatrix();mesh.setMatrixAt(i,t.matrix);mesh.setColorAt(i,tint.setRGB(1+c*.05,1+c*.03,1-c*.04).multiply(root));});
  mesh.count=pts.length;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;mesh.computeBoundingSphere();mesh.receiveShadow=true;return mesh;
}

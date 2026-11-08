// The streamed land around the camera: one merged terrain mesh, one water mesh, and instanced props (trees, bushes,
// rocks, reeds, flowers, grass). Draw calls stay flat however far the camera sees: every prop kind is one
// InstancedMesh for the whole streamed area (trees split into a shadow-casting near set and a far set).
import * as T from 'three';
import {noise2} from './terrain.js';
import {scatterChunk,grassChunk,makeBlocker,wildness,DECOR} from './vegetation.js';
import {propGeometries,propMaterial,wind} from './world-art.js';
import {createWaterMaterial} from './water.js';

const C=c=>new T.Color(c);
// Sage greens, a little less saturated than the first grass pass, so the meadow sits behind the houses and cats.
export const PAL={meadow:C('#98b47a'),lush:C('#8aab72'),dry:C('#b5c088'),sand:C('#d2c194'),wet:C('#a99a74'),bed:C('#6d7d5f'),town:C('#9fb781')};

// Painted grass for the ground: soft blotches and short rounded strokes, seamless, drawn once. Stored around 0.85 so it
// can both darken and (x1.2 in the shader) lighten the vertex colour; mipmapped and anisotropic so it never shimmers.
function grassTexture(anisotropy){
  const N=512,c=document.createElement('canvas');c.width=c.height=N;const g=c.getContext('2d'),rnd=(()=>{let h=7;return ()=>(h=(h*16807)%2147483647)/2147483647;})();
  g.fillStyle='rgb(214,222,196)';g.fillRect(0,0,N,N);
  const wrap=(draw,x,y,r)=>{for(const dx of [-N,0,N])for(const dy of [-N,0,N])if(x+dx>-r&&x+dx<N+r&&y+dy>-r&&y+dy<N+r)draw(x+dx,y+dy);};
  for(let i=0;i<70;i++){const x=rnd()*N,y=rnd()*N,r=30+rnd()*70,light=rnd()>.5;
    wrap((px,py)=>{const grad=g.createRadialGradient(px,py,0,px,py,r);grad.addColorStop(0,light?'rgba(240,246,214,.26)':'rgba(170,190,140,.22)');grad.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=grad;g.fillRect(px-r,py-r,r*2,r*2);},x,y,r);}
  g.lineCap='round';
  for(let i=0;i<2600;i++){
    const x=rnd()*N,y=rnd()*N,len=7+rnd()*9,lean=(rnd()-.5)*.9,t=rnd(),w=2.2+rnd()*1.8;
    const col=t<.45?`rgba(${150+t*60|0},${176+t*50|0},${120+t*40|0},.42)`:`rgba(${226+t*20|0},${236+t*12|0},${196+t*20|0},.38)`;
    wrap((px,py)=>{g.strokeStyle=col;g.lineWidth=w;g.beginPath();g.moveTo(px,py);g.quadraticCurveTo(px+lean*len*.3,py-len*.6,px+lean*len,py-len);g.stroke();},x,y,20);
  }
  const tex=new T.CanvasTexture(c);tex.wrapS=tex.wrapT=T.RepeatWrapping;tex.colorSpace=T.SRGBColorSpace;tex.anisotropy=anisotropy;tex.minFilter=T.LinearMipmapLinearFilter;
  return tex;
}
const GRASS_TILE=3.2;// metres per repeat of the painted grass

export function createMeadow(scene,{mobile,anisotropy=4}){
  const terrainMaterial=new T.MeshStandardMaterial({vertexColors:true,roughness:1,map:grassTexture(anisotropy)});
  // The painted grass shows where vertex attribute grassW is 1 (meadow) and fades out on sand, banks and riverbed.
  terrainMaterial.onBeforeCompile=shader=>{
    shader.vertexShader='attribute float grassW;varying float vGrassW;'+String.fromCharCode(10)+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+String.fromCharCode(10)+'vGrassW=grassW;');
    shader.fragmentShader='varying float vGrassW;'+String.fromCharCode(10)+shader.fragmentShader.replace('#include <map_fragment>','#ifdef USE_MAP'+String.fromCharCode(10)+'diffuseColor.rgb*=mix(vec3(1.),texture2D(map,vMapUv).rgb*1.2,vGrassW);'+String.fromCharCode(10)+'#endif');
  };
  terrainMaterial.customProgramCacheKey=()=>'meadow-ground';
  const terrainMesh=new T.Mesh(new T.BufferGeometry(),terrainMaterial);terrainMesh.receiveShadow=true;terrainMesh.frustumCulled=false;scene.add(terrainMesh);
  // Outer land: a bare ring of the same ground at a coarse step around the streamed land, so a low camera angle shows
  // meadow running into the haze instead of the edge of the world. One draw, shown only when the view reaches the edge.
  const outerLand=new T.Mesh(new T.BufferGeometry(),terrainMaterial);outerLand.receiveShadow=true;outerLand.frustumCulled=false;scene.add(outerLand);
  const OUTER_STEP=8,OUTER_RINGS=5;
  // Water: one mesh at the water line over every terrain quad that dips below it (water.js), drawn after the land.
  const waterLook=createWaterMaterial(wind.uTime);
  const water=new T.Mesh(new T.BufferGeometry(),waterLook.material);water.renderOrder=1;water.frustumCulled=false;scene.add(water);

  const geos=propGeometries(),solid=propMaterial(),flat=propMaterial({flat:true}),swaying=propMaterial({sway:.09,side:T.DoubleSide}),grassy=propMaterial({sway:.9});
  const props=new T.Group();scene.add(props);
  let world=null,tiles=new Map(),scatter=new Map(),grass=new Map(),key='',grassMesh=null,grassTotal=0;
  // Reach culling: terrain tiles and prop instances are stored nearest-first from the centre chunk's middle, with their
  // distances, so each frame draws only the prefix that can show on screen (see update's reach). One draw each still.
  let centre=[0,0],terrainReach=null,ranged=[],waterTiles=[],waterOuter=null;
  const upTo=(sorted,d)=>{let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>1;if(sorted[mid]<=d)lo=mid+1;else hi=mid;}return lo;};
  const tmp=new T.Object3D(),tint=new T.Color();

  /** World: terrain t, ground height(x,z), town layout (its circles include the memorial grounds) and holds, chunk settings and grass counts. */
  function setWorld(next){
    world={...next,blocked:makeBlocker(next.layout)};world.wild=wildness(next.layout,next.t.P.clearing,world.blocked);
    const sites=next.holds.filter(h=>h.site);world.town=(x,z)=>sites.some(h=>Math.hypot(x-h.x,z-h.z)<h.r+2);
    tiles.clear();scatter.clear();grass.clear();key='';
    waterLook.uniforms.uBed.value=next.t.P.bed;
  }
  const ctx=()=>({size:world.chunkSize,height:world.height,water:world.t.water,blocked:world.blocked,town:world.town,river:world.t.river,plain:world.t.P.plain_y,treeCell:4.2,wild:world.wild,clearing:world.t.P.clearing,lift:world.height.lift,knolls:world.t.P.knolls});

  function colourAt(x,z,h,out){
    const W=world.t.water;
    if(h<W+.05)return out.copy(PAL.bed).lerp(PAL.wet,Math.max(0,Math.min(1,(h-W+.9)/.95)));
    if(h<W+.45)return out.copy(PAL.wet).lerp(PAL.sand,(h-W-.05)/.4);
    const lush=noise2(x*.021,z*.021,301)*.5+.5,dry=noise2(x*.0075,z*.0075,302);
    out.copy(PAL.meadow).lerp(PAL.lush,lush*.8).lerp(PAL.dry,Math.max(0,dry)*.75);
    // Knoll crests (terrain.js knolls) dry out a little, so the rises read from the high camera, not only in low sun.
    const K=world.t.P.knolls;if(K)out.lerp(PAL.dry,Math.min(1,world.height.lift(x,z)/K[1])*.4);
    if(h<W+.9)out.lerp(PAL.sand,(W+.9-h)/.45*.6);
    if(world.town(x,z))out.lerp(PAL.town,.35);
    return out;
  }
  // One chunk of terrain at `step` metres, world space, with normals from the height field so tiles meet seamlessly.
  function tile(cx,cz){
    const id=cx+':'+cz;if(tiles.has(id))return tiles.get(id);
    const size=world.chunkSize,n=Math.max(1,Math.round(size/world.step)),step=size/n,H=world.height,pos=new Float32Array((n+1)*(n+1)*3),nrm=new Float32Array(pos.length),col=new Float32Array(pos.length),uv=new Float32Array((n+1)*(n+1)*2),grassW=new Float32Array((n+1)*(n+1)),c=new T.Color(),W=world.t.water;
    let k=0;
    for(let j=0;j<=n;j++)for(let i=0;i<=n;i++,k+=3){
      // Land under roads drops a little, so the coarse grid never pokes through a road ribbon on a slope or bank.
      const x=cx*size+i*step,z=cz*size+j*step,h=H(x,z)-(world.blocked.onRoad(x,z,step*.6)?.18:0),hx=H(x+.5,z)-H(x-.5,z),hz=H(x,z+.5)-H(x,z-.5),l=Math.hypot(hx,1,hz);
      pos[k]=x;pos[k+1]=h;pos[k+2]=z;nrm[k]=-hx/l;nrm[k+1]=1/l;nrm[k+2]=-hz/l;colourAt(x,z,h,c).toArray(col,k);
      const v=k/3;uv[v*2]=x/GRASS_TILE;uv[v*2+1]=z/GRASS_TILE;grassW[v]=Math.min(1,Math.max(0,(h-W-.45)/.5));
    }
    const t={pos,nrm,col,uv,grassW,n};tiles.set(id,t);return t;
  }
  function rebuildTerrain(ids){
    const size=world.chunkSize,away=([x,z])=>Math.hypot((x+.5)*size-centre[0],(z+.5)*size-centre[1])-size*Math.SQRT1_2;
    ids=ids.slice().sort((a,b)=>away(a)-away(b));
    const list=ids.map(([x,z])=>tile(x,z)),near=new Float32Array(ids.length),ends=new Uint32Array(ids.length),verts=list.reduce((s,t)=>s+(t.n+1)**2,0),pos=new Float32Array(verts*3),nrm=new Float32Array(verts*3),col=new Float32Array(verts*3),uv=new Float32Array(verts*2),grassW=new Float32Array(verts),index=[];
    let v=0;
    list.forEach((t,k)=>{
      pos.set(t.pos,v*3);nrm.set(t.nrm,v*3);col.set(t.col,v*3);uv.set(t.uv,v*2);grassW.set(t.grassW,v);const w=t.n+1;
      for(let j=0;j<t.n;j++)for(let i=0;i<t.n;i++){const a=v+j*w+i;index.push(a,a+w,a+1,a+1,a+w,a+w+1);}
      v+=w*w;near[k]=away(ids[k]);ends[k]=index.length;
    });
    terrainReach={near,ends};waterTiles=list;
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(pos,3));geo.setAttribute('normal',new T.BufferAttribute(nrm,3));geo.setAttribute('color',new T.BufferAttribute(col,3));geo.setAttribute('uv',new T.BufferAttribute(uv,2));geo.setAttribute('grassW',new T.BufferAttribute(grassW,1));
    geo.setIndex(verts>65535?new T.Uint32BufferAttribute(index,1):new T.Uint16BufferAttribute(index,1));
    terrainMesh.geometry.dispose();terrainMesh.geometry=geo;
  }
  /** The ring between the streamed land square and OUTER_RINGS chunks beyond it, plus a 0.6 m curtain hung from the
   *  land's edge that closes the hairline cracks where the coarse ring meets the finer tiles. */
  function rebuildOuter(cx,cz){
    const size=world.chunkSize,r=world.landRadius,H=world.height,W=world.t.water,S=OUTER_STEP,E=OUTER_RINGS*size,c=new T.Color();
    const x0=(cx-r)*size,x1=(cx+r+1)*size,z0=(cz-r)*size,z1=(cz+r+1)*size,n=Math.round((x1-x0+2*E)/S);
    const pos=[],nrm=[],col=[],uv=[],gw=[],index=[];
    const vert=(x,z,y,up)=>{const h=H(x,z),hx=up?0:H(x+.5,z)-H(x-.5,z),hz=up?0:H(x,z+.5)-H(x,z-.5),l=Math.hypot(hx,1,hz);
      pos.push(x,y??h,z);nrm.push(-hx/l,1/l,-hz/l);colourAt(x,z,h,c);col.push(c.r,c.g,c.b);uv.push(x/GRASS_TILE,z/GRASS_TILE);gw.push(Math.min(1,Math.max(0,(h-W-.45)/.5)));return pos.length/3-1;};
    for(let j=0;j<=n;j++)for(let i=0;i<=n;i++)vert(x0-E+i*S,z0-E+j*S);
    const inner=(i,j)=>{const x=x0-E+i*S,z=z0-E+j*S;return x>=x0&&x+S<=x1&&z>=z0&&z+S<=z1;};
    for(let j=0;j<n;j++)for(let i=0;i<n;i++){
      if(inner(i,j))continue;
      const a=j*(n+1)+i;index.push(a,a+n+1,a+1,a+1,a+n+1,a+n+2);
    }
    waterOuter={pos,n,skip:inner};
    // Curtain: along each side of the land square at the terrain step, facing outwards.
    const step=size/Math.max(1,Math.round(size/world.step));
    for(const [ax,az,bx,bz,ox,oz] of [[x0,z0,x1,z0,0,-1],[x1,z0,x1,z1,1,0],[x1,z1,x0,z1,0,1],[x0,z1,x0,z0,-1,0]]){
      const len=Math.hypot(bx-ax,bz-az),m=Math.round(len/step);
      for(let k=0;k<m;k++){
        const p=[ax+(bx-ax)*k/m,az+(bz-az)*k/m],q=[ax+(bx-ax)*(k+1)/m,az+(bz-az)*(k+1)/m];
        const pt=vert(p[0],p[1],undefined,true),qt=vert(q[0],q[1],undefined,true),pb=vert(p[0],p[1],H(p[0],p[1])-.6,true),qb=vert(q[0],q[1],H(q[0],q[1])-.6,true);
        // Front face outwards: (pt,qt,pb) has normal (q-p) x down, which points to (ox,oz) when that cross is outward.
        const ex=q[0]-p[0],ez=q[1]-p[1],out=ez*ox-ex*oz>0;index.push(...(out?[pt,qt,pb,qt,qb,pb]:[pt,pb,qt,qt,pb,qb]));
      }
    }
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('normal',new T.Float32BufferAttribute(nrm,3));geo.setAttribute('color',new T.Float32BufferAttribute(col,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.setAttribute('grassW',new T.Float32BufferAttribute(gw,1));geo.setIndex(index);
    outerLand.geometry.dispose();outerLand.geometry=geo;
  }
  /** The water mesh: every land quad (fine tiles and the outer ring) with a corner below the water line, flattened onto
   *  it, with `depth` = water line - ground. Same quads and diagonals as the land, so depth 0 is the drawn shoreline. */
  function rebuildWater(){
    const W=world.t.water,pos=[],depth=[],index=[];
    const add=(P,n,skip)=>{
      const w=n+1,seen=new Map(),v=k=>{let o=seen.get(k);if(o===undefined){o=pos.length/3;pos.push(P[k*3],W,P[k*3+2]);depth.push(W-P[k*3+1]);seen.set(k,o);}return o;};
      for(let j=0;j<n;j++)for(let i=0;i<n;i++){
        const a=j*w+i;if(P[a*3+1]>=W&&P[(a+1)*3+1]>=W&&P[(a+w)*3+1]>=W&&P[(a+w+1)*3+1]>=W||skip&&skip(i,j))continue;
        index.push(v(a),v(a+w),v(a+1),v(a+1),v(a+w),v(a+w+1));
      }
    };
    for(const t of waterTiles)add(t.pos,t.n);
    if(waterOuter)add(waterOuter.pos,waterOuter.n,waterOuter.skip);
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('depth',new T.Float32BufferAttribute(depth,1));
    geo.setAttribute('normal',new T.Float32BufferAttribute(new Float32Array(pos.length).map((_,k)=>k%3===1?1:0),3));geo.setIndex(index);
    water.geometry.dispose();water.geometry=geo;water.visible=index.length>0;
  }
  const scatterOf=(x,z)=>{const id=x+':'+z;if(!scatter.has(id))scatter.set(id,scatterChunk(x,z,ctx()));return scatter.get(id);};
  const grassOf=(x,z,count)=>{const id=x+':'+z;let g=grass.get(id);if(!g||g.asked<count){g={asked:count,list:grassChunk(x,z,count,ctx())};grass.set(id,g);}return g.list;};

  function instanced(geo,material,items,{shadow=false,tintAmount=1,sorted=true}={}){
    if(!items.length)return null;
    const mesh=new T.InstancedMesh(geo,material,items.length);
    // Nearest first, so a prefix (mesh.count) is everything within a radius of the centre.
    if(sorted)items=items.map(p=>({p,d:Math.hypot(p.x-centre[0],p.z-centre[1])})).sort((a,b)=>a.d-b.d);
    const reach=sorted?Float32Array.from(items,i=>i.d):null;if(sorted)items=items.map(i=>i.p);
    items.forEach((p,i)=>{
      tmp.position.set(p.x,p.y,p.z);tmp.rotation.set(0,p.r,0);tmp.scale.setScalar(p.s);tmp.updateMatrix();mesh.setMatrixAt(i,tmp.matrix);
      const c=(p.c-.5)*tintAmount;mesh.setColorAt(i,tint.setRGB(1+c*.16,1+c*.1,1-c*.14));
    });
    mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;mesh.computeBoundingSphere();
    mesh.castShadow=shadow;mesh.receiveShadow=true;props.add(mesh);mesh.userData.reach=reach;return mesh;
  }
  function rebuildProps(cx,cz,rings){
    for(const m of [...props.children]){m.dispose();props.remove(m);}
    const near=[],far=[],bushes=[],farBushes=[],rocks=[],reeds=[],flowers=[[],[]],tufts=[],decor=Object.fromEntries(DECOR.map(([k])=>[k,[]]));
    for(const [x,z,ring] of rings){
      const s=scatterOf(x,z);
      for(const tree of s.trees)(ring<=1?near:far).push(tree);
      for(const b of s.bushes)(ring<=1?bushes:farBushes).push(b);rocks.push(...s.rocks);
      if(ring<=world.detailRing){reeds.push(...s.reeds);for(const f of s.flowers)flowers[f.v].push(f);for(const k in decor)for(const p of s[k])if(!mobile||p.c<.5)decor[k].push(p);}
      const count=ring<=1?world.grassPerChunk:ring<=world.detailRing?Math.round(world.grassPerChunk*.45):0;
      if(count)tufts.push(...grassOf(x,z,world.grassPerChunk).slice(0,count));
    }
    for(let v=0;v<geos.trees.length;v++){
      instanced(geos.trees[v],solid,near.filter(t=>t.v===v),{shadow:true});
      instanced(geos.trees[v],solid,far.filter(t=>t.v===v));
    }
    instanced(geos.bush,solid,bushes,{shadow:true});instanced(geos.bush,solid,farBushes);instanced(geos.rock,flat,rocks,{shadow:true});
    instanced(geos.reed,swaying,reeds);flowers.forEach((list,v)=>instanced(geos.flowers[v],swaying,list,{tintAmount:.5}));
    // Odds and ends: one draw a kind, no shadow pass (it would be a second); half as many on phones.
    for(const k in decor)instanced(geos[k],k==='cairns'?flat:solid,decor[k],{tintAmount:.6});
    // Grass in random order, so drawing a prefix (mesh.count) thins it evenly when zoomed out.
    for(let i=tufts.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[tufts[i],tufts[j]]=[tufts[j],tufts[i]];}
    grassMesh=instanced(geos.tuft,grassy,tufts,{tintAmount:1.6,sorted:false});grassTotal=tufts.length;
    ranged=props.children.filter(m=>m!==grassMesh);
  }

  const chunkKey=(x,z)=>Math.floor(x/world.chunkSize)+':'+Math.floor(z/world.chunkSize);
  /** The rebuild for the chunk under (x,z) as separate steps (chunk caches in batches, terrain, outer ring, water, props),
   *  so a caller can spread it over frames (town.js resetWorld). update() runs them all at once. */
  function rebuildSteps(x,z,chunksPerStep=Infinity){
    const size=world.chunkSize,cx=Math.floor(x/size),cz=Math.floor(z/size),r=world.landRadius,ids=[],rings=[];
    key=cx+':'+cz;centre=[(cx+.5)*size,(cz+.5)*size];
    for(let i=cx-r;i<=cx+r;i++)for(let j=cz-r;j<=cz+r;j++){ids.push([i,j]);rings.push([i,j,Math.max(Math.abs(i-cx),Math.abs(j-cz))]);}
    // Warm steps fill the per-chunk caches (terrain tile, scatter, grass) that the rebuild steps then only assemble.
    const warm=[];for(let k=0;k<rings.length&&chunksPerStep<rings.length;k+=chunksPerStep){const part=rings.slice(k,k+chunksPerStep);warm.push(()=>{for(const [i,j,ring] of part){tile(i,j);scatterOf(i,j);if(ring<=world.detailRing)grassOf(i,j,world.grassPerChunk);}});}
    return [...warm,()=>rebuildTerrain(ids),()=>rebuildOuter(cx,cz),()=>rebuildWater(),()=>rebuildProps(cx,cz,rings)];
  }
  /** Streams around (x,z). Rebuilds only when the centre chunk or the world changes (returns true then); grass thins with zoom.
   *  reach: ground radius around (x,z) that can show on screen; terrain and props beyond it are not drawn. */
  function update(x,z,zoom,time,reach=Infinity){
    wind.uTime.value=time;
    if(!world)return false;let rebuilt=false;
    const size=world.chunkSize;
    if(chunkKey(x,z)!==key){for(const step of rebuildSteps(x,z))step();rebuilt=true;}
    if(grassMesh)grassMesh.count=Math.round(grassTotal*Math.min(1,Math.max(.3,(zoom-.25)/.9)));
    // Measured from the centre chunk's middle: the reach circle around (x,z) lies inside reach + |offset| of it.
    const limit=reach+Math.hypot(x-centre[0],z-centre[1]);
    for(const m of ranged){m.count=upTo(m.userData.reach,limit);m.visible=m.count>0;}
    outerLand.visible=limit>world.landRadius*size;
    if(terrainReach){const n=upTo(terrainReach.near,limit);terrainMesh.geometry.setDrawRange(0,n?terrainReach.ends[n-1]:0);}
    return rebuilt;
  }
  /** Time-of-day tints: the terrain colour multiplies its vertex colours; water takes its colour as is. */
  function setTint(terrain,water){terrainMaterial.color.copy(terrain);waterLook.setTint(water);}
  /** Snow cover (weather.js via town.js): the ground and the grass glow a cool white by k (0..1, already dimmed for night). */
  function setSnow(k){terrainMaterial.emissive.setRGB(k*.93,k*.96,k);grassy.emissive.setRGB(k*.55,k*.58,k*.6);}
  return {setWorld,update,rebuildSteps,setTint,setSnow,refresh:()=>{key='';}};
}

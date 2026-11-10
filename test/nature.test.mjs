import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {terrain,heldGround,townHolds} from '../public/terrain.js';
import {resolveLayout,siteCentre,planSite,placeInGroup,townLayout} from '../public/hamlet-layout.js';
import {makeBlocker,scatterChunk,wildness,DECOR,ROCK_KINDS,ROCK_FOOT,FLOWER_RADIUS} from '../public/vegetation.js';
import {createWaterMaterial} from '../public/water.js';

const json=f=>JSON.parse(readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const config=json('town.config.json'),raw=config.world.layout,L=resolveLayout(raw),t=terrain(L.terrain),P=L.terrain,C=P.clearing;

// A town of three nooks, six homes each, as the client builds it (held ground, blocker, wildness).
function town(){
  const groups=[{id:'main',site:siteCentre(0,L)}];
  for(const id of ['g1','g2'])groups.push({id,site:planSite(groups.map(g=>g.site),L)});
  const homes=[];
  for(const g of groups)for(let n=0;n<6;n++){const s=placeInGroup(g,homes,groups,L);if(!s)break;homes.push({...s,group:g.id});}
  const cats=homes.map((h,i)=>({id:'c'+i,group:h.group,home:{x:h.x,z:h.z,plot:h.plot,style:'builder'}}));
  const layout=townLayout(cats,groups,raw),memorial=layout.memorial;
  const holds=townHolds(t,layout.sites,homes,{x:memorial.x,z:memorial.z,r:L.memorial_reserve},L),height=heldGround(t,holds);
  const blocked=makeBlocker(layout),sites=holds.filter(h=>h.site);
  const ctx={size:32,height,water:t.water,blocked,town:(x,z)=>sites.some(h=>Math.hypot(x-h.x,z-h.z)<h.r+2),river:t.river,plain:P.plain_y,treeCell:4.2,wild:wildness(layout,C,blocked),clearing:C};
  return {layout,homes,ctx,height};
}
const {layout,homes,ctx,height}=town();
const cache=new Map(),chunk=(cx,cz)=>{const k=cx+':'+cz;if(!cache.has(k))cache.set(k,scatterChunk(cx,cz,ctx));return cache.get(k);};
/** Trees whose chunk overlaps the disc (x,z,r). */
function treesNear(x,z,r){
  const out=[];
  for(let cx=Math.floor((x-r)/32);cx<=Math.floor((x+r)/32);cx++)for(let cz=Math.floor((z-r)/32);cz<=Math.floor((z+r)/32);cz++)out.push(...chunk(cx,cz).trees);
  return out;
}

test('the clearing is configured, and wildness is 0 at every site and the memorial, 1 far out',()=>{
  for(const k of ['meadow_radii','forest_radii','meadow_tree_chance','orchard_below','orchard_blossom','meadow_flowers','road_clear','road_fade','road_floor'])assert.equal(typeof C[k],'number',k);
  assert.ok(C.forest_radii>C.meadow_radii);
  for(const s of [...layout.sites,layout.memorial])assert.equal(ctx.wild(s.x,s.z),0);
  assert.equal(ctx.wild(2000,2000),1);
  assert.equal(wildness(layout,undefined)(0,0),1,'no config: no clearing');
});

test('density falls off around every site: fewer trees within 1.5 hamlet radii than in an equal-area ring past the town',()=>{
  const r0=C.meadow_radii*L.plot_radius,spread=Math.max(...layout.sites.map(a=>Math.max(...layout.sites.map(b=>Math.hypot(a.x-b.x,a.z-b.z))))),D=spread+C.forest_radii*L.plot_radius+10,D2=Math.sqrt(D*D+r0*r0);
  let totalIn=0,totalRing=0;
  for(const s of layout.sites){
    const inner=treesNear(s.x,s.z,r0).filter(p=>Math.hypot(p.x-s.x,p.z-s.z)<r0).length;
    const ring=treesNear(s.x,s.z,D2).filter(p=>{const d=Math.hypot(p.x-s.x,p.z-s.z);return d>=D&&d<D2;}).length;
    assert.ok(inner<ring,`site ${s.group}: ${inner} trees within ${r0.toFixed(1)} m, ${ring} in the ring ${D.toFixed(0)}-${D2.toFixed(0)} m`);
    totalIn+=inner;totalRing+=ring;
  }
  assert.ok(totalIn*3<totalRing,`${totalIn} near vs ${totalRing} far`);
  // Near the town the trees are orchard singles: never pines.
  const near=layout.sites.flatMap(s=>treesNear(s.x,s.z,r0).filter(p=>Math.hypot(p.x-s.x,p.z-s.z)<r0));
  assert.ok(near.length>0,'a few scattered trees remain');
  assert.equal(near.filter(p=>p.v===1).length,0,'no pines in the meadow');
});

test('vegetation with the clearing stays off roads, plots, the observatory and water, and is deterministic',()=>{
  const memorial=layout.memorial;let n=0;
  for(let cx=-5;cx<5;cx++)for(let cz=-5;cz<5;cz++){
    const s=chunk(cx,cz);
    for(const p of [...s.trees,...s.flowers,...s.bushes]){
      n++;assert.ok(!ctx.blocked(p.x,p.z,0),'on a road, plaza or plot');
      assert.ok(Math.hypot(p.x-memorial.x,p.z-memorial.z)>=memorial.grounds,'inside the observatory grounds');
      assert.ok(height(p.x,p.z)>t.water+.5,'in water');
    }
    for(const p of s.trees)for(const h of homes)assert.ok(Math.hypot(p.x-h.x,p.z-h.z)>L.house_radius,'tree on a plot');
    assert.deepEqual(scatterChunk(cx,cz,town().ctx),s,'same seed, same scatter');
  }
  assert.ok(n>500,`checked ${n} props`);
});

test('odds and ends of the wild and stone outcrops: off every surface by their footprint, low by the town, more out in the forest',async()=>{
  const {propGeometries}=await import('../public/world-art.js'),geos=propGeometries();
  for(const [kind,,,,minWild,foot] of DECOR){
    const p=geos[kind].attributes.position;let top=0,far=0;for(let i=0;i<p.count;i++){top=Math.max(top,p.getY(i));far=Math.max(far,Math.hypot(p.getX(i),p.getZ(i)));}
    assert.ok(far<=foot,`${kind} mesh reaches ${far.toFixed(2)} m, footprint ${foot}`);
    assert.ok(top*1.2<=(minWild<.3?.5:1),`${kind} stands ${(top*1.2).toFixed(2)} m tall at most`);
  }
  const lifted={...ctx,lift:height.lift,hill:height.hill,knolls:P.knolls},count={},byTown={near:0,far:0};let outcrops=0;
  for(let cx=-6;cx<6;cx++)for(let cz=-6;cz<6;cz++){
    const s=scatterChunk(cx,cz,lifted);
    for(const [kind,,,,minWild,foot] of DECOR)for(const p of s[kind]){
      count[kind]=(count[kind]||0)+1;const w=ctx.wild(p.x,p.z);byTown[w<.5?'near':'far']++;
      assert.ok(!ctx.blocked(p.x,p.z,foot*p.s),`${kind} on a road, plaza or plot at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      assert.ok(w>=minWild,`${kind} too near the town`);assert.ok(p.y>t.water+.8,`${kind} in water`);
    }
    for(const p of s.rocks){
      assert.ok(!ctx.blocked(p.x,p.z,ROCK_FOOT[ROCK_KINDS[p.v]]*p.s),`${ROCK_KINDS[p.v]} on a road, plaza or plot at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      if(p.s>=1.6){outcrops++;assert.ok(height.lift(p.x,p.z)+height.hill(p.x,p.z)>1,'outcrop off the hills and knolls');}
    }
  }
  for(const [kind] of DECOR)assert.ok(count[kind]>5,`${kind}: ${count[kind]||0}`);
  assert.ok(outcrops>5,`${outcrops} outcrop stones`);
  // Per area, the meadow by the town is sparser than the forest: fewer than a third of them stand where wildness < 0.5.
  assert.ok(byTown.near*3<byTown.far,JSON.stringify(byTown));
});

test('the cats\' ground stays clear: no prop of any kind on a road, plaza, plot, yard, door, lamp spot or any route a cat walks',()=>{
  // Every walk a cat can make in the seeded town: between every pair of homes, and from each home to the memorial door.
  const cats=homes.map((h,i)=>({id:'c'+i,group:h.group,home:{x:h.x,z:h.z,plot:h.plot}})),paths=[];
  for(const a of cats){for(const b of cats)if(a!==b)paths.push(layout.visitPath(a,b));const m=layout.memorialPath(a);if(m)paths.push(m);}
  // Samples every 0.5 m along every walk, bucketed by metre for the lookups below.
  const grid=new Map(),key=(x,z)=>Math.floor(x)+':'+Math.floor(z);let samples=0;
  for(const path of paths)for(let i=1;i<path.length;i++){
    const [ax,az]=path[i-1],[bx,bz]=path[i],n=Math.max(1,Math.ceil(Math.hypot(bx-ax,bz-az)/.5));
    for(let k=0;k<=n;k++){const x=ax+(bx-ax)*k/n,z=az+(bz-az)*k/n,id=key(x,z);if(!grid.has(id))grid.set(id,[]);grid.get(id).push([x,z]);samples++;}
  }
  const CAT=.35;// half a cat's width
  const nearWalk=(x,z,r)=>{for(let i=Math.floor(x-r);i<=Math.floor(x+r);i++)for(let j=Math.floor(z-r);j<=Math.floor(z+r);j++)for(const [px,pz] of grid.get(i+':'+j)||[])if(Math.hypot(px-x,pz-z)<r)return true;return false;};
  const foot={trees:()=>.5,bushes:p=>.8*p.s,rocks:p=>ROCK_FOOT[ROCK_KINDS[p.v]]*p.s,reeds:()=>.3,flowers:p=>FLOWER_RADIUS*p.s,...Object.fromEntries(DECOR.map(([k,,,,,f])=>[k,p=>f*p.s]))};
  const spots=[...layout.lamps.map(l=>({...l,r:.45,what:'lamp'})),...layout.yards.map(y=>({...y,what:'yard'}))];
  const lifted={...ctx,lift:height.lift,hill:height.hill,knolls:P.knolls},seen={};let byWalk=0,byLamp=0;
  for(let cx=-5;cx<5;cx++)for(let cz=-5;cz<5;cz++){
    const s=scatterChunk(cx,cz,lifted);
    for(const kind in foot)for(const p of s[kind]){
      const r=foot[kind](p);seen[kind]=(seen[kind]||0)+1;
      assert.ok(!ctx.blocked(p.x,p.z,r),`${kind} on a road, plaza, plot or lamp at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      assert.ok(!nearWalk(p.x,p.z,r+CAT),`${kind} in a cat's way at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      for(const o of spots)assert.ok(Math.hypot(p.x-o.x,p.z-o.z)>=o.r+r,`${kind} on a ${o.what} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      if(nearWalk(p.x,p.z,r+CAT+3))byWalk++;if(layout.lamps.some(l=>Math.hypot(p.x-l.x,p.z-l.z)<r+3))byLamp++;
    }
  }
  assert.ok(paths.length>200&&samples>20000,`${paths.length} walks, ${samples} samples`);
  assert.ok(layout.lamps.length>10,`${layout.lamps.length} lamps`);
  for(const kind in foot)assert.ok(seen[kind]>0,`${kind}: none placed, so none checked`);
  // The checks looked at props right beside the walks and lamps, not only far out in the meadow.
  assert.ok(byWalk>20&&byLamp>5,`${byWalk} props within 3 m of a walk, ${byLamp} within 3 m of a lamp`);
  assert.ok(seen.rocks>100,`${seen.rocks} rocks checked`);
});

test('rock kit: every variant fits its footprint, stays low, and is coloured',async()=>{
  const {rockGeometries}=await import('../public/rocks.js'),kit=rockGeometries();
  assert.deepEqual(Object.keys(kit).sort(),[...ROCK_KINDS].sort());
  for(const kind of ROCK_KINDS){
    const g=kit[kind],p=g.attributes.position;let far=0,top=0;for(let i=0;i<p.count;i++){far=Math.max(far,Math.hypot(p.getX(i),p.getZ(i)));top=Math.max(top,p.getY(i));}
    assert.ok(far<=ROCK_FOOT[kind],`${kind} reaches ${far.toFixed(2)} m, footprint ${ROCK_FOOT[kind]}`);
    assert.ok(top<.6,`${kind} stands ${top.toFixed(2)} m`);assert.ok(g.attributes.color&&g.attributes.normal,`${kind} has colours and normals`);
    assert.ok(p.count/3<=100,`${kind}: ${p.count/3} triangles`);
  }
  assert.equal(rockGeometries(),kit,'built once');
});

test('water shader: the patch lands in three\'s standard shader and has uniforms for every time of day',()=>{
  const times=json('public/presentation.config.json').timesOfDay;assert.deepEqual(Object.keys(times).sort(),['dawn','day','night','sunset']);
  const time={value:0},{material,uniforms,setTint}=createWaterMaterial(time,P.bed);
  const shader={vertexShader:T.ShaderLib.standard.vertexShader,fragmentShader:T.ShaderLib.standard.fragmentShader,uniforms:T.UniformsUtils.clone(T.ShaderLib.standard.uniforms)};
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader,/vDepth=depth;/);
  for(const mark of ['diffuseColor.rgb=mix(uShallow,uDeep','normal=normalize((viewMatrix*vec4(wUp','outgoingLight=mix(outgoingLight,fogColor','#include <opaque_fragment>'])assert.ok(shader.fragmentShader.includes(mark),mark);
  assert.equal(shader.uniforms.uTime,time,'animated by the shared time uniform only');
  for(const k of ['uBed','uShallow','uDeep'])assert.ok(shader.uniforms[k],k);
  const lum=c=>.2126*c.r+.7152*c.g+.0722*c.b;
  for(const [name,p] of Object.entries(times)){
    setTint(p.water);
    const {uShallow:{value:sh},uDeep:{value:dp}}=uniforms;
    assert.ok(material.color.equals(new T.Color(p.water)),name);
    for(const c of [sh,dp])for(const v of [c.r,c.g,c.b])assert.ok(v>0&&v<=1,`${name} tint in range`);
    assert.ok(lum(dp)<lum(sh),`${name}: deep is darker than the banks`);
    assert.ok(dp.b/dp.r>sh.b/sh.r,`${name}: deep leans blue`);
    assert.ok(sh.g/sh.b>dp.g/dp.b,`${name}: shallow leans green`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {terrain,heldGround,townHolds} from '../public/terrain.js';
import {resolveLayout,siteCentre,planSite,placeInGroup,townLayout} from '../public/hamlet-layout.js';
import {makeBlocker,scatterChunk,wildness,DECOR} from '../public/vegetation.js';
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
  const lifted={...ctx,lift:height.lift,knolls:P.knolls},count={},byTown={near:0,far:0};let outcrops=0;
  for(let cx=-6;cx<6;cx++)for(let cz=-6;cz<6;cz++){
    const s=scatterChunk(cx,cz,lifted);
    for(const [kind,,,,minWild,foot] of DECOR)for(const p of s[kind]){
      count[kind]=(count[kind]||0)+1;const w=ctx.wild(p.x,p.z);byTown[w<.5?'near':'far']++;
      assert.ok(!ctx.blocked(p.x,p.z,foot*p.s),`${kind} on a road, plaza or plot at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      assert.ok(w>=minWild,`${kind} too near the town`);assert.ok(p.y>t.water+.8,`${kind} in water`);
    }
    for(const p of s.rocks.filter(r=>r.s>=1.6)){outcrops++;assert.ok(!ctx.blocked(p.x,p.z,p.s*.7)&&height.lift(p.x,p.z)>0,'outcrop off the knolls or on a surface');}
  }
  for(const [kind] of DECOR)assert.ok(count[kind]>5,`${kind}: ${count[kind]||0}`);
  assert.ok(outcrops>5,`${outcrops} outcrop stones`);
  // Per area, the meadow by the town is sparser than the forest: fewer than a third of them stand where wildness < 0.5.
  assert.ok(byTown.near*3<byTown.far,JSON.stringify(byTown));
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

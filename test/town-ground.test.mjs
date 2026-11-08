import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {terrain,findBridges} from '../public/terrain.js';
import {resolveLayout,siteCentre,placeInGroup,townLayout} from '../public/hamlet-layout.js';
import {buildTownGround,strip} from '../public/town-ground.js';

const raw=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).world.layout,L=resolveLayout(raw),t=terrain(L.terrain);
// Signed area in x,z: negative when a triangle faces up (what the single-sided ground material draws).
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const segDist=(p,a,b)=>{const dx=b[0]-a[0],dz=b[1]-a[1],d2=dx*dx+dz*dz,s=d2?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d2)):0;return Math.hypot(p[0]-a[0]-dx*s,p[1]-a[1]-dz*s);};
const lineDist=(p,line)=>{let d=Infinity;for(let i=1;i<line.length;i++)d=Math.min(d,segDist(p,line[i-1],line[i]));return d;};
const triangles=mesh=>{const p=mesh.geometry.attributes.position,ix=mesh.geometry.index.array,out=[];for(let i=0;i<ix.length;i+=3)out.push([ix[i],ix[i+1],ix[i+2]].map(k=>[p.getX(k),p.getZ(k)]));return out;};
const covered=(tris,p)=>tris.some(([a,b,c])=>{const s=cross(a,b,c);if(s>-1e-9)return false;const e=1e-6;return cross(a,b,p)<=e&&cross(b,c,p)<=e&&cross(c,a,p)<=e;});

function town(groupsCount){
  const groups=[],homes=[];
  for(let g=0;g<groupsCount;g++)groups.push({id:g?'g'+g:'main',site:siteCentre(g,L)});
  // As the engine places them: each home clears the roads already laid (placeCat passes the town's roads).
  const catsOf=()=>homes.map((h,i)=>({id:'c'+i,group:h.group,home:{x:h.x,z:h.z,plot:h.plot,style:'builder'}}));
  for(const g of groups)for(let n=0;n<(g.id==='main'?10:5);n++){const s=placeInGroup(g,homes,groups,L,townLayout(catsOf(),groups,raw).roads);homes.push({...s,group:g.id});}
  const cats=catsOf();
  return townLayout(cats,groups,raw);
}

test('road strips keep their width through bends and never fold back on themselves',()=>{
  const layout=town(3);let bends=0;
  for(const road of layout.roads.filter(r=>r.kind==='local'||r.kind==='between')){
    const w=road.width*2,{left,right,centre}=strip(road.points,w);
    let folded=0;
    for(let i=0;i<left.length-1;i++){folded+=Math.max(0,cross(left[i],left[i+1],right[i]))+Math.max(0,cross(right[i],left[i+1],right[i+1]));}
    assert.ok(folded/2<.02,`road folds over ${(folded/2).toFixed(3)} m2`);
    for(let i=1;i<centre.length-1;i++){
      const a=centre[i-1],p=centre[i],b=centre[i+1],turn=Math.acos(Math.max(-1,Math.min(1,((p[0]-a[0])*(b[0]-p[0])+(p[1]-a[1])*(b[1]-p[1]))/(Math.hypot(p[0]-a[0],p[1]-a[1])*Math.hypot(b[0]-p[0],b[1]-p[1])))));
      const held=left[i]===left[i-1]||right[i]===right[i-1]||String(left[i])===String(left[i-1])||String(right[i])===String(right[i-1]);
      if(turn<.35||turn>Math.PI/2||held)continue;bends++;
      // Unmitred, a 60-degree bend narrowed the road to cos(30) = 87% of its width at the corner.
      assert.ok(lineDist(left[i],right)>=w*.95&&lineDist(right[i],left)>=w*.95,`road pinches at a ${(turn*180/Math.PI).toFixed(0)} degree bend near ${p.map(v=>v.toFixed(1))}`);
    }
  }
  assert.ok(bends>0,'the town has bends over 20 degrees to check');
});

test('the whole town ground has no folded (culled) slivers, and kerb rings face up',()=>{
  const layout=town(3),flat=()=>0,homes=[];
  const mesh=buildTownGround({sites:layout.sites,yards:layout.yards,roads:layout.roads,junctions:layout.junctions,common:layout.common,homes,L,bridges:[]},flat,flat,null);
  // Before strips were mitred and held: 51 folded road triangles here (up to 1.4 m2 each) plus 384 downward kerb-ring
  // triangles. What is left is one rare corner where a mitred outer edge meets a held inner edge.
  const folds=triangles(mesh).map(([a,b,c])=>cross(a,b,c)/2).filter(a=>a>1e-6);
  assert.ok(folds.length<=5&&folds.reduce((s,a)=>s+a,0)<1,`${folds.length} folded ground triangles, ${folds.reduce((s,a)=>s+a,0).toFixed(2)} m2`);
  // A point on every common's kerb ring is drawn.
  const tris=triangles(mesh);for(const s of layout.sites)assert.ok(covered(tris,[s.x+layout.common+.1,s.z]),'kerb ring is drawn');
});

test('a dirt road leaving a bridge at an angle leaves no grass between the deck end and the road',()=>{
  let x0=null,z0=0;for(const z of [0,100,-100,200,-200])for(let x=0;x<600&&x0===null;x+=.5)if(t.raw(x,z)<t.water){x0=x;z0=z;}
  assert.ok(x0!==null,'river found');
  let x1=x0;while(t.raw(x1,z0)<t.water+.45)x1+=.5;
  // Straight over the water, then a 60-degree turn just past the far bank.
  const points=[];for(let x=x0-20;x<=x1+3;x+=1.5)points.push([x,z0]);
  const turn=points.at(-1);for(let d=1.5;d<=15;d+=1.5)points.push([turn[0]+d*Math.cos(Math.PI/3),turn[1]+d*Math.sin(Math.PI/3)]);
  const roads=[{kind:'between',points,width:L.half_width_between}],bridges=findBridges(roads,t.raw,t.water);assert.ok(bridges.length>=1);
  const walk=(x,z)=>t.raw(x,z),mesh=buildTownGround({sites:[],yards:[],roads,junctions:[],common:0,homes:[],L,bridges},t.raw,walk,null),tris=triangles(mesh);
  let checked=0;
  for(const br of bridges){
    // The deck itself is drawn, facing up, all the way across (a resample with no step once dropped it entirely).
    for(let s=.1;s<1;s+=.2)assert.ok(covered(tris,[br.a[0]+(br.b[0]-br.a[0])*s,br.a[1]+(br.b[1]-br.a[1])*s]),'bridge deck is drawn');
    const w=br.width*2+.5,len=Math.hypot(br.b[0]-br.a[0],br.b[1]-br.a[1]),u=[(br.b[0]-br.a[0])/len,(br.b[1]-br.a[1])/len],v=[-u[1],u[0]];
    for(const [end,sign] of [[br.a,-1],[br.b,1]])for(let f=.05;f<1;f+=.15)for(let l=-.9;l<=.9;l+=.15){
      if(Math.hypot(f,l)>.95)continue;const p=[end[0]+sign*u[0]*f*w/2+v[0]*l*w/2,end[1]+sign*u[1]*f*w/2+v[1]*l*w/2];
      assert.ok(covered(tris,p),`ground shows through just past a deck end at ${p.map(n=>n.toFixed(2))}`);checked++;
    }
  }
  assert.ok(checked>40);
});

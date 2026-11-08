import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {terrain,heldGround,townHolds,findBridges,roadHeight,siteLevel} from '../public/terrain.js';
import {resolveLayout,siteCentre,siteDry,planSite,placeInGroup,homeProblem,plotFree,townLayout} from '../public/hamlet-layout.js';
import {makeBlocker,scatterChunk,grassChunk,TUFT_RADIUS,FLOWER_RADIUS} from '../public/vegetation.js';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const raw=config.world.layout,L=resolveLayout(raw),t=terrain(L.terrain),P=L.terrain;
const {terrain:_,...flat}=raw,Lflat=resolveLayout(flat);

test('terrain is deterministic and gentle: same heights from a fresh copy of the parameters, small slopes',()=>{
  const other=terrain(structuredClone(P));let steep=0,n=0;
  for(let i=0;i<400;i++){
    const x=(i*37.3)%600-300,z=(i*91.7)%600-300;
    assert.equal(other.raw(x,z),t.raw(x,z));
    if(t.river(x,z).edge>8){n++;if(Math.abs(t.raw(x+1,z)-t.raw(x,z))>.35)steep++;}
  }
  assert.ok(n>200);assert.equal(steep,0,'no cliff steeper than 0.35 m per metre away from river banks');
});

test('rivers keep clear of the town centre and the memorial; water is really there',()=>{
  assert.ok(t.clearOfRiver(0,0,L.plot_radius+L.house_radius),'main common is clear');
  assert.ok(t.dry(L.memorial[0],L.memorial[1]),'memorial is dry');
  let wet=0;for(let x=-600;x<=600;x+=2)if(t.raw(x,0)<t.water||t.raw(0,x)<t.water)wet++;
  assert.ok(wet>0,'a river crosses one of the axes within 600 m');
});

test('dryness follows the Hamlet rule: centre and +-dry_probe stand dry_margin above the water',()=>{
  let checked=0;
  for(let x=-300;x<=300;x+=3.7)for(let z=-300;z<=300;z+=29){
    const rule=[[0,0],[P.dry_probe,0],[-P.dry_probe,0],[0,P.dry_probe],[0,-P.dry_probe]].every(([dx,dz])=>t.raw(x+dx,z+dz)>t.water+P.dry_margin);
    assert.equal(t.dry(x,z),rule);checked++;
  }
  assert.ok(checked>1000);
});

test('wet sites are skipped: planSite takes the next dry site where a terrain-free layout would take a wet one',()=>{
  const sites=[siteCentre(0,L)];let skips=0;
  for(let n=0;n<80;n++){
    const chosen=planSite(sites,L),plain=planSite(sites,Lflat);
    assert.ok(siteDry(chosen,L),`site ${chosen.index} is dry`);
    if(plain.index!==chosen.index){skips++;assert.ok(!siteDry(plain,L)&&plain.index<chosen.index,'the skipped site was wet and lower');}
    sites.push(chosen);
  }
  assert.ok(skips>0,'at least one wet site was skipped');
});

test('plots and owner moves refuse wet ground',()=>{
  let wet=null;for(let x=-L.town_limit+1;x<L.town_limit&&!wet;x+=1.3)for(let z=-L.town_limit+1;z<L.town_limit&&!wet;z+=9)if(!t.dry(x,z))wet={x,z};
  assert.ok(wet,'found a wet spot');
  assert.equal(plotFree(wet,[],[],L),false);
  assert.match(homeProblem(wet.x,wet.z,[],[],L)||'',/dry ground/);
  const group={id:'g',site:siteCentre(0,L)},homes=[];
  for(let n=0;n<20;n++){const spot=placeInGroup(group,homes,[group],L);if(!spot)break;homes.push({...spot,group:'g'});assert.ok(t.dry(spot.x,spot.z));}
});

test('held ground is exactly level on every plaza and plot, and eases back to the natural height',()=>{
  const groups=[{id:'main',site:siteCentre(0,L)}],homes=[];
  for(let n=0;n<10;n++){const s=placeInGroup(groups[0],homes,groups,L);homes.push({...s,group:'main'});}
  const cats=homes.map((h,i)=>({id:'c'+i,group:'main',home:{x:h.x,z:h.z,plot:h.plot,style:'builder'}}));
  const layout=townLayout(cats,groups,raw);
  const holds=townHolds(t,layout.sites,cats.map(c=>({...c.home,group:c.group})),{x:L.memorial[0],z:L.memorial[1],r:L.memorial_reserve},L),height=heldGround(t,holds);
  const level=siteLevel(t,0,0);
  for(const h of homes)for(const [dx,dz] of [[0,0],[2,0],[0,-2]])assert.equal(height(h.x+dx,h.z+dz),level,'house pad is level');
  assert.equal(height(0,0),level);
  const far={x:400,z:-380};assert.equal(height(far.x,far.z),t.raw(far.x,far.z)+t.knoll(far.x,far.z),'far ground keeps its natural height, plus knolls');
});

test('knolls rise only past the commons and away from rivers: town ground is exactly the knoll-free ground, slopes stay gentle',()=>{
  const groups=[{id:'main',site:siteCentre(0,L)}];
  for(const id of ['g1','g2','g3'])groups.push({id,site:planSite(groups.map(g=>g.site),L)});
  const homes=[];for(const g of groups)for(let n=0;n<8;n++){const s=placeInGroup(g,homes,groups,L);if(!s)break;homes.push({...s,group:g.id});}
  const cats=homes.map((h,i)=>({id:'c'+i,group:h.group,home:{x:h.x,z:h.z,plot:h.plot,style:'builder'}})),layout=townLayout(cats,groups,raw);
  const mem={...layout.memorial,r:L.memorial_reserve},holds=townHolds(t,layout.sites,homes,mem,L),height=heldGround(t,holds);
  const {knolls:_k,...bare}=P,t0=terrain(bare),plain=heldGround(t0,townHolds(t0,layout.sites,homes,mem,L));
  const spots=[...homes,...layout.sites,mem,...layout.roads.flatMap(r=>r.points.map(([x,z])=>({x,z})))];
  for(const s of spots)for(const [dx,dz] of [[0,0],[P.dry_probe,0],[0,-P.dry_probe]])assert.equal(height(s.x+dx,s.z+dz),plain(s.x+dx,s.z+dz),`ground moved at ${s.x.toFixed(1)},${s.z.toFixed(1)}`);
  let risen=0,steep=0,wet=0,n=0;
  for(let x=-300;x<=300;x+=2.5)for(let z=-300;z<=300;z+=7.5){
    const lift=height.lift(x,z);if(lift>1)risen++;if(lift&&t.river(x,z).edge<P.valley)wet++;
    if(t.river(x,z).edge>8){n++;if(Math.abs(height(x+1,z)-height(x,z))>.35||Math.abs(height(x,z+1)-height(x,z))>.35)steep++;}
  }
  assert.ok(risen>500,`knolls stand somewhere (${risen} samples over 1 m)`);assert.equal(wet,0,'no knoll in a river valley');
  assert.ok(n>5000);assert.equal(steep,0,'no slope steeper than 0.35 m per metre away from river banks');
});

test('bridges carry a road over water: the deck stays above the water all the way across',()=>{
  let x0=null,z0=0;for(const z of [0,100,-100,200,-200])for(let x=0;x<600&&x0===null;x+=.5)if(t.raw(x,z)<t.water){x0=x;z0=z;}
  assert.ok(x0!==null,'river found on +x');
  const points=[];for(let x=x0-20;x<=x0+30;x+=1.5)points.push([x,z0]);
  const bridges=findBridges([{points,width:1}],t.raw,t.water);assert.ok(bridges.length>=1);
  const walk=roadHeight(t.raw,bridges);
  for(const p of points)assert.ok(walk(p[0],p[1])>t.water+.3,`dry footing at ${p[0].toFixed(1)}`);
});

test('vegetation never grows on roads, plazas, plots, the memorial or in water',()=>{
  const groups=[{id:'main',site:siteCentre(0,L)}],homes=[];
  for(let n=0;n<16;n++){const s=placeInGroup(groups[0],homes,groups,L);if(!s)break;homes.push({...s,group:'main'});}
  const cats=homes.map((h,i)=>({id:'c'+i,group:'main',home:{x:h.x,z:h.z,plot:h.plot,style:'builder'}}));
  const layout=townLayout(cats,groups,raw),memorial=layout.memorial;
  const blocked=makeBlocker(layout),height=t.raw;
  const ctx={size:32,height,water:t.water,blocked,town:(x,z)=>Math.hypot(x,z)<40,river:t.river,plain:P.plain_y,treeCell:4.2};
  const all={trees:0,reeds:0,flowers:0,grass:0,byMemorial:0};
  for(let cx=-4;cx<4;cx++)for(let cz=-4;cz<4;cz++){
    const s=scatterChunk(cx,cz,ctx),g=grassChunk(cx,cz,200,ctx);
    for(const p of [...s.trees,...s.flowers,...s.bushes,...g]){
      assert.ok(!blocked(p.x,p.z,0),'on a road, plaza, plot or memorial');
      const fromMemorial=Math.hypot(p.x-memorial.x,p.z-memorial.z);if(fromMemorial<memorial.grounds+6)all.byMemorial++;
      assert.ok(fromMemorial>=memorial.grounds,`vegetation inside the memorial grounds at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      assert.ok(height(p.x,p.z)>t.water+.5,'in water');
    }
    // Grass and flower clumps: their whole footprint, not just the centre, stays off every paved or reserved surface.
    for(const p of g)assert.ok(!blocked(p.x,p.z,TUFT_RADIUS*p.s),`grass clump overlaps a road or plot at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    for(const p of s.flowers)assert.ok(!blocked(p.x,p.z,FLOWER_RADIUS*p.s),'flower clump overlaps a road or plot');
    for(const p of s.trees)for(const h of homes)assert.ok(Math.hypot(p.x-h.x,p.z-h.z)>L.house_radius,'tree on a plot');
    all.trees+=s.trees.length;all.reeds+=s.reeds.length;all.flowers+=s.flowers.length;all.grass+=g.length;
    assert.deepEqual(scatterChunk(cx,cz,ctx),s,'deterministic');
  }
  assert.ok(all.trees>150&&all.flowers>50&&all.grass>5000,JSON.stringify(all));
  assert.ok(all.byMemorial>20,'the check really looked at ground beside the memorial grounds');
});

test('the grass clump and flower meshes fit inside the footprint radii the scatter keeps clear',async()=>{
  const {propGeometries}=await import('../public/world-art.js'),geos=propGeometries();
  for(const [geo,r] of [[geos.tuft,TUFT_RADIUS],...geos.flowers.map(f=>[f,FLOWER_RADIUS])]){
    const p=geo.attributes.position;let far=0;for(let i=0;i<p.count;i++)far=Math.max(far,Math.hypot(p.getX(i),p.getZ(i)));
    assert.ok(far<=r,`mesh reaches ${far.toFixed(2)} m, radius ${r}`);
  }
});

import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {homeProblem,resolveLayout,townLayout,roadGap,placeInGroup,siteCentre,groupReach,plazaOf} from '../public/hamlet-layout.js';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const L=resolveLayout(config.world.layout),memorial={x:L.memorial[0],z:L.memorial[1]};
const fixture=()=>{const file=join(mkdtempSync(join(tmpdir(),'cat-memorial-')),'events.jsonl');const store=new Store(file,allRoles(config));return {store,town:new Town(store,config)};};

test('the memorial garden is a reserved disc away from the centre',()=>{
  assert.notDeepEqual([memorial.x,memorial.z],[0,0]);
  assert.match(homeProblem(memorial.x,memorial.z,[],[],L)!,/memorial/);
  assert.match(homeProblem(memorial.x+L.memorial_reserve,memorial.z,[],[],L)!,/memorial/);
  assert.equal(homeProblem(memorial.x+L.memorial_reserve+L.house_radius+1,memorial.z,[],[],L),null);
});

test('recruitment never places a home inside the memorial reserve, even when the town fills',()=>{
  const {store,town}=fixture();
  while(store.state.cats.length<config.maxCats)town.recruit('mayor','Resident '+store.state.cats.length,'Research opportunities');
  for(const cat of store.state.cats)assert.ok(Math.hypot(cat.home!.x-memorial.x,cat.home!.z-memorial.z)>=L.memorial_reserve+L.house_radius-1e-9,`${cat.id} sits on the memorial`);
  for(const group of store.state.groups.filter(g=>g.id!=='main'))assert.ok(Math.hypot(group.site.x-memorial.x,group.site.z-memorial.z)>=L.memorial_reserve+plazaOf(group.site,L)+L.road_clearance-1e-9,`${group.id} site is on the memorial`);
});

test('owner moves onto the memorial are refused',()=>{
  const {town}=fixture();
  assert.throws(()=>town.moveHome('owner','scholar',memorial.x,memorial.z),/memorial/);
  assert.throws(()=>town.moveHome('owner','scholar',memorial.x+2,memorial.z-3),/memorial/);
});

// The memorial chapel is part of the town from its first snapshot, before anyone retires.
const memorialRoadOf=(layout:any)=>layout.roads.filter((r:any)=>r.memorial);
const segDist=(p:number[],a:number[],b:number[])=>{const dx=b[0]-a[0],dz=b[1]-a[1],d=dx*dx+dz*dz,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d)):0;return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dz*t);};

test('a new world has the memorial and its road with no retired cats',()=>{
  const {store}=fixture();assert.equal(store.state.retiredCats.length,0);
  const layout=townLayout(store.state.cats,store.state.groups,config.world.layout),spot=layout.memorial;
  assert.deepEqual([spot.x,spot.z],[memorial.x,memorial.z]);
  assert.ok(memorialRoadOf(layout).length>=1,'the memorial has a road');
  assert.deepEqual(memorialRoadOf(layout)[0].points[0],spot.door,'the road starts at the memorial door');
  assert.ok(layout.circles.some((c:any)=>c.x===spot.x&&c.z===spot.z&&c.r===spot.grounds),'the grounds are in the vegetation mask');
});

test('the memorial is reachable by road from every door',()=>{
  const {store,town}=fixture();for(let i=0;i<20;i++)town.recruit('mayor','Walker '+i,'Research');
  const layout=townLayout(store.state.cats,store.state.groups,config.world.layout);
  for(const cat of store.state.cats){
    const path=layout.memorialPath(cat);assert.ok(path&&path.length>2,`${cat.id} cannot walk to the memorial`);
    assert.deepEqual(path.at(-1),layout.memorial.door);
    // Rounded corners leave the road's line, never its paving (the walk starts at the cat's own door).
    for(const p of path)if(!layout.paved(p[0],p[1])&&Math.hypot(p[0]-cat.home!.x,p[1]-cat.home!.z)>=L.stem+.6)assert.fail(`${cat.id}: path leaves the paving at ${p}`);
  }
});

test('as the town grows to its full size, no home, plaza or other road lands on the memorial or its road',()=>{
  const {store,town}=fixture();
  for(let g=0;g<4;g++){const root=town.createTask('scholar','owner',`Hamlet request ${g}. Staff it.`,'test');for(let i=0;i<6;i++)town.recruit('mayor',`Task ${g} cat ${i}`,'Build things',undefined,root);}
  const check=()=>{
    const layout=townLayout(store.state.cats,store.state.groups,config.world.layout),spot=layout.memorial,own=memorialRoadOf(layout);
    assert.ok(own.length>=1);
    for(const cat of store.state.cats){
      assert.ok(Math.hypot(cat.home!.x-spot.x,cat.home!.z-spot.z)>=spot.reserve+L.house_radius-1e-9,`${cat.id} sits on the memorial`);
      assert.ok(roadGap(cat.home!,own)>=L.house_radius-1e-9,`${cat.id} sits on the memorial road`);
    }
    for(const g of store.state.groups)assert.ok(Math.hypot(g.site.x-spot.x,g.site.z-spot.z)>=spot.reserve+plazaOf(g.site,L)-1e-9,`${g.id} plaza is on the memorial`);
    for(const road of layout.roads){
      if(road.memorial)continue;
      for(const p of road.points)assert.ok(Math.hypot(p[0]-spot.x,p[1]-spot.z)>=spot.grounds-1e-6,`${road.kind} road crosses the memorial grounds`);
      // Other roads meet the memorial road only at junctions (within 3 m of a road end), never run over it.
      for(const m of own){const ends=[road.points[0],road.points.at(-1),m.points[0],m.points.at(-1)];
        for(const p of road.points){if(ends.some((e:number[])=>Math.hypot(p[0]-e[0],p[1]-e[1])<3))continue;
          const d=Math.min(...m.points.slice(1).map((q:number[],i:number)=>segDist(p,m.points[i],q)));
          assert.ok(d>=road.width+m.width-1e-6,`${road.kind} road overlaps the memorial road at ${p.map((v:number)=>v.toFixed(1))}`);}}
    }
  };
  check();
  for(let i=0;store.state.cats.length<config.maxCats;i++){town.recruit('mayor','Resident '+i,'Research');if(i%8===0)check();}
  assert.equal(store.state.cats.length,config.maxCats);check();
});

test('a town built before the chapel gets a memorial road that misses its houses and never runs over another road',()=>{
  // Homes placed by the old rule (no roads known), as in journals written before the memorial road existed.
  const groups=[{id:'main',site:siteCentre(0,L)}],homes:any[]=[];
  for(let n=0;n<34;n++){const s=placeInGroup(groups[0],homes,groups,L);if(!s)break;homes.push({...s,group:'main'});}
  const cats=homes.map((h,i)=>({id:'c'+i,group:'main',home:{x:h.x,z:h.z,plot:h.plot,style:'builder'}}));
  const layout=townLayout(cats,groups,config.world.layout),own=memorialRoadOf(layout);
  assert.ok(own.length>=1&&layout.memorialPath(cats[0]),'the memorial is on the network');
  for(const m of own)for(const p of m.points.slice(2,-1))for(const c of cats)assert.ok(Math.hypot(p[0]-c.home.x,p[1]-c.home.z)>=L.house_radius+m.width-1e-3,`memorial road runs over ${c.id}`);
  for(const road of layout.roads){if(road.memorial)continue;
    for(const m of own){const ends=[road.points[0],road.points.at(-1),m.points[0],m.points.at(-1)];
      for(const p of road.points){if(ends.some((e:number[])=>Math.hypot(p[0]-e[0],p[1]-e[1])<3))continue;
        assert.ok(Math.min(...m.points.slice(1).map((q:number[],i:number)=>segDist(p,m.points[i],q)))>=road.width+m.width-1e-6,`${road.kind} road overlaps the memorial road`);}}}
});

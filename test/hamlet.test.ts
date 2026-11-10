import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {resolveLayout,townLayout,planSite,siteCentre,roadGap,groupReach,plazaOf,BOARD,FOUNTAIN} from '../public/hamlet-layout.js';
import {oneLiner} from '../public/one-liner.js';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const raw=config.world.layout,L=resolveLayout(raw);
const dir=()=>mkdtempSync(join(tmpdir(),'cat-hamlet-'));
const fixture=(file=join(dir(),'events.jsonl'))=>{const store=new Store(file,allRoles(config));return {file,store,town:new Town(store,config)};};
const dist=(a:{x:number;z:number},b:{x:number;z:number})=>Math.hypot(a.x-b.x,a.z-b.z);
const snapshotHomes=(store:Store)=>store.state.cats.map(c=>({id:c.id,group:c.group,home:structuredClone(c.home)}));
// A town with main filled past one hamlet, plus several task groups, built through the real engine paths.
function busyTown(){
  const {file,store,town}=fixture();
  for(let i=0;i<35;i++)town.recruit('mayor','Resident '+i,'Research opportunities');
  for(let g=0;g<3;g++){const root=town.createTask('scholar','owner',`Hamlet request ${g}. Staff it.`,'test');for(let i=0;i<5;i++)town.recruit('mayor',`Task ${g} cat ${i}`,'Build things',undefined,root);}
  return {file,store,town};
}

test('replaying the same journal gives the same groups, homes and roads',()=>{
  const {file,store}=busyTown();
  const replay=new Store(file,[]);new Town(replay,config);
  assert.deepEqual(replay.state.groups,store.state.groups);
  assert.deepEqual(replay.state.cats,store.state.cats);
  const a=townLayout(store.state.cats,store.state.groups,raw),b=townLayout(replay.state.cats,replay.state.groups,raw);
  assert.equal(JSON.stringify(a.roads),JSON.stringify(b.roads));
  assert.deepEqual(a.visitPath(store.state.cats[1],store.state.cats.at(-1)),b.visitPath(replay.state.cats[1],replay.state.cats.at(-1)));
});

test('no two houses are closer than 2 x house_radius, and no house sits on a plaza',()=>{
  const {store}=busyTown();const cats=store.state.cats.filter(c=>c.home);
  assert.ok(store.state.groups.length>=4,'several hamlets exist');
  for(let i=0;i<cats.length;i++){
    for(let j=i+1;j<cats.length;j++)assert.ok(dist(cats[i].home!,cats[j].home!)>=2*L.house_radius-1e-9,`${cats[i].id} and ${cats[j].id} overlap`);
    if(cats[i].home!.plot===0)continue;
    for(const g of store.state.groups)assert.ok(dist(cats[i].home!,g.site)>=plazaOf(g.site,L)+L.house_radius-1e-9,`${cats[i].id} sits on a plaza`);
  }
});

test('roads stay out of every plaza: streets ring the paved common instead of piercing it',()=>{
  const {store}=busyTown();const layout=townLayout(store.state.cats,store.state.groups,raw);
  assert.ok(layout.roads.length>10);
  for(const road of layout.roads)for(const p of road.points)for(const g of store.state.groups)
    assert.ok(dist({x:p[0],z:p[1]},g.site)>=plazaOf(g.site,L)-1e-6,`${road.kind} road of ${road.group} enters a plaza`);
});

test('roads keep clear of every house, except a stem leaving its own door',()=>{
  const {store}=busyTown();const layout=townLayout(store.state.cats,store.state.groups,raw);
  const homes=store.state.cats.filter(c=>c.home).map(c=>c.home!);
  for(const road of layout.roads)for(const p of road.points.slice(road.door?2:1,-1))
    for(const h of homes)assert.ok(dist({x:p[0],z:p[1]},h)>=L.house_radius+L.road_clearance-1e-6,'road runs through a house');
});

const segs=(road:{points:number[][]})=>road.points.slice(1).map((p,i)=>[road.points[i],p]);
const segDist=(p:number[],a:number[],b:number[])=>{const dx=b[0]-a[0],dz=b[1]-a[1],d=dx*dx+dz*dz,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d)):0;return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dz*t);};
test('the road network never overlaps itself: ribbons stay apart except within 3 m of a junction',()=>{
  const {store}=busyTown();const roads=townLayout(store.state.cats,store.state.groups,raw).roads;
  for(const A of roads)for(const B of roads){
    if(A===B)continue;const ends=[A.points[0],A.points.at(-1),B.points[0],B.points.at(-1)];
    for(const [a,b] of segs(A)){const n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.5);
      for(let j=0;j<n;j++){const p=[a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n];if(ends.some(e=>Math.hypot(p[0]-e[0],p[1]-e[1])<3))continue;
        const d=Math.min(...segs(B).map(([c,e])=>segDist(p,c,e)));assert.ok(d>=A.width+B.width,`${A.kind} overlaps ${B.kind} at ${p.map(v=>v.toFixed(1))}`);}}
  }
});

test('the notice board, roof and all, clears the ring street and every walking path across its plaza',()=>{
  const {store}=busyTown();const cats=store.state.cats.filter(c=>c.home),layout=townLayout(cats,store.state.groups,raw);
  const paths=cats.slice(0,8).flatMap(a=>cats.map(b=>layout.visitPath(a,b)));
  for(const site of layout.sites){const f=site.features.find((f:{kind:string})=>f.kind==='board'),yaw=f.yaw,c=Math.cos(yaw),s=Math.sin(yaw);
    for(const i of [-1,0,1])for(const j of [-1,1]){const p={x:f.x+i*BOARD.half*c+j*BOARD.depth*s,z:f.z-i*BOARD.half*s+j*BOARD.depth*c};
      assert.ok(roadGap(p,layout.roads)>=.4,`${site.group} board touches a road`);assert.ok(dist(p,site)<site.plaza,`${site.group} board leaves its plaza`);
      for(const path of paths)for(const [a,b] of segs({points:path}))assert.ok(segDist([p.x,p.z],a,b)>=.6,`${site.group} board stands on a walking path`);}}
  // The Mayor's square: the board faces the fountain, and no walking path crosses the fountain.
  const square=layout.sites.find((s:{group:string})=>s.group==='main'),fountain=square.features.find((f:{kind:string})=>f.kind==='fountain'),board=square.features.find((f:{kind:string})=>f.kind==='board');
  assert.ok(fountain&&dist(fountain,square)<1e-9,'a fountain stands in the middle of the square');
  assert.ok(Math.abs(Math.atan2(square.x-board.x,square.z-board.z)-board.yaw)<1e-9,'the Archive board faces the square');
  for(const path of paths)for(const [a,b] of segs({points:path}))assert.ok(segDist([fountain.x,fountain.z],a,b)>=FOUNTAIN.r+.4,'a walking path crosses the fountain');
});

test('every door is on the network, and walking paths follow it between any two cats',()=>{
  const {store}=busyTown();const cats=store.state.cats.filter(c=>c.home),layout=townLayout(cats,store.state.groups,raw);
  // Rounded corners leave the road's line, never its paving; only the doorstep legs cross a home's own front garden.
  const doorstep=(p:number[],...ends:any[])=>ends.some(e=>dist({x:p[0],z:p[1]},e.home)<L.stem+.6);
  for(const c of cats){const path=layout.visitPath(cats[0],c);assert.ok(path.length>2,`${c.id} is reachable`);
    for(const p of path)if(!layout.paved(p[0],p[1])&&!doorstep(p,cats[0],c))assert.fail(`${c.id}: path leaves the paving at ${p}`);}
});

// ---------------------------------------------------------------- natural walking routes (smoothPath)
const lengthOf=(p:number[][])=>p.slice(1).reduce((s,q,i)=>s+Math.hypot(q[0]-p[i][0],q[1]-p[i][1]),0);
const turnAt=(p:number[][],i:number)=>{const a=Math.atan2(p[i][1]-p[i-1][1],p[i][0]-p[i-1][0]),b=Math.atan2(p[i+1][1]-p[i][1],p[i+1][0]-p[i][0]);return Math.abs(Math.atan2(Math.sin(b-a),Math.cos(b-a)));};
function everyRoute(){
  const {store}=busyTown();const cats=store.state.cats.filter(c=>c.home),layout=townLayout(cats,store.state.groups,raw),out=[];
  for(const a of cats)for(const b of cats)if(a!==b)out.push({a,b,path:layout.visitPath(a,b),road:layout.roadPath(a,b)});
  return {layout,routes:out};
}
const town=everyRoute();
test('a rounded route starts and ends exactly where the road route does, on each cat’s stand point',()=>{
  for(const {a,b,path,road} of town.routes){
    assert.deepEqual(path[0],road[0],`${a.id} to ${b.id} starts elsewhere`);assert.deepEqual(path.at(-1),road.at(-1),`${a.id} to ${b.id} ends elsewhere`);
  }
});
test('no rounded route enters a fountain, and none crosses a plaza through its middle',()=>{
  for(const site of town.layout.sites){
    const fountain=site.features.find((f:{kind:string})=>f.kind==='fountain'),middle=site.plaza*.25;
    for(const {a,b,path} of town.routes){
      for(const [p,q] of segs({points:path})){
        if(fountain)assert.ok(segDist([fountain.x,fountain.z],p,q)>=FOUNTAIN.r+.4,`${a.id} to ${b.id} crosses the fountain`);
        assert.ok(segDist([site.x,site.z],p,q)>=middle,`${a.id} to ${b.id} crosses ${site.group}'s plaza through its middle`);
      }
    }
  }
});
test('rounded routes turn gently: at most 35 degrees between consecutive samples (the road routes turn up to 180)',()=>{
  let raw=0;
  for(const {a,b,path,road} of town.routes){
    for(let i=1;i<path.length-1;i++)assert.ok(turnAt(path,i)<=35*Math.PI/180,`${a.id} to ${b.id} turns ${(turnAt(path,i)*180/Math.PI).toFixed(0)} degrees at ${path[i]}`);
    for(let i=1;i<road.length-1;i++)raw=Math.max(raw,turnAt(road,i));
  }
  assert.ok(raw>Math.PI/2,'the road routes this test compares against do have sharp corners');
});
test('rounding never lengthens a route, and cuts at most half of it (doorstep loops only)',()=>{
  const ratios=town.routes.map(({path,road})=>lengthOf(path)/lengthOf(road));
  assert.ok(Math.max(...ratios)<=1+1e-9,`a route got longer: ${Math.max(...ratios)}`);
  assert.ok(Math.min(...ratios)>=.5,`a route lost half its length: ${Math.min(...ratios)}`);
  const mean=ratios.reduce((s,r)=>s+r,0)/ratios.length;assert.ok(mean>.85&&mean<1,`mean length ratio ${mean}`);
});

test('adding a home only adds a stem: every existing road point stays where it was',()=>{
  const {store,town}=busyTown();const before=townLayout(store.state.cats,store.state.groups,raw);
  town.recruit('owner','Late Friend','Research');const root=town.createTask('builder','owner','New hamlet please. Staff it.','test');town.recruit('mayor','New Hamlet Cat','Build',undefined,root);
  const after=townLayout(store.state.cats,store.state.groups,raw),points=new Set(after.roads.flatMap((r:{points:number[][]})=>r.points.map(p=>p.join(','))));
  for(const road of before.roads)for(const p of road.points)assert.ok(points.has(p.join(',')),`${road.kind} road point ${p} moved`);
  assert.ok(after.roads.length>before.roads.length);
});

test('nooks keep keep_apart from each other, their plazas off the memorial, and every nook home out of the Mayor’s circle',()=>{
  const {store}=busyTown();const hamlets=store.state.groups.filter(g=>g.id!=='main');
  assert.ok(hamlets.length>=2);
  const memorial={x:L.memorial[0],z:L.memorial[1]},mainReach=groupReach('main',L);
  for(const g of hamlets){
    assert.ok(dist(g.site,memorial)>=L.memorial_reserve+plazaOf(g.site,L)+L.road_clearance-1e-9,`${g.id} is too near the memorial`);
    assert.ok(dist(g.site,{x:0,z:0})>=mainReach+plazaOf(g.site,L)-1e-9,`${g.id} plaza is in the Mayor's circle`);
    for(const c of store.state.cats.filter(c=>c.group===g.id))assert.ok(dist(c.home!,{x:0,z:0})>=mainReach-1e-9,`${c.id} of ${g.id} lives in the Mayor's circle`);
    for(const other of hamlets)if(other!==g)assert.ok(dist(g.site,other.site)>=L.keep_apart-1e-9,`${g.id} is too near ${other.id}`);
  }
  assert.ok(L.keep_apart>=2*(plazaOf({x:0,z:0,index:1},L)+L.house_radius),'two nook plazas keep a home’s width between them');
  assert.ok(dist(siteCentre(1,L),{x:0,z:0})<45,'the first ring sits close in');
  const next=planSite(store.state.groups.map(g=>g.site),L);
  assert.ok(hamlets.every(g=>dist(g.site,next)>=L.keep_apart-1e-9));
  assert.deepEqual(siteCentre(0,L),{index:0,x:0,z:0});
});

test('an older town is re-seated: main homes take their plot on the bigger square, each nook moves in and its homes settle round it',()=>{
  const old={...config,world:{...config.world,layoutVersion:2,layout:{...raw,site_spacing:60,keep_apart:56,site_jitter:6,main_plaza:raw.plaza_radius,main_radius:27,plot_radius:27}}};
  // A town founded under the v2 layout (small square, wide hex spacing), then reopened under the current config.
  const v2=join(dir(),'events.jsonl'),s2=new Store(v2,allRoles(config)),t2=new Town(s2,old);
  for(let g=0;g<2;g++){const root=t2.createTask('scholar','owner',`Hamlet request ${g}. Staff it.`,'test');for(let i=0;i<3;i++)t2.recruit('mayor',`Task ${g} cat ${i}`,'Build things',undefined,root);}
  const before=structuredClone(s2.state),after=new Store(v2,[]);new Town(after,config);
  assert.equal(after.state.layoutVersion,config.world.layoutVersion);
  const main=after.state.groups.find(g=>g.id==='main')!;
  for(const c of after.state.cats){
    const was=before.cats.find(b=>b.id===c.id)!;assert.equal(c.group,was.group,`${c.id} keeps its group`);
    if(c.group==='main'){
      assert.ok(dist(c.home!,main.site)>=(c.home!.plot===0?0:plazaOf(main.site,L)+L.house_radius)-1e-9,`${c.id} is off the Mayor's square`);
      continue;
    }
    const g=after.state.groups.find(g=>g.id===c.group)!;
    assert.ok(dist(c.home!,main.site)>=groupReach('main',L)-1e-9,`${c.id} of ${g.id} stays out of the Mayor's circle`);
    assert.ok(dist(c.home!,g.site)<=groupReach(g.id,L)+1e-9,`${c.id} lives round its own nook`);
  }
  const hall=after.state.cats.find(c=>c.group==='main'&&c.home!.plot===0)!;
  assert.ok(Math.abs(hall.home!.z-(main.site.z-(plazaOf(main.site,L)-L.house_radius-L.road_clearance)))<1e-9&&dist(hall.home!,main.site)+L.house_radius<plazaOf(main.site,L),'the Mayor’s house stands inside the square');
  for(const g of after.state.groups.filter(g=>g.id!=='main'))assert.ok(dist(g.site,{x:0,z:0})<dist(before.groups.find(o=>o.id===g.id)!.site,{x:0,z:0}),`${g.id} moved in`);
});

test('recruiting never moves an existing home, owner or task-born',()=>{
  const {store,town}=busyTown();const before=snapshotHomes(store);
  town.recruit('owner','Late Owner Friend','Research');
  const root=town.createTask('builder','owner','Another request. Staff it.','test');town.recruit('mayor','Late Task Cat','Research',undefined,root);
  for(const b of before)assert.deepEqual(store.state.cats.find(c=>c.id===b.id)!.home,b.home,`${b.id} moved`);
});

test('a model-recruited cat joins its root task group, founds a site, and later recruits share it',async()=>{
  const {store,town}=fixture();
  town.providers.test=async messages=>{
    const id=/CAT_ID=(\w+)/.exec(String(messages[0].content))?.[1],replies=messages.filter(m=>m.role==='tool').length;
    if(id==='scholar')return replies?{message:{role:'assistant',content:'Delegated.'}}:{message:{role:'assistant',content:null,tool_calls:[{id:'d1',type:'function',function:{name:'delegate',arguments:JSON.stringify({cat:'mayor',task:'Staff the bakery.'})}}]}};
    if(id==='mayor'){
      if(replies>=2)return {message:{role:'assistant',content:'Staffed.'}};
      return {message:{role:'assistant',content:null,tool_calls:[
        {id:'c1',type:'function',function:{name:'create_cat',arguments:JSON.stringify({name:'Baker',role:'Bake bread'})}},
        {id:'c2',type:'function',function:{name:'create_cat',arguments:JSON.stringify({name:'Miller',role:'Mill flour'})}}]}};
    }
    return {message:{role:'assistant',content:'Done.'}};
  };
  const text='Open a bakery on the high street. Staff it.';
  const mainBefore=snapshotHomes(store).filter(h=>h.group==='main');
  const root=town.submit('scholar',text,'test');
  for(let i=0;i<300&&!store.state.tasks.find(t=>t.id===root&&t.status==='done');i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(store.state.tasks.find(t=>t.id===root)!.status,'done');
  const group=store.state.groups.find(g=>g.rootTask===root);
  assert.ok(group,'a group is founded for the owner request');
  assert.equal(group!.name,oneLiner(text,28));
  assert.notEqual(group!.id,'main');assert.equal(group!.lead,'baker');
  assert.ok(store.state.events.some(e=>e.type==='group.founded'&&e.data.id===group!.id));
  const baker=store.state.cats.find(c=>c.id==='baker')!,miller=store.state.cats.find(c=>c.id==='miller')!;
  assert.equal(baker.group,group!.id);assert.equal(miller.group,group!.id);
  assert.equal(baker.home!.plot,0,'the lead takes the hall');assert.ok(miller.home!.plot!>0);
  // The nook's inward plots lie in the Mayor's circle, so the first recruit takes the lowest plot outside it.
  assert.ok(dist(miller.home!,{x:0,z:0})>=groupReach('main',L)-1e-9,'the recruit lives outside the Mayor’s circle');
  assert.ok(dist(baker.home!,group!.site)<L.hall_out+1e-9,'the hall is at its site');
  assert.deepEqual(snapshotHomes(store).filter(h=>h.group==='main'),mainBefore,'main homes did not move');
});

test('an owner recruit into a full main spills into a new hamlet without throwing',()=>{
  const {store,town}=fixture();
  for(let i=0;i<config.maxCats-allRoles(config).length;i++)town.recruit('mayor','Overflow '+i,'Research');
  assert.ok(store.state.groups.length>=2,'a full main founds a hamlet');
  assert.ok(store.state.cats.every(c=>c.home!.plot===undefined||c.home!.plot<=L.plots));
});

test('migration keeps manual homes where they were and moves other cats into main',()=>{
  const file=join(dir(),'events.jsonl');
  const store=new Store(file,allRoles(config).map((c:any,i:number)=>({...c,home:{x:100+i*8,z:100,style:c.id,...(c.id==='banker'?{manual:true}:{})}})));
  new Town(store,config);
  const banker=store.state.cats.find(c=>c.id==='banker')!;
  assert.deepEqual(banker.home,{x:100+2*8,z:100,style:'banker',manual:true});
  assert.ok(store.state.cats.every(c=>c.group==='main'));
  assert.equal(store.state.groups[0].id,'main');
});

test('road lamps sit along every road at roughly lamp_spacing, never by a house or on a plaza',()=>{
  const {store}=busyTown();const layout=townLayout(store.state.cats,store.state.groups,raw);
  const homes=store.state.cats.filter(c=>c.home).map(c=>c.home!);
  const roadLength=layout.roads.reduce((sum:number,r:{points:number[][]})=>sum+r.points.slice(1).reduce((s:number,p:number[],i:number)=>s+Math.hypot(p[0]-r.points[i][0],p[1]-r.points[i][1]),0),0);
  assert.ok(layout.lamps.length>=Math.floor(roadLength/L.lamp_spacing)*0.5,'lamps are spaced along the roads');
  for(const lamp of layout.lamps){
    for(const h of homes)assert.ok(dist(lamp,h)>=L.house_radius-1e-9,'lamp beside a house');
    for(const g of store.state.groups)assert.ok(dist(lamp,g.site)>=plazaOf(g.site,L)+L.road_clearance-1e-9,'lamp on a plaza');
  }
});

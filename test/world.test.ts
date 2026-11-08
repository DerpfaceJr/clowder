import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {designs} from '../src/world.ts';
import {resolveLayout} from '../public/hamlet-layout.js';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const fixture=()=>{const file=join(mkdtempSync(join(tmpdir(),'cat-world-')),'events.jsonl');const store=new Store(file,allRoles(config));return {file,store,town:new Town(store,config)};};

test('legacy towns receive durable distinct homes; recruitment expands without relocating residents',()=>{
  const {file,store,town}=fixture(),original=store.state.cats.map(c=>({id:c.id,home:structuredClone(c.home)}));
  assert.equal(store.state.events.filter(e=>e.type==='town.planned').length,1);
  while(store.state.cats.length<config.maxCats)town.recruit('mayor','Resident '+store.state.cats.length,'Research opportunities');
  assert.throws(()=>town.recruit('mayor','Too many','Research'),/capacity/);
  for(const before of original)assert.deepEqual(store.state.cats.find(c=>c.id===before.id)!.home,before.home);
  for(const a of store.state.cats){assert.ok(a.home);assert.ok(Object.hasOwn(designs,a.home.style));for(const b of store.state.cats)if(a!==b)assert.ok(Math.hypot(a.home.x-b.home!.x,a.home.z-b.home!.z)>=2*resolveLayout(config.world.layout).house_radius-.01);}
  const reloaded=new Store(file,[]);new Town(reloaded,config);assert.deepEqual(reloaded.state.cats,store.state.cats);assert.equal(reloaded.state.events.filter(e=>e.type==='town.planned').length,1);
});
test('the Mayor creates a specialist and its house through the actual tool dispatcher',async()=>{
  const {town,store}=fixture();
  town.providers.test=async messages=>messages.some(m=>m.role==='tool')?{message:{role:'assistant',content:'New workshop ready.'}}:{message:{role:'assistant',tool_calls:[{id:'new-builder',type:'function',function:{name:'create_cat',arguments:JSON.stringify({name:'Inventor',role:'Build prototypes',style:'builder'})}}]}};
  const id=town.submit('mayor','Recruit a prototyping specialist','test');
  for(let i=0;i<100&&!store.state.tasks.some(t=>t.id===id&&t.status==='done');i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(store.state.tasks.find(t=>t.id===id)!.status,'done');const cat=store.state.cats.find(c=>c.id==='inventor')!;
  assert.equal(cat.home?.style,'builder');assert.ok(store.state.roads.some(r=>r.a==='mayor'&&r.b===cat.id));
  const plot={x:cat.home!.x,z:cat.home!.z};town.styleHome('inventor','inventor','scholar');assert.equal(cat.home!.style,'scholar');assert.deepEqual({x:cat.home!.x,z:cat.home!.z},plot);
  assert.throws(()=>town.styleHome('critic','inventor','banker'),/own home/);
  assert.throws(()=>town.recruit('mayor','Invalid','Research','missing'),/known/);
  assert.throws(()=>town.styleHome('mayor','inventor','__proto__'),/known/);
});

test('town planning migrates existing homes once, preserves custom styles, and puts the Mayor in the main hall',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cat-planning-')),file=join(dir,'events.jsonl');
 const store=new Store(file,allRoles(config).map((c:any,i:number)=>({...c,home:{x:100+i*8,z:100,style:c.id==='scholar'?'archivist':c.id}})));new Town(store,config);
 assert.equal(store.state.layoutVersion,config.world.layoutVersion);const mayor=store.state.cats.find(c=>c.id==='mayor')!;assert.equal(mayor.group,'main');assert.equal(mayor.home!.plot,0);assert.equal(store.state.groups[0].id,'main');
 assert.equal(store.state.cats.find(c=>c.id==='scholar')!.home!.style,'archivist');const homes=structuredClone(store.state.cats);const reloaded=new Store(file,[]);new Town(reloaded,config);assert.deepEqual(reloaded.state.cats,homes);assert.equal(reloaded.state.events.filter(e=>e.type==='town.planned').length,1);
});

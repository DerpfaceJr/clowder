import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {houseDecor} from '../src/world.ts';
import {regather} from '../public/hamlet-layout.js';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const fixture=()=>{const file=join(mkdtempSync(join(tmpdir(),'cat-home-look-')),'events.jsonl');const store=new Store(file,allRoles(config));return {file,store,town:new Town(store,config)};};
const home=(store:Store,id:string)=>store.state.cats.find(c=>c.id===id)!.home!;
const look={roof:'#AA3322',wall:'#f0e0c0',trim:'#553311',door:'#335577',decor:['chimney','bunting']};

test('the owner sets, replaces and clears a home look; bad colours and decor are refused',()=>{
  const {store,town}=fixture();
  assert.ok(houseDecor.length>=6&&houseDecor.every(d=>d.id&&d.label));
  town.lookHome('owner','scholar',look);assert.deepEqual(home(store,'scholar').look,{...look,roof:'#aa3322'});
  town.lookHome('owner','scholar',{door:'#112233'});assert.deepEqual(home(store,'scholar').look,{door:'#112233'},'a look replaces, never merges');
  town.lookHome('owner','scholar',{});assert.equal(home(store,'scholar').look,undefined,'an empty body clears it');
  assert.throws(()=>town.lookHome('scholar','scholar',look),/owner/);
  assert.throws(()=>town.lookHome('owner','scholar',{roof:'red'}),/#rrggbb/);
  assert.throws(()=>town.lookHome('owner','scholar',{decor:['moat']}),/known/);
  assert.throws(()=>town.lookHome('owner','scholar',{decor:['ivy','ivy']}),/different/);
  assert.throws(()=>town.lookHome('owner','scholar',{decor:houseDecor.slice(0,7).map(d=>d.id)}),/up to 6/);
  assert.throws(()=>town.lookHome('owner','scholar',{spire:'#ffffff'}),/Unknown house option/);
});

test('Redesign, owner moves and a journal replay keep the home look',()=>{
  const {file,store,town}=fixture();
  town.lookHome('owner','scholar',look);town.styleHome('owner','scholar','merchant');town.moveHome('owner','scholar',24,24);
  assert.equal(home(store,'scholar').style,'merchant');assert.equal(home(store,'scholar').look!.door,'#335577');
  const reloaded=new Store(file,[]);new Town(reloaded,config);assert.deepEqual(home(reloaded,'scholar'),home(store,'scholar'));
});

test('a full replan and a regather keep the home look',()=>{
  // Replan: a fresh journal (layoutVersion 0) replans every non-manual home into hamlets, then regathers.
  const file=join(mkdtempSync(join(tmpdir(),'cat-home-replan-')),'events.jsonl');
  const store=new Store(file,allRoles(config).map((c:any,i:number)=>({...c,home:{x:100+i*8,z:100,style:c.id,...(c.id==='scholar'?{look}:{})}})));new Town(store,config);
  assert.equal(store.state.layoutVersion,config.world.layoutVersion);assert.ok(Number.isInteger(home(store,'scholar').plot),'replanned onto a plot');
  assert.deepEqual(home(store,'scholar').look,look);
  // Regather alone: the next layout version re-seats the town; the look rides along.
  const next={...config,world:{...config.world,layoutVersion:config.world.layoutVersion+1}},again=new Store(file,[]);new Town(again,next);
  assert.equal(again.state.layoutVersion,next.world.layoutVersion);assert.deepEqual(home(again,'scholar').look,look);
  // And the layout function itself, on a home that moves.
  const cats=structuredClone(store.state.cats);const cat=cats.find(c=>c.id==='scholar')!;cat.home!.x+=1;
  const moved=regather(cats,store.state.groups,config.world.layout).homes.find((h:any)=>h.id==='scholar');assert.deepEqual(moved?.home.look,look);
});

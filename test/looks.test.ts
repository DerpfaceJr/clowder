import {allRoles} from '../src/roles.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town,appearanceKeys} from '../src/engine.ts';
import {kit,generateLook,checkParts} from '../src/world.ts';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const fixture=()=>{const file=join(mkdtempSync(join(tmpdir(),'cat-looks-')),'events.jsonl');const store=new Store(file,allRoles(config).filter(c=>kit.roles[c.id]));return {file,store,town:new Town(store,config)};};
const hex=/^#[0-9a-f]{6}$/;
const lookOf=(store:Store,id:string)=>store.state.cats.find(c=>c.id===id)!.look!;

test('founders wear the reference role looks, planned once and kept across reopen',()=>{
  const {file,store}=fixture();
  assert.equal(store.state.events.filter(e=>e.type==='looks.planned').length,1);
  for(const cat of store.state.cats){
    const role=kit.roles[cat.id];assert.ok(role,'every founder has a reference look: '+cat.id);
    assert.deepEqual({base:cat.look!.base,marking:cat.look!.marking,parts:cat.look!.parts,outfit:cat.look!.outfit},{base:role.base,marking:role.marking,parts:role.parts,outfit:role.outfit});
    assert.equal(cat.look!.house,undefined,'founder homes keep their classic design');
  }
  const reloaded=new Store(file,[]);new Town(reloaded,config);
  assert.equal(reloaded.state.events.filter(e=>e.type==='looks.planned').length,1,'a reopened town does not plan looks again');
  assert.deepEqual(reloaded.state.cats,store.state.cats);
});

test('six recruits get six distinct, valid, persisted looks and individual houses',()=>{
  const {file,store,town}=fixture();
  const ids=['Ada','Bramble','Cocoa','Dune','Ember','Fig'].map(n=>town.recruit('mayor',n,'Research opportunities'));
  const looks=ids.map(id=>lookOf(store,id));
  assert.equal(new Set(looks.map(l=>JSON.stringify(l))).size,6,'distinct looks');
  assert.equal(new Set(looks.map(l=>JSON.stringify(l.house))).size,6,'distinct houses');
  for(const look of looks){
    assert.ok(kit.bases.includes(look.base)&&kit.markings.includes(look.marking));
    assert.deepEqual(look.parts,kit.roles.scholar.parts,'a research role wears the scholar costume');
    for(const k of kit.colours)assert.match((look as any)[k],hex,k);
    for(const k of ['roof','wall','trim'])assert.match((look.house as any)[k],hex,'house '+k);
  }
  // The created event carries the look, so replay reproduces it without regenerating.
  assert.ok(store.state.events.filter(e=>e.type==='cat.created').every(e=>e.data.look));
  const reloaded=new Store(file,[]);new Town(reloaded,config);
  for(const id of ids)assert.deepEqual(lookOf(reloaded,id),lookOf(store,id));
});

test('looks are deterministic per id, and unmatched roles get a seeded costume with one part per socket',()=>{
  assert.deepEqual(generateLook('zed','Zed','Juggle teacups','builder'),generateLook('zed','Zed','Juggle teacups','builder'));
  for(const id of ['a','b','c','d','e','f','g','h']){
    const look=generateLook(id,id,'Juggle teacups','builder');
    assert.ok(look.parts.length>=1);assert.deepEqual(checkParts(look.parts),look.parts);
  }
});

test('every generated look is accepted by the owner customize path',()=>{
  const {store,town}=fixture();const id=town.recruit('owner','Quill','Juggle teacups');
  const {house,...look}=lookOf(store,id);
  assert.ok(Object.keys(look).every(k=>appearanceKeys.includes(k)));
  town.customizeCat('owner',id,look);
  assert.deepEqual(store.state.cats.find(c=>c.id===id)!.appearance,look);
});

// The look generators moved into public/looks.js (shared with the Studio). Seeded looks must stay byte-identical to the
// fixture captured before the move: same ids, same names, same key order.
test('generateLook still makes the same looks for 20 fixed ids (captured before looks.js; re-captured when 13 costumes joined the roll, which changed only parts)',()=>{
  const before=JSON.parse(readFileSync(new URL('./fixtures/looks-before.json',import.meta.url),'utf8'));
  assert.equal(before.length,20);
  for(const c of before)assert.equal(JSON.stringify(generateLook(c.id,c.name,c.role,c.style,c.founder)),JSON.stringify(c.look),c.id);
});

test('owner kit choices validate parts per socket; an empty list means no parts',()=>{
  const {store,town}=fixture();
  town.customizeCat('owner','scholar',{base:'sprout',marking:'calico',expression:'sleepy',parts:['satchel','apron'],patch:'#AA2200',trim:'#112233'});
  assert.deepEqual(store.state.cats.find(c=>c.id==='scholar')!.appearance,{base:'sprout',marking:'calico',expression:'sleepy',parts:['satchel','apron'],patch:'#aa2200',trim:'#112233'});
  town.customizeCat('owner','scholar',{parts:[]});
  assert.deepEqual(store.state.cats.find(c=>c.id==='scholar')!.appearance!.parts,[]);
  const before=structuredClone(store.state.cats.find(c=>c.id==='scholar')!.appearance);
  for(const bad of [{parts:['jetpack']},{parts:['apron','waistcoat']},{parts:['cape','cape']},{parts:'cape'},{base:'blob'},{marking:'spotted'},{expression:'angry'},{cream:'white'}])
    assert.throws(()=>town.customizeCat('owner','scholar',bad as Record<string,unknown>),/Choose/,JSON.stringify(bad));
  assert.deepEqual(store.state.cats.find(c=>c.id==='scholar')!.appearance,before);
});

test('the kit catalog maps every part to a known socket and every legacy accessory to a part',()=>{
  for(const [id,part] of Object.entries(kit.parts))assert.ok(kit.sockets.includes(part.socket),id);
  for(const part of Object.values(kit.legacyAccessories))assert.ok(Object.hasOwn(kit.parts,part));
  for(const [style,role] of Object.entries(kit.roles))assert.deepEqual(checkParts(role.parts),role.parts,style);
});

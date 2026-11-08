import {allRoles} from '../src/roles.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {accessories,chromas,designs} from '../src/world.ts';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const fixture=()=>{const file=join(mkdtempSync(join(tmpdir(),'cat-editor-')),'events.jsonl');const store=new Store(file,allRoles(config));return {file,store,town:new Town(store,config)};};
const cat=(store:Store,id:string)=>store.state.cats.find(c=>c.id===id)!;
const home=(store:Store,id:string)=>structuredClone(cat(store,id).home)!;
const scheme=(id:string)=>chromas.find(c=>c.id===id)!;
// Retirement goes through the journal exactly as a passed council records it.
function retire(store:Store,id:string){const council='council-'+id;store.emit('council.opened',{id:council,target:id,proposer:'owner',reason:'Finished',evidence:[],electorate:[],mode:'demo'});store.emit('council.closed',{id:council,status:'retired',result:'Retired for test'});}

test('owner moves a home to a free spot, rounded to a tenth, keeping its style and marking it manual',()=>{
  const {store,town}=fixture();const before=home(store,'scholar');
  assert.equal(town.moveHome('owner','scholar',30.04,30.06),`Moved scholar's home.`);
  assert.deepEqual(home(store,'scholar'),{...before,x:30,z:30.1,manual:true});
  town.moveHome('owner','scholar',-150.04,-99.96);
  assert.deepEqual(home(store,'scholar'),{...before,x:-150,z:-100,manual:true});
});

test('moves onto another home, a plaza, or the memorial are rejected',()=>{
  const {store,town}=fixture();const before=home(store,'scholar'),banker=home(store,'banker');
  assert.throws(()=>town.moveHome('owner','scholar',banker.x+2,banker.z-3),/too close/);
  assert.throws(()=>town.moveHome('owner','scholar',0,-1),/plaza/);
  assert.throws(()=>town.moveHome('owner','scholar',28.8,-28.8),/memorial/);
  assert.deepEqual(home(store,'scholar'),before);
});

test('moves are bounded to the town limit and reject non-finite coordinates',()=>{
  const {store,town}=fixture();
  assert.throws(()=>town.moveHome('owner','archivist',241,0),/inside the town/);
  assert.throws(()=>town.moveHome('owner','archivist',0,-241),/inside the town/);
  assert.throws(()=>town.moveHome('owner','archivist',NaN,0),/finite/);
  assert.throws(()=>town.moveHome('owner','archivist',Infinity,0),/finite/);
});

test('group halls cannot be moved',()=>{
  const {store,town}=fixture();
  assert.throws(()=>town.moveHome('owner','mayor',-150,-100),/hall/);
  assert.equal(home(store,'mayor').plot,0);
});

test('only the owner moves homes or customizes cats',()=>{
  const {store,town}=fixture();const before=home(store,'scholar');
  for(const actor of ['mayor','scholar']){
    assert.throws(()=>town.moveHome(actor,'scholar',24,24),/owner/);
    assert.throws(()=>town.customizeCat(actor,'scholar',{accessory:'bow'}),/owner/);
  }
  assert.deepEqual(home(store,'scholar'),before);assert.equal(cat(store,'scholar').appearance,undefined);
});

test('retired cats can neither move nor be customized',()=>{
  const {store,town}=fixture();retire(store,'scholar');
  assert.throws(()=>town.moveHome('owner','scholar',24,24),/Retired/);
  assert.throws(()=>town.customizeCat('owner','scholar',{accessory:'bow'}),/Retired/);
  assert.throws(()=>town.moveHome('owner','nobody',24,24),/Unknown cat/);
});

test('moved homes and customized looks survive a store reopen (journal replay)',()=>{
  const {file,store,town}=fixture();
  town.moveHome('owner','scholar',24,24);town.customizeCat('owner','scholar',{chroma:'midnight',accessory:'hat'});
  const reloaded=new Store(file,[]);new Town(reloaded,config);
  assert.deepEqual(reloaded.state.cats,store.state.cats);
  assert.deepEqual(home(reloaded,'scholar'),{...home(store,'scholar'),x:24,z:24});
  assert.equal(cat(reloaded,'scholar').appearance!.chroma,'midnight');
});

test('a chroma sets fur, outfit and eyes from the catalog',()=>{
  const {store,town}=fixture();const midnight=scheme('midnight');
  town.customizeCat('owner','scholar',{chroma:'midnight'});
  assert.deepEqual(cat(store,'scholar').appearance,{chroma:'midnight',fur:midnight.fur,outfit:midnight.outfit,eyes:midnight.eyes});
});

test('explicit hex values override the chroma preset, normalised to lowercase',()=>{
  const {store,town}=fixture();const snow=scheme('snow');
  town.customizeCat('owner','scholar',{chroma:'snow',fur:'#AABBCC'});
  assert.deepEqual(cat(store,'scholar').appearance,{chroma:'snow',fur:'#aabbcc',outfit:snow.outfit,eyes:snow.eyes});
});

test('invalid chroma, hex, accessory or unknown option is rejected and leaves the cat unchanged',()=>{
  const {store,town}=fixture();town.customizeCat('owner','scholar',{accessory:'scarf'});const before=structuredClone(cat(store,'scholar').appearance);
  for(const bad of [{chroma:'neon'},{chroma:''},{chroma:7},{fur:'red'},{outfit:'#abc'},{eyes:'#gggggg'},{fur:'#aabbcc0'},{accessory:'crown'},{accessory:null},{name:'Mega'},{},{chroma:'snow',eyes:'#12345'}])
    assert.throws(()=>town.customizeCat('owner','scholar',bad as Record<string,unknown>),/Choose|Unknown/,JSON.stringify(bad));
  assert.deepEqual(cat(store,'scholar').appearance,before);
});

test('partial updates merge with the previous appearance',()=>{
  const {store,town}=fixture();const midnight=scheme('midnight');
  town.customizeCat('owner','scholar',{chroma:'midnight',accessory:'scarf'});
  town.customizeCat('owner','scholar',{eyes:'#010203'});
  assert.deepEqual(cat(store,'scholar').appearance,{chroma:'midnight',fur:midnight.fur,outfit:midnight.outfit,eyes:'#010203',accessory:'scarf'});
  town.customizeCat('owner','scholar',{accessory:'none'});
  assert.equal(cat(store,'scholar').appearance!.accessory,'none');assert.equal(cat(store,'scholar').appearance!.eyes,'#010203');
});

test('catalog chromas are separate from house designs and expose unique preset ids',()=>{
  assert.equal(chromas.length,10);assert.equal(new Set(chromas.map(c=>c.id)).size,10);
  for(const c of chromas)for(const hex of [c.fur,c.outfit,c.eyes])assert.match(hex,/^#[0-9a-f]{6}$/i);
  assert.ok(!Object.hasOwn(designs,'chromas'));assert.deepEqual(accessories,['none','scarf','bow','hat','glasses','satchel']);
});

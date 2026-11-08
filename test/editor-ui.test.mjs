import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planHomeMove,resolveAppearance,lookChanged,appearanceBody,wearPart,wantsKitBody,EYE_DEFAULT,TRIM_DEFAULT} from '../public/editor.js';
import {makeAnimatedCat,applyAppearance} from '../public/world-art.js';

const {chromas,kit,houseDecor,...designs}=JSON.parse(readFileSync(new URL('../public/world-catalog.json',import.meta.url)));
const raw=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).world.layout;
const groups=[{id:'main',name:'Town centre',lead:'mayor',site:{index:0,x:0,z:0}}];
const cats=[{id:'mayor',group:'main',home:{x:0,z:-6.24,style:'mayor',plot:0}},{id:'banker',group:'main',home:{x:40,z:40,style:'builder',plot:5}}];

test('move preview rounds to a tenth and refuses plazas, crowded spots and the memorial',()=>{
  assert.equal(planHomeMove(1,1,cats,'banker',raw,groups).valid,false,'plaza is reserved');
  assert.match(planHomeMove(1,1,cats,'banker',raw,groups).reason,/plaza/);
  assert.equal(planHomeMove(40.5,40,cats,'mayor',raw,groups).valid,false,'banker is too close');
  assert.equal(planHomeMove(28.8,-28.8,cats,'banker',raw,groups).valid,false,'memorial is reserved');
  assert.deepEqual(planHomeMove(40.04,40.06,cats,'banker',raw,groups),{x:40,z:40.1,valid:true,reason:null},'own spot is not occupied');
});

test('resolved look applies the chroma preset first, then explicit colours, then design and eye defaults',()=>{
  const design=designs.mayor;
  assert.deepEqual(resolveAppearance(undefined,chromas,design),{fur:design.fur,outfit:design.outfit,eyes:EYE_DEFAULT,patch:design.patch,cream:design.cream,trim:TRIM_DEFAULT,base:'bean',marking:'solid',expression:'neutral',parts:[],accessory:'none'});
  const preset=chromas.find(c=>c.id==='tuxedo');
  assert.equal(resolveAppearance({chroma:'tuxedo'},chromas,design).fur,preset.fur);
  const mixed=resolveAppearance({chroma:'tuxedo',eyes:'#010203'},chromas,design);
  assert.equal(mixed.eyes,'#010203');assert.equal(mixed.outfit,preset.outfit);
});

test('save body carries the full look, includes chroma only when picked, and dirtiness ignores identical looks',()=>{
  const design=designs.banker,saved={chroma:'snow',fur:'#112233',outfit:'#445566',eyes:'#778899',accessory:'hat'};
  const body=appearanceBody({accessory:'scarf'},chromas,design);
  assert.deepEqual([body.fur,body.outfit,body.eyes,body.accessory],[design.fur,design.outfit,EYE_DEFAULT,'scarf']);assert.ok(!('chroma' in body));
  assert.equal(appearanceBody({chroma:'snow'},chromas,design).chroma,'snow');
  assert.equal(lookChanged({...saved},saved,chromas,design),false);
  assert.equal(lookChanged({...saved,accessory:'bow'},saved,chromas,design),true);
  assert.equal(lookChanged({...saved,outfit:'#445567'},saved,chromas,design),true);
});

test('applying a look recolours only that cat’s tagged parts and never the shared materials',()=>{
  const palette=designs.mayor,a=makeAnimatedCat('mayor',palette),b=makeAnimatedCat('mayor',palette);
  const tagged=cat=>{const out=[];cat.traverse(o=>{if(o.userData.appearanceRole)out.push(o);});return out;};
  const furA=tagged(a).filter(o=>o.userData.appearanceRole==='fur'),eyesA=tagged(a).filter(o=>o.userData.appearanceRole==='eyes');
  assert.ok(furA.length>0&&eyesA.length===2,'fur and both eyes are tagged');
  const look={fur:'#00ff00',outfit:'#0000ff',eyes:'#ff00ff'};
  applyAppearance(a,look);
  assert.ok(furA.every(o=>o.material.color.getHexString()==='00ff00'));
  assert.ok(eyesA.every(o=>o.material.color.getHexString()==='ff00ff'));
  for(const o of tagged(b))assert.notEqual(o.material.color.getHexString(),'00ff00','other cat keeps its own fur');
  for(const o of tagged(b).filter(o=>o.userData.appearanceRole==='fur'))assert.equal(o.material.color.getHexString(),palette.fur.slice(1));
  // An empty look leaves the procedural colours alone.
  const before=furA.map(o=>o.material.color.getHexString());applyAppearance(a,{});
  assert.deepEqual(furA.map(o=>o.material.color.getHexString()),before);
});

test('generated look sits under the owner choices; a legacy accessory maps onto its socket only when no parts were chosen',()=>{
  const look={...kit.roles.merchant,expression:'neutral',eyes:'#231d18'},design=designs.merchant;
  const r=resolveAppearance(undefined,chromas,design,look,kit);
  assert.deepEqual([r.base,r.marking,r.parts,r.outfit],[look.base,look.marking,look.parts,look.outfit]);
  assert.equal(resolveAppearance({chroma:'midnight'},chromas,design,look,kit).fur,chromas.find(c=>c.id==='midnight').fur,'chroma beats the generated look');
  assert.deepEqual(resolveAppearance({accessory:'bow'},chromas,design,look,kit).parts,['apron','satchel','neck_bow']);
  assert.deepEqual(resolveAppearance({accessory:'bow',parts:[]},chromas,design,look,kit).parts,[],'an explicit empty wardrobe wins');
  assert.deepEqual(wearPart(['apron','satchel'],'waistcoat',kit),['satchel','waistcoat'],'one part per socket');
  assert.equal(lookChanged({parts:['apron']},{parts:['apron']},chromas,design,look,kit),false);
  assert.equal(lookChanged({parts:['apron','cape']},{parts:['apron']},chromas,design,look,kit),true);
});

test('only a different body, coat or costume counts as a kit choice (the Mayor keeps its GLB otherwise)',()=>{
  const look={...kit.roles.mayor,expression:'neutral',eyes:'#231d18'},design=designs.mayor;
  const colourOnly=appearanceBody({eyes:'#010203'},chromas,design,look,kit);
  assert.equal(wantsKitBody(colourOnly,look),false,'a colour-only save keeps the hand-made model');
  assert.equal(wantsKitBody(resolveAppearance({},chromas,design,look,kit),look),false,'an unchanged preview too');
  assert.equal(wantsKitBody({...colourOnly,parts:['cape','wizard_hat']},look),true);
  assert.equal(wantsKitBody({base:'puff'},look),true);assert.equal(wantsKitBody(undefined,look),false);
});

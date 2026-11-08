import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {makeHouse,makeGarden,bake} from '../public/world-art.js';
import {ROOF_PALETTE,snapRoof,loadRoofKit,shingles,buildHouseLife} from '../public/house-art.js';
const {chromas,kit,houseDecor,...designs}=JSON.parse(readFileSync(new URL('../public/world-catalog.json',import.meta.url)));
const raw=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url))).world.layout;
const palette=new Set(Object.values(ROOF_PALETTE));
const roofKit=await loadRoofKit();
const tris=g=>(g.index?g.index.count:g.attributes.position.count)/3;

test('the Blender shingle kit loads from its GLB with every piece, a face and a darker lip each',()=>{
  for(const name of ['cap_large','cap_small','gable','dome']){
    const piece=shingles(name);assert.ok(piece,name+' is in house-roofs.glb');
    assert.equal(piece.face.shade,1);assert.ok(piece.lip.shade>.2&&piece.lip.shade<.8,name+' lip is shaded darker (linear)');
    // Triangle budget per roof piece (face + lip): 64 houses carry up to four.
    assert.ok(tris(piece.face.geo)+tris(piece.lip.geo)<=1600,name+' stays inside its triangle budget');
    piece.face.geo.computeBoundingBox();const b=piece.face.geo.boundingBox;
    if(name!=='gable')assert.ok(b.max.x<=1.2&&b.min.y>=-.4&&b.max.y<=1.05,name+' is in unit space');
  }
  assert.deepEqual(Object.keys(roofKit).sort(),['cap_large','cap_small','dome','gable']);
});

test('roof colours snap to the eight-colour palette, the same colour every time',()=>{
  for(const hex of ['#6c9298','#8c9b70','#a68199','#c69b65','#7295ab','#b97f69','#90a18b','#8195ad','#7b768a','#ffffff','#000000',...Object.values(ROOF_PALETTE)]){
    assert.ok(palette.has(snapRoof(hex)),hex);assert.equal(snapRoof(hex),snapRoof(hex));
  }
  for(const hex of Object.values(ROOF_PALETTE))assert.equal(snapRoof(hex),hex,'a palette colour stays itself');
  assert.equal(snapRoof(undefined),ROOF_PALETTE.terracotta,'no colour falls back to terracotta');
  assert.equal(snapRoof('#888888'),ROOF_PALETTE.slate,'greys go slate');
});

// Colours of every mesh drawn in a house, and its glowing panes split by side.
const meshes=g=>{g.updateMatrixWorld(true);const list=[];g.traverse(o=>{if(o.isMesh)list.push(o);});return list;};
test('every style has a lit back window, roofs in the palette, and smoke and window light anchors',()=>{
  for(const style of Object.keys(designs))for(const back of [false,true]){
    const house=makeHouse(style,{...designs[style],back}),v=new T.Vector3();
    const panes=meshes(house).filter(m=>m.material.emissive&&m.material.color.getHexString()==='ffcf7a').map(m=>m.getWorldPosition(v).z);
    assert.ok(panes.some(z=>z<-.8),`${style} has a window on its back`);
    if(style!=='banker')assert.ok(panes.some(z=>z>.8),`${style} keeps its front windows`);
    const life=house.userData.life;
    assert.ok(life.smoke.length>=1,`${style} classic trim has a smoking chimney`);
    assert.ok(life.spill.length>=(style==="banker"?2:4),`${style} lights the ground at its door and windows`);
    // The chimney stands on the side that faces the camera: the back when the back faces it, else the front.
    assert.ok(life.smoke.some(([,,z])=>back?z<0:z>0),`${style} chimney faces the camera (back=${back})`);
  }
  // An owner decor list without a chimney draws none, so no smoke.
  assert.equal(makeHouse('scholar',{...designs.scholar,decor:[]}).userData.life.smoke.length,0);
});

test('roof meshes carry the snapped palette colour, never the raw stored one',()=>{
  const raw='#7b768a',house=makeHouse('scholar',{...designs.scholar,roof:raw}),colours=new Set(meshes(house).map(m=>'#'+m.material.color.getHexString()));
  assert.ok(!colours.has(raw),'the stored colour is not drawn');assert.ok(colours.has(snapRoof(raw)),'the palette colour is drawn');
});

test('house art with shingles still fits the footprint the layout reserves',()=>{
  for(const style of Object.keys(designs))for(const decor of [undefined,houseDecor.map(d=>d.id)])for(const back of [false,true]){
    const g=new T.Group();g.add(makeHouse(style,{...designs[style],decor,back}),makeGarden());g.updateMatrixWorld(true);
    let r=0;const v=new T.Vector3();g.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld);r=Math.max(r,Math.hypot(v.x,v.z));}});
    assert.ok(r<=raw.house_radius+1e-9,`${style}${decor?' with all decor':''} reaches ${r.toFixed(2)}`);
  }
});

test('the town life is two instanced draws at most: smoke and window light',()=>{
  const house=makeHouse('builder',designs.builder),m=new T.Matrix4().makeTranslation(5,0,5);
  const life=buildHouseLife([{points:house.userData.life,matrix:m},{points:house.userData.life,matrix:m.clone().makeTranslation(-5,0,9)}]);
  assert.equal(life.children.length,2);assert.ok(life.children.every(o=>o.isInstancedMesh));
  const [smoke,spill]=life.children;assert.equal(smoke.count,2*house.userData.life.smoke.length*5);assert.equal(spill.count,2*house.userData.life.spill.length);
  assert.equal(buildHouseLife([]).children.length,0,'no houses, no draws');
  // The baked house carries its anchors (town.js hamletMeshes reads them off the bake).
  const art=new T.Group();art.add(house);art.userData.life=house.userData.life;assert.deepEqual(bake(art).userData.life,house.userData.life);
});

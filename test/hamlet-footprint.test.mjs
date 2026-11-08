import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {makeHouse,makeGarden,compact} from '../public/world-art.js';
const {chromas,kit,houseDecor,...designs}=JSON.parse(readFileSync(new URL('../public/world-catalog.json',import.meta.url)));
const raw=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url))).world.layout;

test('house art fits inside the footprint the layout reserves',()=>{
  // Worst horizontal distance from a house centre to any vertex of house plus garden, in unscaled art units.
  const worst=(style,decor)=>{
    const g=new T.Group();g.add(compact(makeHouse(style,{...designs[style],decor})));g.add(compact(makeGarden()));g.updateMatrixWorld(true);
    let r=0;g.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld);r=Math.max(r,Math.hypot(v.x,v.z));}});
    return r;
  };
  // Every decor item at once (the owner's Studio picks at most 6, but each must fit on every style).
  for(const style of Object.keys(designs))for(const decor of [undefined,houseDecor.map(d=>d.id)])assert.ok(worst(style,decor)<=raw.house_radius+1e-9,`${style} art${decor?' with all decor':''} is wider than house_radius`);
});

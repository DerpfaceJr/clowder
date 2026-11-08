// Disposal rules for the town scene, kept free of Three.js and the DOM so Node tests can count disposals with fakes.
// Ownership: an object flagged userData.ownedGeometry owns its geometry, one flagged userData.appearanceRole owns its
// material, and an InstancedMesh owns its instance buffers. Everything else (baked house art, prop materials, the
// Mayor GLB, cached textures) is shared and kept for the next build.

/** Detaches a group and frees what it owns. Points and lines count too (the magic street lights are Points). */
export function destroy(group){
  group.traverse(o=>{if(o.isInstancedMesh)o.dispose();if(o.geometry&&o.userData.ownedGeometry)o.geometry.dispose();if(o.material&&o.userData.appearanceRole)o.material.dispose();if(o.isSkinnedMesh&&o.userData.appearanceRole)o.skeleton?.dispose();});
  group.removeFromParent();
}

/** One resident's house proxy, body, label, bubble and hologram. The hologram is built per cat, so all of it goes. */
export function removeResident(id,r,residents,{disposeSprite,mayorScene=null}){
  r.label.remove();if(r.bubble)disposeSprite(r.bubble);if(id==='mayor'&&mayorScene)mayorScene.removeFromParent();destroy(r.group);destroy(r.catModel);
  r.holo.group.removeFromParent();r.holo.group.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});residents.delete(id);
}

/** Everything one world drew: residents, streets, links, the memorial and farewell bubbles. Maps and lists are emptied. */
export function clearWorld({residents,townGroup=null,linkMesh=null,memorial=null,farewells=[],mayorScene=null},{disposeSprite}){
  for(const [id,r] of [...residents])removeResident(id,r,residents,{disposeSprite,mayorScene});
  for(const group of [townGroup,linkMesh])if(group)destroy(group);
  if(memorial){for(const label of memorial.labels)disposeSprite(label);destroy(memorial.group);}
  for(const item of farewells.splice(0))disposeSprite(item.sprite);
}

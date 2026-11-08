import test from 'node:test';
import assert from 'node:assert/strict';
import {distanceToSegment,MessageVisits} from '../public/world-motion.js';
import {makeStreetCorner,makePlaza,compact,setWorldNight,glow} from '../public/world-art.js';
test('night lights emit more light and return to the same daytime intensity',()=>{
 const road=glow('#b8efd9'),corner=compact(makeStreetCorner()),plaza=compact(makePlaza());assert.ok(corner.children.length&&plaza.children.length);setWorldNight(false);const day=road.emissiveIntensity;setWorldNight(true);assert.ok(road.emissiveIntensity>day);setWorldNight(false);assert.equal(road.emissiveIntensity,day);
});
test('retired cats cannot leave stale walking visits or queued messages',()=>{
 const visits=new MessageVisits(),cats=[{id:'a',home:{x:0,z:8}},{id:'b',home:{x:8,z:8}}],messages=[{id:'message',from:'a',to:'b'}];visits.replay(messages,cats);visits.start(cats,null);assert.ok(visits.current);
 // The recipient retired: the courier turns home along its lane (no snap); the sender retired: the visit is dropped.
 visits.retainCats([cats[0]]);assert.equal(visits.current.phase,'return');assert.equal(visits.queue.length,0);visits.retainCats([]);assert.equal(visits.current,null);
});

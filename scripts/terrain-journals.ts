// Terrain change check against real towns: replays each journal (a temp copy; the original is only read) through the
// server's Town, then checks every home still passes homeProblem (halls: dryness) and that the ground under every home,
// plaza, the memorial and every road point is exactly what an older terrain.js gives.
// Usage: npx tsx scripts/terrain-journals.ts --old old-terrain.js [--break] events.jsonl [more.jsonl ...]
// --break moves the knolls onto the commons (a negative control: the check must then fail).
import {copyFileSync,mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../src/store.js';
import {Town} from '../src/engine.js';
import {loadConfig} from '../src/config.js';
import {resolveLayout,townLayout,homeProblem,dryAt,plazaOf} from '../public/hamlet-layout.js';
import {terrain,heldGround,townHolds} from '../public/terrain.js';

const args=process.argv.slice(2),flag=(k:string)=>{const i=args.indexOf(k);if(i<0)return undefined;const v=args[i+1];args.splice(i,2);return v;};
const oldPath=flag('--old'),broken=args.includes('--break'),files=args.filter(a=>a!=='--break');
if(!oldPath||!files.length)throw new Error('Usage: --old old-terrain.js [--break] events.jsonl ...');
const old=await import(pathToFileURL(resolve(oldPath)).href);
const config=loadConfig(resolve(import.meta.dirname,'..'));
const raw=structuredClone(config.world.layout);if(broken)raw.terrain.knoll_clear=[-40,-20];
const L=resolveLayout(raw),tNew=terrain(L.terrain),tOld=old.terrain(L.terrain);
let failed=0,homesChecked=0,points=0,lifted=0;
for(const file of files){
  const copy=join(mkdtempSync(join(tmpdir(),'terrain-journal-')),'events.jsonl');copyFileSync(file,copy);
  const store=new Store(copy,[]),town=new Town(store,config,{});town.dispose();
  const cats=store.state.cats.filter(c=>c.home&&c.group),groups=store.state.groups,problems:string[]=[];
  // Server rules: every home passes homeProblem against the others (a hall stands on its own plaza: dryness only).
  for(const c of cats){
    const h=c.home!,others=cats.filter(o=>o!==c).map(o=>({...o.home!,group:o.group}));
    const why=h.plot===0?(dryAt(h.x,h.z,L)?null:'wet hall'):homeProblem(h.x,h.z,others,groups,L);
    if(why)problems.push(`${c.id}: ${why}`);
    if(!tOld.dry(h.x,h.z)||tNew.dry(h.x,h.z)!==tOld.dry(h.x,h.z))problems.push(`${c.id}: dryness changed`);
  }
  // Client ground: the same holds under the old and new terrain.js; every sample must match exactly.
  const layout=townLayout(cats,groups,raw),homes=cats.map(c=>({...c.home!,group:c.group}));
  const mem={...layout.memorial,r:L.memorial_reserve},hNew=heldGround(tNew,townHolds(tNew,layout.sites,homes,mem,L)),hOld=old.heldGround(tOld,old.townHolds(tOld,layout.sites,homes,mem,L));
  const probe=L.terrain.dry_probe,samples:[string,number,number][]=[];
  for(const h of homes)for(const [dx,dz] of [[0,0],[probe,0],[-probe,0],[0,probe],[0,-probe],[L.house_radius,0],[0,L.house_radius]])samples.push(['home',h.x+dx,h.z+dz]);
  for(const s of layout.sites){const r=plazaOf(s,L);for(let a=0;a<16;a++)for(const f of [0,.5,1])samples.push(['plaza',s.x+Math.cos(a/16*Math.PI*2)*r*f,s.z+Math.sin(a/16*Math.PI*2)*r*f]);}
  samples.push(['memorial',mem.x,mem.z]);for(const road of layout.roads)for(const p of road.points)samples.push(['road',p[0],p[1]]);
  for(const [kind,x,z] of samples){points++;if(tNew.raw(x,z)!==tOld.raw(x,z))problems.push(`raw changed at ${kind} ${x.toFixed(1)},${z.toFixed(1)}`);if(hNew(x,z)!==hOld(x,z)){problems.push(`${kind} ground moved at ${x.toFixed(1)},${z.toFixed(1)}: ${hOld(x,z)} -> ${hNew(x,z)}`);}}
  // How much the knolls show: the largest rise 40-110 m from the centre (the zoomed-out view).
  let most=0;for(let a=0;a<64;a++)for(let r=40;r<=110;r+=5)most=Math.max(most,hNew.lift(Math.cos(a/64*Math.PI*2)*r,Math.sin(a/64*Math.PI*2)*r));
  if(most>.5)lifted++;
  homesChecked+=cats.length;failed+=problems.length?1:0;
  console.log(`${problems.length?'FAIL':'ok  '} ${file}: ${cats.length} homes, ${groups.length} groups, ${samples.length} ground samples, tallest knoll in view ${most.toFixed(2)} m${problems.length?'\n  '+problems.slice(0,8).join('\n  '):''}`);
}
console.log(`${files.length} journals, ${homesChecked} homes, ${points} ground samples, ${failed} failed; knolls visible in ${lifted}.`);
process.exitCode=failed?1:0;

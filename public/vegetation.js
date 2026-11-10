// Vegetation scatter: pure and deterministic, so Node tests can check it and every viewer sees the same meadow.
// Every prop sits on a global jittered grid (no chunk seams) and is seeded by its grid cell, so streaming is stable.
// Placement follows one grove field (groveDensity): domain-warped noise makes groves with ragged outlines, dense cores
// of tall trees thinning through young trees to a bushy edge, then flowers, then open meadow; clearings open inside the
// larger groves. Species follow small biomes: pines on high ground, birch and blossom by the water, oaks in the meadow.
// Nothing grows on roads, plazas, plots, lamps, the memorial or in water. Around the town the groves thin to an orchard
// meadow (wildness(), world.layout.terrain.clearing).
import {noise2,seeded} from './terrain.js';
import {distanceToSegment} from './world-motion.js';

export const TREE_VARIANTS=['oak','pine','birch','blossom'];
/** Footprint radius (metres, at scale 1) of a grass clump and a flower clump: they keep this far off every surface. */
export const TUFT_RADIUS=.24,FLOWER_RADIUS=.26;
/** Rock variants by the scatter's v (rocks.js draws them), and each one's footprint radius (metres, at scale 1). */
export const ROCK_KINDS=['boulder','slab','pebbles'],ROCK_FOOT={boulder:.66,slab:.92,pebbles:.28};

/** blocked(x,z,margin): true on a road, plaza, house plot, plaza feature or the memorial grounds (all in layout.circles
 *  and layout.roads), a hall yard or a lamp post's spot (layout.yards, layout.lamps). blocked.onRoad: roads only. */
export const LAMP_CLEAR=.45;
export function makeBlocker(layout){
  const circles=[...(layout?.circles||[]),...(layout?.yards||[]),...(layout?.lamps||[]).map(l=>({x:l.x,z:l.z,r:LAMP_CLEAR}))],roads=(layout?.roads||[]).map(r=>{
    const xs=r.points.map(p=>p[0]),zs=r.points.map(p=>p[1]);
    return {r,box:[Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)]};
  });
  const onRoad=(x,z,margin)=>{
    for(const {r,box} of roads){
      const w=r.width+margin;if(x<box[0]-w||x>box[2]+w||z<box[1]-w||z>box[3]+w)continue;
      for(let i=1;i<r.points.length;i++)if(distanceToSegment(x,z,r.points[i-1],r.points[i])<w)return true;
    }
    return false;
  };
  const blocked=(x,z,margin)=>{
    for(const c of circles)if(Math.hypot(x-c.x,z-c.z)<c.r+margin)return true;
    return onRoad(x,z,margin);
  };
  /** Distance from (x,z) to the nearest road edge, capped at `cap` (roads whose box is farther are skipped). */
  const roadGap=(x,z,cap)=>{
    let best=cap;
    for(const {r,box} of roads){
      const w=r.width+best;if(x<box[0]-w||x>box[2]+w||z<box[1]-w||z>box[3]+w)continue;
      for(let i=1;i<r.points.length;i++)best=Math.min(best,distanceToSegment(x,z,r.points[i-1],r.points[i])-r.width);
    }
    return Math.max(0,best);
  };
  blocked.onRoad=onRoad;blocked.roadGap=roadGap;return blocked;
}

const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
/**
 * Wildness w(x,z) in [0,1] around the settled land: 0 (open meadow) within meadow_radii hamlet radii (plot_radius) of every site and
 * the memorial, rising smoothly to 1 (full forest) at forest_radii; roads thin it to road_floor out to road_clear metres
 * past their edge, back to full by road_clear+road_fade. C: world.layout.terrain.clearing. Without it, wild everywhere.
 */
export function wildness(layout,C,blocked=makeBlocker(layout)){
  if(!C||!layout?.L)return ()=>1;
  const R=Math.max(layout.L.plot_radius,layout.L.main_radius||0),a=C.meadow_radii*R,b=C.forest_radii*R;
  const centres=[...(layout.sites||[]),...(layout.memorial?[layout.memorial]:[])],reach=C.road_clear+C.road_fade;
  return (x,z)=>{
    let d=Infinity;for(const c of centres)d=Math.min(d,Math.hypot(x-c.x,z-c.z));
    const town=smooth(a,b,d);if(!town)return 0;
    return town*(C.road_floor+(1-C.road_floor)*smooth(C.road_clear,reach,blocked.roadGap(x,z,reach)));
  };
}

/**
 * Grove density g(x,z) in [0,1]: 0 in open meadow, rising through a grove's edge to 1 in its core. Domain-warped noise
 * gives the groves ragged outlines of mixed sizes; a second field opens clearings inside the larger ones.
 */
export function groveDensity(x,z){
  const wx=x+24*noise2(x*.017,z*.017,77),wz=z+24*noise2(x*.017+7.3,z*.017,78);
  const f=noise2(wx*.0105,wz*.0105,71)*.62+noise2(wx*.027,wz*.027,72)*.28+noise2(x*.08,z*.08,76)*.1;
  return smooth(-.07,.36,f)*(1-.9*smooth(.4,.68,noise2(x*.021,z*.021,79)));
}
/** The grove edge band (bushes) and the fringe just outside it (flowers), each peaking at 1. */
const edgeBand=g=>smooth(.08,.3,g)*(1-smooth(.45,.72,g)),fringe=g=>smooth(0,.12,g)*(1-smooth(.2,.4,g));
/** Species by biome: pines on high ground and in the darkest cores, birch and blossom by the water, oaks in the meadow
 *  with a stand of birch here and there. high: metres above the plain; edge: metres past the nearest river's edge. */
export function treeSpecies(g,high,edge,sp,pick){
  if(pick<.035)return 3;
  if(high>2.4+sp*1.2||(g>.8&&sp>.3))return 1;
  if(edge<14+sp*6)return pick<.3?3:2;
  return sp<-.5?2:0;
}
/** A small random lean (radians) and stretch, so no two trees stand alike. */
const lean=(rnd,max)=>({lx:(rnd()-.5)*2*max,lz:(rnd()-.5)*2*max,sy:.9+rnd()*.22});

/** Grid cells whose jittered point may fall in the chunk [x0,x0+size) x [z0,z0+size). */
function* cells(x0,z0,size,cell){
  for(let i=Math.floor(x0/cell);i<Math.ceil((x0+size)/cell);i++)for(let j=Math.floor(z0/cell);j<Math.ceil((z0+size)/cell);j++)yield [i,j];
}
const kinds=new Map(),kindSeed=k=>{let s=kinds.get(k);if(s===undefined){s=2166136261;for(let i=0;i<k.length;i++){s^=k.charCodeAt(i);s=Math.imul(s,16777619);}kinds.set(k,s|=0);}return s;};
/** A cell's own random stream: mulberry32 seeded by an integer hash of the kind and the cell (no string per cell). */
const cellRnd=(kind,i,j)=>{
  let h=Math.imul(i,0x27d4eb2d)^Math.imul(j,0x165667b1)^kindSeed(kind);h=Math.imul(h^(h>>>15),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);h^=h>>>16;
  return ()=>{h=(h+0x6D2B79F5)|0;let t=h;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
};

/**
 * Props for chunk (cx,cz). ctx = {size, height(x,z), water, blocked(x,z,margin), town(x,z) (inside a hamlet common),
 * river(x,z) ({edge,half}), plain}; optional wild, clearing, lift and hill (heldGround's knoll and hill parts). Returns
 * lists of {x,z,y,s,r,v,c}: position, scale, yaw, variant, tint; trees, bushes and rocks add lx, lz (lean) and sy (stretch).
 */
export function scatterChunk(cx,cz,ctx){
  const {size,height,water,blocked,town,river}=ctx,x0=cx*size,z0=cz*size,inside=(x,z)=>x>=x0&&x<x0+size&&z>=z0&&z<z0+size;
  const out={trees:[],bushes:[],rocks:[],reeds:[],flowers:[],...Object.fromEntries(DECOR.map(([k])=>[k,[]]))};
  const dryEnough=(y,m)=>y>water+m,wild=ctx.wild||(()=>1),C=ctx.clearing||{};
  // Trees: chance rises smoothly with the grove field (never a step, so cores never read as a grid), and size with it:
  // tall mature trees in a core, young ones at the edge. Near the town (wildness w -> 0) every chance falls to the meadow
  // singles chance, and the singles are orchard trees (oak, birch, blossom), never pines. The singles gather in small
  // clumps (a coarse noise gate), so the meadow shows open lawns between them. Each cell has a second spot that only a
  // grove core fills, so crowns close up there.
  for(const [i,j] of cells(x0,z0,size,ctx.treeCell))for(let k=0;k<2;k++){
    const rnd=cellRnd(k?'tree2':'tree',i,j),x=(i+rnd())*ctx.treeCell,z=(j+rnd())*ctx.treeCell;if(!inside(x,z))continue;
    const g=groveDensity(x,z),inTown=town(x,z),w=wild(x,z),single=k?0:(C.meadow_tree_chance??.035)*2.4*smooth(.05,.6,noise2(x*.035,z*.035,81));
    // Small glades break up a grove's core, so it reads as trees with light between them rather than a carpet of crowns.
    const glade=1-(1-smooth(-.6,-.25,noise2(x*.11,z*.11,82)))*smooth(.3,.6,g);
    const chance=inTown?k?0:.03:single+((k?1.2*Math.max(0,g-.5):.012+.85*g**1.5)*glade-single)*w;if(rnd()>chance)continue;
    const y=height(x,z);if(!dryEnough(y,.85)||blocked(x,z,inTown?2.2:1.5))continue;
    const sp=noise2(x*.009,z*.009,73),pick=rnd();
    const v=w<(C.orchard_below??0)?(pick<C.orchard_blossom?3:sp<-.25?2:0):treeSpecies(g,y-ctx.plain,river(x,z).edge,sp,pick);
    out.trees.push({x,z,y,s:.55+.45*g*w+rnd()*.38,r:rnd()*Math.PI*2,v,c:rnd(),...lean(rnd,.05+.05*(1-g))});
  }
  // Understorey: bushes gather in the grove edge band, in twos and threes; a rare single out in the meadow.
  for(const [i,j] of cells(x0,z0,size,5.5)){
    const rnd=cellRnd('bush',i,j),x=(i+rnd())*5.5,z=(j+rnd())*5.5,w=wild(x,z);
    if(town(x,z)||rnd()>.02+.62*edgeBand(groveDensity(x,z))*w)continue;
    for(let k=0,n=1+Math.floor(rnd()*2.6);k<n;k++){
      const a=rnd()*6.28,d=k&&.9+rnd()*.9,bx=x+Math.cos(a)*d,bz=z+Math.sin(a)*d,s=(k?.55:.75)+rnd()*.5;
      if(!inside(bx,bz)||blocked(bx,bz,.8*s))continue;const by=height(bx,bz);if(!dryEnough(by,.7))continue;
      out.bushes.push({x:bx,z:bz,y:by,s,r:rnd()*6.28,v:0,c:rnd(),...lean(rnd,.06)});
    }
  }
  // Reeds: dense along the banks, in the shallows and just above them.
  for(const [i,j] of cells(x0,z0,size,1.7)){
    const rnd=cellRnd('reed',i,j),x=(i+rnd())*1.7,z=(j+rnd())*1.7;if(!inside(x,z))continue;
    const e=river(x,z).edge;if(e<-1.2||e>2.2||rnd()>.75)continue;
    const y=height(x,z);if(blocked(x,z,.4))continue;
    out.reeds.push({x,z,y:Math.max(y,water-.35),s:.75+rnd()*.6,r:rnd()*6.28,v:0,c:rnd()});
  }
  // Wildflowers: drifts in open meadow, a little wider near the town.
  for(const [i,j] of cells(x0,z0,size,2.4)){
    const rnd=cellRnd('flower',i,j),x=(i+rnd())*2.4,z=(j+rnd())*2.4;if(!inside(x,z))continue;
    // Flowers drift through the meadow and gather where a grove thins out, never under the trees.
    const drift=noise2(x*.06,z*.06,74),g=groveDensity(x,z);if(g>.55||drift<.25-(C.meadow_flowers??0)*(1-wild(x,z))-.5*fringe(g)||rnd()>.8)continue;
    const y=height(x,z),fs=.8+rnd()*.5;if(!dryEnough(y,.8)||blocked(x,z,FLOWER_RADIUS*fs))continue;
    out.flowers.push({x,z,y,s:fs,r:rnd()*6.28,v:noise2(x*.03,z*.03,75)>0?0:1,c:rnd()});
  }
  // Odds and ends of the wild (DECOR): rare by the town, a little commoner out in the forest; the taller ones only out there.
  for(const [kind,cell,near,far,minWild,foot] of DECOR)for(const [i,j] of cells(x0,z0,size,cell)){
    const rnd=cellRnd(kind,i,j),x=(i+rnd())*cell,z=(j+rnd())*cell;if(!inside(x,z))continue;
    const w=wild(x,z);if(w<minWild||rnd()>(near+(far-near)*w)*DECOR_GROVE[kind](groveDensity(x,z)))continue;
    const y=height(x,z),s=.8+rnd()*.4;if(!dryEnough(y,.8)||blocked(x,z,foot*s+.3))continue;
    out[kind].push({x,z,y,s,r:rnd()*6.28,v:0,c:rnd()});
  }
  // Rocks (rocks.js variants v: 0 boulder, 1 slab, 2 pebbles), each kept its footprint plus `gap` off every surface.
  // sink: how far into the ground, by scale; tilt: [lx,lz] lean (meadow.js tilts in world space after the yaw).
  const lift=ctx.lift||(()=>0),hill=ctx.hill||(()=>0),slopeAt=(x,z)=>[(height(x+1.5,z)-height(x-1.5,z))/3,(height(x,z+1.5)-height(x,z-1.5))/3];
  const rock=(rnd,x,z,v,s,{sink=0,tilt=[0,0],gap=.2}={})=>{
    if(!inside(x,z)||blocked(x,z,ROCK_FOOT[ROCK_KINDS[v]]*s+gap))return;const y=height(x,z);if(y<water-.2)return;
    out.rocks.push({x,z,y:y-sink*s,s,r:rnd()*6.28,v,c:rnd(),lx:tilt[0],lz:tilt[1],sy:.85+rnd()*.3});
  };
  // Lean with the ground: tilt by `k` of the slope, so a stone on a hillside sits into it rather than floating level.
  const withSlope=(x,z,k)=>{const [hx,hz]=slopeAt(x,z);return [-Math.atan(hz)*k,Math.atan(hx)*k];};
  // Hillside outcrops: on the flank of a hill or knoll, a big slab and a few boulders stepping along the contour, half sunk.
  for(const [i,j] of cells(x0,z0,size,15)){
    const rnd=cellRnd('outcrop',i,j),x=(i+rnd())*15,z=(j+rnd())*15;if(!inside(x,z)||rnd()>.6||lift(x,z)+hill(x,z)<1.2)continue;
    const [hx,hz]=slopeAt(x,z),slope=Math.hypot(hx,hz);if(slope<.05)continue;
    const ux=-hz/slope,uz=hx/slope,dx=hx/slope,dz=hz/slope;// along the contour, and uphill
    for(let k=0,n=3+Math.floor(rnd()*3);k<n;k++){
      const t=(k?(k%2?1:-1)*(.9+k*.55):0)+(rnd()-.5)*.6,o=(rnd()-.5)*1.4,px=x+ux*t+dx*o,pz=z+uz*t+dz*o;
      rock(rnd,px,pz,k===0||rnd()<.3?1:0,(k?.75:1.7)+rnd()*(k?.5:.7),{sink:.22,tilt:withSlope(px,pz,.8),gap:.3});
    }
  }
  // Boulder clusters where a grove meets the meadow: two to four mossy stones, the first the biggest.
  for(const [i,j] of cells(x0,z0,size,12)){
    const rnd=cellRnd('boulders',i,j),x=(i+rnd())*12,z=(j+rnd())*12;if(!inside(x,z)||rnd()>.55*edgeBand(groveDensity(x,z))*wild(x,z))continue;
    for(let k=0,n=2+Math.floor(rnd()*3);k<n;k++){const a=rnd()*6.28,d=k&&.8+rnd()*1.5;rock(rnd,x+Math.cos(a)*d,z+Math.sin(a)*d,0,(k?.5:.95)+rnd()*.45,{sink:.12,tilt:[(rnd()-.5)*.3,(rnd()-.5)*.3]});}
  }
  // Single boulders: by the water, and now and then out in the open.
  for(const [i,j] of cells(x0,z0,size,7)){
    const rnd=cellRnd('prop',i,j),x=(i+rnd())*7,z=(j+rnd())*7;if(!inside(x,z))continue;
    const near=river(x,z).edge,roll=rnd();if((near>.3&&near<5&&roll<.45)||roll<.012)rock(rnd,x,z,0,.45+rnd()*.7,{sink:.05,gap:.4,tilt:[(rnd()-.5)*.3,(rnd()-.5)*.3]});
  }
  // Pebbles: along the paths (kept clear of the road edge) and the river banks. A chunk with no bank or road near skips
  // the lot (the edge and the road gap change by at most about a metre per metre, so 1.5x the half diagonal is safe).
  const mx=x0+size/2,mz=z0+size/2,reach=size*Math.SQRT1_2*1.5;
  const banks=river(mx,mz).edge<3+reach,paths=!!blocked.roadGap&&blocked.roadGap(mx,mz,2.2+reach)<2.2+reach;
  if(banks||paths)for(const [i,j] of cells(x0,z0,size,3)){
    const rnd=cellRnd('pebble',i,j),x=(i+rnd())*3,z=(j+rnd())*3;if(!inside(x,z))continue;
    const roll=rnd(),bank=banks&&roll<.55&&(e=>e>0&&e<3)(river(x,z).edge);
    if(!(bank||paths&&roll<.4&&blocked.roadGap(x,z,2.2)<2.2))continue;
    rock(rnd,x,z,2,.75+rnd()*.6,{gap:.35,tilt:[(rnd()-.5)*.2,(rnd()-.5)*.2]});
  }
  return out;
}
/** [kind, grid cell (m), chance by the town (wildness 0), chance in full forest, least wildness, footprint radius (m)].
 *  Mushrooms and stumps stay under 0.4 m, so they may sit in the meadow by the town; logs, cairns and fence ends are
 *  taller (up to 0.8 m) and keep to the wilder ground, where no house or cat stands behind them. */
/** Where in the groves each kind turns up (a factor on its chance by grove density g): stumps, logs and mushrooms under
 *  the trees, cairns and fence ends out in the open. */
const DECOR_GROVE={mushrooms:g=>.4+1.2*g,stumps:g=>.4+1.2*g,logs:g=>.4+1.2*g,cairns:g=>1.3-g,fences:g=>1.3-g};
export const DECOR=[['mushrooms',8,.03,.16,0,.3],['stumps',12,.02,.18,.15,.45],['logs',15,0,.22,.45,1.1],['cairns',21,0,.2,.6,.45],['fences',27,0,.24,.5,1.1]];

/** Grass tufts for a chunk, in random order so taking a prefix thins evenly. kind seeds it ('blade': the fine blades).
 *  sy: a height stretch (0.8-1.25) on top of the scale s, so neighbouring clumps differ in shape, not only in size. */
export function grassChunk(cx,cz,count,ctx,kind='grass'){
  const {size,height,water,blocked}=ctx,rnd=seeded(`${kind}:${cx}:${cz}`),out=[];
  for(let i=0;i<count;i++){
    const x=(cx+rnd())*size,z=(cz+rnd())*size,s=.7+rnd()*.55,r=rnd()*Math.PI*2,c=rnd();
    // The whole clump (not just its centre) stays off roads, commons, yards, plots and the memorial.
    const y=height(x,z);if(y<water+.55||blocked(x,z,TUFT_RADIUS*s))continue;
    out.push({x,z,y,s,r,v:0,c,sy:.8+.45*(c*7.31%1)});
  }
  return out;
}

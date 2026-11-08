// Vegetation scatter: pure and deterministic, so Node tests can check it and every viewer sees the same meadow.
// Trees use a global jittered grid (blue-noise-like spacing, no chunk seams) with a low-frequency forest mask, so they
// fall into forest patches plus a few singles. Nothing grows on roads, plazas, plots, the memorial or in water.
// Around the town the forest thins to an orchard meadow (wildness(), world.layout.terrain.clearing).
import {noise2,seeded} from './terrain.js';
import {distanceToSegment} from './world-motion.js';

export const TREE_VARIANTS=['oak','pine','birch','blossom'];
/** Footprint radius (metres, at scale 1) of a grass clump and a flower clump: they keep this far off every surface. */
export const TUFT_RADIUS=.24,FLOWER_RADIUS=.26;

/** blocked(x,z,margin): true on a road, plaza, house plot, plaza feature or the memorial grounds (all in layout.circles
 *  and layout.roads). blocked.onRoad: roads only. */
export function makeBlocker(layout){
  const circles=layout?.circles||[],roads=(layout?.roads||[]).map(r=>{
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

/** Grid cells whose jittered point may fall in the chunk [x0,x0+size) x [z0,z0+size). */
function* cells(x0,z0,size,cell){
  for(let i=Math.floor(x0/cell);i<Math.ceil((x0+size)/cell);i++)for(let j=Math.floor(z0/cell);j<Math.ceil((z0+size)/cell);j++)yield [i,j];
}
const cellRnd=(kind,i,j)=>seeded(`${kind}:${i}:${j}`);

/**
 * Props for chunk (cx,cz). ctx = {size, height(x,z), water, blocked(x,z,margin), town(x,z) (inside a hamlet common),
 * river(x,z) ({edge,half}), plain}. Returns lists of {x,z,y,s,r,v,c}: position, scale, yaw, variant, tint.
 */
export function scatterChunk(cx,cz,ctx){
  const {size,height,water,blocked,town,river}=ctx,x0=cx*size,z0=cz*size,inside=(x,z)=>x>=x0&&x<x0+size&&z>=z0&&z<z0+size;
  const out={trees:[],bushes:[],rocks:[],reeds:[],flowers:[],...Object.fromEntries(DECOR.map(([k])=>[k,[]]))};
  const dryEnough=(y,m)=>y>water+m,wild=ctx.wild||(()=>1),C=ctx.clearing||{};
  // Trees: forest patches where the mask is high, rare singles elsewhere, sparse inside hamlet commons. Near the town
  // (wildness w -> 0) every chance falls to the meadow singles chance, so no patch forms there, and the singles are
  // orchard trees (oak, birch, blossom), never pines.
  for(const [i,j] of cells(x0,z0,size,ctx.treeCell)){
    const rnd=cellRnd('tree',i,j),x=(i+rnd())*ctx.treeCell,z=(j+rnd())*ctx.treeCell;if(!inside(x,z))continue;
    const forest=noise2(x*.016,z*.016,71)*.75+noise2(x*.05,z*.05,72)*.25,inTown=town(x,z),w=wild(x,z),single=C.meadow_tree_chance??.035;
    const chance=inTown?.03:single+((forest>.18?.9:forest>.02?.25:.035)-single)*w;if(rnd()>chance)continue;
    const y=height(x,z);if(!dryEnough(y,.85)||blocked(x,z,inTown?2.2:1.5))continue;
    const species=noise2(x*.008,z*.008,73),pick=rnd();
    const v=w<(C.orchard_below??0)?(pick<C.orchard_blossom?3:species<0?2:0):pick<.05?3:(species>.2||y>ctx.plain+1.5)?1:species<-.25?2:0;
    out.trees.push({x,z,y,s:.8+rnd()*.55,r:rnd()*Math.PI*2,v,c:rnd()});
    if(forest>.1&&rnd()<.35*w){const a=rnd()*6.28,bx=x+Math.cos(a)*1.8,bz=z+Math.sin(a)*1.8;if(inside(bx,bz)&&!blocked(bx,bz,1)&&dryEnough(height(bx,bz),.8))out.bushes.push({x:bx,z:bz,y:height(bx,bz),s:.7+rnd()*.5,r:rnd()*6.28,v:0,c:rnd()});}
  }
  // Bushes and rocks: scattered singles, more rocks near the water.
  for(const [i,j] of cells(x0,z0,size,7)){
    const rnd=cellRnd('prop',i,j),x=(i+rnd())*7,z=(j+rnd())*7;if(!inside(x,z))continue;
    const y=height(x,z),near=river(x,z).edge,roll=rnd();
    if(blocked(x,z,1))continue;
    if((near>.3&&near<5&&roll<.5)||roll<.06){if(y>water-.2)out.rocks.push({x,z,y,s:.45+rnd()*.7,r:rnd()*6.28,v:0,c:rnd()});}
    else if(roll<.2&&!town(x,z)&&dryEnough(y,.7))out.bushes.push({x,z,y,s:.7+rnd()*.6,r:rnd()*6.28,v:0,c:rnd()});
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
    const drift=noise2(x*.06,z*.06,74);if(drift<.25-(C.meadow_flowers??0)*(1-wild(x,z))||rnd()>.8)continue;
    const y=height(x,z),fs=.8+rnd()*.5;if(!dryEnough(y,.8)||blocked(x,z,FLOWER_RADIUS*fs))continue;
    out.flowers.push({x,z,y,s:fs,r:rnd()*6.28,v:noise2(x*.03,z*.03,75)>0?0:1,c:rnd()});
  }
  // Odds and ends of the wild (DECOR): rare by the town, a little commoner out in the forest; the taller ones only out there.
  for(const [kind,cell,near,far,minWild,foot] of DECOR)for(const [i,j] of cells(x0,z0,size,cell)){
    const rnd=cellRnd(kind,i,j),x=(i+rnd())*cell,z=(j+rnd())*cell;if(!inside(x,z))continue;
    const w=wild(x,z);if(w<minWild||rnd()>near+(far-near)*w)continue;
    const y=height(x,z),s=.8+rnd()*.4;if(!dryEnough(y,.8)||blocked(x,z,foot*s+.3))continue;
    out[kind].push({x,z,y,s,r:rnd()*6.28,v:0,c:rnd()});
  }
  // Stone outcrops: a few big half-sunk rocks on the crest of a knoll (lift: the knoll part of the ground, heldGround).
  const lift=ctx.lift||(()=>0),crest=(ctx.knolls?.[1]??Infinity)*.7;
  for(const [i,j] of cells(x0,z0,size,11)){
    const rnd=cellRnd('outcrop',i,j),x=(i+rnd())*11,z=(j+rnd())*11;if(!inside(x,z)||lift(x,z)<crest||rnd()>.45)continue;
    for(let k=0,n=2+Math.floor(rnd()*3);k<n;k++){
      const a=rnd()*6.28,d=k&&.9+rnd()*1.3,px=x+Math.cos(a)*d,pz=z+Math.sin(a)*d,s=(k?.9:1.6)+rnd()*.7;if(!inside(px,pz)||blocked(px,pz,s*.7))continue;
      out.rocks.push({x:px,z:pz,y:height(px,pz)-.22*s,s,r:rnd()*6.28,v:0,c:rnd()});
    }
  }
  return out;
}
/** [kind, grid cell (m), chance by the town (wildness 0), chance in full forest, least wildness, footprint radius (m)].
 *  Mushrooms and stumps stay under 0.4 m, so they may sit in the meadow by the town; logs, cairns and fence ends are
 *  taller (up to 0.8 m) and keep to the wilder ground, where no house or cat stands behind them. */
export const DECOR=[['mushrooms',8,.03,.16,0,.3],['stumps',12,.02,.18,.15,.45],['logs',15,0,.22,.45,1.1],['cairns',21,0,.2,.6,.45],['fences',27,0,.24,.5,1.1]];

/** Grass tufts for a chunk, in random order so taking a prefix thins evenly. */
export function grassChunk(cx,cz,count,ctx){
  const {size,height,water,blocked}=ctx,rnd=seeded(`grass:${cx}:${cz}`),out=[];
  for(let i=0;i<count;i++){
    const x=(cx+rnd())*size,z=(cz+rnd())*size,s=.7+rnd()*.55,r=rnd()*Math.PI*2,c=rnd();
    // The whole clump (not just its centre) stays off roads, commons, yards, plots and the memorial.
    const y=height(x,z);if(y<water+.55||blocked(x,z,TUFT_RADIUS*s))continue;
    out.push({x,z,y,s,r,v:0,c});
  }
  return out;
}

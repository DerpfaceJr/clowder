// Hamlet layout: one pure module for sites, plots, clearances and roads. The server places homes with it and the client draws
// and walks the roads it produces. No three.js import, so Node tests and the server can use it directly.
// Constants come from town.config.json world.layout. Lengths are multiplied by layout.scale; plot_area by scale squared (an area).

const TAU=Math.PI*2,GOLDEN_ANGLE=2.399963,PLOT_ANGLE=.6;
// Counts, angles, and ratios are not lengths, so they stay as configured.
const UNSCALED=new Set(['scale','plots','door_jitter','road_iterations','road_push_passes','gate_cap']);

import {seeded,terrain} from './terrain.js';
// The seeded PRNG lives with the terrain; re-exported because the server and looks import it from here.
export {seeded};
const jitter=(rnd,amount)=>(rnd()*2-1)*amount;
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

const scaled=new WeakMap();
/** Returns the layout with every length scaled. Pure: the same raw object always yields the same numbers. */
export function resolveLayout(raw){
  if(scaled.has(raw))return scaled.get(raw);
  const s=raw.scale;if(!(s>0))throw new Error('Set world.layout.scale to a positive number.');
  const L={};
  for(const [k,v] of Object.entries(raw)){
    if(Array.isArray(v))L[k]=v.map(n=>n*s);
    else if(typeof v!=='number'||UNSCALED.has(k))L[k]=v;
    else L[k]=v*s;
  }
  L.plot_area=raw.plot_area*s*s;
  // Distance from house centre to the hall hub: house_radius + road_clearance + stem_gap.
  L.stem=(raw.house_radius+raw.road_clearance+raw.stem_gap)*s;
  scaled.set(raw,L);return L;
}

// Site i >= 1 sits on ring k round the town centre: 6k evenly spaced sites at radius k x site_spacing, like homes round
// a plaza. A ring fills in opposite pairs, so a growing town stays balanced round the Mayor's circle.
function ringSlot(index){
  let k=1;while(3*k*(k+1)<index)k++;
  const t=index-(3*k*(k-1)+1);
  return {k,angle:TAU*((t>>1)+(t&1)*3*k)/(6*k)};
}

/** Site centre for index i. Site 0 is the town centre and has no jitter. */
export function siteCentre(index,L){
  if(index===0)return {index,x:0,z:0};
  const {k,angle}=ringSlot(index),rnd=seeded('site:'+index),r=k*L.site_spacing;
  return {index,x:r*Math.cos(angle)+jitter(rnd,L.site_jitter),z:r*Math.sin(angle)+jitter(rnd,L.site_jitter)};
}

/** Slots on the next ring out whose nearest slot on this ring is `index` (site 0 is the centre: its children are ring 1),
 *  kept to the ones a nook could take (siteFree against the centre alone). The tree a multi-level circular town grows on. */
export function childSlots(index,L){
  const k=index?ringSlot(index).k:0,first=3*(k+1)*k+1,count=6*(k+1),centre=siteCentre(0,L),out=[];
  const ringK=k?Array.from({length:6*k},(_,j)=>3*k*(k-1)+1+j):[0];
  for(let i=first;i<first+count;i++){
    const c=siteCentre(i,L);
    const parent=ringK.reduce((a,b)=>dist(siteCentre(b,L),c)<dist(siteCentre(a,L),c)?b:a);
    if(parent===index&&siteFree(c,[centre],L))out.push(c);
  }
  return out;
}

/** Dry ground by the Hamlet rule (terrain.js). Layouts without a terrain section are all dry. */
export const dryAt=(x,z,L)=>!L.terrain||terrain(L.terrain).dry(x,z);
/** A site is usable when its centre is dry and its whole common (every plot) stays clear of the rivers. */
export function siteDry(c,L){return dryAt(c.x,c.z,L)&&(!L.terrain||terrain(L.terrain).clearOfRiver(c.x,c.z,L.plot_radius+L.house_radius));}

/** How far a group's homes can reach from its site: its plot cap plus a house. Main (the Mayor's circle) has its own cap. */
export const groupReach=(groupId,L)=>(groupId==='main'?L.main_radius:L.plot_radius)+L.house_radius;
/** How much bigger a site's plaza is than a nook's: the Mayor's square (site 0) is main_plaza across, the rest plaza_radius.
 *  Its hall, first ring of plots, ring street and furniture all move out by this much. */
const grow=(site,L)=>site.index===0?L.main_plaza-L.plaza_radius:0;
export const plazaOf=(site,L)=>L.plaza_radius+grow(site,L);
/** A site's paved common with its ring street: what a neighbour must keep off. */
const commonOf=(site,L)=>ringRadius(L,site)+L.half_width_local;
/** A nook site keeps keep_apart from other nooks, keeps its common off the Mayor's circle and the memorial garden, and
 *  is dry. Nook homes fill the outward side; the inward side is the Mayor's (outOfPlace). Site 0 is always main. */
export function siteFree(c,sites,L){
  const memorial={x:L.memorial[0],z:L.memorial[1]},own=commonOf(c,L)+L.road_clearance*2;
  return sites.every(s=>dist(s,c)>=(s.index===0?groupReach('main',L)+own:L.keep_apart))&&dist(c,memorial)>=L.memorial_reserve+own&&siteDry(c,L);
}
/** Lowest-index free site: the ring of six around the town centre fills first, then the next ring out. */
export function planSite(sites,L){
  for(let i=1;i<10000;i++){const c=siteCentre(i,L);if(siteFree(c,sites,L))return c;}
  throw new Error('No free site for a new group.');
}

/**
 * Layout upgrades keep every cat in its group and re-seat the town under the current rules, in founding order. A group's
 * homes take their own plot's spot round its site (the hall at plot 0); a plot that no longer fits gives way to the
 * group's lowest free plot. Main keeps its site; each nook takes the lowest free site nearer the centre where all its homes
 * fit, else stays where it was if they still fit there. If any nook fits nowhere, every nook keeps its old site and homes.
 * Manual homes stay unless the Mayor's square has grown over them; then they move out to main's lowest free plot.
 * Returns {groups, homes} for a town.planned event.
 */
export function regather(cats,groups,raw){
  const L=resolveLayout(raw),main=groups.find(g=>g.id==='main');
  const onSquare=c=>main&&c.home.plot!==0&&dist(c.home,main.site)<plazaOf(main.site,L)+L.house_radius;
  const kept=cats.filter(c=>c.home?.manual&&!onSquare(c)).map(c=>({x:c.home.x,z:c.home.z,group:c.group,plot:c.home.plot}));
  // Seats the group's homes round `site`; returns [{id,home,group}] or null when one does not fit.
  function seat(g,site,settled,placed){
    const at={...g,site},groupsNow=[...placed.filter(p=>p.id!==g.id),at],taken=[...settled],out=[];
    const own=cats.filter(c=>c.group===g.id&&c.home&&(!c.home.manual||g.id==='main'&&onSquare(c))).sort((a,b)=>(a.home.plot??99)-(b.home.plot??99));
    const late=[];
    for(const cat of own){
      const k=cat.home.manual?undefined:cat.home.plot,spot=k===0?hallSpot(site,L):Number.isInteger(k)?plotSpot(site,k,g.id,L):null;
      const free=spot&&!taken.some(h=>h.group===g.id&&h.plot===k)&&!outOfPlace(spot,g.id,groupsNow,L)&&(k===0||!homeProblem(spot.x,spot.z,taken,groupsNow,L));
      if(!free){late.push(cat);continue;}
      out.push({id:cat.id,home:{...cat.home,x:spot.x,z:spot.z},group:g.id});taken.push({x:spot.x,z:spot.z,group:g.id,plot:k});
    }
    for(const cat of late){
      const spot=placeInGroup(at,taken,groupsNow,L);if(!spot)return null;
      out.push({id:cat.id,home:{...cat.home,x:spot.x,z:spot.z,plot:spot.plot},group:g.id});taken.push({x:spot.x,z:spot.z,group:g.id,plot:spot.plot});
    }
    return out;
  }
  const mainHomes=main?seat(main,main.site,kept,[main])||[]:[];
  const base=[...kept,...mainHomes.map(h=>({x:h.home.x,z:h.home.z,group:'main',plot:h.home.plot}))];
  const placed=main?[{...main}]:[],settled=[...base],nookHomes=[];
  for(const g of groups){
    if(g.id==='main')continue;
    const tryAt=c=>siteFree(c,placed.map(p=>p.site),L)?seat(g,c,settled,placed):null;
    let site=null,seated=null;
    for(let i=1;!seated;i++){const c=siteCentre(i,L);if(Math.hypot(c.x,c.z)>=Math.hypot(g.site.x,g.site.z))break;seated=tryAt(c);if(seated)site=c;}
    if(!seated){seated=tryAt(g.site);site=g.site;}
    if(!seated)return {groups,homes:mainHomes};
    for(const h of seated){nookHomes.push(h);settled.push({x:h.home.x,z:h.home.z,group:g.id,plot:h.home.plot});}
    placed.push({...g,site});
  }
  return {groups:placed,homes:[...mainHomes,...nookHomes]};
}

/** The hall: a nook's stands at the back edge of its plaza; the Mayor's house stands inside the big square, at its back. */
export const hallSpot=(site,L)=>({x:site.x,z:site.z-(site.index===0?plazaOf(site,L)-L.house_radius-L.road_clearance:L.hall_out)});

/** Plot k >= 1 on the sunflower spiral, or null past the configured count or radius. */
export function plotSpot(site,k,groupId,L){
  if(!Number.isInteger(k)||k<1||k>L.plots)return null;
  const r=Math.sqrt((L.first_ring+grow(site,L))**2+(k-1)*L.plot_area/TAU*2);if(r+L.house_radius>groupReach(groupId,L))return null;
  const theta=(k-1)*GOLDEN_ANGLE+PLOT_ANGLE,rnd=seeded(`plot:${groupId}:${k}`);
  return {x:site.x+r*Math.cos(theta)+jitter(rnd,L.plot_jitter),z:site.z+r*Math.sin(theta)+jitter(rnd,L.plot_jitter)};
}

/** Yaw that turns a house's front (local +z) to its door. Every house faces its plaza's centre; all but the hall with a
 *  small seeded turn, so a ring of houses does not look stamped. */
export function doorYaw(x,z,site,plot,groupId,L){
  const base=Math.atan2(site.x-x,site.z-z);
  if(plot===0)return base;
  return base+jitter(seeded(`door:${groupId}:${plot}`),L.door_jitter);
}
export const frontVector=yaw=>[Math.sin(yaw),Math.cos(yaw)];
export function doorPoint(home,yaw,L){const [dx,dz]=frontVector(yaw);return [home.x+dx*L.door_out,home.z+dz*L.door_out];}
export function stemPoint(home,yaw,L){const [dx,dz]=frontVector(yaw);return [home.x+dx*L.stem,home.z+dz*L.stem];}
/** Where a visiting cat stands: the house-local offset (1.3, 2.25) rotated with the house. */
export function standPoint(home,yaw,L){
  const ox=1.3*L.scale,oz=2.25*L.scale,c=Math.cos(yaw),s=Math.sin(yaw);
  return [home.x+ox*c+oz*s,home.z-ox*s+oz*c];
}

/** The memorial chapel on the reserved plot, facing the town centre. grounds: its hedge radius (vegetation, lamps and
 *  other roads keep off it); door and stem play the same part as a home's, so its road joins the network like a stem. */
export function memorialSpot(L){
  const x=L.memorial[0],z=L.memorial[1],yaw=Math.atan2(-x,-z),[dx,dz]=frontVector(yaw),out=L.memorial_grounds+L.road_clearance;
  return {x,z,yaw,reserve:L.memorial_reserve,grounds:L.memorial_grounds,door:[x+dx*L.memorial_door,z+dz*L.memorial_door],stem:[x+dx*out,z+dz*out]};
}

/** The notice board's size in metres (unscaled, like all plaza furniture): half its width and depth with the roof, its
 *  ridge and the middle of its face. world-art.js draws to it; town.js sizes the pick, the Archive shot and the label. */
export const BOARD={half:1.3,depth:.5,top:3.2,face:1.9};
/** A house's front-garden fence runs in house-local metres before scale (world-art.js draws it; walking routes keep off
 *  it), and the radius of the house itself, which stays inside its door and the cat's stand point. */
export const GARDEN_FENCE=[[[-2.45,.95],[-2.45,2.15],[-2.1,2.5],[-.85,2.55]],[[2.45,.95],[2.45,2.1]]],HOUSE_BODY=2;
/** The Mayor's square fountain: basin radius in metres (world-art.js draws to it). */
export const FOUNTAIN={r:2.4};
/** Circular plaza features: lamp, bench and notice board, and a fountain in the middle of the Mayor's square. Kept inside
 *  the plaza, so they are also obstacles. The board stands far enough in that its roof clears the ring street and the
 *  hall's walking links across the plaza, and its face (yaw, local +z) turns to the plaza's centre. */
export function plazaFeatures(site,L){
  const p=plazaOf(site,L),bx=p*.6,bz=-p*.2;
  const features=[{kind:'lamp',x:site.x+p*.62,z:site.z+p*.62},{kind:'bench',x:site.x-p*.62,z:site.z+p*.62},{kind:'board',x:site.x+bx,z:site.z+bz,yaw:Math.atan2(-bx,-bz)}];
  if(site.index===0)features.push({kind:'fountain',x:site.x,z:site.z});
  return features;
}

/** Distance from p to the nearest road edge (centreline distance minus half width); Infinity without roads. */
export function roadGap(p,roads){
  let best=Infinity;
  for(const r of roads||[])for(let i=1;i<r.points.length;i++){
    const a=r.points[i-1],b=r.points[i],dx=b[0]-a[0],dz=b[1]-a[1],d2=dx*dx+dz*dz,t=d2?Math.max(0,Math.min(1,((p.x-a[0])*dx+(p.z-a[1])*dz)/d2)):0;
    best=Math.min(best,Math.hypot(p.x-a[0]-dx*t,p.z-a[1]-dz*t)-r.width);
  }
  return best;
}
/** A spot is free when it is dry and clears every home, every plaza, the memorial reserve and every existing road
 *  (roads are laid in journal order and never move, so a new home must not land on one). */
export function plotFree(p,homes,groups,L,roads){
  if(!dryAt(p.x,p.z,L))return false;
  // A home keeps its house radius off every road edge, and at least road_clearance off a narrow street's centre too.
  if(roadGap(p,roads)<L.house_radius+Math.max(0,L.road_clearance-L.half_width_local))return false;
  if(homes.some(h=>dist(h,p)<2*L.house_radius))return false;
  if(groups.some(g=>dist(g.site,p)<plazaOf(g.site,L)+L.house_radius))return false;
  return dist({x:L.memorial[0],z:L.memorial[1]},p)>=L.memorial_reserve+L.house_radius;
}

/** A nook home inside the Mayor's circle (main's reach) is out of place: that ground is kept for main. */
const outOfPlace=(p,groupId,groups,L)=>{const main=groupId!=='main'&&groups.find(g=>g.id==='main');return !!main&&dist(main.site,p)<groupReach('main',L);};
/** Lowest free plot in a group, or null when it is full. `homes` = every cat with a home ({x,z,group,plot}).
 *  Plot 0 is the hall and is always offered to the group's first cat; it ignores the plaza rule because the hall sits by its plaza. */
export function placeInGroup(group,homes,groups,L,roads){
  const holders=new Set(homes.filter(h=>h.group===group.id&&h.plot!==undefined).map(h=>h.plot));
  if(!holders.has(0)){const hall=hallSpot(group.site,L);return {plot:0,x:hall.x,z:hall.z};}
  for(let k=1;k<=L.plots;k++){
    if(holders.has(k))continue;
    const p=plotSpot(group.site,k,group.id,L);
    if(p&&!outOfPlace(p,group.id,groups,L)&&plotFree(p,homes,groups,L,roads))return {plot:k,x:p.x,z:p.z};
  }
  return null;
}

/** Owner-move rules, also used by the client preview. Returns an error message, or null when the spot is valid. */
export function homeProblem(x,z,homes,groups,L){
  if(!Number.isFinite(x)||!Number.isFinite(z))return 'Choose a finite position.';
  if(Math.abs(x)>L.town_limit||Math.abs(z)>L.town_limit)return 'Homes must stay inside the town.';
  const p={x,z};
  if(dist(p,{x:L.memorial[0],z:L.memorial[1]})<L.memorial_reserve+L.house_radius)return 'The memorial garden is reserved.';
  if(groups.some(g=>dist(g.site,p)<plazaOf(g.site,L)+L.house_radius))return 'Homes cannot stand on a plaza.';
  if(homes.some(h=>dist(h,p)<2*L.house_radius))return 'Another home is too close.';
  if(!dryAt(x,z,L))return 'Homes need dry ground, away from the river.';
  return null;
}

// Road routing. Points are [x,z] pairs; the first and last point of every route are fixed.
function subdivide(waypoints,step){
  const out=[];
  for(let i=1;i<waypoints.length;i++){
    const a=waypoints[i-1],b=waypoints[i],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/step));
    for(let j=0;j<n;j++)out.push([a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n]);
  }
  out.push(waypoints.at(-1));return out;
}
// Moves each interior point to the nearest boundary point that lies outside every circle. Overlapping circles
// (neighbouring houses) make sequential pushes bounce back into each other, so candidates are checked against all.
// Exit candidates are radial projections onto each circle the point is inside, plus where those circles cross
// the others. The nearest point outside the whole union is always one of these.
function crossings(a,b){
  const dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz);
  if(d<1e-9||d>a.r+b.r||d<Math.abs(a.r-b.r))return [];
  const along=(a.r*a.r-b.r*b.r+d*d)/(2*d),h=Math.sqrt(Math.max(0,a.r*a.r-along*along));
  const mx=a.x+along*dx/d,mz=a.z+along*dz/d;
  return [[mx-h*dz/d,mz+h*dx/d],[mx+h*dz/d,mz-h*dx/d]];
}
function pushOut(pts,circles){
  for(let i=1;i<pts.length-1;i++){
    const p=pts[i],inside=circles.filter(c=>Math.hypot(p[0]-c.x,p[1]-c.z)<c.r);
    if(!inside.length)continue;
    const candidates=[];
    for(const c of inside){const dx=p[0]-c.x,dz=p[1]-c.z,d=Math.hypot(dx,dz);candidates.push(d<1e-9?[c.x+c.r,c.z]:[c.x+dx*c.r/d,c.z+dz*c.r/d]);}
    for(const c of inside)for(const o of circles)if(o!==c)candidates.push(...crossings(c,o));
    let best=null,bestD=Infinity;
    for(const q of candidates){
      if(circles.some(o=>Math.hypot(q[0]-o.x,q[1]-o.z)<o.r-1e-9))continue;
      const qd=Math.hypot(q[0]-p[0],q[1]-p[1]);if(qd<bestD){bestD=qd;best=q;}
    }
    pts[i]=best||candidates[0];
  }
}
function smooth(pts){
  const prev=pts.map(p=>p.slice());
  for(let i=1;i<pts.length-1;i++)pts[i]=[(prev[i-1][0]+prev[i+1][0])/2,(prev[i-1][1]+prev[i+1][1])/2];
}
function catmullRom(pts,sub){
  if(pts.length<3)return pts;
  const out=[];
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    for(let s=0;s<sub;s++){
      const t=s/sub;
      out.push([0,1].map(c=>.5*((2*p1[c])+(-p0[c]+p2[c])*t+(2*p0[c]-5*p1[c]+4*p2[c]-p3[c])*t*t+(-p0[c]+3*p1[c]-3*p2[c]+p3[c])*t*t*t)));
    }
  }
  out.push(pts.at(-1));return out;
}
/** Straight line through the waypoints, pushed around obstacles, smoothed, then Catmull-Rom curved. The clamp
 *  after Catmull-Rom keeps chords between rim points out of the circles. */
export function routeRoad(waypoints,all,L){
  // Only circles near the route can touch it: a box around the waypoints, padded by the widest circle and the bend room.
  const xs=waypoints.map(p=>p[0]),zs=waypoints.map(p=>p[1]),pad=Math.max(0,...all.map(c=>c.r))*2+4;
  const circles=all.filter(c=>c.x>Math.min(...xs)-pad&&c.x<Math.max(...xs)+pad&&c.z>Math.min(...zs)-pad&&c.z<Math.max(...zs)+pad);
  const pts=subdivide(waypoints,L.road_step);
  for(let it=0;it<L.road_iterations;it++){pushOut(pts,circles);smooth(pts);}
  for(let pass=0;pass<L.road_push_passes;pass++)pushOut(pts,circles);
  const curved=catmullRom(pts,4);pushOut(curved,circles);return curved;
}

/** A country lane: bows the road sideways in a seeded, gentle S (fading to nothing at both ends, so it meets each street square on; up to 14% of its length, capped at
 *  `max`). The bow shrinks until the whole lane clears the obstacles, so it never kinks round one. */
function meander(pts,seed,circles,max=7){
  const a=pts[0],b=pts.at(-1),len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(len<1e-6||pts.length<3)return pts;
  const rnd=seeded('lane:'+seed),nx=-(b[1]-a[1])/len,nz=(b[0]-a[0])/len,one=jitter(rnd,Math.min(.14*len,max)),two=jitter(rnd,Math.min(.06*len,max/2));
  let total=0;const at=[0];for(let i=1;i<pts.length;i++)at.push(total+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
  const clear=p=>circles.every(c=>Math.hypot(p[0]-c.x,p[1]-c.z)>=c.r);
  for(const f of [1,.75,.5,.25]){
    const out=pts.map((p,i)=>{if(i===0||i===pts.length-1)return p;const t=at[i]/total,o=f*Math.sin(Math.PI*t)*(one*Math.sin(Math.PI*t)+two*Math.sin(TAU*t));return [p[0]+nx*o,p[1]+nz*o];});
    if(out.every(clear))return out;
  }
  return pts;
}

// ---------------------------------------------------------------- natural walking routes
// A joined route (stand point, door, stem, streets, ...) has a corner wherever two pieces meet: T-junctions, doorsteps and
// plaza links. smoothPath rounds each corner with a circular fillet (a cubic that matches the route's direction at both
// ends of the bend), about CORNER metres in radius where the paving allows, and never moves the two end points.
const CORNER=1.4,MIN_TURN=.07,HOOK=1.75,BEND_STEP=.25,BEND_ANGLE=.14;
const toSegment=(p,a,b)=>{const dx=b[0]-a[0],dz=b[1]-a[1],d=dx*dx+dz*dz,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d)):0;return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dz*t);};
const turnAt=(p,i)=>{const a=Math.atan2(p[i][1]-p[i-1][1],p[i][0]-p[i-1][0]),b=Math.atan2(p[i+1][1]-p[i][1],p[i+1][0]-p[i][0]);return Math.atan2(Math.sin(b-a),Math.cos(b-a));};
/**
 * Rounds the corners of a walking route. points: [[x,z]...], first and last kept exactly.
 * room(p): how far (m) the route may leave its line at p and stay on the paving (a road's half width, more on a plaza).
 * obstacles: [{x,z,r}] the route must keep r off; a bend never comes nearer one than the route already did.
 * First a hook (the route doubling back over less than its own room, as where a stem overshoots onto the street it
 * joins) is cut; then every turn over MIN_TURN gets a fillet, sharpest first, each in its own stretch of route.
 */
export function smoothPath(points,room=()=>.5,obstacles=[]){
  const p=points.filter((q,i)=>!i||Math.hypot(q[0]-points[i-1][0],q[1]-points[i-1][1])>1e-6);
  // New points may not come nearer an obstacle than its clearance, or than the old points already came.
  const keeps=(fresh,old)=>obstacles.every(o=>{const was=Math.min(...old.map(q=>Math.hypot(q[0]-o.x,q[1]-o.z)));return was>o.r+8||fresh.every(q=>Math.hypot(q[0]-o.x,q[1]-o.z)>=Math.min(o.r,was)-1e-6);});
  const line=(a,b)=>{const n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/BEND_STEP));return Array.from({length:n+1},(_,j)=>[a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n]);};
  for(let i=1;i<p.length-1;i++)if(Math.abs(turnAt(p,i))>HOOK&&toSegment(p[i],p[i-1],p[i+1])<=room(p[i])+.25&&keeps(line(p[i-1],p[i+1]),[p[i-1],p[i],p[i+1]])){p.splice(i,1);i=Math.max(0,i-2);}
  if(p.length<3)return p;
  const s=[0];for(let i=1;i<p.length;i++)s.push(s[i-1]+Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]));
  const total=s.at(-1);
  // Point and unit direction at arc length d.
  const at=d=>{let lo=0,hi=p.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(s[m]<=d)lo=m;else hi=m;}
    const a=p[lo],b=p[hi],len=s[hi]-s[lo]||1,t=Math.max(0,Math.min(1,(d-s[lo])/len));return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,(b[0]-a[0])/len,(b[1]-a[1])/len];};
  const turnOver=(a,b)=>{const A=at(a),B=at(b);return Math.acos(Math.max(-1,Math.min(1,A[2]*B[2]+A[3]*B[3])));};
  // The stretch each corner wants: a fillet of radius r leaves both legs' lines by at most r(1-cos(t/2)) (at its
  // middle), so r keeps that within the room, measured just inside the corner (a street's corner into a plaza has the
  // paving to bend into). Corners close together turn as one, so the stretch is sized for the turn it spans.
  const spans=[];
  for(let i=1;i<p.length-1;i++){
    const t=Math.abs(turnAt(p,i));if(t<=MIN_TURN)continue;
    const d=s[i],ia=p[i-1],ib=p[i+1],ux=(p[i][0]-ia[0])/(s[i]-s[i-1]),uz=(p[i][1]-ia[1])/(s[i]-s[i-1]),vx=(ib[0]-p[i][0])/(s[i+1]-s[i]),vz=(ib[1]-p[i][1])/(s[i+1]-s[i]);
    const wx=vx-ux,wz=vz-uz,wl=Math.hypot(wx,wz)||1,space=room([p[i][0]+wx/wl*.6,p[i][1]+wz/wl*.6]);
    const reach=turn=>Math.min(CORNER,space/Math.max(1e-6,1-Math.cos(Math.min(turn,3)/2)))*Math.tan(Math.min(turn,3)/2);
    let h=Math.min(reach(t),d,total-d);
    for(let k=0;k<3;k++){const want=Math.min(reach(turnOver(d-h,d+h)),d,total-d);if(want<=h*1.05)break;h=want;}
    spans.push({a:d-h,b:d+h,d,t});
  }
  // Overlapping stretches become one bend.
  const merged=[];for(const w of spans){const last=merged.at(-1);if(last&&w.a<last.b){last.b=Math.max(last.b,w.b);last.parts.push(w);}else merged.push({a:w.a,b:w.b,parts:[w]});}
  // One bend: a cubic from the route's point and direction at a to those at b, its handles from where the two
  // tangent lines meet, so a bend over corners of unequal legs stays round. Null when it would near an obstacle.
  const bend=(a,b)=>{
    const A=at(a),B=at(b),phi=turnOver(a,b),h=(b-a)/2,n=Math.max(2,Math.ceil(2*h/BEND_STEP),Math.ceil(phi/BEND_ANGLE));
    const den=A[2]*B[3]-A[3]*B[2],tA=den?((B[0]-A[0])*B[3]-(B[1]-A[1])*B[2])/den:-1,tB=den?((B[1]-A[1])*A[2]-(B[0]-A[0])*A[3])/den:-1;
    // Without a sensible meeting point, the handles of a circular arc on the chord from a to b.
    const k43=phi<1e-3?2/3:4/3*Math.tan(phi/4)/Math.tan(phi/2),chord=Math.hypot(B[0]-A[0],B[1]-A[1]),arc=phi<1e-3?chord/3:4/3*Math.tan(phi/4)*chord/(2*Math.sin(phi/2));
    const [hA,hB]=tA>h/3&&tB>h/3&&tA<3*h&&tB<3*h?[tA*k43,tB*k43]:[arc,arc];
    const c=[A[0]+A[2]*hA,A[1]+A[3]*hA],e=[B[0]-B[2]*hB,B[1]-B[3]*hB],curve=[];
    for(let j=0;j<=n;j++){const u=j/n,v=1-u;curve.push([v*v*v*A[0]+3*v*v*u*c[0]+3*v*u*u*e[0]+u*u*u*B[0],v*v*v*A[1]+3*v*v*u*c[1]+3*v*u*u*e[1]+u*u*u*B[1]]);}
    return keeps(curve,[A,B,...p.filter((q,j)=>s[j]>a&&s[j]<b)])?curve:null;
  };
  // A bend that would near an obstacle splits into its corners' own bends, each tightening about its corner up to
  // three times, else that corner stays as it is.
  const windows=[];
  for(const w of merged){
    const whole=bend(w.a,w.b);if(whole){windows.push({a:w.a,b:w.b,curve:whole});continue;}
    let floor=w.a;
    for(const [j,c] of w.parts.entries()){
      const ceil=j+1<w.parts.length?Math.min(w.b,(c.d+w.parts[j+1].d)/2):w.b;
      for(let f=1,k=0;k<4;k++,f/=2){
        const a=Math.max(floor,c.d-(c.d-c.a)*f),b=Math.min(ceil,c.d+(c.b-c.d)*f);if(b-a<.08)break;
        const curve=bend(a,b);if(curve){windows.push({a,b,curve});floor=b;break;}
      }
    }
  }
  const out=[p[0]];let w=0;
  for(let i=1;i<p.length;i++){
    while(w<windows.length&&windows[w].b<=s[i]+1e-9){const win=windows[w++];for(const q of win.curve)out.push(q);}
    if(!windows.some(win=>s[i]>win.a-1e-9&&s[i]<win.b+1e-9))out.push(p[i]);
  }
  while(w<windows.length)for(const q of windows[w++].curve)out.push(q);
  out[out.length-1]=p.at(-1);
  return out.filter((q,i)=>!i||Math.hypot(q[0]-out[i-1][0],q[1]-out[i-1][1])>1e-6);
}

/** A plaza crossing: from ring end a round the hall's side of the centre to ring end b, on an arc of radius rc about
 *  the site (between the fountain's rim and the plaza edge), meeting the ring along its own direction at both ends.
 *  A hall link is the same curve from the hall's door (which faces the centre) out to one ring end. */
const ease=u=>{const v=Math.max(0,Math.min(1,u));return v*v*(3-2*v);};
function plazaArc(site,from,to,rc,{door=false,spread=.3}={}){
  const pol=q=>[Math.hypot(q[0]-site.x,q[1]-site.z),Math.atan2(q[1]-site.z,q[0]-site.x)];
  const [r0,t0]=pol(from),[r1,t1]=pol(to),span=Math.atan2(Math.sin(t1-t0),Math.cos(t1-t0));
  // A door link spans half a crossing, so its outer blend takes twice the share to match the crossing's shape.
  const out=door?spread*2:spread,n=Math.max(8,Math.ceil(Math.abs(span)*Math.max(r0,r1)/.4)),pts=[];
  for(let j=0;j<=n;j++){
    const u=j/n,r=rc+(r0-rc)*(door?Math.max(0,1-u/spread)**2:ease(1-u/spread))+(r1-rc)*ease(1-(1-u)/out),a=t0+span*u;
    pts.push(j===0?from:j===n?to:[site.x+r*Math.cos(a),site.z+r*Math.sin(a)]);
  }
  return pts;
}
/** Radius of a plaza's crossing arc: halfway between the hall's door and the fountain's rim (or, on a nook's plaza
 *  without one, 30% of the plaza out from its middle). */
const crossRadius=(site,door,L)=>(Math.hypot(door[0]-site.x,door[1]-site.z)+(site.index===0?FOUNTAIN.r+1.2:plazaOf(site,L)*.3))/2;

const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
function joinPaths(...parts){
  const out=[];for(const part of parts)for(const p of part){if(!out.length||!same(out.at(-1),p))out.push(p);}
  return out;
}

// ---------------------------------------------------------------- road network
// Roads form one graph per town: a ring street around every plaza (open where the hall stands), short door stems that
// join the NEAREST existing street with a T-junction, and one road per hamlet that joins the nearest existing road of
// the town centre. Homes are added in journal order (cats order), and each only adds its own stem and splits the street
// it joins, so adding a home never moves an existing road.
const keyOf=p=>p[0].toFixed(3)+','+p[1].toFixed(3);
/** Ring street radius: just outside the paved plaza, inside the first ring of plots. */
export const ringRadius=(L,site={})=>plazaOf(site,L)+L.road_clearance*.6;

function nearestOn(edges,p,clear=0){
  let best=null;
  // A stem's first segment (door to street) never takes a junction: roads meet streets, not doorsteps. A lane also keeps
  // `clear` metres from any door, where a stem still hooks round its garden.
  for(const e of edges)for(let i=e.door?2:1;i<e.points.length;i++){
    const a=e.points[i-1],b=e.points[i],dx=b[0]-a[0],dz=b[1]-a[1],d2=dx*dx+dz*dz;
    if(e.door&&clear&&Math.hypot(a[0]-e.points[0][0],a[1]-e.points[0][1])<clear)continue;
    const t=d2?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d2)):0,q=[a[0]+dx*t,a[1]+dz*t],d=Math.hypot(p[0]-q[0],p[1]-q[1]);
    if(!best||d<best.d)best={e,i,q,d};
  }
  return best;
}
/** Splits edge e at point q on its segment i (snapping to a vertex within `snap`). Returns the junction point. */
function splitAt(edges,hit,snap){
  const {e,i}=hit;let q=hit.q,cut;
  const prev=e.points[i-1],next=e.points[i];
  if(Math.hypot(q[0]-prev[0],q[1]-prev[1])<snap){q=prev;cut=i-1;}else if(Math.hypot(q[0]-next[0],q[1]-next[1])<snap){q=next;cut=i;}
  if(cut===0||cut===e.points.length-1)return q;// an existing end: nothing to split
  const first=cut===undefined?[...e.points.slice(0,i),q]:e.points.slice(0,cut+1),second=cut===undefined?[q,...e.points.slice(i)]:e.points.slice(cut);
  edges.splice(edges.indexOf(e),1,{...e,points:first},{...e,points:second,door:false});
  return q;
}
/** The open ring around a plaza: arc points outside the hall clearance, pushed off every potential plot of the group. */
function ringStreet(g,L,plotCircles){
  const R=ringRadius(L,g.site),hall=hallSpot(g.site,L),hallR=L.house_radius+L.road_clearance,n=Math.max(24,Math.ceil(TAU*R/L.road_step));
  const pts=[];let start=0;
  const inside=a=>Math.hypot(g.site.x+Math.cos(a)*R-hall.x,g.site.z+Math.sin(a)*R-hall.z)<hallR;
  for(let i=0;i<n;i++)if(inside(i/n*TAU)&&!inside((i+1)/n*TAU)){start=i+1;break;}
  for(let k=0;k<=n;k++){const a=(start+k)/n*TAU;if(inside(a))break;pts.push([g.site.x+Math.cos(a)*R,g.site.z+Math.sin(a)*R]);}
  pushOut(pts,plotCircles);return pts;
}

/**
 * The whole town's physical geometry: plazas, houses, the road network and walking paths. Built from cats (with homes,
 * in journal order) and groups. Placement rules live above; this only shapes what is drawn and walked.
 */
export function townLayout(cats,groups,raw){
  const L=resolveLayout(raw),homes=cats.filter(c=>c.home&&c.group);
  const byGroup=new Map(groups.map(g=>[g.id,g])),main=groups.find(g=>g.id==='main')||groups[0];
  const yaw=new Map(homes.map(c=>[c.id,byGroup.get(c.group)?doorYaw(c.home.x,c.home.z,byGroup.get(c.group).site,c.home.plot,c.group,L):0]));
  const common=ringRadius(L)+L.half_width_local,ringOf=g=>ringRadius(L,g.site),commonAt=g=>commonOf(g.site,L);
  // circles: what vegetation and lamps keep off (houses, paved commons). route: what roads bend around.
  // obstacles grow in journal order, so a road only bends around homes and plazas that existed when it was laid.
  const memorial=memorialSpot(L),circles=[{x:memorial.x,z:memorial.z,r:memorial.grounds}],obstacles=[{x:memorial.x,z:memorial.z,r:memorial.grounds}];
  for(const c of homes)circles.push({x:c.home.x,z:c.home.z,r:L.house_radius+L.road_clearance});
  for(const g of groups)circles.push({x:g.site.x,z:g.site.z,r:commonAt(g)+L.road_clearance});
  const edges=[],door=new Map(),snap=L.half_width_local*1.6,opened=new Set(),streets=()=>edges.filter(e=>e.kind!=='plaza'&&!e.pending);
  // A group opens when its first home appears in journal order: its ring street, then (for a nook) one lane from its ring
  // to its parent's ring: the nearest open group nearer the centre (main for the first ring). Lanes form a tree that
  // stems from the Mayor's circle, like a multi-level circular diagram.
  function open(g){
    opened.add(g.id);obstacles.push({x:g.site.x,z:g.site.z,r:ringOf(g)-.25});
    const plots=[];for(let k=1;k<=L.plots;k++){const p=plotSpot(g.site,k,g.id,L);if(p)plots.push({x:p.x,z:p.z,r:L.house_radius+L.road_clearance});}
    const others=streets(),ring={kind:'ring',group:g.id,points:ringStreet(g,L,plots),width:L.half_width_local};edges.push(ring);
    if(g===main||!others.length){laySpokes(g);return;}
    const out=Math.hypot(g.site.x-main.site.x,g.site.z-main.site.z),parent=groups.filter(p=>p!==g&&opened.has(p.id)&&Math.hypot(p.site.x-main.site.x,p.site.z-main.site.z)<out-1e-6)
      .reduce((a,b)=>!a||dist(b.site,g.site)<dist(a.site,g.site)?b:a,null);
    const parentRing=parent?others.filter(e=>e.group===parent.id&&!e.memorial):[];
    const gate=splitAt(edges,nearestOn([ring],[(parent||main).site.x,(parent||main).site.z]),snap);
    const avenue=spokeTo(g),hit=nearestOn(avenue||(parentRing.length?parentRing:others),gate);if(!hit)return;
    const q=splitAt(edges,hit,snap),points=meander(routeRoad([gate,q],obstacles,L),g.id,obstacles);
    // Onto its avenue the lane is the avenue's last stretch, paved the same; without one it is an earth road.
    edges.push(avenue?{kind:'local',group:g.id,points,width:L.half_width_local}:{kind:'between',group:g.id,points,width:L.half_width_between});
    laySpokes(g);
  }
  // The spoke that was laid toward this nook's slot (its avenue out of the parent square), or null.
  function spokeTo(g){const s=streets().filter(e=>e.spoke===g.site.index);return s.length?s:null;}
  // Spokes: when a square opens, a paved avenue leaves its ring toward each child slot (childSlots), out to the edge of its
  // homes, before those homes are placed. Homes and stems then form round the avenues, and a nook founded on that slot
  // only lays a lane from its gate to the avenue's end.
  function laySpokes(g){
    const ring=edges.find(e=>e.kind==='ring'&&e.group===g.id);if(!ring)return;
    for(const c of childSlots(g.site.index||0,L)){
      const dx=c.x-g.site.x,dz=c.z-g.site.z,d=Math.hypot(dx,dz),reach=groupReach(g.id,L)-L.house_radius*.5;
      const end=[g.site.x+dx/d*reach,g.site.z+dz/d*reach],hit=nearestOn(edges.filter(e=>e.kind==='ring'&&e.group===g.id),end);if(!hit)continue;
      // An avenue to a slot no nook has taken is reserved: homes keep off it, but it is not drawn or walked yet.
      const q=splitAt(edges,hit,snap),pending=!groups.some(o=>o!==g&&o.site.index===c.index);
      edges.push({kind:'local',group:g.id,spoke:c.index,pending,points:meander(routeRoad([q,end],obstacles,L),'spoke:'+c.index,obstacles,2.5),width:L.half_width_local});
    }
  }
  // The memorial's stem is laid right after main's first home (its hall), so it is fixed in journal order like any stem:
  // later homes are placed clear of it (plotFree) and later roads join it or bend around the grounds.
  // Towns older than the chapel already have homes in its way: it also bends around every home, keeping its edge off the
  // house art (house_radius). plotFree keeps new homes exactly that far off, so a new town's road is the same either way.
  let memorialRoad=null;
  const settled=homes.map(c=>({x:c.home.x,z:c.home.z,r:L.house_radius+L.half_width_local-1e-6}));
  function layMemorial(){
    const hit=nearestOn(streets(),memorial.stem);if(!hit)return;
    const q=splitAt(edges,hit,snap),pts=hit.d<snap?[memorial.stem,q]:routeRoad([memorial.stem,q],[...obstacles,...settled],L);
    memorialRoad={kind:'local',group:main.id,memorial:true,door:true,points:[memorial.door,...pts],width:L.half_width_local};edges.push(memorialRoad);
  }
  const memorialDue=()=>!memorialRoad&&main&&opened.has(main.id);
  for(const c of homes){
    if(memorialDue())layMemorial();
    const g=byGroup.get(c.group);if(!g)continue;
    if(!opened.has(g.id))open(g);
    obstacles.push({x:c.home.x,z:c.home.z,r:L.house_radius+L.road_clearance});
    const y=yaw.get(c.id),d=doorPoint(c.home,y,L);door.set(c.id,d);
    if(c.home.plot===0){
      // The hall opens straight onto its plaza: walking links (not drawn) from its door to both ends of the ring.
      const rings=()=>edges.filter(e=>e.kind==='ring'&&e.group===g.id),ring=rings();let ends=[ring[0].points[0],ring.at(-1).points.at(-1)];
      // A hall inside its square (the Mayor's) closes the ring: its links reach the ring either side of its front.
      if(Math.hypot(ends[0][0]-ends[1][0],ends[0][1]-ends[1][1])<1e-6){
        const a=Math.atan2(c.home.z-g.site.z,c.home.x-g.site.x),R=ringOf(g);
        ends=[a+1.22,a-1.22].map(t=>splitAt(edges,nearestOn(rings(),[g.site.x+Math.cos(t)*R,g.site.z+Math.sin(t)*R]),snap));
      }
      // Each link curves from the door round the near side of the centre to its ring end; a third link joins the two
      // ends on that same arc, so a cat crossing the plaza passes between the fountain and the hall, not over the doorstep.
      const rc=crossRadius(g.site,d,L);
      for(const end of ends)edges.push({kind:'plaza',group:g.id,cat:c.id,points:plazaArc(g.site,d,end,rc,{door:true}),width:0});
      edges.push({kind:'plaza',group:g.id,points:plazaArc(g.site,ends[0],ends[1],rc),width:0});
      continue;
    }
    // A stem: from the door, out past the garden, to the nearest point of any street (T-junction).
    const s=stemPoint(c.home,y,L),hit=nearestOn(streets(),s);if(!hit)continue;
    const q=splitAt(edges,hit,snap),pts=hit.d<snap?[s,q]:routeRoad([s,q],obstacles,L);
    edges.push({kind:'local',group:g.id,cat:c.id,door:true,points:[d,...pts],width:L.half_width_local});
  }
  if(memorialDue())layMemorial();
  // Legacy towns placed homes before roads avoided them: a road that runs under a house (inside its art radius) is
  // re-laid around every home, keeping its ends. Towns placed by the current rules never trigger this.
  const allHomes=[...homes.map(c=>({x:c.home.x,z:c.home.z,r:L.house_radius+L.road_clearance})),...groups.map(g=>({x:g.site.x,z:g.site.z,r:ringOf(g)-.25}))];
  for(const e of edges){
    if(e.kind!=='local'&&e.kind!=='between')continue;
    const from=e.door?1:0,inner=e.points.slice(from+1,-1);
    if(!inner.some(p=>homes.some(c=>Math.hypot(p[0]-c.home.x,p[1]-c.home.z)<L.house_radius)))continue;
    e.points=[...e.points.slice(0,from),...routeRoad([e.points[from],e.points.at(-1)],allHomes,L)];
  }
  // Walking graph over every edge, nodes at edge ends.
  const graph=new Map(),link=(a,b,e,forward)=>{if(!graph.has(a))graph.set(a,[]);graph.get(a).push({to:b,e,forward});};
  const lengthOf=pts=>pts.slice(1).reduce((s,p,i)=>s+Math.hypot(p[0]-pts[i][0],p[1]-pts[i][1]),0);
  // A hall's door links cost 2 m extra, so a route passes a hall's doorstep only to visit it: crossings take the arc.
  for(const e of edges.filter(e=>!e.pending)){e.length=lengthOf(e.points)+(e.kind==='plaza'&&e.cat?2:0);const a=keyOf(e.points[0]),b=keyOf(e.points.at(-1));link(a,b,e,true);link(b,a,e,false);}
  function route(from,to){
    const dist=new Map([[from,0]]),prev=new Map(),open=new Set([from]);
    while(open.size){
      let u=null;for(const k of open)if(u===null||dist.get(k)<dist.get(u))u=k;open.delete(u);if(u===to)break;
      for(const {to:v,e,forward} of graph.get(u)||[]){const nd=dist.get(u)+e.length;if(nd<(dist.get(v)??Infinity)){dist.set(v,nd);prev.set(v,{u,e,forward});open.add(v);}}
    }
    if(!prev.has(to)&&from!==to)return null;
    const parts=[];for(let k=to;k!==from;){const p=prev.get(k);parts.unshift(p.forward?p.e.points:p.e.points.slice().reverse());k=p.u;}
    return parts;
  }
  /** The route as the road graph has it: stand point, door, road pieces, door, stand point, corners and all. */
  function roadPath(a,b){
    const da=door.get(a.id),db=door.get(b.id),sa=standPoint(a.home,yaw.get(a.id)||0,L),sb=standPoint(b.home,yaw.get(b.id)||0,L);
    const parts=da&&db&&route(keyOf(da),keyOf(db));
    return parts?joinPaths([sa,da],...parts,[db,sb]):[sa,sb];
  }
  // What a smoothed route keeps off: every other home, the fountain and the notice boards' corners. Its room: a road's
  // half width, more on a plaza or a hall's yard.
  const features=groups.flatMap(g=>plazaFeatures(g.site,L).flatMap(f=>f.kind==='fountain'?[{x:f.x,z:f.z,r:FOUNTAIN.r+.45}]:f.kind==='board'?[-1,0,1].flatMap(i=>[-1,1].map(j=>({x:f.x+i*BOARD.half*Math.cos(f.yaw)+j*BOARD.depth*Math.sin(f.yaw),z:f.z-i*BOARD.half*Math.sin(f.yaw)+j*BOARD.depth*Math.cos(f.yaw),r:.65}))):[]));
  const hallYards=groups.map(g=>({...hallSpot(g.site,L),r:L.house_radius+L.road_clearance}));
  const paving=(p,inset=0)=>groups.some(g=>Math.hypot(p[0]-g.site.x,p[1]-g.site.z)<commonAt(g)-inset)||hallYards.some(y=>Math.hypot(p[0]-y.x,p[1]-y.z)<y.r-inset);
  const room=p=>paving(p,.3)?2.5:.5;
  // A route's own two homes: their house and the posts of their garden fence, every 0.3 m (the doorstep is theirs).
  const ownHome=c=>{
    const y=yaw.get(c.id)||0,cs=Math.cos(y),sn=Math.sin(y),local=(x,z)=>({x:c.home.x+(x*cs+z*sn)*L.scale,z:c.home.z+(-x*sn+z*cs)*L.scale,r:.3});
    const posts=GARDEN_FENCE.flatMap(run=>run.slice(1).flatMap((b,i)=>{const a=run[i],n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.3);return Array.from({length:n+1},(_,j)=>local(a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n));}));
    return [{x:c.home.x,z:c.home.z,r:HOUSE_BODY*L.scale},...posts];
  };
  const keepOff=(...ends)=>[...features,...homes.flatMap(c=>ends.includes(c.id)?ownHome(c):[{x:c.home.x,z:c.home.z,r:L.house_radius+L.road_clearance}])];
  /** Walking path from one cat's stand point to another's, along the physical roads, with every corner rounded. */
  const visitPath=(a,b)=>a.id===b.id?roadPath(a,b):smoothPath(roadPath(a,b),room,keepOff(a.id,b.id));
  const roads=edges.filter(e=>e.kind!=='plaza'&&!e.pending),reserved=edges.filter(e=>e.pending);
  // Junctions: every point where road ends meet (T-junctions and split streets). Drawn as paved caps over the seams.
  const degree=new Map();for(const e of roads)for(const p of [e.points[0],e.points.at(-1)]){const k=keyOf(p);if(!degree.has(k))degree.set(k,{p,n:0,w:0,kinds:new Set()});const j=degree.get(k);j.n++;j.w=Math.max(j.w,e.width);j.kinds.add(e.kind);}
  const junctions=[...degree.values()].filter(j=>j.n>=2).map(j=>({x:j.p[0],z:j.p[1],r:j.w*1.15,kinds:[...j.kinds]}));
  // Lamp posts: one per lamp_spacing along every road, alternating sides, plus one beside each door. A lamp never
  // stands within a house radius of a house or on a paved common.
  const lamps=[],at=p=>({x:p[0],z:p[1]});
  const lampAt=p=>{if(dist(memorial,at(p))>=memorial.grounds&&homes.every(c=>dist(c.home,at(p))>=L.house_radius)&&groups.every(g=>dist(g.site,at(p))>=plazaOf(g.site,L)+L.road_clearance))lamps.push({x:p[0],z:p[1]});};
  for(const road of roads){
    // Arc length runs across the road's segments, so lamps sit at fixed spacing along the whole polyline.
    let next=L.lamp_spacing/2,travelled=0,side=1;
    for(let i=1;i<road.points.length;i++){
      const a=road.points[i-1],b=road.points[i],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!len)continue;
      const nx=-(b[1]-a[1])/len,nz=(b[0]-a[0])/len,offset=road.width/2+L.road_clearance*.5;
      for(;next<=travelled+len;next+=L.lamp_spacing){
        const t=(next-travelled)/len,px=a[0]+(b[0]-a[0])*t,pz=a[1]+(b[1]-a[1])*t;
        lampAt([px+nx*side*offset,pz+nz*side*offset]);side=-side;
      }
      travelled+=len;
    }
  }
  for(const c of homes){const d=door.get(c.id);if(!d)continue;const y=yaw.get(c.id);lampAt([d[0]+Math.cos(y)*1.2,d[1]-Math.sin(y)*1.2]);}
  // Hall yards are paved discs around each hall, reaching just past the hall footprint.
  const yards=groups.map(g=>({...hallSpot(g.site,L),r:L.house_radius+L.road_clearance}));
  return {L,yaw,roads,reserved,junctions,visitPath,roadPath,circles,
    /** On the paving: a plaza's common, a hall's yard, or within a road's half width of its line. */
    paved:(x,z)=>paving([x,z])||roadGap({x,z},roads)<=0,lamps,yards,common,sites:groups.map(g=>({...g.site,group:g.id,plaza:plazaOf(g.site,L),common:commonAt(g),features:plazaFeatures(g.site,L)})),memorial,
    /** Walking route from a cat's door to the memorial door along the roads, or null when there is none. */
    memorialPath:c=>{const parts=memorialRoad&&door.has(c.id)&&route(keyOf(door.get(c.id)),keyOf(memorial.door));return parts?smoothPath(joinPaths(...parts),room,keepOff(c.id)):null;},
    frontOf:id=>yaw.get(id)};
}

/** A cat's house yaw from its group and plot, exactly as townLayout computes it. */
export function homeYaw(cat,groups,raw){
  const group=groups.find(g=>g.id===cat.group);if(!group||!cat.home)return 0;
  return doorYaw(cat.home.x,cat.home.z,group.site,cat.home.plot,group.id,resolveLayout(raw));
}

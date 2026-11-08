// Terrain: one pure, seeded height field. The server uses it for plot dryness; the client draws the ground, rivers,
// roads and props from it. No three.js import. Integer-hash value noise (Math.imul), so Node and browsers agree exactly.
// Parameters live in town.config.json world.layout.terrain (metres, unscaled). After voxell-tech/hamlet land.rs.

/** FNV-1a text hash feeding mulberry32. Seeds terrain, sites, plots, doors and cat looks. */
export function seeded(text){
  let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return ()=>{h=(h+0x6D2B79F5)|0;let t=h;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
const seedInt=text=>Math.floor(seeded(text)()*4294967296)|0;
function hash2(ix,iz,s){
  let h=Math.imul(ix,0x27d4eb2d)^Math.imul(iz,0x165667b1)^s;
  h=Math.imul(h^(h>>>15),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);return ((h^(h>>>16))>>>0)/4294967296;
}
const fade=t=>t*t*t*(t*(t*6-15)+10);
/** Smooth value noise in [-1,1]. */
export function noise2(x,z,s){
  const ix=Math.floor(x),iz=Math.floor(z),u=fade(x-ix),v=fade(z-iz);
  const a=hash2(ix,iz,s),b=hash2(ix+1,iz,s),c=hash2(ix,iz+1,s),d=hash2(ix+1,iz+1,s);
  return (a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v)*2-1;
}
const noise1=(x,s)=>{const i=Math.floor(x),u=fade(x-i),a=hash2(i,0,s),b=hash2(i+1,0,s);return (a+(b-a)*u)*2-1;};
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const smax=(a,b,k)=>(a+b+Math.sqrt((a-b)*(a-b)+k))/2;

const built=new WeakMap();
/**
 * The terrain for a parameter object (memoised per object). raw(x,z) is the natural height: noise hills, a floor above
 * the water, and river valleys carved in. Rivers are long meandering lines kept at least river_clear from the town centre.
 */
export function terrain(P){
  if(built.has(P))return built.get(P);
  const s=seedInt(P.seed+':land'),g=seedInt(P.seed+':grain'),W=P.water_y;
  const rivers=[],heading=seeded(P.seed+':rivers')()*Math.PI;
  for(let i=0;i<P.rivers;i++){
    // Rivers run roughly side by side on opposite sides of the centre, so any confluence lies far out of town.
    const rnd=seeded(`${P.seed}:river:${i}`),angle=heading+(rnd()-.5)*.7,side=i%2?-1:1;
    const swing=P.bends[1]+P.kinks[1];
    rivers.push({dx:Math.cos(angle),dz:Math.sin(angle),offset:side*(P.river_clear+swing+P.river_half_width+rnd()*P.river_spread),b:seedInt(`${P.seed}:bend:${i}`),k:seedInt(`${P.seed}:kink:${i}`),w:seedInt(`${P.seed}:width:${i}`)});
  }
  const centre=(r,u)=>r.offset+P.bends[1]*noise1(u*P.bends[0],r.b)+P.kinks[1]*noise1(u*P.kinks[0],r.k);
  /** Distance past the nearest river's water edge (negative inside the water) and that river's half width. The last answer
   *  is kept: raw() and knoll() ask for the same point in a row. */
  let lastX=NaN,lastZ=NaN,last=null;
  function river(x,z){
    if(x===lastX&&z===lastZ)return last;lastX=x;lastZ=z;
    let best=Infinity,half=P.river_half_width;
    for(const r of rivers){
      const u=x*r.dx+z*r.dz,v=-x*r.dz+z*r.dx,slope=(centre(r,u+1)-centre(r,u-1))/2;
      const w=P.river_half_width*(1+.25*noise1(u*.02,r.w)),d=Math.abs(v-centre(r,u))/Math.sqrt(1+slope*slope);
      if(d-w<best){best=d-w;half=w;}
    }
    return last={edge:best,half};
  }
  function raw(x,z){
    const f=P.hills[0];
    let h=P.plain_y+P.hills[1]*(noise2(x*f,z*f,s)*.7+noise2(x*f*2.1,z*f*2.1,s+1)*.3)+P.grain[1]*noise2(x*P.grain[0],z*P.grain[0],g);
    h=smax(h,W+P.floor,.6);
    if(!rivers.length)return h;
    const {edge,half}=river(x,z),d=edge+half;
    const land=W+P.bank_y+(h-W-P.bank_y)*smooth(half+1,half+P.valley,d);
    return W-P.bed+(land-W+P.bed)*smooth(half*.5,half+2,d);
  }
  /** Hamlet rule: dry when the land stands dry_margin above the water at the centre and dry_probe metres around it. */
  const dry=(x,z)=>[[0,0],[P.dry_probe,0],[-P.dry_probe,0],[0,P.dry_probe],[0,-P.dry_probe]].every(([dx,dz])=>raw(x+dx,z+dz)>W+P.dry_margin);
  /** True when every river's water edge is at least `radius` + the valley bank away. */
  const clearOfRiver=(x,z,radius)=>!rivers.length||river(x,z).edge>=radius+P.bank;
  /** Knolls: soft, never-negative rises (knolls = [frequency, metres]) on top of raw, gone across each river valley and
   *  its first `valley` metres of meadow. Not in raw: dryness, site levels and the server never see them (heldGround adds them). */
  const K=P.knolls,ks=seedInt(P.seed+':knolls');
  const knoll=(x,z)=>{
    if(!K)return 0;
    const n=noise2(x*K[0],z*K[0],ks)*.7+noise2(x*K[0]*2.3,z*K[0]*2.3,ks+1)*.3,rise=smooth(.05,.8,n);
    return rise&&K[1]*rise*(rivers.length?smooth(P.valley,P.valley*1.7,river(x,z).edge):1);
  };
  const t={P,water:W,raw,river,dry,clearOfRiver,rivers,knoll};
  built.set(P,t);return t;
}

/**
 * Held ground: holds are flat discs {x,z,r,ease,y}. Inside r the ground is exactly y; over `ease` it blends back to raw.
 * Overlapping holds blend by weight. Returns height(x,z). Holds are bucketed so a lookup touches only nearby discs.
 * Knolls (t.knoll) rise only past every hold's eased edge: none until knoll_clear[0] metres out, full at knoll_clear[1],
 * so the town's ground is exactly what it was without them. height.lift(x,z) is the knoll part alone.
 */
export function heldGround(t,holds,cell=32){
  const grid=new Map(),key=(i,j)=>i+':'+j,[c0,c1]=t.P.knoll_clear||[0,0];
  for(const h of holds){
    const reach=h.r+h.ease+c1;
    for(let i=Math.floor((h.x-reach)/cell);i<=Math.floor((h.x+reach)/cell);i++)for(let j=Math.floor((h.z-reach)/cell);j<=Math.floor((h.z+reach)/cell);j++){
      const k=key(i,j);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(h);
    }
  }
  const lift=(x,z,list)=>{
    if(!t.P.knolls)return 0;let gap=Infinity;if(list)for(const h of list)gap=Math.min(gap,Math.hypot(x-h.x,z-h.z)-h.r-h.ease);
    const m=smooth(c0,c1,gap);return m&&m*t.knoll(x,z);
  };
  const height=(x,z)=>{
    const list=grid.get(key(Math.floor(x/cell),Math.floor(z/cell))),raw=t.raw(x,z);if(!list)return raw+lift(x,z,list);
    let num=0,den=0,top=0;
    for(const h of list){const d=Math.hypot(x-h.x,z-h.z);if(d>=h.r+h.ease)continue;const w=1-smooth(h.r,h.r+h.ease,d);num+=w*h.y;den+=w;if(w>top)top=w;}
    return (den?raw+(num/den-raw)*top:raw)+lift(x,z,list);
  };
  height.lift=(x,z)=>lift(x,z,grid.get(key(Math.floor(x/cell),Math.floor(z/cell))));
  return height;
}

/** Level for a hamlet: its natural height at the centre, never below dry ground. */
export const siteLevel=(t,x,z)=>Math.max(t.raw(x,z),t.water+t.P.bank_y+.2);

/**
 * Holds for a town: every site is a flat common reaching past its farthest home; homes inside a common share its level,
 * homes outside get their own pad at their natural level; the memorial sits at the level of the nearest common.
 */
export function townHolds(t,sites,homes,memorial,L){
  const holds=sites.map(s=>({x:s.x,z:s.z,r:(s.plaza??L.plaza_radius)+L.road_clearance*2,ease:t.P.hold_ease,y:siteLevel(t,s.x,s.z),site:s}));
  const nearest=(x,z)=>holds.reduce((a,b)=>Math.hypot(a.x-x,a.z-z)-a.r<Math.hypot(b.x-x,b.z-z)-b.r?a:b,holds[0]);
  for(const h of homes){
    const site=h.group&&holds.find(s=>s.site.group===h.group),d=site&&Math.hypot(h.x-site.x,h.z-site.z);
    if(site&&d<=Math.max(L.plot_radius,L.main_radius||0)+L.house_radius){site.r=Math.max(site.r,d+L.house_radius);continue;}
    holds.push({x:h.x,z:h.z,r:L.house_radius,ease:t.P.hold_ease*.6,y:siteLevel(t,h.x,h.z)});
  }
  if(memorial&&holds.length){const n=nearest(memorial.x,memorial.z);holds.push({x:memorial.x,z:memorial.z,r:memorial.r,ease:t.P.hold_ease*.6,y:n.y});}
  return holds;
}

/**
 * Bridges where a road crosses water: spans of road points whose ground lies below the deck line, extended to dry bank.
 * Returns [{a:[x,z],b:[x,z],ya,yb,width,kind}] with deck heights at each bank. Pure; roadHeight() uses them.
 */
export function findBridges(roads,height,water,clear=.45){
  const out=[];
  for(const road of roads){
    const p=road.points,wet=p.map(q=>height(q[0],q[1])<water+clear);
    for(let i=0;i<p.length;i++){
      if(!wet[i])continue;let j=i;while(j+1<p.length&&wet[j+1])j++;
      const a=Math.max(0,i-2),b=Math.min(p.length-1,j+2);
      const ya=Math.max(height(p[a][0],p[a][1]),water+clear),yb=Math.max(height(p[b][0],p[b][1]),water+clear);
      out.push({a:p[a],b:p[b],ya,yb,width:road.width+.35,kind:road.kind});i=j;
    }
  }
  return out;
}

/** Ground height with bridge decks on top: what roads, lamps and walking cats stand on. */
export function roadHeight(height,bridges){
  return (x,z)=>{
    const g=height(x,z);
    for(const br of bridges){
      const dx=br.b[0]-br.a[0],dz=br.b[1]-br.a[1],len2=dx*dx+dz*dz||1,s=((x-br.a[0])*dx+(z-br.a[1])*dz)/len2;
      if(s<0||s>1)continue;
      const px=br.a[0]+dx*s,pz=br.a[1]+dz*s;if(Math.hypot(x-px,z-pz)>br.width+.3)continue;
      return Math.max(g,deckY(br,s));
    }
    return g;
  };
}
/** Deck height along a bridge: banks joined by a gentle arch. */
export const deckY=(br,s)=>br.ya+(br.yb-br.ya)*s+.55*Math.sin(Math.PI*s)+.08;

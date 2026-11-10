// Pure helpers first: no DOM or WebGL at module scope, so Node tests can import this file.
export const FAREWELL_MS=6000,NAMEPLATE_PX=24;

/** Newest retirement first. Ties keep the cat name order so the list never reshuffles. */
export function memorialOrder(retired=[]){
  return retired.slice().sort((a,b)=>(Date.parse(b.retiredAt)||0)-(Date.parse(a.retiredAt)||0)||String(a.name).localeCompare(String(b.name)));
}

/** Counts retire / keep / abstain from the ballots actually cast; electorate is the fixed voter list. */
export function tallyVotes(votes=[],electorate=[]){
  const count={retire:0,keep:0,abstain:0};
  for(const ballot of votes)if(Object.hasOwn(count,ballot.vote))count[ballot.vote]++;
  return {...count,cast:votes.length,electorate:electorate.length};
}

/** Panel rows built from retiredCats plus the council that retired each one. */
export function memorialRows(retired=[],councils=[],nameOf=id=>id){
  return memorialOrder(retired).map(cat=>{
    const council=councils.find(c=>c.id===cat.council),votes=council?.votes||[];
    return {
      id:cat.id,name:cat.name,role:cat.role,retiredAt:cat.retiredAt,reason:cat.reason,
      // For the star chart: the cat's own fur colour, its hamlet, and how much it talked with the town (road messages).
      color:cat.appearance?.fur||cat.look?.fur||cat.color,group:cat.group,deeds:(cat.roads||[]).reduce((n,r)=>n+(Number(r.messages)||0),0),
      tally:tallyVotes(votes,council?.electorate||[]),
      ballots:votes.map(v=>({voter:nameOf(v.cat),vote:v.vote,reason:v.reason}))
    };
  });
}

/** Identity of one retirement. A restored cat retired again gets a new council, so the key changes. */
export const retirementKey=cat=>`${cat.id}:${cat.council}`;

/** Retirements not in the previously seen set. The first state a scene sees is history, so callers seed it silently. */
export function newlyRetired(seenKeys,retired=[]){
  return retired.filter(cat=>!seenKeys.has(retirementKey(cat)));
}

export function farewellText(name){
  return 'Farewell, '+String(name||'friend').replace(/[.!?\r\n]+/g,' ').replace(/\s+/g,' ').trim();
}

/** Star-lamp rings around the observatory, in art units (the building is drawn at layout scale). A front sector stays open
 *  for the path; each ring fills outward from the back. Rings sit between the plinth (2.5) and the hedge (memorial_grounds). */
export const STONE_RINGS=[3.6,4.6,5.6],STONE_GAP=1,PATH_HALF_ANGLE=Math.PI/6;
const ringCapacity=r=>Math.floor((2*Math.PI-2*PATH_HALF_ANGLE)*r/STONE_GAP)+1;
export const STONE_CAPACITY=STONE_RINGS.reduce((n,r)=>n+ringCapacity(r),0);
/** Lamp centres relative to the tower centre, front (+z, the door) open. Beyond STONE_CAPACITY no more stones are drawn.
 *  ponytail: a hard cap (74 with these rings, above maxCats); add a fourth ring if a town can retire more cats than that. */
export function stoneLayout(count){
  const out=[];let left=Math.min(count,STONE_CAPACITY);
  for(const r of STONE_RINGS){
    const n=Math.min(left,ringCapacity(r)),step=STONE_GAP/r;left-=n;
    for(let j=0;j<n;j++){const a=Math.PI+(j-(n-1)/2)*step;out.push({x:Math.sin(a)*r,z:Math.cos(a)*r});}
  }
  return out;
}

// ---------------------------------------------------------------- star chart model (pure)
/** The chart is SKY world units wide and SKY/aspect tall (the panel's shape); the panel fits it to its box and pans and zooms over it. */
export const SKY=1000,NO_STARS='No stars yet. Every cat that retires becomes a star here.';
/** Automatic motion only: parallax drift and shooting stars stop under reduced motion. Drag, wheel and pinch stay, since the player drives them. */
export function skyMotion(reduced=false){return reduced?{drift:0,shooting:false}:{drift:1,shooting:true};}
const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)/4294967296;};
/** Two cat figures facing left in unit space (x right, y down, within about -1..1). outline: the open path the stars sit
 *  on, in order (front paw, chest, face, ears, back, haunch, tail); extra: the other line-art strokes. */
const FIGURES={
  sitting:{outline:[[-.48,.92],[-.5,.55],[-.44,.18],[-.56,-.1],[-.72,-.32],[-.68,-.62],[-.62,-.98],[-.42,-.72],[-.16,-.96],[-.06,-.62],[-.02,-.3],[.3,.02],[.56,.44],[.46,.9],[.82,.8],[1,.42],[.9,.02]],
    extra:[[[-.48,.92],[0,.94],[.46,.9]],[[-.2,.42],[-.22,.7],[-.24,.92]],[[-.56,-.44],[-.46,-.42]],[[-.76,-.24],[-.94,-.2]],[[-.76,-.18],[-.92,-.08]]]},
  curled:{outline:[[-.42,.3],[-.7,.16],[-.86,-.12],[-.78,-.42],[-.74,-.76],[-.54,-.54],[-.42,-.84],[-.28,-.52],[.1,-.5],[.56,-.34],[.86,0],[.74,.38],[.36,.6],[-.1,.64],[-.5,.56],[-.72,.42]],
    extra:[[[-.72,.42],[-.44,.46],[-.1,.44],[.22,.34]],[[-.7,-.3],[-.58,-.26]],[[-.42,.3],[-.1,.26],[.2,.1]]]}
};
/** Flowing curve through every point (Catmull-Rom), densely sampled so drawing and star placement share it. */
function smooth(pts,steps=8){
  if(pts.length<3)return pts.map(p=>p.slice());
  const out=[pts[0].slice()];
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    for(let s=1;s<=steps;s++){const t=s/steps,t2=t*t,t3=t2*t;out.push([0,1].map(k=>.5*(2*p1[k]+(p2[k]-p0[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2+(3*p1[k]-p0[k]-3*p2[k]+p3[k])*t3)));}
  }
  return out;
}
/** n points spread along a polyline by arc length, at the middle of n equal parts. */
function along(path,n){
  const lens=[0];for(let i=1;i<path.length;i++)lens.push(lens[i-1]+Math.hypot(path[i][0]-path[i-1][0],path[i][1]-path[i-1][1]));
  const total=lens.at(-1)||1,out=[];let j=1;
  for(let k=0;k<n;k++){const d=(k+.5)/n*total;while(j<path.length-1&&lens[j]<d)j++;const span=lens[j]-lens[j-1]||1,t=(d-lens[j-1])/span;out.push([path[j-1][0]+(path[j][0]-path[j-1][0])*t,path[j-1][1]+(path[j][1]-path[j-1][1])*t]);}
  return out;
}
const finite=v=>Number.isFinite(v)?v:0,safeColour=c=>/^#[0-9a-f]{6}$/i.test(String(c))?String(c):'#bfefff';
/** Constellation label: main is the town centre, gN a hamlet; cats without a hamlet group by role. */
export const constellationName=key=>key==='main'?'Town centre':/^g\d+$/.test(key)?'Nook '+key.slice(1):key.startsWith('role:')?key.slice(5)||'Wanderers':key;
/**
 * Star chart for the memorial rows: one cat-shaped constellation per hamlet (or per role for cats with no hamlet), each
 * retired cat a star on its figure, lines linking neighbours of the same constellation only. Deterministic for a set of
 * cats (input order never matters) and finite for any input.
 * aspect: the panel's width / height, so the figures fill it. Returns {width,height,figures:[{key,label,kind,strokes}], stars:[{id,x,y,mag,color,group,phase}], lines:[[i,j]]} in world units.
 */
export function skyLayout(rows=[],aspect=1){
  const groups=new Map();
  for(const row of rows){const key=row.group?String(row.group):'role:'+String(row.role||'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const keys=[...groups.keys()].sort(),wide=Math.min(2.5,Math.max(.4,finite(aspect)||1)),width=SKY,height=SKY/wide;
  const cols=Math.max(1,Math.min(keys.length,Math.round(Math.sqrt(keys.length*wide)))),rowsN=Math.ceil(keys.length/cols)||1,cw=width/cols,ch=height/rowsN;
  const most=Math.max(0,...rows.map(r=>finite(r.deeds)));
  const figures=[],stars=[],lines=[];
  keys.forEach((key,k)=>{
    const kind=hash(key+':pose')<.5?'sitting':'curled',fig=FIGURES[kind],flip=hash(key+':flip')<.5?-1:1,turn=(hash(key+':turn')-.5)*.5;
    const size=Math.min(cw,ch)*.42,cx=cw*(k%cols+.5)+(hash(key+':x')-.5)*cw*.1,cy=ch*(Math.floor(k/cols)+.5)+(hash(key+':y')-.5)*ch*.1;
    const place=([x,y])=>{x*=flip;return [cx+(x*Math.cos(turn)-y*Math.sin(turn))*size,cy+(x*Math.sin(turn)+y*Math.cos(turn))*size];};
    const outline=smooth(fig.outline).map(place);
    figures.push({key,label:constellationName(key),kind,strokes:[outline,...fig.extra.map(s=>smooth(s).map(place))]});
    const members=groups.get(key).slice().sort((a,b)=>finite(Date.parse(a.retiredAt))-finite(Date.parse(b.retiredAt))||String(a.id).localeCompare(String(b.id)));
    const first=stars.length;
    along(outline,members.length).forEach(([x,y],i)=>{
      const row=members[i],mag=most>0?.35+.65*Math.log1p(Math.max(0,finite(row.deeds)))/Math.log1p(most):.7;
      stars.push({id:row.id,x,y,mag,color:safeColour(row.color),group:key,phase:hash(row.id)*Math.PI*2});
      if(i)lines.push([first+i-1,first+i]);
    });
  });
  return {width,height,figures,stars,lines};
}

// Browser-only helpers below. They run when called, never at import.

function el(tag,text,className){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}

function button(text,className,onclick){const b=el('button',text,className);b.type='button';b.onclick=onclick;return b;}
const retiredOn=at=>{const d=new Date(at);return Number.isNaN(+d)?'an unknown date':d.toLocaleString([],{dateStyle:'medium',timeStyle:'short'});};
/** One retired cat's details: the List view card and the star's glass card share it. */
function details(row,{canRestore,disabled,onRestore},tag='article',className='task-card'){
  const card=el(tag,'',className);
  card.append(el('strong',row.name),el('small',row.group||row.role?[row.role,row.group&&constellationName(String(row.group))].filter(Boolean).join(' · '):''));
  card.append(el('p',`Retired ${retiredOn(row.retiredAt)}`),el('p',`Reason: ${row.reason}`));
  const t=row.tally;
  card.append(el('p',`Retire ${t.retire} · Keep ${t.keep} · Abstain ${t.abstain} · ${t.cast} of ${t.electorate} ballots`));
  const ballots=el('details');ballots.append(el('summary','Ballots'));
  for(const ballot of row.ballots){const p=el('p');p.append(el('strong',`${ballot.voter}: ${ballot.vote}`),document.createElement('br'),document.createTextNode(ballot.reason));ballots.append(p);}
  if(!row.ballots.length)ballots.append(el('p','No ballots were recorded.','muted'));
  card.append(ballots);
  if(canRestore){const restore=button('Restore','sky-restore',()=>onRestore(row.id,restore));restore.disabled=disabled;card.append(restore);}
  return card;
}
function loadSkyStyles(){
  if(document.querySelector?.('link[data-memorial-sky]'))return;
  const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./memorial-sky.css',import.meta.url).href;link.setAttribute('data-memorial-sky','');document.head?.append(link);
}
let memorialView='sky';// Sky or List; kept across re-renders of the panel.
/**
 * Memorial panel DOM: a night-sky star chart, or the List view of cards. Every value goes through textContent; nothing
 * from the town is parsed as HTML. canRestore hides the Restore control entirely (read-only viewers); disabled greys it
 * out while paused or voting. onRestore(id, button) is app.js's restore call.
 */
export function memorialPanel(rows,options={}){
  const opts={canRestore:false,disabled:false,onRestore:()=>{},...options};loadSkyStyles();
  // The body swaps inside its own holder: replacing the wrapper's children would also drop the toolbar's focused toggle.
  const wrap=el('div','','sky-wrap'),tools=el('div','','sky-tools'),holder=el('div','','sky-holder');
  // town.js glides the camera to the observatory (focus-memorial).
  const show=button('Show observatory','sky-chip',()=>dispatchEvent(new CustomEvent('focus-memorial')));
  const toggle=button('','sky-chip',()=>{memorialView=memorialView==='sky'?'list':'sky';render();});
  tools.append(toggle,show);
  const render=()=>{
    wrap.querySelector?.('.sky-body')?.dispatchEvent?.(new Event('sky-dispose'));
    const list=memorialView==='list';toggle.textContent=list?'Sky':'List';toggle.setAttribute('aria-pressed',String(list));
    toggle.setAttribute('aria-label',list?'Show the star chart':'Show the list of retired cats');
    const body=list?el('div','','sky-body sky-list'):skyChart(rows,opts);
    if(list){if(rows.length)body.append(...rows.map(row=>details(row,opts)));else body.append(el('p',NO_STARS,'muted'));}
    holder.replaceChildren(body);
  };
  wrap.replaceChildren(tools,holder);
  render();
  return [wrap];
}

// ---------------------------------------------------------------- star chart drawing (canvas)
const CYAN='120,232,255',rgba=(hex,a)=>`rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
function seeded(seed){let s=seed>>>0||1;return ()=>((s=Math.imul(s^s>>>15,1|s)+0x6d2b79f5>>>0)/4294967296);}
function canvasOf(w,h){const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w));c.height=Math.max(1,Math.round(h));return c;}
/** Backdrop (screen space, cached per size): indigo to violet, nebula clouds, a dense faint star field, a few sparkles, vignette. */
function paintBackdrop(ctx,w,h){
  const random=seeded(7),sky=ctx.createLinearGradient(0,0,w*.4,h);sky.addColorStop(0,'#141a4a');sky.addColorStop(.55,'#24205a');sky.addColorStop(1,'#3a2364');
  ctx.fillStyle=sky;ctx.fillRect(0,0,w,h);
  for(const [x,y,r,c,a] of [[.25,.3,.55,'90,140,255',.16],[.75,.65,.6,'170,90,220',.14],[.6,.2,.4,'80,220,230',.09],[.2,.85,.45,'230,120,200',.07],[.85,.15,.35,'120,110,255',.1]]){
    const g=ctx.createRadialGradient(x*w,y*h,0,x*w,y*h,r*Math.max(w,h));g.addColorStop(0,`rgba(${c},${a})`);g.addColorStop(1,`rgba(${c},0)`);ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
  }
  for(let i=0,n=Math.round(w*h/700);i<n;i++){ctx.fillStyle=`rgba(225,232,255,${.08+random()*.42})`;const s=.35+random()*random()*1.3;ctx.fillRect(random()*w,random()*h,s,s);}
  ctx.strokeStyle='rgba(220,240,255,.45)';ctx.lineWidth=.6;
  for(let i=0;i<9;i++){const x=random()*w,y=random()*h,s=2+random()*3;ctx.beginPath();ctx.moveTo(x-s,y);ctx.lineTo(x+s,y);ctx.moveTo(x,y-s);ctx.lineTo(x,y+s);ctx.stroke();}
  const v=ctx.createRadialGradient(w/2,h/2,Math.min(w,h)*.35,w/2,h/2,Math.max(w,h)*.75);v.addColorStop(0,'rgba(5,6,20,0)');v.addColorStop(1,'rgba(5,6,20,.6)');ctx.fillStyle=v;ctx.fillRect(0,0,w,h);
}
/** Two sparse star layers at device size. The near layer is larger and slides further per pan than the far one. */
function starLayers(pw,ph,dpr){
  return [{depth:.06,speed:2,count:90,max:1.2,seed:31},{depth:.16,speed:6,count:45,max:1.9,seed:57}].map(({depth,speed,count,max,seed})=>{
    const canvas=canvasOf(pw,ph),g=canvas.getContext('2d'),random=seeded(seed);
    if(g)for(let i=0;i<count;i++){g.fillStyle=`rgba(232,240,255,${.35+random()*.6})`;g.beginPath();g.arc(random()*pw,random()*ph,(.5+random()*max)*dpr,0,Math.PI*2);g.fill();}
    return {canvas,depth,speed};
  });
}
/** A star sprite: white-hot core, the cat's colour, a cyan bloom and a four-point flare. R is the core radius in px. */
function starSprite(color,R,dpr){
  const size=Math.ceil(R*12*dpr),c=canvasOf(size,size),g=c.getContext('2d');if(!g)return c;g.scale(dpr,dpr);const m=R*6;
  const bloom=g.createRadialGradient(m,m,0,m,m,R*4);bloom.addColorStop(0,'rgba(255,255,255,.95)');bloom.addColorStop(.18,rgba(color,.8));bloom.addColorStop(.45,`rgba(${CYAN},.28)`);bloom.addColorStop(1,`rgba(${CYAN},0)`);
  g.fillStyle=bloom;g.fillRect(0,0,m*2,m*2);
  for(const [len,width,alpha,angle] of [[R*5.8,R*.22,.9,0],[R*5.8,R*.22,.9,Math.PI/2],[R*2.6,R*.14,.45,Math.PI/4],[R*2.6,R*.14,.45,-Math.PI/4]]){
    g.save();g.translate(m,m);g.rotate(angle);const f=g.createLinearGradient(-len,0,len,0);f.addColorStop(0,`rgba(${CYAN},0)`);f.addColorStop(.5,`rgba(235,252,255,${alpha})`);f.addColorStop(1,`rgba(${CYAN},0)`);
    g.fillStyle=f;g.beginPath();g.moveTo(-len,0);g.quadraticCurveTo(0,-width,len,0);g.quadraticCurveTo(0,width,-len,0);g.fill();g.restore();
  }
  g.shadowColor=`rgba(${CYAN},1)`;g.shadowBlur=R*2;g.fillStyle='#ffffff';g.beginPath();g.arc(m,m,R*.5,0,Math.PI*2);g.fill();
  return c;
}
/** The live chart: canvas art, a visually hidden list of stars for keyboard and screen readers, a glass card on demand. */
function skyChart(rows,opts){
  const root=el('div','','sky-body sky'),canvas=document.createElement('canvas'),ctx=canvas.getContext?.('2d');
  canvas.setAttribute('aria-hidden','true');canvas.className='sky-canvas';
  let model=skyLayout(rows);const byId=new Map(rows.map(r=>[r.id,r])),list=el('ul','','sky-sr'),card=el('div','','sky-card');
  list.setAttribute('aria-label','Retired cats');card.hidden=true;card.setAttribute('role','dialog');
  root.append(canvas,list,card);
  if(!rows.length)root.append(el('p',NO_STARS,'sky-empty'));
  const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w=0,h=0,dpr=1,backdrop=null,chart=null,chartKey='',sprites=[],open=-1,pinned=false,visible=false,frame=0,disposed=false;
  const motion=skyMotion(reduced),mod=(a,n)=>((a%n)+n)%n;let layers=[],shoot=null,nextShoot=0;
  const view={zoom:1,x:0,y:0},fit=()=>Math.min(w/model.width,h/model.height)*.94;
  const toScreen=(x,y)=>[w/2+(x-model.width/2)*fit()*view.zoom+view.x,h/2+(y-model.height/2)*fit()*view.zoom+view.y];
  const starR=s=>(3+4.5*s.mag)*(.8+.2*view.zoom);
  const pathOf=(g,pts)=>{pts.forEach(([x,y],i)=>{const [sx,sy]=toScreen(x,y);i?g.lineTo(sx,sy):g.moveTo(sx,sy);});};
  function paintChart(){
    const key=[w,h,dpr,view.zoom,view.x,view.y].join();if(key===chartKey)return;chartKey=key;
    chart=chart||canvasOf(1,1);chart.width=Math.round(w*dpr);chart.height=Math.round(h*dpr);const g=chart.getContext('2d');if(!g)return;
    g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);g.lineCap='round';g.lineJoin='round';
    // Faint celestial grid: declination circles and right-ascension spokes about the chart's pole.
    g.strokeStyle=`rgba(${CYAN},.06)`;g.lineWidth=1;const [px,py]=toScreen(model.width/2,model.height/2),unit=fit()*view.zoom;
    for(const r of [140,280,420,560]){g.beginPath();g.ellipse(px,py,r*unit,r*unit*.86,0,0,Math.PI*2);g.stroke();}
    g.beginPath();for(let i=0;i<12;i++){const a=i/12*Math.PI*2;g.moveTo(px+Math.cos(a)*60*unit,py+Math.sin(a)*52*unit);g.lineTo(px+Math.cos(a)*700*unit,py+Math.sin(a)*600*unit);}g.stroke();
    // Line art of each cat figure, dim cyan.
    g.strokeStyle=`rgba(${CYAN},.3)`;g.lineWidth=1.2;g.shadowColor=`rgba(${CYAN},.5)`;g.shadowBlur=4;
    for(const f of model.figures)for(const stroke of f.strokes){g.beginPath();pathOf(g,stroke);g.stroke();}
    // Constellation lines: a soft wide glow, then a bright core.
    for(const [width,alpha,blur] of [[6,.16,14],[2,.85,6]]){
      g.strokeStyle=`rgba(${CYAN},${alpha})`;g.lineWidth=width;g.shadowBlur=blur;g.beginPath();
      for(const [a,b] of model.lines)pathOf(g,[[model.stars[a].x,model.stars[a].y],[model.stars[b].x,model.stars[b].y]]);g.stroke();
    }
  }
  function draw(time=0){
    if(!ctx||!w||!h)return;
    if(!backdrop){backdrop=canvasOf(w*dpr,h*dpr);const g=backdrop.getContext('2d');if(g){g.scale(dpr,dpr);paintBackdrop(g,w,h);}}
    if(!layers.length)layers=starLayers(Math.round(w*dpr),Math.round(h*dpr),dpr);
    const t=time/1000;
    paintChart();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(backdrop,0,0);
    // Parallax: the two star layers slide with the pan, at their own depth, plus a slow drift (none under reduced motion).
    for(const layer of layers){const pw=layer.canvas.width,x=mod(view.x*layer.depth*dpr-t*layer.speed*motion.drift*dpr,pw);ctx.drawImage(layer.canvas,x-pw,0);ctx.drawImage(layer.canvas,x,0);}
    if(chart)ctx.drawImage(chart,0,0);ctx.setTransform(dpr,0,0,dpr,0,0);
    // A shooting star now and then: a short streak that fades in 0.9 s.
    if(motion.shooting){
      if(!shoot&&time>nextShoot){shoot={at:time,x:w*(.45+.5*Math.random()),y:h*.08*Math.random()};nextShoot=time+9000+Math.random()*9000;}
      if(shoot){const p=(time-shoot.at)/900;if(p>=1)shoot=null;else{const x=shoot.x-p*w*.3,y=shoot.y+p*h*.14;ctx.globalAlpha=1-p;ctx.strokeStyle='rgba(240,250,255,.9)';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w*.06,y-h*.028);ctx.stroke();ctx.globalAlpha=1;}}
    }
    if(!model.stars.length){const g=ctx.createRadialGradient(w/2,h*.42,0,w/2,h*.42,10);g.addColorStop(0,'rgba(220,240,255,.45)');g.addColorStop(1,'rgba(220,240,255,0)');ctx.fillStyle=g;ctx.fillRect(w/2-10,h*.42-10,20,20);return;}
    model.stars.forEach((s,i)=>{
      const [x,y]=toScreen(s.x,s.y),R=starR(s),tw=reduced?1:.78+.22*Math.sin(t*1.6+s.phase)*Math.sin(t*.7+s.phase*2.3),k=(.85+.15*tw)*R/(sprites[i].R);
      ctx.globalAlpha=(.55+.45*s.mag)*tw;const size=sprites[i].c.width/dpr*k;ctx.drawImage(sprites[i].c,x-size/2,y-size/2,size,size);
      if(i===open){ctx.globalAlpha=.9;ctx.strokeStyle=`rgba(${CYAN},.9)`;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y,R*2.6,0,Math.PI*2);ctx.stroke();}
    });
    ctx.globalAlpha=1;
  }
  // Twinkle only while the chart is on screen; reduced motion draws on change only.
  const loop=time=>{frame=0;if(disposed||!canvas.isConnected||!visible||document.hidden)return;draw(time);frame=requestAnimationFrame(loop);};
  const redraw=()=>{if(reduced||!visible)draw(performance.now());else if(!frame)frame=requestAnimationFrame(loop);};
  const resize=()=>{
    const box=root.getBoundingClientRect?.();if(!box?.width||!box.height)return;
    w=box.width;h=box.height;model=skyLayout(rows,w/h);dpr=Math.min(2,globalThis.devicePixelRatio||1);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    backdrop=null;layers=[];chartKey='';sprites=model.stars.map(s=>{const R=(3+4.5*s.mag)*1.6;return {R,c:starSprite(s.color,R,dpr)};});draw(performance.now());
  };
  // Hit test in CSS px: a star answers within 22 px of its centre (44 px targets), the nearest one wins.
  const hit=(x,y)=>{let best=-1,bestD=Infinity;model.stars.forEach((s,i)=>{const [sx,sy]=toScreen(s.x,s.y),d=Math.hypot(sx-x,sy-y);if(d<=Math.max(22,starR(s)*2)&&d<bestD){best=i;bestD=d;}});return best;};
  // The card sits beside its star and follows it while the sky pans (phones pin it to the bottom in CSS).
  const place=()=>{const s=model.stars[open];if(!s)return;const [x,y]=toScreen(s.x,s.y);card.style.left=Math.round(Math.min(Math.max(8,x+18),Math.max(8,w-248)))+'px';card.style.top=Math.round(Math.min(Math.max(8,y-20),Math.max(8,h-card.offsetHeight-8)))+'px';};
  function show(i,pin){
    open=i;pinned=pin&&i>=0;if(i<0){card.hidden=true;card.replaceChildren();redraw();return;}
    const s=model.stars[i],row=byId.get(s.id),close=button('×','sky-close',()=>{show(-1,false);items[i]?.focus?.();});
    close.setAttribute('aria-label','Close');card.replaceChildren(close,details(row,opts,'div','sky-card-body'));card.setAttribute('aria-label',row.name);card.hidden=false;
    place();
    redraw();
  }
  const items=model.stars.map((s,i)=>{const row=byId.get(s.id),li=el('li'),b=button(`${row.name}, ${row.role||'resident'}, retired ${retiredOn(row.retiredAt)}`,'',()=>{show(i,true);card.children[0]?.focus?.();});li.append(b);list.append(li);return b;});
  // Drag to pan, pinch or wheel to zoom (1x to 4x), tap or hover a star for its card.
  const pointers=new Map();let moved=false,pinch=0;
  const zoomAt=(px,py,next)=>{const z=Math.min(4,Math.max(1,next)),f=z/view.zoom;view.x=px-w/2-(px-w/2-view.x)*f;view.y=py-h/2-(py-h/2-view.y)*f;view.zoom=z;clampView();};
  const clampView=()=>{const mx=w*view.zoom/2,my=h*view.zoom/2;view.x=Math.min(mx,Math.max(-mx,view.x));view.y=Math.min(my,Math.max(-my,view.y));if(open>=0){if(pinned)place();else show(-1,false);}redraw();};
  const local=e=>{const r=canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];};
  canvas.addEventListener('pointerdown',e=>{try{canvas.setPointerCapture(e.pointerId);}catch{}pointers.set(e.pointerId,local(e));moved=false;if(pointers.size===2){const [a,b]=[...pointers.values()];pinch=Math.hypot(a[0]-b[0],a[1]-b[1]);}});
  canvas.addEventListener('pointermove',e=>{
    const p=local(e);
    if(!pointers.has(e.pointerId)){if(e.pointerType==='mouse'){const i=hit(...p);canvas.style.cursor=i>=0?'pointer':'grab';if(!pinned&&i!==open)show(i,false);}return;}
    const last=pointers.get(e.pointerId);pointers.set(e.pointerId,p);
    if(pointers.size===2){const [a,b]=[...pointers.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]);if(pinch)zoomAt((a[0]+b[0])/2,(a[1]+b[1])/2,view.zoom*d/pinch);pinch=d;moved=true;return;}
    if(moved||Math.hypot(p[0]-last[0],p[1]-last[1])>3){moved=true;view.x+=p[0]-last[0];view.y+=p[1]-last[1];clampView();}else pointers.set(e.pointerId,last);
  });
  const up=e=>{if(!pointers.delete(e.pointerId))return;pinch=0;if(!moved&&!pointers.size&&e.type==='pointerup'){const i=hit(...local(e));show(i,i>=0);}};
  canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
  canvas.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'&&!pinned&&open>=0)show(-1,false);});
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoomAt(...local(e),view.zoom*Math.exp(-e.deltaY*.0015));},{passive:false});
  // Escape closes the star's card first; preventDefault keeps the dialog open for that press.
  root.addEventListener('keydown',e=>{if(e.key==='Escape'&&open>=0){e.preventDefault();const i=open;show(-1,false);items[i]?.focus?.();}});
  // The panel replaces this chart on every re-render: a detached chart lets go of its observers at the next callback.
  const dispose=()=>{disposed=true;resizes?.disconnect();seen?.disconnect();document.removeEventListener?.('visibilitychange',wake);if(frame)cancelAnimationFrame(frame);frame=0;};
  const resizes=typeof ResizeObserver==='function'?new ResizeObserver(()=>root.isConnected?resize():dispose()):null;
  const seen=typeof IntersectionObserver==='function'?new IntersectionObserver(([entry])=>{if(!root.isConnected)return dispose();visible=entry.isIntersecting;if(visible){resize();redraw();}}):null;
  resizes?.observe(root);seen?.observe(root);
  const wake=()=>{if(!root.isConnected)dispose();else if(!document.hidden)redraw();};document.addEventListener?.('visibilitychange',wake);
  root.addEventListener('sky-dispose',dispose);
  return root;
}

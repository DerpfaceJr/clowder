// Graphics quality: per viewer like the weather (localStorage 'cat-town-quality', the ☰ menu); ?quality= picks one for
// this load only (perf probes and screenshots). Tiers: Low draws the scene straight to the screen; Medium adds one post
// pass; High adds ambient occlusion and bloom (computers only, phones draw Medium). Auto starts phones on Low and
// computers on Medium, then town.js steps it with the measured frame rate (adaptQuality).
export const QUALITIES=['auto','low','medium','high'];
export const QUALITY_KEY='cat-town-quality';
const TIERS=['low','medium','high'];

/** The viewer's choice: ?quality= first, then storage; anything unknown or unreadable is auto. */
export function savedQuality(search='',storage=null){
  const q=new URLSearchParams(search).get('quality');if(QUALITIES.includes(q))return q;
  try{const v=storage?.getItem(QUALITY_KEY);return QUALITIES.includes(v)?v:'auto';}catch{return 'auto';}
}
export const startTier=mobile=>mobile?'low':'medium';
/** The tier drawn for a choice: auto follows autoTier; High is desktop only. */
export function tierFor(choice,autoTier,mobile){
  const t=TIERS.includes(choice)?choice:TIERS.includes(autoTier)?autoTier:startTier(mobile);
  return mobile&&t==='high'?'medium':t;
}
/** One auto step (dir -1 or +1), never above `ceiling` (the tier auto last had to leave) or High on phones. */
export function stepTier(tier,dir,mobile,ceiling='high'){
  const top=Math.min(mobile?1:2,TIERS.indexOf(ceiling)),i=TIERS.indexOf(tier)+dir;
  return TIERS[Math.max(0,Math.min(top,i))];
}

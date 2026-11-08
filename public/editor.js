import {homeProblem,resolveLayout} from './hamlet-layout.js';
// Owner world editor. The rules below are pure (Node-tested); the Studio (studio.js) builds its own DOM.
// The server stays the authority for homes and appearance; these helpers only preview and shape requests.
export const EYE_DEFAULT='#4c3c32';
export const TRIM_DEFAULT='#e8b354';
const COLOUR_KEYS=['fur','patch','cream','outfit','trim','eyes'];
const LOOK_KEYS=[...COLOUR_KEYS,'base','marking','expression','parts','accessory'];

// Same owner-move rules the server applies (hamlet-layout homeProblem). Preview only; the server validates.
export function planHomeMove(x,z,cats,movingId,raw,groups){
  const L=resolveLayout(raw),nx=Math.round(x*10)/10,nz=Math.round(z*10)/10;
  const homes=cats.filter(c=>c.id!==movingId&&c.home).map(c=>({x:c.home.x,z:c.home.z}));
  const reason=homeProblem(nx,nz,homes,groups,L);
  return {x:nx,z:nz,valid:!reason,reason};
}

/** Put a part on, replacing whatever already uses its socket. */
export function wearPart(parts,part,kit){
  const socket=kit?.parts?.[part]?.socket;
  return [...(parts||[]).filter(p=>kit?.parts?.[p]?.socket!==socket),part];
}

// Precedence: owner's explicit choice > owner's chroma preset > the cat's generated look > house design > defaults.
// An old saved accessory becomes a kit part only when no parts were chosen.
export function resolveAppearance(appearance,chromas=[],design,look={},kit){
  const saved=appearance||{},preset=chromas.find(c=>c.id===saved.chroma)||{},gen=look||{};
  const legacy=kit?.legacyAccessories?.[saved.accessory];
  return {
    fur:saved.fur??preset.fur??gen.fur??design?.fur,
    outfit:saved.outfit??preset.outfit??gen.outfit??design?.outfit,
    eyes:saved.eyes??preset.eyes??gen.eyes??EYE_DEFAULT,
    patch:saved.patch??gen.patch??design?.patch,
    cream:saved.cream??gen.cream??design?.cream,
    trim:saved.trim??gen.trim??TRIM_DEFAULT,
    base:saved.base??gen.base??'bean',
    marking:saved.marking??gen.marking??'solid',
    expression:saved.expression??gen.expression??'neutral',
    parts:saved.parts??(legacy?wearPart(gen.parts,legacy,kit):gen.parts??[]),
    accessory:saved.accessory??'none',
  };
}

const same=(a,b)=>Array.isArray(a)?a.join()===(b||[]).join():a===b;
/** True only when the owner's choices (saved or previewed) give the cat a different body, coat or costume from its generated look. */
export function wantsKitBody(choice,look){
  const gen=look||{};
  return !!choice&&['base','marking','parts'].some(k=>choice[k]!==undefined&&!same(choice[k],gen[k]??(k==='parts'?[]:undefined)));
}
export function lookChanged(draft,saved,chromas,design,look,kit){
  const a=resolveAppearance(draft,chromas,design,look,kit),b=resolveAppearance(saved,chromas,design,look,kit);
  return LOOK_KEYS.some(k=>!same(a[k],b[k]));
}

// Full look, plus the chroma id only when one was picked (the schema rejects empty values).
export function appearanceBody(draft,chromas,design,look,kit){
  const r=resolveAppearance(draft,chromas,design,look,kit);
  return {...(draft.chroma?{chroma:draft.chroma}:{}),...Object.fromEntries(LOOK_KEYS.map(k=>[k,r[k]]))};
}

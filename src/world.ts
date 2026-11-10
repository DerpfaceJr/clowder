import {readFileSync} from 'node:fs';
import type {Cat,Group} from './store.ts';
import {resolveLayout,placeInGroup,planSite,plotSpot,plotFree,seeded,townLayout} from '../public/hamlet-layout.js';
import {oneLiner} from '../public/one-liner.js';
import {randomLook} from '../public/looks.js';
const catalog=JSON.parse(readFileSync(new URL('../public/world-catalog.json',import.meta.url),'utf8'));
const {chromas:chromaPresets,kit:kitCatalog,houseDecor:decorCatalog,...designCatalog}=catalog;
export const designs:Record<string,{label:string;match:string;fur:string;cream:string;patch:string;outfit:string;roof:string;accessory:string;icon:string}>=designCatalog;
export type Chroma={id:string;label:string;fur:string;outfit:string;eyes:string};
export const chromas:Chroma[]=chromaPresets;
export const accessories=['none','scarf','bow','hat','glasses','satchel'];
/** The cat kit's allowed values (bases, markings, parts and their sockets, colour slots). Defined once in world-catalog.json. */
export type Kit={bases:string[];markings:string[];expressions:string[];colours:string[];sockets:string[];parts:Record<string,{socket:string;label:string;cloth?:string}>;legacyAccessories:Record<string,string>;palettes:Record<string,string[]>;roles:Record<string,Partial<Look>>};
export const kit:Kit=kitCatalog;
export type HouseLook={roof:string;wall:string;trim:string};
/** Owner house decor ({id,label}); a home look's decor ids come from this list. Defined once in world-catalog.json. */
export const houseDecor:{id:string;label:string}[]=decorCatalog;
/** Owner house customization (cat.home.look): colours as #rrggbb and decor ids; anything unset keeps the design's. */
export type HomeLook={roof?:string;wall?:string;trim?:string;door?:string;decor?:string[]};
export type Look={base:string;marking:string;parts:string[];expression:string;fur:string;patch:string;cream:string;outfit:string;trim:string;eyes:string;house?:HouseLook};
export type Home={x:number;z:number;style:string;plot?:number;manual?:boolean;look?:HomeLook};

/** Homes that take part in placement: every cat that has a home and a group. */
const homesOf=(cats:Cat[])=>cats.filter(c=>c.home&&c.group).map(c=>({x:c.home!.x,z:c.home!.z,group:c.group!,plot:c.home!.plot}));

/** Every road a new home must keep off: the drawn ones and the avenues reserved for nooks to come. */
const allRoads=(cats:Cat[],groups:Group[],raw:any)=>{const t=townLayout(cats,groups,raw);return [...t.roads,...t.reserved];};
/** Where a new cat lives: the first group of its root task with a free plot, or a new site founded for that root.
 *  Owner and taskless recruits use main and found an overflow group when main is full. Never throws on fullness. */
export function placeCat(cats:Cat[],groups:Group[],raw:any,catId:string,style:string,root?:{id:string;text:string},role=''):{group:string;home:Home;founded?:Group}{
  const layout=resolveLayout(raw),homes=homesOf(cats),roads=allRoads(cats,groups,raw);
  const candidates=root?groups.filter(g=>g.rootTask===root.id):groups.filter(g=>!g.rootTask);
  for(const group of candidates){const spot=placeInGroup(group,homes,groups,layout,roads);if(spot)return {group:group.id,home:{x:spot.x,z:spot.z,style,plot:spot.plot}};}
  const site=planSite(groups.map(g=>g.site),layout),id=`g${groups.length}`;
  const founded:Group={id,name:oneLiner(root?root.text:role,28)||'Nook',lead:catId,site,rootTask:root?root.id:null};
  const spot=placeInGroup(founded,homes,[...groups,founded],layout)!;
  return {group:id,home:{x:spot.x,z:spot.z,style,plot:spot.plot},founded};
}
/** Restore keeps a retired cat's plot when it is still free; otherwise it takes the lowest free plot in its group. */
export function restoreSpot(cat:Cat,cats:Cat[],groups:Group[],raw:any):Home{
  const layout=resolveLayout(raw),group=groups.find(g=>g.id===cat.group)||groups.find(g=>g.id==='main')!,homes=homesOf(cats),roads=allRoads(cats,groups,raw);
  const kept=cat.home?.plot;
  if(kept&&kept>0&&!homes.some(h=>h.group===group.id&&h.plot===kept)){
    const p=plotSpot(group.site,kept,group.id,layout);
    if(p&&plotFree(p,homes,groups,layout,roads))return {x:p.x,z:p.z,style:cat.home!.style,plot:kept};
  }
  const spot=placeInGroup(group,homes,groups,layout,roads);if(!spot)throw new Error('This group has no free plot.');
  return {x:spot.x,z:spot.z,style:cat.home?.style||'builder',plot:spot.plot};
}

/** The design whose keywords match, or undefined (styleFor falls back to builder; looks fall back to a seeded costume). */
export function matchStyle(name:string,role:string){
  if(Object.hasOwn(designs,name.toLowerCase()))return name.toLowerCase();
  return Object.keys(designs).find(id=>new RegExp(designs[id].match,'i').test(name+' '+role));
}
export function styleFor(name:string,role:string,requested?:string){
  if(requested){if(!Object.hasOwn(designs,requested))throw new Error('Choose a known house and character style.');return requested;}
  return matchStyle(name,role)||'builder';
}

/** Validates kit parts: known ids, no repeats, at most one per socket. Returns the cleaned list. */
export function checkParts(parts:unknown):string[]{
  if(!Array.isArray(parts)||parts.length>kit.sockets.length||parts.some(p=>typeof p!=='string'||!Object.hasOwn(kit.parts,p)))throw new Error('Choose known costume parts.');
  const sockets=parts.map(p=>kit.parts[p].socket);
  if(new Set(sockets).size!==sockets.length)throw new Error('Choose at most one costume part per socket.');
  return [...parts];
}

/**
 * The generated look for a cat. Founders wear the reference role looks exactly; recruits whose role matches a trade wear
 * that trade's costume with seeded body, markings and palette; anyone else gets a seeded costume too.
 * Recruits also get a seeded house tint so every new home looks individual. The random draws live in looks.js (shared with the Studio).
 */
export function generateLook(id:string,name:string,role:string,style:string,founder=false):Look{
  const template=kit.roles[style];
  if(founder&&template)return {expression:'neutral',eyes:kit.palettes.eyes[0],...template,parts:[...(template.parts||[])]} as Look;
  const matched=matchStyle(name,role),costume=matched&&kit.roles[matched]?.parts;
  return randomLook(seeded(id),kit,designs,style,costume||undefined) as Look;
}

// Types for the pure terrain in terrain.js (the server imports it through hamlet-layout.js; tsc reads these declarations).
export type TerrainParams=Record<string,any>&{seed:string;water_y:number;rivers:number};
export type Hold={x:number;z:number;r:number;ease:number;y:number};
export type Terrain={P:TerrainParams;water:number;raw(x:number,z:number):number;river(x:number,z:number):{edge:number;half:number};dry(x:number,z:number):boolean;clearOfRiver(x:number,z:number,radius:number):boolean;rivers:any[];knoll(x:number,z:number):number;roll(x:number,z:number,base:number):number};
export type Bridge={a:number[];b:number[];ya:number;yb:number;width:number};
export function seeded(text:string):()=>number;
export function noise2(x:number,z:number,s:number):number;
export function terrain(P:TerrainParams):Terrain;
export function heldGround(t:Terrain,holds:Hold[],cell?:number):((x:number,z:number)=>number)&{lift(x:number,z:number):number;hill(x:number,z:number):number};
export function siteLevel(t:Terrain,x:number,z:number):number;
export function townHolds(t:Terrain,sites:any[],homes:any[],memorial:{x:number;z:number;r:number}|null,L:any):Hold[];
export function findBridges(roads:{points:number[][];width:number}[],height:(x:number,z:number)=>number,water:number,clear?:number):Bridge[];
export function roadHeight(height:(x:number,z:number)=>number,bridges:Bridge[]):(x:number,z:number)=>number;
export function deckY(br:Bridge,s:number):number;

// Types for the look generators in looks.js (the server imports it; tsc reads these declarations).
export type Rnd=()=>number;
export function mixHex(a:string,b:string,t:number,shade?:number):string;
export function pick<T>(rnd:Rnd,list:readonly T[]):T;
export function randomParts(rnd:Rnd,kit:any):string[];
export function randomLook(rnd:Rnd,kit:any,designs:Record<string,any>,style:string,costume?:readonly string[]|null):Record<string,any>;
export function randomHouseLook(rnd:Rnd,kit:any,designs:Record<string,any>,style:string,houseDecor?:{id:string;label?:string}[]):{roof:string;wall:string;trim:string;door:string;decor:string[]};

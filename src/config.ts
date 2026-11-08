// One loader for town.config.json plus the optional, gitignored town.local.json overlay.
// Objects merge key by key; arrays and scalars in the overlay replace the base value.
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const CONFIG_FILE='town.config.json';
export const LOCAL_FILE='town.local.json';

const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const UNSAFE=new Set(['__proto__','constructor','prototype']);

export function mergeConfig(base:any,overlay:any):any{
  if(!isObject(base)||!isObject(overlay))return overlay===undefined?base:overlay;
  const out:Record<string,unknown>={...base};
  for(const [key,value] of Object.entries(overlay)){
    if(UNSAFE.has(key))continue;
    out[key]=isObject(value)&&isObject(out[key])?mergeConfig(out[key],value):value;
  }
  return out;
}

function readJson(file:string):any{
  let text:string;
  try{text=readFileSync(file,'utf8');}
  catch(err:any){throw new Error(`Cannot read ${file}: ${err.message}`);}
  let value:unknown;
  try{value=JSON.parse(text);}
  catch(err:any){throw new Error(`${file} is not valid JSON: ${err.message}`);}
  if(!isObject(value))throw new Error(`${file} must contain a JSON object.`);
  return value;
}

export function loadConfig(root:string):any{
  const base=readJson(resolve(root,CONFIG_FILE));
  const local=resolve(root,LOCAL_FILE);
  return existsSync(local)?mergeConfig(base,readJson(local)):base;
}

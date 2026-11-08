import {randomUUID} from 'node:crypto';
import {mkdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

// Write a temp file, then rename it over the target, so a crash never leaves half a file. Secrets pass mode 0o600 (Windows ignores it).
export function writeJsonAtomic(file:string,value:unknown,mode=0o600){
  mkdirSync(dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,{mode});renameSync(temp,file);}
  catch(err){rmSync(temp,{force:true});throw err;}
}

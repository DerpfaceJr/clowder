import {randomUUID} from 'node:crypto';
import {mkdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

// Write a temp file, flush it to the disk, then rename it over the target, so a crash or a power cut never leaves half a file or an empty
// one under the real name. Secrets pass mode 0o600 (Windows ignores it).
export function writeJsonAtomic(file:string,value:unknown,mode=0o600){
  mkdirSync(dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,{mode,flush:true});renameSync(temp,file);}
  catch(err){rmSync(temp,{force:true});throw err;}
}

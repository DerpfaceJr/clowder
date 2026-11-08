// Files a workshop tool wrote to its out folder. The season child writes them here; the server copies them into the world's gallery.
// A season runs in its own process and must not write the world's event journal, so only the server calls importWorkshopOutbox.
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {artifactsDir, storeArtifact, type ArtifactKind} from './artifacts.ts';
import type {Event} from './store.ts';

export const OUTBOX_DIR='workshop-outbox';
export type OutboxMeta={title:string;cat:string;kind:ArtifactKind;toolId:string;at:string};
type Journal={state:{events:Event[]};emit(type:string,data:any):Event};

// Two files per item: the bytes, then the metadata. Metadata is written last, so an import never sees a half-written item.
export function writeOutbox(dataDir:string,meta:OutboxMeta,bytes:Buffer):void{
  const dir=join(dataDir,OUTBOX_DIR);
  mkdirSync(dir,{recursive:true});
  const id=randomUUID();
  writeFileSync(join(dir,`${id}.bin`),bytes);
  writeFileSync(join(dir,`${id}.json`),JSON.stringify(meta));
}

// Copies every complete item into the world's artifact store, then removes it from the outbox. A refused item is dropped and counted.
export function importWorkshopOutbox(dataDir:string,journal:Journal):{imported:number;refused:number}{
  const dir=join(dataDir,OUTBOX_DIR);
  if(!existsSync(dir))return {imported:0,refused:0};
  let imported=0,refused=0;
  for(const name of readdirSync(dir)){
    if(!name.endsWith('.json'))continue;
    const id=name.slice(0,-'.json'.length);
    const binPath=join(dir,`${id}.bin`);
    const metaPath=join(dir,name);
    try{
      if(!existsSync(binPath))throw new Error('no file');
      const meta=JSON.parse(readFileSync(metaPath,'utf8')) as OutboxMeta;
      const bytes=readFileSync(binPath);
      storeArtifact({journal,dir:artifactsDir(dataDir),cat:String(meta.cat),task:null,project:null,title:String(meta.title),kind:meta.kind,bytes});
      imported++;
    }catch{
      // A refused item (world gallery full, bad bytes, unreadable metadata) is dropped so it cannot block the rest.
      refused++;
    }
    rmSync(binPath,{force:true});
    rmSync(metaPath,{force:true});
  }
  return {imported,refused};
}

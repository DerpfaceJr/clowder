// Restore (plan 7.6, durability §5): Clowder menu > Restore a backup… puts a point in time back: a portable backup folder (7.5) or a
// snapshot on this computer (backups/pre-* from 7.1, or backups/before-restore-* to undo a restore).
//
// Two halves, so the town's files are only ever whole. stageRestore() writes the complete restored tree into backups/restore-staging-<hex>/
// while the server still runs, and fails without touching the data folder: every blob is checked first (backup.ts), and the saved keys are
// re-saved through this computer's SecretStore (safeStorage, by the desktop app's main process), never written in plain text. Then the
// desktop app stops the server and applyRestore() swaps: the current town files move to backups/before-restore-<time>/, then the staged
// ones move in. Both are renames inside the data folder's volume. An intent file written before the first rename lets any failure, or a
// power cut, be put back: a thrown step is undone at once, and the next server boot runs recoverRestore() before anything reads the data.
//
// Which files are the town's: the 7.1 snapshot's allow list (journals, settings, secrets.v2.json, checkpoints, artifacts, plugins, worlds/)
// plus what is rebuilt from them (read-model.db, the wiki/ mirror). Everything else stays: devices.json, push keys, the tunnel, browser
// sign-ins, backup.json, last-boot.json and backups/ itself. Saved keys follow the same split (backup.ts secretIn): a key that travels with
// a backup comes from the restored point; a key bound to this computer (rendezvous, push, device tokens, the recovery key) stays as it is.
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,rmdirSync,statSync,copyFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {writeJsonAtomic} from './atomic-json.ts';
import {Backups,openBackup,restoreBackup,retryBusy,secretIn} from './backup.ts';
import {CONFIG,DIRS,PRE,isJournal} from './snapshot.ts';
import {SECRET_FIELDS,SecretStore,ipcBroker,type Broker} from './secret-store.ts';

const err=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const BEFORE=/^before-restore-(\d{4}-\d\d-\d\dT[\d-]+Z)$/;
const STAGING=/^restore-staging-[0-9a-f]{8}$/,LEFTOVER=/^restore-staging-[0-9a-f]{8}(\.restore-[0-9a-f]{8})?$/;
const INTENT='restore-intent.json',READY='.restore-ready.json';
// Rebuilt from the journal, or stale once the journal changes: they move out with the town, and are never staged from a snapshot.
const DERIVED=/^(read-model\.db(-wal|-shm)?|wiki|season-[\w-]+\.lock)$/;
/** A top-level name in the data folder that belongs to the town, so a restore moves it out and may move one in. */
export const townEntry=(name:string)=>isJournal(name)||CONFIG.has(name)||DIRS.includes(name)||name==='worlds'||DERIVED.test(name);
const stampAt=(stamp:string)=>stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/,'T$1:$2:$3.$4Z');

export type Snapshot={id:string;kind:'pre'|'before-restore';at:string;commit:string|null};
/** The snapshots on this computer, newest first: pre-<commit>-<time> (before an update) and before-restore-<time> (before a restore). */
export function listSnapshots(dataDir:string):Snapshot[]{
  const dir=join(dataDir,'backups');
  if(!existsSync(dir))return [];
  return readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&(PRE.test(e.name)||BEFORE.test(e.name))&&readdirSync(join(dir,e.name)).length>0).map(e=>{
    const pre=PRE.exec(e.name);
    return pre?{id:e.name,kind:'pre' as const,at:stampAt(pre[1]!),commit:/^pre-(\w+)-/.exec(e.name)![1]!}:{id:e.name,kind:'before-restore' as const,at:stampAt(BEFORE.exec(e.name)![1]!),commit:null};
  }).sort((a,b)=>b.at.localeCompare(a.at));
}

/** This computer's own saved keys: the ones that never travel in a backup, so a restore keeps them. */
export const machineSecrets=(store:SecretStore):Record<string,unknown>=>
  Object.fromEntries(Object.keys(SECRET_FIELDS).flatMap(name=>Object.entries(store.of(name))).filter(([ref])=>!secretIn(ref)));
const portable=(store:SecretStore)=>Object.fromEntries(Object.keys(SECRET_FIELDS).flatMap(name=>Object.entries(store.of(name))).filter(([ref])=>secretIn(ref)));

// A snapshot's tree, files and folders only (no link is followed), less its secrets.v2.json (re-saved below) and what is rebuilt.
function copySnapshot(from:string,to:string):number{
  let n=0;
  const walk=(src:string,dst:string,depth:string[])=>{
    mkdirSync(dst,{recursive:true});
    for(const e of readdirSync(src,{withFileTypes:true})){
      const at=[...depth,e.name],top=at.length===1||(at[0]==='worlds'&&at.length===3);
      if(top&&(DERIVED.test(e.name)||(at.length===1&&!townEntry(e.name))))continue;
      if(at.length===1&&e.name==='secrets.v2.json')continue;
      if(e.isDirectory())walk(join(src,e.name),join(dst,e.name),at);
      else if(e.isFile()){copyFileSync(join(src,e.name),join(dst,e.name));n++;}
    }
  };
  walk(from,to,[]);
  return n;
}

// The saved keys, through a SecretStore on this computer's broker: each value encrypted by safeStorage, then read back and compared.
async function saveSecrets(dir:string,broker:Broker,entries:[string,unknown][]){
  if(!entries.length)return;
  const store=new SecretStore(dir,broker);await store.load();
  if(store.mode!=='encrypted')throw err('Saved keys cannot be encrypted on this computer, so nothing was restored.',409);
  store.update(entries);await store.flush();
  if(store.error)throw err('Saved keys could not be encrypted on this computer, so nothing was restored.',409);
  const back=new SecretStore(dir,broker);await back.load();
  if(back.mode!=='encrypted'||entries.some(([ref,v])=>JSON.stringify(back.get(ref))!==JSON.stringify(v)))throw err('Saved keys did not read back after encrypting, so nothing was restored.',409);
}

export type Source={kind:'backup';folder:string;recoveryKey:string;n?:number}|{kind:'snapshot';id:string};
export type Staged={staging:string;label:string;at:string|null;n:number|null;damaged:number[];files:number;secrets:number};
// A staging folder a failed or abandoned restore left: only names this module makes, and never while a swap is half done.
function sweep(backups:string){
  if(existsSync(join(backups,INTENT)))throw err('A restore was interrupted. Restart Clowder to finish putting the files back.',409);
  for(const f of readdirSync(backups))if(LEFTOVER.test(f))rmSync(join(backups,f),{recursive:true,force:true});
}
/**
 * Writes the chosen point, complete, into backups/restore-staging-<hex>/ and returns it. Nothing in the data folder changes. keep: this
 * computer's own saved keys (machineSecrets of the live store). broker: safeStorage, through the desktop app; without it nothing is restored,
 * since the keys would otherwise be written in plain text.
 */
export async function stageRestore(o:{dataDir:string;source:Source;broker:Broker;keep:Record<string,unknown>}):Promise<Staged>{
  const backups=join(resolve(o.dataDir),'backups');
  mkdirSync(backups,{recursive:true});
  sweep(backups);
  const staging=join(backups,`restore-staging-${randomBytes(4).toString('hex')}`);
  try{
    let carried:Record<string,unknown>,label:string,at:string|null,n:number|null=null,damaged:number[]=[],files:number;
    if(o.source.kind==='backup'){
      const {folder,recoveryKey}=o.source;
      // A point picked by number still reports the newer points that did not open, so the owner sees why it is not the newest.
      const points=openBackup(folder,recoveryKey).points();
      const r=restoreBackup(folder,recoveryKey,staging,o.source.n===undefined?{}:{n:o.source.n});
      damaged=o.source.n===undefined?r.damaged:points.filter(p=>!p.ok&&p.n>r.n).map(p=>p.n);
      carried=r.secrets;n=r.n;at=r.at;files=r.files;label=`backup point ${r.n}`;
    }else{
      const {id}=o.source,dir=join(backups,id);
      if(!(PRE.test(id)||BEFORE.test(id))||!existsSync(dir)||!statSync(dir).isDirectory())throw err('That snapshot is not on this computer.',404);
      files=copySnapshot(dir,staging);
      // Its saved keys open here, on the computer that took it; only the ones that travel are taken from it.
      const old=new SecretStore(dir,o.broker);await old.load();
      if(!old.active)throw err('The saved keys in that snapshot cannot be opened on this computer, so nothing was restored.',409);
      carried=portable(old);at=listSnapshots(o.dataDir).find(s=>s.id===id)?.at??null;label=id;
    }
    if(!files)throw err('That point in time holds no files, so nothing was restored.');
    const entries=[...Object.entries(o.keep).filter(([ref])=>!secretIn(ref)),...Object.entries(carried).filter(([ref])=>secretIn(ref))];
    await saveSecrets(staging,o.broker,entries);
    for(const name of readdirSync(staging))if(!townEntry(name))throw err('That point in time holds a file outside the town, so nothing was restored.');
    writeJsonAtomic(join(staging,READY),{label,at});
    return {staging,label,at,n,damaged,files,secrets:entries.length};
  }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
}

type Intent={before:string;staging:string;out:string[];in:string[]};
export type Rename=(from:string,to:string)=>void;
const fsyncDir=(dir:string)=>{try{const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}catch{/* Windows cannot open a folder to fsync it */}};
// Puts every moved name back, newest move first. Each step checks where the name is, so it can run again after a crash part way.
async function undo(dataDir:string,i:Intent,rename:Rename){
  for(const name of [...i.in].reverse())if(existsSync(join(dataDir,name))&&!existsSync(join(i.staging,name)))await retryBusy(()=>rename(join(dataDir,name),join(i.staging,name)));
  for(const name of [...i.out].reverse())if(existsSync(join(i.before,name))&&!existsSync(join(dataDir,name)))await retryBusy(()=>rename(join(i.before,name),join(dataDir,name)));
}
const removeIfEmpty=(dir:string)=>{try{if(existsSync(dir)&&!readdirSync(dir).length)rmdirSync(dir);}catch{/* left for the owner */}};
/**
 * The swap, with the server stopped. The current town files move to backups/before-restore-<time>/, then the staged ones move in. A step
 * that throws puts everything back before rethrowing, so the data folder holds either the old town or the restored one, whole. rename: a
 * test passes one that fails part way.
 */
export async function applyRestore(dataDir:string,staging:string,o:{rename?:Rename;now?:()=>Date}={}){
  const data=resolve(dataDir),backups=join(data,'backups'),rename=o.rename??renameSync;
  staging=resolve(staging);
  if(dirname(staging)!==backups||!STAGING.test(basename(staging))||!existsSync(join(staging,READY)))throw err('That restore was not prepared completely, so nothing was changed.',409);
  if(existsSync(join(backups,INTENT)))throw err('A restore was interrupted. Restart Clowder to finish putting the files back.',409);
  const stamp=(o.now?.()??new Date()).toISOString().replace(/[:.]/g,'-');
  const i:Intent={before:join(backups,`before-restore-${stamp}`),staging,out:readdirSync(data).filter(townEntry),in:readdirSync(staging).filter(f=>f!==READY)};
  if(i.in.some(f=>!townEntry(f)))throw err('That restore holds a file outside the town, so nothing was changed.',409);
  mkdirSync(i.before,{recursive:true});
  writeJsonAtomic(join(backups,INTENT),i);
  try{
    for(const name of i.out)await retryBusy(()=>rename(join(data,name),join(i.before,name)));
    for(const name of i.in)await retryBusy(()=>rename(join(staging,name),join(data,name)));
    fsyncDir(data);
  }catch(error){
    // If putting back fails too, the intent stays and the next boot finishes it (recoverRestore).
    await undo(data,i,rename);
    rmSync(join(backups,INTENT),{force:true});
    removeIfEmpty(i.before);
    rmSync(staging,{recursive:true,force:true});
    throw error;
  }
  rmSync(join(backups,INTENT),{force:true});
  rmSync(staging,{recursive:true,force:true});
  return {before:i.before,moved:i.out.length,restored:i.in.length};
}

/**
 * At boot, before anything reads the data: a swap the process did not finish (a crash, a power cut, or a failure while putting back) is
 * finished when every staged name had moved in, else put back. Returns what it did, or null when there was nothing to do.
 */
export async function recoverRestore(dataDir:string,rename:Rename=renameSync):Promise<'finished'|'rolled-back'|null>{
  const data=resolve(dataDir),backups=join(data,'backups'),file=join(backups,INTENT);
  if(!existsSync(file))return null;
  let i:Intent;
  try{i=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error(`${file} is damaged. Move it aside and restore a backup again.`);}
  const inside=(p:unknown)=>typeof p==='string'&&dirname(resolve(p))===backups;
  const names=(a:unknown)=>Array.isArray(a)&&a.every(n=>typeof n==='string'&&townEntry(n));
  if(!inside(i.before)||!inside(i.staging)||!names(i.out)||!names(i.in))throw new Error(`${file} is damaged. Move it aside and restore a backup again.`);
  const done=i.in.every(n=>!existsSync(join(i.staging,n))&&existsSync(join(data,n)))&&i.out.every(n=>i.in.includes(n)||!existsSync(join(data,n)));
  if(!done){await undo(data,i,rename);removeIfEmpty(i.before);}
  rmSync(file,{force:true});
  rmSync(i.staging,{recursive:true,force:true});
  return done?'finished':'rolled-back';
}

/**
 * The desktop app's worker (main.cjs), run with the server stopped. list: the snapshots. apply: the swap of a staging folder the server
 * prepared. snapshot: when the town cannot open, a snapshot staged and swapped here, its keys re-saved through the app's safeStorage broker.
 */
export async function restoreWorker(job:{dataDir:string;list?:boolean;apply?:string;snapshot?:string}){
  const dataDir=resolve(job.dataDir);
  if(job.list)return {snapshots:listSnapshots(dataDir)};
  await recoverRestore(dataDir);
  if(job.apply)return applyRestore(dataDir,job.apply);
  if(!job.snapshot)throw err('Nothing to restore.');
  const broker=ipcBroker();
  if(!broker||!await broker.available().catch(()=>false))throw err('Saved keys cannot be encrypted on this computer, so nothing was restored.',409);
  const live=new SecretStore(dataDir,broker);await live.load();
  if(!live.active)throw err('The saved keys on this computer cannot be opened, so nothing was restored.',409);
  const staged=await stageRestore({dataDir,source:{kind:'snapshot',id:job.snapshot},broker,keep:machineSecrets(live)});
  return {...staged,...await applyRestore(dataDir,staged.staging)};
}

export type RestoreDeps={
  dataDir:string;backups:Backups;
  // The desktop app's broker when the store is encrypted with it; undefined under npm start, which cannot stop and restart itself.
  broker:()=>Broker|undefined;
  live:()=>SecretStore;
  busy:()=>string|null;
  // After staging: hold the town still and ask the desktop app to stop the server, swap and restart (process.send in server.ts).
  handOff:(staging:string)=>void;
};
// Main listener only. owner: what can be restored (snapshot names and times, the backup folder; never a key). host: everything that takes
// the recovery key or replaces the town, so the key is typed on the host computer only and never leaves it.
export function registerRestoreRoutes(app:FastifyInstance,d:RestoreDeps,gates:{owner:(req:FastifyRequest)=>boolean;host:(req:FastifyRequest)=>boolean}){
  const gate=(allowed:(req:FastifyRequest)=>boolean,error:string)=>async(req:FastifyRequest,reply:FastifyReply)=>{if(!allowed(req))return reply.code(403).send({error});};
  const owner=gate(gates.owner,'Restore is managed on the host computer.'),host=gate(gates.host,'Restore runs on the host computer only.');
  const body=(properties:object,required:string[])=>({body:{type:'object',additionalProperties:false,required,properties}});
  const keyFor=(folder:string,typed?:string)=>{
    if(!isAbsolute(folder))throw err('Give the full path of the backup folder.');
    const key=typed?.trim()||d.backups.savedKeyFor(folder);
    if(!key)throw err('Type the recovery key for that folder.');
    return key;
  };
  let restoring=false;
  app.get('/api/restore',{onRequest:owner},async()=>{
    const s=d.backups.status();
    return {desktop:!!d.broker(),restoring,snapshots:listSnapshots(d.dataDir),backup:{folder:s.folder,keySaved:s.keySaved}};
  });
  const folderKey={folder:{type:'string',minLength:1,maxLength:1024},recoveryKey:{type:'string',maxLength:64}};
  app.post('/api/restore/points',{onRequest:host,schema:body(folderKey,['folder'])},async req=>{
    const {folder,recoveryKey}=req.body as {folder:string;recoveryKey?:string};
    return {points:openBackup(resolve(folder),keyFor(folder,recoveryKey)).points()};
  });
  app.post('/api/restore',{onRequest:host,schema:body({source:{type:'string',enum:['backup','snapshot']},...folderKey,n:{type:'integer',minimum:1},id:{type:'string',maxLength:200}},['source'])},async req=>{
    const b=req.body as {source:'backup'|'snapshot';folder?:string;recoveryKey?:string;n?:number;id?:string};
    const broker=d.broker();
    if(!broker)throw err('Restore runs in the Clowder desktop app: it stops the town, puts the files back and starts it again.',409);
    if(restoring)throw err('A restore is already under way.',409);
    const busy=d.busy();if(busy)throw err(busy,409);
    const live=d.live();
    if(!live.active)throw err('The saved keys on this computer cannot be opened, so nothing was restored.',409);
    const source:Source=b.source==='backup'
      ?(()=>{if(!b.folder)throw err('Choose the backup folder.');return {kind:'backup' as const,folder:resolve(b.folder),recoveryKey:keyFor(b.folder,b.recoveryKey),...(b.n?{n:b.n}:{})};})()
      :(()=>{if(!b.id)throw err('Choose a snapshot.');return {kind:'snapshot' as const,id:b.id};})();
    restoring=true;
    try{
      const staged=await stageRestore({dataDir:d.dataDir,source,broker,keep:machineSecrets(live)});
      d.handOff(staged.staging);
      return {restarting:true,label:staged.label,at:staged.at,n:staged.n,damaged:staged.damaged,files:staged.files};
    }catch(error){restoring=false;throw error;}
  });
}

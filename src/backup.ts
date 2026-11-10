// Portable encrypted backups (plan 7.5, durability §5): a folder the owner picks (OneDrive, Google Drive, a USB stick) gets an encrypted copy of
// the town that opens on any computer with the folder and the recovery key alone. No safeStorage, no data folder and no SecretStore are needed
// to read it back: restoreBackup() takes only the folder, the key and an empty target.
//
// Keys. The recovery key is 128 random bits, shown once to the owner as 26 base32 characters and kept on this computer as a SecretStore ref
// (backup.json#recoveryKey), so hourly runs never ask for it. HKDF-SHA256 derives the AES-256-GCM key from it; a random key needs no salt or
// scrypt. Every encryption takes a fresh 12-byte nonce, and its associated data is the file's own name, so two valid files swapped are refused.
//
// The folder. clowder-backup.json (plain: a format number and an HMAC that tells the right key from a wrong one), blobs/<random>.bin (each one
// file's bytes, or a journal's appended bytes, encrypted) and manifest-<n>.enc (encrypted: every file's path, size, SHA-256 and the blobs that
// make it, plus the saved keys' blob). Names say nothing about what is inside. A blob is written once and never changed.
//
// A run. The base is the newest manifest that opens. A journal whose backed-up bytes are still the file's start gets one new blob of what was
// appended; a journal that shrank or changed (compaction, bit rot) gets a new full blob. Other files get a new blob only when their hash changes.
// Every file goes in as <name>.tmp-<hex>, fsynced, then renamed, retried while a sync client holds it (EBUSY); the manifest goes last. An
// interrupted run therefore leaves the last good point whole, and the next run simply runs again from it. The newest 3 manifests are kept, so a
// half-synced newest one falls back to the one before; a blob no kept manifest names is deleted after a good run.
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,rmdirSync,statSync,writeFileSync} from 'node:fs';
import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes} from 'node:crypto';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {same} from './access.ts';
import {writeJsonAtomic} from './atomic-json.ts';
import {healthOf,type Health} from './health.ts';
import {CONFIG,DIRS,isJournal} from './snapshot.ts';
import {SECRETS_FILE,SECRET_FIELDS,storeFor,withSecrets,withoutSecrets} from './secret-store.ts';

const FORMAT=1,HEADER='clowder-backup.json',BLOBS='blobs',KEEP=3;
// ponytail: a journal that grows every hour gains a blob per run; past this many it is copied whole once, so a manifest stays small.
const MAX_PARTS=256;
// Every blob the newest point names is opened and checked once in this many runs (runBackup). 24: a day at one run an hour (ASSUMED).
const CHECK_RUNS=24;
const MAGIC=Buffer.from('CLB1'),OVERHEAD=MAGIC.length+12+16; // magic, nonce, tag
const MANIFEST=/^manifest-(\d{6,})\.enc$/,BLOB=/^[0-9a-f]{16}\.bin$/,TMP=/\.tmp-[0-9a-f]{8}$/;
const manifestName=(n:number)=>`manifest-${String(n).padStart(6,'0')}.enc`;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const err=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});

// ---- The recovery key: 16 random bytes as RFC 4648 base32, in groups of 6-5-5-5-5. Read back case-blind, with or without dashes and spaces.
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',GROUPS=[6,5,5,5,5];
const BAD_KEY='That is not a Clowder recovery key: it has 26 letters and digits, such as ABCDEF-GHIJK-LMNOP-QRST2-34567.';
export function newRecoveryKey():string{
  let bits=0,acc=0,out='';
  for(const b of randomBytes(16)){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=B32[(acc>>bits)&31];}acc&=(1<<bits)-1;}
  if(bits)out+=B32[(acc<<(5-bits))&31];
  let at=0;return GROUPS.map(n=>out.slice(at,at+=n)).join('-');
}
export function parseRecoveryKey(text:string):Buffer{
  const s=String(text).toUpperCase().replace(/[\s-]/g,'');
  if(!/^[A-Z2-7]{26}$/.test(s))throw err(BAD_KEY);
  let bits=0,acc=0;const out:number[]=[];
  for(const ch of s){acc=(acc<<5)|B32.indexOf(ch);bits+=5;if(bits>=8){bits-=8;out.push((acc>>bits)&255);}acc&=(1<<bits)-1;}
  if(out.length!==16||acc!==0)throw err(BAD_KEY);
  return Buffer.from(out);
}
export const lastGroup=(key:string)=>key.split('-').at(-1)!;

type Keys={enc:Buffer;check:string};
function keysFor(recoveryKey:string):Keys{
  const raw=parseRecoveryKey(recoveryKey);
  const derive=(use:string)=>Buffer.from(hkdfSync('sha256',raw,'clowder-backup',`clowder-backup-v1 ${use}`,32));
  return {enc:derive('enc'),check:createHmac('sha256',derive('check')).update('clowder-backup').digest('hex')};
}
function seal(key:Buffer,name:string,plain:Buffer):Buffer{
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
  c.setAAD(Buffer.from(name));
  const body=Buffer.concat([c.update(plain),c.final()]);
  return Buffer.concat([MAGIC,iv,c.getAuthTag(),body]);
}
function unseal(key:Buffer,name:string,box:Buffer):Buffer{
  if(box.length<OVERHEAD||!box.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('not a backup file');
  const d=createDecipheriv('aes-256-gcm',key,box.subarray(4,16),{authTagLength:16});
  d.setAAD(Buffer.from(name));d.setAuthTag(box.subarray(16,32));
  return Buffer.concat([d.update(box.subarray(32)),d.final()]);
}

// ---- What goes in. The 7.1 snapshot's allow list (snapshot.ts), less secrets.v2.json, whose values go in decrypted here and re-encrypted with
// the backup key (the file itself opens only on this computer), and less season .lock and .log files, which are not journals. So read-model.db,
// pre-compact files, *.pre-secrets-*.bak, devices.json, push-subscriptions.json, remote-settings.json, rendezvous.json, vapid.json,
// cat-browser.json, backup.json, tunnel/, browser/, wiki/ and backups/ never reach the folder.
type InFile={rel:string;abs:string;journal:boolean};
export function inFiles(dataDir:string):InFile[]{
  const out:InFile[]=[];
  const tree=(abs:string,rel:string)=>{for(const e of readdirSync(abs,{withFileTypes:true})){const a=join(abs,e.name),r=`${rel}/${e.name}`;if(e.isDirectory())tree(a,r);else if(e.isFile())out.push({rel:r,abs:a,journal:false});}};
  const folder=(abs:string,prefix:string)=>{
    for(const e of readdirSync(abs,{withFileTypes:true})){
      const a=join(abs,e.name),r=prefix+e.name;
      if(e.isFile()&&isJournal(e.name)&&e.name.endsWith('.jsonl'))out.push({rel:r,abs:a,journal:true});
      else if(e.isFile()&&CONFIG.has(e.name)&&e.name!==SECRETS_FILE)out.push({rel:r,abs:a,journal:false});
      else if(e.isDirectory()&&DIRS.includes(e.name))tree(a,r);
    }
  };
  if(!existsSync(dataDir))return out;
  folder(dataDir,'');
  const worlds=join(dataDir,'worlds');
  if(existsSync(worlds))for(const e of readdirSync(worlds,{withFileTypes:true}))if(e.isDirectory())folder(join(worlds,e.name),`worlds/${e.name}/`);
  return out.sort((a,b)=>a.rel.localeCompare(b.rel));
}
// Which saved keys travel. Durability §9 leaves each ref's portability UNRESOLVED; the rule chosen: a ref whose file is on the IN list (or is
// one of the two secret-only files beside connectors and real money), less the Telegram and Discord device tokens, which are device cookies
// (devices.json is OUT). So rendezvous.json#key, vapid.json, cat-browser.json and backup.json#recoveryKey stay here by construction.
const SECRET_FILES_IN=new Set([...CONFIG,'connector-secrets.json','real-money-secrets.json']);
export const secretIn=(ref:string)=>{const [file,path]=ref.split('#');return SECRET_FILES_IN.has(file!)&&path!=='deviceToken';};
export const secretsOf=(dataDir:string):Record<string,unknown>=>{
  const s=storeFor(dataDir);
  return Object.fromEntries(Object.keys(SECRET_FIELDS).flatMap(name=>Object.entries(s.of(name))).filter(([r])=>secretIn(r)).sort(([a],[b])=>a.localeCompare(b)));
};

// ---- Writing into a sync folder.
// OneDrive holds a file it is uploading: Windows reports EBUSY, and EPERM or EACCES on a rename over it. Each is retried with a growing wait.
const BUSY=new Set(['EBUSY','EPERM','EACCES']);
export async function retryBusy<T>(fn:()=>T,tries=6,wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))):Promise<T>{
  for(let i=1;;i++){
    try{return fn();}
    catch(error){if(i>=tries||!BUSY.has((error as NodeJS.ErrnoException).code??''))throw error;await wait(100*2**(i-1));}
  }
}
export type Writer=(file:string,data:Buffer)=>void;
/** A temp name in the same folder, fsynced, then renamed: a sync client never uploads half a file under its real name. */
export const writeOnce:Writer=(file,data)=>{
  const tmp=`${file}.tmp-${randomBytes(4).toString('hex')}`;
  try{const fd=openSync(tmp,'w');try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);}
  catch(error){rmSync(tmp,{force:true});throw error;}
};

// ---- The manifest.
type Part={blob:string;from:number;size:number;sha256:string};
type FileEntry={path:string;size:number;sha256:string;parts:Part[]};
export type Manifest={format:1;n:number;at:string;files:FileEntry[];secrets:Part|null};
export type Point={n:number;at:string|null;ok:boolean;error?:string};

function readHeader(folder:string):{check:string}|null{
  const file=join(folder,HEADER);
  if(!existsSync(file))return null;
  try{const h=JSON.parse(readFileSync(file,'utf8'));if(h?.format!==FORMAT||typeof h.check!=='string')throw 0;return h;}
  catch{throw err(`${HEADER} in the backup folder is damaged.`);}
}
const OTHER_KEY='That folder holds Clowder backups made with another recovery key. Pick an empty folder.';
// The folder's blobs and manifests, read with keys already checked against the header.
function vault(folder:string,keys:Keys){
  const numbers=()=>(existsSync(folder)?readdirSync(folder):[]).map(f=>Number(MANIFEST.exec(f)?.[1])).filter(n=>n>0).sort((a,b)=>b-a);
  const manifest=(n:number):Manifest=>{
    const name=manifestName(n);
    try{
      const m=JSON.parse(unseal(keys.enc,name,readFileSync(join(folder,name))).toString('utf8'));
      if(m?.format!==FORMAT||m.n!==n||!Array.isArray(m.files))throw 0;
      return m;
    }catch{throw err(`Backup point ${n} (${name}) is damaged or was changed.`);}
  };
  const blob=(name:string,expect?:{size:number;sha256:string}):Buffer=>{
    const file=join(folder,BLOBS,name);
    if(!BLOB.test(name)||!existsSync(file))throw err(`Backup file ${BLOBS}/${name} is missing.`);
    let plain:Buffer;
    try{plain=unseal(keys.enc,`${BLOBS}/${name}`,readFileSync(file));}catch{throw err(`Backup file ${BLOBS}/${name} is damaged or was changed.`);}
    if(expect&&(plain.length!==expect.size||sha(plain)!==expect.sha256))throw err(`Backup file ${BLOBS}/${name} does not match its manifest.`);
    return plain;
  };
  return {numbers,manifest,blob};
}
/** A backup folder opened with its recovery key: its points in time (newest first), each manifest and each blob. Throws on a wrong key. */
export function openBackup(folder:string,recoveryKey:string){
  const keys=keysFor(recoveryKey),header=readHeader(folder);
  if(!header)throw err('There is no Clowder backup in that folder.');
  if(!same(header.check,keys.check))throw err('This recovery key does not open the backups in that folder.');
  const v=vault(folder,keys);
  const points=():Point[]=>v.numbers().map(n=>{try{return {n,at:v.manifest(n).at,ok:true};}catch(e){return {n,at:null,ok:false,error:(e as Error).message};}});
  return {...v,points};
}

export type RunResult={n:number;at:string;files:number;written:{path:string;from:number;size:number}[];reused:number;bytes:number};
/** One backup run. secrets: the saved keys to carry (secretsOf). write: the file writer, retried while busy (tests pass one that fails). */
export async function runBackup(opts:{dataDir:string;folder:string;recoveryKey:string;secrets:Record<string,unknown>;now?:()=>Date;write?:Writer}):Promise<RunResult>{
  const {dataDir,folder}=opts,keys=keysFor(opts.recoveryKey),write=opts.write??writeOnce;
  const put=(rel:string,data:Buffer)=>retryBusy(()=>write(join(folder,rel),data));
  const header=readHeader(folder);
  if(header&&!same(header.check,keys.check))throw err(OTHER_KEY,409);
  mkdirSync(join(folder,BLOBS),{recursive:true});
  // Leftovers of an interrupted run: only names this module makes.
  for(const dir of [folder,join(folder,BLOBS)])for(const f of readdirSync(dir))if(TMP.test(f))await retryBusy(()=>rmSync(join(dir,f),{force:true}));
  if(!header)await put(HEADER,Buffer.from(`${JSON.stringify({format:FORMAT,cipher:'aes-256-gcm',kdf:'hkdf-sha256',check:keys.check})}\n`));
  const v=vault(folder,keys),numbers=v.numbers();
  // The base: the newest point that opens. A half-synced newest manifest is skipped, never built on.
  let prev:Manifest|null=null;
  for(const n of numbers){try{prev=v.manifest(n);break;}catch{/* the one before */}}
  const sizes=new Map(readdirSync(join(folder,BLOBS)).filter(f=>BLOB.test(f)).map(f=>[f,statSync(join(folder,BLOBS,f)).size]));
  // A blob a kept point names is trusted by its size, so a sync client's placeholders are not all downloaded each hour. Size cannot show a
  // changed byte, and one damaged part of the main journal sits in every kept point: the status would say backed up until a restore failed.
  // So each run also opens a share of the base point's blobs in turn (tag, size and hash, as restore checks them), all of them within
  // CHECK_RUNS runs. One that does not open is not intact, and its file is written whole again below.
  // ponytail: a blob damaged after its turn waits up to CHECK_RUNS runs (a day at one run an hour); check every blob each run if that is too long.
  const held=[...(prev?.files??[]).flatMap(f=>f.parts),...(prev?.secrets?[prev.secrets]:[])],bad=new Set<string>();
  const share=Math.ceil(held.length/CHECK_RUNS),turn=numbers[0]??0;
  for(let i=0;i<share;i++){const p=held[(turn*share+i)%held.length]!;try{v.blob(p.blob,p);}catch{bad.add(p.blob);}}
  const intact=(p:Part)=>!bad.has(p.blob)&&sizes.get(p.blob)===p.size+OVERHEAD;
  const written:RunResult['written']=[];let reused=0,bytes=0;
  const newPart=async(path:string,from:number,data:Buffer):Promise<Part>=>{
    const blob=`${randomBytes(8).toString('hex')}.bin`;
    await put(`${BLOBS}/${blob}`,seal(keys.enc,`${BLOBS}/${blob}`,data));
    written.push({path,from,size:data.length});bytes+=data.length;
    return {blob,from,size:data.length,sha256:sha(data)};
  };
  const before=new Map((prev?.files??[]).map(f=>[f.path,f]));
  const files:FileEntry[]=[];
  for(const f of inFiles(dataDir)){
    // ponytail: whole files in memory (the main journal is about 20 MB); stream if journals pass a few hundred MB.
    let data:Buffer;
    // A checkpoint can go between the walk and the read (Back up now does not wait for an idle town): it is gone, so it is not backed up.
    try{data=readFileSync(f.abs);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    // A journal is taken up to its last newline, so every point in time ends on a whole event.
    if(f.journal)data=data.subarray(0,data.lastIndexOf(10)+1);
    const old=before.get(f.rel),ok=!!old&&old.parts.every(intact);
    if(f.journal&&ok&&old!.size<=data.length&&old!.parts.length<MAX_PARTS){
      const h=createHash('sha256').update(data.subarray(0,old!.size));
      // Journals only grow: when last run's bytes are still the start of the file, only what follows is new.
      if(h.copy().digest('hex')===old!.sha256){
        const parts=[...old!.parts];reused+=parts.length;
        if(data.length>old!.size)parts.push(await newPart(f.rel,old!.size,data.subarray(old!.size)));
        files.push({path:f.rel,size:data.length,sha256:h.update(data.subarray(old!.size)).digest('hex'),parts});
        continue;
      }
    }
    const digest=sha(data);
    if(ok&&old!.size===data.length&&old!.sha256===digest){files.push(old!);reused+=old!.parts.length;continue;}
    files.push({path:f.rel,size:data.length,sha256:digest,parts:data.length?[await newPart(f.rel,0,data)]:[]});
  }
  const keyData=Buffer.from(JSON.stringify(opts.secrets)),keySha=sha(keyData);
  const secrets=prev?.secrets&&prev.secrets.sha256===keySha&&intact(prev.secrets)?(reused++,prev.secrets):await newPart('saved keys',0,keyData);
  const n=(numbers[0]??0)+1,at=(opts.now?.()??new Date()).toISOString(),name=manifestName(n);
  const m:Manifest={format:FORMAT,n,at,files,secrets};
  await put(name,seal(keys.enc,name,Buffer.from(JSON.stringify(m))));
  // Keep the newest KEEP points. A blob none of them names goes, unless one of them does not open: then its blobs are unknown and all stay.
  const all=[n,...numbers],kept=all.slice(0,KEEP);
  for(const old of all.slice(KEEP))await retryBusy(()=>rmSync(join(folder,manifestName(old)),{force:true}));
  let refs:Set<string>|null=new Set();
  for(const k of kept){
    let km:Manifest;
    try{km=k===n?m:v.manifest(k);}catch{refs=null;break;}
    for(const f of km.files)for(const p of f.parts)refs.add(p.blob);
    if(km.secrets)refs.add(km.secrets.blob);
  }
  if(refs)for(const b of readdirSync(join(folder,BLOBS)))if(BLOB.test(b)&&!refs.has(b))await retryBusy(()=>rmSync(join(folder,BLOBS,b),{force:true}));
  return {n,at,files:files.length,written,reused,bytes};
}

const safePath=(p:unknown)=>typeof p==='string'&&!!p&&!/[\\:]/.test(p)&&!p.startsWith('/')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');
/**
 * Restores one point (the newest that opens, unless n is given) into target, which must be missing or empty. Needs only the folder and the
 * recovery key. Every blob is checked (GCM tag, size, SHA-256) and every file against its manifest before anything is written, and the files
 * go to a temp folder renamed to target at the end, so a damaged backup leaves target as it was. The saved keys come back in memory only:
 * the caller puts them into its own SecretStore (7.6), never as plain text on disk. damaged: newer points that did not open.
 */
export function restoreBackup(folder:string,recoveryKey:string,target:string,opts:{n?:number}={}){
  const v=openBackup(folder,recoveryKey),damaged:number[]=[];
  let m:Manifest|null=null;
  if(opts.n!==undefined)m=v.manifest(opts.n);
  else for(const n of v.numbers()){try{m=v.manifest(n);break;}catch{damaged.push(n);}}
  if(!m)throw err(damaged.length?'Every backup point in that folder is damaged.':'That folder has no backup points yet.');
  if(existsSync(target)&&readdirSync(target).length)throw err('Restore into an empty folder.');
  // ponytail: the whole point is held in memory before writing (about 25 MB today).
  const out=m.files.map(f=>{
    if(!safePath(f.path))throw err(`Backup point ${m.n} names a path outside the data folder.`);
    const data=Buffer.concat(f.parts.map(p=>v.blob(p.blob,p)));
    if(data.length!==f.size||sha(data)!==f.sha256)throw err(`${f.path} in backup point ${m.n} does not match its manifest.`);
    return [f.path,data] as const;
  });
  const secrets:Record<string,unknown>=m.secrets?JSON.parse(v.blob(m.secrets.blob,m.secrets).toString('utf8')):{};
  const tmp=`${resolve(target)}.restore-${randomBytes(4).toString('hex')}`;
  try{
    mkdirSync(tmp,{recursive:true});
    for(const [path,data] of out){const file=join(tmp,...path.split('/'));mkdirSync(dirname(file),{recursive:true});writeFileSync(file,data,{flush:true});}
    if(existsSync(target))rmdirSync(target);
    renameSync(tmp,target);
  }catch(error){rmSync(tmp,{recursive:true,force:true});throw error;}
  return {n:m.n,at:m.at,files:out.length,secrets,damaged};
}

// ---- The owner's settings: backup.json holds the folder and the run results; its recoveryKey field lives in the SecretStore.
type Run={at:string;ok:boolean;error:string|null;n:number|null;bytes:number};
type Saved={folder?:string;enabled?:boolean;confirmed?:boolean;recoveryKey?:string;lastRun?:Run;lastGood?:{at:string;n:number};failingSince?:string};
export const SCHEDULE='Every hour at :17, when no task or season is running';
export class Backups{
  running=false;
  constructor(readonly dataDir:string,private now:()=>Date=()=>new Date()){}
  private get file(){return join(this.dataDir,'backup.json');}
  private read():Saved{let raw:Saved={};try{raw=JSON.parse(readFileSync(this.file,'utf8'));}catch{/* not set up */}return withSecrets(this.file,raw);}
  // A store that is not in use (locked, or legacy after a failed move) would hand the key back to be written as is: it is left out instead.
  private save(s:Saved){const {recoveryKey,...rest}=s;writeJsonAtomic(this.file,storeFor(this.dataDir).active?withoutSecrets(this.file,s):rest);}
  /** The integration contract (health.ts): off until backups are on, a folder is set and the key is confirmed. */
  health():Health{
    const s=this.read(),failed=s.lastRun?.ok===false;
    return healthOf(s.enabled===true&&!!s.folder&&s.confirmed===true,failed?s.lastRun!.error:null,failed&&s.failingSince?Date.parse(s.failingSince):null);
  }
  /** What the settings show. Never the key. */
  status(){
    const s=this.read();
    return {folder:s.folder??null,enabled:s.enabled===true,confirmed:s.confirmed===true,keySaved:!!s.recoveryKey,running:this.running,lastRun:s.lastRun??null,lastGood:s.lastGood??null,schedule:SCHEDULE};
  }
  /** Restore (7.6) on this computer: the saved key, only for the folder backups go to, so a same-PC restore never asks for it. Never sent out. */
  savedKeyFor(folder:string):string|undefined{
    const s=this.read();
    const norm=(p:string)=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
    return s.folder&&s.recoveryKey&&isAbsolute(String(folder))&&norm(String(folder))===norm(s.folder)?s.recoveryKey:undefined;
  }
  /**
   * Host only. Picks the folder. Until the owner has confirmed a key, each call makes a new one and returns it: it is shown this once and
   * kept only in the SecretStore. Once confirmed, the key stays and a new folder only moves where backups go.
   */
  setup(input:string):{recoveryKey?:string}{
    const store=storeFor(this.dataDir);
    if(!store.active)throw err('Saved keys are locked or could not be moved, so a recovery key cannot be kept safely here. Open Clowder from the desktop app first.',409);
    const text=String(input??'').trim();
    if(!text||!isAbsolute(text))throw err('Give the full path of a folder, such as D:\\Backups\\Clowder or a folder inside OneDrive.');
    const folder=resolve(text),rel=relative(resolve(this.dataDir),folder);
    if(!rel||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)))throw err("Pick a folder outside Clowder's own data folder.");
    try{if(!existsSync(folder))mkdirSync(folder);}catch{throw err('That folder cannot be made: check that the folder it goes in exists.');}
    if(!statSync(folder).isDirectory())throw err('That path is a file, not a folder.');
    const probe=join(folder,`.clowder-probe.tmp-${randomBytes(4).toString('hex')}`);
    try{writeFileSync(probe,'');rmSync(probe);}catch{throw err('Clowder cannot write to that folder.');}
    const s=this.read(),fresh=!s.confirmed||!s.recoveryKey,key=fresh?newRecoveryKey():s.recoveryKey!;
    const header=readHeader(folder);
    if(header&&!same(header.check,keysFor(key).check))throw err(OTHER_KEY,409);
    this.save({...s,folder,recoveryKey:key,confirmed:!fresh,enabled:fresh?false:s.enabled===true});
    return fresh?{recoveryKey:key}:{};
  }
  /** Host only. The owner types the key's last group back; only then do backups start. */
  confirm(group:string){
    const s=this.read();
    if(!s.folder||!s.recoveryKey)throw err('Choose a backup folder first.',409);
    if(s.confirmed)return;
    if(!same(String(group??'').toUpperCase().replace(/[\s-]/g,''),lastGroup(s.recoveryKey)))throw err('That is not the last group of the recovery key. Check what you wrote down.');
    this.save({...s,confirmed:true,enabled:true});
  }
  setEnabled(on:boolean){
    const s=this.read();
    if(on&&!s.confirmed)throw err('Choose a folder and confirm the recovery key first.',409);
    this.save({...s,enabled:on});
  }
  /** One run now. Its result, good or failed, goes on the status; a failure never replaces the last good run. */
  async run():Promise<RunResult>{
    if(this.running)throw err('A backup is already running.',409);
    const s=this.read();
    if(!s.folder||!s.confirmed)throw err('Choose a folder and confirm the recovery key first.',409);
    const at=this.now().toISOString();
    this.running=true;
    try{
      if(!s.recoveryKey)throw err('The recovery key cannot be read: saved keys are locked. Open Clowder from the desktop app.',409);
      const r=await runBackup({dataDir:this.dataDir,folder:s.folder,recoveryKey:s.recoveryKey,secrets:secretsOf(this.dataDir),now:this.now});
      this.record({lastRun:{at:r.at,ok:true,error:null,n:r.n,bytes:r.bytes},lastGood:{at:r.at,n:r.n},failingSince:undefined});
      return r;
    }catch(error){
      // failingSince: the first failed run after the last good one (11.21), so the owner hears of it once it has lasted.
      this.record({lastRun:{at,ok:false,error:(error as Error).message,n:null,bytes:0},failingSince:s.failingSince??at});
      throw error;
    }finally{this.running=false;}
  }
  private record(patch:Partial<Saved>){this.save({...this.read(),...patch});}
  /** The hourly slot (server.ts): runs only when backups are on and the town is idle. A failure is on the status, not thrown. */
  scheduled(idle:boolean){
    const s=this.read();
    if(idle&&!this.running&&s.enabled&&s.confirmed&&s.folder)void this.run().catch(()=>{/* recorded on the status */});
  }
}

// Main listener only. owner: the status, Back up now and on/off, the same gate as the other owner settings. host: choosing the folder and
// confirming the key, because setup is the one answer that carries the recovery key, and that is shown only on the host computer.
export function registerBackupRoutes(app:FastifyInstance,backups:Backups,gates:{owner:(req:FastifyRequest)=>boolean;host:(req:FastifyRequest)=>boolean}){
  const gate=(allowed:(req:FastifyRequest)=>boolean,error:string)=>async(req:FastifyRequest,reply:FastifyReply)=>{if(!allowed(req))return reply.code(403).send({error});};
  const owner=gate(gates.owner,'Backups are managed on the host computer.'),host=gate(gates.host,'The recovery key is shown only on the host computer.');
  const body=(properties:object,required:string[])=>({body:{type:'object',additionalProperties:false,required,properties}});
  app.get('/api/backup',{onRequest:owner},async()=>backups.status());
  app.post('/api/backup/setup',{onRequest:host,schema:body({folder:{type:'string',minLength:1,maxLength:1024}},['folder'])},async req=>({...backups.setup((req.body as {folder:string}).folder),status:backups.status()}));
  app.post('/api/backup/confirm',{onRequest:host,schema:body({lastGroup:{type:'string',minLength:1,maxLength:40}},['lastGroup'])},async req=>{
    backups.confirm((req.body as {lastGroup:string}).lastGroup);
    void backups.run().catch(()=>{/* recorded on the status */});
    return backups.status();
  });
  app.post('/api/backup/run',{onRequest:owner},async()=>backups.run());
  app.post('/api/backup/enabled',{onRequest:owner,schema:body({enabled:{type:'boolean'}},['enabled'])},async req=>{backups.setEnabled((req.body as {enabled:boolean}).enabled);return backups.status();});
}

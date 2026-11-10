// Pre-upgrade snapshot (plan 7.1, durability §2). On the first boot of a build whose {commit, builtAt} differs from data/last-boot.json,
// copy the world data into data/backups/pre-<commit>-<time>/ before the secret store, the journal replay or the read model can write.
// The layout is mirrored, so going back is a copy back. It walks an allow list, never readRegistry(): a damaged worlds.json is exactly when
// a copy matters. Out by construction: read-model.db, pre-compact files, *.pre-secrets-*.bak (plaintext), devices.json (device cookies),
// push-subscriptions.json, remote-settings.json, rendezvous.json, vapid.json, cat-browser.json, tunnel/, browser/, wiki/ (a mirror of the
// journal) and backups/ itself, and owner-key (plan 11.27, access.ts), which stays on this computer.
// Copy, not hard link: journals are appended in place, so a hard link would change with them. COPYFILE_FICLONE asks for a copy-on-write
// clone where the volume supports one (ReFS, Btrfs, APFS) and falls back to a plain copy on NTFS, about 25 MB per snapshot.
import {closeSync,constants,copyFileSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';
import {WORLD_FILE} from './world-reset.ts';
import {SECRETS_FILE} from './secret-store.ts';

export const KEEP=3; // ASSUMED in the plan
const LAST_BOOT='last-boot.json';
// Journals: the world files a reset moves, plus the real-money ledger, which has no other copy.
export const isJournal=(f:string)=>WORLD_FILE.test(f)||f==='purchases.jsonl';
// World and root settings from durability §5's IN list, the registry and the secret store as it is (safeStorage still opens it on this PC).
// Each name is taken wherever it sits, root or world folder. The 7.5 backup (backup.ts) walks the same lists.
export const CONFIG=new Set(['worlds.json',SECRETS_FILE,'town-settings.json','town-default.json','models.json','connectors.json','accounts.json',
  'oauth-clients.json','telegram.json','discord.json','ntfy.json','hermes.json','real-money.json']);
export const DIRS=['checkpoints','artifacts','plugins'];
export const PRE=/^pre-[\w]+-(\d{4}-\d\d-\d\dT[\d-]+Z)$/;

export type BootBuild={commit:string|null;builtAt:string|null};
export type SnapshotResult={skipped:'no-commit'|'same-build'}|{folder:string|null;files:number;pruned:string[]};

const fsyncFile=(file:string)=>{const fd=openSync(file,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}};
const copy=(from:string,to:string,sync:boolean)=>{copyFileSync(from,to,constants.COPYFILE_FICLONE);if(sync)fsyncFile(to);};
// A directory tree, files and folders only: a symlink is not followed out of the data folder.
function copyTree(from:string,to:string):number{
  mkdirSync(to,{recursive:true});
  let n=0;
  for(const e of readdirSync(from,{withFileTypes:true})){
    if(e.isDirectory())n+=copyTree(join(from,e.name),join(to,e.name));
    else if(e.isFile()){copy(join(from,e.name),join(to,e.name),false);n++;}
  }
  return n;
}
// One folder's allowed files (root or a world). Journals and config are fsynced; artifacts and plugins are not, since about 540 fsyncs
// would slow every upgrade boot and a crash before last-boot.json is written takes the snapshot again anyway.
function copyFolder(from:string,to:string):number{
  let n=0;
  for(const e of readdirSync(from,{withFileTypes:true})){
    if(e.isFile()&&(isJournal(e.name)||CONFIG.has(e.name))){mkdirSync(to,{recursive:true});copy(join(from,e.name),join(to,e.name),true);n++;}
    else if(e.isDirectory()&&DIRS.includes(e.name))n+=copyTree(join(from,e.name),join(to,e.name));
  }
  return n;
}

const readLastBoot=(dataDir:string):BootBuild|null=>{try{return JSON.parse(readFileSync(join(dataDir,LAST_BOOT),'utf8'));}catch{return null;}};

/** Takes the snapshot when this build is new to the data folder, keeps the newest KEEP pre-* folders, then records the build.
 *  The copy goes to a tmp- folder renamed to pre-* only when complete, so a pre-* folder is always whole. last-boot.json is written last,
 *  so a crash or an error part way means the next boot snapshots again. */
export function preUpgradeSnapshot(dataDir:string,build:BootBuild,now:()=>Date=()=>new Date()):SnapshotResult{
  if(!build.commit)return {skipped:'no-commit'};
  const last=readLastBoot(dataDir);
  if(last&&last.commit===build.commit&&(last.builtAt??null)===(build.builtAt??null))return {skipped:'same-build'};
  const backups=join(dataDir,'backups');
  const stamp=now().toISOString().replace(/[:.]/g,'-');
  const name=`pre-${build.commit.replace(/\W/g,'')}-${stamp}`,tmp=join(backups,`tmp-${name}`);
  let files=0,folder:string|null=null;
  if(existsSync(dataDir)){
    for(const f of existsSync(backups)?readdirSync(backups):[])if(f.startsWith('tmp-pre-'))rmSync(join(backups,f),{recursive:true,force:true});
    try{
      files=copyFolder(dataDir,tmp);
      const worlds=join(dataDir,'worlds');
      if(existsSync(worlds))for(const e of readdirSync(worlds,{withFileTypes:true}))if(e.isDirectory())files+=copyFolder(join(worlds,e.name),join(tmp,'worlds',e.name));
      if(files){folder=join(backups,name);renameSync(tmp,folder);}else rmSync(tmp,{recursive:true,force:true});
    }catch(err){rmSync(tmp,{recursive:true,force:true});throw err;}
  }
  const pruned=existsSync(backups)?readdirSync(backups).filter(f=>PRE.test(f)).sort((a,b)=>PRE.exec(b)![1]!.localeCompare(PRE.exec(a)![1]!)).slice(KEEP):[];
  for(const f of pruned)rmSync(join(backups,f),{recursive:true,force:true});
  writeJsonAtomic(join(dataDir,LAST_BOOT),{commit:build.commit,builtAt:build.builtAt??null},0o644);
  return {folder,files,pruned};
}

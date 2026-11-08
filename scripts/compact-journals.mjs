// Strips old checkpoint copies out of every world's events.jsonl: the model context on task.updated events, and the
// message copy on approval.requested events. Since ad1aecf the engine keeps both out of the journal; this cleans journals
// written before it. The newest context of a task still waiting is kept, because the engine resumes from it.
//
//   node scripts/compact-journals.mjs            compact every world (quit Clowder first)
//   node scripts/compact-journals.mjs --status   bytes each journal still spends on copies; changes nothing
//   node scripts/compact-journals.mjs --data <dir>   another data folder (default %APPDATA%\Clowder\data)
//
// One world at a time: the original is copied to events.jsonl.pre-compact-<time>, the new journal is written to a temp
// file, checked line for line, then renamed over the original. Ctrl-C is safe; run the same command again to finish.
import {closeSync,copyFileSync,existsSync,fsyncSync,openSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const args=process.argv.slice(2);
const at=args.indexOf('--data');
const dataDir=resolve(at>=0?args[at+1]:join(process.env.APPDATA??'','Clowder','data'));
const status=args.includes('--status');
const PAUSED=new Set(['waiting','waiting_child']);
const mb=n=>`${(n/1e6).toFixed(2)} MB`;

function worlds(){
  const file=join(dataDir,'worlds.json');
  if(!existsSync(file))return [{id:'home',name:'(no registry)',dir:'.'}];
  return JSON.parse(readFileSync(file,'utf8')).worlds;
}

/** Plans one journal: which lines change and how many bytes the copies take. Lines that do not change are kept byte for byte. */
export function plan(text){
  const lines=text.split('\n');
  // A line a newer build wrote (v above 1) is passed through byte for byte: this script knows only v1. Unknown types are never touched either.
  const events=lines.map(l=>{const e=l.trim()?JSON.parse(l):null;return e&&(e.v??1)===1?e:null;});
  // Final status per task, and the newest context-bearing update of each.
  const final=new Map(),newest=new Map();
  events.forEach((e,i)=>{
    if(!e)return;
    if(e.type==='task.created')final.set(e.data.id,e.data.status);
    if(e.type==='task.updated'){if(e.data.status)final.set(e.data.id,e.data.status);if(e.data.context)newest.set(e.data.id,i);}
  });
  let copyBytes=0,kept=0;const out=[...lines];
  events.forEach((e,i)=>{
    if(!e)return;
    let changed=false;const d={...e.data};
    if(e.type==='task.updated'&&d.context){
      if(PAUSED.has(final.get(d.id))&&newest.get(d.id)===i){kept++;return;}
      copyBytes+=JSON.stringify(d.context).length;delete d.context;changed=true;
    }
    if(e.type==='approval.requested'&&'messages' in d){copyBytes+=JSON.stringify(d.messages).length;delete d.messages;changed=true;}
    if(changed)out[i]=JSON.stringify({...e,data:d});
  });
  return {out,copyBytes,kept,count:lines.filter(l=>l.trim()).length};
}

function clowderRunning(){
  if(process.platform!=='win32')return false;
  try{const list=execFileSync('tasklist',['/FO','CSV','/NH'],{encoding:'utf8'});return /"(Clowder|electron)\.exe"/i.test(list);}
  catch{return true;}// cannot tell: assume it is running
}

// Runs only as a command; tests import plan().
if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const rows=[];
  for(const w of worlds()){
    const journal=join(dataDir,w.dir,'events.jsonl');
    if(!existsSync(journal)){rows.push({world:w.name,note:'no journal'});continue;}
    const before=statSync(journal),p=plan(readFileSync(journal,'utf8'));
    const backups=readdirSync(join(dataDir,w.dir)).filter(f=>f.startsWith('events.jsonl.pre-compact-')).length;
    rows.push({world:w.name,id:w.id,journal:mb(before.size),events:p.count,copies:mb(p.copyBytes),keptWaiting:p.kept,backups});
    if(status||!p.copyBytes)continue;
    if(clowderRunning()){console.error('Clowder (or an electron app) is running. Quit it first, then run this again.');process.exit(1);}
    const stamp=new Date().toISOString().replace(/[:.]/g,'-'),tmp=`${journal}.compact.tmp`;
    copyFileSync(journal,`${journal}.pre-compact-${stamp}`);
    const fd=openSync(tmp,'w');try{writeSync(fd,p.out.join('\n'));fsyncSync(fd);}finally{closeSync(fd);}
    // Same events, same order, every line parses: anything else and the original stays.
    const check=readFileSync(tmp,'utf8').split('\n'),orig=readFileSync(journal,'utf8').split('\n');
    const same=check.length===orig.length&&check.every((l,i)=>!l.trim()?!orig[i].trim():JSON.parse(l).id===JSON.parse(orig[i]).id);
    const after=statSync(journal);
    if(!same||after.size!==before.size||after.mtimeMs!==before.mtimeMs){rmSync(tmp,{force:true});console.error(`${w.name}: ${same?'the journal changed while compacting':'check failed'}; left as it was.`);process.exit(1);}
    renameSync(tmp,journal);
    rows.at(-1).now=mb(statSync(journal).size);
  }
  console.table(rows);
  if(!status)console.log('Done. Backups are the events.jsonl.pre-compact-* files; delete them once Clowder starts and looks right.');
}

// Hermes's runtime on first enable (plan 4.13, H2), for a packaged Clowder with no CAT_HERMES_PYTHON. The installer ships uv.exe and the pinned,
// pruned Hermes source in hermes-runtime/ (scripts/fetch-hermes-runtime.mjs). Three steps, each saved when it finishes, into <data>/hermes-runtime:
// source (the Hermes tree copied in: its editable install writes egg-info next to the code, and Program Files is read-only), python
// (`uv python install 3.14`, no shims on PATH and no registry entries) and sync (`uv sync --frozen --no-dev --extra mcp --extra sms` into a venv).
// A finished bootstrap starts no process at boot. An interrupted one resumes at its step; uv itself skips what is already there. A bundle with a
// new stamp (an app update) starts over. Offline is said as such; Hermes stays off and the rest of Clowder never waits on any of this.
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';

export const PYTHON='3.14';
export const STEPS=['source','python','sync'] as const;
export type Step=typeof STEPS[number];
const LABEL:Record<Step,string>={source:'Copying Hermes',python:`Installing Python ${PYTHON}`,sync:"Installing Hermes's packages"};
const ARGS:Record<Exclude<Step,'source'>,string[]>={python:['python','install',PYTHON,'--no-bin','--no-registry'],sync:['sync','--frozen','--no-dev','--extra','mcp','--extra','sms','--python',PYTHON]};
// What uv prints when it cannot reach the network (measured with uv 0.12.24, see test/hermes-bootstrap.test.ts).
export const OFFLINE=/dns error|failed to lookup address|no such host is known|could not resolve|error sending request|connection refused|tcp connect error|network is unreachable|operation timed out|failed to download|failed to fetch/i;
const LINES_MAX=50;
export type BootstrapState='unavailable'|'idle'|'running'|'done'|'failed';
export type BootstrapStatus={state:BootstrapState;step:Step|null;label:string|null;done:Step[];total:number;error:string|null;offline:boolean;failures:number;at:string|null;startedAt:string|null;/** The last finished setup: in all, and per step. */ms:number|null;stepMs:Partial<Record<Step,number>>;lines:string[]};
type Saved={stamp?:string;done?:Step[];error?:string|null;offline?:boolean;failures?:number;at?:string|null;ms?:number|null;stepMs?:Partial<Record<Step,number>>};

/** The whole tree: uv and the venv's python.exe launcher both have children. */
export function killTree(pid?:number){
  if(!pid)return;
  try{if(process.platform==='win32')execFileSync('taskkill',['/T','/F','/PID',String(pid)],{stdio:'ignore',windowsHide:true});else process.kill(pid,'SIGTERM');}catch{/* already gone */}
}

export class HermesBootstrap{
  private running?:Promise<string>;
  private child?:ChildProcess;
  private step:Step|null=null;
  private startedAt:string|null=null;
  private lines:string[]=[];
  private stopped=false;
  constructor(private o:{dataDir:string;/** hermes-runtime/ as shipped: uv.exe, src/, runtime.json. */bundle:string;/** Tests: the command run instead of uv.exe. */uv?:string[]}){}
  get dir(){return join(this.o.dataDir,'hermes-runtime');}
  get python(){return join(this.dir,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');}
  private get file(){return join(this.dir,'bootstrap.json');}
  private saved():Saved{try{return JSON.parse(readFileSync(this.file,'utf8'));}catch{return {};}}
  private save(patch:Saved){writeJsonAtomic(this.file,{...this.saved(),...patch},0o644);}
  /** The shipped pins (uv version and Hermes commit), or null when this Clowder has no bundle. */
  private stamp(){try{return readFileSync(join(this.o.bundle,'runtime.json'),'utf8').trim();}catch{return null;}}
  /** Finished for this bundle: the venv python, without starting anything. */
  ready(){const s=this.saved();return !!s.stamp&&s.stamp===this.stamp()&&STEPS.every(x=>s.done?.includes(x))&&existsSync(this.python);}

  status():BootstrapStatus{
    const s=this.saved(),stamp=this.stamp(),current=s.stamp===stamp;
    const state:BootstrapState=!stamp?'unavailable':this.running?'running':this.ready()?'done':current&&s.error?'failed':'idle';
    return {state,step:this.running?this.step:null,label:this.running&&this.step?LABEL[this.step]:null,done:current?s.done??[]:[],total:STEPS.length,error:current?s.error??null:null,offline:current&&s.offline===true,
      failures:s.failures??0,at:s.at??null,startedAt:this.running?this.startedAt:null,ms:s.ms??null,stepMs:s.stepMs??{},lines:[...this.lines]};
  }

  /** The venv python, building it first when needed. One run at a time; a second caller gets the same promise. */
  run():Promise<string>{return this.running??=this.go().finally(()=>{this.running=undefined;this.step=null;this.child=undefined;});}
  stop(){this.stopped=true;killTree(this.child?.pid);}

  private async go(){
    const stamp=this.stamp();
    if(!stamp)throw new Error('This Clowder has no bundled Hermes runtime (hermes-runtime/). Set CAT_HERMES_PYTHON or hermes.python, or run node scripts/fetch-hermes-runtime.mjs.');
    if(this.ready())return this.python;
    this.stopped=false;this.lines=[];this.startedAt=new Date().toISOString();
    const t0=Date.now(),prior=this.saved();
    // A new bundle starts over; a lost venv redoes everything (uv reuses its cache and the installed Python).
    let done:Step[]=prior.stamp===stamp?[...(prior.done??[])]:[];
    if(!existsSync(this.python))done=done.filter(x=>x!=='sync');
    this.save({stamp,done,error:null,offline:false,...(done.length?{}:{stepMs:{}})});
    try{
      for(const step of STEPS){
        if(done.includes(step))continue;
        this.step=step;const t=Date.now();
        // Async: about 8,000 files (11.6 s measured), and the server keeps answering meanwhile.
        if(step==='source'){await rm(join(this.dir,'src'),{recursive:true,force:true});await cp(join(this.o.bundle,'src'),join(this.dir,'src'),{recursive:true});}
        else await this.uv(ARGS[step],step==='sync'?join(this.dir,'src'):this.dir,step);
        if(this.stopped)throw new Error('Stopped.');
        done.push(step);this.save({done,stepMs:{...this.saved().stepMs,[step]:Date.now()-t}});
      }
      this.save({at:new Date().toISOString(),ms:Date.now()-t0,failures:0});
      return this.python;
    }catch(e){
      // Clowder closing is not a failure: the next start resumes at this step.
      if(this.stopped)throw new Error('Hermes setup was stopped; it resumes on the next start.');
      const offline=OFFLINE.test(this.lines.join('\n'));
      const error=offline?`No internet connection: Clowder could not download ${this.step==='python'?`Python ${PYTHON}`:"Hermes's packages"}. Hermes stays off and the rest of Clowder works. Connect and retry.`
        :`${LABEL[this.step!]} failed: ${(e as Error).message}`;
      this.save({error,offline,failures:(prior.failures??0)+1,at:new Date().toISOString()});
      throw new Error(error);
    }
  }

  private uv(args:string[],cwd:string,step:Step){
    const [file,...pre]=this.o.uv??[join(this.o.bundle,'uv.exe')];
    // The owner's shell UV_* variables never steer this uv (proxies and certificates still pass). Everything uv writes stays in the data folder.
    // No UV_NO_CONFIG: it would also drop Hermes's own [tool.uv] settings.
    const env:Record<string,string>={};for(const [k,v] of Object.entries(process.env))if(v!==undefined&&!/^UV_/i.test(k))env[k]=v;
    Object.assign(env,{UV_CACHE_DIR:join(this.dir,'cache'),UV_PYTHON_INSTALL_DIR:join(this.dir,'python'),UV_PROJECT_ENVIRONMENT:join(this.dir,'venv'),
      UV_PYTHON_PREFERENCE:'only-managed',UV_PYTHON_DOWNLOADS:step==='python'?'automatic':'never',UV_NO_PROGRESS:'1'});
    return new Promise<void>((done,fail)=>{
      let child:ChildProcess;
      try{child=spawn(file!,[...pre,...args],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(e){fail(e);return;}
      this.child=child;
      // Whole lines only: a chunk can end mid-line.
      const reader=()=>{let rest='';return (b:Buffer|null)=>{const parts=(rest+(b?.toString('utf8')??'\n')).split(/\r?\n/);rest=parts.pop()!;
        for(const l of parts)if(l.trim())this.lines.push(l.trimEnd());this.lines.splice(0,Math.max(0,this.lines.length-LINES_MAX));};};
      const out=reader(),err=reader();
      child.stdout!.on('data',out);child.stderr!.on('data',err);child.stdout!.once('end',()=>out(null));child.stderr!.once('end',()=>err(null));
      child.once('error',e=>fail(new Error(`cannot run ${file}: ${(e as NodeJS.ErrnoException).code??e.message}`)));
      child.once('close',code=>code===0?done():fail(new Error(`uv exited ${code}: ${this.lines.at(-1)??'no output'}`)));
    });
  }
}

// Sets up the cat-workshop distro without the owner having to, and runs the owner's Workshop card actions.
// The installer runs as a child process with argv only. Startup never waits for it. Tests inject fake spawners.
// Rules: docs/workshop.md. WSL itself is installed only after the owner confirms and approves the Windows prompt.
import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {checkInvariants, replay} from './economy.ts';
import {latestSeason, readSeason} from './season-view.ts';
import {seasonLock} from './season.ts';
import {capture, distroPresent, readWorkshopSettings, saveWorkshopSettings, type Child, type Spawner, type Workshop, type WorkshopOwner} from './workshop.ts';

export type ProcessSpawner=(file:string,args:string[],env:Record<string,string>)=>Child;
export const processSpawner:ProcessSpawner=(file,args,env)=>spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}}) as unknown as Child;

const POWERSHELL='powershell.exe';
// Constant text. The only variable parts are the script path and the data folder, both set by the app.
const WSL_ELEVATE="Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs";
export const WSL_MISSING='WSL is not installed on this computer. Run "wsl --install" in an administrator PowerShell, restart if Windows asks, then try again. Install WSL in this card does the same after you confirm.';
const INSTALL_LIMIT_MS=60*60_000;
const WSL_CACHE_MS=10_000;
const LINES_MAX=200;
export const SETUP_FILE='workshop-setup.json';
export const SETUP_BACKOFF_MS=15*60_000;
const SETUP_BACKOFF_MAX_MS=24*3600_000;

// A failed setup waits 15 minutes, then twice as long for each further failure, up to a day. Checked once per start.
export function setupRetryDue(failures:number,lastFailedAt:string|null,now:number):boolean{
  if(failures<=0||!lastFailedAt)return true;
  const delay=Math.min(SETUP_BACKOFF_MS*2**(failures-1),SETUP_BACKOFF_MAX_MS);
  return now>=Date.parse(lastFailedAt)+delay;
}

type Saved={failures:number;lastFailedAt:string|null;error:string|null};
function readSetupFile(dir:string):Saved{
  try{
    const raw=JSON.parse(readFileSync(join(dir,SETUP_FILE),'utf8'));
    return {failures:Number.isInteger(raw?.failures)?raw.failures:0,lastFailedAt:typeof raw?.lastFailedAt==='string'?raw.lastFailedAt:null,error:typeof raw?.error==='string'?raw.error:null};
  }catch{return {failures:0,lastFailedAt:null,error:null};}
}

export type SetupStatus='idle'|'running'|'done'|'failed';
export type AutoStartResult='off'|'no-wsl'|'present'|'backoff'|'started'|'once';
export type SetupFailure={error:string;failures:number;at:string};

export class WorkshopSetup{
  private status:SetupStatus='idle';
  private lines:string[]=[];
  private error:string|null=null;
  private reason:'auto'|'manual'|null=null;
  private started=false;
  private child?:Child;
  private wslCache?:{at:number;value:boolean};
  private wslMessage:string|null=null;
  private failures:number;
  private lastFailedAt:string|null;

  constructor(private o:{
    settingsDir:string;
    root:string;
    defaultAutoSetup:boolean;
    wsl:Spawner;
    proc?:ProcessSpawner;
    // The world the install reads and writes: its data folder and its Workshop.
    current:()=>{dataDir:string;workshop:Workshop};
    now?:()=>number;
  }){
    const saved=readSetupFile(o.settingsDir);
    this.failures=saved.failures;
    this.lastFailedAt=saved.lastFailedAt;
    if(saved.error){this.status='failed';this.error=saved.error;}
  }

  private get now(){return this.o.now??Date.now;}
  private get proc():ProcessSpawner{return this.o.proc??processSpawner;}
  autoSetupOn(){return readWorkshopSettings(this.o.settingsDir).autoSetup??this.o.defaultAutoSetup;}

  // WSL is present when wsl.exe --status exits 0. A missing wsl.exe is a spawn error, which counts as absent.
  async wslAvailable():Promise<boolean>{
    const at=this.now();
    if(this.wslCache&&at-this.wslCache.at<WSL_CACHE_MS)return this.wslCache.value;
    const r=await capture(this.o.wsl,['--status'],{maxBytes:4096});
    const value=!r.error&&!r.timedOut&&r.code===0;
    this.wslCache={at,value};
    return value;
  }

  // Called once when the server starts. It decides and starts the installer in the background, and returns before the install ends.
  async autoStart():Promise<AutoStartResult>{
    if(this.started)return 'once';
    this.started=true;
    if(!this.autoSetupOn())return 'off';
    if(!(await this.wslAvailable()))return 'no-wsl';
    if(await distroPresent(this.o.wsl))return 'present';
    if(!setupRetryDue(this.failures,this.lastFailedAt,this.now()))return 'backoff';
    this.begin('auto');
    return 'started';
  }

  // The owner's button. It refuses when WSL is missing, and never runs the installer without WSL.
  async create():Promise<{started:true}>{
    if(this.status==='running')throw new Error('The workshop is already being set up.');
    if(!(await this.wslAvailable()))throw new Error(WSL_MISSING);
    this.begin('manual');
    return {started:true};
  }

  private begin(reason:'auto'|'manual'){
    this.status='running';
    this.reason=reason;
    this.lines=[];
    this.error=null;
    const {dataDir}=this.o.current();
    const script=join(this.o.root,'scripts','workshop','install-workshop.ps1');
    const child=this.proc(POWERSHELL,['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{CAT_TOWN_DATA:dataDir});
    this.child=child;
    const take=(chunk:Buffer|string)=>{
      for(const line of String(chunk).split(/\r?\n/)){const t=line.trim();if(t)this.lines.push(t.slice(0,300));}
      if(this.lines.length>LINES_MAX)this.lines.splice(0,this.lines.length-LINES_MAX);
    };
    child.stdout?.on('data',take);
    child.stderr?.on('data',take);
    const killAt=setTimeout(()=>{try{child.kill('SIGKILL');}catch{/* already gone */}},INSTALL_LIMIT_MS);
    killAt.unref();
    child.on('error',(err:Error)=>{clearTimeout(killAt);this.finish(child,false,`Could not start the installer: ${err.message}`);});
    child.on('close',(code:number|null)=>{clearTimeout(killAt);this.finish(child,code===0,code===0?null:`The installer stopped with exit code ${code}. ${this.lines.at(-1)??''}`.trim());});
  }

  private finish(child:Child,ok:boolean,error:string|null){
    if(this.status!=='running'||this.child!==child)return;
    this.child=undefined;
    this.o.current().workshop.forget();
    if(ok){
      this.status='done';this.error=null;this.failures=0;this.lastFailedAt=null;
    }else{
      this.status='failed';this.error=error;this.failures+=1;this.lastFailedAt=new Date(this.now()).toISOString();
    }
    this.save();
  }

  private save(){
    try{
      const file=join(this.o.settingsDir,SETUP_FILE),temp=`${file}.${process.pid}.tmp`;
      writeFileSync(temp,`${JSON.stringify({failures:this.failures,lastFailedAt:this.lastFailedAt,error:this.error})}\n`);
      renameSync(temp,file);
    }catch{/* the card still shows the state; a lost write only loses the backoff count */}
  }

  // Raised as one quest while the last setup failed, with its error.
  failure():SetupFailure|null{
    if(this.status!=='failed'||!this.error||!this.lastFailedAt)return null;
    return {error:this.error,failures:this.failures,at:this.lastFailedAt};
  }

  // Owner Install WSL: starts the Windows elevation prompt and returns. The owner must confirm first.
  async installWsl(body:unknown):Promise<{started:true}>{
    if((body as {confirm?:unknown})?.confirm!==true)throw new Error('Confirm first: Windows will ask for permission to install WSL.');
    if(await this.wslAvailable())throw new Error('WSL is already installed.');
    const child=this.proc(POWERSHELL,['-NoProfile','-Command',WSL_ELEVATE],{});
    this.wslMessage='Windows is asking for permission to install WSL. Refresh this card when it finishes; a restart may be needed.';
    child.on('error',(err:Error)=>{this.wslMessage=`Could not start the Windows prompt: ${err.message}`;});
    child.on('close',(code:number|null)=>{
      this.wslCache=undefined;
      if(code!==0)this.wslMessage=`WSL was not installed (exit ${code}). Run "wsl --install --no-distribution" in an administrator PowerShell.`;
    });
    return {started:true};
  }

  snapshot(wsl:boolean|null){
    return {status:this.status,reason:this.reason,lines:[...this.lines],error:this.error,failures:this.failures,lastFailedAt:this.lastFailedAt,wsl,wslMessage:this.wslMessage};
  }

  settingsView(){
    return {autoSetup:this.autoSetupOn(),allowLongJobs:readWorkshopSettings(this.o.settingsDir).allowLongJobs===true};
  }

  // The owner's decision on a run recipe that waits for the owner (cautious autonomy). Refused while a season runs.
  async decideRecipe(body:unknown):Promise<{id:string;approved:boolean}>{
    const b=body as {id:string;approved:boolean;reason:string};
    const {dataDir,workshop}=this.o.current();
    const name=latestSeason(dataDir);
    if(!name)throw new Error('There is no season yet, so there is no recipe to decide.');
    if(seasonLock(name,dataDir).running)throw new Error('A season is running. Decide the recipe when it finishes.');
    const events=readSeason(dataDir,name);
    const c=replay(events).capabilities.find(x=>x.id===b.id);
    if(!c?.recipe||c.recipe.status!=='needs_owner')throw new Error(`${b.id} has no run recipe waiting for the owner.`);
    const decided={type:'recipe.decided',id:b.id,by:'owner',approved:b.approved,reason:b.reason};
    // The same rules the economy applies: the decision must be legal against the journal as it stands.
    const problems=checkInvariants([...events,decided]).filter(p=>p.startsWith(`#${events.length} `));
    if(problems.length)throw new Error(problems[0]);
    const file=join(dataDir,`season-${name}.jsonl`);
    if(!existsSync(file))throw new Error('The season journal is missing.');
    appendFileSync(file,`${JSON.stringify(decided)}\n`);
    workshop.forget();
    return {id:b.id,approved:b.approved};
  }

  owner():WorkshopOwner{
    return {
      view:async()=>{
        const {workshop}=this.o.current();
        const status=await workshop.status();
        return {...status,setup:this.snapshot(await this.wslAvailable()),settings:this.settingsView()};
      },
      create:()=>this.create(),
      installWsl:body=>this.installWsl(body),
      settings:body=>{saveWorkshopSettings(this.o.settingsDir,body);return this.settingsView();},
      decideRecipe:body=>this.decideRecipe(body),
    };
  }
}

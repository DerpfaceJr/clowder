// The workshop runs approved sandbox tools inside the cat-workshop WSL distro. Rules: docs/workshop-spec.md.
// Every call is wsl.exe with an argv array, so no shell ever sees model or owner text. A tool's entry command comes
// from its install record, never from a model. Tests inject a fake Spawner and never reach wsl.exe.
import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';
import {validCapabilitySource} from './economy.ts';
import type {EconomyEvent, RunRecipe} from './economy.ts';
import {LIMITS} from './artifacts.ts';
import {latestSeason, readSeason} from './season-view.ts';
import {outputKind, parseFindLines, repoPath, setupArgv} from './workshop-recipe.ts';
import {writeOutbox} from './workshop-outbox.ts';

export const DISTRO='cat-workshop';
export const WSL_USER='catworker';
export const WORK_ROOT='/home/catworker/work';
export const INSTALL_ROOT='/home/catworker/workshop';
export const OUTPUT_BYTES=4096;
export const RUN_TIMEOUT_MS=60_000;
export const LONG_RUN_MS=900_000;
export const SETTINGS_FILE='workshop-settings.json';
const INSTALL_TIMEOUT_MS=600_000;
const FILE_TIMEOUT_MS=120_000;
const LIST_BYTES=65_536;
const STATUS_TTL_MS=10_000;
const MAX_ARGS=8;
const MAX_ARG=200;
const MAX_OUTPUT_FILES=50;
const LICENSES=['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC'];
const CAT=/^[\w-]{1,40}$/;
const TOOL=/^cap\d{1,6}$/;

// The one place a child process starts. A Child is any object with stdout, stderr, on and kill.
export type Child={stdout:NodeJS.EventEmitter|null;stderr:NodeJS.EventEmitter|null;kill(signal?:NodeJS.Signals):boolean;on(event:string,listener:(...args:any[])=>void):unknown};
export type Spawner=(args:string[])=>Child;
export const wslSpawner:Spawner=args=>spawn('wsl.exe',args,{windowsHide:true,stdio:['ignore','pipe','pipe']}) as unknown as Child;

export type Captured={code:number|null;output:string;truncated:boolean;timedOut:boolean;error?:string};
export type Collected={code:number|null;raw:Buffer;truncated:boolean;timedOut:boolean;error?:string};
const decode=(raw:Buffer)=>(raw.includes(0)?raw.toString('utf16le'):raw.toString('utf8')).replace(/\0/g,'').replace(/^﻿/,'').trim();

// Runs one process, keeps at most maxBytes of its output as raw bytes, and kills it at timeoutMs. Resolves once, with what it saw.
export function captureBytes(spawnFn:Spawner,args:string[],{timeoutMs=RUN_TIMEOUT_MS,maxBytes=OUTPUT_BYTES}:{timeoutMs?:number;maxBytes?:number}={}):Promise<Collected>{
  return new Promise(resolve=>{
    const chunks:Buffer[]=[];
    let size=0,truncated=false,settled=false,timer:NodeJS.Timeout|undefined;
    const finish=(code:number|null,timedOut:boolean,error?:string)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      resolve({code,timedOut,truncated,raw:Buffer.concat(chunks),...(error?{error}:{})});
    };
    const onData=(chunk:Buffer|string)=>{
      const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      const room=maxBytes-size;
      if(buf.length>room)truncated=true;
      if(room>0){const part=buf.subarray(0,room);chunks.push(part);size+=part.length;}
    };
    let child:Child;
    try{child=spawnFn(args);}
    catch(err){finish(null,false,(err as Error).message);return;}
    child.stdout?.on('data',onData);
    child.stderr?.on('data',onData);
    timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{/* already gone */}finish(null,true);},timeoutMs);
    child.on('close',(code:number|null)=>finish(code,false));
    child.on('error',(err:Error)=>finish(null,false,err.message));
  });
}

// Text output: the same process rules as captureBytes, decoded and trimmed.
export async function capture(spawnFn:Spawner,args:string[],{timeoutMs=RUN_TIMEOUT_MS,maxBytes=OUTPUT_BYTES}:{timeoutMs?:number;maxBytes?:number}={}):Promise<Captured>{
  const r=await captureBytes(spawnFn,args,{timeoutMs,maxBytes});
  return {code:r.code,timedOut:r.timedOut,truncated:r.truncated,output:decode(r.raw),...(r.error?{error:r.error}:{})};
}

// Arguments are passed as argv elements only. Spaces, quotes, ; && $() stay inside one element; NUL and size limits are refused.
export function checkArgs(args:unknown):string[]{
  if(args===undefined||args===null)return [];
  if(!Array.isArray(args)||args.length>MAX_ARGS)throw new Error(`args must be a list of at most ${MAX_ARGS} text values.`);
  return args.map(a=>{
    if(typeof a!=='string'||a.length>MAX_ARG)throw new Error(`each arg must be text of at most ${MAX_ARG} characters.`);
    if(a.includes('\0'))throw new Error('args may not contain NUL characters.');
    return a;
  });
}
const execArgv=(argv:string[])=>['-d',DISTRO,'-u',WSL_USER,'--exec',...argv];
export const runArgv=(dir:string,entry:string[],args:string[])=>['-d',DISTRO,'-u',WSL_USER,'--cd',dir,'--exec',...entry,...args];
// A run tells the tool where its out folder is through CLOWDER_OUT. The variable is a fixed argv word; no model text reaches it.
export const runOutArgv=(dir:string,out:string,entry:string[],args:string[])=>['-d',DISTRO,'-u',WSL_USER,'--cd',dir,'--exec','env',`CLOWDER_OUT=${out}`,...entry,...args];

// Same rules as the installer script and economy.ts: the license must be on the allowlist, every token of an OR/AND expression.
export const licenseAllowed=(text:string|null)=>{
  if(!text)return false;
  const tokens=text.split(/\s+OR\s+|\s+AND\s+|[()]/).filter(Boolean);
  return tokens.length>0&&tokens.every(t=>LICENSES.includes(t));
};
export function repoLicense(text:string):string|null{
  if(/MIT License/.test(text))return 'MIT';
  if(/Apache License\s+Version 2\.0/.test(text))return 'Apache-2.0';
  if(/ISC License/.test(text))return 'ISC';
  if(/BSD 3-Clause/.test(text))return 'BSD-3-Clause';
  if(/BSD 2-Clause/.test(text))return 'BSD-2-Clause';
  return null;
}
async function registryLicense(manager:'npm'|'pypi',name:string):Promise<string>{
  const url=manager==='npm'?`https://registry.npmjs.org/${name.replace('/','%2F')}/latest`:`https://pypi.org/pypi/${name}/json`;
  const response=await fetch(url,{signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`registry answered ${response.status}`);
  const body:any=await response.json();
  const raw=manager==='npm'?body.license:body.info?.license;
  return typeof raw==='object'&&raw!==null?String(raw.type??''):String(raw??'');
}

// Whether the distro exists. A missing WSL and a WSL with no distros both answer false.
export async function distroPresent(spawnFn:Spawner):Promise<boolean>{
  const r=await capture(spawnFn,['--list','--quiet'],{maxBytes:LIST_BYTES});
  if(r.error||r.timedOut||r.code!==0)return false;
  return r.output.split(/\r?\n/).map(s=>s.trim()).includes(DISTRO);
}

// The owner's switches. They live beside models.json in the shared data folder, because the distro is one for the whole computer.
export type WorkshopSettings={autoSetup?:boolean;allowLongJobs?:boolean};
export function readWorkshopSettings(dir:string):WorkshopSettings{
  try{
    const raw=JSON.parse(readFileSync(join(dir,SETTINGS_FILE),'utf8'));
    return {...(typeof raw?.autoSetup==='boolean'?{autoSetup:raw.autoSetup}:{}),...(typeof raw?.allowLongJobs==='boolean'?{allowLongJobs:raw.allowLongJobs}:{})};
  }catch{return {};}
}
export function saveWorkshopSettings(dir:string,patch:unknown):WorkshopSettings{
  const p=(patch??{}) as Record<string,unknown>;
  for(const [k,v] of Object.entries(p)){
    if(k!=='autoSetup'&&k!=='allowLongJobs')throw new Error(`Unknown setting ${k}.`);
    if(typeof v!=='boolean')throw new Error(`${k} must be true or false.`);
  }
  const next={...readWorkshopSettings(dir),...p} as WorkshopSettings;
  mkdirSync(dir,{recursive:true});
  const file=join(dir,SETTINGS_FILE),temp=`${file}.${process.pid}.tmp`;
  writeFileSync(temp,`${JSON.stringify(next,null,2)}\n`);
  renameSync(temp,file);
  return next;
}

// The run length in seconds: 60 by default, or up to 900 for a recipe marked long while the owner allows long jobs.
// A larger request is clamped to the limit that applies. A request that is not a whole number from 1 to 900 is refused.
export function runSecondsFor(long:boolean,allowLong:boolean,requested:unknown):number{
  const max=long&&allowLong?LONG_RUN_MS/1000:RUN_TIMEOUT_MS/1000;
  if(requested===undefined||requested===null)return RUN_TIMEOUT_MS/1000;
  if(!Number.isInteger(requested)||(requested as number)<1||(requested as number)>900)throw new Error('timeoutSeconds must be a whole number from 1 to 900.');
  return Math.min(requested as number,max);
}

export type Approved={id:string;kind:string;source:string;need:string;purpose:string;recipe:RunRecipe|null};
// Approved sandbox requests from the newest season journal, the same journal the installer script reads.
// The run recipe for each request is replayed from the same journal, using the rules in economy.ts.
export function approvedTools(dataDir:string):{journal:string|null;items:Approved[]}{
  const name=latestSeason(dataDir);
  if(!name)return {journal:null,items:[]};
  const events:EconomyEvent[]=readSeason(dataDir,name);
  const requested=new Map<string,EconomyEvent>(events.filter(e=>e.type==='capability.requested').map(e=>[e.id,e]));
  const recipes=new Map<string,RunRecipe>();
  for(const e of events){
    if(e.type==='recipe.proposed'&&e.recipe)recipes.set(e.id,{...e.recipe,cat:e.cat});
    else if(e.type==='recipe.decided'&&recipes.has(e.id)){const r=recipes.get(e.id)!;recipes.set(e.id,{...r,status:e.approved?'approved':'rejected'});}
  }
  const items:Approved[]=[];
  for(const d of events){
    if(d.type!=='capability.decided'||d.approved!==true)continue;
    const r=requested.get(d.id);
    if(!r||r.tier!=='sandbox'||!validCapabilitySource(r.kind,r.source))continue;
    items.push({id:r.id,kind:r.kind,source:r.source,need:r.need,purpose:r.purpose,recipe:recipes.get(r.id)??null});
  }
  return {journal:name,items};
}

export type InstallRecord={id:string;kind:string;source:string|null;status:'installed'|'failed';license:string|null;reason:string|null;entry:string[]|null;at:string;workdir?:string|null;long?:boolean;setupDone?:boolean};
// The results log is append-only; the last record for an id and source wins. A torn last line is skipped.
function readRecords(file:string):Map<string,InstallRecord>{
  const out=new Map<string,InstallRecord>();
  if(!existsSync(file))return out;
  for(const line of readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;
    try{const r=JSON.parse(line) as InstallRecord;if(typeof r.id==='string')out.set(`${r.id}|${r.source}`,r);}
    catch{/* skipped */}
  }
  return out;
}

export type ToolRow=Approved&{state:'not installed'|'installed'|'not runnable'|'failed';license:string|null;reason:string|null;entry:string[]|null;workdir:string|null;long:boolean};
export type InstalledTool={id:string;kind:string;source:string;need:string;purpose:string};
export type RunResult={ok:boolean;exitCode:number|null;timedOut:boolean;truncated:boolean;output:string;files:string[];skipped:string[]};
export type WorkshopStatus={distro:{name:string;present:boolean};isolated:boolean;isolation:{mountedC:boolean|null;interop:boolean|null};journal:string|null;tools:ToolRow[];resultsFile:string;error?:string};

export class Workshop{
  private cache?:{at:number;value:WorkshopStatus};
  private busy=false;
  constructor(private opts:{dataDir:string;settingsDir?:string;spawn?:Spawner}){}

  private get spawnFn(){return this.opts.spawn??wslSpawner;}
  private get resultsFile(){return join(this.opts.dataDir,'workshop.jsonl');}
  private get settingsDir(){return this.opts.settingsDir??this.opts.dataDir;}
  forget(){this.cache=undefined;}

  private rows(){
    const {journal,items}=approvedTools(this.opts.dataDir);
    const records=readRecords(this.resultsFile);
    return {journal,rows:items.map((a):ToolRow=>{
      const r=records.get(`${a.id}|${a.source}`);
      const state=!r?'not installed':r.status==='failed'?'failed':r.entry?'installed':'not runnable';
      const ok=r?.status==='installed';
      return {...a,state,license:r?.license??null,reason:r?.reason??null,entry:ok?(r?.entry??null):null,workdir:ok?(r?.workdir??null):null,long:r?.long===true};
    })};
  }

  // Tools a cat may use: approved, installed and runnable. Reads files only, so a season can call it every tick.
  installedTools():InstalledTool[]{
    try{return this.rows().rows.filter(r=>r.state==='installed').map(({id,kind,source,need,purpose})=>({id,kind,source,need,purpose}));}
    catch{return [];}
  }

  private async probeDistro():Promise<boolean>{
    return distroPresent(this.spawnFn);
  }

  // test -e exits 0 when the path exists and 1 when it does not. Anything else is unknown, and unknown is not isolated.
  // One probe script, base64-encoded so no quoting layer can mangle it (Windows PowerShell 5.1 drops inner quotes).
  // Exit 0: isolated. 10: a Windows drive is mounted under /mnt. 11: interop is on for this distro (WSL_INTEROP set,
  // or wsl.conf lacks [interop] enabled=false). An empty /mnt/c folder is not a mount and does not count.
  // Verified on the owner's PC 2026-10-26: with this wsl.conf, a copied whoami.exe could not run inside the distro.
  private async probeIsolation(){
    const r=await capture(this.spawnFn,execArgv(['sh','-c','echo Z3JlcCAtcUUgJyAvbW50L1thLXpdICcgL3Byb2MvbW91bnRzICYmIGV4aXQgMTAKWyAtbiAiJFdTTF9JTlRFUk9QIiBdICYmIGV4aXQgMTEKYXdrICcvXlxbaW50ZXJvcFxdL3tzPTE7bmV4dH0gL15cWy97cz0wfSBzICYmIC9eZW5hYmxlZD1mYWxzZSQve2Y9MX0gRU5Ee2V4aXQgIWZ9JyAvZXRjL3dzbC5jb25mIHx8IGV4aXQgMTEKZXhpdCAwCg== | base64 -d | sh']),{maxBytes:OUTPUT_BYTES});
    if(r.error||r.timedOut||r.code===null||![0,10,11].includes(r.code))return {isolated:false,mountedC:null,interop:null};
    return {isolated:r.code===0,mountedC:r.code===10,interop:r.code===11?true:r.code===0?false:null};
  }

  async status():Promise<WorkshopStatus>{
    if(this.cache&&Date.now()-this.cache.at<STATUS_TTL_MS)return this.cache.value;
    const present=await this.probeDistro();
    const iso=present?await this.probeIsolation():{isolated:false,mountedC:null,interop:null};
    let rows:ToolRow[]=[],journal:string|null=null,error:string|undefined;
    try{({rows,journal}=this.rows());}catch(err){error=(err as Error).message;}
    const value:WorkshopStatus={distro:{name:DISTRO,present},isolated:iso.isolated,isolation:{mountedC:iso.mountedC,interop:iso.interop},journal,tools:rows,resultsFile:this.resultsFile,...(error?{error}:{})};
    this.cache={at:Date.now(),value};
    return value;
  }

  // Fresh check, never cached: run and install refuse unless the distro exists and is isolated right now.
  private async assertIsolated(){
    if(!(await this.probeDistro()))throw new Error(`The ${DISTRO} distro is not installed. Use Create workshop in AI models, or run scripts\\workshop\\install-workshop.ps1 on this computer.`);
    const iso=await this.probeIsolation();
    if(!iso.isolated)throw new Error(`The workshop is not isolated (C: drive mounted: ${iso.mountedC}; Windows interop on: ${iso.interop}). Nothing was run.`);
  }

  private async must(argv:string[]):Promise<void>{
    const r=await capture(this.spawnFn,execArgv(argv),{timeoutMs:INSTALL_TIMEOUT_MS,maxBytes:OUTPUT_BYTES});
    if(r.error||r.timedOut||r.code!==0)throw new Error(`${argv[0]} failed${r.timedOut?' (timed out)':''}${r.code===null?'':` (exit ${r.code})`}${r.output?`: ${r.output.slice(-300)}`:''}`);
  }

  // One setup step, in the repo folder. Network is allowed here and nowhere else in the install path.
  private async setupStep(cwd:string,argv:string[]):Promise<void>{
    const r=await capture(this.spawnFn,['-d',DISTRO,'-u',WSL_USER,'--cd',cwd,'--exec',...setupArgv(argv)],{timeoutMs:INSTALL_TIMEOUT_MS,maxBytes:OUTPUT_BYTES});
    if(r.error||r.timedOut||r.code!==0)throw new Error(`setup step ${argv[0]} failed${r.timedOut?' (timed out)':''}${r.code===null?'':` (exit ${r.code})`}${r.output?`: ${r.output.slice(-300)}`:''}`);
  }

  private async installPackage(item:Approved,rec:InstallRecord):Promise<void>{
    const dir=`${INSTALL_ROOT}/${item.id}`;
    const m=/^(npm|pypi):(.+)$/.exec(item.source);
    if(!m)throw new Error('source does not match the sandbox rules');
    const manager=m[1] as 'npm'|'pypi',name=m[2];
    rec.license=await registryLicense(manager,name);
    if(!licenseAllowed(rec.license)){rec.reason=`licence not on allowlist: ${rec.license||'none'}`;return;}
    await this.must(['rm','-rf',dir]);
    await this.must(['mkdir','-p',dir]);
    if(manager==='npm'){
      await this.must(['npm','install','--ignore-scripts','--prefix',dir,name]);
      rec.entry=[`${dir}/node_modules/.bin/${name.replace(/^@[^/]+\//,'')}`];
    }else{
      await this.must(['python3','-m','venv',dir]);
      await this.must([`${dir}/bin/pip`,'install','--only-binary=:all:',name]);
      rec.entry=[`${dir}/bin/${name}`];
    }
    rec.status='installed';
  }

  // A repo is cloned once. It becomes runnable only when its run recipe is approved: setup runs, then the entry is recorded.
  private async installRepo(item:Approved,rec:InstallRecord,existing?:InstallRecord):Promise<void>{
    const dir=`${INSTALL_ROOT}/${item.id}`,src=`${dir}/src`;
    if(existing?.status==='installed'){
      rec.license=existing.license;
    }else{
      await this.must(['rm','-rf',dir]);
      await this.must(['mkdir','-p',dir]);
      await this.must(['git','clone','--depth','1',item.source,src]);
      const head=await capture(this.spawnFn,execArgv(['head','-c','4000',`${src}/LICENSE`]),{timeoutMs:INSTALL_TIMEOUT_MS});
      rec.license=head.code===0?repoLicense(head.output):null;
      if(!licenseAllowed(rec.license)){
        await capture(this.spawnFn,execArgv(['rm','-rf',dir]),{timeoutMs:INSTALL_TIMEOUT_MS});
        rec.reason='no LICENSE file that matches the allowlist';
        return;
      }
    }
    rec.status='installed';
    const recipe=item.recipe;
    if(!recipe||recipe.status!=='approved')return;
    for(const step of recipe.setup)await this.setupStep(src,step);
    rec.entry=recipe.entry.map((a,i)=>i===0&&a.includes('/')?`${src}/${repoPath(a,'entry')}`:a);
    rec.workdir=recipe.workdir?`${src}/${recipe.workdir}`:null;
    rec.long=recipe.long;
    rec.setupDone=true;
  }

  async install(id:string):Promise<InstallRecord>{
    if(!TOOL.test(id))throw new Error('Unknown capability id.');
    if(this.busy)throw new Error('Another install is running. Wait for it to finish.');
    this.busy=true;
    try{
      await this.assertIsolated();
      const {items}=approvedTools(this.opts.dataDir);
      const item=items.find(i=>i.id===id);
      if(!item)throw new Error(`${id} is not an approved sandbox capability in the newest season.`);
      const existing=readRecords(this.resultsFile).get(`${item.id}|${item.source}`);
      // Done when runnable, or when a repo is cloned and no run recipe is approved yet.
      if(existing?.status==='installed'&&(existing.entry||item.recipe?.status!=='approved'))return existing;
      const rec:InstallRecord={id:item.id,kind:item.kind,source:item.source,status:'failed',license:null,reason:null,entry:null,at:new Date().toISOString()};
      try{
        if(item.kind==='package')await this.installPackage(item,rec);
        else await this.installRepo(item,rec,existing);
      }
      catch(err){rec.status='failed';rec.entry=null;rec.reason=(err as Error).message;}
      mkdirSync(this.opts.dataDir,{recursive:true});
      appendFileSync(this.resultsFile,`${JSON.stringify(rec)}\n`);
      this.cache=undefined;
      return rec;
    }finally{this.busy=false;}
  }

  // Copies new files from the out folder into the outbox. Only the server turns them into artifacts (workshop-outbox.ts).
  private async collectOutputs(cat:string,toolId:string,out:string):Promise<{files:string[];skipped:string[]}>{
    const files:string[]=[],skipped:string[]=[];
    const listed=await capture(this.spawnFn,execArgv(['find',out,'-type','f','-printf','%s\\t%P\\n']),{maxBytes:LIST_BYTES});
    let total=0;
    for(const f of parseFindLines(listed.output).slice(0,MAX_OUTPUT_FILES)){
      const kind=outputKind(f.name);
      if(!kind){skipped.push(`${f.name}: type not supported`);continue;}
      if(f.size>LIMITS.video||total+f.size>LIMITS.world){skipped.push(`${f.name}: over the size limit`);continue;}
      const got=await captureBytes(this.spawnFn,execArgv(['cat',`${out}/${f.name}`]),{timeoutMs:FILE_TIMEOUT_MS,maxBytes:f.size});
      if(got.code!==0||got.truncated||got.timedOut||got.error||got.raw.length!==f.size){skipped.push(`${f.name}: could not be read`);continue;}
      writeOutbox(this.opts.dataDir,{title:basename(f.name).slice(0,120)||'Workshop file',cat,kind,toolId,at:new Date().toISOString()},got.raw);
      total+=f.size;
      files.push(f.name);
    }
    return {files,skipped};
  }

  async run(cat:string,toolId:string,args:unknown,opts:{timeoutSeconds?:unknown}={}):Promise<RunResult>{
    if(!CAT.test(cat))throw new Error('Unknown cat.');
    if(!TOOL.test(toolId))throw new Error('Unknown tool id.');
    const argv=checkArgs(args);
    await this.assertIsolated();
    const tool=this.rows().rows.find(r=>r.id===toolId&&r.state==='installed');
    if(!tool||!tool.entry)throw new Error(`${toolId} is not an installed tool.`);
    const seconds=runSecondsFor(tool.long,readWorkshopSettings(this.settingsDir).allowLongJobs===true,opts.timeoutSeconds);
    const work=`${WORK_ROOT}/${cat}`,out=`${work}/out`;
    await capture(this.spawnFn,execArgv(['rm','-rf',out]));
    const made=await capture(this.spawnFn,execArgv(['mkdir','-p',out]));
    if(made.code!==0)throw new Error('Could not create the work folder.');
    const r=await capture(this.spawnFn,runOutArgv(tool.workdir??work,out,tool.entry,argv),{timeoutMs:seconds*1000});
    const copied=await this.collectOutputs(cat,toolId,out);
    return {ok:r.code===0&&!r.timedOut&&!r.error,exitCode:r.code,timedOut:r.timedOut,truncated:r.truncated,output:r.output,files:copied.files,skipped:copied.skipped};
  }
}

const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{
  if(!isOwner(req))return reply.code(403).send({error:'The workshop is managed on the host computer.'});
};
const installBody={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',pattern:'^cap\\d{1,6}$'}}};

// The owner-only actions the workshop card needs. Built in workshop-setup.ts, which owns the WSL and setup state.
export type WorkshopOwner={
  view():Promise<Record<string,unknown>>;
  create():Promise<unknown>;
  installWsl(body:unknown):Promise<unknown>;
  settings(body:unknown):unknown;
  decideRecipe(body:unknown):Promise<unknown>;
};

// Owner-only, on the main app only. The remote and tunnel apps never register these routes.
export function registerWorkshopRoutes(app:FastifyInstance,workshop:Pick<Workshop,'status'|'install'>,owner?:WorkshopOwner){
  app.get('/api/workshop',{onRequest:ownerOnly},async()=>owner?owner.view():workshop.status());
  app.post('/api/workshop/install',{onRequest:ownerOnly,schema:{body:installBody}},async(req,reply)=>{
    try{return await workshop.install((req.body as {id:string}).id);}
    catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
  if(!owner)return;
  const refuse=(reply:FastifyReply,err:unknown)=>reply.code(409).send({error:(err as Error).message});
  app.post('/api/workshop/setup',{onRequest:ownerOnly},async(_req,reply)=>{
    try{return await owner.create();}catch(err){return refuse(reply,err);}
  });
  app.post('/api/workshop/install-wsl',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,required:['confirm'],properties:{confirm:{type:'boolean',const:true}}}}},async(req,reply)=>{
    try{return await owner.installWsl(req.body);}catch(err){return refuse(reply,err);}
  });
  app.post('/api/workshop/settings',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,properties:{autoSetup:{type:'boolean'},allowLongJobs:{type:'boolean'}}}}},async(req,reply)=>{
    try{return owner.settings(req.body);}catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
  app.post('/api/workshop/recipe',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,required:['id','approved','reason'],properties:{id:{type:'string',pattern:'^cap\\d{1,6}$'},approved:{type:'boolean'},reason:{type:'string',minLength:1,maxLength:200}}}}},async(req,reply)=>{
    try{return await owner.decideRecipe(req.body);}catch(err){return refuse(reply,err);}
  });
}

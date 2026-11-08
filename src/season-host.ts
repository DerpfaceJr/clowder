// Runs coin-economy seasons from the town UI. Each season is a child process, so a stalled model call never blocks the
// web server. The season journal and its lock file are the only state: a running season is found again after a server
// restart by its lock, and stopping one leaves the journal resumable.
import {spawn,type ChildProcess} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,openSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';
import {seasonLock} from './season.ts';
import {publicSeason,readSeason} from './season-view.ts';
import {storeFor} from './secret-store.ts';

const NAME=/^[\w-]{1,40}$/;
const JOURNAL=/^season-([\w-]+)\.jsonl$/;
const LOCK=/^season-([\w-]+)\.lock$/;
const PAUSED=/season paused: (.*?)(?:; run the same command.*)?$/;
const STOP_WAIT_MS=5000;
const INTERRUPTED=130;

export type Launch={file:string;args:string[]};
export type Launcher=(run:{name:string;mode:string;seed?:number;days?:number;dataDir:string})=>Launch;
export type Running={name:string;pid:number;mode?:string;startedAt?:string;source:'host'|'lock'};

// Default: the same tsx loader `npm start` uses, run through Node directly so no shell is involved.
export const defaultLauncher=(root:string):Launcher=>({name,mode,seed,days})=>({
  file:process.execPath,
  args:['--import','tsx',join(root,'src','season.ts'),'--name',name,'--mode',mode,
    ...(seed===undefined?[]:['--seed',String(seed)]),...(days===undefined?[]:['--days',String(days)])],
});

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class SeasonHost {
  private child?:{proc:ChildProcess;name:string;mode:string;startedAt:string};
  private stopping=new Set<string>();
  private failed=new Map<string,string>();
  private launch:Launcher;

  constructor(private opts:{root:string;dataDir:string;sharedDataDir?:string;defaultDays?:number;launch?:Launcher}){
    this.launch=opts.launch??defaultLauncher(opts.root);
  }

  private logFile(name:string){return join(this.opts.dataDir,`season-${name}.log`);}

  // The host's own child first, then any season whose lock names a live pid (a CLI run, or a run from before a restart).
  running():Running|null{
    if(this.child)return {name:this.child.name,pid:this.child.proc.pid!,mode:this.child.mode,startedAt:this.child.startedAt,source:'host'};
    for(const file of this.files(LOCK)){
      const name=file.match(LOCK)![1];
      const lock=seasonLock(name,this.opts.dataDir);
      if(lock.running)return {name,pid:lock.pid!,source:'lock'};
    }
    return null;
  }

  private files(pattern:RegExp):string[]{
    if(!existsSync(this.opts.dataDir))return [];
    return readdirSync(this.opts.dataDir).filter(f=>pattern.test(f));
  }

  private pausedReason(name:string):string|undefined{
    const text=existsSync(this.logFile(name))?readFileSync(this.logFile(name),'utf8'):'';
    const line=text.split('\n').reverse().map(l=>PAUSED.exec(l.trim())).find(Boolean);
    return line?.[1]??this.failed.get(name);
  }

  // One entry per journal. Progress and balance come from the same replay the town UI uses.
  list(){
    const running=this.running();
    const seasons=this.files(JOURNAL).map(file=>{
      const name=file.match(JOURNAL)![1];
      try{
        const events=readSeason(this.opts.dataDir,name);
        if(!events.length)return {name,status:'empty' as const};
        const view=publicSeason(events,name);
        const last=view.recent.at(-1);
        const status=running?.name===name?'running':view.progress.finished?'finished':'paused';
        const reason=status==='paused'?this.pausedReason(name):undefined;
        return {
          name,status,...(reason?{reason}:{}),
          progress:view.progress,balance:view.balance,startingCoins:view.startingCoins,tokens:view.tokens,
          last:last?`${last.cat} ${String(last.name).replaceAll('_',' ')}: ${String(last.result??'').slice(0,160)}`:null,
        };
      }catch(err){
        return {name,status:'damaged' as const,reason:(err as Error).message};
      }
    }).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
    const taken=new Set(seasons.map(s=>s.name));
    let n=1;while(taken.has(`s${n}`))n++;
    return {running,seasons,nextName:`s${n}`,defaultDays:this.opts.defaultDays??null};
  }

  async start(input:{name:string;mode:string;seed?:number;days?:number}):Promise<{name:string;mode:string;pid:number}>{
    if(!NAME.test(input.name))throw new Error('Season name must be 1 to 40 letters, digits, - or _.');
    const busy=this.running();
    if(busy)throw new Error(busy.name===input.name?`Season ${busy.name} is already running.`:`Season ${busy.name} is running. Stop it first.`);
    mkdirSync(this.opts.dataDir,{recursive:true});
    this.failed.delete(input.name);
    // Each start replaces the log, so "paused" reflects the latest run only.
    const fd=openSync(this.logFile(input.name),'w');
    const {file,args}=this.launch({...input,dataDir:this.opts.dataDir}),shared=this.opts.sharedDataDir??this.opts.dataDir;
    let proc:ChildProcess;
    try{
      proc=spawn(file,args,{
        cwd:this.opts.root,
        // The run's model keys come from the server's SecretStore here: the child never opens secrets.v2.json, which it could not decrypt.
        env:{...process.env,CAT_TOWN_DATA:this.opts.dataDir,CAT_TOWN_SHARED_DATA:shared,CAT_TOWN_SECRETS:JSON.stringify(storeFor(shared).of('models.json'))},
        stdio:['ignore',fd,fd],
        windowsHide:true,
      });
    }finally{closeSync(fd);}
    const child={proc,name:input.name,mode:input.mode,startedAt:new Date().toISOString()};
    this.child=child;
    proc.on('error',err=>{this.failed.set(input.name,`Could not start: ${err.message}`);if(this.child===child)this.child=undefined;});
    proc.on('exit',(code,signal)=>{
      if(this.child===child)this.child=undefined;
      // 130 is the runner's own interrupt exit; a stop we asked for is not a failure.
      if(!this.stopping.has(input.name)&&code&&code!==INTERRUPTED)this.failed.set(input.name,`exited with code ${code}`);
      if(signal&&!this.stopping.has(input.name))this.failed.set(input.name,`stopped by ${signal}`);
    });
    return {name:input.name,mode:input.mode,pid:proc.pid!};
  }

  // Interrupts the run and waits for its lock to clear. The journal keeps every batch written so far.
  async stop(name:string):Promise<{ok:true}>{
    if(!NAME.test(name))throw new Error('Season name must be 1 to 40 letters, digits, - or _.');
    const run=this.running();
    if(!run||run.name!==name)throw new Error(`Season ${name} is not running.`);
    this.stopping.add(name);
    try{
      const signal=(sig:NodeJS.Signals)=>{try{process.kill(run.pid,sig);}catch{/* already gone */}};
      signal('SIGINT');
      const alive=()=>run.source==='host'?this.child?.name===name:seasonLock(name,this.opts.dataDir).running;
      for(let waited=0;alive()&&waited<STOP_WAIT_MS;waited+=100)await sleep(100);
      if(alive())signal('SIGKILL');
      for(let waited=0;alive()&&waited<STOP_WAIT_MS;waited+=100)await sleep(100);
    }finally{this.stopping.delete(name);}
    return {ok:true};
  }
}

const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{
  if(!isOwner(req))return reply.code(403).send({error:'Season runs are managed on the host computer.'});
};
const startBody={type:'object',additionalProperties:false,required:['name','mode'],properties:{
  name:{type:'string',pattern:'^[\\w-]{1,40}$'},
  mode:{type:'string',minLength:1,maxLength:20},
  seed:{type:'integer',minimum:0,maximum:2147483647},
  days:{type:'integer',minimum:1,maximum:365},
}};
const stopBody={type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',pattern:'^[\\w-]{1,40}$'}}};

// Owner-only, like the model settings routes: the guard runs before body validation, so viewers get 403 not 400.
export function registerSeasonRoutes(app:FastifyInstance,{host,hub}:{host:Pick<SeasonHost,'list'|'start'|'stop'>;hub:{list():Promise<{id:string;name:string}[]>}}){
  app.get('/api/seasons',{onRequest:ownerOnly},async()=>({...host.list(),modes:await hub.list()}));
  app.post('/api/seasons/start',{onRequest:ownerOnly,schema:{body:startBody}},async(req,reply)=>{
    const body=req.body as {name:string;mode:string;seed?:number;days?:number};
    const mode=body.mode==='plan'?'claude':body.mode;
    if(!(await hub.list()).some(m=>m.id===mode))return reply.code(400).send({error:`${body.mode} is not enabled. Choose a model under AI models first.`});
    try{return await host.start({...body,mode});}
    catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
  app.post('/api/seasons/stop',{onRequest:ownerOnly,schema:{body:stopBody}},async(req,reply)=>{
    try{return await host.stop((req.body as {name:string}).name);}
    catch(err){return reply.code(409).send({error:(err as Error).message});}
  });
}

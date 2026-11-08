// The Hermes Mayor's sidecar (plan 4.9, H1a; docs/research/hermes-adaptation.md route b, hermes-spike.md S1-S11), behind town.config.json hermes.enabled.
// Clowder owns its own HERMES_HOME (<data>/hermes): config.yaml (no secrets, from hermes/config.yaml) and .env (no key: that goes in Hermes's environment) are rewritten on every
// start and the clowder_gate plugin is copied in. Hermes runs as a child from CAT_HERMES_PYTHON (or hermes.python, else the runtime hermes-bootstrap.ts
// builds in the data folder on first enable, plan 4.13) with an environment allow-list, and comes back with backoff when it dies. ready() is false until /v1/capabilities has the run API the bridge needs and the plugin said hello for
// this spawn's nonce, so nothing runs ungated. Mayor runs go through the bridge (hermes-bridge.ts, 4.10), Clowder's tools through the town MCP (town-mcp.ts, 4.11).
import {spawn,type ChildProcess} from 'node:child_process';
import {closeSync,cpSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {isLocal,same} from './access.ts';
import {OS_ENV} from './claude-plan.ts';
import {writeJsonAtomic} from './atomic-json.ts';
import {withSecrets,withoutSecrets} from './secret-store.ts';
import type {Approval,Store} from './store.ts';
import type {HermesLink,Town} from './engine.ts';
import {killTree,type HermesBootstrap} from './hermes-bootstrap.ts';

// The run API the bridge uses. A Hermes without any of them, or one that takes runs without its key, gets no runs (row 4.9; spike S1).
export const REQUIRED_FEATURES=['run_submission','run_status','run_events_sse','run_stop','run_approval_response','run_unknown_resolution','approval_events'];
export const missingFeatures=(caps:any):string[]=>[...REQUIRED_FEATURES.filter(f=>caps?.features?.[f]!==true),...(caps?.auth?.required===true?[]:['auth.required'])];
// The spike's allow-list (claude-plan.ts OS_ENV, which CLI runs build on): no token or key from the owner's shell reaches Hermes.
const KEEP=OS_ENV;
// The plugin gives up at 10 s; an ask answered later would leave a card for a call Hermes already blocked (spike S4). A small margin under it.
export const GATE_DEADLINE_MS=8_000;
// Cold starts measured 7.7-22 s, the first one on a new install 25 s (spike S1).
const START_MS=180_000;
const MAX_CRASHES=8;
type Hello={pid:number;nonce:string;execAsk:string;at:string};
// hermes.json: apiKey and gateToken go to the SecretStore (secret-store.ts); nonce and hello stay, so a Clowder restart keeps a live Hermes (S7).
type Saved={apiKey?:string;gateToken?:string;nonce?:string;hello?:Hello|null};
export type SidecarOptions={dataDir:string;root:string;port:number;clowderPort:number;python?:string|null;journal:()=>Store;
  /** Builds the runtime when no python is set (plan 4.13). */bootstrap?:Pick<HermesBootstrap,'run'|'stop'>|null;
  /** Tests: the command run instead of `<python> -m hermes_cli.main gateway run`. */cmd?:string[];startMs?:number};

export class HermesSidecar implements HermesLink{
  /** This spawn's nonce. Only a hello and gate calls that carry it count. */
  nonce='';
  private child?:ChildProcess;
  private adopted=0;
  private caps=false;
  private refused=false;
  private stopping=true;
  private announced=false;
  private crashes=0;
  private startedAt=0;
  private timer?:ReturnType<typeof setTimeout>;
  private watch?:ReturnType<typeof setInterval>;
  private python:string|null=null;
  constructor(private o:SidecarOptions){}
  get home(){return join(this.o.dataDir,'hermes');}
  get url(){return `http://127.0.0.1:${this.o.port}`;}
  private get file(){return join(this.o.dataDir,'hermes.json');}
  private saved():Saved{try{return withSecrets(this.file,JSON.parse(readFileSync(this.file,'utf8')));}catch{return {};}}
  private save(patch:Saved){writeJsonAtomic(this.file,withoutSecrets(this.file,{...this.saved(),...patch}));}
  /** The API key and the gate token, made once per install: 32 random bytes each (Hermes exits on a key under 16 characters, S2). */
  keys(){
    const s=this.saved();
    if(s.apiKey&&s.gateToken)return {apiKey:s.apiKey,gateToken:s.gateToken};
    const keys={apiKey:s.apiKey||randomBytes(32).toString('hex'),gateToken:s.gateToken||randomBytes(32).toString('hex')};
    this.save(keys);return keys;
  }
  /** Both values, so every tool result is masked against them like any saved key. */
  secretValues(){const s=this.saved();return [s.apiKey,s.gateToken].filter(Boolean) as string[];}
  get hello():Hello|null{return this.saved().hello??null;}
  /** Runs may start: capabilities checked, and this spawn's plugin said hello. Whether the gateway parks (HERMES_EXEC_ASK) is checked per gate call:
   *  on a fresh home the plugin loads before the gateway sets it, so the hello's copy is often empty (measured with v0.22.5). */
  ready(){const h=this.hello;return (!!this.child||!!this.adopted)&&this.caps&&!!this.nonce&&h?.nonce===this.nonce;}
  isCurrent(nonce:unknown){return !!this.nonce&&nonce===this.nonce;}
  authorized(header:unknown){const token=this.saved().gateToken;return !!token&&typeof header==='string'&&same(header,`Bearer ${token}`);}
  private emit(type:string,data:any){try{this.o.journal().emit(type,data);}catch{/* a closed world does not stop Hermes */}}

  /** config.yaml from the template (port only), .env (the listener, no key), and the plugin copied in. */
  writeHome(){
    const home=this.home;
    mkdirSync(join(home,'plugins'),{recursive:true});
    writeFileSync(join(home,'config.yaml'),readFileSync(join(this.o.root,'hermes','config.yaml'),'utf8').replaceAll('{{PORT}}',String(this.o.port)).replaceAll('{{CLOWDER_PORT}}',String(this.o.clowderPort)));
    // No API key on disk (security pass M3): Hermes v0.22.5 reads API_SERVER_KEY from its environment (gateway/config_env.py), so spawn() passes it.
    // The whole file is rewritten, so a key line an older Clowder wrote is gone after the next start.
    writeFileSync(join(home,'.env'),`API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=${this.o.port}\n`,{mode:0o600});
    cpSync(join(this.o.root,'hermes','clowder_gate'),join(home,'plugins','clowder_gate'),{recursive:true,force:true});
    return home;
  }

  async api(method:string,path:string,body?:unknown,headers:Record<string,string>={}){
    const r=await fetch(this.url+path,{method,headers:{authorization:`Bearer ${this.keys().apiKey}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
    const text=await r.text();let json:any;try{json=JSON.parse(text);}catch{json={raw:text};}
    return {status:r.status,json};
  }
  private async capabilities(){const r=await this.api('GET','/v1/capabilities');if(r.status!==200)throw new Error(`capabilities ${r.status}`);return r.json;}

  async start(){
    if(!this.stopping)return;
    this.stopping=false;this.refused=false;this.announced=false;this.crashes=0;
    this.python=this.o.python||null;
    // No python given: the bundled runtime, built on first enable. A failed or offline setup leaves Hermes off; the status route says why.
    if(!this.o.cmd&&!this.python&&this.o.bootstrap){
      try{this.python=await this.o.bootstrap.run();}catch(e){if(!this.stopping){this.stopping=true;this.emit('hermes.refused',{reason:(e as Error).message});}return;}
      if(this.stopping)return;
    }
    if(!this.o.cmd&&!this.python){this.stopping=true;this.emit('hermes.refused',{reason:'No Hermes runtime: set CAT_HERMES_PYTHON or hermes.python.'});return;}
    this.writeHome();
    if(await this.attach())return;
    this.spawn();
  }
  /** A Hermes this Clowder started before a restart is still up: it answers our key and its hello matches the saved nonce, so it is kept (S7). */
  private async attach(){
    const s=this.saved();
    if(!s.nonce||s.hello?.nonce!==s.nonce)return false;
    const caps=await this.capabilities().catch(()=>null);
    if(!caps||this.stopping)return false;
    this.nonce=s.nonce;this.adopted=s.hello.pid;
    this.watch=setInterval(()=>void fetch(`${this.url}/health`,{signal:AbortSignal.timeout(5_000)}).then(r=>{if(!r.ok)this.lost();},()=>this.lost()),10_000);this.watch.unref();
    this.verify(caps);
    return true;
  }
  private lost(){if(!this.adopted||this.stopping)return;clearInterval(this.watch);this.kill(this.adopted);this.adopted=0;this.caps=false;this.crashed(null,'unreachable');}
  private spawn(){
    const {apiKey,gateToken}=this.keys(),home=this.home;
    this.nonce=randomUUID();this.caps=false;this.announced=false;this.save({nonce:this.nonce,hello:null});
    const env:Record<string,string>={};for(const k of KEEP)if(process.env[k]!==undefined)env[k]=process.env[k]!;
    const [file,...args]=this.o.cmd??[this.python!,'-m','hermes_cli.main','gateway','run'];
    mkdirSync(join(home,'logs'),{recursive:true});
    const out=openSync(join(home,'logs','clowder-gateway.out'),'a');
    let child:ChildProcess;
    try{child=spawn(file!,args,{cwd:home,env:{...env,HERMES_HOME:home,PYTHONUTF8:'1',CLOWDER_GATE_URL:`http://127.0.0.1:${this.o.clowderPort}`,CLOWDER_HERMES_TOKEN:gateToken,CLOWDER_HERMES_NONCE:this.nonce,API_SERVER_KEY:apiKey},stdio:['ignore',out,out],windowsHide:true});}
    finally{closeSync(out);}
    this.child=child;this.startedAt=Date.now();
    let gone=false;const exited=(code:number|null,signal:string|null)=>{if(gone||this.child!==child)return;gone=true;this.child=undefined;this.caps=false;if(this.stopping||this.refused)this.emit('hermes.stopped',{});else this.crashed(code,signal);};
    // A runtime that cannot be launched (a wrong path) is refused, not retried.
    child.once('error',e=>{const code=(e as NodeJS.ErrnoException).code??'error';if(this.child===child){this.refused=true;this.emit('hermes.refused',{reason:`Cannot run ${file}: ${code}`});}exited(null,code);});child.once('exit',exited);
    this.emit('hermes.started',{pid:child.pid??null});
    void this.whenHealthy(child);
  }
  private crashed(code:number|null,signal:string|null){
    // A Hermes that stayed up five minutes starts the backoff over: 1 s, 2 s, 4 s ... 60 s.
    if(Date.now()-this.startedAt>=300_000)this.crashes=0;
    // A Hermes that keeps dying (a port taken, a broken install) stops filling the journal: after MAX_CRASHES in a row it is left off.
    if(this.crashes>=MAX_CRASHES){this.refused=true;this.stopping=true;this.emit('hermes.refused',{reason:`Hermes stopped ${MAX_CRASHES} times in a row; restart Clowder to try again.`});return;}
    const restartInMs=Math.min(60_000,1000*2**this.crashes++);
    this.emit('hermes.crashed',{code,signal,restartInMs});
    this.timer=setTimeout(()=>{if(!this.stopping)this.spawn();},restartInMs);this.timer.unref();
  }
  private async whenHealthy(child:ChildProcess){
    const end=Date.now()+(this.o.startMs??START_MS);
    while(this.child===child&&Date.now()<end){
      const ok=await fetch(`${this.url}/health`,{signal:AbortSignal.timeout(2_000)}).then(r=>r.ok,()=>false);
      if(this.child!==child)return;
      if(ok){const caps=await this.capabilities().catch(()=>null);if(this.child===child&&caps){this.verify(caps);return;}}
      await new Promise(r=>setTimeout(r,500));
    }
    // Never healthy: killed, and the exit restarts it with backoff.
    if(this.child===child)this.kill(child.pid);
  }
  private verify(caps:any){
    const missing=missingFeatures(caps);
    if(missing.length){this.refused=true;this.emit('hermes.refused',{missing});void this.stop();return;}
    this.caps=true;this.maybeReady();
  }
  private maybeReady(){if(this.announced||!this.ready())return;this.announced=true;this.emit('hermes.ready',{pid:this.hello!.pid,...(this.adopted?{adopted:true}:{})});}

  /** The plugin's hello. Only this spawn's nonce counts; it is saved, so a Clowder restart still knows the plugin is loaded. */
  helloFrom(body:{pid:number;nonce:string;exec_ask?:string}){
    if(!this.isCurrent(body.nonce))return false;
    const hello={pid:body.pid,nonce:body.nonce,execAsk:String(body.exec_ask??''),at:new Date().toISOString()};
    this.save({hello});this.emit('hermes.hello',{pid:hello.pid,execAsk:hello.execAsk});this.maybeReady();
    return true;
  }

  /** Delivers the owner's answer to the parked call: the run's pending approval whose description carries the card id (S6), through
   *  /approval with its exact request id and generation. A run that is not parked any more is the bridge's restart path (4.10). Never throws. */
  async answer(approval:Approval,choice:'once'|'deny'){
    const run=approval.hermes?.run??this.o.journal().state.tasks.find(t=>t.id===approval.task)?.hermes?.run;
    try{
      if(!run)throw new Error('No Hermes run is known for this card.');
      const r=await this.api('GET',`/v1/runs/${encodeURIComponent(run)}`);
      const control=r.json?.status==='waiting_for_approval'?(r.json.pending_controls??[]).find((c:any)=>c?.kind==='approval'&&String(c.description??'').includes(approval.id)):null;
      if(!control)throw new Error(`The run is ${r.json?.status??`gone (${r.status})`}.`);
      const sent=await this.api('POST',`/v1/runs/${encodeURIComponent(run)}/approval`,{request_id:control.prompt_id,execution_generation:control.execution_generation??r.json.execution_generation,choice});
      if(sent.status>=300)throw new Error(`Hermes answered ${sent.status}.`);
      this.emit('hermes.answered',{approval:approval.id,run,choice});
    }catch(e){this.emit('hermes.undelivered',{approval:approval.id,run:run??null,choice,reason:(e as Error).message});}
  }

  // The venv's python.exe is a launcher, so the gateway is its child: the whole tree goes.
  private kill(pid?:number){killTree(pid);}
  async stop(){
    this.stopping=true;clearTimeout(this.timer);clearInterval(this.watch);this.o.bootstrap?.stop();
    const child=this.child,adopted=this.adopted;
    this.nonce='';this.caps=false;this.adopted=0;
    if(child&&child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(r=>{child.once('exit',r);setTimeout(r,10_000).unref();});
      this.kill(child.pid);await exited;
    }else if(adopted){this.kill(adopted);this.emit('hermes.stopped',{});}
    // Unless a start came in meanwhile: its spawn owns the saved nonce now.
    if(this.stopping)this.save({nonce:undefined,hello:null});
  }
  /** process 'exit': no awaiting there, so the tree is killed synchronously. */
  killSync(){this.o.bootstrap?.stop();this.kill(this.child?.pid??(this.adopted||undefined));}
}

export const ownLoopback=(sidecar:HermesSidecar)=>async(req:FastifyRequest,reply:FastifyReply)=>{
  // isLocal: loopback, no proxy header, a localhost Host; the gate token, not the owner session, is Hermes's credential. Main listener only.
  if(!isLocal(req))return reply.code(403).send({error:'Hermes reaches Clowder on this computer only.'});
  if(!sidecar.authorized(req.headers.authorization))return reply.code(401).send({error:'Wrong gate token.'});
};
const body=(properties:Record<string,unknown>,required:string[])=>({body:{type:'object',properties,required}});
const s=(max:number)=>({type:'string',maxLength:max});

/** The plugin's routes. Gate protocol: {tool,args,session_id,tool_call_id,nonce,t} -> {action:'allow'} | {action:'ask',approval,message} | {action:'deny',message}. */
export function registerHermesRoutes(app:FastifyInstance,sidecar:HermesSidecar,town:()=>Town){
  // Tool arguments can be whole files (push_files), past the app's 32 KB body limit.
  const opts={onRequest:ownLoopback(sidecar),bodyLimit:4_000_000};
  app.post('/api/hermes/hello',{...opts,schema:body({pid:{type:'integer',minimum:1},nonce:s(64),exec_ask:s(8)},['pid','nonce'])},async(req,reply)=>
    sidecar.helloFrom(req.body as any)?{ok:true}:reply.code(409).send({error:'Not the Hermes Clowder started.'}));
  app.post('/api/hermes/gate',{...opts,schema:body({tool:s(200),args:{},session_id:s(200),tool_call_id:s(200),nonce:s(64),t:{type:'number'},exec_ask:s(8)},['tool','session_id','tool_call_id','nonce','t'])},async req=>{
    const b=req.body as {tool:string;args?:unknown;session_id:string;tool_call_id:string;nonce:string;t:number;exec_ask?:string};
    // An older Hermes gets nothing, and neither does a call the plugin has stopped waiting for: it would leave a card for a blocked call.
    if(!sidecar.isCurrent(b.nonce))return {action:'deny',message:'This Hermes is not the one Clowder started; not run.'};
    if(Date.now()-b.t>GATE_DEADLINE_MS)return {action:'deny',message:'Clowder answered too late; not run.'};
    return town().hermesGate({session:b.session_id,tool:b.tool,args:b.args,toolCallId:b.tool_call_id,parks:b.exec_ask==='1'});
  });
  app.post('/api/hermes/result',{...opts,schema:body({tool:s(200),session_id:s(200),tool_call_id:s(200),result:s(20_000),nonce:s(64)},['tool','session_id','tool_call_id','nonce'])},async req=>{
    const b=req.body as {tool:string;session_id:string;tool_call_id:string;result?:string;nonce:string};
    return {ok:sidecar.isCurrent(b.nonce)&&town().hermesResult({session:b.session_id,tool:b.tool,toolCallId:b.tool_call_id,result:b.result??''})};
  });
}

// The one place that builds model providers, reads and writes AI model settings, reports their status,
// and registers the owner-only model routes. Settings live in <dataDir>/models.json. A key is never returned.
import {randomUUID} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, networkInterfaces, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';
import {anthropicProvider, openAIProvider, type Provider} from './provider.ts';
import {MEDIA_SPECS, buildAdapters, checkMedia, parseHostedBase as parseBase, runtimeFor, type MediaRuntime} from './media.ts';
import {artifactsDir, storeArtifact} from './artifacts.ts';
import {ENV_DROP, claudePlanProvider, runCli, spawnCli, stopCli, type PlanFault} from './claude-plan.ts';
import {denyRules} from './claude-tools.ts';
import {writeJsonAtomic} from './atomic-json.ts';
import {withSecrets,withoutSecrets} from './secret-store.ts';
import type {ToolRuntime} from './tool-runtimes.ts';
import {codexPlanProvider, defaultCodexExecutable} from './codex-plan.ts';
import {JEV_DEFAULT_BASE, JEV_DEFAULT_MODEL, jevDecider, type JevDecide} from './jev.ts';
import type {Town} from './engine.ts';
import {ANTHROPIC_DEFAULT_MODEL,AI_PROVIDERS,EFFORTS,MODEL_PATTERN,MODEL_PROVIDERS,MODEL_SUGGESTIONS,checkAi,checkTownDefault,isAiProvider,normalizeMode,pickAi,type AiChoice,type AiProvider,type TownDefault} from './ai-options.ts';

export const MODES=['demo','local','hosted','claude','chatgpt','anthropic'];
export {normalizeMode};

export const DEFAULT_OLLAMA='http://127.0.0.1:11434';
const CLAUDE_INSTALL='npm install -g @anthropic-ai/claude-code';
const CODEX_INSTALL='npm install -g @openai/codex';
const PROBE_TTL_MS=10_000,LOGIN_TIMEOUT_MS=5*60_000,LOGIN_URL_WAIT_MS=8_000,LOGIN_LINES=30;

export type Hosted={base:string;model:string;key:string};
export type Jev={base?:string;key:string;enabled:boolean};
// defaults: the owner's default model and effort per provider. Anything missing falls back to town.config.json.
// media: one saved field set per media provider (see MEDIA_SPECS). Keys are stored here and never returned to the client.
// local: Local AI on or off (on when unset). townDefault: the one provider, model and effort the cats think with when nothing else is chosen.
export type ModelSettings={claude?:{enabled:boolean};chatgpt?:{enabled:boolean};local?:{enabled:boolean};hosted?:Hosted;media?:Record<string,Record<string,string>>;jev?:Jev;anthropic?:{key:string};defaults?:Partial<Record<AiProvider,AiChoice>>;townDefault?:TownDefault};

// ponytail: whole-file read/rewrite; fine for a settings file that changes a few times a day.
export function loadSettings(file:string):ModelSettings{
  if(!existsSync(file))return {};
  let raw:any;
  try{raw=withSecrets(file,JSON.parse(readFileSync(file,'utf8')));}catch{throw new Error(`${file} is damaged. Fix or move it; AI model settings were not changed.`);}
  const s:ModelSettings={};
  if(typeof raw?.claude?.enabled==='boolean')s.claude={enabled:raw.claude.enabled};
  if(typeof raw?.chatgpt?.enabled==='boolean')s.chatgpt={enabled:raw.chatgpt.enabled};
  if(typeof raw?.local?.enabled==='boolean')s.local={enabled:raw.local.enabled};
  const h=raw?.hosted;
  if(h&&typeof h.base==='string'&&typeof h.model==='string'&&typeof h.key==='string')s.hosted={base:h.base,model:h.model,key:h.key};
  // The model and effort live in defaults.anthropic like the other providers; only the key is kept here.
  if(typeof raw?.anthropic?.key==='string'&&raw.anthropic.key)s.anthropic={key:raw.anthropic.key};
  // A saved provider that no longer passes its own rules is dropped, so the others still load.
  if(raw?.media&&typeof raw.media==='object'){
    const media:Record<string,Record<string,string>>={};
    for(const id of Object.keys(MEDIA_SPECS)){
      const v=raw.media[id];if(!v||typeof v!=='object')continue;
      const fields=Object.fromEntries(Object.entries(v).filter(([,x])=>typeof x==='string')) as Record<string,string>;
      try{media[id]=checkMedia(id,fields,fields);}catch{/* dropped */}
    }
    if(Object.keys(media).length)s.media=media;
  }
  const j=raw?.jev;
  if(j&&typeof j.enabled==='boolean'&&typeof j.key==='string'&&j.key&&(j.base===undefined||typeof j.base==='string'))s.jev={enabled:j.enabled,key:j.key,...(j.base?{base:j.base}:{})};
  const d=raw?.defaults;
  if(d&&typeof d==='object'){
    const defaults:Partial<Record<AiProvider,AiChoice>>={};
    for(const p of AI_PROVIDERS){
      // A bad saved value is dropped, so that provider falls back to town.config.json.
      try{const c=checkAi(p,d[p]??{});if(c.model||c.effort)defaults[p]=c;}catch{/* dropped */}
    }
    if(Object.keys(defaults).length)s.defaults=defaults;
  }
  // A saved town default that no longer passes its rules is dropped, so the town falls back to the chat's own choice.
  if(raw?.townDefault&&typeof raw.townDefault==='object'){try{s.townDefault=checkTownDefault(raw.townDefault);}catch{/* dropped */}}
  return s;
}

// Keys go to the SecretStore; the rest goes to a temp file that is renamed over, so a crash never leaves half a settings file.
export function saveSettings(file:string,settings:ModelSettings){writeJsonAtomic(file,withoutSecrets(file,settings));}

export const parseHostedBase=parseBase;
// Chat services with an OpenAI-style endpoint, offered as one-tap presets in the API key form. Base and model come from each
// service's docs (WebFetch, not called); keyUrl is its key page. DeepSeek's docs give the base without /v1. Groq is left out:
// its docs could not be fetched to confirm the base. The owner still types the key; the model field stays editable.
export const HOSTED_PRESETS:{id:string;label:string;base:string;model:string;keyUrl:string}[]=[
  {id:'openai',label:'OpenAI',base:'https://api.openai.com/v1',model:'gpt-6.1-sol',keyUrl:'https://platform.openai.com/api-keys'},
  {id:'gemini',label:'Google Gemini',base:'https://generativelanguage.googleapis.com/v1beta/openai',model:'gemini-3.8-flash',keyUrl:'https://aistudio.google.com/apikey'},
  {id:'kimi',label:'Moonshot Kimi',base:'https://api.moonshot.ai/v1',model:'kimi-k3.1-pro',keyUrl:'https://platform.kimi.ai/console/api-keys'},
  {id:'deepseek',label:'DeepSeek',base:'https://api.deepseek.com',model:'deepseek-flash',keyUrl:'https://platform.deepseek.com/api_keys'},
  {id:'openrouter',label:'OpenRouter',base:'https://openrouter.ai/api/v1',model:'~openai/gpt-sol-latest',keyUrl:'https://openrouter.ai/settings/keys'},
  {id:'mistral',label:'Mistral',base:'https://api.mistral.ai/v1',model:'mistral-large-latest',keyUrl:'https://console.mistral.ai'},
];

// Saved settings win; the environment variables are the fallback for a server started with them.
function hostedFrom(settings:ModelSettings,env:NodeJS.ProcessEnv):(Hosted&{source:'settings'|'env'})|null{
  const s=settings.hosted;
  if(s?.base&&s.model&&s.key)return {...s,source:'settings'};
  const base=env.CAT_MODEL_BASE,model=env.CAT_MODEL,key=env.CAT_MODEL_KEY;
  return base&&model&&key?{base,model,key,source:'env'}:null;
}
const hostedProblem=(h:Hosted):string|null=>{try{parseHostedBase(h.base);return null;}catch(err){return (err as Error).message;}};
// Jev is not a cat provider: it answers only the season's closed-choice decisions. Null when off, keyless or on a bad base.
export function jevFromSettings(settings:ModelSettings,config:any):JevDecide|null{
  const j=settings.jev;
  if(!j?.enabled||!j.key)return null;
  try{return jevDecider({base:parseHostedBase(j.base??JEV_DEFAULT_BASE),key:j.key,model:JEV_DEFAULT_MODEL,timeoutMs:config.modelTimeoutMs});}
  catch{return null;}
}
// Claude plan is on when saved; without a saved choice, CAT_CLAUDE_PLAN=1 keeps the old opt-in working.
const claudeEnabled=(settings:ModelSettings,env:NodeJS.ProcessEnv)=>settings.claude?.enabled??env.CAT_CLAUDE_PLAN==='1';
// Local AI is on unless the owner turns it off. Off means no provider is built, so chat, goals and seasons cannot pick it.
const localEnabled=(settings:ModelSettings)=>settings.local?.enabled??true;

// Saved default first, then town.config.json. The config values are the fallback and are never copied elsewhere.
const configuredFor=(provider:AiProvider,config:any):AiChoice=>provider==='local'
  ?{model:config.localModel,effort:config.localOptions?.reasoning_effort}
  :provider==='claude'?{model:config.planModel}:provider==='chatgpt'?{model:config.chatgptModel}:provider==='anthropic'?{model:config.anthropicModel??ANTHROPIC_DEFAULT_MODEL}:{};
export const defaultsFor=(provider:AiProvider,settings:ModelSettings,config:any):AiChoice=>pickAi(undefined,settings.defaults?.[provider],configuredFor(provider,config));

// Only usable providers are returned. Local is built unless turned off; its availability is probed in status.
// health hears each plan call's outcome under its Account id (accounts.ts); omitted, the outcome goes nowhere.
export function buildProviders(config:any,settings:ModelSettings,env:NodeJS.ProcessEnv,health?:(account:string,fault:PlanFault)=>void):Record<string,Provider>{
  const local=defaultsFor('local',settings,config),claude=defaultsFor('claude',settings,config),chatgpt=defaultsFor('chatgpt',settings,config);
  // Hosted gets only the effort the owner saved; localOptions are Ollama's and would be rejected by other endpoints.
  const hostedEffort=pickAi(undefined,settings.defaults?.hosted,undefined).effort;
  const providers:Record<string,Provider>={};
  if(localEnabled(settings))providers.local=openAIProvider(`${env.CAT_OLLAMA_BASE||DEFAULT_OLLAMA}/v1`,local.model??config.localModel,config.modelTimeoutMs,undefined,{...config.localOptions,...(local.effort?{reasoning_effort:local.effort}:{})});
  const hosted=hostedFrom(settings,env);
  if(hosted&&!hostedProblem(hosted))providers.hosted=openAIProvider(parseHostedBase(hosted.base),hosted.model,config.modelTimeoutMs,hosted.key,hostedEffort?{reasoning_effort:hostedEffort}:{});
  if(claudeEnabled(settings,env))providers.claude=claudePlanProvider(claude.model??config.planModel,config.modelTimeoutMs,{executable:env.CAT_CLAUDE||'claude',effort:claude.effort,health:f=>health?.('models:claude',f)});
  if(settings.chatgpt?.enabled===true)providers.chatgpt=codexPlanProvider(chatgpt.model,config.modelTimeoutMs,{executable:env.CAT_CODEX||defaultCodexExecutable(),effort:chatgpt.effort,health:f=>health?.('models:chatgpt',f)});
  // Anthropic API key: saved in models.json through the secret store. Built only when a key is saved.
  const anthropic=defaultsFor('anthropic',settings,config);
  if(settings.anthropic?.key)providers.anthropic=anthropicProvider(anthropic.model??ANTHROPIC_DEFAULT_MODEL,config.modelTimeoutMs,settings.anthropic.key,anthropic.effort);
  return providers;
}

// unsure: the CLI gave no definite answer (a timeout, a crash, unreadable output). The hub keeps its last definite answer instead.
type CliProbe={installed:boolean;loggedIn:boolean;authMethod:string|null;detail:string;unsure?:boolean};
const neverAborted=()=>new AbortController().signal;
const missing=(err:unknown)=>{const code=(err as NodeJS.ErrnoException)?.code;return code==='ENOENT'||code==='EACCES';};
const firstLine=(s:string)=>s.trim().split('\n')[0]?.slice(0,160)??'';
const notFound=(r:{code:number|null;stderr:string})=>r.code===9009||/is not recognized/i.test(r.stderr);

async function probeClaude(exe:string,timeoutMs:number):Promise<CliProbe>{
  try{
    const r=await runCli(exe,['auth','status'],'',tmpdir(),timeoutMs,neverAborted(),{label:'Claude',dropEnv:ENV_DROP});
    let info:any;try{info=JSON.parse(r.stdout);}catch{info=undefined;}
    // The exit code is ignored: a logged-out CLI may still print its status as JSON.
    if(info&&typeof info==='object')return {installed:true,loggedIn:info.loggedIn===true,authMethod:typeof info.authMethod==='string'?info.authMethod:null,detail:info.loggedIn===true?'Signed in.':'Not signed in.'};
    return {installed:!notFound(r),loggedIn:false,authMethod:null,detail:notFound(r)?'Not installed.':firstLine(r.stderr||r.stdout)||'claude auth status gave no status.',...(notFound(r)?{}:{unsure:true})};
  }catch(err){
    return {installed:!missing(err),loggedIn:false,authMethod:null,detail:missing(err)?'Not installed.':'claude auth status failed.',...(missing(err)?{}:{unsure:true})};
  }
}

async function probeCodex(exe:string,timeoutMs:number):Promise<CliProbe>{
  try{
    const r=await runCli(exe,['login','status'],'',tmpdir(),timeoutMs,neverAborted(),{label:'Codex',dropEnv:['OPENAI_API_KEY']});
    if(notFound(r))return {installed:false,loggedIn:false,authMethod:null,detail:'Not installed.'};
    const out=`${r.stdout}\n${r.stderr}`;
    const signedIn=r.code===0&&/logged in using/i.test(out)&&!/not logged in/i.test(out);
    const method=/chatgpt/i.test(out)?'chatgpt':/api key/i.test(out)?'api_key':null;
    return {installed:true,loggedIn:signedIn,authMethod:signedIn?method:null,detail:signedIn?'Signed in.':firstLine(out)||'Not signed in.'};
  }catch(err){
    return {installed:!missing(err),loggedIn:false,authMethod:null,detail:missing(err)?'Not installed.':'codex login status failed.',...(missing(err)?{}:{unsure:true})};
  }
}

// Gemini CLI has no sign-in status command that is safe to run here (reading ~/.gemini is not allowed), so "signed in" is a
// heuristic: an API key in the hub's environment, or CAT_GEMINI_SIGNED_IN=1 set by the owner after a Google sign-in. Installed is
// `gemini --version` answering. A run that is not signed in fails with a sign-in message, which the tool reports.
async function probeGemini(exe:string,timeoutMs:number,env:NodeJS.ProcessEnv):Promise<CliProbe>{
  try{
    const r=await runCli(exe,['--version'],'',tmpdir(),timeoutMs,neverAborted(),{label:'Gemini CLI',dropEnv:[]});
    if(notFound(r))return {installed:false,loggedIn:false,authMethod:null,detail:'Not installed.'};
    const installed=r.code===0;
    const signedIn=installed&&!!(env.GEMINI_API_KEY||env.GOOGLE_API_KEY||env.CAT_GEMINI_SIGNED_IN==='1');
    return {installed,loggedIn:signedIn,authMethod:signedIn?'gemini':null,detail:signedIn?'Signed in.':'Installed. Not signed in.'};
  }catch(err){
    return {installed:!missing(err),loggedIn:false,authMethod:null,detail:missing(err)?'Not installed.':'gemini --version failed.',...(missing(err)?{}:{unsure:true})};
  }
}

// null when Ollama does not answer. Otherwise the installed model names from /api/tags.
// null: Ollama is not running. undefined: it did not answer in time (a busy machine), which says nothing either way.
async function ollamaModels(base:string):Promise<string[]|null|undefined>{
  try{
    const r=await fetch(`${base}/api/tags`,{signal:AbortSignal.timeout(3000)});
    const body:any=await r.json().catch(()=>null);
    if(!r.ok)return null;
    return Array.isArray(body?.models)?body.models.map((m:any)=>m?.name).filter((n:any):n is string=>typeof n==='string'&&MODEL_PATTERN.test(n)):[];
  }catch(err){return (err as Error)?.name==='TimeoutError'?undefined:null;}
}

// loginWaitMs: how long a sign-in waits for the CLI's link before answering without one (tests on a busy machine raise it).
export type HubOptions={file:string;config:any;env:NodeJS.ProcessEnv;loginWaitMs?:number;planHealth?:(account:string,fault:PlanFault)=>void};
type Probe={ollama:boolean;ollamaModels:string[];claude:CliProbe;codex:CliProbe;gemini:CliProbe};

// Owns the live providers map. Town and the council hold the same object, so updates apply without a restart.
const LOGIN_CODE=/^[A-Za-z0-9_\-#.~]{8,600}$/;
export class ModelHub{
  readonly providers:Record<string,Provider>={};
  settings:ModelSettings;
  // refresh: started behind an earlier answer (the TTL ran out), so that answer may stand in until it lands.
  private probeCache?:{at:number;value:Promise<Probe>;done:boolean;refresh:boolean};
  /** The last definite answer per CLI. A slow or failed check reuses it, so a provider never blinks out of the Reasoning list. */
  private sure:{claude?:CliProbe;codex?:CliProbe;gemini?:CliProbe;ollama?:string[]|null}={};
  private logins=new Map<'claude'|'chatgpt',{child:ChildProcessWithoutNullStreams;url?:string;auto?:boolean}>();
  constructor(private opts:HubOptions){
    this.settings=loadSettings(opts.file);
    this.rebuild();
  }

  private rebuild(){
    const next=buildProviders(this.opts.config,this.settings,this.opts.env,this.opts.planHealth);
    for(const key of Object.keys(this.providers))delete this.providers[key];
    Object.assign(this.providers,next);
    // Tasks saved before the rename still carry mode "plan"; they resume on the Claude provider.
    if(next.claude)this.providers.plan=next.claude;
  }

  private invalidate(){this.probeCache=undefined;}

  // Cached for PROBE_TTL_MS so /api/state polling never spawns the CLIs on every request.
  // ponytail: /api/state waits on this probe (about 1.3 s for claude auth status here, once per 10 s); serve the last list while refreshing if the UI stutters.
  // Stale while revalidating: once one check has answered, callers get that answer at once and a fresh check runs behind
  // it, so /api/state never waits on a slow CLI (25 s for `claude auth status` on a loaded machine, measured once).
  // Only the first call, and a call right after invalidate(), waits.
  private settled?:Probe;
  private probe():Promise<Probe>{
    const now=Date.now();
    if(!this.probeCache||now-this.probeCache.at>=PROBE_TTL_MS){
      const stale=this.probeCache?this.settled:undefined;
      const value=this.runProbe(),cache={at:now,value,done:false,refresh:!!stale};
      void value.then(p=>{this.settled=p;cache.done=true;},()=>{cache.done=true;});
      this.probeCache=cache;
      if(stale)return Promise.resolve(stale);
    }
    // While a background check is still running, the last answer stands in for it.
    if(this.probeCache.refresh&&!this.probeCache.done&&this.settled)return Promise.resolve(this.settled);
    return this.probeCache.value;
  }
  private async runProbe():Promise<Probe>{
    const {env}=this.opts;
    // CAT_PROBE_MS: how long a sign-in check may take (8 s; the test suite on a loaded machine sets more).
    const probeMs=Number(env.CAT_PROBE_MS)>0?Number(env.CAT_PROBE_MS):8_000;
    // A probe that could not tell (a timeout on a busy machine) with no earlier definite answer to fall back on asks once more.
    const settle=(id:'claude'|'codex'|'gemini',ask:()=>Promise<CliProbe>)=>ask().then(p=>p.unsure&&!this.sure[id]?ask():p);
    // Gemini's check is short: it only runs `gemini --version`, and a slow answer keeps the last definite one.
    const [models,claude,codex,gemini]=await Promise.all([
      ollamaModels(env.CAT_OLLAMA_BASE||DEFAULT_OLLAMA).then(m=>m===undefined&&this.sure.ollama===undefined?ollamaModels(env.CAT_OLLAMA_BASE||DEFAULT_OLLAMA):m),
      settle('claude',()=>probeClaude(env.CAT_CLAUDE||'claude',probeMs)),
      settle('codex',()=>probeCodex(env.CAT_CODEX||defaultCodexExecutable(),probeMs)),
      settle('gemini',()=>probeGemini(env.CAT_GEMINI||'gemini',Math.min(probeMs,4_000),env))
    ]);
    const keep=(id:'claude'|'codex'|'gemini',p:CliProbe)=>p.unsure?this.sure[id]??p:(this.sure[id]=p);
    // A slow answer keeps the last definite one, like the CLI probes, so Local AI does not drop out of the Reasoning list.
    const local=models===undefined?this.sure.ollama??null:(this.sure.ollama=models);
    return {ollama:local!==null,ollamaModels:local??[],claude:keep('claude',claude),codex:keep('codex',codex),gemini:keep('gemini',gemini)};
  }

  /** The saved API keys (hosted, its env fallback, Jev, and each media provider's secret fields), for Town's tool-result redaction. */
  secretValues(){
    const s=this.settings,media=Object.entries(s.media??{}).flatMap(([id,v])=>(MEDIA_SPECS[id]?.fields??[]).filter(f=>f.secret).map(f=>v[f.name]));
    return [s.hosted?.key,this.opts.env.CAT_MODEL_KEY,s.jev?.key,s.anthropic?.key,...media];
  }
  // The media runtime for cats: generate_image and generate_video are served by the first saved provider that makes the kind.
  media():MediaRuntime{
    return runtimeFor(buildAdapters(this.settings.media??{},this.opts.config.modelTimeoutMs));
  }
  // One saved provider as a runtime, for its own test.
  mediaFor(id:string):MediaRuntime{
    const one=this.settings.media?.[id];
    return runtimeFor(buildAdapters(one?{[id]:one}:{},this.opts.config.modelTimeoutMs));
  }
  // The AI plans whose CLI can run the built-in web_search and code tools, in order: the Claude plan (on and signed in), the ChatGPT
  // plan through Codex (on and signed in with ChatGPT; not on Windows), then Gemini CLI (signed in). Read per call from the last definite probe,
  // so a slow check never drops a runtime for a moment. Each tool call uses the first one.
  toolRuntimes():ToolRuntime[]{
    const {settings:s,opts:{env,config:c}}=this;
    void this.probe().catch(()=>{});
    const workspaceRoot=join(homedir(),'Clowder Workspaces');
    const out:ToolRuntime[]=[];
    const claude=this.sure.claude;
    if(claudeEnabled(s,env)&&claude?.installed&&claude.loggedIn){
      const defaultModel=defaultsFor('claude',s,c).model??c.planModel;
      out.push({kind:'claude',executable:env.CAT_CLAUDE||'claude',defaultModel,fastModel:MODEL_SUGGESTIONS.claude?.includes('haiku')?'haiku':defaultModel,workspaceRoot,denyRead:denyRules(dirname(this.opts.file))});
    }
    // Security pass M3: on Windows, Codex's sandbox is unverified (a shell, maybe network, the data folder readable), so web_search and the code
    // workspace never run on it there until a measured run shows no network. The ChatGPT plan still answers chat.
    const codex=this.sure.codex;
    if(process.platform!=='win32'&&s.chatgpt?.enabled===true&&codex?.installed&&codex.loggedIn&&codex.authMethod==='chatgpt')
      out.push({kind:'chatgpt',executable:env.CAT_CODEX||defaultCodexExecutable(),defaultModel:defaultsFor('chatgpt',s,c).model,workspaceRoot,denyRead:denyRules(dirname(this.opts.file))});
    const gemini=this.sure.gemini;
    if(gemini?.installed&&gemini.loggedIn)out.push({kind:'gemini',executable:env.CAT_GEMINI||'gemini',workspaceRoot,denyRead:denyRules(dirname(this.opts.file))});
    return out;
  }
  // The runtime the built-in tools use now, or null when none is usable. worlds.ts and server.ts call this name.
  claudeTools():ToolRuntime|null{return this.toolRuntimes()[0]??null;}

  async status(){
    const p=await this.probe(),{settings:s,opts:{env,config:c}}=this;
    const hosted=hostedFrom(s,env),problem=hosted?hostedProblem(hosted):null;
    const hostedReady=!!hosted&&!problem;
    // Names and the settings panel show the resolved default: the saved value when set, else town.config.json.
    const localDef=defaultsFor('local',s,c),claudeDef=defaultsFor('claude',s,c),chatgptDef=defaultsFor('chatgpt',s,c);
    // The one list of model names per provider, served from this status. Local lists the installed Ollama models only;
    // Claude and ChatGPT add the resolved default, so a saved or configured default is always selectable.
    const aiBlock=(p:AiProvider,models:string[])=>({efforts:[...EFFORTS[p]],models,default:defaultsFor(p,s,c),saved:s.defaults?.[p]??{}});
    const withDefault=(names:readonly string[],def:AiChoice)=>[...new Set([...names,...(def.model?[def.model]:[])])];
    const localOn=localEnabled(s),localReady=localOn&&p.ollama;
    const claudeOn=claudeEnabled(s,env),claudeReady=p.claude.installed&&p.claude.loggedIn;
    const chatgptOn=s.chatgpt?.enabled===true,chatgptReady=p.codex.installed&&p.codex.loggedIn&&p.codex.authMethod==='chatgpt';
    const jevSaved=s.jev,jevProblem=jevSaved?.key?(()=>{try{parseHostedBase(jevSaved.base??JEV_DEFAULT_BASE);return null;}catch(err){return (err as Error).message;}})():'Not set. Add a key.';
    const jevOn=jevSaved?.enabled===true,jevReady=jevOn&&!jevProblem;
    const anth=s.anthropic?.key,anthropicDef=defaultsFor('anthropic',s,c);
    return {
      // The town's default thinking. usable is false when that provider is off or not built, so nothing falls back to it.
      townDefault:this.describeTownDefault(s.townDefault),
      jev:{id:'jev',name:`Jev decisions · ${JEV_DEFAULT_MODEL}`,enabled:jevOn,configured:!!jevSaved?.key&&!jevProblem,available:jevReady,
        base:jevSaved?.base??null,hasKey:!!jevSaved?.key,keyLast4:jevSaved?.key&&jevSaved.key.length>=12?jevSaved.key.slice(-4):null,
        detail:jevProblem??(jevOn?'Ready. Used only for approvals; LLMs still do open-ended work.':'Off.')},
      local:{id:'local',name:`Local AI · ${localDef.model}`,enabled:localOn,configured:p.ollama,available:localReady,
        ai:aiBlock('local',p.ollamaModels),
        detail:!localOn?'Off. Cats will not use Local AI.':p.ollama?'Ollama is answering.':'Ollama is not answering. Start Ollama and install the model.'},
      hosted:{id:'hosted',name:`API · ${hosted?.model??'not set'}`,enabled:!!hosted,configured:hostedReady,available:hostedReady,presets:HOSTED_PRESETS,
        ai:aiBlock('hosted',[]),
        source:hosted?.source??null,base:hosted?.source==='settings'?hosted.base:null,model:hosted?.model??null,
        hasKey:!!hosted?.key,keyLast4:hosted&&hosted.key.length>=12?hosted.key.slice(-4):null,
        detail:problem??(hosted?'Ready.':'Not set. Add an HTTPS base, model and key.')},
      claude:{id:'claude',name:`Claude plan · ${claudeDef.model}`,enabled:claudeOn,configured:claudeReady,available:claudeOn&&claudeReady,
        ai:aiBlock('claude',withDefault(MODEL_SUGGESTIONS.claude??[],claudeDef)),
        installed:p.claude.installed,loggedIn:p.claude.loggedIn,authMethod:p.claude.authMethod,
        installHint:p.claude.installed?null:CLAUDE_INSTALL,detail:p.claude.detail},
      chatgpt:{id:'chatgpt',name:`ChatGPT plan · ${chatgptDef.model}`,enabled:chatgptOn,configured:chatgptReady,available:chatgptOn&&chatgptReady,
        ai:aiBlock('chatgpt',withDefault(MODEL_SUGGESTIONS.chatgpt??[],chatgptDef)),
        installed:p.codex.installed,loggedIn:p.codex.loggedIn,authMethod:p.codex.authMethod,
        installHint:p.codex.installed?null:CODEX_INSTALL,detail:p.codex.detail},
      anthropic:{id:'anthropic',name:`Anthropic API · ${anthropicDef.model}`,enabled:!!anth,configured:!!anth,available:!!anth,
        ai:aiBlock('anthropic',withDefault(MODEL_SUGGESTIONS.anthropic??[],anthropicDef)),hasKey:!!anth,keyLast4:anth&&anth.length>=12?anth.slice(-4):null,
        detail:anth?'Ready.':'Not set. Add an API key.'},
    };
  }

  // The list the UI offers: demo plus every usable provider. Built from the status, so a disabled provider is left out.
  async list(){return modelList(await this.status());}

  // Validates everything before saving. A changed endpoint without a new key does not reuse the old key.
  async update(input:{claude?:{enabled:boolean};chatgpt?:{enabled:boolean};local?:{enabled:boolean};townDefault?:{provider:AiProvider;model?:string|null;effort?:string|null}|null;hosted?:{base:string;model:string;key?:string}|null;media?:Record<string,Record<string,unknown>|null>;jev?:{enabled:boolean;base?:string;key?:string}|null;anthropic?:{key?:string}|null;defaults?:Partial<Record<AiProvider,{model?:string|null;effort?:string|null}|null>>}){
    const next:ModelSettings={...this.settings};
    if(input.claude)next.claude={enabled:input.claude.enabled};
    if(input.chatgpt)next.chatgpt={enabled:input.chatgpt.enabled};
    if(input.local)next.local={enabled:input.local.enabled};
    if(input.townDefault===null)delete next.townDefault;
    else if(input.townDefault)next.townDefault=checkTownDefault(input.townDefault);
    // Each provider's default is replaced as a whole. Blank or null clears it back to town.config.json.
    if(input.defaults){
      const defaults={...next.defaults};
      for(const [provider,value] of Object.entries(input.defaults)){
        if(!isAiProvider(provider))throw new Error('Unknown AI provider.');
        const choice=value?checkAi(provider,{model:value.model??undefined,effort:value.effort??undefined}):{};
        if(choice.model||choice.effort)defaults[provider]=choice;else delete defaults[provider];
      }
      if(Object.keys(defaults).length)next.defaults=defaults;else delete next.defaults;
    }
    if(input.hosted===null)delete next.hosted;
    else if(input.hosted){
      const base=parseHostedBase(input.hosted.base);
      const model=input.hosted.model.trim();
      if(!model)throw new Error('Enter a model name.');
      const typed=(input.hosted.key??'').trim();
      const kept=this.settings.hosted?.base===base?this.settings.hosted.key:undefined;
      const key=typed||kept;
      if(!key)throw new Error('Enter an API key for this endpoint.');
      next.hosted={base,model,key};
    }
    if(input.media){
      // Each provider is checked whole before anything is saved. A null entry removes that provider.
      const media={...next.media};
      for(const [id,value] of Object.entries(input.media)){
        if(!MEDIA_SPECS[id])throw new Error('Unknown media provider.');
        if(value===null)delete media[id];
        else media[id]=checkMedia(id,value as Record<string,unknown>,this.settings.media?.[id]);
      }
      if(Object.keys(media).length)next.media=media;else delete next.media;
    }
    if(input.jev===null)delete next.jev;
    else if(input.jev){
      const base=input.jev.base?.trim()?parseHostedBase(input.jev.base.trim()):undefined;
      const typed=(input.jev.key??'').trim();
      // Same rule as hosted: a typed key wins, and the saved key is kept only when the endpoint is unchanged.
      const kept=(this.settings.jev?.base??undefined)===base?this.settings.jev?.key:undefined;
      const key=typed||kept;
      if(!key)throw new Error('Enter an API key for Jev.');
      next.jev={enabled:input.jev.enabled,key,...(base?{base}:{})};
    }
    if(input.anthropic===null)delete next.anthropic;
    else if(input.anthropic){
      // Same rule as hosted: a typed key wins; the saved key stays when the field is left blank.
      const key=(input.anthropic.key??'').trim()||this.settings.anthropic?.key;
      if(!key)throw new Error('Enter an API key for Anthropic.');
      next.anthropic={key};
    }
    saveSettings(this.opts.file,next);
    this.settings=next;
    this.rebuild();
    this.invalidate();
  }

  // Jev is kept out of providers and list(): it answers only the season's decision actions.
  jev():JevDecide|null{return jevFromSettings(this.settings,this.opts.config);}
  async townDefaultStatus(){return (await this.status()).townDefault;}
  // A town default as the status shows it: model and effort filled from the provider's own default. usable is false when the provider is not built.
  describeTownDefault(td:TownDefault|null|undefined){
    const def=td?defaultsFor(td.provider,this.settings,this.opts.config):null;
    return td&&def?{provider:td.provider,model:td.model??def.model??null,effort:td.effort??def.effort??null,usable:!!this.providers[td.provider]}:null;
  }
  // The town default for the cats, or null when it is unset or its provider is not built (off, or not configured). Read per call.
  townDefault():TownDefault|null{const td=this.settings.townDefault;return td&&this.providers[td.provider]?td:null;}

  // Starts the official CLI's own sign-in. Only the first URL it prints is kept; no tokens are read.
  // The browser can end on an "Authentication code" page that says to paste the code into Claude Code. The sign-in
  // runs as a child process, so the owner pastes it in the app and it goes to that CLI's stdin. Never stored or logged.
  submitLoginCode(provider:'claude'|'chatgpt',code:string):{ok:true}{
    const entry=this.logins.get(provider);
    if(!entry)throw new Error('No sign-in is waiting for a code. Start the sign-in again.');
    if(typeof code!=='string'||!LOGIN_CODE.test(code.trim()))throw new Error('That does not look like an authentication code.');
    entry.child.stdin.write(code.trim()+'\n');
    return {ok:true};
  }
  async login(provider:'claude'|'chatgpt'):Promise<{started:true;url?:string;auto?:true;browsers?:{id:string;name:string}[];vpn?:string;alreadyRunning?:true}>{
    const running=this.logins.get(provider);
    if(running)return {started:true,...(running.url?{url:running.url}:{}),...(running.auto?{auto:true as const,browsers:loginBrowsers()}:{}),alreadyRunning:true};
    const {env}=this.opts;
    const spec=provider==='claude'
      ?{exe:env.CAT_CLAUDE||'claude',args:['auth','login','--claudeai'],dropEnv:ENV_DROP,label:'Claude Code',install:CLAUDE_INSTALL}
      :{exe:env.CAT_CODEX||defaultCodexExecutable(),args:['login'],dropEnv:['OPENAI_API_KEY'],label:'Codex',install:CODEX_INSTALL};
    // Claude Code opens the browser through BROWSER when it is set. Ours records the link and opens the default browser, so
    // the page that comes back to the CLI on localhost is the one shown: no code to paste. The printed link is the fallback.
    const opener=provider==='claude'?loginOpener():null;
    const child=spawnCli(spec.exe,spec.args,{cwd:tmpdir(),dropEnv:spec.dropEnv,...(opener?{env:{BROWSER:opener.script,CLOWDER_LOGIN_URL_FILE:opener.file}}:{})});
    const entry:{child:ChildProcessWithoutNullStreams;url?:string;auto?:boolean}={child};
    this.logins.set(provider,entry);
    const failure:{error?:NodeJS.ErrnoException}={};
    let wake:()=>void=()=>{};
    const urlFound=new Promise<void>(resolve=>{wake=resolve;});
    let output='',lines=0;
    const scan=(chunk:string)=>{
      if(lines<LOGIN_LINES){output+=chunk;lines+=chunk.split('\n').length-1;}
      entry.url??=/https:\/\/[^\s"'<>]+/.exec(output)?.[0];
      if(entry.url)wake();
    };
    const timer=setTimeout(()=>stopCli(child),LOGIN_TIMEOUT_MS);
    timer.unref();
    const finish=()=>{
      clearTimeout(timer);
      if(this.logins.get(provider)===entry)this.logins.delete(provider);
      this.invalidate();
      wake();
    };
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',scan);child.stderr.on('data',scan);
    child.stdin.on('error',()=>{});
    child.on('error',err=>{failure.error=err as NodeJS.ErrnoException;finish();});
    child.on('close',finish);
    // The opener's link can land seconds after the printed one (cmd.exe start-up; 3 s measured once on this machine), so the
    // sign-in waits for it, the CLI's exit, or the limit. It keeps watching after that, so a second tap gets the late link.
    let limit:NodeJS.Timeout|undefined;
    const gone=new Promise<void>(resolve=>child.on('close',()=>resolve()));
    const opened=opener?new Promise<void>(resolve=>{
      const tick=setInterval(()=>{const url=opener.read();if(url){entry.url=url;entry.auto=true;clearInterval(tick);resolve();}},100);
      child.on('close',()=>clearInterval(tick));
    }):urlFound;
    await Promise.race([opened,gone,new Promise<void>(resolve=>{limit=setTimeout(resolve,this.opts.loginWaitMs??LOGIN_URL_WAIT_MS);})]);
    clearTimeout(limit);
    if(failure.error)throw new Error(failure.error.code==='ENOENT'?`${spec.label} is not installed. Install it with: ${spec.install}`:`Could not start ${spec.label}.`);
    return {started:true,...(entry.url?{url:entry.url}:{}),...(entry.auto?{auto:true as const,browsers:loginBrowsers()}:{}),...(provider==='claude'&&vpnAdapter()?{vpn:vpnAdapter()!}:{})};
  }
  // When the default browser fails the sign-in site's check, the same no-paste link opens in another installed browser.
  openLoginIn(provider:'claude'|'chatgpt',browser:string):{ok:true}{
    const entry=this.logins.get(provider);
    if(!entry?.auto||!entry.url)throw new Error('Start the sign-in first.');
    const exe=BROWSERS[browser]?.paths().find(p=>existsSync(p));
    if(!exe)throw new Error('That browser is not installed.');
    spawn(exe,[entry.url],{detached:true,stdio:'ignore'}).unref();
    return {ok:true};
  }
}

// Browsers the sign-in link can be handed to on Windows, by their standard install folders.
export const BROWSERS:Record<string,{name:string;paths:()=>string[]}>={
  edge:{name:'Edge',paths:()=>['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe']},
  chrome:{name:'Chrome',paths:()=>['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',...(process.env.LOCALAPPDATA?[join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe')]:[])]},
  firefox:{name:'Firefox',paths:()=>['C:/Program Files/Mozilla Firefox/firefox.exe','C:/Program Files (x86)/Mozilla Firefox/firefox.exe']},
};
// A VPN tunnel that is up, by its adapter name, or null. Claude's sign-in site often refuses VPN addresses as unverified
// browsers, so the sign-in card names it. Names are the common clients' adapters; an unknown VPN is simply not named.
const VPN_ADAPTER=/^(ProTUN|Proton|NordLynx|Mullvad|WireGuard|wg\d|tun\d|utun\d|TAP-|ExpressVPN|Surfshark|CloudflareWARP|PIA)/i;
export const vpnAdapter=(nets:Record<string,unknown>=networkInterfaces())=>Object.keys(nets).find(n=>VPN_ADAPTER.test(n))??null;
export const loginBrowsers=()=>process.platform==='win32'?Object.entries(BROWSERS).filter(([,b])=>b.paths().some(p=>existsSync(p))).map(([id,b])=>({id,name:b.name})):[];

// A one-line browser opener for the Claude CLI: it writes the sign-in link to a file and opens the default browser with it.
// Only an https link on claude.com, claude.ai or anthropic.com is ever read back.
const LOGIN_LINK=/^https:\/\/([a-z0-9-]+\.)*(claude\.com|claude\.ai|anthropic\.com)\/[^\s"]*$/i;
function loginOpener(){
  const dir=join(tmpdir(),'clowder-login');mkdirSync(dir,{recursive:true});
  const file=join(dir,`link-${randomUUID()}.txt`);
  const win=process.platform==='win32',script=join(dir,win?'open-browser.cmd':'open-browser.sh');
  writeFileSync(script,win?'@echo off\r\n>"%CLOWDER_LOGIN_URL_FILE%" echo %1\r\nstart "" %1\r\n':'#!/bin/sh\nprintf \'%s\\n\' "$1" > "$CLOWDER_LOGIN_URL_FILE"\n(xdg-open "$1" || open "$1") >/dev/null 2>&1 &\n');
  if(!win)chmodSync(script,0o755);
  return {script,file,read:():string|undefined=>{
    // The opener ends its line with a newline; until then the file may still be being written.
    let text='';try{text=readFileSync(file,'utf8');}catch{return undefined;}
    if(!text.endsWith('\n'))return undefined;
    rmSync(file,{force:true});
    const url=text.trim().replace(/^"|"$/g,'');
    return LOGIN_LINK.test(url)?url:undefined;
  }};
}

// The provider entries only: the town default is a settings value, not a provider, so callers that index providers drop it.
export function providerStatus(s:Awaited<ReturnType<ModelHub['status']>>){const {townDefault:_townDefault,...providers}=s;return providers;}
export type ModelListEntry={id:string;name:string;label:string;models:string[]};
// Pure: the chat Reasoning menu and the owner pickers read this. Only usable providers appear; each carries its model names.
export function modelList(s:Awaited<ReturnType<ModelHub['status']>>):ModelListEntry[]{
  return [
    {id:'demo',name:'Demonstration · scripted',label:'Demonstration',models:[]},
    ...(s.local.available?[{id:'local',name:s.local.name,label:'Local AI',models:s.local.ai.models}]:[]),
    ...(s.hosted.available?[{id:'hosted',name:s.hosted.name,label:'API key',models:s.hosted.model?[s.hosted.model]:[]}]:[]),
    ...(s.claude.available?[{id:'claude',name:s.claude.name,label:'Claude plan',models:s.claude.ai.models}]:[]),
    ...(s.chatgpt.available?[{id:'chatgpt',name:s.chatgpt.name,label:'ChatGPT plan',models:s.chatgpt.ai.models}]:[]),
    ...(s.anthropic.available?[{id:'anthropic',name:s.anthropic.name,label:'Anthropic API',models:s.anthropic.ai.models}]:[]),
  ];
}

export function mediaStatus(saved:Record<string,Record<string,string>>){
  return Object.entries(MEDIA_SPECS).map(([id,spec])=>{
    const cfg=saved[id];
    const hasKey=!!cfg?.key;
    const kinds:string[]=id==='custom'?[cfg?.kind??'image']:id==='higgsfield'?(cfg?.imageModel?['image']:[]):id==='seedance'?[...(cfg?.imageModel?['image']:[]),...(cfg?.videoModel?['video']:[])]:id==='moneyprinter'?['video']:['image'];
    return {
      id,label:spec.label,note:spec.note??null,hint:spec.hint??null,presets:spec.presets??[],kinds,configured:!!cfg,
      values:Object.fromEntries(spec.fields.filter(f=>!f.secret&&cfg?.[f.name]!==undefined).map(f=>[f.name,cfg![f.name]])),
      hasKey,keyLast4:hasKey&&cfg!.key.length>=12?cfg!.key.slice(-4):null,
      fields:spec.fields.map(f=>({name:f.name,label:f.label,secret:!!f.secret,required:!!f.required,url:!!f.url,choices:f.choices??null,default:f.default??null,max:f.max})),
      detail:cfg?'Saved. Check settings sends nothing; Generate test image makes one billable call.':'Not set.',
    };
  });
}

export const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{
  if(!isOwner(req))return reply.code(403).send({error:'AI model settings are managed on the host computer.'});
};
const hostedSchema={anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['base','model'],properties:{
  base:{type:'string',minLength:1,maxLength:300},model:{type:'string',minLength:1,maxLength:120},key:{type:'string',maxLength:500}}}]};
const toggle={type:'object',additionalProperties:false,required:['enabled'],properties:{enabled:{type:'boolean'}}};
const jevSchema={anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['enabled'],properties:{
  enabled:{type:'boolean'},base:{type:'string',maxLength:300},key:{type:'string',maxLength:500}}}]};
const aiChoiceText=(max:number)=>({type:['string','null'],maxLength:max});
const aiDefault={anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{model:aiChoiceText(120),effort:aiChoiceText(20)}}]};
const defaultsSchema={type:'object',additionalProperties:false,properties:Object.fromEntries(AI_PROVIDERS.map(p=>[p,aiDefault]))};
const mediaBody={type:'object',additionalProperties:false,properties:Object.fromEntries(Object.keys(MEDIA_SPECS).map(id=>[id,{anyOf:[{type:'null'},{type:'object',additionalProperties:{type:'string',maxLength:4000}}]}]))};
const townDefaultSchema={anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['provider'],properties:{provider:{type:'string',enum:[...AI_PROVIDERS]},model:aiChoiceText(120),effort:aiChoiceText(20)}}]};
const anthropicSchema={anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{key:{type:'string',maxLength:500}}}]};
const settingsBody={type:'object',additionalProperties:false,properties:{claude:toggle,chatgpt:toggle,local:toggle,hosted:hostedSchema,media:mediaBody,jev:jevSchema,anthropic:anthropicSchema,defaults:defaultsSchema,townDefault:townDefaultSchema}};

// Owner-only per-cat model and effort. A suggestion becomes the cat's override only when the owner accepts it.
export function registerCatAiRoutes(app:FastifyInstance,town:Pick<Town,'setCatAi'|'answerCatAi'>){
  app.post('/api/cats/:id/ai',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,required:['provider'],properties:{provider:{type:'string',enum:[...AI_PROVIDERS]},model:{type:['string','null'],maxLength:120},effort:{type:['string','null'],maxLength:20}}}}},async(req,reply)=>{
    const b=req.body as any;
    try{return {result:town.setCatAi('owner',(req.params as {id:string}).id,b.provider,{model:b.model,effort:b.effort})};}catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
  app.post('/api/cats/:id/ai/suggestion',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,required:['accept'],properties:{accept:{type:'boolean'}}}}},async(req,reply)=>{
    try{return {result:town.answerCatAi('owner',(req.params as {id:string}).id,(req.body as any).accept)};}catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
}

// Owner-only. The media list (keys reduced to their last four characters) and the provider checks. "Check settings" sends nothing.
// "Generate test image" is the only billable call, and it runs only when generate is true.
export function registerMediaRoutes(app:FastifyInstance,hub:ModelHub,world:()=>{journal:Parameters<typeof storeArtifact>[0]['journal'];dir:string}){
  app.get('/api/models/media',{onRequest:ownerOnly},async()=>mediaStatus(hub.settings.media??{}));
  app.post('/api/models/media/:id/test',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,properties:{generate:{type:'boolean'}}}}},async(req,reply)=>{
    const id=(req.params as {id:string}).id;
    if(!MEDIA_SPECS[id])return reply.code(404).send({error:'Unknown media provider.'});
    const saved=hub.settings.media?.[id];
    if(!saved)return reply.code(400).send({error:'Save this provider first.'});
    if((req.body as {generate?:boolean}).generate!==true)return {checked:true,note:'Settings look complete. Nothing was sent to the provider.'};
    const runtime=hub.mediaFor(id);
    if(!runtime.has('image'))return reply.code(400).send({error:'Test images are made by image providers.'});
    try{
      const file=await runtime.generate({prompt:'A small test picture of a cat painting in a sunny meadow.',kind:'image'},new AbortController().signal);
      const target=world();
      const record=storeArtifact({journal:target.journal,dir:artifactsDir(target.dir),cat:'owner',task:null,project:null,title:'Test image',kind:'image',bytes:file.bytes});
      return {artifact:record.id};
    }catch(err){return reply.code(502).send({error:(err as Error).message});}
  });
}

// Owner-only: the guard runs before body validation, so a LAN viewer gets 403 rather than a schema error.
export function registerModelRoutes(app:FastifyInstance,hub:ModelHub){
  app.get('/api/models/status',{onRequest:ownerOnly},async()=>hub.status());
  app.post('/api/models/settings',{onRequest:ownerOnly,schema:{body:settingsBody}},async(req,reply)=>{
    try{await hub.update(req.body as any);}catch(err){return reply.code(400).send({error:(err as Error).message});}
    return hub.status();
  });
  for(const provider of ['claude','chatgpt'] as const)app.post(`/api/models/${provider}/login`,{onRequest:ownerOnly},async(_req,reply)=>{
    try{return await hub.login(provider);}catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
  for(const provider of ['claude','chatgpt'] as const)app.post(`/api/models/${provider}/login/code`,{onRequest:ownerOnly,schema:{body:{type:'object',required:['code'],additionalProperties:false,properties:{code:{type:'string',minLength:8,maxLength:600}}}}},async(req,reply)=>{
    try{return hub.submitLoginCode(provider,(req.body as {code:string}).code);}catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
  app.post('/api/models/claude/login/open',{onRequest:ownerOnly,schema:{body:{type:'object',required:['browser'],additionalProperties:false,properties:{browser:{type:'string',enum:['edge','chrome','firefox']}}}}},async(req,reply)=>{
    try{return hub.openLoginIn('claude',(req.body as {browser:string}).browser);}catch(err){return reply.code(400).send({error:(err as Error).message});}
  });
}

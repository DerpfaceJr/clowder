// Resumable season runner for the coin economy. Spec: docs/economy-spec.md.
// The journal is the only state. Each batch is appended before the next one is computed,
// so Ctrl-C loses at most the model call in flight.
import {appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {act, apply, capabilityDecider, checkInvariants, marketStep, replay, rng, startSeason, startTick} from './economy.ts';
import type {EconomyConfig, EconomyEvent, EconomyState, Pending} from './economy.ts';
import type {Provider} from './provider.ts';
import {MODES, buildProviders, jevFromSettings, loadSettings, normalizeMode} from './models.ts';
import {catAiFromJournal,type AiChoice,type AiProvider} from './ai-options.ts';
import {jevCost} from './jev.ts';
import type {JevDecide} from './jev.ts';
import {ownerDirectives} from './season-view.ts';
import {memoryFor} from './memory.ts';
import {loadConfig} from './config.ts';
import {townCats} from './store.ts';
import {allRoles} from './roles.ts';
import {autonomyPrompt,envelopeMultiplier,loadAutonomy,seasonAutonomyNote,type AutonomyLevel} from './autonomy.ts';
import {Workshop} from './workshop.ts';
import type {InstalledTool, RunResult} from './workshop.ts';

// jev: injected decider for tests; undefined reads models.json, null turns Jev off. Demo mode never uses it.
// workshop: injected for tests; undefined uses the real cat-workshop distro, null has no tools.
export type WorkshopLike={installedTools():InstalledTool[];run(cat:string,toolId:string,args:unknown,opts?:{timeoutSeconds?:unknown}):Promise<RunResult>};
export type SeasonOpts={name:string;mode:'demo'|'local'|'hosted'|'claude'|'chatgpt'|'plan';seed?:number;days?:number;dataDir:string;sharedDataDir?:string;config:any;provider?:Provider;jev?:JevDecide|null;workshop?:WorkshopLike|null;stopAfterTicks?:number;autonomy?:AutonomyLevel;log?:(line:string)=>void};
type Pick={name:string;args:Record<string,any>};

const paths=(name:string,dataDir:string)=>{
  if(!/^[\w-]+$/.test(name))throw new Error(`Season name must be letters, digits, - or _: ${name}`);
  return {journal:join(dataDir,`season-${name}.jsonl`),lock:join(dataDir,`season-${name}.lock`)};
};
const alive=(pid:number)=>{
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(err:any){return err?.code==='EPERM';}
};
function acquire(lock:string):()=>void{
  if(existsSync(lock)){
    const pid=Number(readFileSync(lock,'utf8').trim());
    if(alive(pid))throw new Error(`Season is already running as pid ${pid} (${lock}). Stop it first.`);
  }
  writeFileSync(lock,String(process.pid));
  return()=>{if(existsSync(lock)&&readFileSync(lock,'utf8').trim()===String(process.pid))rmSync(lock,{force:true});};
}
// Lock state for one season: a lock whose pid is gone is stale and does not count as running.
export function seasonLock(name:string,dataDir:string):{running:boolean;pid?:number}{
  const {lock}=paths(name,dataDir);
  if(!existsSync(lock))return {running:false};
  const pid=Number(readFileSync(lock,'utf8').trim());
  return alive(pid)?{running:true,pid}:{running:false,pid};
}
function readJournal(path:string):EconomyEvent[]{
  if(!existsSync(path))return [];
  const lines=readFileSync(path,'utf8').split('\n');
  if(lines.at(-1)==='')lines.pop();
  return lines.map((line,i)=>{
    try{const e=JSON.parse(line);if(typeof e?.type!=='string')throw new Error('not an event');return e as EconomyEvent;}
    catch{throw new Error(`Season journal ${path} is damaged at line ${i+1}${i+1===lines.length?' (the last line)':''}. Refusing to run; fix or move the file.`);}
  });
}
// Pass notes written by askModel when the model did not give a usable action.
const FALLBACK_NOTES=['model error','no tool call','malformed arguments','arguments not an object','unknown action'];
const lastIndex=(evs:EconomyEvent[],type:string)=>{for(let i=evs.length-1;i>=0;i--)if(evs[i].type===type)return i;return -1;};
const isOpen=(evs:EconomyEvent[])=>lastIndex(evs,'tick.started')>lastIndex(evs,'tick.closed');
const keyOf=(name:string,tick:number,cat:string)=>`${name}:${tick}:${cat}`;

// Choosing a mode on the season command is the opt-in, so the matching provider is built even if its saved toggle is off.
function providerFor(mode:string,config:any,dataDir:string):Provider{
  const saved=loadSettings(join(dataDir,'models.json'));
  const settings={...saved,...(mode==='claude'?{claude:{enabled:true}}:{}),...(mode==='chatgpt'?{chatgpt:{enabled:true}}:{})};
  const provider=buildProviders(config,settings,process.env)[mode];
  if(!provider)throw new Error(mode==='hosted'?'Hosted mode needs an HTTPS base, model and key in AI models settings, or CAT_MODEL_BASE, CAT_MODEL and CAT_MODEL_KEY.':`${mode} is not available.`);
  return provider;
}

// One tool per economy action. Argument schemas follow docs/economy-spec.md.
function toolDefs(cats:string[],maxPrice:number,hasTools:boolean,recipes:{define:boolean;decide:boolean}={define:false,decide:false}){
  const fn=(name:string,description:string,properties:any,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
  const str={type:'string'},reason={type:'string',maxLength:200,description:'One short sentence, at most 200 characters.'};
  const int=(minimum:number,maximum?:number)=>({type:'integer',minimum,...(maximum===undefined?{}:{maximum})});
  const biz={business:{type:'string',description:'Business id, e.g. b1'}};
  const cat={type:'string',enum:cats};
  return [
    fn('open_business','Open a business you own. Its startup coins are spent or requested from the Banker.',{name:str,pitch:str,category:str,price:int(1,maxPrice),unitCost:int(1,maxPrice),startup:int(1)},['name','pitch','category','price','unitCost','startup']),
    fn('buy_stock','Buy stock for a business you own. Costs units x unitCost.',{...biz,units:int(1,1000)},['business','units']),
    fn('set_price','Set the price of a business you own.',{...biz,price:int(1,maxPrice)},['business','price']),
    fn('market','Spend coins to boost today\'s demand for a business.',{...biz,amount:int(1)},['business','amount']),
    fn('close_business','Close a business you own. Its stock is lost.',{...biz,reason:str},['business','reason']),
    fn('research','Get a noisy estimate of how well a category fits the town.',{category:str},['category']),
    fn('review','Get a noisy estimate of a business\'s fit.',biz,['business']),
    fn('set_envelope','Mayor only: set a cat\'s spending envelope.',{cat,amount:int(0)},['cat','amount']),
    fn('decide_spend','Banker or Mayor only: approve or reject another cat\'s spend request.',{id:str,approved:{type:'boolean'},reason},['id','approved','reason']),
    fn('request_capability','Ask for a tool you lack. kind package needs source npm:<name> or pypi:<name>; kind repo needs source https://github.com/<owner>/<repo>. The Mayor decides package and repo requests. account, api, money and network are owner-tier: they go to the human and can never be granted, so the source there is optional text up to 200 characters. You may have one open request at a time.',{kind:{type:'string',enum:['package','repo','account','api','money','network']},need:str,purpose:str,source:str},['kind','need','purpose']),
    fn('decide_capability','Mayor only (the Banker for a request from the Mayor): approve or reject a pending package or repo request. Owner-tier requests cannot be decided.',{id:str,approved:{type:'boolean'},reason},['id','approved','reason']),
    fn('message','Send a short message to another cat. No coin effect.',{to:cat,text:str},['to','text']),
    ...(recipes.define?[fn('define_repo_tool','Give an approved repo request a run recipe so it can be used. entry is argv: an allowlisted program (python3, pip, node, npm, npx, bash, sh, make) or a file path inside the repo, then its arguments. No shell strings, and no -c, -e or -p. setup is up to 8 install steps, run once when the recipe is approved. workdir is a path inside the repo. long lets a run take up to 900 seconds when the owner allows long jobs.',{toolId:str,entry:{type:'array',items:{type:'string',maxLength:200},minItems:1,maxItems:16},workdir:str,setup:{type:'array',maxItems:8,items:{type:'array',items:{type:'string',maxLength:200},minItems:1,maxItems:16}},description:str,long:{type:'boolean'}},['toolId','entry','description'])]:[]),
    ...(recipes.decide?[fn('decide_recipe','Mayor only (the Banker for a recipe from the Mayor): approve or reject a pending run recipe.',{id:str,approved:{type:'boolean'},reason},['id','approved','reason'])]:[]),
    ...(hasTools?[fn('use_tool','Run one tool from your installedTools inside the sandbox. Costs no coins; the output is logged. Files the tool writes to out/ become gallery artifacts. timeoutSeconds only applies to a long recipe.',{toolId:str,args:{type:'array',items:{type:'string',maxLength:200},maxItems:8},timeoutSeconds:int(1,900)},['toolId'])]:[]),
    fn('pass','Take no action this tick.',{note:str},[]),
  ];
}

function systemPrompt(c:{id:string;name:string;role:string},autonomy:AutonomyLevel){
  return `You are the ${c.name} of Clowder (cat id: ${c.id}). ${c.role}
The town shares one coin treasury with every cat. You may invent any business you want and run it yourself. Outcomes are computed by the market; claims you make change nothing.${c.id==='mayor'?' Owner directives are the owner\'s wishes for the town; weigh them when setting envelopes, deciding spends and messaging cats.':''}
${[autonomyPrompt(autonomy),seasonAutonomyNote(autonomy)].filter(Boolean).join(' ')}
If you lack a tool you need, request it with request_capability; owner-tier kinds go to the human and are never granted. Tools already installed are listed in installedTools; run one with use_tool.
For set_price, buy_stock and close_business, act only on businesses marked yours: true.
Take exactly one action this tick by calling one tool. Be concise.`;
}

// Only what this cat is allowed to see. Business fit is hidden, and the view is built from fields, never spread.
export function view(s:EconomyState,events:EconomyEvent[],cat:string,dataDir:string,config:EconomyConfig,installed:InstalledTool[]=[]){
  const own=events.filter(e=>e.type==='action'&&e.cat===cat).slice(-5).map(e=>({name:e.name,args:e.args,ok:e.ok,result:e.result}));
  const notes=events.filter(e=>e.type==='action'&&e.name==='message'&&e.args?.to===cat).slice(-5).map(e=>({from:e.cat,text:e.args?.text}));
  return {
    day:s.day,tick:s.tick,ticksPerDay:s.ticksPerDay,totalTicks:s.days*s.ticksPerDay,
    balance:s.balance,available:s.balance-s.reserved,yourEnvelope:s.envelopes[cat]??0,
    businesses:s.businesses.map(b=>({id:b.id,owner:b.owner,name:b.name,category:b.category,price:b.price,unitCost:b.unitCost,stock:b.stock,open:b.open,yours:b.owner===cat})),
    yourBusinesses:s.businesses.filter(b=>b.open&&b.owner===cat).map(b=>({id:b.id,name:b.name})),
    knownTools:config.knownTools??[],
    installedTools:installed.map(t=>({id:t.id,kind:t.kind,source:t.source,purpose:t.purpose,howToCall:`use_tool with toolId "${t.id}" and args (up to 8 short texts)`})),
    pendingSpends:s.pending.map(p=>({id:p.id,cat:p.cat,amount:p.amount,purpose:p.purpose,business:p.business})),
    yourLastResults:own,messagesToYou:notes,
    yourCapabilityRequests:s.capabilities.filter(c=>c.cat===cat).map(c=>({id:c.id,need:c.need,kind:c.kind,source:c.source,status:c.status})),
    townCapabilities:s.capabilities.filter(c=>c.status==='approved').map(c=>({id:c.id,need:c.need,kind:c.kind,source:c.source,status:c.status})),
    // The Mayor and Banker see only the pending sandbox-tier requests they are allowed to decide.
    repoRequestsToDefine:s.capabilities.filter(c=>c.kind==='repo'&&c.status==='approved'&&!c.recipe).map(c=>({id:c.id,need:c.need,source:c.source})),
    ...(cat==='mayor'||cat==='banker'?{recipesToDecide:s.capabilities.filter(c=>c.recipe?.status==='pending'&&capabilityDecider(c.recipe.cat)===cat).map(c=>({id:c.id,cat:c.recipe!.cat,description:c.recipe!.description,entry:c.recipe!.entry}))}:{}),
    ...(cat==='mayor'||cat==='banker'?{capabilityRequestsToDecide:s.capabilities.filter(c=>c.status==='pending'&&c.tier==='sandbox'&&capabilityDecider(c.cat)===cat).map(c=>({id:c.id,cat:c.cat,need:c.need,purpose:c.purpose,kind:c.kind,source:c.source}))}:{}),
    // The season journal has no timestamps, so the last few owner messages are used without a since-filter.
    ...(cat==='mayor'?{ownerDirectives:ownerDirectives(join(dataDir,'events.jsonl'))}:{}),
    // Town knowledge brief (memory.ts); empty when the town has no record of this cat.
    townMemory:memoryFor(dataDir,undefined,false).brief(cat,400),
  };
}

async function askModel(provider:Provider,tools:any[],c:{id:string;name:string;role:string},visible:any,autonomy:AutonomyLevel,ai?:AiChoice):Promise<{pick:Pick;input:number|null;output:number|null}>{
  let reply:any;
  try{reply=await provider([{role:'system',content:systemPrompt(c,autonomy)},{role:'user',content:JSON.stringify(visible)}],tools,new AbortController().signal,ai);}
  catch(err:any){
    // A fatal provider error (plan limit, login) stops the season; the journal stays resumable.
    if(err?.fatal===true)throw err;
    return {pick:{name:'pass',args:{note:`model error: ${String(err?.message??err).slice(0,120)}`}},input:null,output:null};
  }
  const input=reply?.usage?.prompt_tokens??null,output=reply?.usage?.completion_tokens??null;
  const pass=(note:string)=>({pick:{name:'pass',args:{note}},input,output});
  const call=reply?.message?.tool_calls?.[0]?.function;
  if(!call)return pass('no tool call');
  let args:any;
  try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;}catch{return pass('malformed arguments');}
  if(!args||typeof args!=='object'||Array.isArray(args))return pass('arguments not an object');
  if(!tools.some(t=>t.function.name===call.name))return pass(`unknown action ${call.name}`);
  return {pick:{name:call.name,args},input,output};
}

// Routing is fixed here, one rule per request: the banker decides spends from anyone but itself, and the mayor decides
// spends the banker asked for; the banker and mayor decide capability requests as capabilityDecider says. Nothing else goes to Jev.
const spendDecider=(requester:string)=>requester==='banker'?'mayor':'banker';
function jevDecision(s:EconomyState,cat:string):{kind:'spend';p:Pending}|{kind:'capability';c:EconomyState['capabilities'][number]}|null{
  const p=s.pending.find(x=>x.cat!==cat&&spendDecider(x.cat)===cat);
  if(p)return {kind:'spend',p};
  const c=s.capabilities.find(x=>x.status==='pending'&&x.tier==='sandbox'&&capabilityDecider(x.cat)===cat);
  return c?{kind:'capability',c}:null;
}

// Returns null when Jev has no decision for this cat or fails; the caller then runs the cat's LLM turn as before.
async function jevRoute(jev:JevDecide,s:EconomyState,events:EconomyEvent[],cat:string,dataDir:string,config:EconomyConfig,installed:InstalledTool[]):Promise<{pick:Pick;usage:EconomyEvent[]}|null>{
  const d=jevDecision(s,cat);
  if(!d)return null;
  const visible=view(s,events,cat,dataDir,config,installed);
  const choices=['approve','reject'];
  let question:string,decision:Record<string,unknown>;
  if(d.kind==='spend'){
    const {p}=d;
    question=`Should spend request ${p.id} be approved? ${p.cat} asks for ${p.amount} coins for "${p.purpose}". Approve only if the treasury can cover it and the visible state supports the purpose; otherwise reject.`;
    decision={kind:'spend',id:p.id,requester:p.cat,amount:p.amount,purpose:p.purpose,...(p.business?{business:p.business}:{})};
  }else{
    const {c}=d;
    question=`Should capability request ${c.id} (${c.kind}: ${c.need}) from ${c.cat} be approved? It runs in the sandbox. Approve only if the purpose justifies it; otherwise reject.`;
    decision={kind:'capability',id:c.id,requester:c.cat,capability:c.kind,need:c.need,purpose:c.purpose,source:c.source,approvedCount:s.capabilities.filter(x=>x.status==='approved').length,maxCapabilities:config.maxCapabilities};
  }
  let answer:Awaited<ReturnType<JevDecide>>;
  try{answer=await jev(question,choices,{...visible,decision});}
  catch{return null;}
  const approved=answer.choice==='approve';
  const reason=`Jev: ${answer.choice} (${answer.score==null?'no score':answer.score.toFixed(2)})`;
  const pick:Pick=d.kind==='spend'
    ?{name:'decide_spend',args:{id:d.p.id,approved,reason}}
    :{name:'decide_capability',args:{id:d.c.id,approved,reason}};
  return {pick,usage:[{type:'usage',cat,provider:'jev',input:null,output:null,cost:jevCost(answer.usage)} as EconomyEvent]};
}

// Demo never runs a tool. Otherwise the outcome is what the workshop returned, truncated for the journal.
export async function toolOutcome(workshop:WorkshopLike|null,cat:string,args:any,demo:boolean):Promise<{ok:boolean;result:string}>{
  if(demo)return {ok:false,result:'demo: not run'};
  if(!workshop)return {ok:false,result:'The workshop is not available.'};
  try{
    const r=await workshop.run(cat,String(args?.toolId),args?.args,{timeoutSeconds:args?.timeoutSeconds});
    const head=r.timedOut?'timed out':`exit ${r.exitCode}`;
    const saved=r.files.length?` Saved ${r.files.length} file(s) to the gallery.`:'';
    const skipped=r.skipped.length?` Not saved: ${r.skipped.slice(0,3).join('; ')}.`:'';
    return {ok:r.ok,result:`${head}: ${r.output||'(no output)'}${r.truncated?' [output truncated]':''}${saved}${skipped}`.slice(0,1000)};
  }catch(err){return {ok:false,result:(err as Error).message.slice(0,1000)};}
}

// Demo policy: no model. Deterministic from the seed, state and cat id.
const IDEAS:[string,string,string][]=[
  ['Moonlit Fish Stall','fish','Fresh catch for late-night cats'],
  ['Catnip Cafe','cafe','Warm drinks and sweet crumbs'],
  ['Yarn Works','crafts','Hand-dyed yarn and knitting kits'],
  ['Sunbeam Bakery','bakery','Breads baked at dawn'],
  ['Whisker Tailors','fashion','Tiny scarves and bow ties'],
  ['Lantern Books','books','Used books and quiet nooks'],
  ['Mousewood Toys','toys','Wooden toys that roll'],
  ['Tea Garden','cafe','Loose-leaf tea by the window'],
];
const CATEGORIES=['fish','cafe','crafts','bakery','fashion','books','toys'];

function demoPick(s:EconomyState,config:EconomyConfig,cat:string):Pick{
  const t=s.tickIndex,r=rng(s.seed,'policy',cat,t);
  const pick=(name:string,args:Record<string,any>):Pick=>({name,args});
  const pass=(note:string)=>pick('pass',{note});
  const decideSpend=(p:Pending,approved:boolean,reason:string)=>pick('decide_spend',{id:p.id,approved,reason});
  const available=s.balance-s.reserved;
  const open=s.businesses.filter(b=>b.open);
  switch(cat){
    case 'mayor':{
      const first=['merchant','builder','scholar'];
      if(t<first.length&&s.cats.includes(first[t]))return pick('set_envelope',{cat:first[t],amount:40+Math.floor(r()*81)});
      const big=s.pending.find(p=>p.cat!==cat&&p.amount>=120);
      if(big){
        const ok=s.balance>=2*big.amount;
        return decideSpend(big,ok,ok?`the treasury covers ${big.amount} coins`:`${big.amount} coins is too much for the treasury right now`);
      }
      const ask=s.capabilities.find(c=>c.status==='pending'&&c.tier==='sandbox'&&capabilityDecider(c.cat)===cat);
      if(ask&&s.capabilities.filter(c=>c.status==='approved').length<s.maxCapabilities)return pick('decide_capability',{id:ask.id,approved:true,reason:`${ask.kind} runs in the sandbox and installs later`});
      return pass('nothing for the Mayor to decide');
    }
    case 'banker':{
      const p=s.pending.find(x=>x.cat!==cat);
      if(!p)return pass('no requests waiting');
      const b=s.businesses.find(x=>x.id===p.business);
      if(p.amount<=60)return decideSpend(p,true,`${p.amount} coins is a small test`);
      if(b?.open&&b.stock>0&&p.amount<=150)return decideSpend(p,true,`${b.name} already has stock to sell`);
      return decideSpend(p,false,`${p.amount} coins with no sales evidence yet`);
    }
    case 'critic':{
      const pool=open.filter(b=>b.owner!==cat);
      if(!pool.length)return pass('no other businesses to review');
      const b=pool[Math.floor(r()*pool.length)];
      if(t%2===1)return pick('message',{to:b.owner,text:`Review of ${b.name}: ${b.stock} in stock at ${b.price}. Sell through before restocking.`});
      return pick('review',{business:b.id});
    }
    case 'scholar':{
      if(t===2&&!s.capabilities.some(c=>c.cat===cat))return pick('request_capability',{kind:'package',source:'npm:csv-parse',need:'parse market data',purpose:'Read price tables in CSV form when a business needs its sales history.'});
      if(t%2===0)return pick('research',{category:CATEGORIES[Math.floor(r()*CATEGORIES.length)]});
      const note=s.journal.get(keyOf('research',t-1,cat))?.result;
      return note?pick('message',{to:'merchant',text:`Research note: ${note}`}):pass('nothing new to report');
    }
    case 'archivist':
      return t%2===1?pick('message',{to:'mayor',text:`Tick ${t}: ${open.length} open businesses, balance ${s.balance}.`}):pass('no new summary');
    default:{
      // Merchant, builder, operator and any recruit: open one business, then run it.
      if(cat==='builder'&&t===5&&!s.capabilities.some(c=>c.cat===cat))return pick('request_capability',{kind:'account',need:'a real web shop',purpose:'Put the town\'s products in a shop the owner can run.'});
      if(s.pending.some(p=>p.cat===cat))return pass('waiting for a banker decision');
      const mine=open.filter(b=>b.owner===cat);
      if(!mine.length){
        const free=IDEAS.filter(([n])=>!s.businesses.some(b=>b.name===n));
        const pool=free.length?free:IDEAS;
        const [name,category,pitch]=pool[Math.floor(r()*pool.length)];
        const price=5+Math.floor(r()*36);
        const unitCost=Math.max(1,Math.min(price-1,Math.floor(price*(0.3+0.3*r()))));
        return pick('open_business',{name,pitch,category,price,unitCost,startup:30+Math.floor(r()*121)});
      }
      const b=mine[0];
      const affordable=Math.floor(available/b.unitCost);
      if(b.stock<4&&affordable>=1)return pick('buy_stock',{business:b.id,units:Math.min(affordable,2+Math.floor(r()*4))});
      const roll=r();
      if(roll<0.3){
        const step=(1+Math.floor(r()*3))*(r()<0.5?-1:1);
        return pick('set_price',{business:b.id,price:Math.min(config.maxPrice,Math.max(b.unitCost+1,b.price+step))});
      }
      if(roll<0.6&&available>=40)return pick('market',{business:b.id,amount:10+Math.floor(r()*21)});
      return pick('message',{to:'mayor',text:`${b.name}: ${b.stock} in stock at ${b.price}.`});
    }
  }
}

export async function runSeason(opts:SeasonOpts):Promise<{events:EconomyEvent[];done:boolean}>{
  const {name,dataDir,config}=opts;
  // Models are global, so the saved settings come from the shared dir; the journal, lock and autonomy stay in the world.
  const shared=opts.sharedDataDir??dataDir;
  const mode=normalizeMode(opts.mode);
  if(!MODES.includes(mode))throw new Error(`Unknown mode ${mode}.`);
  const log=opts.log??(()=>{});
  const file=paths(name,dataDir);
  // Autonomy scales only the starting envelope, once, when the season starts; the journal then carries the value.
  const autonomy:AutonomyLevel=opts.autonomy??loadAutonomy(dataDir);
  const economy:EconomyConfig={...config.economy,...(opts.days===undefined?{}:{days:opts.days}),recipeReview:autonomy==='cautious'?'owner':'mayor',defaultEnvelope:Math.round(config.economy.defaultEnvelope*envelopeMultiplier(config,autonomy))};
  mkdirSync(dataDir,{recursive:true});
  const release=acquire(file.lock);
  const onSignal=()=>{release();process.exit(130);};
  const signals=['SIGINT','SIGTERM'] as const;
  for(const sig of signals)process.once(sig,onSignal);
  try{
    const events=readJournal(file.journal);
    let state=replay(events);
    const append=(batch:EconomyEvent[])=>{
      if(!batch.length)return;
      appendFileSync(file.journal,batch.map(e=>`${JSON.stringify(e)}\n`).join(''));
      for(const e of batch){events.push(e);state=apply(state,e);}
    };
    if(!state.started){
      append(startSeason(economy,townCats(join(dataDir,'events.jsonl'),config.cats).map(c=>c.id),opts.seed??1));
    }else{
      if(opts.seed!==undefined&&opts.seed!==state.seed)throw new Error(`Season ${name} runs with seed ${state.seed}, not ${opts.seed}.`);
      if(opts.days!==undefined&&opts.days!==state.days)throw new Error(`Season ${name} has ${state.days} days, not ${opts.days}.`);
    }
    const provider=mode==='demo'?undefined:(opts.provider??providerFor(mode,config,shared));
    const jev=mode==='demo'?null:opts.jev!==undefined?opts.jev:jevFromSettings(loadSettings(join(shared,'models.json')),config);
    // Undefined uses the real distro (it reads files only until a tool runs); tests pass a fake or null.
    const workshop:WorkshopLike|null=opts.workshop===undefined?new Workshop({dataDir,settingsDir:opts.sharedDataDir??dataDir}):opts.workshop;
    const catInfo=(id:string)=>allRoles(config).find((c:any)=>c.id===id)??{id,name:id,role:'A cat of the town.'};
    // Each cat's own model override, read from the town journal once per run. Applies even when a provider is injected.
    const catAi=catAiFromJournal(join(dataDir,'events.jsonl'));
    let closed=0,done=false;
    for(;;){
      if(!isOpen(events)){
        const next=startTick(state,economy);
        if(!next.length){done=true;break;}
        if(closed>=(opts.stopAfterTicks??Infinity))break;
        append(next);
      }
      const t=state.tickIndex;
      // Cats that already acted this tick (journaled) are skipped, so a mid-tick crash resumes cleanly.
      const acted=new Set(events.slice(lastIndex(events,'tick.started')).filter(e=>e.type==='action').map(e=>e.cat));
      const installed=workshop?workshop.installedTools():[];
      const tools=toolDefs(state.cats,economy.maxPrice,installed.length>0,{define:state.capabilities.some(c=>c.kind==='repo'&&c.status==='approved'&&!c.recipe),decide:state.capabilities.some(c=>c.recipe?.status==='pending')});
      for(const cat of state.cats){
        if(acted.has(cat))continue;
        let pick:Pick,usage:EconomyEvent[]=[];
        const routed=jev?await jevRoute(jev,state,events,cat,dataDir,economy,installed):null;
        if(routed){pick=routed.pick;usage=routed.usage;}
        else if(provider){
          const reply=await askModel(provider,tools,catInfo(cat),view(state,events,cat,dataDir,economy,installed),autonomy,catAi[cat]?.[mode as AiProvider]);
          pick=reply.pick;
          usage=[{type:'usage',cat,input:reply.input,output:reply.output}];
        }else pick=demoPick(state,economy,cat);
        const outcome=pick.name==='use_tool'?await toolOutcome(workshop,cat,pick.args,mode==='demo'):undefined;
        const out=act(state,economy,cat,keyOf(pick.name,t,cat),pick.name,pick.args,outcome);
        append([...usage,...out.events]);
      }
      // Market and the close marker go in one write, so a crash cannot leave a market applied without its close.
      append([...marketStep(state,economy),{type:'tick.closed',day:state.day,tick:state.tick}]);
      closed++;
      log(`day ${state.day} tick ${state.tick} closed; balance ${state.balance}`);
    }
    return {events,done};
  }finally{
    for(const sig of signals)process.off(sig,onSignal);
    release();
  }
}

export function seasonStatus(name:string,dataDir:string,config:any):string{
  const file=paths(name,dataDir);
  const head=`season ${name}`;
  if(!existsSync(file.journal))return `${head}: no journal at ${file.journal}`;
  let events:EconomyEvent[];
  try{events=readJournal(file.journal);}catch(err:any){return `${head}\n  journal: DAMAGED. ${err.message}`;}
  const s=replay(events);
  if(!s.started)return `${head}\n  journal has no season.started`;
  const total=s.days*s.ticksPerDay;
  const closed=events.filter(e=>e.type==='tick.closed').length;
  const cur=events[lastIndex(events,'tick.started')];
  const age=((Date.now()-statSync(file.journal).mtimeMs)/1000).toFixed(0);
  const pid=existsSync(file.lock)?Number(readFileSync(file.lock,'utf8').trim()):NaN;
  const lock=!existsSync(file.lock)?'not running (no lock file)':alive(pid)?`running (pid ${pid})`:`not running (stale lock for pid ${pid})`;
  const delta=s.balance-s.startingCoins;
  const actions=events.filter(e=>e.type==='action');
  const ok=actions.filter(e=>e.ok).length;
  const passes=actions.filter(e=>e.ok&&e.name==='pass');
  const fallbacks=passes.filter(e=>FALLBACK_NOTES.some(p=>String(e.args?.note??'').startsWith(p))).length;
  const purpose=new Map(events.filter(e=>e.type==='coins.reserved').map((e):[string,string]=>[e.id,String(e.purpose)]));
  const upkeepPaid=events.filter(e=>e.type==='coins.settled'&&purpose.get(e.id)?.startsWith('upkeep')).reduce((n,e)=>n+e.amount,0);
  const upkeepClosed=events.filter(e=>e.type==='business.closed'&&e.reason==='could not pay upkeep').length;
  const requester=new Map(events.filter(e=>e.type==='spend.requested').map((e):[string,string]=>[e.id,e.cat]));
  const decided=events.filter(e=>e.type==='spend.decided'&&e.by!=='system');
  const handoffs=decided.filter(e=>requester.get(e.id)!==e.by).length;
  const approved=decided.filter(e=>e.approved).length;
  const rejected=decided.length-approved;
  const sold=events.filter(e=>e.type==='business.sold');
  const messages=actions.filter(e=>e.name==='message'&&e.ok).length;
  // Jev decisions are counted apart from model calls: they carry cost, not tokens.
  const usage=events.filter(e=>e.type==='usage'&&e.provider!=='jev');
  const jevUse=events.filter(e=>e.type==='usage'&&e.provider==='jev');
  const sum=(k:string)=>usage.reduce((n,e)=>n+(e[k]??0),0);
  const unknown=usage.filter(e=>e.input==null).length;
  const jevCostKnown=jevUse.reduce((n,e)=>n+(typeof e.cost==='number'?e.cost:0),0);
  const jevCostUnknown=jevUse.filter(e=>typeof e.cost!=='number').length;
  const violations=checkInvariants(events);
  const open=s.businesses.filter(b=>b.open);
  return [
    head,
    `  progress: ${closed} of ${total} ticks closed; ${closed>=total?'finished':`current day ${cur?.day} tick ${cur?.tick}`}`,
    `  lock: ${lock}; last journal write ${age}s ago`,
    `  balance: ${s.balance} (start ${s.startingCoins}, delta ${delta>=0?'+':''}${delta}); earned ${s.earned}, settled ${s.settled}`,
    `  upkeep paid: ${upkeepPaid}; businesses closed for upkeep: ${upkeepClosed}`,
    `  businesses open: ${open.length}; sales ${sold.length} ticks, ${sold.reduce((n,e)=>n+e.units,0)} units`,
    ...open.map(b=>`    ${b.name} (${b.id}, ${b.owner}) stock ${b.stock}, price ${b.price}`),
    `  actions: ${ok} ok (${passes.length} passes, of which ${fallbacks} model fallbacks), ${actions.length-ok} rejected`,
    `  spend decisions: ${approved} approved, ${rejected} rejected (excluding expiries); hand-offs ${handoffs}`,
    `  messages: ${messages}`,
    `  model calls: ${usage.length}, input tokens ${sum('input')}, output tokens ${sum('output')}, calls with unknown usage ${unknown}`,
    ...(jevUse.length?[`  jev decisions: ${jevUse.length}, cost $${jevCostKnown.toFixed(6)}, decisions with unknown cost ${jevCostUnknown}`]:[]),
    violations.length?`  invariants VIOLATED (${violations.length}): ${violations.slice(0,5).join('; ')}`:'  invariants OK',
  ].join('\n');
}

async function main(){
  const root=fileURLToPath(new URL('../',import.meta.url));
  const config=loadConfig(root);
  const argv=process.argv.slice(2);
  const flag=(f:string)=>{const i=argv.indexOf(f);return i<0?undefined:argv[i+1];};
  const name=flag('--name')??'s1';
  const mode=normalizeMode(flag('--mode')??'demo');
  if(!MODES.includes(mode))throw new Error('--mode must be demo, local, hosted, claude, chatgpt or anthropic (plan is an alias for claude).');
  const integer=(v:string|undefined,label:string)=>{
    if(v===undefined)return undefined;
    const n=Number(v);
    if(!Number.isInteger(n))throw new Error(`${label} must be an integer.`);
    return n;
  };
  const seed=integer(flag('--seed'),'--seed'),days=integer(flag('--days'),'--days');
  if(days!==undefined&&days<1)throw new Error('--days must be at least 1.');
  const dataDir=resolve(process.env.CAT_TOWN_DATA||join(root,'data'));
  if(argv.includes('--status')){console.log(seasonStatus(name,dataDir,config));return;}
  let r;
  const sharedDataDir=resolve(process.env.CAT_TOWN_SHARED_DATA||dataDir);
  try{r=await runSeason({name,mode:mode as SeasonOpts['mode'],seed,days,dataDir,sharedDataDir,config,log:line=>console.log(line)});}
  catch(err:any){
    if(err?.fatal!==true)throw err;
    console.log(`season paused: ${err.message}; run the same command again later to continue`);
    return;
  }
  console.log(r.done?`season ${name}: finished`:`season ${name}: paused; run the same command again to continue`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(err=>{console.error(err.message);process.exitCode=1;});
}

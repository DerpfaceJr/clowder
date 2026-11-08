// Pure coin economy engine. Spec: docs/economy-spec.md. No I/O, no models.
import {validateRecipe} from './workshop-recipe.ts';
export type EconomyEvent={type:string;[k:string]:any};
export type EconomyConfig={startingCoins:number;ticksPerDay:number;days:number;baseDemand:number;baseUpkeep:number;upkeepDivisor:number;elasticity:number;maxPrice:number;maxActionsPerTick:number;defaultEnvelope:number;spendExpiryTicks:number;maxCapabilities:number;knownTools?:{kind:string;source:string;purpose:string}[];recipeReview?:'mayor'|'owner'};
// A run recipe for an approved repo request. Proposed by a cat; the Mayor (or the Banker for the Mayor) decides, or the owner under cautious autonomy.
export type RunRecipe={cat:string;status:'pending'|'approved'|'rejected'|'needs_owner';entry:string[];workdir:string|null;setup:string[][];description:string;long:boolean};
export type Business={id:string;owner:string;name:string;pitch:string;category:string;price:number;unitCost:number;fit:number;startup:number;stock:number;open:boolean;marketed:Record<string,number>};
export type Reservation={id:string;key:string;cat:string;amount:number;purpose:string;envelope:boolean;status:'open'|'settled'|'released'};
export type Pending={id:string;cat:string;amount:number;purpose:string;business?:string;tick:number;then:EconomyEvent};
export type Capability={id:string;cat:string;need:string;purpose:string;kind:string;source:string|null;tier:'sandbox'|'owner';status:'pending'|'approved'|'rejected'|'needs_owner';recipe?:RunRecipe};
export type EconomyState={seed:number;startingCoins:number;cats:string[];ticksPerDay:number;days:number;defaultEnvelope:number;started:boolean;tickIndex:number;day:number;tick:number;balance:number;reserved:number;earned:number;settled:number;envelopes:Record<string,number>;reservations:Reservation[];pending:Pending[];businesses:Business[];businessSeq:number;spendSeq:number;journal:Map<string,{ok:boolean;result:string}>;actions:Record<string,number>;capabilities:Capability[];capSeq:number;maxCapabilities:number};
const ACTIONS=['open_business','buy_stock','set_price','market','close_business','research','review','set_envelope','decide_spend','request_capability','decide_capability','define_repo_tool','decide_recipe','message','use_tool','pass'];
// Kind decides the tier; cats never choose it. Owner-tier requests have no grant path yet.
const CAPABILITY_TIER:Record<string,'sandbox'|'owner'>={package:'sandbox',repo:'sandbox',account:'owner',api:'owner',money:'owner',network:'owner'};
export const ownerTierKinds=():string[]=>Object.keys(CAPABILITY_TIER).filter(k=>CAPABILITY_TIER[k]==='owner');
const OWNER_REQUEST_LIMIT=2;
const PACKAGE_SOURCE=/^(npm|pypi):((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,80})$/;
const REPO_SOURCE=/^https:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}$/;
export const capabilityTier=(kind:unknown):'sandbox'|'owner'|undefined=>typeof kind==='string'&&Object.hasOwn(CAPABILITY_TIER,kind)?CAPABILITY_TIER[kind]:undefined;
// Who decides a sandbox-tier request: the Mayor, or the Banker when the Mayor is the requester.
export const capabilityDecider=(requester:string)=>requester==='mayor'?'banker':'mayor';
// Why a new request is refused, or undefined. One pending request per cat; at most OWNER_REQUEST_LIMIT
// requests waiting on the owner per cat; no second owner ask with the same kind and need (case-insensitive).
export function capabilityRefusal(s:EconomyState,cat:string,kind:unknown,tier:'sandbox'|'owner',need:unknown):string|undefined{
  if(s.capabilities.some(c=>c.cat===cat&&c.status==='pending'))return 'You already have a pending capability request.';
  if(tier!=='owner')return undefined;
  const key=String(need).toLowerCase();
  if(s.capabilities.some(c=>c.status==='needs_owner'&&c.kind===kind&&String(c.need).toLowerCase()===key))return 'The owner already has this request.';
  if(s.capabilities.filter(c=>c.cat===cat&&c.status==='needs_owner').length>=OWNER_REQUEST_LIMIT)return `You already have ${OWNER_REQUEST_LIMIT} requests waiting on the owner.`;
  return undefined;
}
export function validCapabilitySource(kind:unknown,source:unknown):boolean{
  if(capabilityTier(kind)==='owner')return source===null||source===undefined||(typeof source==='string'&&source.length<=200);
  if(typeof source!=='string')return false;
  if(kind==='package')return PACKAGE_SOURCE.test(source);
  if(kind==='repo')return REPO_SOURCE.test(source);
  return false;
}

export function rng(seed:number,...keys:(string|number)[]):()=>number{
  const text=[seed,...keys].join('\u001f');
  let h=0x811c9dc5;
  for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),0x01000193);
  let a=h>>>0;
  return()=>{a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};
}
const clamp=(x:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,x));
const round2=(x:number)=>(Math.round(x*100)/100).toFixed(2);
const normal=(r:()=>number)=>{const u=Math.max(r(),1e-12);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*r());};
const quality=(seed:number,category:string)=>clamp(Math.exp(0.4*normal(rng(seed,'category',category.toLowerCase()))),0.2,1.8);
const fitOf=(seed:number,id:string,category:string)=>clamp(quality(seed,category)*(0.8+0.4*rng(seed,'business',id)()),0.2,1.8);
const int=(x:any,lo:number,hi:number)=>Number.isInteger(x)&&x>=lo&&x<=hi;
const str=(x:any,max=200)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const business=(s:EconomyState,id:any)=>s.businesses.find(b=>b.id===id);
const nextBusinessId=(s:EconomyState)=>`b${s.businessSeq+1}`;
const bump=(s:EconomyState,id:string)=>{const n=Number(id.slice(1));if(Number.isFinite(n))s.businessSeq=Math.max(s.businessSeq,n);};
const effectPossible=(s:EconomyState,then:EconomyEvent)=>then.type==='business.opened'?!business(s,then.id):!!business(s,then.id)?.open;

export function initialState():EconomyState{
  return {seed:0,startingCoins:0,cats:[],ticksPerDay:1,days:0,defaultEnvelope:0,started:false,tickIndex:-1,day:0,tick:0,balance:0,reserved:0,earned:0,settled:0,envelopes:{},reservations:[],pending:[],businesses:[],businessSeq:0,spendSeq:0,journal:new Map(),actions:{},capabilities:[],capSeq:0,maxCapabilities:Infinity};
}

export function apply(s:EconomyState,e:EconomyEvent):EconomyState{
  switch(e.type){
    case 'season.started':Object.assign(s,{started:true,seed:e.seed,startingCoins:e.startingCoins,cats:e.cats,ticksPerDay:e.ticksPerDay,days:e.days,defaultEnvelope:e.defaultEnvelope,maxCapabilities:e.maxCapabilities??Infinity,balance:e.startingCoins,envelopes:Object.fromEntries(e.cats.map((c:string)=>[c,e.defaultEnvelope]))});break;
    case 'tick.started':s.day=e.day;s.tick=e.tick;s.tickIndex=e.day*s.ticksPerDay+e.tick;s.actions={};break;
    case 'action':s.journal.set(e.key,{ok:e.ok,result:e.result});if(!['message','pass'].includes(e.name))s.actions[e.cat]=(s.actions[e.cat]??0)+1;break;
    case 'envelope.set':s.envelopes[e.cat]=e.amount;break;
    case 'spend.requested':s.pending.push({id:e.id,cat:e.cat,amount:e.amount,purpose:e.purpose,...(e.business?{business:e.business}:{}),tick:s.tickIndex,then:structuredClone(e.then)});if(e.business)bump(s,e.business);break;
    case 'spend.decided':s.pending=s.pending.filter(p=>p.id!==e.id);break;
    case 'coins.reserved':s.reservations.push({id:e.id,key:e.key,cat:e.cat,amount:e.amount,purpose:e.purpose,envelope:e.envelope,status:'open'});s.reserved+=e.amount;if(String(e.id).startsWith('sp'))s.spendSeq++;break;
    case 'coins.settled':{const r=s.reservations.find(x=>x.id===e.id);if(r&&r.status==='open'){r.status='settled';s.reserved-=r.amount;if(r.envelope)s.envelopes[r.cat]-=e.amount;}s.balance-=e.amount;s.settled+=e.amount;break;}
    case 'coins.released':{const r=s.reservations.find(x=>x.id===e.id);if(r&&r.status==='open'){r.status='released';s.reserved-=r.amount;}break;}
    case 'coins.earned':s.balance+=e.amount;s.earned+=e.amount;break;
    case 'business.opened':s.businesses.push({id:e.id,owner:e.owner,name:e.name,pitch:e.pitch,category:e.category,price:e.price,unitCost:e.unitCost,fit:e.fit,startup:e.startup??0,stock:0,open:true,marketed:{}});bump(s,e.id);break;
    case 'business.priced':{const b=business(s,e.id);if(b)b.price=e.price;break;}
    case 'business.stocked':{const b=business(s,e.id);if(b)b.stock+=e.units;break;}
    case 'business.marketed':{const b=business(s,e.id);if(b){const day=String(e.day);b.marketed[day]=(b.marketed[day]??0)+e.amount;}break;}
    case 'business.sold':{const b=business(s,e.id);if(b)b.stock-=e.units;break;}
    case 'business.closed':{const b=business(s,e.id);if(b){b.open=false;b.stock=0;}break;}
    case 'capability.requested':s.capabilities.push({id:e.id,cat:e.cat,need:e.need,purpose:e.purpose,kind:e.kind,source:e.source,tier:e.tier,status:e.tier==='owner'?'needs_owner':'pending'});s.capSeq++;break;
    case 'capability.decided':{const c=s.capabilities.find(x=>x.id===e.id);if(c)c.status=e.approved?'approved':'rejected';break;}
    case 'capability.escalated':break;
    case 'recipe.proposed':{const c=s.capabilities.find(x=>x.id===e.id);if(c)c.recipe={...structuredClone(e.recipe),cat:e.cat};break;}
    case 'recipe.decided':{const c=s.capabilities.find(x=>x.id===e.id);if(c?.recipe)c.recipe.status=e.approved?'approved':'rejected';break;}
  }
  return s;
}

export const replay=(events:EconomyEvent[])=>events.reduce(apply,initialState());

export function startSeason(config:EconomyConfig,cats:string[],seed:number):EconomyEvent[]{
  return [{type:'season.started',seed,startingCoins:config.startingCoins,cats,ticksPerDay:config.ticksPerDay,days:config.days,defaultEnvelope:config.defaultEnvelope,maxCapabilities:config.maxCapabilities}];
}

export function startTick(s:EconomyState,config:EconomyConfig):EconomyEvent[]{
  const next=s.tickIndex+1;
  if(!s.started||next>=s.days*s.ticksPerDay)return [];
  const started={type:'tick.started',day:Math.floor(next/s.ticksPerDay),tick:next%s.ticksPerDay};
  const expired=s.pending.filter(p=>next-p.tick>=config.spendExpiryTicks).flatMap(p=>[{type:'coins.released',id:p.id},{type:'spend.decided',id:p.id,by:'system',approved:false,reason:'expired'}]);
  return [started,...expired];
}

// Reserves coins. Immediate when the cat's envelope covers it; otherwise queued for a decision.
function spend(s:EconomyState,cat:string,key:string,amount:number,purpose:string,then:EconomyEvent,businessId?:string){
  const available=s.balance-s.reserved;
  if(!int(amount,1,s.balance))return {ok:false,queued:false,result:`Amount must be 1 to ${s.balance} coins.`,events:[] as EconomyEvent[]};
  if(amount>available)return {ok:false,queued:false,result:`Not enough coins: ${available} available.`,events:[] as EconomyEvent[]};
  const id=`sp${s.spendSeq+1}`;
  if(amount<=(s.envelopes[cat]??0))return {ok:true,queued:false,result:'',events:[{type:'coins.reserved',id,key,cat,amount,purpose,envelope:true},{type:'coins.settled',id,amount},then]};
  const request={type:'spend.requested',id,cat,amount,purpose,then,...(businessId?{business:businessId}:{})};
  return {ok:true,queued:true,result:`Requested ${amount} coins for ${purpose} as ${id}; a banker or the mayor must approve it.`,events:[request,{type:'coins.reserved',id,key,cat,amount,purpose,envelope:false}]};
}

function target(s:EconomyState,cat:string,id:any,ownerOnly:boolean):{b?:Business;error?:string}{
  const b=business(s,id);
  if(!b)return {error:`Unknown business ${id}.`};
  if(ownerOnly&&b.owner!==cat)return {error:`Only the owner (${b.owner}) can do that to ${b.id}.`};
  if(!b.open)return {error:`${b.id} is closed.`};
  return {b};
}

function decide(s:EconomyState,config:EconomyConfig,cat:string,key:string,name:string,a:any,outcome?:{ok:boolean;result:string}){
  const no=(result:string)=>({ok:false,result,events:[] as EconomyEvent[]});
  const yes=(result:string,events:EconomyEvent[]=[])=>({ok:true,result,events});
  if(!s.started)return no('No season is running.');
  if(!s.cats.includes(cat))return no(`Unknown cat ${cat}.`);
  if(!str(key,200))return no('Invalid key.');
  if(name==='message')return yes('Message recorded.');
  if(name==='pass')return yes('Passed.');
  if(!ACTIONS.includes(name))return no(`Unknown action ${name}.`);
  if((s.actions[cat]??0)>=config.maxActionsPerTick)return no('Action limit reached for this tick.');
  switch(name){
    case 'open_business':{
      if(!str(a.name)||!str(a.category)||!str(a.pitch,600)||!int(a.price,1,config.maxPrice)||!int(a.unitCost,1,config.maxPrice))return no('Invalid business: name, pitch, category, price and unitCost are required.');
      const id=nextBusinessId(s);
      const then={type:'business.opened',id,owner:cat,name:a.name,pitch:a.pitch,category:a.category,price:a.price,unitCost:a.unitCost,fit:fitOf(s.seed,id,a.category),startup:a.startup};
      const r=spend(s,cat,key,a.startup,`open ${a.name}`,then,id);
      if(!r.ok)return no(r.result);
      return yes(r.queued?r.result:`Opened ${a.name} as ${id}.`,r.events);
    }
    case 'buy_stock':{
      const t=target(s,cat,a.business,true);if(t.error)return no(t.error);
      if(!int(a.units,1,1000))return no('Units must be 1 to 1000.');
      const cost=a.units*t.b!.unitCost;
      const r=spend(s,cat,key,cost,`stock ${t.b!.id}`,{type:'business.stocked',id:t.b!.id,units:a.units},t.b!.id);
      if(!r.ok)return no(r.result);
      return yes(r.queued?r.result:`Bought ${a.units} units for ${t.b!.id} at ${cost} coins.`,r.events);
    }
    case 'set_price':{
      const t=target(s,cat,a.business,true);if(t.error)return no(t.error);
      if(!int(a.price,1,config.maxPrice))return no(`Price must be 1 to ${config.maxPrice}.`);
      return yes(`${t.b!.id} now sells at ${a.price}.`,[{type:'business.priced',id:t.b!.id,price:a.price}]);
    }
    case 'market':{
      const t=target(s,cat,a.business,false);if(t.error)return no(t.error);
      const r=spend(s,cat,key,a.amount,`market ${t.b!.id}`,{type:'business.marketed',id:t.b!.id,amount:a.amount,day:s.day},t.b!.id);
      if(!r.ok)return no(r.result);
      return yes(r.queued?r.result:`Marketed ${t.b!.id} for ${a.amount} coins today.`,r.events);
    }
    case 'close_business':{
      const t=target(s,cat,a.business,true);if(t.error)return no(t.error);
      if(!str(a.reason))return no('A reason is required.');
      return yes(`Closed ${t.b!.id}; its stock is lost.`,[{type:'business.closed',id:t.b!.id,reason:a.reason}]);
    }
    case 'research':{
      if(!str(a.category))return no('A category is required.');
      return yes(`Estimated demand score for ${a.category}:${round2(quality(s.seed,a.category)*(0.6+0.8*rng(s.seed,'research',key)()))}.`);
    }
    case 'review':{
      const b=business(s,a.business);if(!b)return no(`Unknown business ${a.business}.`);
      return yes(`Estimated demand score for ${b.id}:${round2(b.fit*(0.8+0.4*rng(s.seed,'review',key)()))}.`);
    }
    case 'set_envelope':{
      if(cat!=='mayor')return no('Only the Mayor can set envelopes.');
      if(!s.cats.includes(a.cat))return no(`Unknown cat ${a.cat}.`);
      if(a.cat==='mayor')return no('The Mayor cannot target itself.');
      if(!int(a.amount,0,s.balance))return no(`Envelope must be 0 to ${s.balance}.`);
      return yes(`${a.cat} envelope set to ${a.amount}.`,[{type:'envelope.set',cat:a.cat,amount:a.amount,by:cat}]);
    }
    case 'decide_spend':{
      if(cat!=='banker'&&cat!=='mayor')return no('Only the Banker or the Mayor can decide spends.');
      const p=s.pending.find(x=>x.id===a.id);
      if(!p)return no(`No open spend request ${a.id}.`);
      if(p.cat===cat)return no('A cat cannot decide its own request.');
      if(typeof a.approved!=='boolean'||!str(a.reason))return no('A decision needs approved (true or false) and a reason of 1 to 200 characters.');
      if(a.approved&&!effectPossible(s,p.then))return no(`${p.then.type} for ${p.id} is no longer possible.`);
      const decided={type:'spend.decided',id:p.id,by:cat,approved:a.approved,reason:a.reason};
      if(a.approved)return yes(`Approved ${p.id} for ${p.amount} coins.`,[decided,{type:'coins.settled',id:p.id,amount:p.amount},p.then]);
      return yes(`Rejected ${p.id}.`,[decided,{type:'coins.released',id:p.id}]);
    }
    case 'request_capability':{
      if(!str(a.need,120)||!str(a.purpose,400))return no('A capability request needs a need (up to 120 characters) and a purpose (up to 400).');
      const tier=capabilityTier(a.kind);
      if(!tier)return no('Unknown capability kind: use package, repo, account, api, money or network.');
      if(!validCapabilitySource(a.kind,a.source)){
        if(tier==='owner')return no('A source must be text of at most 200 characters.');
        return no(a.kind==='package'?'A package needs source npm:<name> or pypi:<name>.':'A repo needs source https://github.com/<owner>/<repo>.');
      }
      const refusal=capabilityRefusal(s,cat,a.kind,tier,a.need);
      if(refusal)return no(refusal);
      const id=`cap${s.capSeq+1}`;
      const source=typeof a.source==='string'?a.source:null;
      const events:EconomyEvent[]=[{type:'capability.requested',id,cat,need:a.need,purpose:a.purpose,kind:a.kind,source,tier}];
      if(tier==='owner')events.push({type:'capability.escalated',id});
      return yes(tier==='owner'?`Requested ${a.kind} as ${id}; only the owner can grant it, so it went to the owner.`:`Requested ${a.kind} as ${id}; the Mayor will decide.`,events);
    }
    case 'decide_capability':{
      const c=s.capabilities.find(x=>x.id===a.id);
      if(!c)return no(`No capability request ${a.id}.`);
      if(c.tier==='owner')return no('only the owner can grant this');
      if(c.status!=='pending')return no(`${c.id} is ${c.status}, not pending.`);
      if(c.cat===cat)return no('A cat cannot decide its own request.');
      const decider=capabilityDecider(c.cat);
      if(cat!==decider)return no(`Only the ${decider==='mayor'?'Mayor':'Banker'} can decide ${c.id}.`);
      if(typeof a.approved!=='boolean'||!str(a.reason))return no('A decision needs approved (true or false) and a reason of 1 to 200 characters.');
      if(a.approved&&s.capabilities.filter(x=>x.status==='approved').length>=s.maxCapabilities)return no(`${s.maxCapabilities} capabilities are already approved this season.`);
      const decided={type:'capability.decided',id:c.id,by:cat,approved:a.approved,reason:a.reason};
      return yes(a.approved?`Approved ${c.id} (${c.kind}).`:`Rejected ${c.id}.`,[decided]);
    }
    // A run recipe makes an approved repo request runnable. The recipe is checked here, so an invalid one never reaches the journal.
    case 'define_repo_tool':{
      let recipe:ReturnType<typeof validateRecipe>;
      try{recipe=validateRecipe(a);}catch(err){return no((err as Error).message);}
      const c=s.capabilities.find(x=>x.id===recipe.toolId);
      if(!c||c.kind!=='repo'||c.status!=='approved')return no(`${recipe.toolId} is not an approved repo request.`);
      if(c.recipe)return no(`${c.id} already has a run recipe (${c.recipe.status}).`);
      const status=config.recipeReview==='owner'?'needs_owner':'pending';
      // The status comes from config, never from the model's args.
      const body={entry:recipe.entry,workdir:recipe.workdir,setup:recipe.setup,description:recipe.description,long:recipe.long,status};
      return yes(status==='needs_owner'?`Proposed the run recipe for ${c.id}; the owner decides it.`:`Proposed the run recipe for ${c.id}; the Mayor decides.`,
        [{type:'recipe.proposed',id:c.id,cat,recipe:body}]);
    }
    case 'decide_recipe':{
      const c=s.capabilities.find(x=>x.id===a.id);
      if(!c?.recipe)return no(`No run recipe for ${a.id}.`);
      if(c.recipe.status==='needs_owner')return no('only the owner can decide this recipe');
      if(c.recipe.status!=='pending')return no(`The recipe for ${c.id} is ${c.recipe.status}, not pending.`);
      if(c.recipe.cat===cat)return no('A cat cannot decide its own recipe.');
      const decider=capabilityDecider(c.recipe.cat);
      if(cat!==decider)return no(`Only the ${decider==='mayor'?'Mayor':'Banker'} can decide the recipe for ${c.id}.`);
      if(typeof a.approved!=='boolean'||!str(a.reason))return no('A decision needs approved (true or false) and a reason of 1 to 200 characters.');
      return yes(a.approved?`Approved the run recipe for ${c.id}.`:`Rejected the run recipe for ${c.id}.`,[{type:'recipe.decided',id:c.id,by:cat,approved:a.approved,reason:a.reason}]);
    }
    // The runner runs the tool and passes the outcome in; the model's args never carry a result.
    case 'use_tool':{
      if(!outcome)return {ok:false,result:'Tools run in the workshop; this action needs a workshop run.',events:[] as EconomyEvent[]};
      return {ok:outcome.ok,result:outcome.result,events:[] as EconomyEvent[]};
    }
  }
  return no(`Unknown action ${name}.`);
}

export function act(s:EconomyState,config:EconomyConfig,cat:string,key:string,name:string,args:any,outcome?:{ok:boolean;result:string}){
  const k=String(key);
  const prior=s.journal.get(k);
  if(prior)return {ok:prior.ok,result:prior.result,events:[] as EconomyEvent[]};
  const a=args??{};
  const out=decide(s,config,cat,k,name,a,outcome);
  const action={type:'action',cat,key:k,name,args:a,ok:out.ok,result:out.result};
  return {ok:out.ok,result:out.result,events:[action,...out.events]};
}

export function marketStep(s:EconomyState,config:EconomyConfig):EconomyEvent[]{
  const events:EconomyEvent[]=[];
  // Coins free to spend, tracked through the step in the same order the events will be applied.
  let available=s.balance-s.reserved;
  for(const b of s.businesses.filter(x=>x.open)){
    const peers=s.businesses.filter(x=>x.open&&x.category.toLowerCase()===b.category.toLowerCase()).length;
    const noise=0.7+0.6*rng(s.seed,'market',b.id,s.tickIndex)();
    const boost=1+(b.marketed[String(s.day)]??0)/50;
    const demand=config.baseDemand*b.fit*Math.pow(b.unitCost*2/b.price,config.elasticity)*boost*(1/peers)*noise;
    const units=Math.min(b.stock,Math.floor(demand));
    if(units>0){
      events.push({type:'business.sold',id:b.id,units,revenue:units*b.price},{type:'coins.earned',business:b.id,amount:units*b.price});
      available+=units*b.price;
    }
    const upkeep=config.baseUpkeep+Math.ceil(b.startup/config.upkeepDivisor);
    if(available>=upkeep){
      const id=`up:${b.id}:${s.tickIndex}`;
      events.push({type:'coins.reserved',id,key:`upkeep:${b.id}:${s.tickIndex}`,cat:b.owner,amount:upkeep,purpose:`upkeep ${b.id}`,envelope:false},{type:'coins.settled',id,amount:upkeep});
      available-=upkeep;
    }else events.push({type:'business.closed',id:b.id,reason:'could not pay upkeep'});
  }
  return events;
}

export function checkInvariants(events:EconomyEvent[]):string[]{
  const out:string[]=[];
  let s=initialState();
  const keys=new Set<string>(),actionKeys=new Set<string>();
  events.forEach((e,i)=>{
    const bad=(m:string)=>out.push(`#${i} ${e.type}: ${m}`);
    switch(e.type){
      case 'action':
        if(actionKeys.has(e.key))bad(`key ${e.key} repeated`);
        actionKeys.add(e.key);break;
      case 'coins.reserved':
        if(keys.has(e.key))bad(`key ${e.key} reserved twice`);
        keys.add(e.key);
        if(s.reservations.some(x=>x.id===e.id))bad(`reservation ${e.id} duplicated`);
        if(!int(e.amount,1,Infinity))bad('reservation amount must be a positive integer');
        else if(e.amount>s.balance-s.reserved)bad(`reservation ${e.amount} exceeds available coins`);
        break;
      case 'coins.settled':case 'coins.released':{
        const r=s.reservations.find(x=>x.id===e.id);
        if(!r)bad(`unknown reservation ${e.id}`);
        else if(r.status!=='open')bad(`reservation ${e.id} already ${r.status}`);
        else if(e.type==='coins.settled'&&!int(e.amount,1,r.amount))bad(`settlement ${e.amount} exceeds reservation ${r.amount}`);
        break;}
      case 'spend.decided':{
        const p=s.pending.find(x=>x.id===e.id);
        if(!p)bad(`spend ${e.id} is not pending`);
        else if(e.by==='system'){if(e.approved||e.reason!=='expired')bad('system may only expire a spend');}
        else if(e.by!=='banker'&&e.by!=='mayor')bad(`${e.by} may not decide spends`);
        else if(e.by===p.cat)bad(`${e.by} decided its own spend`);
        break;}
      case 'coins.earned':{
        const prev=events[i-1];
        if(!int(e.amount,1,Infinity))bad('earnings must be a positive integer');
        else if(!prev||prev.type!=='business.sold'||prev.id!==e.business||prev.revenue!==e.amount)bad('earnings do not follow a matching sale');
        break;}
      case 'business.sold':{
        const b=business(s,e.id);
        if(!b||!b.open)bad(`${e.id} is not an open business`);
        else if(!int(e.units,0,b.stock))bad(`sold ${e.units} units with stock ${b.stock}`);
        else if(e.revenue!==e.units*b.price)bad('revenue does not equal units x price');
        break;}
      case 'business.opened':
        if(business(s,e.id))bad(`${e.id} already exists`);break;
      case 'business.closed':
        if(e.reason==='could not pay upkeep'&&!business(s,e.id)?.open)bad(`${e.id} was not open, so it cannot fail upkeep`);
        break;
      case 'capability.requested':
        if(s.capabilities.some(x=>x.id===e.id))bad(`capability ${e.id} duplicated`);
        if(capabilityTier(e.kind)!==e.tier)bad(`${e.kind} is ${e.tier} tier, not its own tier`);
        if(!validCapabilitySource(e.kind,e.source))bad(`${e.kind} source is not valid`);
        {const r=capabilityRefusal(s,e.cat,e.kind,e.tier,e.need);if(r)bad(r);}
        break;
      case 'capability.escalated':
        if(!s.capabilities.some(x=>x.id===e.id&&x.tier==='owner'))bad(`${e.id} is not an owner-tier request`);
        break;
      case 'recipe.proposed':{
        const c=s.capabilities.find(x=>x.id===e.id);
        if(!c||c.kind!=='repo'||c.status!=='approved')bad(`${e.id} is not an approved repo request`);
        else if(c.recipe)bad(`${e.id} already has a recipe`);
        break;}
      case 'recipe.decided':{
        const c=s.capabilities.find(x=>x.id===e.id);
        if(!c?.recipe)bad(`${e.id} has no recipe`);
        else if(c.recipe.status==='needs_owner'){if(e.by!=='owner')bad(`${e.by} may not decide the owner's recipe`);}
        else if(c.recipe.status!=='pending')bad(`recipe ${e.id} is ${c.recipe.status}, not pending`);
        else if(e.by===c.recipe.cat)bad(`${e.by} decided its own recipe`);
        else if(e.by!==capabilityDecider(c.recipe.cat))bad(`${e.by} may not decide the recipe for ${e.id}`);
        break;}
      case 'capability.decided':{
        const c=s.capabilities.find(x=>x.id===e.id);
        if(!c)bad(`capability ${e.id} is unknown`);
        else if(c.tier!=='sandbox')bad(`owner-tier capability ${e.id} may not be decided`);
        else if(c.status!=='pending')bad(`capability ${e.id} is ${c.status}, not pending`);
        else if(e.by===c.cat)bad(`${e.by} decided its own request`);
        else if(e.by!==capabilityDecider(c.cat))bad(`${e.by} may not decide ${e.id}`);
        break;}
    }
    s=apply(s,e);
    for(const c of s.capabilities)if(c.tier==='owner'&&c.status==='approved')bad(`owner-tier capability ${c.id} is approved`);
    if(s.capabilities.filter(c=>c.status==='approved').length>s.maxCapabilities)bad(`approvals exceed maxCapabilities ${s.maxCapabilities}`);
    if(s.balance<0)bad(`balance ${s.balance} is negative`);
    if(s.reserved>s.balance)bad(`open reservations ${s.reserved} exceed balance ${s.balance}`);
    for(const b of s.businesses)if(b.stock<0)bad(`${b.id} stock ${b.stock} is negative`);
    for(const c of s.cats)if((s.envelopes[c]??0)<0)bad(`envelope of ${c} is negative`);
  });
  const sum=(type:string,field:string)=>events.filter(e=>e.type===type).reduce((n,e)=>n+e[field],0);
  const start=events.find(e=>e.type==='season.started')?.startingCoins??0;
  if(s.balance!==start+sum('coins.earned','amount')-sum('coins.settled','amount'))out.push(`balance ${s.balance} differs from startingCoins + earned - settled`);
  return out;
}

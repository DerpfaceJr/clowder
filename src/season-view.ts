// Read-only views of a coin-economy season journal for the Mayor's chat, the town UI and owner directives.
// Reads never write. A season may be mid-append, so the reader tolerates a torn last line.
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {checkInvariants, replay} from './economy.ts';
import type {EconomyEvent} from './economy.ts';

const NAME=/^[\w-]+$/;

// A malformed last line is a torn append and is skipped; any earlier malformed line means damage.
function parseJournal(text:string,label:string):EconomyEvent[]{
  const lines=text.split('\n').filter(l=>l.trim());
  return lines.flatMap((line,i)=>{
    try{const e=JSON.parse(line);if(typeof e?.type!=='string')throw new Error('not an event');return [e as EconomyEvent];}
    catch{if(i===lines.length-1)return [];throw new Error(`Journal ${label} is damaged at line ${i+1}.`);}
  });
}

export function latestSeason(dataDir:string):string|undefined{
  if(!existsSync(dataDir))return undefined;
  const seasons=readdirSync(dataDir).flatMap(f=>{const m=/^season-([\w-]+)\.jsonl$/.exec(f);return m?[{name:m[1],mtime:statSync(join(dataDir,f)).mtimeMs}]:[];});
  return seasons.sort((a,b)=>b.mtime-a.mtime)[0]?.name;
}

export function readSeason(dataDir:string,name:string):EconomyEvent[]{
  if(!NAME.test(name))throw new Error(`Invalid season name: ${name}`);
  const file=join(dataDir,`season-${name}.jsonl`);
  return existsSync(file)?parseJournal(readFileSync(file,'utf8'),file):[];
}

// Hidden business fit never leaves the server: any key named exactly "fit" is dropped.
const scrub=(v:any):any=>{
  if(Array.isArray(v))return v.map(scrub);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='fit').map(([k,x])=>[k,scrub(x)]));
  return v;
};
const clean=<T>(v:T):T=>scrub(v);

/** Provider-reported model tokens in a season journal. Jev decisions carry cost, not tokens, so they are left out. */
export function seasonTokens(events:EconomyEvent[]){
  const usage=events.filter(e=>e.type==='usage'&&(e as any).provider!=='jev') as any[];
  const known=usage.filter(u=>Number.isFinite(u.input)&&Number.isFinite(u.output));
  return {calls:usage.length,input:known.reduce((a,u)=>a+u.input,0),output:known.reduce((a,u)=>a+u.output,0),unknown:usage.length-known.length};
}

export function publicSeason(events:EconomyEvent[],name:string){
  const s=replay(events);
  const closed=events.filter(e=>e.type==='tick.closed').length;
  const total=s.days*s.ticksPerDay;
  const sold=new Map<string,number>();
  for(const e of events)if(e.type==='business.sold')sold.set(e.id,(sold.get(e.id)??0)+e.units);
  return clean({
    name,
    progress:{closed,total,day:s.day,tick:s.tick,finished:total>0&&closed>=total},
    balance:s.balance,startingCoins:s.startingCoins,earned:s.earned,settled:s.settled,available:s.balance-s.reserved,
    businesses:s.businesses.map(b=>({id:b.id,owner:b.owner,name:b.name,category:b.category,price:b.price,unitCost:b.unitCost,stock:b.stock,open:b.open,startup:b.startup,sold:sold.get(b.id)??0})),
    pending:s.pending.map(p=>({id:p.id,cat:p.cat,amount:p.amount,purpose:p.purpose})),
    capabilities:s.capabilities.map(c=>({id:c.id,cat:c.cat,need:c.need,purpose:c.purpose,kind:c.kind,source:c.source,tier:c.tier,status:c.status})),
    recent:events.filter(e=>e.type==='action').slice(-40).map(e=>({cat:e.cat,name:e.name,args:e.args,ok:e.ok,result:e.result})),
    invariantsOk:checkInvariants(events).length===0,
    tokens:seasonTokens(events),
  });
}

export function seasonSummary(dataDir:string):string{
  const name=latestSeason(dataDir);if(!name)return '';
  const events=readSeason(dataDir,name);if(!events.length)return '';
  const p=publicSeason(events,name);
  const open=p.businesses.filter(b=>b.open);
  const shown=open.slice(0,6).map(b=>`${b.name} ${b.id} (${b.owner}), stock ${b.stock}, price ${b.price}`);
  if(open.length>6)shown.push(`+${open.length-6} more`);
  const notable=p.recent.filter(a=>a.name!=='pass').slice(-3);
  const delta=p.balance-p.startingCoins;
  // Needs-owner items go before the business list and recent actions, so the 600-character cut never drops them first.
  const needs=p.capabilities.filter(c=>c.status==='needs_owner').map(c=>`Needs owner: ${c.need} (${c.cat}).`);
  const text=[
    `Season ${name}: day ${p.progress.day}, tick ${p.progress.tick}, ${p.progress.closed} of ${p.progress.total} ticks closed${p.progress.finished?' (finished)':''}.`,
    `Balance ${p.balance} vs start ${p.startingCoins} (${delta>=0?'+':''}${delta}).`,
    ...needs,
    `Open businesses: ${shown.join('; ')||'none'}.`,
    `Recent actions: ${notable.map(a=>`${a.cat} ${a.name}: ${a.result}`).join('; ')||'none'}.`,
  ].join(' ');
  return text.length>600?`${text.slice(0,597)}...`:text;
}

// Owner-to-Mayor chat from the town journal. Only the last `limit` are returned, oldest first.
export function ownerDirectives(townJournalPath:string,sinceIso?:string,limit=3):{at:string;text:string}[]{
  if(!existsSync(townJournalPath))return [];
  const since=sinceIso?Date.parse(sinceIso):-Infinity;
  const all=parseJournal(readFileSync(townJournalPath,'utf8'),townJournalPath)
    .filter(e=>e.type==='message'&&e.data?.from==='owner'&&e.data?.to==='mayor'&&Date.parse(e.at)>since);
  return all.slice(Math.max(0,all.length-limit)).map(e=>({at:e.at,text:String(e.data.text)}));
}

// Watches the latest season journal and turns newly appended coin events into totals for /api/events.
// Seasons run in a child process, so the server polls the journal and reads only the bytes appended since the last poll.
// Only totals leave the server: no purposes, cat names, reservation ids or event text.
import {closeSync, openSync, readSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {latestSeason} from './season-view.ts';

export type CoinTotals={spent:number;earned:number;count:number};

export const SEASON_POLL_MS=2000;
// ponytail: a single poll reads at most this much, so a long catch-up cannot stall the event loop. A line longer than this is skipped.
const MAX_READ=1<<20;

/** One SSE frame. Built from the three totals only, so nothing else from the journal can ride along. */
export function seasonFrame(totals:CoinTotals):string{
  return `event: season\ndata: ${JSON.stringify({spent:totals.spent,earned:totals.earned,count:totals.count})}\n\n`;
}

/** Sums the coin movements in complete journal lines. Torn or malformed lines are ignored. */
export function tallyCoins(text:string):CoinTotals{
  const totals:CoinTotals={spent:0,earned:0,count:0};
  for(const line of text.split('\n')){
    if(!line.trim())continue;
    let event:{type?:unknown;amount?:unknown}|null;
    try{event=JSON.parse(line);}catch{continue;}
    const amount=event?.amount;
    if(typeof amount!=='number'||!Number.isFinite(amount)||amount<=0)continue;
    if(event?.type==='coins.settled'){totals.spent+=amount;totals.count++;}
    else if(event?.type==='coins.earned'){totals.earned+=amount;totals.count++;}
  }
  return totals;
}

export class SeasonWatch{
  readonly listeners=new Set<(totals:CoinTotals)=>void>();
  /** Bytes consumed from journals so far. Tests use it to check that only appended bytes are read. */
  bytesRead=0;
  private offsets=new Map<string,number>();
  private timer:ReturnType<typeof setInterval>|null=null;

  constructor(private readonly dataDir:string,private readonly intervalMs=SEASON_POLL_MS){}

  /** Journals that already exist are history: they start at their current end, so a restart never replays old spending as sound. */
  start(){
    for(const name of this.names())this.offsets.set(name,this.size(name));
    if(!this.timer){this.timer=setInterval(()=>this.poll(),this.intervalMs);this.timer.unref();}
  }

  stop(){
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
  }

  /** Reads what was appended since the last poll, notifies listeners once for the batch, and returns the totals (or null). */
  poll():CoinTotals|null{
    let totals:CoinTotals|null=null;
    try{totals=this.read();}catch{/* a vanished or damaged journal must not stop the watch */}
    if(totals&&totals.count>0){for(const listener of this.listeners)listener(totals);return totals;}
    return null;
  }

  private read():CoinTotals|null{
    const name=latestSeason(this.dataDir);
    if(!name)return null;
    const size=this.size(name);
    let offset=this.offsets.get(name)??0;
    if(size<offset)offset=0;
    if(size===offset){this.offsets.set(name,offset);return null;}
    const want=Math.min(size-offset,MAX_READ);
    const buffer=Buffer.alloc(want);
    const fd=openSync(this.file(name),'r');
    let read=0;
    try{read=readSync(fd,buffer,0,want,offset);}finally{closeSync(fd);}
    // Only whole lines are consumed. A line still being written waits for its newline on a later poll.
    const lastNewline=buffer.subarray(0,read).lastIndexOf(0x0a);
    let consumed=lastNewline+1;
    if(lastNewline<0&&read===MAX_READ)consumed=read;
    this.offsets.set(name,offset+consumed);
    this.bytesRead+=consumed;
    if(consumed===0)return null;
    return tallyCoins(buffer.subarray(0,consumed).toString('utf8'));
  }

  private file(name:string){return join(this.dataDir,`season-${name}.jsonl`);}

  private size(name:string){
    try{return statSync(this.file(name)).size;}catch{return 0;}
  }

  private names():string[]{
    try{return readdirSync(this.dataDir).flatMap(f=>{const m=/^season-([\w-]+)\.jsonl$/.exec(f);return m?[m[1]]:[];});}
    catch{return [];}
  }
}

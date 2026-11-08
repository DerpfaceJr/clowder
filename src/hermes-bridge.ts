// The Hermes bridge (plan 4.10, H1b; hermes-adaptation.md §4.3-4.4 with the spike's corrections S4, S5, S8), behind hermes.enabled.
// One POST /v1/runs per Mayor run, under an Idempotency-Key never reused for new work: the task id, then child-<id> for each child's result. Hermes
// keeps keys 24 h across its restarts and answers an old key with the old run, so a reply marked replayed is refused, never adopted.
// Each run's SSE goes to Town.hermesEvent. The owner's answer reaches the parked call through pending_controls (HermesSidecar.answer); a run Hermes
// lost to a restart is settled with resolve-unknown and its task ends interrupted (Town.hermesLost). Replay with a one-time grant waits for row 4.12.
import type {Approval} from './store.ts';
import type {HermesLink,Town} from './engine.ts';
import type {HermesSidecar} from './hermes.ts';

const LIVE=new Set(['started','queued','running','waiting_for_approval']);
// GET /v1/runs/{id} statuses that are over, as the event that would have said so. cancelled is also how an interrupted outcome reads (S5).
const ENDED:Record<string,string>={completed:'run.completed',failed:'run.failed',cancelled:'run.cancelled'};
const END=/^run\.(completed|failed|cancelled|interrupted)$/;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms).unref());
type Side=Pick<HermesSidecar,'ready'|'api'|'answer'|'url'|'keys'>;
export type BridgeOptions={sidecar:Side;town:()=>Town|null;
  /** How long to wait between looks at a run whose stream dropped, or while Hermes restarts. Tests shorten it. */retryMs?:number};

export class HermesBridge implements HermesLink{
  /** Each run's SSE reader. */
  private readers=new Map<string,AbortController>();
  /** Events already handled: approval.request by prompt_id (a re-attach repeats it, S8), tool.started by call, a run's end. */
  private seen=new Set<string>();
  private closed=false;
  constructor(private o:BridgeOptions){}
  ready(){return this.o.sidecar.ready();}
  private get wait(){return this.o.retryMs??5_000;}
  private run(id:string){return `/v1/runs/${encodeURIComponent(id)}`;}

  async startRun(r:{task:string;session:string;input:string;key:string;instructions:string}){
    const res=await this.o.sidecar.api('POST','/v1/runs',{input:r.input,session_id:r.session,instructions:r.instructions},{'idempotency-key':r.key});
    if(res.status>=300||typeof res.json?.run_id!=='string')throw new Error(`Hermes answered ${res.status}${res.json?.error?`: ${String(res.json.error.message??res.json.error).slice(0,200)}`:''}.`);
    if(res.json.replayed===true)throw new Error(`Hermes has already run request ${r.key}; old work is not taken as new.`);
    this.watch(r.task,res.json.run_id);
    return res.json.run_id as string;
  }

  /** The owner's answer to a parked call (Town.decideHermes). While the run waits it goes through pending_controls; a run Hermes lost on a restart,
   *  after a kill or a graceful stop alike (S5), is settled and its task ends interrupted. Never throws. */
  async answer(approval:Approval,choice:'once'|'deny'){
    const run=approval.hermes?.run??this.o.town()?.store.state.tasks.find(t=>t.id===approval.task)?.hermes?.run;
    const r=run?await this.o.sidecar.api('GET',this.run(run)).catch(()=>null):null;
    if(run&&r&&(r.json?.status==='unknown'||r.json?.status==='cancelled'||r.json?.status==='failed'||r.status===404)){await this.lose(approval.task,run,r.json);return;}
    await this.o.sidecar.answer(approval,choice);
    // After a Clowder restart nobody reads this run yet; its end (or its loss) must still reach the task.
    if(run)this.watch(approval.task,run);
  }

  /** Best effort: Hermes may still be starting, so this tries for up to about three minutes. */
  async stopRun(run:string){
    for(let tries=0;tries<36&&!this.closed;tries++){
      if(this.o.sidecar.ready()&&await this.o.sidecar.api('POST',`${this.run(run)}/stop`,{}).then(()=>true,()=>false))return;
      await sleep(this.wait);
    }
  }
  close(){this.closed=true;for(const reader of this.readers.values())reader.abort();this.readers.clear();}

  private watch(task:string,run:string){
    if(this.readers.has(run)||this.closed)return;
    const reader=new AbortController();this.readers.set(run,reader);
    void this.read(task,run,reader).finally(()=>{if(this.readers.get(run)===reader)this.readers.delete(run);});
  }
  private async read(task:string,run:string,reader:AbortController){
    let ended=false;
    try{
      const r=await fetch(`${this.o.sidecar.url}${this.run(run)}/events`,{headers:{authorization:`Bearer ${this.o.sidecar.keys().apiKey}`,accept:'text/event-stream'},signal:reader.signal});
      if(!r.ok||!r.body)throw new Error(`events ${r.status}`);
      const dec=new TextDecoder();let buf='';
      for await(const chunk of r.body as AsyncIterable<Uint8Array>){
        buf+=dec.decode(chunk,{stream:true}).replace(/\r/g,'');
        for(let i=buf.indexOf('\n\n');i>=0;i=buf.indexOf('\n\n')){
          const frame=buf.slice(0,i);buf=buf.slice(i+2);
          const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
          let d:any;try{d=JSON.parse(data);}catch{continue;}
          if(this.event(task,run,/^event: ?(.*)$/m.exec(frame)?.[1]??String(d?.event??''),d))ended=true;
        }
      }
    }catch{/* a dropped stream is settled below */}
    if(!ended&&!reader.signal.aborted&&!this.closed){this.readers.delete(run);void this.settle(task,run);}
  }
  /** One event, handled once; true when the run is over. */
  private event(task:string,run:string,name:string,d:any){
    const end=END.test(name),key=name==='approval.request'?`prompt ${d?.prompt_id}`:name==='tool.started'?`tool ${run} ${d?.tool_call_id}`:end?`end ${run}`:'';
    if(key){if(this.seen.has(key))return end;this.seen.add(key);}
    // approval.request needs nothing more: the gate filed Clowder's one card for it before Hermes parked.
    if(name!=='approval.request')this.o.town()?.hermesEvent(task,run,name,d);
    return end;
  }
  /** The stream ended without the run's end: Hermes died or dropped it. The run itself says what happened once Hermes answers again. */
  private async settle(task:string,run:string){
    for(let tries=0;tries<120&&!this.closed;tries++){
      await sleep(this.wait);
      if(!this.o.sidecar.ready())continue;
      const r=await this.o.sidecar.api('GET',this.run(run)).catch(()=>null),status=r?.json?.status;
      if(!r)continue;
      if(LIVE.has(status)){this.watch(task,run);return;}
      if(ENDED[status]){this.event(task,run,ENDED[status]!,r.json);return;}
      if(status==='unknown'||r.status===404){await this.lose(task,run,r.json);return;}
    }
    if(!this.closed)this.o.town()?.hermesLost(task,run);
  }
  /** Hermes marks started work unknown when it restarts ("never replay started work"); resolve-unknown settles it so the session takes new runs. */
  private async lose(task:string,run:string,json:any){
    if(json?.status==='unknown')await this.o.sidecar.api('POST',`${this.run(run)}/resolve-unknown`,{admission_id:json.admission_id,execution_generation:json.execution_generation}).catch(()=>null);
    this.seen.add(`end ${run}`);this.readers.get(run)?.abort();
    this.o.town()?.hermesLost(task,run);
  }
}

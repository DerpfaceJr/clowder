import {FEED_EVENTS,publicApproval,publicEvent,publicTask,type Event,type Store} from './store.ts';

const findLast=<T>(list:T[],test:(x:T)=>boolean)=>{for(let i=list.length-1;i>=0;i--)if(test(list[i]))return list[i];return undefined;};

/**
 * One SSE frame per store event, built once and sent to every open page (ux-audit F1: each event used to make every
 * page refetch the whole state). A frame is {seq, world} plus what the event changed, in the snapshot's own projection:
 * event (feed types only), message, task or approval (upserted by id), and patch (the small keys whose value changed).
 * public/state-delta.js applies it. `changed` (a world switch) and any gap in seq make the page refetch /api/state.
 */
// A tool's plain label for the activity line. Connector and plugin tools read as their own name.
const LABELS:Record<string,string>={delegate:'asking a cat',appoint_director:'appointing a director',create_cat:'recruiting a cat',build_road:'building a road',
  design_home:'designing a home',fetch_url:'reading a page',web_search:'searching the web',browse:'using the browser',code_workspace:'working on files',
  lookup:'looking things up',save_artifact:'saving work',read_artifact:'reading saved work',generate_image:'making an image',generate_video:'making a video',
  request_approval:'asking you',request_owner_step:'adding a to-do',remember:'noting a fact',use_skill:'reading a skill',find_skills:'finding skills'};
export const toolLabel=(name:string)=>LABELS[name]??`using ${name.replace(/^mcp__/,'').replace(/[_-]+/g,' ').trim()||'a tool'}`;
export type Live={activity:{task:string;cat:string;label:string}}|{delta:{task:string;cat:string;text?:string;done?:true}};

export class DeltaFeed{
  readonly clients=new Set<(data:string)=>void>();
  /** Owner pages, also in clients. Transient frames (activity, live text) go to these only, and never touch the journal. */
  readonly owners=new Set<(data:string)=>void>();
  // The small keys as last sent, JSON per key. Null when no page listens or after a switch: the next frame then sends them all.
  private sent:Record<string,string>|null=null;
  constructor(private source:{readonly store:Store;activeWorld():{id:string}}){}
  /** The first frame on a stream: a page whose snapshot is at another seq or world refetches. */
  hello(){return JSON.stringify({hello:true,seq:this.source.store.state.events.length,world:this.source.activeWorld().id});}
  /** A store event of the active world, or undefined after a world switch. */
  publish(event?:Event){
    if(!this.clients.size||!event){this.sent=null;if(this.clients.size)this.fan('changed');return;}
    this.fan(JSON.stringify(this.frame(event)));
    // tool.started is already journaled; its activity frame rides beside the seq frame, one per call, with no arguments or result.
    if(event.type==='tool.started')this.transient({activity:{task:String(event.data?.task??''),cat:String(event.data?.cat??''),label:toolLabel(String(event.data?.name??''))}});
  }
  /** A frame that is not a journal event: it carries the current seq but never advances it (public/state-delta.js applyLive). */
  transient(live:Live){
    if(!this.owners.size)return;
    const data=JSON.stringify({seq:this.source.store.state.events.length,world:this.source.activeWorld().id,...live});
    for(const send of this.owners)send(data);
  }
  frame(e:Event){
    const store=this.source.store,s=store.state,sent:Record<string,string>={},patch:Record<string,unknown>={};
    for(const [key,value] of Object.entries(store.small())){sent[key]=JSON.stringify(value)??'';if(this.sent?.[key]!==sent[key])patch[key]=value;}
    this.sent=sent;
    const id=e.data?.id,message=e.type==='message'?findLast(s.messages,m=>m.id===e.id):undefined;
    const task=/^task\.(created|updated)$/.test(e.type)?findLast(s.tasks,t=>t.id===id):undefined;
    const approval=/^approval\.(requested|resolved)$/.test(e.type)?findLast(s.approvals,a=>a.id===id):undefined;
    return {seq:s.events.length,world:this.source.activeWorld().id,...(FEED_EVENTS.has(e.type)?{event:publicEvent(e)}:{}),
      ...(message?{message}:{}),...(task?{task:publicTask(task)}:{}),...(approval?{approval:publicApproval(approval)}:{}),...(Object.keys(patch).length?{patch}:{})};
  }
  private fan(data:string){for(const send of this.clients)send(data);}
}

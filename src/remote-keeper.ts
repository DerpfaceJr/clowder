import {existsSync,readFileSync} from 'node:fs';
import {writeJsonAtomic} from './atomic-json.ts';
import {RemoteCarrier,type RemoteProvider,type RemoteTunnel} from './remote-provider.ts';

// The owner's choice survives a restart. A damaged or missing file means off, the safe answer.
// provider: the carrier picked in Devices (plan 5.1), saved only once one was picked; until then remote.provider in the config decides.
export class RemoteSettings{
  private value=false;
  private picked?:RemoteProvider;
  constructor(private file:string){
    try{
      const data=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
      this.value=data.enabled===true;
      this.picked=data.provider==='tailscale'||data.provider==='cloudflare'?data.provider:undefined;
    }catch{this.value=false;this.picked=undefined;}
  }
  get enabled(){return this.value;}
  get provider(){return this.picked;}
  set(enabled:boolean){this.write(enabled,this.picked);}
  choose(provider:RemoteProvider){this.write(this.value,provider);}
  private write(enabled:boolean,provider?:RemoteProvider){writeJsonAtomic(this.file,{enabled,...(provider?{provider}:{})});this.value=enabled;this.picked=provider;}
}

// A tunnel that dies while remote access is on comes back after 30 s, then 2 min, then every 10 min. Nothing waits for it.
const RETRY_MS=[30_000,120_000,600_000];
type Timers={set(run:()=>void,ms:number):unknown;clear(handle:unknown):void};
const realTimers:Timers={set:(run,ms)=>setTimeout(run,ms),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
export class RemoteKeeper{
  private timer?:unknown;private step=0;private disposed=false;
  constructor(private tunnel:RemoteTunnel,private port:number,private settings:RemoteSettings,private log:(message:string)=>void=message=>console.log(message),private timers:Timers=realTimers){}
  // The owner asked for remote access: remember it, then start.
  start(){this.settings.set(true);this.cancel();return this.tunnel.start(this.port);}
  // The owner turned it off: forget it, so the next boot leaves it off.
  async stop(){this.settings.set(false);this.cancel();await this.tunnel.stop();}
  // The owner picked a carrier in Devices (plan 5.1). It is remembered; when remote access is on, the old carrier stops and the new one starts.
  async choose(provider:RemoteProvider):Promise<string|undefined>{
    if(!(this.tunnel instanceof RemoteCarrier))throw new Error('This town has one way to connect.');
    this.cancel();this.settings.choose(provider);
    await this.tunnel.use(provider);
    return this.settings.enabled?this.tunnel.start(this.port):undefined;
  }
  // Boot. CAT_TUNNEL_AUTOSTART=1 forces it on, 0 (tests, scratch servers) turns it off, otherwise the saved choice decides. Returns whether it started.
  autostart(env:NodeJS.ProcessEnv){const on=env.CAT_TUNNEL_AUTOSTART==='1'||(env.CAT_TUNNEL_AUTOSTART!=='0'&&this.settings.enabled);if(on)this.attempt();return on;}
  // Called when the tunnel exits, and after a failed background start. One pending retry at a time; nothing when off.
  retry(){
    if(this.disposed||this.timer!==undefined||!this.settings.enabled)return;
    const delay=RETRY_MS[Math.min(this.step++,RETRY_MS.length-1)];
    this.timer=this.timers.set(()=>{this.timer=undefined;this.attempt();},delay);
  }
  private attempt(){
    if(this.disposed)return;
    Promise.resolve().then(()=>this.tunnel.start(this.port)).then(origin=>{this.step=0;this.log(`Remote access: ${origin}`);},error=>{this.log(`Remote access did not start: ${(error as Error).message}`);this.retry();});
  }
  cancel(){if(this.timer!==undefined)this.timers.clear(this.timer);this.timer=undefined;this.step=0;}
  // Shutdown: no more starts, and nothing is written to the settings file.
  dispose(){this.disposed=true;this.cancel();}
}

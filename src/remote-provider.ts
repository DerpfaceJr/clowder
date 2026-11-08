// Which service carries the phone connection. Read from remote.provider in town.local.json (default: cloudflare).
export type RemoteProvider='cloudflare'|'tailscale';
export type RemoteStatus={origin?:string;starting:boolean;error?:string;named:boolean;provider:RemoteProvider};

// Both providers expose this shape to the server. stop() may be async (Tailscale runs a CLI command).
export interface RemoteTunnel{
  origin?:string;
  error?:string;
  start(port:number):Promise<string>;
  stop():void|Promise<void>;
  status():RemoteStatus;
}

// Both carriers exist and one is in use: the one picked in Devices (plan 5.1), else remote.provider from the config. Everything else reads
// it as one tunnel. use() stops the carrier in use before the other takes over; the caller starts it again (RemoteKeeper.choose).
export class RemoteCarrier implements RemoteTunnel{
  constructor(private carriers:Record<RemoteProvider,RemoteTunnel>,public provider:RemoteProvider){}
  private get active(){return this.carriers[this.provider];}
  get origin(){return this.active.origin;}
  set origin(value){this.active.origin=value;}
  get error(){return this.active.error;}
  set error(value){this.active.error=value;}
  start(port:number){return this.active.start(port);}
  stop(){return this.active.stop();}
  status(){return this.active.status();}
  async use(provider:RemoteProvider){
    if(provider===this.provider)return;
    const old=this.active;this.provider=provider;
    await old.stop();
  }
}

export function remoteProvider(value:unknown):RemoteProvider{
  if(value===undefined||value===null||value==='')return 'cloudflare';
  if(value==='cloudflare'||value==='tailscale')return value;
  throw new Error('remote.provider must be "cloudflare" or "tailscale" in town.local.json or town.config.json.');
}

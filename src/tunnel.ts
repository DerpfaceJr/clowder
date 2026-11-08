import {spawn,type ChildProcess} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {RemoteStatus,RemoteTunnel} from './remote-provider.ts';
const namedTunnel=(env:NodeJS.ProcessEnv)=>!!(env.CAT_TUNNEL_TOKEN?.trim()&&env.CAT_TUNNEL_ORIGIN?.trim());
// Quick Tunnels get a new address on every start. A named tunnel keeps one hostname, configured in the Cloudflare dashboard.
// The token travels only in the child's environment, never in argv.
export function tunnelCommand(port:number,env:NodeJS.ProcessEnv,configFile:string):{args:string[];env:Record<string,string>;origin?:string;named:boolean}{
  const token=env.CAT_TUNNEL_TOKEN?.trim(),raw=env.CAT_TUNNEL_ORIGIN?.trim();
  if(!!token!==!!raw)throw new Error('Set both CAT_TUNNEL_TOKEN and CAT_TUNNEL_ORIGIN for a named tunnel, or neither for a Quick Tunnel.');
  if(!token||!raw)return {args:['tunnel','--config',configFile,'--no-autoupdate','--url',`http://127.0.0.1:${port}`],env:{},named:false};
  let url:URL|undefined;try{url=new URL(raw);}catch{}
  if(url?.protocol!=='https:'||url.pathname!=='/')throw new Error('CAT_TUNNEL_ORIGIN must be an https:// origin with no path, such as https://town.example.com.');
  return {args:['tunnel','--no-autoupdate','run'],env:{TUNNEL_TOKEN:token},origin:url.origin,named:true};
}
export class Tunnel implements RemoteTunnel {
  private child?:ChildProcess;
  private starting?:Promise<string>;
  private cancel?:()=>void;
  origin?:string;
  error?:string;
  // onDown runs when cloudflared exits on its own (not for stop()), so the keeper can bring it back.
  constructor(private directory:string,private timeoutMs:number,private onDown?:()=>void){}
  start(port:number):Promise<string>{
    if(this.origin)return Promise.resolve(this.origin);if(this.starting)return this.starting;
    this.error=undefined;
    const pending=new Promise<string>((accept,reject)=>{
      // Explicit config isolates a Quick Tunnel from the operator's other tunnels.
      const config=resolve(this.directory,'quick-tunnel.yml');const command=tunnelCommand(port,process.env,config);
      mkdirSync(this.directory,{recursive:true});writeFileSync(config,'{}\n');
      const child=spawn(process.env.CAT_CLOUDFLARED||'cloudflared',command.args,{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,...command.env}});this.child=child;
      let output='',settled=false,url:string|undefined=command.origin;
      const fail=(message:string)=>{if(this.child===child){this.error=message;this.origin=undefined;}if(!settled){settled=true;clearTimeout(timer);reject(new Error(message));}};
      const timer=setTimeout(()=>{fail('Tunnel did not connect. Check the host Internet connection.');child.kill();},this.timeoutMs);
      this.cancel=()=>fail('Remote access stopped.');
      child.stderr!.on('data',chunk=>{
        output=(output+String(chunk)).slice(-16000);url??=output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if(this.child===child&&!settled&&url&&output.includes('Registered tunnel connection')){settled=true;clearTimeout(timer);this.origin=url;accept(url);}
      });
      child.once('error',()=>fail('cloudflared could not start. Install it or set CAT_CLOUDFLARED to its executable.'));
      child.once('exit',()=>{if(this.child===child){fail('Remote tunnel stopped. Start it again on the host.');this.child=undefined;this.onDown?.();}});
    });
    this.starting=pending;void pending.finally(()=>{this.starting=undefined;}).catch(()=>{});return pending;
  }
  stop(){this.cancel?.();this.cancel=undefined;this.origin=undefined;this.child?.kill();this.child=undefined;this.error=undefined;}
  status():RemoteStatus{return {origin:this.origin,starting:!!this.starting,error:this.error,named:namedTunnel(process.env),provider:'cloudflare'};}
}

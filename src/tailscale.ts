import {execFile} from 'node:child_process';
import type {RemoteStatus,RemoteTunnel} from './remote-provider.ts';

// Tailscale Serve publishes the remote listener to the tailnet only, at https://<machine>.<tailnet>.ts.net.
// Never use `tailscale funnel` here: funnel would expose the town to the public internet.
export type Run={code:number;stdout:string;stderr:string};
// Rejects with an error whose code is 'ENOENT' when the executable does not exist.
export type Runner=(file:string,args:string[])=>Promise<Run>;

export const TAILSCALE_EXECUTABLES=['tailscale','C:\\Program Files\\Tailscale\\tailscale.exe'];
export const NOT_INSTALLED='Tailscale is not installed. Install it from tailscale.com/download and sign in.';
export const NOT_RUNNING='Tailscale is not signed in, or MagicDNS is off. Sign in to Tailscale on this PC and turn on MagicDNS in the Tailscale admin console.';
export const NO_CERTIFICATES='Tailscale HTTPS certificates are not enabled. In the Tailscale admin console, open DNS and enable "HTTPS Certificates", then enable remote access again.';

export const statusArgs=()=>['status','--json'];
export const serveArgs=(port:number)=>{
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Remote port must be a valid TCP port.');
  return ['serve','--bg','--https=443',`http://127.0.0.1:${port}`];
};
export const serveOffArgs=()=>['serve','--https=443','off'];
// The command Clowder runs, as the Devices dialog shows it.
export const serveCommand=(port:number)=>['tailscale',...serveArgs(port)].join(' ');

// Returns the machine's MagicDNS name without the trailing dot. Any missing or unusable state is one message.
export function parseTailscaleStatus(text:string):string{
  let data:any;
  try{data=JSON.parse(text);}catch{throw new Error(NOT_RUNNING);}
  const raw=typeof data?.Self?.DNSName==='string'?data.Self.DNSName:'';
  const dns=raw.replace(/\.$/,'').toLowerCase();
  if(data?.BackendState!=='Running'||!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dns))throw new Error(NOT_RUNNING);
  return dns;
}

// What the Devices dialog shows before anything is published (plan 5.1): installed, signed in, HTTPS certificates on, and the address the
// town would get. Read-only: `tailscale status --json` and nothing else, so it never serves and never fails.
// https: CertDomains lists the names Tailscale will get certificates for, null until HTTPS is on in the admin console. An older client
// without the field says nothing either way (undefined).
export type TailscaleCheck={installed:boolean;signedIn:boolean;https?:boolean;origin?:string};
export async function detectTailscale(run:Runner=execRunner):Promise<TailscaleCheck>{
  for(const exe of TAILSCALE_EXECUTABLES){
    let result:Run;
    try{result=await run(exe,statusArgs());}
    catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')continue;return {installed:true,signedIn:false};}
    let dns:string;
    try{dns=parseTailscaleStatus(result.stdout);}catch{return {installed:true,signedIn:false};}
    const list=JSON.parse(result.stdout).CertDomains;
    const https=list===undefined?undefined:Array.isArray(list)&&list.some(name=>String(name).replace(/\.$/,'').toLowerCase()===dns);
    return {installed:true,signedIn:true,https,origin:`https://${dns}`};
  }
  return {installed:false,signedIn:false};
}

const execRunner:Runner=(file,args)=>new Promise((resolve,reject)=>{
  execFile(file,args,{windowsHide:true,timeout:30000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>{
    if(error&&(error as NodeJS.ErrnoException).code==='ENOENT')return reject(error);
    const code=error?(typeof (error as any).code==='number'?(error as any).code:1):0;
    resolve({code,stdout:String(stdout),stderr:String(stderr)});
  });
});

export class TailscaleServe implements RemoteTunnel{
  origin?:string;
  error?:string;
  private starting?:Promise<string>;
  private exe?:string;
  private served=false;
  private generation=0;
  constructor(private run:Runner=execRunner){}

  start(port:number):Promise<string>{
    if(this.origin)return Promise.resolve(this.origin);
    if(this.starting)return this.starting;
    this.error=undefined;
    const generation=this.generation;
    const pending=this.connect(port,generation).then(origin=>{
      this.origin=origin;this.starting=undefined;return origin;
    },(error:Error)=>{
      this.error=error.message;this.starting=undefined;throw error;
    });
    this.starting=pending;
    return pending;
  }

  private async connect(port:number,generation:number):Promise<string>{
    const args=serveArgs(port);
    const {exe,dns}=await this.findCli();
    this.exe=exe;
    const result=await this.call(exe,args);
    if(result.code!==0){
      const text=`${result.stdout}\n${result.stderr}`;
      throw new Error(/https|certificate/i.test(text)?NO_CERTIFICATES:`Tailscale could not publish remote access: ${firstLine(text)}`);
    }
    this.served=true;
    if(generation!==this.generation){await this.turnOff();throw new Error('Remote access stopped.');}
    return `https://${dns}`;
  }

  // Tries each known executable. Only a missing executable moves on to the next candidate.
  private async findCli():Promise<{exe:string;dns:string}>{
    for(const exe of TAILSCALE_EXECUTABLES){
      let result:Run;
      try{result=await this.run(exe,statusArgs());}
      catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')continue;throw error;}
      return {exe,dns:parseTailscaleStatus(result.stdout)};
    }
    throw new Error(NOT_INSTALLED);
  }

  private async call(exe:string,args:string[]):Promise<Run>{
    try{return await this.run(exe,args);}
    catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new Error(NOT_INSTALLED);throw error;}
  }

  // Removes only our port-443 serve entry, and only if this instance published one.
  private async turnOff():Promise<string|undefined>{
    const exe=this.exe;
    if(!exe||!this.served)return undefined;
    this.served=false;
    const result=await this.call(exe,serveOffArgs()).catch(error=>({code:1,stdout:'',stderr:error.message}));
    return result.code===0?undefined:`Could not turn off Tailscale serve: ${firstLine(`${result.stdout}\n${result.stderr}`)}`;
  }

  async stop():Promise<void>{
    this.generation++;
    this.origin=undefined;
    this.error=undefined;
    const failure=await this.turnOff();
    if(failure)this.error=failure;
  }

  status():RemoteStatus{
    return {origin:this.origin,starting:!!this.starting,error:this.error,named:false,provider:'tailscale'};
  }
}

function firstLine(text:string){
  return text.split(/\r?\n/).map(line=>line.trim()).find(Boolean)?.slice(0,300)||'no output';
}

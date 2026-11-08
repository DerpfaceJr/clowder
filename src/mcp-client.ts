// MCP client for connectors: stdio, Streamable HTTP and legacy SSE, hand-written on fetch and spawnCli. Shapes: connector-types.ts. Rules: docs/connectors-spec.md.
import {tmpdir} from 'node:os';
import {ENV_DROP, spawnCli, stopCli} from './claude-plan.ts';
import type {McpCallResult, McpClient, McpServerInfo, McpTool, McpTransport} from './connector-types.ts';

export const SUPPORTED_VERSIONS=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const PROTOCOL='2025-06-18';

export class McpError extends Error{
  // unsettled: the request was sent and we stopped waiting (timeout or abort), so the server may still have acted on it.
  status?:number; authRequired?:boolean; wwwAuthenticate?:string; unsettled?:boolean;
  constructor(message:string,extra:{status?:number;authRequired?:boolean;wwwAuthenticate?:string;unsettled?:boolean}={}){super(message);this.name='McpError';Object.assign(this,extra);}
}

type ConnectOpts={timeoutMs?:number;fetch?:typeof fetch;token?:()=>Promise<string|null>;spawn?:typeof spawnCli};
type HttpT={url:string;headers?:Record<string,string>};
// A transport only moves messages: send one JSON-RPC message, and stop itself on close.
type Link={send(msg:any,signal?:AbortSignal):Promise<void>;close():Promise<void>};
type Pending={done:(m:any)=>void;fail:(e:Error)=>void};

// One connection. It is also the McpClient the caller gets: the transports call deliver() and fail(), nothing else.
class Client implements McpClient{
  info:McpServerInfo={};
  onToolsChanged?:()=>void;
  link?:Link;
  version?:string;
  dead?:Error;
  private seq=0;
  private pending=new Map<number,Pending>();
  constructor(readonly timeoutMs:number){}

  call(method:string,params:unknown,o:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<any>{
    if(this.dead)return Promise.reject(this.dead);
    const id=++this.seq,ac=new AbortController();
    return new Promise((resolve,reject)=>{
      // Whichever comes first settles the call: the answer, the timeout, the owner's abort, or the transport failing.
      const settle=(fn:()=>void)=>{if(!this.pending.delete(id))return;clearTimeout(timer);o.signal?.removeEventListener('abort',onAbort);fn();};
      const giveUp=(err:Error)=>settle(()=>{this.notify('notifications/cancelled',{requestId:id,reason:err.message}).catch(()=>{});ac.abort();reject(err);});
      const onAbort=()=>giveUp(new McpError('Stopped by owner.',{unsettled:true}));
      const timer=setTimeout(()=>giveUp(new McpError('Connector call timed out.',{unsettled:true})),o.timeoutMs??this.timeoutMs);
      this.pending.set(id,{
        done:m=>settle(()=>m.error?reject(new McpError(`${m.error.code}: ${m.error.message}`)):resolve(m.result)),
        fail:e=>settle(()=>{ac.abort();reject(e);}),
      });
      if(o.signal?.aborted)return giveUp(new McpError('Stopped by owner.'));  // never sent, so nothing can have run
      o.signal?.addEventListener('abort',onAbort,{once:true});
      this.link?.send({jsonrpc:'2.0',id,method,params},ac.signal).catch(e=>this.pending.get(id)?.fail(e));
    });
  }

  async notify(method:string,params?:unknown){await this.link?.send({jsonrpc:'2.0',method,params});}

  // One incoming message: a server request gets its answer, a notification fires its hook, a response settles its call.
  // Messages are `any` on purpose: the server's JSON is checked field by field where it is used, not by a type.
  deliver(m:any){
    if(!m||typeof m!=='object')return;
    if(typeof m.method==='string'){
      if(m.id!==undefined)this.link?.send(m.method==='ping'?{jsonrpc:'2.0',id:m.id,result:{}}:{jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}}).catch(()=>{});
      else if(m.method==='notifications/tools/list_changed')this.onToolsChanged?.();
      return;
    }
    if('result' in m||'error' in m)this.pending.get(m.id)?.done(m);
  }

  fail(err:Error){this.dead=err;for(const p of [...this.pending.values()])p.fail(err);}

  async listTools(signal?:AbortSignal):Promise<McpTool[]>{
    const tools:McpTool[]=[];let cursor:string|undefined;
    for(let page=0;page<20;page++){
      const r=await this.call('tools/list',cursor?{cursor}:{},{signal});
      tools.push(...(r?.tools??[]));
      cursor=r?.nextCursor;
      if(!cursor||tools.length>=500)break;
    }
    return tools.slice(0,500);
  }

  async callTool(name:string,args:Record<string,unknown>,opts:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<McpCallResult>{
    return resultText(await this.call('tools/call',{name,arguments:args},opts));
  }

  async close(){this.fail(new Error('Connector closed.'));await this.link?.close().catch(()=>{});}
}

export async function connectMcp(transport:McpTransport,opts:ConnectOpts={}):Promise<McpClient>{
  const c=new Client(opts.timeoutMs??30000);
  try{
    if(transport.type==='stdio')c.link=await stdioLink(c,transport,opts.spawn??spawnCli);
    else if(transport.type==='http')c.link=httpLink(c,transport,opts);
    else c.link=await sseLink(c,transport,opts);
    await handshake(c);
    return c;
  }catch(e){await c.close();throw e;}
}

// initialize, check the version the server picked, then tell it we are ready. Used again when an HTTP session expires.
async function handshake(c:Client){
  c.version=undefined;
  const r=await c.call('initialize',{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'Clowder',version:'0.1.0'}});
  if(!SUPPORTED_VERSIONS.includes(r?.protocolVersion))throw new Error(`Connector speaks MCP ${r?.protocolVersion}, which Clowder does not support.`);
  c.version=r.protocolVersion;
  c.info={name:r.serverInfo?.name,version:r.serverInfo?.version,instructions:r.instructions,protocolVersion:r.protocolVersion};
  await c.notify('notifications/initialized');
}

async function stdioLink(c:Client,t:Extract<McpTransport,{type:'stdio'}>,spawn:typeof spawnCli):Promise<Link>{
  const child=spawn(t.command,t.args??[],{cwd:t.cwd??tmpdir(),dropEnv:ENV_DROP,env:t.env});
  // A missing executable fails a moment after spawn; wait for 'spawn' so the first write does not fail in a confusing way.
  await new Promise<void>((ok,bad)=>{child.once('spawn',()=>ok());child.once('error',e=>bad(new Error(`Could not start ${t.command}: ${e.message}`)));});
  child.on('error',e=>c.fail(new Error(`Connector stopped: ${e.message}`)));
  child.stdin.on('error',()=>{});
  let buf='',err='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',(d:string)=>{buf+=d;const lines=buf.split('\n');buf=lines.pop()??'';for(const line of lines){let m;try{m=JSON.parse(line);}catch{continue;}c.deliver(m);}});
  child.stderr.on('data',(d:string)=>{err=(err+d).slice(-2048);});
  child.on('close',code=>c.fail(new Error(`Connector stopped: ${err.trim().slice(-300)||`exit code ${code}`}`)));
  let closed=false;
  return{
    send:m=>new Promise<void>((ok,bad)=>child.stdin.write(`${JSON.stringify(m)}\n`,e=>e?bad(e):ok())),
    // stopCli kills the whole tree on Windows. Waiting for 'exit' (capped) means the process is gone when close() resolves.
    close:async()=>{
      if(closed)return;closed=true;stopCli(child);
      if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(ok=>{const t=setTimeout(ok,2000);child.once('exit',()=>{clearTimeout(t);ok();});});
    },
  };
}

// Caller headers, then the request's own, then a Bearer token when the owner has one.
async function authed(t:{headers?:Record<string,string>},o:ConnectOpts,h:Record<string,string>):Promise<Record<string,string>>{
  const token=await o.token?.();
  return {...t.headers,...h,...(token?{Authorization:`Bearer ${token}`}:{})};
}

// A 401 or 403 with a WWW-Authenticate challenge means sign-in; anything else is a status error.
async function httpError(res:Response){
  const body=await res.text().catch(()=>'');
  const auth=res.headers.get('www-authenticate');
  if((res.status===401||res.status===403)&&auth)return new McpError(`Sign-in needed (HTTP ${res.status}).`,{status:res.status,authRequired:true,wwwAuthenticate:auth});
  return new McpError(`HTTP ${res.status}: ${body.slice(0,200)}`,{status:res.status});
}

// A tool result whose text says the sign-in is bad ('auth') or lacks a permission ('scope'), however the server words it; null for any other error.
// Narrow on purpose: a match marks the account for the owner, so "permission denied" (a file) or a Graph rate limit (also an OAuthException) stay out.
export function authProblem(text:string):'auth'|'scope'|null{
  if(/insufficient[_ ]scope|missing (the )?(required )?(scopes?|permissions?)\b|\(#(10|200)\)|does not have (the )?(required )?permission|requires? (the )?[\w:.-]+ scope/i.test(text))return 'scope';
  if(/\b(HTTP|status|code)[ :]*401\b|\b401 Unauthorized|\bunauthori[sz]ed\b|invalid[_ ](access[_ ])?token|(token|session) (has )?(expired|been revoked)|error validating access token|bad credentials|not (logged|signed) in|(log|sign) ?in again/i.test(text))return 'auth';
  return null;
}

// A body is one message or an array of them. Non-JSON bodies carry nothing.
const messagesOf=(text:string):any[]=>{try{const j=JSON.parse(text);return Array.isArray(j)?j:[j];}catch{return [];}};

// Minimal SSE reader: event and data lines, multi-line data joined with \n, a blank line ends an event.
// onEvent returns true to stop reading early.
async function readSse(body:ReadableStream<Uint8Array>,onEvent:(ev:{event:string;data:string})=>boolean|void){
  const reader=body.getReader(),dec=new TextDecoder();
  let buf='',event='message',data:string[]=[];
  for(;;){
    const {done,value}=await reader.read();
    if(done)return;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split(/\r?\n/);buf=lines.pop()??'';
    for(const line of lines){
      if(line===''){
        if(data.length&&onEvent({event,data:data.join('\n')})===true){await reader.cancel().catch(()=>{});return;}
        event='message';data=[];
      }else if(!line.startsWith(':')){
        const i=line.indexOf(':'),field=i<0?line:line.slice(0,i),val=i<0?'':line.slice(i+1).replace(/^ /,'');
        if(field==='event')event=val;else if(field==='data')data.push(val);
      }
    }
  }
}

// Streamable HTTP: each POST is answered with JSON or an SSE stream. The session id and protocol version ride on every later request.
function httpLink(c:Client,t:HttpT,o:ConnectOpts):Link{
  const doFetch=o.fetch??fetch;
  let sid:string|undefined,renewing:Promise<void>|undefined;
  // ponytail: no standalone GET stream, so list_changed only arrives inside a response. Open the GET stream if a server needs it.
  const sessionHeaders=(s?:string)=>({...(s?{'Mcp-Session-Id':s}:{}),...(c.version?{'MCP-Protocol-Version':c.version}:{})});
  const post=async(msg:any,signal?:AbortSignal,retried=false):Promise<void>=>{
    const sent=sid;
    const res=await doFetch(t.url,{method:'POST',signal,body:JSON.stringify(msg),headers:await authed(t,o,{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...sessionHeaders(sent)})});
    sid=res.headers.get('mcp-session-id')??sid;
    // The session expired on the server: start one again, once, and send the request again.
    if(res.status===404&&sent&&!retried){
      await res.text().catch(()=>{});
      if(sid===sent){sid=undefined;renewing=handshake(c);}
      await renewing;
      return post(msg,signal,true);
    }
    if(res.status===202||res.status===204){await res.text().catch(()=>{});return;}
    if(!res.ok)throw await httpError(res);
    if((res.headers.get('content-type')??'').includes('text/event-stream')){
      // Stop once this request's answer is in; other messages on the stream are still delivered.
      const want=msg.method!==undefined&&msg.id!==undefined?msg.id:undefined;
      await readSse(res.body!,ev=>{for(const m of messagesOf(ev.data)){c.deliver(m);if(want!==undefined&&m?.id===want&&('result' in m||'error' in m))return true;}});
    }else for(const m of messagesOf(await res.text()))c.deliver(m);
  };
  return{
    send:(m,signal)=>post(m,signal),
    close:async()=>{
      const s=sid;sid=undefined;
      if(s)await doFetch(t.url,{method:'DELETE',headers:await authed(t,o,sessionHeaders(s))}).catch(()=>{});
    },
  };
}

// Legacy SSE (2024-11-05): a GET stream whose first `endpoint` event names the POST URL. Every answer comes back on the stream.
async function sseLink(c:Client,t:HttpT,o:ConnectOpts):Promise<Link>{
  const doFetch=o.fetch??fetch;
  const ac=new AbortController();
  const res=await doFetch(t.url,{signal:ac.signal,headers:await authed(t,o,{Accept:'text/event-stream'})});
  if(!res.ok)throw await httpError(res);
  const body=res.body;if(!body)throw new Error('Connector sent no event stream.');
  const origin=new URL(t.url).origin;
  let endpoint!:(url:string)=>void,refuse!:(e:Error)=>void;
  const opened=new Promise<string>((ok,bad)=>{endpoint=ok;refuse=bad;});
  readSse(body,ev=>{
    if(ev.event==='endpoint'){
      const u=new URL(ev.data,t.url);
      if(u.origin!==origin){refuse(new Error('Connector endpoint is on another server; refusing it.'));return true;}
      endpoint(u.href);
    }else if(ev.event==='message')for(const m of messagesOf(ev.data))c.deliver(m);
  }).catch(()=>{}).finally(()=>{const e=new Error('Connector stopped: its stream closed.');refuse(e);c.fail(e);});
  const url=await Promise.race([opened,new Promise<never>((_,bad)=>setTimeout(()=>bad(new Error('Connector call timed out.')),c.timeoutMs).unref())]);
  return{
    send:async m=>{
      const r=await doFetch(url,{method:'POST',body:JSON.stringify(m),headers:await authed(t,o,{'Content-Type':'application/json'})});
      if(!r.ok)throw await httpError(r);
      await r.text().catch(()=>{});
    },
    close:async()=>{ac.abort();},
  };
}

// Text for the model: text kept, other parts described in brackets, the whole thing cut at cap characters.
export function resultText(result:any,cap=12000):McpCallResult{
  const parts:string[]=(Array.isArray(result?.content)?result.content:[]).map((p:any)=>{
    if(p?.type==='text')return String(p.text??'');
    if(p?.type==='image'||p?.type==='audio')return `[${p.type}: ${p.mimeType}, ${Math.round(String(p.data??'').length*3/4)} bytes]`;
    if(p?.type==='resource')return typeof p.resource?.text==='string'?p.resource.text:`[resource: ${p.resource?.uri}]`;
    if(p?.type==='resource_link')return `[link: ${p.name} ${p.uri}]`;
    return '';
  }).filter(Boolean);
  let text=parts.join('\n\n');
  if(!parts.length&&result?.structuredContent!==undefined)text=JSON.stringify(result.structuredContent);
  if(text.length>cap)text=`${text.slice(0,cap)}\n… (cut at ${cap.toLocaleString('en-US')} characters)`;
  return {text,isError:result?.isError===true};
}

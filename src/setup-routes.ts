import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import qrcode from 'qrcode-generator';
import {isOwner} from './access.ts';

// The "Set up Clowder" hub's server side: a one-at-a-time Ollama model download and the pairing QR. Owner-only, main app only.
export const PULL_MODEL=/^[A-Za-z0-9._:\/-]{1,80}$/;
// ponytail: a download that goes quiet for this long is abandoned so the single job slot frees up; no resume.
const STALL_MS=5*60_000;
export type PullJob={model:string;status:'running'|'done'|'failed';completed:number;total:number;error:string|null};
export type SetupOptions={ollamaBase:()=>string;defaultModel:()=>string|undefined};

export const pairLink=(origin:string,code:string)=>`${origin}/#pair=${encodeURIComponent(code)}`;
// Error correction M, black on white, no external references. Scalable, so the phone sheet can size it.
export function pairQrSvg(link:string){const qr=qrcode(0,'M');qr.addData(link);qr.make();return qr.createSvgTag({cellSize:4,margin:4,scalable:true});}

// Streams Ollama's NDJSON pull. Layers are summed by digest so progress does not jump between layers.
export async function pullModel(base:string,model:string,onProgress:(completed:number,total:number)=>void):Promise<void>{
  const ctrl=new AbortController();
  let stall=setTimeout(()=>ctrl.abort(),STALL_MS);
  const touch=()=>{clearTimeout(stall);stall=setTimeout(()=>ctrl.abort(),STALL_MS);};
  try{
    let res:Response;
    try{res=await fetch(`${base}/api/pull`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:true}),signal:ctrl.signal});}
    catch{throw new Error('Ollama is not answering. Start Ollama, then try again.');}
    if(!res.ok||!res.body){const body=await res.json().catch(()=>null) as {error?:unknown}|null;throw new Error(typeof body?.error==='string'?body.error:`Ollama answered ${res.status}.`);}
    const layers=new Map<string,{total:number;completed:number}>();
    let finished=false,buffer='';
    const handle=(line:string)=>{
      if(!line.trim())return;
      const msg=JSON.parse(line);
      if(typeof msg.error==='string')throw new Error(msg.error);
      if(typeof msg.digest==='string'&&typeof msg.total==='number')layers.set(msg.digest,{total:msg.total,completed:Number(msg.completed)||0});
      if(msg.status==='success')finished=true;
      const values=[...layers.values()];
      onProgress(values.reduce((sum,l)=>sum+l.completed,0),values.reduce((sum,l)=>sum+l.total,0));
    };
    const decoder=new TextDecoder();
    for await(const chunk of res.body){
      touch();
      buffer+=decoder.decode(chunk,{stream:true});
      for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){handle(buffer.slice(0,at));buffer=buffer.slice(at+1);}
      // success is the last line Ollama means; do not wait for the socket to close after it.
      if(finished)break;
    }
    if(!finished){handle(buffer+decoder.decode());}
    if(!finished)throw new Error('The download stopped before it finished.');
  }catch(err){
    if(ctrl.signal.aborted)throw new Error('The download stalled. Try again.');
    throw err;
  }finally{clearTimeout(stall);}
}

const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{
  if(!isOwner(req))return reply.code(403).send({error:'Setup is managed on the host computer.'});
};

export function registerSetupRoutes(app:FastifyInstance,opts:SetupOptions){
  let job:PullJob|null=null;
  app.get('/api/setup/ollama-pull',{onRequest:ownerOnly},async()=>({job}));
  app.post('/api/setup/ollama-pull',{onRequest:ownerOnly},async(req,reply)=>{
    const requested=(req.body as {model?:unknown}|undefined)?.model??opts.defaultModel();
    if(typeof requested!=='string'||!PULL_MODEL.test(requested))return reply.code(400).send({error:'Pick a model name such as qwen3.5:4b.'});
    if(job?.status==='running'){
      if(job.model===requested)return {job};
      return reply.code(409).send({error:`${job.model} is already downloading.`,job});
    }
    const current:PullJob={model:requested,status:'running',completed:0,total:0,error:null};
    job=current;
    void pullModel(opts.ollamaBase(),requested,(completed,total)=>{current.completed=completed;current.total=total;})
      .then(()=>{current.status='done';current.completed=current.total||current.completed;})
      .catch(err=>{current.status='failed';current.error=(err as Error).message;});
    return {job:current};
  });
}

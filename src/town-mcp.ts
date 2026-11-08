// The town MCP (plan 4.11, H1c; hermes-adaptation.md §4.1): Clowder's own tools for a Hermes Mayor over MCP streamable HTTP with plain JSON replies
// (initialize, tools/list, tools/call; no event stream). Hermes names them mcp__clowder__<tool>. Loopback and the gate token only, on the main
// listener. tools/list is the loop's own Mayor list; tools/call goes through Town.hermesCall, which runs only what the gate cleared.
import type {FastifyInstance} from 'fastify';
import type {Town} from './engine.ts';
import {ownLoopback,type HermesSidecar} from './hermes.ts';

const PROTOCOL='2025-06-18';
/** The Mayor's tools as MCP tools: name, description and the same JSON schema the loop gives its model. */
export const townTools=(town:Town)=>town.hermesTools().map((t:any)=>({name:String(t.function.name),description:String(t.function.description??''),inputSchema:t.function.parameters??{type:'object',properties:{}}}));

/** One JSON-RPC message; null for a notification, which gets no reply. */
export async function mcpReply(town:Town,msg:any):Promise<object|null>{
  if(!msg||typeof msg!=='object'||msg.id===undefined||msg.id===null)return null;
  const ok=(result:object)=>({jsonrpc:'2.0',id:msg.id,result}),p=msg.params??{};
  if(msg.method==='initialize')return ok({protocolVersion:typeof p.protocolVersion==='string'?p.protocolVersion:PROTOCOL,capabilities:{tools:{listChanged:false}},serverInfo:{name:'clowder',version:'1'}});
  if(msg.method==='ping')return ok({});
  if(msg.method==='tools/list')return ok({tools:townTools(town)});
  if(msg.method==='tools/call'){
    if(typeof p.name!=='string')return {jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'tools/call needs a tool name.'}};
    // Hermes's hook saw this call as mcp__clowder__<name>, so that is the name its gate ticket carries.
    const {text,isError}=await town.hermesCall(`mcp__clowder__${p.name}`,p.arguments??{});
    return ok({content:[{type:'text',text}],isError});
  }
  return {jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:`Method not found: ${String(msg.method)}`}};
}

export function registerTownMcp(app:FastifyInstance,sidecar:HermesSidecar,town:()=>Town){
  // Tool arguments can be whole files (push_files), past the app's 32 KB body limit, as on the gate route.
  app.post('/mcp',{onRequest:ownLoopback(sidecar),bodyLimit:4_000_000},async(req,reply)=>{
    const body=req.body as any,replies=(await Promise.all((Array.isArray(body)?body:[body]).map(m=>mcpReply(town(),m)))).filter(Boolean);
    if(!replies.length)return reply.code(202).send();
    return Array.isArray(body)?replies:replies[0];
  });
  // Streamable HTTP lets a server refuse the GET stream; every reply here is plain JSON.
  app.get('/mcp',{onRequest:ownLoopback(sidecar)},async(_req,reply)=>reply.code(405).header('allow','POST').send({error:'This server sends no event stream.'}));
}

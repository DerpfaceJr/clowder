// A fake Hermes for the bridge and town MCP tests (plan 4.10, 4.11), speaking the protocol the spike recorded at v0.22.5 (docs/research/hermes-spike.md):
// /health, /v1/capabilities, POST /v1/runs with Idempotency-Key (kept across restarts; an old key gets the old run with replayed: true),
// GET /v1/runs/{id} with pending_controls, SSE /v1/runs/{id}/events (buffered events replay on every connect), /approval, /resolve-unknown, /stop.
// Its "model" runs the @call <tool> <json> lines of a run's input in order. For each one it does what Hermes and the clowder_gate plugin do: the gate
// call (pre_tool_call), then Clowder's town MCP for mcp__clowder__* or a native result plus post_tool_call; an ask parks the run. A restart (the
// process killed, the sidecar starting it again) leaves started runs unknown, as Hermes does. /fake/* are the tests' own controls, without the key.
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const home=process.env.HERMES_HOME,gate=process.env.CLOWDER_GATE_URL,token=process.env.CLOWDER_HERMES_TOKEN,nonce=process.env.CLOWDER_HERMES_NONCE;
const env=Object.fromEntries(readFileSync(join(home,'.env'),'utf8').split('\n').filter(Boolean).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const file=join(home,'fake-state.json');
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{runs:{},keys:{},posts:[],answers:[],resolved:[],stops:[]};
// Hermes marks started admissions unknown when it boots ("never replay started work", v0.22.5 hermes_state_runtime.py:447-459).
for(const r of Object.values(state.runs))if(['started','running','waiting_for_approval'].includes(r.status)){r.status='unknown';r.pending_controls=[];}
const save=()=>writeFileSync(file,JSON.stringify(state));save();
const mcp=[],gates=[],streams=new Map(),waiters=new Map();let tools=null,connects=0;
const hex=()=>randomBytes(16).toString('hex');
const post=async(url,body,headers={})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t,status:r.status};}};
const toClowder=(path,body)=>post(gate+path,body,{authorization:'Bearer '+token,'x-town-action':'owner'});
// The MCP client sends exactly the headers config.yaml gives the clowder server, ${VAR} filled from the environment, as Hermes does.
const cfg=readFileSync(join(home,'config.yaml'),'utf8').replace(/\r/g,'');
const mcpHeaders=Object.fromEntries([...(/^\s+headers:\n((?:\s{6,}\S.*\n)+)/m.exec(cfg)?.[1]??'').matchAll(/^\s+([A-Za-z-]+):\s*"?([^"#\n]*?)"?\s*(?:#.*)?$/gm)].map(m=>[m[1],m[2].replace(/\$\{(\w+)\}/g,(_,v)=>process.env[v]??'')]));
const mcpUrl=/^\s+url:\s*(http\S+\/mcp)\s*$/m.exec(cfg)?.[1];
let rpc=0;const mcpCall=(method,params)=>post(mcpUrl,{jsonrpc:'2.0',id:++rpc,method,params},mcpHeaders);

function emit(run,event,fields){
  const e={event,run_id:run.run_id,timestamp:Date.now()/1000,...fields,seq:run.events.length};
  run.events.push(e);save();
  for(const res of streams.get(run.run_id)??[]){res.write(`event: ${event}\ndata: ${JSON.stringify(e)}\n\n`);if(/^run\./.test(event))res.end();}
}
const view=r=>({object:'hermes.run',run_id:r.run_id,status:r.status,session_id:r.session_id,admission_id:r.admission_id,execution_generation:r.execution_generation,pending_controls:r.pending_controls,output:r.output,usage:r.usage});

async function agent(run){
  const steps=[];
  // The owner's message is the input's last paragraph; the history before it (Earlier owner to mayor: ...) is not a script.
  for(const line of run.input.split('\n\n').at(-1).split('\n')){const m=/^@call\s+(\S+)\s*(.*)$/.exec(line.trim());if(m)steps.push({tool:m[1],args:m[2]?JSON.parse(m[2]):{}});}
  const results=[];run.status='running';save();
  for(const [i,{tool,args}] of steps.entries()){
    if(run.status!=='running')return;
    const call=`call_${run.run_id}_${i}`;
    // pre_tool_call, as the shipped plugin sends it.
    const d=await toClowder('/api/hermes/gate',{v:1,tool,args,session_id:run.session_id,task_id:run.session_id,tool_call_id:call,turn_id:'t1',pid:process.pid,nonce,t:Date.now(),exec_ask:'1'}).catch(e=>({error:String(e)}));
    gates.push({tool,call,action:d.action});
    let go=d.action==='allow',result=d.action==='allow'?'':String(d.message||'Blocked by Clowder.');
    if(d.action==='ask'){
      const control={kind:'approval',prompt_id:hex(),execution_generation:run.execution_generation,command:`<${tool}> (plugin approval rule)`,description:String(d.message||''),choices:['once','deny','session','always']};
      run.status='waiting_for_approval';run.pending_controls=[control];save();
      emit(run,'approval.request',control);
      const choice=await new Promise(done=>waiters.set(run.run_id,done));
      if(run.status!=='running')return;
      emit(run,'approval.settled',{prompt_id:control.prompt_id,execution_generation:control.execution_generation});
      go=choice==='once';if(!go)result='BLOCKED: Action denied by user. The user has NOT consented to this action. Do NOT retry it.';
    }
    if(go){
      emit(run,'tool.started',{tool,preview:JSON.stringify(args).slice(0,80),tool_call_id:call});
      if(tool.startsWith('mcp__clowder__')){const r=await mcpCall('tools/call',{name:tool.slice(14),arguments:args});mcp.push({name:tool.slice(14),args,reply:r});result=String(r?.result?.content?.[0]?.text??JSON.stringify(r));}
      else{result=`native ${tool} ok`;await toClowder('/api/hermes/result',{v:1,tool,session_id:run.session_id,tool_call_id:call,status:'ok',result,nonce}).catch(()=>{});}
      // The preview really is empty at v0.22.5 (spike S6).
      emit(run,'tool.completed',{tool,duration:0,error:false,tool_call_id:call,preview:''});
    }
    results.push(result);
  }
  if(run.status!=='running')return;
  run.output=`FINAL ${JSON.stringify(results.map(r=>r.slice(0,300)))}`;run.usage={input_tokens:20,output_tokens:10,total_tokens:30};run.status='completed';save();
  emit(run,'message.delta',{delta:run.output});
  emit(run,'run.completed',{output:run.output,usage:run.usage,runtime:{provider:'',model:'',route_source:'global'},completed:true,partial:false,interrupted:false});
}

const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=raw?JSON.parse(raw):{},url=req.url;let m;
  if(url==='/health')return send(res,200,{status:'ok'});
  if(url==='/fake/state')return send(res,200,{...state,mcp,gates,tools,connects,pid:process.pid});
  // Every open stream ends without the run's end, as when Hermes's SSE drops; the next connect replays the buffer (spike S5).
  if(url==='/fake/drop'){for(const set of streams.values())for(const s of set)s.destroy();streams.clear();return send(res,200,{});}
  if(url==='/fake/exit'){send(res,200,{});setTimeout(()=>process.exit(1),50);return;}
  // The key from the environment, as Hermes v0.22.5 reads it (Clowder no longer writes it to .env).
  if(!process.env.API_SERVER_KEY||req.headers.authorization!=='Bearer '+process.env.API_SERVER_KEY)return send(res,401,{error:'Invalid gateway API key'});
  if(url==='/v1/capabilities')return send(res,200,{object:'hermes.api_server.capabilities',auth:{type:'bearer',required:true},features:{run_submission:true,run_status:true,run_events_sse:true,run_stop:true,run_approval_response:true,run_unknown_resolution:true,approval_events:true}});
  if(url==='/v1/runs'&&req.method==='POST'){
    const key=req.headers['idempotency-key'],seen=key&&state.keys[key];
    state.posts.push({key,session:body.session_id,input:body.input,instructions:body.instructions});save();
    if(seen&&Date.now()-seen.at<86_400_000)return send(res,202,{run_id:seen.run,status:'started',replayed:true});
    const run={run_id:'run_'+hex(),status:'started',session_id:body.session_id,input:String(body.input??''),admission_id:hex(),execution_generation:1,pending_controls:[],output:'',usage:{},events:[]};
    state.runs[run.run_id]=run;if(key)state.keys[key]={run:run.run_id,at:Date.now()};save();
    send(res,202,{run_id:run.run_id,status:'started',replayed:false});
    setTimeout(()=>void agent(run).catch(e=>{run.status='failed';emit(run,'run.failed',{error:String(e)});}),20);return;
  }
  const run=(m=/^\/v1\/runs\/([^/]+)/.exec(url))?state.runs[m[1]]:null;
  if(!run)return send(res,404,{error:'Run not found'});
  if(url.endsWith('/events')){
    connects++;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    for(const e of run.events)res.write(`event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`);
    if(['completed','failed','cancelled'].includes(run.status))return res.end();
    if(!streams.has(run.run_id))streams.set(run.run_id,new Set());streams.get(run.run_id).add(res);res.on('close',()=>streams.get(run.run_id)?.delete(res));return;
  }
  if(url.endsWith('/approval')&&req.method==='POST'){
    const c=run.pending_controls[0];
    if(run.status!=='waiting_for_approval'||!c||c.prompt_id!==body.request_id||c.execution_generation!==body.execution_generation)return send(res,409,{error:'No such pending approval'});
    state.answers.push({run:run.run_id,...body});run.pending_controls=[];run.status='running';save();
    send(res,200,{run_id:run.run_id,status:'resolved',prompt_id:c.prompt_id});waiters.get(run.run_id)?.(body.choice);return;
  }
  if(url.endsWith('/resolve-unknown')&&req.method==='POST'){
    if(run.status!=='unknown'||body.admission_id!==run.admission_id||body.execution_generation!==run.execution_generation)return send(res,409,{error:'Not unknown'});
    state.resolved.push({run:run.run_id,...body});run.status='cancelled';save();
    return send(res,200,{run_id:run.run_id,admission_id:run.admission_id,status:'terminal',outcome:'interrupted',execution_generation:run.execution_generation});
  }
  if(url.endsWith('/stop')&&req.method==='POST'){
    state.stops.push(run.run_id);save();
    if(['started','running','waiting_for_approval'].includes(run.status)){run.status='cancelled';run.pending_controls=[];emit(run,'run.cancelled',{});waiters.get(run.run_id)?.('deny');}
    return send(res,200,{run_id:run.run_id,status:run.status});
  }
  if(req.method==='GET'&&/^\/v1\/runs\/[^/]+$/.test(url))return send(res,200,view(run));
  send(res,404,{error:'not found'});
});}).listen(Number(env.API_SERVER_PORT),'127.0.0.1',async()=>{
  // The plugin's hello at load, then the MCP client's handshake and tool list, as Hermes does at boot.
  await toClowder('/api/hermes/hello',{v:1,pid:process.pid,nonce,exec_ask:'1'}).catch(()=>{});
  await mcpCall('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fake-hermes',version:'0'}}).catch(()=>{});
  tools=(await mcpCall('tools/list',{}).catch(()=>null))?.result?.tools?.map(t=>t.name)??null;
});

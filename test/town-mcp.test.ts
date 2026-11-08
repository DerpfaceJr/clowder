// Plan 4.11 (H1c): the town MCP. tools/list is the loop's own Mayor list; tools/call runs only what the Hermes gate cleared, through the same
// execTool and startDelegation as the loop, so delegation keeps its rules (roads, busy cats, depth). Loopback and the gate token only.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import Fastify,{type FastifyInstance} from 'fastify';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installAccess} from '../src/access.ts';
import {Store,roadId} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {HermesSidecar} from '../src/hermes.ts';
import {registerTownMcp} from '../src/town-mcp.ts';
import {mayorTools} from '../src/provider.ts';
import {offeredTools} from '../src/autonomy.ts';
import type {ConnectorRuntime} from '../src/connector-types.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tmp=(p:string)=>mkdtempSync(join(tmpdir(),p));
const fn=(name:string)=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{path:{type:'string'}}}}});
const runtime={toolsFor:()=>[fn('mcp__github__get_file')],resolve:(_c:string,name:string)=>name==='mcp__github__get_file'?{connector:'github',label:'GitHub',tool:'get_file',permission:'allow',effect:'read',identity:null}:null,
  call:async(_c:string,_n:string,args:any)=>`contents of ${args.path}`,allowTool:()=>{},builtinPermission:()=>'allow',skills:()=>[],brief:()=>'',canUse:()=>false,grantable:()=>false,grant:()=>{},readSkill:()=>'',roles:()=>[],findPlugins:async()=>[],findPlugin:()=>null} as unknown as ConnectorRuntime;

type World={store:Store;town:Town;app:FastifyInstance;sidecar:HermesSidecar};
async function world(cfg=config):Promise<World>{
  const store=new Store(join(tmp('mcp-world-'),'events.jsonl'),cfg.cats),town=new Town(store,cfg,{local:async()=>new Promise(()=>{})});
  town.connectors=()=>runtime;town.townDefault=()=>({provider:'local'});
  for(const name of ['Scholar','Archivist'])town.recruit('owner',name,'');
  const sidecar=new HermesSidecar({dataDir:tmp('mcp-data-'),root,port:1,clowderPort:80,journal:()=>store});sidecar.keys();
  const app=Fastify({logger:false,bodyLimit:32000});installAccess(app,false,[],80,undefined,undefined,'test-owner');registerTownMcp(app,sidecar,()=>town);
  return {store,town,app,sidecar};
}
let w:World;
before(async()=>{w=await world();});
after(async()=>{w.town.dispose();await w.app.close();});
// The headers config.yaml gives Hermes's MCP client for the clowder server.
const hdr=(v:World,token=v.sidecar.keys().gateToken)=>({host:'127.0.0.1:80','content-type':'application/json',authorization:`Bearer ${token}`,'x-town-action':'owner'});
const rpc=(v:World,method:string,params:object={},id:number|null=1)=>v.app.inject({method:'POST',url:'/mcp',headers:hdr(v),payload:{jsonrpc:'2.0',...(id===null?{}:{id}),method,params}});
// A Mayor task the bridge started, and the gate's answer for one call, as the plugin would ask it.
const mayorTask=(v:World)=>{const t=v.town.createTask('mayor','owner','Plan the launch','hermes');v.store.emit('task.updated',{id:t.id,hermes:{session:`clowder-${t.id}`,run:'run_1'}});return v.store.state.tasks.find(x=>x.id===t.id)!;};
const gate=(v:World,task:{id:string},tool:string,args:object,call=`call-${Math.random()}`)=>v.town.hermesGate({session:`clowder-${task.id}`,tool:`mcp__clowder__${tool}`,args,toolCallId:call,parks:true});
const call=async(v:World,name:string,args:object)=>(await rpc(v,'tools/call',{name,arguments:args})).json().result as {content:{text:string}[];isError:boolean};

test('tools/list is the Mayor\'s own list: the town tools and the owner\'s connector tools, as the loop offers them',async()=>{
  const r=await rpc(w,'tools/list');assert.equal(r.statusCode,200);
  const tools=r.json().result.tools as {name:string;description:string;inputSchema:any}[];
  assert.deepEqual(tools.map(t=>t.name),w.town.hermesTools().map((t:any)=>t.function.name));
  const names=new Set(tools.map(t=>t.name));
  for(const t of offeredTools(mayorTools('hermes'),w.town.autonomyLevel()))assert.ok(names.has(t.function.name),t.function.name);
  assert.ok(names.has('mcp__github__get_file'),'a connector tool');assert.ok(names.has('request_connection'));
  assert.equal(tools.find(t=>t.name==='delegate')!.inputSchema.type,'object');
  w.town.autonomy=()=>'full';
  try{assert.ok(!(await rpc(w,'tools/list')).json().result.tools.some((t:any)=>t.name==='request_approval'),'not offered at full autonomy');}
  finally{w.town.autonomy=undefined;}
});

test('initialize, ping, a notification, a batch and an unknown method answer as MCP over plain JSON',async()=>{
  const init=(await rpc(w,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'t',version:'0'}})).json();
  assert.deepEqual(init.result,{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'clowder',version:'1'}});
  assert.deepEqual((await rpc(w,'ping',{},7)).json(),{jsonrpc:'2.0',id:7,result:{}});
  assert.equal((await rpc(w,'notifications/initialized',{},null)).statusCode,202);
  const batch=await w.app.inject({method:'POST',url:'/mcp',headers:hdr(w),payload:[{jsonrpc:'2.0',id:1,method:'ping'},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'resources/list'}]});
  assert.deepEqual(batch.json().map((m:any)=>[m.id,m.error?.code??'ok']),[[1,'ok'],[2,-32601]]);
  assert.equal((await w.app.inject({method:'GET',url:'/mcp',headers:hdr(w)})).statusCode,405,'no event stream');
});

test('loopback and the gate token only',async()=>{
  assert.equal((await w.app.inject({method:'POST',url:'/mcp',headers:hdr(w,'wrong'),payload:{jsonrpc:'2.0',id:1,method:'tools/list'}})).statusCode,401);
  assert.equal((await w.app.inject({method:'POST',url:'/mcp',headers:hdr(w),remoteAddress:'192.168.1.9',payload:{jsonrpc:'2.0',id:1,method:'tools/list'}})).statusCode,403);
});

test('tools/call runs only what the gate cleared, once, through the loop\'s execTool',async()=>{
  const task=mayorTask(w);
  // Nothing cleared: the bearer alone runs nothing.
  const bare=await call(w,'mcp__github__get_file',{path:'README.md'});
  assert.equal(bare.isError,true);assert.match(bare.content[0]!.text,/did not clear this call/);
  assert.equal(gate(w,task,'mcp__github__get_file',{path:'README.md'},'c-1').action,'allow');
  const ok=await call(w,'mcp__github__get_file',{path:'README.md'});
  assert.deepEqual(ok,{content:[{type:'text',text:'contents of README.md'}],isError:false});
  const finished=w.store.state.events.filter(e=>e.type==='tool.finished'&&e.data.task===task.id);
  assert.deepEqual(finished.map(e=>[e.data.name,e.data.call,e.data.result]),[['mcp__github__get_file','c-1','contents of README.md']]);
  assert.equal((await call(w,'mcp__github__get_file',{path:'README.md'})).isError,true,'the ticket is used up');
  assert.equal((await call(w,'mcp__github__get_file',{path:'OTHER.md'})).isError,true,'other arguments were never cleared');
});

test('request_approval: the owner\'s answer on the card is the call\'s result',async()=>{
  const task=mayorTask(w);
  const d=gate(w,task,'request_approval',{question:'Launch on Friday?',options:['Friday','Monday']},'c-q') as {action:string;approval:string};
  assert.equal(d.action,'ask');
  w.town.hermes=()=>({ready:()=>true,answer:async()=>{}});
  try{w.town.decide(d.approval,'Monday',true);}finally{w.town.hermes=undefined;}
  const r=await call(w,'request_approval',{question:'Launch on Friday?',options:['Friday','Monday']});
  assert.deepEqual(JSON.parse(r.content[0]!.text),{decision:'approved',answer:'Monday',scope:'discussion and local drafts only'});
  assert.equal((await call(w,'request_approval',{question:'Launch on Friday?',options:['Friday','Monday']})).isError,true,'once');
});

test('delegate goes through startDelegation: no road, a busy cat and depth over the limit are refused; a good one returns at once',async()=>{
  const task=mayorTask(w);
  const delegate=async(cat:string,text='Find a venue.')=>{gate(w,task,'delegate',{cat,task:text});return call(w,'delegate',{cat,task:text});};
  // No road from the Mayor to this cat.
  const road=roadId('mayor','archivist');w.store.state.roads=w.store.state.roads.filter(r=>r.id!==road);
  assert.match((await delegate('archivist')).content[0]!.text,/^Tool error: No road connects these cats/);
  // A good one: the child starts on Clowder's loop with the town default, and the call returns without waiting for it.
  const t0=Date.now(),ok=await delegate('scholar');
  const child=w.store.state.tasks.find(t=>t.parent===task.id)!;
  assert.equal(ok.isError,false);assert.equal(ok.content[0]!.text,`Delegated to scholar (task ${child.id}). End your turn; the result arrives as your next message.`);
  assert.ok(Date.now()-t0<2000,'returned at once');assert.equal(child.mode,'local');assert.equal(child.status,'running');
  assert.equal(w.store.state.tasks.find(t=>t.id===task.id)!.status,'running','the Mayor is not parked on its child');
  // The scholar is busy with that child; one more for this Mayor task waits too.
  assert.match((await delegate('scholar','Another job.')).content[0]!.text,/^Tool error: Wait for the cat you delegated to/);
  const other=mayorTask(w);gate(w,other,'delegate',{cat:'scholar',task:'Third.'});
  assert.match((await call(w,'delegate',{cat:'scholar',task:'Third.'})).content[0]!.text,/^Tool error: scholar is busy with other work/);
  // Depth: a town that allows no delegation at all.
  const flat=await world({...config,maxDelegationDepth:0});
  try{
    const t=mayorTask(flat);gate(flat,t,'delegate',{cat:'scholar',task:'Go.'});
    assert.match((await call(flat,'delegate',{cat:'scholar',task:'Go.'})).content[0]!.text,/^Tool error: Delegation depth limit reached/);
  }finally{flat.town.dispose();await flat.app.close();}
});

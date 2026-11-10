// Plan 4.11 (H1c): the town MCP. tools/list is the loop's own Mayor list; tools/call runs only what the Hermes gate cleared, through the same
// execTool and startDelegation as the loop, so delegation keeps its rules (roads, busy cats, depth). Loopback and the gate token only.
// Plan 11.28 (N18): the owner token, a second token type on the same endpoint with five owner tools through the owner verbs (D1 holds).
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import Fastify,{type FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installAccess,isHost,isOwner} from '../src/access.ts';
import {Store,roadId,type State} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {HermesSidecar} from '../src/hermes.ts';
import {OWNER_TOOLS,registerTownMcp} from '../src/town-mcp.ts';
import {OwnerTokens,registerOwnerTokenRoutes} from '../src/owner-tokens.ts';
import {OwnerVerbs} from '../src/owner-verbs.ts';
import {projects} from '../src/projects.ts';
import {deskTown,until,PUBLISH,WRITE} from './fixtures/desk-town.ts';
import {mayorTools} from '../src/provider.ts';
import {offeredTools} from '../src/autonomy.ts';
import type {ConnectorRuntime} from '../src/connector-types.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tmp=(p:string)=>mkdtempSync(join(tmpdir(),p));
const fn=(name:string)=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{path:{type:'string'}}}}});
const runtime={toolsFor:()=>[fn('mcp__github__get_file')],resolve:(_c:string,name:string)=>name==='mcp__github__get_file'?{connector:'github',label:'GitHub',tool:'get_file',permission:'allow',effect:'read',identity:null}:null,
  call:async(_c:string,_n:string,args:any)=>`contents of ${args.path}`,allowTool:()=>{},builtinPermission:()=>'allow',skills:()=>[],brief:()=>'',canUse:()=>false,grantable:()=>false,grant:()=>{},readSkill:()=>'',roles:()=>[],findPlugins:async()=>[],findPlugin:()=>null} as unknown as ConnectorRuntime;

type World={store:Store;town:Town;app:FastifyInstance;sidecar:HermesSidecar;tokens:OwnerTokens};
const questInput=(state:State)=>({state,projects:projects(state),capabilities:[],seasons:[],models:null,now:new Date()});
async function world(cfg=config):Promise<World>{
  const store=new Store(join(tmp('mcp-world-'),'events.jsonl'),cfg.cats),town=new Town(store,cfg,{local:async()=>new Promise(()=>{})});
  town.connectors=()=>runtime;town.townDefault=()=>({provider:'local'});
  for(const name of ['Scholar','Archivist'])town.recruit('owner',name,'');
  const sidecar=new HermesSidecar({dataDir:tmp('mcp-data-'),root,port:1,clowderPort:80,journal:()=>store});sidecar.keys();
  const tokens=new OwnerTokens(join(tmp('mcp-tokens-'),'owner-tokens.json')),verbs=new OwnerVerbs({town:()=>town,state:()=>store.state,input:questInput});
  const app=Fastify({logger:false,bodyLimit:32000});installAccess(app,false,[],80,undefined,undefined,'test-owner');registerTownMcp(app,sidecar,()=>town,{tokens,verbs,mode:()=>'local'});
  return {store,town,app,sidecar,tokens};
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

// ---- Plan 11.28: the owner token ----

const ownerRpc=(app:FastifyInstance,token:string,method:string,params:object={},extra:object={})=>app.inject({method:'POST',url:'/mcp',headers:{host:'127.0.0.1:80','content-type':'application/json',authorization:`Bearer ${token}`},payload:{jsonrpc:'2.0',id:1,method,params},...extra});
const ownerCall=async(app:FastifyInstance,token:string,name:string,args:object={})=>(await ownerRpc(app,token,'tools/call',{name,arguments:args})).json().result as {content:{text:string}[];isError:boolean};
const FIVE=['needs_you','answer_decision','mark_todo_done','send_request','get_result'];

test('11.28 proof: tools/list with an owner token lists the five owner tools and no Mayor tools; a Hermes token cannot call them',async()=>{
  assert.deepEqual(OWNER_TOOLS.map(t=>t.name),FIVE);
  const {token}=w.tokens.make('Claude Code');
  const listed=(await ownerRpc(w.app,token,'tools/list')).json().result.tools as {name:string}[];
  assert.deepEqual(listed.map(t=>t.name),FIVE);
  const mayor=new Set(w.town.hermesTools().map((t:any)=>t.function.name));
  assert.ok(listed.every(t=>!mayor.has(t.name)),'no Mayor tool');
  assert.ok(!(await rpc(w,'tools/list')).json().result.tools.some((t:any)=>FIVE.includes(t.name)),'the gate token lists none of them');
  // A Hermes token, even with a gate ticket for the very call, is refused every owner tool, and nothing is journaled as an owner call.
  const task=mayorTask(w),before=w.store.state.events.length;
  for(const name of FIVE){
    gate(w,task,name,{});
    const r=await call(w,name,{});assert.equal(r.isError,true,name);assert.match(r.content[0]!.text,/The Mayor cannot use this tool/,name);
  }
  assert.equal(w.store.state.events.slice(before).filter(e=>e.type==='owner.mcp').length,0);
});

test('an owner token cannot act as a cat: Mayor tools are refused before anything runs, even with a gate ticket',async()=>{
  const {token}=w.tokens.make('No cat');const task=mayorTask(w);
  gate(w,task,'mcp__github__get_file',{path:'SECRET.md'},'c-owner');gate(w,task,'delegate',{cat:'scholar',task:'Go.'});
  const before=w.store.state.events.length;
  for(const [name,args] of [['mcp__github__get_file',{path:'SECRET.md'}],['delegate',{cat:'scholar',task:'Go.'}],['request_connection',{}]] as const){
    const r=await ownerCall(w.app,token,name,args);assert.equal(r.isError,true,name);assert.match(r.content[0]!.text,/An owner token cannot use this tool/,name);
  }
  const fresh=w.store.state.events.slice(before);
  assert.deepEqual(fresh.filter(e=>e.type==='tool.started'||e.type==='tool.finished'||e.type==='task.created'),[],'nothing ran');
  assert.deepEqual(fresh.filter(e=>e.type==='owner.mcp').map(e=>[e.data.token,e.data.tool,e.data.ok]),[['No cat','mcp__github__get_file',false],['No cat','delegate',false],['No cat','request_connection',false]]);
});

test('owner tokens: loopback only, a made-up or revoked token gets 401 at once, and the file keeps a hash only',async()=>{
  const {id,token}=w.tokens.make('Laptop');
  assert.equal((await ownerRpc(w.app,token,'ping')).statusCode,200);
  assert.equal((await ownerRpc(w.app,token,'tools/list',{},{remoteAddress:'192.168.1.9'})).statusCode,403,'another address is refused');
  assert.equal((await ownerRpc(w.app,token,'tools/list',{},{headers:{host:'127.0.0.1:80','content-type':'application/json',authorization:`Bearer ${token}`,'x-forwarded-for':'8.8.8.8'}})).statusCode,403,'a proxied request is not local');
  assert.equal((await ownerRpc(w.app,`${token.slice(0,-2)}xx`,'ping')).statusCode,401,'a made-up token');
  assert.equal((await ownerRpc(w.app,w.sidecar.keys().apiKey,'ping')).statusCode,401,'another secret is not a token');
  assert.ok(w.tokens.list().find(t=>t.id===id)!.lastUsedAt,'last used is kept');
  w.tokens.revoke(id);
  assert.equal((await ownerRpc(w.app,token,'ping')).statusCode,401,'revoked: refused at once');
  // A second OwnerTokens reading the same file does not bring it back, and the file never held the value.
  const file=(w.tokens as any).file as string;
  assert.ok(!readFileSync(file,'utf8').includes(token.slice(10)));
  assert.equal(new OwnerTokens(file).authenticate(`Bearer ${token}`),undefined);
});

test('Make token and Revoke: the host only here; the token is shown once and is absent from the list, replies, the journal, the file and logs',async()=>{
  const lines:string[]=[],log=console.log,err=console.error;console.log=(...a)=>lines.push(a.join(' '));console.error=(...a)=>lines.push(a.join(' '));
  const desk=await deskTown(),file=join(tmp('mcp-owner-'),'owner-tokens.json'),tokens=new OwnerTokens(file);
  const verbs=new OwnerVerbs({town:()=>desk.town,state:()=>desk.store.state,input:questInput});
  const app=Fastify({logger:false,bodyLimit:32000});installAccess(app,false,[],80,undefined,undefined,'test-owner');
  registerOwnerTokenRoutes(app,{tokens,owner:isOwner,manage:isHost});registerTownMcp(app,null,()=>desk.town,{tokens,verbs,mode:()=>'test'});
  try{
    const host={host:'127.0.0.1:80','content-type':'application/json','x-town-action':'owner',cookie:'town_owner_80=test-owner'};
    const stranger={host:'127.0.0.1:80','content-type':'application/json','x-town-action':'owner'};
    assert.equal((await app.inject({method:'POST',url:'/api/owner-tokens',headers:stranger,payload:{name:'X'}})).statusCode,403,'a local program without the owner session');
    assert.equal((await app.inject({method:'POST',url:'/api/owner-tokens',headers:host,payload:{name:'X'},remoteAddress:'192.168.1.9'})).statusCode,403,'not this computer');
    const made=await app.inject({method:'POST',url:'/api/owner-tokens',headers:host,payload:{name:'Claude Code'}});
    assert.equal(made.statusCode,200);const {id,token,name}=made.json();assert.equal(name,'Claude Code');assert.match(token,/^clw_owner_[\w-]{43}$/);
    const listed=await app.inject({method:'GET',url:'/api/owner-tokens',headers:host});
    assert.deepEqual(Object.keys(listed.json().tokens[0]).sort(),['createdAt','id','lastUsedAt','name']);
    // Use it once for every tool, so every reply and journal line is checked.
    const replies:string[]=[];
    for(const tool of FIVE)replies.push((await ownerRpc(app,token,'tools/call',{name:tool,arguments:{id:'nope',answer:'x',text:'Hello Mayor'}})).body);
    replies.push((await ownerRpc(app,token,'tools/list')).body,(await app.inject({method:'GET',url:'/api/owner-tokens',headers:host})).body);
    assert.equal((await app.inject({method:'POST',url:`/api/owner-tokens/${id}/revoke`,headers:stranger,payload:{}})).statusCode,403,'revoke is the host\'s too');
    assert.equal((await app.inject({method:'POST',url:`/api/owner-tokens/${id}/revoke`,headers:host,payload:{}})).statusCode,200);
    assert.equal((await ownerRpc(app,token,'ping')).statusCode,401,'revoked');
    assert.equal((await app.inject({method:'POST',url:`/api/owner-tokens/${id}/revoke`,headers:host,payload:{}})).statusCode,404);
    const secret=token.slice('clw_owner_'.length);
    for(const r of replies)assert.ok(!r.includes(secret),'not in a reply after creation');
    assert.ok(!JSON.stringify(desk.store.state.events).includes(secret),'not in the journal');
    assert.ok(!readFileSync(file,'utf8').includes(secret),'not in the tokens file');
    assert.ok(!lines.join('\n').includes(secret),'not in the logs');
    const journaled=desk.store.state.events.filter(e=>e.type==='owner.mcp');
    assert.deepEqual(journaled.map(e=>e.data.tool),FIVE);
    assert.ok(journaled.every(e=>e.data.token==='Claude Code'&&Object.keys(e.data).sort().join()==='ok,token,tool'));
  }finally{console.log=log;console.error=err;await app.close();await desk.close();}
});

test('owner tools go through the owner verbs: a quick decision is answered, public and money decisions open the card, a to-do is marked done, a request is sent and read back',async()=>{
  const desk=await deskTown(),tokens=new OwnerTokens(join(tmp('mcp-owner-'),'owner-tokens.json'));
  const verbs=new OwnerVerbs({town:()=>desk.town,state:()=>desk.store.state,input:questInput});
  const app=Fastify({logger:false,bodyLimit:32000});installAccess(app,false,[],80,undefined,undefined,'test-owner');registerTownMcp(app,null,()=>desk.town,{tokens,verbs,mode:()=>'test'});
  const {token}=tokens.make('Claude Code');
  const items=async()=>JSON.parse((await ownerCall(app,token,'needs_you')).content[0]!.text).items as any[];
  const resolved=(id:string)=>desk.store.state.events.filter(e=>e.type==='approval.resolved'&&e.data.id===id);
  const idle=()=>until(()=>!desk.store.state.tasks.some(t=>t.cat==='scholar'&&['running','waiting','waiting_child'].includes(t.status)));
  try{
    // A public call (send_email) and a money call: no answers offered, and answer_decision is refused with "open the card".
    const pub=await desk.ask(PUBLISH,{to:'all@example.com'});
    const money=randomUUID();
    desk.store.emit('approval.requested',{id:money,task:pub.task,cat:'scholar',gate:'connector',effectClass:'money',question:'Pay the venue $400?',options:['Allow once','Deny'],status:'pending'});
    let list=await items();
    for(const id of [pub.id,money]){
      const item=list.find(i=>i.id===`approval:${id}`);assert.ok(item,id);assert.equal(item.answers,undefined);assert.equal(item.can,'Open the card in Clowder.');
      for(const answer of ['Allow once','Allow','Always allow']){
        const r=await ownerCall(app,token,'answer_decision',{id:`approval:${id}`,answer});
        assert.equal(r.isError,true);assert.match(r.content[0]!.text,/Open the card in Clowder/);
      }
      assert.equal(desk.store.state.approvals.find(a=>a.id===id)!.status,'pending');assert.equal(resolved(id).length,0);
    }
    desk.store.emit('approval.resolved',{id:money,status:'rejected',answer:'Deny',device:'host'});desk.town.decide(pub.id,'Deny',false);
    await idle();
    // A private write: its quick answers are offered, and only those words are taken.
    const write=await desk.ask(WRITE,{note:'groceries'});
    list=await items();assert.deepEqual(list.find(i=>i.id===`approval:${write.id}`).answers,['Allow once','Deny']);
    const typed=await ownerCall(app,token,'answer_decision',{id:write.id,answer:'Allow once and also publish'});
    assert.equal(typed.isError,true);assert.match(typed.content[0]!.text,/Answer with one of: Allow once, Deny/);
    const yes=await ownerCall(app,token,'answer_decision',{id:`approval:${write.id}`,answer:'Allow once'});
    assert.deepEqual([yes.isError,yes.content[0]!.text],[false,'Allow once: sent.']);
    assert.deepEqual(resolved(write.id).map(e=>[e.data.status,e.data.device]),[['approved','mcp:Claude Code']]);
    assert.equal((await ownerCall(app,token,'answer_decision',{id:write.id,answer:'Allow once'})).isError,true,'never twice');
    await until(()=>desk.calls.some(c=>c.name==='update_note'));await idle();
    // A to-do: mark_todo_done closes it; a payment step offers no Mark done and is refused.
    const step=(title:string,kind:string)=>{const id=randomUUID();desk.store.emit('owner.step',{id,goal:null,cat:'scholar',title,steps:`${title}.`,blocking:false,kind,task:write.task});return id;};
    const todo=step('Sign the hall form','legal'),pay=step('Pay the hall deposit','payment');
    list=await items();assert.equal(list.find(i=>i.id===`owner-step:${todo}`).can,'mark_todo_done');assert.equal(list.find(i=>i.id===`owner-step:${pay}`).can,'Open the card in Clowder.');
    assert.equal((await ownerCall(app,token,'mark_todo_done',{id:`owner-step:${pay}`})).isError,true);
    assert.equal((await ownerCall(app,token,'mark_todo_done',{id:todo})).isError,false);
    assert.deepEqual(desk.store.state.events.filter(e=>e.type==='owner.step.done'&&e.data.id===todo).map(e=>e.data.device),['mcp:Claude Code']);
    // send_request goes to the Mayor's inbox as the owner; get_result reads its status and result.
    const sent=JSON.parse((await ownerCall(app,token,'send_request',{text:'Plan the bake sale'})).content[0]!.text);
    const root=desk.store.state.tasks.find(t=>t.id===sent.id)!;assert.deepEqual([root.cat,root.from,root.by,root.origin],['mayor','owner',undefined,undefined]);
    await until(()=>desk.store.state.tasks.find(t=>t.id===sent.id)?.status==='done');
    const got=JSON.parse((await ownerCall(app,token,'get_result',{id:sent.id})).content[0]!.text);
    assert.equal(got.status,'done');assert.equal(got.result,desk.store.state.tasks.find(t=>t.id===sent.id)!.result);
    // A follow-up passes the app's checks: a team member's request is not the owner's to write inside.
    desk.store.state.tasks.find(t=>t.id===sent.id)!.by='p-member';
    const theirs=await ownerCall(app,token,'send_request',{text:'More',follow_up_of:sent.id});
    assert.equal(theirs.isError,true);assert.match(theirs.content[0]!.text,/team member/);
    assert.equal((await ownerCall(app,token,'send_request',{text:'   '})).isError,true,'empty text');
    assert.equal((await ownerCall(app,token,'get_result',{id:'nope'})).isError,true);
  }finally{await app.close();await desk.close();}
});

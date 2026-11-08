import {allRoles} from '../src/roles.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,roadId} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {openAIProvider,type Provider} from '../src/provider.ts';
import {createServer} from 'node:http';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const fixture=()=>{const file=join(mkdtempSync(join(tmpdir(),'cat-town-')),'events.jsonl');const store=new Store(file,allRoles(config));return {file,store,town:new Town(store,config)};};
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for state transition');}
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
test('demo actually delegates, builds a road, waits, persists and resumes after restart',async()=>{
  const {town,store,file}=fixture();const id=town.submit('mayor','Explore a service','demo');
  await until(()=>store.state.approvals.some(a=>a.status==='pending'));
  assert.equal(store.state.tasks.find(t=>t.id===id)?.status,'waiting');
  assert.ok(store.state.tasks.some(t=>t.cat==='scholar'&&t.status==='done'&&t.parent===id));
  assert.ok(store.state.messages.some(m=>m.from==='scholar'&&m.to==='mayor'));
  assert.ok(store.state.roads.some(r=>r.id===roadId('scholar','critic')));
  const persisted=new Store(file,[]);const resumed=new Town(persisted,config);const a=persisted.state.approvals[0];
  resumed.decide(a.id,'Approve draft',true);
  assert.throws(()=>resumed.decide(a.id,'Approve draft',true),/already/);
  await until(()=>persisted.state.tasks.find(t=>t.id===id)?.status==='done');
  assert.match(persisted.state.tasks.find(t=>t.id===id)!.result!,/local draft/);
  assert.ok(persisted.state.usage.every(u=>u.input===null&&u.cost===null));
  const reread=new Store(file,[]);assert.deepEqual(reread.state,persisted.state);
});
test('reject does not produce an approved draft',async()=>{
  const {town,store}=fixture();const id=town.submit('mayor','Test rejection','demo');await until(()=>store.state.approvals.length>0);
  town.decide(store.state.approvals[0].id,'Reject',false);await until(()=>store.state.tasks.find(t=>t.id===id)?.status==='done');
  assert.match(store.state.tasks.find(t=>t.id===id)!.result!,/rejected/);
});
test('roads and civic roles are enforced by the engine',async()=>{
  const {town,store}=fixture();assert.throws(()=>town.road('scholar','scholar','critic'),/Only/);
  assert.throws(()=>town.recruit('critic','Tester','Reviews'),/Only/);
  town.providers.test=async messages=>messages.some(m=>m.role==='tool')?{message:{role:'assistant',content:messages.at(-1).content}}:call('delegate',{cat:'critic',task:'Review'});
  const id=town.submit('scholar','Send to critic','test');await until(()=>store.state.tasks.find(t=>t.id===id)?.status==='done');
  assert.match(store.state.tasks.find(t=>t.id===id)!.result!,/No road/);assert.equal(store.state.tasks.filter(t=>!t.record).length,1,'no delegated task; the recorder may file the result');
  town.road('mayor','scholar','critic');town.road('mayor','critic','scholar');assert.equal(store.state.roads.filter(r=>r.id===roadId('scholar','critic')).length,1);
  const newId=town.recruit('mayor','Gardener','Tend ideas');assert.ok(store.state.roads.some(r=>r.id===roadId('mayor',newId)));
});
test('nested approval resumes the specialist then its waiting Mayor after restart',async()=>{
  const {file,store,town}=fixture();const provider:Provider=async messages=>{
    const mayor=messages[0].content.includes('CAT_ID=mayor');
    if(messages.at(-1).role==='tool')return {message:{role:'assistant',content:mayor?'Mayor received the specialist result':'Specialist finished after approval'}};
    return mayor?call('delegate',{cat:'scholar',task:'Ask for a decision'}):call('request_approval',{question:'Continue the local draft?',options:['Yes','No']});
  };
  town.providers.test=provider;const root=town.submit('mayor','Delegate','test');await until(()=>store.state.approvals.length>0);
  assert.equal(store.state.tasks.find(t=>t.id===root)?.status,'waiting_child');
  const reloaded=new Store(file,[]),resumed=new Town(reloaded,config,{test:provider});resumed.decide(reloaded.state.approvals[0].id,'Yes',true);
  await until(()=>reloaded.state.tasks.find(t=>t.id===root)?.status==='done');assert.ok(reloaded.state.tasks.every(t=>t.status==='done'));
  assert.match(reloaded.state.tasks.find(t=>t.id===root)!.result!,/received/);
});
test('pause cancels waiting work and stale approvals; resume does not repeat it',async()=>{
  const {town,store}=fixture();town.submit('mayor','Example','demo');await until(()=>store.state.approvals.length>0);const a=store.state.approvals[0];
  town.pause(true);assert.equal(a.status,'cancelled');assert.throws(()=>town.submit('mayor','Again','demo'),/paused/);
  town.pause(false);assert.throws(()=>town.decide(a.id,'Yes',true),/already/);assert.ok(!town.isBusy());
});
test('pause during a model call discards a late reply',async()=>{
  const {town,store}=fixture();let finish:(x:any)=>void=()=>{};town.providers.test=()=>new Promise(resolve=>finish=resolve);
  const id=town.submit('mayor','Wait','test');town.pause(true);finish({message:{role:'assistant',content:'Late result'}});
  await new Promise(r=>setTimeout(r,20));assert.equal(store.state.tasks.find(t=>t.id===id)?.status,'cancelled');assert.ok(!store.state.messages.some(m=>m.text==='Late result'));
});
// A complete damaged line (it ends in a newline). A torn last append with no newline is repaired instead: see journal-replay.test.ts.
test('broken journal fails visibly instead of resetting history',()=>{const {file}=fixture();appendFileSync(file,'invalid JSON\n');assert.throws(()=>new Store(file,[]));});
test('HTTP model adapter consumes real wire-format tool calls and usage, handles errors',async()=>{
  let request:any;const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;request=JSON.parse(text);res.setHeader('Content-Type','application/json');if(request.model==='failure'){res.writeHead(503);res.end('{}');return;}res.end(JSON.stringify({choices:[call('delegate',{cat:'scholar',task:'Review'})],usage:{prompt_tokens:21,completion_tokens:7}}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
  try{const provider=openAIProvider(`http://127.0.0.1:${port}`,'fixture',1000);const reply=await provider([{role:'user',content:'Hi'}],[],new AbortController().signal);assert.equal(request.model,'fixture');assert.equal(reply.message.tool_calls[0].function.name,'delegate');assert.equal(reply.usage.prompt_tokens,21);await assert.rejects(openAIProvider(`http://127.0.0.1:${port}`,'failure',1000)([],[],new AbortController().signal),/503/);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('delegation cycles are refused and the caller sees the reason',async()=>{
  const {store,town}=fixture();town.providers.test=async(messages)=>messages.at(-1).role==='tool'?{message:{role:'assistant',content:messages.at(-1).content}}:call('delegate',{cat:messages[0].content.includes('CAT_ID=mayor')?'scholar':'mayor',task:'Loop'});
  const id=town.submit('mayor','Try a cycle','test');await until(()=>store.state.tasks.find(t=>t.id===id)?.status==='done');assert.match(store.state.tasks.find(t=>t.id===id)!.result!,/cycle blocked/);
});
test('restarted in-flight work is interrupted without repeating provider calls',()=>{
  const {file,store,town}=fixture();town.createTask('mayor','owner','In flight','test');const reload=new Store(file,[]);new Town(reload,config);assert.equal(reload.state.tasks[0].status,'interrupted');assert.equal(reload.state.usage.length,0);
});

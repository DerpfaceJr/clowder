// Plan 4.10 (H1b): the Hermes bridge. A fake Hermes (test/fixtures/fake-hermes.mjs) runs as the sidecar's child and speaks the runs, SSE and
// pending_controls protocol the spike recorded; its scripted "model" calls Clowder's real gate route and town MCP as Hermes and the plugin do.
// One optional test drives the real Hermes from the spike's venv with the spike's scripted model when CAT_HERMES_PYTHON is set, skipped loudly otherwise.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import Fastify,{type FastifyInstance} from 'fastify';
import {spawn,type ChildProcess} from 'node:child_process';
import {cpSync,existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installAccess} from '../src/access.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {HermesSidecar,registerHermesRoutes} from '../src/hermes.ts';
import {HermesBridge} from '../src/hermes-bridge.ts';
import {registerTownMcp} from '../src/town-mcp.ts';
import {ALLOW_ONCE} from '../src/accounts.ts';
import type {ConnectorRuntime} from '../src/connector-types.ts';
import {untilEvery} from './helpers/until.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const FAKE=fileURLToPath(new URL('./fixtures/fake-hermes.mjs',import.meta.url));
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tmp=(p:string)=>mkdtempSync(join(tmpdir(),p));
const freePort=()=>new Promise<number>(done=>{const s=createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address() as {port:number};s.close(()=>done(port));});});
const until = untilEvery(25, 20000);

// The cats' own model (cats stay on Clowder's loop): one reply, held until a test opens the gate.
let hold:Promise<void>|null=null;
// A brief with PUSH-IT first asks to push a file (the owner's card), then reports.
const local=async(messages:any[])=>{
  if(hold)await hold;
  if(messages.at(-1)?.role!=='tool'&&String(messages.filter(m=>m.role==='user').at(-1)?.content).includes('PUSH-IT'))return {message:{role:'assistant',content:null,tool_calls:[{id:'c-push',type:'function',function:{name:'mcp__github__push_files',arguments:JSON.stringify({owner:'cat',repo:'site',files:[{path:'a.html'}]})}}]},usage:{prompt_tokens:2,completion_tokens:2}};
  return {message:{role:'assistant',content:'Three venues fit the budget; the riverside hall is free on the 12th.'},usage:{prompt_tokens:3,completion_tokens:4}};
};
const gateOpen=()=>{let open!:()=>void;hold=new Promise<void>(r=>{open=r;});return ()=>{hold=null;open();};};
// The owner's GitHub push_files, set to ask.
const pushes:any[]=[];
const fn=(name:string)=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{}}}});
const runtime={
  toolsFor:()=>[fn('mcp__github__push_files')],
  resolve:(_cat:string,name:string)=>name==='mcp__github__push_files'?{connector:'github',label:'GitHub',tool:'push_files',permission:'ask',effect:'write',identity:null}:null,
  call:async(cat:string,name:string,args:any)=>{pushes.push({cat,name,args});return `pushed ${args.files?.length??0} file(s) to ${args.repo}`;},
  allowTool:()=>{},builtinPermission:()=>'allow',skills:()=>[],brief:()=>'',canUse:()=>false,grantable:()=>false,grant:()=>{},readSkill:()=>'',roles:()=>[],findPlugins:async()=>[],findPlugin:()=>null,
} as unknown as ConnectorRuntime;

type World={store:Store;town:Town;app:FastifyInstance;port:number;sidecar:HermesSidecar;bridge:HermesBridge};
async function world(opts:{cfg?:any;root?:string;python?:string;startMs?:number}={}):Promise<World>{
  const store=new Store(join(tmp('bridge-world-'),'events.jsonl'),config.cats),town=new Town(store,opts.cfg??config,{local});
  town.connectors=()=>runtime;town.townDefault=()=>({provider:'local'});
  const port=await freePort(),app=Fastify({logger:false,bodyLimit:32000});installAccess(app,false,[],port,undefined,undefined,'test-owner');
  const sidecar=new HermesSidecar({dataDir:tmp('bridge-data-'),root:opts.root??root,port:await freePort(),clowderPort:port,journal:()=>store,...(opts.python?{python:opts.python,startMs:opts.startMs}:{cmd:[process.execPath,FAKE]})});
  const bridge=new HermesBridge({sidecar,town:()=>town,retryMs:100});
  town.hermes=()=>bridge;town.secrets=()=>sidecar.secretValues();
  registerHermesRoutes(app,sidecar,()=>town);registerTownMcp(app,sidecar,()=>town);
  await app.listen({port,host:'127.0.0.1'});
  return {store,town,app,port,sidecar,bridge};
}
const close=async(v:World)=>{v.bridge.close();await v.sidecar.stop();v.town.dispose();await v.app.close();};

let w:World;
before(async()=>{w=await world();await w.sidecar.start();await until(()=>w.sidecar.ready(),20_000,'the fake Hermes ready');});
after(async()=>{if(w)await close(w);});
const fake=async()=>await (await fetch(`${w.sidecar.url}/fake/state`)).json() as any;
const task=(id:string)=>w.store.state.tasks.find(t=>t.id===id)!;
const events=(id:string,type?:string)=>w.store.state.events.filter(e=>e.data?.task===id&&(!type||e.type===type));
const cards=(id:string)=>w.store.state.approvals.filter(a=>a.task===id&&a.gate==='hermes');
const PUSH='@call mcp__clowder__mcp__github__push_files {"owner":"cat","repo":"town","branch":"main","files":[{"path":"index.html","content":"hi"}]}';

test('a Mayor task becomes one run: one POST under the task id, the town brief as instructions; results from the town MCP and post_tool_call',async()=>{
  const live:any[]=[];w.town.live=frame=>live.push(frame);
  const id=w.town.submit('mayor','@call mcp__clowder__lookup {"about":"mayor"}\n@call skills_list {}','hermes');
  const done=await until(()=>task(id).status==='done'&&task(id),15_000,'the task done');
  w.town.live=undefined;
  // Hermes's message.delta reaches the owner as live text (plan 8.3), then a done frame; the journal keeps only run.completed's output.
  const mine=live.filter(f=>f.delta?.task===id);
  assert.match(mine.find(f=>f.delta.text)?.delta.text??'',/^FINAL /);
  assert.deepEqual(mine.at(-1).delta,{task:id,cat:'mayor',done:true});
  const posts=(await fake()).posts.filter((p:any)=>p.session===`clowder-${id}`);
  assert.equal(posts.length,1,'one run');assert.equal(posts[0].key,id,'Idempotency-Key = the task id');assert.match(posts[0].instructions,/^CAT_ID=mayor/);
  assert.equal(done.hermes?.session,`clowder-${id}`);assert.match(done.hermes?.run??'',/^run_/);
  const finished=events(id,'tool.finished');
  // Clowder's own tool: journaled by the town MCP handler with the real result. Hermes's own: started from SSE, result from post_tool_call.
  assert.deepEqual(events(id,'tool.started').map(e=>e.data.name),['lookup','skills_list']);
  assert.equal(finished.length,2);assert.ok(finished[0]!.data.result.length>0&&!finished[0]!.data.result.startsWith('Tool error'),finished[0]!.data.result);
  assert.equal(finished[1]!.data.result,'native skills_list ok');
  const usage=w.store.state.usage.filter(u=>u.task===id);
  assert.deepEqual(usage.map(u=>[u.mode,u.input,u.output]),[['hermes',20,10]],'one usage row per run');
  assert.match(w.store.state.messages.filter(m=>m.task===id&&m.from==='mayor').at(-1)!.text,/^FINAL /);
  assert.equal(done.result?.startsWith('FINAL'),true);
});

test('a duplicate approval.request yields one card; Allow once resumes the run and the tool result reaches the journal',async()=>{
  const before=(await fake()).connects;
  const id=w.town.submit('mayor',PUSH,'hermes');
  const card=await until(()=>cards(id).find(a=>a.status==='pending'),15_000,'the card');
  await until(()=>task(id).status==='waiting',15_000,'waiting');
  // The stream drops; the bridge reads the run again and Hermes replays approval.request (spike S5).
  await fetch(`${w.sidecar.url}/fake/drop`,{method:'POST'});
  const s=await (async()=>{const end=Date.now()+5000;while(Date.now()<end){const s=await fake();if(s.connects>=before+2)return s;await new Promise(r=>setTimeout(r,50));}assert.fail('no re-attach');})();
  assert.equal(Object.values(s.runs as Record<string,any>).find(r=>r.session_id===`clowder-${id}`).events.filter((e:any)=>e.event==='approval.request').length,1,'Hermes parked once');
  assert.equal(cards(id).length,1,'one card');
  assert.equal(card.question,'Mayor wants to use GitHub: push_files');assert.equal(card.call?.function.name,'mcp__github__push_files');
  w.town.decide(card.id,ALLOW_ONCE,true);
  await until(()=>task(id).status==='done',15_000,'done');
  const answer=(await fake()).answers.at(-1);
  assert.equal(answer.choice,'once');assert.equal(answer.execution_generation,1);assert.match(answer.request_id,/^[0-9a-f]{32}$/);
  assert.equal(pushes.length,1,'the push ran once, in Clowder');assert.equal(pushes[0].args.repo,'town');
  const finished=events(id,'tool.finished').filter(e=>e.data.name==='mcp__github__push_files');
  assert.equal(finished.length,1);assert.equal(finished[0]!.data.result,'pushed 1 file(s) to town');
  assert.equal(cards(id)[0]!.status,'approved');
});

test('Deny refuses: nothing runs in Clowder and the model is told it was blocked',async()=>{
  const n=pushes.length,id=w.town.submit('mayor',PUSH,'hermes');
  const card=await until(()=>cards(id).find(a=>a.status==='pending'),15_000,'the card');
  await until(()=>task(id).status==='waiting',15_000,'waiting');
  w.town.decide(card.id,'Deny',false);
  const done=await until(()=>task(id).status==='done'&&task(id),15_000,'done');
  assert.equal((await fake()).answers.at(-1).choice,'deny');
  assert.equal(pushes.length,n,'nothing pushed');
  assert.equal(events(id,'tool.finished').length,0);
  assert.match(done.result!,/BLOCKED: Action denied/);assert.equal(cards(id)[0]!.status,'rejected');
});

test('delegate through the town MCP returns at once; the child\'s result resumes the Mayor as a new run in the same session (S11)',async()=>{
  const open=gateOpen();
  const id=w.town.submit('mayor','@call mcp__clowder__delegate {"cat":"scholar","task":"Find a venue for the launch."}','hermes');
  const child=await until(()=>w.store.state.tasks.find(t=>t.parent===id),15_000,'the child');
  assert.equal(child.cat,'scholar');assert.equal(child.mode,'local','the cat stays on Clowder\'s loop, on the town default');
  // The Mayor's turn ended while the child is still working.
  await until(()=>task(id).status==='waiting_child',15_000,'waiting_child');
  assert.match(events(id,'tool.finished').find(e=>e.data.name==='delegate')!.data.result,new RegExp(`^Delegated to scholar \\(task ${child.id}\\)`));
  open();
  await until(()=>task(id).status==='done',15_000,'done');
  const posts=(await fake()).posts.filter((p:any)=>p.session===`clowder-${id}`);
  assert.deepEqual(posts.map((p:any)=>p.key),[id,`child-${child.id}`],'two runs, one session, each its own key');
  assert.match(posts[1].input,/^Result from scholar: Three venues fit/);
  assert.equal(task(child.id).status,'done');
  // The journal reads like the spike's step 7: the child's message to the Mayor, then the Mayor's second reply.
  const order=w.store.state.events.filter(e=>(e.type==='message'&&(e.data.task===id||e.data.task===child.id))||(e.type==='task.updated'&&(e.data.id===id||e.data.id===child.id)&&e.data.status)).map(e=>e.type==='message'?`message ${e.data.from}>${e.data.to}`:`${e.data.id===id?'mayor':'child'} ${e.data.status}`);
  assert.deepEqual(order.slice(order.indexOf('mayor waiting_child')),['mayor waiting_child','message scholar>mayor','child done','mayor running','message mayor>owner','mayor done']);
});

test('delegate-then-approve: the child waits on its own card on Clowder\'s loop; the owner\'s Allow finishes it and resumes the Mayor (Gate 4)',async()=>{
  const n=pushes.length,id=w.town.submit('mayor','@call mcp__clowder__delegate {"cat":"scholar","task":"PUSH-IT to the site."}','hermes');
  const child=await until(()=>w.store.state.tasks.find(t=>t.parent===id),15_000,'the child');
  const card=await until(()=>w.store.state.approvals.find(a=>a.task===child.id&&a.status==='pending'),15_000,'the child\'s card');
  assert.equal(card.gate,'connector');
  await until(()=>task(id).status==='waiting_child',15_000,'waiting_child');
  w.town.decide(card.id,ALLOW_ONCE,true);
  await until(()=>task(id).status==='done',15_000,'done');
  assert.equal(pushes.length,n+1);assert.equal(pushes.at(-1).cat,'scholar');
  assert.deepEqual((await fake()).posts.filter((p:any)=>p.session===`clowder-${id}`).map((p:any)=>p.key),[id,`child-${child.id}`]);
});

test('the monthly cap blocks a new run: a child\'s result waits as held work, and runs when the cap lifts',async()=>{
  const open=gateOpen();
  const id=w.town.submit('mayor','@call mcp__clowder__delegate {"cat":"scholar","task":"Draft the invite."}','hermes');
  const child=await until(()=>w.store.state.tasks.find(t=>t.parent===id),15_000,'the child');
  await until(()=>task(id).status==='waiting_child',15_000,'waiting_child');
  w.town.setUsageCap('owner',1);
  open();
  await until(()=>task(id).held==='cap',15_000,'held by the cap');
  assert.equal(task(id).status,'waiting');
  assert.equal((await fake()).posts.filter((p:any)=>p.session===`clowder-${id}`).length,1,'no second run while capped');
  assert.ok(w.store.state.approvals.some(a=>a.gate==='cap'&&a.status==='pending'),'the month\'s cap card');
  w.town.setUsageCap('owner',null);
  await until(()=>task(id).status==='done',15_000,'done after the lift');
  const posts=(await fake()).posts.filter((p:any)=>p.session===`clowder-${id}`);
  assert.deepEqual(posts.map((p:any)=>p.key),[id,`child-${child.id}`]);
});

test('an Idempotency-Key is never reused for new work: an old key, even across a Hermes restart, is refused and its old run not adopted',async()=>{
  const id=w.town.submit('mayor','@call skills_list {}','hermes');
  await until(()=>task(id).status==='done',15_000,'done');
  const first=task(id).hermes!.run!;
  await assert.rejects(w.bridge.startRun({task:id,session:`clowder-${id}`,input:'different work',key:id,instructions:''}),/already run request/);
  // Hermes keeps its keys 24 h across restarts.
  const pid=(await fake()).pid;
  await fetch(`${w.sidecar.url}/fake/exit`,{method:'POST'});
  await until(()=>!w.sidecar.ready(),15_000,'Hermes down');
  await until(()=>w.sidecar.ready(),20_000,'Hermes back');
  assert.notEqual((await fake()).pid,pid);
  await assert.rejects(w.bridge.startRun({task:id,session:`clowder-${id}`,input:'more different work',key:id,instructions:''}),/already run request/);
  assert.equal(task(id).hermes!.run,first,'the task keeps its own run');
  assert.equal(task(id).status,'done');
});

test('a Hermes restart during a wait ends the task interrupted with one message and no card left pending (S5, until row 4.12)',async()=>{
  const id=w.town.submit('mayor',PUSH,'hermes');
  const card=await until(()=>cards(id).find(a=>a.status==='pending'),15_000,'the card');
  await until(()=>task(id).status==='waiting',15_000,'waiting');
  const run=task(id).hermes!.run!;
  await fetch(`${w.sidecar.url}/fake/exit`,{method:'POST'});
  await until(()=>task(id).status==='interrupted',30_000,'interrupted');
  const s=await fake();
  assert.equal(s.runs[run].status,'cancelled');assert.equal(s.resolved.at(-1).run,run,'resolve-unknown settled the lost run');
  assert.equal(w.store.state.approvals.find(a=>a.id===card.id)!.status,'cancelled','no card left pending');
  assert.deepEqual(w.store.state.messages.filter(m=>m.task===id&&m.from==='system').map(m=>m.text),['Hermes restarted during this work, so it stopped here. Send a new message to continue.']);
});

test('pause stops every live Hermes run',async()=>{
  const id=w.town.submit('mayor',PUSH,'hermes');
  await until(()=>cards(id).find(a=>a.status==='pending'),15_000,'the card');
  const run=task(id).hermes!.run!;
  w.town.pause(true);
  try{
      const end=Date.now()+5000;let stops:string[]=[];while(Date.now()<end){stops=(await fake()).stops;if(stops.includes(run))break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(stops.includes(run),'POST /stop for the parked run');
    assert.equal(task(id).status,'cancelled');
  }finally{w.town.pause(false);}
});

test('with hermes off nothing changes: mode hermes is not a model, and a sidecar without the bridge takes no Mayor task',async()=>{
  const store=new Store(join(tmp('bridge-off-'),'events.jsonl'),config.cats),town=new Town(store,config,{});
  try{
    assert.throws(()=>town.submit('mayor','hello','hermes'),/This model is not configured/);
    town.hermes=()=>null;
    assert.throws(()=>town.submit('mayor','hello','hermes'),/This model is not configured/);
    town.hermes=()=>({ready:()=>true,answer:async()=>{}});
    assert.throws(()=>town.inbox('hello','hermes'),/This model is not configured/);
    assert.equal(store.state.tasks.length,0,'no task made');
  }finally{town.dispose();}
  // A cat other than the Mayor never runs on Hermes.
  assert.throws(()=>w.town.submit('scholar','hello','hermes'),/This model is not configured/);
});

// Optional: the real Hermes (CAT_HERMES_PYTHON, the spike's venv) with this repo's config.yaml, the shipped plugin, and the spike's scripted model
// (mock-llm.mjs, CAT_HERMES_MOCK) added as Hermes's model. n=2 Clowder tool calls: one the gate allows, one the owner allows on a card.
const python=process.env.CAT_HERMES_PYTHON,mock=process.env.CAT_HERMES_MOCK??(python?join(python,'..','..','..','mock-llm.mjs'):'');
test('the real Hermes runs a Mayor task through the bridge: an allowed call and a carded call reach Clowder\'s tools once each',{skip:!python&&'CAT_HERMES_PYTHON is not set, so the real-Hermes bridge test did NOT run',timeout:600_000},async t=>{
  assert.ok(existsSync(mock),`the scripted model at ${mock}`);
  const mockPort=await freePort(),logs=tmp('bridge-live-');
  const model:ChildProcess=spawn(process.execPath,[mock],{env:{...process.env,MOCK_PORT:String(mockPort),MOCK_LOG:join(logs,'mock-llm.jsonl')},stdio:'ignore',windowsHide:true});
  // This repo's hermes/ folder with a model block for the scripted model; the shipped template has none (row 4.2 picks the real one).
  const liveRoot=tmp('bridge-root-');cpSync(join(root,'hermes'),join(liveRoot,'hermes'),{recursive:true});
  writeFileSync(join(liveRoot,'hermes','config.yaml'),readFileSync(join(root,'hermes','config.yaml'),'utf8')+`model:\n  default: spike-model\n  provider: custom\n  base_url: http://127.0.0.1:${mockPort}/v1\n  api_key: sk-mock-not-a-secret\n  context_length: 131072\n`);
  const v=await world({root:liveRoot,python,startMs:240_000});
  try{
    const t0=Date.now();
    await v.sidecar.start();
    await until(()=>v.sidecar.ready(),240_000,'the real Hermes ready');
    t.diagnostic(`ready in ${Date.now()-t0} ms`);
    // The setup crew first, so lookup has a cat to read and the push has a card.
    const id=v.town.submit('mayor','@call mcp__clowder__lookup {"about":"mayor"}\n'+PUSH,'hermes');
    const card=await until(()=>v.store.state.approvals.find(a=>a.task===id&&a.gate==='hermes'&&a.status==='pending'),180_000,'the push card');
    t.diagnostic(`card: ${card.question}`);
    await until(()=>v.store.state.tasks.find(x=>x.id===id)?.status==='waiting',30_000,'waiting');
    // Hermes parks a moment after the gate's answer; answer once it says so.
    const run=v.store.state.tasks.find(x=>x.id===id)!.hermes!.run!;
    const end=Date.now()+60_000;while(Date.now()<end&&(await v.sidecar.api('GET',`/v1/runs/${run}`)).json?.status!=='waiting_for_approval')await new Promise(r=>setTimeout(r,250));
    const n=pushes.length;
    v.town.decide(card.id,ALLOW_ONCE,true);
    const done=await until(()=>{const x=v.store.state.tasks.find(x=>x.id===id)!;return ['done','failed','interrupted','cancelled'].includes(x.status)&&x;},180_000,'the task over');
    const ev=v.store.state.events.filter(e=>e.data?.task===id);
    t.diagnostic(`status ${done.status}; tool.finished: ${ev.filter(e=>e.type==='tool.finished').map(e=>`${e.data.name}=${String(e.data.result).slice(0,60)}`).join(' | ')}`);
    t.diagnostic(`journal: ${ev.map(e=>e.type==='tool.started'||e.type==='tool.finished'?`${e.type}:${e.data.name}`:e.type).join(' > ')}`);
    assert.equal(done.status,'done',String(done.result));
    assert.equal(pushes.length,n+1,'the carded push ran once, in Clowder');
    const finished=ev.filter(e=>e.type==='tool.finished');
    assert.ok(finished.some(e=>e.data.name==='lookup'&&!String(e.data.result).startsWith('Tool error')),'the allowed lookup ran through the town MCP');
    assert.ok(finished.some(e=>e.data.name==='mcp__github__push_files'&&e.data.result==='pushed 1 file(s) to town'));
    assert.equal(v.store.state.approvals.filter(a=>a.task===id&&a.gate==='hermes').length,1,'one card');
    assert.ok(v.store.state.usage.some(u=>u.task===id&&u.mode==='hermes'),'usage journaled');
  }finally{await close(v);model.kill();}
});

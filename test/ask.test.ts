import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {registerAskRoute} from '../src/ask.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import {Store,type Goal} from '../src/store.ts';
import type {Provider} from '../src/provider.ts';

const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
// Goal rounds wait a minute by default, so the tests that do not need rounds never see one start.
const slow={...base,goals:{roundPauseSeconds:60,maxRoundsPerDay:24,tokenBudget:null}};
const fixture=(providers:Record<string,Provider>={})=>{
  const file=join(mkdtempSync(join(tmpdir(),'ask-')),'events.jsonl');
  const store=new Store(file,allRoles(slow));
  const town=new Town(store,slow,providers);town.autonomy=()=>'balanced';
  return {store,town};
};
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for state transition');}
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+name+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
const asides=(store:Store)=>store.state.messages.filter(m=>m.aside);

test('an aside creates no task, and a waiting task keeps its saved context', async()=>{
  const {store,town}=fixture({test:async(messages,tools)=>{
    if(!tools.length)return reply('The plan is waiting for your go-ahead.');
    return call('request_approval',{question:'Draft the notice?',options:['Yes','No']});
  }});
  town.submit('mayor','Draft the town notice','test');
  await until(()=>store.state.tasks[0]?.status==='waiting');
  const task=store.state.tasks[0];
  const savedContext=(t:Parameters<typeof town.checkpoint>[0])=>JSON.stringify(town.checkpoint(t));
  const before=savedContext(task);
  assert.ok(town.checkpoint(task),'the waiting task has a checkpoint');
  const taskCount=store.state.tasks.length;
  await town.ask('mayor','How is the notice going?','test');
  assert.equal(store.state.tasks.length,taskCount);
  assert.equal(store.state.tasks[0].status,'waiting');
  assert.equal(savedContext(store.state.tasks[0]),before,'the saved context is unchanged');
  assert.equal(store.state.approvals.filter(a=>a.status==='pending').length,1,'the pending decision stays open');
  const [question,answer]=asides(store);
  assert.deepEqual([question.from,question.to,question.aside,question.task],['owner','mayor',true,undefined]);
  assert.deepEqual([answer.from,answer.to,answer.aside],['mayor','owner',true]);
  assert.equal(answer.text,'The plan is waiting for your go-ahead.');
});

test('an aside never reaches a running task or a later task’s history', async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const seen:any[][]=[];
  const {store,town}=fixture({test:async(messages,tools)=>{
    if(!tools.length)return reply('Still on the harbour plan.');
    seen.push(messages);
    if(seen.length===1)await gate;
    return reply('Harbour plan drafted.');
  }});
  town.submit('mayor','Plan the harbour festival','test');
  await until(()=>seen.length===1);
  await town.ask('mayor','Where is the harbour festival at now?','test');
  assert.equal(store.state.tasks.length,1);
  assert.equal(store.state.tasks[0].status,'running');
  release();
  await until(()=>store.state.tasks[0].status==='done');
  town.submit('mayor','Write the harbour notice','test');
  await until(()=>seen.length===2);
  assert.ok(!JSON.stringify(seen).includes('Where is the harbour festival'),'no work call sees the question');
  assert.ok(!JSON.stringify(seen).includes('Still on the harbour plan'),'no work call sees the answer');
});

test('the context carries the goal progress and the project list', async()=>{
  const prompts:string[]=[];
  const {store,town}=fixture({test:async(messages,tools)=>{
    if(!tools.length){prompts.push(String(messages[0].content));return reply('Round one is in.');}
    return reply('Lantern parade round summary.');
  }});
  town.submit('mayor','Plan the harbour festival','test');
  await until(()=>store.state.tasks[0]?.status==='done');
  town.submit('mayor','Run the lantern parade','test',{goal:true});
  await until(()=>(store.state.goals[0] as Goal|undefined)?.log.length===1);
  await town.ask('mayor','How is the parade?','test');
  const [prompt]=prompts;
  assert.match(prompt,/Ongoing goals:\n- "Run the lantern parade" \(active\)/);
  assert.match(prompt,/Round 1: Lantern parade round summary/);
  assert.match(prompt,/"Plan the harbour festival": done, 1 of 1 tasks done/);
  town.dispose();
});

test('one aside is in flight per cat, and other cats are not held up', async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const {store,town}=fixture({test:async(messages,tools)=>{if(tools.length)return reply('unused');await gate;return reply('Answer.');}});
  const other=store.state.cats.find(c=>c.id!=='mayor')!.id;
  const first=town.ask('mayor','one','test');
  await assert.rejects(town.ask('mayor','two','test'),/still answering/);
  const second=town.ask(other,'three','test');
  release();
  await Promise.all([first,second]);
  assert.equal(await town.ask('mayor','four','test'),'Answer.','the lock is released once the answer lands');
});

test('a failed aside is posted as the cat’s answer and releases the cat', async()=>{
  let calls=0;
  const {store,town}=fixture({test:async()=>{calls++;if(calls===1)throw new Error('Model request failed (503).');return reply('Back again.');}});
  assert.equal(await town.ask('mayor','status?','test'),'I could not answer just now: Model request failed (503).');
  assert.equal(await town.ask('mayor','status again?','test'),'Back again.');
  assert.equal(asides(store).length,4);
});

test('a refused aside posts nothing', async()=>{
  const {store,town}=fixture({test:async()=>reply('never')});
  await assert.rejects(town.ask('mayor','   ','test'),/message limit/);
  await assert.rejects(town.ask('mayor','status?','local'),/not configured/);
  await assert.rejects(town.ask('nobody','status?','test'),/Unknown cat/);
  assert.equal(asides(store).length,0);
});

test('demo mode answers from the context with a fixed template and no model call', async()=>{
  const {store,town}=fixture();
  const answer=await town.ask('mayor','How is it going?','demo');
  assert.equal(answer,'[Demonstration] Mayor has 0 live tasks, 0 waiting. No goal is running. Nothing was started or changed by this question.');
  assert.equal(store.state.tasks.length,0);
  assert.equal(asides(store).length,2);
});

test('the route answers owners and refuses proxied requests with 403', async()=>{
  const {town}=fixture();
  const app=Fastify();
  installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  registerAskRoute(app,{town:()=>town});
  const body={cat:'mayor',text:'How is it going?',mode:'demo'};
  const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  const ok=await app.inject({method:'POST',url:'/api/ask',headers:owner,payload:body});
  assert.equal(ok.statusCode,200);
  assert.match(ok.json().reply,/^\[Demonstration\]/);
  const proxied=await app.inject({method:'POST',url:'/api/ask',headers:{...owner,'x-forwarded-for':'203.0.113.9'},payload:body});
  assert.equal(proxied.statusCode,403);
  await app.close();
});

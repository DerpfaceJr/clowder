import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const config=(slots:number)=>({...base,maxParallelWork:slots,goals:{roundPauseSeconds:0.02,maxRoundsPerDay:null,tokenBudget:null}});
const fixture=(slots:number,provider:Provider)=>{
  const cfg=config(slots),store=new Store(join(mkdtempSync(join(tmpdir(),'parallel-')),'events.jsonl'),allRoles(cfg));
  return {store,town:new Town(store,cfg,{test:provider})};
};
const until = untilEvery(5);
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
const gate=()=>{let open!:()=>void;const wait=new Promise<void>(r=>open=r);return {wait,open};};
const last=(messages:any[])=>String(messages.at(-1)?.content??'');
const worker=allRoles(config(1)).find(c=>c.id!=='mayor')!.id;

test('two goals run their rounds side by side, and a Mayor message runs beside them', async () => {
  const hold=gate(),started:string[]=[];
  const provider:Provider=async messages=>{const q=last(messages);started.push(q);await hold.wait;return reply('ok');};
  const {store,town}=fixture(3,provider);
  town.submit('mayor','Grow the shop','test',{goal:true});
  town.submit('mayor','Write the newsletter','test',{goal:true});
  const chat=town.submit('mayor','Change the workers to haiku','test');
  await until(()=>started.length===3);
  assert.equal(store.state.tasks.find(t=>t.id===chat)?.status,'running','the message is not queued behind the goals');
  assert.equal(store.state.tasks.filter(t=>!t.parent&&t.status==='running').length,3);
  assert.ok(town.isBusy(),'world switches and resets still see the town as busy');
  hold.open();
  for(const g of store.state.goals)town.goalAction('owner',g.id,'stop');
});

test('past the parallel limit the Mayor queues and other cats refuse', async () => {
  const hold=gate();
  const provider:Provider=async()=>{await hold.wait;return reply('ok');};
  const {store,town}=fixture(2,provider);
  town.submit('mayor','first','test');
  town.submit('mayor','second','test');
  const third=town.submit('mayor','third','test');
  assert.equal(store.state.tasks.find(t=>t.id===third)?.status,'queued');
  assert.throws(()=>town.submit(worker,'hello','test'),/Finish the current task/);
  hold.open();
  await until(()=>store.state.tasks.find(t=>t.id===third)?.status==='done');
});

test('a cat already working takes no second owner message, and parallel threads never share a worker', async () => {
  const hold=gate();let refusal='';
  const provider:Provider=async messages=>{
    const q=last(messages);
    if(q==='work slowly')return (await hold.wait,reply('done slowly'));
    if(q==='use the worker')return call('delegate',{cat:worker,task:'help'});
    const tool=messages.at(-1);if(tool?.role==='tool'){refusal=String(tool.content);return reply('picked another way');}
    return reply('ok');
  };
  const {store,town}=fixture(3,provider);
  town.submit(worker,'work slowly','test');
  assert.throws(()=>town.submit(worker,'and this too','test'),/already working/);
  const mayor=town.submit('mayor','use the worker','test');
  await until(()=>store.state.tasks.find(t=>t.id===mayor)?.status==='done');
  assert.match(refusal,/busy with other work/);
  hold.open();
});

test('a thread does not see another in-flight thread as history; the Mayor gets one line about it instead', async () => {
  const hold=gate();let seen:any[]=[];
  const provider:Provider=async messages=>{
    const q=last(messages);
    if(q.startsWith('This is round'))return call('delegate',{cat:worker,task:'Draft the secret launch plan'});
    if(q==='Draft the secret launch plan'){await hold.wait;return reply('plan');}
    if(q==='How are the cats?'){seen=messages;return reply('fine');}
    return reply('ok');
  };
  const {store,town}=fixture(3,provider);
  town.submit('mayor','Plan the launch','test',{goal:true});
  await until(()=>store.state.tasks.some(t=>t.cat===worker&&t.status==='running'));
  const chat=town.submit('mayor','How are the cats?','test');
  await until(()=>store.state.tasks.find(t=>t.id===chat)?.status==='done');
  const history=seen.slice(1).map(m=>String(m.content)).join('\n');
  assert.doesNotMatch(history,/secret launch plan/,'the round still in flight is not mixed into this thread');
  assert.match(String(seen[0].content),/Also in progress now, in other threads \(.*\): goal round “Goal round 1: Plan the launch” \(mayor waiting_child, \w+ running\)/);
  hold.open();
  town.goalAction('owner',store.state.goals[0].id,'stop');
});

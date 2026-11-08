import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {allRoles} from '../src/roles.ts';
import {Store,type Task} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {projects} from '../src/projects.ts';
import type {Provider} from '../src/provider.ts';

const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
// Short pauses keep goal rounds fast; the real default is config.goals.roundPauseSeconds.
// One thing at a time: these tests cover the inbox when the town is full. Parallel work is in parallel-work.test.ts.
const fast={...base,maxParallelWork:1,goals:{roundPauseSeconds:0.02,maxRoundsPerDay:24,tokenBudget:null}};
const fixture=(providers:Record<string,Provider>,file=join(mkdtempSync(join(tmpdir(),'inbox-')),'events.jsonl'))=>{
  const store=new Store(file,allRoles(fast));
  const town=new Town(store,fast,providers);
  return {file,store,town};
};
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Timed out waiting for state transition');}
const pause=(ms=25)=>new Promise(r=>setTimeout(r,ms));
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+name+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
// A gate the test opens by hand, so the Mayor stays busy for exactly as long as the test needs.
const gate=()=>{let open!:()=>void;const wait=new Promise<void>(r=>open=r);return {wait,open};};
// What the Mayor was asked: the last user message, or the goal round number when the prompt is a round.
const asked=(messages:any[])=>{const last=String(messages.at(-1)?.content??'');const round=/This is round (\d+) of/.exec(last);return round?`round ${round[1]}`:last;};
const byText=(store:{state:{tasks:Task[]}},text:string)=>store.state.tasks.find(t=>t.text===text)!;

test('a message sent while the Mayor is busy waits in the inbox and is not run beside the current task', async () => {
  const hold=gate(),seen:string[]=[];
  const provider:Provider=async messages=>{const q=asked(messages);seen.push(q);if(q==='first')await hold.wait;return reply(`done ${q}`);};
  const {store,town}=fixture({test:provider});
  const first=town.submit('mayor','first','test');
  const second=town.submit('mayor','second','test');
  assert.equal(store.state.tasks.find(t=>t.id===second)?.status,'queued');
  assert.equal(store.state.tasks.filter(t=>t.status==='running').length,1,'only the current task runs');
  assert.ok(store.state.messages.some(m=>m.task===second&&m.text==='second'),'the queued message shows in chat at once');
  await pause();
  assert.deepEqual(seen,['first'],'the queued message never reaches the model while the Mayor is busy');
  // The queued message must not leak into the current task's history before its own pickup.
  const ctx=JSON.stringify(town.context(store.state.tasks.find(t=>t.id===first)!,0).messages);
  assert.ok(!ctx.includes('Earlier owner to mayor: second'),'queued text is not history');
  // Queued work is not shown as a project yet, and sorts above the rest.
  assert.equal(projects(store.state)[0].status,'queued');
  hold.open();
  await until(()=>store.state.tasks.find(t=>t.id===second)?.status==='done');
  assert.deepEqual(seen,['first','second']);
});

test('queued messages are picked up oldest first', async () => {
  const hold=gate(),seen:string[]=[];
  const provider:Provider=async messages=>{const q=asked(messages);seen.push(q);if(q==='first')await hold.wait;return reply(`done ${q}`);};
  const {store,town}=fixture({test:provider});
  town.submit('mayor','first','test');
  for(const text of ['A','B','C'])town.submit('mayor',text,'test');
  hold.open();
  await until(()=>byText(store,'C')?.status==='done');
  assert.deepEqual(seen,['first','A','B','C']);
});

test('the inbox comes before the next goal round', async () => {
  const hold=gate(),seen:string[]=[];
  const provider:Provider=async messages=>{const q=asked(messages);seen.push(q);if(q==='round 1')await hold.wait;return reply(`done ${q}`);};
  const {store,town}=fixture({test:provider});
  town.submit('mayor','Write the report','test',{goal:true});
  town.submit('mayor','Also check the budget','test');
  hold.open();
  const goal=store.state.goals[0];
  await until(()=>seen.includes('round 2'));
  assert.deepEqual(seen.slice(0,3),['round 1','Also check the budget','round 2'],'the queued message runs between rounds');
  town.goalAction('owner',goal.id,'stop');
});

test('a goal queued while the Mayor is busy starts when the Mayor is free', async () => {
  const hold=gate(),seen:string[]=[];
  const provider:Provider=async messages=>{const q=asked(messages);seen.push(q);if(q==='first')await hold.wait;return reply(`done ${q}`);};
  const {store,town}=fixture({test:provider});
  town.submit('mayor','first','test');
  const queued=town.submit('mayor','Plan the festival','test',{goal:true});
  assert.equal(store.state.tasks.find(t=>t.id===queued)?.inbox?.goal,true);
  assert.equal(store.state.goals.length,0,'no goal yet');
  hold.open();
  await until(()=>store.state.goals.length===1);
  await until(()=>seen.includes('round 1'));
  town.goalAction('owner',store.state.goals[0].id,'stop');
});

test('cancel removes a queued message; only the owner can cancel, and only a waiting message', async () => {
  const hold=gate(),seen:string[]=[];
  const provider:Provider=async messages=>{const q=asked(messages);seen.push(q);if(q==='first')await hold.wait;return reply(`done ${q}`);};
  const {store,town}=fixture({test:provider});
  const first=town.submit('mayor','first','test');
  const a=town.submit('mayor','A','test');
  const b=town.submit('mayor','B','test');
  assert.throws(()=>town.cancelQueued('mayor',a),/Only the owner/);
  assert.throws(()=>town.cancelQueued('owner',first),/still waiting/);
  town.cancelQueued('owner',a);
  assert.equal(store.state.tasks.find(t=>t.id===a)?.status,'cancelled');
  hold.open();
  await until(()=>store.state.tasks.find(t=>t.id===b)?.status==='done');
  await pause();
  assert.deepEqual(seen,['first','B'],'the cancelled message never runs');
  assert.throws(()=>town.cancelQueued('owner',a),/still waiting/);
});

test('the queue survives a restart: the replayed inbox keeps its order and is picked up', async () => {
  const hold=gate(),seen:string[]=[];
  const hanging:Provider=async messages=>{const q=asked(messages);seen.push(q);await hold.wait;return reply('never');};
  const {file,town}=fixture({test:hanging});
  town.submit('mayor','first','test');
  town.submit('mayor','A','test');
  town.submit('mayor','B','test');
  town.dispose();
  // A fresh process replays the journal. The running task resumes from its saved first turn (item 5.7); the queued ones are still waiting.
  const replayed=new Store(file,allRoles(fast));
  assert.deepEqual(replayed.state.tasks.filter(t=>t.status==='queued').map(t=>t.text),['A','B']);
  assert.equal(replayed.state.tasks.find(t=>t.text==='first')?.status,'running');
  const after:string[]=[];
  const provider:Provider=async messages=>{after.push(asked(messages));return reply(`done ${asked(messages)}`);};
  const restarted=new Town(replayed,fast,{test:provider});
  await until(()=>byText(replayed,'B')?.status==='done');
  assert.deepEqual(after,['first','A','B'],'the resumed task holds the one slot, then the replayed queue is picked up in order');
  assert.equal(byText(replayed,'first').status,'done');assert.equal(byText(replayed,'first').resumed?.turn,0);
  restarted.dispose();
});

test('asks are answered at once and are never queued', async () => {
  const hold=gate();
  const provider:Provider=async messages=>{const q=asked(messages);if(q==='first')await hold.wait;return reply(`answer to ${q}`);};
  const {store,town}=fixture({test:provider});
  town.submit('mayor','first','test');
  const answer=await town.ask('mayor','how is it going?','test');
  assert.equal(answer,'answer to how is it going?');
  assert.equal(store.state.tasks.filter(t=>t.status==='queued').length,0);
  hold.open();
});

test('other cats still refuse work while the town is busy, and nothing is queued for them', async () => {
  const hold=gate();
  const provider:Provider=async messages=>{if(asked(messages)==='first')await hold.wait;return reply('ok');};
  const {store,town}=fixture({test:provider});
  town.submit('mayor','first','test');
  const other=allRoles(fast).find(c=>c.id!=='mayor')!.id;
  assert.throws(()=>town.submit(other,'hello','test'),/Finish the current task/);
  assert.equal(store.state.tasks.filter(t=>t.status==='queued').length,0);
  hold.open();
});

test('the Mayor prompt is delegate-first, and other cats do not get it', () => {
  const {town}=fixture({});
  const mayorTask={id:'t1',cat:'mayor',from:'owner',text:'x',mode:'test',status:'running'} as Task;
  const catTask={...mayorTask,id:'t2',cat:allRoles(fast).find(c=>c.id!=='mayor')!.id};
  const mayorPrompt=String(town.context(mayorTask,0).messages[0].content);
  assert.match(mayorPrompt,/decision maker/);
  assert.match(mayorPrompt,/delegate execution to the right cats/);
  assert.match(mayorPrompt,/Do not do long execution work yourself/);
  assert.doesNotMatch(String(town.context(catTask,0).messages[0].content),/decision maker/);
});

test('the Mayor cannot make more than three files, images or videos itself in one task', async () => {
  const seen:string[]=[];
  const provider:Provider=async messages=>{
    const results=messages.filter(m=>m.role==='tool').map(m=>String(m.content));
    if(results.length<4)return call('generate_image',{prompt:'a cat',title:`Cat ${results.length}`});
    seen.push(...results);
    return reply('done');
  };
  const {store,town}=fixture({test:provider});
  const id=town.submit('mayor','draw cats','test');
  await until(()=>store.state.tasks.find(t=>t.id===id)?.status==='done');
  assert.equal(seen.filter(r=>r.startsWith('Tool error: The Mayor hands file')).length,1,'the fourth own-work call is refused');
});

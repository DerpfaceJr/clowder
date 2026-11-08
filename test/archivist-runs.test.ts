import {allRoles} from '../src/roles.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type Goal} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {type Provider} from '../src/provider.ts';

const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const fast={...base,goals:{roundPauseSeconds:0.02,maxRoundsPerDay:24,tokenBudget:null}};
const fixture=(providers:Record<string,Provider>)=>{
  const file=join(mkdtempSync(join(tmpdir(),'archivist-')),'events.jsonl');
  const store=new Store(file,allRoles(fast));
  const town=new Town(store,fast,providers);town.autonomy=()=>'balanced';
  return {store,town};
};
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for state transition');}
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+name+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
const roundOf=(messages:any[])=>{const found=[...messages.map(m=>String(m.content??'')).join('\n').matchAll(/This is round (\d+)/g)];return found.length?Number(found.at(-1)![1]):0;};
// Long enough to be filed (record() skips results under 40 characters).
const LONG='The owner’s report draft is finished and filed in the town chat for review.';
const textOf=(messages:any[])=>messages.map(m=>String(m.content??'')).join('\n');
// Every Mayor round answers in text, so a round with no tool call changes nothing.
const recorded=(store:Store)=>store.state.tasks.filter(t=>t.record);

test('a five-round goal records at most once per round', async()=>{
  // Each round hires a scout (a change), and the fifth completes the goal.
  const {store,town}=fixture({test:async messages=>{
    if(!/This is round \d+/.test(textOf(messages)))return reply(LONG);
    const round=roundOf(messages);
    if(messages.at(-1)?.role==='tool')return reply(LONG);
    return round<5?call('create_cat',{name:`Scout ${round}`,role:'Scout'}):call('complete_goal',{summary:'Finished in round 5.'});
  }});
  town.submit('mayor','Write the quarterly report','test',{goal:true});
  await until(()=>store.state.goals[0]?.status==='achieved');
  await new Promise(r=>setTimeout(r,150));
  const goal=store.state.goals[0] as Goal;
  assert.equal(goal.rounds,5);
  assert.ok(recorded(store).length<=5,`recorder ran ${recorded(store).length} times for 5 rounds`);
});

test('a goal round that changes nothing does not run the recorder', async()=>{
  // Rounds 1-3 only reply in text; round 4 completes the goal, so only round 4 can be filed.
  const {store,town}=fixture({test:async messages=>{
    if(!/This is round \d+/.test(textOf(messages)))return reply(LONG);
    const round=roundOf(messages);
    if(round<4)return reply(LONG);
    if(messages.at(-1)?.role==='tool')return reply(LONG);
    return call('complete_goal',{summary:'Finished in round 4.'});
  }});
  town.submit('mayor','Write the quarterly report','test',{goal:true});
  await until(()=>store.state.goals[0]?.status==='achieved');
  await new Promise(r=>setTimeout(r,150));
  const runs=recorded(store);
  assert.equal(runs.length,1,'only the round that changed something is filed');
  assert.match(String(runs[0].text),/Goal round 4/);
});

test('an owner request still runs the recorder even with a text-only answer', async()=>{
  const {store,town}=fixture({test:async()=>reply(LONG)});
  town.submit('mayor','Summarise what we learned this week','test');
  await until(()=>recorded(store).length>0&&recorded(store).every(t=>t.status==='done'));
  assert.equal(recorded(store).length,1);
});

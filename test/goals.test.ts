import {allRoles} from '../src/roles.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {goalReviewBrief,goalSettings,registerGoalRoutes,retirementCandidates} from '../src/goals.ts';
import {Store,type Goal} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {demoProvider,mayorTools,toolDefinitions,type Provider} from '../src/provider.ts';
import {quests} from '../src/quests.ts';
import {projects} from '../src/projects.ts';
import {offeredTools,type AutonomyLevel} from '../src/autonomy.ts';
import {untilEvery} from './helpers/until.ts';

const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
// Short pauses keep the tests fast; the real default is config.goals.roundPauseSeconds.
const fast={...base,goals:{roundPauseSeconds:0.02,maxRoundsPerDay:24,tokenBudget:null}};
const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
const fixture=(config:any=fast,autonomy:AutonomyLevel='balanced',providers:Record<string,Provider>={})=>{
  const file=join(mkdtempSync(join(tmpdir(),'goals-')),'events.jsonl');
  const store=new Store(file,allRoles(config));
  const town=new Town(store,config,providers);town.autonomy=()=>autonomy;
  return {file,store,town,config};
};
const until = untilEvery(10);
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+name+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
// The round number is in the round prompt, the last "This is round N" in the conversation.
const roundOf=(messages:any[])=>{const found=[...messages.map(m=>String(m.content??'')).join('\n').matchAll(/This is round (\d+)/g)];return found.length?Number(found.at(-1)![1]):0;};
// A Mayor that asks the owner in `askInRound` (once), and completes the goal from `finishAt` on. Other rounds just report.
const scripted=(finishAt:number,askInRound=0):Provider=>async messages=>{
  const round=roundOf(messages);
  const tools=messages.filter(m=>m.role==='tool').map(m=>String(m.content));
  if(round===askInRound&&!tools.some(t=>t.includes('"decision"')))return call('request_approval',{question:'Continue this round?',options:['Yes','No']});
  if(round>=finishAt&&!tools.some(t=>t.startsWith('Goal achieved')))return call('complete_goal',{summary:`Finished in round ${round}.`});
  return reply(`Round ${round} summary.`);
};
const goalOf=(store:Store)=>store.state.goals[0] as Goal;
const roundTasks=(store:Store,goalId:string)=>store.state.tasks.filter(t=>!t.parent&&t.goal===goalId);

test('a goal runs several rounds and ends when the Mayor calls complete_goal', async()=>{
  const {store,town}=fixture(fast,'balanced',{test:scripted(3)});
  town.submit('mayor','Write the quarterly report','test',{goal:true});
  await until(()=>goalOf(store)?.status==='achieved');
  const goal=goalOf(store);
  assert.equal(goal.rounds,3);
  assert.equal(goal.log.length,3);
  assert.equal(goal.log[0],'Round 1: Round 1 summary');
  assert.equal(goal.summary,'Finished in round 3.');
  assert.equal(goal.endedBy,'mayor');
  assert.equal(roundTasks(store,goal.id).length,3,'one Mayor task per round');
  assert.ok(store.state.events.some(e=>e.type==='diary.entry'&&e.data.goal===goal.id),'the diary records the goal');
  // Rounds are goal cards, not one-off projects.
  assert.equal(projects(store.state).length,0);
  const quest=quests({state:store.state,projects:[],capabilities:[],seasons:[],models:null,config:{recentHours:24},now:new Date()}).find(q=>q.source.kind==='goal');
  assert.equal(quest?.rank,'F');
  // Nothing runs after the goal ends.
  await new Promise(r=>setTimeout(r,80));
  assert.equal(goalOf(store).rounds,3);
});

test('a demonstration goal stops after one scripted round', async()=>{
  const {store,town}=fixture();
  town.submit('mayor','Make money online','demo',{goal:true});
  await until(()=>{
    const pending=store.state.approvals.find(a=>a.status==='pending');
    if(pending)town.decide(pending.id,pending.options?.[0]??'Yes',true);
    return goalOf(store)?.pausedBy==='demo';
  });
  await new Promise(r=>setTimeout(r,80));
  assert.equal(goalOf(store).rounds,1);
  assert.equal(goalOf(store).status,'paused');
});

test('a round that asks the owner pauses the goal, and the answer resumes it', async()=>{
  const {store,town}=fixture(fast,'balanced',{test:scripted(2,1)});
  town.submit('mayor','Draft the town notice','test',{goal:true});
  await until(()=>store.state.approvals.some(a=>a.status==='pending'));
  assert.equal(goalOf(store).status,'paused');
  assert.equal(goalOf(store).pausedBy,'approval');
  await new Promise(r=>setTimeout(r,80));
  assert.equal(goalOf(store).rounds,1,'no round starts while the owner is asked');
  town.decide(store.state.approvals.find(a=>a.status==='pending')!.id,'Yes',true);
  await until(()=>goalOf(store).status==='achieved');
  assert.equal(goalOf(store).rounds,2);
});

test('the daily round budget pauses the goal with a note and a quest', async()=>{
  const {store,town}=fixture({...fast,goals:{...fast.goals,maxRoundsPerDay:2}},'balanced',{test:async()=>reply('Still working.')});
  town.submit('mayor','Keep a daily digest','test',{goal:true});
  await until(()=>goalOf(store)?.pausedBy==='budget');
  const goal=goalOf(store);
  assert.equal(goal.status,'paused');
  assert.equal(goal.rounds,2);
  assert.match(goal.note??'',/Daily round budget reached: 2 rounds today/);
  const q=quests({state:store.state,projects:[],capabilities:[],seasons:[],models:null,now:new Date()}).find(x=>x.source.kind==='goal');
  assert.equal(q?.rank,'B');
  // The owner raises the budget and resumes; the goal then runs again.
  town.setGoalBudget('owner',goal.id,{maxRoundsPerDay:5});
  town.goalAction('owner',goal.id,'resume');
  await until(()=>goalOf(store).rounds===3);
  town.goalAction('owner',goal.id,'stop');
  assert.equal(goalOf(store).status,'stopped');
});

test('two failed rounds in a row pause the goal and raise an A-rank quest', async()=>{
  const {store,town}=fixture(fast,'balanced',{test:async()=>{throw new Error('model unreachable');}});
  town.submit('mayor','Summarise the notes','test',{goal:true});
  await until(()=>goalOf(store)?.pausedBy==='failures');
  const goal=goalOf(store);
  assert.equal(goal.rounds,2);
  assert.equal(goal.failures,2);
  assert.match(goal.log[1],/^Round 2: Failed: model unreachable/);
  const q=quests({state:store.state,projects:[],capabilities:[],seasons:[],models:null,now:new Date()}).find(x=>x.source.kind==='goal');
  assert.equal(q?.rank,'A');
  assert.equal(q?.id,`goal:${goal.id}`);
});

test('cautious autonomy asks before round 2, and declining pauses the goal', async()=>{
  const {store,town}=fixture(fast,'cautious',{test:scripted(9)});
  town.submit('mayor','Plan the spring fair','test',{goal:true});
  await until(()=>store.state.approvals.some(a=>a.status==='pending'&&a.gate==='goal'));
  assert.equal(goalOf(store).rounds,2,'the gate names round 2');
  assert.equal(roundTasks(store,goalOf(store).id).length,2);
  town.decide(store.state.approvals.find(a=>a.status==='pending')!.id,'Decline',false);
  assert.equal(goalOf(store).pausedBy,'owner');
  await new Promise(r=>setTimeout(r,80));
  assert.equal(goalOf(store).rounds,2,'declined round does not run');
  town.goalAction('owner',goalOf(store).id,'stop');
});

test('cautious autonomy approves round 2 and the goal continues', async()=>{
  const {store,town}=fixture(fast,'cautious',{test:scripted(2)});
  town.submit('mayor','Plan the spring fair','test',{goal:true});
  await until(()=>store.state.approvals.some(a=>a.status==='pending'&&a.gate==='goal'));
  town.decide(store.state.approvals.find(a=>a.status==='pending')!.id,'Start round',true);
  await until(()=>goalOf(store).status==='achieved');
  assert.equal(goalOf(store).rounds,2);
});

test('a restart resumes an active goal once, with no duplicate rounds', async()=>{
  const slow={...fast,goals:{...fast.goals,roundPauseSeconds:0.3}};
  const provider=scripted(4);
  const {file,store,town}=fixture(slow,'balanced',{test:provider});
  town.submit('mayor','Tend the garden','test',{goal:true});
  await until(()=>goalOf(store)?.rounds===1&&!store.state.tasks.some(t=>t.status==='running'));
  // The server stops: the old town's timers stop with it, and a new town reads the same journal.
  town.dispose();
  const reopened=new Store(file,[]);
  new Town(reopened,slow,{test:provider});
  await until(()=>reopened.state.goals[0].status==='achieved');
  const goal=reopened.state.goals[0];
  assert.equal(goal.rounds,4);
  assert.deepEqual(goal.log.map(l=>l.split(':')[0]),['Round 1','Round 2','Round 3','Round 4']);
  assert.equal(roundTasks(reopened,goal.id).length,4,'each round ran once');
  // The old town's store applies its own events only, so one round means it started nothing after dispose.
  assert.equal(store.state.tasks.filter(t=>t.goal===goal.id).length,1,'the disposed town started no round after dispose');
});

test('a round that changes nothing while an owner step is open puts the goal to sleep; a restart keeps it asleep, and an owner message or step wakes it', async()=>{
  // Round 1 files a step (an action); later rounds only read, until round 4 finishes the goal.
  const sleepy:Provider=async messages=>{
    const round=roundOf(messages);
    const tools=messages.filter(m=>m.role==='tool').map(m=>String(m.content));
    if(round===1&&!tools.some(t=>t.startsWith('Filed owner step')))return call('request_owner_step',{kind:'account',title:'Sign in to Instagram',steps:'Sign in once in the cats’ browser.',blocking_remaining:false});
    if(round>=4&&!tools.some(t=>t.startsWith('Goal achieved')))return call('complete_goal',{summary:'Done.'});
    if(round>=2&&!tools.length)return call('lookup',{query:'instagram'});
    return reply(round?`Round ${round}: waiting on you.`:'Noted.');
  };
  const {file,store,town}=fixture(fast,'balanced',{test:sleepy});
  town.submit('mayor','Grow the account','test',{goal:true});
  await until(()=>goalOf(store)?.asleep===true);
  assert.equal(goalOf(store).rounds,2,'round 1 filed a step and went on; round 2 changed nothing');
  assert.equal(goalOf(store).pausedBy,'owner-step');
  assert.equal(goalOf(store).note,'Asleep until you act: Sign in to Instagram');
  town.dispose();
  const reopened=new Store(file,[]);
  const again=new Town(reopened,fast,{test:sleepy});
  await new Promise(r=>setTimeout(r,120));
  assert.equal(reopened.state.goals[0].rounds,2,'a restart does not wake a sleeping goal');
  again.submit('mayor','How is it going?','test');
  await until(()=>reopened.state.goals[0].rounds===3&&reopened.state.goals[0].asleep===true);
  assert.equal(reopened.state.goals[0].status,'paused','the owner’s message woke it for one round, and it fell back asleep');
  const step=reopened.state.ownerSteps.find(s=>s.status==='open')!;
  again.ownerStepDone('owner',step.id,'');
  await until(()=>reopened.state.goals[0].status==='achieved');
  assert.equal(reopened.state.goals[0].rounds,4);
  assert.equal(reopened.state.goals[0].asleep,false);
});

test('a held goal still waits for all its steps; only a sleeping one wakes on the first', async()=>{
  const {store,town}=fixture(fast,'balanced',{test:async()=>reply('Noted.')});
  const goal=(town as any).createGoal('test','Ship it','Ship it');
  for(const title of ['One','Two'])store.emit('owner.step',{id:title,goal:goal.id,cat:'mayor',title,steps:'Do it.',blocking:true,kind:'account'});
  (town as any).markPaused(goal.id,'owner-step','Waiting on you: One');
  town.ownerStepDone('owner','One','');
  assert.equal(goalOf(store).status,'paused','one of two steps done: a held goal keeps waiting');
  (town as any).markPaused(goal.id,'owner-step','Asleep until you act: Two',true);
  store.emit('owner.step',{id:'Three',goal:goal.id,cat:'mayor',title:'Three',steps:'Do it.',blocking:false,kind:'account'});
  town.ownerStepDone('owner','Two','');
  assert.equal(goalOf(store).status,'active','a sleeping goal wakes on the first step done, with another still open');
  town.dispose();
});

test('town pause stops a goal, and resuming the town resumes it', async()=>{
  const {store,town}=fixture({...fast,goals:{...fast.goals,roundPauseSeconds:0.3}},'balanced',{test:scripted(3)});
  town.submit('mayor','Clean the square','test',{goal:true});
  await until(()=>goalOf(store)?.rounds===1&&!store.state.tasks.some(t=>t.status==='running'));
  town.pause(true);
  assert.equal(goalOf(store).status,'paused');
  assert.equal(goalOf(store).pausedBy,'town');
  town.pause(false);
  assert.equal(goalOf(store).status,'active');
  await until(()=>goalOf(store).status==='achieved');
});

test('the Mayor starts a goal with set_goal during ordinary work', async()=>{
  const finish=scripted(1);
  const {store,town}=fixture(fast,'balanced',{test:async messages=>{
    if(roundOf(messages)===0){
      const tools=messages.filter(m=>m.role==='tool');
      return tools.length?reply('Goal started.'):call('set_goal',{title:'Build the harbour',success:'The harbour has a working pier.'});
    }
    return finish(messages,[],new AbortController().signal);
  }});
  town.submit('mayor','Please build a harbour over the next few weeks','test');
  await until(()=>goalOf(store)?.status==='achieved');
  assert.equal(goalOf(store).title,'Build the harbour');
  assert.equal(goalOf(store).success,'The harbour has a working pier.');
});

test('goal tools are offered to the Mayor only', () => {
  const names=(tools:any[])=>tools.map(t=>t.function.name);
  for(const tool of ['set_goal','complete_goal','stop_goal']){
    assert.ok(names(mayorTools('test')).includes(tool),`${tool} for the Mayor`);
    assert.ok(!names(toolDefinitions).includes(tool),`${tool} not for other cats`);
  }
});

test('goal routes are owner-only and return 403 to everyone else', async () => {
  const {store,town}=fixture();
  const app=Fastify();
  installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  registerGoalRoutes(app,{town:()=>town});
  const body={action:'pause'};
  assert.equal((await app.inject({url:'/api/goals',headers:owner})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/goals/x/action',headers:{...owner,'x-forwarded-for':'127.0.0.1'},payload:body})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/goals/x/budget',headers:{...owner,'x-forwarded-for':'127.0.0.1'},payload:{maxRoundsPerDay:3}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/goals/x/action',remoteAddress:'192.168.1.21',headers:{host:'192.168.1.21:8787','x-town-action':'owner'},payload:body})).statusCode,403);
  assert.equal(store.state.goals.length,0);
});

test('owner budget edits are validated and a token budget can be cleared', () => {
  const {store,town}=fixture();
  const id=town.submit('mayor','Note the budgets','demo',{goal:true});
  const goal=store.state.goals[0];
  assert.ok(id);
  assert.throws(()=>town.setGoalBudget('mayor',goal.id,{maxRoundsPerDay:3}),/Only the owner/);
  assert.throws(()=>town.setGoalBudget('owner',goal.id,{maxRoundsPerDay:0}),/whole number/);
  town.setGoalBudget('owner',goal.id,{tokenBudget:5000});
  assert.equal(store.state.goals[0].tokenBudget,5000);
  town.setGoalBudget('owner',goal.id,{tokenBudget:null});
  assert.equal(store.state.goals[0].tokenBudget,null);
  town.dispose();
});

test('the shipped config carries the goal defaults', () => {
  assert.equal(base.goals.roundPauseSeconds,60);
  assert.equal(base.goals.maxRoundsPerDay,null,'ongoing goals have no daily round cap by default');
  assert.equal(goalSettings({}).maxRoundsPerDay,null,'a missing setting is no cap too');
  assert.equal(base.goals.tokenBudget,null);
});

// Removal suggestions. A plain Mayor task titled "Review all town goals" sends the suggestion the test sets, then reports.
let suggestion:Record<string,unknown>|null=null;
const reviewing=(inner:Provider):Provider=>async(messages,tools,signal,ai)=>{
  if([...messages].reverse().find(m=>m.role==='user')?.content==='Review all town goals'){
    const answered=messages.some(m=>m.role==='tool');
    return !answered&&suggestion?call('suggest_goal_removal',suggestion):reply('Reviewed the goals.');
  }
  return inner(messages,tools,signal,ai);
};
const toolResults=(store:Store,name:string)=>store.state.events.filter(e=>e.type==='tool.finished'&&e.data.name===name).map(e=>String(e.data.result));
const removals=(store:Store)=>store.state.approvals.filter(a=>a.gate==='goal-removal');
const questsNow=(store:Store)=>quests({state:store.state,projects:[],capabilities:[],seasons:[],models:null,config:{recentHours:24},now:new Date()});

test('a Mayor suggestion waits for the owner; Remove archives the goal everywhere, and the journal keeps it', async () => {
  suggestion=null;
  const {file,store,town}=fixture(fast,'balanced',{test:reviewing(scripted(1))});
  town.submit('mayor','Write the quarterly report','test',{goal:true});
  await until(()=>store.state.goals.length===1&&goalOf(store).status==='achieved');
  town.submit('mayor','Write the quarterly report again','test',{goal:true});
  await until(()=>store.state.goals.length===2&&store.state.goals[1].status==='achieved');
  const [older,newer]=store.state.goals;
  suggestion={goal:older.id,reason:'Same report, written twice.',duplicate_of:newer.id};
  town.submit('mayor','Review all town goals','test');
  await until(()=>removals(store).some(a=>a.status==='pending'));
  const ask=removals(store)[0];
  assert.equal(ask.question,`Remove goal ‘${older.title}’? Same report, written twice. Duplicate of ‘${newer.title}’.`);
  assert.deepEqual(ask.options,['Remove','Keep']);
  assert.equal(ask.goal,older.id);
  assert.equal(store.state.goals.length,2,'nothing is removed before the owner answers');
  assert.ok(questsNow(store).some(q=>q.source.id===ask.id&&q.rank==='C'),'the suggestion shows as a C-rank quest: it blocks nothing');
  assert.ok(questsNow(store).some(q=>q.id===`goal:${older.id}`),'the goal has a quest before removal');
  town.decide(ask.id,'Remove',true);
  assert.deepEqual(store.state.goals.map(g=>g.id),[newer.id]);
  assert.equal(store.state.approvals.find(a=>a.id===ask.id)?.status,'approved');
  const archived=store.state.events.find(e=>e.type==='goal.archived');
  assert.deepEqual([archived?.data.id,archived?.data.by],[older.id,'mayor']);
  assert.ok(readFileSync(file,'utf8').includes('"goal.archived"'),'the journal keeps the event');
  assert.ok(!questsNow(store).some(q=>q.source.id===older.id),'the archived goal leaves the quest log');
});

test('Keep leaves the goal, and the Mayor does not suggest it again', async () => {
  suggestion=null;
  const {store,town}=fixture(fast,'balanced',{test:reviewing(scripted(1))});
  town.submit('mayor','Tidy the notice board','test',{goal:true});
  await until(()=>goalOf(store)?.status==='achieved');
  suggestion={goal:goalOf(store).id,reason:'Finished in practice.'};
  town.submit('mayor','Review all town goals','test');
  await until(()=>removals(store).some(a=>a.status==='pending'));
  // The chat sends approved=true for any option that is not a refusal, so Keep arrives as an approval too.
  town.decide(removals(store)[0].id,'Keep',true);
  assert.equal(removals(store)[0].status,'rejected');
  assert.equal(store.state.goals.length,1);
  assert.ok(!store.state.events.some(e=>e.type==='goal.archived'));
  town.submit('mayor','Review all town goals','test');
  await until(()=>toolResults(store,'suggest_goal_removal').length===2);
  assert.equal(toolResults(store,'suggest_goal_removal')[1],'Tool error: The owner kept this goal. Do not suggest it again.');
  assert.equal(removals(store).length,1);
});

test('unknown ids, a repeat while one is pending, and the round’s own goal are refused with tool errors', async () => {
  suggestion=null;
  const {store,town}=fixture(fast,'balanced',{test:reviewing(scripted(1))});
  town.submit('mayor','Sort the seed packets','test',{goal:true});
  await until(()=>goalOf(store)?.status==='achieved');
  const goal=goalOf(store);
  suggestion={goal:'no-such-goal',reason:'Old.'};
  town.submit('mayor','Review all town goals','test');
  await until(()=>toolResults(store,'suggest_goal_removal').length===1);
  assert.equal(toolResults(store,'suggest_goal_removal')[0],'Tool error: Unknown goal id. Use an id from the goal list.');
  suggestion={goal:goal.id,reason:'Finished in practice.'};
  town.submit('mayor','Review all town goals','test');
  await until(()=>removals(store).some(a=>a.status==='pending'));
  town.submit('mayor','Review all town goals','test');
  await until(()=>toolResults(store,'suggest_goal_removal').length===3);
  assert.equal(toolResults(store,'suggest_goal_removal')[2],'Tool error: The owner already has a removal suggestion for this goal.');
  assert.equal(removals(store).length,1);
});

test('a goal round cannot suggest removing the goal it is working on', async () => {
  const {store,town}=fixture(fast,'balanced',{test:async messages=>{
    if(roundOf(messages)===1&&!messages.some(m=>m.role==='tool'))return call('suggest_goal_removal',{goal:goalOf(store).id,reason:'Circular.'});
    return reply('Round done.');
  }});
  town.submit('mayor','Count the sheep','test',{goal:true});
  await until(()=>toolResults(store,'suggest_goal_removal').length===1);
  assert.equal(toolResults(store,'suggest_goal_removal')[0],'Tool error: Do not suggest removing the goal this round is working on.');
  assert.equal(removals(store).length,0);
  town.goalAction('owner',goalOf(store).id,'stop');
});

test('the archive route is owner-only; an ended goal leaves the list and the quest log', async () => {
  suggestion=null;
  const {store,town}=fixture(fast,'balanced',{test:scripted(1)});
  town.submit('mayor','Mend the fence','test',{goal:true});
  await until(()=>goalOf(store)?.status==='achieved');
  const goal=goalOf(store);
  const app=Fastify();
  installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  registerGoalRoutes(app,{town:()=>town});
  const url=`/api/goals/${goal.id}/archive`;
  assert.equal((await app.inject({method:'POST',url,headers:{...owner,'x-forwarded-for':'127.0.0.1'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,remoteAddress:'192.168.1.21',headers:{host:'192.168.1.21:8787','x-town-action':'owner'}})).statusCode,403);
  assert.equal(store.state.goals.length,1,'a refused request removes nothing');
  assert.ok(questsNow(store).some(q=>q.id===`goal:${goal.id}`));
  assert.equal((await app.inject({method:'POST',url,headers:owner})).statusCode,200);
  assert.deepEqual(JSON.parse((await app.inject({url:'/api/goals',headers:owner})).body).goals,[]);
  assert.ok(!questsNow(store).some(q=>q.source.kind==='goal'));
  assert.throws(()=>town.archiveGoal('owner',goal.id,'again'),/Unknown goal/);
  await app.close();
});

test('an active goal is stopped before the Mayor’s approved removal, and the owner must stop it first', async () => {
  suggestion=null;
  const {store,town}=fixture(fast,'balanced',{test:reviewing(async()=>reply('Still working.'))});
  town.submit('mayor','Keep the lamp lit','test',{goal:true});
  await until(()=>goalOf(store)?.rounds>=1);
  const goal=goalOf(store);
  assert.throws(()=>town.archiveGoal('owner',goal.id,'x'),/Stop the goal before removing it/);
  suggestion={goal:goal.id,reason:'Stale.'};
  town.submit('mayor','Review all town goals','test');
  await until(()=>removals(store).some(a=>a.status==='pending'));
  town.decide(removals(store)[0].id,'Remove',true);
  assert.equal(store.state.goals.length,0);
  await new Promise(r=>setTimeout(r,80));
  const rounds=store.state.tasks.filter(t=>t.goal===goal.id).length;
  await new Promise(r=>setTimeout(r,80));
  assert.equal(store.state.tasks.filter(t=>t.goal===goal.id).length,rounds,'no round starts after removal');
  assert.ok(!store.state.tasks.some(t=>t.goal===goal.id&&['running','waiting','waiting_child'].includes(t.status)));
  town.dispose();
});

test('the Mayor sees at most 20 goals, and never an archived one', () => {
  const {store,town}=fixture();
  for(let i=0;i<22;i++)store.emit('goal.created',{id:`g${i}`,title:`Goal ${i}`,success:'x',status:'active',mode:'demo',rounds:0,roundsToday:0,day:'',failures:0,log:[],summary:null,maxRoundsPerDay:24,tokenBudget:null,pausedBy:null,note:null,endedBy:null});
  store.emit('goal.archived',{id:'g0',by:'owner',reason:'Removed by you.'});
  const brief=goalReviewBrief(store.state);
  assert.equal(brief.split('\n').filter(l=>l.startsWith('- g')).length,20);
  assert.match(brief,/- 1 more not listed/);
  assert.ok(!brief.includes('- g0 |'));
  assert.equal(goalReviewBrief({...store.state,goals:[]} as any),'');
  town.dispose();
});

test('a goal review lists cats that may be done, with their own task ids as evidence for review_cat', () => {
  const goal=(id:string,status:string)=>({id,title:id,status,createdAt:'2026-10-01',log:[]});
  const task=(id:string,cat:string,status:string,goal?:string)=>({id,cat,status,goal,from:'owner',text:id,mode:'test'});
  const at=(id:string,day:string)=>({type:'task.created',at:`2026-${day}T00:00:00.000Z`,data:{id}});
  const state:any={
    cats:['mayor','done','busy','needed','idle','fresh','kept'].map(id=>({id})),
    goals:[goal('over','achieved'),goal('live','active')],
    tasks:[task('m1','mayor','done','over'),task('d1','done','done','over'),task('d2','done','failed'),task('b1','busy','running','over'),
      task('n1','needed','done','over'),task('n2','needed','done','live'),task('i1','idle','done'),task('f1','fresh','done'),task('k1','kept','done','over')],
    events:[at('m1','10-01'),at('d1','10-01'),at('d2','10-02'),at('b1','10-01'),at('n1','10-01'),at('n2','10-01'),at('i1','10-20'),at('f1','10-31'),at('k1','10-01')],
    councils:[{target:'kept',status:'kept',at:'2026-10-05T00:00:00.000Z'}],
  };
  const policy={protectedCats:['mayor'],maxEvidenceTasks:5,idleDays:7},now=Date.parse('2026-11-02T00:00:00.000Z');
  assert.deepEqual(retirementCandidates(state,policy,now),[
    {cat:'done',why:'every goal it worked on has ended, last work 2026-10-02',evidence:['d1','d2']},
    {cat:'idle',why:'no work for 13 days, last work 2026-10-20',evidence:['i1']},
  ]);
  assert.deepEqual(retirementCandidates(state,{...policy,idleDays:undefined},now).map(c=>c.cat),['done'],'without idleDays only ended goals count');
  assert.match(goalReviewBrief(state,policy,now),/- done \| every goal it worked on has ended.* \| evidence d1,d2\n- idle .*\nWhen the owner asks you to review goals or the town \(not during a goal round\), call review_cat/);
  assert.ok(!goalReviewBrief(state).includes('review_cat'),'no council policy, no list');
});

test('the removal suggestion is a Mayor tool, offered at every autonomy level', () => {
  const names=(tools:any[])=>tools.map(t=>t.function.name);
  assert.ok(names(mayorTools('test')).includes('suggest_goal_removal'));
  assert.ok(!names(toolDefinitions).includes('suggest_goal_removal'));
  assert.ok(names(offeredTools(mayorTools('test'),'balanced')).includes('suggest_goal_removal'));
  assert.ok(names(offeredTools(mayorTools('test'),'full')).includes('suggest_goal_removal'),'full autonomy still leaves removal to the owner');
});

test('the demonstration Mayor ignores the removal tool and still answers', async () => {
  const answer=await demoProvider([{role:'system',content:'CAT_ID=mayor\nIn town now: scholar, critic, banker.'},{role:'user',content:'Review all town goals'}],mayorTools('demo'),new AbortController().signal,undefined as any);
  assert.ok(answer.message);
});

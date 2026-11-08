import {allRoles,withFullRoster} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {projects} from '../src/projects.ts';
import {quests,rankRules,stepUrl} from '../src/quests.ts';
import type {Quest,SeasonCapability,SeasonRun} from '../src/quests.ts';
import {runSeason} from '../src/season.ts';
import {latestSeason,publicSeason,readSeason} from '../src/season-view.ts';

const config=withFullRoster(JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')));
const NOW=new Date('2026-10-25T12:00:00.000Z');
const QUESTS=config.quests;
const RANKS='SABCDEF';
const cat=(id:string,name:string)=>({id,name,role:'',color:'#336699',icon:name[0]});
const task=(id:string,catId:string,text:string,status:string)=>({id,cat:catId,from:'owner',text,mode:'demo',status});
const MODELS={
  claude:{name:'Claude plan · haiku',enabled:true,available:false,detail:'Not signed in.'},
  local:{name:'Local AI · qwen',enabled:true,available:false,detail:'Ollama is not answering.'},
  chatgpt:{name:'ChatGPT plan',enabled:false,available:false,detail:'Off.'},
};

// A real journal written with fixed times, replayed by the Store. Only the season is produced by the runner.
function townFile(){
  const dir=mkdtempSync(join(tmpdir(),'quests-'));
  const file=join(dir,'events.jsonl');
  const lines:string[]=[];
  const add=(type:string,at:string,data:any)=>lines.push(JSON.stringify({id:`e${lines.length+1}`,at,type,data}));
  add('founded','2026-10-25T08:00:00.000Z',{cats:[cat('mayor','Mayor'),cat('historian','Historian'),cat('bridge','Bridge'),...allRoles(config).filter(c=>c.id!=='mayor').map(c=>cat(c.id,c.name))]});
  add('task.created','2026-10-25T09:00:00.000Z',task('R_fail','mayor','Sell the lemonade','failed'));
  add('task.created','2026-10-25T09:05:00.000Z',task('R_fail_ask','mayor','Ask about the bridge','waiting'));
  add('approval.requested','2026-10-25T09:05:30.000Z',{id:'A0',task:'R_fail_ask',cat:'historian',question:'Old question that was answered?',options:['Yes','No'],status:'approved',messages:[],toolCallId:'c0',turn:1,depth:0});
  add('task.created','2026-10-25T10:00:00.000Z',task('R_stale','mayor','Paint the barn','running'));
  add('task.created','2026-10-25T11:00:00.000Z',task('R_done','mayor','Plant the orchard. Then water it.','done'));
  add('task.created','2026-10-20T09:00:00.000Z',task('R_old','mayor','Old finished work','done'));
  add('task.created','2026-10-25T11:40:00.000Z',task('R_wait','mayor','Write the history page','waiting'));
  add('approval.requested','2026-10-25T11:50:00.000Z',{id:'A1',task:'R_wait',cat:'historian',question:'Publish the history page? It names the bridge.',options:['Yes','No'],status:'pending',messages:[],toolCallId:'c1',turn:1,depth:0});
  add('council.opened','2026-10-25T09:30:00.000Z',{id:'C1',target:'bridge',proposer:'owner',reason:'Bridge work is finished.',evidence:[],electorate:['mayor','historian'],mode:'demo'});
  add('council.closed','2026-10-25T09:31:00.000Z',{id:'C1',status:'interrupted',result:'Server restarted during council.'});
  add('council.opened','2026-10-25T09:40:00.000Z',{id:'C2',target:'historian',proposer:'owner',reason:'First review.',evidence:[],electorate:['mayor','bridge'],mode:'demo'});
  add('council.closed','2026-10-25T09:41:00.000Z',{id:'C2',status:'interrupted',result:'Paused.'});
  add('council.opened','2026-10-25T10:50:00.000Z',{id:'C3',target:'historian',proposer:'owner',reason:'Second review.',evidence:[],electorate:['mayor','bridge'],mode:'demo'});
  add('council.closed','2026-10-25T10:55:00.000Z',{id:'C3',status:'kept',result:'No majority.'});
  writeFileSync(file,lines.join('\n')+'\n');
  return {dir,file};
}

async function seasonCapabilities(dir:string):Promise<{name:string|undefined;capabilities:SeasonCapability[]}>{
  await runSeason({name:'q1',mode:'demo',seed:5,days:2,dataDir:dir,config});
  const name=latestSeason(dir);
  return {name,capabilities:name?publicSeason(readSeason(dir,name),name).capabilities:[]};
}

const find=(list:Quest[],kind:string,id:string)=>list.find(q=>q.source.kind===kind&&q.source.id===id);

test('every rank rule fires from a real Store, with the expected ranks and sources',async()=>{
  const f=townFile();
  try{
    const store=new Store(f.file,[]);
    const season=await seasonCapabilities(f.dir);
    const runs:SeasonRun[]=[{name:'q1',status:'paused',reason:'season paused: model timed out'}];
    const list=quests({state:store.state,projects:projects(store.state),latestSeason:season.name,capabilities:season.capabilities,seasons:runs,models:MODELS,config:QUESTS,now:NOW});
    assert.equal(find(list,'approval','A1')?.rank,'S');
    assert.equal(find(list,'approval','A0'),undefined,'answered approvals are not quests');
    assert.equal(find(list,'season','q1')?.rank,'A');
    assert.equal(find(list,'project','R_fail')?.rank,'B');
    assert.equal(find(list,'council','C1')?.rank,'B');
    assert.equal(find(list,'council','C2'),undefined,'a council the owner asked again about is not waiting');
    assert.equal(find(list,'model','claude')?.rank,'C');
    assert.equal(find(list,'model','local'),undefined,'local is always enabled and is skipped');
    assert.equal(find(list,'project','R_stale')?.rank,'D');
    assert.equal(find(list,'project','R_done')?.rank,'F');
    assert.equal(find(list,'project','R_old'),undefined,'finished outside recentHours is not a quest');
    // The demo season approves its own package request, so a pending sandbox request is added to reach rule E.
    const sandbox:SeasonCapability={id:'sb1',cat:'builder',need:'parse market data',kind:'package',tier:'sandbox',status:'pending'};
    const withSandbox=quests({state:store.state,projects:projects(store.state),latestSeason:season.name,capabilities:[...season.capabilities,sandbox],seasons:runs,models:MODELS,config:QUESTS,now:NOW});
    assert.equal(find(withSandbox,'capability','sb1')?.rank,'E');
    const owner=season.capabilities.find(c=>c.status==='needs_owner');
    assert.ok(owner,"demo season should request an owner capability");assert.equal(find(list,'capability',owner.id)?.rank,['money','account'].includes(owner.kind)?'S':'A');
    assert.ok(list.every(q=>q.title.length>0&&q.action.label.length>0));
    assert.ok(new Set(list.map(q=>q.rank)).has('S'));
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('owner capability requests rank S for money or account and A for other kinds',()=>{
  const state=new Store(townFile().file,[]).state;
  const caps:SeasonCapability[]=[
    {id:'k1',cat:'builder',need:'pay the printer',kind:'money',tier:'owner',status:'needs_owner'},
    {id:'k2',cat:'builder',need:'a shop login',kind:'account',tier:'owner',status:'needs_owner'},
    {id:'k3',cat:'builder',need:'a payment API',kind:'api',tier:'owner',status:'needs_owner'},
  ];
  const list=quests({state,projects:[],latestSeason:'q1',capabilities:caps,seasons:[],models:null,config:QUESTS,now:NOW});
  assert.equal(find(list,'capability','k1')?.rank,'S');
  assert.equal(find(list,'capability','k2')?.rank,'S');
  assert.equal(find(list,'capability','k3')?.rank,'A');
});

test('quests are ordered S to F, then newest first within a rank',async()=>{
  const f=townFile();
  try{
    const store=new Store(f.file,[]);
    const season=await seasonCapabilities(f.dir);
    const list=quests({state:store.state,projects:projects(store.state),latestSeason:season.name,capabilities:season.capabilities,seasons:[],models:MODELS,config:QUESTS,now:NOW});
    const ranks=list.map(q=>RANKS.indexOf(q.rank));
    assert.deepEqual(ranks,[...ranks].sort((a,b)=>a-b));
    for(let i=1;i<list.length;i++)if(list[i-1].rank===list[i].rank&&list[i-1].at&&list[i].at)assert.ok(list[i-1].at!>=list[i].at!,'newest first');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('model quests exist only when models are passed (owner only) and local is skipped',()=>{
  const state=new Store(townFile().file,[]).state;
  const base={state,projects:[],latestSeason:undefined,capabilities:[],seasons:[],config:QUESTS,now:NOW};
  assert.equal(quests({...base,models:null}).filter(q=>q.source.kind==='model').length,0);
  const owned=quests({...base,models:MODELS}).filter(q=>q.source.kind==='model');
  assert.deepEqual(owned.map(q=>q.source.id),['claude']);
  assert.equal(owned[0].action.panel,'models');
});

test('missing or invalid quests config skips the D and F rules instead of inventing values',()=>{
  const f=townFile();
  try{
    const store=new Store(f.file,[]);
    const base={state:store.state,projects:projects(store.state),latestSeason:undefined,capabilities:[],seasons:[],models:null,now:NOW};
    const ranks=(c:any)=>new Set(quests({...base,config:c}).map(q=>q.rank));
    for(const c of [undefined,{},{staleMinutes:'soon',recentHours:-1},{staleMinutes:0,recentHours:Number.NaN}]){
      assert.ok(!ranks(c).has('D'),`no D for ${JSON.stringify(c)}`);
      assert.ok(!ranks(c).has('F'),`no F for ${JSON.stringify(c)}`);
    }
    assert.ok(ranks({staleMinutes:30,recentHours:24}).has('D'));
    assert.ok(ranks({staleMinutes:30,recentHours:24}).has('F'));
    assert.ok(ranks({staleMinutes:30}).has('D'));
    assert.ok(!ranks({staleMinutes:30}).has('F'));
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('every rank has one reason in the rule table',()=>{
  assert.deepEqual(rankRules.map(r=>r.rank),[...RANKS]);
  assert.ok(rankRules.every(r=>r.reason.length>20&&!r.reason.includes('\n')));
});

// needsYou per kind: a fixed journal of every quest kind, read back through the same Store the server uses.
test('needsYou is true only for what the owner must act on; every quest carries the flag; old steps without a kind still show', () => {
  const store=new Store(join(mkdtempSync(join(tmpdir(),'needs-you-')),'events.jsonl'),[cat('scholar','Scholar'),cat('mayor','Mayor')]);
  const at='2026-10-25T11:00:00.000Z';
  const approval=(id:string,extra:Record<string,unknown>={})=>store.emit('approval.requested',{id,task:'t',cat:'scholar',question:`Question ${id}?`,options:['Yes','No'],status:'pending',messages:[],toolCallId:'c',turn:1,depth:0,...extra});
  approval('ap-design');
  approval('ap-goal',{cat:'mayor',gate:'goal-removal',goal:'g-fail',reason:'Duplicate.'});
  approval('ap-connector',{gate:'connector',call:{id:'c',type:'function',function:{name:'mcp__x__y',arguments:'{}'}}});
  const step=(id:string,extra:Record<string,unknown>={})=>store.emit('owner.step',{id,goal:null,cat:'scholar',title:`Step ${id}`,steps:'Do it.',blocking:false,...extra});
  step('os-kind',{kind:'account'});
  step('os-page',{kind:'account',url:'https://developers.facebook.com/apps/'});
  step('os-old');
  step('os-connect',{kind:'account',connect:'context7',title:'Connect Context7',steps:'For the docs.'});
  step('os-github',{kind:'account',connect:'github',title:'Connect GitHub',steps:'For the repo.'});
  const goal=(id:string,status:string,extra:Record<string,unknown>={})=>{
    store.emit('goal.created',{id,title:`Goal ${id}`,success:'Done.',status:'active',mode:'test',rounds:1,roundsToday:1,day:'',failures:0,log:[],summary:null,maxRoundsPerDay:null,tokenBudget:null,pausedBy:null,note:null,endedBy:null});
    if(status!=='active')store.emit('goal.updated',{id,status,...extra});
  };
  goal('g-hold','paused',{pausedBy:'owner-step',note:'Waiting on you: Publish'});
  store.emit('owner.step',{id:'os-block',goal:'g-hold',cat:'scholar',title:'Publish',steps:'Press it.',blocking:true,kind:'legal'});
  goal('g-fail','paused',{pausedBy:'failures',note:'Two rounds failed.'});
  goal('g-budget','paused',{pausedBy:'budget',note:'Budget spent.'});
  goal('g-stop','stopped',{endedBy:'mayor',note:'Impossible.'});
  store.emit('council.opened',{id:'k1',target:'scholar',proposer:'mayor',reason:'Idle.',evidence:[],electorate:['mayor'],mode:'test'});
  store.emit('council.closed',{id:'k1',status:'interrupted',result:'Restarted.'});
  const list=quests({state:store.state,projects:[],latestSeason:'alpha',seasons:[{name:'alpha',status:'paused',reason:'Stopped by the owner.'}],capabilities:[
    {id:'cap-money',cat:'scholar',need:'a card',kind:'money',tier:'owner',status:'needs_owner'},
    {id:'cap-api',cat:'scholar',need:'an api key',kind:'api',tier:'owner',status:'needs_owner'},
    {id:'cap-sand',cat:'scholar',need:'a sandbox run',kind:'network',tier:'sandbox',status:'pending'}],
    purchases:[{id:'pu1',vendor:'Namecheap',reason:'A domain.',note:'',url:'https://www.namecheap.com/',requestedAt:at,status:'pending',amountMinor:1200,currency:'USD'} as any],
    models:{claude:{name:'Claude plan',enabled:true,available:false,detail:'Not signed in.'}},
    workshopSetup:{error:'Install failed.',failures:1,at},
    now:NOW});
  const expected:Record<string,boolean>={
    'approval:ap-design':true,'approval:ap-goal':false,'approval:ap-connector':true,
    'purchase:pu1':true,
    'capability:cap-money':true,'capability:cap-api':true,'capability:cap-sand':false,
    'owner-step:os-kind':true,'owner-step:os-page':true,'owner-step:os-old':true,'owner-step:os-connect':true,'owner-step:os-github':true,'owner-step:os-block':true,
    'goal:g-hold':true,'goal:g-fail':false,'goal:g-budget':false,'goal:g-stop':false,
    'council:k1':false,'model:claude':false,'workshop:setup':false,'season:alpha':false,
  };
  const byId=new Map(list.map(q=>[q.id,q]));
  assert.ok(list.every(q=>typeof q.needsYou==='boolean'),'every quest carries needsYou');
  assert.deepEqual([...byId.keys()].sort(),Object.keys(expected).sort(),'needsYou=false quests stay in the list');
  for(const [id,flag] of Object.entries(expected))assert.equal(byId.get(id)!.needsYou,flag,id);
  const old=byId.get('owner-step:os-old')!;
  assert.equal(old.rank,'B');
  assert.equal(old.title,'Owner step: Step os-old');
  assert.equal(old.needsYou,true,'a step written before kinds existed still needs the owner');
  const connect=byId.get('owner-step:os-connect')!;
  assert.deepEqual(connect.connect,{id:'context7',name:'Context7'});
  assert.equal(connect.action.label,'Connect Context7');
  const github=byId.get('owner-step:os-github')!.connect as any;
  assert.match(github.token.url,/^https:\/\/github\.com\/settings\/tokens\/new\?scopes=/,'a token service links straight to making the token');
  assert.match(github.token.help,/Generate token/);
  assert.equal(byId.get('owner-step:os-kind')!.action.label,'Mark done');
  // A sign-in step with a page to open gets the cats' browser; one with no page gets no button (it opened a blank window); a one-tap
  // connect step has its own Connect button, and other kinds have neither.
  assert.equal(byId.get('owner-step:os-kind')!.browser,undefined);
  assert.equal(byId.get('owner-step:os-page')!.browser,true);
  assert.equal(byId.get('owner-step:os-page')!.url,'https://developers.facebook.com/apps/');
  assert.equal(byId.get('owner-step:os-connect')!.browser,undefined);
  assert.equal(byId.get('owner-step:os-block')!.browser,undefined);
});

test('a step opens the page its cat named, else the first address in its text; file names are not hosts', ()=>{
  assert.equal(stepUrl({url:'https://x.example/a',steps:'Go to vercel.com.'}),'https://x.example/a');
  assert.equal(stepUrl({steps:'Open https://developers.facebook.com/apps/. Then sign in.'}),'https://developers.facebook.com/apps/');
  assert.equal(stepUrl({steps:'needs owner sign-in. Sign in to developers.facebook.com in this browser.'}),'https://developers.facebook.com/');
  assert.equal(stepUrl({steps:'Push site/config.js and CREDITS.md, e.g. today.'}),undefined);
  assert.equal(stepUrl({steps:'Paste the token into the connector.'}),undefined);
  assert.equal(stepUrl({steps:'Email me@example.com when done.'}),undefined,'an email address is not a page');
});

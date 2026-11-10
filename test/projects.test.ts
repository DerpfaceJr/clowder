import test from 'node:test';
import assert from 'node:assert/strict';
import {projects} from '../src/projects.ts';
import type {Approval, Cat, Event, Group, State, Task} from '../src/store.ts';

const minute=(n:number)=>new Date(Date.UTC(2026,9,25,9,n)).toISOString();
const cat=(id:string,name:string,group?:string):Cat=>({id,name,role:'',color:'#336699',icon:name[0],group});
const task=(id:string,cat:string,from:string,text:string,status:string,parent?:string):Task=>({id,cat,from,text,mode:'demo',status,parent});
const approval=(id:string,taskId:string,catId:string,question:string,status='pending'):Approval=>({id,task:taskId,cat:catId,question,options:['Yes','No'],status,messages:[],toolCallId:'call',turn:1,depth:0});
const event=(type:string,at:string,data:any):Event=>({id:`${type}-${at}-${Math.random()}`,at,type,data});
const created=(t:Task,at:string)=>event('task.created',at,t);
const state=(parts:Partial<State>):State=>({cats:[],roads:[],tasks:[],approvals:[],messages:[],events:[],paused:false,usage:[],treasury:null,retiredCats:[],councils:[],layoutVersion:0,groups:[],introduced:true,goals:[],ownerSteps:[],hiddenQuests:{},accounts:{},effects:{},routines:[],...parts});

// Three requests, newest first in the output: R4 (failed), R3 (failed child, done root), R2 (waiting), R1 (nested, done, with a hamlet).
const cats=[cat('mayor','Mayor'),cat('gardener','Gardener','g1'),cat('reviewer','Reviewer','g1'),cat('historian','Historian'),cat('bridge','Bridge')];
const groups:Group[]=[{id:'g1',name:'Garden hamlet',lead:'gardener',site:{index:2,x:12,z:-4},rootTask:'R1'}];

const R1=task('R1','mayor','owner','Plan a community garden. Include beds and a path.','done');
const C1=task('C1','gardener','mayor','Design the beds','done','R1');
const G1=task('G1','reviewer','gardener','Review the beds','done','C1');
const R2=task('R2','mayor','owner','Write the town history','waiting_child');
const H1=task('H1','historian','mayor','Draft the history page','waiting','R2');
const R3=task('R3','mayor','owner','Check the bridge design','done');
const F1=task('F1','bridge','mayor','Check load limits','failed','R3');
const R4=task('R4','mayor','owner','Sell the lemonade','failed');

const events=[
  created(R1,minute(1)),created(C1,minute(2)),created(G1,minute(3)),
  event('task.updated',minute(5),{id:'G1',status:'done'}),
  event('message',minute(6),{from:'reviewer',to:'gardener',text:'Beds look good. Add a path.',task:'G1',mode:'demo'}),
  event('usage',minute(7),{task:'G1',cat:'reviewer',mode:'claude',input:100,output:40,cost:null}),
  event('usage',minute(7),{task:'C1',cat:'gardener',mode:'claude',input:null,output:10,cost:null}),
  event('task.updated',minute(9),{id:'R1',status:'done'}),
  created(R2,minute(10)),created(H1,minute(11)),
  event('approval.requested',minute(12),{id:'A1',task:'H1'}),
  created(R3,minute(20)),created(F1,minute(21)),
  event('task.updated',minute(22),{id:'F1',status:'failed'}),
  event('task.updated',minute(23),{id:'R3',status:'done'}),
  created(R4,minute(30)),
  event('task.updated',minute(31),{id:'R4',status:'failed'}),
];

const messages=[
  {id:'m1',at:minute(4),from:'owner',to:'mayor',text:'Plan a community garden.',task:'R1',mode:'demo'},
  {id:'m2',at:minute(6),from:'reviewer',to:'gardener',text:'Beds look good. Add a path.',task:'G1',mode:'demo'},
];

const fixture=()=>state({
  cats,groups,events,
  tasks:[R1,C1,G1,R2,H1,R3,F1,R4],
  approvals:[approval('A1','H1','historian','Publish the history page?')],
  messages,
  usage:[{task:'G1',cat:'reviewer',mode:'claude',input:100,output:40,cost:null,at:minute(7)},{task:'C1',cat:'gardener',mode:'claude',input:null,output:10,cost:null,at:minute(7)}],
});

test('projects lists one row per owner request, newest first, and never mutates the state', () => {
  const s=fixture();const before=JSON.stringify(s);
  const list=projects(s);
  assert.deepEqual(list.map(p=>p.id),['R4','R3','R2','R1']);
  assert.equal(JSON.stringify(s),before, 'the state is read, not changed');
});

test('nested delegation: counts, cats involved, timestamps, progress and the latest message', () => {
  const p=projects(fixture()).find(p=>p.id==='R1')!;
  assert.equal(p.title,'Plan a community garden');
  assert.equal(p.status,'done');
  assert.equal(p.startedAt,minute(1));
  assert.equal(p.updatedAt,minute(9), 'the latest event in the tree, here the root finishing');
  assert.deepEqual(p.counts,{tasks:3,done:3,running:0,waiting:0,failed:0});
  assert.equal(p.progress,1);
  assert.deepEqual(p.cats.map(c=>c.id),['mayor','gardener','reviewer'], 'cats from the whole delegation tree, in first-seen order');
  assert.deepEqual(p.lastMessage,{from:'reviewer',to:'gardener',text:'Beds look good. Add a path.',at:minute(6)});
  assert.deepEqual(p.usage,{input:100,output:50}, 'a null input from the demo-like record is skipped, not counted as zero');
});

test('pending approval outranks the task state and is reported with its cat', () => {
  const p=projects(fixture()).find(p=>p.id==='R2')!;
  assert.equal(p.status,'waiting for you');
  assert.deepEqual(p.pendingApprovals,[{id:'A1',question:'Publish the history page?',cat:'historian'}]);
  assert.deepEqual(p.counts,{tasks:2,done:0,running:1,waiting:1,failed:0}, 'waiting_child counts as running; waiting is the approval checkpoint');
  assert.equal(p.progress,0);
  assert.equal(p.group,null);
  assert.equal(p.lead,'mayor', 'no hamlet: the chat to open is the cat the request went to');
  assert.equal(p.usage.input,null);
  assert.equal(p.usage.output,null, 'nothing reported means null, not zero');
});

test('a resolved approval is not pending', () => {
  const s=fixture();s.approvals=[approval('A1','H1','historian','Publish the history page?','approved')];
  assert.deepEqual(projects(s).find(p=>p.id==='R2')!.pendingApprovals,[]);
  assert.equal(projects(s).find(p=>p.id==='R2')!.status,'running');
});

test('a failed child under a finished root reads done, with the failure in counts', () => {
  const p=projects(fixture()).find(p=>p.id==='R3')!;
  assert.equal(p.status,'done');
  assert.equal(p.counts.failed,1);
  assert.equal(p.counts.done,1);
  assert.equal(p.progress,1, 'failed tasks are finished tasks too');
});

test('a failed root reads failed, and an interrupted root reads stopped', () => {
  const s=fixture();
  assert.equal(projects(s).find(p=>p.id==='R4')!.status,'failed');
  s.tasks.find(t=>t.id==='R4')!.status='interrupted';
  assert.equal(projects(s).find(p=>p.id==='R4')!.status,'interrupted');
});

test('a running request with no decision pending reads running', () => {
  const s=state({cats:[cat('mayor','Mayor')],tasks:[task('R9','mayor','owner','Keep the lamps lit','running'),task('C9','mayor','mayor','Light the lamps','running','R9')],events:[created(task('R9','mayor','owner','Keep the lamps lit','running'),minute(40))]});
  const p=projects(s)[0];
  assert.equal(p.status,'running');
  assert.deepEqual(p.counts,{tasks:2,done:0,running:2,waiting:0,failed:0});
  assert.equal(p.progress,0);
  assert.equal(p.updatedAt,minute(40), 'no later event: updated equals started');
});

test('group membership comes from the hamlet founded by the root task, and only its members are listed', () => {
  const garden=projects(fixture()).find(p=>p.id==='R1')!;
  assert.deepEqual(garden.group,{id:'g1',name:'Garden hamlet',lead:'gardener',site:{x:12,z:-4},members:[{id:'gardener',name:'Gardener',icon:'G',color:'#336699'},{id:'reviewer',name:'Reviewer',icon:'R',color:'#336699'}]});
  assert.equal(garden.lead,'gardener', 'open-in-chat goes to the hamlet lead');
  const other=projects(fixture()).find(p=>p.id==='R3')!;
  assert.equal(other.group,null);
  assert.equal(other.lead,'mayor');
});

test('titles are one line, capped at 60 characters; blank text falls back to a name', () => {
  const long='Build a floating market with a wide canal and lamps along every bridge and a clock tower '.repeat(2);
  const s=state({cats:[cat('mayor','Mayor')],tasks:[task('RL','mayor','owner',long,'done')]});
  const title=projects(s)[0].title;
  assert.ok(title.length<=60,`title is ${title.length} characters`);
  assert.ok(title.endsWith('…'));
  const blank=state({cats:[cat('mayor','Mayor')],tasks:[task('RB','mayor','owner','   ','done')]});
  assert.equal(projects(blank)[0].title,'Untitled request');
});

test('a retired cat keeps its name in an old project', () => {
  const retiredCat={...cat('scribe','Scribe'),retiredAt:minute(50),council:'c1',reason:'done',roads:[]};
  const s=state({cats:[cat('mayor','Mayor')],retiredCats:[retiredCat as any],tasks:[task('RS','mayor','owner','Write the notes','done'),task('CS','scribe','mayor','Take notes','done','RS')]});
  assert.deepEqual(projects(s)[0].cats.map(c=>c.name),['Mayor','Scribe']);
});

test('a request retried to done reads done; its newest owner turn speaks for it (plan 11.1)', () => {
  const s=fixture();
  const root=s.tasks.find(t=>t.id==='R4')!;root.status='interrupted';
  s.tasks.push(task('R4-retry',root.cat,'owner',root.text,'running','R4'));
  assert.equal(projects(s).find(p=>p.id==='R4')!.status,'running');
  s.tasks.find(t=>t.id==='R4-retry')!.status='done';
  assert.equal(projects(s).find(p=>p.id==='R4')!.status,'done');
  // A child a cat delegated is not an owner turn: it never speaks for the request.
  s.tasks.push(task('R4-helper','reviewer',root.cat,'Check it','failed','R4'));
  assert.equal(projects(s).find(p=>p.id==='R4')!.status,'done');
});

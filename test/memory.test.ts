import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {Bm25, buildMemory, lookup, memoryFor, registerMemoryRoutes} from '../src/memory.ts';
import {readSeason} from '../src/season-view.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));

// A town built through the Store and Town (as the council tests do), with a hand-written season journal next to it.
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'town-memory-')),file=join(dir,'events.jsonl');
  const store=new Store(file,allRoles(config));
  new Town(store,config);
  store.emit('task.created',{id:'t1',cat:'scholar',from:'owner',text:'Research small shops',mode:'demo',status:'running'});
  store.emit('task.created',{id:'t2',cat:'critic',from:'scholar',text:'Review the shop research',parent:'t1',mode:'demo',status:'running'});
  store.emit('message',{from:'scholar',to:'critic',text:'Please review the shop research',task:'t2',mode:'demo'});
  store.emit('task.updated',{id:'t2',status:'done',result:'Reviewed.'});
  // A waiting task's model context must never reach the graph, the search, the lookup tool or the routes.
  store.emit('task.updated',{id:'t1',status:'waiting',context:{messages:[{role:'user',content:'CONTEXT-SECRET'}]}});
  store.emit('approval.requested',{id:'a1',task:'t1',cat:'scholar',question:'Continue the shop study?',options:['yes','no'],status:'pending',messages:[{role:'user',content:'TRANSCRIPT-SECRET'}],toolCallId:'call',turn:1,depth:0});
  store.emit('approval.resolved',{id:'a1',status:'approved',answer:'yes'});
  store.emit('council.opened',{id:'c1',target:'critic',proposer:'mayor',reason:'Idle since the review.',evidence:['t2'],electorate:['scholar','banker'],mode:'demo'});
  store.emit('council.voted',{id:'c1',ballot:{cat:'scholar',vote:'keep',reason:'Still useful.'}});
  const season=[
    {type:'season.started',seed:1,startingCoins:100,cats:['mayor','merchant','banker','scholar'],ticksPerDay:2,days:1,defaultEnvelope:10},
    {type:'business.opened',id:'b1',owner:'merchant',name:'Quill Shop',pitch:'Hand-written notes',category:'stationery',price:3,unitCost:1,fit:1.4,startup:5},
    {type:'capability.requested',id:'c1',cat:'scholar',need:'package access',purpose:'read a library',kind:'package',source:'npm:left-pad',tier:'sandbox'},
    {type:'capability.decided',id:'c1',by:'mayor',approved:true,reason:'Fine.'},
    {type:'spend.requested',id:'sp1',cat:'merchant',amount:5,purpose:'stock the shop',business:'b1',tick:0,then:{type:'business.stocked',id:'b1',units:2}},
    {type:'spend.decided',id:'sp1',by:'banker',approved:false,reason:'Too early.'},
    {type:'action',cat:'mayor',key:'k1',name:'message',args:{to:'scholar',text:'Study the stationery shop'},ok:true,result:'Message recorded.'},
  ];
  appendFileSync(join(dir,'season-s1.jsonl'),season.map(e=>JSON.stringify(e)).join('\n')+'\n');
  return {dir,store};
}

const find=(mem:ReturnType<typeof memoryFor>,pred:(n:any)=>boolean)=>[...mem.nodes.values()].find(pred);
const edge=(mem:ReturnType<typeof memoryFor>,type:string,from:string,to:string)=>mem.edges.find(e=>e.type===type&&e.from===from&&e.to===to);

test('graph extraction builds every node type from the journal and the latest season', ()=>{
  const {dir,store}=fixture();
  const mem=memoryFor(dir,store.state.events);
  assert.equal((store.state.tasks.find(t=>t.id==='t1') as any)?.context?.messages?.[0]?.content,'CONTEXT-SECRET','the fixture really stores a context');
  const types=new Set([...mem.nodes.values()].map(n=>n.type));
  for(const t of ['cat','group','project','task','business','decision','message'] as const)assert.ok(types.has(t),`missing node type ${t}`);
  assert.equal(mem.nodes.get('project:t1')?.type,'project');
  assert.equal(mem.nodes.get('task:t2')?.type,'task');
  assert.equal(mem.nodes.get('task:t2')?.status,'done');
  assert.equal(find(mem,n=>n.type==='business')?.label,'Quill Shop');
  assert.equal(mem.nodes.get('owner')?.type,'cat');
});

test('each edge type carries the basis it was extracted with', ()=>{
  const {dir,store}=fixture();
  const mem=memoryFor(dir,store.state.events);
  const ex=(type:string,from:string,to:string)=>edge(mem,type,from,to);
  // Stated by an event field: EXTRACTED.
  assert.equal(ex('delegated','project:t1','task:t2')?.basis,'EXTRACTED');
  assert.equal(ex('delegated','scholar','critic')?.basis,'EXTRACTED');
  assert.equal(ex('part-of','task:t2','project:t1')?.basis,'EXTRACTED');
  assert.equal(ex('messaged','scholar','critic')?.count,1);
  assert.equal(ex('messaged','scholar','critic')?.basis,'EXTRACTED');
  assert.equal(ex('decided','critic','council:c1'),undefined);
  assert.equal(ex('decided','scholar','council:c1')?.basis,'EXTRACTED');
  assert.equal(ex('decided','scholar','council:c1')?.note,'vote keep');
  assert.equal(ex('owns','merchant','biz:s1/b1')?.basis,'EXTRACTED');
  assert.equal(ex('decided','banker','spend:s1/sp1')?.basis,'EXTRACTED');
  assert.equal(ex('decided','mayor','cap:s1/c1')?.basis,'EXTRACTED');
  assert.equal(ex('part-of','spend:s1/sp1','biz:s1/b1')?.basis,'EXTRACTED');
  assert.equal(ex('messaged','mayor','scholar')?.basis,'EXTRACTED');
  assert.ok(mem.edges.some(e=>e.type==='lives-in'&&e.basis==='EXTRACTED'));
  // The approval has no actor in its event, so the owner link is derived and says why.
  const owner=ex('decided','owner','approval:a1');
  assert.equal(owner?.basis,'INFERRED');
  assert.match(owner?.why??'',/only the owner answers approvals/);
  assert.ok(mem.edges.filter(e=>e.basis==='INFERRED').every(e=>e.why),'every INFERRED edge explains itself');
});

test('approval transcripts never enter the graph', ()=>{
  const {dir,store}=fixture();
  const mem=memoryFor(dir,store.state.events);
  assert.ok(!JSON.stringify([...mem.nodes.values()]).includes('TRANSCRIPT-SECRET'));
});

test('BM25 ranks by term frequency and rarity', ()=>{
  const idx=new Bm25();
  idx.add('d1','shop shop shop');
  idx.add('d2','shop yarn');
  idx.add('d3','yarn knitting circle');
  idx.add('d4','quiet garden walk');
  assert.deepEqual(idx.search('shop',5).map(h=>h.id),['d1','d2']);
  assert.equal(idx.search('knitting',5)[0].id,'d3');
  assert.equal(idx.search('shop yarn',5)[0].id,'d2');
  assert.deepEqual(idx.search('absent',5),[]);
  assert.deepEqual(new Bm25().search('anything',5),[]);
});

test('the brief stays within its character cap', ()=>{
  const {dir,store}=fixture();
  for(let i=0;i<30;i++)store.emit('task.created',{id:`long${i}`,cat:'scholar',from:'owner',text:`A very long research assignment number ${i} `.repeat(12),mode:'demo',status:'done'});
  const mem=memoryFor(dir,store.state.events);
  const brief=mem.brief('scholar');
  assert.ok(brief.length>0&&brief.length<=600,`brief is ${brief.length} characters`);
  assert.ok(mem.brief('scholar',400).length<=400);
  assert.match(brief,/Lives in /);
  assert.equal(mem.brief('nobody-here'),'');
});

test('lookup output stays under 1500 characters and tags every line with its source and basis', ()=>{
  const {dir,store}=fixture();
  for(let i=0;i<200;i++)store.emit('message',{from:'critic',to:'scholar',text:`Shop note ${i}: the stationery shop needs more evidence about demand and pricing. `.repeat(3),task:'t2',mode:'demo'});
  const mem=memoryFor(dir,store.state.events);
  const out=lookup(mem,{query:'stationery shop'});
  assert.ok(out.length<=1500,`lookup is ${out.length} characters`);
  const lines=out.split('\n');
  assert.ok(lines.length>1);
  for(const line of lines)assert.match(line,/\[(EXTRACTED|INFERRED)[^\]]*; event [^\]]+\]$/,line);
  const about=lookup(mem,{about:'owner'});
  assert.match(about,/\[EXTRACTED; event /);
  assert.match(lookup(mem,{about:'approval:a1'}),/INFERRED: approval\.resolved records no actor/);
  assert.equal(lookup(mem,{query:'zzzqqq'}),'No town records match.');
  assert.match(lookup(mem,{about:'project:t1'}),/Research small shops/);
  assert.ok(!lookup(mem,{about:'project:t1'}).includes('CONTEXT-SECRET'));
  assert.ok(!lookup(mem,{query:'context'}).includes('CONTEXT-SECRET'));
  assert.throws(()=>lookup(mem,{}),/Give a query/);
  assert.throws(()=>lookup(mem,{query:5}),/Invalid query/);
});

test('the graph endpoint caps at 300 nodes and the routes return no contexts or transcripts', async()=>{
  const {dir,store}=fixture();
  for(let i=0;i<400;i++)store.emit('message',{from:'owner',to:'mayor',text:`Message ${i}`,task:'t1',mode:'demo'});
  const app=Fastify();
  registerMemoryRoutes(app,()=>memoryFor(dir,store.state.events));
  const graph=await app.inject({method:'GET',url:'/api/memory/graph?limit=999'});
  assert.equal(graph.statusCode,400);
  const big=await app.inject({method:'GET',url:'/api/memory/graph?limit=300'});
  assert.equal(big.statusCode,200);
  const body=big.json();
  assert.ok(body.nodes.length<=300&&body.nodes.length>0);
  for(const n of body.nodes)assert.deepEqual(Object.keys(n).sort(),['at','id','label','type']);
  for(const e of body.edges)assert.deepEqual(Object.keys(e).sort(),['basis','from','to','type']);
  const raw=big.body;
  assert.ok(!/"context"\s*:/.test(raw));
  assert.ok(!raw.includes('TRANSCRIPT-SECRET'));
  assert.ok(!raw.includes('CONTEXT-SECRET'));
  const focused=await app.inject({method:'GET',url:'/api/memory/graph?focus=critic&depth=2&limit=50'});
  assert.equal(focused.statusCode,200);
  assert.ok(focused.json().nodes.some((n:any)=>n.id==='critic'));
  assert.equal((await app.inject({method:'GET',url:'/api/memory/graph?focus=nope'})).statusCode,400);
  assert.equal((await app.inject({method:'GET',url:'/api/memory/graph?depth=9'})).statusCode,400);
  assert.equal((await app.inject({method:'GET',url:'/api/memory/graph?limit=0'})).statusCode,400);
  const search=await app.inject({method:'GET',url:'/api/memory/search?q=stationery'});
  assert.equal(search.statusCode,200);
  assert.ok(search.json().hits.length>0);
  assert.ok(!search.body.includes('TRANSCRIPT-SECRET'));
  assert.ok(!search.body.includes('CONTEXT-SECRET'));
  const focusedRaw=focused.body;
  assert.ok(!focusedRaw.includes('CONTEXT-SECRET'));
  const projectGraph=await app.inject({method:'GET',url:'/api/memory/graph?focus=project%3At1&depth=1&limit=50'});
  assert.equal(projectGraph.statusCode,200);
  assert.ok(!projectGraph.body.includes('CONTEXT-SECRET'));
  assert.equal((await app.inject({method:'GET',url:'/api/memory/search?q='})).statusCode,400);
  await app.close();
});

test('a first task starts from the town brief, and the season view carries a brief of at most 400 characters', async()=>{
  const {dir,store}=fixture();
  const town=new Town(store,config);
  store.emit('message',{from:'owner',to:'archivist',text:'Old note for the archivist',task:'other',mode:'demo'});
  const task=town.createTask('archivist','owner','Catalogue the shops','demo');
  const ctx=town.context(task,0);
  const system=String(ctx.messages[0].content);
  const archivist=allRoles(config).find((c:any)=>c.id==='archivist')!;
  assert.match(system,new RegExp(`Town memory: ${archivist.name}:`));
  assert.ok(!ctx.messages.some(m=>String(m.content).includes('Old note for the archivist')),'the first task has no chat history');
  const {view}=await import('../src/season.ts');
  const {readSeason,latestSeason}=await import('../src/season-view.ts');
  const {replay}=await import('../src/economy.ts');
  const events=readSeason(dir,latestSeason(dir)!);
  const v=view(replay(events),events,'merchant',dir,config);
  assert.ok(v.townMemory.length>0&&v.townMemory.length<=400,`townMemory is ${v.townMemory.length} characters`);
  // The season view carries town facts only; the season's own businesses and balances are already in the view.
  assert.match(v.townMemory,/Lives in /);
  assert.ok(!v.townMemory.includes('Quill Shop'));
});

test('every task carries the recorded lessons that match it, dated; a record task does not', ()=>{
  const {store}=fixture();
  const town=new Town(store,config);
  town.createTask('archivist','owner','Catalogue the shops','demo');
  store.emit('memory.noted',{cat:'archivist',task:'t0',title:'Reels need text backing boxes',text:'Instagram covers the bottom of a reel, so captions sit in the safe zone on a backing box.'});
  store.emit('memory.noted',{cat:'archivist',task:'t0',title:'Bakery opens at dawn',text:'The bakery sells bread from six.'});
  const system=(t:any)=>String(town.context(t,0).messages[0].content);
  const later=system(town.createTask('archivist','owner','Render the next instagram reel with captions','demo'));
  assert.match(later,/Lessons from town memory that match this task[^\n]*\(\d{4}-\d\d-\d\d\) Reels need text backing boxes: Instagram covers/);
  assert.ok(!later.includes('Bakery opens'),'a note that shares no words with the task stays out');
  assert.ok(!system(town.createTask('archivist','owner','Plant a garden','demo')).includes('Lessons from town memory'),'no match, no line');
  const record=town.createTask('archivist','owner','Record what the instagram reel work established','demo');
  record.record=true;
  assert.ok(!system(record).includes('Lessons from town memory'),'the recorder is not handed the lessons it is writing');
});

test('the cached graph follows new events and matches a fresh build', ()=>{
  const {dir,store}=fixture();
  const before=memoryFor(dir,store.state.events);
  store.emit('task.created',{id:'t9',cat:'builder',from:'mayor',text:'Build a shop sign',parent:'t1',mode:'demo',status:'running'});
  store.emit('message',{from:'mayor',to:'builder',text:'Build the sign',task:'t9',mode:'demo'});
  const after=memoryFor(dir,store.state.events);
  assert.notEqual(before,after);
  const fresh=buildMemory(store.state.events,{name:'s1',events:readSeason(dir,'s1')});
  assert.equal(after.nodes.size,fresh.nodes.size);
  assert.equal(after.edges.length,fresh.edges.length);
  assert.ok(after.nodes.has('task:t9'));
  assert.equal(before.nodes.has('task:t9'),false,'an earlier snapshot is not changed by later events');
  assert.equal(memoryFor(dir,store.state.events),after,'unchanged journals return the same graph');
});

test('the file path reads only appended lines and waits for a torn last line', ()=>{
  const {dir,store}=fixture();
  memoryFor(dir,undefined,false);
  store.emit('task.created',{id:'t9',cat:'builder',from:'mayor',text:'Build a shop sign',parent:'t1',mode:'demo',status:'running'});
  assert.ok(memoryFor(dir,undefined,false).nodes.has('task:t9'));
  const line=JSON.stringify({id:'torn1',at:new Date().toISOString(),type:'message',data:{from:'owner',to:'mayor',text:'Torn line here',mode:'demo'}});
  appendFileSync(join(dir,'events.jsonl'),line.slice(0,20));
  assert.equal(memoryFor(dir,undefined,false).nodes.has('msg:torn1'),false,'a torn line is not applied yet');
  appendFileSync(join(dir,'events.jsonl'),`${line.slice(20)}\n`);
  assert.ok(memoryFor(dir,undefined,false).nodes.has('msg:torn1'),'the completed line is applied once');
  assert.equal(memoryFor(dir,undefined,false).nodes.get('msg:torn1')?.text,'Torn line here');
});

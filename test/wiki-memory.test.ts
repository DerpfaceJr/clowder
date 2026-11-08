import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {lookup,memoryFor} from '../src/memory.ts';
import {forget,merge,organise,ownerSave,registerWikiRoutes,wikiOf} from '../src/wiki.ts';
import type {Provider} from '../src/provider.ts';

const config={...JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')),maxParallelWork:3};
const world=(readModel=false)=>{const dir=mkdtempSync(join(tmpdir(),'wiki-'));return {dir,file:join(dir,'events.jsonl'),store:new Store(join(dir,'events.jsonl'),config.cats,readModel?{readModel:join(dir,'read-model.db')}:{})};};
const note=(store:Store,title:string,text:string)=>store.emit('memory.noted',{cat:'archivist',task:'t0',title,text});
const notes=(store:Store)=>store.state.events.filter(e=>e.type==='memory.noted').length;
const system=(town:Town,text:string)=>String(town.context(town.createTask('mayor','owner',text,'demo'),0).messages[0].content);
// Three notes name the Daily Tower, three the Bakery; two of the bakery notes say the same thing.
function fill(store:Store){
  note(store,'Daily Tower: tips go through Stripe','The Daily Tower tip jar uses Stripe test mode until the owner enables payouts.');
  note(store,'Daily Tower counter lives in Upstash','The Daily Tower run counter is stored in Upstash Redis, server side only.');
  note(store,'Daily Tower launch is free to play','Daily Tower launches free with optional tips and no perks.');
  note(store,'Bakery opens at dawn','The Bakery sells marmalade buns from six in the morning.');
  note(store,'Bakery opens at dawn daily','The Bakery sells marmalade buns from six every morning.');
  note(store,'Bakery closes on Mondays','The Bakery stays shut on Mondays for cleaning.');
}

test('the organiser files notes into pages once, never deletes a note, and flags near-duplicates',()=>{
  const {dir,store}=world();fill(store);
  const first=organise(store),pages=wikiOf(store).pages;
  assert.deepEqual([...pages.keys()].sort(),['bakery','daily-tower']);
  assert.equal(first.notes,6);
  assert.equal(pages.get('daily-tower')!.kind,'project');
  assert.match(pages.get('bakery')!.body,/Bakery opens at dawn: The Bakery sells marmalade/);
  assert.equal(pages.get('bakery')!.duplicates.length,1,'the two dawn notes are flagged, not removed');
  assert.ok(pages.get('daily-tower')!.sources.every(s=>/^(note|task):/.test(s)));
  const events=store.state.events.length;
  assert.deepEqual(organise(store),{notes:0,pages:0,created:0,duplicates:0});
  assert.equal(store.state.events.length,events,'a second run journals nothing');
  assert.equal(notes(store),6,'every note is still in the journal');
  const file=readFileSync(join(dir,'wiki','bakery.md'),'utf8');
  assert.match(file,/^---\ntitle: "Bakery"\nkind: project\n/);
  assert.match(file,/duplicates: \[\["note:/);
  // A later note that names a page joins it.
  note(store,'Daily Tower adds a leaderboard','The Daily Tower shows the top ten runs.');
  const saves=store.state.events.filter(e=>e.type==='wiki.saved').length;
  assert.equal(organise(store).created,0);
  assert.match(wikiOf(store).pages.get('daily-tower')!.body,/leaderboard/);
  // It is journaled as one small wiki.line, not the whole page again, and replay rebuilds the same page.
  const last=store.state.events.at(-1)!;
  assert.equal(last.type,'wiki.line');
  assert.equal(store.state.events.filter(e=>e.type==='wiki.saved').length,saves);
  assert.ok(JSON.stringify(last.data).length<400);
  assert.deepEqual(wikiOf(new Store(join(dir,'events.jsonl'),[])).pages.get('daily-tower'),wikiOf(store).pages.get('daily-tower'));
  assert.match(readFileSync(join(dir,'wiki','daily-tower.md'),'utf8'),/leaderboard/,'the mirror follows appended lines');
});

test('an owner edit persists across a restart, is marked as the owner’s words and reaches the next task’s context',()=>{
  const {dir,file,store}=world();fill(store);
  new Town(store,config);organise(store);
  const old=wikiOf(store).pages.get('bakery')!;
  ownerSave(store,'bakery',{body:`${old.body}\n- The owner wants marmalade buns kept for the regulars on Fridays.`});
  const saved=wikiOf(store).pages.get('bakery')!;
  assert.deepEqual(saved.owner,['- The owner wants marmalade buns kept for the regulars on Fridays.'],'only the added line is the owner’s');
  assert.deepEqual(saved.sources,old.sources);
  const again=new Store(file,[]),town=new Town(again,config);
  assert.ok(wikiOf(again).pages.get('bakery')!.owner.length,'replayed from the journal');
  const context=system(town,'Bake the Friday marmalade buns for the regulars');
  assert.match(context,/Lessons from town memory[^\n]*\(the owner’s words\) \[\[bakery\]\] The owner wants marmalade buns kept for the regulars on Fridays/);
  assert.match(lookup(memoryFor(dir,again.state.events),{query:'marmalade regulars'}),/wiki page "Bakery".*OWNER: The owner wants marmalade/);
  assert.match(readFileSync(join(dir,'wiki','bakery.md'),'utf8'),/owner_lines: \["- The owner wants/);
  // The organiser appends to an owner-edited page and never touches the owner's line.
  note(again,'Bakery hires a second baker','The Bakery hired a second baker for weekends.');
  organise(again);
  const after=wikiOf(again).pages.get('bakery')!;
  assert.ok(after.body.includes('The owner wants marmalade')&&after.body.includes('second baker'));
  assert.deepEqual(after.owner,saved.owner);
});

test('forget removes a page and its notes from lookups and the organiser never makes it again',()=>{
  const {dir,store}=world();fill(store);organise(store);
  const mem=()=>memoryFor(dir,store.state.events);
  assert.match(lookup(mem(),{query:'marmalade'}),/wiki page "Bakery"/);
  forget(store,'bakery');
  const out=lookup(mem(),{query:'marmalade'});
  assert.ok(!out.includes('Bakery')&&!out.includes('marmalade'),out);
  assert.ok(!mem().lessons('Sell marmalade buns at dawn').includes('marmalade'));
  assert.ok(!existsSync(join(dir,'wiki','bakery.md')));
  note(store,'Bakery adds rye bread','The Bakery now sells rye.');
  organise(store);
  assert.ok(!wikiOf(store).pages.has('bakery'),'a forgotten page is not suggested again');
  assert.equal(notes(store),7,'forgetting deletes no note');
  assert.throws(()=>forget(store,'bakery'),/No such page/);
});

test('merge combines two pages and the merged name points at the survivor',()=>{
  const {dir,store}=world();fill(store);organise(store);
  ownerSave(store,'bread',{title:'Bread',kind:'topic',body:'- Rye sells out by noon.'});
  merge(store,'bread','bakery');
  const w=wikiOf(store),page=w.pages.get('bakery')!;
  assert.ok(!w.pages.has('bread')&&!existsSync(join(dir,'wiki','bread.md')));
  assert.match(page.body,/marmalade[\s\S]*Rye sells out by noon/);
  assert.ok(page.owner.includes('- Rye sells out by noon.'),'owner lines survive a merge');
  assert.equal(w.redirects.get('bread'),'bakery');
  assert.throws(()=>merge(store,'bakery','bakery'),/No such page|different/);
});

test('owner routes: FTS search finds a page by a word, and every route is owner-only',async()=>{
  const {store}=world(true);fill(store);organise(store);
  let owner=true;
  const app=Fastify();registerWikiRoutes(app,{store:()=>store,owner:()=>owner});
  const get=async(url:string)=>(await app.inject({url})).json();
  assert.deepEqual((await get('/api/wiki?q=Upstash')).hits.map((h:any)=>h.slug),['daily-tower']);
  assert.deepEqual((await get('/api/wiki?q=marmalade')).hits.map((h:any)=>h.slug),['bakery']);
  note(store,'Bakery bakes croissants','The Bakery added croissants on weekends.');organise(store);
  assert.deepEqual((await get('/api/wiki?q=croissants')).hits.map((h:any)=>h.slug),['bakery'],'an appended line is searchable');
  assert.deepEqual((await get('/api/wiki?q=Bakery')).hits.map((h:any)=>h.slug),['bakery'],'one hit per page, not per line');
  const list=await get('/api/wiki');
  assert.deepEqual(list.pages.map((p:any)=>p.slug).sort(),['bakery','daily-tower']);
  assert.equal(list.notes,7);
  const page=await get('/api/wiki/bakery');
  assert.match(page.duplicates[0].a.title,/Bakery opens at dawn/);
  assert.equal((await app.inject({method:'PUT',url:'/api/wiki/bakery',payload:{body:'- Open from seven now.'}})).statusCode,200);
  assert.deepEqual((await get('/api/wiki?q=seven')).hits.map((h:any)=>h.slug),['bakery'],'an edit is searchable at once');
  assert.equal((await app.inject({method:'PUT',url:'/api/wiki/..%2Fescape',payload:{body:'x'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/wiki/merge',payload:{from:'bakery',into:'daily-tower'}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/wiki/daily-tower/forget'})).statusCode,200);
  assert.deepEqual((await get('/api/wiki?q=Upstash')).hits,[],'a forgotten page leaves the search');
  owner=false;
  for(const [method,url] of [['GET','/api/wiki'],['GET','/api/wiki/bakery'],['POST','/api/wiki/organise']] as const)assert.equal((await app.inject({method,url})).statusCode,403);
  await app.close();
});

test('the Archivist’s remember files the note on its page',async()=>{
  const {store}=world();fill(store);organise(store);
  const provider:Provider=async messages=>{
    const q=String(messages.at(-1)?.content??'');
    if(q.startsWith('Record for the town'))return {message:{role:'assistant',tool_calls:[{id:'c1',type:'function',function:{name:'remember',arguments:JSON.stringify({title:'Daily Tower ships a dark mode',text:'The Daily Tower now has a dark mode toggle.'})}}]}};
    return {message:{role:'assistant',content:messages.at(-1)?.role==='tool'?'Recorded one note.':'The Daily Tower dark mode shipped after review and is live for every visitor today.'}};
  };
  const town=new Town(store,config,{test:provider});
  town.submit('mayor','Ship the Daily Tower dark mode','test');
  const end=Date.now()+5000;
  while(Date.now()<end&&!wikiOf(store).pages.get('daily-tower')!.body.includes('dark mode'))await new Promise(r=>setTimeout(r,10));
  assert.match(wikiOf(store).pages.get('daily-tower')!.body,/Daily Tower ships a dark mode/);
  assert.equal(wikiOf(store).pages.get('daily-tower')!.by,'archivist');
});

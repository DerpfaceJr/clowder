// Prompt diet (product plan 2.5): the system prompt carries compact town lines instead of JSON of every cat, road and the
// last 30 tasks; what was dropped stays reachable through lookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {lookup} from '../src/memory.ts';
import {goalReviewBrief} from '../src/goals.ts';

const config=loadConfig(fileURLToPath(new URL('../',import.meta.url)));
const role=(i:number)=>`Specialist number ${i} for the shop launch. `.repeat(12)+`Tail fact ${i}.`;
// 40 cats: the founders, two directors, and workers under them with roads to their director; 80 long finished tasks.
function town40(){
  const store=new Store(join(mkdtempSync(join(tmpdir(),'prompt-diet-')),'events.jsonl'),config.cats);
  for(const d of ['d1','d2'])store.emit('cat.created',{id:d,name:`Director ${d}`,role:role(0),color:'#fff',icon:'x',manager:'mayor',directs:`project-${d}`});
  for(let i=0;store.state.cats.length<40;i++){
    const boss=i%2?'d2':'d1';
    store.emit('cat.created',{id:`w${i}`,name:`Worker ${i}`,role:role(i),color:'#fff',icon:'x',manager:boss});
    store.emit('road.created',{id:`${boss}:w${i}`,a:boss,b:`w${i}`});
  }
  for(let i=0;i<80;i++)store.emit('task.created',{id:`old${i}`,cat:`w${i%30}`,from:'mayor',text:`Finished assignment ${i}: `+'long brief text '.repeat(40),mode:'demo',status:'done'});
  const town=new Town(store,config);
  store.emit('goal.created',{id:'g1',title:'Grow the shop',success:'Ten orders',status:'paused',mode:'demo',rounds:3,roundsToday:0,day:'2026-11-06',failures:0,log:['Round 3 done'],summary:null,maxRoundsPerDay:null,tokenBudget:null,pausedBy:'owner',note:null,endedBy:null});
  return {store,town};
}
const system=(town:Town,task:any)=>String(town.context(task,0).messages[0].content);

test('the prompt names every cat and gives the asking cat its roads and live tasks, not finished ones', ()=>{
  const {store,town}=town40();
  const root=town.createTask('d1','mayor','Plan the launch','demo');
  const child=town.createTask('w0','d1','Draft the listing','demo',root.id);
  const prompt=system(town,child);
  for(const c of store.state.cats)assert.ok(prompt.includes(`\n${c.id} · ${c.name} · `),`cat line for ${c.id}`);
  assert.match(prompt,/\nYour roads: [^\n]*mayor–w0[^\n]*d1–w0/);
  assert.ok(!prompt.includes('d2–w1'),'another cat’s road stays out');
  assert.ok(prompt.includes(`${child.id} · w0 · running · Draft the listing`)&&prompt.includes(`${root.id} · d1 · running · Plan the launch`),'own and thread tasks are listed');
  assert.ok(!prompt.includes('old0'),'finished tasks stay out');
  assert.match(prompt,/\nd1 · Director d1 · Specialist number 0[^\n]* · manager mayor, directs project-d1 · busy\n/);
  assert.match(prompt,/\nw2 · Worker 2 · [^\n]* · manager d1 · idle\n/);
  assert.match(prompt,/use lookup with a cat id, a task id/);
});

test('on a 40-cat town the prompts stay small, and the Mayor keeps its recruit and goal review briefs', ()=>{
  const {store,town}=town40();
  const mayor=system(town,town.createTask('mayor','owner','Review the town','demo'));
  const worker=system(town,town.createTask('w3','owner','Hello','demo'));
  // Measured on this town when written: Mayor 9,277 chars, worker 5,893; the old JSON blocks alone were 58,896.
  assert.ok(mayor.length<12000,`Mayor prompt is ${mayor.length} chars`);
  assert.ok(worker.length<7000,`worker prompt is ${worker.length} chars`);
  assert.match(mayor,/\nRoads: mayor–d1, mayor–d2, mayor–w0, d1–w0/);
  assert.ok(mayor.includes(town.recruitBrief()),'recruit brief');
  const review=goalReviewBrief(store.state,config.council);
  assert.ok(review.includes('Grow the shop')&&mayor.includes(review),'goal review brief');
  assert.ok(!worker.includes('Grow the shop')&&!worker.includes('Catalogue:'),'workers get neither');
});

test('lookup answers what the prompt dropped: a whole role and a finished task id', ()=>{
  const {town}=town40();
  const prompt=system(town,town.createTask('mayor','owner','Who did the listing work?','demo'));
  assert.ok(!prompt.includes('Tail fact 7.')&&!prompt.includes('old67'),'both facts are out of the prompt');
  const about=lookup(town.memory(),{about:'w7'});
  assert.match(about,/Tail fact 7\./);
  assert.match(about,/\(old67, done\)/);
  assert.match(lookup(town.memory(),{about:'old67'}),/Finished assignment 67/,'a raw task id from the prompt or a lookup works as about');
});

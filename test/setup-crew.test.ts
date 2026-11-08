import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {buildMemory,lookup} from '../src/memory.ts';
import type {Provider} from '../src/provider.ts';

// A clean world: the shipped config, founded with the Mayor alone.
const config={...JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')),maxParallelWork:3};
const fixture=(provider:Provider)=>{
  const store=new Store(join(mkdtempSync(join(tmpdir(),'crew-')),'events.jsonl'),config.cats);
  return {store,town:new Town(store,config,{test:provider})};
};
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Timed out waiting for state transition');}
const reply=(content:string)=>({message:{role:'assistant',content}});
const call=(name:string,args:any)=>({message:{role:'assistant',tool_calls:[{id:'call-'+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}});
const last=(messages:any[])=>String(messages.at(-1)?.content??'');
const RESULT='We picked the cosy-reading niche because three rivals post daily and none post book reviews.';

test('the first message to the Mayor brings in the setup crew, once, and a retired member stays retired', async () => {
  const {store,town}=fixture(async()=>reply(RESULT));
  assert.deepEqual(store.state.cats.map(c=>c.id),['mayor']);
  town.submit('mayor','Start an Instagram','test');
  for(const id of config.setupCrew)assert.ok(store.state.cats.some(c=>c.id===id),`${id} joined`);
  const count=store.state.cats.length;
  await until(()=>store.state.tasks.every(t=>!['running','waiting','waiting_child'].includes(t.status)));
  town.submit('mayor','And another thing','test');
  assert.equal(store.state.cats.length,count,'no second crew');
});

test('after work finishes the recorder files notes with remember, and every cat can look them up', async () => {
  let recorderTools:string[]=[];
  const provider:Provider=async(messages,tools)=>{
    const q=last(messages);
    if(q.startsWith('Record for the town')){recorderTools=tools.map((t:any)=>t.function.name);return call('remember',{title:'Niche: cosy reading',text:'Chosen because rivals post daily but none review books. Source: the Mayor’s round result.'});}
    if(messages.at(-1)?.role==='tool')return reply('Filed one note.');
    return reply(RESULT);
  };
  const {store,town}=fixture(provider);
  const id=town.submit('mayor','Pick a niche','test');
  await until(()=>store.state.events.some(e=>e.type==='memory.noted'));
  const recordTask=store.state.tasks.find(t=>t.record)!;
  assert.equal(recordTask.cat,config.recorder);
  assert.ok(recorderTools.includes('remember'));
  assert.match(recordTask.text,/cosy-reading niche/,'the finished result is handed over');
  await until(()=>recordTask.status==='done'||store.state.tasks.find(t=>t.id===recordTask.id)?.status==='done');
  assert.equal(store.state.tasks.filter(t=>t.record).length,1,'a record task is never itself recorded');
  assert.equal(store.state.tasks.find(t=>t.id===id)?.status,'done');
  const memory=buildMemory(store.state.events);
  // remember also files the note on a wiki page (wiki.ts), and lookup shows it through the page.
  assert.match(lookup(memory,{query:'cosy reading niche'}),/wiki page "Town notes".*Niche: cosy reading/);
  assert.match(memory.brief('mayor'),/Latest town notes: Niche: cosy reading/);
});

test('only memory keepers may remember, and a record task does not take a parallel slot', async () => {
  let refusal='';
  const provider:Provider=async messages=>{
    const q=last(messages);
    if(q==='Mayor, remember this')return call('remember',{title:'x',text:'y'});
    if(messages.at(-1)?.role==='tool'&&!refusal){refusal=String(messages.at(-1).content);return reply(RESULT);}
    if(q.startsWith('Record for the town'))return new Promise(()=>{});
    return reply(RESULT);
  };
  const {store,town}=fixture(provider);
  town.submit('mayor','Mayor, remember this','test');
  await until(()=>!!refusal);
  assert.match(refusal,/Only the town’s memory keepers/);
  await until(()=>store.state.tasks.some(t=>t.record&&t.status==='running'));
  for(const text of ['a','b','c'])town.submit('mayor',text,'test');
  assert.equal(store.state.tasks.filter(t=>t.status==='queued').length,0,'three slots are still free beside a running record task');
});

test('a record task starts clean: earlier recorder replies never reach its prompt', async () => {
  const prompts:string[]=[];
  let rounds=0;
  const provider:Provider=async messages=>{
    const q=last(messages);
    if(q.startsWith('Record for the town')){
      prompts.push(messages.map((m:any)=>String(m.content??'')).join('\n'));
      rounds++;
      return reply('The remember tool is unavailable in this session.');
    }
    return reply(RESULT);
  };
  const {store,town}=fixture(provider);
  town.submit('mayor','Pick a niche','test');
  await until(()=>store.state.tasks.some(t=>t.record&&t.status==='done'));
  town.submit('mayor','Pick another niche','test');
  await until(()=>rounds>=2);
  assert.doesNotMatch(prompts[1],/unavailable/,'the first record reply is not history for the second');
});

test('the recorder is told a repeated note is already saved, and only one copy lands', async () => {
  const results:string[]=[];
  const provider:Provider=async messages=>{
    const q=last(messages);
    if(messages.at(-1)?.role==='tool'){results.push(q);return results.length<2?call('remember',{title:'Niche: cosy reading',text:'Same fact again.'}):reply('Recorded 1 note.');}
    if(q.startsWith('Record for the town'))return call('remember',{title:'Niche: cosy reading',text:'Chosen because rivals post daily.'});
    return reply(RESULT);
  };
  const {store,town}=fixture(provider);
  town.submit('mayor','Pick a niche','test');
  await until(()=>results.length>=2);
  assert.match(results[0],/Recorded “Niche: cosy reading”.*It is saved; do not repeat it\./);
  assert.match(results[1],/already recorded\. Do not record it again/);
  assert.equal(store.state.events.filter(e=>e.type==='memory.noted').length,1);
});

// Item 5.7 of docs/product-plan.md (server side): a root task running when the server stopped resumes from its last model turn boundary.
// A restart is the store closed mid-run (dispose, the old run left hanging) and the journal replayed by a fresh Store and Town.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import type {Provider} from '../src/provider.ts';
import type {ConnectorRuntime} from '../src/connector-types.ts';
import {untilEvery} from './helpers/until.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const SEARCH='mcp__fake__search';
const searchTool={type:'function',function:{name:SEARCH,description:'[Fake] Search.',parameters:{type:'object',properties:{q:{type:'string'}},required:['q']}}};
// A connector runtime that records every call. effect 'public' puts the call through the publish ledger.
function fake(call:()=>Promise<string>,effect='read'){
  const calls:unknown[]=[];
  const rt={calls,toolsFor:(cat:string)=>cat==='scholar'?[searchTool]:[],resolve:(cat:string,name:string)=>cat==='scholar'&&name===SEARCH?{connector:'fake',label:'Fake',tool:'search',permission:'allow',effect}:null,
    call:async(_cat:string,_name:string,args:unknown)=>{calls.push(args);return call();},canUse:()=>false,grantable:()=>false,grant:()=>{},brief:()=>'',skills:()=>[],readSkill:()=>'',roles:()=>[],allowTool:()=>{},
    findPlugins:async()=>[],findPlugin:()=>null,installPlugin:async()=>({name:'',skills:[],connectors:[]})};
  return rt as unknown as ConnectorRuntime&{calls:unknown[]};
}
const never=()=>new Promise<never>(()=>{});
const reply=(content:string)=>({message:{role:'assistant',content}});
const searchCall={message:{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:SEARCH,arguments:'{"q":"cats"}'}}]}};
const isRecorder=(messages:any[])=>String(messages.at(-1)?.content??'').startsWith('Record for the town');
const tools=(messages:any[])=>messages.filter(m=>m.role==='tool').map(m=>String(m.content));
// Turn 1 asks for a search; turn 2 reports what the tool returned, or never answers (the server stops mid-call).
function scripted(hangOnReport=false){
  const seen:any[][]=[];
  const provider:Provider=async messages=>{if(isRecorder(messages))return reply('Nothing new.');seen.push([...messages]);if(!tools(messages).length)return searchCall as any;if(hangOnReport)return never();return reply(`Report: ${tools(messages).join(' | ')}`);};
  return {provider,seen};
}
const until = untilEvery(10);
function open(file:string,provider:Provider,rt:ConnectorRuntime){const store=new Store(file,allRoles(config)),town=new Town(store,config,{test:provider});town.connectors=()=>rt;return {store,town};}
const task=(store:Store,id:string)=>store.state.tasks.find(t=>t.id===id)!;
const ownerMessages=(store:Store)=>store.state.messages.filter(m=>m.from==='owner').length;
const checkpoint=(file:string,id:string)=>join(dirname(file),'checkpoints',`${id}.json`);

test('a task killed mid-run resumes with no new owner message, reuses the recorded tool result and finishes',async t=>{
  const file=join(mkdtempSync(join(tmpdir(),'restart-resume-')),'events.jsonl');
  const rt=fake(async()=>'found it'),first=scripted(true),a=open(file,first.provider,rt);
  const id=a.town.submit('scholar','Search for cats','test');
  await until(()=>first.seen.length===2);
  // Measured: the turn boundary's one write, while the second model call is in flight.
  const bytes=statSync(checkpoint(file,id)).size,saved=JSON.parse(readFileSync(checkpoint(file,id),'utf8'));
  t.diagnostic(`checkpoint after turn 1: ${bytes} bytes, ${saved.messages.length} messages (pretty-printed by writeJsonAtomic), 1 write per turn, no journal event`);
  assert.equal(saved.turn,1);assert.deepEqual(saved.calls.map((c:any)=>c.id),['call-1']);
  const owner=ownerMessages(a.store),events=a.store.state.events.filter(e=>e.type==='task.updated'&&e.data.id===id).length;
  assert.equal(events,0,'a turn boundary adds nothing to the journal');
  a.town.dispose();
  const second=scripted(),b=open(file,second.provider,rt);
  assert.equal(task(b.store,id).status,'running','still running at boot, resumed on the next tick');
  await until(()=>task(b.store,id).status==='done');
  assert.equal(task(b.store,id).result,'Report: found it');
  assert.equal(task(b.store,id).resumed?.turn,1,'the UI can say "Resumed after a restart"');
  assert.equal(ownerMessages(b.store),owner,'no new owner message');
  assert.equal(rt.calls.length,1,'the recorded search is not run again');
  assert.equal(second.seen.length,1,'the model is asked once, from the saved turn');
  assert.equal(existsSync(checkpoint(file,id)),false,'a finished task keeps no checkpoint');
  b.town.dispose();
});

test('a tool call that started but never recorded a result is not replayed blind; a ledgered one takes the unknown path',async()=>{
  for(const effect of ['read','public']){
    const file=join(mkdtempSync(join(tmpdir(),'restart-unknown-')),'events.jsonl');
    const hung=fake(never,effect),first=scripted(),a=open(file,first.provider,hung);
    const id=a.town.submit('scholar','Search for cats','test');
    await until(()=>hung.calls.length===1);
    a.town.dispose();
    const rt=fake(async()=>'found it',effect),second=scripted(),b=open(file,second.provider,rt);
    await until(()=>task(b.store,id).status==='done');
    assert.equal(rt.calls.length,0,`${effect}: the call is not run again`);
    assert.match(tools(second.seen[0]!)[0]!,/server restarted while this call ran, so its outcome is unknown/,`${effect}: the model is told the outcome is unknown`);
    assert.equal(b.store.state.events.filter(e=>e.type==='tool.finished'&&e.data.task===id).length,1,`${effect}: the unknown answer is journaled once`);
    if(effect==='public'){
      assert.deepEqual(Object.values(b.store.state.effects).map(e=>e.status),['unknown']);
      assert.deepEqual(b.store.state.approvals.filter(x=>x.status==='pending').map(x=>x.gate),['effect'],'one owner card for the unknown outcome');
    }
    b.town.dispose();
  }
});

test('a task with no checkpoint still ends interrupted, and a task resumed once without progress is not resumed again',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'restart-none-')),'events.jsonl');
  const rt=fake(async()=>'found it'),first=scripted(true),a=open(file,first.provider,rt);
  const lost=a.town.submit('scholar','Search for cats','test');
  await until(()=>first.seen.length===2);
  a.town.dispose();rmSync(checkpoint(file,lost));
  const b=open(file,scripted().provider,rt);
  assert.equal(task(b.store,lost).status,'interrupted');
  assert.equal(task(b.store,lost).result,'Server restarted during work. Retry runs it again.');
  b.town.dispose();
  // Resumed, and the server stops again before the next turn boundary: the next boot ends it.
  const c1=scripted(true),c=open(file,c1.provider,rt),id=c.town.submit('scholar','Search again','test');
  await until(()=>c1.seen.length===2);c.town.dispose();
  const d1=scripted(true),d=open(file,d1.provider,rt);
  await until(()=>d1.seen.length===1);d.town.dispose();
  assert.equal(task(d.store,id).resumed?.turn,1);
  const e=open(file,scripted().provider,rt);
  assert.equal(task(e.store,id).status,'interrupted');
  e.town.dispose();
});

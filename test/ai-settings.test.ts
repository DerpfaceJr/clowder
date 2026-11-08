import {allRoles} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {checkAi, pickAi, applyCatAi, catAiFromJournal, EFFORTS, normalizeMode} from '../src/ai-options.ts';
import {ModelHub, buildProviders, loadSettings, registerCatAiRoutes, saveSettings} from '../src/models.ts';
import {openAIProvider, mayorTools} from '../src/provider.ts';
import {claudePlanProvider} from '../src/claude-plan.ts';
import {codexPlanProvider} from '../src/codex-plan.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {quests} from '../src/quests.ts';
import {runSeason} from '../src/season.ts';
import {CLI_ENV} from '../src/claude-plan.ts';
// The fake CLIs read these; a real CLI run gets only CLI_ENV from this process's environment (security pass M3).
CLI_ENV.push('CAT_FAKE_LOG');

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const dir=mkdtempSync(join(tmpdir(),'ai-settings-'));
const win=process.platform==='win32';

// Fake CLIs record their argv as JSON in CAT_FAKE_LOG. The claude fake prints a structured action; the codex fake
// writes one to the --output-last-message file, as the real CLI does.
function fakeCli(name:string,body:string){
  const script=join(dir,`${name}.mjs`);
  writeFileSync(script,body);
  const exe=join(dir,win?`${name}.cmd`:name);
  if(win)writeFileSync(exe,`@"${process.execPath}" "${script}" %*\r\n`);
  else{writeFileSync(exe,`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);chmodSync(exe,0o755);}
  return exe;
}
const claudeFake=fakeCli('claude-fake',`import {writeFileSync} from 'node:fs';
const argv=process.argv.slice(2);
writeFileSync(process.env.CAT_FAKE_LOG,JSON.stringify({argv}));
process.stdout.write(JSON.stringify({is_error:false,result:'',structured_output:{action:'pass',args:{note:'ok'}},usage:{input_tokens:1,output_tokens:1},total_cost_usd:0}));
`);
const codexFake=fakeCli('codex-fake',`import {writeFileSync} from 'node:fs';
const argv=process.argv.slice(2);
writeFileSync(process.env.CAT_FAKE_LOG,JSON.stringify({argv}));
const out=argv[argv.indexOf('--output-last-message')+1];
writeFileSync(out,JSON.stringify({action:'pass',args_json:'{"note":"ok"}',text:''}));
`);
const missing=join(dir,'no-such-cli');

test('checkAi accepts the allowed values and rejects everything else', () => {
  assert.deepEqual(checkAi('claude',{model:'sonnet',effort:'max'}),{model:'sonnet',effort:'max'});
  assert.deepEqual(checkAi('local',{model:'qwen3.5:4b',effort:'none'}),{model:'qwen3.5:4b',effort:'none'});
  assert.deepEqual(checkAi('claude',{model:'',effort:null}),{});
  for(const model of ['bad model','a;rm -rf','-x','--dangerous','x'.repeat(121),'',7])
    if(model!=='')assert.throws(()=>checkAi('claude',{model}),/Model names/,String(model));
  assert.throws(()=>checkAi('claude',{effort:'ultra'}),/Effort for claude/);
  assert.throws(()=>checkAi('chatgpt',{effort:'max'}),/Effort for chatgpt/);
  assert.throws(()=>checkAi('hosted',{model:'gpt'}),/API settings/);
  assert.deepEqual(EFFORTS.claude,['low','medium','high','xhigh','max']);
  assert.equal(normalizeMode('plan'),'claude');
});

test('resolution order: cat override, then saved default, then town.config.json', () => {
  assert.deepEqual(pickAi({model:'opus'},{model:'sonnet',effort:'low'},{model:'haiku',effort:'high'}),{model:'opus',effort:'low'});
  assert.deepEqual(pickAi(undefined,{effort:'low'},{model:'haiku'}),{model:'haiku',effort:'low'});
  assert.deepEqual(pickAi(undefined,undefined,{model:'haiku'}),{model:'haiku'});
});

test('cat overrides fold per provider, clear on blank, and tolerate a missing or torn journal', () => {
  let ai=applyCatAi(undefined,{provider:'claude',model:'opus',effort:'high'});
  ai=applyCatAi(ai,{provider:'local',model:'qwen3.5:4b'});
  assert.deepEqual(ai,{claude:{model:'opus',effort:'high'},local:{model:'qwen3.5:4b'}});
  assert.deepEqual(applyCatAi(ai,{provider:'claude'}),{local:{model:'qwen3.5:4b'}});
  const file=join(dir,'journal.jsonl');
  assert.deepEqual(catAiFromJournal(join(dir,'missing.jsonl')),{});
  writeFileSync(file,[
    JSON.stringify({type:'cat.ai',data:{id:'tuna',provider:'claude',model:'opus'}}),
    '{"type":"cat.ai","data":{"id":"tu',
    JSON.stringify({type:'cat.ai.suggested',data:{id:'tuna',suggestion:null}}),
    JSON.stringify({type:'cat.ai',data:{id:'tuna',provider:'claude'}}),
    JSON.stringify({type:'cat.ai',data:{id:'mayor',provider:'chatgpt',effort:'high'}}),
  ].join('\n'));
  assert.deepEqual(catAiFromJournal(file),{tuna:{},mayor:{chatgpt:{effort:'high'}}}); // tuna's blank event cleared its claude override
});

test('settings: bad defaults are rejected by the owner route path, good ones persist, and status shows the resolved model', async () => {
  const file=join(dir,'models.json');
  const hub=new ModelHub({file,config,env:{CAT_CLAUDE:claudeFake,CAT_CODEX:missing,CAT_OLLAMA_BASE:'http://127.0.0.1:9'}});
  await assert.rejects(hub.update({defaults:{claude:{effort:'ultra'}}}),/Effort for claude/);
  await assert.rejects(hub.update({defaults:{claude:{model:'-rf'}}}),/Model names/);
  await assert.rejects(hub.update({defaults:{hosted:{model:'gpt'}}}),/API settings/);
  await assert.rejects(hub.update({defaults:{demo:{effort:'low'}} as any}),/Unknown AI provider/);
  assert.equal(loadSettings(file).defaults,undefined,'a rejected update saves nothing');
  await hub.update({defaults:{claude:{model:'sonnet',effort:'high'},hosted:{effort:'low'}}});
  const status=await hub.status();
  assert.equal(status.claude.name,'Claude plan · sonnet');
  assert.equal(status.claude.ai?.default.effort,'high');
  assert.equal(status.hosted.ai?.default.effort,'low');
  assert.equal(status.chatgpt.name,`ChatGPT plan · ${config.chatgptModel}`,'unset defaults fall back to town.config.json');
  assert.equal(JSON.parse(readFileSync(file,'utf8')).defaults.claude.effort,'high');
  // Clearing returns to the config value.
  await hub.update({defaults:{claude:null}});
  assert.equal((await hub.status()).claude.name,`Claude plan · ${config.planModel}`);
  // A damaged saved value is dropped on load, so that provider falls back to config.
  saveSettings(file,{defaults:{claude:{model:'x y',effort:'max'},chatgpt:{effort:'max'}}} as any);
  assert.equal(loadSettings(file).defaults,undefined);
});

test('Claude argv carries --model and --effort only when set, from the cat override first', async () => {
  const log=join(dir,'claude-argv.json');
  const provider=claudePlanProvider('haiku',60_000,{executable:claudeFake,workdir:join(dir,'w1'),effort:'low'});
  const run=async(ai?:{model?:string;effort?:string})=>{await provider([{role:'user',content:'hi'}],[{type:'function',function:{name:'pass',parameters:{}}}],new AbortController().signal,ai);return JSON.parse(readFileSync(log,'utf8')).argv as string[];};
  process.env.CAT_FAKE_LOG=log;
  const argv=await run();
  assert.equal(argv[argv.indexOf('--model')+1],'haiku');
  assert.equal(argv[argv.indexOf('--effort')+1],'low');
  const override=await run({model:'opus',effort:'max'});
  assert.equal(override[override.indexOf('--model')+1],'opus');
  assert.equal(override[override.indexOf('--effort')+1],'max');
  const bare=claudePlanProvider('haiku',60_000,{executable:claudeFake,workdir:join(dir,'w2')});
  await bare([{role:'user',content:'hi'}],[{type:'function',function:{name:'pass',parameters:{}}}],new AbortController().signal);
  assert.ok(!JSON.parse(readFileSync(log,'utf8')).argv.includes('--effort'));
});

test('Codex argv carries -m and -c model_reasoning_effort only when set', async () => {
  const log=join(dir,'codex-argv.json');
  process.env.CAT_FAKE_LOG=log;
  const provider=codexPlanProvider('gpt-5-codex',60_000,{executable:codexFake,workdir:join(dir,'c1'),effort:'minimal'});
  const tools=[{type:'function',function:{name:'pass',parameters:{}}}];
  await provider([{role:'user',content:'hi'}],tools,new AbortController().signal,{model:'gpt-5',effort:'high'});
  const argv=JSON.parse(readFileSync(log,'utf8')).argv as string[];
  assert.equal(argv[argv.indexOf('--model')+1],'gpt-5');
  assert.equal(argv[argv.indexOf('-c')+1],'model_reasoning_effort=high');
  await provider([{role:'user',content:'hi'}],tools,new AbortController().signal);
  const plain=JSON.parse(readFileSync(log,'utf8')).argv as string[];
  assert.equal(plain[plain.indexOf('--model')+1],'gpt-5-codex');
  assert.equal(plain[plain.indexOf('-c')+1],'model_reasoning_effort=minimal');
});

test('OpenAI-compatible bodies: effort only when set, cat override wins, hosted never inherits localOptions', async () => {
  const bodies:any[]=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=(async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'}}]}),{status:200,headers:{'content-type':'application/json'}});}) as any;
  try{
    const local=openAIProvider('http://127.0.0.1:9/v1','qwen3.5:4b',5000,undefined,{reasoning_effort:'none'});
    await local([{role:'user',content:'a'}],[],new AbortController().signal);
    await local([{role:'user',content:'a'}],[],new AbortController().signal,{model:'llama3:8b',effort:'high'});
    const hosted=openAIProvider('https://api.example.com/v1','m',5000,'k',{});
    await hosted([{role:'user',content:'a'}],[],new AbortController().signal);
    assert.equal(bodies[0].reasoning_effort,'none');
    assert.equal(bodies[0].model,'qwen3.5:4b');
    assert.equal(bodies[1].reasoning_effort,'high');
    assert.equal(bodies[1].model,'llama3:8b');
    assert.ok(!('reasoning_effort' in bodies[2]),'hosted sends no effort unless set');
  }finally{globalThis.fetch=realFetch;}
});

test('buildProviders: the saved local effort beats town.config.json; the config value is the fallback', async () => {
  const bodies:any[]=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=(async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'}}]}),{status:200,headers:{'content-type':'application/json'}});}) as any;
  try{
    const env={CAT_OLLAMA_BASE:'http://127.0.0.1:9'} as any;
    await buildProviders(config,{defaults:{local:{effort:'high'}}} as any,env).local!([{role:'user',content:'a'}],[],new AbortController().signal);
    await buildProviders(config,{} as any,env).local!([{role:'user',content:'a'}],[],new AbortController().signal);
    assert.equal(bodies[0].reasoning_effort,'high');
    assert.equal(bodies[1].reasoning_effort,config.localOptions.reasoning_effort);
  }finally{globalThis.fetch=realFetch;}
});

test('Mayor create_cat: the Mayor decides the model and effort; an unusable choice falls back to the town default', async () => {
  const file=join(dir,'town','events.jsonl');
  const store=new Store(file,allRoles(config));
  const town=new Town(store,config);
  const seen:any[]=[];
  let step=0;
  town.providers.local=async(messages,tools,_signal,ai)=>{
    if(messages[0].content.includes('CAT_ID=mayor')){
      seen.push({tools,ai});
      step++;
      if(step===1)return {message:{role:'assistant',tool_calls:[{id:'c1',type:'function',function:{name:'create_cat',arguments:JSON.stringify({name:'Bad',role:'Checks things',suggestedEffort:'ultra',suggestionReason:'no'})}}]}};
      if(step===2)return {message:{role:'assistant',tool_calls:[{id:'c2',type:'function',function:{name:'create_cat',arguments:JSON.stringify({name:'Tuna',role:'Reviews research',suggestedModel:'sonnet',suggestedEffort:'high',suggestionReason:'Research needs a stronger model.'})}}]}};
      return {message:{role:'assistant',content:'Recruited.'}};
    }
    return {message:{role:'assistant',content:'ok'}};
  };
  town.submit('mayor','Add a reviewer','local');
  const until=async(fn:()=>boolean)=>{for(let i=0;i<300&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'timed out');};
  await until(()=>store.state.tasks.some(t=>t.cat==='mayor'&&['done','failed'].includes(t.status)));
  // The Mayor was offered only the efforts of its own provider.
  const create=seen[0].tools.find((t:any)=>t.function.name==='create_cat');
  assert.deepEqual(create.function.parameters.properties.suggestedEffort.enum,EFFORTS.local);
  const bad=store.state.cats.find(c=>c.id==='bad')!;
  assert.ok(bad,'an unusable choice still recruits the cat');
  assert.equal(bad.ai,undefined,'and it keeps the town default');
  assert.equal(town.aiFor('bad','local'),undefined);
  const tuna=store.state.cats.find(c=>c.id==='tuna')!;
  assert.deepEqual(town.aiFor('tuna','local'),{model:'sonnet',effort:'high'},'the Mayor choice applies at once');
  assert.equal((tuna.aiSuggestion as any)?.applied,true,'the reason stays visible to the owner');
  assert.equal(tuna.aiSuggestion?.reason,'Research needs a stronger model.');
  assert.throws(()=>town.answerCatAi('mayor','tuna',false),/owner/);
  town.answerCatAi('owner','tuna',false);
  assert.equal(store.state.cats.find(c=>c.id==='tuna')!.aiSuggestion,null,'Got it clears the note only');
  assert.deepEqual(town.aiFor('tuna','local'),{model:'sonnet',effort:'high'});
  // Replay from the journal gives the same state.
  const reread=new Store(file,[]);
  assert.deepEqual(reread.state.cats.find(c=>c.id==='tuna')!.ai,{local:{model:'sonnet',effort:'high'}});
  // The sandbox override is rejected before any write.
  assert.throws(()=>town.setCatAi('owner','tuna','local',{effort:'max'}),/Effort for local/);
  assert.throws(()=>town.setCatAi('mayor','tuna','local',{effort:'low'}),/owner/);
  town.setCatAi('owner','tuna','local',{model:null,effort:null});
  assert.equal(town.aiFor('tuna','local'),undefined);
});

test('mayorTools adds suggestion fields only for a model provider', () => {
  assert.equal(mayorTools('demo').find((t:any)=>t.function.name==='create_cat')!.function.parameters.properties.suggestedModel,undefined);
  const hosted=mayorTools('hosted').find((t:any)=>t.function.name==='create_cat')!.function.parameters.properties;
  assert.deepEqual(hosted.suggestedEffort.enum,EFFORTS.hosted);
  assert.match(mayorTools('claude').find((t:any)=>t.function.name==='create_cat')!.function.description,/lighter one.*applies at once/);
});

test('the Mayor suggestion quest appears for the owner only', async () => {
  const file=join(dir,'quest','events.jsonl');
  const store=new Store(file,allRoles(config));
  store.emit('cat.created',{id:'tuna',name:'Tuna',role:'Reviews',group:'main',home:{x:1,z:1,style:'x'},color:'#000',icon:'T'});
  store.emit('cat.ai.suggested',{id:'tuna',suggestion:{provider:'claude',model:'opus',effort:'max',reason:'Planning-heavy role.'}});
  const now=new Date('2026-10-25T12:00:00.000Z');
  const input={state:store.state,projects:[],capabilities:[],seasons:[],config:config.quests,now};
  const owner=quests({...input,models:{}}).find(q=>q.id==='ai-suggestion:tuna');
  assert.equal(owner?.rank,'E');
  assert.equal(owner?.title,"Review the Mayor's model suggestion for Tuna");
  assert.equal(owner?.action.cat,'tuna');
  assert.equal(quests({...input,models:null}).some(q=>q.id==='ai-suggestion:tuna'),false,'viewers do not see it');
});

test('cat AI routes are owner-only: proxied loopback gets 403, the owner gets the change', async () => {
  const store=new Store(join(mkdtempSync(join(tmpdir(),'ai-route-')),'events.jsonl'),allRoles(config));
  const town=new Town(store,config);
  const app=Fastify();
  installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  registerCatAiRoutes(app,town);
  const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  const body={provider:'claude',effort:'high'};
  assert.equal((await app.inject({method:'POST',url:'/api/cats/scholar/ai',headers:{...owner,'x-forwarded-for':'127.0.0.1'},payload:body})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/cats/scholar/ai/suggestion',headers:{...owner,'x-forwarded-for':'127.0.0.1'},payload:{accept:true}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/cats/scholar/ai',remoteAddress:'192.168.1.21',headers:{host:'192.168.1.21:8787','x-town-action':'owner'},payload:body})).statusCode,403);
  const bad=await app.inject({method:'POST',url:'/api/cats/scholar/ai',headers:owner,payload:{provider:'claude',effort:'ultra'}});
  assert.equal(bad.statusCode,400);
  const ok=await app.inject({method:'POST',url:'/api/cats/scholar/ai',headers:owner,payload:body});
  assert.equal(ok.statusCode,200);
  assert.deepEqual(store.state.cats.find(c=>c.id==='scholar')!.ai,{claude:{effort:'high'}});
  await app.close();
});

test('runSeason passes the cat override to the provider and leaves other cats on the default', async () => {
  const dataDir=mkdtempSync(join(tmpdir(),'ai-season-'));
  // cat.ai lives in the town journal, which the season reads.
  writeFileSync(join(dataDir,'events.jsonl'),JSON.stringify({type:'cat.ai',data:{id:'scholar',provider:'local',model:'llama3:8b',effort:'low'}})+'\n');
  const calls:{cat:string;ai:any}[]=[];
  const provider=async(messages:any[],_tools:any[],_signal:AbortSignal,ai?:any)=>{
    const id=/cat id: (\w+)/.exec(messages[0].content)?.[1]??'?';
    calls.push({cat:id,ai});
    return {message:{role:'assistant',content:'',tool_calls:[{id:'p',type:'function',function:{name:'pass',arguments:JSON.stringify({note:'test'})}}]}};
  };
  await runSeason({name:'ai',mode:'local',seed:1,days:1,dataDir,config:{...config,cats:allRoles(config)},provider:provider as any,stopAfterTicks:1,jev:null,workshop:null});
  const scholar=calls.find(c=>c.cat==='scholar');
  assert.ok(scholar,'scholar was asked');
  assert.deepEqual(scholar!.ai,{model:'llama3:8b',effort:'low'});
  assert.ok(calls.length>1&&calls.filter(c=>c.cat!=='scholar').every(c=>c.ai===undefined));
});

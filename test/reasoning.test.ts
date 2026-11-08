import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {checkTownDefault} from '../src/ai-options.ts';
import {allRoles} from '../src/roles.ts';
import {ModelHub, loadSettings, modelList, providerStatus, registerCatAiRoutes, registerModelRoutes} from '../src/models.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tmp=()=>mkdtempSync(join(tmpdir(),'reasoning-'));

// A stand-in for Ollama's /api/tags with two installed models. The CLIs point at paths that do not exist, so they read as not installed.
async function fakeOllama(){
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{name:'qwen3.5:4b'},{name:'llama3:8b'}]}));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',()=>done()));
  const port=(server.address() as {port:number}).port;
  return {base:`http://127.0.0.1:${port}`,close:()=>new Promise<void>(done=>server.close(()=>done()))};
}
const hubFor=(file:string,base:string)=>new ModelHub({file,config,env:{CAT_OLLAMA_BASE:base,CAT_CLAUDE:join(tmp(),'no-claude'),CAT_CODEX:join(tmp(),'no-codex'),CAT_PROBE_MS:'60000'}});

test('the Reasoning list is built from the status: installed Ollama models, usable providers only', async () => {
  const ollama=await fakeOllama();
  try{
    const hub=hubFor(join(tmp(),'models.json'),ollama.base);
    const status=await hub.status();
    assert.deepEqual(status.local.ai.models,['qwen3.5:4b','llama3:8b'],'the one list of Ollama models');
    const list=modelList(status);
    // Claude, ChatGPT and the API key are off here, so only the demonstration and Local AI are offered.
    assert.deepEqual(list.map(m=>m.id),['demo','local']);
    assert.equal(list[1]!.label,'Local AI');
    assert.deepEqual(list[1]!.models,['qwen3.5:4b','llama3:8b']);
    assert.deepEqual((await hub.list()).map(m=>m.id),['demo','local']);
    assert.equal(providerStatus(status).claude.enabled,false);
  }finally{await ollama.close();}
});

test('Claude and ChatGPT lists are the documented names plus the configured default, and the API key lists its model', async () => {
  const hub=hubFor(join(tmp(),'models.json'),'http://127.0.0.1:9');
  const status=await hub.status();
  assert.deepEqual(status.claude.ai.models,['haiku','sonnet','opus','fable']);
  assert.deepEqual(status.chatgpt.ai.models,['gpt-5-codex'],'unverified ChatGPT model names are not listed; only the configured default');
  await hub.update({claude:{enabled:true},chatgpt:{enabled:true},hosted:{base:'https://api.example.com/v1',model:'my-model',key:'k'.repeat(20)}});
  const list=modelList(await hub.status());
  // Claude and ChatGPT are enabled but not installed here, so they stay out of the list.
  assert.deepEqual(list.map(m=>m.id),['demo','hosted']);
  assert.deepEqual(list.find(m=>m.id==='hosted')!.models,['my-model']);
  assert.equal(list.find(m=>m.id==='hosted')!.label,'API key');
});

test('turning Local AI off removes it from the list, the providers and the town default; turning it back on restores it', async () => {
  const ollama=await fakeOllama();
  try{
    const file=join(tmp(),'models.json');
    const hub=hubFor(file,ollama.base);
    await hub.update({townDefault:{provider:'local',model:'llama3:8b'}});
    assert.deepEqual(hub.townDefault(),{provider:'local',model:'llama3:8b'});
    await hub.update({local:{enabled:false}});
    assert.equal(hub.providers.local,undefined);
    assert.deepEqual((await hub.list()).map(m=>m.id),['demo']);
    assert.equal((await hub.status()).local.available,false);
    assert.equal(hub.townDefault(),null,'a town default on a switched-off provider is not used');
    assert.equal((await hub.status()).townDefault!.usable,false);
    assert.equal(loadSettings(file).local?.enabled,false,'saved in models.json');
    await hub.update({local:{enabled:true}});
    assert.ok(hub.providers.local);
    assert.deepEqual((await hub.list()).map(m=>m.id),['demo','local']);
  }finally{await ollama.close();}
});

test('townDefault is validated, saved in models.json, and a damaged saved value is dropped', async () => {
  const file=join(tmp(),'models.json');
  const hub=hubFor(file,'http://127.0.0.1:9');
  await assert.rejects(hub.update({townDefault:{provider:'nope' as any}}),/Choose a provider/);
  await assert.rejects(hub.update({townDefault:{provider:'hosted',model:'x'}}),/API settings/);
  await assert.rejects(hub.update({townDefault:{provider:'local',effort:'ultra'}}),/Effort for local/);
  await assert.rejects(hub.update({townDefault:{provider:'local',model:'bad name!'}}),/Model names/);
  await hub.update({townDefault:{provider:'claude',model:'opus',effort:'high'}});
  assert.deepEqual(loadSettings(file).townDefault,{provider:'claude',model:'opus',effort:'high'});
  assert.deepEqual(checkTownDefault({provider:'hosted',effort:'low'}),{provider:'hosted',effort:'low'});
  writeFileSync(file,JSON.stringify({townDefault:{provider:'local',model:'bad name!'}}));
  assert.equal(loadSettings(file).townDefault,undefined,'a bad saved value falls back to the chat choice');
  await hub.update({townDefault:null});
  assert.equal(loadSettings(file).townDefault,undefined);
});

test('the town default and the task choices pick the model per call, with cat overrides and children inheriting', () => {
  const store=new Store(join(tmp(),'events.jsonl'),allRoles(config));
  const town=new Town(store,config,{});
  town.townDefault=()=>({provider:'local',model:'llama3:8b',effort:'low'});
  // A new task with no choice gets the town default for its provider.
  assert.deepEqual(town.aiFor('scholar','local'),{model:'llama3:8b',effort:'low'});
  assert.equal(town.aiFor('scholar','claude'),undefined,'the default is for one provider only');
  assert.equal(town.aiFor('scholar','demo'),undefined);
  // A cat's own model wins over the default; the default still fills the effort it leaves out.
  town.setCatAi('owner','scholar','local',{model:'qwen3.5:4b'});
  assert.deepEqual(town.aiFor('scholar','local'),{model:'qwen3.5:4b',effort:'low'});
  // A root task's own choice (the owner's Reasoning pick) beats the cat's override.
  assert.deepEqual(town.aiFor('scholar','local',{ai:{model:'gemma2'}}),{model:'gemma2',effort:'low'});
  // A delegated child takes its parent's model, but a cat's own override still wins for that cat.
  assert.deepEqual(town.aiFor('mayor','local',{parent:'root',ai:{model:'parent-model'}}),{model:'parent-model',effort:'low'});
  assert.deepEqual(town.aiFor('scholar','local',{parent:'root',ai:{model:'parent-model'}}),{model:'qwen3.5:4b',effort:'low'});
});

test('a chat choice is stored on its task; a message with no choice stores none', () => {
  const stub={local:async()=>({message:{role:'assistant',content:'ok'}})} as any;
  const fresh=()=>{const store=new Store(join(tmp(),'events.jsonl'),allRoles(config));const town=new Town(store,config,stub);town.townDefault=()=>null;return {store,town};};
  let {store,town}=fresh();
  town.submit('mayor','hello there','local',{model:'llama3:8b'});
  assert.deepEqual(store.state.tasks.at(-1)!.ai,{model:'llama3:8b'});
  ({store,town}=fresh());
  town.submit('mayor','plain message','local');
  assert.equal(store.state.tasks.at(-1)!.ai,undefined);
  ({store,town}=fresh());
  assert.throws(()=>town.submit('mayor','bad model','local',{model:'a b'}),/Model names/);
  assert.equal(store.state.tasks.length,0,'a rejected message creates no task');
  // Demonstration takes no model: a choice given with it is ignored.
  ({store,town}=fresh());
  town.submit('mayor','demo message','demo',{model:'llama3:8b'});
  assert.equal(store.state.tasks.at(-1)!.ai,undefined);
});

test('a goal keeps the chat choice on the goal record', () => {
  const store=new Store(join(tmp(),'events.jsonl'),allRoles(config));
  const town=new Town(store,config,{local:async()=>({message:{role:'assistant',content:'ok'}})} as any);
  town.townDefault=()=>null;
  town.submit('mayor','Write a short plan','local',{goal:true,model:'llama3:8b'});
  assert.deepEqual(store.state.goals.at(-1)!.ai,{model:'llama3:8b'});
});

test('the cat AI reset clears an override, and the owner-only routes return 403 to proxied and LAN devices', async () => {
  const hub=hubFor(join(tmp(),'models.json'),'http://127.0.0.1:9');
  const store=new Store(join(tmp(),'events.jsonl'),allRoles(config));
  const town=new Town(store,config);
  const app=Fastify();
  installAccess(app,false,[],8787,undefined,undefined,'test-owner');
  registerModelRoutes(app,hub);
  registerCatAiRoutes(app,town);
  const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  const proxied={...owner,'x-forwarded-for':'127.0.0.1'};
  const lan={host:'192.168.1.21:8787','x-town-action':'owner'};
  for(const payload of [{local:{enabled:false}},{townDefault:{provider:'claude'}}]){
    assert.equal((await app.inject({method:'POST',url:'/api/models/settings',headers:proxied,payload})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/models/settings',remoteAddress:'192.168.1.21',headers:lan,payload})).statusCode,403);
  }
  assert.equal((await app.inject({method:'POST',url:'/api/models/settings',headers:owner,payload:{townDefault:{provider:'bogus'}}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/models/settings',headers:owner,payload:{local:{enabled:false}}})).statusCode,200);
  assert.equal(hub.settings.local?.enabled,false);
  // The per-cat reset: set an override, then clear it through the same route the client calls for each cat.
  assert.equal((await app.inject({method:'POST',url:'/api/cats/scholar/ai',headers:owner,payload:{provider:'claude',effort:'high'}})).statusCode,200);
  assert.deepEqual(store.state.cats.find(c=>c.id==='scholar')!.ai,{claude:{effort:'high'}});
  assert.equal((await app.inject({method:'POST',url:'/api/cats/scholar/ai',headers:proxied,payload:{provider:'claude',model:null,effort:null}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/cats/scholar/ai',headers:owner,payload:{provider:'claude',model:null,effort:null}})).statusCode,200);
  assert.equal(store.state.cats.find(c=>c.id==='scholar')!.ai?.claude,undefined);
  await app.close();
});

test('a slow Ollama keeps the last list it gave, so Local AI stays in the Reasoning list', async () => {
  let calls=0;
  const server=createServer((_req,res)=>{if(++calls>1)return;res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{name:'qwen3.5:4b'}]}));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',()=>done()));
  try{
    const hub=hubFor(join(tmp(),'models.json'),`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    assert.deepEqual((await hub.status()).local.ai.models,['qwen3.5:4b']);
    await hub.update({});
    const later=await hub.status();
    assert.ok(calls>1,'the second check reached Ollama and timed out');
    assert.deepEqual(later.local.ai.models,['qwen3.5:4b']);
    assert.deepEqual(modelList(later).map(m=>m.id),['demo','local']);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

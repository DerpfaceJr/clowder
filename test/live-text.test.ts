// Plan 8.3: OpenAI-compatible providers stream, with a non-streaming fallback; the text so far reaches owner pages as transient delta frames,
// redacted, and never the journal. A streamed run journals the same events in the same order as a non-streamed one.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {openAIProvider} from '../src/provider.ts';
import {fixture,until} from './live-helpers.ts';

type Mode={stream:'sse'|'refuse'|'json';chunks:string[];calls?:any[]};
const seen:any[]=[];let mode:Mode={stream:'sse',chunks:[]};
const server=createServer((req:IncomingMessage,res:ServerResponse)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=JSON.parse(raw);seen.push(body);
  const text=mode.chunks.join(''),calls=mode.calls;
  const usage={prompt_tokens:11,completion_tokens:7,total_tokens:18};
  if(body.stream&&mode.stream==='refuse'){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"stream not supported"}');return;}
  if(!body.stream||mode.stream==='json'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:text||null,...(calls?{tool_calls:calls}:{})}}],usage}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const frame=(delta:any)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`);
  frame({role:'assistant'});
  for(const c of mode.chunks)frame({content:c});
  // A tool call arrives in pieces: id and name first, then the arguments split in two.
  for(const [index,c] of (calls??[]).entries()){const a=c.function.arguments;frame({tool_calls:[{index,id:c.id,type:'function',function:{name:c.function.name,arguments:''}}]});frame({tool_calls:[{index,function:{arguments:a.slice(0,3)}}]});frame({tool_calls:[{index,function:{arguments:a.slice(3)}}]});}
  res.write(`data: ${JSON.stringify({choices:[],usage})}\n\n`);res.end('data: [DONE]\n\n');
});});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
after(()=>server.close());
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const ask=(provider=openAIProvider(base,'m',10_000),live?:(t:string)=>void)=>provider([{role:'user',content:'hi'}],[],new AbortController().signal,undefined,live);

test('a streamed reply is the same message and usage as the non-streamed one, and its text arrives as it grows', async()=>{
  const lookup={id:'call_1',type:'function',function:{name:'lookup',arguments:'{"query":"harbour"}'}};
  for(const calls of [undefined,[lookup]]){
    mode={stream:'json',chunks:['Hel','lo ','there'],calls};const plain=await ask();
    mode={stream:'sse',chunks:['Hel','lo ','there'],calls};const texts:string[]=[];const streamed=await ask(undefined,t=>texts.push(t));
    assert.deepEqual(streamed,plain);
    assert.deepEqual(texts,['Hel','Hello ','Hello there']);
    assert.equal(seen.at(-1).stream,true);
  }
});

test('a provider that refuses stream:true is asked without it, and is not asked to stream again', async()=>{
  mode={stream:'refuse',chunks:['Fine.']};seen.length=0;
  const provider=openAIProvider(base,'m',10_000);
  assert.deepEqual((await ask(provider)).message,{role:'assistant',content:'Fine.'});
  assert.deepEqual(seen.map(b=>b.stream),[true,false]);
  assert.equal(seen[1].stream_options,undefined);
  await ask(provider);
  assert.deepEqual(seen.map(b=>b.stream),[true,false,false]);
});

test('a streamed run journals the same events in the same order as a non-streamed run, and sends delta frames to the owner only', async()=>{
  const run=async(stream:'sse'|'json')=>{
    const f=fixture({test:openAIProvider(base,'m',10_000)});
    mode={stream,chunks:['The harbour ','festival is ','on Friday.']};
    f.town.live=frame=>f.feed.transient(frame);
    f.town.submit('mayor','When is the festival?','test');
    await until(()=>f.store.state.tasks[0]?.status==='done');
    return {...f,names:f.store.state.events.map(e=>e.type)};
  };
  const plain=await run('json'),streamed=await run('sse');
  assert.deepEqual(streamed.names,plain.names);
  const deltas=streamed.owner.filter(f=>f.delta);
  assert.ok(deltas.some(f=>f.delta.text==='The harbour festival is on Friday.'),JSON.stringify(deltas));
  assert.deepEqual(deltas.at(-1).delta,{task:streamed.store.state.tasks[0].id,cat:'mayor',done:true});
  assert.ok(!streamed.viewer.some(f=>f.delta||f.activity));
  assert.equal(streamed.lines(),streamed.store.state.events.length);
});

test('a saved secret value never appears in a frame, even split across chunks', async()=>{
  const secret='sk-live-Secret-Value-9f8e7d6c5b4a';
  const f=fixture({test:openAIProvider(base,'m',10_000)});
  f.town.secrets=()=>[secret,'other-saved-key'];
  // Split mid-value, so no single chunk holds it; the 20+ letter-and-digit rule masks a token-like run too.
  mode={stream:'sse',chunks:['Your key is sk-live-Sec','ret-Value-9f8e7d6c5b4a',' and the id is abc123def456ghi789jkl0 ok.']};
  f.town.live=frame=>f.feed.transient(frame);
  f.town.submit('mayor','Show my key','test');
  await until(()=>f.store.state.tasks[0]?.status==='done');
  const live=f.owner.filter(x=>x.delta||x.activity).map(x=>JSON.stringify(x));
  assert.ok(live.some(x=>x.includes('Your key is')),live.join('\n'));
  for(let k=8;k<=secret.length;k++)assert.ok(!live.some(x=>x.includes(secret.slice(0,k))),`a frame shows ${k} characters of the secret`);
  assert.ok(!live.some(x=>x.includes('abc123def456ghi789jkl0')));
  assert.ok(live.some(x=>x.includes('ok.')),'the text after them still streams');
});

test('a model call that streams nothing sends a heartbeat while it waits', async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const f=fixture({test:async()=>{await gate;return {message:{role:'assistant',content:'Done.'}};}});
  f.town.heartbeatMs=30;f.town.live=frame=>f.feed.transient(frame);
  f.town.submit('mayor','Think hard','test');
  await until(()=>f.owner.filter(x=>x.delta&&!x.delta.text&&!x.delta.done).length>=2);
  release();
  await until(()=>f.store.state.tasks[0]?.status==='done');
  assert.ok(f.owner.at(-1).delta?.done||f.owner.some(x=>x.delta?.done));
});

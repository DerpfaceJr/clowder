import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import Fastify,{type FastifyInstance} from 'fastify';
import {pairLink,pairQrSvg,PULL_MODEL,registerSetupRoutes} from '../src/setup-routes.ts';

const owner={host:'localhost:8787','x-town-action':'owner'};
const DEFAULT_MODEL='qwen3.5:4b';

// A real HTTP server standing in for Ollama. Each request is recorded; the handler decides what the stream says.
type Handler=(req:IncomingMessage,res:ServerResponse,body:any)=>void|Promise<void>;
async function fakeOllama(handler:Handler){
  const seen:any[]=[];
  const server=createServer((req,res)=>{
    let raw='';
    req.on('data',chunk=>{raw+=chunk;});
    req.on('end',()=>{
      const body=raw?JSON.parse(raw):null;
      seen.push({method:req.method,url:req.url,body});
      void Promise.resolve(handler(req,res,body)).catch(()=>res.destroy());
    });
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',()=>done()));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {base,seen,close:()=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());})};
}
const ndjson=(res:ServerResponse,lines:object[],end=true)=>{
  res.writeHead(200,{'Content-Type':'application/x-ndjson'});
  for(const line of lines)res.write(JSON.stringify(line)+'\n');
  if(end)res.end();
};
// A stream that stays open until the test releases it, so the job can be seen while it runs.
function held(lines:object[]){
  let release!:()=>void;
  const gate=new Promise<void>(done=>{release=done;});
  const handler:Handler=(_req,res)=>{
    ndjson(res,lines,false);
    void gate.then(()=>{res.write(JSON.stringify({status:'success'})+'\n');res.end();});
  };
  return {handler,release};
}

async function appFor(base:string){
  const app=Fastify({logger:false});
  registerSetupRoutes(app,{ollamaBase:()=>base,defaultModel:()=>DEFAULT_MODEL});
  await app.ready();
  return app;
}
async function jobOf(app:FastifyInstance){
  const res=await app.inject({method:'GET',url:'/api/setup/ollama-pull',headers:owner});
  return res.json().job;
}
async function waitFor(app:FastifyInstance,ready:(job:any)=>boolean){
  for(let i=0;i<300;i++){
    const job=await jobOf(app);
    if(job&&ready(job))return job;
    await new Promise(done=>setTimeout(done,20));
  }
  throw new Error('timed out waiting for the job');
}
const start=(app:FastifyInstance,model?:string)=>app.inject({method:'POST',url:'/api/setup/ollama-pull',headers:owner,payload:model===undefined?{}:{model}});

test('pull streams Ollama progress into one job and ends done', async () => {
  const ollama=await fakeOllama((_req,res)=>ndjson(res,[
    {status:'pulling manifest'},
    {status:'downloading',digest:'sha256:a',total:100,completed:40},
    {status:'downloading',digest:'sha256:a',total:100,completed:100},
    {status:'success'},
  ]));
  const app=await appFor(ollama.base);
  try {
    const res=await start(app,DEFAULT_MODEL);
    assert.equal(res.statusCode,200);
    assert.equal(res.json().job.status,'running');
    const job=await waitFor(app,j=>j.status!=='running');
    assert.deepEqual({status:job.status,model:job.model,completed:job.completed,total:job.total,error:job.error},{status:'done',model:DEFAULT_MODEL,completed:100,total:100,error:null});
    assert.deepEqual(ollama.seen[0],{method:'POST',url:'/api/pull',body:{model:DEFAULT_MODEL,stream:true}});
  } finally {
    await app.close();
    await ollama.close();
  }
});

test('a missing model name uses the configured default, and progress adds up across layers', async () => {
  const gate=held([{status:'downloading',digest:'sha256:a',total:100,completed:50},{status:'downloading',digest:'sha256:b',total:300,completed:10}]);
  const ollama=await fakeOllama(gate.handler);
  const app=await appFor(ollama.base);
  try {
    await start(app);
    await waitFor(app,j=>j.total===400||ollama.seen.length>0);
    assert.equal(ollama.seen[0].body.model,DEFAULT_MODEL);
    const mid=await waitFor(app,j=>j.total===400);
    assert.equal(mid.completed,60);
    assert.equal(mid.status,'running');
    gate.release();
    const done=await waitFor(app,j=>j.status!=='running');
    assert.equal(done.status,'done');
    assert.equal(done.completed,done.total);
  } finally {
    gate.release();
    await app.close();
    await ollama.close();
  }
});

test('one job at a time: another model is refused, the same model returns the running job', async () => {
  const gate=held([{status:'downloading',digest:'sha256:a',total:10,completed:5}]);
  const ollama=await fakeOllama((req,res,body)=>{
    if(body.model==='qwen3.5:4b')return gate.handler(req,res,body);
    ndjson(res,[{status:'success'}]);
  });
  const app=await appFor(ollama.base);
  try {
    const first=await start(app,DEFAULT_MODEL);
    const other=await start(app,'llama3.2:3b');
    assert.equal(other.statusCode,409);
    assert.equal(other.json().job.model,DEFAULT_MODEL);
    const same=await start(app,DEFAULT_MODEL);
    assert.equal(same.statusCode,200);
    assert.equal(same.json().job.model,first.json().job.model);
    gate.release();
    await waitFor(app,j=>j.status!=='running');
    const next=await start(app,'llama3.2:3b');
    assert.equal(next.statusCode,200);
    assert.equal(next.json().job.model,'llama3.2:3b');
    await waitFor(app,j=>j.status==='done'&&j.model==='llama3.2:3b');
  } finally {
    gate.release();
    await app.close();
    await ollama.close();
  }
});

test('an error line from Ollama fails the job with its text', async () => {
  const ollama=await fakeOllama((_req,res)=>ndjson(res,[{status:'pulling manifest'},{error:'pull model manifest: file does not exist'}]));
  const app=await appFor(ollama.base);
  try {
    await start(app,DEFAULT_MODEL);
    const job=await waitFor(app,j=>j.status!=='running');
    assert.equal(job.status,'failed');
    assert.equal(job.error,'pull model manifest: file does not exist');
  } finally {
    await app.close();
    await ollama.close();
  }
});

test('a stream that ends before success is a failed job', async () => {
  const ollama=await fakeOllama((_req,res)=>ndjson(res,[{status:'downloading',digest:'sha256:a',total:10,completed:3}]));
  const app=await appFor(ollama.base);
  try {
    await start(app,DEFAULT_MODEL);
    const job=await waitFor(app,j=>j.status!=='running');
    assert.equal(job.status,'failed');
    assert.equal(job.error,'The download stopped before it finished.');
  } finally {
    await app.close();
    await ollama.close();
  }
});

test('Ollama not answering fails the job in words, never as a crash', async () => {
  const closed=await fakeOllama(()=>{});
  const base=closed.base;
  await closed.close();
  const app=await appFor(base);
  try {
    const res=await start(app,DEFAULT_MODEL);
    assert.equal(res.statusCode,200);
    const job=await waitFor(app,j=>j.status!=='running');
    assert.equal(job.status,'failed');
    assert.match(job.error,/Ollama is not answering/);
  } finally {
    await app.close();
  }
});

test('bad model names are refused, and only the owner can start or read a pull', async () => {
  const ollama=await fakeOllama((_req,res)=>ndjson(res,[{status:'success'}]));
  const app=await appFor(ollama.base);
  try {
    for(const bad of ['','a b','qwen;rm','x'.repeat(81),'qwené']){
      const res=await start(app,bad);
      assert.equal(res.statusCode,400,`model ${JSON.stringify(bad)}`);
    }
    assert.equal(PULL_MODEL.test('qwen3.5:4b'),true);
    assert.equal(PULL_MODEL.test('hf.co/org/model:q4'),true);
    const remote=await app.inject({method:'POST',url:'/api/setup/ollama-pull',headers:{host:'town.example.com'},payload:{model:DEFAULT_MODEL}});
    assert.equal(remote.statusCode,403);
    const read=await app.inject({method:'GET',url:'/api/setup/ollama-pull',headers:{host:'town.example.com'}});
    assert.equal(read.statusCode,403);
    assert.equal(ollama.seen.length,0);
  } finally {
    await app.close();
    await ollama.close();
  }
});

test('the pairing link keeps the code in the fragment, and the QR is a plain SVG with no script or references', () => {
  const link=pairLink('https://town.example.com','ABCD-EFGH');
  assert.equal(link,'https://town.example.com/#pair=ABCD-EFGH');
  assert.equal(link.includes('?'),false);
  const svg=pairQrSvg(link);
  assert.match(svg,/^<svg/);
  assert.equal(/<script/i.test(svg),false);
  assert.equal(/\b(href|src)=/.test(svg),false);
  assert.match(pairQrSvg(pairLink('https://town.example.com','ABCD-EFGH-IJKL-MNOP-QRST-UVWX')),/^<svg/);
});

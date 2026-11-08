import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {buildAdapters, checkMedia, moneyPrinterAdapter, parseLocalBase, runtimeFor} from '../src/media.ts';

// A stand-in for MoneyPrinterTurbo's API: the create, poll and file routes from the pinned commit in src/media.ts.
type Opts={pollsBeforeDone?:number;failWith?:string;videoPath?:string;redirectVideo?:boolean};
const MP4=Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypisom'),Buffer.alloc(64,7)]);
async function fakeMoneyPrinter(o:Opts={}){
  const seen:{method:string;url:string;key:string|undefined;body?:any}[]=[];
  let polls=0;
  let base='';
  const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
    const chunks:Buffer[]=[];
    for await(const c of req)chunks.push(c as Buffer);
    const text=Buffer.concat(chunks).toString('utf8');
    const key=req.headers['x-api-key'] as string|undefined;
    seen.push({method:req.method??'',url:req.url??'',key,body:text?JSON.parse(text):undefined});
    const send=(code:number,body:unknown)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    if(req.method==='POST'&&req.url==='/api/v1/videos')return send(200,{status:200,data:{task_id:'task-1',request_id:'r',params:{}}});
    if(req.method==='GET'&&req.url==='/api/v1/tasks/task-1'){
      polls++;
      if(polls<=(o.pollsBeforeDone??1))return send(200,{status:200,data:{task_id:'task-1',state:4,progress:40}});
      if(o.failWith)return send(200,{status:200,data:{task_id:'task-1',state:-1,error:o.failWith}});
      return send(200,{status:200,data:{task_id:'task-1',state:1,progress:100,videos:[o.videoPath??'/tasks/task-1/final-1.mp4']}});
    }
    if(req.method==='GET'&&req.url==='/tasks/task-1/final-1.mp4'){
      if(o.redirectVideo){res.writeHead(302,{location:`${base}/elsewhere.mp4`});return res.end();}
      res.writeHead(200,{'content-type':'video/mp4'});return res.end(MP4);
    }
    send(404,{status:404});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {base,seen,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

test('MoneyPrinterTurbo flow: create, poll until done, then download the mp4', async()=>{
  const mp=await fakeMoneyPrinter({pollsBeforeDone:2});
  try{
    const adapter=moneyPrinterAdapter({base:mp.base,apiKey:'secret-key',timeoutMs:5000});
    const runtime=runtimeFor([adapter],{pollMs:1});
    const file=await runtime.generate({prompt:'a cat in town',kind:'video'},new AbortController().signal);
    assert.deepEqual(file.bytes,MP4);
    assert.equal(file.adapter,'moneyprinter');
    assert.deepEqual(mp.seen[0].body.video_subject,'a cat in town');
    assert.equal(mp.seen.filter(s=>s.method==='GET'&&s.url==='/api/v1/tasks/task-1').length,3);
    assert.ok(mp.seen.every(s=>s.key==='secret-key'));
  }finally{await mp.close();}
});

test('a failed MoneyPrinterTurbo task reports its error, and an external video link is refused', async()=>{
  const failed=await fakeMoneyPrinter({failWith:'TTS request timed out'});
  try{
    const runtime=runtimeFor([moneyPrinterAdapter({base:failed.base,timeoutMs:5000})],{pollMs:1});
    await assert.rejects(runtime.generate({prompt:'x',kind:'video'},new AbortController().signal),/TTS request timed out/);
  }finally{await failed.close();}
  const elsewhere=await fakeMoneyPrinter({videoPath:'https://example.com/final-1.mp4'});
  try{
    const runtime=runtimeFor([moneyPrinterAdapter({base:elsewhere.base,timeoutMs:5000})],{pollMs:1});
    await assert.rejects(runtime.generate({prompt:'x',kind:'video'},new AbortController().signal),/another host/);
  }finally{await elsewhere.close();}
});

test('the video download refuses redirects', async()=>{
  const mp=await fakeMoneyPrinter({redirectVideo:true});
  try{
    const runtime=runtimeFor([moneyPrinterAdapter({base:mp.base,timeoutMs:5000})],{pollMs:1});
    await assert.rejects(runtime.generate({prompt:'x',kind:'video'},new AbortController().signal));
  }finally{await mp.close();}
});

test('the local address must be 127.0.0.1 or localhost, over http or https, with no login', () => {
  assert.equal(parseLocalBase('http://127.0.0.1:8080'),'http://127.0.0.1:8080');
  assert.equal(parseLocalBase('http://localhost:9000/'),'http://localhost:9000');
  for(const bad of ['http://localhost.evil.com','http://127.0.0.1.nip.io','https://example.com','http://user:pw@127.0.0.1:8080','http://127.0.0.1:8080/?x=1','ftp://127.0.0.1','http://[::1]:8080','127.0.0.1:8080'])
    assert.throws(()=>parseLocalBase(bad),/local address|full URL|http or https|127\.0\.0\.1 or localhost|login/,bad);
});

test('settings: MoneyPrinterTurbo only takes a local address, and the other providers still need HTTPS', () => {
  assert.deepEqual(checkMedia('moneyprinter',{base:'http://127.0.0.1:8080',key:'k'}),{base:'http://127.0.0.1:8080',key:'k'});
  assert.throws(()=>checkMedia('moneyprinter',{base:'https://example.com'}),/127\.0\.0\.1 or localhost/);
  assert.throws(()=>checkMedia('moneyprinter',{base:'http://localhost.evil.com'}),/127\.0\.0\.1 or localhost/);
  assert.throws(()=>checkMedia('custom',{base:'http://api.example.com',path:'/v1/x',kind:'image',key:'k',bodyTemplate:'{"p":"{prompt}"}',resultPath:'data.0.url'}),/HTTPS/);
  assert.throws(()=>checkMedia('moneyprinter',{base:'http://127.0.0.1:8080',unknown:'x'}),/Unknown setting/);
});

test('buildAdapters adds MoneyPrinterTurbo as a video adapter when it is saved', () => {
  const adapters=buildAdapters({moneyprinter:{base:'http://127.0.0.1:8080',key:''}},1000);
  assert.equal(adapters.length,1);
  assert.equal(adapters[0].id,'moneyprinter');
  assert.deepEqual(adapters[0].kinds,['video']);
});

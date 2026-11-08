import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {fileURLToPath} from 'node:url';
import {McpError, connectMcp, resultText} from '../src/mcp-client.ts';

// Real stdio server: test/fixtures/mcp-stdio-server.mjs. Its serverInfo.version is its own pid.
const FIXTURE=fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs',import.meta.url));
const stdio=()=>connectMcp({type:'stdio',command:process.execPath,args:[FIXTURE]});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
// Polls until check() holds, or gives up after ms.
async function until(check:()=>boolean,ms=3000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));return check();}

test('stdio: connects, lists both pages, and describes each result', async()=>{
  const c=await stdio();
  try{
    assert.equal(c.info.name,'fixture');
    assert.equal(c.info.protocolVersion,'2025-06-18');
    assert.equal(c.info.instructions,'Fixture for the client tests.');
    assert.deepEqual((await c.listTools()).map(t=>t.name),['echo','fail','picture','slow','change','pinged']);
    assert.deepEqual(await c.callTool('echo',{text:'hello'}),{text:'hello',isError:false});
    assert.deepEqual(await c.callTool('fail',{}),{text:'Something broke.',isError:true});
    assert.equal((await c.callTool('picture',{})).text,'[image: image/png, 300 bytes]');
    // 20,000 characters come back cut at the cap, with the marker.
    assert.equal((await c.callTool('echo',{text:'x'.repeat(20000)})).text,`${'x'.repeat(12000)}\n… (cut at 12,000 characters)`);
    assert.equal((await c.callTool('pinged',{})).text,'true');
    await assert.rejects(c.callTool('nope',{}),e=>e instanceof McpError&&e.message==='-32602: Unknown tool: nope');
  }finally{await c.close();}
});

test('stdio: a list_changed notification fires onToolsChanged before the call returns', async()=>{
  const c=await stdio();
  let changed=0;
  c.onToolsChanged=()=>changed++;
  try{
    await c.callTool('change',{});
    assert.equal(changed,1);
  }finally{await c.close();}
});

test('stdio: a call past its timeout, or aborted by the owner, rejects with the exact message', async()=>{
  const c=await stdio();
  try{
    await assert.rejects(c.callTool('slow',{},{timeoutMs:200}),{message:'Connector call timed out.'});
    const ac=new AbortController();
    setTimeout(()=>ac.abort(),100);
    await assert.rejects(c.callTool('slow',{},{signal:ac.signal}),{message:'Stopped by owner.'});
    // The connection survives both; a normal call still works.
    assert.equal((await c.callTool('echo',{text:'still here'})).text,'still here');
  }finally{await c.close();}
});

test('stdio: a missing command rejects connectMcp with a clear message', async()=>{
  await assert.rejects(connectMcp({type:'stdio',command:'clowder-no-such-command'}),{message:/^Could not start clowder-no-such-command: /});
});

test('stdio: close() stops the server process, and a second close is harmless', async()=>{
  const c=await stdio();
  const pid=Number(c.info.version);
  assert.equal(alive(pid),true);
  await c.close();
  await c.close();
  assert.equal(await until(()=>!alive(pid)),true);
});

test('resultText describes every part kind, uses structuredContent only when content is empty, and cuts at the cap', ()=>{
  assert.deepEqual(resultText({content:[
    {type:'text',text:'a'},
    {type:'resource',resource:{uri:'file:///x',text:'body'}},
    {type:'resource',resource:{uri:'file:///y'}},
    {type:'resource_link',name:'doc',uri:'https://example.com/x'},
    {type:'audio',data:'AAAA',mimeType:'audio/wav'},
  ],isError:true}),{text:'a\n\nbody\n\n[resource: file:///y]\n\n[link: doc https://example.com/x]\n\n[audio: audio/wav, 3 bytes]',isError:true});
  assert.deepEqual(resultText({structuredContent:{ok:1}}),{text:'{"ok":1}',isError:false});
  assert.deepEqual(resultText({content:[{type:'text',text:'shown'}],structuredContent:{ok:1}}),{text:'shown',isError:false});
  assert.equal(resultText({content:[{type:'text',text:'x'.repeat(13000)}]},100).text,`${'x'.repeat(100)}\n… (cut at 100 characters)`);
});

// ---- Streamable HTTP and legacy SSE, against node:http fakes on port 0 ----

type Seen={verb:string|undefined;headers:IncomingMessage['headers'];body:any};

// A node:http server. The handler gets the parsed body (undefined when there is none).
async function fake(handler:(req:IncomingMessage,res:ServerResponse,body:any)=>void){
  const server=createServer((req,res)=>{
    let raw='';
    req.on('data',d=>raw+=d);
    req.on('end',()=>{try{handler(req,res,raw?JSON.parse(raw):undefined);}catch{res.writeHead(500).end();}});
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,stop:()=>{server.closeAllConnections();server.close();}};
}

const STREAMABLE:Record<string,unknown>={
  'tools/list':{tools:[{name:'echo',inputSchema:{type:'object'}}]},
  'tools/call':{content:[{type:'text',text:'pong'}]},
};
// Streamable HTTP fake: session s-N per initialize. SSE replies leave the stream open after the answer, as a live server may.
async function streamable(o:{sse?:boolean;protocol?:string;expire?:boolean;unauth?:boolean}={}){
  const seen:Seen[]=[];let sessions=0,session:string|undefined,expired=false;
  const srv=await fake((req,res,body)=>{
    seen.push({verb:req.method,headers:req.headers,body});
    if(req.method==='DELETE'){res.writeHead(200).end();return;}
    if(o.unauth){res.writeHead(401,{'WWW-Authenticate':'Bearer realm="fake"'}).end();return;}
    // Notifications and the client's answers carry no id, or no method: accepted and nothing more.
    if(body.method===undefined||body.id===undefined){res.writeHead(202).end();return;}
    // The server forgets the session once: the next tools/list gets a 404.
    if(o.expire&&body.method==='tools/list'&&!expired){expired=true;session=undefined;res.writeHead(404).end();return;}
    if(body.method==='initialize'){sessions++;session=`s-${sessions}`;}
    const result=body.method==='initialize'?{protocolVersion:o.protocol??'2025-06-18',capabilities:{},serverInfo:{name:'streamable',version:'1'}}:STREAMABLE[body.method];
    const head={'Content-Type':o.sse?'text/event-stream':'application/json',...(session?{'Mcp-Session-Id':session}:{})};
    if(!o.sse){res.writeHead(200,head).end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));return;}
    res.writeHead(200,head);
    if(body.method==='tools/call'){
      // A server request and a notification come before the answer. The notification's JSON spans two data lines.
      res.write(`data: ${JSON.stringify({jsonrpc:'2.0',id:'s1',method:'ping'})}\n\n`);
      res.write('event: message\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/tools/list_changed"}\n\n');
    }
    res.write(`data: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\n\n`);
  });
  return {...srv,seen};
}

test('Streamable HTTP, JSON replies: session and protocol headers echo after initialize, the token is sent, close sends DELETE', async()=>{
  const f=await streamable();
  const c=await connectMcp({type:'http',url:f.url,headers:{'X-Test':'yes'}},{token:async()=>'tok-1'});
  try{
    assert.equal(c.info.name,'streamable');
    assert.deepEqual((await c.listTools()).map(t=>t.name),['echo']);
    assert.equal((await c.callTool('echo',{})).text,'pong');
    const [init,...rest]=f.seen;
    assert.equal(init.headers['mcp-session-id'],undefined);
    assert.equal(init.headers['mcp-protocol-version'],undefined);
    assert.ok(rest.length>=3);
    for(const s of rest){assert.equal(s.headers['mcp-session-id'],'s-1');assert.equal(s.headers['mcp-protocol-version'],'2025-06-18');}
    for(const s of f.seen){assert.equal(s.headers.authorization,'Bearer tok-1');assert.equal(s.headers['x-test'],'yes');}
    await c.close();
    assert.equal(f.seen.at(-1)?.verb,'DELETE');
    assert.equal(f.seen.at(-1)?.headers['mcp-session-id'],'s-1');
  }finally{await c.close();f.stop();}
});

test('Streamable HTTP, SSE replies: a ping and a list_changed inside the stream are handled, and the call resolves at its answer', async()=>{
  const f=await streamable({sse:true});
  const c=await connectMcp({type:'http',url:f.url});
  let changed=0;
  c.onToolsChanged=()=>changed++;
  try{
    assert.equal((await c.callTool('echo',{})).text,'pong');
    assert.equal(changed,1);
    // The client answered the server's ping with a POST of its own.
    assert.equal(await until(()=>f.seen.some(s=>s.body?.id==='s1'&&'result' in s.body)),true);
  }finally{await c.close();f.stop();}
});

test('a 401 with WWW-Authenticate is an authRequired error; no token means no Authorization header', async()=>{
  const f=await streamable({unauth:true});
  try{
    await assert.rejects(connectMcp({type:'http',url:f.url},{token:async()=>null}),e=>e instanceof McpError&&e.authRequired===true&&e.status===401&&e.wwwAuthenticate==='Bearer realm="fake"');
    assert.equal(f.seen[0].headers.authorization,undefined);
  }finally{f.stop();}
});

test('a 404 after the session is set re-initializes once and retries the request', async()=>{
  const f=await streamable({expire:true});
  const c=await connectMcp({type:'http',url:f.url});
  try{
    assert.deepEqual((await c.listTools()).map(t=>t.name),['echo']);
    assert.equal(f.seen.filter(s=>s.body?.method==='initialize').length,2);
    assert.equal(f.seen.filter(s=>s.body?.method==='tools/list').at(-1)?.headers['mcp-session-id'],'s-2');
  }finally{await c.close();f.stop();}
});

test('a server on an unsupported protocol version is refused, and its session is closed', async()=>{
  const f=await streamable({protocol:'1999-01-01'});
  try{
    await assert.rejects(connectMcp({type:'http',url:f.url}),/does not support/);
    assert.equal(f.seen.at(-1)?.verb,'DELETE');
  }finally{f.stop();}
});

// Legacy SSE fake: GET opens the stream and names the POST endpoint; POSTs get 202 and their answers go out on the stream.
const LEGACY:Record<string,unknown>={
  initialize:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'legacy',version:'1'}},
  'tools/list':{tools:[{name:'hi',inputSchema:{type:'object'}}]},
  'tools/call':{content:[{type:'text',text:'legacy says hi'}]},
};
async function legacy(endpointHost=''){
  let stream:ServerResponse|undefined,closed=false;
  const srv=await fake((req,res,body)=>{
    if(req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write(`event: endpoint\ndata: ${endpointHost}/messages?session=abc\n\n`);
      stream=res;
      res.on('close',()=>closed=true);
      return;
    }
    if(req.method==='POST'){
      res.writeHead(202).end('Accepted');
      const result=LEGACY[body.method];
      if(body.id!==undefined&&result)stream?.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  return {...srv,closed:()=>closed};
}

test('legacy SSE: the endpoint event, POSTed requests, and answers on the stream; close aborts the stream', async()=>{
  const f=await legacy();
  const c=await connectMcp({type:'sse',url:`${f.url}/sse`});
  try{
    assert.equal(c.info.name,'legacy');
    assert.deepEqual((await c.listTools()).map(t=>t.name),['hi']);
    assert.equal((await c.callTool('hi',{})).text,'legacy says hi');
  }finally{
    await c.close();
    assert.equal(await until(()=>f.closed()),true);
    f.stop();
  }
});

test('legacy SSE: an endpoint on another origin is refused', async()=>{
  const f=await legacy('http://evil.example.test');
  try{
    await assert.rejects(connectMcp({type:'sse',url:`${f.url}/sse`}),/another server/);
  }finally{f.stop();}
});

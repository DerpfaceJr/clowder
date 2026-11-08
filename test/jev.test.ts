import {withFullRoster} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {jevDecider, jevCost, JEV_USD_PER_TOKEN} from '../src/jev.ts';
import {ModelHub, jevFromSettings, loadSettings} from '../src/models.ts';
import {runSeason, seasonStatus} from '../src/season.ts';
import type {Provider} from '../src/provider.ts';
import type {EconomyEvent} from '../src/economy.ts';

const config=withFullRoster(JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')));
const tmp=()=>mkdtempSync(join(tmpdir(),'jev-'));
const KEY='jev-test-key-0000001234';

// A local HTTP server stands in for api.typesafe.ai; each test sets the reply it wants.
async function fakeJev(reply:(req:{method?:string;url?:string;headers:any;body:any})=>{status?:number;body:any}){
  const seen:{method?:string;url?:string;headers:any;body:any}[]=[];
  const server=createServer((req,res)=>{
    let raw='';
    req.on('data',c=>{raw+=c;});
    req.on('end',()=>{
      const item={method:req.method,url:req.url,headers:req.headers,body:raw?JSON.parse(raw):null};
      seen.push(item);
      const out=reply(item);
      res.writeHead(out.status??200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address() as AddressInfo;
  return {base:`http://127.0.0.1:${port}`,seen,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}

const answer=(choice:string,confidence:number)=>({model:'jev-1.14.0',answers:{decision:{type:'choice',choice,confidence,probabilities:{[choice]:confidence}}},usage:{input_tokens:150,output_tokens:0}});

test('request shape: POST /v1/systemone with a bearer key, one choice question, and the context as state', async()=>{
  const srv=await fakeJev(()=>({body:answer('approve',0.9)}));
  try{
    const decide=jevDecider({base:srv.base+'/',key:KEY,timeoutMs:5000});
    const context={decision:{id:'sp1',amount:80},balance:500};
    const r=await decide('Approve spend sp1?',['approve','reject'],context);
    assert.equal(srv.seen.length,1);
    const req=srv.seen[0];
    assert.equal(req.method,'POST');
    assert.equal(req.url,'/v1/systemone');
    assert.equal(req.headers.authorization,`Bearer ${KEY}`);
    assert.equal(req.headers['content-type'],'application/json');
    assert.deepEqual(req.body,{
      model:'jev-latest',
      state:context,
      questions:{decision:{type:'choice',instructions:'Approve spend sp1?',criteria:{approve:null,reject:null}}},
    });
    assert.deepEqual(r,{choice:'approve',score:0.9,usage:{input_tokens:150,output_tokens:0}});
  }finally{await srv.close();}
});

test('the chosen option must be one of the offered choices; anything else throws', async()=>{
  const srv=await fakeJev(()=>({body:answer('maybe',0.5)}));
  try{
    await assert.rejects(jevDecider({base:srv.base,key:KEY,timeoutMs:5000})('q',['approve','reject'],{}),/not offered/);
  }finally{await srv.close();}
  const wrongType=await fakeJev(()=>({body:{model:'m',answers:{decision:{type:'score',score:1,confidence:0.5}},usage:{input_tokens:1,output_tokens:0}}}));
  try{
    await assert.rejects(jevDecider({base:wrongType.base,key:KEY,timeoutMs:5000})('q',['approve','reject'],{}),/no choice answer/);
  }finally{await wrongType.close();}
  const missing=await fakeJev(()=>({body:{model:'m',answers:{},usage:{input_tokens:1,output_tokens:0}}}));
  try{
    await assert.rejects(jevDecider({base:missing.base,key:KEY,timeoutMs:5000})('q',['approve','reject'],{}),/no choice answer/);
  }finally{await missing.close();}
});

test('bad choice lists are refused before any request is sent', async()=>{
  const srv=await fakeJev(()=>({body:answer('approve',1)}));
  try{
    const decide=jevDecider({base:srv.base,key:KEY,timeoutMs:5000});
    await assert.rejects(decide('q',[],{}),/1 to 255/);
    await assert.rejects(decide('q',['approve','approve'],{}),/unique/);
    await assert.rejects(decide('q',['approve',''],{}),/unique non-empty/);
    assert.equal(srv.seen.length,0);
  }finally{await srv.close();}
});

test('HTTP errors throw with the status only, never the key or the body', async()=>{
  for(const status of [401,429,529]){
    const srv=await fakeJev(()=>({status,body:{detail:`echo ${KEY}`}}));
    try{
      await assert.rejects(jevDecider({base:srv.base,key:KEY,timeoutMs:5000})('q',['a','b'],{}),(err:Error)=>{
        assert.equal(err.message,`Jev request failed (${status}).`);
        assert.equal(err.message.includes(KEY),false);
        return true;
      });
    }finally{await srv.close();}
  }
});

test('the score is the Choice confidence, null when absent, and cost is computed from input tokens only', async()=>{
  const srv=await fakeJev(()=>({body:{model:'m',answers:{decision:{type:'choice',choice:'reject',probabilities:{reject:1}}},usage:{input_tokens:1000,output_tokens:999}}}));
  try{
    const r=await jevDecider({base:srv.base,key:KEY,timeoutMs:5000})('q',['approve','reject'],{});
    assert.equal(r.score,null);
    assert.equal(jevCost(r.usage),1000*JEV_USD_PER_TOKEN);
    assert.equal(jevCost({input_tokens:1000,output_tokens:999}),42e-6);
    assert.equal(jevCost(null),null);
  }finally{await srv.close();}
});

test('settings: jev keeps its key on disk and the status shows only the last four characters', async()=>{
  const file=join(tmp(),'models.json');
  const hub=new ModelHub({file,config,env:{} as NodeJS.ProcessEnv});
  await assert.rejects(hub.update({jev:{enabled:true}}),/Enter an API key for Jev/);
  await hub.update({jev:{enabled:true,key:KEY}});
  assert.deepEqual(loadSettings(file).jev,{enabled:true,key:KEY});
  const s=await hub.status();
  assert.equal(s.jev.hasKey,true);
  assert.equal(s.jev.keyLast4,'1234');
  assert.equal(s.jev.available,true);
  assert.equal(JSON.stringify(s).includes(KEY),false);
  // Toggling keeps the saved key; a changed endpoint without a new key does not reuse it.
  await hub.update({jev:{enabled:false}});
  assert.equal(loadSettings(file).jev?.key,KEY);
  assert.equal(hub.jev(),null);
  await hub.update({jev:{enabled:true}});
  assert.equal(hub.jev()===null,false);
  await assert.rejects(hub.update({jev:{enabled:true,base:'https://other.example.com/v1'}}),/API key for Jev/);
  await assert.rejects(hub.update({jev:{enabled:true,base:'http://api.example.com',key:KEY}}),/HTTPS/);
  await hub.update({jev:null});
  assert.equal(loadSettings(file).jev,undefined);
  assert.equal(hub.jev(),null);
});

test('jevFromSettings is null when disabled, keyless or on a plain-http base', ()=>{
  assert.equal(jevFromSettings({},config),null);
  assert.equal(jevFromSettings({jev:{enabled:false,key:KEY}},config),null);
  assert.equal(jevFromSettings({jev:{enabled:true,key:KEY,base:'http://insecure.example.com'}},config),null);
  assert.equal(typeof jevFromSettings({jev:{enabled:true,key:KEY}},config),'function');
});

// Season: merchant opens a business whose startup (120) is above its envelope (50), so a spend waits for a decision.
const openBusiness={name:'Moonlit Fish Stall',pitch:'Fresh catch',category:'fish',price:12,unitCost:5,startup:120};
function merchantProvider(prompts:Record<string,string[]>,opened:{done:boolean}):Provider{
  return async(messages)=>{
    const cat=/cat id: (\w+)/.exec(messages[0].content)?.[1]??'?';
    (prompts[cat]??=[]).push(String(messages[1].content));
    if(cat==='merchant'&&!opened.done){
      opened.done=true;
      return {message:{role:'assistant',content:null,tool_calls:[{id:'m',type:'function',function:{name:'open_business',arguments:JSON.stringify(openBusiness)}}]}};
    }
    return {message:{role:'assistant',content:null,tool_calls:[{id:'p',type:'function',function:{name:'pass',arguments:'{"note":"llm pass"}'}}]}};
  };
}

test('season: Jev decides only the pending spend for the banker; everything else stays with the LLM', async()=>{
  const dir=tmp();
  const prompts:Record<string,string[]>={};
  const calls:{question:string;choices:string[];context:any}[]=[];
  const jev=async(question:string,choices:string[],context:any)=>{
    calls.push({question,choices,context});
    return {choice:'approve',score:0.91,usage:{input_tokens:200,output_tokens:0}};
  };
  const r=await runSeason({name:'j',mode:'local',days:1,dataDir:dir,config,provider:merchantProvider(prompts,{done:false}),jev,stopAfterTicks:2});
  const actions=r.events.filter(e=>e.type==='action');
  // Jev was asked exactly once: the banker's turn in tick 1, for the merchant's spend.
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].choices,['approve','reject']);
  assert.equal(calls[0].context.decision.kind,'spend');
  assert.equal(calls[0].context.decision.requester,'merchant');
  assert.equal(calls[0].context.decision.amount,120);
  assert.equal(calls[0].context.decision.purpose,'open Moonlit Fish Stall');
  // The banker's action is the Jev decision; the LLM never saw the banker in that tick.
  const bankerActions=actions.filter(e=>e.cat==='banker');
  assert.equal(bankerActions.at(-1)?.name,'decide_spend');
  assert.equal(bankerActions.at(-1)?.args.approved,true);
  assert.equal(bankerActions.at(-1)?.args.reason,'Jev: approve (0.91)');
  assert.equal(prompts.banker?.length,1,'banker should only have had its tick-0 LLM turn');
  // Jev usage is its own event, with cost and no token counts.
  const usage=r.events.filter(e=>e.type==='usage'&&e.provider==='jev');
  assert.equal(usage.length,1);
  assert.equal(usage[0].cat,'banker');
  assert.equal(usage[0].input,null);
  assert.equal(usage[0].output,null);
  assert.equal(usage[0].cost,200*JEV_USD_PER_TOKEN);
  // Mayor and the other cats still used the LLM every tick; the mayor never had a Jev turn.
  assert.ok((prompts.mayor?.length??0)>=2);
  assert.ok(r.events.filter(e=>e.type==='usage'&&e.provider!=='jev').length>0);
  // The Jev-decided spend is applied by the economy, so invariants hold.
  const status=seasonStatus('j',dir,config);
  assert.match(status,/jev decisions: 1, cost \$0\.00000\d/);
  assert.match(status,/model calls: \d+/);
});

test('season: when Jev fails, the banker falls back to its normal LLM turn', async()=>{
  const dir=tmp();
  const prompts:Record<string,string[]>={};
  let calls=0;
  const jev=async()=>{calls++;throw new Error('Jev request failed (529).');};
  const r=await runSeason({name:'f',mode:'local',days:1,dataDir:dir,config,provider:merchantProvider(prompts,{done:false}),jev,stopAfterTicks:2});
  assert.equal(calls,1);
  // The banker's LLM turn in tick 1 ran, and no Jev usage was recorded.
  assert.equal(prompts.banker?.length,2);
  assert.equal(r.events.some(e=>e.type==='usage'&&e.provider==='jev'),false);
  const bankerActions=r.events.filter(e=>e.type==='action'&&e.cat==='banker');
  assert.equal(bankerActions.at(-1)?.name,'pass');
  assert.equal(bankerActions.at(-1)?.args.note,'llm pass');
});

test('season: Jev is never called when no decision is waiting, and demo mode ignores it', async()=>{
  const dir=tmp();
  let calls=0;
  const jev=async()=>{calls++;return {choice:'approve',score:1,usage:null};};
  // The provider never opens a business, so nothing is pending.
  const idle:Provider=async()=>({message:{role:'assistant',content:null,tool_calls:[{id:'p',type:'function',function:{name:'pass',arguments:'{"note":"idle"}'}}]}});
  await runSeason({name:'i',mode:'local',days:1,dataDir:dir,config,provider:idle,jev,stopAfterTicks:2});
  assert.equal(calls,0);
  await runSeason({name:'d',mode:'demo',days:1,dataDir:tmp(),config,jev,stopAfterTicks:2});
  assert.equal(calls,0);
});

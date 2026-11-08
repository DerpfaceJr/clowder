import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudePlanProvider} from '../src/claude-plan.ts';
import {runSeason} from '../src/season.ts';
import {checkInvariants, replay} from '../src/economy.ts';
import type {EconomyEvent} from '../src/economy.ts';
import {CLI_ENV, runCli} from '../src/claude-plan.ts';
// The fake CLIs read these; a real CLI run gets only CLI_ENV from this process's environment (security pass M3).
CLI_ENV.push('CAT_FAKE_LOG', 'CAT_FAKE_MODE');

// A fake `claude`: records argv, stdin and whether API-key variables reached it, then prints a canned result.
// CAT_FAKE_MODE picks the reply: default (pass action), reply, limit, garbage, hang, hang-once (hangs the first call only), stray.
const dir=mkdtempSync(join(tmpdir(),'claude-plan-'));
const logFile=join(dir,'call.json');
const script=join(dir,'fake-claude.mjs');
const win=process.platform==='win32';
const executable=join(dir,win?'fake-claude.cmd':'fake-claude');
writeFileSync(script,`import {readFileSync, writeFileSync, existsSync} from 'node:fs';
const stdin=readFileSync(0,'utf8');
const argv=process.argv.slice(2),at=argv.indexOf('--system-prompt-file');
writeFileSync(process.env.CAT_FAKE_LOG,JSON.stringify({argv,systemFile:at<0?null:readFileSync(argv[at+1],'utf8'),stdin,hasApiKey:'ANTHROPIC_API_KEY' in process.env,hasAuthToken:'ANTHROPIC_AUTH_TOKEN' in process.env}));
const usage={input_tokens:10,cache_creation_input_tokens:2,cache_read_input_tokens:3,output_tokens:4};
const mode=process.env.CAT_FAKE_MODE;
const ok=(structured_output)=>JSON.stringify({type:'result',is_error:false,result:'',structured_output,usage,total_cost_usd:0.01});
if(mode==='limit'){process.stdout.write(JSON.stringify({type:'result',is_error:true,result:"You've hit your weekly limit · resets Monday",usage}));process.exit(1);}
if(mode==='empty-error'){process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'',errors:['Structured output failed'],usage}));process.exit(1);}
if(mode==='garbage'){process.stderr.write('boom: not a result');process.exit(1);}
const hung=process.env.CAT_FAKE_LOG+'.hung';
if(mode==='hang-once'&&!existsSync(hung)){writeFileSync(hung,'1');setTimeout(()=>process.exit(0),60000);}
else if(mode==='hang-once')process.stdout.write(ok({action:'pass',args:{note:'second try'}}));
else if(mode==='stray')process.stdout.write(ok({action:'pass',title:'Beside action',args:{note:'inside'}}));
else if(mode==='hang'){setTimeout(()=>process.exit(0),5000);}
else if(mode==='reply')process.stdout.write(ok({action:'reply',text:'hello there'}));
else if(mode==='top-text')process.stdout.write(ok({action:'remember',text:'The fact itself.',args:{title:'Fact title'}}));
else process.stdout.write(ok({action:'pass',args:{note:'fake plan'}}));
`);
if(win)writeFileSync(executable,`@"${process.execPath}" "${script}" %*\r\n`);
else{writeFileSync(executable,`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);chmodSync(executable,0o755);}
process.env.CAT_FAKE_LOG=logFile;

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tools=[{type:'function',function:{name:'pass',description:'Take no action this tick.',parameters:{type:'object',properties:{note:{type:'string'}},required:[],additionalProperties:false}}}];
// remember takes a title and a text; the top-level text in top-text mode belongs to it.
const rememberTools=[...tools,{type:'function',function:{name:'remember',description:'Save a fact.',parameters:{type:'object',properties:{title:{type:'string'},text:{type:'string'}},required:['title','text']}}}];
const messages=[{role:'system',content:'You are the Mayor.\nTake exactly one action.'},{role:'user',content:'{"day":1}'}];
const provider=(workdir=dir,timeoutMs=20000)=>claudePlanProvider('haiku',timeoutMs,{executable,workdir});
const call=()=>JSON.parse(readFileSync(logFile,'utf8'));
const withEnv=async(vars:Record<string,string|undefined>,fn:()=>Promise<void>)=>{
  const prev=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(vars)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  try{await fn();}finally{for(const [k,v] of Object.entries(prev)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
};

test('a tool action becomes a tool call with JSON arguments and mapped usage', async()=>{
  await withEnv({CAT_FAKE_MODE:undefined},async()=>{
    const reply=await provider()(messages,tools,new AbortController().signal);
    assert.equal(reply.message.tool_calls.length,1);
    const [c]=reply.message.tool_calls;
    assert.equal(c.type,'function');
    assert.match(c.id,/^call_/);
    assert.equal(c.function.name,'pass');
    assert.deepEqual(JSON.parse(c.function.arguments),{note:'fake plan'});
    assert.deepEqual(reply.usage,{prompt_tokens:15,completion_tokens:4,cost_usd:0.01});
  });
});

test('a reply action becomes message content without tool calls', async()=>{
  await withEnv({CAT_FAKE_MODE:'reply'},async()=>{
    const reply=await provider()(messages,tools,new AbortController().signal);
    assert.equal(reply.message.content,'hello there');
    assert.equal(reply.message.tool_calls,undefined);
  });
});

test('a limit error rejects as fatal', async()=>{
  await withEnv({CAT_FAKE_MODE:'limit'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal===true&&/weekly limit/.test(e.message));
  });
});

test('an error with an empty result names its subtype and errors instead of failing silently', async()=>{
  await withEnv({CAT_FAKE_MODE:'empty-error'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal!==true&&e.message==='Claude plan call failed: error_during_execution: Structured output failed');
  });
});

test('non-JSON output rejects with stderr and is not fatal', async()=>{
  await withEnv({CAT_FAKE_MODE:'garbage'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal!==true&&/boom/.test(e.message));
  });
});

test('the command line keeps the plan-only flags, the schema, and never --bare', async()=>{
  await withEnv({CAT_FAKE_MODE:undefined},async()=>{
    await provider()(messages,tools,new AbortController().signal);
    const {argv}=call();
    const after=(f:string)=>argv[argv.indexOf(f)+1];
    assert.ok(argv.includes('-p'));
    assert.equal(after('--tools'),'');
    assert.equal(after('--setting-sources'),'');
    assert.ok(argv.includes('--no-session-persistence'));
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.equal(after('--model'),'haiku');
    // Newlines become spaces only on the .cmd path (cmd.exe cannot carry them), so compare with \s+.
    // The system prompt travels in a file (a long one overflowed the Windows command line), deleted after the call.
    assert.ok(!argv.includes('--system-prompt'));
    assert.match(call().systemFile,/^You are the Mayor\.\s+Take exactly one action\.\s+Respond only with the structured output\./);
    assert.ok(!existsSync(after('--system-prompt-file')),'the prompt file is removed after the call');
    assert.deepEqual(JSON.parse(after('--json-schema')).properties.action.enum,['pass','reply']);
    assert.ok(!argv.includes('--bare'));
    assert.match(call().stdin,/USER: \{"day":1\}\n\nTOOLS:\nThese town tools are yours and available now[^\n]*\n- pass: Take no action this tick\.\n  parameters: \{"type":"object"/);
  });
});

test('the child environment drops API-key variables even when the parent sets them', async()=>{
  await withEnv({CAT_FAKE_MODE:undefined,ANTHROPIC_API_KEY:'sk-ant-test-not-real',ANTHROPIC_AUTH_TOKEN:'test-token-not-real'},async()=>{
    await provider()(messages,tools,new AbortController().signal);
    const seen=call();
    assert.equal(seen.hasApiKey,false);
    assert.equal(seen.hasAuthToken,false);
  });
});

test('a call that exceeds the timeout rejects and an owner stop rejects', async()=>{
  await withEnv({CAT_FAKE_MODE:'hang'},async()=>{
    await assert.rejects(provider(dir,300)(messages,tools,new AbortController().signal),/Claude plan call timed out\./);
    const ac=new AbortController();
    const pending=provider()(messages,tools,ac.signal);
    setTimeout(()=>ac.abort(),100);
    await assert.rejects(pending,/Stopped by owner\./);
  });
});

test('a stalled call is tried once more before it fails, and an argument put beside action still reaches the tool', async()=>{
  rmSync(logFile+'.hung',{force:true});
  await withEnv({CAT_FAKE_MODE:'hang-once'},async()=>{
    const {message}=await provider(dir,8000)(messages,tools,new AbortController().signal);
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments),{note:'second try'});
  });
  await withEnv({CAT_FAKE_MODE:'stray'},async()=>{
    const {message}=await provider()(messages,tools,new AbortController().signal);
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments),{title:'Beside action',note:'inside'});
    assert.equal(JSON.parse(call().argv[call().argv.indexOf('--json-schema')+1]).additionalProperties,undefined,'the schema lets a stray key through');
  });
});

test('a plan-mode season pauses on a limit, stays replayable, and resumes with the same command', async()=>{
  const seasonDir=mkdtempSync(join(tmpdir(),'plan-season-'));
  const journal=join(seasonDir,'season-plan.jsonl');
  const readEvents=():EconomyEvent[]=>readFileSync(journal,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
  const run=()=>runSeason({name:'plan',mode:'plan',seed:1,days:1,dataDir:seasonDir,config,provider:provider(),stopAfterTicks:1});
  await withEnv({CAT_FAKE_MODE:'limit'},async()=>{
    await assert.rejects(run(),(e:any)=>e.fatal===true&&/weekly limit/.test(e.message));
    assert.ok(existsSync(journal));
    const events=readEvents();
    assert.ok(replay(events).started);
    assert.deepEqual(checkInvariants(events),[]);
  });
  await withEnv({CAT_FAKE_MODE:undefined},async()=>{
    const r=await run();
    assert.equal(r.events.filter(e=>e.type==='tick.closed').length,1);
    assert.deepEqual(checkInvariants(readEvents()),[]);
  });
});

test('a top-level text becomes the text argument of a tool that takes one, but never the reply of a reply', async () => {
  await withEnv({CAT_FAKE_MODE:'top-text'},async()=>{
    const {message}=await provider()(messages,rememberTools,new AbortController().signal);
    const [call]=message.tool_calls!;
    assert.equal(call.function.name,'remember');
    assert.deepEqual(JSON.parse(call.function.arguments),{title:'Fact title',text:'The fact itself.'});
    assert.equal(message.content,'');
  });
  await withEnv({CAT_FAKE_MODE:'reply'},async()=>{
    const {message}=await provider()(messages,rememberTools,new AbortController().signal);
    assert.equal(message.content,'hello there');
    assert.equal(message.tool_calls,undefined);
  });
});

// Security pass M3: a CLI run (Claude, or Codex with a shell) gets only CLI_ENV, so this launch's owner key or a token in the owner's shell never reaches it.
test('a spawned CLI run does not inherit the owner session key or a shell token', async()=>{
  await withEnv({CAT_OWNER_KEY:'owner-key-from-the-desktop-app',GITHUB_TOKEN:'shell-token'},async()=>{
    const r=await runCli(process.execPath,['-e',"process.stdout.write(JSON.stringify(['CAT_OWNER_KEY','GITHUB_TOKEN','PATH'].map(k=>k in process.env)))"],'',dir,20000,new AbortController().signal,{label:'node',dropEnv:[]});
    assert.deepEqual(JSON.parse(r.stdout),[false,false,true]);
  });
});

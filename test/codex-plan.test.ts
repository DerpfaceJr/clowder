import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexPlanProvider} from '../src/codex-plan.ts';
import {CLI_ENV, removeCallDir} from '../src/claude-plan.ts';
import {spawn} from 'node:child_process';
// The fake CLIs read these; a real CLI run gets only CLI_ENV from this process's environment (security pass M3).
CLI_ENV.push('CAT_FAKE_LOG', 'CAT_FAKE_MODE');

// A fake `codex`: records argv, stdin, the schema it was given and whether OPENAI_API_KEY reached it,
// then writes the final message to the -o file. CAT_FAKE_MODE picks the outcome.
const dir=mkdtempSync(join(tmpdir(),'codex-plan-'));
const workdir=join(dir,'work');
const logFile=join(dir,'call.json');
const script=join(dir,'fake-codex.mjs');
const win=process.platform==='win32';
const executable=join(dir,win?'fake-codex.cmd':'fake-codex');
writeFileSync(script,`import {existsSync, readFileSync, writeFileSync} from 'node:fs';
const argv=process.argv.slice(2);
const stdin=readFileSync(0,'utf8');
const after=f=>{const i=argv.indexOf(f);return i<0?undefined:argv[i+1];};
const schemaPath=after('--output-schema'),outPath=after('--output-last-message');
writeFileSync(process.env.CAT_FAKE_LOG,JSON.stringify({argv,stdin,schema:schemaPath&&existsSync(schemaPath)?JSON.parse(readFileSync(schemaPath,'utf8')):null,hasOpenAiKey:'OPENAI_API_KEY' in process.env}));
const mode=process.env.CAT_FAKE_MODE;
if(mode==='limit'){process.stderr.write("ERROR: You've hit your usage limit. Try again later.");process.exit(1);}
else if(mode==='notlogged'){process.stderr.write('Not logged in. Run codex login.');process.exit(1);}
else if(mode==='garbage'){process.stderr.write('boom: not a result');process.exit(1);}
else if(mode==='hang'){setTimeout(()=>process.exit(0),5000);}
else if(mode==='unknown')writeFileSync(outPath,JSON.stringify({action:'launch_rockets',args_json:'{}',text:''}));
else if(mode==='reply')writeFileSync(outPath,JSON.stringify({action:'reply',args_json:'{}',text:'hello there'}));
else if(mode==='top-text')writeFileSync(outPath,JSON.stringify({action:'remember',args_json:JSON.stringify({title:'Fact title'}),text:'The fact itself.'}));
else writeFileSync(outPath,JSON.stringify({action:'pass',args_json:JSON.stringify({note:'fake codex'}),text:''}));
`);
if(win)writeFileSync(executable,`@"${process.execPath}" "${script}" %*\r\n`);
else{writeFileSync(executable,`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);chmodSync(executable,0o755);}
process.env.CAT_FAKE_LOG=logFile;

const tools=[{type:'function',function:{name:'pass',description:'Take no action this tick.',parameters:{type:'object',properties:{note:{type:'string'}},required:[],additionalProperties:false}}}];
const messages=[{role:'system',content:'You are the Mayor.\nTake exactly one action.'},{role:'user',content:'{"day":1}'}];
const provider=(timeoutMs=20000)=>codexPlanProvider('gpt-5-codex',timeoutMs,{executable,workdir});
const call=()=>JSON.parse(readFileSync(logFile,'utf8'));
const withEnv=async(vars:Record<string,string|undefined>,fn:()=>Promise<void>)=>{
  const prev=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(vars)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  try{await fn();}finally{for(const [k,v] of Object.entries(prev)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
};

test('a tool action becomes a tool call with parsed JSON arguments; usage stays unknown', async()=>{
  await withEnv({CAT_FAKE_MODE:undefined,OPENAI_API_KEY:'sk-test-should-not-reach-codex'},async()=>{
    const reply=await provider()(messages,tools,new AbortController().signal);
    const [c]=reply.message.tool_calls!;
    assert.match(c.id,/^call_/);
    assert.equal(c.function.name,'pass');
    assert.deepEqual(JSON.parse(c.function.arguments),{note:'fake codex'});
    assert.equal(reply.usage,undefined);
  });
});

test('the command line uses exec, read-only sandbox, the schema file and the model; the API key is removed', async()=>{
  await withEnv({CAT_FAKE_MODE:undefined,OPENAI_API_KEY:'sk-test-should-not-reach-codex'},async()=>{
    await provider()(messages,tools,new AbortController().signal);
    const {argv,stdin,schema,hasOpenAiKey}=call();
    assert.equal(argv[0],'exec');
    for(const flag of ['--sandbox','--skip-git-repo-check','--ephemeral','--ignore-user-config','--output-schema','--output-last-message','--model'])assert.ok(argv.includes(flag),flag);
    assert.equal(argv[argv.indexOf('--sandbox')+1],'read-only');
    assert.equal(argv[argv.indexOf('--model')+1],'gpt-5-codex');
    assert.equal(argv.at(-1),'-');
    assert.deepEqual(schema.required,['action','args_json','text']);
    assert.equal(schema.additionalProperties,false);
    assert.ok(schema.properties.action.enum.includes('pass')&&schema.properties.action.enum.includes('reply'));
    assert.match(stdin,/You are the Mayor/);
    assert.match(stdin,/TOOLS:/);
    assert.equal(hasOpenAiKey,false);
  });
});

// A top-level text that belongs to a text parameter is that argument, the same as the Claude adapter does.
test('codex: top-level text becomes the text argument of a tool that takes one', async()=>{
  const rememberTools=[...tools,{type:'function',function:{name:'remember',description:'Save a fact.',parameters:{type:'object',properties:{title:{type:'string'},text:{type:'string'}},required:['title','text']}}}];
  await withEnv({CAT_FAKE_MODE:'top-text'},async()=>{
    const reply=await provider()(messages,rememberTools,new AbortController().signal);
    const [call]=reply.message.tool_calls!;
    assert.deepEqual(JSON.parse(call.function.arguments),{title:'Fact title',text:'The fact itself.'});
  });
});

test('a reply action becomes message content without tool calls', async()=>{
  await withEnv({CAT_FAKE_MODE:'reply'},async()=>{
    const reply=await provider()(messages,tools,new AbortController().signal);
    assert.equal(reply.message.content,'hello there');
    assert.equal(reply.message.tool_calls,undefined);
  });
});

test('a usage limit fails the call as fatal', async()=>{
  await withEnv({CAT_FAKE_MODE:'limit'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal===true&&/usage limit/.test(e.message));
  });
});

test('a sign-in problem fails the call as fatal', async()=>{
  await withEnv({CAT_FAKE_MODE:'notlogged'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal===true&&/needs you to sign in again — run `codex login`/.test(e.message));
  });
});

test('other failures reject with the CLI output and are not fatal', async()=>{
  await withEnv({CAT_FAKE_MODE:'garbage'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal!==true&&/boom/.test(e.message));
  });
});

test('an action outside the listed tools is rejected and not fatal', async()=>{
  await withEnv({CAT_FAKE_MODE:'unknown'},async()=>{
    await assert.rejects(provider()(messages,tools,new AbortController().signal),(e:any)=>e.fatal!==true&&/unknown action/.test(e.message));
  });
});

test('cleanup removes a call folder, and never throws while a process still holds it', async()=>{
  const gone=mkdtempSync(join(dir,'gone-'));writeFileSync(join(gone,'a.json'),'{}');
  removeCallDir(gone);assert.equal(existsSync(gone),false);
  removeCallDir(join(dir,'never-made'));
  // A live process whose working directory is the folder: Windows refuses to remove it (EBUSY), other systems remove it. Either way no throw,
  // so a cleanup in a finally can never replace the call's own error.
  const held=mkdtempSync(join(dir,'held-')),child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{cwd:held,stdio:'ignore',windowsHide:true});
  await new Promise(r=>child.once('spawn',r));
  try{assert.doesNotThrow(()=>removeCallDir(held));}
  finally{const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
  removeCallDir(held);assert.equal(existsSync(held),false,'gone once nothing holds it');
});

test('a call that exceeds the timeout rejects, and the per-call directory is removed', async()=>{
  mkdirSync(workdir,{recursive:true});
  await withEnv({CAT_FAKE_MODE:'hang'},async()=>{
    await assert.rejects(provider(300)(messages,tools,new AbortController().signal),/Codex plan call timed out\./);
  });
  assert.deepEqual(readdirSync(workdir),[]);
});

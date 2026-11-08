// Model provider that runs the owner's ChatGPT plan through the official OpenAI `codex` CLI, signed in with `codex login`.
// The app never reads or stores the login; it only runs the CLI. Calls count against the ChatGPT plan's limits.
// Flags verified against `npx -y @openai/codex@latest exec --help` (codex-cli 0.164.0):
//   "  -m, --model <MODEL>                       Model the agent should use"
//   "  -s, --sandbox <SANDBOX_MODE>              [possible values: read-only, workspace-write, danger-full-access]"
//   "      --output-schema <FILE>                Path to a JSON Schema file describing the model's final response shape"
//   "  -o, --output-last-message <FILE>          Specifies file where the last message from the agent should be written"
//   "      --skip-git-repo-check                 Allow running Codex outside a Git repository"
//   "      --ephemeral                           Run without persisting session files to disk"
//   "      --ignore-user-config                  Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`"
//   "      --color <COLOR>                       [possible values: always, never, auto]"
//   "[PROMPT] ... If not provided as an argument (or if `-` is used), instructions are read from stdin."
// Status: `codex login status` printed "Logged in using ChatGPT" with exit 0 on the verifying machine.
// Not verified here: a live model call, the logged-out status text, and the default model name.
// UNVERIFIED: model_reasoning_effort as a -c key and its values (minimal, low, medium, high). The exec help does not list them.
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelReply, Provider} from './provider.ts';
import {fnOf, planFailure, resolveExecutable, runCli, splitSystem, takesText, transcript, type PlanHealth} from './claude-plan.ts';

// Plain strings, not a union: OpenAI strict structured output rejects open objects, so args travel as JSON text.
const CODEX_SUFFIX='Respond only with the structured output. Choose exactly one action from the listed tools, or action "reply" with text if no tool fits. Put the tool arguments in args_json as a JSON object string ("{}" when none). Use text "" unless the action is "reply".';

export const defaultCodexExecutable=()=>resolveExecutable('codex');

export function codexPlanProvider(model:string|undefined,timeoutMs:number,opts:{executable?:string;workdir?:string;effort?:string;health?:PlanHealth}={}):Provider{
  const executable=opts.executable??process.env.CAT_CODEX??defaultCodexExecutable();
  const workdir=opts.workdir??join(tmpdir(),'cat-town-codex');
  return async(messages,tools,signal,ai):Promise<ModelReply>=>{
    const effort=ai?.effort??opts.effort,chosenModel=ai?.model??model;
    mkdirSync(workdir,{recursive:true});
    // Each call gets its own empty directory for the schema and output files, so concurrent ballots never collide.
    const callDir=mkdtempSync(join(workdir,'call-'));
    try{
      const schemaPath=join(callDir,`${randomUUID()}.schema.json`),outPath=join(callDir,`${randomUUID()}.out.json`);
      const names=tools.map(t=>fnOf(t).name);
      writeFileSync(schemaPath,JSON.stringify({type:'object',properties:{action:{type:'string',enum:[...names,'reply']},args_json:{type:'string'},text:{type:'string'}},required:['action','args_json','text'],additionalProperties:false}));
      const {system:base,rest}=splitSystem(messages);
      const prompt=[base,CODEX_SUFFIX,transcript(rest,tools)].filter(Boolean).join('\n\n');
      const args=['exec','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--ignore-user-config','--ignore-rules','--color','never','--output-schema',schemaPath,'--output-last-message',outPath,...(chosenModel?['--model',chosenModel]:[]),...(effort?['-c',`model_reasoning_effort=${effort}`]:[]),'-'];
      // OPENAI_API_KEY is removed so the ChatGPT sign-in is used, not an API key.
      // Only a timeout that stands counts against the account (the CLI has no retry here).
      const run=await runCli(executable,args,prompt,callDir,timeoutMs,signal,{label:'Codex plan',dropEnv:['OPENAI_API_KEY']}).catch((err:any)=>{if(!signal.aborted&&/call timed out\.$/.test(err.message))opts.health?.('timeout');throw err;});
      const detail=(run.stderr||run.stdout).trim().slice(0,300);
      let raw:string|undefined;
      try{raw=readFileSync(outPath,'utf8');}catch{raw=undefined;}
      if(run.code!==0||raw===undefined){const {fault,error}=planFailure('Codex plan','chatgpt-plan',detail||`exit ${run.code}, no output`);opts.health?.(fault);throw error;}
      let out:any;
      try{out=JSON.parse(raw);}catch{throw new Error('Codex plan returned no structured action.');}
      if(!out||typeof out.action!=='string')throw new Error('Codex plan returned no structured action.');
      opts.health?.('ok');
      if(out.action==='reply')return {message:{role:'assistant',content:out.text||'(no reply)'}};
      if(!names.includes(out.action))throw new Error(`Codex plan chose an unknown action: ${out.action.slice(0,80)}`);
      let parsed:unknown;
      try{parsed=JSON.parse(String(out.args_json??'{}'));}catch{throw new Error('Codex plan returned malformed arguments.');}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Codex plan returned malformed arguments.');
      // The same slip as the Claude adapter: the text parameter's value left in the top-level text field.
      if(takesText(tools,out.action)&&(parsed as any).text===undefined&&out.text)(parsed as any).text=out.text;
      // The CLI does not report token usage here, so usage stays unknown rather than zero.
      return {message:{role:'assistant',content:'',tool_calls:[{id:'call_'+randomUUID(),type:'function',function:{name:out.action,arguments:JSON.stringify(parsed)}}]}};
    }finally{
      rmSync(callDir,{recursive:true,force:true});
    }
  };
}

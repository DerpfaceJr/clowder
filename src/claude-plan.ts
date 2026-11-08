// Model provider that runs the owner's Claude subscription through the official `claude` CLI in headless mode.
// Opt-in only (see models.ts). Calls count against the plan's limits. The CLI helpers here are shared with codex-plan.ts.
import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter,extname,join} from 'node:path';
import type {ModelReply, Provider} from './provider.ts';

export const LIMIT=/hit your (session|weekly|usage) limit|rate limit|usage limit/i;
export const AUTH=/authenticate|login|logged in/i;
export const ENV_DROP=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'];
// The command that signs each plan's CLI in again; the quest and the task error both name it. Keyed by the plan's Account service.
export const PLAN_SIGN_IN:Record<string,string>={'claude-plan':'claude','chatgpt-plan':'codex login'};
// What one plan call tells account health (accounts.ts): ok, or its fault. Other failures are a model error for that cat only.
export type PlanFault='ok'|'signin'|'limit'|'timeout'|'other';
export type PlanHealth=(fault:PlanFault)=>void;
// A failed plan call in plain words. Sign-in and limit problems are fatal (they stop the season); the rest is a model error.
export function planFailure(label:string,service:string,detail:string):{fault:PlanFault;error:Error}{
  const fatal=(fault:PlanFault,message:string)=>({fault,error:Object.assign(new Error(message),{fatal:true})});
  if(LIMIT.test(detail))return fatal('limit',`${label} usage limit reached: ${detail}`);
  if(AUTH.test(detail))return fatal('signin',`${label} needs you to sign in again — run \`${PLAN_SIGN_IN[service]}\` in a terminal.`);
  return {fault:'other',error:new Error(`${label} call failed: ${detail.slice(0,300)}`)};
}
export const SYSTEM_SUFFIX='Respond only with the structured output. Choose exactly one action from the listed tools, or action "reply" with text if no tool fits.';

export const fnOf=(t:any)=>t.function??t;
// True when the named tool declares a text parameter; shared by the Claude and Codex adapters.
export const takesText=(tools:any[],action:string)=>!!fnOf(tools.find(t=>fnOf(t).name===action)??{}).parameters?.properties?.text;
export const text=(v:unknown)=>typeof v==='string'?v:v==null?'':JSON.stringify(v);

export function splitSystem(messages:any[]){
  const sysAt=messages.findIndex(m=>m.role==='system');
  return {system:sysAt<0?'':text(messages[sysAt].content),rest:messages.filter((_,i)=>i!==sysAt)};
}

export const TOOLS_NOTE='These town tools are yours and available now: to use one, set action to its name and args to its parameters. A TOOL RESULT line is its answer; a result that says something was saved means it is done.';
export function transcript(messages:any[],tools:any[]):string{
  const lines=messages.map(m=>{
    if(m.role==='user')return `USER: ${text(m.content)}`;
    if(m.role==='assistant')return [`ASSISTANT: ${text(m.content)}`,...(m.tool_calls??[]).map((c:any)=>`TOOL CALL ${c.function.name} ${c.function.arguments}`)].join('\n');
    if(m.role==='tool')return `TOOL RESULT (${m.tool_call_id}): ${text(m.content)}`;
    return `SYSTEM: ${text(m.content)}`;
  });
  const toolList=tools.map(t=>{const f=fnOf(t);return `- ${f.name}: ${f.description??''}\n  parameters: ${JSON.stringify(f.parameters??{})}`;});
  // The CLI runs with its own tools off, so the model is told these are real and available, and how a call and its answer look.
  return [...lines,`TOOLS:\n${TOOLS_NOTE}\n${toolList.join('\n')}`,'Choose the next action.'].join('\n\n');
}

function schemaFor(tools:any[]){
  return {type:'object',properties:{action:{type:'string',enum:[...tools.map(t=>fnOf(t).name),'reply']},args:{type:'object'},text:{type:'string'}},required:['action']};
}

// A bare command name on Windows is searched on PATH for .exe and .cmd, which Node's spawn does not do for .cmd.
export function resolveExecutable(exe:string):string{
  if(process.platform!=='win32'||extname(exe)||/[\\/]/.test(exe))return exe;
  for(const dir of (process.env.PATH??'').split(delimiter).filter(Boolean))
    for(const ext of ['.exe','.cmd'])if(existsSync(join(dir,exe+ext)))return join(dir,exe+ext);
  return exe;
}

// cmd.exe quoting for .cmd wrappers: MSVCRT rules for the argument, then the whole line is quoted by cmd /s.
const winQuote=(a:string)=>`"${a.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;

// The operating system's own variables, the only ones from the owner's shell a child gets (Hermes's spike allow-list, hermes.ts).
export const OS_ENV=['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','PATHEXT','COMSPEC','TEMP','TMP','USERPROFILE','USERNAME','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','OS','ProgramData','ProgramFiles','SystemDrive','HOME'];
// A CLI run's environment (security pass M3): those, the POSIX equivalents, proxies, and each CLI's own home. A token or cloud key the owner keeps in
// the shell (GITHUB_TOKEN, AWS_*) never reaches a run that reads untrusted text. Gemini's sign-in variables go to Gemini runs only (GEMINI_ENV).
export const CLI_ENV=[...OS_ENV,'ProgramFiles(x86)','ProgramW6432','USER','LOGNAME','SHELL','LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR',
  'DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','CLAUDE_CONFIG_DIR','CLAUDE_CODE_GIT_BASH_PATH','CODEX_HOME'];
export const GEMINI_ENV=['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_APPLICATION_CREDENTIALS'];

export function spawnCli(exe:string,args:string[],opts:{cwd:string;dropEnv:string[];keepEnv?:string[];env?:Record<string,string>}):ChildProcessWithoutNullStreams{
  // Only allow-listed names from the parent; extra variables merge over them; the drops still apply last, so a connector cannot re-add an API key.
  const env:NodeJS.ProcessEnv={};
  for(const k of [...CLI_ENV,...opts.keepEnv??[]])if(process.env[k]!==undefined)env[k]=process.env[k];
  Object.assign(env,opts.env);
  for(const k of opts.dropEnv)delete env[k];
  const cmd=resolveExecutable(exe);
  // A .cmd wrapper (npm installs) needs cmd.exe. Newlines cannot pass through a cmd line, so they become spaces on that path only.
  const viaCmd=process.platform==='win32'&&/\.(cmd|bat)$/i.test(cmd);
  return viaCmd
    ?spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`"${[winQuote(cmd),...args.map(a=>winQuote(a.replace(/\r?\n/g,' ')))].join(' ')}"`],{cwd:opts.cwd,env,windowsHide:true,windowsVerbatimArguments:true})
    :spawn(cmd,args,{cwd:opts.cwd,env,windowsHide:true});
}

// On Windows, killing the cmd.exe wrapper alone leaves its child (and any port it holds) running.
export function stopCli(child:ChildProcessWithoutNullStreams){
  if(process.platform==='win32'&&child.pid)spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true});
  else child.kill();
}

export type CliResult={stdout:string;stderr:string;code:number|null};
// Rejects with code (e.g. ENOENT) when the executable cannot be started.
export function runCli(exe:string,args:string[],input:string,cwd:string,timeoutMs:number,signal:AbortSignal,opts:{label:string;dropEnv:string[];keepEnv?:string[]}):Promise<CliResult>{
  const child=spawnCli(exe,args,{cwd,dropEnv:opts.dropEnv,keepEnv:opts.keepEnv});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',timer:NodeJS.Timeout|undefined;
    const onAbort=()=>stop(new Error('Stopped by owner.'));
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);};
    // Reject at once: on Windows the killed cmd.exe can leave its child holding the pipes open.
    const stop=(err:Error)=>{done();stopCli(child);reject(err);};
    timer=setTimeout(()=>stop(new Error(`${opts.label} call timed out.`)),timeoutMs);
    if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
    child.on('error',err=>{done();reject(Object.assign(new Error(`Could not start ${opts.label}: ${err.message}`),{code:(err as NodeJS.ErrnoException).code}));});
    child.on('close',code=>{done();resolve({stdout,stderr,code});});
  });
}

// Token counts and cost from the CLI's JSON result, in the shape the providers report.
export const usageOf=(result:any)=>{const u=result?.usage??{};return {prompt_tokens:(u.input_tokens??0)+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0),completion_tokens:u.output_tokens??0,cost_usd:result?.total_cost_usd};};

export function claudePlanProvider(model:string,timeoutMs:number,opts:{executable?:string;workdir?:string;effort?:string;health?:PlanHealth}={}):Provider{
  const executable=opts.executable??process.env.CAT_CLAUDE??'claude';
  const workdir=opts.workdir??join(tmpdir(),'cat-town-claude');
  return async(messages,tools,signal,ai):Promise<ModelReply>=>{
    mkdirSync(workdir,{recursive:true});
    const {system:base,rest}=splitSystem(messages);
    const system=[base,SYSTEM_SUFFIX].filter(Boolean).join('\n\n');
    // Model and effort are argv entries, never shell text. Both were checked against allowed lists when saved.
    const effort=ai?.effort??opts.effort;
    // The system prompt goes in a file: as an argv entry a long Mayor prompt overflows the Windows command line (spawn ENAMETOOLONG).
    const systemFile=join(workdir,`system-${randomUUID()}.txt`);
    writeFileSync(systemFile,system,'utf8');
    const args=['-p','--output-format','json','--json-schema',JSON.stringify(schemaFor(tools)),'--model',ai?.model??model,...(effort?['--effort',effort]:[]),'--tools','','--setting-sources','','--strict-mcp-config','--disable-slash-commands','--no-session-persistence','--system-prompt-file',systemFile];
    let run:CliResult;
    const once=()=>runCli(executable,args,transcript(rest,tools),workdir,timeoutMs,signal,{label:'Claude plan',dropEnv:ENV_DROP});
    // A real turn finishes well inside the limit, so a timeout is a stalled CLI: it is tried once more before the task fails.
    try{run=await once().catch((e:Error)=>{if(signal.aborted||!/call timed out\.$/.test(e.message))throw e;return once();});}
    // Only a timeout that survived the retry counts against the account.
    catch(err:any){if(!signal.aborted&&/call timed out\.$/.test(err.message))opts.health?.('timeout');throw err;}
    finally{rmSync(systemFile,{force:true});}
    const {stdout,stderr}=run;
    let result:any;
    try{result=JSON.parse(stdout);}catch{result=undefined;}
    if(!result||typeof result!=='object'){const {fault,error}=planFailure('Claude plan','claude-plan',stderr.trim()||stdout.trim()||'no JSON output');opts.health?.(fault);throw error;}
    if(result.is_error){
      // An error can come back with an empty result (a run that ended in error_during_execution, say): its subtype and errors say why.
      const detail=String(result.result||[result.subtype,...(Array.isArray(result.errors)?result.errors:[])].filter(Boolean).join(': ')||stderr.trim()||'no detail');
      const {fault,error}=planFailure('Claude plan','claude-plan',detail);
      opts.health?.(fault);
      throw error;
    }
    const out=result.structured_output;
    if(!out||typeof out.action!=='string')throw new Error('Claude plan returned no structured action.');
    const usage=usageOf(result);
    opts.health?.('ok');
    if(out.action==='reply')return {message:{role:'assistant',content:out.text||'(no reply)'},usage};
    if(!tools.some(t=>fnOf(t).name===out.action))throw new Error(`Claude plan chose an unknown action: ${out.action.slice(0,80)}`);
    // An argument the model put beside action instead of inside args (a title, say) is still that call's argument.
    // A tool that takes text gets the top-level text when args has none: the model often puts the fact there, not in args.
    const {action,text,args:given,...stray}=out,merged={...stray,...(given??{})},moved=takesText(tools,action)&&merged.text===undefined&&!!text;
    return {message:{role:'assistant',content:moved?'':text??'',tool_calls:[{id:'call_'+randomUUID(),type:'function',function:{name:action,arguments:JSON.stringify(moved?{...merged,text}:merged)}}]},usage};
  };
}

// Prompt diet eval (product plan 2.5). Runs each delegation case in scripts/prompt-eval-cases.json twice, once with the old
// system prompt (JSON of every cat, road and the last 30 tasks) and once with the compact one, and compares the first tool
// the model picks and the cat it targets.
//
//   node scripts/prompt-eval.mjs --provider hosted   run or resume (local, hosted, claude or chatgpt, as set up in Clowder)
//   node scripts/prompt-eval.mjs --status            cases done and agreement so far; calls nothing
//   node scripts/prompt-eval.mjs --dry               build both prompts for every case and print their sizes; calls nothing
//
// Options: --out <dir> (default %TEMP%\clowder-prompt-eval), --settings <models.json> (read only; default
// $CAT_TOWN_DATA\models.json, else %APPDATA%\Clowder\data\models.json). Progress is one line per case and prompt in
// <out>\<provider>.jsonl, written after every model call, so Ctrl-C is safe and the same command picks up where it stopped.
// Each case runs in its own temporary town; nothing is written to Clowder's data folder.
import {closeSync,existsSync,fsyncSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,rmSync,writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {register} from 'tsx/esm/api';
register();
const root=fileURLToPath(new URL('../',import.meta.url));
const {Store,roadId}=await import('../src/store.ts');
const {Town}=await import('../src/engine.ts');
const {loadConfig}=await import('../src/config.ts');
const {buildProviders,loadSettings}=await import('../src/models.ts');

const UNTESTED=[
  'Never run against a real model by its author: none was available on that machine. Checked: --dry, and a full run, an interrupted run and its resume against a fake Ollama that always answers delegate.',
  'Cases run on a small synthetic town, not the town as it was when each real delegation happened. No connectors, skills, economy or money lines in either prompt.',
  'Only the first model reply is scored (tool name and target cat). Tool results, later turns and the quality of the handed-over task are not.',
  'The old prompt is the new one with promptTown() lines swapped back to the old JSON; the old engine itself is not run.',
  'One sample per case and prompt: model randomness is not averaged out. Repeat with a fresh --out to see it.',
  'expect labels are the author\'s, mirroring real delegation pairs; agreement between old and new is the main measure.',
];
const args=process.argv.slice(2),opt=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined;};
const out=resolve(opt('--out')??join(tmpdir(),'clowder-prompt-eval'));
const fixture=JSON.parse(readFileSync(join(root,'scripts','prompt-eval-cases.json'),'utf8'));
const config=loadConfig(root);
const key=r=>`${r.case}:${r.variant}`;
const readRows=file=>existsSync(file)?readFileSync(file,'utf8').split('\n').flatMap(l=>{try{return l.trim()?[JSON.parse(l)]:[];}catch{return [];}}):[];// a torn last line is redone
const same=(a,b)=>a&&b&&a.tool===b.tool&&a.cat===b.cat;

// A fresh town per run, so one case's tasks and messages never reach another's prompt.
function makeTown(mode,provider){
  const dir=mkdtempSync(join(tmpdir(),'clowder-eval-town-')),looks={color:'#8a8a8a',icon:'cat'};
  const store=new Store(join(dir,'events.jsonl'),fixture.founders.map(c=>({...c,...looks})));
  for(const p of fixture.projects){
    const project=`project-${p.director}`;
    store.emit('task.created',{id:project,cat:p.director,from:'mayor',text:`Project: ${p.project}`,mode,status:'done'});
    store.emit('cat.created',{id:p.director,name:p.name,role:`Direct the project “${p.project}”: plan the work, recruit up to 4 reports, delegate to them, review their drafts, and report progress and owner decisions to the Mayor.`,...looks,manager:'mayor',directs:project});
    for(const [id,name,role] of p.reports){store.emit('cat.created',{id,name,role,...looks,manager:p.director});store.emit('road.created',{id:roadId(p.director,id),a:p.director,b:id});}
  }
  fixture.history.forEach(([cat,text],i)=>store.emit('task.created',{id:`h${i}`,cat,from:'mayor',text,mode,status:'done'}));
  return {dir,town:new Town(store,config,provider?{[mode]:provider}:{})};
}
// The old prompt: the same text with the compact town lines swapped back to the JSON the engine used to send.
function legacy(prompt,town,task){
  const p=town.promptTown(task),s=town.store.state;
  const lines=`${p.cats}\n${p.roads}`,json=`Town cats: ${JSON.stringify(s.cats)}\nRoads: ${JSON.stringify(s.roads.map(r=>[r.a,r.b]))}`;
  const tasks=`Task records: ${JSON.stringify(s.tasks.map(t=>({id:t.id,cat:t.cat,status:t.status,text:t.text})).slice(-30))}.`;
  if(!prompt.includes(lines)||!prompt.includes(p.tasks))throw new Error('The prompt no longer contains promptTown() output. Update legacy() in this script before trusting old-vs-new results.');
  return prompt.replace(lines,()=>json).replace(p.tasks,()=>tasks);
}
function prompts(c,mode,provider){
  const {dir,town}=makeTown(mode,provider);
  const task=town.createTask(c.asker,c.asker==='mayor'?'owner':'mayor',c.text,mode);
  return {dir,town,task};
}
// One model call. The reply is recorded and the engine is told to stop, so no tool ever runs.
async function runOne(c,variant,mode,real){
  let seen=null,failure=null;
  const provider=async(messages,tools,signal,ai)=>{
    if(seen||failure)return {message:{role:'assistant',content:'Eval stop.'}};
    try{
      const {message}=await real(messages,tools,signal,ai);
      const call=message?.tool_calls?.[0];let a={};try{a=JSON.parse(call?.function?.arguments||'{}');}catch{/* bad arguments still count as the tool chosen */}
      seen={tool:call?.function?.name??null,cat:call?(a.cat??a.name??null):null,chars:String(messages[0].content).length,...(call?{}:{said:String(message?.content??'').slice(0,160)})};
    }catch(error){failure=error;}
    return {message:{role:'assistant',content:'Eval stop.'}};
  };
  const {dir,town,task}=prompts(c,mode,provider);
  try{
    const ctx=town.context(task,0);
    if(variant==='old')ctx.messages[0].content=legacy(String(ctx.messages[0].content),town,task);
    await town.run(task,ctx);
  }finally{town.dispose();rmSync(dir,{recursive:true,force:true});}
  if(failure)throw failure;
  if(!seen)throw new Error('The engine never called the model for this case.');
  return seen;
}
function status(){
  const files=existsSync(out)?readdirSync(out).filter(f=>f.endsWith('.jsonl')):[];
  if(!files.length)console.log(`No progress in ${out} yet.`);
  for(const f of files){
    const rows=readRows(join(out,f)),by=new Map(rows.map(r=>[key(r),r]));
    const both=fixture.cases.filter(c=>by.has(`${c.id}:old`)&&by.has(`${c.id}:new`));
    const pct=(k,n)=>n?`${k}/${n} (${Math.round(100*k/n)}%)`:'0/0';
    const agree=both.filter(c=>same(by.get(`${c.id}:old`),by.get(`${c.id}:new`))).length;
    const right=v=>both.filter(c=>same(by.get(`${c.id}:${v}`),c.expect)).length;
    const mean=v=>{const xs=both.map(c=>by.get(`${c.id}:${v}`).chars);return xs.length?Math.round(xs.reduce((a,b)=>a+b,0)/xs.length):0;};
    console.log(`${f.replace(/\.jsonl$/,'')}: ${both.length} of ${fixture.cases.length} cases done with both prompts.`);
    console.log(`  old and new pick the same tool and cat: ${pct(agree,both.length)}`);
    console.log(`  match the expected cat: old ${pct(right('old'),both.length)}, new ${pct(right('new'),both.length)}`);
    console.log(`  mean system prompt chars: old ${mean('old')}, new ${mean('new')}`);
    for(const c of both.filter(c=>!same(by.get(`${c.id}:old`),by.get(`${c.id}:new`)))){const o=by.get(`${c.id}:old`),n=by.get(`${c.id}:new`);console.log(`  differs ${c.id}: old ${o.tool??'no tool'} ${o.cat??''}, new ${n.tool??'no tool'} ${n.cat??''} (expected ${c.expect.cat})`);}
  }
}
const untested=()=>console.log(`\nNot tested by this eval:\n${UNTESTED.map(u=>`- ${u}`).join('\n')}`);

if(args.includes('--status')){status();untested();process.exit(0);}
if(args.includes('--dry')){
  for(const c of fixture.cases){
    const {dir,town,task}=prompts(c,'demo');
    try{const now=String(town.context(task,0).messages[0].content);console.log(`${c.id} ${c.asker}: old ${legacy(now,town,task).length} chars, new ${now.length} chars`);}
    finally{town.dispose();rmSync(dir,{recursive:true,force:true});}
  }
  untested();process.exit(0);
}
const mode=opt('--provider');
if(!mode){console.error('Give --provider local|hosted|claude|chatgpt, or --status, or --dry.');process.exit(2);}
const settingsFile=resolve(opt('--settings')??join(process.env.CAT_TOWN_DATA??join(process.env.APPDATA??'','Clowder','data'),'models.json'));
const real=buildProviders(config,loadSettings(settingsFile),process.env)[mode];
if(!real){console.error(`${mode} is not set up in ${settingsFile}. Turn it on in Clowder's AI settings first.`);process.exit(2);}
mkdirSync(out,{recursive:true});
const file=join(out,`${mode}.jsonl`),done=new Set(readRows(file).map(key));
let stop=false;process.on('SIGINT',()=>{stop=true;console.log('\nStopping after this call; run the same command to resume.');});
for(const c of fixture.cases)for(const variant of ['old','new']){
  if(stop)break;
  if(done.has(`${c.id}:${variant}`))continue;
  const started=Date.now();
  let r;try{r=await runOne(c,variant,mode,real);}catch(error){console.error(`${c.id} ${variant}: ${error.message}\nStopped. Run the same command to retry from here.`);process.exit(1);}
  const row={case:c.id,variant,...r,ms:Date.now()-started};
  const fd=openSync(file,'a');try{writeSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  console.log(`${c.id} ${variant}: ${r.tool??'no tool'} ${r.cat??''}`);
}
status();untested();
process.exit(0);

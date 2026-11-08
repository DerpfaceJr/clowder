// Reads Claude Code plugin folders, Claude Code's installed plugins and git marketplaces. Clowder never runs anything in a
// plugin: hooks, lspServers and outputStyles are only listed as unsupported. Rules: docs/connectors-spec.md (Plugins).
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync} from 'node:fs';
import type {Dirent} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import type {Plugin, PluginAgent, PluginCommand, PluginServer, PluginSkill, PluginSource} from './connector-types.ts';

const LIST_MAX=200;
const SKILL_FILES_MAX=50;
const TEXT_MAX=12_000;
const SKILL_FILE_BYTES=1024*1024;
const COPY_BYTES=50*1024*1024;
const COPY_FILES=5000;
const GIT_TIMEOUT_MS=120_000;
const SKIP=new Set(['.git','node_modules']);
const GITHUB='https://github.com/';

export type MarketplacePlugin={name:string; description:string; category?:string; homepage?:string; version?:string; source:unknown};
export type Marketplace={name:string; plugins:MarketplacePlugin[]};
export type ClaudeCodePlugin={key:string; name:string; marketplace:string; version?:string; installPath:string};
export type Git=(args:string[], cwd:string, timeoutMs:number)=>Promise<{code:number|null; stdout:string; stderr:string}>;

// Parsed JSON is untyped, so `any` stays inside these read-only objects and every field is checked before use.
const isObj=(v:unknown):v is Record<string,any>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const clean=(v:unknown)=>typeof v==='string'?v.trim():'';
const isFile=(p:string)=>{try{return statSync(p).isFile();}catch{return false;}};
const isDir=(p:string)=>{try{return statSync(p).isDirectory();}catch{return false;}};
// True when target is not under root, after resolving both lexically.
const escapes=(root:string,target:string)=>{const r=relative(root,target);return isAbsolute(r)||r.split(/[\\/]/)[0]==='..';};
// The real path of target when it sits inside root (symlinks followed), else null.
const realInside=(root:string,target:string):string|null=>{try{const t=realpathSync(target);return escapes(realpathSync(root),t)?null:t;}catch{return null;}};
const entries=(dir:string):Dirent[]=>{try{return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1);}catch{return [];}};
const readJson=(file:string):unknown=>{try{return JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));}catch(err){throw new Error(`Broken JSON in ${file}: ${(err as Error).message}`);}};
const paths=(v:unknown):string[]=>(Array.isArray(v)?v:[v]).filter((p):p is string=>typeof p==='string');
const firstLine=(body:string)=>body.split('\n').map(s=>s.trim()).find(Boolean)??'';
const cutText=(s:string)=>s.length>TEXT_MAX?`${s.slice(0,TEXT_MAX)}\n… (cut at 12,000 characters)`:s;

// Regular files under root as '/'-joined paths, sorted, skipping symlinks and .git/node_modules. Stops after limit.
function walkFiles(root:string,limit=Infinity,rel=''):string[]{
  const out:string[]=[];
  for(const e of entries(join(root,rel))){
    if(out.length>=limit)break;
    const r=rel?`${rel}/${e.name}`:e.name;
    if(e.isDirectory()){if(!SKIP.has(e.name))out.push(...walkFiles(root,limit-out.length,r));}
    else if(e.isFile())out.push(r);
  }
  return out;
}

export const slug=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/,'')||'plugin';

const unquote=(v:string)=>{const q=/^(["'])([\s\S]*)\1$/.exec(v);return q?q[2]:v;};

// A leading ---...--- block of key: value lines. `>` folds its indented lines with spaces, `|` joins them with newlines.
// An indented line continues the previous value with a space; list items are ignored. CRLF is read as LF.
export function parseFrontmatter(text:string):{data:Record<string,string>; body:string}{
  const src=text.replace(/^﻿/,'').replace(/\r\n?/g,'\n');
  const m=/^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(src);
  if(!m)return {data:{}, body:src};
  const raw:Record<string,string>={};
  let key='', block='', parts:string[]=[];
  const close=()=>{if(key&&block)raw[key]=block==='>'?parts.join(' '):parts.join('\n');block='';parts=[];};
  for(const line of (m[1]??'').split('\n')){
    const top=/^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line);
    if(top){
      close();
      key=top[1];
      const v=top[2].trim();
      const b=/^([>|])[-+]?$/.exec(v);
      if(b){block=b[1];raw[key]='';}else raw[key]=v;
      continue;
    }
    if(!key||!/^\s/.test(line))continue;
    const t=line.trim();
    if(block){if(t)parts.push(t);continue;}
    if(!t||t.startsWith('- ')||t==='-')continue;
    raw[key]=raw[key]?`${raw[key]} ${t}`:t;
  }
  close();
  const data:Record<string,string>={};
  for(const [k,v] of Object.entries(raw))data[k]=unquote(v.trim());
  return {data, body:src.slice(m[0].length).replace(/^\n+/,'')};
}

// A skill folder holds SKILL.md. Returns the skill, or null when the folder is not one or was already seen.
function skillAt(folder:string,seen:Set<string>):PluginSkill|null{
  if(!isFile(join(folder,'SKILL.md')))return null;
  const real=realpathSync(folder);
  if(seen.has(real))return null;
  seen.add(real);
  const {data}=parseFrontmatter(readFileSync(join(folder,'SKILL.md'),'utf8'));
  return {name:clean(data.name)||basename(folder), description:clean(data.description).slice(0,300), dir:folder};
}

// Entries of a .mcp.json-style document: {mcpServers:{...}} or flat {name: config}, where a flat entry must look like a server.
function serverPairs(doc:unknown):[string,unknown][]{
  if(!isObj(doc))return [];
  if(isObj(doc.mcpServers))return Object.entries(doc.mcpServers).filter(([,v])=>isObj(v));
  return Object.entries(doc).filter(([,v])=>isObj(v)&&looksLikeServer(v));
}
const looksLikeServer=(v:Record<string,any>)=>'command' in v||'url' in v||'type' in v;

// Reads one plugin folder. Throws `Not a plugin folder` when it has none of the parts Clowder reads, and names a broken JSON file.
export function readPlugin(dir:string, source:PluginSource):Plugin{
  const root=resolve(dir);
  const manifestFile=join(root,'.claude-plugin','plugin.json');
  const mcpFile=join(root,'.mcp.json');
  if(!isDir(root)||!(existsSync(manifestFile)||isDir(join(root,'skills'))||isDir(join(root,'commands'))||isDir(join(root,'agents'))||existsSync(mcpFile)))throw new Error(`Not a plugin folder: ${dir}`);
  const manifest=existsSync(manifestFile)?readJson(manifestFile):{};
  const pj:Record<string,any>=isObj(manifest)?manifest:{};
  const name=clean(pj.name)||basename(root);
  const author=isObj(pj.author)?clean(pj.author.name):clean(pj.author);

  const skills:PluginSkill[]=[], seen=new Set<string>();
  const addSkill=(folder:string)=>{const s=skillAt(folder,seen);if(s&&skills.length<LIST_MAX)skills.push(s);};
  for(const e of entries(join(root,'skills')))if(e.isDirectory())addSkill(join(root,'skills',e.name));
  for(const p of paths(pj.skills)){
    const real=realInside(root,resolve(root,p));
    if(!real)continue;
    if(isFile(join(real,'SKILL.md')))addSkill(real);
    else for(const e of entries(real))if(e.isDirectory())addSkill(join(real,e.name));
  }

  const commands:PluginCommand[]=[];
  const cdir=join(root,'commands');
  for(const rel of walkFiles(cdir).filter(f=>f.endsWith('.md')).slice(0,LIST_MAX)){
    const {data,body}=parseFrontmatter(readFileSync(join(cdir,...rel.split('/')),'utf8'));
    const hint=clean(data['argument-hint']);
    commands.push({name:rel.slice(0,-3).replace(/[\\/]/g,':'), description:clean(data.description).slice(0,300)||firstLine(body).slice(0,120), ...(hint?{argumentHint:hint}:{}), body:body.slice(0,TEXT_MAX)});
  }

  const agents:PluginAgent[]=[];
  for(const e of entries(join(root,'agents')).filter(x=>x.isFile()&&x.name.endsWith('.md')).slice(0,LIST_MAX)){
    const {data,body}=parseFrontmatter(readFileSync(join(root,'agents',e.name),'utf8'));
    agents.push({name:clean(data.name)||e.name.slice(0,-3), description:clean(data.description).slice(0,300), prompt:body.slice(0,TEXT_MAX)});
  }

  // .mcp.json first, then plugin.json: the first name wins.
  const servers:PluginServer[]=[], names=new Set<string>();
  const addServers=(doc:unknown)=>{for(const [n,config] of serverPairs(doc))if(!names.has(n)){names.add(n);servers.push({name:n,config});}};
  if(existsSync(mcpFile))addServers(readJson(mcpFile));
  if(typeof pj.mcpServers==='string'){const real=realInside(root,resolve(root,pj.mcpServers));if(real&&isFile(real))addServers(readJson(real));}
  else if(pj.mcpServers!==undefined)addServers(pj.mcpServers);

  const unsupported:string[]=[];
  if(pj.hooks!==undefined||existsSync(join(root,'hooks','hooks.json')))unsupported.push('hooks');
  if(pj.lspServers!==undefined)unsupported.push('lspServers');
  if(pj.outputStyles!==undefined)unsupported.push('outputStyles');

  return {id:slug(name), name, version:clean(pj.version)||undefined, description:clean(pj.description)||undefined, author:author||undefined, dir:root, source, skills, commands, agents, servers, unsupported};
}

// SKILL.md without its frontmatter, then the skill's other files. With `file`: that one file, read only inside the skill.
export function readSkill(skill:PluginSkill, file?:string):string{
  if(file===undefined){
    const body=parseFrontmatter(readFileSync(join(skill.dir,'SKILL.md'),'utf8')).body;
    const files=walkFiles(skill.dir,SKILL_FILES_MAX+1).filter(f=>f!=='SKILL.md').slice(0,SKILL_FILES_MAX);
    return cutText(files.length?`${body}\n\nFiles in this skill: ${files.join(', ')}`:body);
  }
  const abs=resolve(skill.dir,file);
  if(escapes(skill.dir,abs))throw new Error('That file is outside the skill.');
  if(!existsSync(abs))throw new Error('No such file in this skill.');
  const real=realInside(skill.dir,abs);
  if(!real)throw new Error('That file is outside the skill.');
  if(!isFile(real)||statSync(real).size>=SKILL_FILE_BYTES)throw new Error('That file is not a regular file under 1 MB.');
  return cutText(readFileSync(real,'utf8'));
}

// $ARGUMENTS is the whole argument text, $1..$9 the whitespace-split words. Shell lines (!`cmd`) are never run.
export function expandCommand(cmd:PluginCommand, argText:string):string{
  const body=cmd.body.replace(/!`[^`\n]*`/g,'(shell output not available)');
  const words=argText.trim()?argText.trim().split(/\s+/):[];
  const out=body.replace(/\$ARGUMENTS|\$([1-9])/g,(_,d:string|undefined)=>d?(words[Number(d)-1]??''):argText);
  return /\$ARGUMENTS|\$[1-9]/.test(body)||!argText.trim()?out:`${out}\n\nArguments: ${argText.trim()}`;
}

// `/<plugin id or name>:<command>` picks that plugin's command; a bare `/<command>` only when exactly one plugin has it.
export function findCommand(text:string, plugins:Plugin[]):{plugin:Plugin; command:PluginCommand; args:string}|null{
  const m=/^\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if(!m)return null;
  const token=m[1], args=(m[2]??'').trim();
  for(const plugin of plugins)for(const id of [plugin.id,plugin.name]){
    if(!token.startsWith(`${id}:`))continue;
    const command=plugin.commands.find(c=>c.name===token.slice(id.length+1));
    if(command)return {plugin,command,args};
  }
  const hits=plugins.flatMap(plugin=>plugin.commands.filter(c=>c.name===token).map(command=>({plugin,command})));
  return hits.length===1?{...hits[0]!,args}:null;
}

export const agentRole=(agent:PluginAgent)=>`${agent.description} ${agent.prompt}`.replace(/\s+/g,' ').trim().slice(0,600);

// Claude Code's installed plugins, read from one file under home. The first entry of each key whose folder exists is taken.
// Loose skills in ~/.claude/skills: one folder each with a SKILL.md, the way Claude Code keeps skills that came without a plugin.
export function localSkills(home:string):PluginSkill[]{
  const root=join(home,'.claude','skills'),seen=new Set<string>();
  return entries(root).filter(e=>e.isDirectory()).flatMap(e=>{const s=skillAt(join(root,e.name),seen);return s?[s]:[];});
}

const STOP=new Set(['the','and','for','with','that','this','from','into','about','help','make','some','any','skill','skills','plugin','plugins','tool','tools']);
/** Entries ranked by how many query words appear in them, a name hit counting double. An entry that matches no word is left out. */
export function rankByWords<T extends {name:string; description:string}>(items:T[], query:string, max=8):T[]{
  const words=[...new Set(query.toLowerCase().match(/[a-z0-9]+/g)??[])].filter(w=>w.length>1&&!STOP.has(w));
  const score=(x:T)=>{const n=x.name.toLowerCase(),d=x.description.toLowerCase();return words.reduce((s,w)=>s+(n.includes(w)?2:0)+(d.includes(w)?1:0),0);};
  return items.map(x=>({x,s:score(x)})).filter(r=>r.s>0).sort((a,b)=>b.s-a.s).slice(0,max).map(r=>r.x);
}

export function claudeCodePlugins(home:string):ClaudeCodePlugin[]{
  let doc:unknown;
  try{doc=JSON.parse(readFileSync(join(home,'.claude','plugins','installed_plugins.json'),'utf8'));}catch{return [];}
  const plugins:Record<string,any>=isObj(doc)&&isObj(doc.plugins)?doc.plugins:{};
  const out:ClaudeCodePlugin[]=[];
  for(const [key,list] of Object.entries(plugins)){
    const hit=Array.isArray(list)?list.find(e=>isObj(e)&&typeof e.installPath==='string'&&isDir(e.installPath)):undefined;
    if(!hit)continue;
    const at=key.lastIndexOf('@');
    out.push({key, name:at>0?key.slice(0,at):key, marketplace:at>0?key.slice(at+1):'', ...(clean(hit.version)?{version:clean(hit.version)}:{}), installPath:hit.installPath});
  }
  return out;
}

// Recursive copy of a plugin folder. Skips .git, node_modules and symlinks; over 50 MB or 5,000 files throws.
// Written to a temp folder, then renamed over dest, so a failed copy never leaves a half-written plugin.
// `limits` defaults to the spec values; the test lowers them so the limit path runs without writing 5,000 files.
export function copyPlugin(src:string, dest:string, limits={files:COPY_FILES, bytes:COPY_BYTES}):void{
  if(!isDir(src))throw new Error(`Not a folder: ${src}`);
  const files=walkFiles(src,limits.files+1);
  if(files.length>limits.files)throw new Error('Plugin has too many files.');
  let bytes=0;
  for(const f of files){bytes+=statSync(join(src,...f.split('/'))).size;if(bytes>limits.bytes)throw new Error('Plugin is too large.');}
  const tag=randomBytes(6).toString('hex');
  const temp=`${dest}.tmp-${tag}`, old=`${dest}.old-${tag}`;
  mkdirSync(dirname(dest),{recursive:true});
  try{
    mkdirSync(temp,{recursive:true});
    for(const f of files){const to=join(temp,...f.split('/'));mkdirSync(dirname(to),{recursive:true});copyFileSync(join(src,...f.split('/')),to);}
    const had=existsSync(dest);
    if(had)renameSync(dest,old);
    try{renameSync(temp,dest);}catch(err){if(had)renameSync(old,dest);throw err;}
    if(had){try{rmSync(old,{recursive:true,force:true});}catch{/* the old copy is left behind; harmless */}}
  }catch(err){rmSync(temp,{recursive:true,force:true});throw err;}
}

// ---- Marketplaces ----

export function readMarketplace(dir:string):Marketplace{
  const file=join(dir,'.claude-plugin','marketplace.json');
  const doc=existsSync(file)?readJson(file):undefined;
  if(!isObj(doc))throw new Error(`Not a marketplace: ${dir}`);
  const plugins:MarketplacePlugin[]=[];
  for(const p of Array.isArray(doc.plugins)?doc.plugins:[]){
    if(!isObj(p)||!clean(p.name))continue;
    plugins.push({name:clean(p.name), description:clean(p.description).slice(0,300), ...(clean(p.category)?{category:clean(p.category)}:{}), ...(clean(p.homepage)?{homepage:clean(p.homepage)}:{}), ...(clean(p.version)?{version:clean(p.version)}:{}), source:p.source});
  }
  return {name:clean(doc.name)||basename(dir), plugins};
}

// Only https (and file, when a test allows it) reaches git. Anything else throws before git is started.
export function checkGitUrl(url:string, allowFile=false):void{
  let protocol='';
  try{protocol=new URL(url).protocol;}catch{/* not a URL at all */}
  if(protocol==='https:'||(allowFile&&protocol==='file:'))return;
  throw new Error('Only https:// git URLs are allowed.');
}

// Real git with an argv array only, never a shell. Output is collected whole; a run past timeoutMs is killed.
export const gitRunner:Git=(args,cwd,timeoutMs)=>new Promise(resolvePromise=>{
  let stdout='', stderr='', done=false;
  const child=spawn('git',args,{cwd,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  const finish=(code:number|null)=>{if(done)return;done=true;clearTimeout(timer);resolvePromise({code,stdout,stderr});};
  const timer=setTimeout(()=>{stderr+='\ntimed out';try{child.kill('SIGKILL');}catch{/* already gone */}finish(null);},timeoutMs);
  child.stdout.setEncoding('utf8').on('data',(d:string)=>{stdout+=d;});
  child.stderr.setEncoding('utf8').on('data',(d:string)=>{stderr+=d;});
  child.on('error',(err:Error)=>{stderr+=err.message;finish(null);});
  child.on('close',(code:number|null)=>finish(code));
});

const lastLine=(s:string)=>s.trim().split(/\r?\n/).pop()||'git failed';
// Runs one git command and returns its stdout, or throws with the last line of stderr.
async function gitRun(run:Git,args:string[],cwd:string):Promise<string>{
  const r=await run(args,cwd,GIT_TIMEOUT_MS);
  if(r.code!==0)throw new Error(`git ${args[0]==='-C'?args[2]:args[0]} failed: ${lastLine(r.stderr)}`);
  return r.stdout;
}

// Clones the marketplace on first use, then fetches and resets it to the remote's head.
export async function syncMarketplace(url:string, dir:string, run:Git=gitRunner, allowFile=false):Promise<void>{
  checkGitUrl(url,allowFile);
  if(existsSync(join(dir,'.git'))){
    await gitRun(run,['-C',dir,'fetch','--depth','1','origin'],dir);
    await gitRun(run,['-C',dir,'reset','--hard','FETCH_HEAD'],dir);
    return;
  }
  mkdirSync(dirname(dir),{recursive:true});
  await gitRun(run,['clone','--depth','1','--',url,dir],dirname(dir));
}

// Resolves one marketplace entry to a folder on disk. Remote sources are cloned into a new folder under workDir and,
// when pinned, checked out at their sha. The returned sha is what is actually checked out.
export async function fetchPluginSource(entry:{name?:string; source:unknown}, marketplaceDir:string, workDir:string, run:Git=gitRunner, allowFile=false):Promise<{dir:string; sha?:string}>{
  const src=entry.source;
  if(typeof src==='string'){
    const dir=resolve(marketplaceDir,src);
    if(escapes(marketplaceDir,dir)||!realInside(marketplaceDir,dir)||!isDir(dir))throw new Error(`Plugin source not inside the marketplace or missing: ${src}`);
    return {dir};
  }
  if(!isObj(src))throw new Error('Unsupported plugin source.');
  const kind=src.source, ref=src.ref, sha=src.sha;
  if(!['github','url','git-subdir'].includes(kind))throw new Error('Unsupported plugin source.');
  if(kind==='github'&&!(typeof src.repo==='string'&&/^[\w.-]+\/[\w.-]+$/.test(src.repo)))throw new Error('A GitHub source needs repo as owner/name.');
  const url=kind==='github'?`${GITHUB}${src.repo}.git`:clean(src.url);
  checkGitUrl(url,allowFile);
  if(ref!==undefined&&(typeof ref!=='string'||!ref||ref.startsWith('-')))throw new Error('Bad ref.');
  if(sha!==undefined&&(typeof sha!=='string'||!/^[0-9a-f]{7,64}$/i.test(sha)))throw new Error('Bad sha.');
  const subpath=kind==='git-subdir'?clean(src.path):'';
  if(kind==='git-subdir'&&!subpath)throw new Error('A git-subdir source needs a path.');

  mkdirSync(workDir,{recursive:true});
  const dest=mkdtempSync(join(workDir,'src-'));
  try{
    await gitRun(run,['clone','--depth','1',...(ref?['--branch',ref]:[]),'--',url,dest],workDir);
    if(sha){
      await gitRun(run,['-C',dest,'fetch','--depth','1','origin',sha],dest);
      await gitRun(run,['-C',dest,'checkout','--detach',sha],dest);
    }
    const head=(await gitRun(run,['-C',dest,'rev-parse','HEAD'],dest)).trim();
    let dir=dest;
    if(subpath){
      const sub=resolve(dest,subpath);
      const real=escapes(dest,sub)?null:realInside(dest,sub);
      if(!real||!isDir(real))throw new Error(`git-subdir path not found: ${subpath}`);
      dir=real;
    }
    return {dir, sha: head};
  }catch(err){rmSync(dest,{recursive:true,force:true});throw err;}
}

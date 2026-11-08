// Run recipes for repo tools, and the rules for files a tool writes. Pure: no I/O. Rules: docs/workshop-spec.md.
// A recipe is argv only. Nothing here or in the workshop passes a string through a shell.
import {posix} from 'node:path';

export const RECIPE_BINARIES=['python3','pip','node','npm','npx','bash','sh','make'];
export const SETUP_MAX=8;
const ARGV_MAX=16;
const ARG_MAX=200;
export const OUTPUT_KINDS={png:'image',jpg:'image',jpeg:'image',webp:'image',mp4:'video',webm:'video',svg:'svg',html:'html',htm:'html',md:'markdown',markdown:'markdown',txt:'text',log:'text',csv:'text',json:'json'} as const;
export type OutputKind=typeof OUTPUT_KINDS[keyof typeof OUTPUT_KINDS];

export type Recipe={toolId:string;entry:string[];workdir:string|null;setup:string[][];description:string;long:boolean};

function fail(message:string):never{throw new Error(message);}

// A path inside the repo: relative, no traversal, no drive or absolute form. Returns the posix-normalised path.
export function repoPath(p:unknown,what:string):string{
  if(typeof p!=='string'||!p||p.length>ARG_MAX||/[\0\\\r\n]/.test(p))fail(`${what} must be a relative path inside the repo.`);
  if(p.startsWith('/'))fail(`${what} must be relative to the repo, not absolute.`);
  const n=posix.normalize(p);
  if(n==='..'||n.startsWith('../')||n.split('/').includes('..'))fail(`${what} may not leave the repo.`);
  return n;
}

// Each argument is checked on its own: no absolute path, no traversal segment, even after an option prefix such as -C= or --target=.
function checkArg(arg:string):void{
  if(arg.length>ARG_MAX||/[\0\r\n]/.test(arg))fail('An argument is too long or contains a control character.');
  const tail=arg.replace(/^--?[\w-]+=?/,'');
  if(tail.startsWith('/')||(arg.startsWith('/')))fail(`Argument "${arg}" points outside the repo.`);
  if(tail.split(/[/\\]/).includes('..'))fail(`Argument "${arg}" points outside the repo.`);
}

// Flags that run code from a string. The check is on the argument text, so combined forms such as -lc or -pe are caught too.
// The family is taken from the file name, so .venv/bin/python3.12 is checked like python3.
function checkFlags(name:string,args:string[]):void{
  const fam=/^python[\d.]*$/.test(name)?'python':/^(bash|sh|dash|zsh)$/.test(name)?'shell':name;
  for(const a of args){
    if(fam==='shell'&&(/^-[A-Za-z]*c[A-Za-z]*$/.test(a)||a==='--command'))fail(`${name} may not run a command string (-c). Name a script file inside the repo.`);
    if(fam==='python'&&/^-[A-Za-z]*c[A-Za-z]*$/.test(a))fail('python may not run a command string (-c). Name a script file inside the repo.');
    if(fam==='node'&&(/^-[A-Za-z]*[ep][A-Za-z]*$/.test(a)||a==='--eval'||a==='--print'))fail('node may not run a code string (-e or -p). Name a script file inside the repo.');
    if((fam==='npm'||fam==='npx')&&(/^-[A-Za-z]*c[A-Za-z]*$/.test(a)||a==='--call'||a==='--shell-auth-command'))fail(`${name} may not run a shell string (-c). Name a package script instead.`);
  }
  if(fam==='npm'&&(args[0]==='exec'||args[0]==='x'))fail('npm exec is not allowed. Name a package script instead.');
}

// argv[0] is either one of the allowlisted binaries, or a file path inside the repo such as .venv/bin/python or node_modules/.bin/tool.
export function checkArgv(argv:unknown,what:string):string[]{
  if(!Array.isArray(argv)||argv.length<1||argv.length>ARGV_MAX)fail(`${what} must be a list of 1 to ${ARGV_MAX} text values.`);
  if(!(argv as unknown[]).every(a=>typeof a==='string'))fail(`${what} must be text values only.`);
  const out=argv as string[];
  const bin=out[0];
  if(bin.includes('/')){
    repoPath(bin,'The program path');
  }else if(!RECIPE_BINARIES.includes(bin))fail(`The program ${bin} is not allowed. Use one of: ${RECIPE_BINARIES.join(', ')}, or a file inside the repo.`);
  out.slice(1).forEach(checkArg);
  checkFlags(posix.basename(bin),out.slice(1));
  return out;
}

// Adds the spec's install limits to package commands, so a model cannot drop them: npm runs with --ignore-scripts and pip takes wheels only.
export function setupArgv(argv:string[]):string[]{
  const bin=posix.basename(argv[0]);
  const verb=argv[1];
  if(bin==='npm'&&['ci','install','i'].includes(verb??'')&&!argv.includes('--ignore-scripts'))return [...argv,'--ignore-scripts'];
  if(bin==='pip'&&verb==='install'&&!argv.some(a=>a.startsWith('--only-binary')))return [...argv,'--only-binary=:all:'];
  return argv;
}

export function validateRecipe(input:unknown):Recipe{
  if(!input||typeof input!=='object')fail('A recipe needs toolId, entry and description.');
  const r=input as Record<string,unknown>;
  if(typeof r.toolId!=='string'||!/^cap\d{1,6}$/.test(r.toolId))fail('Give the toolId of an approved repo request, such as cap3.');
  const entry=checkArgv(r.entry,'entry');
  const workdir=r.workdir===undefined||r.workdir===null||r.workdir===''?null:repoPath(r.workdir,'workdir');
  if(r.setup!==undefined&&!Array.isArray(r.setup))fail('setup must be a list of commands.');
  const setupIn=(r.setup as unknown[]|undefined)??[];
  if(setupIn.length>SETUP_MAX)fail(`setup takes at most ${SETUP_MAX} steps.`);
  const setup=setupIn.map((step,i)=>checkArgv(step,`setup step ${i+1}`));
  const description=r.description;
  if(typeof description!=='string'||!description.trim()||description.length>200)fail('description must be 1 to 200 characters.');
  if(r.long!==undefined&&typeof r.long!=='boolean')fail('long must be true or false.');
  return {toolId:r.toolId,entry,workdir,setup,description:description.trim(),long:r.long===true};
}

// The kind an output file is stored as, from its name. null means the gallery has no kind for it, so it is skipped.
export function outputKind(name:string):OutputKind|null{
  const ext=posix.extname(name).slice(1).toLowerCase();
  return (OUTPUT_KINDS as Record<string,OutputKind>)[ext]??null;
}

// find prints "<bytes>\t<relative name>". A name with a tab or line break cannot be split safely, so it is skipped.
export function parseFindLines(text:string):{name:string;size:number}[]{
  const out:{name:string;size:number}[]=[];
  for(const line of text.split('\n')){
    const at=line.indexOf('\t');
    if(at<=0)continue;
    const size=Number(line.slice(0,at));
    const name=line.slice(at+1).replace(/\r$/,'');
    if(!Number.isInteger(size)||size<0||!name||name.includes('\t')||name.startsWith('/')||name.split('/').includes('..'))continue;
    out.push({name,size});
  }
  return out;
}

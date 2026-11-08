import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {agentRole, checkGitUrl, claudeCodePlugins, copyPlugin, expandCommand, fetchPluginSource, findCommand, gitRunner, parseFrontmatter, readMarketplace, readPlugin, readSkill, slug, syncMarketplace} from '../src/plugins.ts';
import type {Git} from '../src/plugins.ts';
import type {Plugin, PluginCommand, PluginSkill, PluginSource} from '../src/connector-types.ts';

const LOCAL:PluginSource={kind:'folder',ref:'test'};
const fixture=(name:string)=>fileURLToPath(new URL(`./fixtures/plugins/${name}`,import.meta.url));
const made:string[]=[];
const tmp=(prefix:string)=>{const d=mkdtempSync(join(tmpdir(),`${prefix}-`));made.push(d);return d;};
const put=(root:string,rel:string,body:string)=>{const f=join(root,...rel.split('/'));mkdirSync(dirname(f),{recursive:true});writeFileSync(f,body);return f;};
after(()=>{for(const d of made)rmSync(d,{recursive:true,force:true,maxRetries:3});});

test('frontmatter: quotes, continuation lines, folded and literal values, list items', ()=>{
  const fm=parseFrontmatter('---\ndescription: "Quoted: value"\nname: \'single\'\nargument-hint:\n  [file] more\ntools:\n  - Read\n  - Edit\nnote: >\n  folded\n  text\nlit: |\n  one\n  two\n---\nBody line\n');
  assert.deepEqual(fm.data,{description:'Quoted: value',name:'single','argument-hint':'[file] more',tools:'',note:'folded text',lit:'one\ntwo'});
  assert.equal(fm.body,'Body line\n');
});

test('frontmatter: CRLF reads like LF, no frontmatter keeps the whole text, an unclosed block is not frontmatter', ()=>{
  assert.deepEqual(parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n'),{data:{name:'x',description:'y'},body:'body\n'});
  assert.deepEqual(parseFrontmatter('# Title\nbody'),{data:{},body:'# Title\nbody'});
  assert.deepEqual(parseFrontmatter('---\nname: x\nbody'),{data:{},body:'---\nname: x\nbody'});
  assert.deepEqual(parseFrontmatter('---\n---\nhi'),{data:{},body:'hi'});
});

test('slug lowercases, dashes runs, trims, caps at 40 and falls back to plugin', ()=>{
  assert.equal(slug('Frontend Tools!!'),'frontend-tools');
  assert.equal(slug('  --A__b--  '),'a-b');
  assert.equal(slug(''),'plugin');
  assert.equal(slug('!!!'),'plugin');
  assert.equal(slug('a'.repeat(50)).length,40);
  assert.equal(slug(`${'x'.repeat(39)} y`),'x'.repeat(39));
});

test('a plugin folder: manifest, skills, nested commands, agents, flat servers and unsupported parts', ()=>{
  const root=fixture('sample');
  const p=readPlugin(root,LOCAL);
  assert.equal(p.id,'sample-tools');
  assert.equal(p.name,'Sample Tools');
  assert.equal(p.version,'1.2.0');
  assert.equal(p.author,'Ada');
  assert.equal(p.description,'A fixture plugin');
  assert.deepEqual(p.skills.map(s=>[s.name,s.description]),[['alpha','Alpha skill for tests'],['beta','Beta skill that folds its lines.']]);
  assert.equal(p.skills[0]!.dir,join(root,'skills','alpha'));
  assert.deepEqual(p.commands.map(c=>c.name),['frontend:component','hello']);
  assert.equal(p.commands[0]!.description,'Build a component named $ARGUMENTS.');
  assert.equal(p.commands[0]!.argumentHint,undefined);
  const hello=p.commands[1]!;
  assert.equal(hello.description,'Say hello');
  assert.equal(hello.argumentHint,'[name]');
  assert.ok(hello.body.startsWith('Say hello to $1'));
  assert.deepEqual(p.agents,[{name:'reviewer',description:'Reviews diffs for bugs',prompt:'You review code.\nBe brief.\n'}]);
  assert.deepEqual(p.servers.map(s=>s.name),['docs','local']);
  assert.deepEqual(p.servers[0]!.config,{type:'http',url:'https://example.com/mcp'});
  assert.deepEqual(p.unsupported,['hooks']);
});

test('mcpServers in both shapes: the first name wins, .mcp.json before plugin.json', ()=>{
  const p=readPlugin(fixture('wrapped'),LOCAL);
  assert.deepEqual(p.servers.map(s=>[s.name,s.config.command??s.config.url]),[['alpha','from-mcp-json'],['beta','https://example.com/beta']]);
  assert.deepEqual(p.unsupported,[]);
});

test('plugin.json: string paths for skills and servers, skill folders as skills, unsupported in order', ()=>{
  const d=tmp('plug-ext');
  put(d,'.claude-plugin/plugin.json',JSON.stringify({name:'Ext',skills:['./extra/one','./more'],mcpServers:'./servers/extra.json',hooks:{},outputStyles:'x',lspServers:{}}));
  put(d,'extra/one/SKILL.md','---\nname: one\n---\nOne.\n');
  put(d,'more/two/SKILL.md','Two.\n');
  put(d,'more/three/SKILL.md','Three.\n');
  put(d,'more/notes.txt','ignored');
  put(d,'servers/extra.json',JSON.stringify({mcpServers:{gamma:{command:'g'}}}));
  const p=readPlugin(d,LOCAL);
  assert.deepEqual(p.skills.map(s=>s.name).sort(),['one','three','two']);
  assert.deepEqual(p.servers.map(s=>s.name),['gamma']);
  assert.deepEqual(p.unsupported,['hooks','lspServers','outputStyles']);
});

test('a folder with no plugin parts is refused, and a broken JSON file is named in the error', ()=>{
  assert.throws(()=>readPlugin(tmp('empty'),LOCAL),/Not a plugin folder/);
  const bad=tmp('bad-json');
  put(bad,'.claude-plugin/plugin.json','{nope');
  assert.throws(()=>readPlugin(bad,LOCAL),/Broken JSON in .*plugin\.json/);
  const badMcp=tmp('bad-mcp');
  put(badMcp,'.mcp.json','{');
  assert.throws(()=>readPlugin(badMcp,LOCAL),/Broken JSON in .*\.mcp\.json/);
});

test('readSkill: body without frontmatter, the file list, and one file read only inside the skill', ()=>{
  const skills=readPlugin(fixture('sample'),LOCAL).skills;
  const alpha=skills[0]!, beta=skills[1]!;
  assert.equal(readSkill(alpha),'# Alpha\n\nUse the run script.\n\n\nFiles in this skill: notes.md, scripts/run.py');
  assert.equal(readSkill(beta),'Beta body.\n');
  // Raw read: with core.autocrlf on Windows the checkout may hold CRLF, so the line ending is not asserted.
  assert.match(readSkill(alpha,'scripts/run.py'),/^print\("hi"\)\r?\n$/);
  assert.throws(()=>readSkill(alpha,'../beta/SKILL.md'),/outside the skill/);
  assert.throws(()=>readSkill(alpha,join(fixture('sample'),'skills','beta','SKILL.md')),/outside the skill/);
  assert.throws(()=>readSkill(alpha,'nope.md'),/No such file/);
  assert.throws(()=>readSkill(alpha,'scripts'),/not a regular file/);
});

test('readSkill: a file over 1 MB is refused, long answers are cut at 12,000 characters, a symlink out of the skill is refused', async t=>{
  const d=tmp('skill-big');
  const skill:PluginSkill={name:'big',description:'',dir:d};
  put(d,'SKILL.md','x'.repeat(20_000));
  const cut=readSkill(skill);
  assert.equal(cut.slice(0,12_000),'x'.repeat(12_000));
  assert.ok(cut.endsWith('… (cut at 12,000 characters)'));
  writeFileSync(join(d,'huge.bin'),Buffer.alloc(1024*1024));
  assert.throws(()=>readSkill(skill,'huge.bin'),/under 1 MB/);
  const outside=put(tmp('outside'),'secret.txt','nope');
  try{symlinkSync(outside,join(d,'link.txt'));}catch{t.skip('symlinks need privileges on this platform');return;}
  assert.throws(()=>readSkill(skill,'link.txt'),/outside the skill/);
});

test('expandCommand: $ARGUMENTS, $1..$9, appended arguments, and shell lines that never run', ()=>{
  const cmd=(body:string):PluginCommand=>({name:'x',description:'',body});
  assert.equal(expandCommand(cmd('Run $ARGUMENTS with $1 and $2 and $3.'),'a  b'),'Run a  b with a and b and .');
  assert.equal(expandCommand(cmd('Plain text.'),'x y'),'Plain text.\n\nArguments: x y');
  assert.equal(expandCommand(cmd('Plain text.'),'  '),'Plain text.');
  assert.equal(expandCommand(cmd('Status:\n!`git status`\nDone $ARGUMENTS'),''),'Status:\n(shell output not available)\nDone ');
  assert.equal(expandCommand(cmd('!`echo $ARGUMENTS`'),'hi'),'(shell output not available)\n\nArguments: hi');
  assert.equal(expandCommand(cmd('A $ARGUMENTS B $1'),'x $2'),'A x $2 B x');
});

test('findCommand: namespaced, bare when unique, ambiguous and unknown answer null', ()=>{
  const plugin=(id:string,name:string,commands:string[]):Plugin=>({id,name,dir:'/x',source:LOCAL,skills:[],agents:[],servers:[],unsupported:[],commands:commands.map(c=>({name:c,description:'',body:c}))});
  const a=plugin('alpha','Alpha',['run','frontend:component']);
  const b=plugin('beta','Beta',['run','solo']);
  const hit=findCommand('/alpha:run go now',[a,b])!;
  assert.equal(hit.plugin,a);
  assert.equal(hit.command.name,'run');
  assert.equal(hit.args,'go now');
  assert.equal(findCommand('/Beta:solo',[a,b])?.plugin,b);
  assert.equal(findCommand('/alpha:frontend:component x',[a,b])?.command.name,'frontend:component');
  assert.equal(findCommand('/frontend:component',[a,b])?.plugin,a);
  assert.equal(findCommand('/solo',[a,b])?.plugin,b);
  assert.equal(findCommand('/solo line1\nline2',[a,b])?.args,'line1\nline2');
  assert.equal(findCommand('/run',[a,b]),null);
  assert.equal(findCommand('/nope',[a,b]),null);
  assert.equal(findCommand('/alpha:missing',[a,b]),null);
  assert.equal(findCommand('run',[a,b]),null);
});

test('agentRole collapses whitespace and cuts at 600', ()=>{
  assert.equal(agentRole({name:'x',description:'  Reviews\n  code ',prompt:'You\tcheck.\n\nNow.'}),'Reviews code You check. Now.');
  assert.equal(agentRole({name:'x',description:'d',prompt:'p'.repeat(1000)}).length,600);
});

test('claudeCodePlugins: the first existing entry of each key, from one file under the fake home', ()=>{
  const home=tmp('fake-home');
  const good=join(home,'installed','good'), second=join(home,'installed','second');
  mkdirSync(good,{recursive:true});
  mkdirSync(second,{recursive:true});
  put(home,'.claude/plugins/installed_plugins.json',JSON.stringify({version:2,plugins:{
    'good@market':[{installPath:good,version:'1.0.0',scope:'user'}],
    'missing@market':[{installPath:join(home,'nope'),version:'2',scope:'user'}],
    'second@market':[{installPath:join(home,'gone')},{installPath:second,version:'3',scope:'user'}],
  }}));
  assert.deepEqual(claudeCodePlugins(home),[
    {key:'good@market',name:'good',marketplace:'market',version:'1.0.0',installPath:good},
    {key:'second@market',name:'second',marketplace:'market',version:'3',installPath:second},
  ]);
  assert.deepEqual(claudeCodePlugins(tmp('no-file')),[]);
  put(home,'.claude/plugins/installed_plugins.json','{broken');
  assert.deepEqual(claudeCodePlugins(home),[]);
});

test('copyPlugin skips .git, node_modules and symlinks, replaces an old copy, and leaves no temp folder', ()=>{
  const src=tmp('plug-src');
  put(src,'.claude-plugin/plugin.json','{"name":"c"}');
  put(src,'skills/a/SKILL.md','v1');
  put(src,'node_modules/x/index.js','x');
  put(src,'.git/config','x');
  try{symlinkSync(join(src,'skills','a','SKILL.md'),join(src,'alias.md'));}catch{/* no symlinks here; the check below still holds */}
  const parent=tmp('plug-dest'), dest=join(parent,'copy');
  copyPlugin(src,dest);
  assert.equal(readFileSync(join(dest,'skills','a','SKILL.md'),'utf8'),'v1');
  assert.equal(existsSync(join(dest,'node_modules')),false);
  assert.equal(existsSync(join(dest,'.git')),false);
  assert.equal(existsSync(join(dest,'alias.md')),false);
  put(dest,'stale.txt','old');
  put(src,'skills/a/SKILL.md','v2');
  copyPlugin(src,dest);
  assert.equal(readFileSync(join(dest,'skills','a','SKILL.md'),'utf8'),'v2');
  assert.equal(existsSync(join(dest,'stale.txt')),false);
  assert.deepEqual(readdirSync(parent),['copy']);
});

test('copyPlugin refuses too many files and too many bytes; the spec limits are 5,000 files and 50 MB', ()=>{
  const many=tmp('plug-many');
  for(let i=0;i<4;i++)writeFileSync(join(many,`f${i}.txt`),'');
  assert.throws(()=>copyPlugin(many,join(tmp('out-many'),'copy'),{files:3,bytes:1e9}),/too many files/);
  const big=tmp('plug-big');
  writeFileSync(join(big,'a.bin'),Buffer.alloc(11));
  assert.throws(()=>copyPlugin(big,join(tmp('out-big'),'copy'),{files:9,bytes:10}),/too large/);
  writeFileSync(join(big,'huge.bin'),Buffer.alloc(50*1024*1024+1));
  assert.throws(()=>copyPlugin(big,join(tmp('out-huge'),'copy')),/too large/);
});

test('readMarketplace keeps named entries and cuts descriptions at 300', ()=>{
  const d=tmp('market-read');
  put(d,'.claude-plugin/marketplace.json',JSON.stringify({name:'m',plugins:[
    {name:'a',description:'A',category:'dev',homepage:'https://x.example',version:'1',source:'./plugins/a'},
    {description:'no name'},
    {name:'b',description:'x'.repeat(400),source:{source:'url',url:'https://e.example/x.git'}},
  ]}));
  const m=readMarketplace(d);
  assert.equal(m.name,'m');
  assert.deepEqual(m.plugins.map(p=>p.name),['a','b']);
  assert.deepEqual(m.plugins[0],{name:'a',description:'A',category:'dev',homepage:'https://x.example',version:'1',source:'./plugins/a'});
  assert.equal(m.plugins[1]!.description.length,300);
  assert.throws(()=>readMarketplace(tmp('not-market')),/Not a marketplace/);
});

test('git URLs are https only, file only when a test allows it; refused URLs never reach git', async()=>{
  checkGitUrl('https://github.com/a/b.git');
  for(const bad of ['http://example.com/x.git','git@github.com:a/b.git','ssh://git@github.com/a/b.git','file:///tmp/x.git','not a url'])
    assert.throws(()=>checkGitUrl(bad),/https:\/\//,bad);
  checkGitUrl('file:///tmp/x.git',true);
  const calls:string[][]=[];
  const spy:Git=async args=>{calls.push(args);return {code:0,stdout:'',stderr:''};};
  await assert.rejects(syncMarketplace('http://example.com/x.git',join(tmp('sync-refuse'),'m'),spy),/https:\/\//);
  await assert.rejects(fetchPluginSource({name:'x',source:{source:'url',url:'ssh://h/x'}},tmp('mk'),tmp('w'),spy),/https:\/\//);
  assert.deepEqual(calls,[]);
});

// Real git on local repos. Identity and signing are set per repo, never globally.
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
// Identity and signing go into the repo's own .git/config (no spawn, no global config). Each git call is slow on Windows.
const newRepo=(prefix:string)=>{const d=tmp(prefix);git(d,'init','-q');appendFileSync(join(d,'.git','config'),'[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');return d;};
const commit=(d:string,msg:string)=>{git(d,'add','-A');git(d,'commit','-q','-m',msg);};
const url=(d:string)=>pathToFileURL(d).href;

test('marketplace: sync from a local repo, then local, pinned url and git-subdir sources', async()=>{
  // One plugin repo serves both the pinned source and the git-subdir source, so the test runs few git commands.
  const plugin=newRepo('plug-repo');
  put(plugin,'.claude-plugin/plugin.json','{"name":"pinned"}');
  put(plugin,'VERSION.txt','v1');
  put(plugin,'plugins/tool/.claude-plugin/plugin.json','{"name":"tool"}');
  commit(plugin,'first');
  const first=git(plugin,'rev-parse','HEAD');
  put(plugin,'VERSION.txt','v2');
  commit(plugin,'second');

  const market=newRepo('market-src');
  const entries=[
    {name:'local',source:'./plugins/local'},
    {name:'pinned',source:{source:'url',url:url(plugin),sha:first}},
    {name:'tool',source:{source:'git-subdir',url:url(plugin),path:'plugins/tool'}},
  ];
  put(market,'.claude-plugin/marketplace.json',JSON.stringify({name:'test-market',plugins:entries}));
  put(market,'plugins/local/.claude-plugin/plugin.json','{"name":"local"}');
  commit(market,'market');

  const mdir=join(tmp('clones'),'market');
  await syncMarketplace(url(market),mdir,gitRunner,true);
  const m=readMarketplace(mdir);
  assert.equal(m.name,'test-market');
  assert.deepEqual(m.plugins.map(p=>p.name),['local','pinned','tool']);

  const work=join(tmp('work'),'w');
  const local=await fetchPluginSource(m.plugins[0]!,mdir,work,gitRunner,true);
  assert.equal(local.dir,join(mdir,'plugins','local'));
  assert.equal(local.sha,undefined);
  assert.equal(readPlugin(local.dir,LOCAL).name,'local');

  const pinned=await fetchPluginSource(m.plugins[1]!,mdir,work,gitRunner,true);
  assert.equal(pinned.sha,first);
  assert.equal(readFileSync(join(pinned.dir,'VERSION.txt'),'utf8'),'v1');

  const tool=await fetchPluginSource(m.plugins[2]!,mdir,work,gitRunner,true);
  assert.equal(readPlugin(tool.dir,LOCAL).name,'tool');
  assert.match(tool.sha!,/^[0-9a-f]{40}$/);

  await assert.rejects(fetchPluginSource({name:'x',source:'../outside'},mdir,work,gitRunner,true),/not inside the marketplace/);
  await assert.rejects(fetchPluginSource({name:'x',source:{source:'git-subdir',url:url(plugin),path:'../../..'}},mdir,work,gitRunner,true),/not found/);
  await assert.rejects(fetchPluginSource({name:'x',source:{source:'url',url:url(plugin),sha:'--upload-pack=x'}},mdir,work,gitRunner,true),/Bad sha/);
  await assert.rejects(fetchPluginSource({name:'x',source:{source:'url',url:url(plugin),ref:'-x'}},mdir,work,gitRunner,true),/Bad ref/);

  // A second sync fetches and resets to the new head.
  put(market,'.claude-plugin/marketplace.json',JSON.stringify({name:'test-market',plugins:[...entries,{name:'added',source:'./plugins/added'}]}));
  put(market,'plugins/added/.claude-plugin/plugin.json','{"name":"added"}');
  commit(market,'add');
  await syncMarketplace(url(market),mdir,gitRunner,true);
  assert.deepEqual(readMarketplace(mdir).plugins.map(p=>p.name),['local','pinned','tool','added']);
});

test('a failing git command rejects with the last line of its stderr', async()=>{
  const missing=url(join(tmp('none'),'missing'));
  await assert.rejects(syncMarketplace(missing,join(tmp('clone-fail'),'m'),gitRunner,true),/git clone failed: \S/);
});

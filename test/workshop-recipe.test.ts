import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateRecipe, checkArgv, setupArgv, outputKind, parseFindLines, repoPath} from '../src/workshop-recipe.ts';
import {act, apply, checkInvariants, initialState, startSeason} from '../src/economy.ts';
import type {EconomyState} from '../src/economy.ts';

const baseConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).economy;
const recipe=(extra:Record<string,unknown>)=>({toolId:'cap1',entry:['python3','main.py'],description:'make a video',...extra});

test('recipes accept argv of allowlisted programs and repo files', () => {
  const r=validateRecipe(recipe({workdir:'app',setup:[['python3','-m','venv','.venv'],['.venv/bin/pip','install','-r','requirements.txt']],long:true}));
  assert.deepEqual(r.entry,['python3','main.py']);
  assert.equal(r.workdir,'app');
  assert.equal(r.long,true);
  assert.equal(r.setup.length,2);
  assert.deepEqual(validateRecipe(recipe({entry:['.venv/bin/python','main.py']})).entry,['.venv/bin/python','main.py']);
  assert.deepEqual(validateRecipe(recipe({entry:['make','-C','sub','run']})).entry,['make','-C','sub','run']);
});

test('recipes refuse shells, command strings and programs outside the allowlist', () => {
  for(const entry of [['bash','-c','rm -rf /'],['bash','-lc','id'],['sh','-c','id'],['python3','-c','import os'],['python3','-Bc','x'],['node','-e','1'],['node','-p','1'],['node','--eval','1'],['npm','-c','x'],['npx','--call','x'],['npm','exec','x'],['curl','https://example.com'],['rm','-rf','x'],['/bin/sh','x.sh']])
    assert.throws(()=>validateRecipe(recipe({entry})),/not allowed|may not|not inside|absolute|outside|repo|allowlist/,JSON.stringify(entry));
});

test('recipe paths stay inside the repo', () => {
  for(const entry of [['python3','../x.py'],['python3','--target=/etc'],['python3','-C/abs'],['make','-C','../'],['./../x','a'],['.venv/../../x']])
    assert.throws(()=>validateRecipe(recipe({entry})),/outside|leave|absolute|repo/,JSON.stringify(entry));
  assert.throws(()=>validateRecipe(recipe({workdir:'../up'})),/leave|repo/);
  assert.throws(()=>validateRecipe(recipe({workdir:'/home/catworker'})),/absolute|repo/);
  assert.equal(repoPath('./a/b/../c','p'),'a/c');
});

test('setup is capped at eight steps and needs a description and a valid entry', () => {
  assert.throws(()=>validateRecipe(recipe({setup:Array(9).fill(['npm','ci'])})),/at most 8|8 steps/);
  assert.throws(()=>validateRecipe(recipe({description:'  '})),/description/);
  assert.throws(()=>validateRecipe(recipe({description:'x'.repeat(201)})),/description/);
  assert.throws(()=>validateRecipe(recipe({entry:Array(17).fill('a')})),/1 to 16/);
  assert.throws(()=>validateRecipe(recipe({toolId:'../x'})),/toolId/);
  assert.throws(()=>checkArgv(['python3','a\nb'],'entry'),/control|too long|outside|repo/);
});

test('install limits are added to package commands', () => {
  assert.deepEqual(setupArgv(['npm','ci']),['npm','ci','--ignore-scripts']);
  assert.deepEqual(setupArgv(['npm','ci','--ignore-scripts']),['npm','ci','--ignore-scripts']);
  assert.deepEqual(setupArgv(['.venv/bin/pip','install','-r','requirements.txt']),['.venv/bin/pip','install','-r','requirements.txt','--only-binary=:all:']);
  assert.deepEqual(setupArgv(['python3','-m','venv','.venv']),['python3','-m','venv','.venv']);
});

test('output files are typed by name and find lines with tabs or traversal are skipped', () => {
  assert.equal(outputKind('a/out.PNG'),'image');
  assert.equal(outputKind('clip.mp4'),'video');
  assert.equal(outputKind('notes.md'),'markdown');
  assert.equal(outputKind('data.bin'),null);
  assert.equal(outputKind('script.sh'),null);
  // A name with a tab cannot be split safely, and a name that climbs out of out/ is never copied.
  assert.deepEqual(parseFindLines('5\tout.txt\n7\tbad\tname.txt\n9\t../up.txt\n3\tdir/x.json\n'),[{name:'out.txt',size:5},{name:'dir/x.json',size:3}]);
});

test('a run recipe is proposed, decided by the Mayor, and passes the journal rules', () => {
  const config={...baseConfig,recipeReview:'mayor',maxActionsPerTick:50};
  let s:EconomyState=initialState();
  const log:any[]=[];
  const push=(events:any[])=>{for(const e of events){s=apply(s,e);log.push(e);}};
  push(startSeason(config,['scholar','mayor','banker'],1));
  let out=act(s,config,'scholar','k1','request_capability',{kind:'repo',need:'video maker',purpose:'make videos',source:'https://github.com/harry0703/MoneyPrinterTurbo'});
  push(out.events);
  out=act(s,config,'mayor','k2','decide_capability',{id:'cap1',approved:true,reason:'ok'});
  push(out.events);
  out=act(s,config,'scholar','k3','define_repo_tool',{toolId:'cap1',entry:['bash','-c','x'],description:'bad'});
  assert.equal(out.ok,false);
  out=act(s,config,'scholar','k4','define_repo_tool',{toolId:'cap1',entry:['python3','main.py'],description:'make a video',setup:[['python3','-m','venv','.venv']]});
  assert.equal(out.ok,true,out.result);
  push(out.events);
  assert.equal(s.capabilities[0].recipe?.status,'pending');
  out=act(s,config,'scholar','k5','decide_recipe',{id:'cap1',approved:true,reason:'self'});
  assert.equal(out.ok,false);
  out=act(s,config,'mayor','k6','decide_recipe',{id:'cap1',approved:true,reason:'runs a video tool'});
  assert.equal(out.ok,true,out.result);
  push(out.events);
  assert.equal(s.capabilities[0].recipe?.status,'approved');
  assert.deepEqual(checkInvariants(log),[]);
});

test('a recipe under cautious autonomy waits for the owner, and only the owner can decide it', () => {
  const config={...baseConfig,recipeReview:'owner',maxActionsPerTick:50};
  let s:EconomyState=initialState();
  const log:any[]=[];
  const push=(events:any[])=>{for(const e of events){s=apply(s,e);log.push(e);}};
  push(startSeason(config,['scholar','mayor','banker'],1));
  push(act(s,config,'scholar','k1','request_capability',{kind:'repo',need:'video maker',purpose:'make videos',source:'https://github.com/a/b'}).events);
  push(act(s,config,'mayor','k2','decide_capability',{id:'cap1',approved:true,reason:'ok'}).events);
  const defined=act(s,config,'scholar','k3','define_repo_tool',{toolId:'cap1',entry:['node','index.js'],description:'run it'});
  assert.equal(defined.ok,true,defined.result);
  push(defined.events);
  assert.equal(s.capabilities[0].recipe?.status,'needs_owner');
  assert.equal(act(s,config,'mayor','k4','decide_recipe',{id:'cap1',approved:true,reason:'x'}).ok,false);
  // The owner's decision is written by the server, as in the workshop route.
  log.push({type:'recipe.decided',id:'cap1',by:'owner',approved:true,reason:'yes'});
  assert.deepEqual(checkInvariants(log),[]);
  assert.deepEqual(checkInvariants([...log.slice(0,-1),{type:'recipe.decided',id:'cap1',by:'mayor',approved:true,reason:'no'}]).length>0,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {Pairing} from '../src/pairing.ts';
import {ModelHub, buildProviders, loadSettings, normalizeMode, registerModelRoutes, saveSettings} from '../src/models.ts';
import {runSeason} from '../src/season.ts';
import {CLI_ENV, stopCli} from '../src/claude-plan.ts';
// The fake CLIs read these; a real CLI run gets only CLI_ENV from this process's environment (security pass M3).
CLI_ENV.push('CAT_FAKE_LINK');

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const dir=mkdtempSync(join(tmpdir(),'models-'));
const win=process.platform==='win32';
// Fake CLIs: `claude auth status` prints JSON, `claude auth login` prints a URL and exits shortly after.
function fakeCli(name:string,body:string){
  const script=join(dir,`${name}.mjs`);
  writeFileSync(script,body);
  const exe=join(dir,win?`${name}.cmd`:name);
  if(win)writeFileSync(exe,`@"${process.execPath}" "${script}" %*\r\n`);
  else{writeFileSync(exe,`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);chmodSync(exe,0o755);}
  return exe;
}
const claudeIn=fakeCli('claude-in',`const a=process.argv.slice(2).join(' ');
if(a==='auth status')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));
else if(a.startsWith('auth login')){
  if(process.env.CLOWDER_LOGIN_URL_FILE)(await import('node:fs')).writeFileSync(process.env.CLOWDER_LOGIN_URL_FILE,'"https://claude.com/cai/oauth/authorize?code=1"\\r\\n');
  console.log('Open https://claude.com/cai/oauth/authorize?code=1 to sign in');setTimeout(()=>process.exit(0),10000);
}
`);
// Like the real CLI: it opens the browser through BROWSER (here the opener's file is written directly, so no real browser
// starts during tests) and prints the paste-code link. CAT_FAKE_LINK picks the link the "browser" was given.
const claudeAuto=fakeCli('claude-auto',`import {writeFileSync} from 'node:fs';
const a=process.argv.slice(2).join(' ');
if(a==='auth status')console.log(JSON.stringify({loggedIn:false,authMethod:'none'}));
else if(a.startsWith('auth login')){
  if(/open-browser\\.(cmd|sh)$/.test(process.env.BROWSER||''))writeFileSync(process.env.CLOWDER_LOGIN_URL_FILE,'"'+process.env.CAT_FAKE_LINK+'"\\r\\n');
  console.log('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback');
  setTimeout(()=>process.exit(0),1500);
}
`);
const claudeOut=fakeCli('claude-out',`console.log(JSON.stringify({loggedIn:false,authMethod:'none'}));process.exit(1);
`);
const missingCodex=join(dir,'no-such-codex');
// Port 9 (discard) is not serving Ollama, so local is unavailable on every machine.
const env=(extra:Record<string,string>={})=>({CAT_OLLAMA_BASE:'http://127.0.0.1:9',CAT_CODEX:missingCodex,CAT_CLAUDE:claudeIn,CAT_PROBE_MS:'60000',...extra});
const newDir=()=>mkdtempSync(join(tmpdir(),'models-state-'));

test('buildProviders offers local by default and follows the claude and chatgpt toggles', ()=>{
  assert.deepEqual(Object.keys(buildProviders(config,{},env())),['local']);
  assert.deepEqual(Object.keys(buildProviders(config,{},env({CAT_CLAUDE_PLAN:'1'}))).sort(),['claude','local']);
  assert.deepEqual(Object.keys(buildProviders(config,{claude:{enabled:false}},env({CAT_CLAUDE_PLAN:'1'}))),['local']);
  assert.deepEqual(Object.keys(buildProviders(config,{chatgpt:{enabled:true}},env())).sort(),['chatgpt','local']);
});

test('hosted comes from saved settings or the environment, and never over plain http', ()=>{
  const e=env({CAT_MODEL_BASE:'https://api.example.com/v1',CAT_MODEL:'m',CAT_MODEL_KEY:'k'});
  assert.ok(buildProviders(config,{},e).hosted);
  assert.ok(buildProviders(config,{hosted:{base:'https://saved.example.com/v1',model:'m2',key:'k2'}},env()).hosted);
  assert.equal(buildProviders(config,{},env({CAT_MODEL_BASE:'http://api.example.com/v1',CAT_MODEL:'m',CAT_MODEL_KEY:'k'})).hosted,undefined);
});

test('the old plan mode name is an alias for claude', ()=>{
  assert.equal(normalizeMode('plan'),'claude');
  assert.equal(normalizeMode('local'),'local');
});

test('settings round-trip keeps the key on disk, leaves no temp file, and a damaged file is refused', ()=>{
  const file=join(newDir(),'models.json');
  const saved={claude:{enabled:true},hosted:{base:'https://api.example.com/v1',model:'m',key:'sk-live-SECRET-1234'}};
  saveSettings(file,saved);
  assert.deepEqual(loadSettings(file),saved);
  assert.deepEqual(readdirSync(join(file,'..')),['models.json','secrets.v2.json'],'the key is in the SecretStore');
  assert.ok(!readFileSync(file,'utf8').includes('sk-live-SECRET-1234'));
  writeFileSync(file,'{damaged');
  assert.throws(()=>loadSettings(file),/damaged/);
});

test('status reports a signed-in Claude CLI, an absent Codex CLI with an install hint, and no secrets', async()=>{
  const hub=new ModelHub({file:join(newDir(),'models.json'),config,env:env()});
  const s=await hub.status();
  assert.equal(s.claude.installed,true);
  assert.equal(s.claude.loggedIn,true);
  assert.equal(s.claude.enabled,false);
  assert.equal(s.claude.available,false);
  assert.equal(s.chatgpt.installed,false);
  assert.match(s.chatgpt.installHint??'',/npm install -g @openai\/codex/);
  assert.equal(s.local.available,false);
  assert.deepEqual((await hub.list()).map(m=>m.id),['demo']);
});

test('a logged-out Claude CLI is reported as not signed in', async()=>{
  const hub=new ModelHub({file:join(newDir(),'models.json'),config,env:env({CAT_CLAUDE:claudeOut})});
  const s=await hub.status();
  assert.equal(s.claude.installed,true);
  assert.equal(s.claude.loggedIn,false);
  assert.equal(s.claude.configured,false);
});

test('saving settings rebuilds the same providers object, offers enabled providers, and never returns the key', async()=>{
  const file=join(newDir(),'models.json');
  const hub=new ModelHub({file,config,env:env()});
  const live=hub.providers;
  await hub.update({claude:{enabled:true},hosted:{base:'https://api.example.com/v1',model:'gpt-x',key:'sk-live-SECRET-1234'}});
  assert.equal(live,hub.providers);
  assert.ok(live.claude&&live.hosted);
  assert.equal(live.plan,live.claude);
  assert.equal(loadSettings(file).hosted?.key,'sk-live-SECRET-1234');
  assert.match(JSON.stringify(await hub.status()),/"keyLast4":"1234"/);
  assert.doesNotMatch(JSON.stringify(await hub.status()),/SECRET/);
  assert.ok((await hub.list()).some(m=>m.name==='Claude plan · haiku'));
  await assert.rejects(hub.update({hosted:{base:'http://api.example.com/v1',model:'m',key:'k'}}),/HTTPS/);
  await assert.rejects(hub.update({hosted:{base:'https://other.example.com/v1',model:'m'}}),/API key/);
  await hub.update({hosted:{base:'https://api.example.com/v1',model:'gpt-y'}});
  assert.equal(loadSettings(file).hosted?.key,'sk-live-SECRET-1234');
  await hub.update({hosted:null});
  assert.equal(live.hosted,undefined);
  assert.equal(loadSettings(file).hosted,undefined);
});

test('login starts the official CLI, returns its URL, and allows one sign-in per provider', async()=>{
  const hub=new ModelHub({file:join(newDir(),'models.json'),config,env:env(),loginWaitMs:60_000});
  const first=await hub.login('claude');
  assert.equal(first.started,true);
  assert.equal(first.url,'https://claude.com/cai/oauth/authorize?code=1');
  assert.equal(first.auto,true,'the link the CLI opened in the browser needs no code');
  const again=await hub.login('claude');
  assert.equal(again.alreadyRunning,true);
  assert.equal(again.auto,true);
  assert.throws(()=>hub.openLoginIn('chatgpt','edge'),/Start the sign-in first/);
  // The fake CLI would otherwise stay alive for its 10 s timer and hold this file open after the last test.
  stopCli((hub as any).logins.get('claude').child);
});

test('Claude sign-in returns the link the CLI opened in the browser, which needs no code, and ignores links on other sites', async()=>{
  const auto='https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5%2Fcallback';
  const prev=process.env.CAT_FAKE_LINK;
  try{
    process.env.CAT_FAKE_LINK=auto;
    const r=await new ModelHub({file:join(newDir(),'models.json'),config,env:env({CAT_CLAUDE:claudeAuto}),loginWaitMs:60_000}).login('claude');
    assert.equal(r.auto,true);
    assert.equal(r.url,auto);
    process.env.CAT_FAKE_LINK='https://evil.example/authorize?x=1';
    const other=await new ModelHub({file:join(newDir(),'models.json'),config,env:env({CAT_CLAUDE:claudeAuto}),loginWaitMs:60_000}).login('claude');
    assert.equal(other.auto,undefined);
    assert.match(other.url??'',/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&redirect_uri=https/);
  }finally{if(prev===undefined)delete process.env.CAT_FAKE_LINK;else process.env.CAT_FAKE_LINK=prev;}
});

test('login reports a missing CLI with its install command', async()=>{
  const hub=new ModelHub({file:join(newDir(),'models.json'),config,env:env()});
  await assert.rejects(hub.login('chatgpt'),/not installed\. Install it with: npm install -g @openai\/codex/);
});

test('season accepts the old plan mode as an alias and rejects unknown modes', async()=>{
  const dataDir=newDir();
  const r=await runSeason({name:'alias',mode:'plan',seed:1,days:1,dataDir,config,provider:async()=>({message:{role:'assistant',content:'no tool'}})});
  assert.equal(r.done,true);
  await assert.rejects(runSeason({name:'nope',mode:'nope' as any,seed:1,days:1,dataDir,config}),/Unknown mode nope/);
});

test('model routes are owner-only: LAN viewers and proxied loopback get 403, the owner gets the status without secrets', async()=>{
  const hub=new ModelHub({file:join(newDir(),'models.json'),config,env:env()});
  const app=Fastify();
  installAccess(app,true,['192.168.1.20'],8787,new Pairing(join(newDir(),'devices.json'),config.remote),undefined,'test-owner');
  registerModelRoutes(app,hub);
  await app.ready();
  try{
    const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
    const remote={host:'192.168.1.20:8787'};
    const share=await app.inject({url:'/api/sharing',headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}});
    const token=new URL(share.json().urls[0]).hash.slice(6);
    const login=await app.inject({method:'POST',url:'/api/viewer-session',remoteAddress:'192.168.1.21',headers:remote,payload:{token}});
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const viewer={...remote,cookie,'x-town-action':'owner'};
    // The viewer's cookie gets past installAccess on GET, so the route guard is what returns 403 here.
    assert.equal((await app.inject({url:'/api/models/status',remoteAddress:'192.168.1.21',headers:viewer})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/models/claude/login',remoteAddress:'192.168.1.21',headers:viewer})).statusCode,403);
    // Loopback with a proxy header is not the owner: the valid viewer cookie gets past installAccess, so the route guard answers 403.
    assert.equal((await app.inject({url:'/api/models/status',headers:{...viewer,host:'localhost:8787','x-forwarded-for':'127.0.0.1'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/models/settings',headers:{...owner,'x-forwarded-for':'127.0.0.1'},payload:{claude:{enabled:true}}})).statusCode,403);
    const status=await app.inject({url:'/api/models/status',headers:owner});
    assert.equal(status.statusCode,200);
    assert.equal(status.json().claude.installed,true);
    const saved=await app.inject({method:'POST',url:'/api/models/settings',headers:owner,payload:{hosted:{base:'https://api.example.com/v1',model:'m',key:'sk-live-SECRET-1234'}}});
    assert.equal(saved.statusCode,200);
    assert.doesNotMatch(saved.body,/SECRET/);
    const bad=await app.inject({method:'POST',url:'/api/models/settings',headers:owner,payload:{hosted:{base:'http://api.example.com/v1',model:'m',key:'k'}}});
    assert.equal(bad.statusCode,400);
    assert.match(bad.json().error,/HTTPS/);
    assert.equal((await app.inject({method:'POST',url:'/api/models/claude/login',headers:owner})).statusCode,200);
  }finally{
    for(const entry of (hub as any).logins.values())stopCli(entry.child);
    await app.close();
  }
});

test('a Claude check that fails after a signed-in answer keeps Claude listed', async()=>{
  // The first `auth status` answers signed in; every later one crashes without JSON, like a slow or broken CLI start.
  const count=join(dir,'flaky-count');
  const flaky=fakeCli('claude-flaky',`import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const n=existsSync(${JSON.stringify(count)})?Number(readFileSync(${JSON.stringify(count)},'utf8')):0;writeFileSync(${JSON.stringify(count)},String(n+1));
if(n===0)console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));else{console.error('boom');process.exit(3);}
`);
  const file=join(newDir(),'models.json');writeFileSync(file,JSON.stringify({claude:{enabled:true}}));
  const hub=new ModelHub({file,config,env:env({CAT_CLAUDE:flaky})});
  assert.equal((await hub.status()).claude.available,true);
  (hub as any).invalidate();
  const again=await hub.status();
  assert.equal(again.claude.available,true,'one failed check does not drop a signed-in Claude');
  assert.ok((await hub.list()).some(m=>m.id==='claude'));
  // A definite logged-out answer still wins.
  const out=new ModelHub({file,config,env:env({CAT_CLAUDE:claudeOut})});
  assert.equal((await out.status()).claude.available,false);
});

test('once a check has answered, status answers at once while a slow fresh check runs behind it', async()=>{
  const count=join(dir,'slow-count');
  const slow=fakeCli('claude-slow',`import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const n=existsSync(${JSON.stringify(count)})?Number(readFileSync(${JSON.stringify(count)},'utf8')):0;writeFileSync(${JSON.stringify(count)},String(n+1));
const answer=()=>console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));
if(n===0)answer();else setTimeout(answer,6000);
`);
  const hub=new ModelHub({file:join(newDir(),'models.json'),config,env:env({CAT_CLAUDE:slow})});
  assert.equal((await hub.status()).claude.loggedIn,true);
  (hub as any).probeCache.at-=60_000;
  const t0=Date.now();
  assert.equal((await hub.status()).claude.loggedIn,true,'the last answer stands in');
  assert.equal((await hub.status()).claude.loggedIn,true,'still the last answer while the fresh check runs');
  assert.ok(Date.now()-t0<3000,`status did not wait on the slow check (${Date.now()-t0} ms)`);
});

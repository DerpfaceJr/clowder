// Plan 4.13 (H2): Hermes's first-enable bootstrap. uv is faked by a small Node script run as the real child process, so the spawn, the saved
// steps, stop mid-step, resume and the offline message run for real. The offline text is what uv 0.12.24 printed on this PC with no network
// (a dead proxy), so the classifier is checked against uv's words, not ours. The real uv run is measured by hand (report), not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HermesBootstrap,OFFLINE} from '../src/hermes-bootstrap.ts';
import {HermesSidecar} from '../src/hermes.ts';
import {quests} from '../src/quests.ts';
import {Store} from '../src/store.ts';
import {untilEvery} from './helpers/until.ts';

const tmp=(p:string)=>mkdtempSync(join(tmpdir(),p));
const until = untilEvery(20);

// uv 0.12.24, offline (HTTPS_PROXY to a closed port), `uv python install 3.14`: the tail of its stderr.
const UV_OFFLINE=`error: Failed to install cpython-3.14.8-windows-x86_64-none
  cause: Request failed after 3 retries in 27.0s
  cause: Failed to download \`https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.14.8%2B20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz\`
  cause: error sending request for url (https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.14.8%2B20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz)
  cause: client error (Connect)
  cause: tunnel error: failed to create underlying connection
  cause: tcp connect error
  cause: No connection could be made because the target machine actively refused it. (os error 10061)`;

// The fake uv: logs its argv, then does what mode.txt says for that command. ok: makes what uv would (the venv's python for sync).
// offline: uv's offline text, exit 2. hang: never finishes (the test stops it). fail: another error, exit 1.
const FAKE=join(tmp('fake-uv-'),'uv.mjs');
writeFileSync(FAKE,`import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [dir,...args]=process.argv.slice(2),cmd=args[0];
appendFileSync(join(dir,'calls.log'),JSON.stringify({args,cwd:process.cwd(),env:{cache:process.env.UV_CACHE_DIR,py:process.env.UV_PYTHON_INSTALL_DIR,venv:process.env.UV_PROJECT_ENVIRONMENT,stray:process.env.UV_INDEX_URL??null}})+'\\n');
const mode=(()=>{try{return JSON.parse(readFileSync(join(dir,'mode.json'),'utf8'))[cmd]??'ok';}catch{return 'ok';}})();
if(mode==='offline'){process.stderr.write(readFileSync(join(dir,'offline.txt'),'utf8'));process.exit(2);}
if(mode==='fail'){process.stderr.write('error: the lockfile needs to be updated, but --frozen was provided\\n');process.exit(1);}
if(mode==='hang'){process.stderr.write('Prepared 3 packages\\n');setInterval(()=>{},1000);}
else{
  if(cmd==='python'){mkdirSync(process.env.UV_PYTHON_INSTALL_DIR,{recursive:true});process.stderr.write('Installed Python 3.14.8\\n');}
  if(cmd==='sync'){const s=join(process.env.UV_PROJECT_ENVIRONMENT,process.platform==='win32'?'Scripts':'bin');mkdirSync(s,{recursive:true});writeFileSync(join(s,process.platform==='win32'?'python.exe':'python'),'');process.stderr.write('Installed 96 packages\\n');}
}
`);

function rig(){
  const ctl=tmp('uv-ctl-'),bundle=tmp('hermes-bundle-'),dataDir=tmp('hermes-data-');
  mkdirSync(join(bundle,'src'));writeFileSync(join(bundle,'src','uv.lock'),'lock');writeFileSync(join(bundle,'src','pyproject.toml'),'[project]');
  writeFileSync(join(bundle,'runtime.json'),'{"uv":"0.12.24","commit":"bf0203a"}');
  writeFileSync(join(ctl,'offline.txt'),UV_OFFLINE);
  const make=()=>new HermesBootstrap({dataDir,bundle,uv:[process.execPath,FAKE,ctl]});
  return {ctl,bundle,dataDir,make,
    mode:(m:Record<string,string>)=>writeFileSync(join(ctl,'mode.json'),JSON.stringify(m)),
    calls:():{args:string[];cwd:string;env:Record<string,string|null>}[]=>{try{return readFileSync(join(ctl,'calls.log'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch{return [];}},
    saved:()=>JSON.parse(readFileSync(join(dataDir,'hermes-runtime','bootstrap.json'),'utf8'))};
}

test('a first run copies the source, installs Python then syncs, all inside the data folder; a second run, or a restart, starts nothing',async()=>{
  const r=rig(),b=r.make();
  process.env.UV_INDEX_URL='https://owner-shell.example/simple';
  try{
    assert.equal(b.status().state,'idle');
    const python=await b.run();
    assert.equal(python,b.python);assert.ok(existsSync(python));
    assert.ok(existsSync(join(r.dataDir,'hermes-runtime','src','uv.lock')),'the source is copied into the data folder');
    const calls=r.calls();
    assert.deepEqual(calls.map(c=>c.args.slice(0,2)),[['python','install'],['sync','--frozen']]);
    assert.deepEqual(calls[0]!.args,['python','install','3.14','--no-bin','--no-registry']);
    assert.deepEqual(calls[1]!.args,['sync','--frozen','--no-dev','--extra','mcp','--extra','sms','--python','3.14']);
    assert.equal(calls[1]!.cwd,join(r.dataDir,'hermes-runtime','src'));
    for(const c of calls){
      for(const v of [c.env.cache,c.env.py,c.env.venv])assert.ok(v!.startsWith(join(r.dataDir,'hermes-runtime')),`${v} is in the data folder`);
      assert.equal(c.env.stray,null,"the owner's UV_* variables do not reach uv");
    }
    const s=b.status();
    assert.equal(s.state,'done');assert.deepEqual(s.done,['source','python','sync']);assert.equal(s.error,null);assert.equal(typeof s.ms,'number');
    assert.deepEqual(Object.keys(s.stepMs).sort(),['python','source','sync']);
    assert.equal(await b.run(),python);
    assert.equal(await r.make().run(),python,'a restarted Clowder reuses the runtime');
    assert.equal(r.calls().length,2,'no uv process after the first setup');
  }finally{delete process.env.UV_INDEX_URL;}
});

test('stopped mid-sync, the next start resumes at sync without reinstalling Python, and the stop is not a failure',async()=>{
  const r=rig(),b=r.make();
  r.mode({sync:'hang'});
  const first=b.run();
  await until(()=>b.status().step==='sync'&&r.calls().length===2);
  assert.equal(b.status().state,'running');assert.equal(b.status().label,"Installing Hermes's packages");
  assert.equal(quests({state:new Store(join(tmp('hermes-store-'),'events.jsonl'),[]).state,projects:[],capabilities:[],seasons:[],models:null,now:new Date(),hermesSetup:b.status()}).find(q=>q.id==='hermes:setup')?.rank,'E');
  b.stop();
  await assert.rejects(first,/stopped; it resumes on the next start/);
  assert.deepEqual(r.saved().done,['source','python']);
  assert.equal(b.status().state,'idle');assert.equal(b.status().error,null);
  r.mode({});
  const python=await r.make().run();
  assert.ok(existsSync(python));
  assert.deepEqual(r.calls().map(c=>c.args[0]),['python','sync','sync'],'Python is not installed again');
});

test('offline, the error says so, Hermes is refused and the quest asks for a retry; online again, a retry finishes',async()=>{
  assert.match(UV_OFFLINE,OFFLINE);
  const r=rig(),b=r.make();
  r.mode({python:'offline'});
  await assert.rejects(b.run(),/^Error: No internet connection: Clowder could not download Python 3\.14\. Hermes stays off/);
  const s=b.status();
  assert.equal(s.state,'failed');assert.equal(s.offline,true);assert.equal(s.failures,1);assert.deepEqual(s.done,['source']);
  assert.ok(s.lines.some(l=>l.includes('tcp connect error')),'uv\'s own words are kept for the status route');
  const q=quests({state:new Store(join(tmp('hermes-store-'),'events.jsonl'),[]).state,projects:[],capabilities:[],seasons:[],models:null,now:new Date(),hermesSetup:s}).find(x=>x.id==='hermes:setup');
  assert.equal(q?.rank,'B');assert.equal(q?.action.label,'Retry');assert.match(q!.detail,/No internet connection/);
  // The sidecar refuses with the same message and starts no Hermes; its start() does not throw, so the rest of Clowder goes on.
  const events:[string,any][]=[],side=new HermesSidecar({dataDir:r.dataDir,root:process.cwd(),port:1,clowderPort:2,journal:()=>({emit:(type:string,data:any)=>events.push([type,data])}) as unknown as Store,bootstrap:r.make()});
  await side.start();
  assert.deepEqual(events.map(e=>e[0]),['hermes.refused']);assert.match(events[0]![1].reason,/No internet connection/);
  assert.equal(side.ready(),false);assert.equal(existsSync(join(r.dataDir,'hermes')),false,'no HERMES_HOME is written');
  r.mode({});
  await b.run();
  assert.equal(b.status().state,'done');assert.equal(b.status().failures,0);assert.equal(b.status().error,null);
  assert.deepEqual(r.calls().map(c=>c.args[0]),['python','python','python','sync']);
});

test('another uv failure is not called offline; a new bundle (an app update) starts over; no bundle is unavailable',async()=>{
  const r=rig(),b=r.make();
  r.mode({sync:'fail'});
  await assert.rejects(b.run(),/Installing Hermes's packages failed: uv exited 1: error: the lockfile needs to be updated/);
  assert.equal(b.status().offline,false);
  r.mode({});await b.run();
  writeFileSync(join(r.bundle,'runtime.json'),'{"uv":"0.12.24","commit":"next"}');
  assert.equal(b.status().state,'idle');
  await b.run();
  assert.deepEqual(r.calls().map(c=>c.args[0]),['python','sync','sync','python','sync']);
  const none=new HermesBootstrap({dataDir:tmp('hermes-data-'),bundle:join(r.bundle,'missing')});
  assert.equal(none.status().state,'unavailable');
  await assert.rejects(none.run(),/no bundled Hermes runtime/);
});

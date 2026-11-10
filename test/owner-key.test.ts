// Row 11.27 of docs/product-plan.md: under npm start the owner key is kept in the data folder, so the owner's browser stays signed in across
// restarts, and Devices rotates it. The key never leaves the server: no API answer, log line or journal file carries it, and no cat tool reaches it.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import type {FastifyInstance} from 'fastify';
import {OWNER_KEY_FILE,ownerKeyFile} from '../src/access.ts';
import {denyRules} from '../src/claude-tools.ts';
import {readArtifactTool} from '../src/artifacts.ts';
import {readPage} from '../src/web-fetch.ts';
const {allowed}=createRequire(import.meta.url)('../src/browse-guard.cjs') as {allowed:(url:string,o?:{lan:string[];site:string})=>boolean};

const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=()=>mkdtempSync(join(tmpdir(),'owner-key-'));
const keyOf=(dir:string)=>readFileSync(join(dir,OWNER_KEY_FILE),'utf8');
// Every file under the data folder but the key itself: journals, settings, snapshots.
const dataFiles=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=join(dir,e.name);return e.isDirectory()?dataFiles(p):e.isFile()&&e.name!==OWNER_KEY_FILE?[p]:[];});

test('the key file: kept across opens, tight permissions, rotated on demand, and a missing, malformed or unreadable file gives a new key',()=>{
  const dir=scratch(),lines:string[]=[],log=(l:string)=>lines.push(l);
  const first=ownerKeyFile(dir,log),key=keyOf(dir);
  assert.match(key,/^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.session(),key,'the cookie carries a keyed hash, never the key');
  assert.notEqual(first.link(),key,'the console link carries a per-launch code, never the key');
  const again=ownerKeyFile(dir,log);
  assert.equal(again.session(),first.session(),'a restart reads the same key, so the same cookie still works');
  assert.notEqual(again.link(),first.link(),'the console link is new each launch');
  // Permissions: this user only.
  if(process.platform==='win32'){
    const out=spawnSync('icacls',[join(dir,OWNER_KEY_FILE)],{encoding:'utf8',windowsHide:true}).stdout;
    const aces=out.split(/\r?\n/).map(l=>l.replace(join(dir,OWNER_KEY_FILE),'').trim()).filter(l=>/:\(/.test(l));
    assert.equal(aces.length,1,out);
    assert.ok(aces[0]!.toLowerCase().includes(`\\${userInfo().username.toLowerCase()}:(f)`),out);
    assert.ok(!out.includes('(I)'),`no inherited entry: ${out}`);
  }else assert.equal(statSync(join(dir,OWNER_KEY_FILE)).mode&0o777,0o600);
  // Rotate: a new key on disk, a new cookie and link; the old cookie no longer matches.
  const old=again.session(),oldLink=again.link();
  again.rotate();
  assert.notEqual(keyOf(dir),key);assert.notEqual(again.session(),old);assert.notEqual(again.link(),oldLink);
  assert.equal(ownerKeyFile(dir,log).session(),again.session(),'the rotated key is the one a restart reads');
  // Missing: a new key, and it is kept.
  rmSync(join(dir,OWNER_KEY_FILE));
  const made=ownerKeyFile(dir,log);
  assert.notEqual(made.session(),again.session());assert.equal(ownerKeyFile(dir,log).session(),made.session());
  // Malformed: a new key replaces it.
  writeFileSync(join(dir,OWNER_KEY_FILE),'not a key\n');
  const fixed=ownerKeyFile(dir,log);
  assert.notEqual(fixed.session(),made.session());assert.match(keyOf(dir),/^[A-Za-z0-9_-]{43}$/);
  assert.equal(lines.length,0,'nothing to say while the file can be kept');
  // Unreadable (a folder in its place): a new key for this launch only, never an open door, and the log line carries no key.
  const blocked=scratch();mkdirSync(join(blocked,OWNER_KEY_FILE));
  const a=ownerKeyFile(blocked,log),b=ownerKeyFile(blocked,log);
  assert.match(a.session(),/^[A-Za-z0-9_-]{43}$/);assert.notEqual(a.session(),b.session(),'each launch makes its own');
  assert.ok(lines.length>0&&lines.every(l=>!l.includes(a.session())&&!l.includes(a.link())),lines.join('\n'));
});

test('no cat tool reaches the key file: Read deny rules, read_artifact, fetch_url and the cats\' browser guard',async()=>{
  const dir=scratch();ownerKeyFile(dir,()=>{});
  const file=join(dir,OWNER_KEY_FILE);
  // Code runs (Claude, Gemini): the data folder's deny rule covers the key file. The CLI honouring it is not run here.
  const rule=denyRules(dir)[0]!,asRule='/'+file.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d:string)=>`/${d.toLowerCase()}`);
  assert.ok(rule.endsWith('/**')&&asRule.startsWith(rule.slice(0,-2)),`${rule} covers ${asRule}`);
  // read_artifact: a forged record that points out of the artifacts folder is refused.
  const id='6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',artifacts=join(dir,'artifacts');mkdirSync(artifacts);
  const events=[{type:'artifact.created',at:new Date().toISOString(),data:{id,kind:'text',title:'x',file:`${id}./../../${OWNER_KEY_FILE}`}}] as any;
  assert.throws(()=>readArtifactTool({events,dir:artifacts,args:{id}}),/Unknown artifact id/);
  // fetch_url: only http and https.
  await assert.rejects(readPage(pathToFileURL(file).href),/http/i);
  // The cats' browser: a file URL never opens (Playwright MCP blocks file:// too, as it runs without --allow-unrestricted-file-access).
  assert.equal(allowed(pathToFileURL(file).href,{lan:[],site:''}),false);
  assert.equal(allowed('about:blank',{lan:[],site:''}),true,'the guard\'s own landing page still opens');
});

// The real server on scratch ports, without CAT_OWNER_KEY: what npm start does.
function boot(dir:string,port:number,appKey=''){
  const child=spawn(process.execPath,['--import','tsx',join(root,'src','server.ts')],{cwd:root,env:{...process.env,CAT_OWNER_KEY:appKey,PORT:String(port),CAT_REMOTE_PORT:String(port+1),CAT_TOWN_DATA:dir,CAT_TUNNEL_AUTOSTART:'0',CAT_TOWN_LAN:'0'},stdio:['ignore','pipe','pipe']});
  let out='';child.stdout!.on('data',c=>{out+=c;});child.stderr!.on('data',c=>{out+=c;});
  const link=new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`server did not start: ${out}`)),60_000);
    const check=()=>{const m=/Clowder: (http\S+)\s/.exec(out);if(m){clearTimeout(timer);resolve(m[1]!);}};
    child.stdout!.on('data',check);child.once('exit',code=>{clearTimeout(timer);reject(new Error(`server exited ${code}: ${out}`));});
  });
  return {child,link,out:()=>out};
}
const stop=(child:ChildProcess)=>new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());process.kill(child.pid!);});
const running:ChildProcess[]=[];
after(async()=>{for(const c of running)await stop(c);});

test('a restart keeps the browser signed in; Rotate signs the old cookie out; a missing key file makes a new key; the key is in no answer, log line or journal',{timeout:240_000},async()=>{
  const dir=scratch();
  writeFileSync(join(dir,'connectors.json'),JSON.stringify({connectors:[],plugins:[]}));
  writeFileSync(join(dir,'workshop-settings.json'),JSON.stringify({autoSetup:false}));
  let port=30000+Math.floor(Math.random()*20000);if(port===8789||port+1===8789)port+=2;
  const base=`http://127.0.0.1:${port}`,keys:string[]=[],sessions:string[]=[],logs:string[]=[];
  const signIn=async(link:string)=>{
    const r=await fetch(link,{redirect:'manual'});assert.equal(r.status,303);
    const cookie=r.headers.get('set-cookie')!.split(';')[0]!;sessions.push(cookie.split('=')[1]!);return cookie;
  };
  const state=(cookie?:string)=>fetch(base+'/api/state',{headers:cookie?{cookie}:{}}).then(r=>r.status);
  const owner=(cookie:string)=>({cookie,'x-town-action':'owner','content-type':'application/json'});
  // Bodies of the routes an owner page reads, checked for the key below.
  const bodies:string[]=[];
  const read=async(cookie:string)=>{for(const path of ['/api/state','/api/remote/status','/api/quests','/api/search?q=owner','/api/artifacts','/api/goals']){
    const r=await fetch(base+path,{headers:{cookie}});bodies.push(`${path} ${r.status} ${JSON.stringify([...r.headers])} ${await r.text()}`);
  }};

  // First launch: the console link signs this browser in; a local request without the cookie (the cats' browser, a CLI) gets nothing.
  let run=boot(dir,port);running.push(run.child);
  const link1=await run.link;keys.push(keyOf(dir));
  assert.equal(await state(),401,'no cookie, no town data: what the cats\' browser profile sends');
  const cookie=await signIn(link1);
  assert.equal(await state(cookie),200);
  const status=await (await fetch(base+'/api/remote/status',{headers:{cookie}})).json() as {ownerKeyRotates?:boolean};
  assert.equal(status.ownerKeyRotates,true,'Devices shows Rotate under npm start');
  await read(cookie);
  await stop(run.child);logs.push(run.out());

  // Restart on the same data folder: the same cookie still works; the old console link does not.
  run=boot(dir,port);running.push(run.child);
  const link2=await run.link;
  assert.equal(keyOf(dir),keys[0],'the same key after a restart');
  assert.equal(await state(cookie),200,'the browser stays signed in across a restart');
  assert.notEqual((await fetch(link1,{redirect:'manual'})).status,303,'last launch\'s console link is spent');
  assert.notEqual(link2,link1);

  // Rotate from Devices: the host browser gets the new cookie with the answer; every browser on the old cookie is signed out.
  assert.equal((await fetch(base+'/api/owner-key/rotate',{method:'POST',headers:{'x-town-action':'owner','content-type':'application/json'},body:'{}'})).status,403,'a local caller without the session cannot rotate');
  const rotated=await fetch(base+'/api/owner-key/rotate',{method:'POST',headers:owner(cookie),body:'{}'});
  const rotatedBody=await rotated.text();
  assert.equal(rotated.status,200,rotatedBody);assert.deepEqual(JSON.parse(rotatedBody),{ok:true});
  const fresh=rotated.headers.get('set-cookie')!.split(';')[0]!;sessions.push(fresh.split('=')[1]!);keys.push(keyOf(dir));
  bodies.push(`rotate ${JSON.stringify([...rotated.headers])} ${rotatedBody}`);
  assert.notEqual(keys[1],keys[0]);
  assert.equal(await state(cookie),401,'the old cookie is signed out');
  assert.equal(await state(fresh),200,'the browser that rotated stays signed in');
  assert.notEqual((await fetch(link2,{redirect:'manual'})).status,303,'the console link from before the rotation is spent too');
  const link3=/Clowder: (http\S+)\s*$/.exec(run.out().trim())![1]!;
  assert.notEqual(link3,link2,'the console shows a new link after a rotation');
  await read(fresh);
  await stop(run.child);logs.push(run.out());

  // A missing key file: the next launch makes a new key, and the last cookie is signed out.
  rmSync(join(dir,OWNER_KEY_FILE));
  run=boot(dir,port);running.push(run.child);
  const link4=await run.link;keys.push(keyOf(dir));
  assert.notEqual(keys[2],keys[1]);
  assert.equal(await state(fresh),401,'a new key signs the last cookie out');
  const last=await signIn(link4);
  assert.equal(await state(last),200);
  await read(last);
  await stop(run.child);logs.push(run.out());

  // The key: in no answer (bodies and headers), no log line, no file under the data folder. The cookie value is only in its own Set-Cookie and
  // never in a body or a log line.
  const files=dataFiles(dir),journal=files.filter(f=>f.endsWith('.jsonl'));
  assert.ok(journal.length>0,'the journal was written');
  for(const key of keys){
    for(const b of bodies)assert.ok(!b.includes(key),`an answer carries the key: ${b.slice(0,200)}`);
    for(const l of logs)assert.ok(!l.includes(key),'a log line carries the key');
    for(const f of files)assert.ok(!readFileSync(f,'latin1').includes(key),`${f} carries the key`);
  }
  for(const s of sessions){
    for(const b of bodies)assert.ok(!b.replace(/set-cookie[^\]]*\]/gi,'').includes(s),`an answer body carries the session: ${b.slice(0,200)}`);
    for(const l of logs)assert.ok(!l.includes(s),'a log line carries the session');
    for(const f of journal)assert.ok(!readFileSync(f,'latin1').includes(s),`${f} carries the session`);
  }
});

test('the desktop app\'s flow is unchanged: CAT_OWNER_KEY wins, no key file, no link, and Rotate refuses',{timeout:120_000},async()=>{
  const dir=scratch();
  writeFileSync(join(dir,'connectors.json'),JSON.stringify({connectors:[],plugins:[]}));
  writeFileSync(join(dir,'workshop-settings.json'),JSON.stringify({autoSetup:false}));
  let port=30000+Math.floor(Math.random()*20000);if(port===8789||port+1===8789)port+=2;
  const run=boot(dir,port,'desk-key-from-the-app');running.push(run.child);
  const link=await run.link;
  assert.equal(link,`http://127.0.0.1:${port}`,'no ?owner= link: the app sets its cookie in its own window');
  const cookie=`town_owner_${port}=desk-key-from-the-app`;
  assert.equal((await fetch(`${link}/api/state`,{headers:{cookie}})).status,200);
  assert.equal((await (await fetch(`${link}/api/remote/status`,{headers:{cookie}})).json() as {ownerKeyRotates:boolean}).ownerKeyRotates,false);
  assert.equal((await fetch(`${link}/api/owner-key/rotate`,{method:'POST',headers:{cookie,'x-town-action':'owner','content-type':'application/json'},body:'{}'})).status,409);
  assert.ok(!readdirSync(dir).includes(OWNER_KEY_FILE),'no key file beside the app\'s data');
  await stop(run.child);
});

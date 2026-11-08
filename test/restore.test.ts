// Plan 7.6: restore in the desktop app. Gate (the automated drill): back up folder A with fake broker 1, restore into empty folder B with
// fake broker 2; the golden hash is equal, every IN secret reads back through B's own store, and no OUT file exists. Also: the current files
// move to backups/before-restore-<time>/ first and restoring that folder undoes it; a failure injected at every step of the swap leaves the
// old town whole; a power cut mid-swap is put back at the next boot; a pre-* snapshot keeps this computer's own keys; damaged points are
// reported; the routes' owner and host gates; and the desktop worker, run as its own process against a fake safeStorage. Every value is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {copyFileSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import Fastify from 'fastify';
import {Backups,newRecoveryKey,runBackup,secretsOf} from '../src/backup.ts';
import {SecretStore,openSecretStore,type Broker} from '../src/secret-store.ts';
import {Store} from '../src/store.ts';
import {applyRestore,listSnapshots,machineSecrets,recoverRestore,registerRestoreRoutes,stageRestore,type Rename} from '../src/restore.ts';
import {stateHash} from './fixtures/golden/state-hash.ts';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const GOLDEN=new URL('./fixtures/golden/',import.meta.url);
const tmp=(name:string)=>mkdtempSync(join(tmpdir(),`restore-${name}-`));
const walk=(dir:string):string[]=>existsSync(dir)?readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]):[];
// The data folder's contents, less backups/: every path with the SHA-256 of its bytes.
const treeHash=(dir:string)=>walk(dir).map(f=>relative(dir,f).replace(/\\/g,'/')).filter(f=>!f.startsWith('backups/')).sort()
  .map(f=>`${f} ${createHash('sha256').update(readFileSync(join(dir,f))).digest('hex')}`).join('\n');
const put=(dir:string,rel:string,text:string)=>{mkdirSync(join(dir,rel,'..'),{recursive:true});writeFileSync(join(dir,rel),text);};

// A fake safeStorage per "PC": an AES key that lives only in this process. Broker 2 cannot open broker 1's blobs.
function broker():Broker{
  const k=randomBytes(32);
  return {available:async()=>true,
    encrypt:async t=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',k,iv);const b=Buffer.concat([c.update(t,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');},
    decrypt:async s=>{const x=Buffer.from(s,'base64'),d=createDecipheriv('aes-256-gcm',k,x.subarray(0,12));d.setAuthTag(x.subarray(12,28));return Buffer.concat([d.update(x.subarray(28)),d.final()]).toString('utf8');}};
}

const SECRET={hosted:'sk-fake-hosted-restore-000001',telegram:'123:fake-telegram-restore-000002',connector:'ghp_fake_restore_connector_000003',
  rendezvousA:'fake-rendezvous-pc1-000004',deviceA:'fake-device-token-pc1-000005',rendezvousB:'fake-rendezvous-pc2-000006',vapidB:'fake-vapid-pc2-000007'};
// IN secrets travel with the backup; the rest are PC 1's own and must not reach PC 2.
const IN_REFS={'models.json#hosted.key':SECRET.hosted,'telegram.json#token':SECRET.telegram,'connector-secrets.json#github':SECRET.connector};
const OUT=['read-model.db','worlds/w2/read-model.db','events.jsonl.pre-compact-2026-01-01T00-00-00Z','devices.json','push-subscriptions.json','remote-settings.json',
  'cat-browser.json','tunnel/cert.pem','browser/Default/Cookies','wiki/page.md','season-s1.lock','season-s1.log','server.log','last-boot.json'];

// Folder A on PC 1: the golden journal, settings, a second world, saved keys through broker 1, and OUT files that must stay behind.
async function townA(){
  const a=tmp('A');
  copyFileSync(new URL('events.jsonl',GOLDEN),join(a,'events.jsonl'));
  put(a,'worlds.json','{"worlds":[]}');
  put(a,'models.json',JSON.stringify({hosted:{base:'https://api.example.com/v1',model:'m1',key:SECRET.hosted}}));
  put(a,'telegram.json',JSON.stringify({token:SECRET.telegram,bot:'@fakebot',deviceToken:SECRET.deviceA}));
  put(a,'connector-secrets.json',JSON.stringify({github:SECRET.connector}));
  put(a,'rendezvous.json',JSON.stringify({relay:'https://ntfy.example',key:SECRET.rendezvousA}));
  put(a,'checkpoints/t1.json','{}');put(a,'artifacts/a.txt','art');put(a,'plugins/p/plugin.json','{}');
  put(a,'worlds/w2/events.jsonl','{"id":3}\n');put(a,'worlds/w2/accounts.json','{}');
  for(const f of OUT)put(a,f,`OUT-MARKER ${f}`);
  const store=await openSecretStore(a,broker());
  await store.flush();
  return a;
}
const golden=()=>readFileSync(new URL('state.sha256',GOLDEN),'utf8').trim();
const outsideTown=(dir:string)=>OUT.filter(f=>existsSync(join(dir,f)));

test('gate: back up A with broker 1, restore into empty B with broker 2: golden hash equal, every IN secret reads back, no OUT file',async()=>{
  const a=await townA(),folder=tmp('folder'),key=newRecoveryKey();
  await runBackup({dataDir:a,folder,recoveryKey:key,secrets:secretsOf(a)});
  // PC 2: an empty data folder with its own safeStorage and one key of its own.
  const b=tmp('B'),b2=broker(),liveB=await openSecretStore(b,b2);
  put(b,'rendezvous.json',JSON.stringify({relay:'https://ntfy.example'}));
  liveB.update([['rendezvous.json#key',SECRET.rendezvousB]]);await liveB.flush();
  const untouched=treeHash(b);
  const staged=await stageRestore({dataDir:b,source:{kind:'backup',folder,recoveryKey:key},broker:b2,keep:machineSecrets(liveB)});
  assert.equal(treeHash(b),untouched,'staging changes nothing in the data folder');
  const applied=await applyRestore(b,staged.staging);
  assert.deepEqual(staged.damaged,[]);
  // The golden hash.
  assert.equal(stateHash(new Store(join(b,'events.jsonl'),[]).state),golden());
  // Every IN secret reads back through PC 2's own store, PC 2's key stays, and PC 1's machine keys did not come.
  const back=new SecretStore(b,b2);await back.load();
  assert.equal(back.mode,'encrypted');
  for(const [ref,value] of Object.entries(IN_REFS))assert.equal(back.get(ref),value,ref);
  assert.equal(back.get('rendezvous.json#key'),SECRET.rendezvousB);
  assert.equal(back.get('telegram.json#deviceToken'),undefined);
  // On disk: safeStorage blobs only, never a value in plain text, anywhere in B.
  const raw=readFileSync(join(b,'secrets.v2.json'),'utf8');
  assert.equal(JSON.parse(raw).cipher,'safeStorage');
  for(const f of walk(b)){const text=readFileSync(f,'utf8');for(const v of Object.values(SECRET))assert.ok(!text.includes(v),`${relative(b,f)} holds a secret in plain text`);}
  // No OUT file, and the worlds and artifacts are back.
  assert.deepEqual(outsideTown(b),[]);
  for(const f of ['worlds/w2/events.jsonl','worlds/w2/accounts.json','artifacts/a.txt','checkpoints/t1.json','plugins/p/plugin.json','models.json'])assert.ok(existsSync(join(b,f)),f);
  // backup.json, devices and the rest of PC 2 stay; the staging folder is gone.
  assert.ok(existsSync(join(b,'rendezvous.json')));
  assert.ok(!readdirSync(join(b,'backups')).some(f=>f.startsWith('restore-staging-')));
  assert.match(applied.before,/before-restore-\d{4}-\d\d-\d\dT[\d-]+Z$/);
});

test('before restore: the current town moves to backups/before-restore-<time>/, and restoring that folder undoes the restore',async()=>{
  const a=await townA(),folder=tmp('folder'),key=newRecoveryKey();
  await runBackup({dataDir:a,folder,recoveryKey:key,secrets:secretsOf(a)});
  const b=tmp('B'),b2=broker(),live=await openSecretStore(b,b2);
  put(b,'events.jsonl','{"id":"old-town"}\n');put(b,'models.json','{"hosted":{"model":"old"}}');put(b,'devices.json','{"keep":true}');put(b,'read-model.db','stale');
  live.update([['models.json#hosted.key','sk-fake-old-town-000009']]);await live.flush();
  const original=treeHash(b);
  const staged=await stageRestore({dataDir:b,source:{kind:'backup',folder,recoveryKey:key},broker:b2,keep:machineSecrets(live)});
  const {before}=await applyRestore(b,staged.staging,{now:()=>new Date('2026-11-07T10:00:00.000Z')});
  assert.ok(before.endsWith('before-restore-2026-11-07T10-00-00-000Z'));
  assert.equal(readFileSync(join(before,'events.jsonl'),'utf8'),'{"id":"old-town"}\n');
  assert.ok(existsSync(join(before,'secrets.v2.json'))&&existsSync(join(before,'read-model.db')));
  assert.equal(readFileSync(join(b,'devices.json'),'utf8'),'{"keep":true}','devices stay where they are');
  // The snapshot list offers it, and restoring it brings the old town back, its saved key included.
  const snaps=listSnapshots(b);
  assert.deepEqual(snaps.map(s=>[s.id,s.kind,s.at]),[['before-restore-2026-11-07T10-00-00-000Z','before-restore','2026-11-07T10:00:00.000Z']]);
  const liveNow=new SecretStore(b,b2);await liveNow.load();
  const undo=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snaps[0]!.id},broker:b2,keep:machineSecrets(liveNow)});
  await applyRestore(b,undo.staging,{now:()=>new Date('2026-11-07T11:00:00.000Z')});
  assert.equal(readFileSync(join(b,'events.jsonl'),'utf8'),'{"id":"old-town"}\n');
  const s=new SecretStore(b,b2);await s.load();
  assert.equal(s.get('models.json#hosted.key'),'sk-fake-old-town-000009');
  assert.equal(s.get('telegram.json#token'),undefined);
  // The same files, less what is rebuilt (read-model.db) and the secrets file, which is re-encrypted with fresh nonces.
  const strip=(t:string)=>t.split('\n').filter(l=>!/^(read-model\.db|secrets\.v2\.json) /.test(l)).join('\n');
  assert.equal(strip(treeHash(b)),strip(original));
});

// A data folder with a pre-* snapshot to restore, on fake broker 2.
async function withSnapshot(){
  const b=tmp('swap'),b2=broker(),live=await openSecretStore(b,b2);
  put(b,'events.jsonl','{"id":"current"}\n');put(b,'workshop.jsonl','{"w":1}\n');put(b,'models.json','{"hosted":{"model":"now"}}');
  put(b,'worlds.json','{"worlds":["w2"]}');put(b,'worlds/w2/events.jsonl','{"id":"w2-now"}\n');put(b,'artifacts/now.txt','now');put(b,'read-model.db','rm');
  put(b,'devices.json','{"d":1}');put(b,'backup.json','{"folder":"X","confirmed":true}');
  live.update([['models.json#hosted.key','sk-fake-current-000010'],['backup.json#recoveryKey','FAKE-RECOVERY-NOT-A-KEY']]);await live.flush();
  const snap=join(b,'backups','pre-abc1234-2026-11-01T09-00-00-000Z');
  put(snap,'events.jsonl','{"id":"then"}\n');put(snap,'models.json','{"hosted":{"model":"then"}}');put(snap,'checkpoints/t.json','{}');
  put(snap,'worlds/w3/events.jsonl','{"id":"w3-then"}\n');
  // Its own secrets file, from before backups were set up: no recovery key in it.
  const old=new SecretStore(snap,b2);await old.load();old.update([['models.json#hosted.key','sk-fake-then-000011']]);await old.flush();
  return {b,b2,live,snap:'pre-abc1234-2026-11-01T09-00-00-000Z'};
}

test('a pre-* snapshot restore keeps this computer\'s own keys: the recovery key stays, the model key comes from the snapshot',async()=>{
  const {b,b2,live,snap}=await withSnapshot();
  assert.deepEqual(listSnapshots(b).map(s=>[s.kind,s.commit,s.at]),[['pre','abc1234','2026-11-01T09:00:00.000Z']]);
  const staged=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:machineSecrets(live)});
  await applyRestore(b,staged.staging);
  const s=new SecretStore(b,b2);await s.load();
  assert.equal(s.get('backup.json#recoveryKey'),'FAKE-RECOVERY-NOT-A-KEY');
  assert.equal(s.get('models.json#hosted.key'),'sk-fake-then-000011');
  assert.equal(readFileSync(join(b,'events.jsonl'),'utf8'),'{"id":"then"}\n');
  assert.ok(!existsSync(join(b,'worlds/w2')),'a world the snapshot did not have moved out');
  assert.ok(existsSync(join(b,'worlds/w3/events.jsonl')));
  assert.ok(!existsSync(join(b,'workshop.jsonl'))&&!existsSync(join(b,'read-model.db'))&&!existsSync(join(b,'artifacts')));
  assert.ok(existsSync(join(b,'backups',snap,'events.jsonl')),'the snapshot itself stays');
  assert.equal(readFileSync(join(b,'devices.json'),'utf8'),'{"d":1}');
  // Refused: a name that is not a snapshot, and a half-written staging folder.
  await assert.rejects(stageRestore({dataDir:b,source:{kind:'snapshot',id:'../../etc'},broker:b2,keep:{}}),/not on this computer/);
  mkdirSync(join(b,'backups','restore-staging-0000abcd'));
  await assert.rejects(applyRestore(b,join(b,'backups','restore-staging-0000abcd')),/not prepared completely/);
});

test('a failure injected at every step of the swap leaves the old town whole, and the next restore still works',async()=>{
  const {b,b2,live,snap}=await withSnapshot();
  const original=treeHash(b);
  let k=0,total=0;
  {const probe=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:machineSecrets(live)});
    total=readdirSync(b).filter(f=>f!=='backups'&&!['devices.json','backup.json'].includes(f)).length+readdirSync(probe.staging).length-1;
    rmSync(probe.staging,{recursive:true,force:true});}
  assert.ok(total>=8,`the swap has ${total} renames`);
  for(k=1;k<=total;k++){
    const staged=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:machineSecrets(live)});
    let n=0;
    const failing:Rename=(from,to)=>{if(++n===k)throw Object.assign(new Error(`EIO: injected failure at rename ${k}`),{code:'EIO'});renameSync(from,to);};
    await assert.rejects(applyRestore(b,staged.staging,{rename:failing}),/injected failure/);
    assert.equal(treeHash(b),original,`after a failure at rename ${k} of ${total}`);
    assert.ok(!existsSync(join(b,'backups','restore-intent.json')));
    assert.ok(!existsSync(staged.staging));
    assert.ok(!readdirSync(join(b,'backups')).some(f=>f.startsWith('before-restore-')),'no empty before-restore folder is left');
  }
  const staged=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:machineSecrets(live)});
  await applyRestore(b,staged.staging);
  assert.equal(readFileSync(join(b,'events.jsonl'),'utf8'),'{"id":"then"}\n');
});

test('a power cut mid-swap (every later rename fails, putting back too) is put back at the next boot; a finished swap is kept',async()=>{
  const {b,b2,live,snap}=await withSnapshot();
  const original=treeHash(b);
  for(const k of [2,5,9]){
    const staged=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:machineSecrets(live)});
    let n=0;
    const dying:Rename=(from,to)=>{if(++n>=k)throw Object.assign(new Error('EIO: the disk went away'),{code:'EIO'});renameSync(from,to);};
    await assert.rejects(applyRestore(b,staged.staging,{rename:dying}),/disk went away/);
    assert.ok(existsSync(join(b,'backups','restore-intent.json')),'the intent stays for the next boot');
    assert.notEqual(treeHash(b),original,'the folder is mixed until recovery runs');
    // A new restore is refused until then.
    await assert.rejects(stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:{}}),/interrupted/);
    assert.equal(await recoverRestore(b),'rolled-back');
    assert.equal(treeHash(b),original,`after a power cut at rename ${k}`);
    assert.ok(!existsSync(staged.staging));
  }
  assert.equal(await recoverRestore(b),null,'nothing to do');
  // A swap that moved everything but died before removing its intent is finished, not undone.
  const staged=await stageRestore({dataDir:b,source:{kind:'snapshot',id:snap},broker:b2,keep:machineSecrets(live)});
  const names=readdirSync(staged.staging).filter(f=>f!=='.restore-ready.json');
  const {before}=await applyRestore(b,staged.staging);
  const restored=treeHash(b);
  writeFileSync(join(b,'backups','restore-intent.json'),JSON.stringify({before,staging:staged.staging,out:readdirSync(before),in:names}));
  assert.equal(await recoverRestore(b),'finished');
  assert.equal(treeHash(b),restored);
});

test('a damaged newest point: restore takes the one before and lists the damaged one, also when a point is picked',async()=>{
  const a=await townA(),folder=tmp('folder'),key=newRecoveryKey();
  await runBackup({dataDir:a,folder,recoveryKey:key,secrets:secretsOf(a)});
  writeFileSync(join(a,'events.jsonl'),readFileSync(join(a,'events.jsonl'),'utf8')+'{"id":"late","type":"x"}\n');
  await runBackup({dataDir:a,folder,recoveryKey:key,secrets:secretsOf(a)});
  writeFileSync(join(folder,'manifest-000002.enc'),'garbage');
  const b=tmp('B'),b2=broker(),live=await openSecretStore(b,b2);
  const newest=await stageRestore({dataDir:b,source:{kind:'backup',folder,recoveryKey:key},broker:b2,keep:machineSecrets(live)});
  assert.deepEqual([newest.n,newest.damaged],[1,[2]]);
  rmSync(newest.staging,{recursive:true,force:true});
  const picked=await stageRestore({dataDir:b,source:{kind:'backup',folder,recoveryKey:key,n:1},broker:b2,keep:machineSecrets(live)});
  assert.deepEqual([picked.n,picked.damaged],[1,[2]]);
  await applyRestore(b,picked.staging);
  assert.equal(stateHash(new Store(join(b,'events.jsonl'),[]).state),golden());
});

test('routes: owner sees what can be restored, never a key; the host alone lists points and restores; npm start and a busy town refuse',async()=>{
  const a=await townA(),b2=broker(),b=tmp('B'),live=await openSecretStore(b,b2);
  const backups=new Backups(b),folder=tmp('folder');
  const {recoveryKey}=backups.setup(folder);backups.confirm(recoveryKey!.split('-').at(-1)!);await live.flush();
  await runBackup({dataDir:a,folder,recoveryKey:recoveryKey!,secrets:secretsOf(a)});
  const gates={owner:true,host:true},state={broker:true as boolean,busy:null as string|null},handed:string[]=[];
  const app=Fastify();
  app.setErrorHandler((error:any,_req,res)=>{res.code(error.statusCode||400).send({error:error.message});}); // as server.ts
  registerRestoreRoutes(app,{dataDir:b,backups,broker:()=>state.broker?b2:undefined,live:()=>live,busy:()=>state.busy,handOff:s=>handed.push(s)},{owner:()=>gates.owner,host:()=>gates.host});
  const call=(method:'GET'|'POST',url:string,payload?:object)=>app.inject({method,url,...(payload?{payload}:{})});
  // Not the host: points and restore refused, the list allowed. Not an owner: everything refused.
  gates.host=false;
  assert.equal((await call('POST','/api/restore/points',{folder})).statusCode,403);
  assert.equal((await call('POST','/api/restore',{source:'backup',folder})).statusCode,403);
  assert.equal((await call('GET','/api/restore')).statusCode,200);
  gates.owner=false;
  assert.equal((await call('GET','/api/restore')).statusCode,403);
  gates.owner=gates.host=true;
  const info=await call('GET','/api/restore');
  assert.deepEqual(info.json().backup,{folder,keySaved:true});
  assert.equal(info.json().desktop,true);
  assert.ok(!info.body.includes(recoveryKey!.split('-').at(-1)!),'the key never leaves');
  // This computer's own folder needs no key; another folder does; a wrong key is refused without being echoed.
  const points=await call('POST','/api/restore/points',{folder});
  assert.deepEqual(points.json().points.map((p:any)=>[p.n,p.ok]),[[1,true]]);
  const other=tmp('other'),otherKey=newRecoveryKey();
  await runBackup({dataDir:a,folder:other,recoveryKey:otherKey,secrets:{}});
  assert.match((await call('POST','/api/restore/points',{folder:other})).json().error,/Type the recovery key/);
  const wrong=newRecoveryKey(),bad=await call('POST','/api/restore/points',{folder:other,recoveryKey:wrong});
  assert.equal(bad.statusCode,400);assert.ok(!bad.body.includes(wrong));
  assert.equal((await call('POST','/api/restore/points',{folder:other,recoveryKey:otherKey.toLowerCase()})).statusCode,200);
  // Refusals before anything is staged.
  state.broker=false;
  assert.match((await call('POST','/api/restore',{source:'backup',folder,n:1})).json().error,/desktop app/);
  state.broker=true;state.busy='A season is running. Stop it before restoring.';
  assert.equal((await call('POST','/api/restore',{source:'backup',folder,n:1})).statusCode,409);
  state.busy=null;
  assert.ok(!existsSync(join(b,'backups'))||!readdirSync(join(b,'backups')).some(f=>f.startsWith('restore-staging-')));
  // The restore: staged, then handed to the desktop app; a second one waits for the restart.
  const r=await call('POST','/api/restore',{source:'backup',folder,n:1});
  assert.equal(r.statusCode,200,r.body);
  assert.deepEqual([r.json().restarting,r.json().n,r.json().damaged],[true,1,[]]);
  assert.equal(handed.length,1);assert.match(handed[0]!,/restore-staging-[0-9a-f]{8}$/);
  assert.ok(existsSync(join(handed[0]!,'.restore-ready.json'))&&existsSync(join(handed[0]!,'events.jsonl')));
  assert.equal((await call('POST','/api/restore',{source:'snapshot',id:'x'})).statusCode,409);
  await app.close();
});

test('the desktop worker, as its own process: a snapshot staged with the app\'s safeStorage over IPC, swapped, and listed',async()=>{
  const {b,b2,snap}=await withSnapshot();
  const run=(job:object)=>new Promise<any>((resolve,reject)=>{
    const script=`import(${JSON.stringify(pathToFileURL(join(ROOT,'src','restore.ts')).href)}).then(m=>m.restoreWorker(${JSON.stringify(job)}))`
      +`.then(r=>process.stdout.write(JSON.stringify({ok:true,...r})),e=>process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e)})))`
      +`.finally(()=>{try{process.disconnect()}catch{}})`;
    const child=spawn(process.execPath,['--import','tsx','-e',script],{cwd:ROOT,env:{...process.env,CAT_SECRETS_BROKER:'1'},stdio:['ignore','pipe','pipe','ipc']});
    // main.cjs serveSecrets, with fake broker 2 as safeStorage.
    child.on('message',async(m:any)=>{
      if(typeof m?.secret!=='number')return;
      try{const result=m.op==='available'?await b2.available():m.op==='encrypt'?await b2.encrypt(m.data):await b2.decrypt(m.data);child.send({secretReply:m.secret,ok:true,result});}
      catch{child.send({secretReply:m.secret,ok:false,error:'refused'});}
    });
    let out='',errText='';child.stdout!.on('data',d=>{out+=d;});child.stderr!.on('data',d=>{errText+=d;});
    child.once('exit',()=>{try{resolve(JSON.parse(out));}catch{reject(new Error(errText||'no answer'));}});
  });
  const listed=await run({dataDir:b,list:true});
  assert.deepEqual(listed.snapshots.map((s:any)=>s.id),[snap]);
  const r=await run({dataDir:b,snapshot:snap});
  assert.equal(r.ok,true,r.error);
  assert.equal(readFileSync(join(b,'events.jsonl'),'utf8'),'{"id":"then"}\n');
  const s=new SecretStore(b,b2);await s.load();
  assert.equal(s.get('models.json#hosted.key'),'sk-fake-then-000011');
  assert.equal(s.get('backup.json#recoveryKey'),'FAKE-RECOVERY-NOT-A-KEY');
  assert.ok(existsSync(join(r.before,'events.jsonl')));
  // apply: a staging folder that is not one is refused and nothing moves.
  const before=treeHash(b);
  const refused=await run({dataDir:b,apply:join(b,'backups','restore-staging-ffffffff')});
  assert.equal(refused.ok,false);assert.equal(treeHash(b),before);
});

test('wiring: recovery runs before the 7.1 snapshot, routes on the main listener only, and the desktop app stops the server before the swap',()=>{
  const server=readFileSync(join(ROOT,'src/server.ts'),'utf8');
  assert.ok(server.indexOf('await recoverRestore(dataPath)')>0&&server.indexOf('await recoverRestore(dataPath)')<server.indexOf('preUpgradeSnapshot(dataPath'));
  assert.match(server,/registerRestoreRoutes\(app,/);assert.ok(!/registerRestoreRoutes\(remoteApp/.test(server));
  assert.match(server,/\{owner:isOwner,host:isHost\}\);/);
  const main=readFileSync(join(ROOT,'desktop/main.cjs'),'utf8');
  assert.match(main,/\{label: 'Restore a backup…', click: openRestore\}/);
  const swap=main.slice(main.indexOf('async function swapAndRelaunch'),main.indexOf('function restoreStaged'));
  assert.ok(swap.indexOf('await stopServer({quitting: false})')>0&&swap.indexOf('await stopServer({quitting: false})')<swap.indexOf('runRestoreWorker(job)'));
  assert.ok(swap.indexOf('runRestoreWorker(job)')<swap.indexOf('await launch()'));
  // The worker gets paths and snapshot names only: no key reaches main.cjs, a command line or the log.
  assert.ok(!/recoveryKey/i.test(main));
});

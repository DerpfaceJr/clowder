// Plan 7.5: portable encrypted backups. Gate: a backup made with fake broker 1 holds no OUT file and no secret in plain text, and a second run
// copies only the appended bytes. Also: a restore with only the folder and the recovery key in a fresh process, tampered and truncated files
// refused, an interrupted run that leaves the last good point whole and finishes next time, and the routes' gates. Every value is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import Fastify from 'fastify';
import {Backups,newRecoveryKey,openBackup,parseRecoveryKey,registerBackupRoutes,restoreBackup,retryBusy,runBackup,secretIn,writeOnce,type Writer} from '../src/backup.ts';
import {openSecretStore,type Broker} from '../src/secret-store.ts';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const tmp=(name:string)=>mkdtempSync(join(tmpdir(),`backup-${name}-`));
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
const tree=(dir:string)=>walk(dir).map(f=>relative(dir,f).replace(/\\/g,'/')).sort();
const fresh=()=>join(tmp('out'),'restored');
const last=(key:string)=>key.split('-').at(-1)!;

// Fake broker 1: safeStorage on "PC 1", an AES key that lives only in this process.
function broker1():Broker{
  const k=randomBytes(32);
  return {available:async()=>true,
    encrypt:async t=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',k,iv);const b=Buffer.concat([c.update(t,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');},
    decrypt:async s=>{const x=Buffer.from(s,'base64'),d=createDecipheriv('aes-256-gcm',k,x.subarray(0,12));d.setAuthTag(x.subarray(12,28));return Buffer.concat([d.update(x.subarray(28)),d.final()]).toString('utf8');}};
}

const SECRET={hosted:'sk-fake-hosted-backup-000001',telegram:'123:fake-telegram-backup-000002',connector:'ghp_fake_backup_connector_000003',rendezvous:'fake-rendezvous-backup-000004',device:'fake-device-token-backup-000005',vapid:'fake-vapid-private-backup-000006'};
const OUT=['read-model.db','worlds/w2/read-model.db','events.jsonl.pre-compact-2026-01-01T00-00-00Z','devices.json','push-subscriptions.json','remote-settings.json',
  'cat-browser.json','tunnel/cert.pem','browser/Default/Cookies','wiki/page.md','backups/world-2026-01-01T00-00-00-000Z/events.jsonl',
  'backups/pre-aaaa-2026-01-01T00-00-00-000Z/events.jsonl','season-s1.lock','season-s1.log','server.log','workshop-settings.json','last-boot.json'];
// The IN files, as restored: journals, settings, checkpoints, artifacts and plugins, root and world.
const IN=['artifacts/a.txt','checkpoints/t1.json','events.jsonl','models.json','plugins/p/plugin.json','purchases.jsonl','season-s1.jsonl','telegram.json',
  'town-settings.json','workshop.jsonl','worlds.json','worlds/w2/accounts.json','worlds/w2/artifacts/b.txt','worlds/w2/events.jsonl'];

function seed(){
  const data=tmp('data');
  const put=(rel:string,text:string)=>{mkdirSync(join(data,rel,'..'),{recursive:true});writeFileSync(join(data,rel),text);};
  put('events.jsonl','{"id":1,"type":"fake-journal-marker-alpha"}\n{"id":2}\n');
  put('workshop.jsonl','{"id":"w"}\n');
  put('purchases.jsonl','{"p":1}\n');
  put('season-s1.jsonl','{"s":1}\n');
  put('worlds.json','{"worlds":[]}');
  put('models.json',JSON.stringify({hosted:{base:'https://api.example.com/v1',model:'m1',key:SECRET.hosted}}));
  put('telegram.json',JSON.stringify({token:SECRET.telegram,bot:'@fakebot',deviceToken:SECRET.device}));
  put('connector-secrets.json',JSON.stringify({github:SECRET.connector}));
  put('rendezvous.json',JSON.stringify({relay:'https://ntfy.example',key:SECRET.rendezvous}));
  put('vapid.json',JSON.stringify({publicKey:'p',privateKey:SECRET.vapid}));
  put('town-settings.json','{}');
  put('checkpoints/t1.json','{}');
  put('artifacts/a.txt','art');
  put('plugins/p/plugin.json','{}');
  put('worlds/w2/events.jsonl','{"id":3}\n');
  put('worlds/w2/accounts.json','{}');
  put('worlds/w2/artifacts/b.txt','b');
  for(const f of OUT)put(f,`OUT-MARKER ${f}`);
  return data;
}
// A town with backups set up on "PC 1": fake broker 1 holds the saved keys, and the recovery key is confirmed.
async function town(broker:Broker|undefined=broker1()){
  const data=seed(),folder=tmp('folder'),store=await openSecretStore(data,broker);
  const backups=new Backups(data);
  const {recoveryKey}=backups.setup(folder);
  assert.ok(recoveryKey);
  backups.confirm(last(recoveryKey));
  await store.flush();
  return {data,folder,store,backups,key:recoveryKey};
}

test('gate: a backup made with fake broker 1 has no OUT file and no secret in plain text, and a second run copies only the appended bytes',async()=>{
  const {data,folder,store,backups,key}=await town();
  assert.equal(store.mode,'encrypted');
  assert.ok(readdirSync(data).some(f=>/\.pre-secrets-\d+\.bak$/.test(f)),'the move left plaintext .bak files in the data folder');
  const first=await backups.run();
  assert.equal(first.n,1);
  // Only the header, manifests and opaque blobs are in the folder.
  for(const f of tree(folder))assert.match(f,/^(clowder-backup\.json|manifest-\d{6}\.enc|blobs\/[0-9a-f]{16}\.bin)$/);
  // No plain text of any secret, the recovery key in any spelling, the safeStorage file, a journal line or an OUT file.
  const raw=parseRecoveryKey(key);
  const needles=[...Object.values(SECRET),key,key.replace(/-/g,''),key.toLowerCase(),raw.toString('hex'),raw.toString('base64'),'fake-journal-marker-alpha','OUT-MARKER','fakebot',
    ...Object.values(JSON.parse(readFileSync(join(data,'secrets.v2.json'),'utf8')).items as Record<string,string>)].map(s=>Buffer.from(s));
  for(const file of walk(folder)){
    const bytes=readFileSync(file);
    for(const n of [...needles,raw])assert.ok(!bytes.includes(n),`${relative(folder,file)} holds plain text`);
  }
  // Decrypted with only the folder and the key, no blob holds an OUT file.
  const v=openBackup(folder,key);
  for(const b of readdirSync(join(folder,'blobs')))assert.ok(!v.blob(b).includes('OUT-MARKER'),`blob ${b} holds an OUT file`);
  // Restored: exactly the IN files, byte for byte, and the saved keys that travel.
  const out=fresh(),r=restoreBackup(folder,key,out);
  assert.deepEqual(tree(out),IN);
  for(const f of IN)assert.deepEqual(readFileSync(join(out,f)),readFileSync(join(data,f)),f);
  assert.deepEqual(r.secrets,{'connector-secrets.json#github':SECRET.connector,'models.json#hosted.key':SECRET.hosted,'telegram.json#token':SECRET.telegram});

  // Second run: only the bytes appended to the journal.
  const size=statSync(join(data,'events.jsonl')).size,extra='{"id":4,"type":"fake-appended"}\n';
  appendFileSync(join(data,'events.jsonl'),extra);
  const blobs=readdirSync(join(folder,'blobs'));
  const second=await backups.run();
  assert.equal(second.n,2);
  assert.deepEqual(second.written,[{path:'events.jsonl',from:size,size:Buffer.byteLength(extra)}]);
  assert.equal(second.bytes,Buffer.byteLength(extra));
  const added=readdirSync(join(folder,'blobs')).filter(b=>!blobs.includes(b));
  assert.equal(added.length,1);
  assert.equal(statSync(join(folder,'blobs',added[0]!)).size,Buffer.byteLength(extra)+32,'the new blob is the appended bytes plus magic, nonce and tag');
  const out2=fresh();restoreBackup(folder,key,out2);
  assert.deepEqual(readFileSync(join(out2,'events.jsonl')),readFileSync(join(data,'events.jsonl')));
  // Point 1 still restores the journal as it was.
  const out1=fresh();restoreBackup(folder,key,out1,{n:1});
  assert.equal(readFileSync(join(out1,'events.jsonl')).length,size);
  // Status: the last good run, never the key.
  const status=backups.status();
  assert.equal(status.lastGood?.n,2);assert.equal(status.lastRun?.ok,true);
  assert.ok(!JSON.stringify(status).includes(last(key)));
  assert.ok(!readFileSync(join(data,'backup.json'),'utf8').includes(last(key)),'backup.json holds no key: it is a SecretStore ref');
});

test('restore needs only the folder and the recovery key: a fresh process with no data folder, no secret store and no safeStorage reads it back',async()=>{
  const {data,folder,backups,key}=await town();
  await backups.run();
  const expected=Object.fromEntries(IN.map(f=>[f,readFileSync(join(data,f),'utf8')]));
  rmSync(data,{recursive:true,force:true});
  const dir=tmp('script'),script=join(dir,'restore.ts'),out=join(dir,'restored');
  writeFileSync(script,`import {restoreBackup} from ${JSON.stringify(pathToFileURL(join(ROOT,'src/backup.ts')).href)};
const r=restoreBackup(process.env.BACKUP_FOLDER!,process.env.BACKUP_KEY!,process.env.BACKUP_OUT!);
process.stdout.write(JSON.stringify({files:r.files,secrets:r.secrets,broker:process.env.CAT_SECRETS_BROKER??null,ipc:typeof process.send}));\n`);
  const env:NodeJS.ProcessEnv={...process.env,BACKUP_FOLDER:folder,BACKUP_KEY:key,BACKUP_OUT:out};delete env.CAT_SECRETS_BROKER;delete env.CAT_TOWN_DATA;
  const run=spawnSync(process.execPath,['--import','tsx',script],{cwd:ROOT,env,encoding:'utf8',windowsHide:true});
  assert.equal(run.status,0,run.stderr);
  const got=JSON.parse(run.stdout);
  assert.deepEqual([got.broker,got.ipc],[null,'undefined'],'no safeStorage broker in the restoring process');
  assert.equal(got.files,IN.length);
  assert.deepEqual(got.secrets,{'connector-secrets.json#github':SECRET.connector,'models.json#hosted.key':SECRET.hosted,'telegram.json#token':SECRET.telegram});
  assert.deepEqual(Object.fromEntries(tree(out).map(f=>[f,readFileSync(join(out,f),'utf8')])),expected);
});

test('integrity: a changed, truncated, swapped or missing file is refused with the target left empty; a damaged newest point falls back and says so',async()=>{
  const {data,folder,backups,key}=await town(undefined);
  await backups.run();
  appendFileSync(join(data,'events.jsonl'),'{"id":9}\n');
  writeFileSync(join(data,'artifacts/c.txt'),'c');
  await backups.run();
  const v=openBackup(folder,key),m=v.manifest(2);
  const blobOf=(path:string)=>join(folder,'blobs',m.files.find(f=>f.path===path)!.parts.at(-1)!.blob);
  const refused=(re:RegExp,opts:{n?:number}={})=>{const out=fresh();assert.throws(()=>restoreBackup(folder,key,out,opts),re);assert.ok(!existsSync(out),'nothing written');assert.ok(!readdirSync(join(out,'..')).length,'no temp folder left');};
  const seg=blobOf('events.jsonl'),good=readFileSync(seg);
  // One byte changed.
  const flipped=Buffer.from(good);flipped[flipped.length-20]^=1;writeFileSync(seg,flipped);
  refused(/damaged or was changed/);
  // Truncated.
  writeFileSync(seg,good.subarray(0,good.length-5));refused(/damaged or was changed/);
  writeFileSync(seg,good.subarray(0,10));refused(/damaged or was changed/);
  writeFileSync(seg,good);
  // Two valid blobs swapped: each is bound to its own name.
  const art=blobOf('artifacts/c.txt'),artBytes=readFileSync(art);
  writeFileSync(art,good);writeFileSync(seg,artBytes);refused(/damaged or was changed/);
  writeFileSync(art,artBytes);writeFileSync(seg,good);
  // Missing.
  renameSync(seg,`${seg}.away`);refused(/missing/);renameSync(`${seg}.away`,seg);
  // A wrong key, and a changed header.
  assert.throws(()=>restoreBackup(folder,newRecoveryKey(),fresh()),/does not open/);
  assert.throws(()=>restoreBackup(folder,'not-a-key',fresh()),/not a Clowder recovery key/);
  // The newest manifest damaged: the point before is used, and the result names the damaged one. Asked for by number, it is refused.
  const newest=join(folder,'manifest-000002.enc'),mb=readFileSync(newest),bad=Buffer.from(mb);bad[40]^=1;writeFileSync(newest,bad);
  const out=fresh(),r=restoreBackup(folder,key,out);
  assert.deepEqual([r.n,r.damaged],[1,[2]]);
  assert.ok(!existsSync(join(out,'artifacts/c.txt')));
  refused(/point 2 .*damaged/,{n:2});
  // A manifest copied over a newer number does not open either.
  writeFileSync(newest,readFileSync(join(folder,'manifest-000001.enc')));refused(/point 2 .*damaged/,{n:2});
  writeFileSync(newest,mb);
  // Everything back as it was: the newest point restores whole.
  const ok=fresh();assert.equal(restoreBackup(folder,key,ok).n,2);
  assert.deepEqual(readFileSync(join(ok,'events.jsonl')),readFileSync(join(data,'events.jsonl')));
  // A target that is not empty is refused.
  assert.throws(()=>restoreBackup(folder,key,ok),/empty folder/);
});

test('a blob damaged without a change of size is found within one turn of the checks, and its file is written whole again',async()=>{
  const {data,folder,backups,key}=await town(undefined);
  await backups.run();
  const first=openBackup(folder,key).manifest(1),held=first.files.flatMap(f=>f.parts).length+(first.secrets?1:0);
  const seg=join(folder,'blobs',first.files.find(f=>f.path==='events.jsonl')!.parts[0]!.blob),bytes=readFileSync(seg);
  bytes[bytes.length-20]^=1;writeFileSync(seg,bytes);
  assert.throws(()=>restoreBackup(folder,key,fresh()),/damaged|does not match/,'the newest point no longer restores');
  // Under 24 blobs each run opens one, so every blob has had its turn after as many runs as there are blobs.
  assert.ok(held<24);
  for(let i=0;i<held;i++)await backups.run();
  const out=fresh();restoreBackup(folder,key,out);
  assert.equal(readFileSync(join(out,'events.jsonl'),'utf8'),readFileSync(join(data,'events.jsonl'),'utf8'),'the newest point restores again');
});

test('an interrupted run leaves the last good point whole, and the next run finishes from it',async()=>{
  const {data,folder,backups,key}=await town(undefined);
  await backups.run();
  const before=readFileSync(join(data,'events.jsonl'));
  appendFileSync(join(data,'events.jsonl'),'{"id":5}\n');
  writeFileSync(join(data,'artifacts/new.txt'),'new');
  writeFileSync(join(data,'town-settings.json'),'{"changed":true}');
  // The power goes after two files: no manifest is written.
  let calls=0;const cut:Writer=(file,data)=>{if(++calls>2)throw new Error('power cut');writeOnce(file,data);};
  await assert.rejects(runBackup({dataDir:data,folder,recoveryKey:key,secrets:{},write:cut}),/power cut/);
  writeFileSync(join(folder,'blobs','0123456789abcdef.bin.tmp-deadbeef'),'half a file');
  // The last good point is whole.
  assert.deepEqual(openBackup(folder,key).numbers(),[1]);
  const out1=fresh();restoreBackup(folder,key,out1);
  assert.deepEqual(readFileSync(join(out1,'events.jsonl')),before);
  assert.ok(!existsSync(join(out1,'artifacts/new.txt')));
  // The next run finishes: the source restores whole, the leftovers are gone, and every blob is named by a kept point.
  const r=await backups.run();
  assert.equal(r.n,2);
  const out2=fresh();restoreBackup(folder,key,out2);
  for(const f of [...IN,'artifacts/new.txt'])assert.deepEqual(readFileSync(join(out2,f)),readFileSync(join(data,f)),f);
  assert.ok(!tree(folder).some(f=>/\.tmp-/.test(f)));
  const v=openBackup(folder,key),named=new Set(v.numbers().flatMap(n=>{const m=v.manifest(n);return [...m.files.flatMap(f=>f.parts.map(p=>p.blob)),m.secrets!.blob];}));
  assert.deepEqual(readdirSync(join(folder,'blobs')).sort(),[...named].sort(),'the interrupted run\'s blobs were removed');
  // A failed run is on the status and never replaces the last good one.
  rmSync(folder,{recursive:true,force:true});writeFileSync(folder,'a file where the folder was');
  await assert.rejects(backups.run());
  const s=backups.status();
  assert.equal(s.lastRun?.ok,false);assert.ok(s.lastRun?.error);assert.equal(s.lastGood?.n,2);
});

test('a journal that shrank or was rewritten starts a new full part; a torn last line waits; three points are kept',async()=>{
  const {data,folder,backups,key}=await town(undefined);
  const journal=join(data,'events.jsonl');
  // A torn last line is left out until it is whole.
  appendFileSync(journal,'{"id":3,"half');
  await backups.run();
  const old=readFileSync(journal,'utf8');
  const out1=fresh();restoreBackup(folder,key,out1);
  assert.equal(readFileSync(join(out1,'events.jsonl'),'utf8'),old.slice(0,old.lastIndexOf('\n')+1));
  appendFileSync(journal,'"}\n');
  const two=await backups.run();
  assert.deepEqual(two.written,[{path:'events.jsonl',from:old.lastIndexOf('\n')+1,size:Buffer.byteLength('{"id":3,"half"}\n')}]);
  // Compaction: shorter and different. A full new part from 0.
  writeFileSync(journal,'{"id":1}\n');
  const three=await backups.run();
  assert.deepEqual(three.written,[{path:'events.jsonl',from:0,size:9}]);
  // Bit rot: the same length, one byte changed. Also a full part.
  writeFileSync(journal,'{"id":7}\n');
  assert.deepEqual((await backups.run()).written,[{path:'events.jsonl',from:0,size:9}]);
  // Points kept: the newest three, each restorable; older manifests are gone.
  writeFileSync(join(data,'town-settings.json'),'{"x":1}');
  await backups.run();
  const v=openBackup(folder,key);
  assert.deepEqual(v.numbers(),[5,4,3]);
  for(const n of v.numbers()){const out=fresh();restoreBackup(folder,key,out,{n});}
  const out3=fresh();restoreBackup(folder,key,out3,{n:3});
  assert.equal(readFileSync(join(out3,'events.jsonl'),'utf8'),'{"id":1}\n');
});

test('recovery key: 26 base32 characters, read back case-blind; every file takes a fresh nonce; the same bytes never encrypt the same',async()=>{
  const key=newRecoveryKey();
  assert.match(key,/^[A-Z2-7]{6}(-[A-Z2-7]{5}){4}$/);
  assert.equal(key.replace(/-/g,'').length,26);
  assert.deepEqual(parseRecoveryKey(` ${key.toLowerCase().replace(/-/g,' ')} `),parseRecoveryKey(key));
  assert.equal(parseRecoveryKey(key).length,16);
  assert.notEqual(newRecoveryKey(),key);
  assert.throws(()=>parseRecoveryKey('ABCDEF-GHIJK'),/not a Clowder recovery key/);
  assert.throws(()=>parseRecoveryKey('AAAAAA-AAAAA-AAAAA-AAAAA-AAAAB'),/not a Clowder recovery key/,'the spare bits must be zero');
  // The same town backed up twice with the same key: equal plain text, different bytes, and no nonce used twice.
  const data=seed(),a=tmp('a'),b=tmp('b');
  await runBackup({dataDir:data,folder:a,recoveryKey:key,secrets:{}});
  await runBackup({dataDir:data,folder:b,recoveryKey:key,secrets:{}});
  const files=[...walk(a),...walk(b)].filter(f=>/\.(bin|enc)$/.test(f));
  const nonces=files.map(f=>readFileSync(f).subarray(4,16).toString('hex'));
  assert.equal(new Set(nonces).size,files.length);
  const journal=(folder:string)=>{const v=openBackup(folder,key),p=v.manifest(1).files.find(f=>f.path==='events.jsonl')!.parts[0]!;return {plain:v.blob(p.blob),bytes:readFileSync(join(folder,'blobs',p.blob))};};
  const ja=journal(a),jb=journal(b);
  assert.deepEqual(ja.plain,jb.plain);assert.notDeepEqual(ja.bytes,jb.bytes);
});

test('EBUSY from a sync client is retried; other errors are not',async()=>{
  const wait=async()=>{};
  let n=0;
  assert.equal(await retryBusy(()=>{if(++n<3)throw Object.assign(new Error('busy'),{code:'EBUSY'});return 'ok';},6,wait),'ok');
  assert.equal(n,3);
  n=0;await assert.rejects(retryBusy(()=>{n++;throw Object.assign(new Error('gone'),{code:'ENOENT'});},6,wait),/gone/);assert.equal(n,1);
  n=0;await assert.rejects(retryBusy(()=>{n++;throw Object.assign(new Error('locked'),{code:'EPERM'});},4,wait),/locked/);assert.equal(n,4);
  // A whole run through a writer that is busy twice for the header and the manifest still finishes.
  const data=seed(),folder=tmp('busy'),key=newRecoveryKey(),seen=new Map<string,number>();
  const busy:Writer=(file,bytes)=>{const k=(seen.get(file)??0)+1;seen.set(file,k);if(/manifest|clowder-backup/.test(file)&&k<3)throw Object.assign(new Error('EBUSY: resource busy or locked'),{code:'EBUSY'});writeOnce(file,bytes);};
  const r=await runBackup({dataDir:data,folder,recoveryKey:key,secrets:{},write:busy});
  assert.equal(r.n,1);
  assert.equal(restoreBackup(folder,key,fresh()).files,IN.length);
});

test('which saved keys travel: the IN list, never machine pairing, device tokens, push keys or the recovery key itself',()=>{
  for(const ref of ['models.json#hosted.key','connector-secrets.json#github','real-money-secrets.json#stripe.key','telegram.json#token','discord.json#token','oauth-clients.json#google.clientSecret','hermes.json#apiKey','ntfy.json#devices.a.topic'])assert.equal(secretIn(ref),true,ref);
  for(const ref of ['rendezvous.json#key','vapid.json#privateKey','cat-browser.json#token','backup.json#recoveryKey','telegram.json#deviceToken','discord.json#deviceToken'])assert.equal(secretIn(ref),false,ref);
});

test('routes: the key is shown once and only on the host; status never carries it; setup refuses a folder in the data folder or another key\'s folder',async()=>{
  const data=tmp('routes');await openSecretStore(data,broker1());
  const backups=new Backups(data),gates={owner:true,host:true};
  const app=Fastify();
  app.setErrorHandler((error:any,_req,res)=>{res.code(error.statusCode||400).send({error:error.message});}); // as server.ts
  registerBackupRoutes(app,backups,{owner:()=>gates.owner,host:()=>gates.host});
  const call=(method:'GET'|'POST',url:string,payload?:object)=>app.inject({method,url,...(payload?{payload}:{})});
  // Not the host: setup and confirm are refused; not an owner: everything is.
  gates.host=false;
  assert.equal((await call('POST','/api/backup/setup',{folder:tmp('x')})).statusCode,403);
  assert.equal((await call('POST','/api/backup/confirm',{lastGroup:'AAAAA'})).statusCode,403);
  assert.equal((await call('GET','/api/backup')).statusCode,200);
  gates.owner=false;
  for(const [m,u] of [['GET','/api/backup'],['POST','/api/backup/run'],['POST','/api/backup/enabled']] as const)assert.equal((await call(m,u,m==='POST'?{enabled:true}:undefined)).statusCode,403,u);
  gates.owner=gates.host=true;
  // Bad folders.
  assert.match((await call('POST','/api/backup/setup',{folder:'relative/path'})).json().error,/full path/);
  assert.match((await call('POST','/api/backup/setup',{folder:join(data,'inside')})).json().error,/outside/);
  const other=tmp('other');await runBackup({dataDir:seed(),folder:other,recoveryKey:newRecoveryKey(),secrets:{}});
  assert.equal((await call('POST','/api/backup/setup',{folder:other})).statusCode,409);
  // Nothing runs before setup.
  assert.equal((await call('POST','/api/backup/run')).statusCode,409);
  // Setup: a key, once. A second setup before confirming makes a new one (the first was never confirmed).
  const folder=tmp('folder');
  const first=(await call('POST','/api/backup/setup',{folder})).json();
  assert.match(first.recoveryKey,/^[A-Z2-7]{6}(-[A-Z2-7]{5}){4}$/);
  assert.equal(first.status.confirmed,false);assert.equal(first.status.enabled,false);
  const again=(await call('POST','/api/backup/setup',{folder})).json();
  assert.notEqual(again.recoveryKey,first.recoveryKey);
  const status=await call('GET','/api/backup');
  assert.ok(!status.body.includes(last(again.recoveryKey)));
  assert.equal(status.json().keySaved,true);
  // Confirm: the last group, typed back.
  assert.match((await call('POST','/api/backup/confirm',{lastGroup:last(first.recoveryKey)})).json().error,/not the last group/);
  const confirmed=await call('POST','/api/backup/confirm',{lastGroup:last(again.recoveryKey).toLowerCase()});
  assert.equal(confirmed.statusCode,200);assert.equal(confirmed.json().enabled,true);
  while(backups.running)await new Promise(r=>setTimeout(r,10));
  assert.equal(backups.status().lastGood?.n,1,'confirming starts the first backup');
  // Once confirmed, a new folder keeps the key and shows nothing.
  const moved=(await call('POST','/api/backup/setup',{folder:tmp('moved')})).json();
  assert.equal(moved.recoveryKey,undefined);
  assert.equal((await call('POST','/api/backup/run')).json().n,1);
  assert.equal((await call('POST','/api/backup/enabled',{enabled:false})).json().enabled,false);
  // The hourly slot does nothing while off or busy.
  backups.scheduled(true);assert.equal(backups.running,false);
  assert.equal((await call('POST','/api/backup/enabled',{enabled:true})).json().enabled,true);
  backups.scheduled(false);assert.equal(backups.running,false);
  backups.scheduled(true);assert.equal(backups.running,true);
  while(backups.running)await new Promise(r=>setTimeout(r,10));
  assert.equal(backups.status().lastGood?.n,2);
  await app.close();
});

test('a locked secret store refuses setup rather than write the key in plain text',async()=>{
  const data=tmp('locked');
  writeFileSync(join(data,'secrets.v2.json'),JSON.stringify({v:2,cipher:'safeStorage',items:{'models.json#hosted.key':'blob'}}));
  await openSecretStore(data);
  assert.throws(()=>new Backups(data).setup(tmp('f')),/locked/);
  assert.ok(!existsSync(join(data,'backup.json')));
});

test('server.ts: backup routes on the main listener only, and one croner job that checks the town is idle',()=>{
  const src=readFileSync(join(ROOT,'src/server.ts'),'utf8');
  assert.match(src,/registerBackupRoutes\(app,backups,\{owner:isOwner,host:isHost\}\)/);
  assert.ok(!/registerBackupRoutes\(remoteApp/.test(src));
  assert.equal(src.match(/new Cron\(/g)?.length,1);
  assert.match(src,/new Cron\('17 \* \* \* \*',\{protect:true,unref:true\},\(\)=>backups\.scheduled\(!busyReason\(\)\)\)/);
  // busyReason is the one idle rule (plan 7.10): a running season or a busy town.
  assert.match(src,/const busyReason=\(\):string\|null=>worlds\.seasons\.running\(\)\?'[^']+':worlds\.town\.isBusy\(\)\?'[^']+':null;/);
  assert.match(src,/backupJob\.stop\(\)/);
});

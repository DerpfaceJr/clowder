// Item 1.7: the SecretStore under a fake safeStorage broker, the move from the old plaintext files, seasons and redaction. Every value is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SECRET_FIELDS,openSecretStore,resetSecretStores,storeFor,withSecrets,type Broker} from '../src/secret-store.ts';
import {ModelHub,loadSettings,saveSettings} from '../src/models.ts';
import {catBrowserSettings} from '../src/cat-browser.ts';
import {redactValues,geminiDenyPolicy} from '../src/tool-runtimes.ts';
import {denyRules} from '../src/claude-tools.ts';
import {SeasonHost} from '../src/season-host.ts';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const tmp=()=>mkdtempSync(join(tmpdir(),'secret-store-'));
const DAY=86_400_000;
// A stand-in for safeStorage: reversible, and never the plain text on disk.
const fake=(o:{decrypt?:(b:string)=>Promise<string>}={}):Broker=>({
  available:async()=>true,
  encrypt:async t=>Buffer.from(`enc:${t}`).toString('base64').split('').reverse().join(''),
  decrypt:o.decrypt??(async b=>{const s=Buffer.from(b.split('').reverse().join(''),'base64').toString();if(!s.startsWith('enc:'))throw new Error('bad blob');return s.slice(4);}),
});
const reopen=(dir:string,broker?:Broker,now?:number)=>{resetSecretStores();return openSecretStore(dir,broker,now);};

// The old files as Clowder wrote them before the store. Every secret is fake and long enough to search for.
const OLD:Record<string,any>={
  'models.json':{local:{enabled:false},hosted:{base:'https://api.example.com/v1',model:'m1',key:'sk-fake-hosted-0000000001'},jev:{enabled:true,key:'sk-fake-jev-000000000002'},media:{'openai-images':{base:'https://api.example.com/v1',model:'img',key:'sk-fake-media-0000000003'}}},
  'connector-secrets.json':{github:{vars:{GITHUB_TOKEN:'ghp_fake0000000000000000004'},oauth:{accessToken:'fake-access-00000000005',refreshToken:'fake-refresh-0000000006'}}},
  'real-money-secrets.json':{stripe:{key:'sk_test_fake000000000007',webhookSecret:'whsec_fake00000000000008',cardId:'ic_fake',cardholderId:null,currency:'usd'}},
  'cat-browser.json':{mode:'chrome',token:'fakeExtensionToken000009'},
  'telegram.json':{token:'123456789:AAE-fake-token-for-tests-only-0000010',bot:'@fakebot',chat:42,deviceToken:'fake-device-token-0000011'},
  'discord.json':{token:'MTIzNDU2Nzg5MDEy.GabcDE.fake-discord-token-for-tests-0000012',bot:'fakebot',botId:'123456789012',deviceToken:'fake-device-token-0000013'},
  'vapid.json':{publicKey:'fake-public',privateKey:'fake-private-key-000000012',createdAt:'2026-01-01T00:00:00.000Z'},
  'ntfy.json':{devices:{'fake-device':{topic:'clowder-fake0000000000000000000000000000000000000000000',createdAt:'2026-01-01T00:00:00.000Z'}}},
  'rendezvous.json':{relay:'https://ntfy.example',topic:'clowder-fake',key:'fake-rendezvous-key-00000013'},
  'oauth-clients.json':{google:{clientId:'fake.apps.googleusercontent.com',clientSecret:'GOCSPX-fake-000000014',savedAt:1}},
  'hermes.json':{apiKey:'fake-hermes-api-key-0000015',gateToken:'fake-hermes-gate-token-0016',nonce:'n-1',hello:null},
  'backup.json':{folder:'D:\fake-backups',enabled:true,confirmed:true,recoveryKey:'FAKE00-RECOV-ERYKE-Y0000-00018'},
};
const SECRETS=['sk-fake-hosted-0000000001','sk-fake-jev-000000000002','sk-fake-media-0000000003','ghp_fake0000000000000000004','fake-access-00000000005','fake-refresh-0000000006',
  'sk_test_fake000000000007','whsec_fake00000000000008','fakeExtensionToken000009','123456789:AAE-fake-token-for-tests-only-0000010','fake-device-token-0000011','fake-private-key-000000012','fake-rendezvous-key-00000013','GOCSPX-fake-000000014','fake-hermes-api-key-0000015','fake-hermes-gate-token-0016','FAKE00-RECOV-ERYKE-Y0000-00018'];
function fixture(){const dir=tmp();for(const [name,v] of Object.entries(OLD))writeFileSync(join(dir,name),JSON.stringify(v));return dir;}
const snapshot=(dir:string)=>Object.fromEntries(readdirSync(dir).sort().map(n=>[n,readFileSync(join(dir,n),'utf8')]));

test('a value round-trips through the broker, the file holds only blobs, and without the broker the store is locked and left alone',async()=>{
  const dir=tmp(),s=await reopen(dir,fake());
  assert.equal(s.mode,'encrypted');
  s.update([['telegram.json#token','123456789:AAE-fake-token-for-tests-only-0000010']]);
  await s.flush();
  const disk=readFileSync(join(dir,'secrets.v2.json'),'utf8');
  assert.equal(JSON.parse(disk).cipher,'safeStorage');
  assert.ok(!disk.includes('fake-token'),'no plain text on disk');
  assert.equal((await reopen(dir,fake())).get('telegram.json#token'),'123456789:AAE-fake-token-for-tests-only-0000010');
  const locked=await reopen(dir);
  assert.equal(locked.mode,'locked');
  assert.equal(locked.get('telegram.json#token'),undefined);
  assert.throws(()=>locked.update([['telegram.json#token','x']]),/locked/);
  assert.equal(readFileSync(join(dir,'secrets.v2.json'),'utf8'),disk,'a locked store never rewrites the file');
  // A plain store opened by the desktop app is re-encrypted.
  const plainDir=tmp();(await reopen(plainDir)).update([['cat-browser.json#token','fakeExtensionToken000009']]);
  assert.match(readFileSync(join(plainDir,'secrets.v2.json'),'utf8'),/fakeExtensionToken000009/);
  const up=await reopen(plainDir,fake());
  assert.equal(up.mode,'encrypted');
  assert.equal(up.get('cat-browser.json#token'),'fakeExtensionToken000009');
  assert.ok(!readFileSync(join(plainDir,'secrets.v2.json'),'utf8').includes('fakeExtensionToken000009'));
});

test('the move from the old files round-trips every value, keeps backups for 7 days, and a second run changes nothing',async()=>{
  const dir=fixture(),now=Date.UTC(2026,10,6);
  const s=await reopen(dir,fake(),now);
  assert.equal(s.mode,'encrypted');
  const files=snapshot(dir);
  for(const v of SECRETS){
    for(const [n,text] of Object.entries(files))if(!n.endsWith('.bak'))assert.ok(!text.includes(v),`${v} left in ${n}`);
  }
  for(const [name,v] of Object.entries(OLD)){
    assert.deepEqual(withSecrets(join(dir,name),JSON.parse(files[name]!)),v,`${name} reads back whole`);
    assert.ok(existsSync(join(dir,`${name}.pre-secrets-${now}.bak`)),`${name} backed up`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,`${name}.pre-secrets-${now}.bak`),'utf8')),v);
  }
  // The refs are the Account model's secretRef strings.
  assert.equal(s.get('models.json#hosted.key'),'sk-fake-hosted-0000000001');
  assert.deepEqual(s.get('connector-secrets.json#github'),OLD['connector-secrets.json'].github);
  assert.equal(loadSettings(join(dir,'models.json')).jev?.key,'sk-fake-jev-000000000002');
  assert.equal(catBrowserSettings(dir).token,'fakeExtensionToken000009');
  assert.deepEqual(Object.keys(SECRET_FIELDS).sort(),Object.keys(OLD).sort(),'the fixture covers every writer');
  // Idempotent: the same files byte for byte, no new backup.
  await reopen(dir,fake(),now+DAY);
  assert.deepEqual(snapshot(dir),files);
  // Backups go after 7 days.
  await reopen(dir,fake(),now+8*DAY);
  assert.deepEqual(readdirSync(dir).filter(n=>n.endsWith('.bak')),[]);
  assert.equal(storeFor(dir).get('vapid.json#privateKey'),'fake-private-key-000000012');
});

test('a decrypt that fails or answers wrong aborts the move: every old file untouched, no store, and the old files keep working',async()=>{
  for(const decrypt of [async()=>{throw new Error('refused');},async()=>'"something else"']){
    const dir=fixture(),before=snapshot(dir);
    const s=await reopen(dir,fake({decrypt}));
    assert.equal(s.mode,'legacy');
    assert.deepEqual(snapshot(dir),before,'no file written, renamed or backed up');
    assert.equal(loadSettings(join(dir,'models.json')).hosted?.key,'sk-fake-hosted-0000000001');
    // A save in this state writes the old file as before, so nothing is lost.
    saveSettings(join(dir,'models.json'),{...loadSettings(join(dir,'models.json')),local:{enabled:true}});
    assert.match(readFileSync(join(dir,'models.json'),'utf8'),/sk-fake-hosted-0000000001/);
    assert.ok(!existsSync(join(dir,'secrets.v2.json')));
  }
});

test('a later move that aborts still reads the keys an earlier boot stored',async()=>{
  const dir=tmp(),file=join(dir,'models.json'),KEY='sk-fake-earlier-000000016';
  writeFileSync(file,JSON.stringify({hosted:{base:'https://api.example.com/v1',model:'m1',key:KEY}}));
  await reopen(dir,fake());
  assert.ok(!readFileSync(file,'utf8').includes(KEY));
  // A restored telegram.json whose check fails: the move aborts, models.json's key still comes from the store.
  writeFileSync(join(dir,'telegram.json'),JSON.stringify({token:'123456789:AAE-restored-token-for-tests-0000017',bot:'@b'}));
  const real=fake();
  const s=await reopen(dir,fake({decrypt:async b=>{const p=await real.decrypt(b);return p.includes('restored')?'"wrong"':p;}}));
  assert.equal(s.mode,'legacy');
  assert.equal(loadSettings(file).hosted?.key,KEY);
  assert.match(readFileSync(join(dir,'telegram.json'),'utf8'),/restored-token/,'the restored file is untouched');
});

test('a season gets its model key from the server and never reads secrets.v2.json',async()=>{
  resetSecretStores();
  const dir=tmp(),file=join(dir,'models.json'),KEY='sk-fake-season-0000000014';
  saveSettings(file,{hosted:{base:'https://api.example.com/v1',model:'m1',key:KEY}});
  assert.ok(!readFileSync(file,'utf8').includes(KEY),'models.json holds no key');
  rmSync(join(dir,'secrets.v2.json'));// the server still has it in memory; the child cannot find it on disk
  const models=pathToFileURL(join(ROOT,'src','models.ts')).href;
  const script=`const {loadSettings}=await import(${JSON.stringify(models)});console.log('key='+loadSettings(${JSON.stringify(file)}).hosted?.key+' env='+(process.env.CAT_TOWN_SECRETS===undefined?'gone':'kept'));`;
  const host=new SeasonHost({root:ROOT,dataDir:dir,launch:()=>({file:process.execPath,args:['--import','tsx','--input-type=module','-e',script]})});
  await host.start({name:'s1',mode:'hosted'});
  const log=join(dir,'season-s1.log');
  for(let waited=0;waited<20_000&&!/key=/.test(existsSync(log)?readFileSync(log,'utf8'):'');waited+=100)await new Promise(r=>setTimeout(r,100));
  const text=readFileSync(log,'utf8');
  assert.match(text,new RegExp(`key=${KEY} env=gone`),text);
  assert.ok(!existsSync(join(dir,'secrets.v2.json')));
});

test('redaction masks a value saved in the store',async()=>{
  resetSecretStores();
  const dir=tmp(),file=join(dir,'models.json'),KEY='sk-fake-redact-0000000015';
  saveSettings(file,{hosted:{base:'https://api.example.com/v1',model:'m1',key:KEY}});
  assert.ok(!readFileSync(file,'utf8').includes(KEY));
  const hub=new ModelHub({file,config,env:{}});
  const masked=redactValues(`the tool printed ${KEY} here`,hub.secretValues());
  assert.ok(!masked.includes(KEY),masked);
  assert.match(masked,/••••0015/);
});

test('Gemini code runs get the data folder deny list as policy rules',()=>{
  const policy=geminiDenyPolicy(denyRules('C:\\Users\\Owner\\AppData\\Roaming\\Clowder\\data'),'C:\\Users\\Owner');
  const re=new RegExp(/argsPattern = '(.*)'/.exec(policy)![1]!);
  const hit=(p:string)=>re.test(JSON.stringify({absolute_path:p}));
  assert.ok(hit('C:\\Users\\Owner\\AppData\\Roaming\\Clowder\\data\\secrets.v2.json'));
  assert.ok(hit('c:/Users/Owner/AppData/Roaming/Clowder/data/models.json'));
  assert.ok(hit('C:\\Users\\Owner\\.ssh\\id_ed25519'));
  assert.ok(!hit('C:\\Users\\Owner\\Clowder Workspaces\\town\\index.html'),'the workspace stays open');
  assert.equal((policy.match(/\[\[rule\]\]/g)??[]).length,8);
});

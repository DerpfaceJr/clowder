// Plan 10.3 (docs/for-you-and-teams-plan.md): people.json, devices that belong to a person, and removing a person. The HTTP proofs (a removed
// person's devices get 401, a member device reaches the member allow-list alone) are in test/device-roles.test.ts and test/lan-control.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OWNER,Pairing,type RemoteConfig} from '../src/pairing.ts';
import {People} from '../src/people.ts';

const config:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const DAY=24*60*60*1000;
const sha=(token:string)=>createHash('sha256').update(token).digest('hex');
const folder=()=>mkdtempSync(join(tmpdir(),'people-'));
const record=(id:string,permission:string,extra:object={})=>({id,name:id,permission,tokenHash:sha(randomBytes(32).toString('hex')),createdAt:Date.now(),expiresAt:Date.now()+20*DAY,...extra});

test('an old devices.json loads with every device the owner\'s, and a second load writes nothing',()=>{
  const file=join(folder(),'devices.json');
  // Today's records (no person) and a v1 one, which is renamed on the same load.
  writeFileSync(file,JSON.stringify([record('phone','owner',{followAt:Date.now()}),record('tablet','viewer'),record('v1-phone','control')]));
  const first=new Pairing(file,config);
  assert.deepEqual(first.list().map(d=>[d.id,d.permission,d.person]),[['phone','owner',OWNER],['tablet','viewer',OWNER],['v1-phone','owner',OWNER]]);
  const once=readFileSync(file,'utf8'),at=statSync(file).mtimeMs;
  assert.deepEqual(JSON.parse(once).map((d:{person:string})=>d.person),[OWNER,OWNER,OWNER],'the owner is saved with each device');
  const again=new Pairing(file,config);
  assert.equal(readFileSync(file,'utf8'),once);assert.equal(statSync(file).mtimeMs,at,'no write on the second load');
  assert.deepEqual(again.list().map(d=>d.person),[OWNER,OWNER,OWNER]);
  // People on the same folder with no people.json: the owner alone, nothing revoked, nothing written.
  const people=new People(join(file,'..','people.json'),again);
  assert.deepEqual(people.list().map(p=>[p.id,p.role]),[[OWNER,'owner']]);
  assert.equal(again.list().length,3);assert.equal(existsSync(join(file,'..','people.json')),false);
  assert.equal(readFileSync(file,'utf8'),once);
});

test('removing a person revokes every device of theirs through the revoke hooks, and their open code',()=>{
  const dir=folder(),pairing=new Pairing(join(dir,'devices.json'),config),people=new People(join(dir,'people.json'),pairing);
  const revoked:string[]=[];pairing.revoked.add(id=>revoked.push(id));
  const ana=people.add('Ana','member'),ben=people.add('Ben','viewer');
  const pairAs=(permission:'member'|'viewer'|'owner',person:string|undefined,name:string)=>pairing.pair(pairing.create(permission,'remote',person).code,name);
  const anaPhone=pairAs('member',ana.id,'Ana phone'),anaLaptop=pairAs('member',ana.id,'Ana laptop'),benPhone=pairAs('viewer',ben.id,'Ben phone'),mine=pairAs('owner',undefined,'My phone');
  assert.deepEqual([anaPhone.device.person,benPhone.device.person,mine.device.person],[ana.id,ben.id,OWNER]);
  const open=pairing.create('member','remote',ana.id);
  people.remove(ana.id);
  assert.deepEqual(revoked.sort(),[anaPhone.device.id,anaLaptop.device.id].sort(),'each of her devices went through revoke');
  assert.equal(pairing.authenticate(anaPhone.token),undefined);assert.equal(pairing.authenticate(anaLaptop.token),undefined);
  assert.ok(pairing.authenticate(benPhone.token)&&pairing.authenticate(mine.token),'other people\'s devices stay');
  assert.throws(()=>pairing.pair(open.code,'Late'),/expired, used or incorrect/,'her open code went with her');
  assert.deepEqual(people.list().map(p=>p.name),['Owner','Ben']);
  const saved=JSON.parse(readFileSync(join(dir,'people.json'),'utf8'));
  assert.equal(typeof saved.find((p:{id:string})=>p.id===ana.id).removedAt,'number','she stays on file, marked removed');
  assert.throws(()=>people.remove(ana.id),/No such person/);
  assert.throws(()=>people.remove(OWNER),/owner cannot be removed/);
  // Control is the owner's alone, so no code pairs another person's device as an owner.
  assert.throws(()=>pairing.create('owner','remote',ben.id),/Only the owner/);
});

test('fail closed on load: a device whose person is removed or unknown is revoked, and a damaged people.json stops the start',()=>{
  const dir=folder(),file=join(dir,'devices.json');
  writeFileSync(file,JSON.stringify([record('mine','owner'),record('gone','member',{person:'p-gone'}),record('stranger','member',{person:'p-unknown'}),record('kept','member',{person:'p-kept'})]));
  writeFileSync(join(dir,'people.json'),JSON.stringify([{id:'p-gone',name:'Gone',role:'member',createdAt:1,removedAt:2},{id:'p-kept',name:'Kept',role:'member',createdAt:1}]));
  const pairing=new Pairing(file,config),revoked:string[]=[];pairing.revoked.add(id=>revoked.push(id));
  new People(join(dir,'people.json'),pairing);
  assert.deepEqual(revoked.sort(),['gone','stranger']);
  assert.deepEqual(pairing.list().map(d=>d.id),['mine','kept']);
  for(const bad of ['{}','[{"id":"owner","name":"Me","role":"owner","createdAt":1}]','[{"id":"x","name":"X","role":"admin","createdAt":1}]']){
    writeFileSync(join(dir,'people.json'),bad);
    assert.throws(()=>new People(join(dir,'people.json'),pairing),/Invalid people store/,bad);
  }
  writeFileSync(file,JSON.stringify([record('bad','member',{person:''})]));
  assert.throws(()=>new Pairing(file,config),/Invalid paired-device store/);
});

// Plan 10.4: invites. The HTTP proofs (the host's routes, pairing through the tunnel listener) are in test/device-roles.test.ts.
const status=(work:()=>unknown)=>{try{work();return 200;}catch(error){return (error as {statusCode?:number}).statusCode;}};
test('invites: one code per person with their role; a used, replaced or expired code gets 401, and one person\'s code never pairs as another',()=>{
  let now=1_800_000_000_000;
  const dir=folder(),pairing=new Pairing(join(dir,'devices.json'),config,()=>now),people=new People(join(dir,'people.json'),pairing,()=>now);
  const ana=people.add('Ana','member'),ben=people.add('Ben','member'),cy=people.add('Cy','viewer');
  const replaced=people.invite(ana.id),forAna=people.invite(ana.id),forBen=people.invite(ben.id);
  assert.equal(forAna.permission,'member');
  assert.equal(status(()=>pairing.pair(replaced.code,'Old')),401,'a new code replaces the person\'s last one');
  const a=pairing.pair(forAna.code,'Ana phone');
  assert.deepEqual([a.device.person,a.device.permission],[ana.id,'member'],'Ana\'s code pairs a device of Ana\'s');
  assert.equal(status(()=>pairing.pair(forAna.code,'Again')),401,'a used code');
  const b=pairing.pair(forBen.code,'Ben phone');
  assert.deepEqual([b.device.person,b.device.permission],[ben.id,'member'],'Ben\'s code, made beside Ana\'s, is still his');
  assert.equal(people.invite(cy.id).permission,'viewer','a viewer is invited as a viewer, never as a member');
  assert.equal(status(()=>people.invite(OWNER)),404,'no invite pairs control');
  assert.equal(status(()=>people.invite('p-nobody')),404);
  const late=people.invite(ana.id);now+=config.pairingTtlMs;
  assert.equal(status(()=>pairing.pair(late.code,'Late')),401,'an expired code');
});

test('invites: the attempt limit holds, so past it even the right code gets 429 until the window passes',()=>{
  let now=1_800_000_000_000;
  const dir=folder(),pairing=new Pairing(join(dir,'devices.json'),config,()=>now),people=new People(join(dir,'people.json'),pairing,()=>now);
  const ana=people.add('Ana','member'),invite=people.invite(ana.id);
  for(let i=0;i<config.maxPairAttempts;i++)assert.equal(status(()=>pairing.pair('0000-0000-0000-0000','Guess')),401);
  assert.equal(status(()=>pairing.pair(invite.code,'Ana phone')),429);
  now+=config.attemptWindowMs;
  assert.equal(pairing.pair(invite.code,'Ana phone').device.person,ana.id);
});

test('a removed person\'s code stops working: the person is checked when a code is made and again when it is used',()=>{
  const dir=folder(),pairing=new Pairing(join(dir,'devices.json'),config),people=new People(join(dir,'people.json'),pairing);
  const ana=people.add('Ana','member'),open=people.invite(ana.id);
  people.remove(ana.id);
  assert.equal(status(()=>pairing.pair(open.code,'Late')),401);
  assert.equal(status(()=>people.invite(ana.id)),404,'no new code for a removed person');
  assert.equal(status(()=>pairing.create('member','remote',ana.id)),404,'nor through Pairing directly');
  // The check at use on its own: Ben's code stays in the open codes, and Ben is marked removed on file and read again, with no remove() call.
  const ben=people.add('Ben','member'),code=people.invite(ben.id).code,file=join(dir,'people.json');
  writeFileSync(file,JSON.stringify(JSON.parse(readFileSync(file,'utf8')).map((p:{id:string})=>p.id===ben.id?{...p,removedAt:Date.now()}:p)));
  new People(file,pairing);
  assert.equal(status(()=>pairing.pair(code,'Ben phone')),401);
  // Without People only the owner's codes are made and pair: the timid default.
  const bare=new Pairing(join(folder(),'devices.json'),config);
  assert.equal(status(()=>bare.create('member','invite:p-x','p-x')),404);
  assert.equal(bare.pair(bare.create('viewer').code,'My tablet').device.person,OWNER);
});

// Plan 11.21: integration health. One item per integration whose error has lasted 15 min; it closes when the integration works again.
// The Telegram case runs the real channel against a fake Bot API that answers 401, with the clock under the test's control.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Backups} from '../src/backup.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {TelegramChannel,type BotApi} from '../src/telegram.ts';
import {ErrorClock,healthOf,type Integration} from '../src/health.ts';
import {quests} from '../src/quests.ts';
import {deskTown,tmp,until} from './fixtures/desk-town.ts';

const remoteConfig:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const TOKEN='123456789:AAE-fake-token-for-tests-only-0123456';
const MIN=60_000;
const T0=Date.parse('2026-11-09T10:02:00Z');
const down=(since:number|null,error='Telegram 401: Unauthorized'):Integration['health']=>({state:'error',error,since});
const ok:Integration['health']={state:'ok',error:null,since:null};

test('Health: an error for 16 min files one item; 14 min files none; three failing files three',async()=>{
  const desk=await deskTown();
  try{
    const at=(list:Integration[],now:number)=>quests({state:desk.store.state,projects:[],capabilities:[],seasons:[],models:null,now:new Date(now),integrations:list})
      .filter(q=>q.source.kind==='health');
    const tg:Integration={id:'telegram',name:'Telegram',health:down(T0)};
    assert.equal(at([tg],T0+14*MIN).length,0,'14 min: not yet');
    const items=at([tg],T0+16*MIN);
    assert.equal(items.length,1);
    assert.equal(items[0]!.id,'health:telegram');
    assert.equal(items[0]!.band,'needs');assert.equal(items[0]!.needsYou,true);
    assert.match(items[0]!.title,/^Telegram stopped working at \d\d:\d\d: Telegram 401: Unauthorized$/);
    const three:Integration[]=[tg,{id:'discord',name:'Discord',health:down(T0-MIN)},{id:'backup',name:'Backup',health:down(T0-30*MIN,'Disk full.')},{id:'mail',name:'Mail',health:ok}];
    assert.equal(at(three,T0+16*MIN).length,3,'three failing integrations, three items');
    assert.equal(at([{id:'mail',name:'Mail',health:ok}],T0+60*MIN).length,0,'ok or off files nothing');
  }finally{await desk.close();}
});

test('Health: a fake Telegram 401 lasting 16 min files one item, and it closes when a poll succeeds',async()=>{
  const desk=await deskTown(),data=tmp('health-tg-');
  const pairing=new Pairing(join(data,'devices.json'),remoteConfig);
  let now=T0,revoked=true;
  const api:BotApi=async(method)=>{
    if(method==='getMe')return {id:1,is_bot:true,username:'clowder_test_bot'};
    if(method==='getUpdates'){
      if(revoked)throw new Error('Telegram 401: Unauthorized');
      await new Promise(r=>setTimeout(r,5));return [];
    }
    return true;
  };
  const channel=new TelegramChannel({dataDir:data,pairing,town:()=>desk.town,mode:()=>'test',api:()=>api,retryMs:1,now:()=>now});
  const filed=()=>quests({state:desk.store.state,projects:[],capabilities:[],seasons:[],models:null,now:new Date(now),integrations:[{id:'telegram',name:'Telegram',health:channel.health()}]})
    .filter(q=>q.source.kind==='health');
  try{
    assert.equal(channel.health().state,'off','no token yet');
    await channel.setToken(TOKEN);
    await until(()=>channel.error!==null);
    assert.equal(channel.health().state,'error');
    assert.equal(channel.health().since,T0,'the stretch began at the first failure');
    now=T0+16*MIN;
    const items=filed();
    assert.equal(items.length,1,'exactly one item');
    assert.equal(items[0]!.id,'health:telegram');
    // The Bot API is back: the next poll succeeds, the error clears, and the item closes itself.
    revoked=false;
    await until(()=>channel.error===null);
    assert.equal(channel.health().state,'ok');
    assert.equal(filed().length,0,'closed once the integration works again');
  }finally{channel.stop();await desk.close();}
});

test('ErrorClock: a repeated error keeps the first time; clearing ends the stretch',()=>{
  let t=1;const c=new ErrorClock(()=>t);
  c.set('a');t=5;c.set('b');assert.equal(c.since,1);
  c.set(null);assert.equal(c.since,null);t=9;c.set('c');assert.equal(c.since,9);
  assert.deepEqual(healthOf(false,'x',1),{state:'off',error:null,since:null});
});

test('Health: backup is off until set up; its error starts at the first failed run, and a good run clears it',()=>{
  const dir=tmp('health-backup-'),b=new Backups(dir);
  assert.equal(b.health().state,'off');
  const first=T0,later=T0+60*MIN;
  writeFileSync(join(dir,'backup.json'),JSON.stringify({folder:'x',enabled:true,confirmed:true,lastRun:{at:new Date(later).toISOString(),ok:false,error:'Disk full.',n:null,bytes:0},failingSince:new Date(first).toISOString()}));
  assert.deepEqual(b.health(),{state:'error',error:'Disk full.',since:first},'the stretch began at the first failure, not the latest');
  writeFileSync(join(dir,'backup.json'),JSON.stringify({folder:'x',enabled:true,confirmed:true,lastRun:{at:new Date(later).toISOString(),ok:true,error:null,n:1,bytes:1}}));
  assert.equal(b.health().state,'ok');
});

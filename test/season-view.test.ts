import {allRoles,withFullRoster} from '../src/roles.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {latestSeason, ownerDirectives, publicSeason, readSeason, seasonSummary} from '../src/season-view.ts';
import {runSeason} from '../src/season.ts';
import {replay} from '../src/economy.ts';
import {Store} from '../src/store.ts';
import type {Task} from '../src/store.ts';
import {Town} from '../src/engine.ts';

const config=withFullRoster(JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')));
const tmp=()=>mkdtempSync(join(tmpdir(),'season-view-'));

test('publicSeason matches the replayed balance, caps recent at 40 and never exposes a fit key', async()=>{
  const dir=tmp();
  await runSeason({name:'v',mode:'demo',seed:5,days:1,dataDir:dir,config});
  const events=readSeason(dir,'v');
  assert.equal(publicSeason(events,'v').balance,replay(events).balance);
  // Padding with a fit key in args and a pending spend carrying a hidden fit exercises the cap and the key scrub.
  // The last action is a message containing "profit", which must survive untouched.
  const padded=[...events,
    ...Array.from({length:60},(_,i)=>({type:'action',cat:'critic',key:`pad${i}`,name:'review',args:{business:'b1',fit:0.9},ok:true,result:'Estimated demand score for b1: 1.1'})),
    {type:'spend.requested',id:'sp999',cat:'merchant',amount:5,purpose:'open x',then:{type:'business.opened',id:'b99',owner:'merchant',name:'X',pitch:'p',category:'c',price:1,unitCost:1,fit:1.5,startup:5}},
    {type:'action',cat:'mayor',key:'profit-msg',name:'message',args:{to:'owner',text:'Profit is up this week'},ok:true,result:'Message recorded.'},
  ];
  const out=publicSeason(padded,'v');
  assert.equal(out.balance,replay(padded).balance);
  assert.equal(out.recent.length,40);
  assert.equal(/"fit"\s*:/.test(JSON.stringify(out)),false);
  assert.ok(out.recent.some(a=>a.args?.text==='Profit is up this week'),'a message containing profit was rewritten or dropped');
});

test('readSeason skips a malformed last line but refuses a malformed middle line', ()=>{
  const dir=tmp();
  writeFileSync(join(dir,'season-p.jsonl'),'{"type":"season.started","seed":1}\n{"type":"tick.started","day":0,"tick":0}\n{"type":"acti');
  assert.deepEqual(readSeason(dir,'p').map(e=>e.type),['season.started','tick.started']);
  writeFileSync(join(dir,'season-q.jsonl'),'{"type":"season.started"}\nnot json\n{"type":"tick.started"}\n');
  assert.throws(()=>readSeason(dir,'q'),/damaged at line 2/);
});

test('latestSeason picks the most recently modified season journal', ()=>{
  const dir=tmp();
  assert.equal(latestSeason(dir),undefined);
  writeFileSync(join(dir,'season-old.jsonl'),'');writeFileSync(join(dir,'season-new.jsonl'),'');writeFileSync(join(dir,'season-old.lock'),'1');
  const past=new Date(Date.now()-60_000);utimesSync(join(dir,'season-old.jsonl'),past,past);
  assert.equal(latestSeason(dir),'new');
});

test('ownerDirectives returns only owner-to-mayor messages, in order, last three, after a given time', ()=>{
  const dir=tmp();const file=join(dir,'events.jsonl');
  const msg=(at:string,from:string,to:string,text:string)=>JSON.stringify({id:at,at,type:'message',data:{from,to,text}});
  writeFileSync(file,[
    msg('2026-10-24T10:00:00.000Z','owner','mayor','one'),
    msg('2026-10-24T10:01:00.000Z','owner','scholar','not for the mayor'),
    msg('2026-10-24T10:02:00.000Z','mayor','owner','a reply'),
    msg('2026-10-24T10:03:00.000Z','owner','mayor','two'),
    msg('2026-10-24T10:04:00.000Z','owner','mayor','three'),
    msg('2026-10-24T10:05:00.000Z','owner','mayor','four'),
    '{"type":"message","da',
  ].join('\n'));
  assert.deepEqual(ownerDirectives(file).map(d=>d.text),['two','three','four']);
  assert.deepEqual(ownerDirectives(file,'2026-10-24T10:03:30.000Z').map(d=>d.text),['three','four']);
  assert.deepEqual(ownerDirectives(join(dir,'missing.jsonl')),[]);
});

test('seasonSummary is empty without a season and stays under 600 characters with one', async()=>{
  const dir=tmp();
  assert.equal(seasonSummary(dir),'');
  await runSeason({name:'s',mode:'demo',seed:9,days:2,dataDir:dir,config});
  const text=seasonSummary(dir);
  assert.ok(text.length>0&&text.length<=600,`length ${text.length}`);
  assert.match(text,/^Season s: /);
  assert.equal(text.toLowerCase().includes('fit'),false);
});

test('the Mayor chat prompt carries the economy summary; other cats and a failing summary do not', ()=>{
  const store=new Store(join(tmp(),'events.jsonl'),allRoles(config));
  const town=new Town(store,config);
  const task=(cat:string):Task=>({id:`t-${cat}`,cat,from:'owner',text:'How is the economy?',mode:'demo',status:'running'});
  town.economySummary=()=>'Season s: day 0, tick 1.';
  assert.ok(town.context(task('mayor'),0).messages[0].content.includes('\nCoin economy (read-only; you steer it through your season decisions and by messaging cats): Season s: day 0, tick 1.'));
  assert.equal(town.context(task('scholar'),0).messages[0].content.includes('Coin economy'),false);
  town.economySummary=()=>{throw new Error('bad season file');};
  assert.equal(town.context(task('mayor'),0).messages[0].content.includes('Coin economy'),false);
});

test('publicSeason exposes capabilities and seasonSummary lists the needs-owner request', async()=>{
  const dir=tmp();
  await runSeason({name:'cap',mode:'demo',seed:1,days:2,dataDir:dir,config});
  const events=readSeason(dir,'cap');
  const caps=publicSeason(events,'cap').capabilities;
  assert.deepEqual(caps.map(c=>[c.cat,c.kind,c.tier,c.status]),[['scholar','package','sandbox','approved'],['builder','account','owner','needs_owner']]);
  assert.equal(caps[0].source,'npm:csv-parse');
  assert.equal(caps[1].source,null);
  const text=seasonSummary(dir);
  assert.match(text,/Needs owner: a real web shop \(builder\)\./);
  assert.ok(text.length<=600);
});

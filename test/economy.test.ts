import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {act,apply,checkInvariants,initialState,replay,rng,startSeason,startTick,marketStep} from '../src/economy.ts';
import type {EconomyConfig,EconomyEvent} from '../src/economy.ts';
const economy:EconomyConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).economy;
const cats=['mayor','banker','merchant','critic'];

// Drives a season the way the runner will: startTick, then acts, then marketStep each tick.
function season(seed:number,cfg:EconomyConfig=economy){
  const events:EconomyEvent[]=[];
  let state=initialState();
  const add=(evs:EconomyEvent[])=>{for(const e of evs){events.push(e);state=apply(state,e);}return evs;};
  add(startSeason(cfg,cats,seed));
  return {
    events,
    get state(){return state;},
    begin(){add(startTick(state,cfg));},
    markets(){add(marketStep(state,cfg));},
    act(cat:string,key:string,name:string,args:any={}){const out=act(state,cfg,cat,key,name,args);add(out.events);return out;},
  };
}
const firstId=(events:EconomyEvent[],type:string)=>events.find(e=>e.type===type)!.id;

test('rng stays in [0,1) and the same keys always give the same stream', ()=>{
  const r=rng(7,'x');
  for(let i=0;i<1000;i++){const v=r();assert.ok(v>=0&&v<1);}
  assert.equal(rng(7,'x','y')(),rng(7,'x','y')());
  assert.notEqual(rng(7,'x')(),rng(8,'x')());
});

test('same seed and actions give identical events and replay; another seed draws another fit',()=>{
  const script=(sim:ReturnType<typeof season>)=>{
    sim.begin();
    sim.act('merchant','k1','open_business',{name:'Bakery',pitch:'Fresh bread',category:'Food',price:10,unitCost:4,startup:40});
    sim.act('critic','k2','research',{category:'Food'});
    sim.markets();
    sim.begin();
    sim.act('merchant','k3','buy_stock',{business:'b1',units:2});
    sim.act('critic','k4','market',{business:'b1',amount:30});
    sim.markets();
  };
  const a=season(7),b=season(7),c=season(8);
  script(a);script(b);script(c);
  assert.deepEqual(a.events,b.events);
  assert.deepEqual(replay(a.events),replay(b.events));
  assert.deepEqual(replay(a.events),a.state);
  assert.notEqual(a.state.businesses[0].fit,c.state.businesses[0].fit);
});

test('a scripted two-day season keeps every invariant and balances against its events',()=>{
  const sim=season(42,{...economy,days:2});
  const ok=(out:{ok:boolean;result:string;events:EconomyEvent[]})=>{assert.equal(out.ok,true,out.result);return out;};
  sim.begin();
  ok(sim.act('merchant','t0-bakery','open_business',{name:'Bakery',pitch:'Fresh bread',category:'Food',price:10,unitCost:4,startup:40}));
  const gallery=ok(sim.act('critic','t0-gallery','open_business',{name:'Gallery',pitch:'Local art',category:'Art',price:12,unitCost:6,startup:80}));
  ok(sim.act('banker','t0-approve','decide_spend',{id:firstId(gallery.events,'spend.requested'),approved:true,reason:'worth a try'}));
  sim.markets();
  sim.begin();
  ok(sim.act('merchant','t1-stock','buy_stock',{business:'b1',units:2}));
  ok(sim.act('critic','t1-market','market',{business:'b1',amount:30}));
  ok(sim.act('mayor','t1-envelope','set_envelope',{cat:'merchant',amount:100}));
  sim.markets();
  sim.begin();
  const bigStock=ok(sim.act('merchant','t2-big-stock','buy_stock',{business:'b1',units:50}));
  const bigMarket=ok(sim.act('critic','t2-big-market','market',{business:'b2',amount:500}));
  ok(sim.act('banker','t2-reject','decide_spend',{id:firstId(bigMarket.events,'spend.requested'),approved:false,reason:'too large for a test'}));
  sim.markets();
  sim.begin();
  ok(sim.act('critic','t3-research','research',{category:'Art'}));
  sim.markets();
  sim.begin();
  ok(sim.act('merchant','t4-mill','open_business',{name:'Mill',pitch:'Grind grain',category:'Food',price:8,unitCost:3,startup:30}));
  sim.markets();
  sim.begin();
  ok(sim.act('merchant','t5-price','set_price',{business:'b1',price:12}));
  sim.markets();
  assert.ok(bigStock.events.some(e=>e.type==='spend.requested'));

  const events=sim.events;
  assert.deepEqual(checkInvariants(events),[]);
  assert.ok(events.some(e=>e.type==='spend.decided'&&e.approved===true&&e.by==='banker'));
  assert.ok(events.some(e=>e.type==='spend.decided'&&e.approved===false&&e.by==='banker'));
  assert.ok(events.some(e=>e.type==='spend.decided'&&e.by==='system'&&e.reason==='expired'));
  const sum=(type:string,field:string)=>events.filter(e=>e.type===type).reduce((n,e)=>n+e[field],0);
  assert.ok(sum('coins.earned','amount')>0);
  assert.equal(sim.state.balance,economy.startingCoins+sum('coins.earned','amount')-sum('coins.settled','amount'));
  assert.ok(sim.state.balance>=0);
});

test('rejections: self-approval, non-owner edits, non-mayor envelopes, self-targeting, overspend, repeated keys',()=>{
  const sim=season(3,{...economy,maxActionsPerTick:10});
  sim.begin();
  const vault=sim.act('banker','r1','open_business',{name:'Vault',pitch:'Keep coins',category:'Bank',price:5,unitCost:1,startup:80});
  assert.equal(vault.ok,true);
  const id=firstId(vault.events,'spend.requested');
  const self=sim.act('banker','r2','decide_spend',{id,approved:true,reason:'mine'});
  assert.equal(self.ok,false);
  assert.match(self.result,/own request/);
  assert.deepEqual(self.events.map(e=>e.type),['action']);
  const notBanker=sim.act('critic','r3','decide_spend',{id,approved:true,reason:'not mine to decide'});
  assert.equal(notBanker.ok,false);
  const bake=sim.act('merchant','r4','open_business',{name:'Bakery',pitch:'Bread',category:'Food',price:10,unitCost:4,startup:20});
  assert.equal(bake.ok,true);
  const bakery=firstId(bake.events,'business.opened');
  const steal=sim.act('critic','r5','set_price',{business:bakery,price:1});
  assert.equal(steal.ok,false);
  assert.match(steal.result,/owner/);
  const envelope=sim.act('merchant','r6','set_envelope',{cat:'critic',amount:999});
  assert.equal(envelope.ok,false);
  assert.match(envelope.result,/Mayor/);
  const selfTarget=sim.act('mayor','r7','set_envelope',{cat:'mayor',amount:10});
  assert.equal(selfTarget.ok,false);
  assert.match(selfTarget.result,/itself/);
  const overspend=sim.act('critic','r8','open_business',{name:'Palace',pitch:'Too big',category:'Art',price:5,unitCost:1,startup:950});
  assert.equal(overspend.ok,false);
  assert.match(overspend.result,/Not enough/);
  const repeat=sim.act('merchant','r4','market',{business:bakery,amount:5});
  assert.equal(repeat.ok,bake.ok);
  assert.equal(repeat.result,bake.result);
  assert.deepEqual(repeat.events,[]);
  assert.deepEqual(checkInvariants(sim.events),[]);
});

test('checkInvariants flags an unknown settlement and an oversold business',()=>{
  const sim=season(5);
  sim.begin();
  sim.act('merchant','c1','open_business',{name:'Bakery',pitch:'Bread',category:'Food',price:10,unitCost:4,startup:40});
  sim.begin();
  sim.act('merchant','c2','buy_stock',{business:'b1',units:2});
  assert.deepEqual(checkInvariants(sim.events),[]);
  const violations=checkInvariants([...sim.events,{type:'coins.settled',id:'sp999',amount:5},{type:'business.sold',id:'b1',units:999,revenue:9990}]);
  assert.ok(violations.some(m=>/unknown reservation sp999/.test(m)),violations.join('\n'));
  assert.ok(violations.some(m=>/sold 999 units/.test(m)),violations.join('\n'));
  const orphan=checkInvariants([...sim.events,{type:'coins.earned',business:'b1',amount:5}]);
  assert.ok(orphan.some(m=>/earnings do not follow a matching sale/.test(m)),orphan.join('\n'));
});

test('a business with startup 100 pays 4 + 10 upkeep each tick, and the spend ids stay stable',()=>{
  const sim=season(21);
  sim.begin();
  sim.act('merchant','u1','open_business',{name:'Bakery',pitch:'Bread',category:'Food',price:10,unitCost:4,startup:100});
  sim.act('banker','u2','decide_spend',{id:firstId(sim.events,'spend.requested'),approved:true,reason:'test'});
  assert.equal(sim.state.balance,economy.startingCoins-100);
  const before=sim.state.balance;
  const from=sim.events.length;
  sim.markets();
  assert.deepEqual(sim.events.slice(from),[
    {type:'coins.reserved',id:'up:b1:0',key:'upkeep:b1:0',cat:'merchant',amount:14,purpose:'upkeep b1',envelope:false},
    {type:'coins.settled',id:'up:b1:0',amount:14},
  ]);
  assert.equal(sim.state.balance,before-14);
  assert.equal(sim.state.reserved,0);
  sim.begin();
  const stock=sim.act('merchant','u3','buy_stock',{business:'b1',units:2});
  assert.equal(stock.ok,true,stock.result);
  assert.equal(stock.events.find((e):e is EconomyEvent=>e.type==='coins.reserved')?.id,'sp2');
  sim.markets();
  const pair=sim.events.filter(e=>e.id==='up:b1:1');
  assert.deepEqual(pair.map(e=>e.type),['coins.reserved','coins.settled']);
  assert.equal(pair[0].key,'upkeep:b1:1');
  assert.equal(pair[0].amount,14);
  assert.equal(pair[1].amount,14);
  assert.deepEqual(checkInvariants(sim.events),[]);
});

test('a business that cannot pay upkeep closes with that reason and no coins move',()=>{
  const sim=season(22,{...economy,startingCoins:100});
  sim.begin();
  sim.act('merchant','d1','open_business',{name:'Bakery',pitch:'Bread',category:'Food',price:10,unitCost:4,startup:100});
  sim.act('banker','d2','decide_spend',{id:firstId(sim.events,'spend.requested'),approved:true,reason:'all in'});
  assert.equal(sim.state.balance,0);
  const before={balance:sim.state.balance,reserved:sim.state.reserved,settled:sim.state.settled,earned:sim.state.earned};
  const from=sim.events.length;
  sim.markets();
  assert.deepEqual(sim.events.slice(from),[{type:'business.closed',id:'b1',reason:'could not pay upkeep'}]);
  assert.deepEqual({balance:sim.state.balance,reserved:sim.state.reserved,settled:sim.state.settled,earned:sim.state.earned},before);
  assert.equal(sim.state.businesses[0].open,false);
  assert.deepEqual(checkInvariants(sim.events),[]);
  const again=checkInvariants([...sim.events,{type:'business.closed',id:'b1',reason:'could not pay upkeep'}]);
  assert.ok(again.some(m=>/cannot fail upkeep/.test(m)),again.join('\n'));
});

test('capability sources: packages and repos accept only the spec formats', ()=>{
  const ok:[string,string][]=[['package','npm:csv-parse'],['package','npm:@scope/tool.js'],['package','pypi:requests'],['repo','https://github.com/owner/repo-name']];
  const bad:[string,unknown][]=[['package','csv-parse'],['package','yarn:left-pad'],['package','npm:Bad Name'],['package','npm:'],['package',['npm:x']],['repo','http://github.com/o/r'],['repo','https://github.com/o/r/tree/main'],['repo','https://github.com/o/'],['repo',undefined]];
  for(const [kind,source] of ok){
    const sim=season(11);sim.begin();
    const out=sim.act('merchant','s-ok-'+source,'request_capability',{kind,need:'a tool',purpose:'to test',source});
    assert.equal(out.ok,true,`${kind} ${source}: ${out.result}`);
  }
  for(const [kind,source] of bad){
    const sim=season(11);sim.begin();
    const out=sim.act('merchant','s-bad',"request_capability",{kind,need:'a tool',purpose:'to test',source});
    assert.equal(out.ok,false,`${kind} ${JSON.stringify(source)} should be refused`);
    assert.deepEqual(out.events.map(e=>e.type),['action']);
  }
  const sim=season(11);sim.begin();
  const relabel=sim.act('merchant','s-tier','request_capability',{kind:'package',need:'a tool',purpose:'to test',source:'npm:csv-parse'});
  assert.equal((relabel.events.find(e=>e.type==='capability.requested') as any)?.tier,'sandbox');
  const account=sim.act('critic','s-acct','request_capability',{kind:'account',need:'a shop',purpose:'to sell'});
  assert.equal((account.events.find(e=>e.type==='capability.requested') as any)?.tier,'owner');
  assert.equal(sim.state.capabilities.find(c=>c.kind==='account')?.status,'needs_owner');
});

test('owner-tier requests escalate, and no one can decide them',()=>{
  const sim=season(12);sim.begin();
  const req=sim.act('merchant','o1','request_capability',{kind:'money',need:'a bank card',purpose:'pay suppliers'});
  assert.equal(req.ok,true,req.result);
  assert.deepEqual(req.events.map(e=>e.type),['action','capability.requested','capability.escalated']);
  const id=firstId(req.events,'capability.requested');
  for(const cat of ['mayor','banker'] as const){
    const out=sim.act(cat,`o-${cat}`,'decide_capability',{id,approved:true,reason:'please'});
    assert.equal(out.ok,false);
    assert.match(out.result,/only the owner can grant this/);
  }
  assert.equal(sim.state.capabilities[0].status,'needs_owner');
  assert.deepEqual(checkInvariants(sim.events),[]);
  const injected=checkInvariants([...sim.events,{type:'capability.decided',id,by:'mayor',approved:true,reason:'forged'}]);
  assert.ok(injected.some(m=>/owner-tier capability cap1 may not be decided/.test(m)),injected.join('\n'));
  assert.ok(injected.some(m=>/owner-tier capability cap1 is approved/.test(m)),injected.join('\n'));
});

test('a cat cannot decide its own request, and the Banker decides the Mayor\'s',()=>{
  const sim=season(13,{...economy,maxActionsPerTick:10});sim.begin();
  sim.act('critic','p1','request_capability',{kind:'package',need:'parse data',purpose:'read csv',source:'npm:csv-parse'});
  const own=sim.act('critic','p2','decide_capability',{id:'cap1',approved:true,reason:'mine'});
  assert.equal(own.ok,false);
  assert.match(own.result,/own request/);
  const wrong=sim.act('banker','p3','decide_capability',{id:'cap1',approved:true,reason:'not mine'});
  assert.equal(wrong.ok,false);
  assert.match(wrong.result,/Only the Mayor/);
  sim.act('mayor','p4','request_capability',{kind:'repo',need:'read code',purpose:'review',source:'https://github.com/owner/repo'});
  const mine=sim.act('mayor','p5','decide_capability',{id:'cap2',approved:true,reason:'mine'});
  assert.equal(mine.ok,false);
  assert.match(mine.result,/own request/);
  const banker=sim.act('banker','p6','decide_capability',{id:'cap2',approved:true,reason:'the Mayor asked'});
  assert.equal(banker.ok,true,banker.result);
  assert.equal(sim.state.capabilities.find(c=>c.id==='cap2')?.status,'approved');
  const again=sim.act('mayor','p7','decide_capability',{id:'cap2',approved:false,reason:'changed mind'});
  assert.equal(again.ok,false);
  assert.match(again.result,/approved, not pending/);
  assert.deepEqual(checkInvariants(sim.events),[]);
  const selfDecided=checkInvariants([...sim.events,{type:'capability.decided',id:'cap1',by:'critic',approved:true,reason:'x'}]);
  assert.ok(selfDecided.some(m=>/critic decided its own request/.test(m)),selfDecided.join('\n'));
});

test('approvals stop at maxCapabilities, and one open request per cat is enforced',()=>{
  const cfg={...economy,maxActionsPerTick:100,maxCapabilities:2};
  const sim=season(14,cfg);sim.begin();
  const pkg=(source:string)=>({kind:'package',need:'a tool',purpose:'to test',source});
  sim.act('merchant','c1','request_capability',pkg('npm:one'));
  const dup=sim.act('merchant','c2',"request_capability",pkg('npm:two'));
  assert.equal(dup.ok,false);
  assert.match(dup.result,/pending capability request/);
  assert.equal(sim.act('mayor','c3','decide_capability',{id:'cap1',approved:true,reason:'ok'}).ok,true);
  sim.act('critic','c4','request_capability',pkg('npm:three'));
  assert.equal(sim.act('mayor','c5','decide_capability',{id:'cap2',approved:true,reason:'ok'}).ok,true);
  sim.act('merchant','c6','request_capability',pkg('npm:four'));
  const over=sim.act('mayor','c7','decide_capability',{id:'cap3',approved:true,reason:'too many'});
  assert.equal(over.ok,false);
  assert.match(over.result,/already approved/);
  assert.equal(sim.act('mayor','c8','decide_capability',{id:'cap3',approved:false,reason:'no room'}).ok,true);
  assert.deepEqual(checkInvariants(sim.events),[]);
  const injected=checkInvariants(sim.events.map(e=>e.type==='season.started'?{...e,maxCapabilities:1}:e));
  assert.ok(injected.some(m=>/approvals exceed maxCapabilities 1/.test(m)),injected.join('\n'));
});

test('a needs-owner request does not block a package; owner asks are capped at two and not duplicated',()=>{
  const sim=season(15,{...economy,maxActionsPerTick:20});sim.begin();
  const acct=(need:string)=>({kind:'account',need,purpose:'to sell'});
  assert.equal(sim.act('merchant','w1','request_capability',acct('A Real Web Shop')).ok,true);
  const dup=sim.act('critic','w2','request_capability',acct('a real web shop'));
  assert.equal(dup.ok,false);
  assert.match(dup.result,/already has this request/);
  const again=sim.act('merchant','w3','request_capability',acct('a real web shop'));
  assert.equal(again.ok,false);
  const pkg=sim.act('merchant','w4','request_capability',{kind:'package',need:'parse data',purpose:'read csv',source:'npm:csv-parse'});
  assert.equal(pkg.ok,true,pkg.result);
  assert.equal(sim.act('mayor','w5','decide_capability',{id:'cap2',approved:true,reason:'ok'}).ok,true);
  assert.equal(sim.act('merchant','w6','request_capability',acct('a bank card of ours')).ok,true);
  const third=sim.act('merchant','w7','request_capability',{kind:'api',need:'post orders',purpose:'sync'});
  assert.equal(third.ok,false);
  assert.match(third.result,/already have 2 requests waiting/);
  assert.equal(sim.act('critic','w8','request_capability',{kind:'api',need:'post orders',purpose:'sync'}).ok,true);
  assert.deepEqual(checkInvariants(sim.events),[]);
  const forged=checkInvariants([...sim.events,{type:'capability.requested',id:'cap99',cat:'merchant',need:'x',purpose:'y',kind:'network',source:null,tier:'owner'},{type:'capability.escalated',id:'cap99'}]);
  assert.ok(forged.some(m=>/already have 2 requests/.test(m)),forged.join('\n'));
});

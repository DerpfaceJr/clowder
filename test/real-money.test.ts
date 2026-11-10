import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {withFullRoster,allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {quests} from '../src/quests.ts';
import {recordBalance} from '../src/treasury.ts';
import {installAccess,isHost,isOwner} from '../src/access.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {installRemoteAccess} from '../src/remote-access.ts';
import {APPROVAL_HOURS,RealMoney,checkPolicy,loadPolicy,merchantMatches,registerRealMoneyRoutes,registerStripeWebhook,type Policy} from '../src/real-money.ts';
import {STRIPE_VERSION,verifyStripeSignature} from '../src/stripe-issuing.ts';

// Tests never reach Stripe or a bank, not even test mode: any real network call fails the test.
globalThis.fetch=(async()=>{throw new Error('A test tried to call the network.');}) as any;

const raw=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const config=withFullRoster(raw);
const remoteConfig:RemoteConfig=raw.remote;
const KEY=`rk_test_${'a'.repeat(20)}SECRETKEY42`,WHSEC=`whsec_${'b'.repeat(20)}SIGNING42`;
const ON:Policy={enabled:true,mode:'prepay',currency:'USD',perPurchaseLimitMinor:5000,monthlyLimitMinor:12000,allowedCategories:[],toleranceMinor:0};
const ask=(over:any={})=>({vendor:'Namecheap',url:'https://www.namecheap.com/domains/',amount:12,currency:'USD',reason:'A domain for the shop page.',category:'computer_network_services',recurring:false,...over});
const HOUR=3_600_000;

type Call={method:string;path:string;form:URLSearchParams};
function setup(policy:Partial<Policy>|null=ON,stripeError?:string){
  const dir=mkdtempSync(join(tmpdir(),'real-money-'));
  const store=new Store(join(dir,'worlds','w1','events.jsonl'),allRoles(config));
  const clock={now:new Date('2026-10-20T12:00:00.000Z')};
  const calls:Call[]=[];
  // A fake Stripe: records each call and answers like the Issuing card endpoints, or with an error when asked to.
  const fakeFetch=async(url:any,init:any)=>{
    const u=new URL(String(url)),path=u.pathname.replace('/v1/','');
    calls.push({method:init.method,path,form:new URLSearchParams(init.body??'')});
    assert.equal(u.origin,'https://api.stripe.com');assert.equal(init.headers.Authorization,`Bearer ${KEY}`);assert.equal(init.headers['Stripe-Version'],STRIPE_VERSION);
    if(stripeError)return new Response(JSON.stringify({error:{message:stripeError}}),{status:400});
    const id=path.startsWith('issuing/cards/')?path.split('/')[2]:'ic_town123';
    return new Response(JSON.stringify({id,object:'issuing.card',type:'virtual',currency:'usd',status:new URLSearchParams(init.body??'').get('status')??'inactive',cardholder:{id:'ich_owner1'},last4:'L4ST'}),{status:200});
  };
  if(policy)writeFileSync(join(dir,'real-money.json'),JSON.stringify(checkPolicy({...ON,...policy})));
  const money=new RealMoney({dataDir:dir,journal:()=>store,fetch:fakeFetch as any,now:()=>clock.now});
  const questList=()=>quests({state:store.state,projects:[],capabilities:[],seasons:[],models:null,config:{recentHours:24},now:clock.now,purchases:money.purchases()});
  return {dir,store,clock,calls,money,questList};
}
const auth=(over:any={})=>({id:`iauth_${Math.random().toString(36).slice(2)}`,object:'issuing.authorization',amount:0,approved:false,card:{id:'ic_town123'},
  merchant_data:{name:'NAMECHEAP.COM',category:'computer_network_services'},pending_request:{amount:1200,currency:'usd'},...over});
async function autopay(over:Partial<Policy>={}){
  const s=setup({...ON,...over});
  await s.money.connectStripe({key:KEY,webhookSecret:WHSEC,cardholder:'ich_owner1'});
  await s.money.savePolicy({...ON,...over,mode:'autopay'});
  return s;
}

test('policy: off and Pre-pay by default; a damaged file is off; turning on needs real limits',()=>{
  const {dir}=setup(null);
  assert.deepEqual(loadPolicy(dir),{...ON,enabled:false,perPurchaseLimitMinor:0,monthlyLimitMinor:0});
  writeFileSync(join(dir,'real-money.json'),'{broken');
  assert.equal(loadPolicy(dir).enabled,false);
  writeFileSync(join(dir,'real-money.json'),JSON.stringify({...ON,mode:'turbo'}));
  assert.equal(loadPolicy(dir).enabled,false,'an invalid field means the whole file is ignored');
  assert.throws(()=>checkPolicy({...ON,perPurchaseLimitMinor:0}),/above zero/);
  assert.throws(()=>checkPolicy({...ON,monthlyLimitMinor:4000}),/monthly limit at least/);
  assert.throws(()=>checkPolicy({...ON,allowedCategories:['Bad Category']}),/Stripe merchant category/);
});

test('limits: per purchase, what remains of the month, and split requests to one vendor are refused with a reason',()=>{
  const {money,clock}=setup();
  assert.throws(()=>setup({...ON,enabled:false}).money.request(ask()),/off/);
  assert.throws(()=>money.request(ask({amount:50.01})),/over the per-purchase limit of 50\.00 USD/);
  money.request(ask({vendor:'Alpha',url:'https://alpha.example/',amount:45}));
  const beta=money.request(ask({vendor:'Beta',url:'https://beta.example/',amount:45})).purchase;
  assert.deepEqual(money.month(),{spentMinor:0,openMinor:9000,limitMinor:12000,remainingMinor:3000});
  assert.throws(()=>money.request(ask({vendor:'Gamma',url:'https://gamma.example/',amount:40})),/over what remains this month \(30\.00 USD of 120\.00 USD\)/);
  // Rejected requests stop counting.
  money.decide(beta.id,false,'Not needed.');
  assert.equal(money.month().remainingMinor,7500);
  // Splitting: another request to Alpha within 24 hours is summed. A respelled name on the same site is the same vendor.
  assert.throws(()=>money.request(ask({vendor:'Alpha',url:'https://alpha.example/',amount:10})),/Splitting a purchase does not get around the limit/);
  assert.throws(()=>money.request(ask({vendor:'ALPHA Inc.',url:'https://www.alpha.example/cart',amount:10})),/earlier request to ALPHA Inc\./);
  assert.throws(()=>money.request(ask({vendor:'alpha',url:'https://other.example/',amount:10})),/Splitting/,'same name on another site');
  // After 24 hours it is a separate purchase again.
  clock.now=new Date(clock.now.getTime()+25*HOUR);
  assert.equal(money.request(ask({vendor:'Alpha',url:'https://alpha.example/',amount:5})).purchase.status,'pending');
  // Refusals are kept in the ledger for the owner but never count.
  assert.ok(money.purchases().filter(p=>p.status==='refused').length>=4);
  assert.equal(money.month().openMinor,5000);
});

test('an approved purchase that was never paid expires and stops counting',()=>{
  const {money,clock}=setup();
  const p=money.request(ask({amount:50})).purchase;money.decide(p.id,true);
  assert.equal(money.month().remainingMinor,7000);
  clock.now=new Date(clock.now.getTime()+(APPROVAL_HOURS+1)*HOUR);
  assert.equal(money.purchases()[0].expired,true);
  assert.equal(money.month().remainingMinor,12000);
});

test('currency must match the policy; amounts, links and categories are checked',()=>{
  const {money}=setup({...ON,allowedCategories:['computer_network_services']});
  assert.throws(()=>money.request(ask({currency:'EUR'})),/spends in USD, not EUR/);
  assert.throws(()=>money.request(ask({amount:12.345})),/at most two decimals/);
  assert.throws(()=>money.request(ask({amount:-3})),/positive/);
  assert.throws(()=>money.request(ask({url:'http://namecheap.com/'})),/https/);
  assert.throws(()=>money.request(ask({url:'https://user:pw@namecheap.com/'})),/plain https/);
  assert.throws(()=>money.request(ask({category:'gambling'})),/not an allowed category/);
  assert.equal(money.request(ask({amount:'12.50'})).purchase.amountMinor,1250);
});

test('Pre-pay: request becomes an S quest, approval tells the Mayor, Paid is capped and lowers the balance',()=>{
  const {money,store,questList}=setup();
  recordBalance(store,'100.00','USD');
  const {purchase,message}=money.request(ask(),{task:'t1',journal:store});
  assert.equal(purchase.status,'pending');assert.match(message,/Nothing is paid until the owner decides/);
  const q=questList().find(x=>x.source.kind==='purchase')!;
  assert.equal(q.rank,'S');assert.equal(q.title,'Approve purchase: Namecheap 12.00 USD');
  assert.match(q.detail,/A domain for the shop page\. · https:\/\/www\.namecheap\.com\/domains\//);assert.equal(q.action.panel,'moonvault');
  assert.throws(()=>money.markPaid(purchase.id,'12.00'),/Only an approved purchase/);
  money.decide(purchase.id,true,'Go ahead.');
  assert.throws(()=>money.decide(purchase.id,false),/already been decided/);
  const owed=questList().filter(x=>x.source.kind==='purchase');assert.equal(owed.length,1);assert.equal(owed[0].action.label,'Mark paid');assert.equal(owed[0].needsYou,true);
  assert.match(store.state.messages.at(-1).text,/Purchase approved: Namecheap 12\.00 USD\. I will pay it myself; nothing has been paid yet/);
  assert.equal(money.purchases()[0].status,'approved');
  assert.throws(()=>money.markPaid(purchase.id,'12.01'),/Record at most 12\.00 USD/);
  money.markPaid(purchase.id,'11.50');
  assert.equal(money.purchases()[0].status,'paid');assert.equal(money.purchases()[0].paidMinor,1150);
  assert.equal(store.state.treasury!.amountMinor,8850,'the Moonvault balance drops by the paid amount');
  assert.deepEqual(store.state.events.filter(e=>e.type.startsWith('purchase.')).map(e=>e.type),['purchase.requested','purchase.decided','purchase.paid']);
  assert.equal(money.month().spentMinor,1150);
  // Rejecting tells the Mayor why.
  const second=money.request(ask({vendor:'Hover',url:'https://hover.com/',amount:20})).purchase;
  money.decide(second.id,false,'Use the free subdomain.');
  assert.equal(store.state.messages.at(-1).text,'Purchase rejected: Hover 20.00 USD. Reason: Use the free subdomain.');
  assert.equal(store.state.messages.at(-1).to,'mayor');
  // The ledger is durable.
  const reopened=new RealMoney({dataDir:setupDir(money),now:()=>new Date('2026-10-20T13:00:00Z')});
  assert.deepEqual(reopened.purchases().map(p=>p.status),['paid','rejected']);
});
const setupDir=(m:RealMoney)=>(m as any).opts.dataDir as string;

test('Pre-pay tolerance lets Paid go slightly over the approved amount, never more',()=>{
  const {money}=setup({...ON,toleranceMinor:50});
  const p=money.request(ask()).purchase;money.decide(p.id,true);
  assert.throws(()=>money.markPaid(p.id,'12.51'),/plus 0\.50 USD tolerance/);
  assert.equal(money.markPaid(p.id,'12.50').paidMinor,1250);
});

test('Autopay: within limits is auto-approved without a quest; over the limits is an S quest; a card charge is an F notice',async()=>{
  const {money,calls,questList,store}=await autopay();
  const create=calls.find(c=>c.method==='POST'&&c.path==='issuing/cards')!;
  assert.equal(create.form.get('type'),'virtual');assert.equal(create.form.get('currency'),'usd');assert.equal(create.form.get('cardholder'),'ich_owner1');assert.equal(create.form.get('status'),'inactive');
  assert.equal(create.form.get('spending_controls[spending_limits][0][amount]'),'5000');assert.equal(create.form.get('spending_controls[spending_limits][0][interval]'),'per_authorization');
  assert.equal(create.form.get('spending_controls[spending_limits][1][amount]'),'12000');assert.equal(create.form.get('spending_controls[spending_limits][1][interval]'),'monthly');
  assert.equal(calls.at(-1)!.path,'issuing/cards/ic_town123');assert.equal(calls.at(-1)!.form.get('status'),'active','choosing Autopay activates the card');
  const small=money.request(ask());
  assert.equal(small.purchase.status,'auto-approved');assert.match(small.message,/Nothing has been charged yet/);
  assert.equal(questList().filter(q=>q.source.kind==='purchase').length,0);
  const big=money.request(ask({vendor:'Figma',url:'https://figma.com/pricing',amount:60,category:'computer_software_stores'})).purchase;
  assert.equal(big.status,'pending');assert.match(big.note,/Over the Autopay limits/);
  assert.deepEqual(questList().filter(q=>q.source.kind==='purchase').map(q=>[q.rank,q.title]),[['S','Approve purchase: Figma 60.00 USD']]);
  assert.equal(money.authorize(auth()).approved,true);
  assert.deepEqual(questList().filter(q=>q.rank==='F').map(q=>q.title),['Paid Namecheap 12.00 USD']);
  assert.ok(store.state.events.some(e=>e.type==='purchase.authorization'&&e.data.approved===true));
  // Leaving Autopay makes the card inactive.
  await money.savePolicy(ON);
  assert.equal(calls.at(-1)!.form.get('status'),'inactive');
});

test('Autopay falls back to Pre-pay and shows Stripe’s error when Issuing is not available',async()=>{
  const failing=setup(ON,'Your account is not set up to use Issuing.');
  await assert.rejects(failing.money.connectStripe({key:KEY,webhookSecret:WHSEC,cardholder:'ich_owner1'}),/Stripe: Your account is not set up to use Issuing\./);
  assert.equal(failing.money.publicView(true).stripe.connected,false,'nothing saved when Stripe refuses');
  await assert.rejects(failing.money.savePolicy({...ON,mode:'autopay'}),/Connect Stripe Issuing before choosing Autopay/);
  // Connected, then Stripe refuses the limits: stays on Pre-pay with Stripe's words.
  const s=setup();await s.money.connectStripe({key:KEY,webhookSecret:WHSEC,card:'ic_existing1'});
  (s.money as any).opts.fetch=async()=>new Response(JSON.stringify({error:{message:`Issuing is not supported in your country. Key ${KEY}`}}),{status:400});
  await assert.rejects(s.money.savePolicy({...ON,mode:'autopay'}),err=>{const m=(err as Error).message;return /not supported in your country/.test(m)&&/stays on Pre-pay/.test(m)&&!m.includes(KEY);});
  assert.equal(s.money.policy().mode,'prepay');
  // No card before there are limits to mirror, and Autopay keeps the card's currency.
  await assert.rejects(setup({...ON,enabled:false}).money.connectStripe({key:KEY,webhookSecret:WHSEC,cardholder:'ich_owner1'}),/Turn real money on/);
  const c=setup();await c.money.connectStripe({key:KEY,webhookSecret:WHSEC,cardholder:'ich_owner1'});
  await assert.rejects(c.money.savePolicy({...ON,currency:'EUR',mode:'autopay'}),/The linked card spends USD/);
});

test('authorizations are approved only for the linked card, a matching open purchase, within its amount; all decisions are logged',async()=>{
  const {money,clock}=await autopay();
  const p=money.request(ask()).purchase;
  const decline=(a:any,why:RegExp)=>{const d=money.authorize(a);assert.equal(d.approved,false,why.source);assert.match(d.reason,why);};
  decline(auth({card:{id:'ic_someone_else'}}),/linked card/);
  decline(auth({pending_request:{amount:1201,currency:'usd'}}),/No approved purchase matches/);
  decline(auth({pending_request:{amount:1200,currency:'eur'}}),/Charge in EUR, not USD/);
  decline(auth({merchant_data:{name:'CASINO ROYALE',category:'betting_casino_gambling'}}),/No approved purchase matches/);
  decline(auth({pending_request:null}),/No pending amount/);
  const ok=auth({pending_request:{amount:1100,currency:'usd'}});
  assert.equal(money.authorize(ok).approved,true);
  assert.equal(money.authorize(ok).approved,true,'the same authorization asked twice gets the same answer');
  decline(auth({id:'iauth_second'}),/No approved purchase matches/);
  assert.equal(money.purchases().find(x=>x.id===p.id)!.paidMinor,1100);
  // A category match counts when the merchant name differs (statement descriptors are often odd).
  money.request(ask({vendor:'JetBrains',url:'https://jetbrains.com/',amount:20,category:'computer_software_stores'}));
  assert.equal(money.authorize(auth({merchant_data:{name:'PADDLE.NET* SOFTWARE',category:'computer_software_stores'},pending_request:{amount:2000,currency:'usd'}})).approved,true);
  // Expired approvals do not match.
  money.request(ask({vendor:'Hover',url:'https://hover.com/',amount:5}));
  clock.now=new Date(clock.now.getTime()+(APPROVAL_HOURS+1)*HOUR);
  decline(auth({merchant_data:{name:'HOVER',category:'computer_network_services'},pending_request:{amount:500,currency:'usd'}}),/No approved purchase matches/);
  // Outside Autopay everything is declined.
  await money.savePolicy(ON);
  decline(auth(),/Autopay is off/);
  assert.equal(money.authorizations().length,11);
  assert.equal(money.authorizations().filter(a=>a.approved).length,3);
  assert.ok(merchantMatches({vendor:'Namecheap',host:'namecheap.com',category:'x'},'NAMECHEAP.COM*1234',''));
  assert.ok(!merchantMatches({vendor:'The Shop',host:'shop.com',category:'x'},'ANOTHER STORE',''));
});

const sign=(body:string,secret=WHSEC,t=Math.floor(Date.now()/1000))=>`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${body}`).digest('hex')},v0=${'0'.repeat(64)}`;
test('signature check follows Stripe’s scheme: v1 HMAC-SHA256 of t.body, constant-time, 300 s tolerance',()=>{
  const body='{"id":"evt_1"}',now=1_800_000_000;
  assert.equal(verifyStripeSignature(body,sign(body,WHSEC,now),WHSEC,now),true);
  assert.equal(verifyStripeSignature(Buffer.from(body),sign(body,WHSEC,now),WHSEC,now+300),true);
  assert.equal(verifyStripeSignature(body,sign(body,WHSEC,now),WHSEC,now+301),false,'stale');
  assert.equal(verifyStripeSignature(body,sign(body,'whsec_other',now),WHSEC,now),false,'wrong secret');
  assert.equal(verifyStripeSignature(body+' ',sign(body,WHSEC,now),WHSEC,now),false,'changed body');
  assert.equal(verifyStripeSignature(body,`t=${now},v0=${createHmac('sha256',WHSEC).update(`${now}.${body}`).digest('hex')}`,WHSEC,now),false,'v0 is ignored');
  assert.equal(verifyStripeSignature(body,sign(body,WHSEC,now),WHSEC,now,0),false,'a zero tolerance is refused');
  assert.equal(verifyStripeSignature(body,undefined,WHSEC,now),false);
});

const origin='https://town-test.trycloudflare.com';
async function remoteApp(money:RealMoney){
  const dir=mkdtempSync(join(tmpdir(),'real-money-remote-')),pairing=new Pairing(join(dir,'devices.json'),remoteConfig);
  const app=Fastify({bodyLimit:32000});installRemoteAccess(app,pairing,()=>origin);
  app.setErrorHandler((err:any,_req,res)=>res.code(err.statusCode||400).send({error:err.message}));
  // The same wiring as server.ts registerTown on the remote listener.
  // The same gates as server.ts: settings host-only, deciding open to owner devices.
  registerRealMoneyRoutes(app,money,{owner:isHost,decide:isOwner});
  registerStripeWebhook(app,money);await app.ready();
  const headers={host:new URL(origin).host,origin,'x-town-action':'owner'};
  const pair=async(permission:'viewer'|'owner')=>{const r=await app.inject({method:'POST',url:'/api/pair',headers,payload:{code:pairing.create(permission).code,name:permission}});return {...headers,cookie:String(r.headers['set-cookie']).split(';')[0]};};
  return {app,headers,control:await pair('owner'),view:await pair('viewer')};
}

test('webhook on the tunnel listener: no pairing needed, only signed Stripe posts are answered',async()=>{
  const {money}=await autopay();money.request(ask());
  const {app,headers}=await remoteApp(money);
  const event=(o:any)=>JSON.stringify({id:'evt_1',type:'issuing_authorization.request',data:{object:o}});
  const post=(body:string,signature?:string,extra:any={})=>app.inject({method:'POST',url:'/stripe/webhook',payload:body,headers:{host:headers.host,'content-type':'application/json; charset=utf-8',...(signature?{'stripe-signature':signature}:{}),...extra}});
  try{
    const good=event(auth());
    const r=await post(good,sign(good));
    assert.equal(r.statusCode,200);assert.equal(r.headers['stripe-version'],STRIPE_VERSION);assert.deepEqual(r.json(),{approved:true});
    const other=event(auth({id:'iauth_other',merchant_data:{name:'ELSEWHERE',category:'florists'}}));
    assert.deepEqual((await post(other,sign(other))).json(),{approved:false});
    assert.equal((await post(good,sign(good,'whsec_wrongsecret'))).statusCode,400,'bad signature');
    assert.equal((await post(good,sign(good,WHSEC,Math.floor(Date.now()/1000)-301))).statusCode,400,'stale timestamp');
    assert.equal((await post(good)).statusCode,400,'unsigned');
    const ping=JSON.stringify({id:'evt_2',type:'issuing_card.updated',data:{object:{}}});
    assert.deepEqual((await post(ping,sign(ping))).json(),{received:true});
    // The exemption is the webhook path only: other unpaired posts are still refused.
    assert.equal((await app.inject({method:'POST',url:'/api/purchases/x/decide',payload:{approved:true},headers:{host:headers.host}})).statusCode,403);
    assert.equal(money.authorizations().length,2,'unsigned or stale posts never reach a decision');
  }finally{await app.close();}
});

test('owner routes answer 403 to viewer devices and LAN viewers; an owner device may approve but not change money settings',async()=>{
  const {money}=setup();const p=money.request(ask()).purchase,q=money.request(ask({vendor:'Hover',url:'https://hover.com/',amount:5})).purchase;
  const {app,control,view}=await remoteApp(money);
  const policy={...ON,mode:'prepay'};
  try{
    for(const headers of [view]){
      assert.equal((await app.inject({method:'POST',url:'/api/real-money/policy',headers,payload:policy})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:'/api/real-money/stripe',headers,payload:{key:KEY,webhookSecret:WHSEC,cardholder:'ich_owner1'}})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:'/api/real-money/stripe/disconnect',headers})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:`/api/purchases/${p.id}/paid`,headers,payload:{amount:'12.00'}})).statusCode,403);
    }
    assert.equal((await app.inject({method:'POST',url:`/api/purchases/${p.id}/decide`,headers:view,payload:{approved:true}})).statusCode,403,'view-only device');
    const seen=(await app.inject({url:'/api/real-money',headers:view})).json();assert.equal(seen.owner,false);assert.equal(seen.decide,false);
    const decided=await app.inject({method:'POST',url:`/api/purchases/${p.id}/decide`,headers:control,payload:{approved:true,reason:'From my phone.'}});
    assert.equal(decided.statusCode,200);assert.equal(decided.json().purchase.status,'approved');
    assert.equal((await app.inject({method:'POST',url:'/api/real-money/policy',headers:control,payload:policy})).statusCode,403,'money settings stay on the host until a step-up exists');
    assert.equal((await app.inject({method:'POST',url:'/api/real-money/stripe/disconnect',headers:control})).statusCode,403,'so does Stripe');
  }finally{await app.close();}
  // Main app: LAN viewers cannot write; the loopback owner can.
  const main=Fastify();installAccess(main,true,['192.168.1.20'],8787,undefined,undefined,'test-owner');
  main.setErrorHandler((err:any,_req,res)=>res.code(err.statusCode||400).send({error:err.message}));
  registerRealMoneyRoutes(main,money,{owner:isHost,decide:isOwner});
  const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  try{
    assert.equal((await main.inject({method:'POST',url:'/api/real-money/policy',headers:{...owner,host:'192.168.1.20:8787'},remoteAddress:'192.168.1.21',payload:policy})).statusCode,403);
    assert.equal((await main.inject({method:'POST',url:'/api/real-money/policy',headers:{...owner,'x-forwarded-for':'1.2.3.4'},payload:policy})).statusCode,403,'proxied');
    assert.equal((await main.inject({method:'POST',url:'/api/real-money/policy',headers:owner,payload:{...policy,perPurchaseLimitMinor:6000}})).statusCode,200);
    assert.equal(money.policy().perPurchaseLimitMinor,6000);
    assert.equal((await main.inject({method:'POST',url:`/api/purchases/${q.id}/decide`,headers:owner,payload:{approved:true}})).statusCode,200);
    assert.equal((await main.inject({method:'POST',url:`/api/purchases/${q.id}/paid`,headers:owner,payload:{amount:'5.00'}})).statusCode,200);
  }finally{await main.close();}
});

test('no secret reaches the state, any client response, the journal, the ledger or the policy file',async()=>{
  const {money,store,dir,questList}=await autopay();
  money.request(ask());money.authorize(auth());
  const {app,control}=await remoteApp(money);
  const main=Fastify();installAccess(main,false,[],8787,undefined,undefined,'test-owner');registerRealMoneyRoutes(main,money,{owner:isOwner,decide:isOwner});
  const owner={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  try{
    const responses=[
      (await main.inject({url:'/api/real-money',headers:owner})).body,
      (await main.inject({method:'POST',url:'/api/real-money/policy',headers:owner,payload:{...ON,mode:'autopay'}})).body,
      (await app.inject({url:'/api/real-money',headers:control})).body,
    ];
    const connected=await money.connectStripe({key:KEY,webhookSecret:WHSEC,card:'ic_town123'});
    const blobs={state:JSON.stringify(store.snapshot({messages:Infinity,events:Infinity,approvals:Infinity})),journal:readFileSync(store.file,'utf8'),ledger:readFileSync(join(dir,'purchases.jsonl'),'utf8'),
      policy:readFileSync(join(dir,'real-money.json'),'utf8'),quests:JSON.stringify(questList()),connect:JSON.stringify(connected),responses:responses.join('\n')};
    for(const [name,text] of Object.entries(blobs)){
      for(const secret of [KEY,WHSEC,'SECRETKEY42','SIGNING42'])assert.ok(!text.includes(secret),`${name} leaks a secret`);
      assert.ok(!text.includes('L4ST'),`${name} carries card digits`);
    }
    assert.ok(JSON.parse(responses[0]).stripe.connected,'the views were taken while connected');
    // The grep can find a secret: the SecretStore (plain text under tests) holds it, so a leak above would have been caught.
    assert.ok(readFileSync(join(dir,'secrets.v2.json'),'utf8').includes(KEY));
    assert.ok(!readFileSync(join(dir,'real-money-secrets.json'),'utf8').includes(KEY));
  }finally{await app.close();await main.close();}
});

test('Autopay: a purchase within the limits from work a For you card started waits for the owner (plan 9.7); the owner\'s own is auto-approved',async()=>{
  const {money,store}=await autopay();
  const fake=async(messages:any[])=>messages.some(m=>m.role==='tool')||String(messages.at(-1)?.content??'').startsWith('Record for the town')?{message:{role:'assistant',content:'ok'}}
    :{message:{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'request_purchase',arguments:JSON.stringify(ask())}}]}};
  const town=new Town(store,config,{fake} as any);town.realMoney=money;
  try{
    const settled=async(id:string)=>{for(let i=0;i<500&&!['done','failed'].includes(store.state.tasks.find(t=>t.id===id)?.status??'');i++)await new Promise(r=>setTimeout(r,10));};
    await settled(town.inbox('The owner started a For you card. Buy what it says.','fake','suggestion'));
    assert.deepEqual(money.purchases().map(p=>[p.status,p.note]),[['pending','This work began from a For you card, so it waits for the owner.']]);
    await settled(town.inbox('Buy the domain.','fake'));
    assert.deepEqual(money.purchases().map(p=>p.status).sort(),['auto-approved','pending']);
  }finally{town.dispose();}
});

test('Autopay: a purchase within the limits from a team member\'s tree waits for the owner (plan 10.7)',async()=>{
  const {money,store}=await autopay();
  const fake=async(messages:any[])=>messages.some(m=>m.role==='tool')||String(messages.at(-1)?.content??'').startsWith('Record for the town')?{message:{role:'assistant',content:'ok'}}
    :{message:{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'request_purchase',arguments:JSON.stringify(ask())}}]}};
  const town=new Town(store,config,{fake} as any);town.realMoney=money;
  try{
    const id=town.submit('mayor','Buy the domain for the team.','fake',{by:'p-ana'});
    for(let i=0;i<500&&!['done','failed'].includes(store.state.tasks.find(t=>t.id===id)?.status??'');i++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(money.purchases().map(p=>[p.status,p.note]),[['pending','A team member’s work asked for this, so it waits for the owner.']]);
    assert.equal(store.state.events.find(e=>e.type==='purchase.requested')?.by,'p-ana','the request is journaled as hers');
  }finally{town.dispose();}
});

test('the Mayor is offered request_purchase only while the module is on, and the handler re-checks',async()=>{
  const {money,store,dir}=setup({...ON,enabled:false});
  const seen:{tools:string[];prompt:string}[]=[];
  let callPurchase=true;
  const fake=async(messages:any[],tools:any[])=>{
    seen.push({tools:tools.map(t=>t.function.name),prompt:messages[0].content});
    const done=messages.some(m=>m.role==='tool');
    if(callPurchase&&!done)return {message:{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'request_purchase',arguments:JSON.stringify(ask())}}]}};
    return {message:{role:'assistant',content:'ok'}};
  };
  const town=new Town(store,config,{fake} as any);town.realMoney=money;
  const run=async(text:string,mode='fake')=>{const id=town.submit('mayor',text,mode);for(let i=0;i<300&&!['done','failed','waiting'].includes(store.state.tasks.find(t=>t.id===id)?.status??'');i++)await new Promise(r=>setTimeout(r,10));return store.state.tasks.find(t=>t.id===id)!;};
  await run('Find me a domain');
  assert.ok(!seen[0].tools.includes('request_purchase'));assert.match(seen[0].prompt,/No web, shell, money, publishing or commerce adapters are connected/);
  assert.ok(store.state.events.some(e=>e.type==='tool.finished'&&e.data.result==='Tool error: Real-money purchases are off.'));
  assert.equal(money.purchases().length,0);
  writeFileSync(join(dir,'real-money.json'),JSON.stringify(ON));
  seen.length=0;await run('Find me a domain');
  const tool=seen[0].tools;assert.ok(tool.includes('request_purchase'));
  assert.match(seen[0].prompt,/call request_purchase only when a real-world purchase is truly needed/);assert.match(seen[0].prompt,/Never split a purchase/);
  assert.equal(money.purchases().length,1);assert.equal(money.purchases()[0].task!==null,true);
  // The demo Mayor shows the flow when asked to buy something.
  callPurchase=false;
  const demo=await run('Please buy a domain for the shop','demo');
  assert.equal(demo.status,'done');assert.match(demo.result!,/\[Demonstration\] Purchase request filed/);
  assert.equal(money.purchases().filter(p=>p.vendor==='Namecheap').length,2,'one from the fake model, one from the demo');
  assert.ok(existsSync(join(dir,'purchases.jsonl')));
});

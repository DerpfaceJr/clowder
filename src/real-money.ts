// Real money: the owner's optional spending policy, the purchase ledger and the checks every purchase passes.
// Off by default. Global, in the data dir, so switching worlds never resets a monthly limit.
//   real-money.json          the policy (no secrets)
//   real-money-secrets.json  Stripe key, webhook signing secret and the linked card id; mode 0600, never returned
//   purchases.jsonl          append-only ledger: requested, decided, paid, authorization
// No model output moves money: the Mayor can only file a request; code checks it against the limits; the owner (Pre-pay)
// or the linked card's webhook (Autopay, matched against an approved purchase) is the only way a payment happens.
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,writeFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {currencies,formatMinor,parseMinor} from './treasury.ts';
import {dropSecrets,withSecrets,withoutSecrets} from './secret-store.ts';
import {STRIPE_VERSION,spendingControls,stripeCall,verifyStripeSignature,type StripeFetch} from './stripe-issuing.ts';
import type {Store} from './store.ts';

export type Mode='prepay'|'autopay';
export type Currency=typeof currencies[number];
export type Policy={enabled:boolean;mode:Mode;currency:Currency;perPurchaseLimitMinor:number;monthlyLimitMinor:number;allowedCategories:string[];toleranceMinor:number};
export const DEFAULT_POLICY:Policy=Object.freeze({enabled:false,mode:'prepay',currency:'USD',perPurchaseLimitMinor:0,monthlyLimitMinor:0,allowedCategories:[],toleranceMinor:0}) as Policy;
export type Status='pending'|'approved'|'auto-approved'|'rejected'|'refused'|'paid';
export type Purchase={id:string;vendor:string;url:string;host:string;amountMinor:number;currency:string;reason:string;category:string;recurring:boolean;mode:Mode;status:Status;note:string;task:string|null;
  requestedAt:string;decidedAt?:string;decision?:string;expiresAt?:string;paidMinor?:number;paidAt?:string;paidBy?:'owner'|'card';authorization?:string;expired?:boolean};
export type Authorization={at:string;id:string;approved:boolean;reason:string;purchase:string|null;amountMinor:number|null;currency:string;merchant:string;category:string};
type Secrets={stripe?:{key:string;webhookSecret:string;cardId:string;cardholderId:string|null;currency:string}};

const POLICY_FILE='real-money.json',SECRETS_FILE='real-money-secrets.json',LEDGER_FILE='purchases.jsonl';
// An approved purchase that was never paid stops matching card charges and stops counting against the month.
export const APPROVAL_HOURS=72;
const HOUR=3_600_000,DAY=24*HOUR;
const CATEGORY=/^[a-z0-9_]{1,60}$/;
const OPEN=new Set<Status>(['pending','approved','auto-approved']);

const isLimit=(v:unknown):v is number=>Number.isInteger(v)&&(v as number)>=0&&(v as number)<=100_000_000;
/** Validates a whole policy. Throws a sentence the owner can act on. */
export function checkPolicy(raw:any):Policy{
  if(!raw||typeof raw!=='object')throw new Error('Send the whole spending policy.');
  const p={enabled:raw.enabled,mode:raw.mode,currency:raw.currency,perPurchaseLimitMinor:raw.perPurchaseLimitMinor,monthlyLimitMinor:raw.monthlyLimitMinor,allowedCategories:raw.allowedCategories??[],toleranceMinor:raw.toleranceMinor??0};
  if(typeof p.enabled!=='boolean')throw new Error('Choose on or off.');
  if(p.mode!=='prepay'&&p.mode!=='autopay')throw new Error('Choose Pre-pay or Autopay.');
  if(!currencies.includes(p.currency))throw new Error('Choose a supported currency.');
  if(!isLimit(p.perPurchaseLimitMinor)||!isLimit(p.monthlyLimitMinor)||!isLimit(p.toleranceMinor))throw new Error('Limits must be amounts from 0 to 1,000,000.');
  if(!Array.isArray(p.allowedCategories)||p.allowedCategories.length>40||p.allowedCategories.some((c:unknown)=>typeof c!=='string'||!CATEGORY.test(c)))throw new Error('Categories are Stripe merchant category names, such as computer_software_stores.');
  if(p.enabled&&(p.perPurchaseLimitMinor<=0||p.monthlyLimitMinor<p.perPurchaseLimitMinor))throw new Error('Set a per-purchase limit above zero and a monthly limit at least as large before turning real money on.');
  if(p.toleranceMinor>p.perPurchaseLimitMinor)throw new Error('The paid-amount tolerance cannot exceed the per-purchase limit.');
  return {...p,allowedCategories:[...new Set(p.allowedCategories as string[])]};
}
// Missing or damaged means the timid answer: off, Pre-pay.
export function loadPolicy(dir:string):Policy{
  try{return checkPolicy(JSON.parse(readFileSync(join(dir,POLICY_FILE),'utf8')));}catch{return {...DEFAULT_POLICY,allowedCategories:[]};}
}
function writeJson(file:string,value:unknown,mode?:number){
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,mode?{mode}:{});renameSync(temp,file);}catch(err){rmSync(temp,{force:true});throw err;}
}

const words=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const STOP=new Set(['www','com','net','org','inc','llc','ltd','the','shop','store','online','app','co']);
const hostOf=(url:string)=>new URL(url).hostname.toLowerCase().replace(/^www\./,'');
/** Same vendor for split detection: same host, or the same name once case and punctuation are ignored. */
const sameVendor=(p:Purchase,vendor:string,host:string)=>p.host===host||words(p.vendor)===words(vendor);
/** Does a card merchant plausibly belong to this purchase? Same merchant category, or a vendor or site-name word in the merchant name. */
export function merchantMatches(p:Pick<Purchase,'vendor'|'host'|'category'>,merchant:string,category:string):boolean{
  if(category&&p.category===category)return true;
  const name=words(merchant),compact=name.replace(/ /g,'');
  if(!compact)return false;
  const site=p.host.split('.').slice(-2,-1)[0]??'';
  const tokens=[...words(p.vendor).split(' '),site].filter(t=>t.length>=3&&!STOP.has(t));
  const vendor=words(p.vendor).replace(/ /g,'');
  return tokens.some(t=>name.split(' ').includes(t)||compact.includes(t))||(vendor.length>=4&&(compact.includes(vendor)||vendor.includes(compact)&&compact.length>=4));
}
const monthKey=(iso:string)=>iso.slice(0,7);

export type RealMoneyOptions={dataDir:string;journal?:()=>Store|null;fetch?:StripeFetch;now?:()=>Date};
export class RealMoney{
  private ledger:Purchase[]=[];
  private auths:Authorization[]=[];
  constructor(private opts:RealMoneyOptions){
    mkdirSync(opts.dataDir,{recursive:true});
    const file=join(opts.dataDir,LEDGER_FILE);
    // Fail closed on a damaged ledger: a lost line could hide spend from the monthly limit.
    if(existsSync(file))for(const line of readFileSync(file,'utf8').split('\n').filter(Boolean))this.apply(JSON.parse(line));
  }
  private now(){return this.opts.now?.()??new Date();}
  private get fetch(){return this.opts.fetch??fetch;}
  policy(){return loadPolicy(this.opts.dataDir);}
  private secrets():Secrets{
    try{
      const file=join(this.opts.dataDir,SECRETS_FILE),s=withSecrets(file,JSON.parse(readFileSync(file,'utf8')))?.stripe;
      return s&&typeof s.key==='string'&&typeof s.webhookSecret==='string'&&typeof s.cardId==='string'?{stripe:{key:s.key,webhookSecret:s.webhookSecret,cardId:s.cardId,cardholderId:typeof s.cardholderId==='string'?s.cardholderId:null,currency:typeof s.currency==='string'?s.currency:''}}:{};
    }catch{return {};}
  }
  webhookSecret(){return this.secrets().stripe?.webhookSecret??'';}
  /** The Stripe key and webhook secret, for Town's tool-result redaction. */
  secretValues(){const s=this.secrets().stripe;return [s?.key,s?.webhookSecret];}
  private savePolicyFile(p:Policy){writeJson(join(this.opts.dataDir,POLICY_FILE),p);}

  // ---- Ledger ----
  private apply(e:{at:string;type:string;data:any}){
    const d=e.data,p=this.ledger.find(x=>x.id===d.id);
    if(e.type==='requested')this.ledger.push({...d,requestedAt:e.at});
    if(e.type==='decided'&&p)Object.assign(p,{status:d.status,decision:d.decision,decidedAt:e.at,expiresAt:d.expiresAt});
    if(e.type==='paid'&&p)Object.assign(p,{status:'paid',paidMinor:d.paidMinor,paidAt:e.at,paidBy:d.paidBy,authorization:d.authorization});
    if(e.type==='authorization')this.auths.push({...d,at:e.at});
  }
  private append(type:string,data:any){
    const event={at:this.now().toISOString(),type,data};
    const fd=openSync(join(this.opts.dataDir,LEDGER_FILE),'a');
    try{writeSync(fd,JSON.stringify(event)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    this.apply(event);
  }
  /** The record also goes to the active world's journal. A journal failure never undoes a ledger entry. */
  private journal(type:string,data:any,store=this.opts.journal?.()){try{store?.emit(type,data);}catch{/* the ledger is the record */}}
  private view(p:Purchase):Purchase{return {...p,expired:(p.status==='approved'||p.status==='auto-approved')&&!!p.expiresAt&&Date.parse(p.expiresAt)<=this.now().getTime()};}
  purchases():Purchase[]{return this.ledger.map(p=>this.view(p));}
  authorizations(){return [...this.auths];}
  private counts(p:Purchase){return p.status==='paid'||(OPEN.has(p.status)&&!this.view(p).expired);}
  private committed(p:Purchase){return p.status==='paid'?p.paidMinor!:p.amountMinor;}
  /** This UTC month (Stripe's monthly limit resets at 00:00 UTC): paid amounts, plus requests and approvals still open. */
  month(){
    const key=monthKey(this.now().toISOString());let spent=0,open=0;
    for(const p of this.ledger.filter(p=>this.counts(p))){
      if(p.status==='paid'){if(monthKey(p.paidAt!)===key)spent+=p.paidMinor!;}
      else if(monthKey(p.requestedAt)===key)open+=p.amountMinor;
    }
    const limit=this.policy().monthlyLimitMinor;
    return {spentMinor:spent,openMinor:open,limitMinor:limit,remainingMinor:Math.max(0,limit-spent-open)};
  }
  private find(id:string){const p=this.ledger.find(x=>x.id===id);if(!p)throw new Error('Unknown purchase.');return this.view(p);}

  // ---- The Mayor's request ----
  /** Checks a request against the policy. Refusals throw a reason the Mayor can read. Pre-pay: within limits waits for the owner.
   *  Autopay: within limits is approved for the card; anything over the limits waits for the owner. */
  request(args:any,from:{task?:string;journal?:Store}={}):{purchase:Purchase;message:string}{
    const policy=this.policy();
    if(!policy.enabled)throw new Error('Real-money purchases are off. Only the owner can turn them on, on the host computer.');
    const text=(k:string,max:number)=>{const v=args?.[k];if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`Give ${k} (at most ${max} characters).`);return v.trim();};
    const vendor=text('vendor',80),reason=text('reason',500),category=text('category',60).toLowerCase(),rawUrl=text('url',500);
    let url:URL;try{url=new URL(rawUrl);}catch{throw new Error('Give the vendor link as a full https:// address.');}
    if(url.protocol!=='https:'||url.username||url.password)throw new Error('The vendor link must be a plain https:// address.');
    if(typeof args.recurring!=='boolean')throw new Error('Say whether the purchase renews (recurring true or false).');
    const amountMinor=parseMinor(args.amount);
    if(amountMinor===null||amountMinor<=0)throw new Error('Give the amount as a positive number with at most two decimals.');
    const currency=String(args.currency??'').toUpperCase();
    const base={id:randomUUID(),vendor,url:url.href,host:hostOf(url.href),amountMinor,currency,reason,category,recurring:args.recurring,mode:policy.mode,task:from.task??null};
    const refuse=(why:string):never=>{
      this.append('requested',{...base,status:'refused',note:why});
      this.journal('purchase.requested',{id:base.id,vendor,amountMinor,currency,status:'refused',note:why},from.journal);
      throw new Error(`Purchase refused: ${why}`);
    };
    if(currency!==policy.currency)refuse(`the town spends in ${policy.currency}, not ${currency||'an unnamed currency'}. Ask again in ${policy.currency}.`);
    if(!CATEGORY.test(category))refuse('the category must be a Stripe merchant category name, such as computer_software_stores.');
    if(policy.allowedCategories.length&&!policy.allowedCategories.includes(category))refuse(`${category} is not an allowed category. Allowed: ${policy.allowedCategories.join(', ')}.`);
    const money=(m:number)=>formatMinor(m,policy.currency),over:string[]=[];
    if(amountMinor>policy.perPurchaseLimitMinor)over.push(`${money(amountMinor)} is over the per-purchase limit of ${money(policy.perPurchaseLimitMinor)}`);
    const {remainingMinor}=this.month();
    if(amountMinor>remainingMinor)over.push(`${money(amountMinor)} is over what remains this month (${money(remainingMinor)} of ${money(policy.monthlyLimitMinor)})`);
    const since=this.now().getTime()-DAY;
    const earlier=this.ledger.filter(p=>this.counts(p)&&sameVendor(p,vendor,base.host)&&Date.parse(p.requestedAt)>=since);
    const together=earlier.reduce((sum,p)=>sum+this.committed(p),amountMinor);
    if(earlier.length&&together>policy.perPurchaseLimitMinor)over.push(`with ${earlier.length} earlier request${earlier.length>1?'s':''} to ${vendor} in the last 24 hours this comes to ${money(together)}, over the per-purchase limit of ${money(policy.perPurchaseLimitMinor)}. Splitting a purchase does not get around the limit`);
    if(over.length&&policy.mode==='prepay')refuse(`${over.join('; ')}.`);
    const auto=policy.mode==='autopay'&&!over.length;
    const status:Status=auto?'auto-approved':'pending';
    const note=over.length?`Over the Autopay limits: ${over.join('; ')}.`:'';
    this.append('requested',{...base,status,note});
    if(auto)this.append('decided',{id:base.id,status,decision:'Within the owner’s Autopay limits.',expiresAt:new Date(this.now().getTime()+APPROVAL_HOURS*HOUR).toISOString()});
    this.journal('purchase.requested',{id:base.id,vendor,amountMinor,currency,status,note},from.journal);
    const purchase=this.find(base.id);
    return {purchase,message:auto
      ?`Auto-approved within the owner’s limits: ${vendor} ${money(amountMinor)}. The owner’s card will accept one charge up to that amount from this vendor within ${APPROVAL_HOURS} hours. Nothing has been charged yet, and you never see or use the card.`
      :`Purchase request filed for the owner: ${vendor} ${money(amountMinor)}.${note?` ${note}`:''} Nothing is paid until the owner decides. Do not file it again; you will hear back.`};
  }

  // ---- The owner's decisions ----
  decide(id:string,approved:boolean,reason='',journal?:Store){
    const p=this.find(id);
    if(p.status!=='pending')throw new Error('This purchase has already been decided.');
    if(typeof reason!=='string'||reason.length>500)throw new Error('Keep the reason under 500 characters.');
    const status:Status=approved?'approved':'rejected',money=formatMinor(p.amountMinor,p.currency);
    this.append('decided',{id,status,decision:reason.trim(),...(approved?{expiresAt:new Date(this.now().getTime()+APPROVAL_HOURS*HOUR).toISOString()}:{})});
    this.journal('purchase.decided',{id,vendor:p.vendor,amountMinor:p.amountMinor,currency:p.currency,status,reason:reason.trim()},journal);
    // The Mayor hears the answer on its road; its next task reads it.
    this.journal('message',{from:'owner',to:'mayor',text:approved
      ?`Purchase approved: ${p.vendor} ${money}. I will pay it myself; nothing has been paid yet.${reason.trim()?` ${reason.trim()}`:''}`
      :`Purchase rejected: ${p.vendor} ${money}. Reason: ${reason.trim()||'none given.'}`},journal);
    return this.find(id);
  }
  /** Pre-pay: the owner paid outside the app. The actual amount may not exceed the approved amount plus the tolerance. */
  markPaid(id:string,amount:unknown,journal?:Store){
    const p=this.find(id),policy=this.policy();
    if(p.status!=='approved')throw new Error('Only an approved purchase can be marked paid.');
    const paidMinor=parseMinor(amount);
    if(paidMinor===null||paidMinor<=0)throw new Error('Enter the amount you paid, with at most two decimals.');
    const cap=p.amountMinor+policy.toleranceMinor;
    if(paidMinor>cap)throw new Error(`You approved ${formatMinor(p.amountMinor,p.currency)}${policy.toleranceMinor?` (plus ${formatMinor(policy.toleranceMinor,p.currency)} tolerance)`:''}. Record at most ${formatMinor(cap,p.currency)}.`);
    this.paid(p,paidMinor,'owner',undefined,journal);
    return this.find(id);
  }
  private paid(p:Purchase,paidMinor:number,paidBy:'owner'|'card',authorization?:string,journal?:Store){
    this.append('paid',{id:p.id,paidMinor,paidBy,...(authorization?{authorization}:{})});
    // purchase.paid lowers the Moonvault balance when it is in the same currency (store.ts).
    this.journal('purchase.paid',{id:p.id,vendor:p.vendor,paidMinor,currency:p.currency,paidBy},journal);
  }

  // ---- Autopay: the card's real-time authorization ----
  /** Approves only a charge on the linked card, in the policy currency, that matches an open approved purchase
   *  (merchant name or category, amount at most the approved amount, not expired). Everything else is declined. Every decision is logged. */
  authorize(auth:any):{approved:boolean;reason:string}{
    const policy=this.policy(),card=this.secrets().stripe?.cardId;
    const request=auth?.pending_request,merchant=String(auth?.merchant_data?.name??'').slice(0,120),category=String(auth?.merchant_data?.category??'').slice(0,80);
    const amount=Number.isInteger(request?.amount)?request.amount as number:null,currency=String(request?.currency??'').toUpperCase().slice(0,3);
    const id=typeof auth?.id==='string'?auth.id.slice(0,80):'';
    let reason='',match:Purchase|undefined;
    const already=id?this.ledger.find(p=>p.authorization===id):undefined;
    if(!policy.enabled)reason='Real money is off.';
    else if(policy.mode!=='autopay')reason='Autopay is off.';
    else if(!card||auth?.card?.id!==card)reason='Not the town’s linked card.';
    else if(!id||amount===null||amount<=0)reason='No pending amount to approve.';
    else if(currency!==policy.currency)reason=`Charge in ${currency||'an unknown currency'}, not ${policy.currency}.`;
    else if(already)match=already;
    else{
      match=this.purchases().filter(p=>(p.status==='approved'||p.status==='auto-approved')&&!p.expired&&p.currency===currency&&amount<=p.amountMinor&&merchantMatches(p,merchant,category))
        .sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt))[0];
      if(!match)reason='No approved purchase matches this merchant and amount.';
    }
    const approved=!!match;
    this.append('authorization',{id,approved,reason:approved?`Matches ${match!.vendor}.`:reason,purchase:match?.id??null,amountMinor:amount,currency,merchant,category});
    if(match&&!already)this.paid(match,amount!,'card',id);
    this.journal('purchase.authorization',{id,approved,purchase:match?.id??null,amountMinor:amount,currency,merchant});
    return {approved,reason:approved?`Matches ${match!.vendor}.`:reason};
  }

  // ---- Owner settings (host only; the routes check) ----
  /** Saves the policy. Autopay needs a linked card; the card's Stripe limits are mirrored first. If Stripe refuses,
   *  the town falls back to Pre-pay and the Stripe error is shown as it came. Leaving Autopay or turning off makes the card inactive. */
  async savePolicy(raw:any):Promise<Policy>{
    const next=checkPolicy(raw),stripe=this.secrets().stripe;
    if(next.mode==='autopay'&&!next.enabled)throw new Error('Turn real money on before choosing Autopay.');
    if(next.mode==='autopay'&&!stripe)throw new Error('Connect Stripe Issuing before choosing Autopay.');
    // A card's currency is fixed, so Autopay keeps the currency the card was linked in.
    if(next.mode==='autopay'&&stripe&&stripe.currency!==next.currency)throw new Error(`The linked card spends ${stripe.currency||'another currency'}. Use ${stripe.currency||'that currency'}, or disconnect Stripe and link a ${next.currency} card.`);
    if(stripe&&next.mode==='autopay'){
      try{await this.updateCard(stripe,next,'active');}
      catch(err){this.savePolicyFile({...next,mode:'prepay'});throw new Error(`${(err as Error).message} Real money stays on Pre-pay.`);}
    }else if(stripe){
      // Best effort: the webhook already declines everything outside Autopay.
      try{await this.updateCard(stripe,next,'inactive');}catch{/* declined at the webhook anyway */}
    }
    this.savePolicyFile(next);
    return next;
  }
  private updateCard(stripe:NonNullable<Secrets['stripe']>,p:Policy,status:'active'|'inactive'){
    return stripeCall(this.fetch,stripe.key,'POST',`issuing/cards/${encodeURIComponent(stripe.cardId)}`,{status,spending_controls:spendingControls(p,true)});
  }
  /** Links Stripe Issuing: a restricted key, the webhook signing secret, and either an existing virtual card or a cardholder
   *  to create one for. The card starts inactive; choosing Autopay activates it. Nothing is saved if Stripe refuses. */
  async connectStripe(input:{key?:unknown;webhookSecret?:unknown;cardholder?:unknown;card?:unknown}){
    const key=String(input.key??'').trim(),webhookSecret=String(input.webhookSecret??'').trim();
    const cardholder=String(input.cardholder??'').trim(),cardIn=String(input.card??'').trim();
    if(!/^(rk|sk)_(test|live)_[A-Za-z0-9]{8,200}$/.test(key))throw new Error('Paste a Stripe restricted key (rk_live_… or rk_test_…).');
    if(!/^whsec_[A-Za-z0-9]{8,200}$/.test(webhookSecret))throw new Error('Paste the webhook signing secret (whsec_…).');
    if(!!cardholder===!!cardIn)throw new Error('Give either a cardholder id (ich_…) to create a card for, or an existing virtual card id (ic_…).');
    if(cardholder&&!/^ich_[A-Za-z0-9]{4,100}$/.test(cardholder))throw new Error('A cardholder id starts with ich_.');
    if(cardIn&&!/^ic_[A-Za-z0-9]{4,100}$/.test(cardIn))throw new Error('A card id starts with ic_.');
    const policy=this.policy(),currency=policy.currency.toLowerCase();
    // The card mirrors the limits, so they must exist first.
    if(!policy.enabled)throw new Error('Turn real money on and save your limits before connecting Stripe.');
    let card:any;
    try{
      if(cardIn){
        card=await stripeCall(this.fetch,key,'GET',`issuing/cards/${encodeURIComponent(cardIn)}`);
        if(card?.type!=='virtual')throw new Error('That card is not a virtual card.');
        if(card?.currency!==currency)throw new Error(`That card is in ${String(card?.currency).toUpperCase()}; the policy currency is ${policy.currency}.`);
        card=await stripeCall(this.fetch,key,'POST',`issuing/cards/${encodeURIComponent(cardIn)}`,{status:'inactive',spending_controls:spendingControls(policy,true)});
      }else card=await stripeCall(this.fetch,key,'POST','issuing/cards',{cardholder,currency,type:'virtual',status:'inactive',spending_controls:spendingControls(policy,false)});
      if(typeof card?.id!=='string'||!card.id.startsWith('ic_'))throw new Error('Stripe did not return a card.');
    }catch(err){
      if(policy.mode!=='prepay')this.savePolicyFile({...policy,mode:'prepay'});
      throw err;
    }
    // Only the id is kept. Never the number, CVC or expiry; the owner sees those in Stripe's dashboard.
    const file=join(this.opts.dataDir,SECRETS_FILE);
    writeJson(file,withoutSecrets(file,{stripe:{key,webhookSecret,cardId:card.id,cardholderId:cardholder||(typeof card.cardholder?.id==='string'?card.cardholder.id:null),currency:policy.currency}}),0o600);
    return this.publicView(true).stripe;
  }
  async disconnectStripe(){
    const stripe=this.secrets().stripe,policy=this.policy();
    if(stripe)try{await this.updateCard(stripe,policy,'inactive');}catch{/* the webhook has no secret after this, so every charge is declined */}
    rmSync(join(this.opts.dataDir,SECRETS_FILE),{force:true});dropSecrets(join(this.opts.dataDir,SECRETS_FILE));
    if(policy.mode!=='prepay')this.savePolicyFile({...policy,mode:'prepay'});
  }
  /** What any viewer may see. Secrets are reduced to booleans; the card to its id and a dashboard link. */
  publicView(owner:boolean,decide=owner){
    const stripe=this.secrets().stripe,policy=this.policy();
    return {owner,decide,policy,approvalHours:APPROVAL_HOURS,month:this.month(),
      stripe:{connected:!!stripe,testMode:!!stripe?.key.includes('_test_'),cardId:stripe?.cardId??null,dashboard:stripe?`https://dashboard.stripe.com/${stripe.key.includes('_test_')?'test/':''}issuing/cards/${stripe.cardId}`:null},
      purchases:this.purchases().reverse().slice(0,100),authorizations:this.auths.slice(-50).reverse()};
  }
}

// ---- The Mayor's tool and brief ----
export function purchaseTool(p:Policy){
  const str=(maxLength:number,description?:string)=>({type:'string',maxLength,...(description?{description}:{})});
  return {type:'function',function:{name:'request_purchase',
    description:`Mayor only. Ask to spend real money on a real-world purchase the owner's goal truly needs. Prefer free options. Never split one purchase into smaller ones: requests to the same vendor within 24 hours are added together against the limit. This tool pays nothing.`,
    parameters:{type:'object',additionalProperties:false,required:['vendor','url','amount','currency','reason','category','recurring'],properties:{
      vendor:str(80,'Who sells it.'),url:str(500,'https:// link to the exact product or plan.'),
      amount:{type:'number',exclusiveMinimum:0,description:`Total price in ${p.currency}, at most two decimals.`},
      currency:{type:'string',enum:[p.currency]},reason:str(500,'Why the goal needs it, and why no free option works.'),
      category:p.allowedCategories.length?{type:'string',enum:p.allowedCategories}:str(60,'Stripe merchant category, for example computer_software_stores.'),
      recurring:{type:'boolean',description:'True if it renews. Each renewal needs its own request.'}}}}};
}
export function purchaseBrief(p:Policy,remainingMinor:number){
  const money=(m:number)=>formatMinor(m,p.currency);
  return `Real-world purchases: call request_purchase only when a real-world purchase is truly needed for the owner's goal. Prefer free options and say why none works. Never split a purchase to dodge a limit. Limits: ${money(p.perPurchaseLimitMinor)} per purchase, ${money(remainingMinor)} left this month, in ${p.currency}. ${p.mode==='prepay'?'Pre-pay: the owner approves each purchase and pays it themselves.':'Autopay: purchases within the limits are approved for the owner’s card; larger ones wait for the owner.'} You never see or use card details.`;
}

// ---- Routes ----
/** owner: host-only settings (policy, Stripe, marking paid). decide: the owner, or a paired device with control permission. */
export function registerRealMoneyRoutes(app:FastifyInstance,money:RealMoney,access:{owner:(req:FastifyRequest)=>boolean;decide:(req:FastifyRequest)=>boolean;journal?:()=>Store}){
  const host='Real money is managed on the host computer.';
  const body=(properties:any,required:string[])=>({body:{type:'object',additionalProperties:false,properties,required}});
  app.get('/api/real-money',async req=>money.publicView(access.owner(req),access.decide(req)));
  app.post('/api/real-money/policy',{schema:body({enabled:{type:'boolean'},mode:{type:'string',enum:['prepay','autopay']},currency:{type:'string',enum:[...currencies]},
    perPurchaseLimitMinor:{type:'integer'},monthlyLimitMinor:{type:'integer'},toleranceMinor:{type:'integer'},allowedCategories:{type:'array',maxItems:40,items:{type:'string',maxLength:60}}},
    ['enabled','mode','currency','perPurchaseLimitMinor','monthlyLimitMinor'])},async(req,res)=>{
    if(!access.owner(req))return res.code(403).send({error:host});
    return {policy:await money.savePolicy(req.body)};
  });
  app.post('/api/real-money/stripe',{schema:body({key:{type:'string',maxLength:300},webhookSecret:{type:'string',maxLength:300},cardholder:{type:'string',maxLength:120},card:{type:'string',maxLength:120}},['key','webhookSecret'])},async(req,res)=>{
    if(!access.owner(req))return res.code(403).send({error:host});
    return {stripe:await money.connectStripe(req.body as any)};
  });
  app.post('/api/real-money/stripe/disconnect',async(req,res)=>{
    if(!access.owner(req))return res.code(403).send({error:host});
    await money.disconnectStripe();return {ok:true};
  });
  app.post('/api/purchases/:id/decide',{schema:body({approved:{type:'boolean'},reason:{type:'string',maxLength:500}},['approved'])},async(req,res)=>{
    if(!access.decide(req))return res.code(403).send({error:'Approve purchases on the host computer or a paired device with control.'});
    const b=req.body as {approved:boolean;reason?:string};
    return {purchase:money.decide((req.params as {id:string}).id,b.approved,b.reason??'',access.journal?.())};
  });
  app.post('/api/purchases/:id/paid',{schema:body({amount:{type:'string',maxLength:18}},['amount'])},async(req,res)=>{
    if(!access.owner(req))return res.code(403).send({error:'Mark purchases paid on the host computer.'});
    return {purchase:money.markPaid((req.params as {id:string}).id,(req.body as {amount:string}).amount,access.journal?.())};
  });
}

/** POST /stripe/webhook on the remote (tunnel) listener. No session: only a valid Stripe signature gets an answer.
 *  After verification every reply is 200 with Stripe-Version and {approved}, so an internal error declines instead of
 *  becoming a webhook_error that Stripe's timeout or Autopilot settings might approve. */
export function registerStripeWebhook(app:FastifyInstance,money:RealMoney,now=()=>Math.floor(Date.now()/1000)){
  void app.register(async scope=>{
    // Signatures cover the exact bytes Stripe sent, so this scope keeps the body raw.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,raw,done)=>done(null,raw));
    scope.post('/stripe/webhook',{bodyLimit:1_000_000},async(req,res)=>{
      const raw=req.body,secret=money.webhookSecret();
      if(!secret||!Buffer.isBuffer(raw)||!verifyStripeSignature(raw,req.headers['stripe-signature'],secret,now()))return res.code(400).send({error:'Invalid signature.'});
      let approved=false;
      try{
        const event=JSON.parse(raw.toString('utf8'));
        if(event?.type!=='issuing_authorization.request')return res.code(200).send({received:true});
        approved=money.authorize(event.data?.object).approved;
      }catch{approved=false;}
      return res.code(200).header('Stripe-Version',STRIPE_VERSION).type('application/json').send({approved});
    });
  });
}

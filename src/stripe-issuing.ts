// Stripe Issuing, used only by Autopay. No card number, CVC or bank detail ever passes through here: the app stores a
// card id and decides authorizations from the merchant name, category and amount Stripe sends.
// Docs followed (read 2026-10-26):
//   Webhook signatures, manual verification and replay tolerance: https://docs.stripe.com/webhooks#verify-manually
//   Real-time authorizations (issuing_authorization.request, reply 200 + Stripe-Version + {approved}, 2 s budget):
//     https://docs.stripe.com/issuing/controls/real-time-authorizations
//   Spending controls (spending_limits per_authorization/monthly in the card currency's minor unit, allowed_categories):
//     https://docs.stripe.com/issuing/controls/spending-controls
//   Create a card (cardholder, currency, type=virtual, status, spending_controls): https://docs.stripe.com/api/issuing/cards/create
//   Authorization object (pending_request.amount/currency, merchant_data.name/category, card.id):
//     https://docs.stripe.com/api/issuing/authorizations/object
//   Restricted keys (rk_live_/rk_test_, per-resource Read/Write): https://docs.stripe.com/keys/restricted-api-keys
import {createHmac,timingSafeEqual} from 'node:crypto';

// A GA version, as in the real-time authorization example. An invalid version in the reply is a webhook_error.
export const STRIPE_VERSION='2025-03-31.basil';
// Stripe's libraries default to 5 minutes. 0 would disable the freshness check, so it is never accepted.
export const SIGNATURE_TOLERANCE_SECONDS=300;

/** Stripe-Signature check: t=<unix>,v1=<hex>[,v1=…][,v0=…]. HMAC-SHA256 of `${t}.${raw body}` keyed by the whsec_ secret.
 *  Only v1 counts (v0 is a test scheme; ignoring it prevents downgrades). Constant-time compare, then the timestamp window. */
export function verifyStripeSignature(raw:Buffer|string,header:unknown,secret:string,nowSeconds=Math.floor(Date.now()/1000),tolerance=SIGNATURE_TOLERANCE_SECONDS):boolean{
  if(typeof header!=='string'||typeof secret!=='string'||!secret||!(tolerance>0))return false;
  let t:number|undefined;const v1:string[]=[];
  for(const part of header.split(',')){
    const i=part.indexOf('=');if(i<1)continue;
    const key=part.slice(0,i).trim(),value=part.slice(i+1).trim();
    if(key==='t'&&/^\d{1,12}$/.test(value))t=Number(value);
    else if(key==='v1'&&/^[0-9a-f]{64}$/i.test(value))v1.push(value.toLowerCase());
  }
  if(t===undefined||!v1.length)return false;
  const expected=Buffer.from(createHmac('sha256',secret).update(`${t}.`).update(raw).digest('hex'));
  const signed=v1.some(s=>{const b=Buffer.from(s);return b.length===expected.length&&timingSafeEqual(b,expected);});
  return signed&&Math.abs(nowSeconds-t)<=tolerance;
}

// Stripe errors are shown to the owner as they are, minus anything shaped like a key.
const scrub=(text:string,key:string)=>text.split(key).join('[key]').replace(/\b(sk|rk|whsec)_[A-Za-z0-9_*]+/g,'[key]');

// Stripe's form encoding: a[b][0][c]=v. An empty string clears a list on update.
function form(value:unknown,prefix:string,out:URLSearchParams){
  if(Array.isArray(value))value.forEach((v,i)=>form(v,`${prefix}[${i}]`,out));
  else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))form(v,prefix?`${prefix}[${k}]`:k,out);
  else if(value!==undefined)out.append(prefix,String(value));
  return out;
}

export type StripeFetch=typeof fetch;
export async function stripeCall(fetchImpl:StripeFetch,key:string,method:'GET'|'POST',path:string,params?:Record<string,unknown>):Promise<any>{
  const body=params?form(params,'',new URLSearchParams()).toString():undefined;
  let response:Response;
  try{
    response=await fetchImpl(`https://api.stripe.com/v1/${path}`,{method,body,signal:AbortSignal.timeout(15_000),
      headers:{Authorization:`Bearer ${key}`,'Stripe-Version':STRIPE_VERSION,...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})}});
  }catch(err){throw new Error(`Stripe could not be reached: ${scrub((err as Error).message,key)}`);}
  const data:any=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Stripe: ${scrub(String(data?.error?.message||`request failed (${response.status})`),key)}`);
  return data;
}

/** The card-side mirror of the owner's limits. Stripe runs these before the webhook, so the card can never exceed them. */
export function spendingControls(p:{perPurchaseLimitMinor:number;monthlyLimitMinor:number;allowedCategories:string[]},update:boolean){
  return {
    spending_limits:[{amount:p.perPurchaseLimitMinor,interval:'per_authorization'},{amount:p.monthlyLimitMinor,interval:'monthly'}],
    ...(p.allowedCategories.length?{allowed_categories:p.allowedCategories}:update?{allowed_categories:''}:{}),
  };
}

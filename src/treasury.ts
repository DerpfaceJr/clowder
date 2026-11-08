import type {FastifyInstance} from 'fastify';
import {isOwner} from './access.ts';
import type {Store} from './store.ts';

export const currencies=['CAD','USD','EUR','GBP'] as const;
/** "12.5" → 1250. Every supported currency has two decimals. Returns null for anything else (NaN, 1e4, 12,000, three decimals). */
export function parseMinor(amount:unknown,{negative=false}={}):number|null{
  // A model may send 12.5 as a number. More than two decimals stays visible as three and is refused.
  const value=typeof amount==='number'&&Number.isFinite(amount)?amount.toFixed(Math.abs(amount*100-Math.round(amount*100))<1e-6?2:3):amount;
  if(typeof value!=='string'||!(negative?/^-?\d{1,12}(?:\.\d{1,2})?$/:/^\d{1,12}(?:\.\d{1,2})?$/).test(value.trim()))return null;
  const text=value.trim(),[whole,fraction='']=text.replace('-','').split('.');
  return Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')))*(text.startsWith('-')?-1:1);
}
export const formatMinor=(minor:number,currency:string)=>`${(minor/100).toFixed(2)} ${currency}`;
export function recordBalance(store:Store,amount:string,currency:string,note:string=''){
  if(!currencies.includes(currency as any))throw new Error('Choose a supported currency.');
  const amountMinor=typeof amount==='string'?parseMinor(amount,{negative:true}):null;
  if(amountMinor===null)throw new Error('Enter a balance with at most two decimal places.');
  if(typeof note!=='string'||note.length>240)throw new Error('Keep the balance note short.');
  store.emit('treasury.recorded',{amountMinor,currency,note:note.trim(),source:'owner-recorded'});
  return store.state.treasury;
}
// Only the local host can reconcile funds. Cats and paired devices cannot edit them (treasury is main-app only).
export function registerTreasury(app:FastifyInstance,store:Store|(()=>Store)){
  const current=typeof store==='function'?store:()=>store;
  app.post('/api/treasury',{schema:{body:{type:'object',required:['amount','currency'],additionalProperties:false,properties:{amount:{type:'string',maxLength:18},currency:{type:'string',enum:[...currencies]},note:{type:'string',maxLength:240}}}}},async(req,res)=>{
    if(!isOwner(req))return res.code(403).send({error:'Record the balance on the host computer.'});
    const body=req.body as {amount:string;currency:string;note?:string};
    return {treasury:recordBalance(current(),body.amount,body.currency,body.note)};
  });
}

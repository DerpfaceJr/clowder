import {createCipheriv,createECDH,createPrivateKey,createPublicKey,hkdfSync,randomBytes,sign,verify} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {stripSecrets,withSecrets,withoutSecrets} from './secret-store.ts';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {quests,type Quest,type QuestInput} from './quests.ts';
import {verbsFor,type Verb} from './owner-verbs.ts';
import type {State} from './store.ts';

// Web Push (RFC 8291 aes128gcm body, RFC 8292 VAPID) written against node:crypto. The web-push package is MPL-2.0, not MIT, so it is not used.
// problems: a trouble item (a failed or stopped request, quests() band 'trouble'). On by default (11.10).
export type Prefs={approvals:boolean;mayor:boolean;seasons:boolean;routines:boolean;problems:boolean};
// device: the paired device id, or 'host'. Subscriptions saved before devices were recorded have none and are kept.
export type Subscription={endpoint:string;keys:{p256dh:string;auth:string};kinds:Prefs;createdAt:string;device?:string};
// approval and actions: answer buttons (plan 3.4), only on a notice whose decision quickActions allows.
// item and verbs: the owner verbs (11.25, owner-verbs.ts) on a notice with no answer buttons; the tap posts /api/quests/<item>/verb.
export type QuickAction={answer:string;approved:boolean};
export type PayloadAction={action:string;title:string;answer?:string;approved?:boolean;verb?:Verb};
export type Payload={title:string;body:string;url:string;tag:string;approval?:string;item?:string;actions?:PayloadAction[]};
export type Item={title:string;body:string;url?:string;tag:string;approval?:string;actions?:QuickAction[];item?:string;verbs?:{verb:Verb;label:string}[]};
export type Sender=(endpoint:string,headers:Record<string,string>,body:Buffer)=>Promise<number>;
export type PushSource={state:{events:{id:string;type:string;data:any}[];cats:{id:string;name?:string}[];tasks?:{id:string;routine?:string}[]};listeners:Set<()=>void>};

const PUSH_HOSTS=['fcm.googleapis.com','updates.push.services.mozilla.com','push.apple.com','notify.windows.com'];
// The VAPID subject is a contact URI that push services may read. It is deliberately not the owner's address.
export const VAPID_SUBJECT='mailto:clowder@example.invalid';
const MAX_SUBSCRIPTIONS=50;
const JWT_SECONDS=12*3600;
const DEFAULT_WINDOW_MS=30_000;

const b64u=(input:Buffer|string)=>Buffer.from(input).toString('base64url');
const pad32=(buf:Buffer)=>buf.length===32?buf:Buffer.concat([Buffer.alloc(32-buf.length),buf]);

/** Only https endpoints on the big browser push services. A subscription can never make the server POST to an arbitrary URL. */
export function pushEndpointAllowed(endpoint:string):boolean{
  if(typeof endpoint!=='string'||endpoint.length>2048)return false;
  let url:URL;try{url=new URL(endpoint);}catch{return false;}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return false;
  return PUSH_HOSTS.some(host=>url.hostname===host||url.hostname.endsWith('.'+host));
}

function decodeKey(value:unknown,bytes:number):Buffer|null{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))return null;
  const buf=Buffer.from(value,'base64url');
  return buf.length===bytes?buf:null;
}

/** RFC 8291: encrypts one message for a subscription. salt and asPrivateKey are injectable only so the RFC test vector can be checked. */
export function encryptPayload(keys:{p256dh:string;auth:string},plaintext:Buffer,options:{salt?:Buffer;asPrivateKey?:Buffer}={}):Buffer{
  const ua=decodeKey(keys.p256dh,65),auth=decodeKey(keys.auth,16);
  if(!ua||!auth)throw new Error('Subscription keys are invalid.');
  const salt=options.salt??randomBytes(16);
  const as=createECDH('prime256v1');
  if(options.asPrivateKey)as.setPrivateKey(options.asPrivateKey);else as.generateKeys();
  const asPublic=as.getPublicKey(undefined,'uncompressed');
  const ecdh=as.computeSecret(ua);
  const ikm=Buffer.from(hkdfSync('sha256',ecdh,auth,Buffer.concat([Buffer.from('WebPush: info\0'),ua,asPublic]),32));
  const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
  const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
  const cipher=createCipheriv('aes-128-gcm',cek,nonce);
  // One record, last-record delimiter 0x02, no extra padding.
  const sealed=Buffer.concat([cipher.update(Buffer.concat([plaintext,Buffer.from([2])])),cipher.final(),cipher.getAuthTag()]);
  const recordSize=Buffer.alloc(4);recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt,recordSize,Buffer.from([asPublic.length]),asPublic,sealed]);
}

function jwkFromKeys(vapid:{publicKey:string;privateKey:string}){
  const pub=decodeKey(vapid.publicKey,65)!;
  return {kty:'EC',crv:'P-256',x:b64u(pub.subarray(1,33)),y:b64u(pub.subarray(33,65)),d:vapid.privateKey};
}

/** RFC 8292: the Authorization header for one push service. The signature is raw r||s, as the spec requires. */
export function vapidAuthorization(endpoint:string,vapid:{publicKey:string;privateKey:string},nowSeconds:number,subject=VAPID_SUBJECT):string{
  const header=b64u(JSON.stringify({typ:'JWT',alg:'ES256'}));
  const claims=b64u(JSON.stringify({aud:new URL(endpoint).origin,exp:nowSeconds+JWT_SECONDS,sub:subject}));
  const input=`${header}.${claims}`;
  const key=createPrivateKey({key:jwkFromKeys(vapid),format:'jwk'});
  const signature=sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'});
  return `vapid t=${input}.${b64u(signature)}, k=${vapid.publicKey}`;
}

export const verifyVapidSignature=(token:string,publicKey:string):boolean=>{
  const [header,claims,signature]=token.split('.');
  if(!header||!claims||!signature)return false;
  const pub=decodeKey(publicKey,65)!;
  const key=createPublicKey({key:{kty:'EC',crv:'P-256',x:b64u(pub.subarray(1,33)),y:b64u(pub.subarray(33,65))},format:'jwk'});
  return verify('sha256',Buffer.from(`${header}.${claims}`),{key,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'));
};

const ENTITY_FREE:Record<string,string>={'<':'‹','>':'›'};
/** Plain-text clean-up for untrusted text (model-written questions and names): control, format and bidi characters become spaces, markup brackets are neutralised, and the result is cut by code point. */
export function clean(text:unknown,max:number):string{
  const flat=String(text??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,' ').replace(/[<>]/g,c=>ENTITY_FREE[c]).replace(/\s+/g,' ').trim();
  const chars=Array.from(flat);
  return chars.length>max?chars.slice(0,Math.max(0,max-1)).join('')+'…':flat;
}

const safePath=(url:unknown)=>typeof url==='string'&&url.length<=200&&/^\/(?!\/)[\w\-./?#=&%]*$/.test(url)?url:'/';

/** The only shape a push carries: title, body, a same-origin path and a tag, plus a decision's id and answer buttons. No secrets. */
export function buildPayload(item:Item,more=0):Payload{
  const suffix=more>0?` (+${more} more)`:'';
  // A coalesced notice stands in for items the owner has not read, so it never carries buttons. Push shows at most two.
  const actions=more===0&&item.approval&&item.actions?.length&&item.actions.length<=2?item.actions:null;
  const verbs=more===0&&!actions&&item.item&&item.verbs?.length&&item.verbs.length<=2?item.verbs:null;
  return {
    title:clean(item.title,80)||'Clowder',
    body:clean(`${item.body}${suffix}`,240),
    url:safePath(item.url),
    tag:clean(item.tag,80).replace(/[^A-Za-z0-9_.:-]/g,'_')||'clowder',
    ...(actions?{approval:item.approval,actions:actions.map((a,i)=>({action:String(i),title:clean(a.answer,40),answer:a.answer,approved:a.approved}))}:{}),
    ...(verbs?{item:item.item,actions:verbs.map((v,i)=>({action:String(i),title:clean(v.label,40),verb:v.verb}))}:{}),
  };
}

// app.js isRefusal, the same rule: what a typed or tapped answer counts as.
const refusal=(text:string)=>/^(reject|decline|deny|no\b)/i.test(text);
/** The one class rule for answering outside the card (plan 3.4 and 3.5; push, Telegram and later Discord all call it). Buttons only for a
 *  connector call that reads or writes privately (Allow once and Deny, never an Always allow; Allow on a card filed before item 1.4) and for a plain question with its own options.
 *  Public, money and delete calls, a call with no class (older journals, installs, browser runs) and every other gate open the card. */
export function quickActions(a:{gate?:string;effectClass?:string;options?:unknown}):QuickAction[]{
  const options=Array.isArray(a.options)?a.options.filter((o):o is string=>typeof o==='string'&&o.length>0&&o.length<=200):[];
  if(a.gate==='connector')return (a.effectClass==='read'||a.effectClass==='write')&&(options[0]==='Allow once'||options[0]==='Allow')&&options.includes('Deny')?[{answer:options[0],approved:true},{answer:'Deny',approved:false}]:[];
  return a.gate===undefined&&options.length>=2&&options.length<=4?options.map(o=>({answer:o,approved:!refusal(o)})):[];
}
/** The top-rank quests a channel announces: a decision (with its buttons) and an owner step. url opens that decision's card; text is the
 *  whole line for a channel with room for it (Telegram), body the push-sized one. */
export function noticeOf(event:{type:string;data:any},cats:{id:string;name?:string}[]):(Item&{text:string})|null{
  const d=event.data,cat=cats.find(c=>c.id===d?.cat)?.name??String(d?.cat??'A cat');
  if(event.type==='approval.requested'&&d?.status==='pending'){
    const actions=quickActions(d);
    return {title:'Clowder',body:`${cat} needs you: ${clean(d.question,120)}`,text:`${cat} needs you: ${clean(d.question,2000)}`,url:`/#approval=${encodeURIComponent(String(d.id))}`,tag:`approval-${d.id}`,...(actions.length?{approval:String(d.id),actions}:{})};
  }
  if(event.type==='owner.step')return {title:'Clowder',body:`${cat} needs you to: ${clean(d.title,120)}`,text:`${cat} needs you to: ${clean(d.title,300)}\n\n${String(d.steps??'').split('\n').map(line=>clean(line,300)).join('\n').slice(0,2000)}`.trim(),url:'/',tag:`step-${d.id}`};
  return null;
}

/** The push notice for one Needs-you or trouble item (11.10). Answer buttons only where quickActions allows them on the decision's own record;
 *  otherwise the owner verbs the item offers (11.25: Mark done, Remind me tomorrow, Retry), so a purchase has none. */
export function questNotice(q:Quest,approvals:({id:string}&Parameters<typeof quickActions>[0])[]=[]):Item{
  const url=`/#item=${encodeURIComponent(q.id)}`,tag=`item-${q.id}`;
  const verbs=verbsFor(q).map(({verb,label})=>({verb,label})),withVerbs=verbs.length?{item:q.id,verbs}:{};
  if(q.band==='trouble')return {title:'Clowder',body:`Your request '${q.title}' failed: ${q.detail.replace(/[.\s]+$/,'')}. Retry?`,url,tag,...withVerbs};
  const record=q.source.kind==='approval'?approvals.find(a=>a.id===q.source.id):undefined;
  const actions=record?quickActions(record):[];
  return {title:'Clowder',body:`Needs you: ${q.title}`,url,tag,...(actions.length?{approval:String(record!.id),actions}:withVerbs)};
}

/** At most one delivery per window and key. Items arriving inside the window are coalesced into the next delivery, which reports how many it stands in for. */
export class RateLimiter<T>{
  private slots=new Map<string,{last?:number;timer?:unknown;item?:T;queued:number}>();
  constructor(private windowMs:number,private deliver:(kind:string,item:T,more:number)=>void,private now:()=>number=Date.now,
    private later:(fn:()=>void,ms:number)=>unknown=(fn,ms)=>{const t=setTimeout(fn,ms);(t as any).unref?.();return t;},
    private stopTimer:(timer:any)=>void=t=>clearTimeout(t)){}
  submit(kind:string,item:T):'sent'|'queued'{
    const now=this.now();
    const slot=this.slots.get(kind)??{queued:0};this.slots.set(kind,slot);
    if(slot.timer===undefined&&(slot.last===undefined||now-slot.last>=this.windowMs)){slot.last=now;this.deliver(kind,item,0);return 'sent';}
    slot.item=item;slot.queued++;
    if(slot.timer===undefined)slot.timer=this.later(()=>this.flush(kind),Math.max(0,slot.last!+this.windowMs-now));
    return 'queued';
  }
  private flush(kind:string){
    const slot=this.slots.get(kind);if(!slot)return;
    slot.timer=undefined;const item=slot.item;const more=slot.queued-1;
    slot.item=undefined;slot.queued=0;
    if(item===undefined)return;
    slot.last=this.now();this.deliver(kind,item,more);
  }
  close(){for(const slot of this.slots.values())if(slot.timer!==undefined)this.stopTimer(slot.timer);this.slots.clear();}
}

type Vapid={publicKey:string;privateKey:string;createdAt:string};
function parseVapid(file:string):Vapid{
  const v=withSecrets(file,JSON.parse(readFileSync(file,'utf8')));
  if(!v||typeof v.publicKey!=='string'||typeof v.privateKey!=='string'||!decodeKey(v.publicKey,65)||!decodeKey(v.privateKey,32))throw new Error('Invalid VAPID key file.');
  return v;
}
// Created once. flag 'wx' means a second process can never replace the keys that existing subscriptions were made with.
function loadOrCreateVapid(file:string):Vapid{
  if(existsSync(file))return parseVapid(file);
  const ecdh=createECDH('prime256v1');ecdh.generateKeys();
  const created:Vapid={publicKey:b64u(ecdh.getPublicKey(undefined,'uncompressed')),privateKey:b64u(pad32(ecdh.getPrivateKey())),createdAt:new Date().toISOString()};
  // The private key goes to the SecretStore only once this process has won the 'wx' create.
  try{writeFileSync(file,JSON.stringify(stripSecrets(file,created)),{mode:0o600,flag:'wx'});withoutSecrets(file,created);return created;}
  catch(err:any){if(err.code==='EEXIST')return parseVapid(file);throw err;}
}

export const defaultSender:Sender=async(endpoint,headers,body)=>{
  const res=await fetch(endpoint,{method:'POST',headers,body:new Uint8Array(body),signal:AbortSignal.timeout(15_000)});
  await res.arrayBuffer().catch(()=>undefined);
  return res.status;
};

// questInput: the quests() input for this store. The default reads the store only; the host passes its full input (projects, purchases...).
export type PushOptions={dataDir:string;send?:Sender;now?:()=>number;windowMs?:number;
  later?:(fn:()=>void,ms:number)=>unknown;stopTimer?:(timer:any)=>void;subject?:string;questInput?:(state:State)=>QuestInput};

/** The quests() input from the store alone. The host passes its full input (projects, purchases, capabilities) through questInput. */
export const storeQuestInput=(state:State):QuestInput=>({state,projects:[],capabilities:[],seasons:[],models:null,now:new Date()});

/** Which Needs-you and trouble ids are new since the last look (11.10). Push, Telegram and Discord each keep one, so each announces each id once. */
export class ListAnnouncer{
  private listed?:Set<string>;
  constructor(private input:(state:State)=>QuestInput){}
  private items(state:State):Quest[]{
    // A state with no approvals array lists no decisions, rather than throwing.
    const s=Array.isArray(state.approvals)?state:{...state,approvals:[]};
    return quests(this.input(s)).filter(q=>q.band==='needs'||q.band==='trouble');
  }
  /** Records the current list as known, so a restart announces nothing that is already listed. */
  baseline(state:State){this.listed=new Set(this.items(state).map(q=>q.id));}
  fresh(state:State):Quest[]{
    const now=this.items(state),before=this.listed??new Set<string>();
    this.listed=new Set(now.map(q=>q.id));
    return now.filter(q=>!before.has(q.id));
  }
}

const normalizePrefs=(raw:any):Prefs=>({approvals:raw?.approvals!==false,mayor:raw?.mayor!==false,seasons:raw?.seasons!==false,routines:raw?.routines!==false,problems:raw?.problems!==false});

export class PushService{
  // The private key lives only in this object. Nothing on the class returns it.
  private readonly vapid:Vapid;
  private readonly announcer:ListAnnouncer;
  private subs:Subscription[]=[];
  private readonly subsFile:string;
  private readonly limiter:RateLimiter<Item>;
  private readonly send:Sender;
  private seasonBaseline?:Set<string>;
  private lastEventId?:string;
  constructor(private opts:PushOptions){
    mkdirSync(opts.dataDir,{recursive:true});
    this.vapid=loadOrCreateVapid(resolve(opts.dataDir,'vapid.json'));
    this.subsFile=resolve(opts.dataDir,'push-subscriptions.json');
    if(existsSync(this.subsFile)){
      const data=JSON.parse(readFileSync(this.subsFile,'utf8'));
      if(!Array.isArray(data))throw new Error('Invalid push subscription store.');
      this.subs=data;
    }
    this.send=opts.send??defaultSender;
    this.announcer=new ListAnnouncer(opts.questInput??storeQuestInput);
    this.limiter=new RateLimiter<Item>(opts.windowMs??DEFAULT_WINDOW_MS,(kind,item,more)=>{void this.fanOut(kind as keyof Prefs|'test',buildPayload(item,more));},
      opts.now??Date.now,opts.later,opts.stopTimer);
  }
  publicKey():string{return this.vapid.publicKey;}
  count():number{return this.subs.length;}
  private save(){
    const tmp=this.subsFile+'.tmp';
    writeFileSync(tmp,JSON.stringify(this.subs),{mode:0o600,flush:true});
    renameSync(tmp,this.subsFile);
  }
  subscribe(input:{endpoint:string;keys:{p256dh:string;auth:string};kinds?:Partial<Prefs>},device?:string):{kinds:Prefs}{
    if(!pushEndpointAllowed(input.endpoint))throw new Error('Use the notification address your browser provides.');
    const p256dh=decodeKey(input.keys?.p256dh,65);
    if(!p256dh||p256dh[0]!==4)throw new Error('Subscription key is invalid.');
    if(!decodeKey(input.keys?.auth,16))throw new Error('Subscription key is invalid.');
    const kinds=normalizePrefs(input.kinds);
    const sub:Subscription={endpoint:input.endpoint,keys:{p256dh:input.keys.p256dh,auth:input.keys.auth},kinds,createdAt:new Date().toISOString(),...(device?{device}:{})};
    this.subs=[...this.subs.filter(s=>s.endpoint!==sub.endpoint),sub].slice(-MAX_SUBSCRIPTIONS);
    this.save();
    return {kinds};
  }
  /** Whether this device (and, when given, this endpoint) is subscribed. Subscriptions saved before devices were recorded count for no device. */
  status(device:string|undefined,endpoint?:string){
    const mine=this.subs.filter(s=>device!==undefined&&s.device===device);
    return {subscribed:mine.length>0,...(endpoint?{endpoint:mine.some(s=>s.endpoint===endpoint)}:{}),kinds:mine.at(-1)?.kinds??null};
  }
  unsubscribe(endpoint:string):boolean{
    const before=this.subs.length;
    this.subs=this.subs.filter(s=>s.endpoint!==endpoint);
    if(this.subs.length!==before)this.save();
    return this.subs.length!==before;
  }
  /** A revoked device gets nothing more: every endpoint it subscribed is dropped. */
  forget(device:string){
    const before=this.subs.length;
    this.subs=this.subs.filter(s=>s.device!==device);
    if(this.subs.length!==before)this.save();
  }
  /** Rate-limited entry point. kind 'test' reaches every subscription; the others respect the per-kind checklist. */
  // Every notice the service is asked to send, before the rate limit: the ntfy ping channel (plan 5.4) follows the same selection through this.
  private readonly noticeListeners=new Set<(kind:keyof Prefs|'test')=>void>();
  onNotify(fn:(kind:keyof Prefs|'test')=>void){this.noticeListeners.add(fn);}
  notify(kind:keyof Prefs|'test',item:Item):'sent'|'queued'{for(const fn of this.noticeListeners)fn(kind);return this.limiter.submit(kind,item);}
  private async fanOut(kind:keyof Prefs|'test',payload:Payload){
    const body=Buffer.from(JSON.stringify(payload));
    const gone:string[]=[];
    for(const sub of this.subs.filter(s=>kind==='test'||s.kinds[kind]!==false)){
      try{
        const encrypted=encryptPayload(sub.keys,body);
        const status=await this.send(sub.endpoint,{
          Authorization:vapidAuthorization(sub.endpoint,this.vapid,Math.floor((this.opts.now?.()??Date.now())/1000),this.opts.subject),
          TTL:'3600',Urgency:'normal','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',
        },encrypted);
        if(status===404||status===410)gone.push(sub.endpoint);
      }catch{/* a network failure keeps the subscription for the next event */}
    }
    if(gone.length){this.subs=this.subs.filter(s=>!gone.includes(s.endpoint));this.save();}
  }
  /** Hooks the store. The baseline is the list at attach time, so a restart announces nothing that was already listed. */
  attach(store:PushSource){this.announcer.baseline(store.state as State);store.listeners.add(()=>this.onStore(store));}
  onStore(store:PushSource){
    // 11.10: each Needs-you id, and each trouble id, once. An id that leaves the list and comes back is announced again.
    for(const q of this.announcer.fresh(store.state as State))this.notify(q.band==='trouble'?'problems':'approvals',questNotice(q,(store.state as State).approvals??[]));
    const event=store.state.events.at(-1);
    if(!event||event.id===this.lastEventId)return;
    this.lastEventId=event.id;
    // A briefing routine's finished run: one push per run, under the owner's routines setting.
    if(event.type==='routine.briefed')this.notify('routines',{title:'Daily briefing',body:String(event.data.line??''),url:'/',tag:`briefing-${event.data.task}`});
    // A routine run's replies are not pushed as Mayor messages: a briefing pushes its first line once, and the other routines push nothing per turn.
    if(event.type==='message'&&event.data?.from==='mayor'&&event.data?.to==='owner'&&!store.state.tasks?.find(t=>t.id===event.data.task)?.routine){
      this.notify('mayor',{title:'Mayor',body:String(event.data.text??''),url:'/',tag:`mayor-${event.id}`});
    }
  }
  /** Season completion is not a store event, so the caller polls seasons.list(). The first call only records the baseline. */
  checkSeasons(list:()=>{name:string;status:string}[]){
    const finished=new Set(list().filter(s=>s.status==='finished').map(s=>s.name));
    if(this.seasonBaseline){
      for(const name of finished)if(!this.seasonBaseline.has(name))this.notify('seasons',{title:'Clowder',body:`Season ${clean(name,40)} finished.`,url:'/',tag:`season-${clean(name,40)}`});
    }
    this.seasonBaseline=finished;
  }
  /** A world switch replaces the finished seasons; the next check records the new world's list as its baseline. */
  resetSeasonBaseline(){this.seasonBaseline=undefined;}
  close(){this.limiter.close();}
}

const subscriptionSchema={type:'object',required:['endpoint','keys'],additionalProperties:false,properties:{
  endpoint:{type:'string',minLength:1,maxLength:2048},
  keys:{type:'object',required:['p256dh','auth'],additionalProperties:false,properties:{p256dh:{type:'string',maxLength:200},auth:{type:'string',maxLength:64}}},
  kinds:{type:'object',additionalProperties:false,properties:{approvals:{type:'boolean'},mayor:{type:'boolean'},seasons:{type:'boolean'},routines:{type:'boolean'},problems:{type:'boolean'}}},
}};

/** Owner on the main app, paired owner device on the remote app. Anyone else gets 403 before the handler runs. device: who subscribes, so revoking it removes its endpoints. */
export function registerPushRoutes(app:FastifyInstance,{service,allowed,device=()=>undefined}:{service:PushService;allowed:(req:FastifyRequest)=>boolean;device?:(req:FastifyRequest)=>string|undefined}){
  const deny=(res:FastifyReply)=>res.code(403).send({error:'Notifications are managed on the host computer or by a paired owner device.'});
  app.get('/api/push/config',async(req,res)=>{
    if(!allowed(req))return deny(res);
    return {publicKey:service.publicKey()};
  });
  // For the first-run prompt: is this device already getting notifications? ?endpoint= also checks the browser's own subscription.
  app.get('/api/push/status',{schema:{querystring:{type:'object',additionalProperties:false,properties:{endpoint:{type:'string',minLength:1,maxLength:2048}}}}},async(req,res)=>{
    if(!allowed(req))return deny(res);
    return service.status(device(req),(req.query as {endpoint?:string}).endpoint);
  });
  app.post('/api/push/subscribe',{schema:{body:subscriptionSchema}},async(req,res)=>{
    if(!allowed(req))return deny(res);
    try{return service.subscribe(req.body as any,device(req));}catch(err){return res.code(400).send({error:(err as Error).message});}
  });
  app.post('/api/push/unsubscribe',{schema:{body:{type:'object',required:['endpoint'],additionalProperties:false,properties:{endpoint:{type:'string',minLength:1,maxLength:2048}}}}},async(req,res)=>{
    if(!allowed(req))return deny(res);
    return {removed:service.unsubscribe((req.body as {endpoint:string}).endpoint)};
  });
}

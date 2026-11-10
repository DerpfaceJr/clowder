import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {MEMBER_REFUSED,cookie,gatePath,grantMember,grantOwner,instanceCookie,memberRoute} from './access.ts';
import {Pairing,type Device} from './pairing.ts';
import {creationOptions,requestOptions,verifyAssertion,verifyRegistration} from './webauthn.ts';
// Pairing, renewal, logout and the step-up send one shape of cookie: Secure, HttpOnly, host-only (__Host-: Secure, Path=/, no Domain).
// The name carries the team instance (instanceCookie in access.ts); the private town keeps __Host-town_device and __Host-town_stepup.
const hostCookie=(name:string,token:string,maxAgeS:number)=>`${name}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`;

// Passkey step-up (plan 5.5). Money settings, Stripe, marking paid and new webhook links stay on the host; an owner device may change them
// only for a few minutes after it confirmed with its passkey, and only on a stable address (Tailscale or a named tunnel). A Quick Tunnel's
// host name dies with it, and a passkey works only for the host name it was made for, so the option does not exist there.
// Adding a passkey needs the host too: Devices opens a short window for one device, so a phone taken while paired cannot add its own.
// A member device may add one too (plan 10.4, §4.4), but its confirm opens nothing: only an owner device is ever stepped up.
export const STEP_UP_MS=5*60_000,ALLOW_MS=5*60_000,CHALLENGE_MS=2*60_000;
const stepped=new WeakSet<FastifyRequest>();
// The step-up window is held by its own short cookie, not the long-lived device cookie: a copy of the device cookie alone opens nothing.
// This is the private town's name; a team instance's carries its slug.
export const STEP_UP_COOKIE='__Host-town_stepup';
const digest=(token:string)=>createHash('sha256').update(token).digest();
/** A request from an owner device that confirmed with its passkey in the last STEP_UP_MS, on the stable address the passkey was made for. */
export const isSteppedUp=(req:FastifyRequest)=>stepped.has(req);
const refuse=(statusCode:number,message:string):never=>{throw Object.assign(new Error(message),{statusCode});};
export const NEEDS_STABLE='Passkeys need an address that stays the same: Tailscale or your own Cloudflare tunnel. A Quick Tunnel changes its address on every restart.';
export const NEEDS_ALLOW='On your computer, open Devices and choose Allow a passkey next to this phone. Then add it here within 5 minutes.';
export class StepUp{
  private allowed=new Map<string,number>();
  private challenges=new Map<string,{kind:'create'|'get';challenge:string;origin:string;rpId:string;expiresAt:number}>();
  private fresh=new Map<string,{until:number;hash:Buffer}>();
  constructor(private pairing:Pairing,private now=Date.now){
    pairing.revoked.add(id=>{this.allowed.delete(id);this.challenges.delete(id);this.fresh.delete(id);});
  }
  // Host only (server.ts, under /api/remote/). The window closes when the passkey is added or after ALLOW_MS.
  allow(id:string){
    if(!this.pairing.list().some(d=>d.id===id&&d.permission!=='viewer'))refuse(403,'Only a device paired with control or as a member can have a passkey.');
    const until=this.now()+ALLOW_MS;this.allowed.set(id,until);return until;
  }
  allowedUntil(id:string){const until=this.allowed.get(id);return until&&until>this.now()?until:undefined;}
  // Host only. Removing a passkey also ends a step-up in progress.
  remove(id:string){this.pairing.setPasskey(id,undefined);this.fresh.delete(id);this.challenges.delete(id);}
  /** The window's end, if this device confirmed within STEP_UP_MS, token is that confirm's cookie, and its passkey is for this host name. */
  private freshUntil(id:string,origin:string,token:string){
    const entry=this.fresh.get(id);
    if(!entry||!token||entry.until<=this.now()||this.pairing.passkey(id)?.rpId!==new URL(origin).hostname)return undefined;
    return timingSafeEqual(digest(token),entry.hash)?entry.until:undefined;
  }
  /** Whether this device may change host settings now: freshUntil, with the step-up cookie this device was given. */
  freshFor(id:string,origin:string,token:string){return this.freshUntil(id,origin,token)!==undefined;}
  view(device:Device|undefined,origin:string|undefined,stable:boolean,token:string){
    if(!device||device.permission==='viewer'||!origin||!stable)return {available:false};
    const rpId=new URL(origin).hostname,passkey=this.pairing.passkey(device.id);
    return {available:true,passkey:passkey?.rpId===rpId,canAdd:!!this.allowedUntil(device.id),until:this.freshUntil(device.id,origin,token)??null,minutes:STEP_UP_MS/60_000};
  }
  private challenge(id:string,kind:'create'|'get',origin:string){
    const challenge=randomBytes(32).toString('base64url'),rpId=new URL(origin).hostname;
    this.challenges.set(id,{kind,challenge,origin,rpId,expiresAt:this.now()+CHALLENGE_MS});
    return {challenge,rpId};
  }
  // Single use: taken out before it is checked, so a second answer to the same challenge finds nothing.
  private take(id:string,kind:'create'|'get',origin:string){
    const pending=this.challenges.get(id);this.challenges.delete(id);
    if(!pending||pending.kind!==kind||pending.expiresAt<=this.now()||pending.origin!==origin)refuse(400,'That passkey request expired. Try again.');
    return pending!;
  }
  creation(device:Device,origin:string){
    if(!this.allowedUntil(device.id))refuse(409,NEEDS_ALLOW);
    const {challenge,rpId}=this.challenge(device.id,'create',origin);
    // A new passkey replaces the old one, so the old one is not excluded: adding again on the same phone works.
    return creationOptions({challenge,rpId,userId:device.id,name:device.name});
  }
  register(device:Device,origin:string,body:unknown){
    const pending=this.take(device.id,'create',origin);
    if(!this.allowedUntil(device.id))refuse(409,NEEDS_ALLOW);
    const passkey=verifyRegistration(body,pending,this.now());
    this.pairing.setPasskey(device.id,passkey);this.allowed.delete(device.id);this.fresh.delete(device.id);
  }
  request(device:Device,origin:string){
    const passkey=this.pairing.passkey(device.id);
    if(!passkey||passkey.rpId!==new URL(origin).hostname)refuse(409,'This phone has no passkey for this address yet. Add one first.');
    const {challenge,rpId}=this.challenge(device.id,'get',origin);
    return requestOptions({challenge,rpId,id:passkey!.id});
  }
  confirm(device:Device,origin:string,body:unknown){
    const pending=this.take(device.id,'get',origin),passkey=this.pairing.passkey(device.id);
    if(!passkey)return refuse(409,'This phone has no passkey for this address yet. Add one first.');
    const signCount=verifyAssertion(body,passkey,pending);
    this.pairing.setPasskey(device.id,{...passkey,signCount});
    // A new confirm replaces the last window and its cookie. Only the cookie's hash is kept.
    const until=this.now()+STEP_UP_MS,token=randomBytes(32).toString('base64url');
    this.fresh.set(device.id,{until,hash:digest(token)});return {until,token};
  }
}

/** stable: whether the current origin keeps its host name (Tailscale or a named tunnel). Only then is the passkey step-up offered.
 *  team: a team instance's slug, so its cookies do not replace the private town's on the same host name (plan 10.2). */
export function installRemoteAccess(app:FastifyInstance,pairing:Pairing,getOrigin:()=>string|undefined,stable:()=>boolean=()=>false,now=Date.now,team?:string){
  const DEVICE=instanceCookie('__Host-town_device',team),STEP_UP=instanceCookie(STEP_UP_COOKIE,team);
  const deviceToken=(req:FastifyRequest)=>cookie(req,DEVICE);
  const deviceCookie=(token:string)=>hostCookie(DEVICE,token,Math.floor(pairing.config.deviceTtlMs/1000));
  const device=(req:FastifyRequest)=>pairing.authenticate(deviceToken(req));
  const stepUp=new StepUp(pairing,now);
  app.addHook('onRequest',async(req,res)=>{
    res.header('Cache-Control','no-store');res.header('Referrer-Policy','no-referrer');res.header('X-Content-Type-Options','nosniff');res.header('X-Frame-Options','DENY');
    const origin=getOrigin(),path=gatePath(req);
    if(path===null)return res.code(400).send({error:'Bad address.'});
    // This listener never inherits loopback owner privileges from the tunnel.
    if(!origin||req.headers.host!==new URL(origin).host)return res.code(403).send({error:'Remote access is disabled.'});
    // Authenticated first, on every request: a device used after a day gets a full TTL, and the browser learns the new Max-Age here, whatever route answers.
    const current=device(req);
    if(current?.renewed)res.header('Set-Cookie',deviceCookie(deviceToken(req)));
    const write=!['GET','HEAD'].includes(req.method);
    // Stripe's real-time authorization webhook: no Origin, no session. Its route accepts only a valid Stripe signature.
    if(path==='/stripe/webhook'&&req.method==='POST')return;
    // A routine's webhook (routines.ts): no Origin, no session. Its route accepts only that routine's token.
    if(path.startsWith('/hooks/routines/')&&req.method==='POST')return;
    // The phone's system browser coming back from a sign-in server (connectors.ts): no cookie, cross-site. Its route accepts only a pending state.
    if(path==='/api/connectors/oauth/callback'&&req.method==='GET')return;
    if(write&&(req.headers.origin!==origin||req.headers['x-town-action']!=='owner'))return res.code(403).send({error:'Use the paired town interface.'});
    if(path==='/api/remote-access'&&req.method==='GET')return;
    if(path==='/api/pair'&&req.method==='POST')return;
    // The APK holds no secrets, so a first install works before pairing. The rest of /app/ still needs a device.
    if(path==='/app/clowder.apk'&&!write)return;
    // Only the static pairing application is public; all town data needs a session.
    if(!path.startsWith('/api/')&&!path.startsWith('/app/')&&!path.startsWith('/artifacts/')&&!write)return;
    if(!current)return res.code(401).send({error:'Pair this device on your host computer.'});
    // The rendezvous read is the one /api/remote/ route a paired device may reach: it is how the app finds the town after a restart. Its route admits owners only.
    const rendezvous=path==='/api/remote/rendezvous'&&req.method==='GET';
    if((path.startsWith('/api/remote/')&&!rendezvous)||path==='/api/sharing'||path==='/api/viewer-session')return res.code(403).send({error:'Device access is managed on the host computer.'});
    // Past device management, an owner device passes every isOwner gate on this listener (access.ts). With a fresh passkey step-up on a
    // stable address it also passes isSteppedUp, which only the host-only settings read (server.ts).
    // A member device reaches the member routes and nothing else (plan 10.5, access.ts).
    if(current.permission==='owner'){grantOwner(req);if(stable()&&stepUp.freshFor(current.id,origin,cookie(req,STEP_UP)))stepped.add(req);}
    else if(current.permission==='member'){if(!memberRoute(req,path))return res.code(403).send({error:MEMBER_REFUSED});grantMember(req,current.person);}
    else if(write&&path!=='/api/logout')return res.code(403).send({error:'This device is paired for viewing only.'});
  });
  // A paired device that got the relay details can find the town after a restart; Devices shows it as followAt.
  app.addHook('onSend',async(req,res,payload)=>{if(req.method==='GET'&&gatePath(req)==='/api/remote/rendezvous'&&res.statusCode===200){const current=device(req);if(current)pairing.markFollow(current.id);}return payload;});
  app.get('/api/remote-access',async req=>({remote:true,paired:!!device(req),pollMs:pairing.config.pollMs}));
  app.post('/api/pair',{schema:{body:{type:'object',additionalProperties:false,required:['code','name'],properties:{code:{type:'string',minLength:1,maxLength:64},name:{type:'string',minLength:1,maxLength:60}}}}},async(req,res)=>{
    const {code,name}=req.body as {code:string;name:string};const result=pairing.pair(code,name);
    res.header('Set-Cookie',deviceCookie(result.token));
    return {ok:true,permission:result.device.permission};
  });
  app.post('/api/logout',async(req,res)=>{const current=device(req);if(current)pairing.revoke(current.id);res.header('Set-Cookie',hostCookie(DEVICE,'',0));return {ok:true};});
  // The step-up routes (public/step-up.js). The gateway above already needs a paired device, and for a POST this origin and the action header.
  // Each route needs an owner device on a stable address, or a member device for adding a passkey; a Quick Tunnel answers 409 to all of them
  // and GET says available:false.
  const place=(req:FastifyRequest,member=false)=>{
    const current=device(req),origin=getOrigin();
    if(!current||!(current.permission==='owner'||member&&current.permission==='member'))return refuse(403,'Only a device paired with control can use a passkey.');
    if(!origin||!stable())return refuse(409,NEEDS_STABLE);
    return {current,origin};
  };
  const answer=async(res:FastifyReply,work:()=>unknown)=>{try{return await work();}catch(error){const e=error as Error&{statusCode?:number};return res.code(e.statusCode&&e.statusCode<500?e.statusCode:400).send({error:e.message});}};
  const credential={body:{type:'object',required:['id','type','response'],properties:{id:{type:'string',maxLength:1400},type:{type:'string',maxLength:20},response:{type:'object',additionalProperties:{type:'string',maxLength:12000}}}}};
  app.get('/api/step-up',async req=>stepUp.view(device(req),getOrigin(),stable(),cookie(req,STEP_UP)));
  app.post('/api/step-up/register/options',async(req,res)=>answer(res,()=>{const {current,origin}=place(req,true);return stepUp.creation(current,origin);}));
  app.post('/api/step-up/register',{schema:credential},async(req,res)=>answer(res,()=>{const {current,origin}=place(req,true);stepUp.register(current,origin,req.body);return {ok:true};}));
  app.post('/api/step-up/options',async(req,res)=>answer(res,()=>{const {current,origin}=place(req);return stepUp.request(current,origin);}));
  app.post('/api/step-up',{schema:credential},async(req,res)=>answer(res,()=>{
    const {current,origin}=place(req),{until,token}=stepUp.confirm(current,origin,req.body);
    res.header('Set-Cookie',hostCookie(STEP_UP,token,STEP_UP_MS/1000));return {until,minutes:STEP_UP_MS/60_000};
  }));
  return {device:(req:FastifyRequest)=>device(req)?.id,stepUp};
}

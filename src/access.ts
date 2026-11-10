import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmodSync,closeSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {networkInterfaces,userInfo} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pairing,Role} from './pairing.ts';

const loopback=(address:string)=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
// Reverse proxies on this machine arrive as loopback, so any proxy header means a remote visitor.
const proxied=(req:FastifyRequest)=>['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','cf-connecting-ip','true-client-ip'].some(h=>h in req.headers);
// This computer: loopback, no proxy header, a literal localhost Host (so no DNS rebinding). Not the owner by itself: the cats' browser, a CLI run
// and any other program here are local too. Hermes's routes (hermes.ts) take a local caller that holds their gate token.
export const isLocal=(req:FastifyRequest)=>loopback(req.ip)&&!proxied(req)&&/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||'');
// The host owner (security pass H2): a local request with this launch's owner session. installAccess marks each local request without one.
// Device management, the tunnel and revealing secrets stay host-only.
const strangers=new WeakSet<FastifyRequest>();
export const isHost=(req:FastifyRequest)=>isLocal(req)&&!strangers.has(req);
export const same=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
// One owner session cookie per port, so opening a scratch town on another port does not sign the owner out of this one.
export const ownerCookie=(port:number)=>`town_owner_${port}`;
export const ownerSetCookie=(port:number,session:string)=>`${ownerCookie(port)}=${session}; HttpOnly; SameSite=Strict; Path=/`;
// The owner key kept under npm start (plan 11.27), so a browser stays signed in across restarts. The file is <data>/owner-key, readable by this
// user alone: mode 0600, or on Windows an ACL with inheritance removed and one grant, to this user. It never leaves the server: the cookie
// carries session(), a keyed hash of it, and the console link carries link(), a code made per launch (and per rotation). A missing, unreadable or
// malformed file, or one whose permissions cannot be tightened, gives a new key (the timid answer); if that cannot be kept, it lasts this launch.
// Outside the snapshot, backup and restore allow lists (snapshot.ts) by construction. CAT_OWNER_KEY (the desktop app) skips all of this.
export const OWNER_KEY_FILE='owner-key';
const KEY_SHAPE=/^[A-Za-z0-9_-]{43}$/;
const tighten=(file:string)=>{
  if(process.platform!=='win32'){chmodSync(file,0o600);return;}
  const user=process.env.USERDOMAIN?`${process.env.USERDOMAIN}\\${userInfo().username}`:userInfo().username;
  const r=spawnSync('icacls',[file,'/inheritance:r','/grant:r',`${user}:F`],{windowsHide:true,encoding:'utf8'});
  if(r.status!==0)throw new Error('icacls could not set the owner key file\'s permissions.');
};
export function ownerKeyFile(dataDir:string,log:(line:string)=>void=console.error){
  const file=join(dataDir,OWNER_KEY_FILE);
  const read=()=>{try{const key=readFileSync(file,'utf8');if(!KEY_SHAPE.test(key))return undefined;tighten(file);return key;}catch{return undefined;}};
  // Made empty and tightened before the key is written, then renamed over the old file, so no reader ever sees the key with looser permissions.
  // Not kept: the old file is removed, so a restart cannot bring back a key that was rotated away.
  const fresh=()=>{
    const key=randomBytes(32).toString('base64url'),tmp=`${file}.${randomBytes(4).toString('hex')}.tmp`;
    try{mkdirSync(dataDir,{recursive:true});closeSync(openSync(tmp,'wx',0o600));tighten(tmp);writeFileSync(tmp,key);renameSync(tmp,file);}
    catch{
      try{rmSync(tmp,{force:true});}catch{/* left as an empty or locked .tmp file */}
      try{rmSync(file,{force:true});}catch{log('Clowder: the old owner key file could not be removed; delete it from the data folder.');}
      log('Clowder: the owner key could not be kept in the data folder; this launch uses one that ends with it.');
    }
    return key;
  };
  let key=read()??fresh(),link=randomBytes(32).toString('base64url');
  return {
    session:()=>createHmac('sha256',key).update('clowder owner session').digest('base64url'),
    link:()=>link,
    // Every cookie made from the old key, and the old console link, stop working at once.
    rotate:()=>{key=fresh();link=randomBytes(32).toString('base64url');},
  };
}
// Cookies are not kept apart by port (RFC 6265 §8.5), so two instances on one host name share a cookie jar (plan 10.2). The device, LAN and
// step-up cookies of a team instance carry its slug (CAT_TEAM, desktop/teams.cjs): the slug, not a port, because a team's ports move when one is
// busy (desktop/main.cjs freePort) and a pairing outlives a launch, while the owner cookie is set again on every launch. No team: today's name,
// so no device of the private town re-pairs. A slug that cannot sit in a cookie name stops the server rather than share the private names.
export const instanceCookie=(base:string,team?:string)=>{
  if(team===undefined||team==='')return base;
  if(!/^[a-z0-9-]{1,40}$/.test(team))throw new Error(`CAT_TEAM must be lower-case letters, digits and dashes, not ${JSON.stringify(team)}.`);
  return `${base}_${team}`;
};
// This computer's LAN addresses: where Same Wi-Fi sharing listens, and what the cats' browser may not open (tool-runtimes.ts).
export const lanAddresses=()=>[...new Set(Object.values(networkInterfaces()).flatMap(items=>(items||[]).filter(i=>i.family==='IPv4'&&!i.internal).map(i=>i.address)))];
// The one owner rule: the host, or a request the remote gateway authenticated as a paired owner device (remote-access.ts grants it).
const ownerDevices=new WeakSet<FastifyRequest>();
export const grantOwner=(req:FastifyRequest)=>{ownerDevices.add(req);};
export const isOwner=(req:FastifyRequest)=>ownerDevices.has(req)||isHost(req);
// The member gate (plan 10.5, §4.4 of docs/for-you-and-teams-plan.md): the only routes a member device reaches, on either listener. Fail closed:
// a route not listed answers 403 to a member, so one added later stays shut to members until it is reviewed and listed here. Chat is with the
// Mayor and a decision is the member's own (server.ts checks both). Reads leave out the owner's: worlds, money, accounts, routines, usage, quests,
// the wiki and memory, push and devices. A member may add a passkey (§4.4); confirming one opens a step-up, which stays the owner's.
const MEMBER_ROUTES=new Set(['GET /api/state','GET /api/events','GET /api/chats/:cat','GET /api/threads/:task','GET /api/search','GET /api/projects',
  'GET /api/season','GET /api/goals','GET /api/artifacts','GET /artifacts/:id','GET /artifacts/:id/raw','GET /api/remote-access','GET /api/step-up',
  'POST /api/chat','POST /api/approvals/:id','POST /api/logout','POST /api/step-up/register/options','POST /api/step-up/register']);
export const memberRoute=(req:FastifyRequest,path:string)=>MEMBER_ROUTES.has(`${req.method==='HEAD'?'GET':req.method} ${path}`);
export const MEMBER_REFUSED='This part of the town is the owner\'s.';
// Granted by the gate that admitted a member device, with the person it acts for (people.ts).
const members=new WeakMap<FastifyRequest,string>();
export const grantMember=(req:FastifyRequest,person:string)=>{members.set(req,person);};
export const isMember=(req:FastifyRequest)=>members.has(req);
export const memberPerson=(req:FastifyRequest)=>members.get(req);
// The path a gate decides on (security pass H1). The router decodes before it matches, so /%61pi/state is /api/state to Fastify but not to
// startsWith('/api/'). A path no browser or app sends (a percent-encoded letter, digit or -._~, a broken escape, a dot segment) is refused
// outright: null, answered 400 by both listeners. Any other path is the route the router matched, or the path itself for the static app's
// wildcard and for no route at all.
export function gatePath(req:FastifyRequest):string|null{
  const path=req.url.split(/[?#]/)[0]!;
  for(const [,hex] of path.matchAll(/%(.{0,2})/g))if(!/^[0-9A-Fa-f]{2}$/.test(hex!)||/[A-Za-z0-9\-._~]/.test(String.fromCharCode(parseInt(hex!,16))))return null;
  if(/(^|\/)\.\.?(\/|$)/.test(path))return null;
  const route=req.routeOptions.url;
  return route&&!route.includes('*')?route:path;
}
export const cookie=(req:FastifyRequest,name:string)=>(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith(name+'='))?.slice(name.length+1)||'';
// Plain http on the LAN, so no Secure or __Host- prefix: the browser would drop either.
const lanCookie=(name:string,token:string,maxAgeMs:number)=>`${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs/1000)}`;

/** LAN sharing is a device pairing: a one-time code from Devices, swapped for a device cookie. A viewer only views. A member device reaches the
 *  member routes on the tunnel listener's list. An owner device controls
 *  the town exactly as through the tunnel (item 5.2): tunnelRoute admits only the routes the tunnel listener serves, each behind its own isOwner or
 *  isHost gate, so device management, the tunnel, secrets and money settings stay on the host. Without tunnelRoute every LAN device only views.
 *  ownerKey: the owner session (H2), or a getter for one that can rotate (11.27). The desktop app sets its cookie in its own window; under npm start
 *  the console link's ?owner=<code> sets it in the owner's browser. ownerLink: that code; without one the link takes the session itself. Without a
 *  key no request is the host. team: a team instance's slug (instanceCookie), unset for the private town. */
export function installAccess(app:FastifyInstance,enabled:boolean,addresses:string[],port:number,pairing?:Pairing,tunnelRoute?:(req:FastifyRequest)=>boolean,ownerKey?:string|(()=>string),team?:string,ownerLink?:()=>string){
  const lan=instanceCookie('town_device',team);
  const hosts=new Set(['localhost','127.0.0.1',...(enabled?addresses:[])].flatMap(h=>[h,`${h}:${port}`]));
  const key=typeof ownerKey==='function'?ownerKey:()=>ownerKey;
  const matches=(value:unknown,expected:string|undefined)=>!!expected&&typeof value==='string'&&same(value,expected);
  const session=(value:unknown)=>matches(value,key());
  app.addHook('onRequest',async(req,res)=>{
    const host=req.headers.host||'';
    res.header('X-Content-Type-Options','nosniff');res.header('Referrer-Policy','no-referrer');
    res.header('Cache-Control','no-store');
    const path=gatePath(req);
    if(path===null)return res.code(400).send({error:'Bad address.'});
    if(!hosts.has(host))return res.code(403).send({error:'Unknown town address.'});
    const local=isLocal(req),write=!['GET','HEAD'].includes(req.method);
    // The console link: ?owner=<code> sets the session, then the same page loads without the code in its address.
    if(local&&req.method==='GET'&&matches((req.query as {owner?:unknown}|undefined)?.owner,ownerLink?ownerLink():key())){
      const url=new URL(req.url,'http://town');url.searchParams.delete('owner');
      return res.code(303).header('Set-Cookie',ownerSetCookie(port,key()!)).header('Location',url.pathname+url.search).send();
    }
    if(local&&!session(cookie(req,ownerCookie(port))))strangers.add(req);
    const owner=isHost(req),guarded=path.startsWith('/api/')||path.startsWith('/app/')||path.startsWith('/artifacts/');
    if(write&&req.headers.origin&&req.headers.origin!==`http://${host}`)return res.code(403).send({error:'Use the town interface.'});
    if(path==='/api/viewer-session'&&enabled&&req.method==='POST')return;
    // Artifact pages run in an opaque origin, so their requests carry Origin: null or Sec-Fetch-Site: cross-site. The town API never answers them.
    // The OAuth return is the system browser following a redirect from the sign-in server: cross-site by design. Its pending state is the guard.
    const oauthReturn=req.method==='GET'&&path==='/api/connectors/oauth/callback';
    if(path.startsWith('/api/')&&!oauthReturn&&(req.headers.origin==='null'||req.headers['sec-fetch-site']==='cross-site'))return res.code(403).send({error:'Artifacts cannot reach the town.'});
    if(!owner&&local){
      // This computer without the owner session: the cats' browser, a CLI run, any other program. The app's pages load; town data and writes do
      // not. Routes that check their own credential still answer: Hermes's gate token, a routine's webhook token, the sign-in callback's pending state.
      if(['/mcp','/api/hermes/hello','/api/hermes/gate','/api/hermes/result'].includes(path)||(req.method==='POST'&&path.startsWith('/hooks/routines/'))||oauthReturn)return;
      if(write)return res.code(403).send({error:'Use the Clowder window.'});
      if(guarded)return res.code(401).send({error:'Open Clowder from its own window, or from the link it printed when it started.'});
    }else if(!owner){
      if(!enabled)return res.code(403).send({error:'This device has view-only access.'});
      const token=cookie(req,lan),device=guarded||write?pairing?.authenticate(token):undefined;
      if(device?.renewed)res.header('Set-Cookie',lanCookie(lan,token,pairing!.config.deviceTtlMs));
      // The same rule as the tunnel gateway (remote-access.ts): an owner device passes isOwner, a member device reaches the member routes and
      // nothing else, and a write also needs the action header.
      const routed=!!tunnelRoute?.(req)&&(!write||req.headers['x-town-action']==='owner');
      if(device?.permission==='owner'&&routed)grantOwner(req);
      else if(device?.permission==='member'){if(!routed||!memberRoute(req,path))return res.code(403).send({error:MEMBER_REFUSED});grantMember(req,device.person);}
      else if(write)return res.code(403).send({error:'This device has view-only access.'});
      if(guarded&&!device)return res.code(401).send({error:'Open the viewing link from your computer.'});
    }else if(write&&req.headers['x-town-action']!=='owner')return res.code(403).send({error:'Use the local Clowder interface.'});
  });
  app.post('/api/viewer-session',{schema:{body:{type:'object',required:['token'],additionalProperties:false,properties:{token:{type:'string',maxLength:128}}}}},async(req,res)=>{
    if(!enabled||!pairing)return res.code(403).send({error:'Viewing link expired or invalid. Get a fresh link on your computer.'});
    try{const {token}=pairing.pair((req.body as {token:string}).token,permission=>`Same Wi-Fi ${permission}`);res.header('Set-Cookie',lanCookie(lan,token,pairing.config.deviceTtlMs));return {ok:true};}
    catch(error){return res.code(403).send({error:(error as Error).message});}
  });
  // ?permission=owner: a one-time code that pairs an owner device on this Wi-Fi. Default viewer.
  app.get('/api/sharing',{schema:{querystring:{type:'object',additionalProperties:false,properties:{permission:{type:'string',enum:['viewer','owner']}}}}},async(req,res)=>{
    if(!isHost(req))return res.code(403).send({error:'Sharing is managed on the host computer.'});
    // Each opening of Devices makes a fresh one-time code. A full device list gives no link rather than a dialog that will not open.
    const permission=(req.query as {permission?:Role}).permission??'viewer';
    let code='';if(enabled&&pairing)try{code=pairing.create(permission,'lan').code;}catch{/* Devices shows the list to revoke from */}
    return {enabled,urls:code?addresses.map(address=>`http://${address}:${port}/#view=${code}`):[]};
  });
  // Who acts, journaled on closed steps and answered approvals: 'host', the paired LAN device's id, or 'unpaired'.
  return {device:(req:FastifyRequest)=>isHost(req)?'host':pairing?.authenticate(cookie(req,lan))?.id??'unpaired'};
}

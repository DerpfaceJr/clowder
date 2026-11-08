import {createHash,timingSafeEqual} from 'node:crypto';
import {networkInterfaces} from 'node:os';
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
// This computer's LAN addresses: where Same Wi-Fi sharing listens, and what the cats' browser may not open (tool-runtimes.ts).
export const lanAddresses=()=>[...new Set(Object.values(networkInterfaces()).flatMap(items=>(items||[]).filter(i=>i.family==='IPv4'&&!i.internal).map(i=>i.address)))];
// The one owner rule: the host, or a request the remote gateway authenticated as a paired owner device (remote-access.ts grants it).
const ownerDevices=new WeakSet<FastifyRequest>();
export const grantOwner=(req:FastifyRequest)=>{ownerDevices.add(req);};
export const isOwner=(req:FastifyRequest)=>ownerDevices.has(req)||isHost(req);
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
const lanCookie=(token:string,maxAgeMs:number)=>`town_device=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs/1000)}`;

/** LAN sharing is a device pairing: a one-time code from Devices, swapped for a device cookie. A viewer only views. An owner device controls
 *  the town exactly as through the tunnel (item 5.2): tunnelRoute admits only the routes the tunnel listener serves, each behind its own isOwner or
 *  isHost gate, so device management, the tunnel, secrets and money settings stay on the host. Without tunnelRoute every LAN device only views.
 *  ownerKey: this launch's owner session (H2). The desktop app sets its cookie in its own window; under npm start the console link's ?owner=<key>
 *  sets it in the owner's browser. Without a key no request is the host. */
export function installAccess(app:FastifyInstance,enabled:boolean,addresses:string[],port:number,pairing?:Pairing,tunnelRoute?:(req:FastifyRequest)=>boolean,ownerKey?:string){
  const hosts=new Set(['localhost','127.0.0.1',...(enabled?addresses:[])].flatMap(h=>[h,`${h}:${port}`]));
  const session=(value:unknown)=>!!ownerKey&&typeof value==='string'&&same(value,ownerKey);
  app.addHook('onRequest',async(req,res)=>{
    const host=req.headers.host||'';
    res.header('X-Content-Type-Options','nosniff');res.header('Referrer-Policy','no-referrer');
    res.header('Cache-Control','no-store');
    const path=gatePath(req);
    if(path===null)return res.code(400).send({error:'Bad address.'});
    if(!hosts.has(host))return res.code(403).send({error:'Unknown town address.'});
    const local=isLocal(req),write=!['GET','HEAD'].includes(req.method);
    // The console link: ?owner=<key> sets the session, then the same page loads without the key in its address.
    if(local&&req.method==='GET'&&session((req.query as {owner?:unknown}|undefined)?.owner)){
      const url=new URL(req.url,'http://town');url.searchParams.delete('owner');
      return res.code(303).header('Set-Cookie',`${ownerCookie(port)}=${ownerKey}; HttpOnly; SameSite=Strict; Path=/`).header('Location',url.pathname+url.search).send();
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
      const token=cookie(req,'town_device'),device=guarded||write?pairing?.authenticate(token):undefined;
      if(device?.renewed)res.header('Set-Cookie',lanCookie(token,pairing!.config.deviceTtlMs));
      // The same rule as the tunnel gateway (remote-access.ts): an owner device passes isOwner, and a write also needs the action header.
      if(device?.permission==='owner'&&tunnelRoute?.(req)&&(!write||req.headers['x-town-action']==='owner'))grantOwner(req);
      else if(write)return res.code(403).send({error:'This device has view-only access.'});
      if(guarded&&!device)return res.code(401).send({error:'Open the viewing link from your computer.'});
    }else if(write&&req.headers['x-town-action']!=='owner')return res.code(403).send({error:'Use the local Clowder interface.'});
  });
  app.post('/api/viewer-session',{schema:{body:{type:'object',required:['token'],additionalProperties:false,properties:{token:{type:'string',maxLength:128}}}}},async(req,res)=>{
    if(!enabled||!pairing)return res.code(403).send({error:'Viewing link expired or invalid. Get a fresh link on your computer.'});
    try{const {token}=pairing.pair((req.body as {token:string}).token,permission=>`Same Wi-Fi ${permission}`);res.header('Set-Cookie',lanCookie(token,pairing.config.deviceTtlMs));return {ok:true};}
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
  return {device:(req:FastifyRequest)=>isHost(req)?'host':pairing?.authenticate(cookie(req,'town_device'))?.id??'unpaired'};
}

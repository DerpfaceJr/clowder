// OAuth 2.1 sign-in for remote MCP servers, per the MCP authorization spec: RFC 9728 protected resource metadata, RFC 8414 (or
// OpenID Connect) authorization server metadata, RFC 7591 dynamic registration, PKCE S256, RFC 8707 resource indicators.
// Pure functions over an injected fetch. The caller saves the returned OAuthState; nothing here touches disk.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {OAuthState} from './connector-types.ts';

const TIMEOUT_MS=15_000;
const SKEW_MS=60_000;
const DEVICE_GRANT='urn:ietf:params:oauth:grant-type:device_code';
// How long a started sign-in waits for its callback. A connect step's quest reads it too (quests.ts).
export const PENDING_MS=10*60_000;

type Fetch=typeof fetch;
// The server's JSON is untyped (any): each field is checked where it is read.
type Posted={ok:boolean;status:number;j:any};

// Every endpoint is https, except plain http to this machine (tests and local servers).
function checkUrl(u:string){
  const x=new URL(u);
  if(x.protocol==='https:'||(x.protocol==='http:'&&(x.hostname==='127.0.0.1'||x.hostname==='localhost')))return u;
  throw new Error(`Refusing a non-HTTPS endpoint: ${u}`);
}
// An optional endpoint that fails the check is left out rather than failing the sign-in.
const safeUrl=(u:unknown)=>{try{return typeof u==='string'?checkUrl(u):undefined;}catch{return undefined;}};
const s256=(v:string)=>createHash('sha256').update(v).digest('base64url');
const b64u=(n:number)=>randomBytes(n).toString('base64url');
const trimSlash=(p:string)=>p.replace(/\/+$/,'');
const expiry=(j:any,now:number)=>{const ttl=typeof j.expires_in==='string'?Number(j.expires_in):j.expires_in;return typeof ttl==='number'&&Number.isFinite(ttl)?now+ttl*1000:undefined;};
const reason=(j:any,status:number)=>j.error_description||j.error||status;

async function getJson(url:string,f:Fetch){
  const r=await f(checkUrl(url),{headers:{accept:'application/json'},signal:AbortSignal.timeout(TIMEOUT_MS)});
  const j=r.ok?await r.json().catch(()=>null):null;
  return j&&typeof j==='object'?j:null;
}

// Form-encoded POST to the token endpoint. Fields that are undefined are left out.
async function postForm(url:string,fields:Record<string,string|undefined>,f:Fetch):Promise<Posted>{
  const body=new URLSearchParams();
  for(const [k,v] of Object.entries(fields))if(v!==undefined)body.set(k,v);
  const r=await f(checkUrl(url),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body,signal:AbortSignal.timeout(TIMEOUT_MS)});
  const j=(await r.json().catch(()=>null))??{};
  return {ok:r.ok&&!!j.access_token,status:r.status,j};
}

/** The Bearer challenge's resource_metadata, scope and error. Quoted values may hold commas; the scheme is any case. */
export function parseWwwAuthenticate(header:string|null){
  const out:{resourceMetadata?:string;scope?:string;error?:string}={};
  const m=header?.match(/(?:^|[\s,])Bearer(?=\s|$)/i);
  if(!header||!m)return out;
  for(const p of header.slice(m.index!+m[0].length).matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]*))/g)){
    const v=p[2]!==undefined?p[2].replace(/\\(.)/g,'$1'):p[3]??'';
    const k=p[1]!.toLowerCase();
    if(k==='resource_metadata')out.resourceMetadata=v;else if(k==='scope')out.scope=v;else if(k==='error')out.error=v;
  }
  return out;
}

export async function discover(serverUrl:string,wwwAuthenticate:string|null,f:Fetch=fetch):Promise<{resource:string;authServer:string;metadata:any;scope?:string}>{
  const srv=new URL(serverUrl),origin=srv.origin,path=trimSlash(srv.pathname);
  const hdr=parseWwwAuthenticate(wwwAuthenticate);
  // The header's resource_metadata wins; else the path-suffixed well-known document, then the root one (RFC 9728 section 3).
  const prmUrls=hdr.resourceMetadata?[hdr.resourceMetadata]:[...new Set([`${origin}/.well-known/oauth-protected-resource${path}`,`${origin}/.well-known/oauth-protected-resource`])];
  let prm:any=null;
  for(const u of prmUrls){prm=await getJson(u,f);if(prm)break;}
  // RFC 9728 section 3.3: the metadata must name this connector as its resource (same origin and path; a trailing slash does not count). One that
  // names another service would have Clowder sign in there and send that service's token to this server (security pass M2).
  if(typeof prm?.resource==='string'){
    let named:URL|null=null;try{named=new URL(prm.resource);}catch{/* not a URL: refused below */}
    if(!named||named.origin!==origin||trimSlash(named.pathname)!==path)throw new Error(`This server's sign-in details are for another address (${prm.resource.slice(0,200)}), not ${origin}${path}. Not signing in.`);
  }
  const authServer:string=(Array.isArray(prm?.authorization_servers)&&prm.authorization_servers[0])||origin;
  const resource:string=(typeof prm?.resource==='string'&&prm.resource)||serverUrl.split('#')[0];
  const prmScope=Array.isArray(prm?.scopes_supported)?prm.scopes_supported.join(' '):'';
  const scope=hdr.scope||prmScope||undefined;
  // RFC 8414 first, then OpenID Connect. A path on the issuer goes after the well-known segment (RFC 8414 section 3).
  const iss=new URL(authServer),io=iss.origin,ip=trimSlash(iss.pathname);
  const asUrls=ip?[`${io}/.well-known/oauth-authorization-server${ip}`,`${io}/.well-known/openid-configuration${ip}`,`${io}${ip}/.well-known/openid-configuration`]:[`${io}/.well-known/oauth-authorization-server`,`${io}/.well-known/openid-configuration`];
  let metadata:any=null;
  for(const u of asUrls){metadata=await getJson(u,f);if(metadata)break;}
  if(!metadata)throw new Error(`No sign-in details found at ${authServer}`);
  if(!metadata.authorization_endpoint||!metadata.token_endpoint)throw new Error('The sign-in server does not list its authorization and token endpoints.');
  for(const k of ['authorization_endpoint','token_endpoint','registration_endpoint'])if(metadata[k])checkUrl(metadata[k]);
  const methods=metadata.code_challenge_methods_supported;
  if(methods!==undefined&&!(Array.isArray(methods)&&methods.includes('S256')))throw new Error('The sign-in server does not support PKCE with S256.');
  return {resource,authServer,metadata,scope};
}

// RFC 7591: a public client (no secret unless the server gives one) for these redirect URIs, and the device grant when the server has one.
async function register(endpoint:string,redirectUris:string[],device:boolean,f:Fetch){
  const r=await f(checkUrl(endpoint),{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({client_name:'Clowder',redirect_uris:redirectUris,grant_types:['authorization_code','refresh_token',...(device?[DEVICE_GRANT]:[])],response_types:['code'],token_endpoint_auth_method:'none'}),signal:AbortSignal.timeout(TIMEOUT_MS)});
  const j=(await r.json().catch(()=>null))??{};
  if(!r.ok||!j.client_id)throw new Error(`Client registration failed: ${reason(j,r.status)}`);
  return {clientId:String(j.client_id),clientSecret:j.client_secret?String(j.client_secret):undefined};
}

/** Starts a sign-in. redirectUri: where this one returns. redirectUris: every redirect a new client should accept (this computer's and, on a
 *  stable origin, the remote listener's), so a sign-in from the other device reuses it. device: a device code sign-in when the server lists one;
 *  then url is the page the owner opens and device.userCode what it should show. */
export async function beginAuth(o:{serverUrl:string;wwwAuthenticate:string|null;redirectUri:string;redirectUris?:string[];device?:boolean;prior?:OAuthState;f?:Fetch;now?:number}):Promise<{url:string;state:OAuthState;device?:{userCode:string;expiresAt:number}}>{
  const f=o.f??fetch,now=o.now??Date.now(),prior=o.prior;
  const d=await discover(o.serverUrl,o.wwwAuthenticate,f);
  const m=d.metadata,deviceAt=safeUrl(m.device_authorization_endpoint),useDevice=!!(o.device&&deviceAt);
  let clientId=prior?.clientId,clientSecret=prior?.clientSecret,deviceGrant=prior?.deviceGrant;
  let redirectUris=prior?.redirectUris??(prior?.redirectUri?[prior.redirectUri]:[]);
  // One client for every redirect URI it was registered with. A loopback port change still registers anew: RFC 8252 section 7.3 says any port
  // matches, but a server that matches exactly would strand the sign-in on its own error page, where Clowder never hears of it.
  // A prior client is kept when the server has no registration endpoint to make a new one.
  if(!clientId||!redirectUris.includes(o.redirectUri)||(useDevice&&!deviceGrant)){
    if(m.registration_endpoint){
      redirectUris=[...new Set([o.redirectUri,...o.redirectUris??[]])];deviceGrant=!!deviceAt;
      const reg=await register(m.registration_endpoint,redirectUris,deviceGrant,f);clientId=reg.clientId;clientSecret=reg.clientSecret;
    }
    else if(!clientId)throw new Error('This service does not let new apps sign in on their own. Add an access token instead.');
  }
  const base:OAuthState={...prior,resource:d.resource,authServer:d.authServer,authorizationEndpoint:m.authorization_endpoint,tokenEndpoint:m.token_endpoint,registrationEndpoint:m.registration_endpoint,scope:d.scope,clientId,clientSecret,redirectUri:o.redirectUri,redirectUris,deviceGrant,userinfoEndpoint:safeUrl(m.userinfo_endpoint)};
  if(useDevice){
    // RFC 8628: the owner approves on any device with a browser while the hub polls the token endpoint (pollDevice). The window is at most PENDING_MS.
    let r:Posted;
    try{r=await postForm(deviceAt!,{client_id:clientId,scope:d.scope,resource:d.resource,client_secret:clientSecret},f);}
    catch(e){throw new Error(`Sign-in failed: ${(e as Error).message}`);}
    const j=r.j,url=safeUrl(j.verification_uri_complete)??safeUrl(j.verification_uri);
    if(typeof j.device_code!=='string'||typeof j.user_code!=='string'||!url)throw new Error(`Sign-in failed: ${reason(j,r.status)}`);
    const expiresAt=now+Math.min(typeof j.expires_in==='number'&&j.expires_in>0?j.expires_in*1000:PENDING_MS,PENDING_MS);
    const interval=typeof j.interval==='number'&&j.interval>=0?j.interval:5;
    return {url,device:{userCode:j.user_code.slice(0,40),expiresAt},state:{...base,pending:{state:b64u(16),verifier:'',createdAt:now,device:{code:j.device_code,interval,expiresAt}}}};
  }
  return authorize(base,now);
}

// The PKCE authorization request for a state whose endpoints, client and redirect are set. extra: a provider's own parameters.
function authorize(base:OAuthState,now:number,extra:Record<string,string>={}){
  const verifier=b64u(32),state=b64u(16);
  const u=new URL(checkUrl(base.authorizationEndpoint??''));
  const q={response_type:'code',client_id:base.clientId,redirect_uri:base.redirectUri,code_challenge:s256(verifier),code_challenge_method:'S256',state,resource:base.resource,scope:base.scope,...extra};
  for(const [k,v] of Object.entries(q))if(v)u.searchParams.set(k,v);
  return {url:u.href,state:{...base,pending:{state,verifier,createdAt:now}}};
}

/** Sign-in with a client the owner registered (Google, Microsoft: D6): fixed endpoints, no discovery and no registration. No resource
 *  indicator, which those servers do not take. The rest (finishAuth, freshToken) is the same as for an MCP server's own sign-in. */
export function beginOwnerAuth(o:{authorizationEndpoint:string;tokenEndpoint:string;userinfoEndpoint?:string;clientId:string;clientSecret?:string;scope:string;redirectUri:string;extra?:Record<string,string>;prior?:OAuthState;now?:number}):{url:string;state:OAuthState}{
  checkUrl(o.tokenEndpoint);
  // A prior sign-in's tokens stay until the new one finishes, so a sign-in the owner abandons does not sign the account out.
  const base:OAuthState={...o.prior,resource:undefined,authServer:undefined,registrationEndpoint:undefined,deviceGrant:undefined,authorizationEndpoint:o.authorizationEndpoint,tokenEndpoint:o.tokenEndpoint,userinfoEndpoint:o.userinfoEndpoint,clientId:o.clientId,clientSecret:o.clientSecret,scope:o.scope,redirectUri:o.redirectUri,redirectUris:[o.redirectUri]};
  return authorize(base,o.now??Date.now(),o.extra);
}

/** A returned state against the pending one, in constant time: the remote callback answers anyone who reaches it. */
export const stateMatches=(want:string,got:string)=>{const a=Buffer.from(got),b=Buffer.from(want);return a.length===b.length&&timingSafeEqual(a,b);};

/** The code and state out of what the owner pastes back: the whole address the phone's browser stopped at, or just its query. */
export function pastedRedirect(text:string){
  const t=text.trim(),q=new URLSearchParams(t.includes('?')?t.slice(t.indexOf('?')+1).split('#')[0]:t);
  const get=(k:string)=>q.get(k)??undefined;
  return {code:get('code'),state:get('state'),error:get('error'),error_description:get('error_description')};
}

export async function finishAuth(st:OAuthState,code:string,returnedState:string,f:Fetch=fetch,now:number=Date.now()):Promise<OAuthState>{
  const p=st.pending;
  if(!p)throw new Error('No sign-in is waiting. Start sign-in again.');
  if(!stateMatches(p.state,returnedState))throw new Error('Sign-in did not match the request. Start sign-in again.');
  if(now-p.createdAt>PENDING_MS)throw new Error('Sign-in took too long. Start sign-in again.');
  let r:Posted;
  try{r=await postForm(checkUrl(st.tokenEndpoint??''),{grant_type:'authorization_code',code,redirect_uri:st.redirectUri,client_id:st.clientId,code_verifier:p.verifier,resource:st.resource,client_secret:st.clientSecret},f);}
  catch(e){throw new Error(`Sign-in failed: ${(e as Error).message}`);}
  if(!r.ok)throw new Error(`Sign-in failed: ${reason(r.j,r.status)}`);
  return {...st,accessToken:r.j.access_token,refreshToken:r.j.refresh_token,expiresAt:expiry(r.j,now),pending:undefined};
}

/** One poll of a device code sign-in (RFC 8628 section 3.5). wait: not approved yet, ask again in that many seconds; none: signed in.
 *  A refusal (access_denied, expired_token) or the end of the window throws. */
export async function pollDevice(st:OAuthState,f:Fetch=fetch,now:number=Date.now()):Promise<{state:OAuthState;wait?:number}>{
  const p=st.pending,dv=p?.device;
  if(!p||!dv)throw new Error('No sign-in is waiting. Start sign-in again.');
  if(now>dv.expiresAt)throw new Error('Sign-in took too long. Start sign-in again.');
  let r:Posted;
  // No answer at all is asked again, as a refresh that gets none keeps its tokens.
  try{r=await postForm(st.tokenEndpoint??'',{grant_type:DEVICE_GRANT,device_code:dv.code,client_id:st.clientId,resource:st.resource,client_secret:st.clientSecret},f);}
  catch{return {state:st,wait:dv.interval};}
  if(r.ok)return {state:{...st,accessToken:r.j.access_token,refreshToken:r.j.refresh_token,expiresAt:expiry(r.j,now),pending:undefined}};
  if(r.j.error==='authorization_pending')return {state:st,wait:dv.interval};
  // slow_down: this and every later poll wait 5 s longer.
  if(r.j.error==='slow_down'){const interval=dv.interval+5;return {state:{...st,pending:{...p,device:{...dv,interval}}},wait:interval};}
  throw new Error(`Sign-in failed: ${reason(r.j,r.status)}`);
}

export async function freshToken(st:OAuthState,f:Fetch=fetch,now:number=Date.now()):Promise<{token:string|null;state:OAuthState}>{
  if(st.accessToken&&(st.expiresAt===undefined||st.expiresAt-now>SKEW_MS))return {token:st.accessToken,state:st};
  if(!st.refreshToken)return {token:null,state:st};
  const url=checkUrl(st.tokenEndpoint??'');
  // No answer at all (offline, timeout) keeps the tokens for the next try. A refusal from the server clears them.
  let r:Posted;
  try{r=await postForm(url,{grant_type:'refresh_token',refresh_token:st.refreshToken,client_id:st.clientId,resource:st.resource,client_secret:st.clientSecret},f);}
  catch{return {token:null,state:st};}
  if(!r.ok)return {token:null,state:{...st,accessToken:undefined,refreshToken:undefined,expiresAt:undefined}};
  return {token:r.j.access_token,state:{...st,accessToken:r.j.access_token,refreshToken:r.j.refresh_token??st.refreshToken,expiresAt:expiry(r.j,now)}};
}

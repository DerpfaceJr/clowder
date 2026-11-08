import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {beginAuth, discover, finishAuth, freshToken, parseWwwAuthenticate} from '../src/mcp-oauth.ts';
import type {OAuthState} from '../src/connector-types.ts';

type Ctx={body:string;base:string};
type Reply={status?:number;json?:unknown};
type Handler=(c:Ctx)=>Reply|Promise<Reply>;
type Hit={path:string;body:string};

// A fake server on 127.0.0.1, port 0. Unknown paths answer 404. Every request is recorded before it is answered.
async function serve(routes:Record<string,Handler>,fn:(base:string,hits:Hit[])=>Promise<void>){
  const hits:Hit[]=[];
  let base='';
  const server=createServer((req,res)=>{
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',async()=>{
      const path=new URL(req.url??'/','http://127.0.0.1').pathname;
      hits.push({path,body});
      const r=await (routes[path]?.({body,base})??{status:404,json:{error:'not_found'}});
      res.writeHead(r.status??200,{'content-type':'application/json',connection:'close'});
      res.end(JSON.stringify(r.json??{}));
    });
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',()=>done()));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try{await fn(base,hits);}finally{await new Promise<void>(done=>server.close(()=>done()));}
}

// A fetch that fails the test if anything reaches it. Used where the code must refuse before any request.
const noNet=(async(u:unknown)=>{throw new Error(`network call to ${String(u)}`);}) as unknown as typeof fetch;
const REDIRECT='http://localhost/cb';
const sha=(v:string)=>createHash('sha256').update(v).digest('base64url');
const asMeta=(base:string,extra:Record<string,unknown>={})=>({issuer:base,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,registration_endpoint:`${base}/register`,code_challenge_methods_supported:['S256'],...extra});
const asAt=(path:string,extra:Record<string,unknown>={}):Record<string,Handler>=>({[path]:({base})=>({json:asMeta(base,extra)})});
// A protected resource (root document) and an authorization server with dynamic registration, on one fake server.
const signInRoutes=(token:Handler=()=>({json:{access_token:'at-1'}})):Record<string,Handler>=>({
  '/.well-known/oauth-protected-resource':({base})=>({json:{resource:`${base}/mcp`,authorization_servers:[base],scopes_supported:['mcp:tools']}}),
  ...asAt('/.well-known/oauth-authorization-server'),
  '/register':()=>({json:{client_id:'client-1'}}),
  '/token':token,
});

test('parseWwwAuthenticate reads the quoted Bearer parameters, commas inside quotes included', () => {
  assert.deepEqual(parseWwwAuthenticate('Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="files:read files:write"'),{resourceMetadata:'https://mcp.example/.well-known/oauth-protected-resource/mcp',scope:'files:read files:write'});
  assert.deepEqual(parseWwwAuthenticate('Bearer error="invalid_token", error_description="expired, sign in again", resource_metadata="https://h.example/p"'),{error:'invalid_token',resourceMetadata:'https://h.example/p'});
  assert.equal(parseWwwAuthenticate('Bearer scope="a\\"b"').scope,'a"b');
});

test('parseWwwAuthenticate takes unquoted values and any case of the scheme', () => {
  assert.deepEqual(parseWwwAuthenticate('bearer resource_metadata=https://h.example/p, error=insufficient_scope'),{resourceMetadata:'https://h.example/p',error:'insufficient_scope'});
  assert.deepEqual(parseWwwAuthenticate('BEARER scope="a"'),{scope:'a'});
});

test('parseWwwAuthenticate gives nothing without a Bearer challenge', () => {
  assert.deepEqual(parseWwwAuthenticate(null),{});
  assert.deepEqual(parseWwwAuthenticate('Basic realm="x", scope="y"'),{});
  assert.deepEqual(parseWwwAuthenticate('Bearer'),{});
});

test('discover takes the resource metadata the header names, and the header scope wins over scopes_supported', async () => {
  await serve({
    '/prm':({base})=>({json:{resource:`${base}/mcp`,authorization_servers:[`${base}/as`],scopes_supported:['x','y']}}),
    '/.well-known/oauth-protected-resource/mcp':()=>({json:{authorization_servers:['https://wrong.example']}}),
    ...asAt('/.well-known/oauth-authorization-server/as'),
  },async (base,hits)=>{
    const d=await discover(`${base}/mcp`,`Bearer resource_metadata="${base}/prm"`);
    assert.equal(d.authServer,`${base}/as`);
    assert.equal(d.resource,`${base}/mcp`);
    assert.equal(d.scope,'x y');
    assert.equal(d.metadata.token_endpoint,`${base}/token`);
    assert.equal(hits.some(h=>h.path==='/.well-known/oauth-protected-resource/mcp'),false);
    assert.equal((await discover(`${base}/mcp`,`Bearer resource_metadata="${base}/prm", scope="header:only"`)).scope,'header:only');
  });
});

test('discover tries the path-suffixed protected resource metadata before the root one', async () => {
  await serve({
    '/.well-known/oauth-protected-resource/mcp':({base})=>({json:{authorization_servers:[base]}}),
    '/.well-known/oauth-protected-resource':()=>({json:{authorization_servers:['https://root.example']}}),
    ...asAt('/.well-known/oauth-authorization-server'),
  },async (base,hits)=>{
    const d=await discover(`${base}/mcp#frag`,null);
    assert.equal(d.authServer,base);
    assert.equal(d.resource,`${base}/mcp`);
    assert.equal(hits.some(h=>h.path==='/.well-known/oauth-protected-resource'),false);
  });
});

test('discover falls back to the root protected resource metadata', async () => {
  await serve({
    '/.well-known/oauth-protected-resource':({base})=>({json:{resource:`${base}/mcp`,authorization_servers:[base]}}),
    ...asAt('/.well-known/oauth-authorization-server'),
  },async base=>{
    const d=await discover(`${base}/mcp`,null);
    assert.equal(d.authServer,base);
    assert.equal(d.resource,`${base}/mcp`);
  });
});

test('discover refuses protected resource metadata that names another service as its resource, before asking any sign-in server (security pass M2)', async () => {
  for(const named of [()=>'https://real-provider.example/mcp',(base:string)=>`${base}/other`,(base:string)=>`${base}`,()=>'not a url']){
    await serve({
      '/.well-known/oauth-protected-resource':({base})=>({json:{resource:named(base),authorization_servers:['https://real-provider.example']}}),
      ...asAt('/.well-known/oauth-authorization-server'),
    },async (base,hits)=>{
      await assert.rejects(discover(`${base}/mcp`,null),/sign-in details are for another address/,named(base));
      assert.equal(hits.some(h=>h.path.includes('oauth-authorization-server')),false,'no sign-in server is asked');
    });
  }
  // The connector's own address, a trailing slash aside, is its resource.
  await serve({'/.well-known/oauth-protected-resource':({base})=>({json:{resource:`${base}/mcp/`,authorization_servers:[base]}}),...asAt('/.well-known/oauth-authorization-server')},async base=>{
    assert.equal((await discover(`${base}/mcp`,null)).resource,`${base}/mcp/`);
  });
});

test('discover without protected resource metadata uses the server origin, and the server URL minus its hash', async () => {
  await serve(asAt('/.well-known/oauth-authorization-server'),async base=>{
    const d=await discover(`${base}/mcp#x`,null);
    assert.equal(d.authServer,base);
    assert.equal(d.resource,`${base}/mcp`);
    assert.equal(d.scope,undefined);
  });
});

test('discover falls back to OpenID Connect configuration, at the root and on a path issuer', async () => {
  await serve(asAt('/.well-known/openid-configuration'),async base=>{
    assert.equal((await discover(`${base}/mcp`,null)).authServer,base);
  });
  for(const p of ['/.well-known/openid-configuration/tenant','/tenant/.well-known/openid-configuration']){
    await serve({'/.well-known/oauth-protected-resource':({base})=>({json:{authorization_servers:[`${base}/tenant`]}}),...asAt(p)},async base=>{
      const d=await discover(`${base}/mcp`,null);
      assert.equal(d.authServer,`${base}/tenant`);
      assert.equal(d.metadata.token_endpoint,`${base}/token`);
    });
  }
});

test('discover refuses a sign-in server without PKCE S256', async () => {
  await serve(asAt('/.well-known/oauth-authorization-server',{code_challenge_methods_supported:['plain']}),async base=>{
    await assert.rejects(discover(`${base}/mcp`,null),/S256/);
  });
});

test('discover refuses a non-HTTPS endpoint that is not this machine, and a plain-http server URL to another host', async () => {
  await serve(asAt('/.well-known/oauth-authorization-server',{token_endpoint:'http://auth.example.com/token'}),async base=>{
    await assert.rejects(discover(`${base}/mcp`,null),/Refusing a non-HTTPS endpoint: http:\/\/auth\.example\.com\/token/);
  });
  await assert.rejects(discover('http://mcp.example.com/mcp',null,noNet),/Refusing a non-HTTPS endpoint/);
});

test('beginAuth registers a client once per redirect URI and reuses it otherwise', async () => {
  await serve(signInRoutes(),async (base,hits)=>{
    const registrations=()=>hits.filter(h=>h.path==='/register');
    const a=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT,now:1000});
    assert.equal(registrations().length,1);
    assert.deepEqual(JSON.parse(registrations()[0]!.body),{client_name:'Clowder',redirect_uris:[REDIRECT],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});
    assert.equal(a.state.clientId,'client-1');
    const b=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT,prior:a.state});
    assert.equal(registrations().length,1);
    assert.equal(b.state.clientId,'client-1');
    await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:'http://localhost/other',prior:a.state});
    assert.equal(registrations().length,2);
  });
});

test('beginAuth builds the authorization URL with PKCE, state and resource, keeping the endpoint query', async () => {
  await serve({
    ...signInRoutes(),
    '/.well-known/oauth-authorization-server':({base})=>({json:asMeta(base,{authorization_endpoint:`${base}/authorize?tenant=t1`})}),
  },async base=>{
    const {url,state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT,now:5000});
    const u=new URL(url);
    assert.equal(`${u.origin}${u.pathname}`,`${base}/authorize`);
    assert.equal(u.searchParams.get('tenant'),'t1');
    assert.equal(u.searchParams.get('response_type'),'code');
    assert.equal(u.searchParams.get('client_id'),'client-1');
    assert.equal(u.searchParams.get('redirect_uri'),REDIRECT);
    assert.equal(u.searchParams.get('code_challenge_method'),'S256');
    assert.equal(u.searchParams.get('resource'),`${base}/mcp`);
    assert.equal(u.searchParams.get('scope'),'mcp:tools');
    const verifier=state.pending!.verifier;
    assert.match(verifier,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(u.searchParams.get('code_challenge'),sha(verifier));
    assert.equal(u.searchParams.get('state'),state.pending!.state);
    assert.match(state.pending!.state,/^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(state.pending,{state:state.pending!.state,verifier,createdAt:5000});
    assert.equal(state.tokenEndpoint,`${base}/token`);
    assert.equal(state.redirectUri,REDIRECT);
  });
});

test('beginAuth refuses a server with no registration endpoint when there is no client yet', async () => {
  await serve(asAt('/.well-known/oauth-authorization-server',{registration_endpoint:undefined}),async base=>{
    await assert.rejects(beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT}),{message:'This service does not let new apps sign in on their own. Add an access token instead.'});
  });
});

test('finishAuth exchanges the code with the verifier behind the sent challenge, and stores the tokens', async () => {
  let challenge='';
  await serve(signInRoutes(({body})=>{
    const p=new URLSearchParams(body);
    if(sha(p.get('code_verifier')??'')!==challenge)return {status:400,json:{error:'invalid_grant',error_description:'verifier does not match'}};
    return {json:{access_token:'at-1',refresh_token:'rt-1',expires_in:3600}};
  }),async (base,hits)=>{
    const {url,state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT,now:1000});
    challenge=new URL(url).searchParams.get('code_challenge')!;
    const done=await finishAuth(state,'code-1',state.pending!.state,fetch,2000);
    assert.equal(done.accessToken,'at-1');
    assert.equal(done.refreshToken,'rt-1');
    assert.equal(done.expiresAt,2000+3_600_000);
    assert.equal(done.pending,undefined);
    assert.equal(done.clientId,'client-1');
    const form=new URLSearchParams(hits.find(h=>h.path==='/token')!.body);
    assert.equal(form.get('grant_type'),'authorization_code');
    assert.equal(form.get('code'),'code-1');
    assert.equal(form.get('redirect_uri'),REDIRECT);
    assert.equal(form.get('client_id'),'client-1');
    assert.equal(form.get('resource'),`${base}/mcp`);
    assert.equal(form.get('client_secret'),null);
  });
});

test('finishAuth refuses a returned state that does not match, and sends no token request', async () => {
  await serve(signInRoutes(),async (base,hits)=>{
    const {state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT});
    await assert.rejects(finishAuth(state,'code-1','not-the-state'),/did not match/);
    await assert.rejects(finishAuth(state,'code-1',state.pending!.state.slice(0,-1)),/did not match/);
    assert.equal(hits.some(h=>h.path==='/token'),false);
  });
});

test('finishAuth refuses a sign-in older than 10 minutes, and one with nothing pending', async () => {
  await serve(signInRoutes(),async base=>{
    const {state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT,now:1000});
    await assert.rejects(finishAuth(state,'code-1',state.pending!.state,fetch,1000+10*60_000+1),/took too long/);
    await assert.rejects(finishAuth({...state,pending:undefined},'code-1','x'),/No sign-in is waiting/);
  });
});

test('finishAuth reports the server reason when the token request fails', async () => {
  await serve(signInRoutes(()=>({status:400,json:{error:'invalid_grant',error_description:'code already used'}})),async base=>{
    const {state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT});
    await assert.rejects(finishAuth(state,'code-1',state.pending!.state),{message:'Sign-in failed: code already used'});
  });
});

test('finishAuth leaves expiresAt unset when the server gives no expires_in', async () => {
  await serve(signInRoutes(()=>({json:{access_token:'at-1'}})),async base=>{
    const {state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT});
    const done=await finishAuth(state,'code-1',state.pending!.state,fetch,1000);
    assert.equal(done.accessToken,'at-1');
    assert.equal(done.expiresAt,undefined);
    assert.equal(done.refreshToken,undefined);
  });
});

test('freshToken returns a token that does not expire within a minute, with no request', async () => {
  const st:OAuthState={accessToken:'a',refreshToken:'r',clientId:'c',tokenEndpoint:'https://auth.example.com/token',expiresAt:1000+61_000};
  const r=await freshToken(st,noNet,1000);
  assert.equal(r.token,'a');
  assert.equal(r.state,st);
});

test('freshToken refreshes a token that expires within a minute', async () => {
  await serve({'/token':({body,base})=>{
    const p=new URLSearchParams(body);
    if(p.get('grant_type')!=='refresh_token'||p.get('refresh_token')!=='rt-old'||p.get('client_id')!=='client-1'||p.get('resource')!==`${base}/mcp`)return {status:400,json:{error:'invalid_request'}};
    return {json:{access_token:'at-new',refresh_token:'rt-new',expires_in:3600}};
  }},async base=>{
    const st:OAuthState={accessToken:'at-old',refreshToken:'rt-old',clientId:'client-1',resource:`${base}/mcp`,tokenEndpoint:`${base}/token`,expiresAt:1000+30_000};
    const r=await freshToken(st,fetch,1000);
    assert.equal(r.token,'at-new');
    assert.equal(r.state.accessToken,'at-new');
    assert.equal(r.state.refreshToken,'rt-new');
    assert.equal(r.state.expiresAt,1000+3_600_000);
  });
});

test('freshToken keeps the old refresh token when the refresh gives none', async () => {
  await serve({'/token':()=>({json:{access_token:'at-new',expires_in:3600}})},async base=>{
    const r=await freshToken({accessToken:'at-old',refreshToken:'rt-old',clientId:'c',tokenEndpoint:`${base}/token`,expiresAt:1000},fetch,1000);
    assert.equal(r.token,'at-new');
    assert.equal(r.state.refreshToken,'rt-old');
  });
});

test('freshToken clears the tokens when the refresh fails, and keeps the client', async () => {
  await serve({'/token':()=>({status:400,json:{error:'invalid_grant'}})},async base=>{
    const r=await freshToken({accessToken:'at-old',refreshToken:'rt-old',clientId:'c',tokenEndpoint:`${base}/token`,expiresAt:1000},fetch,1000);
    assert.equal(r.token,null);
    assert.equal(r.state.accessToken,undefined);
    assert.equal(r.state.refreshToken,undefined);
    assert.equal(r.state.expiresAt,undefined);
    assert.equal(r.state.clientId,'c');
  });
});

test('freshToken keeps the tokens when the server gives no answer, and finishAuth says why it failed', async () => {
  const unreachable=(async()=>{throw new TypeError('fetch failed');}) as unknown as typeof fetch;
  const r=await freshToken({accessToken:'at-old',refreshToken:'rt-old',clientId:'c',tokenEndpoint:'https://auth.example.com/token',expiresAt:1000},unreachable,1000);
  assert.equal(r.token,null);
  assert.equal(r.state.accessToken,'at-old');
  assert.equal(r.state.refreshToken,'rt-old');
  await serve(signInRoutes(),async base=>{
    const {state}=await beginAuth({serverUrl:`${base}/mcp`,wwwAuthenticate:null,redirectUri:REDIRECT});
    await assert.rejects(finishAuth(state,'code-1',state.pending!.state,unreachable),{message:'Sign-in failed: fetch failed'});
  });
});

test('freshToken returns no token for an expired grant with no refresh token', async () => {
  const r=await freshToken({accessToken:'a',expiresAt:1000},noNet,1000);
  assert.equal(r.token,null);
});

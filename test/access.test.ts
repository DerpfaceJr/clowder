import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess,isOwner} from '../src/access.ts';
import {Pairing} from '../src/pairing.ts';
const remoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const KEY='access-test-owner-key',session=`town_owner_8787=${KEY}`;

async function fixture(enabled=true,pairing=new Pairing(join(mkdtempSync(join(tmpdir(),'cat-access-')),'devices.json'),remoteConfig)){
  const app=Fastify();installAccess(app,enabled,['192.168.1.20'],8787,pairing,undefined,KEY);
  app.get('/api/state',async req=>({readOnly:!isOwner(req)}));
  app.post('/api/pause',async()=>({ok:true}));
  await app.ready();return app;
}
test('LAN invitation is a one-time viewer pairing: read-only state; spoofed owner headers cannot mutate',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'cat-access-')),'devices.json'),pairing=new Pairing(file,remoteConfig);
  const app=await fixture(true,pairing);try{
    const owner={host:'localhost:8787',cookie:session},remote={host:'192.168.1.20:8787'};
    const share=await app.inject({url:'/api/sharing',headers:owner});assert.equal(share.statusCode,200);
    const token=new URL(share.json().urls[0]).hash.slice(6);
    const read=()=>app.inject({url:'/api/state',remoteAddress:'192.168.1.21',headers:remote});
    assert.equal((await read()).statusCode,401);
    const login=await app.inject({method:'POST',url:'/api/viewer-session',remoteAddress:'192.168.1.21',headers:remote,payload:{token}});
    assert.equal(login.statusCode,200);const cookie=String(login.headers['set-cookie']).split(';')[0];
    assert.match(String(login.headers['set-cookie']),/^town_device=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/,'plain http: no Secure, no __Host- prefix');
    assert.deepEqual(pairing.list().map(d=>[d.name,d.permission]),[['Same Wi-Fi viewer','viewer']],'the viewer shows in Devices');
    assert.equal((await app.inject({method:'POST',url:'/api/viewer-session',remoteAddress:'192.168.1.22',headers:remote,payload:{token}})).statusCode,403,'the link works once');
    const headers={...remote,cookie,'x-town-action':'owner'};
    const state=await app.inject({url:'/api/state',remoteAddress:'192.168.1.21',headers});assert.equal(state.statusCode,200);assert.equal(state.json().readOnly,true);
    assert.equal((await app.inject({method:'POST',url:'/api/pause',remoteAddress:'192.168.1.21',headers,payload:{value:true}})).statusCode,403);
    assert.equal((await app.inject({url:'/api/sharing',remoteAddress:'192.168.1.21',headers})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/pause',remoteAddress:'192.168.1.21',headers:{...headers,host:'localhost:8787','x-forwarded-for':'127.0.0.1'},payload:{value:true}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:{...owner,'x-town-action':'owner','x-forwarded-for':'203.0.113.9'},payload:{value:true}})).statusCode,403);
    assert.equal((await app.inject({url:'/api/sharing',headers:{...owner,'x-town-action':'owner',forwarded:'for=203.0.113.9',cookie}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:{...owner,'x-town-action':'owner'},payload:{value:true}})).statusCode,200);
    assert.equal((await app.inject({url:'/api/state',headers:{host:'evil.example:8787'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/viewer-session',headers:{...remote,origin:'http://evil.example'},payload:{token}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/viewer-session',headers:remote,payload:{token:'é'.repeat(64)}})).statusCode,403);
    // A paired viewer survives a restart, like any device, until it is revoked in Devices.
    const restarted=await fixture(true,new Pairing(file,remoteConfig));
    try{
      assert.equal((await restarted.inject({url:'/api/state',headers:{...remote,cookie},remoteAddress:'192.168.1.21'})).statusCode,200);
      pairing.revoke(pairing.list()[0]!.id);
    }finally{await restarted.close();}
    assert.equal((await read()).statusCode,401);
    assert.equal((await app.inject({url:'/api/state',headers:{...remote,cookie},remoteAddress:'192.168.1.21'})).statusCode,401,'revoked');
  }finally{await app.close();}
});
test('sharing is off by default and remote localhost impersonation is rejected',async()=>{
  const app=await fixture(false);try{
    assert.deepEqual((await app.inject({url:'/api/sharing',headers:{host:'localhost:8787',cookie:session}})).json(),{enabled:false,urls:[]});
    assert.equal((await app.inject({url:'/api/state',headers:{host:'localhost:8787'},remoteAddress:'192.168.1.21'})).statusCode,403);
    assert.equal((await app.inject({url:'/api/state',headers:{host:'192.168.1.20:8787'}})).statusCode,403);
  }finally{await app.close();}
});
test('this computer is the host only with this launch\'s owner session: the console link sets it; without it a local page gets the app but no data and no writes',async()=>{
  for(const enabled of [false,true]){
    const app=await fixture(enabled);try{
      // Every header the town's own page sends, from a browser on this computer that never opened the link: the cats' browser, say.
      const local={host:'localhost:8787',origin:'http://localhost:8787','x-town-action':'owner','content-type':'application/json'};
      assert.equal((await app.inject({url:'/api/state',headers:local})).statusCode,401,`LAN ${enabled}: no town data`);
      assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:local,payload:{value:true}})).statusCode,403,'no writes');
      assert.equal((await app.inject({url:'/api/sharing?permission=owner',headers:local})).statusCode,401,'no owner pairing code');
      assert.equal((await app.inject({url:'/api/state',headers:{...local,cookie:'town_owner_8787=an-older-key'}})).statusCode,401,'a key from an earlier start is no session');
      assert.equal((await app.inject({url:'/?owner=an-older-key',headers:local})).statusCode,404,'nor is an older link');
      // The console link: 303 to the same page without the key, with the session cookie.
      const link=await app.inject({url:`/?perf&owner=${KEY}`,headers:{host:'localhost:8787'}});
      assert.equal(link.statusCode,303);assert.equal(link.headers.location,'/?perf=');
      assert.equal(link.headers['set-cookie'],`town_owner_8787=${KEY}; HttpOnly; SameSite=Strict; Path=/`);
      const cookie=String(link.headers['set-cookie']).split(';')[0]!;
      assert.equal((await app.inject({url:'/api/state',headers:{...local,cookie}})).json().readOnly,false);
      assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:{...local,cookie},payload:{value:true}})).statusCode,200);
      // Off this computer the link and the cookie are nothing.
      const lan={host:'192.168.1.20:8787'};
      assert.notEqual((await app.inject({url:`/?owner=${KEY}`,headers:lan,remoteAddress:'192.168.1.21'})).statusCode,303);
      assert.equal((await app.inject({method:'POST',url:'/api/pause',headers:{...lan,cookie,'x-town-action':'owner'},remoteAddress:'192.168.1.21',payload:{value:true}})).statusCode,403);
    }finally{await app.close();}
  }
});

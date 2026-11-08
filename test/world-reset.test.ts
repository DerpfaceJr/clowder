import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerWorldResetRoute} from '../src/world-reset.ts';

const WORLD=['events.jsonl','workshop.jsonl','season-a.jsonl','season-a.lock','season-a.log'];
const CONFIG=['models.json','devices.json','push-subscriptions.json','vapid.json','town-settings.json'];

function setup(running:unknown=null,busy=false){
  const dir=mkdtempSync(join(tmpdir(),'world-reset-'));
  for(const f of [...WORLD,...CONFIG])writeFileSync(join(dir,f),'{}\n');
  mkdirSync(join(dir,'tunnel'));writeFileSync(join(dir,'tunnel','state.json'),'{}');
  const app=Fastify();
  const calls={paused:false};
  registerWorldResetRoute(app,{dataDir:dir,busy:()=>running?'A season is running. Stop it first.':busy?'Finish the current work or stop the town first.':null,town:{pause:v=>{calls.paused=v;}}});
  return {dir,app,calls};
}

test('reset moves world files to a backup and keeps configuration', async()=>{
  const {dir,app,calls}=setup();
  const res=await app.inject({method:'POST',url:'/api/world/reset',headers:{'content-type':'application/json'},payload:'{}'});
  assert.equal(res.statusCode,200);
  const body=res.json();
  assert.equal(body.restartRequired,true);
  assert.equal(calls.paused,true);
  assert.ok(body.backup.startsWith(join(dir,'backups')));
  for(const f of WORLD){
    assert.equal(existsSync(join(dir,f)),false,`${f} should have left the data dir`);
    assert.equal(existsSync(join(body.backup,f)),true,`${f} should be in the backup`);
  }
  for(const f of CONFIG)assert.equal(existsSync(join(dir,f)),true,`${f} must stay`);
  assert.equal(existsSync(join(dir,'tunnel','state.json')),true,'tunnel/ must stay');
});

test('a running season refuses the reset and moves nothing', async()=>{
  const {dir,app}=setup({name:'a'});
  const res=await app.inject({method:'POST',url:'/api/world/reset',payload:'{}',headers:{'content-type':'application/json'}});
  assert.equal(res.statusCode,409);
  for(const f of WORLD)assert.equal(existsSync(join(dir,f)),true,`${f} must stay`);
});

test('a busy town refuses the reset and moves nothing', async()=>{
  const {dir,app}=setup(null,true);
  const res=await app.inject({method:'POST',url:'/api/world/reset',payload:'{}',headers:{'content-type':'application/json'}});
  assert.equal(res.statusCode,409);
  assert.equal(existsSync(join(dir,'events.jsonl')),true);
});

test('a proxied request gets 403 and moves nothing', async()=>{
  const {dir,app}=setup();
  const res=await app.inject({method:'POST',url:'/api/world/reset',payload:'{}',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.9'}});
  assert.equal(res.statusCode,403);
  assert.equal(existsSync(join(dir,'events.jsonl')),true);
});

test('a remote (non-loopback) request gets 403', async()=>{
  const {dir,app}=setup();
  const res=await app.inject({method:'POST',url:'/api/world/reset',payload:'{}',headers:{'content-type':'application/json'},remoteAddress:'192.168.1.20'});
  assert.equal(res.statusCode,403);
  assert.equal(existsSync(join(dir,'events.jsonl')),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.ts';
import {installAccess} from '../src/access.ts';
import {recordBalance,registerTreasury} from '../src/treasury.ts';

test('treasury preserves unknown, exact cents, zero, deficits and durable history',()=>{
 const dir=mkdtempSync(join(tmpdir(),'town-funds-')),file=join(dir,'events.jsonl');
 try{
  const store=new Store(file,[]);assert.equal(store.state.treasury,null);
  recordBalance(store,'0.10','CAD','Initial funds');assert.equal(store.state.treasury!.amountMinor,10);
  recordBalance(store,'0','USD');assert.equal(store.state.treasury!.amountMinor,0);
  recordBalance(store,'-25.51','EUR');assert.equal(store.state.treasury!.amountMinor,-2551);
  const reopened=new Store(file,[]);assert.deepEqual(reopened.state.treasury,store.state.treasury);
  assert.equal(reopened.state.events.filter(e=>e.type==='treasury.recorded').length,3);
  for(const value of ['NaN','1e4','1.001','','Infinity','12,000','1000000000000'])assert.throws(()=>recordBalance(store,value,'CAD'));
  assert.throws(()=>recordBalance(store,'1','XXX'));assert.equal(store.state.treasury!.amountMinor,-2551);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('only local owner can record funds through the guarded route',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'town-funds-access-')),store=new Store(join(dir,'events.jsonl'),[]),app=Fastify();
 installAccess(app,true,['192.168.1.20'],8787,undefined,undefined,'test-owner');registerTreasury(app,store);
 try{
  const payload={amount:'125.50',currency:'CAD',note:'Test balance'},headers={host:'localhost:8787',cookie:'town_owner_8787=test-owner','x-town-action':'owner'};
  assert.equal((await app.inject({method:'POST',url:'/api/treasury',headers,payload})).statusCode,200);
  assert.equal(store.state.treasury!.amountMinor,12550);
  for(const bad of [{headers:{...headers,origin:'https://foreign.example'}},{headers:{host:'localhost:8787',cookie:'town_owner_8787=test-owner'}},{headers,remoteAddress:'192.168.1.21'}]){
   assert.equal((await app.inject({method:'POST',url:'/api/treasury',payload:{...payload,amount:'999'},...bad})).statusCode,403);
  }
  assert.equal(store.state.treasury!.amountMinor,12550);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

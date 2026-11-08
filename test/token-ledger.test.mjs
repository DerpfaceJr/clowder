import test from 'node:test';
import assert from 'node:assert/strict';
import {chatTokens,formatTokens,treasuryShort} from '../public/treasury-view.js';
import {seasonTokens} from '../src/season-view.ts';

test('chat tokens group by provider, skip demo, and count unreported calls apart', () => {
  const t=chatTokens([
    {mode:'claude',input:1000,output:200},{mode:'plan',input:500,output:100},{mode:'local',input:null,output:null},
    {mode:'demo',input:null,output:null},{mode:'chatgpt',input:10,output:5},
  ]);
  assert.deepEqual(t.rows.map(r=>[r.provider,r.input,r.output,r.calls,r.unknown]),[['Claude plan',1500,300,2,0],['ChatGPT plan',10,5,1,0],['Local AI',0,0,1,1]]);
  assert.deepEqual([t.calls,t.input,t.output,t.unknown],[4,1510,305,1]);
  assert.equal(chatTokens([]).calls,0);
  assert.equal(formatTokens(151000),'151k');assert.equal(formatTokens(1510000),'1.5M');assert.equal(formatTokens(950),'950');
});

test('season tokens leave out Jev and count unknown usage', () => {
  const t=seasonTokens([{type:'usage',cat:'a',input:100,output:20},{type:'usage',cat:'b',input:null,output:null},{type:'usage',cat:'c',provider:'jev',input:null,output:null}]);
  assert.deepEqual(t,{calls:2,input:100,output:20,unknown:1});
});

test('the phone pill label is short and keeps unreported usage visibly partial', () => {
  const funds = {currency:'CAD',amountMinor:123456};
  assert.equal(treasuryShort('tokens',null,{total:1700000,calls:3,unknown:0}),'1.7M');
  assert.equal(treasuryShort('tokens',null,{total:1700000,calls:3,unknown:1}),'1.7M+');
  assert.equal(treasuryShort('tokens',null,{total:0,calls:2,unknown:2}),'—');
  assert.equal(treasuryShort('both',funds,{total:950,calls:1,unknown:0}),'950');
  assert.equal(treasuryShort('money',null,{total:0,calls:0,unknown:0}),'Not set');
  assert.match(treasuryShort('money',funds,{total:0,calls:0,unknown:0}),/^CAD\s?1[.,]2K$/);
});

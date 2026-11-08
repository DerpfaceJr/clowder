import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {QUALITIES,QUALITY_KEY,savedQuality,startTier,tierFor,stepTier} from '../public/quality.js';
import {summarizeAppearance} from '../public/settings-menu.js';

const store=v=>({getItem:k=>k===QUALITY_KEY?v:null});

test('the saved choice: ?quality= first, then storage; unknown or unreadable storage reads as auto',()=>{
  assert.equal(savedQuality('?quality=high',store('low')),'high');
  assert.equal(savedQuality('?quality=ultra',store('low')),'low');
  assert.equal(savedQuality('',store('nonsense')),'auto');
  assert.equal(savedQuality('',{getItem(){throw Error('blocked');}}),'auto');
  assert.equal(savedQuality('',null),'auto');
});

test('phones start Low and computers Medium; High is desktop only',()=>{
  assert.equal(startTier(true),'low');assert.equal(startTier(false),'medium');
  assert.equal(tierFor('auto','medium',false),'medium');
  assert.equal(tierFor('high','low',false),'high');
  assert.equal(tierFor('high','low',true),'medium','a phone asked for High draws Medium');
  assert.equal(tierFor('auto','nonsense',true),'low');
});

test('auto steps one tier at a time, never past its ceiling or High on phones',()=>{
  assert.equal(stepTier('medium',-1,false),'low');
  assert.equal(stepTier('low',-1,false),'low');
  assert.equal(stepTier('medium',1,false),'high');
  assert.equal(stepTier('medium',1,true),'medium','phones stop at Medium');
  assert.equal(stepTier('low',1,false,'low'),'low','a tier auto had to leave is not climbed back to');
  assert.equal(stepTier('low',1,false,'medium'),'medium');
});

test('the ☰ Appearance page has the Graphics quality row, and its subtitle names the choice',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const page=html.slice(html.indexOf('id="settings-appearance"'),html.indexOf('id="settings-town"'));
  assert.ok(page.includes('id="settings-quality"')&&page.includes('id="quality-switch"'));
  for(const q of QUALITIES)assert.ok(page.includes(`data-quality="${q}"`),q);
  assert.equal(summarizeAppearance('Day','auto','medium'),'Day · House names auto · Graphics medium');
});

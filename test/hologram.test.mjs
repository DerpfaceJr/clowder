import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {oneLiner} from '../public/one-liner.js';
import {fitBubble} from '../public/hologram.js';
import {MessageVisits} from '../public/world-motion.js';
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url)));
const cats=[{id:'mayor',home:{x:-8,z:8}},{id:'scholar',home:{x:0,z:8}}];

test('oneLiner keeps only the first sentence and strips markdown and extra whitespace',()=>{
  assert.equal(oneLiner('Research fish demand. Then write it up.'),'Research fish demand');
  assert.equal(oneLiner('  **Approve**   80   coins for `café` now  '),'Approve 80 coins for café now');
  assert.equal(oneLiner('# Review\n> the draft'),'Review');
  assert.equal(oneLiner('...Approve it! Yes?'),'Approve it');
  assert.equal(oneLiner('Finish in the cats’ browser: developers.facebook.com',120),'Finish in the cats’ browser: developers.facebook.com','a dot inside a site name or version is not a sentence end');
  assert.equal(oneLiner('Mayor wants to use GitHub: push_files',120),'Mayor wants to use GitHub: push_files','an underscore inside a name stays');
  assert.equal(oneLiner('_draft_ notes'),'draft notes','an underscore used as emphasis goes');
});

test('oneLiner caps long text at max characters with an ellipsis on a word boundary',()=>{
  const long='Research the seasonal demand for dried fish across the three harbour markets this week';
  const short=oneLiner(long);
  assert.ok(short.length<=40);assert.ok(short.endsWith('…'));assert.equal(short,'Research the seasonal demand for dried…');
  assert.equal(oneLiner('abcdefghijkl',5),'abcd…');
  assert.ok(oneLiner(long,10).length<=10);
});

test('oneLiner returns an empty string for empty or punctuation-only text',()=>{
  assert.equal(oneLiner(''),'');assert.equal(oneLiner('   \n '),'');assert.equal(oneLiner(undefined),'');assert.equal(oneLiner('...'),'');
});

test('a courier visit carries the message text its speech bubble is built from',()=>{
  const visits=new MessageVisits();visits.ingest([],cats);
  visits.ingest([{id:'m1',from:'mayor',to:'scholar',text:'Approve 80 coins for café? Details follow.'}],cats);
  const v=visits.start(cats,null);
  assert.equal(v.message.text,'Approve 80 coins for café? Details follow.');
  assert.equal(oneLiner(v.message.text),'Approve 80 coins for café');
});

test('fitBubble keeps the bubble the same on-screen height at any zoom',()=>{
  const sprite={scale:{set(x,y){this.x=x;this.y=y;}},userData:{aspect:2}},camera={top:18,bottom:-18,zoom:1};
  fitBubble(sprite,camera,800,50);const height=sprite.scale.y;
  assert.ok(Math.abs(height-50*36/800)<1e-9);assert.ok(Math.abs(sprite.scale.x-2*height)<1e-9);
  camera.zoom=3;fitBubble(sprite,camera,800,50);assert.ok(Math.abs(sprite.scale.y-height/3)<1e-9);
});

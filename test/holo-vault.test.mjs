import test from 'node:test';
import assert from 'node:assert/strict';
import {liftClear,unionBox,textScale,textCanvasSize,TEXT_SCALE_MAX,bubbleTexture,speechBubble,iconTexture,iconPx,ICON_MIN_PX,ICON_MAX_PX,BUBBLE_PX,FONT_PX,disposeSprite} from '../public/hologram.js';
import {formatFunds,formatTokens,usedTokens,tokensText,treasuryText,treasuryMode,saveTreasuryMode} from '../public/treasury-view.js';

// A canvas stand-in: the 2D context accepts every draw call and measures each character as 8 px.
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>new Proxy({},{get:(o,k)=>k in o?o[k]:k==='measureText'?s=>({width:s.length*8}):()=>{},set:(o,k,v)=>{o[k]=v;return true;}})})};

const overlaps=(a,b)=>Math.abs(a.x-b.x)<(a.width+b.width)/2&&Math.abs(a.y-b.y)<(a.height+b.height)/2;

test('a name label over a hologram stack rises above it and never overlaps',()=>{
  const holo={x:400,y:300,width:40,height:120},label={x:405,y:280,width:70,height:36};
  const y=liftClear(label,[holo]);
  assert.ok(Math.abs(y-(300-(120+36)/2-4))<1e-3);assert.ok(!overlaps({...label,y},holo));
  // A label already clear of the stack stays where it is, and a label is never pushed down.
  assert.equal(liftClear({...label,y:100},[holo]),100);assert.equal(liftClear({...label,x:600},[holo]),280);
});

test('a label clears a column of stacked holograms, and random layouts never overlap',()=>{
  const boxes=[{x:400,y:300,width:40,height:60},{x:410,y:240,width:50,height:40},{x:395,y:190,width:44,height:30}];
  const label={x:400,y:310,width:80,height:36},y=liftClear(label,boxes);
  for(const b of boxes)assert.ok(!overlaps({...label,y},b));
  let seed=7;const rand=()=>((seed=seed*16807%2147483647)/2147483647);
  for(let n=0;n<500;n++){
    const list=Array.from({length:1+Math.floor(rand()*6)},()=>({x:rand()*800,y:rand()*600,width:20+rand()*120,height:20+rand()*160}));
    const rect={x:rand()*800,y:rand()*600,width:56+rand()*100,height:36},lifted=liftClear(rect,list);
    assert.ok(lifted<=rect.y);for(const b of list)assert.ok(!overlaps({...rect,y:lifted},b),`case ${n}`);
  }
});

test('unionBox holds every part of a hologram stack',()=>{
  const u=unionBox([{x:100,y:50,width:40,height:40},{x:110,y:140,width:60,height:20}]);
  assert.deepEqual(u,{x:110,y:90,width:60,height:120});
});

test('hologram text renders at the device pixel ratio, at least 2x and capped',()=>{
  assert.equal(textScale(1),2);assert.equal(textScale(2.5),2.5);assert.equal(textScale(4),TEXT_SCALE_MAX);
  assert.deepEqual(textCanvasSize(100.2,41,2.5),{width:251,height:103});
  // The icon keeps its world size until that would fall under the minimum or over the cap on screen.
  assert.equal(iconPx(2),ICON_MIN_PX);assert.equal(iconPx(40),54);assert.equal(iconPx(500),ICON_MAX_PX);
  // The bubble sprite is fitted to BUBBLE_PX, which is the canvas height, so FONT_PX is the real on-screen size.
  assert.ok(FONT_PX>=13);
});

test('bubble textures are sized to the text, linear-filtered without mipmaps, and cached per line',()=>{
  const a=bubbleTexture('Approve 80 coins',2);
  assert.equal(a.texture.image.height,BUBBLE_PX*2);assert.equal(a.texture.image.width,Math.ceil(('Approve 80 coins'.length*8+34)*2));
  assert.equal(a.texture.generateMipmaps,false);assert.equal(a.texture.minFilter,1006);
  assert.equal(bubbleTexture('Approve 80 coins',2),a);assert.notEqual(bubbleTexture('Approve 80 coins',3),a);
  // Two bubbles with the same line share one texture, and disposing a bubble keeps the cached texture alive.
  const s1=speechBubble('Approve 80 coins. Details follow.'),s2=speechBubble('Approve 80 coins!');
  assert.equal(s1.material.map,s2.material.map);
  let disposed=0;s1.material.map.addEventListener('dispose',()=>disposed++);disposeSprite(s1);assert.equal(disposed,0);
  // The cache is bounded: old lines are evicted and disposed.
  const first=bubbleTexture('line 0',2);let evicted=0;first.texture.addEventListener('dispose',()=>evicted++);
  for(let i=1;i<40;i++)bubbleTexture('line '+i,2);
  assert.equal(evicted,1);assert.notEqual(bubbleTexture('line 0',2),first);
});

test('reaction icons share one texture per kind and scale',()=>{
  const work=iconTexture('work',2);
  assert.equal(iconTexture('work',2),work);assert.notEqual(iconTexture('question',2),work);
  assert.equal(work.image.width,ICON_MAX_PX*2);assert.equal(work.image.height,ICON_MAX_PX*2);
  assert.equal(work.generateMipmaps,false);
});

test('the vault line shows money left, tokens used, or both on one line',()=>{
  const funds={currency:'CAD',amountMinor:10000},tokens={total:151400,calls:3,unknown:0};
  assert.equal(treasuryText('money',funds,tokens),formatFunds(funds));
  assert.equal(treasuryText('tokens',funds,tokens),`${formatTokens(151400)} tokens`);
  assert.equal(treasuryText('both',funds,tokens),`${formatFunds(funds)} · 151k tokens`);
  assert.equal(treasuryText('both',null,tokens),'Not set · 151k tokens');
  assert.ok(!treasuryText('both',funds,tokens).includes('\n'));
});

test('unreported tokens are never shown as zero',()=>{
  assert.equal(tokensText({total:0,calls:0,unknown:0}),'0 tokens');
  assert.equal(tokensText({total:0,calls:2,unknown:2}),'tokens unreported');
  assert.equal(tokensText({total:12000,calls:3,unknown:1}),'12k+ tokens');
});

test('tokens used adds the chat ledger and every season, as the Moonvault total does',()=>{
  const usage=[{mode:'claude',input:100000,output:20000},{mode:'demo',input:5,output:5},{mode:'local'}];
  const t=usedTokens(usage,[{name:'s1',tokens:{calls:2,input:30000,output:1400,unknown:0}}]);
  assert.deepEqual(t,{total:151400,calls:4,unknown:1});
});

test('the display mode defaults to money with a balance, tokens without, and survives storage errors',()=>{
  const store=new Map(),storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
  assert.equal(treasuryMode({amountMinor:1},storage),'money');assert.equal(treasuryMode(null,storage),'tokens');
  saveTreasuryMode('both',storage);assert.equal(treasuryMode(null,storage),'both');
  store.set('clowder.treasuryShow','bogus');assert.equal(treasuryMode(null,storage),'tokens');
  const broken={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
  assert.equal(treasuryMode({amountMinor:1},broken),'money');assert.doesNotThrow(()=>saveTreasuryMode('both',broken));
});

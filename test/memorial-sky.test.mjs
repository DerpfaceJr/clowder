import test from 'node:test';
import assert from 'node:assert/strict';
import {skyLayout,memorialPanel,memorialRows,NO_STARS,constellationName} from '../public/memorial.js';

const cat=(id,group,extra={})=>({id,name:id[0].toUpperCase()+id.slice(1),role:'Research',group,color:'#52718c',look:{fur:'#f2a14f'},retiredAt:'2026-10-2'+(id.length%9)+'T09:00:00.000Z',council:'c-'+id,reason:'Done.',roads:[{messages:id.length}],...extra});
const retired=[cat('vega','g1'),cat('altair','g1'),cat('deneb','g1'),cat('mira','g2'),cat('lyra','g2'),cat('polaris','main')];
const rowsOf=list=>memorialRows(list,[],id=>id);

test('rows carry the cat colour, hamlet and road messages for the chart',()=>{
  const row=rowsOf([cat('vega','g1',{appearance:{fur:'#ffffff'}})])[0];
  assert.deepEqual([row.color,row.group,row.deeds],['#ffffff','g1',4]);
  assert.equal(rowsOf([cat('mira','g2')])[0].color,'#f2a14f');
});

test('the chart layout is finite and the same for a set of cats whatever their order',()=>{
  const a=skyLayout(rowsOf(retired),.6),b=skyLayout(rowsOf(retired.slice().reverse()),.6);
  assert.deepEqual(a,b);
  assert.equal(a.stars.length,retired.length);
  for(const s of a.stars){
    for(const v of [s.x,s.y,s.mag,s.phase])assert.ok(Number.isFinite(v),`${s.id} has a non-finite value`);
    assert.ok(s.x>=0&&s.x<=a.width&&s.y>=0&&s.y<=a.height,`${s.id} is off the chart`);
  }
  for(const f of a.figures)for(const stroke of f.strokes)for(const [x,y] of stroke)assert.ok(Number.isFinite(x)&&Number.isFinite(y));
  // Brighter for more messages: deneb (5) beats vega (4); polaris (7) is the brightest.
  const mag=id=>a.stars.find(s=>s.id===id).mag;assert.ok(mag('deneb')>mag('vega'));assert.equal(mag('polaris'),1);
  // Hostile input stays finite: no dates, no colour, no roads, an aspect of zero.
  const odd=skyLayout([{id:'x',name:'X'},{id:'y',name:'Y',retiredAt:'nonsense',deeds:NaN,color:'url(javascript:1)'}],0);
  for(const s of odd.stars){assert.ok(Number.isFinite(s.x)&&Number.isFinite(s.y)&&Number.isFinite(s.mag));assert.match(s.color,/^#[0-9a-f]{6}$/i);}
});

test('constellations connect only cats of the same hamlet, as one chain each',()=>{
  const sky=skyLayout(rowsOf(retired));
  assert.equal(sky.figures.length,3);
  for(const [i,j] of sky.lines)assert.equal(sky.stars[i].group,sky.stars[j].group,'a line crosses constellations');
  const lines=group=>sky.lines.filter(([i])=>sky.stars[i].group===group).length;
  assert.deepEqual([lines('g1'),lines('g2'),lines('main')],[2,1,0]);
  // Cats with no hamlet group by role instead.
  const byRole=skyLayout([{id:'a',role:'Scout'},{id:'b',role:'Scout'},{id:'c',role:'Cook'}]);
  assert.deepEqual(byRole.figures.map(f=>f.label),['Cook','Scout']);
  for(const [i,j] of byRole.lines)assert.equal(byRole.stars[i].group,byRole.stars[j].group);
  assert.equal(constellationName('main'),'Town centre');assert.equal(constellationName('g3'),'Nook 3');
});

// A small stand-in for the browser DOM: enough for the panel builder to run its real code in Node (no canvas context,
// no observers, so nothing draws; the structure and text are what is checked).
class Node_{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.style={};this.listeners={};this.hidden=false;this.ownText='';}
  get textContent(){return this.ownText+this.children.map(c=>c.textContent).join('');}
  set textContent(v){this.ownText=String(v);this.children=[];}
  append(...nodes){for(const n of nodes)this.children.push(typeof n==='string'?Object.assign(new Node_('#text'),{ownText:n}):n);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(k,v){this.attributes[k]=String(v);}getAttribute(k){return this.attributes[k]??null;}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  dispatchEvent(e){for(const fn of this.listeners[e.type]||[])fn(e);}
  click(){this.onclick?.();}
  all(test){return [this,...this.children.flatMap(c=>c.all?c.all(test):[])].filter(test);}
}
function withDom(fn){
  const head=new Node_('head'),saved=globalThis.document;
  globalThis.document={head,createElement:t=>new Node_(t),createTextNode:t=>Object.assign(new Node_('#text'),{ownText:t})};
  try{return fn(head);}finally{if(saved===undefined)delete globalThis.document;else globalThis.document=saved;}
}

test('the empty sky renders one quiet line, a canvas and no stars',()=>withDom(head=>{
  const [wrap]=memorialPanel([]);
  assert.ok(wrap.textContent.includes(NO_STARS));
  assert.equal(wrap.all(n=>n.tagName==='CANVAS').length,1);
  assert.equal(wrap.all(n=>n.tagName==='LI').length,0);
  assert.equal(head.all(n=>n.tagName==='LINK'&&String(n.href).endsWith('/memorial-sky.css')).length,1,'styles come from memorial-sky.css');
  // The List toggle keeps the same quiet line.
  const toggle=wrap.all(n=>n.tagName==='BUTTON'&&n.textContent==='List')[0];toggle.click();
  assert.ok(wrap.textContent.includes(NO_STARS));assert.equal(wrap.all(n=>n.tagName==='CANVAS').length,0);
  toggle.click();assert.equal(wrap.all(n=>n.tagName==='CANVAS').length,1,'back to the sky');
}));

test('every star is in the hidden list, and its card restores through the app hook',()=>withDom(()=>{
  const restored=[],rows=rowsOf(retired);
  const [wrap]=memorialPanel(rows,{canRestore:true,disabled:false,onRestore:(id,button)=>restored.push([id,button.tagName])});
  const stars=wrap.all(n=>n.tagName==='LI');assert.equal(stars.length,retired.length);
  const card=wrap.all(n=>n.className==='sky-card')[0];assert.equal(card.hidden,true);
  const first=stars[0].children[0];first.click();
  assert.equal(card.hidden,false);
  const name=card.all(n=>n.tagName==='STRONG')[0].textContent;assert.ok(first.textContent.startsWith(name+','));
  assert.ok(card.textContent.includes('Reason: Done.'));
  card.all(n=>n.tagName==='BUTTON'&&n.textContent==='Restore')[0].click();
  assert.equal(restored.length,1);assert.equal(restored[0][1],'BUTTON');assert.equal(rows.find(r=>r.name===name).id,restored[0][0]);
  // Read-only viewers get no Restore control; List view shows every cat as a card.
  const [readOnly]=memorialPanel(rows,{canRestore:false});readOnly.all(n=>n.tagName==='LI')[0].children[0].click();
  assert.equal(readOnly.all(n=>n.tagName==='BUTTON'&&n.textContent==='Restore').length,0);
}));

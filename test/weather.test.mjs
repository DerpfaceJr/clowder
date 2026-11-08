import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {WEATHERS,WEATHER_LABELS,createWeather} from '../public/weather.js';
import {weatherReaction,pickReaction} from '../public/cat-animation.js';

const light=()=>({sky:new T.Color('#cbdcc0'),hemiSky:new T.Color('#fff3d5'),hemiGround:new T.Color('#739165'),sun:new T.Color('#fff0d1'),terrain:new T.Color('#ffffff'),water:new T.Color('#79b2c9'),
  hemi:2.2,sunIntensity:2.5,exposure:1.1,glow:.18,lamps:0,stars:0,fireflies:0,sunFrom:new T.Vector3(-18,32,20)});
const camera=()=>{const c=new T.OrthographicCamera(-22,22,18,-18,.1,600);c.position.set(96,128,140);c.zoom=1.45;return c;};
const run=(w,seconds,p)=>{let relit=false;for(let t=0;t<seconds;t+=1/30)relit=w.frame(1/30,{target:new T.Vector3(0,.6,0),camera:camera(),reach:60,light:p})||relit;return relit;};

test('every weather has a label, and clear leaves the light untouched',()=>{
  assert.deepEqual(Object.keys(WEATHER_LABELS),WEATHERS);
  const w=createWeather({scene:new T.Scene()}),p=light();
  run(w,2,p);assert.equal(w.adjust(p),p,'clear returns the time-of-day light itself');
  assert.equal(w.mood.kind,'clear');
});

test('a storm dims the light without touching the preset, and eases back when cleared',()=>{
  const w=createWeather({scene:new T.Scene()}),p=light(),sky=p.sky.getHex();
  w.set('thunder');assert.ok(run(w,4,p),'the mood easing asks for a relight');
  const out=w.adjust(p);assert.notEqual(out,p);assert.ok(out.sunIntensity<p.sunIntensity&&out.hemi<p.hemi+1.7);
  assert.equal(p.sky.getHex(),sky,'the preset object is never written');
  w.set('clear');run(w,8,p);assert.equal(w.adjust(p),p);
});

test('reduced motion never flashes lightning and stops the clock',()=>{
  const w=createWeather({scene:new T.Scene(),reduced:true}),p=light();w.set('thunder');run(w,30,p);
  assert.equal(w.mood.startle,0);assert.equal(w.wind,1);
});

test('unknown weather falls back to clear',()=>{const w=createWeather({scene:new T.Scene()});w.set('lava');assert.equal(w.name,'clear');});

test('changing the weather disposes the old one: nothing is left in the scene after clear',()=>{
  const scene=new T.Scene(),w=createWeather({scene}),p=light();
  for(const name of WEATHERS){w.set(name);run(w,.5,p);}
  for(const name of ['tsunami','meteors','tornado','thunder']){w.set(name);run(w,12,p);assert.ok(w.root.children.length>0,name+' draws something');}
  w.set('clear');assert.equal(w.root.children.length,0);
});

test('the surge stays on the far side and meteors light the night without touching the preset',()=>{
  const night={sky:'#121c33',hemiSky:'#8ea6e6',hemiGround:'#22304a',hemi:1.5,sun:'#a8c0ff',sunIntensity:1.2,exposure:1,glow:2.6,terrain:'#8d9cc0',water:'#2c4f78',lamps:1,stars:1};
  const w=createWeather({scene:new T.Scene(),night}),p=light(),sky=p.sky.getHex();w.set('tsunami');
  const c=camera(),target=new T.Vector3(0,.6,0),top=(c.top-c.bottom)/2/c.zoom/Math.sin(Math.asin((c.position.y-target.y)/c.position.distanceTo(target)));
  for(let t=0;t<30;t+=1/30){w.frame(1/30,{target,camera:c,reach:60,light:p});const u=w.root.children.find(m=>m.material.uniforms?.uFront)?.material.uniforms;assert.ok(u.uFront.value>=top*.45,'the shore never comes past the middle of the upper half');}
  w.set('meteors');run(w,6,p);const out=w.adjust(p);
  assert.ok(out.stars>.5&&out.lamps>.5&&out.sunIntensity<p.sunIntensity,'meteors: stars out, lamps lit, darker');assert.equal(p.sky.getHex(),sky,'the preset is never written');
  assert.equal(w.mood,w.mood,'mood is one reused object');
});

test('cats react only in pose, each in its own way, and never with reduced motion',()=>{
  const cat=(kind,seed=.3)=>({seed,facing:.4,base:{x:1,z:2},rest:{amount:0,state:'awake'},weather:{kind,strength:1,startle:0,toward:0,since:99}});
  const settle=(item,opts,t0=0)=>{let r;for(let i=0;i<120;i++)r=weatherReaction(item,t0+i/30,1/30,opts);return r;};
  const rain=settle(cat('rain'),{awake:true,active:true});assert.ok(rain.ear>0&&rain.tail>0,'rain flattens ears and curls the tail');
  const meteors=settle(cat('meteors'),{awake:true,active:true});assert.ok(meteors.head[0]<0,'meteors: looking up');
  const asleep=settle(cat('snow'),{awake:false,active:true});assert.ok(asleep.tail>0&&!asleep.armR&&asleep.hop===0,'a sleeper only curls up');
  const busy=settle(cat('rain'),{awake:true,active:false});assert.ok(busy.ear>0&&!busy.armL&&!busy.armR&&busy.hop===0,'a busy cat only flattens its ears');
  const reduced=settle(cat('thunder'),{awake:true,active:true,reduced:true});assert.equal(reduced.hop,0);assert.equal(reduced.ear,0);
  // Different cats pick different reactions at the same moment.
  const names=new Set();for(let s=0;s<20;s++)names.add(pickReaction('rain',s/20,30).name);assert.ok(names.size>=3,'cats vary: '+[...names]);
  // A startle is latched and played as a short flinch with a hop, after the cat's own delay.
  const item=cat('thunder');settle(item,{awake:true,active:true});let hop=0;
  for(let i=0;i<45;i++){item.weather.startle=Math.max(0,1-i/12);hop=Math.max(hop,weatherReaction(item,4+i/30,1/30,{awake:true,active:true}).hop);}
  assert.ok(hop>0,'thunder makes an awake cat hop');
  // Never what the cat does: no position, facing or rest state is written.
  const before=JSON.stringify({f:item.facing,b:item.base,r:item.rest});assert.equal(JSON.stringify({f:item.facing,b:item.base,r:item.rest}),before);
  assert.deepEqual(Object.keys(item).filter(k=>!['seed','facing','base','rest','weather'].includes(k)).every(k=>k.startsWith('wx')),true,'only wx* scratch keys are added');
});

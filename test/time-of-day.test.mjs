import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TIMES,LIGHT_COLOURS,LIGHT_NUMBERS} from '../public/time-of-day.js';

const settings=JSON.parse(readFileSync(new URL('../public/presentation.config.json',import.meta.url),'utf8'));

test('every time of day has a preset, in menu order, and the ease is about a second',()=>{
  assert.deepEqual(TIMES,['dawn','day','sunset','night']);
  assert.deepEqual(Object.keys(settings.timesOfDay),TIMES);
  assert.ok(settings.timeOfDayEaseSeconds>0&&settings.timeOfDayEaseSeconds<=3);
  assert.ok(TIMES.includes(settings.defaultView));
});

test('each preset is complete and valid: colours parse, numbers in range, the sun above the ground',()=>{
  const keys=[...LIGHT_COLOURS,...Object.keys(LIGHT_NUMBERS),'sunFrom'].sort();
  for(const [name,p] of Object.entries(settings.timesOfDay)){
    assert.deepEqual(Object.keys(p).sort(),keys,`${name} sets exactly the light keys`);
    for(const k of LIGHT_COLOURS)assert.match(p[k],/^#[0-9a-f]{6}$/i,`${name}.${k}`);
    for(const [k,[lo,hi]] of Object.entries(LIGHT_NUMBERS))assert.ok(Number.isFinite(p[k])&&p[k]>=lo&&p[k]<=hi,`${name}.${k}=${p[k]} in [${lo}, ${hi}]`);
    assert.ok(p.sunFrom.length===3&&p.sunFrom.every(Number.isFinite)&&p.sunFrom[1]>0,`${name}.sunFrom`);
  }
});

test('lamps, stars and fireflies are fully lit only at night; day keeps them dark',()=>{
  const {day,night,sunset}=settings.timesOfDay;
  for(const k of ['lamps','stars','fireflies']){assert.equal(day[k],0,`day ${k}`);assert.equal(night[k],1,`night ${k}`);}
  assert.ok(sunset.lamps>0,'lamps start to glow at sunset');
});

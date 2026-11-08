import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,mergeConfig} from '../src/config.ts';

const dir=()=>mkdtempSync(join(tmpdir(),'config-'));

test('objects merge key by key while arrays and scalars replace', ()=>{
  const base={port:8787,localModel:'a',list:[1,2,3],nested:{keep:true,deep:{x:1,y:2}}};
  const merged=mergeConfig(base,{port:8790,list:[9],nested:{deep:{y:5},added:'yes'},localModel:null});
  assert.deepEqual(merged,{port:8790,localModel:null,list:[9],nested:{keep:true,deep:{x:1,y:5},added:'yes'}});
  assert.deepEqual(base.nested.deep,{x:1,y:2},'base must not be mutated');
});

test('prototype keys in an overlay are ignored', ()=>{
  const merged=mergeConfig({a:1},JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"b":2}'));
  assert.deepEqual(merged,{a:1,b:2});
  assert.equal(({} as any).polluted,undefined);
});

test('a missing overlay leaves town.config.json unchanged', ()=>{
  const root=dir();
  writeFileSync(join(root,'town.config.json'),JSON.stringify({port:8787,economy:{days:7}}));
  assert.deepEqual(loadConfig(root),{port:8787,economy:{days:7}});
});

test('town.local.json overrides only the keys it names', ()=>{
  const root=dir();
  writeFileSync(join(root,'town.config.json'),JSON.stringify({port:8787,planModel:'haiku',economy:{startingCoins:1000,days:7}}));
  writeFileSync(join(root,'town.local.json'),JSON.stringify({port:8790,economy:{days:3}}));
  assert.deepEqual(loadConfig(root),{port:8790,planModel:'haiku',economy:{startingCoins:1000,days:3}});
});

test('the committed example overlay parses and names keys the base config has', ()=>{
  const example=JSON.parse(readFileSync(new URL('../town.local.example.json',import.meta.url),'utf8'));
  const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
  assert.equal(typeof example.port,'number');
  assert.equal(typeof example.economy.days,'number');
  assert.ok('localModel' in base && 'planModel' in base && 'days' in base.economy);
});

test('a broken overlay fails with an error naming town.local.json', ()=>{
  const root=dir();
  writeFileSync(join(root,'town.config.json'),'{"port":8787}');
  writeFileSync(join(root,'town.local.json'),'{"port": 8790,');
  assert.throws(()=>loadConfig(root),/town\.local\.json is not valid JSON/);
});

test('an overlay that is not a JSON object is rejected by name', ()=>{
  const root=dir();
  writeFileSync(join(root,'town.config.json'),'{"port":8787}');
  writeFileSync(join(root,'town.local.json'),'[1,2]');
  assert.throws(()=>loadConfig(root),/town\.local\.json must contain a JSON object/);
});

test('a broken base config is reported by name too', ()=>{
  const root=dir();
  writeFileSync(join(root,'town.config.json'),'nope');
  assert.throws(()=>loadConfig(root),/town\.config\.json is not valid JSON/);
});

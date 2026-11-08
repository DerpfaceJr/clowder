import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelHub} from '../src/models.ts';

const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const hub=()=>new ModelHub({file:join(mkdtempSync(join(tmpdir(),'login-code-')),'models.json'),config,env:{}});

test('an authentication code is refused when no sign-in is waiting, and malformed codes never reach a CLI',()=>{
  assert.throws(()=>hub().submitLoginCode('claude','abcDEF123#xyz_-'),/No sign-in is waiting/);
  const h=hub() as any,written:string[]=[];
  h.logins.set('claude',{child:{stdin:{write:(s:string)=>written.push(s)}}});
  assert.throws(()=>h.submitLoginCode('claude','bad code; rm -rf'),/does not look like/);
  assert.throws(()=>h.submitLoginCode('claude','short'),/does not look like/);
  assert.deepEqual(h.submitLoginCode('claude','  FHcq-dIR_9m#1469.gf~e  '),{ok:true});
  assert.deepEqual(written,['FHcq-dIR_9m#1469.gf~e\n']);
});

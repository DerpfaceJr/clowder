// Plan 4.13: the build script refuses a download whose sha256 is not the pinned one, and deletes it. The real download and clone run in desktop:build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {UV,HERMES,verifyCommit,verifySha256} from '../scripts/fetch-hermes-runtime.mjs';

test('a file with the wrong sha256 is refused and deleted; the right one is kept',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'uv-zip-')),'uv.zip');
  writeFileSync(file,'not the uv release');
  assert.throws(()=>verifySha256(file,UV.sha256),/uv\.zip has sha256 [0-9a-f]{64}, expected 7c38608c.*refused and deleted/);
  assert.equal(existsSync(file),false);
  writeFileSync(file,'not the uv release');
  verifySha256(file,createHash('sha256').update('not the uv release').digest('hex'));
  assert.equal(existsSync(file),true);
});

test('a checkout at another commit is refused',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hermes-src-')),git=(...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8'}).trim();
  git('init','-q');git('-c','user.email=t@t','-c','user.name=t','commit','-q','--allow-empty','-m','x');
  assert.throws(()=>verifyCommit(dir,HERMES.commit),/is commit [0-9a-f]{40}, expected bf0203a7.*refused/);
  verifyCommit(dir,git('rev-parse','HEAD'));
});

test('the pins are exact: a 64-hex uv hash and a 40-hex Hermes commit',()=>{
  assert.match(UV.sha256,/^[0-9a-f]{64}$/);assert.match(HERMES.commit,/^[0-9a-f]{40}$/);
  assert.ok(UV.url.includes(`/${UV.version}/`),'the url is the pinned version');
});

// Plans 7.9 and 7.10: the release tag check, the idle rule for installing an update, and electron-updater 6.8.11's own signature check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync, closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const tagScript = new URL('../scripts/check-release-tag.mjs', import.meta.url).href;
const {tagMatches} = await import(tagScript) as {tagMatches: (tag: unknown, version: string) => boolean};
const root = fileURLToPath(new URL('../', import.meta.url));
const {updateGate} = require('../desktop/update-gate.cjs');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

test('release tag: only v plus the package.json version passes, and the workflow step exits 1 on a mismatch', () => {
  assert.equal(tagMatches(`v${version}`, version), true);
  for (const tag of [version, `v${version}.1`, 'v9.9.9', `V${version}`, '', undefined]) assert.equal(tagMatches(tag, version), false, String(tag));
  const run = (tag: string) => spawnSync(process.execPath, [join(root, 'scripts', 'check-release-tag.mjs')], {env: {...process.env, GITHUB_REF_NAME: tag}, encoding: 'utf8'});
  const bad = run('v9.9.9');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not match package\.json version/);
  assert.equal(run(`v${version}`).status, 0);
});

// The real updater's install() is the only way an update installs (autoInstallOnAppQuit is off), so the fake counts its calls.
function harness(busy: string | null, installs = true) {
  const calls: string[] = [];
  const state = {busy};
  const gate = updateGate({
    updater: {install: (silent: boolean, runAfter: boolean) => { calls.push(`install:${silent}:${runAfter}`); return installs; }},
    askBusy: async () => { calls.push('ask'); return state.busy; },
    stopServer: async ({quitting}: {quitting: boolean}) => { calls.push(`stop:${quitting}`); },
    offer: async () => { calls.push('offer'); return 'now'; },
    quit: () => calls.push('quit'),
    restart: async () => { calls.push('restart'); },
  });
  return {gate, calls, state};
}

test('with a task running, neither restart now nor quit installs, and the offer stays', async () => {
  const {gate, calls, state} = harness('Finish the current work or stop the town first.');
  gate.downloaded('0.2.0');
  assert.equal(await gate.tryOffer(), 'busy');
  assert.equal(await gate.restartNow(), 'busy');
  assert.deepEqual(calls, ['ask', 'ask'], 'busy: no offer, no stop, no install');
  // The owner chose "at next quit" while idle, then a season started before the quit.
  const calls2: string[] = [];
  let busy2: string | null = null;
  const g = updateGate({
    updater: {install: () => { calls2.push('install'); return true; }},
    askBusy: async () => busy2,
    stopServer: async () => { calls2.push('stop'); },
    offer: async () => 'quit', quit: () => calls2.push('quit'), restart: async () => {},
  });
  g.downloaded('0.2.0');
  assert.equal(await g.tryOffer(), 'at-quit');
  busy2 = 'A season is running. Stop it first.';
  assert.equal(await g.onQuit(), false);
  assert.deepEqual(calls2, ['stop'], 'the server stops, nothing installs, nothing quits early');
  assert.equal(g.ready, '0.2.0');
  assert.equal(g.atQuit, true, 'the offer stays for the next quit');
  // And a restart-now asked while busy after the box was answered: still nothing.
  state.busy = 'Finish the current work or stop the town first.';
  assert.equal(await gate.restartNow(), 'busy');
  assert.ok(!calls.some(c => c.startsWith('install') || c.startsWith('stop')));
});

test('idle: restart now stops the server before installing; at next quit installs only after the server stopped', async () => {
  const now = harness(null);
  now.gate.downloaded('0.2.0');
  assert.equal(await now.gate.tryOffer(), 'installing');
  assert.deepEqual(now.calls, ['ask', 'offer', 'ask', 'stop:false', 'install:true:true', 'quit']);

  const refused = harness(null, false);
  refused.gate.downloaded('0.2.0');
  assert.equal(await refused.gate.restartNow(), 'failed');
  assert.deepEqual(refused.calls, ['ask', 'stop:false', 'install:true:true', 'restart'], 'a refused install brings the town back');

  const calls: string[] = [];
  const g = updateGate({
    updater: {install: (s: boolean, r: boolean) => { calls.push(`install:${s}:${r}`); return true; }},
    askBusy: async () => { calls.push('ask'); return null; },
    stopServer: async ({quitting}: {quitting: boolean}) => { calls.push(`stop:${quitting}`); },
    offer: async () => 'quit', quit: () => calls.push('quit'), restart: async () => {},
  });
  assert.equal(await g.onQuit(), false, 'no download: nothing to install');
  g.downloaded('0.2.0');
  assert.equal(await g.tryOffer(), 'at-quit');
  calls.length = 0;
  assert.equal(await g.onQuit(), true);
  assert.deepEqual(calls, ['ask', 'stop:true', 'install:true:false']);
});

test('the updater stays off unless the build is a release whose app-update.yml names a publisher', () => {
  const {updaterOff, NOT_RELEASE} = require('../desktop/update-gate.cjs');
  assert.equal(updaterOff(null, null), NOT_RELEASE);
  assert.equal(updaterOff({commit: 'abc1234', builtAt: 'x'}, {publisherName: ['CN=Someone']}), NOT_RELEASE);
  assert.equal(updaterOff({commit: 'abc1234', release: 'true'}, {publisherName: ['CN=Someone']}), NOT_RELEASE, 'only the boolean the workflow writes');
  for (const cfg of [null, {}, {publisherName: null}, {publisherName: []}, {publisherName: ['  ']}]) assert.match(updaterOff({release: true}, cfg), /no publisher/);
  assert.equal(updaterOff({release: true}, {publisherName: ['CN=Someone, C=CA']}), null);
  assert.equal(updaterOff({release: true}, {publisherName: 'CN=Someone'}), null);
});

test('a local desktop build, when present, is one the updater stays off for', {skip: !existsSync(join(root, 'dist-desktop', 'win-unpacked', 'resources', 'app-update.yml')) && 'no local build in dist-desktop'}, () => {
  const {updaterOff, NOT_RELEASE} = require('../desktop/update-gate.cjs');
  const yaml = require(require.resolve('js-yaml', {paths: [require.resolve('electron-updater')]}));
  const resources = join(root, 'dist-desktop', 'win-unpacked', 'resources');
  const info = JSON.parse(readFileSync(join(resources, 'app', 'build-info.json'), 'utf8'));
  const cfg = yaml.load(readFileSync(join(resources, 'app-update.yml'), 'utf8'));
  assert.equal(updaterOff(info, cfg), NOT_RELEASE);
  assert.match(updaterOff({...info, release: true}, cfg), /no publisher/, 'even a forged marker finds no publisher in a local build');
});

// electron-updater 6.8.11's real verifySignature: Get-AuthenticodeSignature, then the certificate subject against publisherName.
const authenticode = (file: string) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; @{status=[string]$s.Status; subject=[string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress`], {encoding: 'utf8'}));

// A real unsigned executable: node.exe with its PE certificate table entry zeroed.
function unsignedCopy(dir: string) {
  const file = join(dir, 'unsigned.exe');
  copyFileSync(process.execPath, file);
  const fd = openSync(file, 'r+');
  try {
    const head = Buffer.alloc(4096);
    readSync(fd, head, 0, head.length, 0);
    const pe = head.readUInt32LE(0x3c), optional = pe + 24;
    const dirs = optional + (head.readUInt16LE(optional) === 0x20b ? 112 : 96);
    writeSync(fd, Buffer.alloc(8), 0, 8, dirs + 4 * 8);
  } finally {
    closeSync(fd);
  }
  return file;
}

test('electron-updater 6.8.11 refuses an unsigned exe and an exe signed by another publisher', {skip: process.platform !== 'win32' && 'Get-AuthenticodeSignature is Windows only'}, async () => {
  assert.equal(require('electron-updater/package.json').version, '6.8.11');
  const {verifySignature} = require('electron-updater/out/windowsExecutableCodeSignatureVerifier.js');
  const logs: string[] = [];
  const logger = {info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => {}};
  const madeUp = ['CN=Made Up Publisher, O=Made Up Publisher, L=Nowhere, S=Ontario, C=CA', 'Made Up Publisher'];

  const signed = authenticode(process.execPath);
  assert.equal(signed.status, 'Valid', 'node.exe must be validly signed for this case to mean anything');
  assert.match(signed.subject, /CN=OpenJS Foundation/);
  const wrong = await verifySignature(madeUp, process.execPath, logger);
  assert.equal(typeof wrong, 'string', 'another publisher is refused');
  assert.match(wrong, /publisherNames: CN=Made Up Publisher/);
  // Control: the same call accepts the real publisher, so the refusal above is the subject comparison, not a PowerShell failure.
  assert.equal(await verifySignature([signed.subject], process.execPath, logger), null);

  const dir = mkdtempSync(join(tmpdir(), 'clowder-sig-'));
  try {
    const unsigned = unsignedCopy(dir);
    assert.equal(authenticode(unsigned).status, 'NotSigned');
    const refused = await verifySignature(madeUp, unsigned, logger);
    assert.equal(typeof refused, 'string', 'an unsigned exe is refused');
    // Even naming node.exe's own publisher does not let the unsigned copy through.
    assert.equal(typeof await verifySignature([signed.subject], unsigned, logger), 'string');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

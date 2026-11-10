// Does the real updater in a packaged build refuse an update that its publisher did not sign? (plan 7.10's proof, end to end.)
// It marks an UNPACKED SCRATCH BUILD as a release (build-info.json release: true, app-update.yml with a publisher and a local feed), starts
// it on a temporary profile and data folder, and offers it version 9.9.9 from a local feed. Nothing is installed: the app installs only on
// "Restart now" or at a quit after "At next quit", and neither is chosen. Never point it at a build you mean to keep or ship.
//   node node_modules/electron-builder/cli.js --win --dir --publish never -c.directories.output=<scratch>
//   node scripts/update-refusal-probe.mjs <scratch>/win-unpacked <an .exe to offer>
// Offer an unsigned .exe, then one signed by someone else (any Microsoft-signed tool): both must print "verdict": "refused".
// Run on 2026-11-10 against fb1cf30: both refused (docs/launch-readiness.md). The updater's own cache for the probe is removed at the end.
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

const [unpacked, offered] = process.argv.slice(2);
if (!unpacked || !offered || !existsSync(join(unpacked, 'Clowder.exe')) || !existsSync(offered)) { console.error('Usage: node scripts/update-refusal-probe.mjs <scratch win-unpacked> <exe to offer>'); process.exit(2); }
const resources = join(unpacked, 'resources');
const FEED = 8895, PORT = 8896, CDP = 9334, CACHE = 'clowder-updater-probe';
const out = {requests: [], updater: [], errors: []};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. Mark the scratch copy as a release whose publisher is someone the offered file is not signed by.
const infoFile = join(resources, 'app', 'build-info.json');
writeFileSync(infoFile, JSON.stringify({...JSON.parse(readFileSync(infoFile, 'utf8')), release: true}, null, 2));
writeFileSync(join(resources, 'app-update.yml'), `provider: generic\nurl: http://127.0.0.1:${FEED}/\nupdaterCacheDirName: ${CACHE}\npublisherName:\n  - Clowder Probe Publisher\n`);

// 2. The feed: latest.yml for 9.9.9 and the unsigned installer it names.
const exe = readFileSync(offered), name = 'Clowder-Setup-9.9.9.exe', sha512 = createHash('sha512').update(exe).digest('base64');
const latest = `version: 9.9.9\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${exe.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-11-10T00:00:00.000Z'\n`;
const feed = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  out.requests.push(`${req.method} ${path}`);
  if (path === '/latest.yml') return void res.writeHead(200, {'Content-Type': 'text/yaml'}).end(latest);
  if (path === `/${name}`) return void res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': exe.length}).end(exe);
  res.writeHead(404).end();
}).listen(FEED, '127.0.0.1');

// 3. The packaged app on a temporary profile and data folder.
const tmp = mkdtempSync(join(tmpdir(), 'clowder-update-'));
const user = join(tmp, 'user'), data = join(tmp, 'data');
mkdirSync(user); mkdirSync(data);
writeFileSync(join(data, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
writeFileSync(join(data, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
const child = spawn(join(unpacked, 'Clowder.exe'), [`--user-data-dir=${user}`, `--remote-debugging-port=${CDP}`], {
  cwd: unpacked, stdio: 'ignore',
  env: {...process.env, CAT_TOWN_DATA: data, PORT: String(PORT), CAT_REMOTE_PORT: '8897', CAT_TUNNEL_AUTOSTART: '0'},
});
let exited = null;
child.on('exit', code => { exited = code; });

// 4. Wait for the updater's verdict in the app's own log.
const logFile = join(user, 'server.log');
const lines = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('[updater]')) : []);
const verdict = () => { const all = lines().join('\n'); return /not signed by the application owner/i.test(all) ? 'refused' : /has been downloaded|update-downloaded/i.test(all) ? 'ACCEPTED' : /\[updater\] off/.test(all) ? 'off' : null; };
for (let i = 0; i < 240 && !verdict() && exited === null; i++) await sleep(500);
await sleep(3000); // anything the updater would do after its verdict
out.verdict = verdict() ?? 'no verdict in 120 s';
out.updater = lines().map(l => l.replace(tmp, '<tmp>').slice(0, 230)).slice(0, 14);

// 5. Close the window as an owner would. No update was chosen for "at next quit", so quitting installs nothing.
try {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const page = browser.contexts().flatMap(c => c.pages())[0];
  out.page = page ? await page.evaluate(() => location.origin).catch(() => 'no page') : 'no page';
  await page?.evaluate(() => window.close()).catch(() => {});
  for (let i = 0; i < 60 && exited === null; i++) await sleep(500);
  await browser.close().catch(() => {});
} catch (err) { out.errors.push('close: ' + err.message.slice(0, 120)); }
if (exited === null) { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}); out.killed = true; }
out.exitCode = exited;
out.afterQuit = lines().slice(out.updater.length).map(l => l.slice(0, 200));
feed.close();
// The updater's download cache for this probe, never the real app's.
const cache = join(process.env.LOCALAPPDATA ?? '', CACHE);
out.cacheExisted = existsSync(cache);
try { rmSync(cache, {recursive: true, force: true, maxRetries: 3, retryDelay: 200}); } catch { out.errors.push('cache not removed'); }
try { rmSync(tmp, {recursive: true, force: true, maxRetries: 3, retryDelay: 300}); } catch { out.tmpLeft = tmp; }
console.log(JSON.stringify(out, null, 1));
process.exit(0);

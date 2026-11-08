// The cats' browser: one headed Chrome or Edge window on the owner's computer, with its own profile in the data folder. The owner
// signs in there once and the sign-in persists in that profile. Cats drive it through the browse tool (tool-runtimes.ts), which
// attaches the Playwright MCP server to the window's DevTools port. Its own profile, unless the owner chooses My Chrome below.
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';
import {BROWSERS} from './models.ts';
import {writeJsonAtomic} from './atomic-json.ts';
import {withSecrets, withoutSecrets} from './secret-store.ts';

const PORT_FILE = 'DevToolsActivePort';
export const catBrowserProfile = (dataDir: string) => join(dataDir, 'browser');
// The first line of DevToolsActivePort is the port Chrome chose for --remote-debugging-port=0. Anything else is not a port.
export function devToolsPort(text: string): number | null { const port = Number(text.split(/\r?\n/)[0]); return Number.isInteger(port) && port > 0 && port < 65536 ? port : null; }
// Only an https address is ever opened in the cats' browser. Returns the normalised address, or null.
export function secureUrl(value: unknown): string | null { if (typeof value !== 'string') return null; try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } }
const endpointOf = (profile: string) => { try { const port = devToolsPort(readFileSync(join(profile, PORT_FILE), 'utf8')); return port ? `http://127.0.0.1:${port}` : null; } catch { return null; } };
// A window that was closed no longer answers on its endpoint.
async function live(endpoint: string | null) { if (!endpoint) return false; try { return (await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(1500)})).ok; } catch { return false; } }
const browserExe = () => ['chrome', 'edge'].flatMap(id => BROWSERS[id].paths()).find(p => existsSync(p)) ?? null;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Opens the cats' browser. A live window gets the address as a new tab; otherwise a window is launched on its own profile. Returns its DevTools endpoint. */
export async function openCatBrowser(dataDir: string, url?: string): Promise<string> {
  const profile = catBrowserProfile(dataDir), endpoint = endpointOf(profile);
  if (endpoint && await live(endpoint)) {
    if (url) await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {method: 'PUT'}).catch(() => {});
    return endpoint;
  }
  const exe = browserExe();
  if (!exe) throw new Error('Install Chrome or Edge to use the cats’ browser.');
  mkdirSync(profile, {recursive: true});
  // A port file left by a window that is gone would point at nothing, so it goes before the launch.
  rmSync(join(profile, PORT_FILE), {force: true});
  const child = spawn(exe, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', url ?? 'about:blank'], {detached: true, stdio: 'ignore'});
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 100; i++) { const found = endpointOf(profile); if (found && await live(found)) return found; await sleep(200); }
  throw new Error('The cats’ browser did not open. Close any other window that uses its profile and try again.');
}

// The page's own signed-in marker, read in the page: GitHub's user-login meta, GitLab's gon.current_username.
const HANDLE_JS = `document.querySelector('meta[name="user-login"]')?.content||window.gon?.current_username||null`;
/** Who a site is signed in as (item 1.8), read from a tab of that site already open in the cats' window over its DevTools port. Nothing is opened or
 *  launched: no live window, no tab of the site, or no marker reads null (unchecked). Page values are untrusted, so only a plain handle passes.
 *  ponytail: GitHub's and GitLab's markers only; add a site's when a cat needs it. */
export async function signedInHandle(dataDir: string, host: string): Promise<string | null> {
  const endpoint = endpointOf(catBrowserProfile(dataDir));
  if (!endpoint || !await live(endpoint)) return null;
  const tabs: any[] = await (await fetch(`${endpoint}/json/list`, {signal: AbortSignal.timeout(3000)})).json();
  const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const tab = tabs.find(t => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && hostOf(String(t.url)) === host);
  if (!tab) return null;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  const value = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No answer from the page.')), 5000);
    ws.onopen = () => ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression: HANDLE_JS, returnByValue: true}}));
    // A throw inside a listener would be uncaught, so a frame that is not JSON is skipped.
    ws.onmessage = e => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (m?.id === 1) { clearTimeout(timer); resolve(m.result?.result?.value); } };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('The page could not be read.')); };
  }).finally(() => ws.close());
  return typeof value === 'string' && /^[\w.-]{1,40}$/.test(value) ? value : null;
}

// My Chrome: the owner lets the cats work in their own Chrome, signed in as they are, through the Playwright extension. Each run still
// asks the owner first in Clowder; without the extension's token Chrome also asks to connect. The token stays in this file on this computer.
export const PLAYWRIGHT_EXTENSION = 'https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm';
export type CatBrowserSettings = {mode: 'own' | 'chrome'; token?: string};
const settingsFile = (dataDir: string) => join(dataDir, 'cat-browser.json');
const TOKEN = /^[A-Za-z0-9_\-.=+/]{8,200}$/;
// The extension shows the token as a whole line (PLAYWRIGHT_MCP_EXTENSION_TOKEN=...); a pasted line or JSON entry keeps only the value.
const cleanToken = (t: string) => t.trim().replace(/^(?:export\s+)?["']?[A-Z_]*TOKEN["']?\s*[=:]\s*/, '').replace(/^["']|["'],?$/g, '');
export function catBrowserSettings(dataDir: string): CatBrowserSettings {
  try {
    const j = withSecrets(settingsFile(dataDir), JSON.parse(readFileSync(settingsFile(dataDir), 'utf8')));
    return {mode: j?.mode === 'chrome' ? 'chrome' : 'own', ...(typeof j?.token === 'string' && TOKEN.test(cleanToken(j.token)) ? {token: cleanToken(j.token)} : {})};
  } catch { return {mode: 'own'}; }
}
/** The owner's Chrome for a browse run, or null when the cats use their own window. */
export function ownChrome(dataDir: string): {token?: string} | null {
  const s = catBrowserSettings(dataDir);
  return s.mode === 'chrome' ? (s.token ? {token: s.token} : {}) : null;
}
const view = (dataDir: string) => { const s = catBrowserSettings(dataDir); return {mode: s.mode, tokenSet: !!s.token, extension: PLAYWRIGHT_EXTENSION}; };
const chromeExe = () => BROWSERS.chrome.paths().find(p => existsSync(p)) ?? null;
/** The quest button in My Chrome mode: the address opens as a tab in the owner's own Chrome. */
function openInOwnChrome(url?: string) {
  const exe = chromeExe();
  if (!exe) throw new Error('Install Chrome to use My Chrome.');
  const child = spawn(exe, url ? [url] : [], {detached: true, stdio: 'ignore'});
  child.on('error', () => {});
  child.unref();
}

// Owner-only, like the other owner routes: paired and LAN devices get 403. The Connectors panel and a quest's button both call it.
export function registerCatBrowserRoutes(app: FastifyInstance, opts: {dataDir: string; open?: (dataDir: string, url?: string) => Promise<string>; openOwn?: (url?: string) => void}) {
  const open = opts.open ?? openCatBrowser;
  const ownerOnly = async (req: FastifyRequest, reply: FastifyReply) => { if (!isOwner(req)) return reply.code(403).send({error: 'The cats’ browser is opened on the host computer.'}); };
  app.post('/api/cat-browser/open', {onRequest: ownerOnly, schema: {body: {type: 'object', additionalProperties: false, properties: {url: {type: 'string', maxLength: 2000}}}}}, async (req, reply) => {
    const raw = (req.body as {url?: string}).url;
    const url = raw === undefined ? undefined : secureUrl(raw) ?? undefined;
    if (raw !== undefined && !url) return reply.code(400).send({error: 'Give an https address.'});
    try {
      if (catBrowserSettings(opts.dataDir).mode === 'chrome') (opts.openOwn ?? openInOwnChrome)(url); else await open(opts.dataDir, url);
      return {ok: true};
    } catch (err) { return reply.code(500).send({error: (err as Error).message}); }
  });
  app.get('/api/cat-browser', {onRequest: ownerOnly}, async () => view(opts.dataDir));
  // token '' clears it. A token that does not look like one is refused rather than saved.
  app.put('/api/cat-browser', {onRequest: ownerOnly, schema: {body: {type: 'object', additionalProperties: false, minProperties: 1, properties: {mode: {type: 'string', enum: ['own', 'chrome']}, token: {type: 'string', maxLength: 200}}}}}, async (req, reply) => {
    const b = req.body as {mode?: 'own' | 'chrome'; token?: string}, cur = catBrowserSettings(opts.dataDir);
    const token = b.token === undefined ? cur.token : cleanToken(b.token);
    if (token && !TOKEN.test(token)) return reply.code(400).send({error: 'That does not look like the extension’s token.'});
    mkdirSync(opts.dataDir, {recursive: true});
    writeJsonAtomic(settingsFile(opts.dataDir), withoutSecrets(settingsFile(opts.dataDir), {mode: b.mode ?? cur.mode, ...(token ? {token} : {})}));
    return view(opts.dataDir);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {installAccess} from '../src/access.ts';
import {PLAYWRIGHT_EXTENSION, catBrowserProfile, devToolsPort, ownChrome, registerCatBrowserRoutes, secureUrl} from '../src/cat-browser.ts';

// The window itself is never launched here: the route takes a fake opener, and only the pure helpers are called directly.

test('the DevTools port is the first line of DevToolsActivePort, and only a real port counts', () => {
  assert.equal(devToolsPort('9222\n/devtools/browser/0f3c'), 9222);
  assert.equal(devToolsPort('51234\r\n/devtools/browser/abc'), 51234, 'CRLF line endings');
  assert.equal(devToolsPort(' 9333 \n'), 9333, 'spaces around the port');
  assert.equal(devToolsPort(''), null);
  assert.equal(devToolsPort('abc\n'), null);
  assert.equal(devToolsPort('0\n'), null);
  assert.equal(devToolsPort('70000\n'), null);
  assert.equal(devToolsPort('9222.5\n'), null);
});

test('the cats’ browser profile sits in the data folder, never the owner’s own profile', () => {
  assert.equal(catBrowserProfile('/srv/town/data'), join('/srv/town/data', 'browser'));
});

test('only an https address is ever opened in the cats’ browser', () => {
  assert.equal(secureUrl('https://developers.facebook.com/apps/'), 'https://developers.facebook.com/apps/');
  assert.equal(secureUrl('http://example.com/'), null, 'plain http is refused');
  assert.equal(secureUrl('javascript:alert(1)'), null);
  assert.equal(secureUrl('file:///C:/Users/Owner/secret.txt'), null);
  assert.equal(secureUrl('not a url'), null);
  assert.equal(secureUrl(42), null);
  assert.equal(secureUrl(undefined), null);
});

test('POST /api/cat-browser/open is owner-only, takes https only, and opens the window with the data folder', async () => {
  const opened: [string, string | undefined][] = [];
  const app = Fastify();
  installAccess(app, false, [], 8787,undefined,undefined,'test-owner');
  registerCatBrowserRoutes(app, {dataDir: '/data/test', open: async (dir, url) => { opened.push([dir, url]); return 'http://127.0.0.1:1'; }});
  const owner = {host: 'localhost:8787', cookie: 'town_owner_8787=test-owner', 'x-town-action': 'owner'};
  const url = '/api/cat-browser/open';
  // A proxied loopback request and a LAN device are refused, and nothing opens.
  assert.equal((await app.inject({method: 'POST', url, headers: {...owner, 'x-forwarded-for': '127.0.0.1'}, payload: {}})).statusCode, 403);
  assert.equal((await app.inject({method: 'POST', url, remoteAddress: '192.168.1.21', headers: {host: '192.168.1.21:8787', 'x-town-action': 'owner'}, payload: {}})).statusCode, 403);
  assert.deepEqual(opened, [], 'a refused request opens nothing');
  // Plain http and other schemes are refused before any window is touched.
  assert.equal((await app.inject({method: 'POST', url, headers: owner, payload: {url: 'http://example.com/'}})).statusCode, 400);
  assert.equal((await app.inject({method: 'POST', url, headers: owner, payload: {url: 'javascript:alert(1)'}})).statusCode, 400);
  assert.deepEqual(opened, []);
  // The owner's Open button sends no address; a start page is passed through as its https address.
  assert.equal((await app.inject({method: 'POST', url, headers: owner, payload: {}})).statusCode, 200);
  assert.equal((await app.inject({method: 'POST', url, headers: owner, payload: {url: 'https://developers.facebook.com/apps/'}})).statusCode, 200);
  assert.deepEqual(opened, [['/data/test', undefined], ['/data/test', 'https://developers.facebook.com/apps/']]);
  await app.close();
});

test('My Chrome: owner-only setting; a bad token is refused; the quest button opens the owner’s Chrome, not the cats’ window', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cat-browser-mode-'));
  const opened: (string | undefined)[] = [], own: (string | undefined)[] = [];
  const app = Fastify();
  installAccess(app, false, [], 8787,undefined,undefined,'test-owner');
  registerCatBrowserRoutes(app, {dataDir, open: async (_dir, url) => { opened.push(url); return 'http://127.0.0.1:1'; }, openOwn: url => { own.push(url); }});
  const owner = {host: 'localhost:8787', cookie: 'town_owner_8787=test-owner', 'x-town-action': 'owner'};
  const put = (payload: unknown, headers: Record<string, string> = owner) => app.inject({method: 'PUT', url: '/api/cat-browser', headers, payload: payload as any});
  assert.deepEqual((await app.inject({method: 'GET', url: '/api/cat-browser', headers: owner})).json(), {mode: 'own', tokenSet: false, extension: PLAYWRIGHT_EXTENSION});
  assert.equal(ownChrome(dataDir), null, 'the cats’ own window by default');
  assert.equal((await put({mode: 'chrome'}, {host: '192.168.1.21:8787', 'x-town-action': 'owner'})).statusCode, 403);
  assert.equal((await put({})).statusCode, 400, 'an empty change is refused');
  assert.equal((await put({token: 'has spaces in it'})).statusCode, 400, 'a token that does not look like one is not saved');
  assert.deepEqual((await put({mode: 'chrome'})).json(), {mode: 'chrome', tokenSet: false, extension: PLAYWRIGHT_EXTENSION});
  assert.deepEqual(ownChrome(dataDir), {}, 'My Chrome with no token: Chrome asks to connect');
  assert.equal((await put({token: 'AbC-123_xyz.tokenvalue'})).json().tokenSet, true);
  assert.deepEqual(ownChrome(dataDir), {token: 'AbC-123_xyz.tokenvalue'});
  assert.ok(!JSON.stringify((await app.inject({method: 'GET', url: '/api/cat-browser', headers: owner})).json()).includes('AbC-123'), 'the token never comes back');
  await put({token: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=AbC-123_line'});
  assert.deepEqual(ownChrome(dataDir), {token: 'AbC-123_line'}, 'the extension’s whole line keeps only the value');
  await put({token: ' "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "AbC-123_json", '});
  assert.deepEqual(ownChrome(dataDir), {token: 'AbC-123_json'}, 'a JSON entry keeps only the value');
  writeFileSync(join(dataDir, 'cat-browser.json'), JSON.stringify({mode: 'chrome', token: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=AbC-123_saved'}));
  assert.deepEqual(ownChrome(dataDir), {token: 'AbC-123_saved'}, 'a whole line saved before this fix is read as its value');
  await app.inject({method: 'POST', url: '/api/cat-browser/open', headers: owner, payload: {url: 'https://github.com/login'}});
  assert.deepEqual([opened, own], [[], ['https://github.com/login']]);
  assert.equal((await put({token: ''})).json().tokenSet, false, 'an empty token clears it');
  assert.equal((await put({mode: 'own'})).json().mode, 'own');
  await app.inject({method: 'POST', url: '/api/cat-browser/open', headers: owner, payload: {}});
  assert.deepEqual(opened, [undefined], 'back to the cats’ own window');
  await app.close();
});

test('a window that fails to open answers 500 with its reason', async () => {
  const app = Fastify();
  installAccess(app, false, [], 8787,undefined,undefined,'test-owner');
  registerCatBrowserRoutes(app, {dataDir: mkdtempSync(join(tmpdir(), 'cat-browser-')), open: async () => { throw new Error('Install Chrome or Edge to use the cats’ browser.'); }});
  const res = await app.inject({method: 'POST', url: '/api/cat-browser/open', headers: {host: 'localhost:8787', cookie: 'town_owner_8787=test-owner', 'x-town-action': 'owner'}, payload: {}});
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'Install Chrome or Edge to use the cats’ browser.');
  await app.close();
});

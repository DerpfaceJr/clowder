import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {installAppCsp, installGzip, installServiceWorkerHeaders} from '../src/pwa.ts';
import {isStandalone, isIOS, initInstallApp, isInstalledApp, installWarning, QUICK_TUNNEL_WARNING, INSTALLED_NOTE} from '../public/mobile-ui.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = name => readFileSync(join(root, name), 'utf8');

// Loads the classic service worker in a sandbox with no registration, then returns its pure router.
function loadRouter() {
  const sandbox = {self: {location: {origin: 'https://town.example'}}, URL, Response, console};
  vm.createContext(sandbox);
  return vm.runInContext(read('sw.js') + '\n;route', sandbox);
}
const route = loadRouter();
const origin = 'https://town.example';
const get = (url, navigate = false) => route({method: 'GET', url, origin, navigate});

test('the service worker never routes /api through the cache, including SSE and every POST', () => {
  for (const url of ['/api/state', '/api/events', '/api/quests', '/api/remote-access', '/api/pair', '/api/chat', '/api/state?x=1']) {
    assert.equal(get(url), 'pass', `${url} passes to the network`);
    assert.equal(get(url, true), 'pass', `${url} passes even as a navigation`);
    assert.equal(route({method: 'POST', url, origin, navigate: false}), 'pass', `POST ${url} passes`);
  }
});

test('navigations and the app code are network first, and heavy assets are stale-while-revalidate', () => {
  assert.equal(get('/', true), 'navigate');
  assert.equal(get('/?x=1', true), 'navigate');
  for (const url of ['/artifacts/5b0c9d7e-0000-4000-8000-000000000000/raw', '/artifacts/5b0c9d7e-0000-4000-8000-000000000000', '/app/clowder.apk'])
    assert.equal(get(url, true), 'pass', `${url} is never stored as the offline app page`);
  for (const url of ['/app.js', '/mobile-ui.js', '/town.js', '/style.css', '/immersive.css', '/manifest.webmanifest']) {
    assert.equal(get(url), 'fresh', `${url} is network first`);
  }
  for (const url of ['/icons/icon-192.png', '/icons/icon-512-maskable.png',
    '/vendor/three/build/three.module.js', '/assets/cat-kit.glb', '/assets/cat-kit.glb?v=2', '/assets/cat-motions.json']) {
    assert.equal(get(url), 'static', `${url} is static`);
  }
  assert.equal(get('/sw.js'), 'pass', 'the worker script itself is never cached by the worker');
  assert.equal(get('/assets/private.txt'), 'pass', 'only glb and json under /assets are cached');
  assert.equal(get('https://fonts.example.com/x.css'), 'pass', 'other origins pass through');
  assert.equal(route({method: 'POST', url: '/app.js', origin, navigate: false}), 'pass', 'non-GET is never cached');
});

test('the worker versions its cache and deletes older clowder caches on activate', () => {
  const src = read('sw.js');
  assert.match(src, /const CACHE = 'clowder-v\d+'/);
  assert.match(src, /n\.startsWith\('clowder-'\) && n !== CACHE/);
});

test('sw.js is served with no-cache, and other static files keep their default headers', async () => {
  const app = Fastify({logger: false});
  installServiceWorkerHeaders(app);
  await app.register(fastifyStatic, {root, prefix: '/'});
  try {
    const sw = await app.inject({method: 'GET', url: '/sw.js'});
    assert.equal(sw.statusCode, 200);
    assert.equal(sw.headers['cache-control'], 'no-cache');
    assert.match(sw.headers['content-type'], /javascript/);
    const sw2 = await app.inject({method: 'GET', url: '/sw.js?v=2'});
    assert.equal(sw2.headers['cache-control'], 'no-cache');
    const other = await app.inject({method: 'GET', url: '/app.js'});
    assert.notEqual(other.headers['cache-control'], 'no-cache');
  } finally {
    await app.close();
  }
});

test('the app page carries a script policy with a hash for each of its inline scripts, and no other response does', async () => {
  const app = Fastify({logger: false});
  installAppCsp(app, join(root, 'index.html'));
  await app.register(fastifyStatic, {root, prefix: '/'});
  app.get('/callback', async (req, reply) => reply.type('text/html').send('<script>close()</script>'));
  try {
    const inline = [...read('index.html').matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.equal(inline.length, 2, 'the import map and the desktop-app class');
    for (const url of ['/', '/index.html', '/?owner=x']) {
      const csp = String((await app.inject({url})).headers['content-security-policy']);
      assert.match(csp, /^script-src 'self' 'sha256-[^;]+; object-src 'none'; base-uri 'none'$/, url);
      for (const text of inline) assert.ok(csp.includes(`'sha256-${createHash('sha256').update(text).digest('base64')}'`), `${url}: ${text.slice(0, 30)}`);
      assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), url);
    }
    const page = await app.inject({url: '/'});
    const again = await app.inject({url: '/', headers: {'if-none-match': page.headers.etag}});
    assert.equal(again.statusCode, 304);
    assert.equal(again.headers['content-security-policy'], page.headers['content-security-policy'], 'a revalidated copy gets the policy too');
    assert.equal((await app.inject({url: '/app.js'})).headers['content-security-policy'], undefined);
    assert.equal((await app.inject({url: '/callback'})).headers['content-security-policy'], undefined, 'a route’s own page is not the app page');
  } finally {
    await app.close();
  }
});

test('static text is gzipped for a browser that accepts it, and nothing else is', async () => {
  const app = Fastify({logger: false});
  installGzip(app);
  await app.register(fastifyStatic, {root, prefix: '/'});
  app.get('/api/x', async () => ({ok: true}));
  const gzip = {'accept-encoding': 'gzip, deflate, br'};
  try {
    const zipped = await app.inject({url: '/app.js', headers: gzip});
    assert.equal(zipped.statusCode, 200);
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal(zipped.headers['vary'], 'Accept-Encoding');
    assert.equal(zipped.headers['content-length'], undefined);
    assert.deepEqual(gunzipSync(zipped.rawPayload), readFileSync(join(root, 'app.js')));
    assert.ok(zipped.rawPayload.length < readFileSync(join(root, 'app.js')).length / 2, 'at most half the bytes');
    const plain = await app.inject({url: '/app.js'});
    assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding, no gzip');
    assert.deepEqual(plain.rawPayload, readFileSync(join(root, 'app.js')));
    assert.equal((await app.inject({url: '/app.js', headers: {...gzip, range: 'bytes=0-9'}})).headers['content-encoding'], undefined, 'a range stays as it is');
    assert.equal((await app.inject({url: '/app.js', headers: {...gzip, 'if-none-match': zipped.headers.etag}})).statusCode, 304);
    assert.equal((await app.inject({url: '/icons/icon-192.png', headers: gzip})).headers['content-encoding'], undefined, 'an image is already compressed');
    assert.equal((await app.inject({url: '/api/x', headers: gzip})).headers['content-encoding'], undefined, 'a JSON route is not a file stream');
  } finally {
    await app.close();
  }
});

test('a browser that reports Clowder installed here hides Install app and says where to open it', async () => {
  assert.equal(isInstalledApp([{platform: 'webapp', url: 'https://town.invalid/manifest.webmanifest'}]), true);
  assert.equal(isInstalledApp([{platform: 'chromeWebStore', url: 'https://town.invalid/x'}]), false, 'other stores do not count');
  assert.equal(isInstalledApp([{platform: 'webapp', url: 'https://town.invalid/other.json'}]), false, 'another manifest does not count');
  assert.equal(isInstalledApp([]), false);
  assert.equal(isInstalledApp(undefined), false, 'no API reads as not known, so the item stays');
  const env = fakeEnvironment({relatedApps: [{platform: 'webapp', url: 'https://town.invalid/manifest.webmanifest'}]});
  const button = initInstallApp(env.doc, env.win);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(button.removed, true, 'the item is removed');
  const note = env.group.children.at(-1);
  assert.equal(note.id, 'install-installed');
  assert.equal(note.textContent, INSTALLED_NOTE);
  const ios = fakeEnvironment({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone'});
  const kept = initInstallApp(ios.doc, ios.win);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(kept.removed, undefined, 'iOS has no installed-app API, so the item stays');
});

test('the quick-tunnel warning shows only where the address changes', () => {
  assert.equal(installWarning({provider: 'cloudflare', named: false, hostname: 'a-b.trycloudflare.com'}), QUICK_TUNNEL_WARNING);
  assert.equal(installWarning({provider: 'tailscale', named: false, hostname: 'town.tail1234.ts.net'}), null, 'Tailscale shows no warning');
  assert.equal(installWarning({provider: 'cloudflare', named: true, hostname: 'town.example.com'}), null, 'a named tunnel keeps its address');
  assert.equal(installWarning({provider: 'cloudflare', named: false, hostname: 'localhost'}), null, 'this computer is not a tunnel');
  assert.equal(installWarning({hostname: 'a-b.trycloudflare.com'}), QUICK_TUNNEL_WARNING, 'a paired device has no status: the address decides');
  assert.equal(installWarning({hostname: 'town.tail1234.ts.net'}), null);
  assert.equal(installWarning({hostname: '192.168.1.20'}), null, 'a LAN address is stable');
  assert.equal(installWarning(), null);
  assert.match(QUICK_TUNNEL_WARNING, /Remove the old Clowder icon first, or set up Tailscale for one permanent app\./);
});

test('the install sheet carries the warning only on a quick tunnel', async () => {
  const quick = fakeEnvironment({hostname: 'a-b.trycloudflare.com', remote: false});
  const button = initInstallApp(quick.doc, quick.win);
  await button.listeners.click();
  const sheet = quick.doc.body.children.at(-1);
  assert.ok(sheet.children.some(c => c.className === 'install-warning' && c.textContent === QUICK_TUNNEL_WARNING), 'quick tunnel warns before install');
  const tailnet = fakeEnvironment({hostname: 'town.tail1234.ts.net', remote: {provider: 'tailscale', named: false}});
  const other = initInstallApp(tailnet.doc, tailnet.win);
  await other.listeners.click();
  const plain = tailnet.doc.body.children.at(-1);
  assert.equal(plain.children.some(c => c.className === 'install-warning'), false, 'Tailscale shows no warning');
});

test('the manifest is valid JSON with installable fields and a maskable 512 icon', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.id, '/');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.orientation, 'any');
  assert.equal(m.name, 'Clowder');
  assert.equal(m.short_name, 'Clowder');
  const sizes = m.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  const maskable = m.icons.find(i => i.purpose === 'maskable');
  assert.ok(maskable, 'a maskable icon is declared');
  assert.equal(maskable.sizes, '512x512');
  assert.equal(maskable.type, 'image/png');
  for (const icon of m.icons) assert.ok(existsSync(join(root, icon.src)), `${icon.src} exists on disk`);
});

test('index.html carries the iOS home-screen tags and the manifest link', () => {
  const html = read('index.html');
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Clowder">/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /viewport-fit=cover/, 'safe-area insets are reachable');
  assert.match(html, /Pair this phone\./);
  assert.match(html, /Devices on your computer/);
});

// Minimal stand-ins for the DOM calls initInstallApp makes. Only the menu group, one button, and a body are needed.
// relatedApps: what getInstalledRelatedApps resolves with (omit for iOS, which has no such API). hostname: the page's address.
// remote: the owner status body, false for a 403 (paired device), or omitted when the page has no fetch.
function fakeEnvironment({standalone = false, userAgent = 'Mozilla/5.0 (Linux; Android 14)', platform = '', touch = 0, relatedApps = null, hostname, remote} = {}) {
  const listeners = {};
  const make = tag => {
    const el = {tagName: tag, children: [], attrs: {}, listeners: {}, textContent: '', className: '', id: '', type: ''};
    el.append = (...items) => { el.children.push(...items); };
    el.setAttribute = (k, v) => { el.attrs[k] = v; };
    el.addEventListener = (k, fn) => { el.listeners[k] = fn; };
    el.remove = () => { el.removed = true; };
    el.showModal = () => { el.open = true; };
    el.close = () => { el.open = false; };
    return el;
  };
  const group = {children: [], append(el) { this.children.push(el); }};
  const doc = {body: make('body'), createElement: make, querySelector: sel => (sel === '#settings-screen .menu-items' ? group : null)};
  const win = {
    navigator: {
      userAgent, platform, maxTouchPoints: touch, ...(standalone ? {standalone: true} : {}),
      ...(relatedApps !== null ? {getInstalledRelatedApps: async () => relatedApps} : {}),
    },
    matchMedia: q => ({matches: standalone && q === '(display-mode: standalone)'}),
    addEventListener: (k, fn) => { listeners[k] = fn; },
    ...(hostname !== undefined ? {location: {hostname}} : {}),
    ...(remote !== undefined ? {fetch: async () => (remote === false ? {ok: false} : {ok: true, json: async () => remote})} : {}),
  };
  return {doc, win, group, listeners};
}

test('the Install app item is absent in standalone mode, both media query and iOS flag', () => {
  const a = fakeEnvironment({standalone: true});
  assert.equal(isStandalone(a.win), true);
  assert.equal(initInstallApp(a.doc, a.win), null);
  assert.equal(a.group.children.length, 0, 'no item is added to the menu');
  const b = fakeEnvironment({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone'});
  b.win.navigator.standalone = true;
  assert.equal(isStandalone(b.win), true, 'iOS navigator.standalone counts');
  assert.equal(initInstallApp(b.doc, b.win), null);
});

test('the Install app item shows in a browser tab and opens the iOS sheet', async () => {
  const env = fakeEnvironment({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone'});
  assert.equal(isStandalone(env.win), false);
  const button = initInstallApp(env.doc, env.win);
  assert.equal(button.textContent, 'Install app');
  assert.equal(env.group.children[0], button);
  await button.listeners.click();
  const sheet = env.doc.body.children.at(-1);
  assert.equal(sheet.id, 'install-dialog');
  assert.equal(sheet.open, true);
  const steps = sheet.children[2];
  assert.ok(steps.children.some(c => c.innerHTML?.includes('<svg')), 'the share glyph is drawn');
  assert.ok(steps.children.includes(' Share, then Add to Home Screen.'), 'the iOS instruction names Share then Add to Home Screen');
});

test('Chrome uses the captured beforeinstallprompt event, and the item disappears once installed', async () => {
  const env = fakeEnvironment();
  assert.equal(isIOS({userAgent: 'Linux; Android', platform: 'Linux armv8l', maxTouchPoints: 5}), false);
  assert.equal(isIOS({platform: 'MacIntel', maxTouchPoints: 5, userAgent: ''}), true, 'iPadOS reports as Mac');
  const button = initInstallApp(env.doc, env.win);
  let prompted = 0;
  let prevented = false;
  env.listeners.beforeinstallprompt({preventDefault() { prevented = true; }, prompt: async () => { prompted++; }});
  assert.equal(prevented, true);
  await button.listeners.click();
  assert.equal(prompted, 1, 'the native prompt runs');
  env.listeners.appinstalled();
  assert.equal(button.removed, true, 'the item is removed after install');
});

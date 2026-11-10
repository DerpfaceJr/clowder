// Clowder service worker. Classic script (no ES module syntax) so iOS Safari and Android Chrome both accept it.
// Bump CACHE when the shell changes shape; activate deletes every older clowder-* cache.
const CACHE = 'clowder-v5';
const SHELL = ['/', '/style.css', '/immersive.css', '/settings-menu.css', '/app.js', '/mobile-ui.js', '/manifest.webmanifest',
  '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png',
  '/fonts/fraunces-latin-full-normal.woff2', '/fonts/figtree-latin-wght-normal.woff2'];

// Pure routing, exported for tests (see test/pwa.test.mjs, which runs this file in a sandbox).
// Returns one of: 'pass' (let the browser handle it), 'navigate' (network first, cached shell offline),
// 'fresh' (network first, cached copy offline: the app's own code, so an update never mixes old and new modules),
// 'static' (stale-while-revalidate: icons, three.js and models, which only change with their file names or rarely),
// 'share' (the manifest's share_target: a shared file, stashed for the owner to save, below).
const SHARE_PATH = '/share-target';
function route({method, url, origin, navigate}) {
  if (method !== 'GET' && method !== 'POST') return 'pass';
  let u;
  try { u = new URL(url, origin); } catch { return 'pass'; }
  if (u.origin !== origin) return 'pass';
  const path = u.pathname;
  if (method === 'POST') return path === SHARE_PATH ? 'share' : 'pass';
  if (path === '/api' || path.startsWith('/api/')) return 'pass';
  // Only the app's own page is kept as the offline page (networkFirst stores it under '/'). A navigation to anything else, such as an
  // artifact a cat wrote opened in a tab, or the APK, goes to the network: it must never become what the town's address shows offline.
  if (navigate) return path === '/' || path === '/index.html' ? 'navigate' : 'pass';
  if (path === '/sw.js') return 'pass';
  if (path.startsWith('/icons/') || path.startsWith('/vendor/three/')) return 'static';
  if (path.startsWith('/fonts/') && /\.woff2$/.test(path)) return 'static';
  if (/\.(?:js|css|webmanifest)$/.test(path)) return 'fresh';
  if (/\.(?:png|jpe?g|svg|webp|ico)$/.test(path)) return 'static';
  if (path.startsWith('/assets/') && /\.(?:glb|json)$/.test(path)) return 'static';
  return 'pass';
}

// A notification's answer button (plan 3.4), exported for tests. Only an answer the server put on the notice is sent: the decision id
// and the answer come from the push payload, never from the action name. Null when the tap was not an answer button.
function answerFor(data, action) {
  const id = data && data.approval, list = data && data.actions;
  if (!action || typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || !Array.isArray(list)) return null;
  const pick = list.find(a => a && a.action === action);
  if (!pick || typeof pick.answer !== 'string' || !pick.answer || pick.answer.length > 200 || typeof pick.approved !== 'boolean') return null;
  return {path: `/api/approvals/${id}`, body: {answer: pick.answer, approved: pick.approved}};
}

// An owner verb button (plan 11.25: Mark done, Remind me tomorrow, Retry), exported for tests. The item and the verb come from the push
// payload; the server checks both again (owner-verbs.ts), so a tap on an item already settled is refused and opens the card.
function verbFor(data, action) {
  const id = data && data.item, list = data && data.actions;
  if (!action || typeof id !== 'string' || !/^[\w:-]{1,120}$/.test(id) || !Array.isArray(list)) return null;
  const pick = list.find(a => a && a.action === action);
  if (!pick || !['done', 'remind', 'retry'].includes(pick.verb)) return null;
  return {path: `/api/quests/${encodeURIComponent(id)}/verb`, body: {verb: pick.verb}};
}

// The share target (plans 11.22, 11.25). The worker never uploads on its own: any site can POST a form here, so a shared file is only
// stashed in this browser (Cache Storage, under a random id, for STASH_MS) and the app opens at /?share=<id>. There app.js names each file
// and uploads only when the owner taps Save to Archive; Discard, expiry, a non-owner page or another id deletes the stash.
// app.js repeats SHARE_CACHE, STASH_PREFIX and STASH_MS; SHARE_CAP is uploads.ts UPLOAD_CAP (test/share-target-ui.test.mjs checks both).
const SHARE_CACHE = 'share-stash', STASH_PREFIX = '/share-stash/', STASH_MS = 10 * 60 * 1000, SHARE_CAP = 20 * 1024 * 1024, SHARE_FILES = 10;

// Exported for tests: what one share stashes. Empty files and files over the upload cap are left out; at most SHARE_FILES.
function stashEntries(form, id, now) {
  const files = form && typeof form.getAll === 'function' ? form.getAll('file') : [];
  return files.filter(f => f && typeof f === 'object' && typeof f.size === 'number' && f.size > 0 && f.size <= SHARE_CAP).slice(0, SHARE_FILES).map((file, i) => ({
    url: `${STASH_PREFIX}${id}/${i}`, body: file,
    headers: {'Content-Type': typeof file.type === 'string' && file.type ? file.type : 'application/octet-stream', 'X-File-Name': encodeURIComponent(typeof file.name === 'string' && file.name ? file.name : 'Shared file'), 'X-File-Size': String(file.size), 'X-Stashed-At': String(now)},
  }));
}

// Drops every stashed file older than STASH_MS (or with no time), so an abandoned share does not linger.
async function sweepStash(cache, now) {
  for (const request of await cache.keys()) {
    const response = await cache.match(request), at = Number(response && response.headers.get('X-Stashed-At'));
    if (!(now - at < STASH_MS)) await cache.delete(request);
  }
}

// A share POST: stash, then open the app on it. Nothing is sent to the town here.
async function receiveShare(request) {
  let id = '';
  try {
    const cache = await caches.open(SHARE_CACHE), now = Date.now();
    await sweepStash(cache, now);
    const entries = stashEntries(await request.formData(), crypto.randomUUID(), now);
    for (const entry of entries) await cache.put(entry.url, new Response(entry.body, {headers: entry.headers}));
    if (entries.length) id = entries[0].url.split('/')[2];
  } catch { /* not a form, or storage off: open the app with nothing to save */ }
  return Response.redirect(new URL(id ? `/?share=${id}` : '/', self.location.origin).href, 303);
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined') {
  self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {})))).then(() => self.skipWaiting()));
  });

  self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
      .then(names => Promise.all(names.filter(n => n.startsWith('clowder-') && n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim()));
  });

  self.addEventListener('fetch', event => {
    const request = event.request;
    const kind = route({method: request.method, url: request.url, origin: self.location.origin, navigate: request.mode === 'navigate'});
    if (kind === 'navigate') event.respondWith(networkFirst(request));
    else if (kind === 'fresh') event.respondWith(networkFirstAsset(request));
    else if (kind === 'static') event.respondWith(staleWhileRevalidate(request));
    else if (kind === 'share') event.respondWith(receiveShare(request));
    // 'pass': no respondWith, so /api (including SSE and every POST) goes straight to the network.
  });

  // Web Push. A payload is only title, body, a same-origin path and a tag; anything else is ignored, and the path must start with a single slash.
  const safePath = url => (typeof url === 'string' && url.length <= 200 && /^\/(?!\/)[\w\-./?#=&%]*$/.test(url)) ? url : '/';

  self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
    const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'Clowder';
    const body = typeof data.body === 'string' ? data.body.slice(0, 240) : '';
    const tag = typeof data.tag === 'string' ? data.tag.slice(0, 80) : undefined;
    const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2).filter(a => a && typeof a.action === 'string' && typeof a.title === 'string') : [];
    event.waitUntil(self.registration.showNotification(title, {body, tag, icon: '/icons/icon-192.png', data: {url: safePath(data.url), approval: data.approval, item: data.item, actions},
      ...(actions.length ? {actions: actions.map(a => ({action: a.action, title: a.title.slice(0, 40)}))} : {})}));
  });

  // An answer or verb button posts with this device's own cookie, so the journal names the device. Anything else, or a tap the town
  // refuses (already answered or settled, paused, offline), focuses the open Clowder window at the notice's path, or opens a new one there.
  self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = safePath(event.notification.data && event.notification.data.url);
    const answer = answerFor(event.notification.data, event.action) || verbFor(event.notification.data, event.action);
    event.waitUntil((async () => {
      if (answer) {
        try {
          const response = await fetch(answer.path, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(answer.body)});
          if (response.ok) return;
        } catch { /* offline: open the card below */ }
      }
      const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
      const client = windows.find(c => new URL(c.url).origin === self.location.origin);
      if (client) {
        await client.focus();
        try { await client.navigate(url); return; } catch { /* not navigable: open a fresh window below */ }
      }
      return self.clients.openWindow(url);
    })());
  });

  async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put('/', response.clone());
      return response;
    } catch {
      const shell = await cache.match('/');
      if (shell) return shell;
      return new Response('Clowder is offline. Open it again when your town is reachable.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
    }
  }

  async function networkFirstAsset(request) {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      return (await cache.match(request)) || Response.error();
    }
  }

  async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const refresh = fetch(request).then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    }).catch(() => undefined);
    if (cached) return cached;
    return (await refresh) || new Response('', {status: 504});
  }
}

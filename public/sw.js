// Clowder service worker. Classic script (no ES module syntax) so iOS Safari and Android Chrome both accept it.
// Bump CACHE when the shell changes shape; activate deletes every older clowder-* cache.
const CACHE = 'clowder-v4';
const SHELL = ['/', '/style.css', '/immersive.css', '/settings-menu.css', '/app.js', '/mobile-ui.js', '/manifest.webmanifest',
  '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png',
  '/fonts/fraunces-latin-full-normal.woff2', '/fonts/figtree-latin-wght-normal.woff2'];

// Pure routing, exported for tests (see test/pwa.test.mjs, which runs this file in a sandbox).
// Returns one of: 'pass' (let the browser handle it), 'navigate' (network first, cached shell offline),
// 'fresh' (network first, cached copy offline: the app's own code, so an update never mixes old and new modules),
// 'static' (stale-while-revalidate: icons, three.js and models, which only change with their file names or rarely).
function route({method, url, origin, navigate}) {
  if (method !== 'GET') return 'pass';
  let u;
  try { u = new URL(url, origin); } catch { return 'pass'; }
  if (u.origin !== origin) return 'pass';
  const path = u.pathname;
  if (path === '/api' || path.startsWith('/api/')) return 'pass';
  if (navigate) return 'navigate';
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
    event.waitUntil(self.registration.showNotification(title, {body, tag, icon: '/icons/icon-192.png', data: {url: safePath(data.url), approval: data.approval, actions},
      ...(actions.length ? {actions: actions.map(a => ({action: a.action, title: a.title.slice(0, 40)}))} : {})}));
  });

  // An answer button posts the answer with this device's own cookie, so the journal names the device. Anything else, or an answer the
  // town refuses (already answered, paused, offline), focuses the open Clowder window at the notice's path, or opens a new one there.
  self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = safePath(event.notification.data && event.notification.data.url);
    const answer = answerFor(event.notification.data, event.action);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SEEN_KEY} from '../public/setup-hub.js';

// Plan 8.10's proof in a real browser, with the 3D town loaded (headless WebGL is slow, so the waits are long). A scratch server (its own
// ports, a temporary CAT_TOWN_DATA, this launch's owner key) and a headless Chromium, at 1024 px and at 375 px on a touch screen:
// opening a cat's chat eases the camera to it (centred in the town the chat pane leaves showing at 1024), opening a work row replays its
// visit, a #thread= link opens that request's thread after load, and the page never scrolls sideways.
// Skipped where no Chromium, Edge or Chrome is installed. CLOWDER_TEST_BROWSER names another one.
const browserPath = [process.env.CLOWDER_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }).on('error', reject); });
const call = (page, path, body) => page.evaluate(([path, body]) => fetch(path, body ? {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)} : {}).then(r => r.json()), [path, body]);
// Where a cat stands on screen now, in px from the canvas corner, with the canvas size. The ease aims at the cat itself, not its house (the
// name label rides on the house), so this projects the cat's model through the camera (window.__town, the ?perf hook): of the two top
// groups tagged with the cat's id, the house and the cat, the cat is the one with a skeleton. Until its rigged model has loaded (often
// still loading at 375 px on a busy machine) the cat is makeAnimatedCat's stand-in (world-art.js), the group with userData.parts, on the
// same spot.
const catAt = (page, id) => page.evaluate(id => {
  const {scene, camera} = window.__town, c = document.getElementById('town-canvas'), tops = [];
  camera.updateMatrixWorld();
  scene.traverse(o => { if (o.userData.cat === id && o.parent?.userData.cat !== id) tops.push(o); });
  const rigged = o => { let found = false; o.traverse(k => { found ||= k.isBone || k.isSkinnedMesh; }); return found; };
  const model = tops.find(rigged) ?? tops.find(o => o.userData.parts);
  if (!model) return {x: NaN, y: NaN, w: c.clientWidth, h: c.clientHeight, tops: tops.length};
  const p = model.getWorldPosition(model.position.clone()).project(camera);
  return {x: (p.x * .5 + .5) * c.clientWidth, y: (-p.y * .5 + .5) * c.clientHeight, w: c.clientWidth, h: c.clientHeight, tops: tops.length};
}, id);

test('proof (plan 8.10) in a real browser: thread open eases to the cat, a work row replays its visit, #thread= opens after load, at 1024 and 375 px', {skip: !browserPath && 'no Chromium, Edge or Chrome here', timeout: 600_000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'town-links-ui-')), key = 'town-links-ui-owner-key', port = await freePort();
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  Object.assign(process.env, {PORT: String(port), CAT_REMOTE_PORT: String(await freePort()), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_OWNER_KEY: key});
  // The server never reaches the Internet from here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, {status: 503}));
  const {app: server} = await import('../src/server.ts');
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({executablePath: browserPath, headless: true});
  const base = `http://127.0.0.1:${port}/?owner=${key}&perf`;
  let task = null;
  try {
    for (const {width, height, phone} of [{width: 1024, height: 768, phone: false}, {width: 375, height: 812, phone: true}]) {
      const context = await browser.newContext({viewport: {width, height}, ...(phone ? {isMobile: true, hasTouch: true, deviceScaleFactor: 3} : {})});
      // The Setup hub opens 1.5 s after a first load and takes focus: marked seen. The welcome flight would hold the camera: marked seen below.
      await context.addInitScript(seen => { try { localStorage.setItem(seen, '1'); } catch { /* storage off */ } }, SEEN_KEY);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const step = name => t.diagnostic(`[${width}] ${name} at ${Date.now() - started} ms`), started = Date.now();
      const connected = async url => {
        step(`load ${url.replace(key, 'KEY')}`);
        await page.goto(url, {waitUntil: 'domcontentloaded'});
        await page.waitForFunction(() => !document.body.classList.contains('connecting') && !!document.querySelector('#cats .cat-button'), null, {timeout: 60_000});
        step('connected');
      };
      // The town is up once its cats have labels, the loading card is gone and no welcome flight is playing.
      const ready = async url => {
        await connected(url);
        await page.waitForFunction(() => document.getElementById('town-loading')?.hidden && document.querySelectorAll('#labels .world-label[data-cat]').length >= 2 && !!window.__town?.controls && !document.body.classList.contains('cinematic'), null, {timeout: 180_000});
        step('town up');
      };
      // Set-up on a first load, before the town matters: the welcome flight is marked seen, so the loads below never play it.
      await connected(base);
      await call(page, '/api/world/intro-seen', {});
      // One demonstration request (no model needed): the Mayor recruits the Scholar, the Critic and the Banker and asks them, so its chat
      // gets a work row with visits in it.
      if (!task) {
        const r = await call(page, '/api/chat', {cat: 'mayor', text: 'Help the town explore a small digital service. Ask the specialists to review it.', mode: 'demo'});
        task = typeof r.task === 'string' ? r.task : r.task?.id ?? null;
        assert.ok(task, `the demonstration request was taken: ${JSON.stringify(r).slice(0, 200)}`);
        await page.waitForFunction(id => fetch('/api/state').then(r => r.json()).then(s => s.tasks.some(t => t.id === id && t.status === 'done')), task, {timeout: 180_000, polling: 1000});
        step('demonstration done');
      }
      const cat = (await call(page, '/api/state')).cats.find(c => c.id !== 'mayor')?.id;
      assert.ok(cat, 'a cat besides the Mayor');
      // A fresh load: the request's visits are history now, so any visit after this is the replay's.
      await ready(base);
      await page.waitForFunction(() => !/Message animation/.test(document.getElementById('world-activity')?.textContent ?? ''), null, {timeout: 60_000});

      // 1. A cat's chat opens through the thread switcher's path (chat-thread.js open -> app.js select): the camera eases to it.
      const before = await catAt(page, cat), target0 = await page.evaluate(() => ({...window.__town.controls.target}));
      assert.ok(Number.isFinite(before.x), `${cat}'s model is found (${before.tops} tagged groups)`);
      await page.evaluate(id => window.__chatThread.open({kind: 'cat', id}), cat);
      await page.waitForFunction(() => document.getElementById('cat-header')?.textContent.length > 0);
      // Headless WebGL draws a few frames a second and town.js caps a frame's dt, so the ease takes longer than on a real screen: sampled
      // every 500 ms until the cat holds still (two samples within 1 px) or 40 s pass.
      const samples = [];
      for (let i = 0; i < 80; i++) { await page.waitForTimeout(500); samples.push(await catAt(page, cat)); if (samples.length > 4 && Math.abs(samples.at(-1).x - samples.at(-2).x) < 1 && Math.abs(samples.at(-2).x - samples.at(-3).x) < 1) break; }
      t.diagnostic(`${width} px: ${cat} x every 500 ms: ${samples.map(s => s.x.toFixed(0)).join(' ')}`);
      const after = samples.at(-1), target1 = await page.evaluate(() => ({...window.__town.controls.target}));
      const inset = await page.evaluate(() => { if (matchMedia('(max-width:899px)').matches) return 0; const p = document.getElementById('inspector-panel').getBoundingClientRect(), c = document.getElementById('town-canvas').getBoundingClientRect(); return Math.max(0, c.right - p.left); });
      const centre = (after.w - inset) / 2, moved = Math.hypot(target1.x - target0.x, target1.z - target0.z);
      t.diagnostic(`${width} px: ${cat} at x ${before.x.toFixed(0)} -> ${after.x.toFixed(0)} px (visible-town centre ${centre.toFixed(0)}, canvas ${after.w}x${after.h}, pane inset ${inset.toFixed(0)}); camera target moved ${moved.toFixed(2)} m; n=${samples.length} samples over ${samples.length / 2} s`);
      assert.ok(moved > .1, `${width}: the camera target moved (${moved.toFixed(2)} m)`);
      assert.ok(Math.abs(after.x - centre) < 12,`${width}: ${cat} ends near the centre of the visible town (${after.x.toFixed(0)} vs ${centre.toFixed(0)})`);
      if (!phone) assert.ok(inset >= 300, `1024: the chat pane covers ${inset.toFixed(0)} px of the town`);

      // 2. The visit still plays: the Mayor's chat, its work row, and the town shows the message animation.
      await page.evaluate(() => window.__chatThread.open({kind: 'mayor'}));
      await page.waitForSelector('#chat .work-row[aria-expanded="false"]', {timeout: 30_000});
      assert.equal(await page.evaluate(() => /Message animation/.test(document.getElementById('world-activity').textContent)), false, 'no visit before the row opens');
      await page.locator('#chat .work-row').first().click();
      const t0 = Date.now();
      await page.waitForFunction(() => /Message animation/.test(document.getElementById('world-activity').textContent), null, {timeout: 30_000});
      t.diagnostic(`${width} px: the work row's visit started ${Date.now() - t0} ms after the click: "${await page.evaluate(() => document.getElementById('world-activity').textContent)}"`);

      // 3. The 375 px strip: the town renders at the strip's size behind the sheet, and its labels are hidden.
      if (phone) {
        const strip = await page.evaluate(() => { const c = document.getElementById('town-canvas'); return {strip: document.body.classList.contains('town-strip'), css: [c.clientWidth, c.clientHeight], buffer: [c.width, c.height], dpr: devicePixelRatio, labels: getComputedStyle(document.getElementById('labels')).display}; });
        t.diagnostic(`375 px strip: town-strip=${strip.strip}, canvas ${strip.css.join('x')} css px, buffer ${strip.buffer.join('x')} px at dpr ${strip.dpr}, labels display ${strip.labels}`);
        assert.equal(strip.strip, true);
        assert.ok(strip.css[1] <= 120 && strip.buffer[1] <= 120 * strip.dpr, 'the renderer is the strip, not the full screen');
        assert.equal(strip.labels, 'none');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}: no sideways scroll with the chat open`);

      // 4. A #thread= link opens that request's thread after load (and the fragment is cleared, so a reload does not open it twice).
      await ready(`${base}#thread=${task}`);
      await page.waitForFunction(id => window.__chatThread.current().kind === 'request' && window.__chatThread.current().id === id, task, {timeout: 30_000});
      await page.waitForSelector('#chat .thread-head', {timeout: 30_000});
      const opened = await page.evaluate(() => ({head: document.querySelector('#chat .thread-head').textContent, hash: location.hash, visible: getComputedStyle(document.getElementById('inspector-panel')).display !== 'none' && !document.getElementById('inspector-panel').hidden, scrollWidth: document.documentElement.scrollWidth}));
      t.diagnostic(`${width} px: #thread= opened "${opened.head}"; hash after "${opened.hash}"; chat visible ${opened.visible}; scrollWidth ${opened.scrollWidth}`);
      assert.match(opened.head, /^Request /);
      assert.equal(opened.hash, '');
      assert.equal(opened.visible, true);
      assert.equal(opened.scrollWidth, width, `${width}: no sideways scroll with the thread open`);
      // And #cat= opens that cat's chat.
      await page.evaluate(id => { location.hash = `cat=${id}`; }, cat);
      await page.waitForFunction(id => window.__chatThread.current().id === id, cat, {timeout: 15_000});
      assert.deepEqual(errors, [], `${width}: no page errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    globalThis.fetch = realFetch;
    try { rmSync(dir, {recursive: true, force: true}); } catch { /* a file still held open on Windows: the temp folder clears it later */ }
  }
});

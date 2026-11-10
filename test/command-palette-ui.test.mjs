import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SURFACE_INFO} from '../public/command-palette.js';
import {SEEN_KEY} from '../public/setup-hub.js';
import {economyOn, loadConfig} from '../src/config.ts';

// Plan 8.9's proof in a real browser. A scratch server (its own port, a temporary CAT_TOWN_DATA, this launch's owner key) and a headless
// Chromium: every SURFACES entry in app.js opens from the command palette by keyboard alone (Ctrl+K, its name, Enter), at 1024 px and at
// 375 px on a touch screen, where the palette is a full-width sheet with 44 px rows and the page never scrolls sideways.
// Skipped where no Chromium, Edge or Chrome is installed. CLOWDER_TEST_BROWSER names another one.
const browserPath = [process.env.CLOWDER_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const SURFACE_KEYS = [...(/const SURFACES=\{(.*?)\};/.exec(app)?.[1] ?? '').matchAll(/(\w+):\(\)=>/g)].map(m => m[1]);
// Coins (the season surface) are offered only while the coin economy is on (economy.enabled, off as shipped); otherwise the palette leaves them out.
const coinsOn = economyOn(loadConfig(fileURLToPath(new URL('..', import.meta.url))));
const OFFERED = SURFACE_KEYS.filter(name => coinsOn || name !== 'season');
// What each surface shows once open. A new SURFACES entry needs its line here.
const OPENED = {memorial: '#memorial-panel[open]', archive: '#archive-panel[open]', season: '#season-panel:not([hidden])', models: '#models-dialog[open]', connectors: '#connectors-panel[open]',
  devices: '#share-dialog[open]', treasury: '#treasury-dialog[open]', studio: '#studio:not([hidden])', worlds: '#worlds-dialog[open]', routines: '#routines-dialog[open]', telegram: '#telegram-dialog[open]',
  memory: '#memory-dialog[open]', usage: '#treasury-dialog[open] #vault-usage:not([hidden])', discord: '#discord-dialog[open]', accounts: '#accounts-dialog[open]', clients: '#owner-clients-dialog[open]', mail: '#mail-watch-dialog[open]',
  ntfy: '#ntfy-dialog[open]', postoffice: '#post-office-dialog[open]', autonomy: '#town-menu[open] #settings-autonomy:not([hidden])',
  backups: '#town-menu[open] #settings-backup:not([hidden])'};
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

test('proof (plan 8.9) in a real browser: every SURFACES entry opens from the palette by keyboard alone, at 1024 and 375 px', {skip: !browserPath && 'no Chromium, Edge or Chrome here', timeout: 240_000}, async t => {
  assert.ok(SURFACE_KEYS.length >= 18);
  for (const name of SURFACE_KEYS) assert.ok(OPENED[name], `${name}: add what it shows once open to OPENED`);
  const dir = mkdtempSync(join(tmpdir(), 'palette-ui-')), key = 'palette-ui-owner-key', port = await freePort();
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  Object.assign(process.env, {PORT: String(port), CAT_REMOTE_PORT: String(await freePort()), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_OWNER_KEY: key});
  // The server never reaches the Internet from here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, {status: 503}));
  const {app: server} = await import('../src/server.ts');
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({executablePath: browserPath, headless: true});
  try {
    for (const {width, height, phone} of [{width: 1024, height: 768, phone: false}, {width: 375, height: 812, phone: true}]) {
      const context = await browser.newContext({viewport: {width, height}, ...(phone ? {isMobile: true, hasTouch: true} : {})});
      // The Setup hub opens once per browser, 1.5 s after load (settings-menu.js), as a modal that takes focus whenever its timer lands.
      // It is marked seen, so it cannot land between a focus change below and the check of it (it did once, in a loaded full run).
      await context.addInitScript(seen => { try { localStorage.setItem(seen, '1'); } catch { /* storage off: the hub may open */ } }, SEEN_KEY);
      // The 3D town is not needed, and headless WebGL is slow: without it the page shows its notice and every surface still opens.
      await context.route('**/town.js', route => route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?owner=${key}`);
      await page.waitForFunction(() => !document.body.classList.contains('connecting') && !!document.querySelector('#cats .cat-button'));
      // Probe-gated ☰ rows (AI models, Telegram, …) show once their routes answer; the palette offers what the menu offers.
      const controls = OFFERED.map(name => SURFACE_INFO[name].control).filter(Boolean);
      await page.waitForFunction(ids => ids.every(id => { const el = document.getElementById(id); return el && !el.hidden && getComputedStyle(el).display !== 'none'; }), controls);
      // A surface with several controls (the Post office: any of its entries) is offered once one of them shows.
      const anyOf = OFFERED.map(name => SURFACE_INFO[name].controls).filter(Boolean);
      await page.waitForFunction(groups => groups.every(ids => ids.some(id => { const el = document.getElementById(id); return el && !el.hidden && getComputedStyle(el).display !== 'none'; })), anyOf);

      // '/' on the page is plan 8.7's (focus the composer), never the palette's.
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('/');
      assert.equal(await page.locator('#command-palette[open]').count(), 0, `${width}: "/" does not open the palette`);
      // Plan 8.7: with no dialog open, "/" focuses the composer.
      assert.equal(await page.evaluate(() => document.querySelector('dialog[open]')?.id ?? null), null, `${width}: no dialog is open`);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', `${width}: "/" focuses the composer (plan 8.7)`);
      // Blurred again, so the palette below opens with nothing focused: closing a dialog gives focus back to what had it.
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#command-palette[open]');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'cp-input');
      // Measured once the opening fade has finished.
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
      const sheet = await page.evaluate(() => {
        const rect = document.getElementById('command-palette').getBoundingClientRect();
        const rows = [...document.querySelectorAll('#cp-list [role="option"]')];
        return {width: rect.width, left: rect.left, top: rect.top, scrollWidth: document.documentElement.scrollWidth, rows: rows.length,
          minRow: Math.min(...rows.map(r => r.getBoundingClientRect().height)), unnamed: rows.filter(r => !r.textContent.trim()).length};
      });
      t.diagnostic(`${width} px: palette ${Math.round(sheet.width)} px wide at x=${Math.round(sheet.left)}, y=${Math.round(sheet.top)}; ${sheet.rows} rows, shortest ${sheet.minRow.toFixed(1)} px; scrollWidth ${sheet.scrollWidth}`);
      assert.equal(sheet.scrollWidth, width, `${width}: the page does not scroll sideways with the palette open`);
      assert.equal(sheet.unnamed, 0, 'every row has a name');
      if (phone) {
        assert.equal(Math.round(sheet.width), width, '375: a full-width sheet');
        assert.equal(Math.round(sheet.left), 0);
        assert.equal(Math.round(sheet.top), 0, '375: from the top edge');
        assert.ok(sheet.minRow >= 44, `375 on touch: rows are at least 44 px (shortest ${sheet.minRow})`);
      }
      // A cat opens its chat; on a desk the cursor lands in the composer, a phone keeps its keyboard down.
      await page.keyboard.type('Mayor');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#inspector-panel:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement?.id === 'message'), !phone, `${width}: the composer ${phone ? 'is left alone' : 'has the cursor'}`);
      // Opened from the composer, Escape gives focus back to it.
      await page.locator('#message').focus();
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#command-palette[open]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#command-palette[open]', {state: 'detached'});
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', `${width}: Escape gives focus back to the composer`);

      if (!coinsOn) {
        await page.keyboard.press('Control+k');
        await page.waitForSelector('#command-palette[open]');
        await page.keyboard.type(SURFACE_INFO.season.label);
        await page.waitForFunction(label => document.getElementById('cp-input').value === label, SURFACE_INFO.season.label);
        assert.equal(await page.locator('#cp-list [data-id="surface:season"]').count(), 0, `${width}: with the coin economy off the palette offers no Coins row`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('#command-palette[open]', {state: 'detached'});
      }
      let opened = 0;
      for (const name of OFFERED) {
        await page.keyboard.press('Control+k');
        await page.waitForSelector('#command-palette[open]');
        await page.keyboard.type(SURFACE_INFO[name].label);
        await page.waitForFunction(id => document.getElementById(document.getElementById('cp-input').getAttribute('aria-activedescendant'))?.dataset.id === id, `surface:${name}`);
        await page.keyboard.press('Enter');
        await page.waitForSelector(OPENED[name], {state: 'attached', timeout: 10_000});
        assert.equal(await page.locator('#command-palette[open]').count(), 0, `${name}: the palette closed`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}: ${name} does not scroll the page sideways`);
        opened++;
        // Back to the town for the next one: Escape, then anything still open.
        await page.keyboard.press('Escape');
        await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
        if (await page.locator('#studio:not([hidden])').count()) await page.keyboard.press('Escape');
      }
      t.diagnostic(`${width} px: ${opened} of ${OFFERED.length} offered SURFACES entries opened by keyboard alone (${SURFACE_KEYS.length} in all; Coins ${coinsOn ? 'on' : 'off'})`);
      assert.equal(opened, OFFERED.length);
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

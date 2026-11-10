// Plan 8.12: the scratch app and the page probes that test/chat-spine-ui.test.mjs and scripts/gate8.mjs share. A scratch server (its own
// ports, a temporary CAT_TOWN_DATA, this launch's owner key), a headless Chromium, Edge or Chrome, and no Internet: globalThis.fetch is
// stubbed before the server loads. Nothing here touches the owner's app or its data.
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SEEN_KEY} from '../../public/setup-hub.js';

export const browserPath = [process.env.CLOWDER_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => p && existsSync(p));

const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Every SURFACES key in app.js, the ones window.openSurface opens by name.
export const SURFACE_KEYS = [...(/const SURFACES=\{(.*?)\};/.exec(app)?.[1] ?? '').matchAll(/(\w+):\(\)=>/g)].map(m => m[1]);
// What each surface shows once open. A new SURFACES entry needs its line here (the same map as command-palette-ui.test.mjs).
export const OPENED = {memorial: '#memorial-panel[open]', archive: '#archive-panel[open]', season: '#season-panel:not([hidden])', models: '#models-dialog[open]', connectors: '#connectors-panel[open]',
  devices: '#share-dialog[open]', treasury: '#treasury-dialog[open]', studio: '#studio:not([hidden])', worlds: '#worlds-dialog[open]', routines: '#routines-dialog[open]', telegram: '#telegram-dialog[open]',
  memory: '#memory-dialog[open]', usage: '#treasury-dialog[open] #vault-usage:not([hidden])', discord: '#discord-dialog[open]', accounts: '#accounts-dialog[open]', clients: '#owner-clients-dialog[open]', mail: '#mail-watch-dialog[open]',
  ntfy: '#ntfy-dialog[open]', postoffice: '#post-office-dialog[open]', autonomy: '#town-menu[open] #settings-autonomy:not([hidden])',
  backups: '#town-menu[open] #settings-backup:not([hidden])'};

export const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

/** Starts the scratch app once per process. Returns {port, key, close}. */
export async function startScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-spine-')), key = 'chat-spine-owner-key', port = await freePort();
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  Object.assign(process.env, {PORT: String(port), CAT_REMOTE_PORT: String(await freePort()), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_OWNER_KEY: key});
  globalThis.fetch = (async () => new Response(null, {status: 503}));
  const {app: server} = await import('../../src/server.ts');
  return {port, key, url: `http://127.0.0.1:${port}/?owner=${key}`, async close() {
    await server.close();
    try { rmSync(dir, {recursive: true, force: true}); } catch { /* a file still held open on Windows: the temp folder clears it later */ }
  }};
}

/** A page at the given size. seen: the Setup hub is marked seen, so its 1.5 s modal cannot take focus from a figure. */
export async function newPage(browser, {width = 1024, height = 768, phone = false, seen = true, context = null} = {}) {
  const ctx = context ?? await browser.newContext({viewport: {width, height}, ...(phone ? {isMobile: true, hasTouch: true} : {})});
  if (seen) await ctx.addInitScript(k => { try { localStorage.setItem(k, '1'); } catch { /* storage off: the hub may open */ } }, SEEN_KEY);
  // The 3D town is not needed, and headless WebGL is slow: without it the page shows its notice and every surface still opens.
  await ctx.route('**/town.js', route => route.abort());
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return {ctx, page, errors};
}

/** Loads the app and waits until the cats are listed. */
export async function loadApp(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !document.body.classList.contains('connecting') && !!document.querySelector('#cats .cat-button'));
}

/** Typable: the cats are listed (the stream is up), and the composer is on screen, enabled, not behind a modal dialog, with Send enabled. Runs in the page. */
export const TYPABLE = () => {
  const m = document.getElementById('message'), send = document.getElementById('send');
  if (!m || !send || m.disabled || send.disabled || document.querySelector('dialog:modal')) return false;
  if (document.getElementById('inspector-panel')?.hidden || document.body.classList.contains('connecting') || !document.querySelector('#cats .cat-button')) return false;
  const r = m.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(m).visibility !== 'hidden' && !m.closest('[inert]');
};

/** Controls on screen that have no accessible name. A heuristic (aria-label, labelledby, text, label, title, placeholder, alt), not a screen reader. Runs in the page. */
export const UNNAMED = () => {
  const visible = el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !el.closest('[hidden],[inert]'); };
  const named = el => {
    if (el.getAttribute('aria-label')?.trim()) return true;
    const by = el.getAttribute('aria-labelledby');
    if (by && by.split(/\s+/).some(id => document.getElementById(id)?.textContent.trim())) return true;
    if (el.textContent.trim()) return true;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
    if (el.closest('label')) return true;
    if (el.getAttribute('title')?.trim() || el.getAttribute('placeholder')?.trim()) return true;
    return !!el.querySelector('img[alt]:not([alt=""]), svg title');
  };
  const controls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=switch], summary')];
  const bad = controls.filter(el => visible(el) && !named(el));
  return {total: controls.filter(visible).length, count: bad.length, sample: bad.slice(0, 5).map(el => el.outerHTML.slice(0, 140))};
};

/**
 * The conversation's share of the chat sheet, at this moment. box: #chat's own box over the sheet (it fills the space left over, so it
 * includes empty space). shown: the part of the messages inside #chat's box, over the sheet (on screen, not scrolled away). Runs in the page.
 */
export const CHAT_SHARE = () => {
  const sheet = document.getElementById('inspector-panel').getBoundingClientRect(), chat = document.getElementById('chat').getBoundingClientRect();
  const shown = [...document.querySelectorAll('#chat > *')].map(el => el.getBoundingClientRect())
    .reduce((sum, r) => sum + Math.max(0, Math.min(r.bottom, chat.bottom) - Math.max(r.top, chat.top)), 0);
  return {sheet: sheet.height, chat: chat.height, box: chat.height / sheet.height, shown, shownShare: shown / sheet.height};
};

/** Sends a line to the Mayor's chat, the way the owner does: the composer, then Enter. */
export async function sayToMayor(page, text) {
  await page.locator('#message').fill(text);
  await page.locator('#message').press('Enter');
}

/** Opens the Mayor's chat from the command palette, the way the palette test does. */
export async function openMayorChat(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#command-palette[open]');
  await page.keyboard.type('Mayor');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#inspector-panel:not([hidden])');
}

/** The Demonstration decision: the Mayor asks for a draft approval with quick answers "Approve draft" and "Reject". */
export const DEMO_GOAL = 'Help the town explore a small digital service.';
// Attached, not visible: the strip hides a decision while its card in the conversation shows its answers (plan 11.6).
export async function askDemoDecision(page) {
  await sayToMayor(page, DEMO_GOAL);
  await page.waitForSelector('#approvals .decision-card[data-state="pending"] .decision-answer', {state: 'attached', timeout: 30_000});
}

/**
 * One quick decision answered from a surface, the way the owner taps it: 'strip' (the strip above the composer), 'inbox' (the Inbox
 * opened first) or 'thread' (the card in the chat). Waits for the 4 s Undo hold and the server's answer. Returns {id, taps}.
 */
export async function answerQuick(page, surface) {
  await askDemoDecision(page);
  const id = await page.evaluate(() => document.querySelector('#approvals .decision-card[data-state="pending"]').dataset.decision);
  const target = {strip: `#approvals [data-decision="${id}"] .decision-answer`, inbox: `#quests-body [data-decision="${id}"] .decision-answer`,
    thread: `#chat [data-decision="${id}"] .decision-answer`}[surface];
  let taps = 0;
  const inboxOpen = () => page.getAttribute('#toggle-quests', 'aria-expanded').then(v => v === 'true');
  if (surface === 'inbox') { await page.locator('#toggle-quests').click(); taps++; }
  // The strip shows a decision only while its card in the conversation is off screen (plan 11.6), as after the owner scrolls up.
  if (surface === 'strip') {
    await page.evaluate(() => { document.getElementById('chat').scrollTop = 0; });
    await page.locator(target).first().waitFor({state: 'visible', timeout: 5_000});
  }
  await page.locator(target).first().click();
  taps++;
  // Settled: the server has the answer and the card reads its approval back (data-state approved), after the 4 s Undo hold.
  await page.waitForSelector(`[data-decision="${id}"][data-state="approved"]`, {timeout: 15_000});
  if (surface === 'inbox' && await inboxOpen()) await page.locator('#toggle-quests').click();
  return {id, taps};
}

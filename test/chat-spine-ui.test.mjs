import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {browserPath, startScratch, newPage, loadApp, UNNAMED, SURFACE_KEYS, OPENED, openMayorChat, answerQuick} from './helpers/chat-spine-scratch.mjs';

// Plan 8.12, Gate 8's deterministic figures, in a real browser on a scratch server (see test/helpers/chat-spine-scratch.mjs):
//   taps per decision (2 from the strip, the Inbox and the thread; 3 for a card decision, which the Demonstration cannot produce),
//   the composer focused at open at 1024, Tab stops to the composer, scrollWidth 375 and unnamed controls on every SURFACES entry at 375.
// A Hermes decision and a connector decision render the same card: test/decision-card-ui.test.mjs, "a Hermes decision and a connector
// decision render the same card (Gate 8)", proves that, so it is not repeated here.
// The figures that are timings or depend on a live model are in scripts/gate8.mjs, not here.
// Skipped where no Chromium, Edge or Chrome is installed. CLOWDER_TEST_BROWSER names another one.
const skip = !browserPath && 'no Chromium, Edge or Chrome here';
let scratch, browser, chromium;

before(async () => {
  if (skip) return;
  scratch = await startScratch();
  ({chromium} = await import('playwright-core'));
  browser = await chromium.launch({executablePath: browserPath, headless: true});
});
after(async () => {
  await browser?.close();
  await scratch?.close();
});

test('the composer is focused at open on desktop (1024 x 768, Gate 8)', {skip, timeout: 180_000}, async () => {
  const {ctx, page, errors} = await newPage(browser, {width: 1024, height: 768});
  await loadApp(page, scratch.url);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', 'the composer has focus with the chat open');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A touch screen keeps its keyboard down at open, so a keyboard there starts from the top of the page. The first Tab stop is the
// "Go to conversation" skip link, and Enter on it puts the cursor in the composer. Keys are counted from page load: Tabs and that Enter.
test('at most 3 keys from page load to the composer where it is not focused at open (Gate 8)', {skip, timeout: 180_000}, async () => {
  const {ctx, page} = await newPage(browser, {width: 375, height: 812, phone: true});
  await loadApp(page, scratch.url);
  await page.waitForTimeout(500);
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'message', 'a touch screen is not focused at open');
  let keys = 0;
  while (keys < 40 && !['message', 'skip-to-chat'].includes(await page.evaluate(() => document.activeElement?.id))) {
    await page.keyboard.press('Tab');
    keys++;
  }
  if (await page.evaluate(() => document.activeElement?.id) === 'skip-to-chat') { await page.keyboard.press('Enter'); keys++; }
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message', 'the keyboard reaches the composer');
  assert.ok(keys <= 3, `${keys} keys to the composer, at most 3 allowed`);
  await ctx.close();
});

test('a quick decision takes at most 2 taps from the strip, the Inbox and the thread (Gate 8)', {skip, timeout: 120_000}, async () => {
  // The strip shows only while the thread's card is off screen; since 11.15's one-row header the card fits at 768, so a shorter window.
  const {ctx, page, errors} = await newPage(browser, {width: 1024, height: 560});
  await loadApp(page, scratch.url);
  await openMayorChat(page);
  const taps = {};
  for (const surface of ['strip', 'inbox', 'thread']) {
    const {taps: n} = await answerQuick(page, surface);
    assert.ok(n <= 2, `${surface}: ${n} taps, at most 2 allowed`);
    taps[surface] = n;
  }
  assert.deepEqual(taps, {strip: 1, inbox: 2, thread: 1});
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A card decision with no quick list (the 3-tap case) needs a connector or Hermes gate. The Demonstration script only asks quick
// decisions, so that case is not produced on a scratch server here.
test('a card decision with no quick list takes at most 3 taps (Gate 8)', {skip: skip || 'the Demonstration asks only quick decisions; a gate-made card needs a Hermes or connector gate on a scratch server'}, () => {});

test('every SURFACES entry at 375 x 812 scrolls to 375 px and every visible control has a name (Gate 8)', {skip, timeout: 240_000}, async () => {
  assert.ok(SURFACE_KEYS.length >= 18);
  for (const name of SURFACE_KEYS) assert.ok(OPENED[name], `${name}: add what it shows once open to OPENED`);
  const {ctx, page, errors} = await newPage(browser, {width: 375, height: 812, phone: true});
  // Anything the page's Content-Security-Policy (src/pwa.ts appCsp) blocks on any surface is recorded here.
  await ctx.addInitScript(() => { window.cspBlocked = []; addEventListener('securitypolicyviolation', e => window.cspBlocked.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  const [index] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/' && r.status() === 200), loadApp(page, scratch.url)]);
  assert.match(String(index.headers()['content-security-policy']), /^script-src 'self' 'sha256-/, 'the app page is served with its script policy');
  const failures = [];
  const check = async label => {
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (width !== 375) failures.push(`${label}: scrollWidth ${width}`);
    const unnamed = await page.evaluate(UNNAMED);
    if (unnamed.count) failures.push(`${label}: ${unnamed.count} unnamed control(s), e.g. ${unnamed.sample[0]}`);
  };
  await check('chat');
  for (const name of SURFACE_KEYS) {
    await page.evaluate(n => window.openSurface(n), name);
    await page.waitForSelector(OPENED[name], {state: 'attached', timeout: 10_000});
    await check(name);
    // Back to the town for the next one. A dialog's close event is queued, so it gets a task to run in before the next surface opens:
    // Autonomy and Backups share #town-menu, and a close event that came after Backups had opened hid its page again (timeout, seen under load).
    await page.keyboard.press('Escape');
    await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); return new Promise(done => setTimeout(done, 0)); });
    if (await page.locator('#studio:not([hidden])').count()) await page.keyboard.press('Escape');
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(await page.evaluate(() => window.cspBlocked), [], 'the script policy blocks nothing the app does');
  await ctx.close();
});

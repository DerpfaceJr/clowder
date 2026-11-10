#!/usr/bin/env node
// Plan 8.12: prints each Gate 8 figure on one line, with its n, its source and its status. A scratch server with a temporary data
// dir, a headless browser, no Internet. Run it with: npx tsx scripts/gate8.mjs
// Timings depend on machine load: run it on a quiet machine before quoting one. Figures that need a live model print UNRESOLVED.
import {cpus, freemem, totalmem} from 'node:os';
import {request} from 'node:http';
import {browserPath, startScratch, newPage, loadApp, TYPABLE, UNNAMED, CHAT_SHARE, SURFACE_KEYS, OPENED, openMayorChat, answerQuick} from '../test/helpers/chat-spine-scratch.mjs';

const out = (figure, value, {n, source, status = 'MEASURED', note = ''}) =>
  console.log(`${figure.padEnd(34)} ${String(value).padEnd(36)} n=${n}  SOURCE ${source}  ${status}${note ? `  -- ${note}` : ''}`);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = x => `${Math.round(x * 100)}%`;

console.log(`Gate 8 figures, scratch server, ${new Date().toISOString()}`);
console.log(`machine: ${cpus().length} CPUs, ${Math.round(freemem() / totalmem() * 100)}% RAM free (Windows has no load average here; timings are for a quiet machine only)`);

// Ollama: a live model answers only if one is running on this machine. Checked with node:http, which the scratch stub does not touch.
const ollamaUp = await new Promise(resolve => {
  const req = request('http://127.0.0.1:11434/api/tags', res => { res.resume(); resolve(res.statusCode === 200 ? 'up' : `HTTP ${res.statusCode}`); });
  req.setTimeout(2000, () => { req.destroy(); resolve('timeout'); });
  req.on('error', e => resolve(e.code ?? e.message));
  req.end();
});

const scratch = await startScratch();
const {chromium} = await import('playwright-core');
const browser = await chromium.launch({executablePath: browserPath, headless: true});
try {
  // 1. Time from navigation to a typable composer. Warm: five loads in one browser profile, seen Setup hub. First load: one fresh profile.
  const warm = [], warmContext = await browser.newContext({viewport: {width: 1024, height: 768}});
  for (let i = 0; i < 5; i++) {
    const {page} = await newPage(browser, {context: warmContext, seen: true});
    const t0 = Date.now();
    await page.goto(scratch.url);
    await page.waitForFunction(TYPABLE, null, {timeout: 30_000});
    warm.push(Date.now() - t0);
    await page.close();
  }
  out('typable composer, warm', `mean ${Math.round(mean(warm))} ms, median ${Math.round(median(warm))} ms`, {n: warm.length, source: 'goto to TYPABLE (test/helpers) per load', note: `loads: ${warm.join(', ')} ms; Gate 8 target 1,000 ms`});

  const first = await browser.newContext({viewport: {width: 1024, height: 768}});
  const cold = await newPage(browser, {context: first, seen: false});
  const t0 = Date.now();
  await cold.page.goto(scratch.url);
  try {
    await cold.page.waitForFunction(TYPABLE, null, {timeout: 15_000});
    out('typable composer, first load', `${Date.now() - t0} ms`, {n: 1, source: 'fresh profile, Setup hub not marked seen', note: 'the hub opens 1.5 s after load'});
  } catch {
    out('typable composer, first load', 'not typable in 15 s', {n: 1, source: 'fresh profile, Setup hub not marked seen', status: 'UNRESOLVED', note: 'the Setup hub modal holds the page from 1.5 s; typing needs it dismissed first'});
  }
  await first.close();

  // 2. Tab stops from page load to the composer.
  const tabs = await newPage(browser, {seen: true});
  await loadApp(tabs.page, scratch.url);
  await tabs.page.evaluate(() => document.activeElement?.blur?.());
  let stops = 0;
  while (stops < 40 && await tabs.page.evaluate(() => document.activeElement?.id) !== 'message') { await tabs.page.keyboard.press('Tab'); stops++; }
  out('Tab stops to composer', `${stops}`, {n: 1, source: 'Tab presses from blurred page to #message', note: 'Gate 8 target 3; baseline 21 was a DOM walk'});
  await tabs.ctx.close();

  // 3. Taps per quick decision, from each surface. Card decisions with no quick list cannot be produced by the Demonstration.
  const taps = await newPage(browser, {seen: true});
  await loadApp(taps.page, scratch.url);
  await openMayorChat(taps.page);
  for (const surface of ['strip', 'inbox', 'thread']) {
    const r = await answerQuick(taps.page, surface);
    out(`taps per decision, ${surface}`, `${r.taps}`, {n: 1, source: 'clicks on the answer path (answerQuick), decision answered on server', note: 'Gate 8 target 2 for a quick decision'});
  }
  out('taps per decision, card (no quick)', 'not produced', {n: 0, source: 'Demonstration asks only quick decisions', status: 'UNRESOLVED', note: 'needs a Hermes or connector gate on the scratch server'});
  await taps.ctx.close();

  // 4 and 5. Every SURFACES entry at 375 x 812, touch: scrollWidth and unnamed controls, one state each.
  const phone = await newPage(browser, {width: 375, height: 812, phone: true, seen: true});
  await loadApp(phone.page, scratch.url);
  const widths = [], unnamedCounts = [], unnamedSamples = [];
  const measure = async name => {
    widths.push([name, await phone.page.evaluate(() => document.documentElement.scrollWidth)]);
    const u = await phone.page.evaluate(UNNAMED);
    unnamedCounts.push(u.count);
    if (u.count) unnamedSamples.push(`${name}: ${u.sample[0]}`);
  };
  await measure('chat');
  for (const name of SURFACE_KEYS) {
    await phone.page.evaluate(n => window.openSurface(n), name);
    await phone.page.waitForSelector(OPENED[name], {state: 'attached', timeout: 10_000});
    await measure(name);
    await phone.page.keyboard.press('Escape');
    await phone.page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
    if (await phone.page.locator('#studio:not([hidden])').count()) await phone.page.keyboard.press('Escape');
  }
  const off = widths.filter(([, w]) => w !== 375).map(([n, w]) => `${n} ${w}`);
  out('scrollWidth at 375', off.length ? `${widths.length - off.length} of ${widths.length} at 375; off: ${off.join(', ')}` : `375 on all ${widths.length}`,
    {n: widths.length, source: 'documentElement.scrollWidth after window.openSurface, one state each', note: 'chat plus each SURFACES entry'});
  out('unnamed controls at 375', `${unnamedCounts.reduce((a, b) => a + b, 0)}`, {n: widths.length, source: 'UNNAMED heuristic (aria, text, label, title, placeholder, alt)',
    note: unnamedSamples[0] ? `first: ${unnamedSamples[0]}` : 'a heuristic, not a screen reader'});
  await phone.ctx.close();

  // 6. The conversation's share of the chat sheet at 1024 x 768, without and with a pending decision.
  const desk = await newPage(browser, {seen: true});
  await loadApp(desk.page, scratch.url);
  await openMayorChat(desk.page);
  await desk.page.waitForTimeout(500);
  const plain = await desk.page.evaluate(CHAT_SHARE);
  await desk.page.evaluate(() => document.activeElement?.blur?.());
  await desk.page.locator('#message').fill('Help the town explore a small digital service.');
  await desk.page.locator('#message').press('Enter');
  await desk.page.waitForSelector('#approvals .decision-card[data-state="pending"] .decision-answer', {state: 'attached', timeout: 30_000});
  await desk.page.waitForTimeout(500);
  const pending = await desk.page.evaluate(CHAT_SHARE);
  out('chat share, no decision', `messages ${pct(plain.shownShare)} of sheet (${Math.round(plain.shown)} of ${Math.round(plain.sheet)} px)`, {n: 1, source: 'messages inside #chat / #inspector-panel at 1024 x 768',
    note: `#chat box ${pct(plain.box)}, includes empty space; Gate 8 target 50%, baseline 22%`});
  out('chat share, decision pending', `messages ${pct(pending.shownShare)} of sheet (${Math.round(pending.shown)} of ${Math.round(pending.sheet)} px)`, {n: 1, source: 'as above, one quick decision pending',
    note: `#chat box ${pct(pending.box)}, includes empty space; Gate 8 target 50%`});
  await desk.ctx.close();

  // 7. First live text after Send on Ollama.
  out('first live text after Send, Ollama', 'not measured', {n: 0, source: 'GET 127.0.0.1:11434/api/tags', status: 'UNRESOLVED',
    note: ollamaUp === 'up' ? 'Ollama answers, but this script does not select an Ollama model for a cat yet' : `no Ollama answers on this machine (${ollamaUp})`});
} finally {
  await browser.close();
  await scratch.close();
}

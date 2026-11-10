// Plan 11.25: a file shared to the installed app (the manifest's share_target) reaches the town only when the owner taps Save to Archive.
// A real headless browser on a scratch server (test/helpers/chat-spine-scratch.mjs): the real service worker stashes the share, app.js shows
// the confirm sheet at 375 x 812, and the server's own journal is read before and after. Skipped where no Chromium, Edge or Chrome is installed.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {browserPath, startScratch, newPage, loadApp} from './helpers/chat-spine-scratch.mjs';

const skip = !browserPath && 'no Chromium, Edge or Chrome here';
const LONG = 'a-very-long-receipt-name-from-the-fishmonger-2026-11-09.txt';
let scratch, browser, worlds, origin;

before(async () => {
  if (skip) return;
  scratch = await startScratch();
  ({worlds} = await import('../src/server.ts'));
  origin = `http://127.0.0.1:${scratch.port}`;
  const {chromium} = await import('playwright-core');
  browser = await chromium.launch({executablePath: browserPath, headless: true});
});
after(async () => {
  await browser?.close();
  await scratch?.close();
});

const journal = () => ({events: worlds.store.state.events.length, artifacts: worlds.store.state.events.filter(e => e.type === 'artifact.created').length});
const stash = page => page.evaluate(async () => (await (await caches.open('share-stash')).keys()).map(r => new URL(r.url).pathname));
// Polled from here: the stash is read in the page each time, until it is empty or 10 s pass.
async function emptied(page) { for (let i = 0; i < 100; i++) { if (!(await stash(page)).length) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(`stash still holds ${await stash(page)}`); }
const sheet = page => page.locator('dialog.confirm-dialog[open]');

/** The owner's phone, with the service worker in control (a share target only reaches a page the worker controls). */
async function ownerPhone() {
  const p = await newPage(browser, {width: 375, height: 812, phone: true});
  await loadApp(p.page, scratch.url);
  await p.page.evaluate(() => navigator.serviceWorker.ready);
  await loadApp(p.page, `${origin}/`);
  await p.page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return p;
}
/** What the system share sheet does: a multipart POST of the files to the manifest's action, as a navigation. */
const share = (page, files) => page.evaluate(files => {
  const form = document.createElement('form'), input = document.createElement('input'), dt = new DataTransfer();
  Object.assign(form, {method: 'post', enctype: 'multipart/form-data', action: '/share-target'});
  for (const [name, text, type] of files) dt.items.add(new File([text], name, {type}));
  Object.assign(input, {type: 'file', name: 'file'});input.files = dt.files;
  form.append(input);document.body.append(form);form.submit();
}, files);
/** A stash written as the worker writes it, for the expiry and other-id cases. */
const plant = (page, id, at) => page.evaluate(async ([id, at]) => {
  await (await caches.open('share-stash')).put(`/share-stash/${id}/0`, new Response('planted', {headers: {'Content-Type': 'text/plain', 'X-File-Name': 'planted.txt', 'X-File-Size': '7', 'X-Stashed-At': String(at)}}));
}, [id, at]);

test('a share alone stores nothing on the server; the owner\'s sheet at 375 x 812 names the file, and Save stores it', {skip, timeout: 180_000}, async () => {
  const {ctx, page, errors} = await ownerPhone();
  const before = journal();
  await share(page, [[LONG, 'Receipt: 3 fish', 'text/plain']]);
  await sheet(page).waitFor();
  assert.deepEqual(journal(), before, 'the share POST and the sheet: 0 events, 0 artifacts on the server');
  assert.equal(await page.evaluate(() => location.search), '', 'the ?share= id leaves the address');
  assert.equal((await stash(page)).length, 1);
  const text = await sheet(page).innerText();
  assert.match(text, /Save this shared file\?/);
  assert.match(text, /a-very-long-receipt-n…-11-09\.txt \(text\/plain, 15 B\)/, 'name (cut in the middle), type and size');
  // 375 x 812: no sideways scroll on the page or in the sheet, and both buttons at least 44 px tall and on screen.
  const fit = await page.evaluate(() => {
    const d = document.querySelector('dialog.confirm-dialog[open]');
    return {page: document.documentElement.scrollWidth, sheet: d.scrollWidth - d.clientWidth,
      buttons: [...d.querySelectorAll('button')].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return {text: b.textContent, h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom)}; })};
  });
  assert.equal(fit.page, 375);assert.equal(fit.sheet, 0);
  assert.deepEqual(fit.buttons.map(b => b.text), ['Discard', 'Save to Archive']);
  for (const b of fit.buttons) assert.ok(b.h >= 44 && b.right <= 375 && b.bottom <= 812, JSON.stringify(b));
  console.log(`share sheet 375x812: scrollWidth ${fit.page}, buttons ${fit.buttons.map(b => `${b.text} ${b.h}px`).join(', ')}`);

  await sheet(page).getByRole('button', {name: 'Save to Archive'}).click();
  await page.waitForFunction(() => /Saved to the Archive/.test(document.getElementById('notice').textContent));
  const after = journal();
  assert.equal(after.artifacts, before.artifacts + 1, 'Save stores it');
  const saved = worlds.store.state.events.filter(e => e.type === 'artifact.created').at(-1).data;
  assert.deepEqual([saved.title, saved.cat], [LONG, 'owner']);
  assert.deepEqual(await stash(page), [], 'the stash is gone once saved');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Discard and an expired stash store nothing; a stash under another id is deleted', {skip, timeout: 180_000}, async () => {
  const {ctx, page, errors} = await ownerPhone();
  const before = journal();
  await share(page, [['notes.md', '# Notes', 'text/markdown'], ['photo.txt', 'not a photo', 'text/plain']]);
  await sheet(page).waitFor();
  assert.match(await sheet(page).innerText(), /Save these 2 shared files\?[\s\S]*notes\.md \(text\/markdown, 7 B\); photo\.txt \(text\/plain, 11 B\)/);
  await sheet(page).getByRole('button', {name: 'Discard'}).click();
  await emptied(page);
  assert.deepEqual(journal(), before, 'Discard: nothing stored');

  // Expired (older than 10 minutes) under the id in the address, and a fresh one under another id: both deleted, no sheet.
  await plant(page, 'expired', Date.now() - 10 * 60 * 1000 - 1);
  await plant(page, 'other', Date.now());
  await loadApp(page, `${origin}/?share=expired`);
  await emptied(page);
  assert.equal(await sheet(page).count(), 0);
  assert.deepEqual(journal(), before, 'expiry: nothing stored');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a page that is not the owner\'s shows no sheet and deletes the stash: a viewer, and this computer without the owner session', {skip, timeout: 180_000}, async () => {
  const before = journal();
  // A viewer: the same page reading readOnly from /api/state, as a paired viewer's does.
  const viewer = await ownerPhone();
  await viewer.ctx.route('**/api/state', async route => { const response = await route.fetch(), json = await response.json(); await route.fulfill({response, json: {...json, readOnly: true, me: {role: 'viewer'}}}); });
  await plant(viewer.page, 'v1', Date.now());
  await loadApp(viewer.page, `${origin}/?share=v1`);
  await emptied(viewer.page);
  assert.equal(await sheet(viewer.page).count(), 0, 'no sheet for a viewer');
  await viewer.ctx.close();
  // No owner session at all (the cats' browser, any other program here): the town refuses it, and the stash still goes.
  const stranger = await newPage(browser, {width: 375, height: 812, phone: true});
  await stranger.page.goto(`${origin}/`);
  await stranger.page.evaluate(() => navigator.serviceWorker.ready);
  await plant(stranger.page, 's1', Date.now());
  await stranger.page.goto(`${origin}/?share=s1`);
  await emptied(stranger.page);
  assert.equal(await sheet(stranger.page).count(), 0);
  await stranger.ctx.close();
  assert.deepEqual(journal(), before);
});

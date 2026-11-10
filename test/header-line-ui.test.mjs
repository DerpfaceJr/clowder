// Plan 11.5: the header says what waits on the owner, and when Clowder is not answering.
// (a) A lead before the activity line, "3 decisions waiting", from the items behind the one "needs you" count; the phone's town strip
// mirrors it. (b) While the host is down, one bar with Retry; the activity line hides; Send says why it is off. (c) The Mayor's notice
// compares the count with the decisions that count (needsYou true), so a goal-removal suggestion no longer hides a to-do (N4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {waitingLead, stripCaption, initPaneLayout} from '../public/mobile-ui.js';
import {splitNeeds} from '../public/quests-panel.js';
import {nounOf} from '../public/plain-words.js';
import {SEEN_KEY} from '../public/setup-hub.js';
import {PROMPT_KEY} from '../public/notify-prompt.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
// Line endings are normalised: a Windows checkout has CRLF, and the patterns below expect LF.
const read = name => readFileSync(join(repo, 'public', name), 'utf8').replace(/\r\n/g, '\n');
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

// Quest fixtures in /api/quests's shape (src/quests.ts quest()).
const quest = (kind, id, title, needsYou, rank = 'S') => ({id: `${kind}:${id}`, rank, title, detail: '', at: '2026-11-09T12:00:00.000Z', source: {kind, id}, action: {label: 'Open', panel: 'chat'}, needsYou});
const nouns = list => splitNeeds(list).needs.map(nounOf);

test('the lead names what waits in the Inbox nouns, with the one count as its number', () => {
  const three = [quest('approval', 'a1', 'May the town continue?', true), quest('approval', 'a2', 'May it post?', true), quest('purchase', 'p1', 'Approve purchase: Shop 12.00 USD', true)];
  assert.equal(waitingLead(nouns(three)), '3 decisions waiting', 'approvals and a purchase are all Decisions (plain-words.js)');
  assert.equal(waitingLead(nouns([quest('owner-step', 's1', 'Owner step: Sign the lease', true, 'A')])), '1 to-do waiting');
  assert.equal(waitingLead(nouns([quest('owner-step', 's1', 'One', true, 'B'), quest('owner-step', 's2', 'Two', true, 'A')])), '2 to-dos waiting');
  assert.equal(waitingLead(nouns([quest('approval', 'a1', 'Q', true), quest('owner-step', 's1', 'One', true), quest('owner-step', 's2', 'Two', true)])), '1 decision and 2 to-dos waiting');
  assert.equal(waitingLead(nouns([quest('approval', 'a1', 'Q', true), quest('goal', 'g1', 'Waiting on you: Open the cafe', true, 'A')])), '2 things waiting', 'any other kind makes them things');
  // Only items that count: a goal-removal suggestion (needsYou false) and a For you card are left out, as the badge leaves them out.
  const n4 = [quest('approval', 'r1', 'Remove the goal “Old fair”?', false, 'C'), quest('owner-step', 's1', 'Owner step: Sign the lease', true, 'A'), quest('suggestion', 'reply:mail:1', 'Reply to Ana', false, 'E')];
  assert.equal(waitingLead(nouns(n4)), '1 to-do waiting');
  assert.equal(nouns(n4).length, splitNeeds(n4).needs.length, 'the number is needsYouCount');
  assert.equal(waitingLead([]), '', 'nothing waits: no lead');
  assert.equal(waitingLead(undefined), '');
  for (const list of [three, n4]) assert.doesNotMatch(waitingLead(nouns(list)), /coin|season/i, 'no coin or season copy');
});

test('the strip caption is the lead, then the activity line, each only while shown', () => {
  assert.equal(stripCaption('3 decisions waiting', ' Meadow life · 3 cats sleeping '), '3 decisions waiting · Meadow life · 3 cats sleeping');
  assert.equal(stripCaption('', 'Meadow life'), 'Meadow life', 'nothing waits: the activity line alone, as before');
  assert.equal(stripCaption('', ''), '', 'Clowder is not answering: both hidden, so the caption is empty (and its :empty rule hides it)');
});

// A small DOM for initPaneLayout (the shape of mobile-ui.test.mjs's), with a MutationObserver the test flushes by hand.
class FakeEl {
  constructor(doc, tag, {id = '', className = '', attrs = {}, hidden = false, text = ''} = {}) {
    Object.assign(this, {ownerDocument: doc, tagName: tag.toUpperCase(), id, attrs: {...attrs}, hidden, textContent: text, children: [], parentElement: null, listeners: {}, classes: new Set(className.split(' ').filter(Boolean))});
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(' ').filter(Boolean)); }
  get classList() { const c = this.classes; return {add: n => c.add(n), remove: n => c.delete(n), contains: n => c.has(n), toggle: (n, on = !c.has(n)) => { if (on) c.add(n); else c.delete(n); return on; }}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  detach() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; }
  append(...nodes) { for (const n of nodes) { n.detach(); n.parentElement = this; this.children.push(n); } }
  prepend(n) { n.detach(); n.parentElement = this; this.children.unshift(n); }
  insertBefore(n, ref) { n.detach(); n.parentElement = this; const at = this.children.indexOf(ref); this.children.splice(at < 0 ? this.children.length : at, 0, n); }
  before(n) { this.parentElement.insertBefore(n, this); }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.detach(); this.append(...nodes); }
  cloneNode() { return new FakeEl(this.ownerDocument, this.tagName, {className: this.className, text: this.textContent}); }
  get outerHTML() { return `<${this.tagName}>${this.textContent}`; }
  contains(n) { for (let at = n; at; at = at.parentElement) if (at === this) return true; return false; }
  matches(sel) {
    if (sel.startsWith('.')) return this.classes.has(sel.slice(1));
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    return attr ? this.attrs[attr[1]] === attr[2] : this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const deep = c.querySelector(sel); if (deep) return deep; } return null; }
}

test('the phone strip mirrors the header line: the lead first, and neither part while the header hides it', () => {
  const doc = {activeElement: null, addEventListener() {}};
  const el = (tag, opts, ...kids) => { const node = new FakeEl(doc, tag, opts); node.append(...kids); return node; };
  doc.createElement = tag => el(tag);
  const activity = el('span', {id: 'world-activity', text: 'Meadow life · 3 cats sleeping'});
  const line = el('div', {className: 'world-life'}, el('span', {id: 'connection', text: 'Town connected'}), activity, el('span', {id: 'world-state', text: 'At ease'}));
  const inspector = el('aside', {id: 'inspector-panel', hidden: true}, el('div', {className: 'panel-tools'}), el('div', {id: 'cat-header'}, el('div', {}, el('h2', {text: 'Mayor’s corner'}))), el('div', {className: 'tabs'}));
  const main = el('main', {}, el('section', {className: 'world'}, el('div', {id: 'canvas-wrap'})), inspector, el('aside', {id: 'quests-panel', hidden: true}));
  doc.body = el('body', {className: 'immersive'}, el('header', {}, line), main, el('nav', {}, el('button', {id: 'dock-town'}), el('button', {id: 'dock-more'}), el('div', {id: 'dock-more-menu'})));
  doc.getElementById = id => { const walk = node => node.id === id ? node : node.children.map(walk).find(Boolean) ?? null; return walk(doc.body); };
  const watched = [];
  class Observer { constructor(fn) { this.fn = fn; } observe(node, options) { watched.push({node, options, fn: this.fn}); } }
  const query = {matches: true, addEventListener() {}};
  initPaneLayout({doc, win: {addEventListener() {}, matchMedia: () => query, MutationObserver: Observer}, panels: ['inspector', 'quests'], setPanel() {}});
  const caption = doc.getElementById('town-strip-caption'), flush = () => { for (const w of watched) w.fn([]); };
  assert.equal(caption.textContent, 'Meadow life · 3 cats sleeping', 'before app.js draws a lead, the caption is the activity line, as before');
  const strip = watched.find(w => w.node === line);
  assert.ok(strip, 'the whole header line is watched, so a lead added later is seen');
  assert.deepEqual([strip.options.subtree, strip.options.characterData, strip.options.childList, strip.options.attributes], [true, true, true, true]);
  assert.deepEqual(strip.options.attributeFilter, ['hidden'], 'and the parts’ hidden flags');
  // app.js inserts the lead before the activity line (its own span; town.js only writes the activity line).
  const lead = el('span', {id: 'world-waiting', text: '3 decisions waiting'});
  activity.before(lead);
  flush();
  assert.equal(caption.textContent, '3 decisions waiting · Meadow life · 3 cats sleeping', 'the strip starts with the lead');
  lead.hidden = true; flush();
  assert.equal(caption.textContent, 'Meadow life · 3 cats sleeping', 'nothing waits: the lead is left out');
  lead.hidden = false; flush();
  assert.equal(caption.textContent, '3 decisions waiting · Meadow life · 3 cats sleeping');
  lead.hidden = true; activity.hidden = true; flush();
  assert.equal(caption.textContent, '', 'Clowder is not answering: app.js hides both, and the caption is empty');
});

test('app.js draws the lead as its own span, the bar, Send’s reason and the notice rule; town.js and index.html are untouched', () => {
  const app = read('app.js');
  assert.match(app, /const waitingLine=el\('span',\{className:'world-waiting',attrs:\{id:'world-waiting'\}\}\);waitingLine\.hidden=true;\$\('world-activity'\)\.before\(waitingLine\);/, 'its own span, before the activity line');
  assert.doesNotMatch(read('town.js'), /world-waiting|host-down/, 'town.js keeps the activity line to itself');
  assert.doesNotMatch(read('index.html'), /world-waiting|host-down|send-reason/, 'app.js adds the new parts; index.html is unchanged');
  // The lead and the notice read the list the Inbox fetched (one fetch), through the one needsYou rule.
  assert.match(app, /fetchImpl:readQuests,onCount:n=>\{/, 'the Inbox reads /api/quests through readQuests');
  assert.match(app, /if\(args\[0\]==='\/api\/quests'&&r\.ok\)\{try\{const list=await r\.clone\(\)\.json\(\);if\(Array\.isArray\(list\)\)questList=list;\}/, 'a clone, so the panel still reads the body');
  assert.match(app, /function paintWaiting\(\)\{const text=questCount\?waitingLead\(splitNeeds\(questList\)\.needs\.map\(nounOf\)\):'';if\(waitingLine\.textContent!==text\)waitingLine\.textContent=text;waitingLine\.hidden=!text\|\|hostDown\(\);\}/);
  const notice = between(app, 'function paintQuestNotice(){', '\n}\n');
  assert.match(notice, /const decisions=splitNeeds\(questList\)\.needs\.filter\(q=>q\.source\?\.kind==='approval'\)\.length;/, 'the notice compares with decisions that count (N4)');
  assert.doesNotMatch(notice, /state\?\.approvals/, 'not with every pending approval');
  assert.match(notice, /show=selected==='mayor'&&questCount>decisions/);
  // The bar: the closed gate (plan 10.10), not a single failed frame.
  assert.match(app, /const hostDown=\(\)=>!connected&&gate\?\.gateState\(\)\.open===false;/);
  const bar = between(app, 'function paintHostDown(){', '\n}\n');
  assert.match(bar, /Clowder is not answering\. Retrying…\$\{awayFromHost\(\)\?' The host computer may be asleep or off\.':''\}/, 'the row’s words; away from the host, the likely reason');
  assert.match(bar, /\$\('world-activity'\)\.hidden=down;paintWaiting\(\);/, 'the activity line and its lead hide');
  assert.match(bar, /const why=down\?'Send is off while Clowder is not answering\.':connected\?'':'Send is off while Clowder reconnects\.';/);
  assert.match(bar, /\$\('send'\)\.title=why;\$\('send'\)\.setAttribute\('aria-label',why\?`Send message\. \$\{why\}`:'Send message'\);/, 'Send names the reason');
  assert.match(between(app, 'function paintConnection(){', '\n}\n'), /\n {2}paintHostDown\(\);$/, 'the connection line paints the bar, on every gate change and render');
  assert.match(app, /hostRetry\.onclick=\(\)=>\{hostRetry\.textContent='Trying…';openStream\(\);/, 'Retry opens the page stream again at once');
  assert.match(app, /function notify\(error\)\{if\(error instanceof TypeError&&hostDown\(\)\)return;/, 'no "Failed to fetch" beside the bar');
  assert.doesNotMatch(app.match(/Clowder is not answering[^'`]*/g).join(' '), /offline|coin|season/i);
  const css = read('style.css');
  assert.match(css, /\.immersive header \.world-waiting\[hidden\],\.immersive #world-activity\[hidden\]\{display:none\}/, '[hidden] outweighs immersive.css’s display:block');
  assert.match(css, /@media\(max-width:420px\)\{\.immersive header \.world-waiting\{display:none\}\}/, 'under 421px the strip carries the lead, as it does the activity line');
  assert.match(css, /\.host-down-retry\{flex:none;min-width:88px\}/);
  assert.match(css, /\.host-down-bar\{[^}]*min-height:var\(--tap\)/, 'the bar holds a 44px Retry');
  assert.match(css, /body\.immersive\.host-down\{--sheet-top:calc\([^}]*var\(--host-bar-h,52px\)/, 'the panes move down under the bar');
  assert.match(css, /@media\(max-width:899px\)\{body\.immersive\.host-down\{--strip-top:calc\([^}]*var\(--host-bar-h,52px\)/, 'and the phone’s strip');
});

// The proof in a real browser. A scratch server in a child process (its own ports, a temporary CAT_TOWN_DATA, a fixed owner key, no
// outbound fetch, Demonstration only), and a headless Chromium at 1440×900 and at 375×812 on a touch screen, side by side. /api/quests is
// answered from a fixture, so the count is exact; one Demonstration request gives the state a real pending approval for the N4 case.
// The server is then killed (as a sleeping host would vanish) and started again on the same folder.
// The 3D town is not needed here, so town.js is refused and the activity line keeps index.html's words. Skipped without a browser.
const browserPath = [process.env.CLOWDER_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

test('proof (plan 11.5) in a real browser at 1440 and 375: the lead, the notice on N4, the bar while the server is down, and its end', {skip: !browserPath && 'no Chromium, Edge or Chrome here', timeout: 300_000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'header-line-ui-')), key = 'header-line-ui-owner-key', port = await freePort(), remotePort = await freePort();
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({connectors: [], plugins: []}));
  writeFileSync(join(dir, 'workshop-settings.json'), JSON.stringify({autoSetup: false}));
  const env = {...process.env, PORT: String(port), CAT_REMOTE_PORT: String(remotePort), CAT_TOWN_DATA: dir, CAT_TUNNEL_AUTOSTART: '0', CAT_OWNER_KEY: key};
  const boot = `globalThis.fetch=async()=>new Response(null,{status:503});await import(${JSON.stringify(pathToFileURL(join(repo, 'src', 'server.ts')).href)});`;
  const start = () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', boot], {cwd: repo, env, stdio: 'ignore'});
  const origin = `http://127.0.0.1:${port}`;
  const answering = async () => { for (const until = Date.now() + 90_000; Date.now() < until; await new Promise(r => setTimeout(r, 200))) { try { if ((await fetch(`${origin}/api/remote-access`)).status) return; } catch { /* not yet */ } } throw new Error('the scratch server did not start'); };
  let server = start();
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({executablePath: browserPath, headless: true});
  try {
    await answering();
    let fixture = [];
    const pages = [];
    for (const {width, height, phone} of [{width: 1440, height: 900, phone: false}, {width: 375, height: 812, phone: true}]) {
      const context = await browser.newContext({viewport: {width, height}, ...(phone ? {isMobile: true, hasTouch: true} : {})});
      // The Setup hub opens 1.5 s after a first load and takes focus, and the notifications card covers the dock: both marked seen.
      await context.addInitScript(([seen, prompt]) => { try { localStorage.setItem(seen, '1'); localStorage.setItem(prompt, 'later'); } catch { /* storage off */ } }, [SEEN_KEY, PROMPT_KEY]);
      await context.route('**/town.js', route => route.abort());
      await context.route('**/api/quests', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(fixture)}));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      pages.push({page, width, phone, errors});
    }
    const load = async ({page, phone}) => {
      await page.goto(`${origin}/?owner=${key}`, {waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => !document.body.classList.contains('connecting') && !!document.querySelector('#cats .cat-button') && document.getElementById('connection').dataset.state === 'up', null, {timeout: 60_000});
      if (phone && await page.evaluate(() => document.getElementById('inspector-panel').hidden)) await page.click('#toggle-inspector');
    };
    // The visible header line and strip caption, the bar and Send, and the 375 check's numbers.
    const look = page => page.evaluate(() => {
      const shown = n => !!n && n.getClientRects().length > 0 && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden';
      const rect = n => { const r = n.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height}; };
      const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const bar = document.getElementById('host-down'), retry = bar.querySelector('button'), send = document.getElementById('send'), caption = document.getElementById('town-strip-caption');
      const line = [...document.querySelectorAll('header .world-life > span')].filter(n => shown(n) && n.id !== 'connection' && n.id !== 'world-state').map(n => n.textContent.trim()).join(' · ');
      const pane = document.getElementById('inspector-panel'), strip = document.body.classList.contains('town-strip') ? document.getElementById('canvas-wrap') : null;
      const small = [...document.querySelectorAll('button,a[href],input,select,textarea')].filter(n => shown(n) && !n.disabled).map(n => [n, rect(n)])
        .filter(([, r]) => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && (r.width < 44 || r.height < 44)).map(([n, r]) => `${n.id || n.className}:${Math.round(r.width)}x${Math.round(r.height)}`);
      return {line, caption: shown(caption) ? caption.textContent : '', notice: shown(document.getElementById('quest-notice')) ? document.getElementById('quest-notice').textContent : '',
        bar: shown(bar) ? bar.querySelector('p').textContent : '', retry: shown(bar) ? rect(retry) : null,
        // Where the bar, the header and the chat pane sit, and the bar height the panes moved down by, for the diagnostics.
        rects: shown(bar) ? {bar: rect(bar), pane: rect(pane), header: rect(document.querySelector('body>header')), hostBarH: getComputedStyle(document.body).getPropertyValue('--host-bar-h')} : null,
        overlaps: shown(bar) ? {header: meet(rect(bar), rect(document.querySelector('body>header'))), pane: shown(pane) && meet(rect(bar), rect(pane)), strip: !!strip && meet(rect(bar), rect(strip))} : null,
        send: {disabled: send.disabled, title: send.title, label: send.getAttribute('aria-label')}, reason: shown(document.getElementById('send-reason')) ? document.getElementById('send-reason').textContent : '',
        message: document.getElementById('notice').textContent, scrollWidth: document.documentElement.scrollWidth, innerWidth, small};
    });

    // (a) Three decisions waiting.
    fixture = [quest('approval', 'a1', 'May the town continue?', true), quest('approval', 'a2', 'May it post?', true), quest('approval', 'a3', 'May it draft?', true)];
    await Promise.all(pages.map(load));
    for (const {page, width, phone} of pages) {
      await page.waitForFunction(phone => (phone ? document.getElementById('town-strip-caption') : document.getElementById('world-waiting'))?.textContent.startsWith('3 decisions waiting'), phone, {timeout: 30_000});
      const seen = await look(page);
      t.diagnostic(`${width}: header line "${seen.line}", strip "${seen.caption}"`);
      if (phone) assert.match(seen.caption, /^3 decisions waiting · Meadow life/, `${width}: the strip starts with the lead`);
      else assert.match(seen.line, /^3 decisions waiting · Meadow life/, `${width}: the header line starts with the lead`);
      assert.equal(seen.notice, '', `${width}: every counted item is a decision the strip above the composer shows, so no notice`);
      assert.equal(seen.scrollWidth, width, `${width}: no sideways scroll`);
    }

    // (c) N4: one goal-removal suggestion (a real pending approval, not counted) and one to-do. The old rule compared the count (1) with
    // every pending approval (1) and hid the notice.
    const sent = await pages[0].page.evaluate(() => fetch('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify({cat: 'mayor', text: 'Draft a sample offer.', mode: 'demo'})}).then(r => r.json()));
    assert.ok(sent.task, `the Demonstration request was taken: ${JSON.stringify(sent).slice(0, 200)}`);
    const approval = await pages[0].page.waitForFunction(() => fetch('/api/state').then(r => r.json()).then(s => s.approvals.find(a => a.status === 'pending')?.id), null, {timeout: 60_000, polling: 500}).then(h => h.jsonValue());
    fixture = [quest('approval', approval, 'Remove the goal “Old fair”?', false, 'C'), quest('owner-step', 's1', 'Owner step: Sign the lease', true, 'A')];
    await Promise.all(pages.map(load));
    for (const {page, width, phone} of pages) {
      await page.waitForFunction(phone => (phone ? document.getElementById('town-strip-caption') : document.getElementById('world-waiting'))?.textContent.startsWith('1 to-do waiting'), phone, {timeout: 30_000});
      await page.waitForFunction(() => !document.getElementById('quest-notice').hidden, null, {timeout: 10_000});
      const seen = await look(page);
      t.diagnostic(`${width}: N4 header line "${seen.line}", strip "${seen.caption}", notice "${seen.notice}"`);
      assert.equal(seen.notice, '1 thing needs you ›', `${width}: the notice shows for the to-do`);
    }
    fixture = [quest('approval', 'a1', 'May the town continue?', true), quest('approval', 'a2', 'May it post?', true), quest('approval', 'a3', 'May it draft?', true)];
    await Promise.all(pages.map(load));
    for (const {page, phone} of pages) await page.waitForFunction(phone => (phone ? document.getElementById('town-strip-caption') : document.getElementById('world-waiting'))?.textContent.startsWith('3 decisions waiting'), phone, {timeout: 30_000});
    for (const {page} of pages) await page.fill('#message', 'Typed before the host went away');

    // (b) The server goes away: the bar, the hidden line, Send's reason.
    const killed = Date.now();
    server.kill('SIGKILL');
    await Promise.all(pages.map(({page}) => page.waitForFunction(() => !document.getElementById('host-down').hidden, null, {timeout: 30_000, polling: 100})));
    t.diagnostic(`the bar showed on both pages ${Date.now() - killed} ms after the server was killed (the gate waits pollMs, 2,500 ms, after the stream drops)`);
    for (const {page, width, phone} of pages) {
      // The panes and the strip slide down under the bar (their top transitions); the layout is read once they have settled.
      await page.waitForFunction(() => { const bar = document.getElementById('host-down').getBoundingClientRect().bottom, below = [document.getElementById('inspector-panel'), document.body.classList.contains('town-strip') ? document.getElementById('canvas-wrap') : null];
        return below.every(n => !n || n.hidden || n.getBoundingClientRect().top >= bar); }, null, {timeout: 5_000}).catch(() => { /* the overlap assertion below reports it */ });
      const seen = await look(page);
      t.diagnostic(`${width}: down: ${JSON.stringify({rects: seen.rects, bar: seen.bar, retry: seen.retry, overlaps: seen.overlaps, send: seen.send, reason: seen.reason, small: seen.small})}`);
      assert.equal(seen.bar, 'Clowder is not answering. Retrying…', `${width}: one bar, the row's words (on this computer, so no gate hint)`);
      assert.equal(seen.line, '', `${width}: the activity line and its lead hide`);
      assert.equal(seen.caption, '', `${width}: and so does the strip's caption`);
      assert.deepEqual(seen.send, {disabled: true, title: 'Send is off while Clowder is not answering.', label: 'Send message. Send is off while Clowder is not answering.'}, `${width}: Send names the reason`);
      assert.equal(seen.reason, 'Send is off while Clowder is not answering.', `${width}: in words over the composer too`);
      assert.ok(seen.retry.width >= 44 && seen.retry.height >= 44, `${width}: Retry is a 44px target`);
      assert.deepEqual(seen.overlaps, {header: false, pane: false, strip: false}, `${width}: the bar covers neither the header, the chat pane nor the strip`);
      assert.equal(seen.scrollWidth, width, `${width}: no sideways scroll`);
      if (phone) assert.deepEqual(seen.small, [], '375: every tap target in view is at least 44px');
      assert.equal(await page.inputValue('#message'), 'Typed before the host went away', `${width}: the typed message stays`);
    }
    // Retry while still down: the bar stays and no "Failed to fetch" joins it.
    await pages[0].page.click('#host-down button');
    await pages[0].page.waitForTimeout(2000);
    const retried = await look(pages[0].page);
    assert.equal(retried.bar, 'Clowder is not answering. Retrying…');
    assert.equal(retried.message, '', 'one bar, no second message');

    // The server comes back on the same folder and key: the bar goes by itself, and the line and Send come back.
    const restarted = Date.now();
    server = start();
    await answering();
    const answered = Date.now();
    await Promise.all(pages.map(({page}) => page.waitForFunction(() => document.getElementById('host-down').hidden && document.getElementById('connection').dataset.state === 'up', null, {timeout: 60_000, polling: 100})));
    t.diagnostic(`the server answered ${answered - restarted} ms after it was started; the bar was gone on both pages ${Date.now() - answered} ms after that`);
    for (const {page, width, phone} of pages) {
      await page.waitForFunction(phone => (phone ? document.getElementById('town-strip-caption') : document.getElementById('world-waiting'))?.textContent.startsWith('3 decisions waiting'), phone, {timeout: 30_000});
      const seen = await look(page);
      assert.equal(seen.bar, '', `${width}: the bar is gone`);
      assert.deepEqual([seen.send.title, seen.send.label, seen.reason], ['', 'Send message', ''], `${width}: Send has no reason to give`);
      assert.equal(seen.scrollWidth, width);
    }
    for (const {width, errors} of pages) assert.deepEqual(errors, [], `${width}: no page errors`);
  } finally {
    await browser.close();
    server.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 500));
    rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});

// Mobile layout probe: opens each screen in headless Chrome at phone and tablet sizes and counts layout faults.
// Needs a running town (use a scratch server, never the live one). No dependencies: Chrome DevTools Protocol over WebSocket.
// Usage: node scripts/mobile-probe.mjs --url http://127.0.0.1:9301/?owner=<key from the server's Clowder: line> --tag before|after [--sizes 375x812,390x844,768x1024]
//        [--only cats,chat,chrome,intro] [--out <file.json>] [--shots <dir>] [--chrome <exe>]
// Per screen and size it reports: opened (root visible), hscroll (document overflow px), wide (elements past the viewport edge),
// small (interactive elements under 44px), closeOk (close button on screen and not covered), lastOk (last control reachable
// after scrolling its scroller to the bottom), overlaps (non-nested interactive pairs that overlap). The chrome (header, dock,
// camera stack) is measured once per size under the screen "chrome". Screenshots are JPEG: mobile-audit-<screen>-<width>-<tag>.jpg.
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const url = opt('url') || 'http://127.0.0.1:9301';
const tag = opt('tag') || 'probe';
const sizes = String(opt('sizes') || '375x812,390x844,768x1024').split(',').map(s => s.split('x').map(Number));
const only = opt('only') ? String(opt('only')).split(',') : null;
const here = dirname(fileURLToPath(import.meta.url));
const shots = opt('shots') || join(here, '..', 'docs', 'ui');
const out = opt('out');
const chrome = opt('chrome') || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) throw new Error('Chrome or Edge not found; pass --chrome.');
mkdirSync(shots, {recursive: true});

// Fixed debug port, outside the 9300-9800 band perf-probe draws from.
const port = 9905;
const profile = mkdtempSync(join(tmpdir(), 'mobile-probe-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], {stdio: 'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function json(path) { return (await fetch(`http://127.0.0.1:${port}${path}`)).json(); }
let target;
for (let i = 0; i < 60 && !target; i++) { try { target = (await json('/json/list')).find(t => t.type === 'page'); } catch {} if (!target) await sleep(200); }
if (!target) { proc.kill(); throw new Error(`Chrome did not start on ${port} (is the port taken?).`); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const problems = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(d.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200));
};
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, d => d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)); ws.send(JSON.stringify({id: n, method, params})); });
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

// Page-side measurement, installed once. Reads layout only; it changes no state except scrollTop, which it restores.
const PAGE = String.raw`(() => {
  const vw = () => document.documentElement.clientWidth, vh = () => innerHeight;
  const cs = el => getComputedStyle(el);
  const visible = el => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hidden || e.inert) return false;
      // Contents of a closed <details> are not on screen even though they keep a box.
      if (e.parentElement && e.parentElement.tagName === "DETAILS" && !e.parentElement.open && e.tagName !== "SUMMARY") return false;
      const s = cs(e); if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const inXScroller = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(cs(p).overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
  const label = el => { const t = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40); const r = el.getBoundingClientRect(); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') + ' "' + t + '" ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); };
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=option]';
  // A checkbox or radio inside a 44px label is covered by that label's tap area, so the input itself is exempt. So is a visually hidden input.
  // True when an ancestor scroller or clipper hides the element (a list item scrolled out of its own box is not on screen).
  const hiddenByAncestor = el => { const r = el.getBoundingClientRect(); for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = cs(p); if (o.overflowY !== 'visible' || o.overflowX !== 'visible') { const q = p.getBoundingClientRect(); if (r.bottom <= q.top || r.top >= q.bottom || r.right <= q.left || r.left >= q.right) return true; } } return false; };
  // The part of an element that its clipping ancestors leave on screen.
  const shown = el => { let r = el.getBoundingClientRect(); let l = r.left, tp = r.top, rt = r.right, bt = r.bottom; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = cs(p); if (o.overflowY !== 'visible' || o.overflowX !== 'visible') { const q = p.getBoundingClientRect(); l = Math.max(l, q.left); tp = Math.max(tp, q.top); rt = Math.min(rt, q.right); bt = Math.min(bt, q.bottom); } } return {l, t: tp, r: rt, b: bt}; };
  const exemptInput = el => { if (el.matches('input[type=checkbox], input[type=radio]')) { const l = el.closest('label'); if (l) { const r = l.getBoundingClientRect(); if (r.width >= 44 && r.height >= 44) return true; } } const r = el.getBoundingClientRect(); return r.width <= 2 || r.height <= 2; };
  const measure = (scopeSel, closeSel, lastSel) => {
    const scope = scopeSel ? document.querySelector(scopeSel) : null;
    const res = {opened: !!scope && visible(scope), rootRect: scope ? [scope.getBoundingClientRect()].map(r => [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)].join(","))[0] : "", wide: 0, wideSample: [], small: 0, smallSample: [], closeOk: null, closeInfo: '', lastOk: null, lastInfo: '', overlaps: 0, overlapSample: [], spill: 0, spillSample: [], clipped: 0, hscroll: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)};
    if (!scope) return res;
    const W = vw(), H = vh();
    const nodes = [scope, ...scope.querySelectorAll('*')];
    for (const el of nodes) {
      if (!visible(el) || inXScroller(el)) continue;
      const own = el.matches(INTERACTIVE) || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= 0 || r.left >= W) continue;
      if (r.right > W + 0.5 || r.left < -0.5) { res.wide++; if (res.wideSample.length < 8) res.wideSample.push(label(el)); }
      // Text that runs past its own box (not an intentional ellipsis) is cut or spills into a neighbour.
      if (el.clientWidth > 2 && el.getBoundingClientRect().width > 2 && cs(el).textOverflow !== 'ellipsis' && !el.matches('input,select,textarea') && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) {
        const rg = document.createRange(); rg.selectNodeContents(el); const tr = rg.getBoundingClientRect(), box = el.getBoundingClientRect();
        if (tr.width > 0 && (tr.right > box.right + 2 || tr.left < box.left - 2)) { res.spill++; if (res.spillSample.length < 6) res.spillSample.push(label(el)); }
      }
      if (el.scrollWidth > el.clientWidth + 2 && /(hidden|clip)/.test(cs(el).overflowX) && el.clientWidth > 0 && !el.matches('input,select,textarea')) res.clipped++;
    }
    const allInter = [...scope.querySelectorAll(INTERACTIVE)].filter(el => visible(el) && !inXScroller(el));
    const inter = [...scope.querySelectorAll(INTERACTIVE)].filter(el => visible(el) && !inXScroller(el) && !hiddenByAncestor(el) && !exemptInput(el));
    for (const el of inter) {
      const r = el.getBoundingClientRect();
      if (r.right <= 0 || r.left >= W || r.bottom <= 0 || r.top >= H) continue;
      if (r.width < 44 || r.height < 44) { res.small++; if (res.smallSample.length < 8) res.smallSample.push(label(el)); }
    }
    for (let i = 0; i < inter.length; i++) for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i], b = inter[j];
      if (a.contains(b) || b.contains(a)) continue;
      const x = shown(a), y = shown(b);
      const w = Math.min(x.r, y.r) - Math.max(x.l, y.l), h = Math.min(x.b, y.b) - Math.max(x.t, y.t);
      if (w > 4 && h > 4) { res.overlaps++; if (res.overlapSample.length < 6) res.overlapSample.push(label(a) + ' x ' + label(b)); }
    }
    if (closeSel) {
      const c = document.querySelector(closeSel);
      if (!c || !visible(c)) { res.closeOk = false; res.closeInfo = 'missing'; }
      else {
        const r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        res.closeOk = !!hit && (hit === c || c.contains(hit)) && x >= 0 && x <= W && y >= 0 && y <= H;
        res.closeInfo = label(c) + (res.closeOk ? '' : ' covered by ' + (hit ? label(hit) : 'nothing'));
      }
    }
    // At rest (before any scrolling) the last control should already be on screen and not under the dock or another control.
    const restLast = lastSel ? document.querySelector(lastSel) : allInter.filter(el => !el.closest('[hidden]')).pop();
    if (restLast && visible(restLast)) { const r = restLast.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); res.restOk = !!hit && (hit === restLast || restLast.contains(hit)) && x >= 0 && x <= W && y >= 0 && y <= H; res.restInfo = label(restLast) + (res.restOk ? '' : ' not on screen at rest'); } else { res.restOk = null; res.restInfo = ''; }
    // Scroll every scroller in the scope to its end; the last control must then be on screen and hit by a tap.
    const scrollers = nodes.filter(el => /(auto|scroll)/.test(cs(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
    const saved = scrollers.map(el => el.scrollTop);
    scrollers.forEach(el => el.scrollTop = el.scrollHeight);
    const last = lastSel ? document.querySelector(lastSel) : allInter.filter(el => !el.closest('[hidden]')).pop();
    if (last && visible(last)) {
      const r = last.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      res.lastOk = !!hit && (hit === last || last.contains(hit)) && x >= 0 && x <= W && y >= 0 && y <= H;
      res.lastInfo = label(last) + (res.lastOk ? '' : ' hidden under ' + (hit ? label(hit) : 'nothing'));
    } else { res.lastOk = null; res.lastInfo = 'no control'; }
    scrollers.forEach((el, i) => el.scrollTop = saved[i]);
    return res;
  };
  const chrome = sels => sels.map(s => { const m = measure(s); const q = document.querySelector(s); const b = q ? q.getBoundingClientRect() : null; return {scope: s, rect: b ? [b.left, b.top, b.right, b.bottom].map(Math.round).join(",") : "", opened: m.opened, wide: m.wide, wideSample: m.wideSample, small: m.small, smallSample: m.smallSample, overlaps: m.overlaps, overlapSample: m.overlapSample, hscroll: m.hscroll}; });
  window.__probe = {measure, chrome};
  return true;
})()`;

const RESET = `(() => {
  document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch {} });
  for (const p of ['residents', 'inspector', 'projects', 'quests', 'diary', 'season']) {
    const panel = document.getElementById(p + '-panel');
    if (panel && !panel.hidden) document.getElementById('toggle-' + p)?.click();
  }
  document.querySelectorAll('#inspector-panel details').forEach(d => d.open = false);
  document.querySelectorAll('.panel, .panel-body, .tab-pane').forEach(e => e.scrollTop = 0);
  document.querySelector('.gallery-viewer:not([hidden]) .gallery-close')?.click();
  document.querySelector('[data-tab="chat"]')?.click();
  return true;
})()`;

const WAIT = 'await new Promise(r => setTimeout(r, 700));';
const CAT = id => `document.querySelector('#cats [data-cat="${id}"]').click(); ${WAIT}`;
// Screens. open: JS run before measuring (async body). root and close are the selectors measured.
const SCREENS = [
  {name: 'chat', open: `document.getElementById('toggle-inspector').click(); ${WAIT}`, root: '#inspector-panel', close: '#inspector-panel .panel-close'},
  {name: 'chat-settings', open: `document.getElementById('toggle-inspector').click(); ${WAIT} document.querySelector('#inspector-panel details').open = true; ${WAIT}`, root: '#inspector-panel', close: '#inspector-panel .panel-close'},
  {name: 'approval-strip', open: `document.getElementById('toggle-inspector').click(); ${WAIT}`, root: '#approvals', close: null},
  {name: 'approval-sheet', open: `document.getElementById('toggle-inspector').click(); ${WAIT} document.querySelector('#approvals .approval-open')?.click(); ${WAIT}`, root: '#approval-dialog', close: '#approval-dialog [data-close]'},
  {name: 'cats', open: `document.getElementById('toggle-residents').click(); ${WAIT}`, root: '#residents-panel', close: '#residents-panel .panel-close'},
  {name: 'projects', open: `document.getElementById('toggle-projects').click(); ${WAIT}`, root: '#projects-panel', close: '#projects-panel .panel-close'},
  {name: 'quests', open: `document.getElementById('toggle-quests').click(); ${WAIT}`, root: '#quests-panel', close: '#quests-panel .panel-close'},
  {name: 'diary', open: `document.getElementById('toggle-diary').click(); ${WAIT}`, root: '#diary-panel', close: '#diary-panel .panel-close'},
  {name: 'coins', open: `document.getElementById('toggle-season').click(); ${WAIT}`, root: '#season-panel', close: '#season-panel .panel-close'},
  {name: 'memorial', open: `document.getElementById('toggle-memorial').click(); await new Promise(r => setTimeout(r, 3000));`, root: '#memorial-panel', close: '#memorial-close'},
  {name: 'moonvault', open: `document.getElementById('treasury-button').click(); ${WAIT}`, root: '#treasury-dialog', close: '#treasury-dialog [data-close]'},
  {name: 'models', open: `document.getElementById('models-chip').click(); ${WAIT}`, root: '#models-dialog', close: '#models-dialog [data-close]'},
  {name: 'menu', open: `document.getElementById('menu-toggle').click(); ${WAIT}`, root: '#town-menu', close: '#town-menu [data-close]'},
  {name: 'worlds', open: `document.getElementById('worlds-button').click(); ${WAIT}`, root: '#worlds-dialog', close: '#worlds-dialog .worlds-close'},
  {name: 'recruit', open: `document.getElementById('recruit').click(); ${WAIT}`, root: '#recruit-dialog', close: '#recruit-dialog [data-close]'},
  {name: 'road', open: `document.getElementById('road-button').click(); ${WAIT}`, root: '#road-dialog', close: '#road-dialog [data-close]'},
  {name: 'share', open: `document.getElementById('share').click(); ${WAIT}`, root: '#share-dialog', close: '#share-dialog [data-close]'},
  {name: 'memory', open: `${CAT('scholar')} document.querySelector('[data-tab="memory"]').click(); ${WAIT}`, root: '#memory', close: null},
  {name: 'gallery', open: `${CAT('artist')} document.querySelector('[data-tab="gallery"]').click(); ${WAIT}`, root: '#gallery', close: null},
  {name: 'gallery-viewer', open: `${CAT('artist')} document.querySelector('#gallery .gallery-hit')?.click(); ${WAIT}`, root: '.gallery-viewer:not([hidden])', close: '.gallery-viewer .gallery-close'},
  {name: 'gallery-web', open: `${CAT('artist')} document.querySelector('#gallery .gallery-web')?.click(); ${WAIT}`, root: '.gallery-viewer:not([hidden])', close: '.gallery-viewer .gallery-close'},
  {name: 'menu-appearance', open: `document.getElementById('menu-toggle').click(); ${WAIT} document.querySelector('#settings-list .menu-row[data-category="appearance"]')?.click(); ${WAIT}`, root: '#town-menu', close: '#town-menu [data-close]'},
  {name: 'menu-devices', open: `document.getElementById('menu-toggle').click(); ${WAIT} document.querySelector('#settings-list .menu-row:nth-child(3)')?.click(); ${WAIT}`, root: '#town-menu', close: '#town-menu [data-close]'},
  {name: 'confirm', open: `import('/dialogs.js').then(m => m.confirmDialog({title: 'Delete this world?', message: 'Its cats, chats and gallery go with it. This cannot be undone.', confirmLabel: 'Delete world', danger: true})); ${WAIT}`, root: '.confirm-dialog[open]', close: '.confirm-dialog .dialog-actions button'},
];
const CHROME = ['header', 'nav.town-dock', '.world-controls'];

const shotsTaken = [];
async function shot(name, width) {
  const {data} = await send('Page.captureScreenshot', {format: 'jpeg', quality: 60});
  const file = join(shots, `mobile-audit-${name}-${width}-${tag}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64')); shotsTaken.push(file);
}

const results = [];
const want = name => !only || only.includes(name);
await send('Page.enable'); await send('Runtime.enable');
try {
  for (const [w, h] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 768});
    await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
    await send('Page.navigate', {url});
    await sleep(2500);
    for (let i = 0; i < 150; i++) { if (await evaluate(`!!document.getElementById('toggle-inspector') && !document.body.classList.contains('connecting')`).catch(() => false)) break; await sleep(200); }
    await sleep(3000);
    // The intro plays on a world's first load. Probe it, then skip it so the other screens load clean.
    if (want('intro')) {
      const intro = await evaluate(`!!document.querySelector('.intro-cinema')`).catch(() => false);
      if (intro) {
        const m = await evaluate(`(() => { const s = document.querySelector('.intro-skip'); const sr = s ? s.getBoundingClientRect() : null; return {opened: true, hscroll: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth), skipOnScreen: !!sr && sr.left >= 0 && sr.top >= 0 && sr.right <= innerWidth && sr.bottom <= innerHeight, skipSize: sr ? Math.round(sr.width) + 'x' + Math.round(sr.height) : 'none'}; })()`);
        await shot('intro', w);
        results.push({screen: 'intro', width: w, ...m});
        await evaluate(`document.querySelector('.intro-skip')?.click()`).catch(() => {});
        await sleep(1500);
      } else results.push({screen: 'intro', width: w, opened: false, note: 'no intro on this load'});
    }
    await evaluate(PAGE);
    if (opt("eval")) { await evaluate(RESET); console.log(JSON.stringify(await evaluate(`(async () => { ${readFileSync(opt("eval"), "utf8")} })()`), null, 1)); continue; }
    await evaluate(RESET); await sleep(400);
    if (want('chrome')) {
      const c = await evaluate(`window.__probe.chrome(${JSON.stringify(CHROME)})`);
      for (const row of c) results.push({screen: 'chrome', width: w, ...row});
    }
    for (const s of SCREENS) {
      if (!want(s.name)) continue;
      await evaluate(RESET); await sleep(300);
      try { await evaluate(`(async () => { ${s.open} })()`); } catch (e) { results.push({screen: s.name, width: w, openError: e.message}); }
      const m = await evaluate(`window.__probe.measure(${JSON.stringify(s.root)}, ${JSON.stringify(s.close)}, null)`);
      await shot(s.name, w);
      // Second pass with every scroller in the screen at its end: controls below the fold are sized and overlap-checked too.
      const atEnd = await evaluate(`(() => { const sc = document.querySelector(${JSON.stringify(s.root)}); if (!sc) return null; const sy = []; [sc, ...sc.querySelectorAll("*")].forEach(el => { if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) { sy.push([el, el.scrollTop]); el.scrollTop = el.scrollHeight; } }); window.__probeRestore = sy; const r = window.__probe.measure(${JSON.stringify(s.root)}, null, null); return {bottomWide: r.wide, bottomWideSample: r.wideSample, bottomSmall: r.small, bottomSmallSample: r.smallSample, bottomOverlaps: r.overlaps, bottomOverlapSample: r.overlapSample}; })()`);
      await evaluate(`(() => { (window.__probeRestore || []).forEach(([el, y]) => el.scrollTop = y); window.__probeRestore = null; })()`);
      results.push({screen: s.name, width: w, root: s.root, ...m, ...(atEnd || {})});
      await evaluate(RESET); await sleep(200);
    }
    results.push({screen: '_page', width: w, problems: problems.splice(0).slice(0, 10)});
  }
} finally {
  await evaluate(RESET).catch(() => {});
  try {
    const v = await json('/json/version');
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise(r => bws.onopen = r);
    bws.send(JSON.stringify({id: 1, method: 'Browser.close'}));
    await sleep(800);
    bws.close();
  } catch {}
  ws.close();
  await sleep(500);
  proc.kill();
  try { rmSync(profile, {recursive: true, force: true}); } catch {}
}

const payload = {tag, url, sizes, at: new Date().toISOString(), results, shots: shotsTaken};
if (out) writeFileSync(out, JSON.stringify(payload, null, 1));
for (const r of results) {
  if (r.screen === '_page') { if (r.problems?.length) console.log(`${r.width} page-errors: ${r.problems.join(' | ')}`); continue; }
  const bad = [r.opened === false && 'NOT-OPENED', r.hscroll > 0 && `hscroll=${r.hscroll}`, r.wide > 0 && `wide=${r.wide}`, r.small > 0 && `small=${r.small}`, r.closeOk === false && 'close-covered', r.lastOk === false && 'last-unreachable', r.restOk === false && 'rest-hidden', r.overlaps > 0 && `overlaps=${r.overlaps}`, r.spill > 0 && `spill=${r.spill}`, r.bottomSmall > 0 && `bottom-small=${r.bottomSmall}`, r.bottomOverlaps > 0 && `bottom-overlaps=${r.bottomOverlaps}`, r.bottomWide > 0 && `bottom-wide=${r.bottomWide}`, r.openError && 'open-error'].filter(Boolean);
  console.log(`${r.width} ${r.screen.padEnd(16)} ${bad.length ? bad.join(' ') : 'ok'}`);
}
console.log(shotsTaken.length, 'screenshots');

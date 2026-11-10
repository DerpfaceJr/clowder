import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {browserPath, startScratch, newPage, loadApp, openMayorChat, SURFACE_KEYS, OPENED} from './helpers/chat-spine-scratch.mjs';

// docs/ux-ui-improvements.md (the UI audit of 2026-11-10), rows 1, 7, 8, 10 and 12, the ones that are CSS: the empty chat reads at
// 4.5:1, a cat's name shows whole in its own header, world labels are 44px tall, Search stands in the desktop dock, and no label is
// under 12px. Each row is read from the CSS source, then measured in a real browser on a scratch server
// (test/helpers/chat-spine-scratch.mjs: own ports, a temporary data folder, Demonstration, no Internet) at 1024 x 768 and at 375 x 812
// on a touch screen. Skipped where no Chromium, Edge or Chrome is installed. CLOWDER_TEST_BROWSER names another one.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sheets = readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.css'));
const rulesOf = name => read(name).replace(/\/\*[\s\S]*?\*\//g, '');
const skip = !browserPath && 'no Chromium, Edge or Chrome here';
const SIZES = [{width: 1024, height: 768, phone: false}, {width: 375, height: 812, phone: true}];
let scratch, browser;

before(async () => {
  if (skip) return;
  scratch = await startScratch();
  const {chromium} = await import('playwright-core');
  browser = await chromium.launch({executablePath: browserPath, headless: true});
});
after(async () => {
  await browser?.close();
  await scratch?.close();
});

// The page with the Mayor's chat open. ?perf gives window.__chatThread (chat-thread.js), which opens a cat's chat by id.
async function open(size) {
  const {ctx, page, errors} = await newPage(browser, size);
  await loadApp(page, `${scratch.url}&perf`);
  if (await page.locator('#inspector-panel').isHidden()) await openMayorChat(page);
  return {ctx, page, errors};
}
const closeAll = async page => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  if (await page.locator('#studio:not([hidden])').count()) await page.keyboard.press('Escape');
};

// Runs in the page: every element under root that holds text of its own, with its size and its contrast against the background really
// behind it. A colour is read by painting it on a canvas, so rgb(), color(srgb ...) and color-mix() all come back as bytes; a
// see-through background is laid over the ones behind it, down to the first solid one.
const CONTRAST = selector => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext('2d', {willReadFrequently: true});
  const rgba = colour => { pen.clearRect(0, 0, 1, 1); pen.fillStyle = colour; pen.fillRect(0, 0, 1, 1); const d = pen.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const behind = el => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reverse().reduce((base, c) => over(c, base), [255, 255, 255, 1]);
  };
  const light = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const root = document.querySelector(selector);
  return [...root.querySelectorAll('*')].filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(el => {
    const cs = getComputedStyle(el), bg = behind(el), fg = over(rgba(cs.color), bg), a = light(fg), b = light(bg);
    return {text: el.textContent.trim().slice(0, 32), tag: el.tagName.toLowerCase(), px: parseFloat(cs.fontSize), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05)};
  });
};
// Runs in the page: the elements on screen under root whose own text is drawn smaller than 12px. A 0px label is hidden text, not small text.
const SMALL = selector => {
  const root = document.querySelector(selector);
  const shown = el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !el.closest('[hidden]'); };
  return [...root.querySelectorAll('*')].filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && shown(el))
    .map(el => ({text: el.textContent.trim().slice(0, 32), px: parseFloat(getComputedStyle(el).fontSize)})).filter(e => e.px > 0 && e.px < 12).map(e => `"${e.text}" ${e.px}px`);
};

test('row 1: the empty chat takes its colours and its size from the tokens', () => {
  const css = rulesOf('style.css');
  assert.match(css, /\.empty\{[^}]*color:var\(--ink-2\);font-size:var\(--text-sm\)/, 'the intro line is --ink-2 at --text-sm (13px)');
  assert.match(css, /\.empty \.big\{[^}]*color:var\(--ink-3\)\}/, 'the paw is --ink-3');
  assert.match(css, /\.empty button\{color:var\(--ink\)\}/, 'the starters read as every other button does');
  for (const rule of css.match(/\.empty[^{}]*\{[^}]*\}/g)) assert.ok(!/#[0-9a-f]{3,8}\b|rgb/i.test(rule), `no colour literal in ${rule}`);
});

for (const size of SIZES) {
  test(`row 1: every line of the empty chat reads at 4.5:1 or better and 13px or more (${size.width} px)`, {skip, timeout: 120_000}, async () => {
    const {ctx, page, errors} = await open(size);
    await page.waitForSelector('#chat .empty .starter');
    const lines = await page.evaluate(CONTRAST, '#chat .empty');
    // The paw, the intro line, Try a delegation and the five starters.
    assert.equal(lines.length, 8, `the empty chat has 8 lines of text: ${lines.map(l => l.text).join(' | ')}`);
    assert.equal(lines.filter(l => l.tag === 'button').length, 6, 'Try a delegation and five starters');
    for (const line of lines) {
      assert.ok(line.ratio >= 4.5, `"${line.text}" reads at ${line.ratio.toFixed(2)}:1, 4.5:1 or better asked`);
      assert.ok(line.px >= 13, `"${line.text}" is ${line.px}px, 13px or more asked`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), size.width, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`row 8: a world label is 44px tall (${size.width} px)`, {skip, timeout: 120_000}, async () => {
    const {ctx, page, errors} = await open(size);
    // Under 900px an open sheet covers the town: Town in the dock shows it again.
    if (size.phone) await page.locator('#dock-town').click();
    // town.js is not loaded on the scratch page (headless WebGL is slow), so the labels it would make are made here the way it makes them:
    // a button.world-label in #labels. The Mayor's shows in every House names setting, and a selected one too.
    const labels = await page.evaluate(() => [['Mayor', 'mayor', ''], ['Scholar', 'scholar', 'selected']].map(([name, id, state]) => {
      const el = document.createElement('button');
      el.className = `world-label ${state}`.trim();
      el.textContent = name;
      el.dataset.cat = id;
      el.style.left = el.style.top = '50%';
      document.getElementById('labels').append(el);
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return {name, height: r.height, width: r.width, min: cs.minHeight, tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(), px: parseFloat(cs.fontSize)};
    }));
    for (const label of labels) {
      assert.equal(label.tap, '44px', '--tap is the 44px token');
      assert.equal(label.min, '44px', `${label.name}: min-height comes to 44px`);
      assert.ok(label.height >= 44, `${label.name} is ${label.height}px tall, 44px or more asked`);
      assert.ok(label.width >= 44, `${label.name} is ${label.width}px wide`);
      assert.ok(label.px >= 12, `${label.name} is ${label.px}px text`);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

// 1440 x 900 too: from 1334px the pane is 440px wide, and the name keeps its one 17px line there.
for (const size of [...SIZES, {width: 1440, height: 900, phone: false}]) {
  test(`row 7: each cat's name shows whole in its header, in the one 48px row, with the tabs, the menu and close on screen (${size.width} px)`, {skip, timeout: 120_000}, async () => {
    const {ctx, page, errors} = await open(size);
    const cats = await page.evaluate(() => fetch('/api/state').then(r => r.json()).then(s => s.cats.map(c => ({id: c.id, name: c.name}))));
    assert.ok(cats.length >= 2, 'the default town has the Mayor and one more cat');
    for (const cat of cats) {
      await page.evaluate(id => window.__chatThread.open({kind: 'cat', id}), cat.id);
      await page.waitForFunction(name => document.querySelector('#cat-header h2')?.textContent.startsWith(name), cat.name);
      const row = await page.evaluate(() => {
        const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height}; };
        const h = document.querySelector('#cat-header h2');
        return {text: h.textContent, scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, scrollHeight: h.scrollHeight, clientHeight: h.clientHeight, px: parseFloat(getComputedStyle(h).fontSize),
          name: box('#cat-header h2'), status: box('#cat-header .cat-status'), head: box('#cat-header'), pane: box('#inspector-panel'), width: innerWidth, page: document.documentElement.scrollWidth,
          controls: Object.fromEntries(Object.entries({conversation: '#tab-chat', work: '#tab-tasks', menu: '#pane-menu-open', close: '#inspector-panel > .panel-tools .panel-close'}).map(([k, s]) => [k, box(s)]))};
      });
      assert.ok(row.scrollWidth <= row.clientWidth, `"${row.text}" needs ${row.scrollWidth}px and has ${row.clientWidth}px`);
      assert.ok(row.scrollHeight <= row.clientHeight, `"${row.text}" needs ${row.scrollHeight}px of height and has ${row.clientHeight}px`);
      assert.ok(row.px >= 13, `the name is ${row.px}px, 13px or more`);
      assert.ok(row.head.height <= 48.5, `the header is still one 48px row (${row.head.height}px)`);
      assert.ok(row.name.top >= row.head.top - .5 && row.status.bottom <= row.head.bottom + .5 && row.name.bottom <= row.status.top + .5, `"${row.text}" and its status sit in the row, one under the other`);
      for (const [part, box] of Object.entries(row.controls)) {
        assert.ok(box.width >= 44 && box.height >= 44, `${part} keeps a 44px target (${box.width} x ${box.height})`);
        assert.ok(box.left >= row.pane.left - .5 && box.right <= Math.min(row.pane.right, row.width) + .5, `${part} is on screen, inside the pane (${box.left} to ${box.right})`);
        assert.ok(box.left >= row.name.right - .5, `${part} starts after the name (${box.left} against ${row.name.right})`);
      }
      assert.equal(row.page, size.width, 'no sideways scroll');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('row 8: no rule gives a world label a height under the 44px tap target', () => {
  let found = 0;
  for (const file of sheets) for (const [, selector, body] of rulesOf(file).matchAll(/([^{}]*\.world-label[^{}]*)\{([^}]*)\}/g)) {
    const min = /(?:^|;)\s*min-height:([^;]+)/.exec(body)?.[1];
    if (!min) continue;
    found++;
    assert.ok(['var(--tap)', '44px'].includes(min.trim()), `${file}: "${selector.trim()}" sets min-height:${min}`);
  }
  assert.ok(found >= 3, `${found} world-label rules set a min-height`);
});

test('row 10: Search stands in the dock at 1024 px, named, and opens the palette', {skip, timeout: 120_000}, async () => {
  const {ctx, page, errors} = await open(SIZES[0]);
  const dock = await page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height}; };
    const bar = document.querySelector('.town-dock'), search = document.getElementById('dock-search');
    const shown = [...bar.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);
    return {bar: box(bar), search: box(search), name: search.getAttribute('aria-label'), label: search.querySelector('.dock-label').textContent, labelBox: box(search.querySelector('.dock-label')),
      visible: getComputedStyle(search).visibility, order: shown.map(b => b.id), boxes: shown.map(box), page: document.documentElement.scrollWidth};
  });
  assert.ok(dock.search.width >= 44 && dock.search.height >= 44, `Search is a ${dock.search.width} x ${dock.search.height} target in the dock row`);
  assert.equal(dock.visible, 'visible');
  assert.equal(dock.name, 'Search');
  assert.equal(dock.label, 'Search');
  assert.ok(dock.labelBox.width > 0 && dock.labelBox.height > 0, 'its word shows');
  assert.ok(dock.search.left >= dock.bar.left && dock.search.right <= dock.bar.right && dock.search.top >= dock.bar.top && dock.search.bottom <= dock.bar.bottom, 'inside the dock');
  assert.deepEqual(dock.order, ['toggle-inspector', 'toggle-quests', 'toggle-projects', 'dock-search', 'toggle-residents', 'toggle-diary', 'toggle-archive', 'toggle-memorial'], 'the dock row, in the order of the page');
  for (const [i, box] of dock.boxes.entries()) {
    assert.ok(box.left >= dock.bar.left - .5 && box.right <= dock.bar.right + .5, `${dock.order[i]} stays inside the dock`);
    if (i) assert.ok(box.left >= dock.boxes[i - 1].right - .5, `${dock.order[i]} does not overlap ${dock.order[i - 1]}`);
  }
  assert.equal(dock.page, 1024, 'no sideways scroll');
  await page.locator('#dock-search').click();
  await page.waitForSelector('#command-palette[open]');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cp-input', 'the cursor is in the palette');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#command-palette:not([open])', {state: 'attached'});
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'dock-search', 'Escape gives focus back to Search');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('row 10: at 375 px Search stays under More, as before', {skip, timeout: 120_000}, async () => {
  const {ctx, page, errors} = await open(SIZES[1]);
  const shown = () => page.evaluate(() => [...document.querySelectorAll('.town-dock button')].filter(b => b.getBoundingClientRect().width > 0).map(b => b.id));
  assert.deepEqual(await shown(), ['toggle-inspector', 'toggle-quests', 'toggle-projects', 'dock-town', 'dock-more'], 'the phone dock keeps its five');
  await page.locator('#dock-more').click();
  assert.deepEqual(await shown(), ['toggle-inspector', 'toggle-quests', 'toggle-projects', 'dock-town', 'dock-more', 'dock-search', 'toggle-residents', 'toggle-diary', 'toggle-archive', 'toggle-memorial'], 'More lists Search first');
  await page.locator('#dock-search').click();
  await page.waitForSelector('#command-palette[open]');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375, 'no sideways scroll');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('row 12: no stylesheet sets text at 11px', () => {
  for (const file of sheets) {
    const css = rulesOf(file);
    assert.ok(!/font-size:11px/.test(css), `${file} has font-size:11px; the 12px token is var(--text-xs)`);
    assert.ok(!/font:[^;}]*\b11px/.test(css), `${file} has an 11px font shorthand; the 12px token is var(--text-xs)`);
  }
  assert.match(rulesOf('style.css'), /--text-xs:12px/, '--text-xs is the 12px token');
});

// What each of the audit's five surfaces is drawn in.
const FIVE = {accounts: '#accounts-dialog', mail: '#mail-watch-dialog', usage: '#treasury-dialog', telegram: '#telegram-dialog', discord: '#discord-dialog'};
for (const size of SIZES) {
  test(`row 12: Accounts, Mail, Usage, Telegram and Discord draw no text under 12px, and no surface scrolls sideways (${size.width} px)`, {skip, timeout: 300_000}, async () => {
    const {ctx, page, errors} = await open(size);
    const failures = [];
    for (const name of SURFACE_KEYS) {
      await page.evaluate(n => window.openSurface(n), name);
      await page.waitForSelector(OPENED[name], {state: 'attached', timeout: 15_000});
      if (FIVE[name]) {
        // The panel's first read fills it in: wait until its loading line is gone.
        await page.waitForFunction(s => !document.querySelector(`${s} [role=status].cx-empty`), FIVE[name], {timeout: 15_000});
        const small = await page.evaluate(SMALL, FIVE[name]);
        if (small.length) failures.push(`${name}: ${small.length} under 12px, ${small.join(', ')}`);
      }
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > size.width) failures.push(`${name}: scrollWidth ${width}`);
      await closeAll(page);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

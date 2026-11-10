import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {browserPath, startScratch, newPage, loadApp, UNNAMED} from './helpers/chat-spine-scratch.mjs';
import {PROMPT_KEY} from '../public/notify-prompt.js';
import {SURFACE_INFO} from '../public/command-palette.js';
import {ENTRIES} from '../public/post-office.js';
import {ITEMS} from '../public/manage.js';
import {ROWS} from '../public/settings-menu.js';

// docs/ux-ui-improvements.md rows 3, 4 and 5, in a real browser on a scratch server (test/helpers/chat-spine-scratch.mjs), at 375 x 812
// and 1024 x 768:
//   row 3: a control is named after the heading of what it opens. Every way into the Post office area is walked: the Setup hub's step,
//          Options > Manage, the Mailman's corner, the Post office's own entries, the palette and the ☰ list;
//   row 4: a dialog a Setup hub step opened gives the hub back when it closes (Escape, its close button, the phone's back pill), with
//          focus on that step's button and the step read again; opened from anywhere else it closes to where it was opened;
//   row 5: the ☰ button, the header's status dot and the chat menu's settings row each say what they open.
// The heading is the element the open dialog names itself by (aria-labelledby), and it must be on screen.
// Skipped where no Chromium, Edge or Chrome is installed.
const skip = !browserPath && 'no Chromium, Edge or Chrome here';
const SIZES = [{width: 375, height: 812, phone: true}, {width: 1024, height: 768, phone: false}];
// The Post office area's own names (docs/design/menu-chat-mailman.md): the dialog, its three groups, and the panels its entries open.
const AREA = ['postoffice', 'accounts', 'connectors', 'clients', 'telegram', 'discord', 'mail', 'ntfy'];
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

async function open(size) {
  const context = await browser.newContext({viewport: {width: size.width, height: size.height}, ...(size.phone ? {isMobile: true, hasTouch: true} : {})});
  // The notifications card asks once per browser; answered here, so it never sits over a control below.
  await context.addInitScript(key => { try { localStorage.setItem(key, 'later'); } catch { /* storage off */ } }, PROMPT_KEY);
  const {ctx, page, errors} = await newPage(browser, {...size, context});
  await loadApp(page, scratch.url);
  // Probe-gated entries show once their routes answer, and the setup counts once theirs do.
  await page.waitForFunction(ids => ids.every(id => { const el = document.getElementById(id); return el && !el.hidden; }), [...Object.keys(ENTRIES), 'manage-setup'], {timeout: 20_000});
  return {ctx, page, errors};
}

// The open dialog on top: its id, the heading it is named by, and whether that heading is drawn.
const top = page => page.evaluate(() => {
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (!dialog) return null;
  const heading = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
  const box = heading?.getBoundingClientRect();
  return {id: dialog.id || dialog.className, heading: heading?.textContent.trim() ?? null, shown: !!box && box.width > 0 && box.height > 0, eyebrow: dialog.querySelector('.eyebrow')?.textContent.trim() ?? null,
    close: [...dialog.querySelectorAll('.close-x')].map(b => b.getAttribute('aria-label'))};
});
const openDialogs = page => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(d => d.id || d.className));
const focused = page => page.evaluate(() => { const a = document.activeElement; return {step: a?.closest?.('[data-step]')?.dataset.step ?? null, action: !!a?.matches?.('.setup-action'), text: a?.textContent.trim() ?? '', id: a?.id ?? '', cls: a?.className ?? ''}; });
// Closed, with every queued close event delivered before the next step.
const closeAll = async page => {
  await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  await page.evaluate(() => new Promise(done => setTimeout(done, 0)));
};
async function sound(page, size, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), size.width, `${label}: no sideways scroll`);
  const unnamed = await page.evaluate(UNNAMED);
  assert.equal(unnamed.count, 0, `${label}: unnamed control ${unnamed.sample[0] ?? ''}`);
}
// The palette, the way the owner uses it: its event (the phone's Search button sends the same), the words, Enter on the first row.
async function palette(page, words) {
  await page.evaluate(() => { document.activeElement?.blur?.(); window.dispatchEvent(new CustomEvent('open-palette')); });
  await page.waitForSelector('#command-palette[open]');
  await page.keyboard.type(words);
  await page.waitForFunction(q => document.querySelector('#command-palette input')?.value === q, words);
  return page.evaluate(() => [...document.querySelectorAll('#command-palette [role="option"] .cp-label')].map(n => n.textContent.trim()));
}
// The Setup hub, opened the way this width offers it: the card on the Mayor's thread from 900px, Options > Manage under it.
async function openHub(page, size) {
  if (size.phone) {
    await page.click('#composer-options');
    await page.click('#manage-setup');
  } else await page.click('#setup-card .setup-card-open');
  await page.waitForSelector('dialog.setup-hub[open] [data-step="workshop"] .setup-action');
}
const stepButton = step => `dialog.setup-hub [data-step="${step}"] .setup-action`;

for (const size of SIZES) {
  test(`row 3: every way into the Post office area is named after the heading it opens (${size.width} px)`, {skip, timeout: 240_000}, async () => {
    const {ctx, page, errors} = await open(size);
    const names = {};

    // The Setup hub's step: its button says Open and the dialog's own name.
    await openHub(page, size);
    const hubLabel = await page.textContent(stepButton('apps'));
    await page.click(stepButton('apps'));
    await page.waitForSelector('#accounts-dialog[open]');
    let at = await top(page);
    assert.equal(hubLabel, `Open ${at.heading}`, 'the hub’s button is Open and the heading of the dialog it opens');
    assert.equal(at.heading, 'Accounts & connections');
    assert.ok(at.shown, 'and that heading is on screen');
    assert.equal(at.eyebrow, 'THE POST OFFICE', 'the line above the heading says where the panel lives, not a second name');
    names.accounts = at.heading;
    await sound(page, size, 'Accounts & connections from the hub');
    // Closing it shows the hub again (row 4, below); the hub then closes to the town.
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.setup-hub[open]');
    await closeAll(page);

    // Options > Manage: Channels, Sign-ins and Apps each open the Post office on that group, under that word.
    const groups = {channels: ['Telegram', 'Discord', 'Email to the Mayor', 'Android ping'], signins: ['Accounts & connections', 'Sign-in clients'], apps: ['Connectors & plugins']};
    for (const [key, entries] of Object.entries(groups)) {
      await page.click('#composer-options');
      const label = await page.textContent(`#${ITEMS[key].id}`);
      await page.click(`#${ITEMS[key].id}`);
      await page.waitForSelector('#post-office-dialog[open]');
      at = await top(page);
      assert.equal(at.heading, label, `Manage’s ${label} opens a dialog headed ${label}`);
      assert.ok(at.shown);
      assert.equal(at.eyebrow, 'THE POST OFFICE');
      assert.ok(at.close.includes(`Close ${label}`), `its close button says Close ${label}`);
      const seen = await page.evaluate(() => ({
        groups: [...document.querySelectorAll('#post-office-dialog .po-group')].filter(s => s.getBoundingClientRect().height > 0).map(s => s.dataset.group),
        headings: [...document.querySelectorAll('#post-office-dialog .po-group > h3')].filter(h => h.getBoundingClientRect().height > 0).map(h => h.textContent),
        entries: [...document.querySelectorAll('#post-office-dialog .po-items > button .po-label')].filter(n => n.closest('.po-group').getBoundingClientRect().height > 0).map(n => n.textContent),
      }));
      assert.deepEqual(seen.groups, [key], 'only that group shows');
      assert.deepEqual(seen.headings, [], 'the word is said once: the group’s own heading steps aside');
      assert.deepEqual(seen.entries, entries, 'with every entry of the group');
      names[key] = at.heading;
      await sound(page, size, `the Post office on ${label}`);
      await closeAll(page);
    }

    // The Mailman's corner chips are the same three items (from 900px; under it Manage holds them).
    if (!size.phone) {
      assert.deepEqual(await palette(page, 'Mailman').then(rows => rows.slice(0, 1)), ['Mailman']);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('#corner-chips .corner-chip').length === 3);
      for (const key of Object.keys(groups)) {
        const chip = `#corner-chips .corner-chip[data-item="${key}"]`, label = await page.textContent(chip);
        await page.click(chip);
        await page.waitForSelector('#post-office-dialog[open]');
        assert.equal((await top(page)).heading, label, `the corner’s ${label} chip opens a dialog headed ${label}`);
        await closeAll(page);
      }
    }

    // The palette: each row of the area opens a dialog headed by the row's own label.
    for (const key of AREA) {
      const label = SURFACE_INFO[key].label, rows = await palette(page, label);
      assert.equal(rows[0], label, `the palette lists ${label} first for its own name`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#command-palette[open]') && !!document.querySelector('dialog[open]'));
      at = await top(page);
      assert.equal(at.heading, label, `the palette’s ${label} opens a dialog headed ${label}`);
      assert.ok(at.shown);
      names[key] = at.heading;
      await closeAll(page);
    }
    // Opened whole, the Post office is the Post office: all three groups under their own headings.
    await palette(page, SURFACE_INFO.postoffice.label);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#post-office-dialog[open]');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#post-office-dialog .po-group > h3')].filter(h => h.getBoundingClientRect().height > 0).map(h => h.textContent)), ['Channels', 'Sign-ins', 'Apps']);
    assert.ok((await top(page)).close.includes('Close post office'));
    await closeAll(page);

    // The Post office's own entries: each opens the panel its words name.
    for (const id of Object.keys(ENTRIES)) {
      await page.evaluate(() => window.openSurface('postoffice'));
      await page.waitForSelector('#post-office-dialog[open]');
      if (ENTRIES[id].advanced) await page.click('#post-office-dialog .po-advanced > summary');
      const label = await page.textContent(`#${id} .po-label`);
      await page.click(`#${id}`);
      await page.waitForFunction(() => { const d = document.querySelector('dialog[open]'); return !!d && d.id !== 'post-office-dialog'; });
      at = await top(page);
      assert.equal(at.heading, label, `the Post office’s ${label} entry opens a dialog headed ${label}`);
      assert.ok(at.shown);
      await closeAll(page);
    }

    // The words these places used to go by still find them in the palette.
    for (const [words, label] of [['choose apps', 'Accounts & connections'], ['manage apps', 'Accounts & connections'], ['the accounts', 'Accounts & connections'], ['the connectors', 'Connectors & plugins'],
      ['sign-ins', 'Post office'], ['apps', 'Post office'], ['channels', 'Post office']]) {
      assert.ok((await palette(page, words)).includes(label), `"${words}" still finds ${label}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#command-palette[open]'));
    }

    // ☰ holds device and app settings only: none of its seven rows, and nothing in the dialog, leads into this area.
    await page.click('#menu-toggle');
    await page.waitForSelector('#town-menu[open]');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#settings-list .menu-row-title')].map(n => n.textContent));
    for (const name of Object.values(names)) assert.ok(!rows.includes(name), `☰ has no ${name} row`);
    assert.deepEqual(await page.evaluate(ids => ids.filter(id => document.getElementById('town-menu').contains(document.getElementById(id))), Object.keys(ENTRIES)), []);
    await closeAll(page);

    assert.deepEqual(names, {accounts: 'Accounts & connections', channels: 'Channels', signins: 'Sign-ins', apps: 'Apps', postoffice: 'Post office', connectors: 'Connectors & plugins',
      clients: 'Sign-in clients', telegram: 'Telegram', discord: 'Discord', mail: 'Email to the Mayor', ntfy: 'Android ping'}, 'one name per place');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`row 4: a dialog a Setup hub step opened gives the hub back, on that step, read again (${size.width} px)`, {skip, timeout: 240_000}, async () => {
    const {ctx, page, errors} = await open(size);
    // After the first return the server says GitHub is connected, as it would once the owner signed in inside the dialog.
    let connected = false;
    await page.route('**/api/connectors', route => (connected && route.request().method() === 'GET'
      ? route.fulfill({json: {connectors: [{id: 'github', name: 'GitHub', status: 'connected', enabled: true}], directory: [], cats: [], builtins: {}, sites: []}})
      : route.continue()));
    const opener = size.phone ? null : '#setup-card .setup-card-open';

    await openHub(page, size);
    assert.equal(await page.getAttribute('dialog.setup-hub [data-step="apps"]', 'data-state'), 'optional');
    assert.match(await page.textContent('dialog.setup-hub [data-step="apps"] p'), /^Nothing connected yet/);

    // Escape, a real key press.
    await page.click(stepButton('apps'));
    await page.waitForSelector('#accounts-dialog[open]');
    assert.deepEqual(await openDialogs(page), ['accounts-dialog'], 'the hub steps aside: one dialog at a time');
    connected = true;
    await page.keyboard.press('Escape');
    await page.waitForSelector(`dialog.setup-hub[open] ${stepButton('apps').replace('dialog.setup-hub ', '')}`);
    assert.deepEqual(await openDialogs(page), ['setup-hub'], 'Escape closes the dialog and shows the hub again');
    await page.waitForFunction(() => document.activeElement?.matches?.('[data-step="apps"] .setup-action'));
    assert.deepEqual(await focused(page).then(f => [f.step, f.action, f.text]), ['apps', true, 'Open Accounts & connections'], 'focus is on that step’s button');
    assert.equal(await page.getAttribute('dialog.setup-hub [data-step="apps"]', 'data-state'), 'ready', 'the step was read again');
    assert.equal(await page.textContent('dialog.setup-hub [data-step="apps"] p'), 'GitHub connected.');
    await sound(page, size, 'the hub after a return');

    // The dialog's own close control: × from 900px, the back pill on a phone.
    const closer = size.phone ? '.back-pill' : '.close-x';
    await page.keyboard.press('Enter');
    await page.waitForSelector('#accounts-dialog[open]');
    await page.click(`#accounts-dialog ${closer}`);
    await page.waitForSelector('dialog.setup-hub[open]');
    await page.waitForFunction(() => document.activeElement?.matches?.('[data-step="apps"] .setup-action'));
    assert.deepEqual(await openDialogs(page), ['setup-hub'], `${closer} shows the hub again`);

    // The other dialog a step opens: AI models, from the workshop step, whose button arrives with its slower check.
    await page.click(stepButton('workshop'));
    await page.waitForSelector('#models-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.setup-hub[open]');
    await page.waitForFunction(() => document.activeElement?.matches?.('[data-step="workshop"] .setup-action'));
    assert.deepEqual(await openDialogs(page), ['setup-hub']);
    await page.click(stepButton('workshop'));
    await page.waitForSelector('#models-dialog[open]');
    await page.click(`#models-dialog ${closer}`);
    await page.waitForSelector('dialog.setup-hub[open]');
    await page.waitForFunction(() => document.activeElement?.matches?.('[data-step="workshop"] .setup-action'));

    // Leaving the dialog for another panel is not a return: the hub stays away, and that panel closes to the town.
    await page.click(stepButton('apps'));
    await page.waitForSelector('#accounts-dialog[open]');
    await page.evaluate(() => { document.getElementById('accounts-dialog').close(); window.openSurface('connectors'); });
    await page.waitForSelector('#connectors-panel[open]');
    await page.evaluate(() => new Promise(done => setTimeout(done, 50)));
    assert.deepEqual(await openDialogs(page), ['connectors-panel'], 'the hub does not open over the panel the owner went on to');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.evaluate(() => new Promise(done => setTimeout(done, 50)));
    assert.deepEqual(await openDialogs(page), []);

    // The same dialogs opened from anywhere else close to where they were opened, never to the hub.
    for (const [words, dialog] of [['Accounts & connections', '#accounts-dialog'], ['AI models', '#models-dialog']]) {
      await palette(page, words);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${dialog}[open]`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
      await page.evaluate(() => new Promise(done => setTimeout(done, 50)));
      assert.deepEqual(await openDialogs(page), [], `${words} from the palette closes to the town`);
    }
    await page.evaluate(() => window.openSurface('postoffice'));
    await page.click('#accounts-open');
    await page.waitForSelector('#accounts-dialog[open]');
    await page.click(`#accounts-dialog ${closer}`);
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.evaluate(() => new Promise(done => setTimeout(done, 50)));
    assert.deepEqual(await openDialogs(page), [], 'Accounts & connections from the Post office closes to the town');

    // Closing the hub itself still closes it, and focus goes back to the control that opened it.
    await openHub(page, size);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    if (opener) assert.equal(await page.evaluate(s => document.activeElement === document.querySelector(s), opener), true, 'focus is back on Start setup');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`row 5: the ☰ button, the status dot and the chat menu’s settings row say what they open (${size.width} px)`, {skip, timeout: 180_000}, async () => {
    const {ctx, page, errors} = await open(size);
    const title = () => page.textContent('#town-menu-title');
    const closeName = () => page.getAttribute('#town-menu .menu-tools > .close-x', 'aria-label');

    // ☰ is "Settings" and opens "Settings"; each row opens a page headed by the row's own words, and Back is the list again.
    assert.equal(await page.getAttribute('#menu-toggle', 'aria-label'), 'Settings');
    assert.equal(await page.getAttribute('#menu-toggle', 'title'), 'Settings');
    const toggle = await page.evaluate(() => { const r = document.getElementById('menu-toggle').getBoundingClientRect(); return [r.width, r.height]; });
    assert.ok(toggle[0] >= 44 && toggle[1] >= 44, `☰ is a ${toggle[0]} x ${toggle[1]} target`);
    await page.click('#menu-toggle');
    await page.waitForSelector('#town-menu[open]');
    assert.equal((await top(page)).heading, 'Settings', 'the dialog is headed by the button’s name');
    assert.equal(await closeName(), 'Close settings');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#settings-list .menu-row')].map(r => ({key: r.dataset.category, title: r.querySelector('.menu-row-title').textContent})));
    assert.deepEqual(rows.map(r => r.key), [...ROWS]);
    let pages = 0;
    for (const row of rows) {
      await page.click(`#settings-list .menu-row[data-category="${row.key}"]`);
      // A row whose page is one control (the host's Devices and AI models) or its own screen (Worlds) opens that directly.
      if (await page.evaluate(() => !document.getElementById('town-menu').open)) { await closeAll(page); await page.click('#menu-toggle'); await page.waitForSelector('#town-menu[open]'); continue; }
      assert.equal(await title(), row.title, `the ${row.title} row opens a page headed ${row.title}`);
      assert.equal(await closeName(), 'Close settings', 'a row’s page is still Settings');
      await page.click('#settings-back');
      assert.equal(await title(), 'Settings');
      pages++;
    }
    assert.ok(pages >= 4, `${pages} rows opened a page of their own`);
    await sound(page, size, '☰');
    await closeAll(page);

    // The status dot says "town controls" and opens "Town controls", which closes under that name.
    const label = await page.getAttribute('#town-status', 'aria-label');
    assert.equal(label, 'Town running. Open town controls to pause');
    await page.click('#town-status');
    await page.waitForSelector('#town-menu[open] #settings-town:not([hidden])');
    const heading = (await top(page)).heading;
    assert.equal(heading, 'Town controls');
    assert.ok(label.toLowerCase().includes(heading.toLowerCase()), 'the dot’s name holds the heading it opens');
    assert.ok((await page.getAttribute('#town-status', 'title')).toLowerCase().includes(heading.toLowerCase()), 'and so does its tooltip');
    assert.equal(await closeName(), 'Close Town controls');
    assert.equal(await page.isVisible('#settings-back'), false);
    await sound(page, size, 'Town controls');
    await closeAll(page);
    // Afterwards ☰ is Settings again, close button and all.
    await page.click('#menu-toggle');
    await page.waitForSelector('#town-menu[open]');
    assert.equal(await title(), 'Settings');
    assert.equal(await closeName(), 'Close settings');
    await closeAll(page);

    // The palette's row for ☰ is the same word, and the old name still finds it.
    assert.equal((await palette(page, 'Settings'))[0], 'Settings');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#town-menu[open]');
    assert.equal(await title(), 'Settings');
    await closeAll(page);
    assert.ok((await palette(page, 'town menu')).includes('Settings'), '"town menu" still finds Settings');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#command-palette[open]'));

    // The chat menu's row is named after the sheet it opens, so it is not a second "Settings".
    await page.click('#pane-menu-open');
    await page.waitForFunction(() => document.getElementById('pane-menu').matches(':popover-open'));
    const row = await page.textContent('#pane-menu .chat-settings > summary');
    assert.equal(row, 'Mayor’s settings');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#pane-menu button, #pane-menu summary')].filter(n => n.getBoundingClientRect().height > 0).map(n => n.textContent.trim()).filter(t => t === 'Settings')), [], 'no row of the chat menu is called Settings');
    await sound(page, size, 'the chat menu');
    await page.click('#pane-menu .chat-settings > summary');
    await page.waitForSelector('#cat-settings-flyout:not([hidden])');
    assert.equal(await page.textContent('#cat-settings-title'), row, 'the sheet is headed by the row’s words');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cat-settings-flyout', {state: 'hidden'});
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

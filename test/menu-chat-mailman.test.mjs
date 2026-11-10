import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {KEEPERS, ITEMS, MAILMAN, hasRole, keeperOf, cornerItems, manageRows, cornerLabel, setupCard, showsSetupCard, townStatus, createManage} from '../public/manage.js';
import {GROUPS, ENTRIES, entriesOf, liveGroups, viewOf} from '../public/post-office.js';
import {ACCOUNTS_NAME} from '../public/accounts-panel.js';
import {VAULT_TABS, VAULT_TITLES, tabStep} from '../public/moonvault.js';
import {ROWS} from '../public/settings-menu.js';
import {SURFACE_INFO} from '../public/command-palette.js';
import {COMMAND_PANELS} from '../public/chat-composer.js';
import {fakeDocument} from './fixtures/fake-dom.mjs';

// docs/design/menu-chat-mailman.md, the UI half: ☰ keeps device and app settings, what a cat looks after lives with that cat, chat manages
// everything, and the Mailman's Post office holds the channels, sign-ins and apps. Checked without a browser here; the real-browser proof
// at 375 and 1440 px is test/menu-chat-mailman-ui.test.mjs.
const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const app = read('app.js');
const between = (from, to, text = html) => { const at = text.indexOf(from); return text.slice(at, text.indexOf(to, at)); };

const CATS = [{id: 'mayor', name: 'Mayor'}, {id: 'scholar', name: 'Scholar'}, {id: 'banker', name: 'Banker'}, {id: 'archivist', name: 'Archivist'}];

test('what each cat looks after: Mayor autonomy and routines, Mailman channels, sign-ins and apps, Banker money and usage, Archivist memory and backups', () => {
  assert.deepEqual(KEEPERS.map(k => [k.role, k.name, [...k.items]]), [
    ['mayor', 'Mayor', ['autonomy', 'routines']],
    ['mailman', 'Mailman', ['channels', 'signins', 'apps']],
    ['banker', 'Banker', ['money', 'usage']],
    ['archivist', 'Archivist', ['memory', 'backups']],
  ]);
  assert.equal(MAILMAN, 'mailman');
  for (const keeper of KEEPERS) for (const key of keeper.items) assert.ok(ITEMS[key]?.label && ITEMS[key].icon && ITEMS[key].id, `${key} has words, an icon and an id`);
  const sprite = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map(m => m[1]));
  for (const item of Object.values(ITEMS)) assert.ok(sprite.has(item.icon), `${item.icon} is in the sprite`);
  // Each item's id is the control the palette reads for that place.
  assert.equal(SURFACE_INFO.routines.control, ITEMS.routines.id);
  assert.equal(SURFACE_INFO.memory.control, ITEMS.memory.id);
  assert.equal(SURFACE_INFO.usage.control, ITEMS.usage.id);
  assert.equal(SURFACE_INFO.autonomy.control, ITEMS.autonomy.id);
  assert.equal(SURFACE_INFO.backups.control, ITEMS.backups.id);
});

test('a cat holds a role by its id (catalogue cats are named after their role), roleId or its house; never by its name or role text', () => {
  assert.ok(hasRole({id: 'mailman'}, MAILMAN));
  assert.ok(hasRole({id: 'posty', roleId: 'mailman'}, MAILMAN));
  assert.ok(hasRole({id: 'posty', home: {style: 'mailman'}}, MAILMAN));
  assert.ok(!hasRole({id: 'posty', name: 'Mailman', role: 'Carry the town’s messages'}, MAILMAN), 'a name or role text is not the role id');
  assert.ok(!hasRole(null, MAILMAN) && !hasRole({id: 'mayor'}, ''));
  assert.equal(keeperOf({id: 'banker'})?.role, 'banker');
  assert.equal(keeperOf({id: 'scholar'}), null);
});

test('corner chips list what that cat looks after; the Mailman’s show only for a cat that holds the role', () => {
  assert.deepEqual(cornerItems({id: 'mayor'}), ['autonomy', 'routines']);
  assert.deepEqual(cornerItems({id: 'archivist'}), ['memory', 'backups']);
  assert.deepEqual(cornerItems({id: 'banker'}), ['money', 'usage']);
  assert.deepEqual(cornerItems({id: 'mailman'}), ['channels', 'signins', 'apps']);
  assert.deepEqual(cornerItems({id: 'scholar'}), [], 'a cat that looks after nothing has no chips');
  assert.deepEqual(cornerItems(null), []);
  assert.deepEqual(cornerItems({id: 'archivist'}, key => key !== 'backups'), ['memory'], 'what this device cannot open is left out');
  assert.equal(cornerLabel('Mayor'), 'What Mayor looks after');
});

test('Options > Manage has one row per cat that looks after something, named after the cat that holds the role', () => {
  assert.deepEqual(manageRows(CATS).map(r => [r.role, r.name, r.items]), [
    ['mayor', 'Mayor', ['autonomy', 'routines']],
    ['mailman', 'Mailman', ['channels', 'signins', 'apps']],
    ['banker', 'Banker', ['money', 'usage']],
    ['archivist', 'Archivist', ['memory', 'backups']],
  ], 'Money keeps its home before a Banker is recruited, and the Post office before the Mailman arrives');
  const renamed = [{id: 'mayor', name: 'Mayor'}, {id: 'posty', name: 'Posty', roleId: 'mailman'}];
  assert.equal(manageRows(renamed).find(r => r.role === 'mailman').name, 'Posty');
  const phone = key => !['channels', 'signins', 'apps', 'backups'].includes(key);
  assert.deepEqual(manageRows(CATS, phone).map(r => r.role), ['mayor', 'banker', 'archivist'], 'a row with nothing to open goes');
  assert.deepEqual(manageRows(CATS, () => false), []);
});

test('Set up Clowder sits on the Mayor’s thread until setup is complete, for the owner only', () => {
  assert.deepEqual(setupCard({ready: 0, total: 2, badge: 2}), {title: 'Set up Clowder', text: '0 of 2 ready', action: 'Start setup'});
  assert.equal(setupCard({ready: 1, total: 2, badge: 1}).action, 'Continue setup');
  assert.equal(setupCard({ready: 2, total: 2, badge: 0}), null, 'complete: no card');
  assert.equal(setupCard(null), null, 'counts that could not be read: no card');
  const state = {readOnly: false}, summary = {ready: 0, total: 2, badge: 2};
  assert.equal(showsSetupCard({state, selected: 'mayor', summary}), true);
  assert.equal(showsSetupCard({state, selected: 'scholar', summary}), false, 'the Mayor’s thread only');
  assert.equal(showsSetupCard({state, selected: 'mayor', conversation: false, summary}), false, 'on the Conversation tab');
  assert.equal(showsSetupCard({state: {readOnly: true}, selected: 'mayor', summary}), false, 'never for a viewer');
  assert.equal(showsSetupCard({state, selected: 'mayor', summary: {ready: 2, total: 2, badge: 0}}), false);
  // The hub's own counts, and the palette entry.
  assert.match(app, /summary:\(\)=>import\('\.\/setup-hub\.js'\)\.then\(hub=>hub\.setupSummary\(\)\)/);
  assert.match(app, /openSetup:\(\)=>void openSetup\(\)\}\);\/\/ Ctrl\+K/, 'the palette opens the same hub');
});

test('the header logo’s status dot reads Running or Paused, and says so to a screen reader', () => {
  assert.deepEqual(townStatus({loaded: true}), {state: 'running', word: 'Running', label: 'Town running. Open town controls to pause', title: 'Running · open town controls'});
  assert.equal(townStatus({loaded: true, paused: true}).word, 'Paused');
  assert.equal(townStatus({loaded: true, paused: true}).label, 'Town paused. Open town controls to resume');
  assert.equal(townStatus({loaded: false}).state, 'connecting');
  assert.deepEqual(townStatus({loaded: true, connected: false, connection: 'Gate closed'}), {state: 'down', word: 'Gate closed', label: 'Gate closed. Open town controls', title: 'Gate closed'});
  assert.equal(townStatus({loaded: true, connected: false, connection: 'Reconnecting…'}).label, 'Reconnecting. Open town controls');
  const world = between('<div class="world-life">', '<div class="header-actions">');
  assert.match(world, /^<div class="world-life"><button type="button" id="town-status" class="town-status" data-state="connecting" aria-haspopup="dialog" aria-controls="town-menu" aria-label="Town controls"><span class="town-status-dot" aria-hidden="true"><\/span><span class="town-status-word">Connecting<\/span><\/button><span id="connection"/);
  assert.match(app, /function paintTownStatus\(\)\{/);
  assert.match(app, /paintTownStatus\(\);\n  paintHostDown\(\);\n\}/, 'every connection paint repaints it, and render() paints the connection');
});

test('the Post office: Channels, Sign-ins with Sign-in clients under Advanced, and Apps, each entry the panel it always opened', () => {
  assert.deepEqual([...GROUPS], ['channels', 'signins', 'apps']);
  assert.deepEqual(entriesOf('channels'), ['telegram-open', 'discord-open', 'mail-watch-open', 'ntfy-open']);
  assert.deepEqual(entriesOf('signins'), ['accounts-open', 'owner-clients-open']);
  assert.deepEqual(entriesOf('apps'), ['connectors-open']);
  assert.equal(ENTRIES['owner-clients-open'].advanced, true);
  assert.deepEqual(liveGroups(['discord-open', 'connectors-open']), ['channels', 'apps']);
  assert.deepEqual(liveGroups([]), [], 'a paired phone: nothing here');
  const dialog = between('<dialog id="post-office-dialog"', '</dialog>');
  assert.match(dialog, /class="op-dialog post-office" aria-labelledby="post-office-title"/);
  assert.match(dialog, /<button type="button" class="back-pill phone-only" data-close="post-office-dialog" aria-label="Back to town">← Town<\/button><span class="eyebrow">THE POST OFFICE<\/span><button type="button" class="close-x desk-only" data-close="post-office-dialog" aria-label="Close post office">×<\/button>/);
  const order = [...dialog.matchAll(/data-group="(\w+)"|data-items="([\w-]+)"|<button id="([\w-]+)"/g)].map(m => m[1] ?? m[2] ?? m[3]);
  assert.deepEqual(order, ['channels', 'channels', 'telegram-open', 'discord-open', 'signins', 'signins', 'accounts-open', 'signins-advanced', 'apps', 'apps', 'connectors-open']);
  assert.match(dialog, /<details class="po-advanced" hidden><summary>Advanced<\/summary>/);
  for (const [file, group] of [['mail-watch-panel.js', 'channels'], ['ntfy-panel.js', 'channels'], ['owner-clients-panel.js', 'signins-advanced']]) {
    assert.match(read(file), new RegExp(`postOfficeEntry\\(doc, \\{id: '[\\w-]+', group: '${group}'`), `${file} adds its entry to ${group}`);
  }
  assert.match(read('owner-dialog.js'), /#post-office-dialog \[data-items="\$\{group\}"\]/);
  assert.equal(COMMAND_PANELS.connect, 'postoffice', '/connect opens it');
  assert.match(app, /postoffice:\(\)=>postOffice\.open\(\)/, 'and the palette');
  assert.deepEqual(SURFACE_INFO.postoffice.controls, Object.keys(ENTRIES), 'offered while any entry shows');
});

// docs/ux-ui-improvements.md row 3: one name per place, in the design's own words. The real-browser walk of every way in is
// test/naming-setup-ui.test.mjs; here the words themselves, without a browser.
test('one name per place: a control, the heading it opens and the palette row say the same words', () => {
  const dialog = between('<dialog id="post-office-dialog"', '</dialog>');
  const heading = /<h2 id="post-office-title">([^<]+)<\/h2>/.exec(dialog)[1];
  const groupNames = Object.fromEntries([...dialog.matchAll(/data-group="(\w+)" aria-labelledby="po-\w+"><h3 id="po-\w+" tabindex="-1">([^<]+)<\/h3>/g)].map(m => [m[1], m[2]]));
  assert.equal(heading, 'Post office');
  assert.equal(SURFACE_INFO.postoffice.label, heading, 'the palette row is the dialog’s heading');
  assert.deepEqual(groupNames, {channels: 'Channels', signins: 'Sign-ins', apps: 'Apps'}, 'the three groups, as menu-chat-mailman.md names them');
  for (const group of GROUPS) assert.equal(ITEMS[group].label, groupNames[group], `Manage’s ${group} item is the group’s heading`);

  // Opened whole it is the Post office; opened on a group it is that group alone, under the group's name.
  const live = ['channels', 'signins', 'apps'];
  assert.deepEqual(viewOf(null, live, groupNames, heading), {group: null, title: 'Post office', shown: live});
  assert.deepEqual(viewOf('signins', live, groupNames, heading), {group: 'signins', title: 'Sign-ins', shown: ['signins']});
  assert.deepEqual(viewOf('apps', live, groupNames, heading), {group: 'apps', title: 'Apps', shown: ['apps']});
  assert.deepEqual(viewOf('channels', ['apps'], groupNames, heading), {group: null, title: 'Post office', shown: ['apps']}, 'a group this device cannot use falls back to the whole');
  assert.deepEqual(viewOf('nowhere', live, groupNames, heading).title, 'Post office');
  const js = read('post-office.js');
  assert.match(js, /only = GROUPS\.includes\(group\) \? group : null;/, 'every open says which view it wants');
  assert.match(js, /dialog\.addEventListener\('close', \(\) => \{ if \(!dialog\.open\) \{ only = null; paint\(\); \} \}\);/, 'and a late close event never resets a view opened since');
  assert.ok(!js.includes('scrollIntoView'), 'no scrolling to a group inside a dialog headed by another name');

  // The panels the entries open: the entry, the heading and the palette row agree, and the line above the heading says where it lives.
  const entry = id => new RegExp(`<button id="${id}"[^>]*>([^<]+)</button>`).exec(dialog)[1].replace(/&amp;/g, '&');
  assert.equal(ACCOUNTS_NAME, 'Accounts & connections');
  assert.equal(entry('accounts-open'), ACCOUNTS_NAME);
  assert.equal(SURFACE_INFO.accounts.label, ACCOUNTS_NAME);
  const accounts = read('accounts-panel.js');
  assert.match(accounts, /h\('h2', \{text: ACCOUNTS_NAME, attrs: \{id: 'accounts-title'\}\}\)/);
  assert.match(accounts, /className: 'eyebrow', text: 'THE POST OFFICE'/);
  assert.ok(!accounts.includes('THE ACCOUNTS'), '"The accounts" is not a second name for it');
  const connectors = between('<dialog id="connectors-panel"', '</dialog>');
  assert.equal(entry('connectors-open'), 'Connectors & plugins');
  assert.equal(SURFACE_INFO.connectors.label, 'Connectors & plugins');
  assert.match(connectors, /<span class="eyebrow">THE POST OFFICE<\/span><h2 id="connectors-title">Connectors &amp; plugins<\/h2>/, 'the heading is the entry’s words, with no full stop');
  assert.match(connectors, /data-close="connectors-panel" aria-label="Close Connectors &amp; plugins"/);
  assert.equal(SURFACE_INFO.clients.label, 'Sign-in clients');
  assert.match(read('owner-clients-panel.js'), /title: 'Sign-in clients',[\s\S]*postOfficeEntry\(doc, \{id: 'owner-clients-open', group: 'signins-advanced', text: 'Sign-in clients'/);
  // The words a place used to go by stay findable.
  for (const old of ['the accounts', 'apps', 'choose apps', 'open apps', 'manage apps', 'sign-ins']) assert.ok(SURFACE_INFO.accounts.keywords.includes(old), `accounts keeps "${old}"`);
  for (const old of ['apps', 'the connectors']) assert.ok(SURFACE_INFO.connectors.keywords.includes(old), `connectors keeps "${old}"`);
  for (const old of ['channels', 'sign-ins', 'apps']) assert.ok(SURFACE_INFO.postoffice.keywords.includes(old), `the Post office keeps "${old}"`);
});

test('the Moonvault: the Money pill opens Money with Usage joined into the same panel, a tab each', () => {
  assert.deepEqual([...VAULT_TABS], ['money', 'usage']);
  assert.deepEqual({...VAULT_TITLES}, {money: 'Money', usage: 'Usage'});
  assert.equal(tabStep('ArrowRight', 0), 1);
  assert.equal(tabStep('ArrowRight', 1), 0, 'wraps');
  assert.equal(tabStep('ArrowLeft', 0), 1);
  assert.equal(tabStep('Home', 1), 0);
  assert.equal(tabStep('End', 0), 1);
  assert.equal(tabStep('Enter', 0), null);
  const vault = between('<dialog id="treasury-dialog"', '</dialog>');
  assert.match(vault, /<h2 id="treasury-title">Money<\/h2><div class="vault-tabs" role="tablist" aria-label="Moonvault"><button type="button" role="tab" id="vault-tab-money" aria-controls="vault-money" aria-selected="true">Money<\/button><button type="button" role="tab" id="vault-tab-usage" aria-controls="vault-usage" aria-selected="false" tabindex="-1">Usage<\/button><\/div>/);
  assert.ok(vault.indexOf('id="vault-money"') < vault.indexOf('class="treasury-columns"') && vault.indexOf('id="real-money"') < vault.indexOf('id="vault-usage"'), 'Money keeps its contents in its tab');
  assert.match(app, /\$\('treasury-button'\)\.onclick=\(\)=>openTreasury\(\);/, 'the pill opens Money');
  assert.match(app, /money:\(\)=>openTreasury\('money'\),usage:\(\)=>openTreasury\('usage'\)/, 'the Banker’s chips and Manage open each tab');
  assert.equal(COMMAND_PANELS.money, 'money');
});

test('More holds Cats, Diary, Archive and the Memorial', () => {
  const more = between('<div id="dock-more-menu"', '</nav>');
  const shown = [...more.matchAll(/<button id="([^"]+)"([^>]*)>/g)].filter(m => !/\shidden(\s|$)/.test(m[2])).map(m => m[1]);
  assert.deepEqual(shown, ['dock-search', 'toggle-residents', 'toggle-diary', 'toggle-archive', 'toggle-memorial'], 'Coins shows only while the coin economy is on');
});

test('☰ keeps device and app settings only: Set up, Town, autonomy, Routines, Memory, Usage, Memorial and the Post office’s entries left it', () => {
  assert.deepEqual([...ROWS], ['appearance', 'sound', 'screen', 'devices', 'models', 'worlds', 'backup']);
  for (const key of ['setup', 'town', 'autonomy', 'routines', 'memory', 'usage', 'memorial']) assert.ok(!ROWS.includes(key), `${key} is not a row`);
});

test('manage.css uses the :root tokens only and keeps 44px targets', () => {
  const css = read('manage.css');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...rules.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]).join(';');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(declarations), 'no colour literals');
  assert.ok(!/font-family/.test(rules), 'no font families');
  assert.ok(!/:root/.test(rules), 'no new tokens');
  for (const [, decl] of rules.matchAll(/font:([^;}]+)/g)) assert.match(decl, /var\(--text-\w+\)/, `type from the scale: font:${decl}`);
  for (const [, size] of rules.matchAll(/font-size:([^;}]+)/g)) assert.match(size, /^var\(--text-\w+\)$/, `font-size:${size}`);
  for (const [, color] of rules.matchAll(/(?:^|[;{])\s*(?:color|background|border(?:-\w+)?|box-shadow|outline):([^;}]+)/gm)) {
    assert.ok(!/#[0-9a-f]|rgba?\(|hsla?\(/i.test(color), `colour from tokens only: ${color}`);
  }
  for (const selector of ['.immersive .town-status{', '.corner-chip{', '.manage-item{', '.setup-card-open{', '#treasury-dialog .vault-tabs [role=tab]{', '.post-office .po-advanced>summary{']) {
    const rule = rules.slice(rules.indexOf(selector), rules.indexOf('}', rules.indexOf(selector)));
    assert.match(rule, /min-height:var\(--tap\)/, `${selector} is at least 44px tall`);
  }
  assert.match(rules, /\.post-office \.po-items>button\{[^}]*min-height:56px/, 'a Post office entry is a 56px card row');
  assert.match(rules, /@media\(max-width:420px\)\{\n \.immersive \.town-status\{position:absolute;left:30px;top:6px;width:var\(--tap\);height:var\(--tap\)/, 'on a phone the dot keeps a 44px target');
  assert.ok(html.includes('<link rel="stylesheet" href="/manage.css">'));
});

test('createManage draws Manage, the corner chips and the setup card, and an item opens its panel after closing Options', async () => {
  const doc = fakeDocument();
  const panel = doc.createElement('aside'), header = doc.createElement('div'), chat = doc.createElement('div'), menu = doc.createElement('div');
  chat.before = (...nodes) => { const at = panel.children.indexOf(chat); for (const n of nodes) n.parentNode = panel; panel.children.splice(at, 0, ...nodes); };
  panel.append(header, chat);
  doc.body.append(panel, menu);
  let state = {readOnly: false, cats: CATS}, selected = 'mayor';
  const opened = [], closed = [], setups = [];
  const host = new Set(['autonomy', 'routines', 'money', 'usage', 'memory']);
  const manage = createManage({doc, menu, header, chat, getState: () => state, selected: () => selected, can: key => host.has(key),
    open: (key, {from}) => opened.push([key, from?.className]), closeOptions: () => closed.push('options'), openSetup: () => setups.push('hub'),
    summary: async () => ({ready: 0, total: 2, badge: 2})});
  manage.paint();
  await new Promise(resolve => setImmediate(resolve));
  const section = menu.querySelector('section');
  assert.equal(section.hidden, false);
  const rows = section.querySelectorAll('.manage-row').filter(r => !r.hidden);
  assert.deepEqual(rows.map(r => r.querySelector('.manage-who').textContent), ['Mayor', 'Banker', 'Archivist'], 'the Mailman’s row waits for a channel, sign-in or app this device can open');
  assert.deepEqual(rows.map(r => r.querySelectorAll('.manage-item').filter(b => !b.hidden).map(b => b.textContent)), [['Autonomy', 'Routines'], ['Money', 'Usage'], ['Memory']]);
  const backups = manage.button('backups');
  assert.equal(backups.getAttribute('id'), 'backups-open');
  assert.equal(backups.hidden, true, 'Backups is the host’s');
  assert.ok('data-owner' in backups.attributes && 'data-host' in backups.attributes, 'and says so to the page');
  manage.button('routines').listeners.click[0]();
  assert.deepEqual(closed, ['options'], 'Options closes first');
  assert.deepEqual(opened, [['routines', 'manage-item']]);

  const corner = header.parentNode.children[header.parentNode.children.indexOf(header) + 1];
  assert.equal(corner.getAttribute('id'), 'corner-chips');
  assert.equal(corner.getAttribute('aria-label'), 'What Mayor looks after');
  assert.deepEqual(corner.children.map(c => c.textContent), ['Autonomy', 'Routines'], 'the Mayor’s corner');
  corner.children[0].listeners.click[0]();
  assert.deepEqual(opened.at(-1), ['autonomy', 'corner-chip']);

  const card = panel.children[panel.children.indexOf(chat) - 1];
  assert.equal(card.getAttribute('id'), 'setup-card');
  assert.equal(card.hidden, false, 'pinned above the Mayor’s conversation');
  assert.equal(card.querySelector('.setup-card-text').textContent, '0 of 2 ready');
  card.querySelector('button').listeners.click[0]();
  assert.deepEqual(setups, ['hub']);

  selected = 'archivist';
  manage.paint();
  assert.deepEqual(corner.children.map(c => c.textContent), ['Memory'], 'the Archivist’s corner, without what this device cannot open');
  assert.equal(card.hidden, true, 'not on another cat’s thread');
  selected = 'scholar';
  manage.paint();
  assert.equal(corner.hidden, true, 'a cat that looks after nothing has no chips');

  // The Mailman joins the town (another branch adds the role): its chips show in its own corner, keyed on the role id.
  host.add('channels').add('signins').add('apps');
  state = {readOnly: false, cats: [...CATS, {id: 'mailman', name: 'Mailman'}]};
  selected = 'mailman';
  manage.paint();
  assert.deepEqual(corner.children.map(c => c.textContent), ['Channels', 'Sign-ins', 'Apps']);
  assert.ok(section.querySelectorAll('.manage-row').some(r => !r.hidden && r.querySelector('.manage-who').textContent === 'Mailman'));
});

test('app.js wires the chat to its panels: each item opens a sheet over the thread, and the palette, the commands and the chips share one map', () => {
  assert.match(app, /const MANAGED=\{autonomy:\(\)=>openSettingsPage\('autonomy',\{over:'thread'\}\),routines:\(\)=>void routinesPanel\.open\(\),postoffice:\(\)=>postOffice\.open\(\),channels:\(\)=>postOffice\.open\('channels'\),signins:\(\)=>postOffice\.open\('signins'\),apps:\(\)=>postOffice\.open\('apps'\),money:\(\)=>openTreasury\('money'\),usage:\(\)=>openTreasury\('usage'\),memory:\(\)=>void memoryPanel\.open\(\),backups:\(\)=>openSettingsPage\('backup',\{over:'thread'\}\)\};/);
  assert.match(app, /openPanel:key=>openManaged\(key\),canOpen:key=>canManage\(key\)/, 'the composer’s commands');
  assert.match(app, /manage\.paint\(\);composerOptions\.paint\(\);composer\.paint\(\);/, 'render() paints the Manage section before the chip that shows it');
  for (const name of Object.values(COMMAND_PANELS)) assert.ok(new RegExp(`\\b${name}:\\(\\)=>`).test(app.slice(app.indexOf('const MANAGED='))), `${name} has an opener`);
  // From 900px the Inbox is the top of the chat pane: the chips and the card step aside while it is open there.
  assert.match(read('manage.css'), /\.immersive \.inspector:has\(>\.quests:not\(\[hidden\]\)\) :is\(\.corner-chips,\.setup-card\)\{display:none!important\}/);
});

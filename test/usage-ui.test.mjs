import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {monthName, monthDays, ranked, costText, capDraft, capLine, rowSummary, todayIn, createUsagePanel, CAP_DENIED, MODE_LABELS} from '../public/usage-panel.js';
import {usageReport, capStatus} from '../src/usage.ts';
import {fakeDocument, fakeFetch, settle, button} from './fixtures/fake-dom.mjs';

const tally = (tokens, calls = 1, unreported = 0) => ({tokens, input: tokens, output: 0, calls, unreported});

test('a month reads as its name, and its days run 1 to the end with tokens and calls, days after today marked', () => {
  assert.equal(monthName('2026-11', 'en-GB'), 'November 2026');
  assert.equal(monthName('nope'), 'nope');
  const days = monthDays({month: '2026-02', days: {'2026-02-03': tally(500, 2, 1)}}, '2026-02-10');
  assert.equal(days.length, 28);
  assert.deepEqual(days[2], {day: '2026-02-03', n: 3, tokens: 500, calls: 2, unreported: 1, ahead: false});
  assert.equal(days[10].ahead, true);
  assert.equal(monthDays({month: '2024-02', days: {}}).length, 29, 'a leap year');
  assert.equal(monthDays({month: '2026-10', days: {}}, '').every(d => !d.ahead), true, 'last month has no days ahead');
});

test('breakdowns rank largest first, fold the rest into Other, and share is against the largest row', () => {
  const rows = ranked({a: tally(10), b: tally(40), c: tally(20), d: tally(5), e: tally(1)}, k => k.toUpperCase(), 4);
  assert.deepEqual(rows.map(r => [r.label, r.tokens]), [['B', 40], ['C', 20], ['A', 10], ['Other (2)', 6]]);
  assert.equal(rows[0].share, 1);
  assert.equal(rows[1].share, 0.5);
  assert.deepEqual(ranked({}), []);
  assert.equal(ranked({x: tally(0, 3)})[0].share, 0, 'a row with no counted tokens has no bar');
});

test('cost is Unknown when any call came without one, never 0', () => {
  assert.equal(costText({cost: null, total: tally(10)}), 'Unknown');
  assert.equal(costText({cost: 0, total: tally(0, 0)}), 'None');
  assert.equal(costText({cost: 1.5, total: tally(10)}, 'en-US'), '$1.50');
  // The server: a month with one plan row (cost null) is null, so the page reads Unknown.
  const state = {usage: [{at: '2026-11-03T10:00:00Z', cat: 'mayor', mode: 'claude', input: 100, output: 20, cost: null}], tasks: [], approvals: []};
  const report = usageReport(state, new Date('2026-11-07T12:00:00Z'));
  assert.equal(report.current.cost, null);
  assert.equal(costText(report.current), 'Unknown');
  assert.equal(monthDays(report.current).find(d => d.tokens).tokens, 120);
});

test('the cap field reads plain numbers, thousands and millions; the cap line says how full the month is', () => {
  assert.deepEqual(capDraft('2,000,000'), {body: {tokens: 2000000}});
  assert.deepEqual(capDraft('2m'), {body: {tokens: 2000000}});
  assert.deepEqual(capDraft('1.5M'), {body: {tokens: 1500000}});
  assert.deepEqual(capDraft('500k'), {body: {tokens: 500000}});
  for (const bad of ['', '0', '-5', 'lots', '2mm']) assert.match(capDraft(bad).error, /whole number/, bad);
  assert.deepEqual(capLine({cap: null, used: 1200}, 'en-GB'), {text: 'No monthly cap. 1,200 tokens used so far this month.', fill: null, tone: 'off'});
  assert.equal(capLine({cap: 1000, used: 500}, 'en-GB').tone, 'ok');
  assert.equal(capLine({cap: 1000, used: 850}, 'en-GB').tone, 'warn');
  const reached = capLine({cap: 1000, used: 1200, reached: true}, 'en-GB');
  assert.equal(reached.fill, 1);
  assert.match(reached.text, /1,200 of 1,000 tokens used this month \(100%\)\. The cap is reached: new work waits for you\./);
  assert.match(capLine({cap: 1000, used: 1200, override: true}, 'en-GB').text, /You let this month run past the cap\./);
  // The server's own shape.
  const status = capStatus({usage: [], approvals: [], usageCap: 5000, capOverride: null}, new Date('2026-11-07T12:00:00Z'));
  assert.equal(capLine(status, 'en-GB').text, '0 of 5,000 tokens used this month (0%).');
});

test('the ☰ row names this month’s tokens and the cap; today follows the host’s timezone', () => {
  assert.equal(rowSummary(null), 'Tokens by day, cat and model');
  assert.equal(rowSummary({cap: {used: 12345, cap: null}}), '12k tokens this month');
  assert.equal(rowSummary({cap: {used: 12345, cap: 2000000}}), '12k of 2.0M tokens this month');
  assert.equal(todayIn('America/New_York', Date.parse('2026-11-07T03:00:00Z')), '2026-11-06');
  assert.equal(todayIn('Europe/London', Date.parse('2026-11-07T03:00:00Z')), '2026-11-07');
  assert.equal(MODE_LABELS.anthropic, 'Anthropic API');
});

const data = {timezone: 'Europe/London',
  current: {month: '2026-11', total: tally(3000, 3, 1), cost: null, days: {'2026-11-02': tally(1000, 1), '2026-11-05': tally(2000, 2)},
    cats: {mayor: tally(2000, 2), scribe: tally(1000, 1)}, modes: {claude: tally(3000, 3)}, goals: {g1: tally(1000, 1)}, routines: {r1: tally(500, 1)}},
  previous: {month: '2026-10', total: tally(0, 0), cost: 0, days: {}, cats: {}, modes: {}, goals: {}, routines: {}},
  cap: {month: '2026-11', cap: null, used: 3000, override: false, reached: false, card: null}};

async function mount(routes = {}) {
  const doc = fakeDocument();
  const {fetchImpl, calls} = fakeFetch({'GET /api/usage': data, 'GET /api/routines': {routines: [{id: 'r1', title: 'Daily briefing'}]}, 'POST /api/usage/cap': body => ({ok: true, cap: {...data.cap, cap: body.tokens}}), ...routes});
  const panel = createUsagePanel({doc, win: {addEventListener() {}}, fetchImpl, locale: 'en-GB', now: () => Date.parse('2026-11-07T12:00:00Z'),
    town: () => ({cats: [{id: 'mayor', name: 'Mayor'}, {id: 'scribe', name: 'Scribe'}], goals: [{id: 'g1', title: 'Grow the reels'}], models: []})});
  await panel.open();
  await settle();
  return {panel, dialog: panel.dialog, calls};
}

test('the panel shows this month’s totals, cost Unknown, the cap, the busiest day, and the four breakdowns by name', async () => {
  const {dialog} = await mount();
  assert.deepEqual(dialog.querySelectorAll('dt').map(n => n.textContent), ['Tokens', 'Calls', 'Cost']);
  assert.deepEqual(dialog.querySelectorAll('dd').map(n => n.textContent), ['3,000', '3', 'Unknown']);
  assert.match(dialog.textContent, /1 call came back without a token count and is left out of the totals\./);
  assert.match(dialog.querySelector('.us-cap').textContent, /No monthly cap\. 3,000 tokens used so far this month\./);
  assert.equal(dialog.querySelectorAll('span.us-bar').length, 30);
  assert.equal(dialog.querySelector('.us-plot').getAttribute('aria-valuenow'), '5', 'the readout starts on the busiest day');
  assert.match(dialog.querySelector('.us-readout').textContent, /2,000 tokens · 2 calls$/);
  assert.equal(dialog.querySelector('table.us-table').querySelector('tbody').querySelectorAll('tr').length, 2, 'the table lists the days with calls');
  const labels = id => dialog.querySelector(`[id="us-${id}"]`).parentNode.querySelectorAll('.us-row-label').map(n => n.textContent);
  assert.deepEqual(labels('cats'), ['Mayor', 'Scribe']);
  assert.deepEqual(labels('modes'), ['Claude plan']);
  assert.deepEqual(labels('goals'), ['Grow the reels']);
  assert.deepEqual(labels('routines'), ['Daily briefing']);
});

test('the arrow keys move the day read out; last month has no cap form', async () => {
  const {dialog} = await mount();
  const plot = dialog.querySelector('.us-plot');
  for (const fn of plot.listeners.keydown) fn({key: 'ArrowLeft', preventDefault() {}});
  assert.equal(plot.getAttribute('aria-valuenow'), '4');
  assert.match(dialog.querySelector('.us-readout').textContent, /: 0 tokens · 0 calls$/);
  for (const fn of plot.listeners.keydown) fn({key: 'End', preventDefault() {}});
  assert.match(dialog.querySelector('.us-readout').textContent, /: not yet$/, 'a day after today');
  button(dialog, 'Last month · October 2026').click();
  assert.equal(dialog.querySelector('.us-cap'), null);
  assert.deepEqual(dialog.querySelectorAll('dd').map(n => n.textContent), ['0', '0', 'None']);
  assert.match(dialog.querySelector('.us-days').textContent, /No tokens were counted this month\./);
});

test('Save cap posts the number; a bad number never posts; Remove cap posts null; a viewer gets the owner sentence', async () => {
  const {dialog, calls} = await mount();
  const form = dialog.querySelector('form.us-cap-form');
  assert.equal(form.getAttribute('data-owner'), '', 'hidden for viewers');
  const input = form.querySelector('input');
  input.value = 'lots'; input.oninput();
  form.onsubmit({preventDefault() {}});
  await settle();
  assert.equal(calls.some(c => c[0] === 'POST'), false);
  assert.match(dialog.querySelector('.us-cap').textContent, /whole number/);
  assert.equal(dialog.querySelector('form.us-cap-form').querySelector('input').value, 'lots', 'what was typed stays');
  const again = dialog.querySelector('form.us-cap-form');
  again.querySelector('input').value = '2m'; again.querySelector('input').oninput();
  again.onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(calls.find(c => c[0] === 'POST'), ['POST', '/api/usage/cap', {tokens: 2000000}]);

  const capped = await mount({'GET /api/usage': {...data, cap: {...data.cap, cap: 5000}}});
  button(capped.dialog, 'Remove cap').click();
  await settle();
  assert.deepEqual(capped.calls.find(c => c[0] === 'POST')[2], {tokens: null});

  const viewer = await mount({'POST /api/usage/cap': {status: 403, body: {error: 'nope'}}});
  const vf = viewer.dialog.querySelector('form.us-cap-form');
  vf.querySelector('input').value = '1000'; vf.querySelector('input').oninput();
  vf.onsubmit({preventDefault() {}});
  await settle();
  assert.match(viewer.dialog.querySelector('.us-cap').textContent, new RegExp(CAP_DENIED));
});

test('Usage joins Money in the Moonvault: the panel draws into its Usage tab, and openSurface opens it there', async () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /initUsagePanel\(\{town:\(\)=>state,mount:\{dialog:\$\('treasury-dialog'\),body:\$\('vault-usage-body'\),lede:\$\('vault-usage-lede'\),show:\(\)=>openTreasury\('usage'\)/);
  assert.match(app, /usage:\(\)=>void usagePanel\.open\(\)/);
  const {ROWS} = await import('../public/settings-menu.js');
  assert.ok(!ROWS.includes('usage'), 'not a ☰ row');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(html, /<div id="vault-usage" class="vault-pane vault-usage op-scope" role="tabpanel" aria-labelledby="vault-tab-usage" hidden><p id="vault-usage-lede" class="op-lede"><\/p><div id="vault-usage-body" class="op-body"><\/div><\/div><\/dialog>/);
});

test('mounted in another panel, Usage opens that panel instead of a dialog of its own, and loads when asked', async () => {
  const doc = fakeDocument();
  const host = doc.createElement('dialog'), lede = doc.createElement('p'), body = doc.createElement('div');
  host.append(lede, body);
  doc.body.append(host);
  host.open = true;
  const shown = [];
  const {fetchImpl} = fakeFetch({'GET /api/usage': data, 'GET /api/routines': {routines: []}});
  const panel = createUsagePanel({doc, win: {addEventListener() {}}, fetchImpl, locale: 'en-GB', now: () => Date.parse('2026-11-07T12:00:00Z'),
    mount: {dialog: host, body, lede, show: () => shown.push('usage'), showing: () => true}});
  assert.equal(doc.body.querySelectorAll('dialog').length, 1, 'no dialog of its own');
  assert.equal(panel.dialog, host);
  await panel.open();
  assert.deepEqual(shown, ['usage'], 'open() asks the host to show its Usage tab');
  await panel.load();
  await settle();
  assert.match(lede.textContent, /^What the town used/);
  assert.deepEqual(body.querySelectorAll('dt').map(n => n.textContent), ['Tokens', 'Calls', 'Cost'], 'the host body holds the same panel');
});

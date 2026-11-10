import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  scheduleCron, pickerOf, clockText, whenText, describeSchedule, runTime, routineFacts, routineDraft, catChoices, modelChoices, defaultMode,
  rowSummary, hookUrl, TEMPLATES, WHEN, HOOK_403, createRoutinesPanel, briefingLead, lastRun, runRow,
} from '../public/routines-panel.js';
import {nextRunAt, BRIEF} from '../src/routines.ts';
import {speakableText, speechChunks, createListener} from '../public/briefing-listen.js';

test('each schedule picker choice becomes a 5-part cron, and "only when I run it" has none', () => {
  assert.deepEqual(scheduleCron({kind: 'weekdays', time: '08:00'}), {cron: '0 8 * * 1-5'});
  assert.deepEqual(scheduleCron({kind: 'daily', time: '7:05'}), {cron: '5 7 * * *'});
  assert.deepEqual(scheduleCron({kind: 'weekly', time: '09:30', day: 1}), {cron: '30 9 * * 1'}, 'every Monday at 09:30');
  assert.deepEqual(scheduleCron({kind: 'weekly', time: '18:00', day: '0'}), {cron: '0 18 * * 0'}, 'Sunday is day 0');
  assert.deepEqual(scheduleCron({kind: 'custom', cron: '  0  */2 * *   * '}), {cron: '0 */2 * * *'});
  assert.deepEqual(scheduleCron({kind: 'none'}), {cron: null});
  assert.match(scheduleCron({kind: 'daily', time: '25:00'}).error, /Choose a time/);
  assert.match(scheduleCron({kind: 'daily', time: ''}).error, /Choose a time/);
  assert.match(scheduleCron({kind: 'weekly', time: '08:00', day: 7}).error, /day of the week/);
  assert.match(scheduleCron({kind: 'custom', cron: '* * * * * *'}).error, /5 parts/, 'no seconds field');
  assert.match(scheduleCron({}).error, /when the routine runs/);
});

test('a saved cron opens in the picker it came from; anything else stays custom so Edit never rewrites it', () => {
  for (const when of [{kind: 'weekdays', time: '08:00'}, {kind: 'daily', time: '23:59'}, {kind: 'weekly', time: '09:30', day: 5}]) {
    const back = pickerOf(scheduleCron(when).cron);
    assert.equal(back.kind, when.kind);
    assert.equal(back.time, when.time);
    if (when.kind === 'weekly') assert.equal(back.day, when.day);
  }
  assert.equal(pickerOf('0 8 * * 7').day, 0, 'cron 7 is Sunday too');
  assert.deepEqual(pickerOf('*/15 9-17 * * 1-5'), {kind: 'custom', time: '08:00', day: 1, cron: '*/15 9-17 * * 1-5'});
  assert.equal(pickerOf('0 8 1 * *').kind, 'custom', 'a monthly pattern is custom');
  assert.equal(pickerOf(null).kind, 'none');
});

test('every picker cron is one the server accepts', () => {
  for (const [kind] of WHEN.filter(([kind]) => kind !== 'none' && kind !== 'custom')) {
    const {cron} = scheduleCron({kind, time: '06:45', day: 3});
    assert.ok(nextRunAt({cron, timezone: 'Europe/London'}, new Date('2026-11-07T00:00:00Z')), kind);
  }
});

test('the schedule reads in plain words, in the reader’s clock format, naming a timezone only when it is not the owner’s', () => {
  assert.equal(clockText('08:00', 'en-GB'), '08:00');
  assert.equal(clockText('8:00', 'en-US'), '08:00 AM');
  assert.equal(describeSchedule({cron: '0 8 * * 1-5', timezone: 'Europe/London'}, 'Europe/London', 'en-GB'), 'Every weekday at 08:00');
  assert.equal(describeSchedule({cron: '30 9 * * 1', timezone: 'Europe/London'}, 'Europe/London', 'en-GB'), 'Every Monday at 09:30');
  assert.equal(describeSchedule({cron: '0 7 * * *', timezone: 'America/New_York'}, 'Europe/London', 'en-GB'), 'Every day at 07:00 (America/New_York)');
  assert.equal(describeSchedule({cron: '*/15 * * * *', timezone: 'UTC'}, 'UTC', 'en-GB'), 'Custom: */15 * * * *');
  assert.equal(describeSchedule(null, 'UTC'), 'Only when you run it');
  assert.equal(whenText({kind: 'weekly', time: '16:30', day: 5}, 'en-GB'), 'Every Friday at 16:30');
});

test('the next run shows in the owner’s timezone; an unreadable time is null', () => {
  assert.equal(runTime('2026-11-09T08:00:00.000Z', 'Europe/London', 'en-GB'), 'Mon 9 Nov, 08:00');
  assert.equal(runTime('2026-11-09T08:00:00.000Z', 'America/New_York', 'en-GB'), 'Mon 9 Nov, 03:00');
  assert.equal(runTime('2026-11-09T08:00:00.000Z', 'Not/AZone', 'en-GB')?.length > 0, true, 'a bad zone falls back to the reader’s own');
  assert.equal(runTime(null, 'UTC'), null);
});

test('a card’s facts: off, not scheduled or the next time; the last run; tokens against the budget', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const base = {enabled: true, schedule: {cron: '0 8 * * 1-5', timezone: 'UTC'}, nextRunAt: '2026-11-09T08:00:00.000Z', lastRunAt: '2026-11-07T09:00:00.000Z', tokensUsed: 1234, tokenBudget: null};
  assert.deepEqual(routineFacts(base, 'UTC', {now, locale: 'en-GB'}), {next: 'Mon 9 Nov, 08:00', last: '3 h ago', tokens: '1,234'});
  assert.equal(routineFacts({...base, enabled: false}, 'UTC', {now}).next, 'Off');
  assert.equal(routineFacts({...base, schedule: null, nextRunAt: null}, 'UTC', {now}).next, 'Not scheduled');
  assert.equal(routineFacts({...base, lastRunAt: null}, 'UTC', {now}).last, 'Not run yet');
  assert.equal(routineFacts({...base, tokenBudget: 50000}, 'UTC', {now, locale: 'en-GB'}).tokens, '1,234 of 50,000');
  assert.equal(routineFacts({...base, tokensUsed: undefined}, 'UTC', {now, locale: 'en-GB'}).tokens, '0', 'nothing reported reads as nothing used');
});

test('the form makes the POST body, or names the first problem', () => {
  const ok = routineDraft({title: ' Daily briefing ', prompt: ' Brief me. ', cat: 'mayor', mode: 'local', budget: '50,000', when: {kind: 'weekdays', time: '08:00'}, timezone: 'Europe/London'});
  assert.deepEqual(ok, {body: {title: 'Daily briefing', prompt: 'Brief me.', cat: 'mayor', mode: 'local', tokenBudget: 50000, enabled: true, schedule: {cron: '0 8 * * 1-5', timezone: 'Europe/London'}}});
  assert.equal(routineDraft({title: 'a', prompt: 'b', budget: '', when: {kind: 'none'}}).body.schedule, null, 'run by hand only');
  assert.equal(routineDraft({title: 'a', prompt: 'b', when: {kind: 'daily', time: '08:00'}, enabled: false}).body.enabled, false);
  assert.match(routineDraft({title: ' ', prompt: 'b'}).error, /title/);
  assert.match(routineDraft({title: 'a', prompt: ''}).error, /what the routine does/);
  assert.match(routineDraft({title: 'a', prompt: 'x'.repeat(4001)}).error, /4,000/);
  for (const budget of ['0', '-5', '2.5', 'lots']) assert.match(routineDraft({title: 'a', prompt: 'b', budget}).error, /whole number/, budget);
  assert.match(routineDraft({title: 'a', prompt: 'b', when: {kind: 'daily', time: 'noon'}}).error, /time/);
});

// The safety warning reads the cat's tools, not the prompt (plan 9.7; routines.test.ts), so a starter's words no longer decide it.
test('the starters are a daily briefing, a weekly review and a draft-only inbox triage; each saves', () => {
  assert.deepEqual(TEMPLATES.map(t => t.label), ['Daily briefing', 'Weekly review', 'Inbox triage (draft only)']);
  assert.match(TEMPLATES[2].prompt, /draft only/);
  for (const t of TEMPLATES) {
    const draft = routineDraft({title: t.title, prompt: t.prompt, when: t.when, timezone: 'UTC'});
    assert.ok(draft.body, t.id);
    assert.ok(nextRunAt(draft.body.schedule), `${t.id} runs`);
  }
  assert.equal(TEMPLATES[1].when.kind, 'weekly');
});

test('menus: the Mayor first, the routine’s own cat and model kept when they are gone, a new routine on the town default', () => {
  const cats = [{id: 'scribe', name: 'Scribe'}, {id: 'mayor', name: 'Mayor'}];
  assert.deepEqual(catChoices(cats).map(c => c.value), ['mayor', 'scribe']);
  assert.equal(catChoices(cats, 'ghost').at(-1).label, 'ghost (no longer in town)');
  const models = [{id: 'demo', label: 'Demonstration'}, {id: 'local', label: 'Local'}, {id: 'claude', label: 'Claude'}];
  assert.equal(modelChoices(models, 'hosted').at(-1).label, 'hosted (not set up)');
  assert.equal(defaultMode(models, {usable: true, provider: 'claude'}), 'claude');
  assert.equal(defaultMode(models, {usable: false, provider: 'claude'}), 'local');
  assert.equal(defaultMode([{id: 'demo'}], null), 'demo');
});

test('the ☰ row counts routines and how many are on; a webhook link is the origin plus the path', () => {
  assert.equal(rowSummary([]), 'Run a prompt on a schedule');
  assert.equal(rowSummary([{enabled: true}, {enabled: false}]), '2 routines · 1 on');
  assert.equal(rowSummary([{enabled: true}]), '1 routine · 1 on');
  assert.equal(hookUrl('https://town.example/', '/hooks/routines/r1/abc'), 'https://town.example/hooks/routines/r1/abc');
});

// A small stand-in for the browser DOM: enough for the panel to build its list and form in Node.
// Selectors are one compound: a tag, classes and [attr] or [attr="value"] parts ("button.primary", "[data-key]").
class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, ownText: '', disabled: false});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return !event.defaultPrevented; }
  click() { this.onclick?.({type: 'click', currentTarget: this}); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector);
    if (!m) throw new Error(`unsupported selector ${selector}`);
    const own = this.className.split(/\s+/), classes = m[2].split('.').filter(Boolean), attrs = [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    return (!m[1] || this.tagName === m[1].toUpperCase()) && classes.every(c => own.includes(c)) && attrs.every(([, k, v]) => k in this.attributes && (v === undefined || this.attributes[k] === v));
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
async function withPanel(routines, fn, {status = {}, saved = null, threads = {}} = {}) {
  const saved_ = globalThis.document, doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  globalThis.document = doc;
  const calls = [], asked = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : undefined]);
    const code = status[url] ?? 200;
    const thread = /^\/api\/threads\/([^?]+)\?limit=1$/.exec(url)?.[1];
    const body = url === '/api/routines' && !init.method ? {routines, timezone: 'Europe/London'}
      : thread ? {messages: [], more: false, tasks: threads[decodeURIComponent(thread)] ?? []}
      : url === '/api/remote/status' ? {origin: null}
        : url.endsWith('/hook') ? {token: 'tok', path: '/hooks/routines/r1/tok'}
          : code === 200 ? (saved ?? {ok: true}) : {error: 'Refused.'};
    return {ok: code < 400, status: code, json: async () => body};
  };
  const opened = [], win = {addEventListener() {}, location: {origin: 'http://127.0.0.1:8787', hash: ''}, navigator: {}};
  const panel = createRoutinesPanel({doc, win, fetchImpl,
    town: () => ({cats: [{id: 'mayor', name: 'Mayor'}, {id: 'scribe', name: 'Scribe'}], models: [{id: 'demo', label: 'Demonstration'}, {id: 'local', label: 'Local'}], townDefault: {usable: true, provider: 'local'}}),
    onOpenChat: id => opened.push(id), ask: async opts => { asked.push(opts.title); return true; }});
  try { await panel.open(); await settle(); return await fn({panel, dialog: panel.dialog, calls, asked, opened, win}); } finally {
    if (saved_ === undefined) delete globalThis.document; else globalThis.document = saved_;
  }
}
const warned = {id: 'r1', title: 'Answer my email', prompt: 'Read my inbox and reply.', cat: 'mayor', mode: 'demo', enabled: true, schedule: {cron: '0 18 * * *', timezone: 'Europe/London'},
  hook: false, running: false, nextRunAt: '2026-11-07T18:00:00.000Z', lastRunAt: null, tokensUsed: 0, tokenBudget: null, note: null,
  warning: 'This routine reads private data, takes in outside content and sends things out.'};
const button = (root, text) => root.querySelectorAll('button').find(b => b.textContent === text);

test('a card leads with the server’s warning, then when, who, the three facts and its buttons', () => withPanel([warned], async ({dialog}) => {
  const card = dialog.querySelector('li.rt-card');
  assert.equal(card.dataset.id, 'r1');
  const parts = card.children.map(c => c.className);
  assert.ok(parts.indexOf('cx-warn rt-warning') === 1, 'the warning comes right after the title row');
  assert.match(card.querySelector('.rt-warning').textContent, /^WarningThis routine reads private data/);
  assert.equal(card.querySelector('.rt-who').textContent, 'Mayor · Demonstration');
  assert.deepEqual(card.querySelectorAll('dt').map(n => n.textContent), ['Next run', 'Last run', 'Tokens used']);
  assert.deepEqual(card.querySelectorAll('button').map(b => b.textContent), ['Run now', 'Edit', 'Webhook link', 'Remove']);
  assert.equal(dialog.querySelector('.rt-lede').textContent.endsWith('Times are in Europe/London.'), true);
}));

test('Run now starts a run and offers the cat’s chat; Remove asks first; the switch saves on or off', () => withPanel([warned], async ({panel, dialog, calls, asked, opened}) => {
  button(dialog, 'Run now').click();
  await settle();
  assert.deepEqual(calls.find(c => c[0] === 'POST'), ['POST', '/api/routines/r1/run', {}]);
  const note = dialog.querySelector('li.rt-card').querySelector('.cx-msg');
  assert.match(note.textContent, /Started\. Mayor is on it\./);
  const chat = note.querySelector('button.rt-link');
  dialog.querySelector('section.rt-list-view').dispatchEvent({type: 'click', target: chat});
  assert.deepEqual(opened, ['mayor']);
  assert.equal(dialog.open, false, 'the panel closes before the chat opens');
  await panel.open();
  const toggle = dialog.querySelector('input[data-key="r1:enabled"]');
  toggle.checked = false; toggle.onchange();
  await settle();
  assert.deepEqual(calls.filter(c => c[0] === 'POST').at(-1), ['POST', '/api/routines/r1', {enabled: false}]);
  button(dialog, 'Remove').click();
  await settle();
  assert.deepEqual(asked, ['Remove “Answer my email”?']);
  assert.deepEqual(calls.filter(c => c[0] === 'POST').at(-1), ['POST', '/api/routines/r1/remove', {}]);
}));

test('a webhook link is refused away from the host with the plain sentence', () => withPanel([warned], async ({dialog}) => {
  button(dialog, 'Webhook link').click();
  await settle();
  assert.equal(dialog.querySelector('li.rt-card').querySelector('.cx-msg').textContent, HOOK_403);
}, {status: {'/api/routines/r1/hook': 403}}));

test('on the host a webhook link shows once, with a copy box', () => withPanel([warned], async ({panel, dialog}) => {
  button(dialog, 'Webhook link').click();
  await settle();
  const input = dialog.querySelector('input.rt-hook-input');
  assert.equal(input.value, 'http://127.0.0.1:8787/hooks/routines/r1/tok');
  dialog.close();
  assert.equal(dialog.querySelector('input.rt-hook-input'), null, 'closing the panel takes the link off the page');
  await panel.open();
  assert.equal(dialog.querySelector('input.rt-hook-input'), null, 'and the next open does not show it again');
  assert.equal(button(dialog, 'Webhook link').textContent, 'Webhook link');
}));

test('New routine: a template fills the form, the picker says when, and Save posts it and shows the server’s warning', () => withPanel([], async ({dialog, calls}) => {
  button(dialog, 'New routine').click();
  const form = dialog.querySelector('form.rt-form');
  assert.deepEqual(form.querySelectorAll('button.rt-template').map(b => b.textContent), TEMPLATES.map(t => t.label));
  assert.equal(form.querySelector('select[id="rt-cat"]').value, 'mayor', 'the Mayor runs it unless chosen otherwise');
  assert.equal(form.querySelector('select[id="rt-mode"]').value, 'local', 'on the town default');
  form.querySelector('button[data-template="weekly"]').click();
  assert.equal(form.querySelector('input[id="rt-title"]').value, 'Weekly review');
  assert.equal(form.querySelector('select[id="rt-when-kind"]').value, 'weekly');
  assert.match(form.querySelector('.rt-preview').textContent, /^Every Monday at .*09.*00.*, Europe\/London time\.$/);
  await form.onsubmit({preventDefault() {}});
  await settle();
  const post = calls.find(c => c[0] === 'POST');
  assert.equal(post[1], '/api/routines');
  assert.deepEqual(post[2].schedule, {cron: '0 9 * * 1', timezone: 'Europe/London'});
  assert.equal(post[2].mode, 'local');
  assert.match(dialog.querySelector('.rt-banner').textContent, /^Saved “Weekly review”\. Warning: Careful\.$/);
  assert.equal(dialog.querySelector('.rt-banner').querySelector('p').className, 'cx-warn rt-warning');
  assert.equal(dialog.querySelector('form.rt-form'), null, 'back on the list');
}, {saved: {routine: {id: 'r9', title: 'Weekly review'}, warning: 'Careful.'}}));

test('Edit keeps a custom schedule as typed, and a bad field never posts', () => withPanel([{...warned, schedule: {cron: '*/30 9-17 * * 1-5', timezone: 'Europe/London'}}], async ({dialog, calls}) => {
  button(dialog, 'Edit').click();
  const form = dialog.querySelector('form.rt-form');
  assert.equal(form.querySelector('.rt-templates'), null, 'templates are for new routines');
  assert.equal(form.querySelector('select[id="rt-when-kind"]').value, 'custom');
  assert.equal(form.querySelector('input[id="rt-when-cron"]').value, '*/30 9-17 * * 1-5');
  form.querySelector('input[id="rt-budget"]').value = '1.5';
  await form.onsubmit({preventDefault() {}});
  assert.match(form.querySelector('.rt-error').textContent, /whole number/);
  assert.equal(calls.some(c => c[0] === 'POST'), false);
  form.querySelector('input[id="rt-budget"]').value = '';
  await form.onsubmit({preventDefault() {}});
  await settle();
  assert.deepEqual(calls.find(c => c[0] === 'POST').slice(0, 2), ['POST', '/api/routines/r1']);
  assert.deepEqual(calls.find(c => c[0] === 'POST')[2].schedule, {cron: '*/30 9-17 * * 1-5', timezone: 'Europe/London'});
}));

// Plan 11.14 (F8): a card says whether its last run worked, from the run task's status (11.3), and lists the last runs.
const NOON = Date.parse('2026-11-09T12:00:00Z');
const run = (task, status, hoursAgo, trigger = 'schedule') => ({task, at: new Date(NOON - hoursAgo * 3_600_000).toISOString(), trigger, status});

test('Last run: done with Open, failed or interrupted with its reason and Retry, in-flight says when it started', () => {
  const now = NOON;
  assert.deepEqual(lastRun({runs: [run('t2', 'done', 2), run('t1', 'failed', 26)]}, {now}), {text: 'Done 2 h ago', action: 'open', task: 't2'});
  assert.deepEqual(lastRun({runs: [run('t1', 'failed', 2)]}, {now, reason: 'Claude plan call timed out'}), {text: 'Failed · Claude plan call timed out', action: 'retry', task: 't1'});
  assert.deepEqual(lastRun({runs: [run('t1', 'interrupted', 2)]}, {now}), {text: 'Interrupted', action: 'retry', task: 't1'}, 'no reason read yet: the word alone');
  assert.equal(lastRun({runs: [run('t3', 'running', 0.1)]}, {now}).text, 'Running, started 6 min ago');
  assert.equal(lastRun({runs: [run('t3', 'waiting', 1)]}, {now}).text, 'Waiting for you, started 1 h ago');
  assert.deepEqual(lastRun({runs: [run('t4', 'cancelled', 3)]}, {now}), {text: 'Stopped 3 h ago', action: 'open', task: 't4'});
  assert.deepEqual(lastRun({runs: [run('gone', null, 3)]}, {now}), {text: '3 h ago', action: null, task: 'gone'}, 'a run with no task in the town has nothing to open');
  assert.deepEqual(lastRun({runs: []}, {now, fallback: '5 h ago'}), {text: '5 h ago', action: null, task: null}, 'only skipped slots: the time, the note says why');
  assert.equal(lastRun({}).text, 'Not run yet');
  assert.equal(runRow(run('t1', 'failed', 26, 'catch-up'), now), 'Failed 26 h ago · run late after a missed time');
  assert.equal(runRow(run('t2', 'done', 2, 'manual'), now), 'Done 2 h ago · Run now');
  assert.equal(runRow(run('t2', 'done', 50, 'webhook'), now), 'Done 2 d ago · from its webhook link');
});

const failing = {...warned, id: 'r1', title: 'Morning digest', warning: null, lastRunAt: run('t1', 'failed', 2).at, runs: [run('t1', 'failed', 2), run('t0', 'done', 26, 'manual')]};
const working = {...warned, id: 'r2', title: 'Weekly review', warning: null, lastRunAt: run('t2', 'done', 2).at, runs: [run('t2', 'done', 2)]};
const threads = {t1: [{id: 't1', status: 'failed', result: 'Claude plan call timed out. Try again later.'}, {id: 't1-child', parent: 't1', status: 'failed', result: 'Not this one.'}]};

test('a failed and a done routine each show their Last run line; the reason is the run task’s, read once', () => withPanel([failing, working], async ({panel, dialog, calls}) => {
  const [bad, good] = dialog.querySelectorAll('li.rt-card');
  const last = card => card.querySelector('.rt-last');
  assert.equal(last(bad).querySelector('dt').textContent, 'Last run');
  assert.equal(last(bad).querySelector('dd').textContent, 'Failed · Claude plan call timed out Retry');
  assert.equal(last(bad).dataset.run, 'retry');
  assert.match(last(good).querySelector('dd').textContent, /^Done .+ ago Open$/);
  assert.equal(last(good).dataset.run, 'open');
  assert.deepEqual(bad.querySelectorAll('dt').map(n => n.textContent), ['Next run', 'Last run', 'Tokens used'], 'still three facts');
  const reads = () => calls.filter(c => c[1].startsWith('/api/threads/')).map(c => c[1]);
  assert.deepEqual(reads(), ['/api/threads/t1?limit=1'], 'only the failed run is read');
  await panel.refresh(); await settle();
  assert.deepEqual(reads(), ['/api/threads/t1?limit=1'], 'and only once while the panel is open');
}, {threads}));

test('Retry is Run now; Open closes the panel and opens the run’s thread', () => withPanel([failing, working], async ({panel, dialog, calls, win, opened}) => {
  button(dialog.querySelector('li.rt-card'), 'Retry').click();
  await settle();
  assert.deepEqual(calls.filter(c => c[0] === 'POST'), [['POST', '/api/routines/r1/run', {}]]);
  assert.equal(dialog.open, true, 'Retry keeps the panel open');
  const good = dialog.querySelectorAll('li.rt-card')[1];
  button(good.querySelector('.rt-last'), 'Open').click();
  assert.equal(dialog.open, false);
  assert.equal(win.location.hash, 'thread=t2');
  assert.deepEqual(opened, [], 'a thread, not the cat’s chat');
  await panel.open(); await settle();
}, {threads}));

test('the last runs fold under the card, newest first, each with Open', () => withPanel([failing, {...warned, id: 'r3', runs: []}], async ({dialog, win}) => {
  const [card, none] = dialog.querySelectorAll('li.rt-card');
  assert.equal(none.querySelector('details.rt-runs'), null, 'no runs, no list');
  assert.equal(none.querySelector('.rt-last').querySelector('dd').textContent, 'Not run yet');
  const box = card.querySelector('details.rt-runs');
  assert.equal(box.querySelector('summary').textContent, 'Last 2 runs');
  const rows = box.querySelectorAll('li');
  assert.deepEqual(rows.map(li => li.dataset.task), ['t1', 't0']);
  assert.match(rows[0].textContent, /^Failed .+ ago · on schedule Open$/);
  assert.match(rows[1].textContent, /^Done .+ ago · Run now Open$/);
  assert.match(rows[1].querySelector('button').getAttribute('aria-label'), /^Open the run: Done .+ · Run now$/);
  rows[1].querySelector('button').click();
  assert.equal(win.location.hash, 'thread=t0');
}, {threads}));

test('Routines live in the Mayor’s corner: its chip, Options > Manage, /routines and openSurface open them, and ☰ no longer lists them', async () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /initRoutinesPanel\(\{town:\(\)=>state,/);
  assert.match(app, /routines:\(\)=>void routinesPanel\.open\(\)/);
  assert.match(app, /const MANAGED=\{.*\broutines:\(\)=>void routinesPanel\.open\(\)/, 'the chat opens the same panel');
  const {ROWS} = await import('../public/settings-menu.js');
  const {KEEPERS} = await import('../public/manage.js');
  const {COMMAND_PANELS} = await import('../public/chat-composer.js');
  assert.ok(!ROWS.includes('routines'), 'not a ☰ row');
  assert.deepEqual(KEEPERS.find(k => k.role === 'mayor').items, ['autonomy', 'routines']);
  assert.equal(COMMAND_PANELS.routines, 'routines');
  const panel = readFileSync(new URL('../public/routines-panel.js', import.meta.url), 'utf8');
  assert.ok(!panel.includes('registerSettingsSection'), 'the panel registers no ☰ section');
  assert.match(panel, /panel\.ready = panel\.probe\(\)\.catch\(\(\) => false\)/, 'the chat offers it once its probe answers');
});

// Daily briefing Listen (plan 3.2).

test('a briefing is read as plain words: no Markdown marks, links read as their text, long text in short pieces', () => {
  assert.equal(speakableText('# Today\n\n- **3 decisions** wait for you\n- See [the post](https://x.example/p) and https://y.example\n---\n1. `Ship` it'),
    'Today\n3 decisions wait for you\nSee the post and a link\nShip it');
  assert.equal(briefingLead('## Quiet day: nothing waits.\nMore.'), 'Quiet day: nothing waits.');
  const chunks = speechChunks(`${'One short sentence. '.repeat(30)}\nNext line.`, 100);
  assert.ok(chunks.every(c => c.length <= 100));
  assert.equal(chunks.at(-1), 'Next line.');
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), `${'One short sentence. '.repeat(30)}Next line.`.trim());
  assert.ok(speechChunks('x'.repeat(500), 200).every(c => c.length <= 200), 'a run-on line is cut too');
});

test('the listener speaks, says Stop while it does, stops, and does nothing where the browser has no speech', () => {
  const spoken = [];
  let cancelled = 0;
  const win = {speechSynthesis: {speak: u => spoken.push(u), cancel: () => { cancelled++; }}, SpeechSynthesisUtterance: function (t) { this.text = t; }};
  const l = createListener(win), seen = [];
  assert.equal(l.available, true);
  assert.equal(l.toggle('r1', 'Hello there. Two decisions wait.', id => seen.push(id)), true);
  assert.equal(l.reading, 'r1');
  assert.deepEqual(spoken.map(u => u.text), ['Hello there. Two decisions wait.']);
  spoken.at(-1).onend();
  assert.equal(l.reading, null, 'the last piece ending ends the reading');
  l.toggle('r1', 'Again.', id => seen.push(id));
  assert.equal(l.toggle('r1', 'Again.'), false, 'the same button again stops it');
  assert.ok(cancelled >= 2);
  assert.deepEqual(seen, ['r1', null, 'r1', null]);
  assert.equal(createListener({}).available, false);
  assert.equal(createListener({}).toggle('r1', 'x'), false);
});

test('the Daily briefing starter is a real briefing routine: it carries the facts marker', () => {
  assert.ok(TEMPLATES[0].prompt.includes(BRIEF));
  assert.equal(TEMPLATES.filter(t => t.prompt.includes(BRIEF)).length, 1, 'only the briefing');
});

test('a briefing routine’s card shows its latest result with Listen; Listen reads it and becomes Stop', () => {
  const spoken = [];
  const win = {addEventListener() {}, location: {origin: 'http://127.0.0.1:8787'}, navigator: {}, speechSynthesis: {speak: u => spoken.push(u.text), cancel() {}}, SpeechSynthesisUtterance: function (t) { this.text = t; }};
  const doc = {activeElement: null, head: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  const saved = globalThis.document;
  globalThis.document = doc;
  const briefing = '# Your day\nTwo decisions wait for you.\nThe Scribe finished the reel.';
  const routine = {...warned, warning: null, briefing};
  const body = {routines: [routine, {...warned, id: 'r2', title: 'Plain', warning: null, briefing: null}], timezone: 'Europe/London'};
  const fetchImpl = async () => ({ok: true, status: 200, json: async () => body});
  return (async () => {
    try {
      const panel = createRoutinesPanel({doc, win, fetchImpl, town: () => ({cats: [{id: 'mayor', name: 'Mayor'}], models: []}), ask: async () => true});
      await panel.open(); await settle();
      const cards = panel.dialog.querySelectorAll('li.rt-card');
      assert.equal(cards[1].querySelector('.rt-briefing'), null, 'a routine that is not a briefing has no Listen');
      const box = cards[0].querySelector('.rt-briefing');
      assert.equal(box.querySelector('.rt-briefing-lead').textContent, 'Your day');
      assert.equal(box.querySelector('.rt-briefing-text').textContent, briefing);
      const listen = box.querySelector('button.rt-listen');
      assert.equal(listen.textContent, 'Listen');
      listen.click();
      assert.deepEqual(spoken, ['Your day', 'Two decisions wait for you.', 'The Scribe finished the reel.']);
      const stop = panel.dialog.querySelector('li.rt-card').querySelector('button.rt-listen');
      assert.equal(stop.textContent, 'Stop');
      assert.equal(stop.getAttribute('aria-pressed'), 'true');
      panel.dialog.close();
    } finally { globalThis.document = saved; }
  })();
});

// Routines (plan 3.1 and 3.8): a prompt a cat runs on its own, on a schedule in the owner's timezone, on Run now or from its webhook.
// The Mayor's corner opens this panel (its Routines chip, Options > Manage, /routines). It reads GET /api/routines and writes through the owner routes in src/routines.ts. Routines are not
// in the town state (their webhook hashes stay off it), so the list is read when the panel opens, after each change, and while it is
// open whenever the town changes. A webhook link is made and shown on the host computer only, once. The pure helpers are exported for
// Node tests; the DOM is built with createElement and textContent only, so a title or a prompt can never become markup.
import {el} from './projects-panel.js';
import {ago} from './quests-panel.js';
import {confirmDialog} from './dialogs.js';
import {createListener, speakableText} from './briefing-listen.js';
import {oneLiner} from './one-liner.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The schedule picker, in reading order. It reads as a sentence with the day and time beside it: "Every week on Monday at 09:00".
// Custom takes a 5-part cron; "none" leaves Run now and the webhook.
export const WHEN = [['weekdays', 'Every weekday'], ['daily', 'Every day'], ['weekly', 'Every week'], ['custom', 'Custom (cron)'], ['none', 'Only when I run it']];
export const HOOK_403 = 'Webhook links are shown on the host computer.';
// Starter routines. Each one only reads and reports, or drafts, so none of them sends anything out on its own.
export const TEMPLATES = [
  // {{briefing}} makes it a briefing routine (src/routines.ts): each run fills it with the facts since the last one, and the card offers Listen.
  {id: 'briefing', label: 'Daily briefing', title: 'Daily briefing', when: {kind: 'weekdays', time: '08:00', day: 1},
    prompt: 'Write my daily briefing in plain words. Start with every decision and to-do that waits for me, most urgent first. Then say what the cats finished since the last briefing and what they are working on now. Keep it short. Use only the facts below. Only read and report: change nothing.\n\n{{briefing}}'},
  {id: 'weekly', label: 'Weekly review', title: 'Weekly review', when: {kind: 'weekly', time: '09:00', day: 1},
    prompt: 'Review the past week in plain words: what got done, what is stuck and why, and what waits for me. End with the three most useful next steps for the week ahead. Only read and report: change nothing.'},
  {id: 'inbox', label: 'Inbox triage (draft only)', title: 'Inbox triage', when: {kind: 'weekdays', time: '09:00', day: 1},
    prompt: 'Go through the new mail in my inbox. Sort each message into needs an answer, read later or ignore. For each one that needs an answer, write a short draft and save it as a draft only. Nothing goes out without me: list the drafts for me to check.'},
];
const NEW_WHEN = {kind: 'weekdays', time: '08:00', day: 1, cron: ''};
const list = value => (Array.isArray(value) ? value : []);
const enc = encodeURIComponent;

// A whole HH:MM clock time, or null.
function clock(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? {h: Number(m[1]), m: Number(m[2])} : null;
}

/** The picker's choice as a cron: {cron}, with null for "only when I run it", or {error} with a sentence the owner can act on. */
export function scheduleCron({kind, time, day, cron} = {}) {
  if (kind === 'none') return {cron: null};
  if (kind === 'custom') {
    const text = String(cron ?? '').trim().replace(/\s+/g, ' ');
    return text.split(' ').length === 5 ? {cron: text} : {error: 'A custom schedule has 5 parts: minute, hour, day, month and weekday, such as 30 7 * * 1-5.'};
  }
  if (!['daily', 'weekdays', 'weekly'].includes(kind)) return {error: 'Choose when the routine runs.'};
  const at = clock(time);
  if (!at) return {error: 'Choose a time, such as 08:00.'};
  if (kind === 'daily') return {cron: `${at.m} ${at.h} * * *`};
  if (kind === 'weekdays') return {cron: `${at.m} ${at.h} * * 1-5`};
  const d = Number(day);
  return Number.isInteger(d) && d >= 0 && d <= 6 ? {cron: `${at.m} ${at.h} * * ${d}`} : {error: 'Choose a day of the week.'};
}

/** A saved cron back in the picker's terms. A pattern the picker cannot say stays custom, so Edit never rewrites it. */
export function pickerOf(cron) {
  if (cron === null || cron === undefined) return {...NEW_WHEN, kind: 'none'};
  const text = String(cron).trim().replace(/\s+/g, ' ');
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(text);
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return {...NEW_WHEN, kind: 'custom', cron: text};
  const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  if (m[3] === '*') return {kind: 'daily', time, day: 1, cron: text};
  if (m[3] === '1-5') return {kind: 'weekdays', time, day: 1, cron: text};
  return {kind: 'weekly', time, day: Number(m[3]) % 7, cron: text};
}

/** A clock time in the reader's own format: "08:00", or "08:00 AM" where the locale says so. */
export function clockText(time, locale) {
  const at = clock(time);
  if (!at) return String(time ?? '');
  return new Date(Date.UTC(2000, 0, 3, at.h, at.m)).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit', timeZone: 'UTC'});
}

/** When a picker choice runs, in plain words. */
export function whenText(when, locale) {
  if (when.kind === 'none') return 'Only when you run it';
  if (when.kind === 'custom') return `Custom: ${String(when.cron ?? '').trim() || 'no pattern yet'}`;
  const days = when.kind === 'daily' ? 'Every day' : when.kind === 'weekdays' ? 'Every weekday' : `Every ${WEEKDAYS[Number(when.day)] ?? 'week'}`;
  return `${days} at ${clockText(when.time, locale)}`;
}

/** The card's schedule line. A routine kept in another timezone than the owner's names its zone. */
export function describeSchedule(schedule, ownerZone, locale) {
  if (!schedule) return 'Only when you run it';
  const zone = schedule.timezone && schedule.timezone !== ownerZone ? ` (${schedule.timezone})` : '';
  return `${whenText(pickerOf(schedule.cron), locale)}${zone}`;
}

/** A run's time in the owner's timezone ("Mon 10 Nov, 08:00"), or null when it cannot be read. */
export function runTime(iso, zone, locale) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  const shape = {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'};
  try { return new Date(t).toLocaleString(locale, zone ? {...shape, timeZone: zone} : shape); } catch { return new Date(t).toLocaleString(locale, shape); }
}

/** The card's three facts. Tokens are what providers reported over every run, so a missing count is a floor, never a guess. */
export function routineFacts(routine, zone, {now = Date.now(), locale} = {}) {
  const next = !routine.enabled ? 'Off' : !routine.schedule ? 'Not scheduled' : runTime(routine.nextRunAt, zone, locale) ?? 'Not scheduled';
  const last = routine.lastRunAt ? ago(routine.lastRunAt, now) : 'Not run yet';
  const used = Number.isFinite(routine.tokensUsed) ? routine.tokensUsed : 0;
  const tokens = routine.tokenBudget ? `${used.toLocaleString(locale)} of ${routine.tokenBudget.toLocaleString(locale)}` : used.toLocaleString(locale);
  return {next, last, tokens};
}

// Plan 11.14 (F8): a run is its task (src/routines.ts runs, newest first), so its status says whether it worked. In-flight runs say when
// they started; a failed or interrupted one offers Retry (the existing Run now), the others Open (the run's thread).
const RUN_WORDS = {done: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped', queued: 'Waiting to start', running: 'Running', waiting: 'Waiting for you', waiting_child: 'Running'};
const RUN_LIVE = ['queued', 'running', 'waiting', 'waiting_child'];
const RUN_FAILED = ['failed', 'interrupted'];
const TRIGGER_WORDS = {schedule: 'on schedule', 'catch-up': 'run late after a missed time', manual: 'Run now', webhook: 'from its webhook link'};

/** One run in words: "Done 2 h ago", "Running, started 1 min ago". A run whose task is not in the town has no status and reads as a time. */
export function runWords(run, now = Date.now()) {
  if (!run?.status) return ago(run?.at, now);
  const word = RUN_WORDS[run.status] ?? 'Running';
  return RUN_LIVE.includes(run.status) ? `${word}, started ${ago(run.at, now)}` : `${word} ${ago(run.at, now)}`;
}

/**
 * The card's Last run, from the newest run: {text, action, task}. A failed or interrupted run reads "Failed · <reason>" with Retry; any other
 * run with a status offers Open. No run yet: fallback, the time of a skipped slot or "Not run yet" (routineFacts).
 */
export function lastRun(routine, {now = Date.now(), reason = '', fallback = 'Not run yet'} = {}) {
  const run = list(routine?.runs)[0];
  if (!run) return {text: fallback, action: null, task: null};
  if (RUN_FAILED.includes(run.status)) return {text: [RUN_WORDS[run.status], reason].filter(Boolean).join(' · '), action: 'retry', task: run.task};
  return {text: runWords(run, now), action: run.status ? 'open' : null, task: run.task};
}

/** A row of the last-runs list: "Done 2 h ago · on schedule". */
export const runRow = (run, now = Date.now()) => [runWords(run, now), TRIGGER_WORDS[run?.trigger]].filter(Boolean).join(' · ');

/** The form's fields as the POST body, or the first problem with them. A blank budget means none. */
export function routineDraft({title, prompt, cat, mode, budget, enabled = true, when = NEW_WHEN, timezone} = {}) {
  const name = String(title ?? '').trim();
  if (!name) return {error: 'Give the routine a title.'};
  const text = String(prompt ?? '').trim();
  if (!text) return {error: 'Write what the routine does.'};
  if (text.length > 4000) return {error: 'Keep what the routine does to 4,000 characters.'};
  const raw = String(budget ?? '').trim().replace(/[\s,_]/g, '');
  const tokenBudget = raw === '' ? null : Number(raw);
  if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget < 1)) return {error: 'The token budget must be a whole number, or blank for none.'};
  const schedule = scheduleCron(when);
  if (schedule.error) return {error: schedule.error};
  return {body: {title: name, prompt: text, cat: cat || 'mayor', mode: mode || 'demo', tokenBudget, enabled: enabled !== false,
    schedule: schedule.cron === null ? null : {cron: schedule.cron, ...(timezone ? {timezone} : {})}}};
}

/** The cat menu: the town's cats, the Mayor first, plus the routine's own cat when it has left town. */
export function catChoices(cats, current) {
  const out = list(cats).map(c => ({value: c.id, label: c.name ?? c.id})).sort((a, b) => (b.value === 'mayor') - (a.value === 'mayor'));
  if (current && !out.some(o => o.value === current)) out.push({value: current, label: `${current} (no longer in town)`});
  return out;
}
/** The model menu: each provider the town can use, plus the routine's own when it is no longer set up. */
export function modelChoices(models, current) {
  const out = list(models).map(m => ({value: m.id, label: m.label ?? m.name ?? m.id}));
  if (current && !out.some(o => o.value === current)) out.push({value: current, label: `${current} (not set up)`});
  return out;
}
/** A new routine starts on the town default's provider, else the first real one, else the demonstration. */
export function defaultMode(models, townDefault) {
  const ids = list(models).map(m => m.id);
  if (townDefault?.usable && ids.includes(townDefault.provider)) return townDefault.provider;
  return ids.find(id => id !== 'demo') ?? 'demo';
}
/** A one-line summary of the routines: none yet, or how many run. */
export function rowSummary(routines) {
  const all = list(routines);
  if (!all.length) return 'Run a prompt on a schedule';
  const on = all.filter(r => r.enabled).length;
  return `${all.length} ${all.length === 1 ? 'routine' : 'routines'} · ${on} on`;
}
export const hookUrl = (origin, path) => `${String(origin ?? '').replace(/\/+$/, '')}${path}`;
/** A briefing's first line, for the card: the line the push names, without its Markdown. */
export const briefingLead = text => speakableText(text).split('\n')[0] ?? '';

function injectStyles(doc) {
  if (!doc?.head || doc.querySelector('link[data-routines-panel]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('routines-panel.css', import.meta.url).href;
  link.dataset.routinesPanel = '';
  doc.head.append(link);
}

const h = (tag, props, ...children) => el(tag, props, children.flat().filter(c => c !== null && c !== undefined && c !== false));

/**
 * The Routines dialog. town() gives the state for the cat and model menus; onOpenChat(cat) shows a cat's chat once the dialog has closed.
 * Returns {open, close, refresh, probe, summary}.
 */
export function createRoutinesPanel({doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), town = () => null, onOpenChat = () => {}, ask = confirmDialog, listener = createListener(win)} = {}) {
  injectStyles(doc);
  // reasons: a failed or interrupted run's task id to its reason, read once from its thread (the routines list carries the status only).
  const ui = {routines: [], timezone: null, loaded: false, denied: null, view: 'list', editing: null, busy: new Set(), msgs: new Map(), hooks: new Map(), reasons: new Map(), banner: null, key: ''};
  // lastFocus: the data-key of the list control the owner last focused, so a repaint can put focus back on it.
  let refreshing = false, again = false, townTimer = 0, lastFocus = null;

  const read = async path => {
    const response = await fetchImpl(path, {cache: 'no-store'});
    const data = await response.json().catch(() => ({}));
    return {status: response.status, ok: response.ok, data};
  };
  const send = async (path, body = {}) => {
    const response = await fetchImpl(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'That did not work.'), {status: response.status});
    return data;
  };
  const catName = id => list(town()?.cats).find(c => c.id === id)?.name ?? (id === 'mayor' ? 'Mayor' : id);
  const modelName = id => list(town()?.models).find(m => m.id === id)?.label ?? (id === 'demo' ? 'Demonstration' : id);

  // The shell: a title row (back pill on phones, × on desktop), the lede, a page message, then the list and the form, one at a time.
  const back = h('button', {className: 'back-pill phone-only', text: '← Town', attrs: {type: 'button', 'aria-label': 'Back to town'}});
  const closeX = h('button', {className: 'close-x desk-only', text: '×', attrs: {type: 'button', 'aria-label': 'Close routines'}});
  const lede = h('p', {className: 'rt-lede'});
  const banner = h('div', {className: 'rt-banner', attrs: {role: 'status'}});
  const listView = h('section', {className: 'rt-list-view', attrs: {'aria-label': 'Your routines'}});
  const formView = h('section', {className: 'rt-form-view', attrs: {'aria-labelledby': 'rt-form-title'}});
  formView.hidden = true;
  const dialog = h('dialog', {className: 'routines-dialog', attrs: {id: 'routines-dialog', 'aria-labelledby': 'routines-title'}},
    h('div', {className: 'treasury-dialog-title rt-top'}, back, h('span', {className: 'eyebrow', text: 'ON THEIR OWN'}), closeX),
    h('h2', {text: 'Routines', attrs: {id: 'routines-title'}}),
    lede, banner, listView, formView);
  back.onclick = () => dialog.close();
  closeX.onclick = () => dialog.close();
  doc.body.append(dialog);
  // Escape steps back from the form to the list before it closes the panel.
  dialog.addEventListener('cancel', e => { if (ui.view === 'form') { e.preventDefault(); showList(); } });
  // Closing forgets what was on screen, a webhook link included: the next open reads the list again.
  dialog.addEventListener('close', () => {
    clearTimeout(townTimer); townTimer = 0; lastFocus = null; listener.stop();
    ui.view = 'list'; ui.editing = null; ui.hooks.clear(); ui.msgs.clear(); ui.reasons.clear(); ui.banner = null; ui.key = '';
    formView.hidden = true; formView.replaceChildren(); listView.hidden = false; listView.replaceChildren();
  });
  // While open, the town's own changes (a run starting or ending) re-read the list, a second apart at most.
  win?.addEventListener?.('town-state', () => {
    if (!dialog.open || townTimer) return;
    townTimer = setTimeout(() => { townTimer = 0; void refresh(); }, 1000);
  });

  function paintLede() {
    lede.textContent = `A routine is a prompt a cat runs on its own: on a schedule, when you tap Run now, or from its webhook link.${ui.timezone ? ` Times are in ${ui.timezone}.` : ''}`;
  }
  function paintBanner() {
    const b = ui.banner;
    banner.replaceChildren(...(b ? [h('p', {className: b.warning ? 'cx-warn rt-warning' : 'cx-msg', text: b.text, attrs: b.warning ? {role: 'alert'} : {}})] : []));
    banner.hidden = !b;
  }

  async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const r = await read('/api/routines');
      if (!r.ok) throw Object.assign(new Error(r.data.error || 'Routines could not load.'), {status: r.status});
      ui.routines = list(r.data.routines); ui.timezone = typeof r.data.timezone === 'string' ? r.data.timezone : null; ui.loaded = true; ui.denied = false;
      ui.msgs.delete('page');
      // A last run that failed names its reason: the run task's result, from its thread. Read once per run; a failed read leaves it blank.
      await Promise.all(ui.routines.map(x => list(x.runs)[0]).filter(run => RUN_FAILED.includes(run?.status) && !ui.reasons.has(run.task)).map(async run => {
        const t = await read(`/api/threads/${enc(run.task)}?limit=1`).catch(() => null);
        ui.reasons.set(run.task, t?.ok ? oneLiner(list(t.data.tasks).find(x => x.id === run.task)?.result, 80) : '');
      }));
    } catch (error) {
      if (error.status === 403) ui.denied = true;
      ui.msgs.set('page', {text: error.message || 'Routines could not load.', bad: true});
    } finally {
      refreshing = false;
    }
    const key = JSON.stringify([ui.routines, ui.timezone, [...ui.msgs], ui.denied, [...ui.reasons]]);
    if (key !== ui.key) { ui.key = key; paintList(); }
    if (again) { again = false; await refresh(); }
  }

  // Runs one request with its key busy until it ends; a failure lands in the slot. Then the list is read again.
  async function act(key, work, slotName = key) {
    if (ui.busy.has(key)) return false;
    ui.busy.add(key); ui.msgs.delete(slotName); paintList();
    let ok = false;
    try { await work(); ok = true; } catch (error) { ui.msgs.set(slotName, {text: error.message || String(error), bad: true}); } finally {
      ui.busy.delete(key); ui.key = ''; await refresh();
    }
    return ok;
  }

  const message = name => {
    const m = ui.msgs.get(name);
    if (!m) return null;
    return h('p', {className: `cx-msg${m.bad ? ' bad' : ''}`, attrs: {role: 'status', 'data-slot': name}}, m.text,
      ...(m.chat ? [' ', h('button', {className: 'rt-link', text: `Open ${catName(m.chat)}’s chat`, attrs: {type: 'button'}})] : []));
  };
  const button = (text, {className = '', key, onclick, attrs = {}} = {}) => {
    const b = h('button', {className, text, attrs: {type: 'button', ...(key ? {'data-key': key} : {}), ...attrs}});
    if (key && ui.busy.has(key)) b.disabled = true;
    if (onclick) b.onclick = onclick;
    return b;
  };

  function toggle(r) {
    const input = h('input', {attrs: {type: 'checkbox', role: 'switch', 'data-key': `${r.id}:enabled`, 'aria-label': `${r.title}: on or off`}});
    input.checked = r.enabled === true;
    input.disabled = ui.busy.has(`${r.id}:enabled`);
    const text = h('span', {text: input.checked ? 'On' : 'Off'});
    input.onchange = () => {
      text.textContent = input.checked ? 'On' : 'Off';
      void act(`${r.id}:enabled`, () => send(`/api/routines/${enc(r.id)}`, {enabled: input.checked}), r.id);
    };
    return h('label', {className: 'cx-switch rt-switch'}, input, h('span', {className: 'switch-track', attrs: {'aria-hidden': 'true'}}), text);
  }

  const fact = (label, value) => h('div', {}, h('dt', {text: label}), h('dd', {text: value}));

  function card(r) {
    const facts = routineFacts(r, ui.timezone);
    const runKey = `${r.id}:run`, hookKey = `${r.id}:hook`, removeKey = `${r.id}:remove`;
    const run = button(r.running ? 'Running…' : 'Run now', {className: 'primary', key: runKey, onclick: () => void runNow(r)});
    if (r.running) run.disabled = true;
    return h('li', {className: 'cx-card rt-card', attrs: {'data-id': r.id, 'data-enabled': String(r.enabled === true)}},
      h('div', {className: 'cx-head'},
        h('div', {className: 'cx-title'}, h('strong', {text: r.title}), r.running ? h('span', {className: 'cx-badge', text: 'Running'}) : null),
        toggle(r)),
      // The server's safety warning leads the card: it is the one thing to read before the routine runs again.
      r.warning ? h('p', {className: 'cx-warn rt-warning', attrs: {role: 'note'}}, h('strong', {text: 'Warning'}), h('span', {text: r.warning})) : null,
      h('p', {className: 'rt-when', text: describeSchedule(r.schedule, ui.timezone)}),
      h('p', {className: 'rt-who', text: `${catName(r.cat)} · ${modelName(r.mode)}${r.hook ? ' · webhook link on' : ''}`}),
      r.note ? h('p', {className: 'cx-note', text: r.note}) : null,
      h('dl', {className: 'rt-facts'}, fact('Next run', facts.next), lastRunFact(r, facts.last), fact(r.tokenBudget ? 'Tokens used of budget' : 'Tokens used', facts.tokens)),
      h('div', {className: 'rt-actions'},
        run,
        button('Edit', {key: `${r.id}:edit`, onclick: () => showForm(r)}),
        button(r.hook ? 'New webhook link' : 'Webhook link', {key: hookKey, onclick: () => void makeHook(r)}),
        button('Remove', {className: 'rt-remove', key: removeKey, onclick: () => void remove(r)})),
      runsBox(r),
      message(r.id),
      hookBox(r),
      briefingBox(r));
  }

  // Last run says whether it worked (plan 11.14): Retry runs it again as Run now does; Open shows the run's thread. "quiet", not rt-link:
  // the list's click handler opens a cat's chat for every rt-link.
  function lastRunFact(r, fallback) {
    const line = lastRun(r, {reason: ui.reasons.get(list(r.runs)[0]?.task), fallback});
    let action = null;
    if (line.action === 'retry') {
      action = button('Retry', {className: 'quiet', key: `${r.id}:retry`, attrs: {'aria-label': `Retry ${r.title}`}, onclick: () => void runNow(r)});
      if (r.running || ui.busy.has(`${r.id}:run`)) action.disabled = true;
    } else if (line.action === 'open') {
      action = button('Open', {className: 'quiet', key: `${r.id}:open`, attrs: {'aria-label': `Open the last run of ${r.title}`}, onclick: () => openRun(line.task)});
    }
    return h('div', {className: 'rt-last', attrs: {'data-run': line.action ?? 'none'}}, h('dt', {text: 'Last run'}), h('dd', {}, line.text, action ? ' ' : null, action));
  }
  // The last runs, newest first, folded under the card. Each opens its thread.
  function runsBox(r) {
    const runs = list(r.runs);
    if (!runs.length) return null;
    return h('details', {className: 'rt-runs'}, h('summary', {text: `Last ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`}),
      h('ol', {}, runs.map((run, i) => h('li', {attrs: {'data-task': run.task}}, runRow(run), run.status ? ' ' : null,
        run.status ? button('Open', {className: 'quiet', key: `${r.id}:run-${i}`, attrs: {'aria-label': `Open the run: ${runRow(run)}`}, onclick: () => openRun(run.task)}) : null))));
  }
  // #thread=<task> opens that run's thread in the chat panel (app.js takeLink), as people-panel.js does.
  function openRun(task) {
    dialog.close();
    if (win?.location) win.location.hash = `thread=${enc(task)}`;
  }

  // A briefing routine's latest result, with Listen: the browser reads it aloud, and the button says Stop while it does.
  function briefingBox(r) {
    if (!r.briefing) return null;
    const key = `${r.id}:listen`, on = listener.reading === r.id;
    const listen = listener.available ? button(on ? 'Stop' : 'Listen', {className: on ? 'rt-listen primary' : 'rt-listen', key, attrs: {'aria-pressed': String(on), 'aria-label': on ? `Stop reading ${r.title}` : `Listen to ${r.title}`}, onclick: () => {
      listener.toggle(r.id, r.briefing, () => { ui.key = ''; paintList(); });
    }}) : null;
    return h('div', {className: 'rt-briefing'},
      h('div', {className: 'rt-briefing-head'}, h('strong', {text: 'Latest briefing'}), listen),
      h('p', {className: 'rt-briefing-lead', text: briefingLead(r.briefing)}),
      speakableText(r.briefing).includes('\n') ? h('details', {className: 'rt-briefing-more'}, h('summary', {text: 'Read it all'}), h('p', {className: 'rt-briefing-text', text: r.briefing})) : null,
      listener.available ? null : h('p', {className: 'rt-hook-note', text: 'This browser cannot read aloud.'}));
  }

  function paintList() {
    paintLede(); paintBanner();
    if (ui.view !== 'list') return;
    const add = button('New routine', {className: 'primary rt-new', key: 'new', onclick: () => showForm(null)});
    add.disabled = ui.denied === true;
    const items = ui.routines.map(card);
    const empty = !ui.loaded ? h('p', {className: 'cx-empty muted', text: 'Loading routines…', attrs: {role: 'status'}})
      : ui.denied ? null
        : h('div', {className: 'empty'}, h('span', {className: 'big', text: '↻', attrs: {'aria-hidden': 'true'}}), h('p', {text: 'No routines yet. Start one from a template: a daily briefing, a weekly review or an inbox triage that only drafts.'}));
    listView.replaceChildren(...[message('page'), h('div', {className: 'rt-bar'}, add), items.length ? h('ul', {className: 'rt-list'}, items) : empty].filter(Boolean));
    restoreFocus();
  }
  // A repaint puts focus back on the same control of the same card, so a live refresh or a busy button never throws the reader
  // back to the top. Focus that moved to another layer (the confirm dialog) is left alone.
  listView.addEventListener('focusin', e => { lastFocus = e.target?.dataset?.key ?? null; });
  function restoreFocus() {
    const active = doc.activeElement;
    if (!lastFocus || !(active === doc.body || active === dialog || listView.contains?.(active))) return;
    if (active?.dataset?.key === lastFocus && active.isConnected) return;
    [...listView.querySelectorAll('[data-key]')].find(n => n.dataset.key === lastFocus && !n.disabled)?.focus();
  }

  async function runNow(r) {
    const ok = await act(`${r.id}:run`, () => send(`/api/routines/${enc(r.id)}/run`), r.id);
    if (ok) { ui.msgs.set(r.id, {text: `Started. ${catName(r.cat)} is on it.`, chat: r.cat}); ui.key = ''; paintList(); }
  }

  async function remove(r) {
    const yes = await ask({title: `Remove “${r.title}”?`, message: 'It stops running and leaves this list. What its runs already did stays in the chat and the diary.', confirmLabel: 'Remove routine', cancelLabel: 'Keep it', danger: true});
    if (!yes) return;
    await act(`${r.id}:remove`, () => send(`/api/routines/${enc(r.id)}/remove`), r.id);
  }

  // A new link replaces the old one at once, so an existing link asks first. The token comes back once and is never kept here after close.
  async function makeHook(r) {
    if (r.hook && !await ask({title: 'Make a new webhook link?', message: 'The old link stops working at once. Anything that calls it needs the new one.', confirmLabel: 'Make a new link', cancelLabel: 'Keep the old one'})) return;
    await act(`${r.id}:hook`, async () => {
      let data;
      try { data = await send(`/api/routines/${enc(r.id)}/hook`); } catch (error) { throw error.status === 403 ? new Error(HOOK_403) : error; }
      const remote = await read('/api/remote/status').then(x => (x.ok && typeof x.data.origin === 'string' ? x.data.origin : null)).catch(() => null);
      ui.hooks.set(r.id, {path: data.path, remote});
    }, r.id);
  }

  function linkRow(label, url) {
    const input = h('input', {className: 'rt-hook-input', attrs: {type: 'text', readonly: '', 'aria-label': `${label}: webhook link`, spellcheck: 'false'}});
    input.value = url;
    input.onclick = () => input.select();
    const copy = button('Copy', {onclick: async () => {
      try { await win.navigator.clipboard.writeText(url); copy.textContent = 'Copied'; } catch { input.select(); copy.textContent = 'Select and copy'; }
    }});
    return h('div', {className: 'rt-hook-row'}, h('span', {className: 'rt-hook-label', text: label}), h('div', {className: 'rt-hook-field'}, input, copy));
  }
  function hookBox(r) {
    const hook = ui.hooks.get(r.id);
    if (!hook) return null;
    const local = hookUrl(win?.location?.origin ?? '', hook.path);
    return h('div', {className: 'rt-hook'},
      h('p', {className: 'rt-hook-note', text: 'Send a POST request to this link to start a run. Anyone with the link can start one, so keep it private. Copy it now: Clowder shows it only once.'}),
      hook.remote ? linkRow('From anywhere', hookUrl(hook.remote, hook.path)) : null,
      linkRow('On this computer', local),
      hook.remote ? null : h('p', {className: 'rt-hook-note', text: 'To call it from outside this computer, turn on remote access in Devices and use the same path on that address.'}));
  }

  // The form: a template row for a new routine, then title, what to do, when, who runs it, the model, a budget and on or off.
  function field(label, control, hint) {
    return h('label', {className: 'rt-field'}, h('span', {text: label}), control, hint ? h('small', {className: 'rt-hint', text: hint}) : null);
  }
  function select(id, choices, value) {
    const node = h('select', {attrs: {id}});
    node.replaceChildren(...choices.map(c => Object.assign(doc.createElement('option'), {value: c.value, textContent: c.label})));
    node.value = value;
    return node;
  }

  function showForm(routine) {
    ui.view = 'form'; ui.editing = routine; ui.banner = null; paintBanner();
    const state = town() ?? {};
    const when = routine ? pickerOf(routine.schedule?.cron ?? null) : {...NEW_WHEN};
    const zone = routine?.schedule?.timezone ?? ui.timezone;
    const title = h('input', {attrs: {id: 'rt-title', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Daily briefing'}});
    const prompt = h('textarea', {attrs: {id: 'rt-prompt', rows: '5', maxlength: '4000', placeholder: 'What should the cat do each time?'}});
    const kind = select('rt-when-kind', WHEN.map(([value, label]) => ({value, label})), when.kind);
    const day = select('rt-when-day', WEEKDAYS.map((label, i) => ({value: String(i), label})), String(when.day));
    const time = h('input', {attrs: {id: 'rt-when-time', type: 'time', required: ''}});
    const cron = h('input', {attrs: {id: 'rt-when-cron', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '30 7 * * 1-5', 'aria-label': 'Cron pattern'}});
    const preview = h('p', {className: 'rt-preview', attrs: {'aria-live': 'polite'}});
    const cat = select('rt-cat', catChoices(state.cats, routine?.cat), routine?.cat ?? 'mayor');
    const mode = select('rt-mode', modelChoices(state.models, routine?.mode), routine?.mode ?? defaultMode(state.models, state.townDefault));
    const budget = h('input', {attrs: {id: 'rt-budget', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'No limit'}});
    const enabled = h('input', {attrs: {id: 'rt-enabled', type: 'checkbox'}});
    const error = h('p', {className: 'cx-msg bad rt-error', attrs: {role: 'status'}});
    const save = h('button', {className: 'primary', text: routine ? 'Save changes' : 'Save routine', attrs: {type: 'submit'}});
    const cancel = h('button', {text: 'Cancel', attrs: {type: 'button'}});
    title.value = routine?.title ?? ''; prompt.value = routine?.prompt ?? ''; time.value = when.time; cron.value = when.cron;
    budget.value = routine?.tokenBudget ? String(routine.tokenBudget) : ''; enabled.checked = routine ? routine.enabled === true : true;

    const dayRow = h('label', {className: 'rt-inline', attrs: {'data-for': 'weekly'}}, h('span', {text: 'on'}), day);
    const timeRow = h('label', {className: 'rt-inline', attrs: {'data-for': 'time'}}, h('span', {text: 'at'}), time);
    const cronRow = h('label', {className: 'rt-field', attrs: {'data-for': 'custom'}}, h('span', {text: 'Cron pattern'}), cron, h('small', {className: 'rt-hint', text: 'Five parts: minute, hour, day of the month, month, day of the week.'}));
    const pick = () => ({kind: kind.value, time: time.value, day: Number(day.value), cron: cron.value});
    const paintWhen = () => {
      const p = pick();
      dayRow.hidden = p.kind !== 'weekly'; timeRow.hidden = !['weekly', 'daily', 'weekdays'].includes(p.kind); cronRow.hidden = p.kind !== 'custom';
      preview.textContent = p.kind === 'none' ? 'Runs only when you tap Run now or call its webhook link.' : `${whenText(p)}${zone ? `, ${zone} time` : ''}.`;
    };
    for (const node of [kind, day, time, cron]) node.addEventListener('input', paintWhen);
    kind.addEventListener('change', paintWhen);

    const templates = routine ? null : h('div', {className: 'rt-templates', attrs: {role: 'group', 'aria-label': 'Start from a template'}},
      ...TEMPLATES.map(t => {
        const b = h('button', {className: 'rt-template', text: t.label, attrs: {type: 'button', 'aria-pressed': 'false', 'data-template': t.id}});
        b.onclick = () => {
          title.value = t.title; prompt.value = t.prompt; kind.value = t.when.kind; time.value = t.when.time; day.value = String(t.when.day);
          for (const other of b.parentNode.children) other.setAttribute('aria-pressed', String(other === b));
          paintWhen();
        };
        return b;
      }));

    const form = h('form', {className: 'rt-form', attrs: {novalidate: ''}},
      h('h3', {className: 'rt-form-title', text: routine ? `Edit “${routine.title}”` : 'New routine', attrs: {id: 'rt-form-title'}}),
      templates ? h('div', {className: 'rt-field'}, h('span', {text: 'Start from'}), templates) : null,
      field('Title', title),
      field('What the cat does', prompt, 'Up to 4,000 characters. The cat reads this each time the routine runs. Where {{briefing}} stands, each run puts what happened since the last one and everything that waits for you.'),
      h('fieldset', {className: 'rt-when-set'}, h('legend', {text: 'When it runs'}),
        h('div', {className: 'rt-when-row'}, h('label', {className: 'rt-inline'}, h('span', {className: 'sr-only', text: 'How often'}), kind), dayRow, timeRow),
        cronRow, preview),
      h('div', {className: 'rt-pair'}, field('Who runs it', cat), field('Model', mode)),
      field('Token budget', budget, 'Over all of its runs, as providers report them. It turns off when the budget is used. Blank for no limit.'),
      h('label', {className: 'rt-check'}, enabled, h('span', {text: 'On: run on its schedule'})),
      error,
      h('div', {className: 'rt-form-actions'}, cancel, save));
    cancel.onclick = () => showList();
    form.onsubmit = async e => {
      e.preventDefault();
      const draft = routineDraft({title: title.value, prompt: prompt.value, cat: cat.value, mode: mode.value, budget: budget.value, enabled: enabled.checked, when: pick(), timezone: zone});
      if (draft.error) { error.textContent = draft.error; return; }
      save.disabled = true; error.textContent = '';
      try {
        const saved = await send(routine ? `/api/routines/${enc(routine.id)}` : '/api/routines', draft.body);
        const name = saved.routine?.title ?? draft.body.title;
        ui.banner = saved.warning ? {warning: true, text: `Saved “${name}”. Warning: ${saved.warning}`} : {text: `Saved “${name}”.`};
        showList(saved.routine?.id);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    };
    paintWhen();
    listView.hidden = true; formView.hidden = false;
    formView.replaceChildren(form);
    title.focus();
  }

  function showList(focusId = ui.editing?.id) {
    ui.view = 'list'; ui.editing = null;
    formView.hidden = true; formView.replaceChildren(); listView.hidden = false;
    ui.key = ''; paintList();
    void refresh().then(() => {
      const target = focusId ? [...listView.querySelectorAll('[data-id]')].find(n => n.dataset.id === focusId) : null;
      (target?.querySelector('button') ?? listView.querySelector('.rt-new'))?.focus();
    });
  }

  listView.addEventListener('click', e => {
    const chat = e.target.closest?.('.rt-link');
    if (!chat) return;
    const id = chat.closest('[data-id]')?.dataset.id, routine = ui.routines.find(r => r.id === id);
    if (!routine) return;
    dialog.close();
    onOpenChat(routine.cat);
  });

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.key = ''; paintList();
    await refresh();
  }

  // Only an owner device gets the list; a viewer's 403 keeps the chat's Routines entries hidden.
  async function probe() {
    try { await refresh(); } catch { /* the row stays as it is */ }
    return ui.denied === false;
  }

  return {open, close: () => dialog.close(), refresh, probe, summary: () => (ui.denied === false ? rowSummary(ui.routines) : ''), dialog};
}

/**
 * Routines live in the Mayor's corner (docs/design/menu-chat-mailman.md): its chip, Options > Manage, /routines and the palette open this
 * panel. Owner devices only: ready resolves true once the routes answer, and the chat offers it from then on. Called once by app.js.
 */
export function initRoutinesPanel(options = {}) {
  const panel = createRoutinesPanel(options);
  panel.ready = panel.probe().catch(() => false);
  return panel;
}

// Usage (plan 3.10): the tokens the town used this month and last, per day, cat, model, goal and routine, and the town-wide monthly cap.
// ☰ > Usage opens this panel. It reads GET /api/usage (open to every device that can see the town) and sets the cap with the owner's
// POST /api/usage/cap {tokens} (null removes it). Counts are what providers reported: a call without a count adds nothing, so every
// total is a floor. Cost is a sum only when every call carried one; otherwise it reads Unknown, never 0. Days are the host computer's
// calendar. The pure helpers are exported for Node tests; the DOM is built with createElement and textContent only.
import {formatTokens} from './treasury-view.js';
import {registerSettingsSection} from './settings-menu.js';
import {ensureStyles, h, msgNode, ownerDialog, readJson, sendJson} from './owner-dialog.js';
import {icon} from './icons.js';

export const MODE_LABELS = {demo: 'Demonstration', local: 'Local AI', hosted: 'API key', claude: 'Claude plan', plan: 'Claude plan', chatgpt: 'ChatGPT plan', anthropic: 'Anthropic API', hermes: 'Hermes'};
export const CAP_DENIED = 'The token cap is set on the host computer or an owner device.';
const list = value => (Array.isArray(value) ? value : []);
const num = v => (Number.isFinite(v) ? v : 0);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "November 2026" for "2026-11". */
export function monthName(key, locale) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return String(key ?? '');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString(locale, {month: 'long', year: 'numeric', timeZone: 'UTC'});
}

/** Every day of the month in order, with its tokens and calls. Days after today (this month only) are marked ahead. */
export function monthDays(month, today = '') {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month?.month ?? ''));
  if (!m) return [];
  const count = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return Array.from({length: count}, (_, i) => {
    const day = `${m[1]}-${m[2]}-${String(i + 1).padStart(2, '0')}`, t = month.days?.[day];
    return {day, n: i + 1, tokens: num(t?.tokens), calls: num(t?.calls), unreported: num(t?.unreported), ahead: !!today && day > today};
  });
}

/** A breakdown as ranked rows, largest first. Past `limit` rows the rest fold into one "Other" row. share is against the largest row. */
export function ranked(record, nameOf = k => k, limit = 6) {
  const rows = Object.entries(record ?? {}).map(([key, t]) => ({key, label: nameOf(key), tokens: num(t?.tokens), calls: num(t?.calls), unreported: num(t?.unreported)}))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || (a.label < b.label ? -1 : 1));
  const shown = rows.length > limit ? rows.slice(0, limit - 1) : rows, rest = rows.slice(shown.length);
  if (rest.length) shown.push({key: '__other', label: `Other (${rest.length})`, tokens: rest.reduce((s, r) => s + r.tokens, 0), calls: rest.reduce((s, r) => s + r.calls, 0), unreported: rest.reduce((s, r) => s + r.unreported, 0)});
  const top = Math.max(0, ...shown.map(r => r.tokens));
  return shown.map(r => ({...r, share: top ? r.tokens / top : 0}));
}

/** Cost in plain words: Unknown when any call came without a price, "None" for a month with no calls. */
export function costText(month, locale) {
  if (month?.cost === null || month?.cost === undefined) return 'Unknown';
  if (!num(month?.total?.calls)) return 'None';
  return month.cost.toLocaleString(locale, {style: 'currency', currency: 'USD'});
}

/** The cap field as the POST body: "2,000,000", "2m" and "500k" all read; blank or anything else is a sentence to fix. */
export function capDraft(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/[\s,_]/g, '');
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);
  const tokens = m ? Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1)) : NaN;
  if (!Number.isSafeInteger(tokens) || tokens < 1) return {error: 'Enter a whole number of tokens, such as 2,000,000 or 2m.'};
  return {body: {tokens}};
}

/** The cap in one sentence, and how full the month is (0 to 1, or null with no cap). */
export function capLine(cap, locale) {
  const used = num(cap?.used);
  if (!cap || cap.cap === null || cap.cap === undefined) return {text: `No monthly cap. ${used.toLocaleString(locale)} tokens used so far this month.`, fill: null, tone: 'off'};
  const fill = Math.min(1, used / cap.cap);
  const base = `${used.toLocaleString(locale)} of ${cap.cap.toLocaleString(locale)} tokens used this month (${Math.floor(fill * 100)}%).`;
  if (cap.override) return {text: `${base} You let this month run past the cap.`, fill, tone: 'warn'};
  if (cap.reached) return {text: `${base} The cap is reached: new work waits for you.`, fill, tone: 'error'};
  return {text: base, fill, tone: fill >= 0.8 ? 'warn' : 'ok'};
}

/** The ☰ row's subtitle. */
export function rowSummary(data) {
  if (!data?.cap) return 'Tokens by day, cat and model';
  const used = formatTokens(num(data.cap.used));
  return data.cap.cap ? `${used} of ${formatTokens(data.cap.cap)} tokens this month` : `${used} tokens this month`;
}

/** Today's date on the host's calendar, from the timezone /api/usage names. */
export function todayIn(zone, now = Date.now()) {
  try { return new Intl.DateTimeFormat('en-CA', {timeZone: zone || undefined, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(now)); } catch { return new Date(now).toISOString().slice(0, 10); }
}

/** The Usage dialog. town() gives cat and goal names. Returns {open, close, refresh, probe, summary, dialog}. */
export function createUsagePanel({doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), town = () => null, now = () => Date.now(), locale} = {}) {
  ensureStyles(doc, 'usage-panel.css', 'usage-panel');
  // capText: what the owner typed in the cap field, so a repaint never wipes it. key: what the last paint showed.
  const ui = {data: null, loaded: false, denied: false, which: 'current', msg: null, capMsg: null, capText: null, busy: '', routines: new Map(), pick: null, key: ''};
  let townTimer = 0;
  const shell = ownerDialog({doc, id: 'usage-dialog', eyebrow: 'TOKENS', title: 'Usage', size: 'wide',
    onClose: () => { clearTimeout(townTimer); townTimer = 0; ui.msg = null; ui.capMsg = null; ui.capText = null; ui.pick = null; ui.key = ''; }});
  const {dialog, body, lede} = shell;
  win?.addEventListener?.('town-state', () => {
    if (!dialog.open || townTimer) return;
    townTimer = setTimeout(() => { townTimer = 0; void refresh(); }, 2000);
  });

  const catName = id => [...list(town()?.cats), ...list(town()?.retiredCats)].find(c => c.id === id)?.name ?? (id === 'mayor' ? 'Mayor' : id);
  const modeName = id => MODE_LABELS[id] ?? list(town()?.models).find(m => m.id === id)?.label ?? id;
  const goalName = id => list(town()?.goals).find(g => g.id === id)?.title ?? 'A goal that is no longer listed';
  const routineName = id => ui.routines.get(id) ?? 'A routine';

  async function refresh() {
    try {
      const r = await readJson(fetchImpl, '/api/usage');
      if (!r.ok) throw Object.assign(new Error(r.data.error || 'Usage could not load.'), {status: r.status});
      ui.data = r.data; ui.loaded = true; ui.denied = false; ui.msg = null;
    } catch (error) {
      ui.denied = error.status === 401 || error.status === 403;
      ui.msg = {text: error.message, bad: true};
    }
    // A live refresh repaints only when something on screen changed, so typing in the cap field is never interrupted.
    if (JSON.stringify([ui.data, ui.msg]) !== ui.key) paint();
  }
  // Routine titles come from the owner's routines route; anywhere else a routine is named as such.
  async function loadRoutines() {
    try {
      const r = await readJson(fetchImpl, '/api/routines');
      if (r.ok) ui.routines = new Map(list(r.data.routines).map(x => [x.id, x.title]));
    } catch { /* names only */ }
  }

  const btn = (text, {className = '', key, onclick, attrs = {}} = {}) => {
    const b = h('button', {className, text, attrs: {type: 'button', ...(key ? {'data-key': key} : {}), ...attrs}});
    if (key && ui.busy === key) b.disabled = true;
    if (onclick) b.onclick = onclick;
    return b;
  };
  const fact = (label, value, note) => h('div', {}, h('dt', {text: label}), h('dd', {text: value}), note ? h('small', {className: 'us-fact-note', text: note}) : null);

  function chart(month) {
    const days = monthDays(month, ui.which === 'current' ? todayIn(ui.data?.timezone, now()) : '');
    const peak = Math.max(0, ...days.map(d => d.tokens));
    const best = days.reduce((a, d) => (d.tokens > (a?.tokens ?? -1) ? d : a), null);
    let index = Math.max(0, days.findIndex(d => d.day === ui.pick));
    if (!ui.pick && best?.tokens) index = days.indexOf(best);
    const readout = h('p', {className: 'us-readout', attrs: {'aria-live': 'polite'}});
    const bars = days.map((d, i) => h('span', {className: `us-bar${d.ahead ? ' us-ahead' : ''}`, attrs: {'data-day': d.day, 'aria-hidden': 'true'}},
      h('span', {className: 'us-fill', style: {height: peak && d.tokens ? `max(2px, ${(d.tokens / peak) * 100}%)` : '0'}})));
    const plot = h('div', {className: 'us-plot', attrs: {role: 'slider', tabindex: '0', 'aria-label': `Tokens per day in ${monthName(month.month, locale)}`, 'aria-valuemin': '1', 'aria-valuemax': String(days.length)}}, ...bars);
    const show = i => {
      index = Math.min(days.length - 1, Math.max(0, i));
      const d = days[index];
      if (!d) return;
      ui.pick = d.day;
      bars.forEach((b, j) => b.classList?.toggle('us-on', j === index));
      const date = new Date(`${d.day}T12:00:00Z`).toLocaleDateString(locale, {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});
      readout.textContent = d.ahead ? `${date}: not yet` : `${date}: ${d.tokens.toLocaleString(locale)} tokens · ${plural(d.calls, 'call')}${d.unreported ? ` (${d.unreported} without a count)` : ''}`;
      plot.setAttribute('aria-valuenow', String(d.n));
      plot.setAttribute('aria-valuetext', readout.textContent);
    };
    const at = event => {
      const box = plot.getBoundingClientRect?.();
      if (!box?.width) return;
      show(Math.floor(((event.clientX - box.left) / box.width) * days.length));
    };
    plot.addEventListener('pointermove', at);
    plot.addEventListener('pointerdown', at);
    plot.addEventListener('keydown', e => {
      const step = {ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1}[e.key];
      if (step) { e.preventDefault(); show(index + step); } else if (e.key === 'Home') { e.preventDefault(); show(0); } else if (e.key === 'End') { e.preventDefault(); show(days.length - 1); }
    });
    show(index);
    const ticks = days.filter(d => d.n % 7 === 1).map(d => h('span', {className: 'us-tick', text: String(d.n), style: {left: `${((d.n - 0.5) / days.length) * 100}%`}}));
    const table = h('details', {className: 'op-more us-table-box'}, h('summary', {text: 'Show as a table'}),
      h('table', {className: 'us-table'}, h('thead', {}, h('tr', {}, h('th', {text: 'Day', attrs: {scope: 'col'}}), h('th', {text: 'Tokens', attrs: {scope: 'col'}}), h('th', {text: 'Calls', attrs: {scope: 'col'}}))),
        h('tbody', {}, days.filter(d => d.calls).map(d => h('tr', {}, h('th', {text: d.day, attrs: {scope: 'row'}}), h('td', {text: d.tokens.toLocaleString(locale)}), h('td', {text: d.calls.toLocaleString(locale)})))),
      ));
    return h('section', {className: 'cx-section us-days', attrs: {'aria-labelledby': 'us-days-title'}},
      h('h4', {text: 'Tokens per day', attrs: {id: 'us-days-title'}}),
      peak ? h('div', {className: 'us-chart'},
        h('p', {className: 'us-peak', text: `Busiest day ${formatTokens(peak)}`}),
        plot,
        h('div', {className: 'us-ticks', attrs: {'aria-hidden': 'true'}}, ...ticks),
        readout,
        h('p', {className: 'op-hint', text: 'Point at or tap a day, or use the arrow keys, to read its count.'})) : h('p', {className: 'cx-empty muted', text: 'No tokens were counted this month.'}),
      peak ? table : null);
  }

  function breakdown(id, title, record, nameOf, empty) {
    const rows = ranked(record, nameOf);
    return h('section', {className: 'cx-section us-break', attrs: {'aria-labelledby': `us-${id}`}},
      h('h4', {text: title, attrs: {id: `us-${id}`}}),
      rows.length ? h('ul', {className: 'us-rows'}, rows.map(r => h('li', {className: 'us-row'},
        h('span', {className: 'us-row-label', text: r.label}),
        h('span', {className: 'us-row-value', text: `${formatTokens(r.tokens)} · ${plural(r.calls, 'call')}`}),
        h('span', {className: 'us-track', attrs: {'aria-hidden': 'true'}}, h('span', {className: 'us-meter', style: {width: r.tokens ? `max(4px, ${r.share * 100}%)` : '0'}}))))) : h('p', {className: 'cx-empty muted', text: empty}));
  }

  function capBox(cap) {
    const line = capLine(cap, locale);
    const input = h('input', {className: 'us-cap-input', attrs: {type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'For example 2,000,000', 'aria-label': 'Monthly token cap'}});
    input.value = ui.capText ?? (cap?.cap ? cap.cap.toLocaleString(locale) : '');
    input.oninput = () => { ui.capText = input.value; };
    const form = h('form', {className: 'us-cap-form', attrs: {novalidate: '', 'data-owner': ''}},
      h('label', {className: 'op-field'}, h('span', {text: cap?.cap ? 'Change the cap' : 'Set a monthly cap'}), input,
        h('small', {text: 'Tokens for the whole town each calendar month. When it is reached, new work pauses and one decision asks you to raise it, allow it once, or wait.'})),
      h('div', {className: 'op-actions'},
        btn(ui.busy === 'cap' ? 'Saving…' : 'Save cap', {className: 'primary', key: 'cap', attrs: {type: 'submit'}}),
        cap?.cap ? btn('Remove cap', {className: 'cx-remove op-end', key: 'nocap', onclick: () => void saveCap(null)}) : null),
      msgNode(ui.capMsg, 'cap'));
    form.onsubmit = e => {
      e.preventDefault();
      const draft = capDraft(input.value);
      if (draft.error) { ui.capMsg = {text: draft.error, bad: true}; paint(); return; }
      void saveCap(draft.body.tokens);
    };
    return h('section', {className: 'cx-section us-cap', attrs: {'aria-labelledby': 'us-cap-title'}},
      h('h4', {text: 'Monthly cap', attrs: {id: 'us-cap-title'}}),
      h('p', {className: 'op-status'}, h('span', {className: 'cx-dot', attrs: {'data-tone': line.tone, 'aria-hidden': 'true'}}), h('span', {text: line.text})),
      line.fill === null ? null : h('div', {className: 'us-cap-track', attrs: {role: 'progressbar', 'aria-label': 'Share of the monthly cap used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.floor(line.fill * 100))}},
        h('span', {className: 'us-cap-fill', attrs: {'data-tone': line.tone}, style: {width: `${line.fill * 100}%`}})),
      cap?.card ? h('p', {className: 'cx-warn', text: 'A decision about the cap waits for you in Needs you.'}) : null,
      form);
  }

  async function saveCap(tokens) {
    if (ui.busy) return;
    ui.busy = tokens === null ? 'nocap' : 'cap'; ui.capMsg = null; paint();
    try {
      const r = await sendJson(fetchImpl, '/api/usage/cap', {tokens});
      if (ui.data) ui.data.cap = r.cap;
      ui.capText = null;
      ui.capMsg = {text: tokens === null ? 'The cap is off.' : `Saved. The cap is ${tokens.toLocaleString(locale)} tokens a month.`};
    } catch (error) {
      ui.capMsg = {text: error.status === 403 ? CAP_DENIED : error.message, bad: true};
    } finally {
      ui.busy = '';
    }
    paint();
    await refresh();
  }

  function paint() {
    const d = ui.data;
    ui.key = JSON.stringify([ui.data, ui.msg]);
    lede.textContent = `What the town used, as each provider reported it. A call that came back without a count adds nothing, so every total is a floor.${d?.timezone ? ` Days follow this computer’s calendar (${d.timezone}).` : ''}`;
    if (!d) { body.replaceChildren(...[ui.loaded || ui.msg ? msgNode(ui.msg) : h('p', {className: 'cx-empty muted', text: 'Loading usage…', attrs: {role: 'status'}})].filter(Boolean)); return; }
    const month = ui.which === 'previous' ? d.previous : d.current;
    const total = month?.total ?? {};
    const focusKey = doc.activeElement?.dataset?.key;
    const seg = h('div', {className: 'cx-seg op-seg us-months', attrs: {role: 'group', 'aria-label': 'Which month'}},
      btn(`This month · ${monthName(d.current?.month, locale)}`, {key: 'm:current', attrs: {'aria-pressed': String(ui.which === 'current')}, onclick: () => { ui.which = 'current'; ui.pick = null; paint(); }}),
      btn(`Last month · ${monthName(d.previous?.month, locale)}`, {key: 'm:previous', attrs: {'aria-pressed': String(ui.which === 'previous')}, onclick: () => { ui.which = 'previous'; ui.pick = null; paint(); }}));
    body.replaceChildren(...[
      seg,
      msgNode(ui.msg),
      h('dl', {className: 'op-facts us-facts'},
        fact('Tokens', num(total.tokens).toLocaleString(locale)),
        fact('Calls', num(total.calls).toLocaleString(locale)),
        fact('Cost', costText(month, locale))),
      costText(month, locale) === 'Unknown' ? h('p', {className: 'op-hint', text: 'Cost is unknown: plan and API calls come back without a price, so Clowder does not guess one.'}) : null,
      total.unreported ? h('p', {className: 'op-hint', text: `${plural(total.unreported, 'call')} came back without a token count and ${total.unreported === 1 ? 'is' : 'are'} left out of the totals.`}) : null,
      ui.which === 'current' ? capBox(d.cap) : null,
      chart(month),
      h('div', {className: 'us-breaks'},
        breakdown('cats', 'By cat', month?.cats, catName, 'No cat used tokens this month.'),
        breakdown('modes', 'By model', month?.modes, modeName, 'No model was used this month.'),
        breakdown('goals', 'By goal', month?.goals, goalName, 'No goal used tokens this month.'),
        breakdown('routines', 'By routine', month?.routines, routineName, 'No routine used tokens this month.')),
    ].filter(Boolean));
    if (focusKey) [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    paint();
    await Promise.all([refresh(), loadRoutines()]);
    paint();
  }
  async function probe() { await refresh(); return !ui.denied && !!ui.data; }
  return {open, close: () => dialog.close(), refresh, probe, summary: () => rowSummary(ui.data), dialog};
}

/** ☰ > Usage: a top-level row that opens the panel. The read is open to every device that sees the town; the cap form is the owner's. */
export function initUsagePanel(options = {}) {
  const panel = createUsagePanel(options);
  let fallback = null;
  registerSettingsSection('usage', 'Usage', container => {
    fallback = h('button', {text: 'Usage…', attrs: {type: 'button', id: 'usage-open', 'aria-haspopup': 'dialog'}});
    fallback.hidden = true;
    fallback.onclick = () => void panel.open();
    container.append(fallback);
  }, {icon: icon('cpu', {size: 18}), summary: panel.summary, action: () => void panel.open()});
  void panel.probe().then(ok => { if (fallback) fallback.hidden = !ok; });
  (options.doc ?? document).getElementById('menu-toggle')?.addEventListener('click', () => void panel.refresh());
  return panel;
}

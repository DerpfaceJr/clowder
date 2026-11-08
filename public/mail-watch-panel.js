// Email to the Mayor (plan 3.11): one Gmail label on one Google account the owner signed in. Mail under the label from the owner's own
// addresses becomes a message to the Mayor, fenced as quoted data. ☰ > Devices & AI > Email to the Mayor opens this panel. Routes
// (src/mail-inbox.ts): GET and PUT /api/mail-watch, owner only on the main app. The Google accounts are the connectors made from a
// directory entry whose client is google (GET /api/connectors). The pure helpers are exported for Node tests; textContent only.
import {ago} from './quests-panel.js';
import {devicesEntry, h, msgNode, ownerDialog, readJson, sendJson, switchControl} from './owner-dialog.js';

export const DENIED = 'The owner sets up mail.';
const list = value => (Array.isArray(value) ? value : []);

/** The Google accounts the watcher can use: connectors made from a directory entry with the google client. */
export function googleAccounts(data) {
  const google = new Set(list(data?.directory).filter(d => d.client === 'google').map(d => d.id));
  return list(data?.connectors).filter(c => c.entry && google.has(c.entry)).map(c => ({id: c.id, name: c.name, signedIn: c.auth === 'signed-in'}));
}

/** The status line. status is GET /api/mail-watch. */
export function watchLine(status, accounts = []) {
  if (status?.error) return {tone: 'error', text: status.error};
  if (!status?.enabled) return {tone: 'off', text: 'Off. Clowder reads no mail.'};
  const account = list(accounts).find(a => a.id === status.account)?.name ?? status.account;
  return {tone: 'ok', text: `On. Watching the label “${status.label}” in ${account}.`};
}

/** Counters and timing, as facts. */
export function watchFacts(status, now = Date.now()) {
  const every = Number(status?.intervalSeconds) > 0 ? Math.max(30, Number(status.intervalSeconds)) : 600;
  return [
    ['Sent to the Mayor', Number(status?.taken ?? 0).toLocaleString()],
    ['Ignored', Number(status?.ignored ?? 0).toLocaleString()],
    // lastPollAt is milliseconds since 1970 (mail-inbox.ts); ago() reads a date string.
    ['Last checked', Number(status?.lastPollAt) > 0 ? ago(new Date(Number(status.lastPollAt)).toISOString(), now) : 'Not yet'],
    ['Checks', every >= 120 ? `Every ${Math.round(every / 60)} min` : `Every ${every} s`],
  ];
}

/** The settings form as the PUT body, or the first problem. Owners: one address per line or comma; blank uses the account's own address. */
export function mailDraft({account, label, owners}) {
  if (!account) return {error: 'Pick the Google account first.'};
  const name = String(label ?? '').trim();
  if (!name) return {error: 'Type the Gmail label to watch, as Gmail shows it.'};
  if (name.length > 200) return {error: 'That label name is too long.'};
  const addresses = String(owners ?? '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  const bad = addresses.find(x => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if (bad) return {error: `“${bad}” is not an email address.`};
  if (addresses.length > 10) return {error: 'Ten addresses at most.'};
  return {body: {account, label: name, owners: addresses}};
}

/** The Email to the Mayor dialog. openClients() opens Sign-in clients; openConnectors() opens Connectors & plugins. */
export function createMailWatchPanel({doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), openClients = () => {}, openConnectors = () => {}} = {}) {
  const ui = {status: null, accounts: [], loaded: false, denied: false, msg: null, formMsg: null, busy: '', form: null};
  const {dialog, body} = ownerDialog({doc, id: 'mail-watch-dialog', eyebrow: 'EMAIL TO THE MAYOR', title: 'Email to the Mayor',
    lede: 'File or send an email under one Gmail label, and the Mayor reads it as a message from you. Only your own mail counts: mail the account sent, or mail that passed your provider’s DMARC check from one of your addresses. Everything else under the label is ignored, however its From line reads.',
    onClose: () => { ui.msg = null; ui.formMsg = null; ui.form = null; }});

  async function refresh() {
    const [s, c] = await Promise.all([readJson(fetchImpl, '/api/mail-watch'), readJson(fetchImpl, '/api/connectors')].map(p => p.catch(error => ({ok: false, status: 0, data: {error: error.message}}))));
    if (s.ok) { ui.status = s.data; ui.denied = false; } else { ui.denied = s.status === 401 || s.status === 403; ui.msg = {text: ui.denied ? DENIED : s.data.error || 'Mail settings could not load.', bad: true}; }
    if (c.ok) ui.accounts = googleAccounts(c.data);
    ui.loaded = true;
    paint();
  }

  const btn = (text, {className = '', key, onclick, attrs = {}} = {}) => {
    const b = h('button', {className, text, attrs: {type: 'button', ...(key ? {'data-key': key} : {}), ...attrs}});
    if (key && ui.busy) b.disabled = true;
    if (onclick) b.onclick = onclick;
    return b;
  };

  function paint() {
    if (!dialog.open && ui.loaded) return;
    const focusKey = doc.activeElement?.dataset?.key;
    const s = ui.status;
    if (!s) { body.replaceChildren(...[ui.loaded ? msgNode(ui.msg) : h('p', {className: 'cx-empty muted', text: 'Loading…', attrs: {role: 'status'}})].filter(Boolean)); return; }
    const line = watchLine(s, ui.accounts);
    const f = ui.form ??= {account: s.account ?? ui.accounts.find(a => a.signedIn)?.id ?? ui.accounts[0]?.id ?? '', label: s.label ?? '', owners: list(s.owners).join('\n')};
    const parts = [
      h('div', {className: 'op-row-head'},
        h('p', {className: 'op-status'}, h('span', {className: 'cx-dot', attrs: {'data-tone': line.tone, 'aria-hidden': 'true'}}), h('span', {text: line.text})),
        switchControl({label: 'Watch the label', checked: s.enabled, key: 'enabled', disabled: !!ui.busy, onChange: on => void setEnabled(on)})),
      msgNode(ui.msg, 'page'),
      h('dl', {className: 'op-facts'}, ...watchFacts(s, now()).map(([k, v]) => h('div', {}, h('dt', {text: k}), h('dd', {text: v})))),
    ];
    if (!ui.accounts.length) {
      parts.push(h('section', {className: 'cx-section'}, h('h4', {text: 'First, a Google account'}),
        h('p', {text: 'No Google account is connected yet. Set up your own Google client once, then add the account in Connectors & plugins (Google Workspace).'}),
        h('div', {className: 'op-actions'}, btn('Set up sign-in clients', {key: 'clients', onclick: () => openClients()}), btn('Open Connectors & plugins', {key: 'connectors', onclick: () => openConnectors()}))));
    } else {
      const account = h('select', {attrs: {'aria-label': 'Google account'}});
      account.replaceChildren(...ui.accounts.map(a => Object.assign(doc.createElement('option'), {value: a.id, textContent: a.signedIn ? a.name : `${a.name} (not signed in)`})));
      account.value = f.account;
      account.onchange = () => { f.account = account.value; };
      const label = h('input', {attrs: {type: 'text', maxlength: '200', autocomplete: 'off', spellcheck: 'false', placeholder: 'Clowder', 'aria-label': 'Gmail label'}});
      label.value = f.label;
      label.oninput = () => { f.label = label.value; };
      const owners = h('textarea', {attrs: {rows: '3', spellcheck: 'false', placeholder: 'you@example.com', 'aria-label': 'Your addresses'}});
      owners.value = f.owners;
      owners.oninput = () => { f.owners = owners.value; };
      const form = h('form', {className: 'op-form', attrs: {novalidate: ''}},
        h('label', {className: 'op-field'}, h('span', {text: 'Google account'}), account),
        h('label', {className: 'op-field'}, h('span', {text: 'Gmail label'}), label, h('small', {text: 'Make the label in Gmail first. Clowder checks it exists when you save. Changing it starts from now: older mail under it is not taken.'})),
        h('label', {className: 'op-field'}, h('span', {text: 'Your addresses (optional)'}), owners, h('small', {text: 'One per line. Blank means the account’s own address.'})),
        h('div', {className: 'op-actions'}, btn(ui.busy === 'save' ? 'Checking with Gmail…' : 'Save', {className: 'primary', key: 'save', attrs: {type: 'submit'}})),
        msgNode(ui.formMsg, 'form'));
      form.onsubmit = e => { e.preventDefault(); void save(); };
      parts.push(h('section', {className: 'cx-section'}, h('h4', {text: 'What to watch'}), form));
    }
    parts.push(h('p', {className: 'op-hint', text: 'The Mayor answers in Clowder. An email is never an instruction to the cats: it reaches the Mayor marked as quoted text from someone else, and only what you ask is done.'}));
    body.replaceChildren(...parts.filter(Boolean));
    if (focusKey) [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  async function write(key, patch, slot, done) {
    if (ui.busy) return;
    ui.busy = key; ui.msg = null; ui.formMsg = null; paint();
    try { ui.status = await sendJson(fetchImpl, '/api/mail-watch', patch, 'PUT'); ui[slot] = done; }
    catch (error) { ui[slot] = {text: error.status === 403 ? DENIED : error.message, bad: true}; }
    finally { ui.busy = ''; }
    paint();
  }
  const setEnabled = on => write('enabled', {enabled: on}, 'msg', {text: on ? 'On. New mail under the label goes to the Mayor from now on.' : 'Off. Clowder stops reading the label.'});
  async function save() {
    const draft = mailDraft(ui.form ?? {});
    if (draft.error) { ui.formMsg = {text: draft.error, bad: true}; paint(); return; }
    await write('save', draft.body, 'formMsg', {text: ui.status?.enabled ? 'Saved. Watching from now.' : 'Saved. Turn the switch on to start.'});
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.loaded = false; ui.form = null; paint();
    await refresh();
  }
  async function probe() { const r = await readJson(fetchImpl, '/api/mail-watch').catch(() => ({ok: false})); return r.ok; }
  return {open, close: () => dialog.close(), refresh, probe, dialog};
}

/** ☰ > Devices & AI > Email to the Mayor, shown once the owner route answers. */
export function initMailWatchPanel(options = {}) {
  const doc = options.doc ?? document, panel = createMailWatchPanel(options);
  const entry = devicesEntry(doc, {id: 'mail-watch-open', text: 'Email to the Mayor', note: 'Mail under one Gmail label goes to the Mayor', open: panel.open});
  void panel.probe().then(ok => { if (entry) entry.hidden = !ok; });
  return panel;
}

// Sign-in clients (plan D6, 3.3): the owner's own Google Cloud "Desktop app" client and Microsoft app registration, set up once, so each
// Google or Microsoft account added after is one sign-in. Post office > Sign-ins > Advanced > Sign-in clients opens this panel. Routes (src/connectors.ts,
// src/owner-clients.ts): GET /api/owner-clients and GET /api/owner-clients/setup (the steps rendered here, in order) for owners;
// PUT and DELETE /api/owner-clients/:provider on the host computer only, since a client secret is a secret. The server never sends a
// secret back, only whether one is saved. The pure helpers are exported for Node tests; the DOM is built with textContent only.
import {confirmDialog} from './dialogs.js';
import {copyBox, postOfficeEntry, h, msgNode, ownerDialog, readJson, sendJson} from './owner-dialog.js';

export const PROVIDERS = [['google', 'Google'], ['microsoft', 'Microsoft']];
export const HOST_ONLY = 'Sign-in clients are changed on the host computer.';
const nameOf = p => PROVIDERS.find(([id]) => id === p)?.[1] ?? p;
const GOOGLE_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An https link from the server's steps, or null: anything else is never a link on the page. */
export function httpsLink(value) {
  try { const url = new URL(String(value ?? '')); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}

/** A saved client in one line. saved is GET /api/owner-clients' entry: {clientId, hasSecret, tenant?, savedAt} or null. */
export function clientLine(provider, saved, locale) {
  if (!saved) return {tone: 'off', text: 'Not set up yet.'};
  const shown = String(saved.clientId ?? '');
  const when = Number(saved.savedAt) > 0 ? `, saved ${new Date(Number(saved.savedAt)).toLocaleDateString(locale, {day: 'numeric', month: 'short', year: 'numeric'})}` : '';
  if (provider === 'google') {
    return saved.hasSecret ? {tone: 'ok', text: `Ready: client ${shown}, secret saved${when}.`} : {tone: 'warn', text: `Client ${shown} is saved without its secret${when}. Save it again with the secret.`};
  }
  return {tone: 'ok', text: `Ready: client ${shown}, tenant ${saved.tenant || 'common'}${when}.`};
}

/** The form as the PUT body, or the first problem. Saving replaces the whole client, so Google's secret is asked for every time. */
export function clientDraft(provider, {clientId, clientSecret, tenant} = {}) {
  const id = String(clientId ?? '').trim(), secret = String(clientSecret ?? '').trim(), t = String(tenant ?? '').trim();
  if (!id) return {error: provider === 'google' ? 'Paste the client ID from the Google Cloud console.' : 'Paste the Application (client) ID from Microsoft Entra.'};
  if (id.length > 300) return {error: 'That client ID is too long.'};
  if (provider === 'google') {
    if (!GOOGLE_ID.test(id)) return {error: 'A Google Desktop client ID ends in .apps.googleusercontent.com.'};
    if (!secret) return {error: 'Paste the client secret too. Saving replaces the saved client, secret included.'};
    if (secret.length > 500) return {error: 'That client secret is too long.'};
    return {body: {clientId: id, clientSecret: secret}};
  }
  if (!GUID.test(id)) return {error: 'The Application (client) ID looks like 00000000-0000-0000-0000-000000000000.'};
  if (t.length > 100 || !/^[A-Za-z0-9.-]*$/.test(t)) return {error: 'A tenant is common, consumers, organizations, a domain or a directory ID.'};
  return {body: {clientId: id, ...(t ? {tenant: t} : {})}};
}

/** The Post office entry's note while the panel is closed. */
export function entrySummary(clients) {
  const ready = PROVIDERS.filter(([p]) => clients?.[p]).map(([, name]) => name);
  return ready.length ? `${ready.join(' and ')} set up` : 'Your own Google and Microsoft clients, set up once';
}

/** The Sign-in clients dialog. Returns {open, close, refresh, probe, dialog}. */
export function createOwnerClientsPanel({doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), ask = confirmDialog, locale} = {}) {
  const ui = {guide: null, denied: false, loaded: false, provider: 'google', msg: null, busy: '', form: {}};
  const {dialog, body} = ownerDialog({doc, id: 'owner-clients-dialog', eyebrow: 'GOOGLE AND MICROSOFT', title: 'Sign-in clients',
    lede: 'Clowder has no Google or Microsoft app of its own. You make one of each, once, in your own console. After that every account you add, Work or Personal, is one sign-in, and your mail never passes through anyone else’s app.',
    onClose: () => { ui.msg = null; ui.form = {}; }});

  async function refresh() {
    const r = await readJson(fetchImpl, '/api/owner-clients/setup').catch(error => ({ok: false, status: 0, data: {error: error.message}}));
    if (r.ok) { ui.guide = r.data; ui.denied = false; } else { ui.denied = r.status === 401 || r.status === 403; ui.msg = {text: r.data.error || 'Sign-in clients could not load.', bad: true}; }
    ui.loaded = true;
    paint();
  }

  const btn = (text, {className = '', key, onclick, attrs = {}} = {}) => {
    const b = h('button', {className, text, attrs: {type: 'button', ...(key ? {'data-key': key} : {}), ...attrs}});
    if (key && ui.busy) b.disabled = true;
    if (onclick) b.onclick = onclick;
    return b;
  };
  const field = (label, input, hint) => h('label', {className: 'op-field'}, h('span', {text: label}), input, hint ? h('small', {text: hint}) : null);
  // A field keeps what was typed across a repaint.
  const input = (name, attrs) => {
    const node = h('input', {attrs: {autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', ...attrs}});
    node.value = ui.form[`${ui.provider}:${name}`] ?? '';
    node.oninput = () => { ui.form[`${ui.provider}:${name}`] = node.value; };
    return node;
  };

  function paint() {
    if (!dialog.open && ui.loaded) return;
    const focusKey = doc.activeElement?.dataset?.key;
    if (!ui.guide) { body.replaceChildren(...[ui.loaded ? msgNode(ui.msg) : h('p', {className: 'cx-empty muted', text: 'Loading…', attrs: {role: 'status'}})].filter(Boolean)); return; }
    const p = ui.provider, g = ui.guide[p] ?? {}, saved = g.saved ?? null, line = clientLine(p, saved, locale);
    const seg = h('div', {className: 'cx-seg op-seg', attrs: {role: 'group', 'aria-label': 'Which provider'}},
      ...PROVIDERS.map(([id, name]) => btn(ui.guide[id]?.saved ? `${name} ✓` : name, {key: `p:${id}`, attrs: {'aria-pressed': String(p === id)}, onclick: () => { ui.provider = id; ui.msg = null; paint(); }})));
    const steps = h('ol', {className: 'op-steps'}, ...(Array.isArray(g.steps) ? g.steps : []).map(s => {
      const link = httpsLink(s.link);
      return h('li', {}, h('strong', {text: s.title}), h('p', {text: s.text}), link ? h('a', {className: 'cx-open', text: 'Open ↗', attrs: {href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open: ${s.title}`}}) : null);
    }));
    const redirect = g.registerRedirect
      ? h('div', {className: 'op-field'}, h('span', {text: 'Redirect URI to add'}), copyBox(win, 'Redirect URI to add', g.registerAs ?? g.redirectUri),
        h('small', {text: `Under “Mobile and desktop applications”. Clowder comes back to ${g.redirectUri}; Microsoft ignores the port of a localhost address.`}))
      : h('div', {className: 'op-field'}, h('span', {text: 'Where sign-ins come back'}), copyBox(win, 'Where sign-ins come back', g.redirectUri ?? ''),
        h('small', {text: 'Nothing to add in Google: a Desktop app client accepts this computer’s own address.'}));
    const id = input('clientId', {type: 'text', maxlength: '300', placeholder: p === 'google' ? '123…apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000', 'aria-label': 'Client ID'});
    const secret = p === 'google' ? input('clientSecret', {type: 'password', maxlength: '500', placeholder: saved?.hasSecret ? 'Saved. Paste it again to replace the client' : 'GOCSPX-…', 'aria-label': 'Client secret'}) : null;
    const tenant = p === 'microsoft' ? input('tenant', {type: 'text', maxlength: '100', placeholder: saved?.tenant || 'common', 'aria-label': 'Tenant'}) : null;
    const form = h('form', {className: 'op-form', attrs: {novalidate: '', 'data-owner': ''}},
      field(p === 'google' ? 'Client ID' : 'Application (client) ID', id),
      secret ? field('Client secret', secret, 'Kept on this computer only. Clowder never shows it again.') : null,
      tenant ? field('Tenant', tenant, 'Leave blank for common: work, school and personal accounts. consumers takes personal accounts only.') : null,
      h('div', {className: 'op-actions'},
        btn(ui.busy === 'save' ? 'Saving…' : saved ? `Replace ${nameOf(p)} client` : `Save ${nameOf(p)} client`, {className: 'primary', key: 'save', attrs: {type: 'submit'}}),
        saved ? btn(ui.busy === 'remove' ? 'Removing…' : 'Remove', {className: 'cx-remove op-end', key: 'remove', onclick: () => void remove(p)}) : null),
      msgNode(ui.msg, 'form'));
    form.onsubmit = e => { e.preventDefault(); void save(p); };
    const scopes = Array.isArray(g.scopes) && g.scopes.length ? h('details', {className: 'op-more'}, h('summary', {text: `What Clowder asks for (${g.scopes.length} permissions)`}), h('ul', {}, g.scopes.map(s => h('li', {text: s})))) : null;
    body.replaceChildren(...[
      seg,
      h('p', {className: 'op-status'}, h('span', {className: 'cx-dot', attrs: {'data-tone': line.tone, 'aria-hidden': 'true'}}), h('span', {text: line.text})),
      h('section', {className: 'cx-section', attrs: {'aria-label': `Set up ${nameOf(p)}`}}, h('h4', {text: saved ? 'How it was set up' : 'Set it up'}), steps),
      h('section', {className: 'cx-section'}, h('h4', {text: 'Sign-in address'}), redirect, scopes),
      h('section', {className: 'cx-section'}, h('h4', {text: saved ? `Your ${nameOf(p)} client` : `Paste your ${nameOf(p)} client`}), form),
    ].filter(Boolean));
    if (focusKey) [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  // Runs one write with its button busy, reads the guide again, then shows done (or the server's sentence) under the form.
  async function act(key, work, done) {
    if (ui.busy) return;
    ui.busy = key; ui.msg = null; paint();
    let msg = null;
    try { await work(); msg = done; } catch (error) { msg = {text: error.status === 403 ? HOST_ONLY : error.message, bad: true}; } finally { ui.busy = ''; }
    await refresh();
    ui.msg = msg; paint();
  }
  async function save(p) {
    const f = ui.form, draft = clientDraft(p, {clientId: f[`${p}:clientId`], clientSecret: f[`${p}:clientSecret`], tenant: f[`${p}:tenant`]});
    if (draft.error) { ui.msg = {text: draft.error, bad: true}; paint(); return; }
    await act('save', async () => {
      await sendJson(fetchImpl, `/api/owner-clients/${p}`, draft.body, 'PUT');
      for (const k of Object.keys(ui.form)) if (k.startsWith(`${p}:`)) delete ui.form[k];
    }, {text: `Saved. Add ${nameOf(p)} accounts in Connectors & plugins: each one is a single sign-in now.`});
  }
  async function remove(p) {
    const yes = await ask({title: `Remove your ${nameOf(p)} client?`, message: `Accounts already signed in keep working until their sign-in runs out. New ${nameOf(p)} sign-ins stop until you set a client up again.`, confirmLabel: 'Remove client', cancelLabel: 'Keep it', danger: true});
    if (!yes) return;
    await act('remove', () => sendJson(fetchImpl, `/api/owner-clients/${p}`, {}, 'DELETE'), {text: `Your ${nameOf(p)} client is removed.`});
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.loaded = false; paint();
    await refresh();
  }
  async function probe() {
    const r = await readJson(fetchImpl, '/api/owner-clients').catch(() => ({ok: false}));
    if (r.ok) ui.summary = entrySummary(r.data.clients);
    return r.ok;
  }
  return {open, close: () => dialog.close(), refresh, probe, dialog, summary: () => ui.summary};
}

/** Post office > Sign-ins > Advanced > Sign-in clients, shown once the owner route answers. */
export function initOwnerClientsPanel(options = {}) {
  const doc = options.doc ?? document, panel = createOwnerClientsPanel(options);
  const entry = postOfficeEntry(doc, {id: 'owner-clients-open', group: 'signins-advanced', text: 'Sign-in clients', note: 'Your own Google and Microsoft clients, set up once', open: panel.open});
  void panel.probe().then(ok => { if (entry) { entry.hidden = !ok; if (ok) entry.setAttribute('data-note', panel.summary()); } });
  return panel;
}

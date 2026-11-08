// Two more entries in the AI models panel (models-panel.js): the Anthropic API key (src/models.ts, anthropic.key through POST
// /api/models/settings) and Hermes (experimental), the Mayor's optional sidecar (src/hermes.ts, plan 4.9-4.13). Hermes is switched on in
// town.config.json (hermes.enabled) and read back here from GET /api/hermes/runtime, which exists only while it is on: 404 means off.
// While it is on, "Hermes (experimental)" joins the Mayor's Reasoning menu (withHermes, used by app.js); /api/chat takes mode hermes then.
// The pure helpers are exported for Node tests; the DOM is built with createElement and textContent only, with the panel's own classes.
import {savingButton} from './ai-settings.js';
import {h, readJson} from './owner-dialog.js';

export const ANTHROPIC_KEYS = 'https://console.anthropic.com/settings/keys';
export const HERMES_LABEL = 'Hermes (experimental)';
export const HERMES_HOW = 'Hermes is switched in town.config.json: set "hermes": {"enabled": true} to turn it on, or false to turn it off, then restart Clowder. The first start sets Hermes up on this computer, which takes a few minutes and needs the internet.';
const KEY_MAX = 500;

/** The Anthropic card from the status block. The server sends only the key's last four characters. */
export function anthropicCard(a) {
  const ready = a?.available === true;
  return {
    badge: ready ? 'Ready' : 'Not set', tone: ready ? 'ok' : 'off',
    hint: a?.detail ?? '',
    keyLine: a?.hasKey ? (a.keyLast4 ? `Key saved ••••${a.keyLast4}` : 'Key saved') : 'No key saved',
    removable: a?.hasKey === true,
    use: ready ? 'Listed in the chat Reasoning menu as Anthropic API.' : 'Not listed in the chat Reasoning menu until a key is saved.',
  };
}

/** The key form as the settings body, or the first problem. A blank field keeps the saved key, so it asks for a new one instead. */
export function anthropicDraft(key, saved) {
  const k = String(key ?? '').trim();
  if (!k) return {error: saved?.hasKey ? 'The key is saved. Paste a new one to replace it.' : 'Paste an Anthropic API key.'};
  if (k.length > KEY_MAX) return {error: `An API key is at most ${KEY_MAX} characters.`};
  if (/\s/.test(k)) return {error: 'An API key has no spaces. Copy it again from the Anthropic console.'};
  return {body: {anthropic: {key: k}}};
}

/** Hermes as the page can see it: off (the route is not there), on with its setup state, or not this device's to see. */
export async function readHermes(fetchImpl = (...args) => fetch(...args)) {
  try {
    const r = await readJson(fetchImpl, '/api/hermes/runtime');
    if (r.status === 404) return {on: false};
    if (r.status === 401 || r.status === 403) return {on: false, denied: true};
    if (!r.ok) return {on: true, error: r.data.error || 'Hermes did not answer.'};
    return {on: true, runtime: r.data};
  } catch (error) { return {on: false, error: error.message}; }
}
/** Whether Hermes is on, for the Reasoning menu. Anything but a clear answer reads as off. */
export const probeHermes = async (fetchImpl) => (await readHermes(fetchImpl)).on === true;

/** The Hermes card: badge, tone, one sentence, and whether Retry setup is offered. */
export function hermesCard(read) {
  if (!read?.on) return {badge: 'Off', tone: 'off', text: 'Off. The Mayor thinks with the models above, through Clowder’s own loop.', retry: false, lines: []};
  if (read.error) return {badge: 'On', tone: 'warn', text: `On, but its status did not load: ${read.error}`, retry: false, lines: []};
  const r = read.runtime ?? {}, lines = Array.isArray(r.lines) ? r.lines.slice(-4) : [];
  if (r.state === 'running') return {badge: 'Setting up', tone: 'warn', text: `Setting Hermes up: ${r.label ?? 'starting'} (step ${(Array.isArray(r.done) ? r.done.length : 0) + 1} of ${r.total ?? 3}).`, retry: false, lines};
  if (r.state === 'failed') return {badge: 'Needs you', tone: 'error', text: `Setup did not finish${r.offline ? ' because this computer is offline' : ''}: ${r.error ?? 'no reason given'}`, retry: true, lines};
  if (r.state === 'unavailable') return {badge: 'Not set up', tone: 'warn', text: 'This copy of Clowder has no Hermes runtime. Set hermes.python in town.config.json, or CAT_HERMES_PYTHON, to a Python that has Hermes.', retry: false, lines: []};
  if (r.state === 'external') return {badge: 'On', tone: 'ok', text: 'On. Hermes runs from the Python set in hermes.python or CAT_HERMES_PYTHON.', retry: false, lines: []};
  return {badge: 'On', tone: 'ok', text: 'On. Hermes is set up on this computer.', retry: false, lines: []};
}

/** The Reasoning menu's providers, plus Hermes for the Mayor while it is on. single: the one option it offers (it has no model list). */
export function withHermes(models, {enabled = false, cat = ''} = {}) {
  const list = Array.isArray(models) ? models : [];
  if (!enabled || cat !== 'mayor' || list.some(m => m.id === 'hermes')) return list;
  return [...list, {id: 'hermes', name: 'Hermes · the Mayor only', label: HERMES_LABEL, models: [], single: 'Mayor on Hermes'}];
}

const group = (title, ...children) => h('div', {className: 'model-group'}, h('h4', {className: 'model-group-title', text: title}), ...children);
const more = (...children) => h('details', {className: 'model-more'}, h('summary', {text: 'More info'}), ...children);
const role = (node, name) => { node.setAttribute('data-role', name); return node; };

/**
 * The Anthropic API card. api(path, body) is the panel's owner request; onStatus(status) repaints the panel with the answer.
 * defaults is the panel's model and effort section for anthropic; useAll its "Use for all cats" button. Returns {section, paint(status)}.
 */
export function createAnthropicSection({api, onStatus, defaults = null, useAll = null, flashMs = 1500}) {
  const key = h('input', {attrs: {name: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'sk-ant-…', maxlength: String(KEY_MAX)}});
  const error = role(h('p', {className: 'model-error', attrs: {role: 'status'}}), 'form-error');
  const remove = role(h('button', {text: 'Remove key', attrs: {type: 'button'}}), 'remove');
  const save = role(h('button', {className: 'primary', text: 'Save', attrs: {type: 'submit'}}), 'save');
  const form = h('form', {className: 'model-form', attrs: {autocomplete: 'off', novalidate: ''}},
    h('label', {}, 'Anthropic API key', key), error, h('div', {className: 'dialog-actions'}, remove, save));
  const badge = role(h('span', {className: 'model-badge'}), 'badge'), hint = h('p', {className: 'model-detail'}), keyLine = h('p', {className: 'model-key'}), use = h('p', {className: 'model-use muted'});
  const section = h('section', {className: 'model-card', attrs: {'data-card': 'anthropic', 'aria-labelledby': 'models-anthropic-title'}},
    h('div', {className: 'model-head'}, h('h3', {text: 'Anthropic API', attrs: {id: 'models-anthropic-title'}}), badge),
    group('Status & sign-in', hint, keyLine, h('a', {className: 'cx-open', text: 'Get a key ↗', attrs: {href: ANTHROPIC_KEYS, target: '_blank', rel: 'noopener noreferrer'}}), form),
    group('Use for cats', useAll, use),
    defaults,
    more(h('p', {className: 'model-note muted', text: 'Pay as you go with your own key from the Anthropic console. Clowder caches the system prompt, so repeated turns cost less. Your account may charge for use.'})));
  section.hidden = true;
  let saved = null;
  form.onsubmit = async e => {
    e.preventDefault();
    const draft = anthropicDraft(key.value, saved);
    if (draft.error) { error.textContent = draft.error; return; }
    error.textContent = '';
    await savingButton(save, api('models/settings', draft.body).then(s => { onStatus(s); key.value = ''; }), {errorNode: error, flashMs});
  };
  remove.onclick = async () => {
    error.textContent = ''; remove.disabled = true;
    try { onStatus(await api('models/settings', {anthropic: null})); key.value = ''; } catch (err) { error.textContent = err.message || String(err); } finally { remove.disabled = false; }
  };
  function paint(status) {
    saved = status?.anthropic ?? null;
    const c = anthropicCard(saved);
    badge.textContent = c.badge; badge.setAttribute('data-tone', c.tone);
    hint.textContent = c.hint; hint.hidden = !c.hint;
    keyLine.textContent = c.keyLine; remove.hidden = !c.removable; use.textContent = c.use;
    return c;
  }
  return {section, paint};
}

/** The Hermes (experimental) card. Its switch shows the state and cannot change it: town.config.json does. Returns {section, refresh()}. */
export function createHermesSection({api, fetchImpl = (...args) => fetch(...args)}) {
  const badge = role(h('span', {className: 'model-badge'}), 'badge'), text = h('p', {className: 'model-detail', attrs: {role: 'status'}});
  const lines = h('ul', {className: 'muted model-lines'}), error = h('p', {className: 'model-error', attrs: {role: 'status'}});
  const retry = h('button', {text: 'Retry setup', attrs: {type: 'button'}});
  const toggle = h('input', {attrs: {type: 'checkbox', role: 'switch', 'aria-describedby': 'models-hermes-how'}});
  toggle.disabled = true;
  const use = h('p', {className: 'model-use muted'});
  const section = h('section', {className: 'model-card', attrs: {'data-card': 'hermes', 'aria-labelledby': 'models-hermes-title'}},
    h('div', {className: 'model-head'}, h('h3', {text: HERMES_LABEL, attrs: {id: 'models-hermes-title'}}), badge),
    group('Status', text, lines, h('div', {className: 'model-actions'}, retry), error),
    group('Use for the Mayor', h('label', {className: 'model-switch'}, toggle, h('span', {className: 'switch-track', attrs: {'aria-hidden': 'true'}}), h('span', {text: HERMES_LABEL})),
      use, h('p', {className: 'model-note muted', text: HERMES_HOW, attrs: {id: 'models-hermes-how'}})),
    more(h('p', {className: 'model-note muted', text: 'Hermes Agent runs the Mayor as a separate program on this computer, with the same tools. Every tool call it makes still comes to Clowder first, so your decision cards and the journal stay the same. The other cats keep thinking with Clowder’s own loop.'})));
  section.hidden = true;
  let last = {on: false};
  async function refresh() {
    last = await readHermes(fetchImpl);
    const c = hermesCard(last);
    badge.textContent = c.badge; badge.setAttribute('data-tone', c.tone);
    text.textContent = c.text;
    lines.replaceChildren(...c.lines.map(l => h('li', {text: l}))); lines.hidden = !c.lines.length;
    retry.hidden = !c.retry;
    toggle.checked = last.on === true;
    use.textContent = last.on ? `In the Mayor’s Reasoning menu as “${HERMES_LABEL}”. The other cats do not offer it.` : 'Not in any Reasoning menu while it is off.';
    return {tone: c.tone, denied: last.denied === true, on: last.on === true};
  }
  retry.onclick = async () => {
    error.textContent = ''; retry.disabled = true;
    try { await api('hermes/runtime/retry', {}); await refresh(); } catch (err) { error.textContent = err.message || String(err); } finally { retry.disabled = false; }
  };
  return {section, refresh, get on() { return last.on === true; }};
}

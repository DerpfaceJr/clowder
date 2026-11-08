// The Images tab of the AI models dialog: one collapsed row per media provider (images and video), each with its own key storage.
// The forms are drawn from the server's field list and presets. A key is never sent back: a saved key shows only its last four characters.
// "Check settings" makes no call. "Generate test image" is the only billable action, and it asks first.

import {ensureModelsPanelStyles, presetChip} from './models-panel.js';

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  // Keys with a dash are attributes (data-*, aria-*); the rest are DOM properties.
  for (const [k, v] of Object.entries(props)) { if (k.includes('-')) node.setAttribute(k, String(v)); else node[k] = v; }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

/** The body for one Save: every filled field. A blank key is left out, so the saved key is kept. */
export function payloadFor(fields, values) {
  const out = {};
  for (const f of fields) {
    const v = typeof values[f.name] === 'string' ? values[f.name].trim() : '';
    if (f.secret && !v) continue;
    if (v) out[f.name] = v;
  }
  return out;
}

export function keyHint(provider) {
  return provider.hasKey ? `Saved key ends ${provider.keyLast4 ?? '····'}. Leave blank to keep it.` : 'No key saved.';
}

export function createMediaSettings({root, fetchImpl = (...args) => fetch(...args), ask = async () => true, notify = () => {}}) {
  let providers = [];
  const note = el('p', {className: 'media-note', role: 'status'});
  // Rows the owner opened stay open across a refresh (a save repaints every row).
  const openRows = new Set();
  ensureModelsPanelStyles();

  async function api(path, body, method = 'POST') {
    const response = await fetchImpl('/api/' + path, {method, headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: method === 'GET' ? undefined : JSON.stringify(body ?? {})});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), {status: response.status});
    return data;
  }

  function row(p) {
    const result = el('p', {className: 'media-result', role: 'status'});
    const inputs = {};
    // Textareas hold the one long field (the JSON template); every other field is a single line.
    const fieldNodes = p.fields.map(f => {
      const id = `media-${p.id}-${f.name}`;
      let input;
      if (f.choices) {
        input = el('select', {id});
        for (const c of f.choices) input.append(new Option(c, c));
        input.value = p.values[f.name] ?? f.default ?? f.choices[0];
      } else if (f.name === 'bodyTemplate') {
        input = el('textarea', {id, rows: 4, maxLength: f.max, spellcheck: false, value: p.values[f.name] ?? f.default ?? ''});
      } else {
        input = el('input', {id, type: f.secret ? 'password' : 'text', maxLength: f.max, spellcheck: false, autocomplete: 'off',
          value: f.secret ? '' : (p.values[f.name] ?? f.default ?? ''), placeholder: f.secret && p.hasKey ? `Saved key ends ${p.keyLast4 ?? '····'}` : (f.default ?? '')});
      }
      inputs[f.name] = input;
      const wide = f.url || f.name === 'bodyTemplate';
      return el('label', {className: 'media-cell' + (wide ? ' media-wide' : ''), htmlFor: id},
        el('span', {className: 'media-cell-label', textContent: f.label + (f.required && !f.secret ? ' *' : '')}), input);
    });
    const save = async () => {
      const payload = payloadFor(p.fields, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])));
      await api('settings', {media: {[p.id]: payload}});
      result.textContent = 'Saved.';
      await refresh();
    };
    const check = async () => {
      const data = await api(`media/${p.id}/test`, {});
      result.textContent = data.note ?? 'Settings look complete.';
    };
    const generate = async () => {
      const ok = await ask({title: 'Make a test image?', message: 'This makes one image with your provider, which may be billed. It is saved in the Gallery.', confirmLabel: 'Generate test image', cancelLabel: 'Not now'});
      if (!ok) return;
      result.textContent = 'Making the test image…';
      const data = await api(`media/${p.id}/test`, {generate: true});
      result.textContent = `Made a test image. It is in the Gallery (${data.artifact}).`;
    };
    const run = fn => async () => {
      result.textContent = '';
      try { await fn(); } catch (err) { result.textContent = err.message; notify(err); }
    };
    // A preset fills the fields it names. The key is still typed, so the key field takes focus.
    const applyPreset = preset => {
      for (const [name, value] of Object.entries(preset.values)) if (inputs[name]) inputs[name].value = value;
      result.textContent = '';
      inputs.key?.focus();
    };
    const presets = (p.presets ?? []).length ? el('div', {className: 'media-presets'},
      el('p', {className: 'media-muted', textContent: 'Start from a service, then paste its key.'}),
      el('div', {className: 'preset-row'}, ...p.presets.map(preset => presetChip(preset, applyPreset)))) : null;
    const form = el('form', {className: 'media-grid', autocomplete: 'off'}, ...fieldNodes);
    form.onsubmit = e => { e.preventDefault(); run(save)(); };
    const actions = el('div', {className: 'media-actions'},
      el('button', {type: 'button', className: 'primary', textContent: 'Save', onclick: run(save)}),
      el('button', {type: 'button', textContent: 'Check settings', onclick: run(check)}),
      p.kinds.includes('image') ? el('button', {type: 'button', textContent: 'Generate test image', onclick: run(generate)}) : null,
      p.configured ? el('button', {type: 'button', className: 'media-remove', textContent: 'Remove', onclick: run(async () => {
        if (!await ask({title: `Remove ${p.label}?`, message: 'Its saved key is deleted from this computer.', confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true})) return;
        await api('settings', {media: {[p.id]: null}});
        await refresh();
      })}) : null);
    const kinds = p.kinds.length ? p.kinds.map(k => (k === 'image' ? 'Images' : 'Video')).join(' · ') : '';
    const details = el('details', {className: 'media-row', 'data-provider': p.id},
      el('summary', {className: 'media-row-head'},
        el('span', {className: 'media-row-name', textContent: p.label}),
        el('span', {className: 'media-kinds', textContent: kinds}),
        el('span', {className: 'media-chip', 'data-tone': p.configured ? 'ok' : 'off', textContent: p.configured ? 'Ready' : 'Not set'}),
        el('span', {className: 'media-toggle', textContent: p.configured ? 'Edit' : 'Set up'})),
      el('div', {className: 'media-row-body'},
        p.hint ? el('p', {className: 'media-hint', textContent: p.hint}) : null,
        el('p', {className: 'media-muted', textContent: keyHint(p)}),
        presets,
        form, actions, result,
        p.note ? el('details', {className: 'media-more'}, el('summary', {textContent: 'More info'}), el('p', {className: 'media-muted', textContent: p.note})) : null));
    details.open = openRows.has(p.id);
    details.addEventListener('toggle', () => { if (details.open) openRows.add(p.id); else openRows.delete(p.id); });
    return details;
  }

  async function refresh() {
    try {
      providers = await api('models/media', undefined, 'GET');
      root.hidden = false;
      root.replaceChildren(
        el('p', {className: 'media-muted', textContent: 'Images and video for the Gallery. Keys stay on this computer and are never shown again.'}),
        note, ...providers.map(row));
    } catch (err) {
      // The owner-only route answers 403 on paired and LAN devices: the group is simply not offered there.
      if (err.status === 403) { root.hidden = true; return; }
      note.textContent = err.message;
    }
  }

  return {refresh, get providers() { return providers; }};
}

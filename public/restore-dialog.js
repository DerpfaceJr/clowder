// Restore a backup (plan 7.6): the dialog the desktop app's Clowder menu opens (window.openRestore), also reached from ☰ > Backups. The
// owner picks a backup folder or a snapshot on this computer and a point in time; the server stages it and the desktop app stops the town,
// swaps the files and starts it again (src/restore.ts). The recovery key field is on the host only, never stored or echoed here.
// Plain and structural: existing classes and :root tokens only, the look is left to the design pass. Built with createElement and
// textContent, so nothing the server says is markup.
import {confirmDialog} from './dialogs.js';
import {h, msgNode, ownerDialog, readJson, sendJson} from './owner-dialog.js';

const when = at => (at ? new Date(at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : 'unknown time');
/** A snapshot's name in words. */
export const snapshotLabel = s => s.kind === 'pre' ? `Before the update to ${s.commit}, ${when(s.at)}` : `Before a restore, ${when(s.at)}`;
/** A backup point in words; a damaged one says why it cannot be chosen. */
export const pointLabel = p => p.ok ? `Point ${p.n}, ${when(p.at)}` : `Point ${p.n}: damaged, cannot be restored (${p.error})`;

let shell = null;
export function openRestore({doc = document, win = window, fetchImpl = (...args) => fetch(...args)} = {}) {
  shell ??= ownerDialog({doc, id: 'restore-dialog', eyebrow: 'PUT A POINT IN TIME BACK', title: 'Restore a backup',
    lede: 'Clowder stops the town, moves the current files to backups/before-restore-<time>/ so this can be undone, puts the chosen point back and starts the town again.'});
  const {dialog, body} = shell;
  const ui = {info: null, source: 'backup', folder: null, key: '', points: null, n: null, id: null, msg: null, busy: false, done: false};

  async function load() {
    const r = await readJson(fetchImpl, '/api/restore').catch(() => ({ok: false, data: {}}));
    if (!r.ok) { ui.msg = {text: r.data?.error || 'Restore is available on the host computer only.', bad: true}; ui.info = null; paint(); return; }
    ui.info = r.data;
    ui.folder ??= r.data.backup.folder ?? '';
    if (!r.data.backup.folder && r.data.snapshots.length) ui.source = 'snapshot';
    ui.id ??= r.data.snapshots[0]?.id ?? null;
    paint();
  }
  async function act(fn) {
    if (ui.busy) return;
    ui.busy = true; ui.msg = null; paint();
    try { ui.msg = await fn(); } catch (error) { ui.msg = {text: error.message, bad: true}; }
    ui.busy = false; paint();
  }
  const radio = (name, value, checked, disabled, onPick) => {
    const input = h('input', {attrs: {type: 'radio', name, value}});
    input.checked = checked; input.disabled = disabled;
    input.onchange = () => { if (input.checked) onPick(); };
    return input;
  };
  const row = (input, text, hint) => h('li', {className: 'op-row'}, h('label', {className: 'op-row-head'}, h('span', {}, input, ' ', text)), hint ? h('small', {className: 'op-hint', text: hint}) : null);

  function backupPart() {
    const s = ui.info;
    const folder = h('input', {attrs: {type: 'text', spellcheck: 'false', 'aria-label': 'Backup folder', placeholder: 'D:\\Backups\\Clowder, or a folder in OneDrive'}});
    folder.value = ui.folder ?? '';
    folder.oninput = () => { ui.folder = folder.value; ui.points = null; ui.n = null; };
    const same = !!s.backup.folder && s.backup.keySaved && (ui.folder ?? '').trim().toLowerCase() === s.backup.folder.toLowerCase();
    const key = h('input', {attrs: {type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Recovery key', placeholder: same ? 'Not needed for this computer’s backup folder' : 'ABCDEF-GHIJK-LMNOP-QRST2-34567'}});
    key.value = ui.key;
    key.oninput = () => { ui.key = key.value; };
    const show = h('button', {text: 'Show points in time', attrs: {type: 'button'}});
    show.disabled = ui.busy;
    show.onclick = () => void act(async () => {
      if (!folder.value.trim()) return {text: 'Give the full path of the backup folder.', bad: true};
      const r = await sendJson(fetchImpl, '/api/restore/points', {folder: folder.value, ...(ui.key.trim() ? {recoveryKey: ui.key} : {})});
      ui.points = r.points;
      ui.n = r.points.find(p => p.ok)?.n ?? null;
      return r.points.length ? null : {text: 'That folder has no backup points yet.', bad: true};
    });
    const parts = [
      h('label', {className: 'op-field'}, h('span', {text: 'Backup folder'}), folder),
      h('label', {className: 'op-field'}, h('span', {text: 'Recovery key'}), key,
        h('small', {text: same ? 'This computer keeps the key for its own backup folder.' : 'The 26-letter key shown when backups were set up. It is typed here, on the host computer, and never saved.'})),
      h('div', {className: 'op-actions'}, show),
    ];
    if (ui.points?.length) {
      const damaged = ui.points.filter(p => !p.ok);
      parts.push(h('fieldset', {className: 'op-field'}, h('legend', {text: 'Point in time'}),
        h('ul', {className: 'op-list'}, ui.points.map(p => row(radio('restore-point', String(p.n), ui.n === p.n, !p.ok || ui.busy, () => { ui.n = p.n; }), pointLabel(p))))));
      if (damaged.length) parts.push(h('p', {className: 'op-hint', attrs: {role: 'status'}, text: `${damaged.length === 1 ? 'One point is' : `${damaged.length} points are`} damaged and cannot be restored. An older point opens instead.`}));
    }
    return parts;
  }
  function snapshotPart() {
    const list = ui.info.snapshots;
    if (!list.length) return [h('p', {className: 'op-hint', text: 'There is no snapshot on this computer yet. Clowder takes one before each update.'})];
    return [h('fieldset', {className: 'op-field'}, h('legend', {text: 'Snapshot on this computer'}),
      h('ul', {className: 'op-list'}, list.map(s => row(radio('restore-snapshot', s.id, ui.id === s.id, ui.busy, () => { ui.id = s.id; }), snapshotLabel(s),
        s.kind === 'before-restore' ? 'Undoes the restore made at this time.' : null))))];
  }

  function paint() {
    const s = ui.info;
    if (!s) { body.replaceChildren(...[msgNode(ui.msg)].filter(Boolean)); return; }
    if (ui.done) { body.replaceChildren(msgNode(ui.msg)); return; }
    const sources = h('fieldset', {className: 'op-field'}, h('legend', {text: 'Restore from'}),
      h('div', {className: 'op-actions'},
        h('label', {}, radio('restore-source', 'backup', ui.source === 'backup', ui.busy, () => { ui.source = 'backup'; ui.msg = null; paint(); }), ' A backup folder'),
        h('label', {}, radio('restore-source', 'snapshot', ui.source === 'snapshot', ui.busy, () => { ui.source = 'snapshot'; ui.msg = null; paint(); }), ' A snapshot on this computer')));
    const ready = ui.source === 'backup' ? ui.n !== null : !!ui.id;
    const go = h('button', {className: 'primary', text: 'Restore', attrs: {type: 'button'}});
    go.disabled = ui.busy || !ready || !s.desktop;
    go.onclick = () => void act(async () => {
      const what = ui.source === 'backup' ? `backup point ${ui.n}` : snapshotLabel(s.snapshots.find(x => x.id === ui.id));
      const ok = await confirmDialog({title: 'Restore this point?', danger: true, confirmLabel: 'Restore',
        message: `Clowder stops the town and replaces its files with ${what}. The current files move to backups/before-restore-<time>/ first.`}, doc);
      if (!ok) return null;
      const r = await sendJson(fetchImpl, '/api/restore', ui.source === 'backup'
        ? {source: 'backup', folder: ui.folder, n: ui.n, ...(ui.key.trim() ? {recoveryKey: ui.key} : {})}
        : {source: 'snapshot', id: ui.id});
      ui.key = ''; ui.done = true;
      const skipped = r.damaged?.length ? ` Newer point${r.damaged.length === 1 ? '' : 's'} ${r.damaged.join(', ')} ${r.damaged.length === 1 ? 'was' : 'were'} damaged and skipped.` : '';
      return {text: `Restoring ${r.label}. Clowder is restarting the town.${skipped}`};
    });
    body.replaceChildren(...[
      sources,
      ...(ui.source === 'backup' ? backupPart() : snapshotPart()),
      s.desktop ? null : h('p', {className: 'op-hint', attrs: {role: 'status'}, text: 'Restore runs in the Clowder desktop app, which can stop and restart the town. Open Clowder from the desktop app to restore.'}),
      h('div', {className: 'op-actions'}, go),
      msgNode(ui.msg),
    ].filter(Boolean));
  }

  dialog.addEventListener('close', () => { ui.key = ''; }, {once: true});
  paint();
  if (!dialog.open) dialog.showModal();
  void load();
  return dialog;
}

if (typeof window !== 'undefined') window.openRestore = () => openRestore();

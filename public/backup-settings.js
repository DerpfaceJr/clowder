// ☰ > Backups (plan 7.5): the folder encrypted backups go to, the recovery key shown once with its last group typed back, the last run and
// Back up now. The routes are on the host's own listener (src/backup.ts); anywhere else GET /api/backup fails and the section hides itself.
// Existing classes only: the look is left to the design pass. Built with createElement and textContent, so nothing the server says is markup.
import {registerSettingsSection} from './settings-menu.js';
import {copyBox, ensureStyles, h, msgNode, readJson, sendJson, switchControl} from './owner-dialog.js';
import {openRestore} from './restore-dialog.js';

const when = at => new Date(at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
/** The row's one line: not set up, running, the last failure, off, or the last good backup. It never reports a backup that did not happen. */
export function backupLine(s) {
  if (!s) return '';
  if (s.running) return 'Backing up now…';
  if (!s.folder || !s.confirmed) return 'Not set up: nothing is backed up yet';
  if (s.lastRun && !s.lastRun.ok) return `Last backup failed: ${s.lastRun.error}`;
  const good = s.lastGood ? `Last backup ${when(s.lastGood.at)}` : 'No backup yet';
  return s.enabled ? good : `Off. ${good}`;
}

let current = null;
function build(container, section, {doc = document, win = window, fetchImpl = (...args) => fetch(...args)} = {}) {
  ensureStyles(doc, 'owner-panels.css', 'owner-panels');
  const ui = {key: '', msg: null, busy: false, folder: null};
  async function refresh() {
    const r = await readJson(fetchImpl, '/api/backup').catch(() => ({ok: false}));
    if (!r.ok) { section.style.display = 'none'; return; }
    current = r.data;
    paint();
    if (current.running) setTimeout(() => void refresh(), 2000);
  }
  async function act(fn) {
    if (ui.busy) return;
    ui.busy = true; ui.msg = null; paint();
    try { ui.msg = await fn(); } catch (error) { ui.msg = {text: error.message, bad: true}; }
    ui.busy = false;
    await refresh();
  }
  function paint() {
    const s = current;
    const folder = h('input', {attrs: {type: 'text', spellcheck: 'false', 'aria-label': 'Backup folder', placeholder: 'D:\\Backups\\Clowder, or a folder in OneDrive'}});
    folder.value = ui.folder ?? s.folder ?? '';
    folder.oninput = () => { ui.folder = folder.value; };
    const save = h('button', {text: s.folder ? 'Move backups here' : 'Use this folder', attrs: {type: 'button'}});
    save.disabled = ui.busy;
    save.onclick = () => void act(async () => {
      const r = await sendJson(fetchImpl, '/api/backup/setup', {folder: folder.value});
      ui.folder = null;
      if (r.recoveryKey) { ui.key = r.recoveryKey; return null; }
      return {text: 'Saved. Backups go to this folder from now on.'};
    });
    const parts = [
      h('p', {text: backupLine(s), attrs: {role: 'status'}}),
      h('label', {className: 'op-field'}, h('span', {text: 'Backup folder'}), folder,
        h('small', {text: 'A folder that OneDrive, Google Drive or a USB stick keeps. Everything in it is encrypted: journals, settings, files and saved keys.'})),
      h('div', {className: 'op-actions'}, save),
    ];
    if (ui.key) {
      const group = h('input', {attrs: {type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Last group of the recovery key'}});
      const confirm = h('button', {text: 'Confirm and start backups', attrs: {type: 'button'}});
      confirm.disabled = ui.busy;
      confirm.onclick = () => void act(async () => {
        await sendJson(fetchImpl, '/api/backup/confirm', {lastGroup: group.value});
        ui.key = '';
        return {text: 'Confirmed. Backups are on, and the first one has started.'};
      });
      parts.push(h('section', {},
        h('h4', {text: 'Your recovery key'}),
        h('p', {text: 'Write it down and keep it away from this computer. With the backup folder it opens your town on any computer. Clowder shows it only now, and nobody can reset it.'}),
        copyBox(win, 'Recovery key', ui.key),
        h('label', {className: 'op-field'}, h('span', {text: 'Type its last group to confirm'}), group),
        h('div', {className: 'op-actions'}, confirm)));
    }
    if (s.confirmed) {
      const now = h('button', {text: 'Back up now', attrs: {type: 'button'}});
      now.disabled = ui.busy || s.running;
      now.onclick = () => void act(async () => {
        const r = await sendJson(fetchImpl, '/api/backup/run');
        return {text: `Backed up ${r.files} files${r.bytes ? `, ${r.bytes.toLocaleString()} new bytes` : ', nothing new'}.`};
      });
      parts.push(h('div', {className: 'op-actions'}, now,
        switchControl({label: 'Hourly backups', checked: s.enabled, disabled: ui.busy, text: ['Hourly off', 'Hourly on'],
          onChange: on => void act(async () => { await sendJson(fetchImpl, '/api/backup/enabled', {enabled: on}); return null; })})));
      parts.push(h('p', {className: 'op-hint', text: `${s.schedule}.`}));
    }
    const restore = h('button', {text: 'Restore a backup…', attrs: {type: 'button', 'aria-haspopup': 'dialog'}});
    restore.onclick = () => openRestore({doc, win, fetchImpl});
    parts.push(h('div', {className: 'op-actions'}, restore));
    parts.push(msgNode(ui.msg));
    container.replaceChildren(...parts.filter(Boolean));
  }
  void refresh();
}

registerSettingsSection('backup', 'Backups', (container, section) => build(container, section), {icon: '⛁', summary: () => backupLine(current)});

// Settings menu section for the Mayor's autonomy level. Owner only: the route answers 403 to viewers, paired
// devices and LAN devices, and the section hides itself when that happens.
import {registerSettingsSection} from './settings-menu.js';

const LEVELS = [
  {id: 'full', label: 'Full autonomy', text: 'The Mayor and cats decide and act, and report afterwards in chat. They ask you only for owner-only decisions.'},
  {id: 'balanced', label: 'Balanced', text: 'The Mayor asks you about meaningful plan decisions and costly or irreversible-feeling steps.'},
  {id: 'cautious', label: 'Cautious', text: 'The Mayor asks before any new project or business, before spends above a small threshold, and before recruiting a cat.'},
];

async function readLevel() {
  const response = await fetch('/api/autonomy', {cache: 'no-store'});
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && LEVELS.some(level => level.id === data.level) ? data.level : null;
}

async function saveLevel(level) {
  const response = await fetch('/api/autonomy', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'},
    body: JSON.stringify({level}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not save the Mayor autonomy setting.');
  return data.level;
}

async function build(container, section) {
  let saved = null;
  try {
    saved = await readLevel();
  } catch {
    saved = null;
  }
  if (!saved) {
    section.style.display = 'none';
    return;
  }

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const group = document.createElement('div');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', "Mayor's autonomy");

  for (const level of LEVELS) {
    const row = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mayor-autonomy';
    input.value = level.id;
    input.checked = level.id === saved;
    const title = document.createElement('strong');
    title.textContent = level.label;
    const text = document.createElement('span');
    text.textContent = ` ${level.text}`;
    label.append(input, title, text);
    row.append(label);
    group.append(row);
    input.addEventListener('change', async () => {
      status.textContent = 'Saving...';
      try {
        saved = await saveLevel(input.value);
        status.textContent = 'Saved. New seasons and new chat tasks use this level.';
      } catch (error) {
        status.textContent = error.message;
        for (const other of group.querySelectorAll('input')) other.checked = other.value === saved;
      }
    });
  }
  container.append(group, status);
}

registerSettingsSection('autonomy', "Mayor's autonomy", (container, section) => {
  void build(container, section);
}, {icon: '✦', summary: autonomySummary});

function autonomySummary() {
  const checked = document.querySelector('input[name="mayor-autonomy"]:checked');
  return LEVELS.find(level => level.id === checked?.value)?.label || '';
}

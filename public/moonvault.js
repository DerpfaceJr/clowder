// The Moonvault (docs/design/menu-chat-mailman.md): the Money pill opens Money with Usage joined into the same panel, one tab each. The
// tabs follow the ARIA tabs pattern: one tab stop, Left and Right (or Home and End) move between them and open the tab, and the panel's
// title follows the open tab. Money's contents and Usage's (usage-panel.js, drawn into the Usage tab) are unchanged.

export const VAULT_TABS = Object.freeze(['money', 'usage']);
export const VAULT_TITLES = Object.freeze({money: 'Money', usage: 'Usage'});

/** The tab a key press moves to from `at`, or null for a key the tabs leave alone. Wraps at both ends. */
export function tabStep(key, at, count = VAULT_TABS.length) {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = {ArrowRight: 1, ArrowLeft: -1}[key];
  return step ? (at + step + count) % count : null;
}

/**
 * Wires the tabs inside the Moonvault dialog. select(tab, {focus, quiet}) shows a tab; onSelect(tab) runs when the owner picks one (not
 * for a quiet select, which app.js makes while opening the dialog). Returns {select, current}.
 */
export function initMoonvault({doc = globalThis.document, onSelect = () => {}} = {}) {
  const tabs = VAULT_TABS.map(name => doc.getElementById(`vault-tab-${name}`));
  const panes = VAULT_TABS.map(name => doc.getElementById(`vault-${name}`));
  const title = doc.getElementById('treasury-title');
  let current = 'money';
  function select(name, {focus = false, quiet = false} = {}) {
    current = VAULT_TABS.includes(name) ? name : 'money';
    VAULT_TABS.forEach((tab, i) => {
      const on = tab === current;
      tabs[i]?.setAttribute('aria-selected', String(on));
      if (tabs[i]) tabs[i].tabIndex = on ? 0 : -1;
      if (panes[i]) panes[i].hidden = !on;
    });
    if (title) title.textContent = VAULT_TITLES[current];
    if (focus) tabs[VAULT_TABS.indexOf(current)]?.focus();
    if (!quiet) onSelect(current);
  }
  tabs.forEach((tab, i) => {
    tab?.addEventListener('click', () => { if (current !== VAULT_TABS[i]) select(VAULT_TABS[i]); });
    tab?.addEventListener('keydown', e => {
      const to = tabStep(e.key, i);
      if (to === null || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      select(VAULT_TABS[to], {focus: true});
    });
  });
  select('money', {quiet: true});
  return {select, current: () => current};
}

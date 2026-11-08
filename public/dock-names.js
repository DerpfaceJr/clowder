// The dock's accessible names (plan 6.5). Each dock button carries aria-label with its visible word, so a screen reader
// names it even where the label is cut short on a phone. A badge is aria-hidden and its count joins the name instead:
// "Needs you, 3", "Chat, 1 decision waiting". Pure, so the tests read it without a DOM.

/** The name for a dock button: its visible word, then the count when there is one. */
export function dockName(label, count = 0, unit = null) {
  const n = Number(count) || 0;
  if (n <= 0) return label;
  if (!unit) return `${label}, ${n}`;
  return `${label}, ${n} ${n === 1 ? unit[0] : unit[1]}`;
}

export const DECISIONS = ['decision waiting', 'decisions waiting'];

/** Sets a dock button's name from its visible .dock-label word and a count. A missing button is skipped. */
export function nameDockButton(button, count = 0, unit = null) {
  if (!button) return;
  const label = button.querySelector('.dock-label')?.textContent.trim() || button.getAttribute('aria-label') || '';
  button.setAttribute('aria-label', dockName(label, count, unit));
}

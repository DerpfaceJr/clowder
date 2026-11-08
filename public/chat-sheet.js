// The chat sheet's small-screen parts (plan 5.6, 5.8): the composer's one Options chip, the tabs' More menu, and the
// "Sign in to a brain" card shown while no model is signed in. The pure helpers come first, so the tests import them
// without a DOM; the wiring below them takes its elements as arguments.

/** The chip's visible text: "Options", or the options that are on, as "Options · Goal". */
export function optionsChipText(on) {
  return on.length ? `Options · ${on.join(', ')}` : 'Options';
}

/**
 * Which tabs fit in the bar and which go under More. tabs: [{key, width}] in bar order, width the tab's own width.
 * available: the bar's inner width. gap: the space kept between two tabs. more: the More button's width with its gap.
 * Tabs keep their order: once one does not fit, it and every tab after it go under More. The first tab always shows.
 */
export function splitTabs(tabs, available, {gap = 0, more = 0} = {}) {
  const all = tabs.map(t => t.key);
  const total = tabs.reduce((sum, t, i) => sum + t.width + (i ? gap : 0), 0);
  if (total <= available) return {shown: all, overflow: []};
  const shown = [];
  let used = more;
  for (const [i, t] of tabs.entries()) {
    const width = t.width + (i ? gap : 0);
    if (shown.length && used + width > available) break;
    shown.push(t.key);
    used += width;
  }
  return {shown, overflow: all.slice(shown.length)};
}

/** True when a real model can answer: a provider other than Demonstration lists a model (as ai-settings.js reasoningGroups does). */
export const hasBrain = models => (models ?? []).some(m => m?.id !== 'demo' && (m?.models ?? []).length > 0);

/** The "More" button's accessible name: which tab is open when it is one of the tabs under More. */
export const moreTabsName = active => (active ? `More tabs, ${active} open` : 'More tabs');

/**
 * The Options chip: the goal, reply and ask toggles sit in a small popover above the text box instead of a row that
 * appears on focus, so the composer keeps one height and the decision strip above it never moves. Each toggle is a
 * <label data-short> with a checkbox; a hidden label is not offered, and with none offered the chip hides.
 */
export function initComposerOptions({form, chip, menu, doc = globalThis.document}) {
  const setOpen = open => {
    menu.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  };
  const close = (focusChip = false) => {
    if (menu.hidden) return;
    setOpen(false);
    if (focusChip) chip.focus();
  };
  function paint() {
    const offered = [...menu.querySelectorAll(':scope > label')].filter(label => !label.hidden);
    chip.hidden = offered.length === 0;
    if (chip.hidden) setOpen(false);
    const on = offered.filter(label => label.querySelector('input')?.checked).map(label => label.dataset.short);
    chip.textContent = optionsChipText(on);
    chip.classList.toggle('is-on', on.length > 0);
  }
  chip.addEventListener('click', () => setOpen(menu.hidden));
  menu.addEventListener('change', paint);
  // Escape closes the popover first; the open sheet stays (app.js closes the sheet on an Escape that reaches the document).
  form.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); e.preventDefault(); close(true); }
  });
  form.addEventListener('submit', () => close());
  doc.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !chip.contains(e.target)) close();
  });
  setOpen(false);
  paint();
  return {paint, close};
}

/**
 * The tabs' More menu. Tabs that do not fit the bar hide there (class tab-overflow) and the menu lists them in order; a
 * menu item clicks its tab, so app.js's tab switching stays the only one. fit() measures again; it is cheap when nothing
 * changed. The bar keeps a gap of at least minGap between tabs, so they never run into each other.
 */
export function initTabsOverflow({bar, more, menu, minGap = 16, doc = globalThis.document, Observer = globalThis.ResizeObserver}) {
  const tabs = [...bar.querySelectorAll('[data-tab]')];
  let key = '';
  const label = tab => tab.textContent.trim();
  const setOpen = open => {
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };
  function paintActive() {
    const active = tabs.find(t => t.classList.contains('active'));
    const hiddenActive = active?.classList.contains('tab-overflow') ? active : null;
    more.classList.toggle('active', !!hiddenActive);
    more.setAttribute('aria-label', moreTabsName(hiddenActive ? label(hiddenActive) : null));
    for (const item of menu.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset.for === active?.dataset.tab));
  }
  function fit() {
    const live = tabs.filter(t => !t.hidden);
    const width = bar.clientWidth;
    if (!width) return;
    const next = `${width}|${live.map(t => t.dataset.tab).join()}`;
    if (next === key) { paintActive(); return; }
    key = next;
    const style = getComputedStyle(bar);
    const gap = Math.max(parseFloat(style.columnGap) || 0, minGap);
    const available = width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    bar.classList.add('tabs-measuring');
    for (const t of tabs) t.classList.remove('tab-overflow');
    more.hidden = false;
    const widths = live.map(t => ({key: t.dataset.tab, width: t.getBoundingClientRect().width}));
    const moreWidth = more.getBoundingClientRect().width + gap;
    bar.classList.remove('tabs-measuring');
    const {overflow} = splitTabs(widths, available, {gap, more: moreWidth});
    const hadFocus = doc.activeElement === more;
    more.hidden = overflow.length === 0;
    if (more.hidden) setOpen(false);
    // The sheet widened (Town memory opens wide) and More went away: focus stays on the tab that is open.
    if (more.hidden && hadFocus) tabs.find(t => t.classList.contains('active'))?.focus();
    const items = [];
    for (const t of live) {
      if (!overflow.includes(t.dataset.tab)) continue;
      t.classList.add('tab-overflow');
      const item = doc.createElement('button');
      item.type = 'button';
      item.textContent = label(t);
      item.dataset.for = t.dataset.tab;
      item.addEventListener('click', () => { setOpen(false); t.click(); more.focus(); });
      items.push(item);
    }
    menu.replaceChildren(...items);
    paintActive();
  }
  more.addEventListener('click', () => setOpen(menu.hidden));
  // A tab click (app.js switches the pane) moves the active mark, possibly onto a tab under More.
  bar.addEventListener('click', e => { if (e.target.closest?.('[data-tab]')) paintActive(); });
  bar.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); e.preventDefault(); setOpen(false); more.focus(); }
  });
  doc.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !more.contains(e.target)) setOpen(false);
  });
  if (Observer) new Observer(() => fit()).observe(bar);
  setOpen(false);
  return {fit};
}

/**
 * The first-launch card: with no model signed in, "Sign in to a brain" sits above the composer and opens the AI models
 * dialog, the existing sign-in. Only the host computer can sign in, so another owner device is told where to do it.
 */
export function paintBrainCard({card, button, text, models, readOnly, canSignIn}) {
  card.hidden = !!readOnly || hasBrain(models);
  if (card.hidden) return;
  button.hidden = !canSignIn;
  text.textContent = canSignIn
    ? 'No AI model is signed in. Replies are canned.'
    : 'No AI model is signed in, so replies are canned. Sign in to a brain under AI models on the host computer.';
}

const fitted = new WeakMap();
/**
 * The text box's height follows what is typed (one row up to max), never focus: a box that shrank on blur moved the
 * decision strip above it, so a tap on Answer right after typing missed (ux-audit F15). Cheap when the text is unchanged.
 */
export function fitComposer(box, {min = 44, max = 132} = {}) {
  // A closed sheet has no width to measure: measure again once it shows.
  if (!box || !box.clientWidth || fitted.get(box) === box.value) return;
  fitted.set(box, box.value);
  box.style.height = `${min}px`;
  box.style.height = `${Math.min(max, Math.max(min, box.scrollHeight))}px`;
  box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
}

/**
 * On a phone the whole chat sheet scrolls when it is short (the keyboard is up). The composer and the decision strip are
 * pinned to the sheet's bottom edge (chat-sheet.css, position: sticky), the strip right on top of the composer: this
 * keeps --composer-h on the sheet equal to the composer's height as the text box grows.
 */
export function pinComposer({panel, form, Observer = globalThis.ResizeObserver}) {
  const set = () => { if (form.offsetHeight) panel.style.setProperty('--composer-h', `${form.offsetHeight}px`); };
  if (Observer) new Observer(set).observe(form);
  set();
}

// Interface sounds that need no change in any screen's code. Delegated listeners and one MutationObserver watch the page:
// toggles (checkboxes, radios, role=switch), sheets and dialogs opening and closing, and a quest marked done. Taps, tabs and
// cat choices are handled by attachUiSounds in audio.js.
//
// Sounds an outcome (send, success, error) cannot be guessed from the page, so the code that knows calls uiSound('send'),
// uiSound('success') or uiSound('error') itself. uiSound is safe to call before sound starts or with sound off: it does nothing.

let current = null;

/** Plays one interface cue by name (see CUES in audio.js). Returns whether it sounded. */
export const uiSound = kind => (current ? current.play(kind) : false);

/** What a sheet or dialog is: the things whose opening and closing sound. */
export const SHEET_SELECTOR = 'dialog, aside.panel, .town-menu, [role=dialog]';
export const QUEST_DONE_SELECTOR = '.quest-primary';

/** The cue for one watched attribute change, or null. `was` and `is` say whether the element was and is open or on. */
export function sheetCue(element, attribute, oldValue) {
  if (!element?.matches?.(SHEET_SELECTOR)) return null;
  if (attribute === 'open') return (oldValue !== null) === element.hasAttribute('open') ? null : element.hasAttribute('open') ? 'open' : 'close';
  if (attribute === 'hidden') return (oldValue === null) === !element.hasAttribute('hidden') ? null : element.hasAttribute('hidden') ? 'close' : 'open';
  return null;
}

/**
 * Starts the watchers. Returns {dispose}. A batch of changes sounds once: if anything opened, the open cue, else the close cue,
 * so opening one sheet while another closes is one sound, not two.
 */
export function installUiSounds({win = null, doc = null, audio, MutationObserverClass = win?.MutationObserver} = {}) {
  current = audio;
  const onChange = event => {
    const el = event.target;
    if (!el?.matches?.('input[type=checkbox], input[type=radio]')) return;
    if (el.type === 'radio' && !el.checked) return;
    audio.play(el.checked ? 'toggleOn' : 'toggleOff');
  };
  const onClick = event => {
    const button = event.target?.closest?.(QUEST_DONE_SELECTOR);
    if (button && /mark done/i.test(button.textContent || '')) audio.play('quest');
  };
  doc?.addEventListener('change', onChange, true);
  doc?.addEventListener('click', onClick, true);

  let observer = null;
  if (MutationObserverClass && doc?.documentElement) {
    observer = new MutationObserverClass(records => {
      const cues = new Set();
      for (const record of records) {
        const el = record.target;
        if (record.attributeName === 'aria-checked' && el.matches?.('[role=switch]')) {
          cues.add((el.getAttribute('aria-checked') === 'true') === (record.oldValue === 'true') ? null : el.getAttribute('aria-checked') === 'true' ? 'toggleOn' : 'toggleOff');
        } else cues.add(sheetCue(el, record.attributeName, record.oldValue));
      }
      cues.delete(null);
      const cue = cues.has('open') ? 'open' : cues.has('close') ? 'close' : [...cues][0];
      if (cue) audio.play(cue);
    });
    observer.observe(doc.documentElement, {subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['open', 'hidden', 'aria-checked']});
  }

  return {
    dispose() {
      if (current === audio) current = null;
      doc?.removeEventListener?.('change', onChange, true);
      doc?.removeEventListener?.('click', onClick, true);
      observer?.disconnect();
    },
  };
}

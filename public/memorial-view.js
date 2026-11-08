// The Memorial as a full-screen layer. A modal <dialog> makes the layer: showModal puts it over the header and dock, makes the
// rest of the page inert (the focus trap) and handles Escape. Its close event does the teardown. Every open and close also
// dispatches 'memorial-view' on the window: audio.js crossfades its music on `open`, town.js pauses its render loop
// while `open && pause`. memorial-transition.js announces {open:true, pause:false} as the camera starts its zoom and
// pauses the town only once the sky has covered it.
export const MEMORIAL_EVENT = 'memorial-view';
// The Town Archive (archive-view.js) is the same kind of layer on its own event, so it pauses the town without the Memorial's music.
export const ARCHIVE_EVENT = 'archive-view';
// The pause last announced per event. The 3D scene is imported late, so a pause created after an open must start paused too.
const announced = {};

/** True while the Memorial or the Archive covers the town, so the 3D loop skips its frames. One flag per layer. */
export function createTownPause(target = globalThis) {
  const paused = {...announced};
  for (const name of [MEMORIAL_EVENT, ARCHIVE_EVENT]) target.addEventListener(name, event => { paused[name] = event.detail?.open === true && event.detail?.pause !== false; });
  return {get paused() { return Object.values(paused).some(Boolean); }};
}

/**
 * Opens and closes the dialog. Focus goes to the close button on open and back to whatever opened the view on close
 * (the dock button when the view was opened from the observatory, where nothing had focus). 'focus-memorial' (Show
 * observatory) closes the view too, so the camera glide that town.js starts is not hidden behind it.
 * intercept(fn) hands the close button, Escape and Show observatory to fn(reason) instead ('button', 'escape',
 * 'observatory'), so a transition can animate the close. show() and announce() are its lower-level steps.
 * closeId, eventName and focusEvent default to the Memorial's; the Archive passes its own (focusEvent null: no observatory).
 */
export function createMemorialView({dialog, dock = null, doc = globalThis.document, win = globalThis, closeId = 'memorial-close', eventName = MEMORIAL_EVENT, focusEvent = 'focus-memorial'}) {
  let returnTo = null, said = 'false:false', requestClose = null;
  const announce = (open, pause = open) => {
    const key = `${open}:${pause}`;
    if (key === said) return;
    said = key;
    announced[eventName] = open && pause;
    win.dispatchEvent(new CustomEvent(eventName, {detail: {open, pause}}));
  };
  const show = () => {
    if (dialog.open) return;
    const active = doc?.activeElement;
    returnTo = active && active !== doc?.body ? active : dock;
    dialog.showModal();
    dialog.querySelector(`#${closeId}`)?.focus?.();
  };
  const open = () => {
    if (dialog.open) return;
    show();
    announce(true);
  };
  const close = () => { if (dialog.open) dialog.close(); };
  const ask = reason => (requestClose ? requestClose(reason) : close());
  // The exit is the back-pill: "← Town" on screen, still named "Return to town" for screen readers.
  const closeButton = dialog.querySelector(`#${closeId}`);
  if (closeButton) { closeButton.classList?.add('back-pill'); closeButton.textContent = '← Town'; closeButton.ariaLabel = 'Return to town'; }
  closeButton?.addEventListener('click', () => ask('button'));
  if (focusEvent) win.addEventListener?.(focusEvent, () => ask('observatory'));
  dialog.addEventListener('cancel', event => {
    if (!requestClose) return;
    event.preventDefault();
    requestClose('escape');
  });
  dialog.addEventListener('close', () => {
    announce(false);
    const target = returnTo?.isConnected ? returnTo : dock;
    returnTo = null;
    target?.focus?.();
  });
  return {
    open, close, show, announce, dialog,
    intercept(fn) { requestClose = typeof fn === 'function' ? fn : null; },
    get isOpen() { return dialog.open === true; },
  };
}

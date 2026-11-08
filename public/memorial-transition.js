// The Memorial zoom: a small state machine around memorial-view.js.
//   idle -> flying -> revealed -> closing -> idle
// flying:   the camera glides to the observatory (FLIGHT ms) while the light tints to night and the page chrome fades;
//           then the sky opens from the telescope's lens outward (REVEAL ms). The town pauses only when that ends.
// closing:  the sky fades (FADE ms), the town resumes on the zoomed view, the camera eases back (RETURN ms), the light
//           returns to the chosen time and the chrome fades back in.
// Reduced motion, or no 3D scene or observatory yet: no flight, the sky just crossfades (QUICK ms) each way.
// While flying or closing, open and close requests are ignored; Escape jumps to the end state.
export const FLIGHT = 1100, REVEAL = 500, FADE = 350, RETURN = 1100, QUICK = 250;
// After an Escape skip the town draws a few more frames (at least SETTLE_FRAMES_MS and two animation frames) under the sky before it pauses, so the canvas left behind
// (seen as the sky fades on close) shows the landed camera, not the pose it had when Escape was pressed.
export const SETTLE_FRAMES_MS = 120;
const LOOKS = ['zoom-reveal', 'zoom-fade', 'zoom-leave'];

/**
 * view: createMemorialView's result. stage(): the 3D scene or null (flyTo, cameraView, tint, memorialShot, memorialScreen).
 * audio(): the sound controller or null (zoomIn, zoomOut). The clock is injectable for tests.
 * shotOf, screenOf and tone pick the place and the light: the observatory at night by default; the Archive flies to the
 * notice board (archiveShot, archiveScreen) with no tint. open(true) is the quick crossfade with no flight.
 */
export function createMemorialTransition({view, stage = () => null, audio = () => null, win = globalThis, doc = globalThis.document,
  shotOf = scene => scene?.memorialShot?.(), screenOf = scene => scene?.memorialScreen?.(), tone = 'night',
  reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = t => clearTimeout(t)}) {
  let state = 'idle', cinematic = false, shot = null, home = null, stay = false, timers = [];
  const later = (ms, fn) => { timers.push(schedule(fn, ms)); };
  const frames = (n, fn) => (n > 0 && win.requestAnimationFrame ? win.requestAnimationFrame(() => frames(n - 1, fn)) : fn());
  const clear = () => { for (const t of timers) cancel(t); timers = []; };
  const body = doc?.body;
  const chrome = mode => { // 'hidden' while zoomed, 'back' while it fades in again, null when settled
    body?.classList?.toggle('memorial-zooming', mode === 'hidden');
    body?.classList?.toggle('memorial-unzooming', mode === 'back');
  };
  const look = (name, origin) => {
    const dialog = view.dialog;
    for (const n of LOOKS) dialog?.classList?.toggle(n, n === name);
    if (origin) { dialog?.style?.setProperty('--mx', `${Math.round(origin.x)}px`); dialog?.style?.setProperty('--my', `${Math.round(origin.y)}px`); }
  };

  function open(quick = false) {
    if (state !== 'idle') return false;
    const scene = stage();
    shot = quick === true || reduced() ? null : shotOf(scene) || null;
    cinematic = !!(shot && scene.flyTo);
    state = 'flying';
    stay = false;
    view.announce(true, false); // the music starts crossing over with the camera; the town keeps rendering
    if (!cinematic) { reveal(); return true; }
    home = scene.cameraView();
    chrome('hidden');
    if (tone) scene.tint?.(tone, FLIGHT / 1000);
    audio()?.zoomIn?.(FLIGHT / 1000);
    scene.flyTo({...shot, duration: FLIGHT});
    later(FLIGHT, reveal);
    return true;
  }
  function reveal() {
    look(cinematic ? 'zoom-reveal' : 'zoom-fade', cinematic ? screenOf(stage()) : null);
    view.show();
    later(cinematic ? REVEAL : QUICK, settle);
  }
  function settle(pauseAfter = 0) {
    clear();
    look(null);
    state = 'revealed';
    // the sky covers the town now: pause its render loop
    if (pauseAfter > 0) later(pauseAfter, () => frames(2, () => { if (state === 'revealed') view.announce(true, true); }));
    else view.announce(true, true);
  }

  function close(reason) {
    if (state === 'flying' || state === 'closing') { if (reason === 'escape') skip(); return false; }
    if (state !== 'revealed') return false;
    clear();
    state = 'closing';
    stay = reason === 'observatory'; // Show observatory: town.js glides there itself, so no fly back
    look('zoom-leave');
    later(cinematic ? FADE : QUICK, back);
    return true;
  }
  function back() {
    view.announce(false); // the town resumes on the zoomed view before the dialog goes
    view.close();
    look(null);
    if (!cinematic) { done(); return; }
    const scene = stage();
    chrome('back');
    if (tone) scene?.tint?.(null, RETURN / 1000);
    if (!stay) { audio()?.zoomOut?.(RETURN / 1000); scene?.flyTo?.({...home, duration: RETURN}); }
    later(RETURN, done);
  }
  function done() {
    clear();
    chrome(null);
    state = 'idle';
  }

  /** Escape mid-transition: land in the end state with no animation left running. */
  function skip() {
    clear();
    const scene = cinematic ? stage() : null;
    if (state === 'flying') {
      if (scene) { scene.flyTo?.({...shot, duration: 0}); if (tone) scene.tint?.(tone, 0); }
      look(null);
      view.show();
      settle(scene ? SETTLE_FRAMES_MS : 0);
    } else if (state === 'closing') {
      view.announce(false);
      view.close();
      look(null);
      if (scene) { if (!stay) scene.flyTo?.({...home, duration: 0}); if (tone) scene.tint?.(null, 0); }
      done();
    }
  }

  view.intercept?.(close);
  // A close that bypassed us (the browser can force-close a modal after repeated Escapes): finish cleanly, no animation.
  view.dialog?.addEventListener?.('close', () => { if (state === 'revealed' || state === 'flying') { state = 'closing'; skip(); } });
  // During the flight the dialog is not up yet, so Escape is caught on the window. preventDefault stops a modal dialog's
  // own cancel from also firing for the same key press.
  win.addEventListener?.('keydown', event => {
    if (event.key !== 'Escape' || (state !== 'flying' && state !== 'closing')) return;
    event.preventDefault();
    event.stopPropagation?.();
    skip();
  }, true);

  return {open, close, skip, get state() { return state; }};
}

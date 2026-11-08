import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMemorialView, createTownPause, MEMORIAL_EVENT} from '../public/memorial-view.js';
import {skyMotion} from '../public/memorial.js';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

// A stand-in for <dialog> and the page: showModal and close behave as the platform does (close fires the close event).
function fakeDialog(closeButton) {
  const listeners = {close: []};
  return {
    open: false, closeCalls: 0,
    showModal() { this.open = true; },
    close() { if (!this.open) return; this.open = false; this.closeCalls++; for (const fn of listeners.close) fn(); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector: sel => (sel === '#memorial-close' ? closeButton : null),
  };
}
function fakeElement(name) {
  const listeners = {};
  return {
    name, focused: 0, isConnected: true,
    focus() { this.focused++; doc.activeElement = this; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    click() { for (const fn of listeners.click || []) fn(); },
  };
}
function setup() {
  const body = fakeElement('body');
  globalThis.doc = {activeElement: body, body};
  const closeButton = fakeElement('close');
  const dialog = fakeDialog(closeButton);
  const dock = fakeElement('dock');
  const win = new EventTarget();
  const seen = [];
  win.addEventListener(MEMORIAL_EVENT, e => seen.push(e.detail.open));
  const view = createMemorialView({dialog, dock, doc: globalThis.doc, win});
  return {dialog, view, win, seen, closeButton, dock, doc: globalThis.doc};
}

test('opening and closing toggles the overlay and tells the town and the music', () => {
  const {dialog, view, seen} = setup();
  assert.equal(view.isOpen, false);
  view.open();
  assert.equal(dialog.open, true);
  assert.equal(view.isOpen, true);
  assert.deepEqual(seen, [true]);
  view.open();
  assert.deepEqual(seen, [true], 'opening twice announces once');
  view.close();
  assert.equal(dialog.open, false);
  assert.deepEqual(seen, [true, false]);
  view.close();
  assert.equal(dialog.closeCalls, 1, 'closing a closed view does nothing');
});

test('the Return to town button closes the view, as Escape does through the platform close', () => {
  const {dialog, view, closeButton, seen} = setup();
  view.open();
  closeButton.click();
  assert.equal(dialog.open, false);
  view.open();
  dialog.close();
  assert.deepEqual(seen, [true, false, true, false], 'the platform close path also announces');
});

test('focus moves to the close button on open and goes back to what opened the view on close', () => {
  const {view, closeButton, doc} = setup();
  const menu = fakeElement('menu-toggle');
  doc.activeElement = menu;
  view.open();
  assert.equal(closeButton.focused, 1, 'the close button takes focus');
  assert.equal(doc.activeElement, closeButton);
  view.close();
  assert.equal(menu.focused, 1, 'focus returns to the element that opened the view');
});

test('with nothing focused (the observatory tap), focus returns to the dock button', () => {
  const {view, dock, doc} = setup();
  doc.activeElement = doc.body;
  view.open();
  view.close();
  assert.equal(dock.focused, 1);
});

test('a removed opener falls back to the dock button', () => {
  const {view, dock, doc} = setup();
  const menu = fakeElement('menu-toggle');
  doc.activeElement = menu;
  view.open();
  menu.isConnected = false;
  view.close();
  assert.equal(dock.focused, 1);
  assert.equal(menu.focused, 0);
});

test('Show observatory closes the view so the camera glide shows', () => {
  const {dialog, view, win, seen} = setup();
  view.open();
  win.dispatchEvent(new Event('focus-memorial'));
  assert.equal(dialog.open, false);
  assert.equal(view.isOpen, false);
  assert.deepEqual(seen, [true, false]);
});

test('the town pause flag follows the view: paused while open, running again on close', () => {
  const target = new EventTarget();
  const pause = createTownPause(target);
  assert.equal(pause.paused, false);
  target.dispatchEvent(new CustomEvent(MEMORIAL_EVENT, {detail: {open: true}}));
  assert.equal(pause.paused, true);
  target.dispatchEvent(new CustomEvent(MEMORIAL_EVENT, {detail: {open: false}}));
  assert.equal(pause.paused, false);
  target.dispatchEvent(new CustomEvent(MEMORIAL_EVENT));
  assert.equal(pause.paused, false, 'a malformed event does not pause the town');
});

test('a pause created after the view opened (the 3D scene loads late) starts paused, and clears on close', () => {
  const {view} = setup();
  view.open();
  const late = createTownPause(new EventTarget());
  assert.equal(late.paused, true, 'it missed the open event but still knows the view is up');
  view.close();
  assert.equal(createTownPause(new EventTarget()).paused, false);
});

test('reduced motion turns off drift and shooting stars; full motion keeps them', () => {
  assert.deepEqual(skyMotion(true), {drift: 0, shooting: false});
  assert.deepEqual(skyMotion(false), {drift: 1, shooting: true});
  assert.deepEqual(skyMotion(), skyMotion(false));
});

test('the layer is a full-screen dialog with safe-area chrome, a short crossfade and the zoom reveal', () => {
  const css = read('memorial-sky.css');
  assert.match(css, /\.memorial-view\{position:fixed;inset:0;width:100vw;height:100dvh/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@keyframes memorial-in\{from\{opacity:0\}to\{opacity:1\}\}/);
  assert.match(css, /\.memorial-view\.zoom-fade\{animation:memorial-in \.25s/, 'reduced motion and no-scene opens crossfade briefly');
  assert.match(css, /\.memorial-view\.zoom-reveal\{[^}]*mask-image:radial-gradient\(circle at var\(--mx,50%\) var\(--my,50%\)/, 'the reveal opens from the telescope');
  assert.match(css, /:is\(\.zoom-reveal,\.zoom-fade,\.zoom-leave\)::backdrop\{background:transparent;backdrop-filter:none\}/, 'the town shows through while it runs');
  const chips = css.match(/\.sky-chip\{[^}]*\}/)[0], close = css.match(/\.memorial-close\{[^}]*\}/)[0];
  assert.match(chips, /min-height:44px/);
  assert.match(close, /min-height:44px/);
});

test('the markup has the Memorial dialog with its chrome, outside the town layout and off the dock data hook', () => {
  const html = read('index.html');
  const dialog = html.slice(html.indexOf('<dialog id="memorial-panel"'), html.indexOf('</dialog>', html.indexOf('<dialog id="memorial-panel"')));
  assert.ok(dialog.includes('class="memorial-view"'));
  assert.ok(dialog.includes('id="memorial-close"') && dialog.includes('aria-label="Return to town">← Town<'), 'close is labelled');
  assert.ok(dialog.includes('>Memorial<'), 'the small title');
  assert.ok(dialog.includes('id="memorial-body"'), 'the body app.js renders into is kept');
  assert.ok(!html.includes('class="memorial panel"'), 'the old side panel is gone');
  assert.ok(!html.includes('data-toggle-panel="memorial"'), 'the dock opens the view directly');
  assert.ok(html.includes('aria-controls="memorial-panel"'), 'the dock still names the dialog');
  assert.ok(html.includes('id="menu-memorial-open"'), 'the ☰ menu opens it too');
  assert.ok(html.indexOf('<dialog id="memorial-panel"') > html.indexOf('</main>'), 'it sits outside main, so the rest of the page can go inert');
  assert.ok(html.includes('href="/memorial-sky.css" data-memorial-sky'));
});

test('app.js keeps the Memorial out of the sheet panels and wires the dock, the menu and the observatory', () => {
  const app = read('app.js');
  assert.ok(!/const panels=\[[^\]]*'memorial'/.test(app), 'memorial is not a sheet panel');
  assert.ok(app.includes("if(e.detail==='memorial')memorialZoom.open()"), 'the observatory tap opens it through the zoom');
  assert.ok(app.includes("$('toggle-memorial').onclick=()=>memorialZoom.open()"));
  assert.ok(app.includes("memorialZoom.open();};"), 'the menu entry zooms too');
  assert.ok(app.includes("$('menu-memorial-open').onclick"));
  assert.match(read('town.js'), /document\.hidden\|\|memorialPause\.paused\|\|!viewW/, 'the render loop skips frames while the Memorial is open');
});

// A small stand-in for the browser DOM, enough to drive the command palette (public/command-palette.js) by keyboard in Node: events
// that capture from the window down and bubble back up, focus, <dialog> showModal and close, and compound selectors
// ("dialog[open]", "button.primary", '[role="option"]') with the descendant combinator. getComputedStyle mirrors the two rules of
// style.css that hide controls on other devices (.viewer [data-owner], .remote [data-host]) and the hidden attribute.
// Compare these nodes by id in assertions, never as objects: a failed strict assertion on two of them diffs the whole page.
export class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, {bubbles: false, cancelable: true, ...init, type});
    this.defaultPrevented = false; this.stopped = false; this.stoppedNow = false; this.target = null; this.currentTarget = null;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.stoppedNow = true; }
}

class Target {
  constructor() { this.listeners = []; }
  addEventListener(type, fn, options) { this.listeners.push({type, fn, capture: options === true || !!options?.capture}); }
  removeEventListener(type, fn, options) { const capture = options === true || !!options?.capture; this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture)); }
  // phase: 'capture' runs capturing listeners, 'bubble' the others, 'target' all of them in the order they were added.
  fire(event, phase) {
    for (const l of [...this.listeners]) {
      if (l.type !== event.type || (phase === 'capture' && !l.capture) || (phase === 'bubble' && l.capture)) continue;
      event.currentTarget = this;
      l.fn.call(this, event);
      if (event.stoppedNow) return;
    }
    if (phase !== 'capture' && event.type === 'click' && typeof this.onclick === 'function') this.onclick(event);
  }
}

class FakeText {
  constructor(text) { this.nodeType = 3; this.text = String(text); this.parentNode = null; }
  get textContent() { return this.text; }
}

// One compound selector: tag, #id, .class and [attr] / [attr="value"] parts.
function compound(text) {
  const parts = {tag: null, id: null, classes: [], attrs: []};
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m, at = 0;
  while ((m = re.exec(text))) {
    if (m.index !== at) throw new Error(`unsupported selector ${text}`);
    at = re.lastIndex;
    if (m[1]) parts.tag = m[1].toUpperCase();
    else if (m[2]) parts.id = m[2];
    else if (m[3]) parts.classes.push(m[3]);
    else parts.attrs.push([m[4], m[5] ?? m[6] ?? m[7]]);
  }
  if (at !== text.length) throw new Error(`unsupported selector ${text}`);
  return parts;
}
const fits = (el, p) => (!p.tag || el.tagName === p.tag) && (!p.id || el.id === p.id) && p.classes.every(c => el.classList.contains(c)) &&
  p.attrs.every(([k, v]) => el.hasAttribute(k) && (v === undefined || el.getAttribute(k) === v));

export class FakeElement extends Target {
  constructor(doc, tag) {
    super();
    const props = {};
    Object.assign(this, {ownerDocument: doc, tagName: tag.toUpperCase(), attrs: new Map(), children: [], parentNode: null, value: '', checked: false, disabled: false, scrolled: 0,
      style: {props, setProperty(k, v) { props[k] = String(v); }}});
  }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(on) { if (on) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get open() { return this.attrs.has('open'); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: c => list().includes(c),
      add: (...c) => { this.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { this.className = list().filter(x => !c.includes(x)).join(' '); },
      toggle: (c, on = !list().includes(c)) => { if (on) this.classList.add(c); else this.classList.remove(c); return on; },
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(String(v) ? [String(v)] : [])); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument; }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n;
      if (node.parentNode?.children) node.parentNode.children = node.parentNode.children.filter(c => c !== node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...nodes); }
  get elements() { return this.children.filter(c => c instanceof FakeElement); }
  matches(selector) {
    const chain = selector.trim().split(/\s+/).map(compound);
    if (!fits(this, chain.at(-1))) return false;
    let node = this.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (node instanceof FakeElement && !fits(node, chain[i])) node = node.parentNode;
      if (!(node instanceof FakeElement)) return false;
      node = node.parentNode;
    }
    return true;
  }
  closest(selector) { for (let node = this; node instanceof FakeElement; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
  querySelectorAll(selector) { return this.elements.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  dispatchEvent(event) { return dispatch(this, event); }
  click() { dispatch(this, new FakeEvent('click', {bubbles: true})); }
  focus() { if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollIntoView() { this.scrolled++; }
  showModal() { if (this.open) throw new Error('InvalidStateError: already open'); this.attrs.set('open', ''); }
  // As in a browser, focus left inside a dialog that closes falls back to the body. The close event is synchronous here (a browser
  // queues it), which is the harder case for the code under test.
  close() {
    if (!this.open) return;
    this.attrs.delete('open');
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    dispatch(this, new FakeEvent('close'));
  }
  // A failed assertion prints this, not the whole page.
  toString() { return `<${this.tagName.toLowerCase()}${this.id ? `#${this.id}` : ''}>`; }
}

// Capture from the window down to the target's parent, then the target, then bubble back up when the event bubbles.
function dispatch(target, event) {
  const doc = target.ownerDocument, win = doc.defaultView;
  event.target = target;
  const path = [];
  for (let node = target.parentNode; node; node = node.parentNode) path.push(node);
  const down = [win, ...path.reverse()];
  for (const node of down) { node.fire(event, 'capture'); if (event.stopped) return !event.defaultPrevented; }
  target.fire(event, 'target');
  if (event.bubbles && !event.stopped) for (const node of [...down].reverse()) { node.fire(event, 'bubble'); if (event.stopped) break; }
  return !event.defaultPrevented;
}

export class FakeDocument extends Target {
  constructor() {
    super();
    this.body = new FakeElement(this, 'body');
    this.body.parentNode = this;
    this.activeElement = this.body;
    this.defaultView = null;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(_ns, tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(text); }
  getElementById(id) { const find = node => node.id === id ? node : node.elements.map(find).find(Boolean) ?? null; return find(this.body); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  querySelector(selector) { return this.body.querySelector(selector); }
}

export class FakeWindow extends Target {
  constructor(doc, {coarse = false} = {}) {
    super();
    doc.defaultView = this;
    const calls = [];
    Object.assign(this, {document: doc, coarse, Event: FakeEvent, HashChangeEvent: FakeEvent, history: {calls, replaceState: (...args) => calls.push(args)}});
  }
  matchMedia(query) { return {matches: /coarse/.test(query) ? this.coarse : false}; }
  getComputedStyle(el) {
    const body = this.document.body.classList;
    const none = el.hidden || (body.contains('viewer') && el.hasAttribute('data-owner')) || (body.contains('remote') && el.hasAttribute('data-host'));
    return {display: none ? 'none' : 'block'};
  }
  requestAnimationFrame(fn) { return setTimeout(fn, 0); }
  dispatchEvent(event) { event.target = this; this.fire(event, 'target'); return !event.defaultPrevented; }
}

/** A keydown at the focused element, as a keyboard sends it. Returns the event. */
export function press(doc, key, mods = {}) {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  const event = new FakeEvent('keydown', {key, code, bubbles: true, ...mods});
  dispatch(doc.activeElement ?? doc.body, event);
  return event;
}

/** Types text into the focused field one key at a time: keydown, then the character and an input event unless the key was taken. */
export function type(doc, text) {
  for (const ch of text) {
    const target = doc.activeElement, event = press(doc, ch);
    if (!event.defaultPrevented && /^(INPUT|TEXTAREA)$/.test(target.tagName)) {
      target.value += ch;
      dispatch(target, new FakeEvent('input', {bubbles: true}));
    }
  }
}

// A small stand-in for the browser DOM, enough for the owner panels (owner-dialog.js and the panels built on it) to build and repaint in
// Node. Selectors are one compound of a tag, classes and [attr] or [attr="value"] parts ("button.primary", "[data-key]").
export class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    const classList = {
      add: (...c) => { this.className = [...new Set([...classes(), ...c])].join(' '); },
      remove: (...c) => { this.className = classes().filter(x => !c.includes(x)).join(' '); },
      toggle: (c, on = !classes().includes(c)) => { if (on) classList.add(c); else classList.remove(c); return on; },
      contains: c => classes().includes(c),
    };
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, classList, className: '', hidden: false, open: false, ownText: '', disabled: false, value: '', checked: false, scrollTop: 0});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  after(...nodes) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); for (const n of nodes) n.parentNode = p; p.children.splice(i + 1, 0, ...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return !event.defaultPrevented; }
  click() { this.onclick?.({type: 'click', currentTarget: this}); for (const fn of this.listeners.click ?? []) fn({type: 'click'}); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  getBoundingClientRect() { return {left: 0, top: 0, width: 0, height: 0}; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector);
    if (!m) throw new Error(`unsupported selector ${selector}`);
    const own = this.className.split(/\s+/), classes = m[2].split('.').filter(Boolean), attrs = [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    return (!m[1] || this.tagName === m[1].toUpperCase()) && classes.every(c => own.includes(c)) && attrs.every(([, k, v]) => k in this.attributes && (v === undefined || this.attributes[k] === v));
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

/** A document with a body, as the panels take it ({doc}). It is also the global document, since el() (projects-panel.js) builds with that. */
export function fakeDocument() {
  const doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createElementNS = (ns, tag) => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  doc.getElementById = id => doc.body.querySelectorAll(`[id="${id}"]`)[0] ?? null;
  doc.querySelector = selector => doc.body.querySelector(selector);
  globalThis.document = doc;
  return doc;
}

/** Lets every pending promise and timer-free continuation run. */
export const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

/**
 * A fetch that answers from a table. routes: {'GET /api/x': body | (body, url) => body | {status, body}}. Every call is kept in calls as
 * [method, url, parsed body]. An unknown route answers 404.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([method, url, body]);
    let answer = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`];
    if (typeof answer === 'function') answer = answer(body, url);
    const reply = answer === undefined ? {status: 404, body: {error: 'Not found.'}} : answer?.status && answer?.body !== undefined ? answer : {status: 200, body: answer};
    return {ok: reply.status < 400, status: reply.status, json: async () => reply.body};
  };
  return {fetchImpl, calls};
}

/** The buttons under root whose text is exactly text. */
export const buttons = (root, text) => root.querySelectorAll('button').filter(b => b.textContent === text);
export const button = (root, text) => buttons(root, text)[0];

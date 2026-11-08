// A small stand-in for the browser DOM, enough for the owner panels to build and run in Node: elements with children, attributes, classes,
// listeners and dialogs, and selectors of one compound (a tag, .classes and [attr] or [attr="value"] or [attr$="end"] parts).
// A disabled button ignores click(), as in a browser. Used by the accounts, Discord, connect-flow and secrets UI tests.
export class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, parentNode: null, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, ownText: '', disabled: false, value: '', type: ''});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get innerText() { return this.textContent; }
  get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }
  get classList() {
    const own = () => this.className.split(/\s+/).filter(Boolean), set = list => { this.className = list.join(' '); };
    return {contains: c => own().includes(c), add: (...cs) => set([...new Set([...own(), ...cs])]), remove: (...cs) => set(own().filter(c => !cs.includes(c))),
      toggle: (c, force) => { const on = force ?? !own().includes(c); set(on ? [...new Set([...own(), c])] : own().filter(x => x !== c)); return on; }};
  }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true; if (k === 'type') this.type = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return true; }
  click() { if (this.disabled) return; this.onclick?.({type: 'click', currentTarget: this}); for (const fn of this.listeners.click ?? []) fn({type: 'click'}); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:[$]?="[^"]*")?\])*)$/.exec(selector);
    if (!m) throw new Error(`The fake DOM cannot match ${selector}`);
    const own = this.className.split(/\s+/), classes = m[2].split('.').filter(Boolean), attrs = [...m[3].matchAll(/\[([\w-]+)(?:([$]?)="([^"]*)")?\]/g)];
    return (!m[1] || this.tagName === m[1].toUpperCase()) && classes.every(c => own.includes(c))
      && attrs.every(([, k, end, v]) => k in this.attributes && (v === undefined || (end ? this.attributes[k].endsWith(v) : this.attributes[k] === v)));
  }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

/** A document whose createElement makes FakeNodes. It becomes globalThis.document, as projects-panel.js el() builds on it; restore() puts back
 *  whatever was there. */
export function fakeDocument() {
  const before = globalThis.document, doc = {activeElement: null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createElementNS = (ns, tag) => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.body = doc.createElement('body');
  doc.querySelector = selector => doc.body.querySelector(selector);
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  globalThis.document = doc;
  doc.restore = () => { if (before === undefined) delete globalThis.document; else globalThis.document = before; };
  return doc;
}

/** A window with listeners, window.open (recorded) and a clipboard. */
export function fakeWindow() {
  const listeners = {}, opened = [];
  return {listeners, opened, navigator: {clipboard: {writeText: async () => {}}},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] ?? []) fn(event); }, open(url) { opened.push(url); return {}; }};
}

/** A fetch over a route table: 'METHOD /path' -> (body, server) => answer. An Error answers 400 with its message; {status, json} answers as given;
 *  anything else answers 200 with it as JSON. Every call is recorded as [method, path, body]. */
export function fakeServer(routes) {
  const server = {calls: [], routes};
  server.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    server.calls.push([method, url, body]);
    const route = server.routes[`${method} ${url}`];
    if (!route) return {ok: false, status: 404, json: async () => ({error: `No route ${method} ${url}`})};
    const answer = await route(body, server);
    if (answer instanceof Error) return {ok: false, status: answer.status ?? 400, json: async () => ({error: answer.message})};
    if (answer && typeof answer === 'object' && 'status' in answer && 'json' in answer && Object.keys(answer).length === 2) return {ok: answer.status < 300, status: answer.status, json: async () => answer.json};
    // A copy, as the network gives: the page never holds the test's own objects.
    const copy = answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
    return {ok: true, status: 200, json: async () => copy};
  };
  return server;
}

export const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
export const byKey = (root, key) => root.querySelectorAll('[data-key]').find(n => n.dataset.key === key) ?? null;
export const buttonByText = (root, text) => root.querySelectorAll('button').find(n => n.textContent === text) ?? null;

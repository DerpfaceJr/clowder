// Devices > "How your phone reaches this computer" (plan 5.1, D4): Tailscale first, as the recommended way, with Quick Tunnel as the
// fallback. Tailscale is checked on this computer (GET /api/remote/tailscale, src/tailscale.ts detectTailscale) and the missing steps
// are listed; the way in use is picked with POST /api/remote/provider. Host only, like the rest of Devices.
// remotePath() is pure, for Node tests; the DOM is built with createElement and textContent only.
import {el} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';

export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
export const stable = status => status?.provider === 'tailscale' || status?.named === true;

/** The one status line under the two ways. status is GET /api/remote/status. */
export function remoteStatusText(status) {
  if (status?.starting) return 'Connecting your town…';
  if (status?.origin) return `Remote access is on: ${status.origin}`;
  return status?.error || 'Remote access is off.';
}

export const addressNote = status => stable(status)
  ? 'The address stays the same after restarts.'
  : 'The address changes when Clowder restarts; make a new pairing link then.';

/** What the two ways show. check is GET /api/remote/tailscale, null while it loads, or {failed: true}. */
export function remotePath(status, check) {
  const inUse = status?.provider === 'tailscale';
  const on = inUse && !!status?.origin;
  const state = !check ? 'checking' : check.failed ? 'unknown' : !check.installed ? 'missing' : !check.signedIn ? 'signed-out' : check.https === false ? 'no-https' : 'ready';
  const address = on ? status.origin : check?.origin || null;
  const line = {
    checking: 'Checking Tailscale on this computer…',
    unknown: 'Tailscale could not be checked on this computer.',
    missing: 'Tailscale is not installed on this computer yet.',
    'signed-out': 'Tailscale is installed here but not signed in.',
    'no-https': 'Tailscale is signed in. Turn on HTTPS to finish.',
    ready: on ? 'On. Your town’s private address:' : 'Ready. Your town’s private address will be:',
  }[state];
  const steps = [
    {key: 'install', text: 'Install Tailscale on this computer and on your phone.', done: !!check?.installed, link: TAILSCALE_DOWNLOAD},
    {key: 'sign-in', text: 'Sign in on both with the same account.', done: !!check?.signedIn},
    {key: 'https', text: 'Turn on HTTPS: in the Tailscale admin console, open DNS and turn on MagicDNS and HTTPS Certificates. When you turn on remote access, Clowder runs tailscale serve for you.', done: check?.https === true},
  ];
  const named = status?.named === true;
  return {
    tailscale: {
      inUse, state, line, address: state === 'ready' || on ? address : null,
      steps, showSteps: state !== 'ready' && state !== 'checking',
      serve: typeof check?.serve === 'string' ? check.serve : null,
      action: inUse ? (state === 'ready' ? null : 'check') : (check?.signedIn ? 'use' : 'check'),
    },
    fallback: {
      inUse: status?.provider === 'cloudflare', named,
      title: named ? 'Your Cloudflare tunnel' : 'Quick Tunnel',
      badge: named ? '' : 'No setup',
      lede: named
        ? 'Your own address through Cloudflare. It stays the same after restarts, and apps you connect from your phone come back to it by themselves.'
        : 'Works without an account, through Cloudflare. The address changes each time Clowder restarts, so you pair your phone again after a restart. Connecting an app from your phone takes one more step there: copy the address of the page the sign-in ends on and paste it back into Clowder.',
      use: named ? 'Use your Cloudflare tunnel' : 'Use Quick Tunnel',
    },
  };
}

function injectStyles(doc) {
  if (!doc?.head || doc.querySelector('link[data-remote-path]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('remote-path.css', import.meta.url).href;
  link.dataset.remotePath = '';
  doc.head.append(link);
}

const badge = (text, inUse = false) => el('span', {className: 'cx-badge', text, attrs: inUse ? {'data-in-use': ''} : {}});
const button = (text, onclick, primary = false) => {
  const b = el('button', {className: primary ? 'primary' : '', text, attrs: {type: 'button'}});
  b.onclick = onclick;
  return b;
};

/** root: the dialog's container. request(path, body) posts like app.js api(); reload() redraws Devices. */
export function createRemotePath({root, request, reload, doc = document, fetchImpl = (...args) => fetch(...args), ask = confirmDialog}) {
  injectStyles(doc);
  let status = null, check = null, message = '', checking = null;

  async function recheck() {
    const pending = checking = fetchImpl('/api/remote/tailscale', {cache: 'no-store'})
      .then(async r => (r.ok ? r.json() : {failed: true}))
      .catch(() => ({failed: true}));
    draw();
    const result = await pending;
    if (checking !== pending) return;
    check = result;checking = null;draw();
  }

  async function use(provider) {
    const name = provider === 'tailscale' ? 'Tailscale' : remotePath(status, check).fallback.title;
    if (status?.origin && !await ask({title: `Switch to ${name}?`, message: 'Remote access restarts on the new address. Phones paired on the old address pair again there.', confirmLabel: 'Switch', cancelLabel: 'Keep it as it is'})) return;
    let failure = '';
    try { await request('remote/provider', {provider}); } catch (error) { failure = error.message; }
    await reload();
    // The status line already says why a start failed; the card says only what it does not.
    if (failure && failure !== status?.error) { message = failure; draw(); }
  }

  function tailscaleCard(view) {
    const t = view.tailscale;
    const head = el('div', {className: 'remote-way-head'}, [el('h4', {text: 'Tailscale'}), badge('Recommended'), ...(t.inUse ? [badge('In use', true)] : [])]);
    const parts = [head, el('p', {text: 'A private address that stays the same after restarts. Only your own devices, signed in to Tailscale, can open it, and apps you connect from your phone come back to it by themselves.'})];
    parts.push(el('p', {className: 'remote-way-line', text: t.line, attrs: {'data-state': t.state}}));
    if (t.address) parts.push(el('p', {className: 'remote-address', text: t.address}));
    if (t.showSteps) {
      parts.push(el('ol', {className: 'remote-steps'}, t.steps.map(step => {
        const item = el('li', {attrs: step.done ? {'data-done': ''} : {}}, [el('span', {text: step.text})]);
        if (step.link && !step.done) item.append(' ', el('a', {text: 'tailscale.com/download', attrs: {href: step.link, target: '_blank', rel: 'noopener noreferrer'}}));
        if (step.done) item.append(el('span', {className: 'remote-step-done', text: ' ✓ Done'}));
        return item;
      })));
    }
    if (t.serve) parts.push(el('p', {className: 'muted remote-serve'}, ['Clowder runs ', el('code', {text: t.serve}), '. It never uses tailscale funnel, so your town stays off the public Internet.']));
    const actions = [];
    if (t.action === 'use') actions.push(button('Use Tailscale', () => use('tailscale'), true));
    if (t.action === 'check' && t.state !== 'checking') {
      const again = button(checking ? 'Checking…' : 'Check again', () => void recheck());
      again.disabled = !!checking;
      actions.push(again);
    }
    if (actions.length) parts.push(el('div', {className: 'remote-way-actions'}, actions));
    return el('section', {className: 'remote-way', attrs: {'aria-label': 'Tailscale', ...(t.inUse ? {'data-in-use': ''} : {})}}, parts);
  }

  function fallbackCard(view) {
    const f = view.fallback;
    const head = el('div', {className: 'remote-way-head'}, [el('h4', {text: f.title}), ...(f.badge ? [badge(f.badge)] : []), ...(f.inUse ? [badge('In use', true)] : [])]);
    const parts = [head, el('p', {text: f.lede})];
    if (!f.inUse) parts.push(el('div', {className: 'remote-way-actions'}, [button(f.use, () => use('cloudflare'))]));
    return el('section', {className: 'remote-way', attrs: {'aria-label': f.title, ...(f.inUse ? {'data-in-use': ''} : {})}}, parts);
  }

  function draw() {
    if (!root || !status) return;
    const view = remotePath(status, check);
    const children = [el('h3', {text: 'How your phone reaches this computer'}), tailscaleCard(view), el('p', {className: 'remote-or muted', text: 'No Tailscale? Use this instead:'}), fallbackCard(view)];
    if (message) children.push(el('p', {className: 'cx-msg bad', text: message, attrs: {role: 'status'}}));
    root.replaceChildren(...children);
  }

  /** Draws the two ways for this status at once, then checks Tailscale again. */
  function show(next) {
    status = next;message = '';void recheck();
  }

  return {show, recheck};
}

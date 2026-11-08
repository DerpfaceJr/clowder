// What happens after a sign-in starts (plan 1.6), shared by the Accounts hub and the Needs you panel. The server's answer (src/connectors.ts
// SignIn) names how it finishes: callback (the browser comes back by itself), device (the owner types userCode on the page given; the server
// polls meanwhile) or paste (on Quick Tunnel the phone's browser stops at this computer's address, and the owner pastes that address back).
// A token pasted instead of a sign-in comes back with the account's whoami, or a 409 that says why the service refused it.
// The pure helpers are exported for Node tests. The box is built with createElement and textContent only, so nothing a server says becomes markup.
import {el} from './projects-panel.js';
import {webLink} from './connectors-panel.js';

export const PASTE_PATH = '/api/connectors/oauth/paste';
const h = (tag, props, ...children) => el(tag, props, children.flat().filter(c => c !== null && c !== undefined && c !== false));

/** The sign-in answer as one plan for the box, or null when it gives no web page. A device answer without a readable code reads as a callback. */
export function signInPlan(r) {
  const url = webLink(r?.url);
  if (!url) return null;
  if (r?.finish === 'paste') return {finish: 'paste', url};
  const code = String(r?.device?.userCode ?? '').trim();
  if (r?.finish === 'device' && /^[A-Za-z0-9 -]{4,40}$/.test(code)) {
    const t = Number(r.device.expiresAt);
    return {finish: 'device', url, userCode: code, expiresAt: Number.isFinite(t) && t > 0 ? t : null};
  }
  return {finish: 'callback', url};
}

/** When a device code stops working, as a clock time, or '' when the server gave no time. */
export const codeUntil = (expiresAt, locale) => (expiresAt ? new Date(expiresAt).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'}) : '');

/** The one line a box shows first, by how the sign-in finishes. */
export function planLine(plan, name = 'the service') {
  if (!plan) return '';
  if (plan.finish === 'device') return `Open the ${name} sign-in page and enter this code. This updates by itself once you approve.`;
  if (plan.finish === 'paste') return `Sign in on the ${name} page. When you are done, your browser stops on a page that does not load. Copy that whole address and paste it here.`;
  if (plan.opened === false) return `Your browser did not open the ${name} sign-in page. Open it below; this updates by itself once you finish.`;
  return `The ${name} sign-in page opened. Finish there; this updates by itself.`;
}

/** What the paste box sends, or why not: an address that came back from a sign-in carries a code (or the service's error) and the state. */
export function pasteDraft(text) {
  const t = String(text ?? '').trim();
  if (!t) return {error: 'Paste the address your browser stopped at.'};
  if (t.length > 4000) return {error: 'That is longer than a sign-in address.'};
  if (!/(^|[?&#])(code|error)=/.test(t) || !/(^|[?&#])state=/.test(t)) return {error: 'That address has no sign-in code. Copy the whole address from the address bar, after you approve.'};
  return {body: {url: t}};
}

/** What a pasted token's answer says: who it signs in as, or that nobody could be checked. account is POST /api/connectors/:id/token's (or a
 *  connect step's) account: {status, reason, identity}. */
export function tokenLine(account, name = 'The service') {
  const who = typeof account?.identity === 'string' && account.identity.trim() ? account.identity.trim() : '';
  if (who && account.status === 'expiring') return `Signed in as ${who}. ${account.reason || 'The sign-in ends soon.'}`;
  if (who) return `Signed in as ${who}.`;
  if (account?.status && account.status !== 'unchecked' && account.status !== 'connected' && account.reason) return account.reason;
  // No account at all: the check did not run (the service did not answer), which proves nothing either way.
  if (!account) return `Saved. Clowder could not reach ${name} to check who it signs in as; it checks again within 15 minutes.`;
  return `Saved. ${name} has no way to say who the token belongs to, so it is not checked.`;
}

/** POST with the owner header; the server's error (a 409's reason) is the message. */
export async function post(fetchImpl, url, body) {
  const r = await fetchImpl(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body ?? {})});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || (r.status === 403 ? 'Do this on the computer running Clowder.' : 'That did not work.')), {status: r.status});
  return data;
}

/** The box for one started sign-in: the line, the page link, then the code (device) or the paste box (paste). onDone(name) runs after a paste
 *  finishes. A copy button falls back to telling the owner to copy by hand. */
// Its stylesheet loads once, on first use, so a page that never signs in pays nothing.
function ensureStyles(doc = globalThis.document) {
  if (!doc?.head || doc.querySelector('link[data-connect-flow]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('connect-flow.css', import.meta.url).href;
  link.dataset.connectFlow = '';
  doc.head.append(link);
}

export function signInBox(plan, {name = 'the service', fetchImpl = (...a) => fetch(...a), onDone = () => {}, clipboard = globalThis.navigator?.clipboard} = {}) {
  if (!plan) return null;
  ensureStyles();
  const link = h('a', {className: 'cx-open', text: plan.finish === 'callback' && plan.opened !== false ? 'Open it again ↗' : `Open the ${name} sign-in page ↗`, attrs: {href: plan.url, target: '_blank', rel: 'noopener noreferrer'}});
  const parts = [h('p', {className: 'cf-line', text: planLine(plan, name), attrs: {role: 'status'}}), link];
  if (plan.finish === 'device') {
    const until = codeUntil(plan.expiresAt);
    const copy = h('button', {className: 'cf-copy', text: 'Copy code', attrs: {type: 'button'}});
    copy.onclick = async () => { try { await clipboard.writeText(plan.userCode); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy it by hand'; } };
    parts.splice(1, 0, h('p', {className: 'cf-code', text: plan.userCode, attrs: {'aria-label': `Code ${plan.userCode.split('').join(' ')}`}}), copy);
    if (until) parts.push(h('p', {className: 'cf-hint', text: `The code works until ${until}.`}));
  }
  if (plan.finish === 'paste') {
    const input = h('input', {className: 'cf-paste-input', attrs: {type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '4000', placeholder: 'http://127.0.0.1:…/api/connectors/oauth/callback?code=…', 'aria-label': `The address your browser stopped at after signing in to ${name}`}});
    const send = h('button', {className: 'primary cf-paste-send', text: 'Finish sign-in', attrs: {type: 'submit'}});
    const msg = h('p', {className: 'cx-msg', attrs: {role: 'status', hidden: ''}});
    const say = (text, bad) => { msg.textContent = text; msg.hidden = !text; msg.classList.toggle('bad', !!bad); };
    const form = h('form', {className: 'cf-paste', attrs: {novalidate: ''}}, input, send);
    form.onsubmit = async event => {
      event?.preventDefault?.();
      const draft = pasteDraft(input.value);
      if (draft.error) { say(draft.error, true); return; }
      send.disabled = true; say('');
      try { const r = await post(fetchImpl, PASTE_PATH, draft.body); input.value = ''; say(`Signed in to ${r?.name || name}.`); onDone(r?.name || name); }
      catch (error) { say(error.message, true); }
      finally { send.disabled = false; }
    };
    parts.push(form, msg);
  }
  return h('div', {className: 'cf-box', attrs: {'data-finish': plan.finish}}, parts);
}

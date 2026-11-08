// Moonvault "Real money" section: the owner's spending policy, the Stripe Issuing link, this month's spend and the
// purchase ledger. Mounted into #real-money inside the Moonvault dialog and refreshed whenever the dialog opens.
// The server decides who may do what: settings and "Paid" are host-only; approving or rejecting is also open to a
// paired device with control. Card details are never shown here; the owner opens the card in Stripe's dashboard.
// The DOM is built with createElement and textContent only. Links are rendered only for https addresses.
import {confirmDialog} from './dialogs.js';

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'];
const STATUS = {pending: 'Waiting for you', approved: 'Approved · pay it yourself', 'auto-approved': 'Auto-approved for the card', rejected: 'Rejected', refused: 'Refused by the limits', paid: 'Paid'};

export const money = (minor, currency) => `${(minor / 100).toFixed(2)} ${currency}`;
// "12.5" → 1250; null for anything that is not a plain amount with at most two decimals.
export function toMinor(text) {
  const value = String(text ?? '').trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export const statusLabel = p => p.expired ? 'Expired · not paid' : STATUS[p.status] || p.status;
export const categoriesFrom = text => String(text || '').split(/[\s,]+/).map(c => c.trim().toLowerCase()).filter(Boolean);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    else node.setAttribute(key, value);
  }
  for (const child of [children].flat()) if (child) node.append(child);
  return node;
}
// Only https links are clickable; anything else is shown as plain text.
function safeLink(url, text) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return el('a', {href: u.href, target: '_blank', rel: 'noopener noreferrer', text: text || u.host});
  } catch { /* shown as text */ }
  return el('span', {text: text || String(url)});
}

async function call(path, body) {
  const response = await fetch(path, body === undefined ? {cache: 'no-store'} : {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function mount(root) {
  let busy = false;
  const status = el('p', {className: 'real-money-status', role: 'status'});

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const view = await call('/api/real-money');
      // Viewers see nothing while the module is off and the ledger is empty.
      root.hidden = !view.owner && !view.policy.enabled && !view.purchases.length;
      if (!root.hidden) render(view);
    } catch {
      root.hidden = true;
    } finally {
      busy = false;
    }
  }

  async function act(button, work, done = 'Saved.') {
    button.disabled = true;
    status.textContent = '';
    try {
      await work();
      await refresh();
      status.textContent = done;
      delete status.dataset.kind;
    } catch (error) {
      status.textContent = error.message;
      status.dataset.kind = 'error';
    } finally {
      button.disabled = false;
    }
  }

  function render(view) {
    const {policy, month, stripe} = view;
    const cur = policy.currency;
    const head = el('div', {className: 'real-money-head'}, [
      el('h3', {id: 'real-money-title', text: 'Real money'}),
      el('span', {className: `real-money-mode ${policy.enabled ? 'on' : ''}`, text: policy.enabled ? (policy.mode === 'autopay' ? 'On · Autopay' : 'On · Pre-pay') : 'Off'}),
    ]);
    const used = month.spentMinor + month.openMinor;
    const meter = el('div', {className: 'real-money-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(month.limitMinor), 'aria-valuenow': String(Math.min(used, month.limitMinor)), 'aria-label': 'This month against the monthly limit'});
    meter.append(el('span', {style: `width:${month.limitMinor ? Math.min(100, Math.round(used / month.limitMinor * 100)) : 0}%`}));
    const summary = el('div', {className: 'real-money-month'}, [
      el('p', {text: `This month: ${money(month.spentMinor, cur)} paid${month.openMinor ? `, ${money(month.openMinor, cur)} approved or waiting` : ''}, of ${money(month.limitMinor, cur)}.`}),
      meter,
      el('p', {className: 'muted', text: `Per purchase up to ${money(policy.perPurchaseLimitMinor, cur)}. Months run on UTC, like Stripe's.`}),
    ]);
    const parts = [head, summary, ledger(view)];
    if (view.authorizations.length) parts.push(authorizations(view));
    if (view.owner) parts.push(policyForm(view), stripeSection(view));
    parts.push(status);
    root.replaceChildren(...parts);
  }

  function ledger(view) {
    const list = el('ul', {className: 'real-money-ledger'});
    for (const p of view.purchases) {
      const item = el('li', {className: 'real-money-item', 'data-status': p.expired ? 'expired' : p.status}, [
        el('div', {className: 'real-money-line'}, [el('strong', {text: p.vendor}), el('span', {text: money(p.status === 'paid' ? p.paidMinor : p.amountMinor, p.currency)})]),
        el('small', {text: `${statusLabel(p)}${p.recurring ? ' · renews' : ''} · ${new Date(p.requestedAt).toLocaleString()}`}),
        el('p', {text: p.reason}),
        p.note ? el('p', {className: 'real-money-note', text: p.note}) : null,
        p.decision ? el('p', {className: 'muted', text: `Decision: ${p.decision}`}) : null,
        el('p', {className: 'real-money-link'}, [safeLink(p.url)]),
      ]);
      if (p.status === 'pending' && view.decide) item.append(decision(p));
      if (p.status === 'approved' && view.owner) item.append(paid(p, view.policy));
      list.append(item);
    }
    return el('section', {className: 'real-money-block'}, [
      el('h4', {text: 'Purchase ledger'}),
      view.purchases.length ? list : el('p', {className: 'muted', text: 'No purchases yet. The Mayor asks only when a real-world purchase is truly needed.'}),
    ]);
  }

  function decision(p) {
    const reason = el('textarea', {rows: '2', maxlength: '500', placeholder: 'Optional note for the Mayor (why, or what to do instead)'});
    const approve = el('button', {type: 'button', className: 'primary', text: 'Approve'});
    const reject = el('button', {type: 'button', text: 'Reject'});
    approve.addEventListener('click', async () => {
      const ok = await confirmDialog({title: `Approve ${p.vendor} ${money(p.amountMinor, p.currency)}?`, message: p.mode === 'autopay' ? 'This is over the Autopay limits. The linked card may accept one matching charge if Stripe’s card limits allow it; otherwise buy it yourself, outside the app, and mark it paid here.' : 'Nothing is paid by the app. You buy it yourself, outside the app, then mark it paid here.', confirmLabel: 'Approve purchase', cancelLabel: 'Not yet'});
      if (ok) await act(approve, () => call(`/api/purchases/${encodeURIComponent(p.id)}/decide`, {approved: true, reason: reason.value}), 'Approved. Pay it yourself, then mark it paid.');
    });
    reject.addEventListener('click', async () => {
      const ok = await confirmDialog({title: `Reject ${p.vendor}?`, message: 'The Mayor is told no, with your note as the reason.', confirmLabel: 'Reject purchase', cancelLabel: 'Keep it open', danger: true});
      if (ok) await act(reject, () => call(`/api/purchases/${encodeURIComponent(p.id)}/decide`, {approved: false, reason: reason.value}), 'Rejected. The Mayor has been told why.');
    });
    return el('div', {className: 'real-money-actions'}, [el('label', {text: 'Note for the Mayor'}, [reason]), el('div', {className: 'choices'}, [reject, approve])]);
  }

  function paid(p, policy) {
    const cap = p.amountMinor + policy.toleranceMinor;
    const amount = el('input', {type: 'text', inputmode: 'decimal', maxlength: '12', value: (p.amountMinor / 100).toFixed(2), 'aria-label': `Amount paid to ${p.vendor}`});
    const button = el('button', {type: 'button', className: 'primary', text: 'Mark paid'});
    button.addEventListener('click', () => act(button, () => call(`/api/purchases/${encodeURIComponent(p.id)}/paid`, {amount: amount.value.trim()}), 'Recorded as paid.'));
    return el('div', {className: 'real-money-actions'}, [
      el('label', {text: `Amount you paid (at most ${money(cap, p.currency)})`}, [amount]),
      button,
    ]);
  }

  function authorizations(view) {
    const list = el('ul', {className: 'real-money-ledger'});
    for (const a of view.authorizations.slice(0, 10)) list.append(el('li', {className: 'real-money-item', 'data-status': a.approved ? 'paid' : 'rejected'}, [
      el('div', {className: 'real-money-line'}, [el('strong', {text: a.merchant || 'Unknown merchant'}), el('span', {text: a.amountMinor === null ? '—' : money(a.amountMinor, a.currency || view.policy.currency)})]),
      el('small', {text: `${a.approved ? 'Card charge approved' : 'Card charge declined'} · ${new Date(a.at).toLocaleString()}`}),
      el('p', {text: a.reason}),
    ]));
    return el('section', {className: 'real-money-block'}, [el('h4', {text: 'Card decisions'}), list]);
  }

  function policyForm(view) {
    const {policy, stripe} = view;
    const field = (label, input, hint) => el('label', {text: label}, [input, hint ? el('small', {className: 'muted', text: hint}) : null]);
    const enabled = el('input', {type: 'checkbox'});
    enabled.checked = policy.enabled;
    const modes = el('div', {className: 'real-money-modes', role: 'radiogroup', 'aria-label': 'Payment mode'});
    for (const [id, title, text] of [['prepay', 'Pre-pay', 'You approve each purchase and pay it yourself. The default.'], ['autopay', 'Autopay', 'Purchases within the limits are approved for a Stripe Issuing virtual card. Needs Stripe connected.']]) {
      const input = el('input', {type: 'radio', name: 'real-money-mode', value: id});
      input.checked = policy.mode === id;
      if (id === 'autopay' && !stripe.connected) input.disabled = true;
      modes.append(el('label', {className: 'real-money-choice'}, [input, el('strong', {text: title}), el('span', {text: ` ${text}`})]));
    }
    const currency = el('select');
    for (const c of CURRENCIES) currency.append(el('option', {value: c, text: c}));
    currency.value = policy.currency;
    const amount = minor => el('input', {type: 'text', inputmode: 'decimal', maxlength: '12', value: (minor / 100).toFixed(2)});
    const per = amount(policy.perPurchaseLimitMinor), monthly = amount(policy.monthlyLimitMinor), tolerance = amount(policy.toleranceMinor);
    const categories = el('input', {type: 'text', maxlength: '1200', value: policy.allowedCategories.join(', '), placeholder: 'Any category'});
    const save = el('button', {type: 'submit', className: 'primary', text: 'Save spending policy'});
    const form = el('form', {className: 'real-money-form'}, [
      el('p', {className: 'real-money-warning', text: 'Real money is off unless you turn it on here. Cats never see card numbers or bank details, and nothing a model says can pay on its own: every purchase is checked against these limits, and only you or the linked card (for a purchase already approved) can pay.'}),
      el('label', {className: 'real-money-choice'}, [enabled, el('strong', {text: 'Let the Mayor ask for real-world purchases'})]),
      modes,
      field('Currency', currency),
      field('Per-purchase limit', per),
      field('Monthly limit', monthly, 'Requests waiting for you and approved purchases count until they expire or are rejected.'),
      field('Allowed categories', categories, 'Optional. Stripe merchant category names, separated by commas, such as computer_software_stores.'),
      field('Paid-amount tolerance', tolerance, 'How much a paid amount may exceed the approved amount. Default 0.'),
      save,
    ]);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const next = {enabled: enabled.checked, mode: modes.querySelector('input:checked')?.value || 'prepay', currency: currency.value,
        perPurchaseLimitMinor: toMinor(per.value), monthlyLimitMinor: toMinor(monthly.value), toleranceMinor: toMinor(tolerance.value), allowedCategories: categoriesFrom(categories.value)};
      if ([next.perPurchaseLimitMinor, next.monthlyLimitMinor, next.toleranceMinor].some(v => v === null)) { status.textContent = 'Enter amounts with at most two decimals.'; status.dataset.kind = 'error'; return; }
      if (next.enabled && !policy.enabled) {
        const ok = await confirmDialog({title: 'Turn on real money?', message: `The Mayor may ask to spend up to ${money(next.perPurchaseLimitMinor, next.currency)} per purchase and ${money(next.monthlyLimitMinor, next.currency)} a month. ${next.mode === 'autopay' ? 'Autopay approves purchases within these limits without asking you.' : 'You approve and pay each one yourself.'}`, confirmLabel: 'Turn on', cancelLabel: 'Keep it off', danger: true});
        if (!ok) return;
      }
      if (next.mode === 'autopay' && policy.mode !== 'autopay') {
        const ok = await confirmDialog({title: 'Switch to Autopay?', message: 'Purchases within your limits will be approved without asking you, and the linked Stripe card will accept one matching charge for each. Larger requests still wait for you.', confirmLabel: 'Switch to Autopay', cancelLabel: 'Stay on Pre-pay', danger: true});
        if (!ok) return;
      }
      await act(save, () => call('/api/real-money/policy', next));
    });
    return el('details', {className: 'real-money-block', open: ''}, [el('summary', {text: 'Spending policy'}), form]);
  }

  function stripeSection(view) {
    const {stripe} = view;
    const block = el('details', {className: 'real-money-block'}, [el('summary', {text: `Stripe Issuing · ${stripe.connected ? `connected${stripe.testMode ? ' (test mode)' : ''}` : 'not connected'}`})]);
    const webhook = el('p', {className: 'real-money-warning'});
    webhook.textContent = 'Autopay needs a public HTTPS address for Stripe’s real-time authorizations. Turn on remote access (Devices) with a Cloudflare tunnel, then set the Issuing real-time authorization endpoint to that address followed by /stripe/webhook. Tailscale addresses are private to your tailnet and a Quick Tunnel address changes on every restart. In Stripe’s Issuing settings, set the timeout behaviour to decline.';
    void call('/api/remote/status').then(remote => {
      if (remote.origin && remote.provider !== 'tailscale') webhook.append(el('br'), el('strong', {text: `Endpoint now: ${remote.origin}/stripe/webhook`}));
    }).catch(() => {});
    block.append(webhook, el('p', {}, [safeLink('https://dashboard.stripe.com/account/issuing', 'Open Stripe Issuing settings')]));
    if (stripe.connected) {
      const disconnect = el('button', {type: 'button', className: 'danger', text: 'Disconnect Stripe'});
      disconnect.addEventListener('click', async () => {
        const ok = await confirmDialog({title: 'Disconnect Stripe?', message: 'The card is set inactive, the key and signing secret are deleted from this computer, and real money goes back to Pre-pay.', confirmLabel: 'Disconnect', cancelLabel: 'Keep connected', danger: true});
        if (ok) await act(disconnect, () => call('/api/real-money/stripe/disconnect', {}), 'Stripe disconnected. Pre-pay only.');
      });
      block.append(el('p', {text: 'The virtual card’s number is never shown here. Open it in Stripe to see or use it.'}),
        el('p', {}, [safeLink(stripe.dashboard, 'Open the card in Stripe')]), disconnect);
      return block;
    }
    const secret = (label, placeholder) => el('label', {text: label}, [el('input', {type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '300', placeholder})]);
    const key = secret('Restricted key', 'rk_live_… or rk_test_…'), signing = secret('Webhook signing secret', 'whsec_…');
    const target = el('label', {text: 'Cardholder id (to create a card) or existing virtual card id'}, [el('input', {type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '120', placeholder: 'ich_… or ic_…'})]);
    const connect = el('button', {type: 'submit', className: 'primary', text: 'Connect Stripe'});
    const form = el('form', {className: 'real-money-form'}, [
      el('p', {className: 'muted', text: 'Create a restricted key in Stripe with Issuing Cards: Write and Issuing Cardholders: Read, everything else None. Create the cardholder in Stripe’s dashboard first, so your name and address stay with Stripe. The key and secret stay on this computer and are never shown again.'}),
      key, signing, target, connect,
    ]);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const id = target.querySelector('input').value.trim();
      const ok = await confirmDialog({title: 'Connect Stripe Issuing?', message: `The app ${id.startsWith('ic_') ? 'links that virtual card' : 'creates one virtual card'} and sets its Stripe limits to match your policy. It stays inactive until you choose Autopay.`, confirmLabel: 'Connect', cancelLabel: 'Cancel'});
      if (!ok) return;
      await act(connect, () => call('/api/real-money/stripe', {key: key.querySelector('input').value.trim(), webhookSecret: signing.querySelector('input').value.trim(), ...(id.startsWith('ic_') ? {card: id} : {cardholder: id})}), 'Stripe connected. Choose Autopay to use the card.');
    });
    block.append(form);
    return block;
  }

  // The Moonvault opens from the HUD, the town scene and quests; watching the dialog catches all of them.
  const dialog = root.closest('dialog');
  if (dialog) new MutationObserver(() => { if (dialog.open) void refresh(); }).observe(dialog, {attributes: true, attributeFilter: ['open']});
  return {refresh};
}

const root = typeof document !== 'undefined' ? document.getElementById('real-money') : null;
if (root) mount(root);

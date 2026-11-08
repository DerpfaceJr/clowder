// Telegram (plan 3.5, D7): talk to the Mayor and answer decisions from your own Telegram chat. ☰ > Devices & AI > Telegram opens this
// panel on the host computer only: the bot token is a secret and the pairing code makes an owner device, as the phone invite does.
// Three steps, each shown once the one before it is done: paste the token BotFather gave you, send the one-time code to the bot, and
// the paired chat shows here (and in Devices as "Telegram", where it can be revoked). Remove takes the token off this computer.
// Routes: src/telegram.ts (GET /api/telegram; POST token, pair, remove). The pure helpers are exported for Node tests; the DOM is built
// with createElement and textContent only, so nothing Telegram or the server says can become markup.
import {el} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';

export const HOST_ONLY = 'Telegram is set up on the host computer.';
export const BOTFATHER = 'https://t.me/BotFather';
const POLL_MS = 2000;
const enc = encodeURIComponent;

/** The status line: a tone for the dot and one plain sentence. status is GET /api/telegram. */
export function statusLine(status) {
  if (!status?.configured) return {tone: 'off', text: 'Not set up'};
  if (status.error) return {tone: 'error', text: `Telegram says: ${status.error}`};
  if (status.paired) return {tone: 'ok', text: `Paired with your chat on ${status.bot}`};
  if (status.polling) return {tone: 'warn', text: `${status.bot} is ready. Pair your chat next.`};
  return {tone: 'warn', text: `${status.bot} is not connected yet.`};
}

/** A link that opens the bot in Telegram with the code ready to send (Telegram's start parameter), or null for an odd bot name. */
export function startLink(bot, code) {
  const name = String(bot ?? '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,64}$/.test(name) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(code ?? ''))) return null;
  return `https://t.me/${name}?start=${enc(code)}`;
}

/** When a code stops working, as a clock time ("14:05"), or '' when it cannot be read. */
export function untilText(expiresAt, locale) {
  const t = Number(expiresAt);
  return Number.isFinite(t) && t > 0 ? new Date(t).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'}) : '';
}

function injectStyles(doc) {
  if (!doc?.head || doc.querySelector('link[data-telegram-panel]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('telegram-panel.css', import.meta.url).href;
  link.dataset.telegramPanel = '';
  doc.head.append(link);
}

const h = (tag, props, ...children) => el(tag, props, children.flat().filter(c => c !== null && c !== undefined && c !== false));

/** button: the ☰ entry, shown once the host's route answers. Returns {open, close, refresh, probe, dialog}. */
export function createTelegramPanel({button = null, doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), ask = confirmDialog, now = () => Date.now()} = {}) {
  injectStyles(doc);
  const ui = {status: null, denied: false, code: null, busy: '', msg: null, tokenMsg: null, loaded: false, changing: false};
  let poll = 0;

  const read = async () => {
    const response = await fetchImpl('/api/telegram', {cache: 'no-store'});
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) throw Object.assign(new Error(HOST_ONLY), {status: 403});
    if (!response.ok) throw new Error(data.error || 'Telegram settings could not load.');
    return data;
  };
  const send = async (path, body = {}) => {
    const response = await fetchImpl(`/api/telegram/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) throw new Error(HOST_ONLY);
    if (!response.ok) throw new Error(data.error || 'That did not work.');
    return data;
  };

  const back = h('button', {className: 'back-pill phone-only', text: '← Town', attrs: {type: 'button', 'aria-label': 'Back to town'}});
  const closeX = h('button', {className: 'close-x desk-only', text: '×', attrs: {type: 'button', 'aria-label': 'Close Telegram'}});
  const body = h('div', {className: 'tg-body'});
  const dialog = h('dialog', {className: 'telegram-dialog', attrs: {id: 'telegram-dialog', 'aria-labelledby': 'telegram-title'}},
    h('div', {className: 'treasury-dialog-title tg-top'}, back, h('span', {className: 'eyebrow', text: 'OUTSIDE CHANNEL'}), closeX),
    h('h2', {text: 'Telegram', attrs: {id: 'telegram-title'}}),
    h('p', {className: 'tg-lede', text: 'Talk to the Mayor and answer decisions from your own Telegram chat. Only the chat you pair is heard; every other chat is ignored. Decisions that publish, pay or delete still open in Clowder.'}),
    body);
  back.onclick = () => dialog.close();
  closeX.onclick = () => dialog.close();
  doc.body.append(dialog);
  dialog.addEventListener('close', () => { stopPolling(); ui.code = null; ui.msg = null; ui.tokenMsg = null; ui.changing = false; body.replaceChildren(); });

  function stopPolling() { clearTimeout(poll); poll = 0; }
  // While a code is open, the status is read every 2 seconds until the chat pairs or the code runs out.
  function startPolling() {
    stopPolling();
    const tick = async () => {
      poll = 0;
      if (!dialog.open || !ui.code) return;
      if (now() > ui.code.expiresAt) { ui.code = null; ui.msg = {text: 'The code ran out. Get a new one to pair your chat.', bad: true}; paint(); return; }
      await refresh();
      if (ui.status?.paired) { ui.code = null; ui.msg = {text: 'Paired. Say hello to the Mayor from Telegram.'}; paint(); return; }
      poll = setTimeout(tick, POLL_MS);
    };
    poll = setTimeout(tick, POLL_MS);
  }

  async function refresh() {
    try {
      ui.status = await read(); ui.denied = false;
    } catch (error) {
      ui.denied = error.status === 403;
      ui.msg = {text: error.message, bad: true};
    }
    ui.loaded = true;
    paint();
  }

  async function act(key, work) {
    if (ui.busy) return;
    ui.busy = key; ui.msg = null; paint();
    try { await work(); } catch (error) { ui.msg = {text: error.message || String(error), bad: true}; } finally { ui.busy = ''; paint(); }
  }

  const msgNode = m => (m ? h('p', {className: `cx-msg${m.bad ? ' bad' : ''}`, text: m.text, attrs: {role: 'status'}}) : null);
  const btn = (text, key, onclick, className = '') => {
    const b = h('button', {className, text, attrs: {type: 'button', 'data-key': key}});
    b.disabled = !!ui.busy;
    b.onclick = onclick;
    return b;
  };

  function tokenForm(again) {
    const input = h('input', {className: 'tg-token', attrs: {type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '100', placeholder: '123456789:AA…', 'aria-label': 'Bot token from BotFather'}});
    const save = h('button', {className: 'primary', text: again ? 'Save new token' : 'Save token', attrs: {type: 'submit'}});
    save.disabled = !!ui.busy;
    const form = h('form', {className: 'tg-token-form', attrs: {novalidate: ''}}, input, save);
    form.onsubmit = e => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) { ui.tokenMsg = {text: 'Paste the token BotFather gave you.', bad: true}; paint(); return; }
      ui.tokenMsg = null;
      void act('token', async () => {
        try { ui.status = await send('token', {token}); } catch (error) { ui.tokenMsg = {text: error.message, bad: true}; return; }
        ui.changing = false; ui.code = null; ui.msg = {text: `Saved. Clowder now listens to ${ui.status.bot}.`};
      });
    };
    return h('div', {className: 'tg-token-box'},
      again ? null : h('ol', {className: 'tg-steps'},
        h('li', {text: 'In Telegram, open @BotFather and send /newbot. Give your bot any name.'}),
        h('li', {text: 'Copy the token BotFather sends back and paste it here. Clowder checks it with Telegram before saving.'})),
      again ? null : h('a', {className: 'cx-open tg-open', text: 'Open @BotFather ↗', attrs: {href: BOTFATHER, target: '_blank', rel: 'noopener noreferrer'}}),
      form,
      msgNode(ui.tokenMsg));
  }

  function codeBox() {
    const {code, bot, expiresAt} = ui.code, link = startLink(bot, code), until = untilText(expiresAt);
    const copy = btn('Copy code', 'copy', async () => {
      try { await win.navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy it by hand'; }
    });
    return h('div', {className: 'tg-code-box'},
      h('p', {className: 'tg-code', text: code, attrs: {'aria-label': `Pairing code ${code.split('').join(' ')}`}}),
      h('p', {className: 'tg-hint', text: `Send this code to ${bot} in Telegram, or tap Open in Telegram and then Start. It works once${until ? `, until ${until}` : ''}.`}),
      h('div', {className: 'tg-actions'},
        link ? h('a', {className: 'cx-open tg-open', text: `Open ${bot} in Telegram ↗`, attrs: {href: link, target: '_blank', rel: 'noopener noreferrer'}}) : null,
        copy),
      h('p', {className: 'tg-wait', text: 'Waiting for your message…', attrs: {role: 'status'}}));
  }

  function paint() {
    if (!dialog.open && ui.loaded) return;
    const s = ui.status, line = statusLine(s);
    const parts = [];
    if (ui.denied) {
      parts.push(msgNode(ui.msg));
    } else if (!ui.loaded) {
      parts.push(h('p', {className: 'cx-empty muted', text: 'Loading…', attrs: {role: 'status'}}));
    } else {
      parts.push(h('p', {className: 'cx-status tg-status'}, h('span', {className: 'cx-dot', attrs: {'data-tone': line.tone, 'aria-hidden': 'true'}}), h('span', {text: line.text})));
      parts.push(msgNode(ui.msg));
      // Step 1: the bot.
      const bot = h('section', {className: 'cx-section tg-step', attrs: {'aria-labelledby': 'tg-bot'}}, h('h4', {text: '1 · Your bot', attrs: {id: 'tg-bot'}}));
      if (!s?.configured) bot.append(tokenForm(false));
      else {
        bot.append(h('p', {className: 'tg-line'}, 'Bot: ', h('strong', {text: s.bot})));
        if (ui.changing) bot.append(tokenForm(true));
        else bot.append(btn('Change token', 'change', () => { ui.changing = true; ui.tokenMsg = null; paint(); }, 'tg-quiet'));
      }
      parts.push(bot);
      // Step 2: the chat.
      if (s?.configured) {
        const chat = h('section', {className: 'cx-section tg-step', attrs: {'aria-labelledby': 'tg-chat'}}, h('h4', {text: '2 · Your chat', attrs: {id: 'tg-chat'}}));
        if (s.paired && !ui.code) {
          chat.append(
            h('p', {className: 'tg-line', text: `Paired: your own chat with ${s.bot}. What you write there goes to the Mayor, and decisions come there too.`}),
            h('p', {className: 'tg-hint', text: 'The chat shows in Devices as Telegram, where you can revoke it.'}),
            btn('Pair a different chat', 'pair', () => void getCode(), 'tg-quiet'));
        } else if (ui.code) {
          chat.append(codeBox());
        } else {
          chat.append(h('p', {className: 'tg-line', text: `Get a one-time code, then send it to ${s.bot} from your own Telegram account.`}), btn('Get a pairing code', 'pair', () => void getCode(), 'primary'));
        }
        parts.push(chat);
        // Remove: the token leaves this computer and the chat is unpaired.
        parts.push(h('section', {className: 'cx-section tg-step'},
          h('h4', {text: 'Stop using Telegram'}),
          h('p', {className: 'tg-hint', text: 'Removes the bot token from this computer and unpairs the chat. The bot itself stays in your Telegram account.'}),
          btn('Remove Telegram', 'remove', () => void remove(), 'cx-remove tg-remove')));
      }
    }
    const focusKey = doc.activeElement?.dataset?.key;
    body.replaceChildren(...parts.filter(Boolean));
    if (focusKey) [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  async function getCode() {
    await act('pair', async () => {
      ui.code = await send('pair');
      ui.msg = null;
      startPolling();
    });
  }

  async function remove() {
    const yes = await ask({title: 'Remove Telegram?', message: 'Clowder stops listening to the bot, unpairs your chat and deletes the token from this computer.', confirmLabel: 'Remove Telegram', cancelLabel: 'Keep it', danger: true});
    if (!yes) return;
    await act('remove', async () => {
      stopPolling(); ui.code = null;
      ui.status = await send('remove');
      ui.msg = {text: 'Telegram is removed.'};
    });
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.loaded = false; paint();
    await refresh();
  }

  // Only the host gets an answer; anywhere else the entry stays hidden.
  async function probe() {
    try { await read(); if (button) button.hidden = false; return true; } catch { return false; }
  }

  if (button) button.addEventListener('click', () => void open());
  return {open, close: () => dialog.close(), refresh, probe, dialog};
}

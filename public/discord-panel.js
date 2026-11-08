// Discord (plan 3.5, D7): talk to the Mayor and answer decisions from a direct message with your own bot. ☰ > Devices & AI > Discord opens this
// panel on the host computer only: the bot token is a secret and the pairing code makes an owner device, as the phone invite does.
// Three steps, each shown once the one before it is done: paste the bot token from the Discord Developer Portal, make the bot reachable (share a
// server with it, or install it to your own account) so you can DM it, then DM it the one-time code. The paired DM shows here and in Devices as
// "Discord", where it can be revoked. Remove takes the token off this computer.
// Routes: src/discord.ts through chat-channel.ts (GET /api/discord {configured, bot, paired, connected, error}; POST token, pair, remove).
// The pure helpers are exported for Node tests; the DOM is built with createElement and textContent only, so nothing Discord says becomes markup.
import {el} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';
import {untilText} from './telegram-panel.js';

export const HOST_ONLY = 'Discord is set up on the host computer.';
export const PORTAL = 'https://discord.com/developers/applications';
const POLL_MS = 2000;

/** The status line: a tone for the dot and one plain sentence. status is GET /api/discord. */
export function statusLine(status) {
  if (!status?.configured) return {tone: 'off', text: 'Not set up'};
  const bot = status.bot || 'Your bot';
  if (status.error) return {tone: 'error', text: `Discord says: ${status.error}`};
  if (status.paired) return {tone: status.connected ? 'ok' : 'warn', text: status.connected ? `Paired with your DM on ${bot}` : `Paired with ${bot}, reconnecting to Discord…`};
  if (status.connected) return {tone: 'warn', text: `${bot} is online. Pair your DM next.`};
  return {tone: 'warn', text: `${bot} is not connected yet.`};
}

function injectStyles(doc) {
  if (!doc?.head || doc.querySelector('link[data-discord-panel]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('discord-panel.css', import.meta.url).href;
  link.dataset.discordPanel = '';
  doc.head.append(link);
}

const h = (tag, props, ...children) => el(tag, props, children.flat().filter(c => c !== null && c !== undefined && c !== false));

/** button: the ☰ entry, shown once the host's route answers. Returns {open, close, refresh, probe, dialog}. */
export function createDiscordPanel({button = null, doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), ask = confirmDialog, now = () => Date.now()} = {}) {
  injectStyles(doc);
  const ui = {status: null, denied: false, code: null, busy: '', msg: null, tokenMsg: null, loaded: false, changing: false};
  let poll = 0;

  const read = async () => {
    const response = await fetchImpl('/api/discord', {cache: 'no-store'});
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) throw Object.assign(new Error(HOST_ONLY), {status: 403});
    if (!response.ok) throw new Error(data.error || 'Discord settings could not load.');
    return data;
  };
  const send = async (path, body = {}) => {
    const response = await fetchImpl(`/api/discord/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Town-Action': 'owner'}, body: JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) throw new Error(HOST_ONLY);
    if (!response.ok) throw new Error(data.error || 'That did not work.');
    return data;
  };

  const back = h('button', {className: 'back-pill phone-only', text: '← Town', attrs: {type: 'button', 'aria-label': 'Back to town'}});
  const closeX = h('button', {className: 'close-x desk-only', text: '×', attrs: {type: 'button', 'aria-label': 'Close Discord'}});
  const body = h('div', {className: 'dc-body'});
  const dialog = h('dialog', {className: 'discord-dialog', attrs: {id: 'discord-dialog', 'aria-labelledby': 'discord-title'}},
    h('div', {className: 'treasury-dialog-title dc-top'}, back, h('span', {className: 'eyebrow', text: 'OUTSIDE CHANNEL'}), closeX),
    h('h2', {text: 'Discord', attrs: {id: 'discord-title'}}),
    h('p', {className: 'dc-lede', text: 'Talk to the Mayor and answer decisions from a direct message with your own Discord bot. Only the DM you pair is heard; servers, other people and other bots are ignored. Decisions that publish, pay or delete still open in Clowder.'}),
    body);
  back.onclick = () => dialog.close();
  closeX.onclick = () => dialog.close();
  doc.body.append(dialog);
  dialog.addEventListener('close', () => { stopPolling(); ui.code = null; ui.msg = null; ui.tokenMsg = null; ui.changing = false; body.replaceChildren(); });

  function stopPolling() { clearTimeout(poll); poll = 0; }
  // While a code is open, the status is read every 2 seconds until the DM pairs or the code runs out.
  function startPolling() {
    stopPolling();
    const tick = async () => {
      poll = 0;
      if (!dialog.open || !ui.code) return;
      if (now() > ui.code.expiresAt) { ui.code = null; ui.msg = {text: 'The code ran out. Get a new one to pair your DM.', bad: true}; paint(); return; }
      await refresh();
      if (ui.status?.paired) { ui.code = null; ui.msg = {text: 'Paired. Say hello to the Mayor from Discord.'}; paint(); return; }
      poll = setTimeout(tick, POLL_MS);
    };
    poll = setTimeout(tick, POLL_MS);
  }

  async function refresh() {
    try { ui.status = await read(); ui.denied = false; } catch (error) { ui.denied = error.status === 403; ui.msg = {text: error.message, bad: true}; }
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
    const input = h('input', {className: 'dc-token', attrs: {type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '100', placeholder: 'MTA1…', 'aria-label': 'Bot token from the Discord Developer Portal'}});
    const save = h('button', {className: 'primary', text: again ? 'Save new token' : 'Save token', attrs: {type: 'submit'}});
    save.disabled = !!ui.busy;
    const form = h('form', {className: 'dc-token-form', attrs: {novalidate: ''}}, input, save);
    form.onsubmit = e => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) { ui.tokenMsg = {text: 'Paste the bot token from the Developer Portal.', bad: true}; paint(); return; }
      ui.tokenMsg = null;
      void act('token', async () => {
        try { ui.status = await send('token', {token}); } catch (error) { ui.tokenMsg = {text: error.message, bad: true}; return; }
        ui.changing = false; ui.code = null; ui.msg = {text: `Saved. Clowder now listens to ${ui.status.bot || 'your bot'}.`};
      });
    };
    return h('div', {className: 'dc-token-box'},
      again ? null : h('ol', {className: 'dc-steps'},
        h('li', {text: 'In the Discord Developer Portal, choose New Application and give it any name.'}),
        h('li', {text: 'Open Bot, choose Reset Token and copy the token. Clowder checks it with Discord before saving.'})),
      again ? null : h('a', {className: 'cx-open dc-open', text: 'Open the Developer Portal ↗', attrs: {href: PORTAL, target: '_blank', rel: 'noopener noreferrer'}}),
      form,
      msgNode(ui.tokenMsg));
  }

  // Discord lets you DM a bot only when you can reach it: a server you share with it, or the bot installed to your own account.
  function reachBox(bot) {
    return h('div', {className: 'dc-reach'},
      h('p', {className: 'dc-line', text: `Before you can DM ${bot}, Discord needs a way to reach it. Do one of these once:`}),
      h('ul', {className: 'dc-steps'},
        h('li', {text: 'Share a server with it: in the Developer Portal open Installation, copy the install link, and add the bot to a server you are in. It ignores everything said in servers.'}),
        h('li', {text: 'Or install it to your account: in Installation turn on User Install, then open the install link and choose Add to my apps.'})),
      h('p', {className: 'dc-hint', text: `Then open ${bot}’s profile in Discord and choose Message.`}));
  }

  function codeBox() {
    const {code, bot, expiresAt} = ui.code, until = untilText(expiresAt);
    const copy = btn('Copy code', 'copy', async () => {
      try { await win.navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy it by hand'; }
    });
    return h('div', {className: 'dc-code-box'},
      h('p', {className: 'dc-code', text: code, attrs: {'aria-label': `Pairing code ${String(code).split('').join(' ')}`}}),
      h('p', {className: 'dc-hint', text: `Send this code to ${bot || 'your bot'} in a direct message. It works once${until ? `, until ${until}` : ''}.`}),
      h('div', {className: 'dc-actions'}, copy),
      h('p', {className: 'dc-wait', text: 'Waiting for your message…', attrs: {role: 'status'}}));
  }

  function paint() {
    if (!dialog.open && ui.loaded) return;
    const s = ui.status, line = statusLine(s), bot = s?.bot || 'your bot';
    const parts = [];
    if (ui.denied) parts.push(msgNode(ui.msg));
    else if (!ui.loaded) parts.push(h('p', {className: 'cx-empty muted', text: 'Loading…', attrs: {role: 'status'}}));
    else {
      parts.push(h('p', {className: 'cx-status dc-status'}, h('span', {className: 'cx-dot', attrs: {'data-tone': line.tone, 'aria-hidden': 'true'}}), h('span', {text: line.text})));
      parts.push(msgNode(ui.msg));
      const step1 = h('section', {className: 'cx-section dc-step', attrs: {'aria-labelledby': 'dc-bot'}}, h('h4', {text: '1 · Your bot', attrs: {id: 'dc-bot'}}));
      if (!s?.configured) step1.append(tokenForm(false));
      else {
        step1.append(h('p', {className: 'dc-line'}, 'Bot: ', h('strong', {text: bot})));
        step1.append(ui.changing ? tokenForm(true) : btn('Change token', 'change', () => { ui.changing = true; ui.tokenMsg = null; paint(); }, 'dc-quiet'));
      }
      parts.push(step1);
      if (s?.configured) {
        if (!s.paired) parts.push(h('section', {className: 'cx-section dc-step', attrs: {'aria-labelledby': 'dc-reach'}}, h('h4', {text: '2 · Reach your bot', attrs: {id: 'dc-reach'}}), reachBox(bot)));
        const step3 = h('section', {className: 'cx-section dc-step', attrs: {'aria-labelledby': 'dc-dm'}}, h('h4', {text: s.paired ? '2 · Your DM' : '3 · Your DM', attrs: {id: 'dc-dm'}}));
        if (s.paired && !ui.code) {
          step3.append(
            h('p', {className: 'dc-line', text: `Paired: your own DM with ${bot}. What you write there goes to the Mayor, and decisions come there too.`}),
            h('p', {className: 'dc-hint', text: 'The DM shows in Devices as Discord, where you can revoke it.'}),
            btn('Pair a different DM', 'pair', () => void getCode(), 'dc-quiet'));
        } else if (ui.code) step3.append(codeBox());
        else step3.append(h('p', {className: 'dc-line', text: `Get a one-time code, then send it to ${bot} in a direct message from your own Discord account.`}), btn('Get a pairing code', 'pair', () => void getCode(), 'primary'));
        parts.push(step3);
        parts.push(h('section', {className: 'cx-section dc-step'},
          h('h4', {text: 'Stop using Discord'}),
          h('p', {className: 'dc-hint', text: 'Removes the bot token from this computer and unpairs the DM. The bot itself stays in your Developer Portal.'}),
          btn('Remove Discord', 'remove', () => void remove(), 'cx-remove dc-remove')));
      }
    }
    const focusKey = doc.activeElement?.dataset?.key;
    body.replaceChildren(...parts.filter(Boolean));
    if (focusKey) [...body.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  async function getCode() {
    await act('pair', async () => { ui.code = await send('pair'); ui.msg = null; startPolling(); });
  }

  async function remove() {
    const yes = await ask({title: 'Remove Discord?', message: 'Clowder stops listening to the bot, unpairs your DM and deletes the token from this computer.', confirmLabel: 'Remove Discord', cancelLabel: 'Keep it', danger: true});
    if (!yes) return;
    await act('remove', async () => { stopPolling(); ui.code = null; ui.status = await send('remove'); ui.msg = {text: 'Discord is removed.'}; });
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

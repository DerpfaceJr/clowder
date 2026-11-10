// People (plan 10.11, §4.4–4.6 of docs/for-you-and-teams-plan.md): the owner's panel for the people of a shared world, and a member's own view.
// The owner opens ☰ > Devices & AI > People on the host computer: add a person as a member or a viewer, make their one-time invite (a link to copy
// and its QR), set or clear a member's monthly token budget, remove a person behind a confirm, and see who is online now. Routes, all host-only:
// GET/POST /api/remote/people, POST /api/remote/people/:id/invite (needs remote access on), /remove and /budget (src/server.ts, src/people.ts).
// Who is online comes from the transient presence frame (state.presence, public/state-delta.js); only the owner's pages get ids in it.
// A member's page (state.me.role 'member', from /api/state) reaches chat with the Mayor, its own Requests and Goals and its own decisions; every
// other route answers 403 (src/access.ts MEMBER_ROUTES). Its own view, Yours, holds exactly that, and the body's member class hides the owner's
// surfaces. Names and everything else a person or a cat wrote are drawn with textContent only (el() in projects-panel.js), never as markup.
// Pure helpers are exported for Node tests; nothing touches the DOM at import. devices-status.js starts both, so app.js needs no line of its own.
import {copyBox, devicesEntry, ensureStyles, h, msgNode, ownerDialog, readJson, sendJson, switchControl} from './owner-dialog.js';
import {confirmDialog} from './dialogs.js';
import {capDraft} from './usage-panel.js';
import {startingReasoning} from './ai-settings.js';

const list = v => (Array.isArray(v) ? v : []);
const enc = encodeURIComponent;
const clip = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ---- Pure helpers ----

/** The two roles the owner can give (D18: no admin in G1), with what each may do. */
export const ROLES = [
  ['member', 'Member', 'Talks to the Mayor, files Requests and Goals within a budget, and answers decisions on their own work.'],
  ['viewer', 'Viewer', 'Watches the town. Changes nothing.'],
];
export const roleLabel = role => (role === 'owner' ? 'Owner' : ROLES.find(([r]) => r === role)?.[1] ?? 'Person');
export const START_REMOTE = 'Start remote access first.';
export const HOST_ONLY = 'People are managed on the host computer.';

/** A member's budget in words. Only members run work, so a viewer has none to show. */
export function budgetLine(person, locale) {
  if (person?.role !== 'member') return null;
  const b = person.budget;
  return Number.isInteger(b) && b > 0 ? `Budget: ${b.toLocaleString(locale)} tokens a month. Past it, their new work waits for you.` : 'No budget of their own. The town’s monthly cap still applies.';
}

/** The budget field: plain numbers, thousands (200k) or millions (2m). {tokens} or {error}; it never posts a bad number. */
export function budgetDraft(text) {
  const draft = capDraft(text);
  return draft.error ? {error: 'Enter a whole number of tokens a month, such as 200,000 or 200k.'} : {tokens: draft.body.tokens};
}

/** Who is online, from the presence frame: [{id?, name, role}], or null before the live feed has said. */
export function onlineNow(presence) {
  if (!Array.isArray(presence)) return null;
  return presence.filter(p => p && typeof p.name === 'string' && p.name.trim());
}
/** The line over the online list. ownId: this page's own person (the owner's page knows it). */
export function onlineLine(presence, ownId) {
  const all = onlineNow(presence);
  if (!all) return 'Who is online shows once the live feed connects.';
  const others = all.filter(p => !ownId || p.id !== ownId);
  if (!others.length) return 'Only you are here right now.';
  return `${others.length} ${others.length === 1 ? 'other person is' : 'other people are'} here now.`;
}

/** What /api/state says this page is: owner, member or viewer. A server from before me reads by readOnly. */
export function roleOf(state) {
  const role = state?.me?.role;
  if (['owner', 'member', 'viewer'].includes(role)) return role;
  return state?.readOnly ? 'viewer' : 'owner';
}

/** The answers a member may give: never an Always allow, which changes the owner's settings (engine.ts decide). */
export const memberOptions = a => list(a?.options).filter(o => typeof o === 'string' && o.trim() && !/^always allow/i.test(o));
/** A refusal, in decide()'s and the decision strip's sense. */
export const isRefusal = text => /^(reject|decline|deny|no\b)/i.test(String(text ?? ''));

/** Town.mayDecide (src/engine.ts) on the page: a member answers a decision only in a tree they started, never an owner-only one, and only a
 *  plain question, a goal, or a connector call. The server checks again; this only says which cards get buttons. */
export function mayAnswer(a, task, meId) {
  if (!a || !task || !meId || task.by !== meId || a.ownerOnly) return false;
  return a.gate === undefined || a.gate === 'goal' || (a.gate === 'connector' && String(a.call?.function?.name ?? '').startsWith('mcp__'));
}

/** A request's status in words. */
export function statusWords(t) {
  if (t?.held === 'budget') return 'Held: past your monthly budget. The owner decides.';
  if (t?.held === 'cap') return 'Held: the town’s monthly cap is reached.';
  return {queued: 'Waiting for the Mayor', pending: 'Waiting to start', running: 'In progress', waiting: 'Waiting on a decision', waiting_child: 'Cats are working on it',
    interrupted: 'Interrupted', done: 'Done', failed: 'Did not finish', cancelled: 'Stopped'}[t?.status] ?? 'In progress';
}
const GOAL_WORDS = {active: 'Active', paused: 'Paused', achieved: 'Achieved', stopped: 'Stopped'};
export function goalWords(g) {
  const rounds = Number(g?.rounds) || 0;
  return `${GOAL_WORDS[g?.status] ?? 'Active'} · ${rounds} ${rounds === 1 ? 'round' : 'rounds'}`;
}

/** A member's own work. tasks: the state's unfinished tasks; mayorTasks: the Mayor's recent ones from GET /api/chats/mayor, finished included.
 *  Requests are the root tasks they started (goal rounds sit under Goals), newest first; decisions are the pending ones in their trees. */
export function ownWork(state, meId, mayorTasks = []) {
  if (!meId) return {requests: [], goals: [], decisions: []};
  const byId = new Map();
  for (const t of [...list(mayorTasks), ...list(state?.tasks)]) if (t?.id) byId.set(t.id, {...byId.get(t.id), ...t});
  const tasks = [...byId.values()];
  const requests = tasks.filter(t => t.by === meId && !t.parent && !t.goal).reverse();
  const goals = list(state?.goals).filter(g => g?.by === meId).slice().reverse();
  const decisions = list(state?.approvals).filter(a => a?.status === 'pending').map(a => ({a, task: byId.get(a.task)}))
    .filter(({task}) => task?.by === meId).map(({a, task}) => ({a, canAnswer: mayAnswer(a, task, meId)}));
  return {requests, goals, decisions};
}

/** A refused call in plain words: the server's own sentence for a 403, a fresh-invite hint for a 401. */
export function refusalText(error) {
  if (error?.status === 401) return 'This device is no longer paired. Ask the owner for a new invite.';
  if (error?.status === 403) return error.message && error.message !== 'That did not work.' ? error.message : 'That part of the town is the owner’s.';
  // No answer at all (fetch rejects): the gate is closed, as the header says (plan 10.10). Nothing queues in G1, so the text stays to send again.
  if (error?.status === undefined && error?.name === 'TypeError') return 'The town did not answer: the host computer may be asleep. Send it again when the gate opens.';
  return error?.message || 'That did not work. Try again.';
}

/** The reasoning a member's message goes with: the Mayor's own choice, else the town default, else a model that answers (ai-settings.js). */
export function memberMode(state) {
  const mayor = list(state?.cats).find(c => c.id === 'mayor');
  return startingReasoning(state?.models, state?.townDefault, mayor?.ai, null);
}

// ---- The owner's People panel ----

/** ☰ > Devices & AI > People. win: for the clipboard, town-state events and openSurface('devices'). */
export function createPeoplePanel({doc = document, win = globalThis.window, fetchImpl = (...a) => fetch(...a), ask = confirmDialog, locale} = {}) {
  ensureStyles(doc, 'people-panel.css', 'people-panel');
  const ui = {people: [], loaded: false, error: null, busy: '', msgs: new Map(), invites: new Map(), budgets: new Set(), drafts: new Map(), presence: undefined, role: 'member'};
  const {dialog, body} = ownerDialog({doc, id: 'people-dialog', eyebrow: 'THE PEOPLE', title: 'People',
    lede: 'People join this town as members or viewers. Each one pairs their own device with a one-time invite. Your accounts stay yours unless you mark one for the team in Accounts & connections.',
    onClose: () => { ui.msgs.clear(); ui.invites.clear(); ui.budgets.clear(); }});
  win?.addEventListener?.('town-state', event => {
    const next = event?.detail?.next?.presence;
    if (JSON.stringify(next) === JSON.stringify(ui.presence)) return;
    ui.presence = next;
    if (dialog.open) paint();
  });

  async function refresh() {
    const r = await readJson(fetchImpl, '/api/remote/people').catch(error => ({ok: false, status: 0, data: {error: error.message}}));
    if (r.ok) { ui.people = list(r.data.people); ui.error = null; } else ui.error = r.status === 403 || r.status === 401 ? HOST_ONLY : r.data.error || 'People could not load.';
    ui.loaded = true;
    paint();
  }

  async function act(key, slot, work) {
    if (ui.busy) return;
    ui.busy = key; ui.msgs.delete(slot); paint();
    try { await work(); } catch (error) { ui.msgs.set(slot, {text: error.status === 403 ? HOST_ONLY : error.message || 'That did not work.', bad: true, remote: error.message === START_REMOTE}); }
    finally { ui.busy = ''; }
    paint();
  }

  const btn = (text, key, onclick, {className = '', label, extra = {}} = {}) => {
    const node = h('button', {className, text, attrs: {type: 'button', 'data-key': key, ...(label ? {'aria-label': label} : {}), ...extra}});
    node.disabled = !!ui.busy;
    node.onclick = onclick;
    return node;
  };
  const slotMsg = slot => {
    const m = ui.msgs.get(slot);
    if (!m) return null;
    return [msgNode(m, slot), m.remote ? h('div', {className: 'op-actions'}, btn('Open Devices', `${slot}:devices`, () => { dialog.close(); win?.openSurface?.('devices'); })) : null];
  };

  function paint() {
    if (!dialog.open && ui.loaded) return;
    const parts = [];
    if (!ui.loaded) parts.push(h('p', {className: 'cx-empty muted', text: 'Loading people…', attrs: {role: 'status'}}));
    else if (ui.error && !ui.people.length) parts.push(msgNode({text: ui.error, bad: true}));
    else parts.push(onlineSection(), peopleSection(), addSection());
    keepFocus(doc, body, () => body.replaceChildren(...parts.flat().filter(Boolean)));
  }

  function onlineSection() {
    const all = onlineNow(ui.presence);
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'pp-online-title'}},
      h('h4', {text: 'Online now', attrs: {id: 'pp-online-title'}}),
      h('p', {className: 'op-hint', text: onlineLine(ui.presence, 'owner'), attrs: {role: 'status'}}),
      all?.length ? h('ul', {className: 'pp-online', attrs: {'aria-label': 'Online now'}}, all.map(p =>
        h('li', {}, h('span', {className: 'cx-dot', attrs: {'data-tone': 'ok', 'aria-hidden': 'true'}}), h('span', {className: 'pp-name', text: p.id === 'owner' ? 'You' : p.name}), h('span', {className: 'pp-role', text: roleLabel(p.role)})))) : null);
  }

  function peopleSection() {
    const online = new Set(list(onlineNow(ui.presence)).map(p => p.id).filter(Boolean));
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'pp-people-title'}},
      h('h4', {text: 'People in this town', attrs: {id: 'pp-people-title'}}),
      ui.error ? msgNode({text: ui.error, bad: true}) : null,
      h('ul', {className: 'op-list'}, ui.people.map(p => personRow(p, online.has(p.id)))),
      ui.people.length <= 1 ? h('p', {className: 'op-hint', text: 'Only you so far. Add a person below, then send them their invite.'}) : null);
  }

  function personRow(p, online) {
    const owner = p.id === 'owner', slot = `p:${p.id}`, budget = budgetLine(p, locale);
    return h('li', {className: 'cx-card op-row', attrs: {'data-id': p.id}},
      h('div', {className: 'op-row-head'},
        h('div', {className: 'pp-who'}, h('strong', {className: 'pp-name', text: owner ? 'You' : p.name}), h('span', {className: 'pp-role', text: owner ? 'Owner' : roleLabel(p.role)})),
        online ? h('p', {className: 'op-status'}, h('span', {className: 'cx-dot', attrs: {'data-tone': 'ok', 'aria-hidden': 'true'}}), h('span', {text: 'Online'})) : null),
      budget ? h('p', {className: 'op-hint', text: budget}) : null,
      owner ? null : h('div', {className: 'op-actions'},
        btn('Invite', `${slot}:invite`, () => void invite(p), {label: `Invite ${p.name}`}),
        p.role === 'member' ? btn('Budget', `${slot}:budget`, () => { if (ui.budgets.has(p.id)) ui.budgets.delete(p.id); else ui.budgets.add(p.id); paint(); }, {label: `Budget for ${p.name}`, extra: {'aria-expanded': String(ui.budgets.has(p.id))}}) : null,
        btn('Remove', `${slot}:remove`, () => void remove(p), {className: 'op-end cx-remove', label: `Remove ${p.name}`})),
      ui.invites.has(p.id) ? inviteBox(p, ui.invites.get(p.id)) : null,
      ui.budgets.has(p.id) ? budgetForm(p, slot) : null,
      slotMsg(slot));
  }

  // The link to copy and its QR. The QR is the server's SVG drawn as an image, so nothing in it can run on this page.
  function inviteBox(p, inv) {
    const until = new Date(inv.expiresAt).toLocaleTimeString(locale, {hour: 'numeric', minute: '2-digit'});
    const img = inv.qr ? h('img', {attrs: {alt: `QR code for ${p.name}’s invite link`, width: '164', height: '164'}}) : null;
    if (img) img.src = `data:image/svg+xml;charset=utf-8,${enc(inv.qr)}`;
    return h('div', {className: 'pp-invite'},
      h('p', {text: `Send ${p.name} this link. It pairs one device as a ${roleLabel(p.role).toLowerCase()}, works once, and ends at ${until}. A new invite replaces it.`}),
      copyBox(win, `Invite link for ${p.name}`, inv.link),
      img ? h('div', {className: 'pair-qr pp-qr'}, img) : null,
      img ? h('p', {className: 'pair-qr-caption', text: 'Or they scan this with their phone’s camera'}) : null,
      inv.code ? h('p', {className: 'op-hint', text: `Code: ${inv.code}`}) : null);
  }

  function budgetForm(p, slot) {
    const key = `${slot}:budget-input`;
    const field = h('input', {attrs: {type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: '20', placeholder: 'Such as 200k', 'aria-label': `Monthly token budget for ${p.name}`, 'data-key': key}});
    field.value = ui.drafts.get(key) ?? (Number.isInteger(p.budget) ? String(p.budget) : '');
    field.oninput = () => ui.drafts.set(key, field.value);
    const save = h('button', {className: 'primary', text: 'Save budget', attrs: {type: 'submit', 'data-key': `${slot}:budget-save`}});
    save.disabled = !!ui.busy;
    const form = h('form', {className: 'op-form', attrs: {novalidate: ''}},
      h('label', {className: 'op-field'}, h('span', {text: 'Tokens a month'}), field, h('small', {text: 'Past it, their new work is held with one card for you. The town’s monthly cap still applies to everyone.'})),
      h('div', {className: 'op-actions'}, save, Number.isInteger(p.budget) ? btn('Clear budget', `${slot}:budget-clear`, () => void setBudget(p, null, slot), {label: `Clear ${p.name}’s budget`}) : null));
    form.onsubmit = event => {
      event?.preventDefault?.();
      const draft = budgetDraft(ui.drafts.get(key) ?? field.value);
      if (draft.error) { ui.msgs.set(slot, {text: draft.error, bad: true}); paint(); return; }
      void setBudget(p, draft.tokens, slot);
    };
    return form;
  }

  function addSection() {
    const key = 'add:name', field = h('input', {attrs: {type: 'text', autocomplete: 'off', maxlength: '60', placeholder: 'Their name', 'aria-label': 'Name of the person to add', 'data-key': key}});
    field.value = ui.drafts.get(key) ?? '';
    field.oninput = () => ui.drafts.set(key, field.value);
    const pick = ([role, label]) => btn(label, `add:role:${role}`, () => { ui.role = role; paint(); }, {extra: {'aria-pressed': String(ui.role === role)}});
    const submit = h('button', {className: 'primary', text: 'Add person', attrs: {type: 'submit', 'data-key': 'add:submit'}});
    submit.disabled = !!ui.busy;
    const form = h('form', {className: 'op-form', attrs: {novalidate: ''}},
      h('label', {className: 'op-field'}, h('span', {text: 'Name'}), field),
      h('div', {className: 'op-field'}, h('span', {text: 'Role', attrs: {id: 'pp-role-label'}}),
        h('div', {className: 'cx-seg op-seg', attrs: {role: 'group', 'aria-labelledby': 'pp-role-label'}}, ROLES.map(pick)),
        h('small', {text: ROLES.find(([r]) => r === ui.role)?.[2] ?? ''})),
      h('div', {className: 'op-actions'}, submit));
    form.onsubmit = event => {
      event?.preventDefault?.();
      const name = (ui.drafts.get(key) ?? field.value ?? '').trim();
      if (!name) { ui.msgs.set('add', {text: 'Name this person first.', bad: true}); paint(); return; }
      void act('add', 'add', async () => {
        const person = await sendJson(fetchImpl, '/api/remote/people', {name, role: ui.role});
        ui.drafts.delete(key);
        await refresh();
        ui.msgs.set(`p:${person.id}`, {text: `Added ${person.name} as a ${roleLabel(person.role).toLowerCase()}. Make their invite when you’re ready to send it.`});
      });
    };
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'pp-add-title'}},
      h('h4', {text: 'Add a person', attrs: {id: 'pp-add-title'}}), form, slotMsg('add'));
  }

  const invite = p => act(`p:${p.id}:invite`, `p:${p.id}`, async () => {
    ui.invites.set(p.id, await sendJson(fetchImpl, `/api/remote/people/${enc(p.id)}/invite`));
  });
  const setBudget = (p, tokens, slot) => act(`${slot}:budget`, slot, async () => {
    const r = await sendJson(fetchImpl, `/api/remote/people/${enc(p.id)}/budget`, {tokens});
    if (Array.isArray(r?.people)) ui.people = r.people; else await refresh();
    ui.budgets.delete(p.id); ui.drafts.delete(`${slot}:budget-input`);
    ui.msgs.set(slot, {text: tokens === null ? `${p.name} has no budget of their own now.` : `${p.name}’s budget is ${tokens.toLocaleString(locale)} tokens a month.`});
  });
  async function remove(p) {
    const yes = await ask({title: `Remove ${p.name}?`, message: 'Their devices lose access on their next request and their invite stops working. Their earlier work keeps their name.', confirmLabel: 'Remove', cancelLabel: 'Keep them', danger: true});
    if (!yes) return;
    await act(`p:${p.id}:remove`, `p:${p.id}`, async () => {
      await sendJson(fetchImpl, `/api/remote/people/${enc(p.id)}/remove`);
      ui.invites.delete(p.id);
      await refresh();
      ui.msgs.set('add', {text: `Removed ${p.name}.`});
    });
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.loaded = false; paint();
    await refresh();
  }
  async function probe() {
    const r = await readJson(fetchImpl, '/api/remote/people').catch(() => ({ok: false}));
    if (r.ok) ui.people = list(r.data.people);
    return r.ok;
  }
  const summary = () => {
    const n = ui.people.filter(p => p.id !== 'owner').length;
    return n ? `${n} ${n === 1 ? 'person' : 'people'} besides you · invites and budgets` : 'Invite people to this town and set their budgets';
  };
  return {open, close: () => dialog.close(), refresh, probe, summary, dialog};
}

// ---- A member's own view ----

/** Yours: a member's Mayor chat box, their decisions, Requests and Goals. Shown only on a member's page (roleOf). */
export function createMemberView({doc = document, win = globalThis.window, fetchImpl = (...a) => fetch(...a), locale} = {}) {
  ensureStyles(doc, 'people-panel.css', 'people-panel');
  const ui = {state: null, role: null, mayorTasks: [], msgs: new Map(), busy: '', draft: '', goal: false, answers: new Map()};
  const {dialog, body, lede} = ownerDialog({doc, id: 'member-dialog', eyebrow: 'YOUR PART OF THE TOWN', title: 'Yours',
    lede: 'Ask the Mayor, follow your Requests and Goals, and answer decisions on your own work. The rest of the town is the owner’s.',
    onClose: () => ui.msgs.clear()});
  const meId = () => ui.state?.me?.id;

  // The dock entry, where Inbox (the owner's) sits on an owner's page, and a pointer where the owner's composer sits in the chat panel.
  const entry = dockEntry(doc, () => void open());
  const pointer = chatPointer(doc, () => void open());

  function apply(state) {
    ui.state = state;
    const role = roleOf(state), member = role === 'member';
    if (role !== ui.role) {
      ui.role = role;
      doc.body?.classList?.toggle?.('member', member);
      if (entry) entry.hidden = !member;
      if (pointer) pointer.hidden = !member;
      if (!member && dialog.open) dialog.close();
    }
    if (!member) return;
    const name = state?.me?.name;
    lede.textContent = `${name ? `You’re ${name}, a member here. ` : ''}Ask the Mayor, follow your Requests and Goals, and answer decisions on your own work. The rest of the town is the owner’s.`;
    const work = ownWork(state, meId(), ui.mayorTasks), waiting = work.decisions.filter(d => d.canAnswer).length;
    if (entry) entry.setAttribute('aria-label', waiting ? `Yours, ${waiting} ${waiting === 1 ? 'decision waits' : 'decisions wait'} for you` : 'Yours');
    // Every journal event is a frame: only one that changes the member's own work repaints, so a message being typed keeps its place.
    const key = JSON.stringify([work, list(state?.cats).map(c => [c.id, c.name])]);
    if (key === ui.painted) return;
    if (dialog.open) paint();
  }
  win?.addEventListener?.('town-state', event => { if (event?.detail?.next) apply(event.detail.next); });

  async function loadMayor() {
    const r = await readJson(fetchImpl, '/api/chats/mayor?limit=1').catch(() => ({ok: false}));
    if (r.ok) ui.mayorTasks = list(r.data.tasks);
  }

  async function act(key, slot, work) {
    if (ui.busy) return;
    ui.busy = key; ui.msgs.delete(slot); paint();
    try { await work(); } catch (error) { ui.msgs.set(slot, {text: refusalText(error), bad: true}); }
    finally { ui.busy = ''; }
    paint();
  }

  function paint() {
    if (!dialog.open) return;
    const work = ownWork(ui.state, meId(), ui.mayorTasks);
    ui.painted = JSON.stringify([work, list(ui.state?.cats).map(c => [c.id, c.name])]);
    keepFocus(doc, body, () => body.replaceChildren(...[askSection(), decisionsSection(work.decisions), requestsSection(work.requests), goalsSection(work.goals)].flat().filter(Boolean)));
  }

  function askSection() {
    const text = h('textarea', {attrs: {rows: '3', maxlength: '12000', placeholder: 'Ask the Mayor for something…', 'aria-label': 'Message to the Mayor', 'data-key': 'ask:text'}});
    text.value = ui.draft;
    text.oninput = () => { ui.draft = text.value; };
    const send = h('button', {className: 'primary', text: 'Send to the Mayor', attrs: {type: 'submit', 'data-key': 'ask:send'}});
    send.disabled = !!ui.busy;
    const form = h('form', {className: 'op-form', attrs: {novalidate: ''}}, text,
      h('div', {className: 'op-actions'},
        switchControl({label: 'Make it a goal', checked: ui.goal, key: 'ask:goal', text: ['Make it a goal', 'Make it a goal'], onChange: on => { ui.goal = on; }}),
        h('span', {className: 'op-end'}, send)));
    form.onsubmit = event => {
      event?.preventDefault?.();
      const message = ui.draft.trim();
      if (!message) { ui.msgs.set('ask', {text: 'Write what you need first.', bad: true}); paint(); return; }
      const goal = ui.goal;
      void act('ask', 'ask', async () => {
        await sendJson(fetchImpl, '/api/chat', {cat: 'mayor', text: message, mode: memberMode(ui.state), goal});
        ui.draft = ''; ui.goal = false;
        ui.msgs.set('ask', {text: goal ? 'Sent as a goal. It shows under Your goals once the Mayor sets it up.' : 'Sent. The Mayor has your request.'});
        await loadMayor();
      });
    };
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'mv-ask-title'}}, h('h4', {text: 'Ask the Mayor', attrs: {id: 'mv-ask-title'}}), form, msgNode(ui.msgs.get('ask'), 'ask'));
  }

  function decisionsSection(decisions) {
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'mv-decisions-title'}},
      h('h4', {text: 'Your decisions', attrs: {id: 'mv-decisions-title'}}),
      decisions.length ? h('ul', {className: 'op-list'}, decisions.map(decisionRow)) : h('p', {className: 'op-hint', text: 'Nothing waits on you.'}));
  }

  function decisionRow({a, canAnswer}) {
    const cat = list(ui.state?.cats).find(c => c.id === a.cat)?.name ?? 'A cat', slot = `d:${a.id}`, options = memberOptions(a);
    const answer = value => act(slot, slot, async () => {
      await sendJson(fetchImpl, `/api/approvals/${enc(a.id)}`, {answer: value, approved: !isRefusal(value)});
      ui.msgs.set('decided', {text: `Answered ${cat}: ${value}.`});
    });
    let controls;
    if (!canAnswer) controls = h('p', {className: 'op-hint', text: a.ownerOnly ? 'This one waits for the owner: it needs an account or money only the owner can allow.' : 'This one waits for the owner.'});
    else if (options.length) controls = h('div', {className: 'op-actions', attrs: {role: 'group', 'aria-label': `Answer ${cat}`}},
      options.map((o, i) => { const b = h('button', {className: i === 0 && !isRefusal(o) ? 'primary' : '', text: o, attrs: {type: 'button', 'data-key': `${slot}:${i}`}}); b.disabled = !!ui.busy; b.onclick = () => void answer(o); return b; }));
    else {
      const key = `${slot}:text`, field = h('input', {attrs: {type: 'text', autocomplete: 'off', maxlength: '2000', 'aria-label': `Your answer to ${cat}`, 'data-key': key}});
      field.value = ui.answers.get(a.id) ?? '';
      field.oninput = () => ui.answers.set(a.id, field.value);
      const send = h('button', {className: 'primary', text: 'Send answer', attrs: {type: 'submit', 'data-key': `${slot}:send`}});
      send.disabled = !!ui.busy;
      controls = h('form', {className: 'pp-answer', attrs: {novalidate: ''}}, field, send);
      controls.onsubmit = event => { event?.preventDefault?.(); const value = (ui.answers.get(a.id) ?? '').trim(); if (value) void answer(value).then(() => ui.answers.delete(a.id)); };
    }
    return h('li', {className: 'cx-card op-row', attrs: {'data-id': a.id}},
      h('strong', {className: 'pp-name', text: `${cat} asks`}), h('p', {text: String(a.question ?? '')}), controls, msgNode(ui.msgs.get(slot), slot));
  }

  function requestsSection(requests) {
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'mv-requests-title'}},
      h('h4', {text: 'Your requests', attrs: {id: 'mv-requests-title'}}),
      msgNode(ui.msgs.get('decided')),
      requests.length ? h('ul', {className: 'op-list'}, requests.slice(0, 20).map(t => {
        const short = clip(t.text, 140), open = h('button', {text: 'Open', attrs: {type: 'button', 'aria-label': `Open: ${clip(t.text, 60)}`, 'data-key': `r:${t.id}`}});
        open.onclick = () => openThread(t.id);
        return h('li', {className: 'cx-card cx-row pp-request', attrs: {'data-id': t.id}},
          h('div', {className: 'cx-row-main'}, h('strong', {className: 'pp-text', text: short}), h('p', {className: 'op-hint', text: statusWords(t)})), open);
      })) : h('p', {className: 'op-hint', text: 'Nothing yet. Ask the Mayor above and it shows here.'}));
  }

  function goalsSection(goals) {
    return h('section', {className: 'cx-section', attrs: {'aria-labelledby': 'mv-goals-title'}},
      h('h4', {text: 'Your goals', attrs: {id: 'mv-goals-title'}}),
      goals.length ? h('ul', {className: 'op-list'}, goals.map(g => h('li', {className: 'cx-card op-row', attrs: {'data-id': g.id}},
        h('strong', {className: 'pp-text', text: clip(g.title, 140)}), h('p', {className: 'op-hint', text: goalWords(g)})))) : h('p', {className: 'op-hint', text: 'No goals yet. Switch on Make it a goal when you ask, and the Mayor keeps working on it in rounds.'}));
  }

  // #thread=<task> opens that request's thread in the chat panel (app.js takeLink, plan 8.10).
  function openThread(id) {
    dialog.close();
    if (win?.location) win.location.hash = `thread=${enc(id)}`;
  }

  async function open() {
    if (ui.role !== 'member') return;
    if (!dialog.open) dialog.showModal();
    paint();
    await loadMayor();
    paint();
  }
  return {open, close: () => dialog.close(), apply, dialog, entry, pointer};
}

// A repaint replaces the controls: the one that had focus gets it back by its data-key, and a text box keeps its caret.
function keepFocus(doc, root, repaint) {
  const active = doc.activeElement, key = active?.dataset?.key, caret = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  repaint();
  if (!key || active?.isConnected) return;
  const twin = [...root.querySelectorAll('[data-key]')].find(n => n.dataset.key === key && !n.disabled);
  twin?.focus?.({preventScroll: true});
  if (twin && caret) try { twin.setSelectionRange?.(...caret); } catch { /* not a text box */ }
}

// The dock button for a member, before Inbox. Hidden until the page is a member's.
function dockEntry(doc, onClick) {
  const dock = doc.querySelector?.('.town-dock'), before = doc.getElementById?.('toggle-quests');
  if (!dock) return null;
  const ico = h('span', {className: 'dock-ico', attrs: {'aria-hidden': 'true'}});
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
  for (const [k, v] of [['width', '20'], ['height', '20'], ['focusable', 'false']]) svg.setAttribute(k, v);
  use.setAttribute('href', '#i-star');
  svg.append(use); ico.append(svg);
  const button = h('button', {attrs: {id: 'toggle-member', type: 'button', 'aria-label': 'Yours', 'aria-haspopup': 'dialog'}}, ico, h('span', {className: 'dock-label', text: 'Yours'}));
  button.hidden = true;
  button.onclick = onClick;
  if (before?.parentNode === dock) dock.insertBefore?.(button, before) ?? dock.append(button); else dock.append(button);
  return button;
}

// In the chat panel, where the owner's composer is: a member asks the Mayor from Yours.
function chatPointer(doc, onClick) {
  const form = doc.getElementById?.('chat-form');
  if (!form?.parentNode) return null;
  const go = h('button', {className: 'primary', text: 'Ask the Mayor', attrs: {type: 'button'}});
  go.onclick = onClick;
  const box = h('div', {className: 'pp-member-ask', attrs: {id: 'member-ask'}}, h('p', {text: 'You’re a member here: you ask the Mayor and answer your own decisions from Yours.'}), go);
  box.hidden = true;
  form.parentNode.insertBefore?.(box, form) ?? form.after?.(box);
  return box;
}

/** Starts People (the owner's ☰ entry, shown once its host route answers) and Yours (shown on a member's page). */
export function initPeople(options = {}) {
  const doc = options.doc ?? document, panel = createPeoplePanel(options), member = createMemberView(options);
  const entry = devicesEntry(doc, {id: 'people-open', text: 'People', note: 'Invite people to this town and set their budgets', open: panel.open});
  void panel.probe().then(ok => { if (entry) { entry.hidden = !ok; if (ok) entry.setAttribute('data-note', panel.summary()); } });
  return {panel, member, entry};
}

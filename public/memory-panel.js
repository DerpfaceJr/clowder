// Memory (plan 3.7): the wiki pages the cats keep about people, projects, topics and the owner's preferences, which they read when they work.
// ☰ > Memory opens this panel. It reads and writes through the owner routes in src/wiki.ts: GET /api/wiki (every page and the merge
// suggestions, or ?q= for a search), GET and PUT /api/wiki/:slug, POST /api/wiki/:slug/forget, POST /api/wiki/merge {from,into} and
// POST /api/wiki/organise. Lines the owner wrote are marked as theirs (the server keeps that list). Forget and merge ask first. The old
// memory graph (memory-view.js) is the panel's second view, Graph, and a page's note sources open there. The pure helpers are exported
// for Node tests; the DOM is built with createElement and textContent only, so nothing a page says can become markup.
import {ago} from './quests-panel.js';
import {confirmDialog} from './dialogs.js';
import {registerSettingsSection} from './settings-menu.js';
import {ensureStyles, h, msgNode, ownerDialog, readJson, sendJson} from './owner-dialog.js';
import {emptyState} from './empty-state.js';

export const KINDS = [['person', 'People', 'Person'], ['project', 'Projects', 'Project'], ['topic', 'Topics', 'Topic'], ['preference', 'Preferences', 'Preference']];
export const DENIED = 'Memory is managed on the host computer or an owner device.';
const list = value => (Array.isArray(value) ? value : []);
const enc = encodeURIComponent;
const kindOf = k => (KINDS.some(([id]) => id === k) ? k : 'topic');
export const kindLabel = k => KINDS.find(([id]) => id === kindOf(k))[2];
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The list's sections: one per kind that has pages, in the order people, projects, topics, preferences. Pages keep the server's newest-first order. */
export function groupByKind(pages) {
  return KINDS.map(([kind, label]) => ({kind, label, pages: list(pages).filter(p => kindOf(p.kind) === kind)})).filter(g => g.pages.length);
}

/** Who last wrote a page, in plain words. */
export const byText = by => (by === 'owner' ? 'you' : by === 'organiser' ? 'the organiser' : String(by || 'the town'));

/** A row's second line: "12 lines · updated 2 h ago by you". */
export function pageMeta(page, now = Date.now()) {
  const lines = Number.isFinite(page?.lines) ? plural(page.lines, 'line') : null;
  const when = page?.updated ? `updated ${ago(page.updated, now)} by ${byText(page.by)}` : null;
  return [lines, when].filter(Boolean).join(' · ');
}

/** A body line split into text and [[page]] links, so a link can open its page. */
export function lineParts(line) {
  const out = [];
  let last = 0;
  for (const m of String(line ?? '').matchAll(/\[\[([a-z0-9][a-z0-9-]{0,59})\]\]/g)) {
    if (m.index > last) out.push({text: line.slice(last, m.index)});
    out.push({link: m[1]});
    last = m.index + m[0].length;
  }
  if (last < String(line ?? '').length) out.push({text: String(line).slice(last)});
  return out;
}
/** The server's own line split (memory.ts wikiLines): trimmed, blank lines dropped. */
export const bodyLines = body => String(body ?? '').split('\n').map(l => l.trim()).filter(Boolean);

/** A line as shown: the Markdown bullet the organiser writes ("- ") is dropped, since each line is already its own row. */
export const shownLine = line => String(line ?? '').replace(/^[-*]\s+/, '');

/** One source as the owner reads it: a remembered note or a task the town did, with a short id. */
export function sourceLabel(source) {
  const [kind, ...rest] = String(source ?? '').split(':'), id = rest.join(':');
  const short = id.length > 8 ? id.slice(0, 8) : id;
  if (kind === 'note') return {kind, id, label: `Note ${short}`};
  if (kind === 'task') return {kind, id, label: `Task ${short}`};
  return {kind: 'other', id: String(source ?? ''), label: String(source ?? '')};
}
/** "Built from 5 notes and 3 tasks." */
export function sourceSummary(sources) {
  const all = list(sources).map(sourceLabel), notes = all.filter(s => s.kind === 'note').length, tasks = all.filter(s => s.kind === 'task').length;
  if (!all.length) return 'No sources: you wrote this page.';
  const parts = [notes ? plural(notes, 'note') : null, tasks ? plural(tasks, 'task') : null, all.length - notes - tasks ? plural(all.length - notes - tasks, 'other source') : null].filter(Boolean);
  return `Built from ${parts.join(' and ')}.`;
}

/** What Organise did, in one sentence. */
export function organiseText(r) {
  if (!r || !r.notes) return 'Every note is already on a page.';
  const made = r.created ? `, ${plural(r.created, 'new page')}` : '';
  const dupes = r.duplicates ? ` ${plural(r.duplicates, 'possible duplicate')} flagged for you.` : '';
  return `Filed ${plural(r.notes, 'note')} into ${plural(r.pages, 'page')}${made}.${dupes}`;
}

/** The edit form as the PUT body, or the first problem. */
export function editDraft({title, kind, body}) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  if (!bodyLines(text).length) return {error: 'A page needs at least one line. To remove the page, use Forget instead.'};
  if (text.length > 200000) return {error: 'Keep a page under 200,000 characters.'};
  const name = String(title ?? '').trim();
  if (name.length > 120) return {error: 'Keep the title to 120 characters.'};
  return {body: {...(name ? {title: name} : {}), kind: kindOf(kind), body: text}};
}

/** The ☰ row's subtitle. */
export function rowSummary(pages, loaded) {
  if (!loaded) return 'What the cats know';
  const n = list(pages).length;
  return n ? `${plural(n, 'page')} the cats read` : 'No pages yet';
}

/**
 * The Memory dialog. town() gives the state (the graph's cat colours). Returns {open, close, refresh, probe, summary, dialog}.
 * graph(root) builds the graph view; it defaults to memory-view.js, loaded on first use.
 */
export function createMemoryPanel({doc = document, win = globalThis.window, fetchImpl = (...args) => fetch(...args), town = () => null, ask = confirmDialog, now = () => Date.now(),
  graph = root => import('./memory-view.js').then(m => m.createMemoryView(root))} = {}) {
  ensureStyles(doc, 'memory-panel.css', 'memory-panel');
  const ui = {pages: [], suggestions: [], forgotten: [], notes: 0, loaded: false, denied: null, view: 'list', kind: 'all', query: '', hits: null, page: null, draft: null, msg: null, busy: '', returnTo: null};
  let graphView = null, townTimer = 0, shownView = '';

  const shell = ownerDialog({doc, id: 'memory-dialog', eyebrow: 'WHAT THE TOWN KNOWS', title: 'Memory', size: 'wide',
    lede: 'Pages the cats keep about people, projects, topics and your preferences. They read these when they work. Correct a page by editing it: the lines you write are marked as yours.',
    onClose: () => { clearTimeout(townTimer); townTimer = 0; ui.view = 'list'; ui.page = null; ui.draft = null; ui.msg = null; ui.busy = ''; }});
  const {dialog, body} = shell;
  dialog.classList.add('memory-dialog');
  const views = h('div', {className: 'cx-seg op-seg mp-views', attrs: {role: 'group', 'aria-label': 'Memory view'}});
  const main = h('div', {className: 'mp-main'});
  const graphBox = h('div', {className: 'mp-graph', attrs: {'aria-label': 'Memory graph'}});
  graphBox.hidden = true;
  body.append(views, main, graphBox);
  // Escape steps back to the list from a page, the editor or the graph before it closes the panel.
  dialog.addEventListener('cancel', e => { if (ui.view !== 'list') { e.preventDefault(); showList(); } });
  // While the list is open, the town's own changes (the organiser filing notes) re-read it, a second and a half apart at most.
  win?.addEventListener?.('town-state', () => {
    if (!dialog.open || ui.view !== 'list' || townTimer) return;
    townTimer = setTimeout(() => { townTimer = 0; void refresh(); }, 1500);
  });

  const titleOf = slug => ui.pages.find(p => p.slug === slug)?.title ?? slug;
  const btn = (text, {className = '', key, onclick, attrs = {}} = {}) => {
    const b = h('button', {className, text, attrs: {type: 'button', ...(key ? {'data-key': key} : {}), ...attrs}});
    if (key && ui.busy === key) b.disabled = true;
    if (onclick) b.onclick = onclick;
    return b;
  };

  async function refresh() {
    try {
      const r = await readJson(fetchImpl, '/api/wiki');
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(DENIED), {status: 403});
      if (!r.ok) throw new Error(r.data.error || 'Memory could not load.');
      ui.pages = list(r.data.pages); ui.suggestions = list(r.data.suggestions); ui.forgotten = list(r.data.forgotten); ui.notes = Number(r.data.notes) || 0;
      ui.loaded = true; ui.denied = false;
    } catch (error) {
      if (error.status === 403) ui.denied = true;
      ui.msg = {text: error.message, bad: true};
    }
    if (ui.view === 'list') paint();
  }

  // Runs one request with its control busy; a failure becomes the page message.
  async function act(key, work) {
    if (ui.busy) return false;
    ui.busy = key; ui.msg = null; paint();
    let ok = false;
    try { await work(); ok = true; } catch (error) { ui.msg = {text: error.message || String(error), bad: true}; } finally { ui.busy = ''; }
    return ok;
  }

  function paintViews() {
    const pagesButton = btn('Pages', {attrs: {'aria-pressed': String(ui.view !== 'graph')}, onclick: () => showList()});
    const graphButton = btn('Graph', {attrs: {'aria-pressed': String(ui.view === 'graph')}, onclick: () => void showGraph()});
    views.replaceChildren(pagesButton, graphButton);
    views.hidden = ui.denied === true;
  }

  function paint() {
    paintViews();
    main.hidden = ui.view === 'graph'; graphBox.hidden = ui.view !== 'graph';
    if (ui.view === 'graph') return;
    const focusKey = doc.activeElement?.dataset?.key;
    const view = ui.view;
    main.replaceChildren(...(view === 'page' ? pageView() : view === 'edit' ? editView() : listView()).filter(Boolean));
    // A new view starts at the top, under the title row; a repaint of the same view keeps the place.
    if (view !== shownView) { shownView = view; dialog.scrollTop = 0; }
    if (focusKey) [...main.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey && !n.disabled)?.focus();
  }

  // The list: search, kind filter, merge suggestions, the pages by kind, then Organise and the forgotten pages.
  function row(p) {
    const badges = [p.owner ? h('span', {className: 'cx-badge mp-yours', text: 'Has your lines'}) : null,
      p.duplicates ? h('span', {className: 'cx-badge mp-dupe', text: plural(p.duplicates, 'possible duplicate')}) : null].filter(Boolean);
    const b = h('button', {className: 'mp-row', attrs: {type: 'button', 'data-key': `page:${p.slug}`, 'data-slug': p.slug}},
      h('span', {className: 'mp-row-title'}, h('strong', {text: p.title}), ...badges),
      h('span', {className: 'mp-row-meta', text: p.snippet ? p.snippet : pageMeta(p, now())}));
    b.onclick = () => void openPage(p.slug);
    return h('li', {}, b);
  }
  function listView() {
    if (ui.denied) return [msgNode(ui.msg)];
    if (!ui.loaded) return [h('p', {className: 'cx-empty muted', text: 'Loading memory…', attrs: {role: 'status'}})];
    const query = h('input', {className: 'mp-query', attrs: {type: 'search', maxlength: '200', placeholder: 'Search every page', 'aria-label': 'Search memory pages', autocomplete: 'off'}});
    query.value = ui.query;
    const search = h('form', {className: 'mp-search', attrs: {role: 'search'}}, query, btn('Search', {className: 'primary', attrs: {type: 'submit'}}));
    search.onsubmit = e => { e.preventDefault(); void runSearch(query.value); };
    const parts = [search, msgNode(ui.msg)];
    if (ui.hits) {
      parts.push(h('div', {className: 'mp-bar'}, h('p', {className: 'mp-count', text: ui.hits.length ? `${plural(ui.hits.length, 'page')} ${ui.hits.length === 1 ? 'matches' : 'match'} “${ui.query}”` : `No page matches “${ui.query}”.`, attrs: {role: 'status'}}),
        btn('Clear search', {key: 'clear', onclick: () => { ui.query = ''; ui.hits = null; paint(); }})));
      if (ui.hits.length) parts.push(h('ul', {className: 'mp-rows'}, ui.hits.map(row)));
      return parts;
    }
    if (!ui.pages.length) {
      // No pages yet: one sentence, and the graph shows what the Scholar has collected so far.
      parts.push(emptyState(doc, {icon: 'book-open',
        text: ui.notes ? `The cats have remembered ${plural(ui.notes, 'note')}; Organise files them into pages.` : 'No pages yet; as the cats remember things, Organise files their notes into pages.',
        action: btn('Open the graph', {className: 'secondary', key: 'empty-graph', onclick: () => void showGraph()})}));
    } else {
      const counts = Object.fromEntries(KINDS.map(([k]) => [k, ui.pages.filter(p => kindOf(p.kind) === k).length]));
      const chips = [['all', `All ${ui.pages.length}`], ...KINDS.filter(([k]) => counts[k]).map(([k, label]) => [k, `${label} ${counts[k]}`])];
      if (!chips.some(([k]) => k === ui.kind)) ui.kind = 'all';
      parts.push(h('div', {className: 'cx-chips mp-kinds', attrs: {role: 'group', 'aria-label': 'Show pages of one kind'}},
        chips.map(([k, label]) => btn(label, {className: 'cx-chip', key: `kind:${k}`, attrs: {'aria-pressed': String(ui.kind === k)}, onclick: () => { ui.kind = k; paint(); }}))));
      if (ui.suggestions.length && ui.kind === 'all') parts.push(suggestionsBox());
      const groups = groupByKind(ui.pages).filter(g => ui.kind === 'all' || g.kind === ui.kind);
      for (const g of groups) parts.push(h('section', {className: 'cx-section mp-group', attrs: {'aria-label': g.label}}, h('h4', {text: `${g.label} · ${g.pages.length}`}), h('ul', {className: 'mp-rows'}, g.pages.map(row))));
    }
    parts.push(h('section', {className: 'cx-section mp-organise'},
      h('h4', {text: 'Organise'}),
      h('p', {className: 'op-hint', text: `${plural(ui.notes, 'note')} remembered in all. Organise files each note that is not on a page yet. It never deletes a note; it only flags near-duplicates for you.`}),
      h('div', {className: 'op-actions'}, btn(ui.busy === 'organise' ? 'Organising…' : 'Organise notes', {key: 'organise', onclick: () => void organise()}))));
    if (ui.forgotten.length) parts.push(h('details', {className: 'op-more mp-forgotten'}, h('summary', {text: `Forgotten pages (${ui.forgotten.length})`}),
      h('p', {className: 'op-hint', text: 'The organiser never makes these pages again.'}), h('ul', {}, ui.forgotten.map(s => h('li', {text: s})))));
    return parts;
  }
  function suggestionsBox() {
    return h('section', {className: 'cx-section mp-suggestions', attrs: {'aria-labelledby': 'mp-suggest-title'}},
      h('h4', {text: 'These may be the same', attrs: {id: 'mp-suggest-title'}}),
      h('p', {className: 'op-hint', text: 'Their titles share most of their words. Keep one and the other joins it.'}),
      h('ul', {className: 'mp-pairs'}, ui.suggestions.slice(0, 10).map(s => {
        const a = titleOf(s.a), b = titleOf(s.b);
        return h('li', {className: 'cx-card mp-pair'},
          h('p', {}, h('strong', {text: a}), ' and ', h('strong', {text: b})),
          h('div', {className: 'op-actions'},
            btn(`Keep “${a}”`, {key: `merge:${s.b}:${s.a}`, onclick: () => void mergePages(s.b, s.a)}),
            btn(`Keep “${b}”`, {key: `merge:${s.a}:${s.b}`, onclick: () => void mergePages(s.a, s.b)})));
      })));
  }

  // One page: its lines (yours marked), possible duplicates, sources, and Edit, Merge and Forget.
  function pageView() {
    const p = ui.page;
    if (!p) return [msgNode(ui.msg)];
    const mine = new Set(list(p.owner));
    const lines = bodyLines(p.body).map(line => {
      const yours = mine.has(line);
      const parts = lineParts(shownLine(line)).map(part => part.link
        ? (ui.pages.some(x => x.slug === part.link) ? btn(titleOf(part.link), {className: 'mp-link', key: `link:${part.link}`, onclick: () => void openPage(part.link)}) : h('span', {className: 'mp-dead', text: part.link}))
        : part.text);
      return h('li', {className: yours ? 'mp-line mp-line-owner' : 'mp-line'}, yours ? h('span', {className: 'mp-you', text: 'You'}) : null, h('span', {className: 'mp-text'}, ...parts));
    });
    const sources = list(p.sources).map(sourceLabel);
    const others = ui.pages.filter(x => x.slug !== p.slug);
    const into = h('select', {className: 'mp-into', attrs: {'aria-label': 'Page to merge into'}});
    into.replaceChildren(Object.assign(doc.createElement('option'), {value: '', textContent: 'Choose a page…'}), ...others.map(x => Object.assign(doc.createElement('option'), {value: x.slug, textContent: x.title})));
    return [
      h('div', {className: 'mp-bar'}, btn('← Pages', {className: 'mp-back', key: 'back', onclick: () => showList()})),
      msgNode(ui.msg),
      h('article', {className: 'mp-page', attrs: {'aria-labelledby': 'mp-page-title'}},
        h('div', {className: 'mp-page-head'},
          h('h3', {text: p.title, attrs: {id: 'mp-page-title', tabindex: '-1'}}),
          h('span', {className: 'cx-badge', text: kindLabel(p.kind)})),
        h('p', {className: 'op-hint', text: pageMeta({lines: bodyLines(p.body).length, updated: p.updated, by: p.by}, now())}),
        mine.size ? h('p', {className: 'op-hint mp-legend'}, h('span', {className: 'mp-you', text: 'You'}), ' marks a line you wrote.') : null,
        h('ul', {className: 'mp-lines'}, lines)),
      list(p.duplicates).length ? h('section', {className: 'cx-section mp-dupes'},
        h('h4', {text: 'Possible duplicates'}),
        h('p', {className: 'op-hint', text: 'Each pair of notes says nearly the same thing. Edit the page to keep one line of each pair.'}),
        h('ul', {className: 'mp-dupe-list'}, list(p.duplicates).map(d => h('li', {}, h('span', {text: d.a?.title || sourceLabel(d.a?.id).label}), h('span', {className: 'muted', text: ' ~ '}), h('span', {text: d.b?.title || sourceLabel(d.b?.id).label}))))) : null,
      h('section', {className: 'cx-section mp-sources'},
        h('h4', {text: `Sources · ${sources.length}`}),
        h('p', {className: 'op-hint', text: sourceSummary(p.sources)}),
        sources.length ? h('details', {className: 'op-more'}, h('summary', {text: 'Show each source'}),
          h('ul', {className: 'mp-source-list'}, sources.map(s => h('li', {}, h('span', {className: 'mp-source', text: s.label}),
            s.kind === 'note' ? btn('Show in graph', {className: 'op-quiet', key: `graph:${s.id}`, onclick: () => void showGraph(`note:${s.id}`)}) : null)))) : null),
      h('section', {className: 'cx-section mp-actions'},
        h('h4', {text: 'Change this page'}),
        h('div', {className: 'op-actions'},
          btn('Edit', {className: 'primary', key: 'edit', onclick: () => { ui.view = 'edit'; ui.draft = null; ui.msg = null; paint(); main.querySelector('textarea')?.focus({preventScroll: true}); }}),
          btn(ui.busy === 'forget' ? 'Forgetting…' : 'Forget', {className: 'cx-remove op-end', key: 'forget', onclick: () => void forgetPage(p)})),
        others.length ? h('div', {className: 'mp-merge'},
          h('label', {className: 'op-field'}, h('span', {text: 'Merge into another page'}), into, h('small', {text: 'This page’s lines and sources join the other page, and this one leaves the list.'})),
          h('div', {className: 'op-actions'}, btn('Merge', {key: 'merge-into', onclick: () => { if (into.value) void mergePages(p.slug, into.value); else { ui.msg = {text: 'Choose the page to merge into first.', bad: true}; paint(); } }}))) : null),
    ];
  }

  // The typed text lives in ui.draft, so a repaint (a busy Save, a failed save) never loses it.
  function editView() {
    const p = ui.page, d = ui.draft ??= {title: p.title, kind: kindOf(p.kind), body: bodyLines(p.body).join('\n')};
    const title = h('input', {attrs: {type: 'text', maxlength: '120', autocomplete: 'off', 'aria-label': 'Page title'}});
    title.value = d.title;
    const kind = h('select', {attrs: {'aria-label': 'Kind of page'}});
    kind.replaceChildren(...KINDS.map(([value, , label]) => Object.assign(doc.createElement('option'), {value, textContent: label})));
    kind.value = d.kind;
    const text = h('textarea', {className: 'mp-body', attrs: {rows: '14', spellcheck: 'true', 'aria-label': 'Page text, one fact per line'}});
    text.value = d.body;
    title.oninput = () => { d.title = title.value; };
    kind.onchange = () => { d.kind = kind.value; };
    text.oninput = () => { d.body = text.value; };
    const error = h('p', {className: 'cx-msg bad', attrs: {role: 'status'}});
    const save = btn(ui.busy === 'save' ? 'Saving…' : 'Save page', {className: 'primary', key: 'save', attrs: {type: 'submit'}});
    const form = h('form', {className: 'op-form mp-edit', attrs: {novalidate: ''}},
      h('div', {className: 'mp-bar'}, btn('← Back to the page', {className: 'mp-back', key: 'cancel-edit', onclick: () => leaveEdit()})),
      h('h3', {className: 'mp-edit-title', text: `Edit “${p.title}”`}),
      h('div', {className: 'mp-pair-fields'}, h('label', {className: 'op-field'}, h('span', {text: 'Title'}), title), h('label', {className: 'op-field'}, h('span', {text: 'Kind'}), kind)),
      h('label', {className: 'op-field'}, h('span', {text: 'One fact per line'}), text,
        h('small', {text: 'Lines you add or change are marked as yours. Lines you leave as they are stay the organiser’s. Write [[page-name]] to link another page.'})),
      error, msgNode(ui.msg),
      h('div', {className: 'op-actions'}, btn('Cancel', {onclick: () => leaveEdit()}), save));
    form.onsubmit = async e => {
      e.preventDefault();
      const draft = editDraft(d);
      if (draft.error) { error.textContent = draft.error; return; }
      const ok = await act('save', () => sendJson(fetchImpl, `/api/wiki/${enc(p.slug)}`, draft.body, 'PUT'));
      if (ok) { ui.draft = null; await openPage(p.slug, {text: 'Saved. The cats read the new text from their next task.'}); void refresh(); }
      else { ui.view = 'edit'; paint(); }
    };
    return [form];
  }
  function leaveEdit() { ui.view = 'page'; ui.draft = null; paint(); main.querySelector('h3')?.focus({preventScroll: true}); }

  async function runSearch(q) {
    ui.query = String(q ?? '').trim();
    if (!ui.query) { ui.hits = null; paint(); return; }
    await act('search', async () => {
      const r = await readJson(fetchImpl, `/api/wiki?q=${enc(ui.query)}`);
      if (!r.ok) throw new Error(r.data.error || 'The search did not work.');
      ui.hits = list(r.data.hits);
    });
    paint();
  }

  async function openPage(slug, msg = null) {
    const from = ui.view === 'list' ? slug : ui.returnTo;
    const ok = await act(`page:${slug}`, async () => {
      const r = await readJson(fetchImpl, `/api/wiki/${enc(slug)}`);
      if (!r.ok) throw new Error(r.status === 404 ? 'That page is gone: it was forgotten or merged.' : r.data.error || 'The page could not load.');
      ui.page = r.data;
    });
    if (!ok) { paint(); return; }
    ui.returnTo = from; ui.view = 'page'; ui.msg = msg;
    paint();
    main.querySelector('h3')?.focus({preventScroll: true});
  }

  function showList() {
    const back = ui.page?.slug ?? ui.returnTo;
    ui.view = 'list'; ui.page = null;
    paint();
    void refresh().then(() => {
      const target = back ? [...main.querySelectorAll('[data-slug]')].find(n => n.dataset.slug === back) : null;
      target?.focus();
    });
  }

  async function showGraph(focus = null) {
    ui.view = 'graph'; paint();
    try {
      graphView ??= await graph(graphBox);
      graphView.update(town() ?? {cats: []});
      if (focus) graphView.focus?.(focus);
    } catch (error) {
      graphBox.replaceChildren(msgNode({text: error.message || 'The graph could not load.', bad: true}));
    }
  }

  async function organise() {
    let result = null;
    const ok = await act('organise', async () => { result = await sendJson(fetchImpl, '/api/wiki/organise'); });
    if (ok) ui.msg = {text: organiseText(result)};
    await refresh();
  }

  async function mergePages(from, into) {
    if (!from || !into || from === into) return;
    const a = titleOf(from), b = titleOf(into);
    const yes = await ask({title: `Merge “${a}” into “${b}”?`, message: `The lines and sources of “${a}” join “${b}”, and “${a}” leaves the list. Notes the organiser would have filed under “${a}” go to “${b}” from now on.`, confirmLabel: 'Merge pages', cancelLabel: 'Keep both'});
    if (!yes) return;
    const ok = await act(`merge:${from}:${into}`, () => sendJson(fetchImpl, '/api/wiki/merge', {from, into}));
    if (ok) { await refresh(); await openPage(into, {text: `Merged “${a}” into this page.`}); } else paint();
  }

  async function forgetPage(p) {
    const yes = await ask({title: `Forget “${p.title}”?`, message: 'The page goes, and its notes leave what the cats read and learn from. They stay in the journal. The organiser never makes this page again.', confirmLabel: 'Forget page', cancelLabel: 'Keep it', danger: true});
    if (!yes) return;
    const ok = await act('forget', () => sendJson(fetchImpl, `/api/wiki/${enc(p.slug)}/forget`));
    if (ok) { ui.page = null; ui.view = 'list'; ui.msg = {text: `Forgot “${p.title}”.`}; ui.returnTo = null; await refresh(); } else paint();
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    ui.view = 'list'; ui.msg = null; paint();
    await refresh();
  }

  // Only an owner gets the pages; anywhere else the ☰ row stays hidden.
  async function probe() {
    await refresh();
    return ui.denied === false;
  }

  return {open, close: () => dialog.close(), refresh, probe, summary: () => rowSummary(ui.pages, ui.loaded), dialog, openPage};
}

/** ☰ > Memory: a top-level row that opens the panel, for owners only. Called once by app.js. */
export function initMemoryPanel(options = {}) {
  const panel = createMemoryPanel(options);
  let fallback = null;
  registerSettingsSection('memory', 'Memory', container => {
    fallback = h('button', {text: 'Memory…', attrs: {type: 'button', id: 'memory-open', 'data-owner': '', 'aria-haspopup': 'dialog'}});
    fallback.hidden = true;
    fallback.onclick = () => void panel.open();
    container.append(fallback);
  }, {icon: '✎', summary: panel.summary, action: () => void panel.open()});
  void panel.probe().then(owner => { if (fallback) fallback.hidden = !owner; });
  (options.doc ?? document).getElementById('menu-toggle')?.addEventListener('click', () => void panel.refresh());
  return panel;
}

// A rebuildable SQLite read model beside a world's journal (product plan 2.4). The journal stays the source of truth:
// this file only holds a snapshot of the replayed state (so a restart replays just the newer events), rows for paging
// (messages by chat, tasks by cat), FTS5 search over messages, memory notes, artifacts and root request results, and FTS5 over wiki pages (wiki.ts). Deleting it rebuilds it from the journal.
import {closeSync, existsSync, openSync, readSync, rmSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {State, Task} from './store.ts';
import {artifactIndex, artifactsDir} from './artifacts.ts';

// Bump when the tables change; a db at another version is dropped and rebuilt from the journal on the next start.
// 3: artifacts and request results join the search table, which gains a title column.
const SCHEMA = 3;
// What the search table keeps of an artifact's text and of a request's result: enough to show and to match, not the whole file.
const EXCERPT = 2000, RESULT = 4000, READ_BYTES = 8192;
export type SearchHit = {kind:'message'|'note'|'artifact'|'request'; ref:string; cat:string; at:string; title:string; text:string};
/** The start of a saved text artifact, tags stripped for HTML and SVG. Image and video files have no text; an unreadable file has none either. */
function artifactExcerpt(path:string, kind:string) {
  if (kind === 'image' || kind === 'video') return '';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(READ_BYTES), n = readSync(fd, buf, 0, READ_BYTES, 0);
    let text = buf.subarray(0, n).toString('utf8');
    if (kind === 'html' || kind === 'svg') text = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]*>/g, ' ');
    return text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// The full-state snapshot is ~6.5 MB of JSON on the owner's world, so it is rewritten every this many events, not every tick.
export const SNAPSHOT_EVERY = 1000;
const sqlite = () => process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;
// What identifies the journal prefix a snapshot or the rows were built from: count, last id and length, so a rewritten journal (compact-journals.mjs keeps ids) misses.
export type Mark = {seq:number; id:string; size:number};
type Snap = Mark & {state:Omit<State,'events'>};

export class ReadModel {
  private scheduled = false; warned = false;
  /** version: a fingerprint of the replay code, so a snapshot written by older code is never loaded into newer code. */
  constructor(public file:string, private version:string, private source:()=>{state:State; size:number}) {}
  static fingerprint(code:string) {return createHash('sha256').update(`${SCHEMA}\n${code}`).digest('hex').slice(0, 16);}
  private open() {
    const db = new (sqlite()!.DatabaseSync)(this.file, {timeout: 5000});
    try {
      if ((db.prepare('PRAGMA user_version').get() as any).user_version !== SCHEMA) {
        db.exec(`DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS search; DROP TABLE IF EXISTS wiki; PRAGMA user_version=${SCHEMA};`);
      }
      db.exec(`PRAGMA synchronous=OFF;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, from_cat TEXT, to_cat TEXT, json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_from ON messages(from_cat, seq);
        CREATE INDEX IF NOT EXISTS messages_to ON messages(to_cat, seq);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, cat TEXT, seq INTEGER NOT NULL, json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tasks_cat ON tasks(cat, seq);
        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(kind UNINDEXED, ref UNINDEXED, cat UNINDEXED, at UNINDEXED, title, text);
        CREATE VIRTUAL TABLE IF NOT EXISTS wiki USING fts5(slug UNINDEXED, title, body);`);
      return db;
    } catch (err) {db.close(); throw err;}
  }
  // Opened per call and closed at once, so no handle outlives a flush (Windows cannot delete a world folder with an open file).
  private use<T>(fn:(db:DatabaseSync)=>T):T {const db = this.open(); try {return fn(db);} finally {db.close();}}
  private meta(db:DatabaseSync, key:string) {const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any; return row ? JSON.parse(row.value) : null;}
  private setMeta(db:DatabaseSync, key:string, value:unknown) {db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));}

  /** The snapshot, if this db has one written by the same replay code from the journal prefix `matches` confirms; null otherwise (the caller replays in full).
   *  A corrupt db, or one built from a journal that has since been rewritten, warns and is deleted, to be rebuilt by the next flush. */
  load(matches:(mark:Mark)=>boolean):Snap|null {
    if (!existsSync(this.file)) return null;
    try {
      const {snap, rows} = this.use(db => ({snap: this.meta(db, 'snapshot') as (Snap & {version:string})|null, rows: this.meta(db, 'rows') as Mark|null}));
      if ((!snap || matches(snap)) && (!rows || matches(rows))) return snap?.version === this.version ? snap : null;
      throw new Error('it was built from a different journal');
    } catch (err) {
      this.warn(err, 'replaying the journal in full and rebuilding it');
      // A locked file (antivirus, a handle not yet released) stays; the next flush rebuilds its rows anyway.
      try {rmSync(this.file, {force: true});} catch {}
      return null;
    }
  }
  /** One flush per tick: every emit in the same tick shares it, and the emit itself never waits on SQLite. */
  schedule() {if (this.scheduled) return; this.scheduled = true; setImmediate(() => {this.scheduled = false; this.flush();});}
  /** Brings the rows up to the store's current state in one transaction, and rewrites the snapshot when it is SNAPSHOT_EVERY events behind (or always with snapshot:true). Never throws. */
  flush({snapshot = false}:{snapshot?:boolean} = {}) {
    try {
      const {state, size} = this.source(), events = state.events, n = events.length;
      // A world folder deleted since the flush was scheduled: nothing to write to.
      if (!n || !existsSync(dirname(this.file))) return;
      this.use(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const rows:Mark|null = this.meta(db, 'rows');
          // Rows built from another journal prefix (a rewritten or replaced journal) are dropped and rebuilt from the start.
          const from = rows && rows.seq <= n && events[rows.seq - 1]?.id === rows.id ? rows.seq : 0;
          if (!from) db.exec('DELETE FROM messages; DELETE FROM tasks; DELETE FROM search; DELETE FROM wiki;');
          if (from < n) this.write(db, state, from);
          const mark:Mark = {seq: n, id: events[n - 1].id, size};
          this.setMeta(db, 'rows', mark);
          const snap = this.meta(db, 'snapshot');
          if (snapshot || !from || !snap || snap.version !== this.version || n - snap.seq >= SNAPSHOT_EVERY) {
            const {events: _events, ...rest} = state;
            this.setMeta(db, 'snapshot', {...mark, version: this.version, state: rest});
          }
          db.exec('COMMIT');
        } catch (err) {db.exec('ROLLBACK'); throw err;}
      });
    } catch (err) {this.warn(err, 'the journal is unaffected');}
  }
  private write(db:DatabaseSync, state:State, from:number) {
    const msg = db.prepare('INSERT INTO messages(seq,id,from_cat,to_cat,json) VALUES(?,?,?,?,?)');
    const fts = db.prepare('INSERT INTO search(kind,ref,cat,at,title,text) VALUES(?,?,?,?,?,?)');
    const task = db.prepare('INSERT INTO tasks(id,cat,seq,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET cat=excluded.cat, json=excluded.json');
    const touched = new Map<string, number>();
    const drop = db.prepare('DELETE FROM wiki WHERE slug=?'), page = db.prepare('INSERT INTO wiki(slug,title,body) VALUES(?,?,?)');
    const dropRequest = db.prepare(`DELETE FROM search WHERE kind='request' AND ref=?`);
    for (let seq = from; seq < state.events.length; seq++) {
      const e = state.events[seq], d = e.data ?? {};
      // The same shape apply() pushes into state.messages.
      if (e.type === 'message') {msg.run(seq, e.id, d.from ?? null, d.to ?? null, JSON.stringify({...d, id: e.id, at: e.at})); fts.run('message', e.id, `${d.from} ${d.to}`, e.at, '', String(d.text ?? ''));}
      if (e.type === 'memory.noted') fts.run('note', e.id, d.cat ?? null, e.at, String(d.title ?? ''), String(d.text ?? ''));
      // The file is read when the event is indexed, and again on a rebuild: the index follows the file's text, not the journal (which keeps metadata only).
      if (e.type === 'artifact.created') for (const a of artifactIndex([e])) fts.run('artifact', a.id, a.cat, e.at, a.title, artifactExcerpt(join(artifactsDir(dirname(this.file)), basename(a.file)), a.kind));
      if ((e.type === 'task.created' || e.type === 'task.updated') && d.id && !touched.has(d.id)) touched.set(d.id, seq);
      // A full save replaces a page's rows; a wiki.line adds one row under the same slug (wikiSearch keeps the best row per page).
      if (typeof d.slug === 'string') {
        if (e.type === 'wiki.saved' || e.type === 'wiki.removed') drop.run(d.slug);
        if (e.type === 'wiki.saved') page.run(d.slug, String(d.title ?? d.slug), String(d.body ?? ''));
        if (e.type === 'wiki.line') page.run(d.slug, '', String(d.line ?? ''));
      }
    }
    if (!touched.size) return;
    // Tasks are merged by later updates, so their rows are written from the current state, once per task per flush.
    // A root task's result is a request row, replaced whenever the task changes, so a later result is found as well.
    const byId = new Map<string, Task>(state.tasks.map(t => [t.id, t]));
    for (const [id, seq] of touched) {
      const t = byId.get(id);
      if (!t) continue;
      task.run(id, t.cat, seq, JSON.stringify(t));
      if (t.parent) continue;
      dropRequest.run(id);
      if (t.result) fts.run('request', id, t.cat, state.events[seq].at, t.text, String(t.result).slice(0, RESULT));
    }
  }

  /** One cat's chat page, the same shape as Store.chat(): newest `limit` messages before `before`, in journal order. */
  chat(cat:string, {before, limit, tasks}:{before?:string; limit:number; tasks:number}) {
    return this.use(db => {
      let below = Number.MAX_SAFE_INTEGER;
      if (before !== undefined) {const row = db.prepare('SELECT seq FROM messages WHERE id=?').get(before) as any; if (!row) throw new Error('That message is not in this town.'); below = row.seq;}
      const page = (db.prepare('SELECT json FROM messages WHERE (from_cat=?1 OR to_cat=?1) AND seq<?2 ORDER BY seq DESC LIMIT ?3').all(cat, below, limit + 1) as any[]).map(r => JSON.parse(r.json));
      const more = page.length > limit, messages = page.slice(0, limit).reverse();
      if (before !== undefined) return {messages, more};
      const mine = tasks > 0 ? (db.prepare('SELECT json FROM tasks WHERE cat=? ORDER BY seq DESC LIMIT ?').all(cat, tasks) as any[]).map(r => ({...JSON.parse(r.json), context: undefined})).reverse() : [];
      return {messages, more, tasks: mine};
    });
  }
  /** Full-text search over messages, memory notes, artifacts (title and text excerpt) and root request results, best match first; one kind only when `kind` is given.
   *  Each word is quoted, so punctuation cannot break the FTS5 query syntax. */
  search(query:string, limit = 20, kind?:string):SearchHit[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const match = words.map(w => `"${w}"`).join(' ');
    return this.use(db => (kind === undefined
      ? db.prepare('SELECT kind,ref,cat,at,title,text FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?').all(match, limit)
      : db.prepare('SELECT kind,ref,cat,at,title,text FROM search WHERE search MATCH ? AND kind=? ORDER BY rank LIMIT ?').all(match, kind, limit)) as any);
  }
  /** Full-text search over wiki pages, best match first, with a short snippet around the match. */
  wikiSearch(query:string, limit = 20):{slug:string; title:string; snippet:string}[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    // A page is its full save plus one row per appended line: the best-ranked row stands for the page.
    // ponytail: reads 10 rows per wanted page and keeps each page's first; a page with more matching lines than that can crowd others out.
    const rows = this.use(db => db.prepare(`SELECT slug,title,snippet(wiki,2,'','','…',16) AS snippet FROM wiki WHERE wiki MATCH ? ORDER BY rank LIMIT ?`).all(words.map(w => `"${w}"`).join(' '), limit * 10) as {slug:string; title:string; snippet:string}[]);
    const seen = new Set<string>();
    return rows.filter(r => !seen.has(r.slug) && !!seen.add(r.slug)).slice(0, limit);
  }
  counts() {return this.use(db => Object.fromEntries(['messages', 'tasks', 'search'].map(t => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as any).n as number])));}
  private warn(err:unknown, then:string) {if (this.warned) return; this.warned = true; console.warn(`Read model ${this.file}: ${(err as Error)?.message ?? err}; ${then}.`);}
}

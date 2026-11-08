// The SecretStore (item 1.7): every saved key, token and sign-in lives in one file, <dataDir>/secrets.v2.json, keyed by the secretRef the Account
// model uses (accounts.ts: `<file>#<dot.path>`). The desktop app encrypts each value with Electron safeStorage in its main process, asked over the
// server's IPC channel, so this process never holds the OS key. `npm start` has no broker and keeps the values in plain text, and says so.
// Each owning module keeps its own file for everything else and overlays the store: withSecrets on read, withoutSecrets on write.
import {copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';

export const SECRETS_FILE = 'secrets.v2.json';
// Each file's secret leaves as dot paths; '*' is any one key. Only what is a credential: ids and settings stay readable in their own files.
export const SECRET_FIELDS: Record<string, string[]> = {
  'models.json': ['hosted.key', 'jev.key', 'media.*.key', 'anthropic.key'],
  'connector-secrets.json': ['*'],
  'real-money-secrets.json': ['stripe.key', 'stripe.webhookSecret'],
  'cat-browser.json': ['token'],
  'telegram.json': ['token', 'deviceToken'],
  'discord.json': ['token', 'deviceToken'],
  'vapid.json': ['privateKey'],
  'ntfy.json': ['devices.*.topic'],
  'rendezvous.json': ['key'],
  'oauth-clients.json': ['*.clientSecret'],
  'hermes.json': ['apiKey', 'gateToken'],
  'backup.json': ['recoveryKey'],
};
export const BACKUP_DAYS = 7;
const BACKUP = /\.pre-secrets-(\d+)\.bak$/;

/** The desktop app's main process: safeStorage behind IPC. A test passes a fake. Values cross as base64 blobs. */
export type Broker = {available(): Promise<boolean>; encrypt(text: string): Promise<string>; decrypt(blob: string): Promise<string>};
// encrypted/plaintext: the store is in use. locked: an encrypted file this process cannot open (started without the desktop app, or another
// Windows account). legacy: the move failed, so the old files are read and written as before. Both leave secrets.v2.json untouched.
export type SecretMode = 'encrypted' | 'plaintext' | 'locked' | 'legacy';
type Disk = {v: 2; cipher: 'safeStorage' | 'none'; items: Record<string, string>};

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
// Every [path, value] a pattern finds in obj.
function leaves(o: unknown, pat: string[], at: string[] = []): [string, unknown][] {
  if (!pat.length) return o === undefined ? [] : [[at.join('.'), o]];
  if (!isObj(o)) return [];
  const [head, ...rest] = pat;
  return (head === '*' ? Object.keys(o) : [head!]).flatMap(k => leaves(o[k], rest, [...at, k]));
}
const secretLeaves = (name: string, obj: unknown) => (SECRET_FIELDS[name] ?? []).flatMap(p => leaves(obj, p.split('.')));
const matches = (name: string, path: string[]) => (SECRET_FIELDS[name] ?? []).some(p => { const s = p.split('.'); return s.length === path.length && s.every((x, i) => x === '*' || x === path[i]); });
function strip(name: string, obj: any) {
  const out = structuredClone(obj);
  for (const [path] of secretLeaves(name, obj)) { const s = path.split('.'), last = s.pop()!; delete s.reduce((o, k) => o[k], out)[last]; }
  return out;
}

export class SecretStore {
  mode: SecretMode = 'plaintext';
  error: string | null = null;
  private values = new Map<string, unknown>();
  private items: Record<string, string> = {};
  private chain = Promise.resolve();
  constructor(readonly dir: string, private broker?: Broker, private readonly memoryOnly = false) {}
  get file() { return join(this.dir, SECRETS_FILE); }
  private get cipher(): Disk['cipher'] { return this.broker ? 'safeStorage' : 'none'; }
  get active() { return this.mode === 'encrypted' || this.mode === 'plaintext'; }

  get(ref: string) { return this.values.get(ref); }
  /** Every saved ref of one file with its value. */
  of(name: string): Record<string, unknown> { return Object.fromEntries([...this.values].filter(([r]) => r.startsWith(`${name}#`))); }
  /** One status line for /api/state: the app shows note as a banner when it is not null. */
  status() {
    const note = {encrypted: null, plaintext: 'Saved keys are stored unencrypted on this computer. Open Clowder from the desktop app to encrypt them.',
      locked: 'Saved keys are locked: they were encrypted by the desktop app. Open Clowder from the desktop app.',
      legacy: 'Saved keys could not be moved to encrypted storage, so they stay in their old files.'}[this.mode];
    return {mode: this.mode, note, ...(this.error ? {error: this.error} : {})};
  }

  /** Sets (or, for undefined, removes) refs in one write. Memory changes now; an encrypted write follows in order and never throws. */
  update(changes: [string, unknown][]) {
    if (!this.active) throw new Error(this.status().note!);
    const changed = changes.filter(([r, v]) => JSON.stringify(v) !== JSON.stringify(this.values.get(r)));
    if (!changed.length) return;
    for (const [r, v] of changed) v === undefined ? this.values.delete(r) : this.values.set(r, v);
    if (this.memoryOnly) return;
    if (!this.broker) { for (const [r, v] of changed) v === undefined ? delete this.items[r] : this.items[r] = JSON.stringify(v); this.write(this.items); return; }
    // ponytail: a crash in the few ms before this write loses only the value just saved; flush() awaits it at shutdown and in tests.
    this.chain = this.chain.then(async () => {
      for (const [r, v] of changed) v === undefined ? delete this.items[r] : this.items[r] = await this.broker!.encrypt(JSON.stringify(v));
      this.write(this.items);
    }).catch(() => { this.error = 'A saved key could not be encrypted, so it is kept only until Clowder closes. Save it again.'; console.error(`SecretStore: ${this.error}`); });
  }
  flush() { return this.chain; }
  private write(items: Record<string, string>, file = this.file) { writeJsonAtomic(file, {v: 2, cipher: this.cipher, items} satisfies Disk); }

  // The file, or undefined when it locks the store: damaged, or encrypted with no broker here. Either way it is left as it is.
  private readDisk(): Disk | undefined {
    const disk = existsSync(this.file) ? readJson(this.file) : {v: 2, cipher: this.cipher, items: {}};
    if (disk?.v !== 2 || !isObj(disk.items) || (disk.cipher !== 'none' && disk.cipher !== 'safeStorage')) return this.lock(`${SECRETS_FILE} is damaged.`);
    return disk.cipher === 'safeStorage' && !this.broker ? this.lock(null) : disk;
  }
  private lock(error: string | null) { this.mode = 'locked'; this.error = error; return undefined; }
  private accept(disk: Disk, plain: [string, string][]) {
    try { this.values = new Map(plain.map(([r, p]) => [r, JSON.parse(p)])); } catch { return this.lock(`${SECRETS_FILE} is damaged.`); }
    // A plain store opened by the desktop app is re-encrypted by migrate(), with the same check as a first move.
    this.reencrypt = disk.cipher !== this.cipher && plain.length > 0;
    this.items = disk.cipher === this.cipher ? {...disk.items} : {};
    this.mode = this.broker ? 'encrypted' : 'plaintext';
  }
  private reencrypt = false;
  /** Reads the file. An encrypted file with no broker, or one whose blobs do not decrypt, is locked and left as it is. */
  async load() {
    const disk = this.readDisk();
    if (!disk) return;
    const plain: [string, string][] = [];
    try { for (const [r, blob] of Object.entries(disk.items)) plain.push([r, disk.cipher === 'safeStorage' ? await this.broker!.decrypt(blob) : blob]); }
    catch { return this.lock(`${SECRETS_FILE} could not be decrypted on this computer or Windows account.`); }
    this.accept(disk, plain);
  }
  /** The plain store's load (tests, scripts, a server without the desktop app): nothing to decrypt, so nothing awaits. */
  loadSync() { const disk = this.readDisk(); if (disk) this.accept(disk, Object.entries(disk.items)); return this; }

  /** Moves every secret still in an old file into the store. The new file is written beside the old one, read back from disk and every value
   *  decrypted and compared; only then does it replace secrets.v2.json, each old file get a .pre-secrets-<ms>.bak copy, and the old file lose its
   *  secret fields. Any failure before that leaves every file as it was and runs this session on the old files. Running it again finds nothing. */
  async migrate(now = Date.now()) {
    if (!this.active) return;
    const found = Object.keys(SECRET_FIELDS).map(name => {
      const file = join(this.dir, name), raw = existsSync(file) ? readJson(file) : undefined;
      return {name, file, raw, leaves: raw === undefined ? [] : secretLeaves(name, raw)};
    }).filter(f => f.leaves.length);
    if (!found.length && !this.reencrypt) return;
    // A value in an old file wins: it was saved there before the move, or the owner restored the file on purpose.
    const next = new Map(this.values);
    for (const f of found) for (const [path, v] of f.leaves) next.set(`${f.name}#${path}`, v);
    const temp = `${this.file}.${process.pid}.verify.tmp`;
    try {
      const items: Record<string, string> = {};
      for (const [r, v] of next) items[r] = this.broker ? await this.broker.encrypt(JSON.stringify(v)) : JSON.stringify(v);
      this.write(items, temp);
      const back = readJson(temp)?.items ?? {};
      for (const [r, v] of next) {
        const plain = this.broker ? await this.broker.decrypt(back[r]) : back[r];
        if (plain !== JSON.stringify(v)) throw new Error('mismatch');
      }
      renameSync(temp, this.file);
      this.items = items; this.values = next; this.reencrypt = false;
    } catch {
      rmSync(temp, {force: true});
      this.mode = 'legacy'; this.error = 'Saved keys could not be checked after encrypting, so nothing was moved.';
      return;
    }
    for (const f of found) { copyFileSync(f.file, `${f.file}.pre-secrets-${now}.bak`); writeJsonAtomic(f.file, strip(f.name, f.raw)); }
  }

  /** Deletes migration backups older than BACKUP_DAYS. */
  pruneBackups(now = Date.now()) {
    for (const n of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      const at = Number(BACKUP.exec(n)?.[1]);
      if (at && now - at > BACKUP_DAYS * 86_400_000) rmSync(join(this.dir, n), {force: true});
    }
  }
}

// One store per data folder, so every module in a process shares it. A season child gets its models.json refs from the server in
// CAT_TOWN_SECRETS (season-host.ts) and never opens the file; the variable is removed here so nothing it spawns inherits it.
const stores = new Map<string, SecretStore>();
const fromEnv = process.env.CAT_TOWN_SECRETS;
delete process.env.CAT_TOWN_SECRETS;
let envStore: SecretStore | undefined;
if (fromEnv) {
  envStore = new SecretStore('', undefined, true);
  try { const v = JSON.parse(fromEnv); envStore.update(Object.entries(isObj(v) ? v : {})); } catch { /* none passed */ }
}

/** The store for a data folder: the one the server opened, else a plain one read now. */
export function storeFor(dir: string): SecretStore {
  if (envStore) return envStore;
  const key = resolve(dir);
  let s = stores.get(key);
  if (!s) { s = new SecretStore(key).loadSync(); stores.set(key, s); }
  return s;
}

/** The server's boot: load, move old files in, prune backups. Await it before any module reads a secret. */
export async function openSecretStore(dir: string, broker?: Broker, now = Date.now()) {
  const usable = broker && await broker.available().catch(() => false);
  const s = new SecretStore(resolve(dir), usable ? broker : undefined);
  await s.load();
  await s.migrate(now);
  s.pruneBackups(now);
  stores.set(s.dir, s);
  return s;
}
/** Tests only: forget the cached stores. */
export const resetSecretStores = () => stores.clear();

/** obj read from <dir>/<name> with its secret fields filled from the store. A value still in the file wins (see migrate); a ref whose parent
 *  object is gone is not brought back. Legacy still fills from what an earlier boot stored; locked has nothing to fill. */
export function withSecrets<T>(file: string, obj: T): T {
  const s = storeFor(dirname(file)), name = basename(file);
  if (s.mode === 'locked' || !isObj(obj)) return obj;
  const out: any = structuredClone(obj);
  for (const [ref, v] of Object.entries(s.of(name))) {
    const path = ref.slice(name.length + 1).split('.');
    if (!matches(name, path)) continue;
    const last = path.pop()!, parent = path.reduce((o: any, k) => (isObj(o) ? o[k] : undefined), out);
    if (isObj(parent) && parent[last] === undefined) parent[last] = v;
  }
  return out;
}
/** What to write to <dir>/<name>: obj without its secret fields, which go to the store. Refs of this file that obj no longer has are removed.
 *  Locked or legacy: obj as it is, so the old file keeps working. */
export function withoutSecrets<T>(file: string, obj: T): T {
  const s = storeFor(dirname(file)), name = basename(file);
  if (!s.active) return obj;
  const found = new Map(secretLeaves(name, obj).map(([p, v]) => [`${name}#${p}`, v]));
  s.update([...Object.keys(s.of(name)).filter(r => !found.has(r)).map(r => [r, undefined] as [string, unknown]), ...found]);
  return strip(name, obj);
}
/** obj without its secret fields when the store is in use, without saving anything (a write that must win a race first). */
export const stripSecrets = <T>(file: string, obj: T): T => storeFor(dirname(file)).active ? strip(basename(file), obj) : obj;
/** The file is deleted: so are its refs. */
export function dropSecrets(file: string) { const s = storeFor(dirname(file)); if (s.active) s.update(Object.keys(s.of(basename(file))).map(r => [r, undefined])); }

/** The broker in the desktop app's server: requests go to the main process over the IPC channel main.cjs opened. Undefined under `npm start`. */
export function ipcBroker(proc: NodeJS.Process = process, timeoutMs = 5_000): Broker | undefined {
  if (!proc.send || proc.env.CAT_SECRETS_BROKER !== '1') return undefined;
  let n = 0;
  const waiting = new Map<number, {ok: (v: any) => void; fail: (e: Error) => void}>();
  proc.on('message', (m: any) => {
    const w = typeof m?.secretReply === 'number' ? waiting.get(m.secretReply) : undefined;
    if (!w) return;
    waiting.delete(m.secretReply);
    m.ok ? w.ok(m.result) : w.fail(new Error(String(m.error ?? 'The desktop app refused.')));
  });
  // A request the app never answers fails, so a migration aborts rather than hangs. No value is ever put in an error.
  const call = (op: string, data: string) => new Promise<any>((ok, fail) => {
    const id = ++n, timer = setTimeout(() => { waiting.delete(id); fail(new Error('The desktop app did not answer.')); }, timeoutMs);
    timer.unref?.();
    waiting.set(id, {ok: v => { clearTimeout(timer); ok(v); }, fail: e => { clearTimeout(timer); fail(e); }});
    proc.send!({secret: id, op, data});
  });
  return {available: () => call('available', '').then(Boolean), encrypt: t => call('encrypt', t).then(String), decrypt: b => call('decrypt', b).then(String)};
}

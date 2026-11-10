// Worlds: independent towns in one data dir. "home" is the town that already lives in the data dir root, so its files
// stay where they are. Every other world lives in <dataDir>/worlds/<id>/. worlds.json, in the root, is the registry and
// the only thing that maps a world id to a directory. Models, devices, push keys, the tunnel and the Workshop distro stay global.
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {Store,type Event} from './store.ts';
import type {Live} from './state-delta.ts';
import {Town, type HermesLink, type MemberBudgets} from './engine.ts';
import {economyOn} from './config.ts';
import {foundingCats} from './roles.ts';
import {SeasonHost} from './season-host.ts';
import {SeasonWatch, type CoinTotals} from './season-watch.ts';
import {Workshop} from './workshop.ts';
import {seasonSummary} from './season-view.ts';
import {loadAutonomy} from './autonomy.ts';
import {openCatBrowser, ownChrome, signedInHandle} from './cat-browser.ts';
import type {MediaRuntime} from './media.ts';
import type {ClaudeRuntime} from './claude-tools.ts';
import type {ConnectorRuntime} from './connector-types.ts';
import {checkTownDefault, type TownDefault} from './ai-options.ts';
import type {RealMoney} from './real-money.ts';

export const HOME = 'home';
const REGISTRY = 'worlds.json';
// A world's own town default. It sits in the world's folder; a world without one uses the global default in models.json.
const TOWN_DEFAULT_FILE = 'town-default.json';

/** The world's saved default, or null when unset or damaged. A damaged file falls back to the global default, never to demo. */
export function readWorldTownDefault(dir: string): TownDefault | null {
  const file = join(dir, TOWN_DEFAULT_FILE);
  if (!existsSync(file)) return null;
  try { return checkTownDefault(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}
const NAME_MAX = 40;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type WorldRecord = {id: string; name: string; createdAt: string; dir: string; archivedAt?: string};
export type Registry = {active: string; worlds: WorldRecord[]};
export class WorldError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

export function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new WorldError('Give the world a name.');
  if ([...name].length > NAME_MAX) throw new WorldError(`World names are at most ${NAME_MAX} characters.`);
  return name;
}

export function newWorldId(name: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'world';
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

// A registry dir must resolve inside the data dir, so a hand-edited worlds.json cannot point a world at another folder.
export function resolveWorldDir(dataDir: string, dir: string): string {
  const full = resolve(dataDir, dir);
  const rel = relative(resolve(dataDir), full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`World folder ${dir} is outside the data dir.`);
  return full;
}

export function readRegistry(dataDir: string, now: () => string = () => new Date().toISOString()): Registry {
  const file = join(dataDir, REGISTRY);
  if (!existsSync(file)) return {active: HOME, worlds: [{id: HOME, name: 'Clowder', createdAt: now(), dir: '.'}]};
  let raw: any; // untrusted JSON from disk: each field is checked below
  // Fail closed: a damaged registry is reported, never quietly replaced by a fresh one.
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`${file} is damaged (${(err as Error).message}). Fix or move it; no world was changed.`); }
  if (!raw || typeof raw.active !== 'string' || !Array.isArray(raw.worlds)) throw new Error(`${file} has no world list.`);
  const seen = new Set<string>();
  const worlds: WorldRecord[] = raw.worlds.map((w: any) => {
    const valid = w && typeof w.id === 'string' && (w.id === HOME || ID.test(w.id)) && w.id.length <= 60 && !seen.has(w.id)
      && typeof w.name === 'string' && typeof w.dir === 'string' && typeof w.createdAt === 'string';
    if (!valid) throw new Error(`${file} has a bad world entry.`);
    resolveWorldDir(dataDir, w.dir);
    seen.add(w.id);
    return {id: w.id, name: w.name, createdAt: w.createdAt, dir: w.dir, ...(typeof w.archivedAt === 'string' ? {archivedAt: w.archivedAt} : {})};
  });
  const active = worlds.find(w => w.id === raw.active);
  if (!active || active.archivedAt) throw new Error(`${file} names an active world that is missing or archived.`);
  return {active: raw.active, worlds};
}

// Write to a temp file, then rename, so a crash never leaves half a registry.
function writeRegistry(dataDir: string, registry: Registry) {
  mkdirSync(dataDir, {recursive: true});
  const file = join(dataDir, REGISTRY);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`); renameSync(temp, file); }
  catch (err) { rmSync(temp, {force: true}); throw err; }
}

// The only folder a delete may remove: exactly <data>/worlds/<id>, with no link at any level. Real paths are compared on both sides,
// so an 8.3 short name or a junction cannot make the check pass. A folder that is already gone is returned as-is; removing it does nothing.
function deletableFolder(dataDir: string, record: WorldRecord): string {
  const target = resolveWorldDir(dataDir, record.dir);
  if (target !== resolve(dataDir, 'worlds', record.id)) throw new WorldError('That world’s folder does not match its registry entry.', 409);
  if (!existsSync(target)) return target;
  const worldsRoot = realpathSync.native(join(dataDir, 'worlds'));
  if (worldsRoot !== join(realpathSync.native(dataDir), 'worlds')) throw new WorldError('The worlds folder is not inside the data folder.', 409);
  if (lstatSync(target).isSymbolicLink() || realpathSync.native(target) !== join(worldsRoot, record.id)) {
    throw new WorldError('That world’s folder is a link, not a world folder. Nothing was deleted.', 409);
  }
  return target;
}

export type WorldServices = {dir: string; store: Store; town: Town; seasons: SeasonHost; feed: SeasonWatch; workshop: Workshop};
export type WorldHostOptions = {root: string; dataDir: string; config: any; providers: Record<string, any>; now?: () => string; media?: () => MediaRuntime | null; claude?: () => ClaudeRuntime | null; townDefault?: () => TownDefault | null; realMoney?: RealMoney; connectors?: () => ConnectorRuntime | null; secrets?: () => unknown[]; hermes?: () => HermesLink | null; personName?: (id: string) => string | undefined; members?: MemberBudgets};

export class WorldHost {
  /** Store events of the active world only. Push reads these. */
  readonly storeListeners = new Set<() => void>();
  /** Every SSE feed. Fired with each store event, and with none after a switch (the `data: changed` frame). */
  readonly clients = new Set<(event?: Event) => void>();
  readonly seasonClients = new Set<(totals: CoinTotals) => void>();
  /** The active world's transient frames (live text, heartbeats): never journaled, sent to owner pages only (state-delta.ts transient). */
  readonly live = new Set<(frame: Live) => void>();
  /** Fired after a switch, before clients are told. Push resets its season baseline here. */
  readonly switched = new Set<() => void>();
  private reg: Registry;
  private current: WorldServices;

  constructor(private opts: WorldHostOptions) {
    this.reg = readRegistry(opts.dataDir, this.now);
    this.current = this.load(this.recordOf(this.reg.active));
    this.current.feed.start();
    this.attach(this.current);
  }

  private get now() { return this.opts.now ?? (() => new Date().toISOString()); }
  get store() { return this.current.store; }
  get town() { return this.current.town; }
  get seasons() { return this.current.seasons; }
  get workshop() { return this.current.workshop; }
  /** The active world's folder. Per-world files are read and written here. */
  get dir() { return this.current.dir; }
  get activeId() { return this.reg.active; }
  /** True until the owner has seen the intro of a world founded fresh. Journals from before the flag existed are never pending. */
  get introPending() { return this.store.state.introduced === false; }
  markIntroSeen() { if (this.introPending) this.store.emit('world.introduced', {introduced: true}); return this.introPending; }
  activeWorld() { return {id: this.reg.active, name: this.recordOf(this.reg.active).name}; }

  list() {
    return {
      active: this.reg.active,
      worlds: this.reg.worlds.filter(w => !w.archivedAt).map(w => this.describe(w)),
      archived: this.reg.worlds.filter(w => w.archivedAt).map(w => this.describe(w)),
    };
  }

  /** The world's own default when it is set and its provider is built. Null means the global default applies. */
  ownTownDefault(dir: string): TownDefault | null {
    const td = readWorldTownDefault(dir);
    return td && this.opts.providers[td.provider] ? td : null;
  }

  create(rawName: unknown, rawDefault?: unknown) {
    const name = cleanName(rawName);
    const id = newWorldId(name);
    const record: WorldRecord = {id, name, createdAt: this.now(), dir: `worlds/${id}`};
    const dir = resolveWorldDir(this.opts.dataDir, record.dir);
    const chosen = rawDefault === undefined || rawDefault === null ? null : this.checkedDefault(rawDefault);
    try {
      // Building the services founds the town: the Store writes `founded`, and the Town plans homes and looks.
      this.load(record);
      if (chosen) writeFileSync(join(dir, TOWN_DEFAULT_FILE), JSON.stringify(chosen, null, 2) + '\n');
      writeRegistry(this.opts.dataDir, {...this.reg, worlds: [...this.reg.worlds, record]});
    } catch (err) {
      rmSync(dir, {recursive: true, force: true});
      throw err;
    }
    this.reg = {...this.reg, worlds: [...this.reg.worlds, record]};
    return this.describe(record);
  }

  private checkedDefault(raw: unknown): TownDefault {
    let td: TownDefault;
    try { td = checkTownDefault(raw as {provider?: unknown; model?: unknown; effort?: unknown}); } catch (err) { throw new WorldError((err as Error).message); }
    if (!this.opts.providers[td.provider]) throw new WorldError('That provider is not ready. Pick another, or set it up in Models first.');
    return td;
  }

  /** Owner-only switch. Everything is loaded before anything changes, so a damaged target leaves the current world running. */
  activate(id: string) {
    const record = this.liveRecord(id);
    if (id === this.reg.active) return this.list();
    const busy = this.busyReason();
    if (busy) throw new WorldError(`Finish or pause current work first: ${busy}.`, 409);
    const next = this.load(record);
    const registry = {...this.reg, active: id};
    writeRegistry(this.opts.dataDir, registry);
    const previous = this.current;
    this.current = next;
    this.reg = registry;
    previous.feed.stop();
    previous.town.dispose();
    next.feed.start();
    this.attach(next);
    for (const listener of this.switched) listener();
    this.notify();
    return this.list();
  }

  rename(id: string, rawName: unknown) {
    const name = cleanName(rawName);
    const record = this.liveRecord(id);
    this.reg = {...this.reg, worlds: this.reg.worlds.map(w => w.id === record.id ? {...w, name} : w)};
    writeRegistry(this.opts.dataDir, this.reg);
    if (id === this.reg.active) this.notify();
    return this.describe(this.recordOf(id));
  }

  archive(id: string) {
    const record = this.liveRecord(id);
    if (id === this.reg.active) throw new WorldError('The active world cannot be archived. Visit another world first.', 409);
    this.reg = {...this.reg, worlds: this.reg.worlds.map(w => w.id === record.id ? {...w, archivedAt: this.now()} : w)};
    writeRegistry(this.opts.dataDir, this.reg);
    return this.list();
  }

  unarchive(id: unknown) {
    const record = this.anyRecord(id);
    if (!record.archivedAt) return this.list();
    this.reg = {...this.reg, worlds: this.reg.worlds.map(w => {
      if (w.id !== record.id) return w;
      const {archivedAt: _restored, ...live} = w;
      return live;
    })};
    writeRegistry(this.opts.dataDir, this.reg);
    return this.list();
  }

  /**
   * Permanent. Refusals come first and change nothing. The registry entry goes first (atomically), then the folder.
   * A folder that cannot be removed is reported, because the world is already off the list by then.
   */
  delete(id: unknown) {
    const record = this.anyRecord(id);
    if (record.id === HOME) throw new WorldError("The home world can't be deleted; archive it instead", 409);
    if (record.id === this.reg.active) throw new WorldError('The active world cannot be deleted. Visit another world first.', 409);
    const folder = deletableFolder(this.opts.dataDir, record);
    const run = new SeasonHost({root: this.opts.root, dataDir: folder, sharedDataDir: this.opts.dataDir}).running();
    if (run) throw new WorldError(`A season is running in ${record.name}. Stop it first.`, 409);
    const remaining = this.reg.worlds.filter(w => w.id !== record.id);
    writeRegistry(this.opts.dataDir, {...this.reg, worlds: remaining});
    this.reg = {...this.reg, worlds: remaining};
    this.catCache.delete(record.id);
    try {
      rmSync(folder, {recursive: true, force: true});
    } catch (err) {
      throw new WorldError(`${record.name} was removed from the list, but its folder could not be deleted (${(err as Error).message}). Remove ${folder} by hand.`, 500);
    }
    return this.list();
  }

  close() { this.current.feed.stop(); this.current.town.dispose(); }

  private busyReason(): string | null {
    if (this.current.town.isBusy()) return 'work is still running';
    if (this.current.seasons.running()) return 'a season is running';
    return null;
  }

  private recordOf(id: string): WorldRecord {
    const record = this.reg.worlds.find(w => w.id === id);
    if (!record) throw new WorldError('Unknown world.', 404);
    return record;
  }

  // Ids come only from the request; they are checked against the slug pattern, looked up in the registry, and never used to build a path.
  private anyRecord(id: unknown): WorldRecord {
    if (typeof id !== 'string' || !(id === HOME || ID.test(id))) throw new WorldError('Unknown world.', 404);
    const record = this.reg.worlds.find(w => w.id === id);
    if (!record) throw new WorldError('Unknown world.', 404);
    return record;
  }

  private liveRecord(id: unknown): WorldRecord {
    const record = this.anyRecord(id);
    if (record.archivedAt) throw new WorldError('Unknown world.', 404);
    return record;
  }

  private describe(record: WorldRecord) {
    const cats = this.catsOf(record);
    return {
      id: record.id, name: record.name, createdAt: record.createdAt,
      ...(record.archivedAt ? {archivedAt: record.archivedAt} : {}),
      ...(cats === undefined ? {} : {cats}),
    };
  }

  // Cat count for the list. A world that is not loaded is replayed from its journal, and the answer is cached until the file changes.
  // undefined means the journal could not be read, so the card shows no count rather than a wrong one.
  private catCache = new Map<string, {key: string; cats: number}>();
  private catsOf(record: WorldRecord): number | undefined {
    if (record.id === this.reg.active) return this.current.store.state.cats.length;
    const file = join(resolveWorldDir(this.opts.dataDir, record.dir), 'events.jsonl');
    if (!existsSync(file)) return 0;
    const {size, mtimeMs} = statSync(file);
    const key = `${size}:${mtimeMs}`;
    const hit = this.catCache.get(record.id);
    if (hit?.key === key) return hit.cats;
    try {
      // A blank journal would make the Store write a founded event, so it is answered here and never replayed.
      if (!readFileSync(file, 'utf8').trim()) return 0;
      const cats = new Store(file, []).state.cats.length;
      this.catCache.set(record.id, {key, cats});
      return cats;
    } catch {
      return undefined;
    }
  }

  private load(record: WorldRecord): WorldServices {
    const dir = resolveWorldDir(this.opts.dataDir, record.dir);
    const store = new Store(join(dir, 'events.jsonl'), foundingCats(this.opts.config), {readModel: join(dir, 'read-model.db')});
    const town = new Town(store, this.opts.config, this.opts.providers);
    // Off by default (economy.enabled): with the coin economy off, the Mayor's prompt carries no season summary.
    if (economyOn(this.opts.config)) town.economySummary = () => seasonSummary(dir);
    town.autonomy = () => loadAutonomy(dir);
    town.media = this.opts.media ?? (() => null);
    town.claudePlan = this.opts.claude ?? (() => null);
    town.browserWindow = (url) => openCatBrowser(this.opts.dataDir, url);
    town.ownChrome = () => ownChrome(this.opts.dataDir);
    // The owner's own Chrome is never read: a site signed in there stays unchecked.
    town.siteProbe = host => ownChrome(this.opts.dataDir) ? Promise.resolve(null) : signedInHandle(this.opts.dataDir, host);
    // The world's own default first, then the global one from models.json. A world with neither gets no default.
    town.townDefault = () => this.ownTownDefault(dir) ?? this.opts.townDefault?.() ?? null;
    town.realMoney = this.opts.realMoney;
    town.connectors = this.opts.connectors;
    town.secrets = this.opts.secrets;
    town.hermes = this.opts.hermes;
    town.personName = this.opts.personName;
    town.members = this.opts.members;
    // Models stay global: the season child reads them from sharedDataDir, and everything else from its own world folder.
    const seasons = new SeasonHost({root: this.opts.root, dataDir: dir, defaultDays: this.opts.config.economy?.days, sharedDataDir: this.opts.dataDir});
    return {dir, store, town, seasons, feed: new SeasonWatch(dir), workshop: new Workshop({dataDir: dir, settingsDir: this.opts.dataDir})};
  }

  // Forwarders check that their world is still the active one, so a retired store or feed cannot wake clients.
  private attach(services: WorldServices) {
    services.town.live = frame => { if (this.current === services) for (const listener of this.live) listener(frame); };
    services.store.listeners.add(event => {
      if (this.current !== services) return;
      for (const listener of this.storeListeners) listener();
      this.notify(event);
    });
    services.feed.listeners.add(totals => {
      if (this.current === services) for (const listener of this.seasonClients) listener(totals);
    });
  }

  private notify(event?: Event) { for (const listener of this.clients) listener(event); }
}

const nameBody = {type: 'object', required: ['name'], additionalProperties: false, properties: {name: {type: 'string', maxLength: 400}}};
const createBody = {type: 'object', required: ['name'], additionalProperties: false, properties: {
  name: {type: 'string', maxLength: 400},
  townDefault: {type: 'object', additionalProperties: false, required: ['provider'], properties: {provider: {type: 'string', maxLength: 20}, model: {type: 'string', maxLength: 120}, effort: {type: 'string', maxLength: 20}}},
}};
const idParams = {type: 'object', required: ['id'], properties: {id: {type: 'string', maxLength: 80}}};

// Listing is open to every device the listener admits. Writes pass through canWrite: both listeners pass isOwner (the host or a paired owner device).
export function registerWorldRoutes(app: FastifyInstance, host: WorldHost, canWrite: (req: FastifyRequest) => boolean) {
  const ownerOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!canWrite(req)) return reply.code(403).send({error: 'Worlds are managed on the host computer.'});
  };
  app.get('/api/worlds', async () => host.list());
  app.post('/api/worlds', {onRequest: ownerOnly, schema: {body: createBody}}, async req => {
    const body = req.body as {name: string; townDefault?: TownDefault};
    return {world: host.create(body.name, body.townDefault)};
  });
  app.post('/api/worlds/:id/activate', {onRequest: ownerOnly, schema: {params: idParams}}, async req => host.activate((req.params as {id: string}).id));
  app.post('/api/worlds/:id/rename', {onRequest: ownerOnly, schema: {params: idParams, body: nameBody}}, async req =>
    ({world: host.rename((req.params as {id: string}).id, (req.body as {name: string}).name)}));
  app.post('/api/worlds/:id/archive', {onRequest: ownerOnly, schema: {params: idParams}}, async req => host.archive((req.params as {id: string}).id));
  app.post('/api/worlds/:id/unarchive', {onRequest: ownerOnly, schema: {params: idParams}}, async req => host.unarchive((req.params as {id: string}).id));
}

// Owner-only: the owner has seen a new world's intro.
export function registerWorldIntroRoute(app: FastifyInstance, host: WorldHost, canWrite: (req: FastifyRequest) => boolean) {
  app.post('/api/world/intro-seen', {
    onRequest: async (req, reply) => { if (!canWrite(req)) return reply.code(403).send({error: 'Only the owner can mark the intro as seen.'}); },
  }, async () => ({introPending: host.markIntroSeen()}));
}

// Main app only (server.ts registers it on app, never on the tunnel listener).
export function registerWorldDeleteRoute(app: FastifyInstance, host: WorldHost, canWrite: (req: FastifyRequest) => boolean) {
  app.post('/api/worlds/:id/delete', {
    onRequest: async (req, reply) => { if (!canWrite(req)) return reply.code(403).send({error: 'Worlds are managed on the host computer.'}); },
    schema: {params: idParams},
  }, async req => host.delete((req.params as {id: string}).id));
}

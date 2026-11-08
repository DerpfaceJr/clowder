// Accounts and grants: the one place that knows which accounts exist, what each one is, and which cats may use it in which world.
// accounts.json holds metadata only. A secret stays where it is today and secretRef names its file and field, never its value (SecretStore is item 1.7).
import {randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';
import {catBrowserSettings} from './cat-browser.ts';
import {MEDIA_SPECS} from './media.ts';
import {HOSTED_PRESETS, loadSettings, type ModelSettings} from './models.ts';
import {PLAN_SIGN_IN, type PlanFault} from './claude-plan.ts';
import {resolveWorldDir, type Registry} from './worlds.ts';
import type {ToolPermission} from './connector-types.ts';
import {instagramAccounts, instagramTokenExpiry} from './instagram-accounts.ts';
import {directoryEntry} from './connector-directory.ts';
import {authProblem} from './mcp-client.ts';
import type {Store} from './store.ts';

export type AccountKind = 'oauth' | 'token' | 'cli' | 'browser-session' | 'key' | 'none';
// The lifecycle (item 1.2): requested → signing-in → connected | wrong-account | needs-sign-in, then expiring → expired. unchecked: working as far as
// anyone can tell, but no identity endpoint confirmed who it is, so never connected. error is kept for old files; the monitor never sets it.
export type AccountStatus = 'requested' | 'signing-in' | 'connected' | 'expiring' | 'expired' | 'needs-sign-in' | 'wrong-account' | 'error' | 'unchecked';
export type Identity = {handle?: string; email?: string; accountId?: string; checkedAt: number};
// identity is fetched, never typed (item 1.3), so it is null until then. connector: the connector this account is, when it is one.
// expected: who the owner means this account to be (a handle or an email); without it, the @handle in the label (expectedOf).
export type Account = {id: string; service: string; label: string; kind: AccountKind; identity: Identity | null; expected?: string; secretRef: string | null; status: AccountStatus; expiresAt: number | null; refreshable: boolean; lastOkAt: number | null; lastError: string | null; connector?: string};
// world: the world it applies in, or EVERY_WORLD. '*' in cats means every cat of that world. tools: each tool's choice for every cat;
// catTools: one cat's own choice (item 1.4, "Always allow (this cat)"), over tools.
export type Grant = {account: string; cats: string[]; tools: Record<string, ToolPermission>; catTools?: Record<string, Record<string, ToolPermission>>; world: string};
export type Accounts = {accounts: Account[]; grants: Grant[]};
export const EVERY_WORLD = '*';

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown) => [...new Set(arr(v).filter((x): x is string => typeof x === 'string'))];
const fileOf = (dataDir: string) => join(dataDir, 'accounts.json');

/** accounts.json, or none yet. A damaged file is kept as .broken and read as empty: the migration rebuilds the accounts, but a grant only from cats
 *  connectors.json still holds, so no cat gains one. */
export function readAccounts(dataDir: string): Accounts {
  const file = fileOf(dataDir);
  if (!existsSync(file)) return {accounts: [], grants: []};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')); // `any` below: JSON from disk, each field checked here
    if (Array.isArray(v?.accounts) && Array.isArray(v?.grants)) return {
      accounts: v.accounts.filter((a: any) => isObj(a) && typeof a.id === 'string' && typeof a.service === 'string'),
      grants: v.grants.filter((g: any) => isObj(g) && typeof g.account === 'string' && typeof g.world === 'string').map((g: any) => ({account: g.account, cats: strings(g.cats), tools: isObj(g.tools) ? g.tools : {}, ...(isObj(g.catTools) ? {catTools: Object.fromEntries(Object.entries(g.catTools).filter(([, t]) => isObj(t)))} : {}), world: g.world})),
    };
  } catch { /* broken below */ }
  copyFileSync(file, `${file}.broken`);
  return {accounts: [], grants: []};
}
export const saveAccounts = (dataDir: string, a: Accounts) => writeJsonAtomic(fileOf(dataDir), a);

/** The grant for this account in this world: the world's own, else the one for every world. */
export const grantIn = (grants: Grant[], account: string, world: string) =>
  grants.find(g => g.account === account && g.world === world) ?? grants.find(g => g.account === account && g.world === EVERY_WORLD);

// ---- Grant-level policy (item 1.4) ----

/** The one tool-policy decision, shared by the engine's cards, the hub's views and the Hermes gate. An Off for every cat wins (the owner switched
 *  the tool off); then this cat's own choice, then every cat's, then fallback (the tool's default: connectors.ts permissionOf). No cat: every cat's.
 *  The publish ledger's repeat card is not here: it asks under any allow (engine.ts effectCheck). */
export function decideToolPolicy(grant: Pick<Grant, 'tools' | 'catTools'> | undefined, cat: string | undefined, tool: string, fallback: ToolPermission = 'ask'): ToolPermission {
  // Own keys only: a tool or cat named toString must not read Object's.
  const own = <T>(o: Record<string, T> | undefined, k: string | undefined) => o && k !== undefined && Object.hasOwn(o, k) ? o[k] : undefined;
  const all = own(grant?.tools, tool);
  return all === 'off' ? 'off' : own(own(grant?.catTools, cat), tool) ?? all ?? fallback;
}
// A tool card's answers. EVERY_CAT is today's connector-level allow; the bare 'Always allow' of a card filed before item 1.4 means the same.
export const ALLOW_ONCE = 'Allow once', THIS_CAT = 'Always allow (this cat)', EVERY_CAT = 'Always allow (every cat)', OLD_ALWAYS = 'Always allow';
export const SITE_THIS_CAT = 'Always allow for this site (this cat)', SITE_EVERY_CAT = 'Always allow for this site (every cat)';
/** The answers a tool card offers. Every effect class gets the same (D1: money and deletes included, behind the publish ledger). repeat: the ledger's
 *  repeat card, which never offers an Always allow. browse: per site, and only when the run names its start page. */
export function cardOptions(o: {repeat?: boolean; browse?: boolean; site?: string | null} = {}): string[] {
  if (o.repeat) return [ALLOW_ONCE, 'Deny'];
  if (o.browse) return o.site ? [ALLOW_ONCE, SITE_THIS_CAT, SITE_EVERY_CAT, 'Deny'] : [ALLOW_ONCE, 'Deny'];
  return [ALLOW_ONCE, THIS_CAT, EVERY_CAT, 'Deny'];
}
/** Which Always allow an answer is: 'cat', 'every', or null for Allow once, Deny and anything typed. */
export const alwaysScope = (answer: string): 'cat' | 'every' | null => answer === THIS_CAT || answer === SITE_THIS_CAT ? 'cat' : answer === EVERY_CAT || answer === SITE_EVERY_CAT || answer === OLD_ALWAYS ? 'every' : null;
/** A browse run's site: the start page's host without www., as the cats'-browser Account names it (engine.ts browse). */
export const siteOf = (url?: unknown) => { try { return typeof url === 'string' && url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };

const account = (id: string, service: string, label: string, kind: AccountKind, secretRef: string | null): Account =>
  ({id, service, label, kind, identity: null, secretRef, status: secretRef || kind === 'cli' || kind === 'none' ? 'unchecked' : 'needs-sign-in', expiresAt: null, refreshable: false, lastOkAt: null, lastError: null});
/** A site signed in through the cats' browser (item 1.8), one per host. No secret: the session lives in the browser profile. The service keeps
 *  its 'browser:' prefix so no connect step (a directory id) ever reads as covering it. */
export const browserAccount = (host: string) => account(`browser:${host}`, `browser:${host}`, host, 'browser-session', null);

// Plans, keys and the Playwright extension's token, as the AI models file and the cats' browser file hold them today. Ids carry a ':', which no connector id can.
function settingAccounts(dataDir: string): Account[] {
  let s: ModelSettings = {};
  try { s = loadSettings(join(dataDir, 'models.json')); } catch { /* the models hub reports a damaged file; its accounts come on a later boot */ }
  const hosted = s.hosted, preset = hosted && HOSTED_PRESETS.find(p => p.base === hosted.base);
  return [
    ...(s.claude ? [account('models:claude', 'claude-plan', 'Claude plan', 'cli', null)] : []),
    ...(s.chatgpt ? [account('models:chatgpt', 'chatgpt-plan', 'ChatGPT plan', 'cli', null)] : []),
    ...(hosted ? [account('models:hosted', `api:${preset ? preset.id : 'custom'}`, `API · ${hosted.model}`, 'key', 'models.json#hosted.key')] : []),
    ...(s.jev ? [account('models:jev', 'jev', 'Jev', 'key', 'models.json#jev.key')] : []),
    // A media provider with no key field set (a local MoneyPrinterTurbo) needs no sign-in.
    ...Object.entries(s.media ?? {}).map(([id, f]) => account(`models:media:${id}`, `media:${id}`, MEDIA_SPECS[id]?.label ?? id, f.key ? 'key' : 'none', f.key ? `models.json#media.${id}.key` : null)),
    // The Telegram bot (telegram.ts). Its token stays in telegram.json; the chat it is paired with is a device in Devices.
    ...(existsSync(join(dataDir, 'telegram.json')) ? [account('telegram:bot', 'telegram', 'Telegram bot', 'token', 'telegram.json#token')] : []),
    // The Discord bot (discord.ts), the same way: discord.json holds the token, the paired DM is a device.
    ...(existsSync(join(dataDir, 'discord.json')) ? [account('discord:bot', 'discord', 'Discord bot', 'token', 'discord.json#token')] : []),
    ...(existsSync(join(dataDir, 'cat-browser.json')) ? [account('cat-browser:playwright', 'playwright-ext', 'Playwright extension', 'token', catBrowserSettings(dataDir).token ? 'cat-browser.json#token' : null)] : []),
  ];
}

// The cat ids each registered world's journal founded or created. Only lines that match the two event types as text are parsed.
// ponytail: reads every journal whole, once, and only while a named-cat grant is still to migrate.
function journalCats(dataDir: string, reg: Registry): Map<string, Set<string>> {
  return new Map(reg.worlds.map(w => {
    const file = join(resolveWorldDir(dataDir, w.dir), 'events.jsonl'), cats = new Set<string>();
    if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"type":"cat.created"') && !line.includes('"type":"founded"')) continue;
      try { const e = JSON.parse(line); for (const cat of e.type === 'founded' ? arr(e.data?.cats) : e.type === 'cat.created' ? [e.data] : []) if (typeof cat?.id === 'string') cats.add(cat.id); } catch { /* a torn last line */ }
    }
    return [w.id, cats] as const;
  }));
}

/** The boot migration, in place. Each connector, plan, key and extension token without an Account gets one, and a connector also gets its Grants from the
 *  cats and tools its connectors.json entry held. An every-cat grant stays in every world. A named cat goes to each world whose journal has it, the Mayor
 *  to every world, and a cat no journal has to the world open at boot, so no cat is lost whichever world is open. Anything with an Account already is
 *  left alone, so a second run changes nothing. */
export function migrateAccounts(dataDir: string, a: Accounts, reg: Registry, connectors: {account: Account; cats?: unknown; tools?: unknown}[]) {
  const have = new Set(a.accounts.map(x => x.id));
  let seen: Map<string, Set<string>> | undefined;
  for (const c of connectors) {
    if (have.has(c.account.id)) continue;
    a.accounts.push(c.account);
    if (a.grants.some(g => g.account === c.account.id)) continue;
    const account = c.account.id, cats = strings(c.cats), tools = isObj(c.tools) ? c.tools : {};
    if (cats.includes('*')) { a.grants.push({account, cats, tools: {...tools}, world: EVERY_WORLD}); continue; }
    const known = (seen ??= journalCats(dataDir, reg)), nowhere = (cat: string) => ![...known.values()].some(s => s.has(cat));
    const placed = reg.worlds.map(w => ({world: w.id, cats: cats.filter(cat => cat === 'mayor' || known.get(w.id)!.has(cat) || (w.id === reg.active && nowhere(cat)))})).filter(g => g.cats.length);
    for (const g of placed.length ? placed : [{world: reg.active, cats: []}]) a.grants.push({account, cats: g.cats, tools: {...tools}, world: g.world});
  }
  for (const x of settingAccounts(dataDir)) if (!have.has(x.id)) a.accounts.push(x);
}

// ---- Health (item 1.2) and identity (item 1.3) ----

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** States the owner must act on. Each change into one files one quest for the account, however many cats hit it. error: a plan that has not answered several times in a row. */
export const ATTENTION = new Set<AccountStatus>(['needs-sign-in', 'wrong-account', 'expiring', 'expired', 'error']);
// How early a sign-in that cannot renew itself is flagged: Instagram's ~60-day token a week ahead, anything else 2 h ahead (auth §5.5).
export const warnBefore = (service: string) => service === 'instagram' ? 7 * DAY : 2 * HOUR;
const shown = (x: string) => /^[^@]+@/.test(x) ? x : `@${x.replace(/^@/, '')}`;
/** Who the account should be, as shown: the owner's choice, else the @handle its label carries ("instagram @example_shop"), else nobody. */
export const expectedOf = (a: Pick<Account, 'expected' | 'label'>) => { const x = a.expected?.trim() || /@([A-Za-z0-9._-]+)\s*$/.exec(a.label)?.[1]; return x ? shown(x) : null; };
/** An identity as a card or quest shows it: @handle, else the email, else the id. */
export const identityText = (i: Identity | null | undefined) => !i ? null : i.handle ? shown(i.handle) : i.email ?? i.accountId ?? null;
const norm = (x: string) => x.replace(/^@/, '').toLowerCase();
const isWho = (i: Identity, want: string) => [i.handle, i.email, i.accountId].some(x => !!x && norm(x) === norm(want));
const inWords = (ms: number) => ms < 48 * HOUR ? `${Math.max(1, Math.round(ms / HOUR))} h` : `${Math.round(ms / DAY)} days`;

/** What one probe found. fact: the settings decide it without a call. identity undefined: no identity endpoint. refused: the endpoint turned the
 *  sign-in down. expiresAt: an expiry the service just gave. credsAt: when the credentials last changed (the hub's clock). */
export type Probe = {fact?: AccountStatus; reason?: string; identity?: Identity | null; refused?: string; expiresAt?: number | null; credsAt?: number};

/** One probe's verdict, pure: expired, refused, someone else, ending soon, else connected (identity verified) or unchecked. */
export function verdict(a: Pick<Account, 'service' | 'label' | 'expected' | 'expiresAt' | 'refreshable'>, p: Probe, now: number): {status: AccountStatus; reason: string} {
  if (p.fact) return {status: p.fact, reason: p.reason ?? ''};
  const left = a.expiresAt !== null && !a.refreshable ? a.expiresAt - now : Infinity, want = expectedOf(a);
  if (left <= 0) return {status: 'expired', reason: 'The sign-in ended and cannot renew itself.'};
  if (p.refused) return {status: 'needs-sign-in', reason: p.refused};
  if (p.identity && want && !isWho(p.identity, want)) return {status: 'wrong-account', reason: `Signed in as ${identityText(p.identity)}, not ${want}.`};
  if (left <= warnBefore(a.service)) return {status: 'expiring', reason: `The sign-in ends in ${inWords(left)} and cannot renew itself.`};
  return {status: p.identity ? 'connected' : 'unchecked', reason: ''};
}

/** whoami: who a credential signs in as. Instagram through Graph me/accounts (the account whose id the connector posts to), GitHub through
 *  GET /user, an OAuth server through the userinfo endpoint its metadata listed. Any other service has none, so identity stays undefined.
 *  A network failure throws, and the monitor keeps the state it had: a check that did not run proves nothing. */
export async function whoami(c: {service: string; token: string | null; igAccount?: string; userinfo?: string; graphVersion?: string}, f: typeof fetch, now: number): Promise<Probe> {
  if (!c.token) return {};
  if (c.service === 'instagram') {
    let found;
    try { found = await instagramAccounts(c.token, f, c.graphVersion); }
    catch (e) { const m = (e as Error).message; if (authProblem(m)) return {refused: m}; throw e; }
    const mine = found.find(x => x.id === c.igAccount), expiresAt = await instagramTokenExpiry(c.token, f, c.graphVersion);
    if (!found.length) return {refused: 'The token reaches no Instagram account.', expiresAt};
    // A token that does not reach the account the connector posts to is signed in as someone else: the ones it does reach are named.
    return {identity: mine ? {handle: mine.username, accountId: mine.id, checkedAt: now} : {handle: found.map(x => x.username).join(', @'), checkedAt: now}, expiresAt};
  }
  const url = c.service === 'github' ? 'https://api.github.com/user' : c.userinfo;
  if (!url) return {};
  const res = await f(url, {headers: {authorization: `Bearer ${c.token}`, accept: 'application/json', 'user-agent': 'Clowder'}, signal: AbortSignal.timeout(15_000)});
  // A 403 that is GitHub's rate limit says nothing about the token.
  if (res.status === 401 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') !== '0')) return {refused: `${c.service === 'github' ? 'GitHub' : 'The sign-in server'} refused the sign-in (HTTP ${res.status}).`};
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j: any = await res.json().catch(() => ({})), str = (v: unknown) => typeof v === 'string' && v ? v.slice(0, 100) : undefined;
  // GitHub names a fine-grained token's end in a header ("2026-12-01 00:00:00 UTC").
  const ends = Date.parse(res.headers.get('github-authentication-token-expiration') ?? '');
  const identity = c.service === 'github' ? {handle: str(j.login), email: str(j.email), accountId: typeof j.id === 'number' ? String(j.id) : undefined, checkedAt: now}
    // OpenID userinfo (Google: email, sub) or Microsoft Graph me (mail, else userPrincipalName for an account with no mailbox; id).
    : {handle: str(j.preferred_username) ?? str(j.nickname), email: str(j.email) ?? str(j.mail) ?? str(j.userPrincipalName), accountId: str(j.sub) ?? str(j.id), checkedAt: now};
  return {identity, ...(Number.isFinite(ends) ? {expiresAt: ends} : {})};
}

/** Where the monitor reads accounts and runs probes: the connector hub, which keeps every secret to itself. record writes accounts.json. */
// account(id) finds any Account, a model plan's included: only connectors are probed, but a plan's outcome is still recorded on its Account.
export type HealthSource = {healthAccounts(): Account[]; probe(id: string): Promise<Probe>; record(id: string, r: {status: AccountStatus; reason: string; identity?: Identity | null; expiresAt?: number | null}): void; account?(id: string): Account | undefined};
/** A cats'-browser quest's own fields (owner.step): the cat Mark done restarts, its task mode, and the page Open the cats' browser shows. */
export type BrowserStep = {title: string; steps: string; cat: string; mode: string; url?: string};
const DONE_NOTE: Partial<Record<AccountStatus, string>> = {unchecked: 'Works again.', 'signing-in': 'Sign-in started.', requested: 'A connect step covers it.'};

/** The health monitor: at boot and every 15 min it probes each account, journals each state change as account.state in the open world, and keeps
 *  one owner quest per account per state change, whichever cats hit it. Cats' auth failures come in through report(), not as owner steps. */
export class AccountMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private again = false;
  private reportedAt = new Map<string, number>();
  private timeouts = new Map<string, number>(); // plan timeouts in a row, per account
  private readonly now: () => number;
  // strikes: how many timeouts in a row mark a plan (read per call, so a town.config.json change applies without a restart).
  constructor(private o: {source: HealthSource; store: () => Store; now?: () => number; everyMs?: number; strikes?: () => number}) { this.now = o.now ?? Date.now; }

  start() { void this.tick(); this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 15 * 60_000); this.timer.unref(); }
  stop() { clearInterval(this.timer); }

  /** One sweep over every account. A call while one runs asks for one more after it, so credentials saved mid-sweep are still checked. */
  tick(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    return this.running = (async () => { do { this.again = false; await this.sweep(); } while (this.again); })().finally(() => { this.running = undefined; });
  }

  private async sweep() {
    for (const a of this.o.source.healthAccounts()) await this.one(a).catch(() => undefined); // not measured: the state stays as it was
  }

  /** One account checked now, as a sweep would: a token pasted on any owner device gets its whoami at once (item 1.6). The verdict comes back
   *  before settle turns a refusal into `requested`, so the caller can tell a token that works from one that does not. Throws when not measured. */
  async check(id: string): Promise<{status: AccountStatus; reason: string; identity: string | null} | undefined> {
    const a = this.o.source.healthAccounts().find(x => x.id === id);
    return a && this.one(a);
  }

  private async one(a: Account) {
    const started = this.now(), p = await this.o.source.probe(a.id);
    if ((this.reportedAt.get(a.id) ?? -Infinity) >= started) return; // a cat's report landed meanwhile and is newer
    // A cat's auth failure stands until something proves it wrong: the settings, a verified identity, or credentials changed since.
    const rec = this.o.store().state.accounts[a.id];
    if (rec?.by === 'report' && !p.fact && !p.identity && (p.credsAt ?? 0) <= rec.since) return;
    const acct = p.expiresAt !== undefined ? {...a, expiresAt: p.expiresAt} : a, v = verdict(acct, p, this.now());
    this.settle(acct, v.status, v.reason, p.identity, 'probe', p.expiresAt);
    return {...v, identity: identityText(p.identity)};
  }

  /** A cat's tool call was refused for the account's sign-in ('auth') or a missing permission ('scope'). Each report is journaled as account.error;
   *  the first moves the account and files its quest, the rest find it moved already. message must already be free of secrets. */
  report(id: string, cat: string, kind: 'auth' | 'scope', message: string) {
    const a = this.o.source.healthAccounts().find(x => x.id === id);
    if (!a) return;
    this.reportedAt.set(id, this.now());
    this.o.store().emit('account.error', {id, cat, kind, error: message.slice(0, 300)});
    const expired = a.expiresAt !== null && !a.refreshable && a.expiresAt <= this.now();
    this.settle(a, expired ? 'expired' : 'needs-sign-in', expired ? 'The sign-in ended and cannot renew itself.' : `A call was refused${kind === 'scope' ? ' for a permission the sign-in lacks' : ''}: ${message.slice(0, 200)}`, undefined, 'report');
  }

  /** A plan call's outcome, from its provider (claude-plan.ts). A sign-in problem moves the plan's Account to needs-sign-in; a usage limit is a note,
   *  not a failure; a timeout counts, and only as many in a row as strikes() sets mark it (error). A call that works clears all of it. */
  plan(id: string, fault: PlanFault) {
    const a = this.o.source.account?.(id);
    if (!a) return;
    const misses = fault === 'timeout' ? (this.timeouts.get(id) ?? 0) + 1 : 0;
    if (misses) this.timeouts.set(id, misses); else this.timeouts.delete(id);
    if (fault === 'signin') this.settle(a, 'needs-sign-in', `${a.label} needs you to sign in again.`, undefined, 'report');
    else if (fault === 'limit') this.settle(a, 'unchecked', `${a.label} has hit its usage limit. It works again when the limit resets.`, undefined, 'report');
    else if (fault === 'ok') { const rec = this.o.store().state.accounts[id]; if (rec && ATTENTION.has(rec.status as AccountStatus)) this.settle(a, 'unchecked', 'Works again.', undefined, 'report'); }
    else if (misses && misses >= (this.o.strikes?.() ?? Infinity)) this.settle(a, 'error', `${a.label} did not answer ${misses} times in a row.`, undefined, 'report');
  }

  /** A browse run stopped for the owner on this site (item 1.8): its Account moves to needs-sign-in and files its one quest, with the browser
   *  fields (step) so the quest opens the cats' browser and Mark done hands the work back to that cat. A second run finds it moved already. */
  browserSignIn(a: Account, reason: string, step: BrowserStep) { this.settle(a, 'needs-sign-in', reason, undefined, 'report', undefined, step); }

  /** The owner marked the sign-in done (handle undefined: unchecked at once, so a cat stopping there again files a new quest), or the probe read
   *  the page: a handle makes it connected. Not through one(): its report guard would keep a probe that found no handle from landing. */
  browserChecked(a: Account, handle?: string) {
    const identity = handle ? {handle, checkedAt: this.now()} : undefined, v = verdict(a, {identity}, this.now());
    this.settle(a, v.status, v.status === 'unchecked' ? 'The owner marked the sign-in done; no page named who it is.' : v.reason, identity, handle ? 'probe' : 'report');
  }

  private settle(a: Account, status: AccountStatus, reason: string, identity: Identity | null | undefined, by: 'probe' | 'report', expiresAt?: number | null, step?: BrowserStep) {
    const store = this.o.store(), rec = store.state.accounts[a.id];
    // requested: a cat's own connect step for this service is open, and that step is the quest.
    if (status === 'needs-sign-in' && store.state.ownerSteps.some(s => s.status === 'open' && !s.account && !!s.connect && (s.connect === a.service || s.connect === a.connector))) status = 'requested';
    this.o.source.record(a.id, {status, reason, ...(identity !== undefined ? {identity} : {}), ...(expiresAt !== undefined ? {expiresAt} : {})});
    const who = identity === undefined ? rec?.identity ?? null : identityText(identity), want = expectedOf(a), bad = ATTENTION.has(status);
    // A cats'-browser quest the owner dismissed meant "not now": the next stop there asks again rather than telling the cat a quest is open.
    const asked = !step || store.state.ownerSteps.some(s => s.id === rec?.step && s.status === 'open');
    if (rec && rec.status === status && rec.identity === who && asked) return;
    const old = rec?.step ? store.state.ownerSteps.find(s => s.id === rec.step && s.status === 'open') : undefined;
    if (old) store.emit(bad ? 'owner.step.dismissed' : 'owner.step.done', {id: old.id, ...(bad ? {} : {note: status === 'connected' ? `Signed in as ${who}.` : DONE_NOTE[status] ?? ''}), device: 'town'});
    store.emit('account.state', {id: a.id, service: a.service, label: a.label, from: rec?.status ?? null, to: status, identity: who, expected: want, reason, by, since: this.now(), step: bad ? this.fileStep(store, a, status, reason, who, want, step) : null});
  }

  // The quest is an owner step, so it gets Mark done, the phone, and for a directory service the Connect button that signs in again.
  // browser: a cats'-browser site's own title, steps, cat and page, over the defaults.
  private fileStep(store: Store, a: Account, status: AccountStatus, reason: string, who: string | null, want: string | null, browser?: BrowserStep): string {
    const id = randomUUID(), dir = a.connector ? directoryEntry(a.connector) : undefined;
    // A plan's CLI is fixed in a terminal, not in Connectors.
    const cli = PLAN_SIGN_IN[a.service];
    const how = dir ? `Tap Connect ${dir.name} to sign in again.` : cli ? `Run \`${cli}\` in a terminal.` : `In Connectors, open ${a.label} and sign in again or paste a new token.`;
    const title = status === 'wrong-account' ? `${a.label} is signed in as ${who}, not ${want}` : status === 'expiring' ? `${a.label} sign-in ends soon` : status === 'expired' ? `${a.label} sign-in expired` : status === 'error' ? `${a.label} is not answering` : `Sign in to ${a.label}`;
    const steps = status === 'wrong-account' ? `Sign in again as ${want}. Until then, cats using ${a.label} act as ${who}. ${how}` : `${reason} ${how} This one quest covers every cat that uses it.`;
    store.emit('owner.step', {id, goal: null, cat: 'mayor', title, steps, blocking: false, kind: 'account', account: a.id, ...(dir ? {connect: dir.id} : {}), ...(status === 'needs-sign-in' && browser ? {...browser, browser: true} : {})});
    return id;
  }
}

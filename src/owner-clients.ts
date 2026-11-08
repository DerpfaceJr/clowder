// The owner's own OAuth clients (plan D6): one Google Cloud "Desktop app" client and one Microsoft app registration, set up once on a guided page.
// Every Google or Microsoft account the owner connects (Work, Personal) signs in through them; Clowder owns no Google client and needs no CASA.
// oauth-clients.json keeps the client ids; each secret goes to the SecretStore (secret-store.ts SECRET_FIELDS).
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.ts';
import {withSecrets, withoutSecrets} from './secret-store.ts';

export type Provider = 'google' | 'microsoft';
export const PROVIDERS: Provider[] = ['google', 'microsoft'];
// tenant: Microsoft only; 'common' takes work, school and personal accounts.
export type OwnerClient = {clientId: string; clientSecret?: string; tenant?: string; savedAt: number};
type Clients = Partial<Record<Provider, OwnerClient>>;

const FILE = 'oauth-clients.json';
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fileOf = (dataDir: string) => join(dataDir, FILE);

export function readClients(dataDir: string): Clients {
  const file = fileOf(dataDir);
  let raw: unknown = {};
  try { if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8')); } catch { /* damaged: read as none, the next save replaces it */ }
  const all = withSecrets(file, isObj(raw) ? raw : {});
  return Object.fromEntries(PROVIDERS.filter(p => isObj(all[p]) && typeof all[p].clientId === 'string' && all[p].clientId).map(p => [p, {clientId: all[p].clientId, ...(typeof all[p].clientSecret === 'string' && all[p].clientSecret ? {clientSecret: all[p].clientSecret} : {}), ...(typeof all[p].tenant === 'string' && all[p].tenant ? {tenant: all[p].tenant} : {}), savedAt: Number(all[p].savedAt) || 0}]));
}
export const ownerClient = (dataDir: string, p: Provider) => readClients(dataDir)[p];

/** Saves (or, with null, removes) one provider's client. The secret leaves the file for the SecretStore. */
export function saveClient(dataDir: string, p: Provider, c: Omit<OwnerClient, 'savedAt'> | null, now = Date.now()) {
  const all = readClients(dataDir);
  if (c) all[p] = {clientId: c.clientId.trim(), ...(c.clientSecret?.trim() ? {clientSecret: c.clientSecret.trim()} : {}), ...(c.tenant?.trim() ? {tenant: c.tenant.trim()} : {}), savedAt: now}; else delete all[p];
  writeJsonAtomic(fileOf(dataDir), withoutSecrets(fileOf(dataDir), all));
}

/** What the UI shows: never a secret, only whether one is saved. */
export const publicClients = (dataDir: string) => {
  const all = readClients(dataDir);
  return Object.fromEntries(PROVIDERS.map(p => [p, all[p] ? {clientId: all[p]!.clientId, hasSecret: !!all[p]!.clientSecret, ...(all[p]!.tenant ? {tenant: all[p]!.tenant} : {}), savedAt: all[p]!.savedAt} : null]));
};

// Endpoints per provider. Microsoft's carry the tenant. extra: Google gives a refresh token only for access_type=offline, and prompt makes
// it ask which account each time, so a second account through the same client is one more sign-in, not a sign-out.
export function endpoints(p: Provider, c: OwnerClient): {authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string; extra: Record<string, string>} {
  if (p === 'google') return {authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token', userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo', extra: {access_type: 'offline', prompt: 'select_account consent'}};
  const t = encodeURIComponent(c.tenant || 'common');
  return {authorizationEndpoint: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`, tokenEndpoint: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, userinfoEndpoint: 'https://graph.microsoft.com/v1.0/me', extra: {prompt: 'select_account'}};
}

// Where the browser comes back. Google's Desktop app client takes any loopback port without registering one; Microsoft ignores the port of a
// localhost redirect registered under "Mobile and desktop applications", but its path must match.
export const redirectFor = (p: Provider, port: number) => `http://${p === 'google' ? '127.0.0.1' : 'localhost'}:${port}/api/connectors/oauth/callback`;

/** The guided page's data (item 3.3): steps the UI renders in order, with links, the exact redirect and the scopes the directory entries ask for. */
export function setupGuide(dataDir: string, port: number, scopes: Record<Provider, string[]>) {
  const saved = publicClients(dataDir);
  return {
    google: {
      saved: saved.google,
      redirectUri: redirectFor('google', port), registerRedirect: false, scopes: scopes.google,
      steps: [
        {title: 'Create a Google Cloud project', link: 'https://console.cloud.google.com/projectcreate', text: 'Any name works, for example "Clowder". It is yours; Clowder never sees the console.'},
        {title: 'Turn on the APIs', link: 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com', text: 'Enable Gmail, Google Calendar, Google Drive and Google Docs for the project.'},
        {title: 'Set up the consent screen', link: 'https://console.cloud.google.com/auth/branding', text: 'User type External. Fill in the app name and your email. Skip verification: this app is for your own accounts.'},
        {title: 'Publish it: set it to "In production"', link: 'https://console.cloud.google.com/auth/audience', text: 'Under Audience, choose Publish app. In Testing mode Google ends every sign-in after 7 days; in production it lasts. Google will show an "unverified app" warning at sign-in: choose Advanced, then continue.'},
        {title: 'Create a Desktop app client', link: 'https://console.cloud.google.com/auth/clients/create', text: 'Application type: Desktop app. No redirect URI to add: a Desktop client accepts this computer\'s loopback address. Copy the client ID and client secret.'},
        {title: 'Paste the client ID and secret into Clowder', text: 'Then add each Google account (Work, Personal) with one sign-in each.'},
      ],
    },
    microsoft: {
      saved: saved.microsoft,
      redirectUri: redirectFor('microsoft', port), registerRedirect: true, registerAs: 'http://localhost/api/connectors/oauth/callback', scopes: scopes.microsoft,
      steps: [
        {title: 'Register an app', link: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade', text: 'Any name. Supported account types: accounts in any organizational directory and personal Microsoft accounts.'},
        {title: 'Add the redirect URI', text: 'Platform "Mobile and desktop applications", URI http://localhost/api/connectors/oauth/callback (Microsoft ignores the port of a localhost redirect).'},
        {title: 'Paste the Application (client) ID into Clowder', text: 'No client secret is needed for a desktop redirect. Tenant: leave "common" for work and personal accounts, or "consumers" for personal accounts only.'},
      ],
    },
  };
}

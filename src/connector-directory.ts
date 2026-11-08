// The known remote connectors, read once from connector-directory.json. The hub, the quest log and the request_connection tool share it.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {EffectClass} from './connector-types.ts';

// trust 'read-only': public documentation with no account; the tools a connector added from it default to allow.
// A stdio entry (type 'stdio') runs on this computer: command, args and env, pinned to a version. client: it signs in through the owner's own
// OAuth client (owner-clients.ts) with these scopes, never dynamic registration, and gets its token in the reserved OAUTH_* variables.
// effects: the class of tools whose name or hints mislead (a draft is a private write, a send is public). managed: 'cloud' when tokens and tool
// data pass through a third party; such an entry is opt-in and never a starter. trial/version/license/source: what the owner is told before adding it.
export type DirectoryEntry = {id: string; name: string; description: string; type: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; env?: Record<string, string>;
  auth: 'none' | 'oauth' | 'token'; homepage: string; trust?: 'read-only'; headers?: Record<string, string>; tokenUrl?: string; tokenHelp?: string;
  client?: 'google' | 'microsoft'; scopes?: string[]; effects?: Record<string, EffectClass>; managed?: 'cloud'; trial?: boolean; version?: string; license?: string; source?: string; needs?: string};
// The one variable a token connector needs, read from its header placeholder (`${NAME}`), or null.
export const tokenVar = (d: DirectoryEntry) => d.auth === 'token' ? (/\$\{([A-Z0-9_]+)\}/.exec(Object.values(d.headers ?? {}).join(' '))?.[1] ?? null) : null;
export const DIRECTORY: DirectoryEntry[] = JSON.parse(readFileSync(fileURLToPath(new URL('./connector-directory.json', import.meta.url)), 'utf8'));
export const directoryEntry = (id: string) => DIRECTORY.find(d => d.id === id);
// The ids and names request_connection lists for the model. A managed (cloud) entry is the owner's opt-in only, so no cat asks for it.
export const directoryList = () => DIRECTORY.filter(d => !d.managed).map(d => `${d.id} (${d.name})`).join(', ');

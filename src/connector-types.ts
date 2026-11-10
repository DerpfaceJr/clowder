// Shared shapes for connectors (MCP servers) and plugins (Claude Code plugin folders). Rules: docs/connectors-spec.md.
// mcp-client.ts speaks MCP, mcp-oauth.ts signs in, plugins.ts reads plugin folders, connectors.ts owns settings and routes,
// and engine.ts reaches all of it only through ConnectorRuntime, read per call like media and realMoney.

/** How to reach one MCP server. `${VAR}` placeholders are already filled in when a transport reaches connectMcp. */
export type McpTransport =
  | {type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string}
  | {type: 'http'; url: string; headers?: Record<string, string>}
  | {type: 'sse'; url: string; headers?: Record<string, string>};

export type McpToolAnnotations = {title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean};
export type McpTool = {name: string; title?: string; description?: string; inputSchema: any; annotations?: McpToolAnnotations};
export type McpServerInfo = {name?: string; version?: string; instructions?: string; protocolVersion?: string};
/** A tool result as text for the model: text parts kept, other parts described, cut at the cap. */
export type McpCallResult = {text: string; isError: boolean};

export interface McpClient {
  info: McpServerInfo;
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<McpCallResult>;
  /** Set by the caller; fired on notifications/tools/list_changed. */
  onToolsChanged?: () => void;
  /** Ends the session. A stdio server's whole process tree is stopped. Safe to call twice. */
  close(): Promise<void>;
}

/** Saved OAuth progress and tokens for one HTTP connector. Lives only in the secrets file. */
export type OAuthState = {
  resource?: string; authServer?: string; authorizationEndpoint?: string; tokenEndpoint?: string; registrationEndpoint?: string; scope?: string;
  // redirectUri: the current sign-in's. redirectUris: every one the client was registered with (older files: redirectUri alone).
  // deviceGrant: the client was registered for the device code grant too.
  clientId?: string; clientSecret?: string; redirectUri?: string; redirectUris?: string[]; deviceGrant?: boolean;
  // The sign-in server's OpenID userinfo endpoint, when its metadata lists one: whoami for this account (accounts.ts).
  userinfoEndpoint?: string;
  accessToken?: string; refreshToken?: string; expiresAt?: number;
  // step: the connect step that started this sign-in; the callback closes it, and only then. by: the device that started it, journaled then.
  // device: a device code sign-in (RFC 8628), polled by the hub until expiresAt; its state is never sent anywhere, so no callback matches it.
  pending?: {state: string; verifier: string; createdAt: number; step?: string; by?: string; device?: {code: string; interval: number; expiresAt: number}};
};

export type ToolPermission = 'allow' | 'ask' | 'off';
/** What a tool call does outside Clowder. public, money and delete calls go through the publish ledger (engine.ts). */
export type EffectClass = 'read' | 'write' | 'public' | 'money' | 'delete';

// ---- Plugins ----
export type PluginSkill = {name: string; description: string; dir: string};
export type PluginCommand = {name: string; description: string; argumentHint?: string; body: string};
export type PluginAgent = {name: string; description: string; prompt: string};
/** One entry of the plugin's .mcp.json, exactly as written (placeholders kept). */
export type PluginServer = {name: string; config: any};
export type PluginSource = {kind: 'folder' | 'claude-code' | 'marketplace'; ref: string; sha?: string};
export type Plugin = {
  id: string; name: string; version?: string; description?: string; author?: string; dir: string; source: PluginSource;
  skills: PluginSkill[]; commands: PluginCommand[]; agents: PluginAgent[]; servers: PluginServer[];
  /** Parts Clowder reads but never runs, such as hooks and lspServers. Shown to the owner. */
  unsupported: string[];
};

/** What the engine sees. Every method answers for one cat, so an unassigned connector is invisible to it. */
export interface ConnectorRuntime {
  /** OpenAI-style function tools for this cat's connected, assigned, not-off tools. */
  toolsFor(cat: string): any[];
  /** The connector tool behind a function name, if this cat may use it now; null otherwise. permission counts this cat's own Always allow. */
  // identity: who the account was last verified as (@handle or email), or null when no whoami has confirmed it.
  // by: the person whose tree makes the call (plan 10.8); absent or 'owner' is the owner. A member's call to an account not team-scoped is
  // permission 'ask' with ownerOnly: a card only the owner answers. ownerOnly is absent on every other hit.
  resolve(cat: string, name: string, by?: string): {connector: string; label: string; tool: string; permission: 'allow' | 'ask'; effect: EffectClass; identity?: string | null; ownerOnly?: true} | null;
  /** call() throws an error with unknown: true when the request went out and no answer came (timeout, abort, 5xx, a dropped link): it may have run. */
  call(cat: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /** The owner's "Always allow" on an approval: the tool stops asking, as if set to Allow in Connectors. cat: for that cat only (item 1.4).
   *  connector is also BUILTINS for a built-in, or browser:host for browse on that site. */
  allowTool(connector: string, tool: string, cat?: string): void;
  /** The owner's allow/ask/off for a built-in tool that writes (tool-runtimes.ts WRITING_BUILTINS), with cat's own choice when given. Absent: allow, as before the setting. */
  builtinPermission?(tool: string, cat?: string): ToolPermission;
  /** browse on this cats'-browser site, with cat's own choice when given: ask until an Always allow for this site. */
  sitePermission?(host: string, cat?: string): ToolPermission;
  /** One prompt paragraph naming this cat's connected services, or '' when it has none. */
  brief(cat: string): string;
  /** True when this cat is offered at least one tool of the connector now: enabled, connected, assigned and not all off. */
  canUse(cat: string, connector: string): boolean;
  /** True when the connector is connected for another cat but not given to this one: a grant, not a second connect. */
  grantable(connector: string, cat: string): boolean;
  /** Gives the connector to the cat (and the Mayor), as a connect step does. */
  grant(connector: string, cat: string): void;
  /** Skills from enabled plugins, for every cat. everyCat: the owner wants every cat to lead with it. */
  skills(): {name: string; description: string; everyCat?: boolean}[];
  /** A skill's SKILL.md body, or one file inside the skill folder. Throws on unknown skill or a path outside it. */
  readSkill(name: string, file?: string): string;
  /** Agents from enabled plugins, as extra recruitable roles. */
  roles(): {id: string; name: string; role: string}[];
  /** find_skills: plugins and skills that fit the query, from the marketplaces and this computer. */
  findPlugins(query: string): Promise<PluginHit[]>;
  /** One find_skills result by id, or null. */
  findPlugin(id: string): PluginHit | null;
  /** install_skills, run only after the owner's Allow. */
  installPlugin(id: string): Promise<{name: string; skills: {name: string}[]; connectors: string[]}>;
  /** A browse run stopped for the owner on this host: its browser-session Account and one quest (item 1.8). False: no monitor, nothing filed. */
  browserSignIn?(host: string, reason: string, step: {title: string; steps: string; cat: string; mode: string; url?: string}): boolean;
  /** The owner marked that sign-in done (unchecked), or a probe read who it is (handle: connected). */
  browserChecked?(host: string, handle?: string): void;
}

/** A plugin or loose skill a cat may ask the owner to install; `from` is where it comes from, in words. */
export type PluginHit = {id: string; name: string; description: string; from: string; installed: boolean};

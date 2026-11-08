// Roles a town can use. `cats` in town.config.json are the founders of a new world (the Mayor alone); `roleCatalogue`
// holds the rest, which the Mayor recruits with create_cat when a task needs them. One place reads both lists.
export type RoleDef = {id: string; name: string; role: string; color: string; icon: string; style?: string};

export const roleCatalogue = (config: any): RoleDef[] => config.roleCatalogue ?? [];
/** Every role the config defines, founders first, each id once. Tests seed full towns with this. */
export const allRoles = (config: any): RoleDef[] =>
  [...new Map([...(config.cats ?? []), ...roleCatalogue(config)].map((r: RoleDef) => [r.id, r])).values()];
/** The config with the whole roster as its founders: what a world founded with every role would read. */
export const withFullRoster = (config: any) => ({...config, cats: allRoles(config)});
/** The catalogue entry a recruit name refers to ("Builder" or "builder"), or undefined for a role outside the catalogue. */
// Plugin agents join the recruit list with one look, a soft blue star, so they read apart from the catalogue's own hues.
const PLUGIN_ROLE = {color: '#b5c7e0', icon: '✶'};
/** Plugin agents as recruitable roles. Names and role text are cut to what recruit accepts. */
export const pluginRoleDefs = (roles: {id: string; name: string; role: string}[]): RoleDef[] =>
  roles.map(r => ({id: r.id, name: r.name.slice(0, 40), role: r.role.slice(0, 600), ...PLUGIN_ROLE}));
/** The roles a recruit may name: the config catalogue, then plugin agents. A plugin role never shadows a config role with the same id. */
export const recruitableRoles = (config: any, plugin: RoleDef[] = []): RoleDef[] => {
  const taken = new Set(allRoles(config).map(r => r.id));
  return [...roleCatalogue(config), ...plugin.filter(p => !taken.has(p.id))];
};
/** The recruitable role a name refers to: its id or its name, ignoring case ("Builder", "builder", "Code Reviewer"). */
export const catalogueRole = (config: any, name: string, plugin: RoleDef[] = []): RoleDef | undefined => {
  const key = name.trim().toLowerCase();
  return recruitableRoles(config, plugin).find(r => r.id === key || r.name.trim().toLowerCase() === key);
};

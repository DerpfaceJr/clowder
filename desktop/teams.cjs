'use strict';
// Team instances (plan 10.1, D13 b): a team world is its own Clowder server with its own data folder and ports, set through the
// variables the server already reads (CAT_TOWN_DATA, PORT, CAT_REMOTE_PORT). Pure rules only; desktop/main.cjs starts and stops them.
const path = require('node:path');

// Team n's ports sit n steps above the config's ports, so each team keeps the same ports from one start to the next.
const PORT_STEP = 10;
const SLUG = /^team-[1-9]\d{0,3}$/;

// The team's folder: a sibling of the private data folder (data -> data-team-1), never the folder itself or anything inside it.
function teamDataDir(privateDataDir, slug) {
  if (!SLUG.test(String(slug))) throw new Error(`Not a team name: ${slug}`);
  const own = path.resolve(privateDataDir);
  const dir = path.join(path.dirname(own), `${path.basename(own)}-${slug}`);
  const rel = path.relative(own, dir);
  if (!rel || !rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`A team folder must sit beside the data folder, not in it: ${dir}`);
  return dir;
}

// The next team: the lowest free number, with ports derived from the config's (base: {port, remotePort}) that clash with neither
// the private pair nor another team's.
function nextTeam(teams, base) {
  const used = new Set(teams.map(t => t.slug));
  const taken = new Set([base.port, base.remotePort, ...teams.flatMap(t => [t.port, t.remotePort])]);
  for (let n = 1; n < 10000; n++) {
    const slug = `team-${n}`;
    const port = base.port + PORT_STEP * n, remotePort = base.remotePort + PORT_STEP * n;
    if (used.has(slug) || taken.has(port) || taken.has(remotePort) || remotePort > 65535) continue;
    return {slug, name: `Team ${n}`, port, remotePort};
  }
  throw new Error('No team number left.');
}

// teams.json as written by saveTeams; anything unreadable or malformed is dropped (no team is better than a wrong one).
function parseTeams(text) {
  let list;
  try { list = JSON.parse(text).teams; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const port = p => Number.isInteger(p) && p > 0 && p < 65536;
  return list.filter(t => t && SLUG.test(String(t.slug)) && typeof t.name === 'string' && port(t.port) && port(t.remotePort));
}

// The environment a team server starts with: the private one's, with its own folder, ports and owner key. The owner's named tunnel
// (src/tunnel.ts) is the private town's address, so a team never inherits it. CAT_TEAM (plan 10.2) puts the slug in its cookie names and
// moves its Tailscale Serve port off 443, so it shares a host name with the private town without either losing its pairings.
function teamEnv(baseEnv, {slug, dataDir, port, remotePort, ownerKey}) {
  if (!SLUG.test(String(slug))) throw new Error(`Not a team name: ${slug}`);
  const env = {...baseEnv, PORT: String(port), CAT_REMOTE_PORT: String(remotePort), CAT_TOWN_DATA: dataDir, CAT_OWNER_KEY: ownerKey, CAT_TEAM: slug};
  for (const name of ['CAT_TUNNEL_TOKEN', 'CAT_TUNNEL_ORIGIN', 'CAT_TUNNEL_AUTOSTART']) delete env[name];
  return env;
}

module.exports = {PORT_STEP, teamDataDir, nextTeam, parseTeams, teamEnv};

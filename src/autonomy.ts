// Mayor autonomy: how much the Mayor and cats ask the owner before acting. Saved in the data dir as town-settings.json.
// Owner-tier capabilities (economy.ts) always go to the owner; no level changes that.
import {mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';

export const AUTONOMY_LEVELS=['full','balanced','cautious'] as const;
export type AutonomyLevel=typeof AUTONOMY_LEVELS[number];
export const DEFAULT_AUTONOMY:AutonomyLevel='balanced';
export const SETTINGS_FILE='town-settings.json';

export const isAutonomyLevel=(value:unknown):value is AutonomyLevel=>typeof value==='string'&&(AUTONOMY_LEVELS as readonly string[]).includes(value);

const PROMPTS:Record<AutonomyLevel,string>={
  full:'Mayor autonomy is FULL: decide and act on plans, businesses, spends and recruiting yourself, then report what you did in chat. Do not ask the owner before acting; decisions that only the owner can make are routed to the owner by the system.',
  balanced:'Mayor autonomy is BALANCED: ask the owner for meaningful plan decisions and for costly or irreversible-feeling steps; act on routine work and report it.',
  cautious:'Mayor autonomy is CAUTIOUS: ask the owner before starting any new project or business, before any spend above a small threshold, and before recruiting a cat. Do not take those steps until the owner answers.',
};
export const autonomyPrompt=(level:AutonomyLevel):string=>PROMPTS[level];
// Season cats have no way to reach the owner. Balanced keeps today's behaviour: spends above an envelope already wait for the Banker or Mayor.
const SEASON_NOTES:Record<AutonomyLevel,string>={
  full:'',
  balanced:'A season run cannot reach the owner directly. Spends above your envelope already wait for the Banker or Mayor.',
  cautious:'A season run cannot reach the owner directly, so when your level calls for asking, pass and note it instead.',
};
export const seasonAutonomyNote=(level:AutonomyLevel):string=>SEASON_NOTES[level];

// Missing or damaged settings mean balanced, the default that matches the town's behaviour before this setting existed.
export function loadAutonomy(dataDir:string):AutonomyLevel{
  try{
    const raw=JSON.parse(readFileSync(join(dataDir,SETTINGS_FILE),'utf8'));
    return isAutonomyLevel(raw?.level)?raw.level:DEFAULT_AUTONOMY;
  }catch{return DEFAULT_AUTONOMY;}
}

// Write to a temp file, then rename, so a crash never leaves half a settings file.
export function saveAutonomy(dataDir:string,level:unknown):AutonomyLevel{
  if(!isAutonomyLevel(level))throw new Error('Choose full, balanced or cautious.');
  mkdirSync(dataDir,{recursive:true});
  const file=join(dataDir,SETTINGS_FILE);
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{writeFileSync(temp,`${JSON.stringify({level},null,2)}\n`);renameSync(temp,file);}
  catch(err){rmSync(temp,{force:true});throw err;}
  return level;
}

// The per-cat starting envelope is the config default times this. A missing or invalid value means 1, the config default.
export function envelopeMultiplier(config:any,level:AutonomyLevel):number{
  const value=config?.economy?.autonomy?.[level]?.envelopeMultiplier;
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:1;
}

// Full autonomy withdraws the Mayor's approval tools, so routine work cannot pause for the owner or ask about goals.
const OWNER_ASK_TOOLS=new Set(['request_approval']);
export function offeredTools<T extends {function:{name:string}}>(tools:T[],level:AutonomyLevel):T[]{
  return level==='full'?tools.filter(t=>!OWNER_ASK_TOOLS.has(t.function.name)):tools;
}

// Owner-only. The same isOwner rule as every other owner route, so proxied, LAN and paired devices get 403.
export function registerAutonomyRoutes(app:FastifyInstance,opts:{dataDir:string}){
  const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{if(!isOwner(req))return reply.code(403).send({error:'Mayor autonomy is managed on the host computer.'});};
  app.get('/api/autonomy',{onRequest:ownerOnly},async()=>({level:loadAutonomy(opts.dataDir)}));
  app.post('/api/autonomy',{onRequest:ownerOnly,schema:{body:{type:'object',additionalProperties:false,required:['level'],properties:{level:{type:'string',enum:[...AUTONOMY_LEVELS]}}}}},async req=>({level:saveAutonomy(opts.dataDir,(req.body as {level:string}).level)}));
}

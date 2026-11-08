// Owner-only "Start new world": moves the world state into data/backups/world-<time>/ and leaves configuration in place.
// Only the whitelisted world files move. Everything else in the data dir (models.json, devices.json, push keys,
// push-subscriptions.json, town-settings.json, tunnel/, backups/) is configuration and stays.
import {existsSync,mkdirSync,readdirSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';

export const WORLD_FILE=/^(events\.jsonl|workshop\.jsonl|season-[\w-]+\.(jsonl|lock|log))$/;

// busy: the server's busyReason (one rule for reset, restore, backups and updates), null when the town is idle.
export type WorldResetOptions={dataDir:string;busy():string|null;town:{pause(value:boolean):void};now?:()=>Date};
export type WorldResetResult={backup:string;moved:string[];restartRequired:true};

export class WorldResetError extends Error{constructor(message:string,readonly status:number){super(message);}}

export function resetWorld(opts:WorldResetOptions):WorldResetResult{
  const busy=opts.busy();if(busy)throw new WorldResetError(busy,409);
  // Stop the town before any file moves, so no cat writes into the old journal while it is being backed up.
  opts.town.pause(true);
  const stamp=(opts.now?.()??new Date()).toISOString().replace(/[:.]/g,'-');
  const backup=resolve(opts.dataDir,'backups',`world-${stamp}`);
  const moved=existsSync(opts.dataDir)?readdirSync(opts.dataDir).filter(f=>WORLD_FILE.test(f)):[];
  mkdirSync(backup,{recursive:true});
  for(const file of moved)renameSync(join(opts.dataDir,file),join(backup,file));
  // The running Store and Town hold the old layout and their own state; a fresh Town is planned only at startup.
  // So the reset completes on restart, and the UI says so rather than reloading into the old world.
  return {backup,moved,restartRequired:true};
}

const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{
  if(!isOwner(req))return reply.code(403).send({error:'Starting a new world is managed on the host computer.'});
};

// Main app only, like the workshop and season routes. Remote and tunnel apps never get this route.
// After a reset the old world is still in memory, so every write is refused until the server restarts;
// otherwise it would land in a fresh events.jsonl on top of the backed-up world.
export const resetState={done:false};
export const refuseWritesAfterReset=(app:FastifyInstance)=>app.addHook('onRequest',async(req,reply)=>{
  if(resetState.done&&req.method!=='GET')return reply.code(503).send({error:'A new world is ready. Restart Clowder to open it.'});
});
export function registerWorldResetRoute(app:FastifyInstance,opts:WorldResetOptions){
  app.post('/api/world/reset',{onRequest:ownerOnly},async(_req,reply)=>{
    try{const result=resetWorld(opts);resetState.done=true;return result;}
    catch(err){if(err instanceof WorldResetError)return reply.code(err.status).send({error:err.message});throw err;}
  });
}

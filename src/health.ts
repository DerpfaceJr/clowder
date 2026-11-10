// Integration health (11.21): one contract. Telegram, Discord, mail watch, backup and ntfy each expose health(): {state, error, since}.
// quests.ts turns an error that has lasted HEALTH_MINUTES into one owner-only Needs-you item per integration. The item closes itself
// when health is ok again, because quests() is derived from health on every read.

export type HealthState='ok'|'error'|'off';
// since: when the current error began (epoch ms), null when there is no error or the start is unknown.
export type Health={state:HealthState;error:string|null;since:number|null};
export type IntegrationId='telegram'|'discord'|'mail'|'backup'|'ntfy';
export type Integration={id:IntegrationId;name:string;health:Health};
// ASSUMED: how long an error may last before the owner hears of it.
export const HEALTH_MINUTES=15;
export const OFF:Health={state:'off',error:null,since:null};

/** Off when not configured; error while an error is set; ok otherwise. */
export const healthOf=(configured:boolean,error:string|null,since:number|null):Health=>
  !configured?OFF:error?{state:'error',error,since}:{state:'ok',error:null,since:null};

/** Remembers when the current stretch of errors began. A new error keeps the first time; clearing it (null) ends the stretch. */
export class ErrorClock{
  error:string|null=null;
  since:number|null=null;
  constructor(private now:()=>number){}
  set(error:string|null){
    if(error===null){this.error=null;this.since=null;return;}
    if(this.error===null)this.since=this.now();
    this.error=error;
  }
}

/** Integrations whose error has lasted HEALTH_MINUTES, or whose start is unknown: one entry each. */
export function stoppedIntegrations(list:Integration[],now:number){
  return list.filter(x=>x.health.state==='error'&&x.health.error!==null&&(x.health.since===null||now-x.health.since>=HEALTH_MINUTES*60_000))
    .map(x=>({id:x.id,name:x.name,error:x.health.error!,since:x.health.since}));
}

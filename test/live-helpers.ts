// Shared by live-frames.test.ts and live-text.test.ts: a town on a temp journal, its feed, and one owner and one viewer page.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {DeltaFeed} from '../src/state-delta.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

const base=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const slow={...base,goals:{roundPauseSeconds:60,maxRoundsPerDay:24,tokenBudget:null}};
export function fixture(providers:Record<string,Provider>={}){
  const file=join(mkdtempSync(join(tmpdir(),'live-')),'events.jsonl');
  const store=new Store(file,allRoles(slow));
  const town=new Town(store,slow,providers);town.autonomy=()=>'balanced';
  const feed=new DeltaFeed({store,activeWorld:()=>({id:'home'})});
  store.listeners.add(e=>feed.publish(e));
  const owner:any[]=[],viewer:any[]=[];
  const ownerSend=(d:string)=>owner.push(JSON.parse(d)),viewerSend=(d:string)=>viewer.push(JSON.parse(d));
  feed.clients.add(ownerSend);feed.owners.add(ownerSend);feed.clients.add(viewerSend);
  const lines=()=>readFileSync(file,'utf8').split('\n').filter(Boolean).length;
  return {store,town,feed,owner,viewer,lines,file};
}
export const until = untilEvery(10);

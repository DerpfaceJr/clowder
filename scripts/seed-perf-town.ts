// Seeds a throwaway town with the full 64 cats (main plus task hamlets) for render measurements.
// Usage: CAT_TOWN_DATA=<empty temp dir> [HAMLETS=4 PER_HAMLET=6] npx tsx scripts/seed-perf-town.ts   (refuses to touch an existing journal)
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
const dir=process.env.CAT_TOWN_DATA;if(!dir)throw new Error('Set CAT_TOWN_DATA to an empty temp directory.');
const file=resolve(dir,'events.jsonl');if(existsSync(file))throw new Error('Journal exists; use an empty directory.');
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const store=new Store(file,allRoles(config)),town=new Town(store,config);
const hamlets=Number(process.env.HAMLETS||4),per=Number(process.env.PER_HAMLET||6);
for(let g=0;g<hamlets;g++){const root=town.createTask('scholar','owner',`Hamlet request ${g}. Staff it.`,'test');for(let i=0;i<per;i++)town.recruit('mayor',`Task ${g} cat ${i}`,'Build things',undefined,root);}
for(let i=0;store.state.cats.length<config.maxCats;i++)town.recruit('mayor','Resident '+i,'Research opportunities');
console.log(store.state.cats.length,'cats',store.state.groups.length,'groups');

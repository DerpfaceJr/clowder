// Usage page (plan 3.10): the journal's usage rows by day, cat, model mode, goal and routine for this month and last, and the town-wide
// monthly token cap. Months and days are the computer's local calendar, as goals' dayKey is: the owner's timezone is the host's.
// Every count adds rows through goals.ts rowTokens, so a row with no number adds nothing and each total is a floor.
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {isOwner} from './access.ts';
import {budgetSpent,dayKey,finite,goalOfTasks,rowTokens} from './goals.ts';
import {hostZone} from './routines.ts';
import type {State} from './store.ts';
import type {Town} from './engine.ts';

export const CAP_NOTE='Monthly token cap reached. Raise the cap, allow this once, or wait for next month.';
export const monthKey=(now=new Date())=>dayKey(now).slice(0,7);
// unreported: calls whose provider sent no token count; tokens leave them out.
export type Tally={tokens:number;input:number;output:number;calls:number;unreported:number};
const tally=():Tally=>({tokens:0,input:0,output:0,calls:0,unreported:0});
const add=(t:Tally,u:any)=>{const n=rowTokens(u);t.calls++;if(n===null){t.unreported++;return;}t.tokens+=n;if(finite(u.input))t.input+=u.input;if(finite(u.output))t.output+=u.output;};
// cost: a sum only when every row carries one. Plan and API rows are journaled with cost null, so it stays unknown, never 0.
export type MonthUsage={month:string;total:Tally;cost:number|null;days:Record<string,Tally>;cats:Record<string,Tally>;modes:Record<string,Tally>;goals:Record<string,Tally>;routines:Record<string,Tally>};

/** This month and last, in one pass over the usage rows. Goals and routines include their delegated children, as their budgets do. */
export function usageReport(state:State,now=new Date()):{current:MonthUsage;previous:MonthUsage}{
  const keys=[monthKey(now),monthKey(new Date(now.getFullYear(),now.getMonth()-1,1))];
  const months:MonthUsage[]=keys.map(month=>({month,total:tally(),cost:0,days:{},cats:{},modes:{},goals:{},routines:{}}));
  const goalOf=goalOfTasks(state),routineOf=goalOfTasks(state,'routine');
  const bump=(rec:Record<string,Tally>,k:string|undefined,u:any)=>{if(k)add(rec[k]??=tally(),u);};
  for(const u of state.usage){
    const day=dayKey(new Date(u.at)),m=months[keys.indexOf(day.slice(0,7))];if(!m)continue;
    add(m.total,u);m.cost=m.cost!==null&&finite(u.cost)?m.cost+u.cost:null;
    bump(m.days,day,u);bump(m.cats,u.cat,u);bump(m.modes,u.mode,u);bump(m.goals,goalOf(u.task),u);bump(m.routines,routineOf(u.task),u);
  }
  return {current:months[0],previous:months[1]};
}

/** This month's tokens, a floor. Rows are in journal order, so the walk from the end stops at the first older month: it runs before every model step. */
export function monthTokens(state:State,now=new Date()){
  const key=monthKey(now);let total=0;
  for(let i=state.usage.length-1;i>=0;i--){const k=monthKey(new Date(state.usage[i].at));if(k<key)break;if(k===key)total+=rowTokens(state.usage[i])??0;}
  return total;
}
/** The one cap rule: a cap is set, this month has reached it, and the owner has not let this month run past it. */
export const capReached=(state:State,now=new Date())=>state.capOverride!==monthKey(now)&&budgetSpent(monthTokens(state,now),state.usageCap??null);
/** The cap and the month's progress. card: the month's pending cap decision, or null. */
export function capStatus(state:State,now=new Date()){
  const month=monthKey(now);
  return {month,cap:state.usageCap??null,used:monthTokens(state,now),override:state.capOverride===month,reached:capReached(state,now),card:state.approvals.find(a=>a.gate==='cap'&&a.month===month&&a.status==='pending')?.id??null};
}

// The read is open like /api/goals (the state already carries a usage summary); setting the cap is owner-only, like a goal's token budget.
export function registerUsageRoutes(app:FastifyInstance,opts:{town:()=>Town;device?:(req:FastifyRequest)=>string}){
  const ownerOnly=async(req:FastifyRequest,reply:FastifyReply)=>{if(!isOwner(req))return reply.code(403).send({error:'The token cap is set on the host computer or an owner device.'});};
  app.get('/api/usage',async()=>{const s=opts.town().store.state,now=new Date();return {timezone:hostZone(),...usageReport(s,now),cap:capStatus(s,now)};});
  app.post('/api/usage/cap',{onRequest:ownerOnly,schema:{body:{type:'object',required:['tokens'],additionalProperties:false,properties:{tokens:{type:['integer','null'],minimum:1}}}}},async req=>{
    const town=opts.town();town.setUsageCap('owner',(req.body as {tokens:number|null}).tokens,opts.device?.(req)??'host');
    return {ok:true,cap:capStatus(town.store.state)};
  });
}

export function formatFunds(funds){return funds?new Intl.NumberFormat(undefined,{style:'currency',currency:funds.currency,currencyDisplay:'code'}).format(funds.amountMinor/100):'Not set';}

// Provider-reported tokens from the town's usage rows (chat, tasks and goal rounds), grouped by provider. Demo calls make
// no model calls and are left out. A call whose provider did not report counts as unknown, never as zero tokens.
const PROVIDER_NAMES={claude:'Claude plan',plan:'Claude plan',chatgpt:'ChatGPT plan',local:'Local AI',hosted:'API key'};
// Per-mode totals. The server sends these in /api/state instead of thousands of rows (src/store.ts small()); a row that
// already has `calls` is such a total and is added as it is, so summing summaries gives the same answer as summing rows.
export function usageSummary(usage){
  const modes=new Map();
  for(const u of usage||[]){
    if(!u||u.mode==='demo')continue;
    const m=modes.get(u.mode)??{mode:u.mode,calls:0,input:0,output:0,unknown:0};
    if(Number.isFinite(u.calls)){m.calls+=u.calls;m.input+=u.input;m.output+=u.output;m.unknown+=u.unknown;}
    else{m.calls++;if(Number.isFinite(u.input)&&Number.isFinite(u.output)){m.input+=u.input;m.output+=u.output;}else m.unknown++;}
    modes.set(u.mode,m);
  }
  return [...modes.values()];
}
export function chatTokens(usage){
  const groups=new Map();
  for(const u of usageSummary(usage)){
    const key=u.mode==='plan'?'claude':u.mode,g=groups.get(key)??{provider:PROVIDER_NAMES[key]??key,calls:0,input:0,output:0,unknown:0};
    for(const k of ['calls','input','output','unknown'])g[k]+=u[k];
    groups.set(key,g);
  }
  const rows=[...groups.values()].sort((a,b)=>(b.input+b.output)-(a.input+a.output));
  const sum=k=>rows.reduce((a,r)=>a+r[k],0);
  return {rows,calls:sum('calls'),input:sum('input'),output:sum('output'),unknown:sum('unknown')};
}
export const formatTokens=n=>n>=1e6?`${(n/1e6).toFixed(n>=1e7?0:1)}M`:n>=1e4?`${Math.round(n/1e3)}k`:n.toLocaleString();

// Chat ledger plus economy seasons, the same total the Moonvault's token ledger shows.
export function usedTokens(usage,seasons=[]){
  const all=[chatTokens(usage),...seasons.map(s=>s.tokens)];
  return all.reduce((a,t)=>({total:a.total+t.input+t.output,calls:a.calls+t.calls,unknown:a.unknown+(t.unknown||0)}),{total:0,calls:0,unknown:0});
}
// Unreported calls are never counted as zero: all unreported reads "unreported", some unreported marks the total a floor (+).
export function tokensText(t){
  if(t.calls&&t.unknown===t.calls)return 'tokens unreported';
  return `${formatTokens(t.total)}${t.unknown?'+':''} tokens`;
}
// The phone pill's short label (the full line stays in title and aria-label). Money compacts; tokens show as a bare number.
export function treasuryShort(mode,funds,tokens){
  if(mode==='money')return funds?new Intl.NumberFormat(undefined,{notation:'compact',style:'currency',currency:funds.currency,currencyDisplay:'code'}).format(funds.amountMinor/100):'Not set';
  if(tokens.calls&&tokens.unknown===tokens.calls)return '—';
  return `${formatTokens(tokens.total)}${tokens.unknown?'+':''}`;
}
// What the vault label and the Town funds chip show: money left, tokens used, or both, on one line.
export const TREASURY_MODES=['money','tokens','both'];
const MODE_KEY='clowder.treasuryShow';
export function treasuryMode(funds,storage=globalThis.localStorage){
  let mode=null;try{mode=storage?.getItem(MODE_KEY);}catch{/* private mode: fall back to the default */}
  return TREASURY_MODES.includes(mode)?mode:funds?'money':'tokens';
}
export function saveTreasuryMode(mode,storage=globalThis.localStorage){try{storage?.setItem(MODE_KEY,mode);}catch{/* not saved; the default returns next load */}}
export function treasuryText(mode,funds,tokens){
  const money=formatFunds(funds),used=tokensText(tokens);
  return mode==='tokens'?used:mode==='both'?`${money} · ${used}`:money;
}
// app.js sets the line on each render; town.js reads it, so both show the same text without the scene knowing about seasons.
let vaultLine='';
export const setVaultLine=text=>{vaultLine=text;},vaultText=()=>vaultLine;

// The Money dialog's "Tokens used" section: provider rows from the chat ledger and each season, the total on top. esc escapes the labels.
const tokenRow=(label,t,esc)=>`<li><span>${esc(label)}</span><strong>${formatTokens(t.input+t.output)}</strong><small>${formatTokens(t.input)} in · ${formatTokens(t.output)} out · ${t.calls} call${t.calls===1?'':'s'}${t.unknown?` · ${t.unknown} unreported`:''}</small></li>`;
export function tokensUsedHtml(usage,seasons,esc){
  const chat=chatTokens(usage),rows=[...chat.rows.map(r=>tokenRow(r.provider,r,esc)),...seasons.map(s=>tokenRow(`Season ${s.name}`,s.tokens,esc))];
  const total=usedTokens(usage,seasons).total;
  return `<h3>Tokens used</h3>${rows.length?`<p class="treasury-tokens-total">${formatTokens(total)} <span>tokens so far in this world</span></p><ul>${rows.join('')}</ul>`:'<p class="muted">No model tokens yet. The scripted demo uses none.</p>'}<p class="muted">As reported by each provider. Plans count against your plan's limits; local models cost nothing.</p>`;
}

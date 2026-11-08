// Coins panel: the coin economy season. Everyone sees the season; the owner can start, resume and stop runs from here.
// Fetches /api/season only while the panel is open and the document is visible.
// All cat-generated text (names, args, results) is untrusted: it is written with textContent only.
import {emptyState} from './empty-state.js';
const POLL_MS=5000;
const panel=document.getElementById('season-panel');
const body=document.getElementById('season-body');
const status=document.getElementById('season-status');
let timer=0,busy=false,lastJson='';

const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
const number=n=>Number(n??0).toLocaleString();
const signed=n=>`${n>=0?'+':''}${number(n)}`;
const clip=(value,max)=>{const text=typeof value==='string'?value:(JSON.stringify(value)??'');return text.length>max?`${text.slice(0,max-1)}…`:text;};
const argsText=args=>args&&typeof args==='object'?Object.entries(args).map(([key,value])=>`${key} ${clip(value,40)}`).join(', '):clip(args??'',80);
const section=title=>{const element=node('section','season-section');element.append(node('h3','season-heading',title));return element;};
const empty=text=>node('p','muted',text);

// The empty state's one button. It is shown only to the owner and only when the run card could start a season.
let emptyStart=null;
function renderNoSeason(){
  emptyStart=node('button','primary','Start a season');emptyStart.type='button';emptyStart.hidden=true;emptyStart.onclick=()=>startSeason();
  return emptyState(document,{icon:'coins',text:'Cats earn coins for finished work during a season.',action:emptyStart});
}

function renderSeason(data){
  const frag=document.createDocumentFragment(),p=data.progress;
  const head=node('div','season-head');
  head.append(node('span','season-title',`Season ${data.name} · ${p.finished?'Finished':`Day ${p.day+1}, tick ${p.tick+1}`}`),node('span',`season-check ${data.invariantsOk?'ok':'bad'}`,data.invariantsOk?'invariants OK':'ledger check failed'));
  const bar=node('div','season-bar'),fill=node('i');fill.style.width=`${p.total?Math.min(100,p.closed/p.total*100):0}%`;bar.append(fill);
  const delta=data.balance-data.startingCoins;
  const balance=node('div','season-balance');
  balance.append(node('strong',null,number(data.balance)),node('small',null,'coins'),node('span',`season-delta ${delta>=0?'up':'down'}`,`${signed(delta)} vs start ${number(data.startingCoins)}`));
  // Balance = startingCoins + earned - settled, so "spent" is the settled total.
  frag.append(head,bar,empty(`${p.closed} of ${p.total} ticks closed`),balance,node('p','season-flow',`Earned ${number(data.earned)} · Spent ${number(data.settled)} · Available ${number(data.available)}`));

  const capabilities=data.capabilities??[];
  const owed=capabilities.filter(c=>c.status==='needs_owner');
  const needs=section('Needs you');
  if(!owed.length)needs.append(empty('Nothing needs you right now.'));
  const owedList=node('ul','season-list');
  for(const c of owed){
    const item=node('li','season-item');
    item.append(node('strong',null,`${c.cat} · ${c.kind}`),node('small',null,c.need),node('small',null,c.purpose));
    owedList.append(item);
  }
  needs.append(owedList);
  if(owed.length)needs.append(node('p','muted','Tell the Mayor in Chat if you want to provide this.'));

  const businesses=section(`Businesses · ${data.businesses.length}`);
  if(!data.businesses.length)businesses.append(empty('No businesses yet.'));
  const bizList=node('ul','season-list');
  for(const b of data.businesses){
    const item=node('li','season-item'),top=node('div','season-item-top');
    top.append(node('strong',null,b.name),node('span',`season-state ${b.open?'open':'closed'}`,b.open?'open':'closed'));
    item.append(top,node('small',null,`${b.owner} · ${b.category} · price ${number(b.price)} · stock ${number(b.stock)} · sold ${number(b.sold)}`));
    bizList.append(item);
  }
  businesses.append(bizList);

  const pending=section(`Spend requests · ${data.pending.length}`);
  if(!data.pending.length)pending.append(empty('Nothing waiting for approval.'));
  const pendingList=node('ul','season-list');
  for(const r of data.pending){const item=node('li','season-item');item.append(node('strong',null,`${r.cat} · ${number(r.amount)} coins`),node('small',null,r.purpose));pendingList.append(item);}
  pending.append(pendingList);

  const recent=section('Recent actions');
  if(!data.recent.length)recent.append(empty('No actions yet.'));
  const feed=node('ol','season-list');
  for(const a of data.recent.slice().reverse()){
    const item=node('li',`season-action ${a.ok?'ok':'bad'}`),args=argsText(a.args);
    item.append(node('div','season-action-line',`${a.ok?'✓':'✗'} ${a.cat} ${String(a.name).replaceAll('_',' ')}${args?` ${args}`:''}`),node('small',null,a.result||''));
    feed.append(item);
  }
  recent.append(feed);

  const tools=section('Tools');
  const others=capabilities.filter(c=>c.status!=='needs_owner');
  if(!others.length)tools.append(empty('No tools requested yet.'));
  const toolList=node('ul','season-list');
  for(const c of others){
    const item=node('li','season-item'),top=node('div','season-item-top');
    top.append(node('strong',null,`${c.cat} · ${c.kind}`),node('span','season-state',c.status));
    item.append(top,node('small',null,`${c.need}${c.source?` · ${c.source}`:''}`));
    toolList.append(item);
  }
  tools.append(toolList);

  frag.append(needs,businesses,pending,tools,recent);
  return frag;
}

function render(data){
  const json=JSON.stringify(data);
  if(json===lastJson)return;
  lastJson=json;
  body.replaceChildren(data.season===null||!data.progress?renderNoSeason():renderSeason(data));
}

async function load(){
  if(busy)return;
  busy=true;
  try{
    const r=await fetch('/api/season');
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||`Season unavailable (${r.status})`);
    status.hidden=true;
    render(data);
  }catch(error){
    status.textContent=`Cannot read the season: ${error.message}`;
    status.hidden=false;
  }finally{busy=false;}
  await loadRuns();
}

function sync(){
  const open=!panel.hidden&&!document.hidden;
  if(open&&!timer){void load();timer=setInterval(load,POLL_MS);}
  else if(!open&&timer){clearInterval(timer);timer=0;}
}

// Run the economy: owner only. The host computer starts, resumes and stops season child processes; everyone else sees a note.
const runBox=document.getElementById('season-run');
const NAME=/^[\w-]{1,40}$/;
let host={models:[],readOnly:true,townDefault:null},modelsKey='',runs=null,card=null,busyRun=false;

const ownerPost=async(path,body)=>{
  const r=await fetch(`/api/seasons/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.error||`Request failed (${r.status})`);
  return data;
};

// The run card: a status line, the buttons that apply, and the name, model and days under Options. Start uses those fields,
// which default to the next free name, the town's model and the configured days.
function buildCard(){
  const section=node('section','season-run-card');
  const field=(text,control)=>{const label=node('label','season-field');label.append(node('span',null,text),control);return label;};
  const name=node('input');name.type='text';name.maxLength=40;name.autocomplete='off';name.spellcheck=false;name.setAttribute('aria-label','Season name');
  name.addEventListener('input',()=>{name.dataset.touched='1';renderRuns();});
  const model=node('select');model.setAttribute('aria-label','Model');model.style.setProperty('width','100%');
  const days=node('input');days.type='number';days.min='1';days.max='365';days.step='1';days.inputMode='numeric';days.setAttribute('aria-label','Days');
  const start=node('button','primary','Start a season');start.type='button';start.hidden=true;
  const resume=node('button','primary','Resume');resume.type='button';resume.hidden=true;
  const stop=node('button','danger','Stop');stop.type='button';stop.hidden=true;
  const buttons=node('div','season-run-buttons');buttons.append(start,resume,stop);
  const note=node('p','season-run-note'),last=node('p','season-run-note'),message=node('p','season-run-message');
  message.setAttribute('role','status');
  // One column, so the model name is never squeezed into a half-width cell.
  const form=node('div','season-run-form');form.style.setProperty('display','grid');form.style.setProperty('grid-template-columns','minmax(0,1fr)');form.style.setProperty('gap','8px');
  form.append(field('Season name',name),field('Model',model),field('Days',days));
  const options=node('details','season-options');options.append(node('summary',null,'Options'),form);
  section.append(note,last,buttons,options,message);
  start.onclick=()=>startSeason();
  resume.onclick=()=>act(()=>ownerPost('start',{name:name.value.trim(),mode:model.value}),'Season resumed.');
  stop.onclick=()=>act(()=>ownerPost('stop',{name:runs.running.name}),'Stopping. The journal keeps every finished step.');
  card={section,name,model,days,start,resume,stop,note,last,message};
  return section;
}

// Start with the run card's fields. Used by the empty state's button and the run card's Start.
const startSeason=()=>act(()=>ownerPost('start',{name:card.name.value.trim(),mode:card.model.value,...(card.days.value?{days:Number(card.days.value)}:{})}),'Season started.');

async function act(task,done){
  if(busyRun)return;
  busyRun=true;card.message.textContent='';renderRuns();
  try{await task();card.message.textContent=done;}
  catch(error){card.message.textContent=error.message;}
  finally{busyRun=false;}
  await loadRuns();
}

// The model list comes from the app. A new run starts on the town's own model when it is usable, else the demonstration.
function syncModels(){
  const key=JSON.stringify([host.models,host.townDefault?.provider]);
  if(!card||key===modelsKey)return;
  modelsKey=key;
  const previous=card.model.value,preferred=host.townDefault?.usable?host.townDefault.provider:null,ids=host.models.map(m=>m.id);
  card.model.replaceChildren(...host.models.map(m=>new Option(m.name,m.id)));
  const chosen=ids.includes(previous)?previous:preferred;
  card.model.value=ids.includes(chosen)?chosen:(ids[0]??'demo');
}

function renderRuns(){
  if(!card||!runs)return;
  const {running,seasons,nextName,defaultDays}=runs;
  if(running){
    card.name.value=running.name;
    if(running.mode&&host.models.some(m=>m.id===running.mode))card.model.value=running.mode;
  }
  else if(card.name.dataset.touched!=='1')card.name.value=nextName;
  if(!card.days.value&&defaultDays)card.days.value=String(defaultDays);
  const typed=card.name.value.trim(),valid=NAME.test(typed);
  const entry=seasons.find(s=>s.name===(running?running.name:typed));
  let text;
  if(running){
    const p=entry?.progress;
    text=`Running ${running.name}${running.mode?` · ${running.mode}`:''}${p?` · ${p.closed} of ${p.total} ticks`:''}${entry?` · balance ${number(entry.balance)}`:''}`;
  }
  else if(!valid)text='Use letters, digits, - or _ (up to 40 characters).';
  else if(!entry)text=`New season. Next free name: ${nextName}.`;
  else if(entry.status==='paused')text=`Paused${entry.reason?`: ${entry.reason}`:''}. Resume to continue.`;
  else if(entry.status==='finished')text='Finished.';
  else if(entry.status==='damaged')text=`Journal cannot be read: ${entry.reason}`;
  else text='Journal is empty.';
  card.note.textContent=text;
  // The empty state's sentence says what this is; the note only speaks up when there is something to fix or report.
  card.note.hidden=!running&&!seasons.length&&valid;
  card.last.textContent=running&&entry?.last?`Last action: ${entry.last}`:'';
  const locked=!!running||busyRun,canStart=!locked&&valid&&!entry;
  for(const control of [card.name,card.model,card.days])control.disabled=locked;
  // Each button shows only when it applies. Start sits here once a season exists; the empty state has its own.
  card.start.hidden=!canStart||!seasons.length;
  if(emptyStart)emptyStart.hidden=!canStart;
  card.resume.hidden=locked||!valid||!entry||entry.status!=='paused';
  card.stop.hidden=!running;
  card.stop.disabled=busyRun;
}

async function loadRuns(){
  if(!runBox)return;
  if(host.readOnly){
    if(!runBox.firstChild){
      const section=node('section','season-run-card');
      section.append(node('p','muted','Seasons are started on the host computer.'));
      runBox.replaceChildren(section);
    }
    runBox.hidden=false;return;
  }
  try{
    const r=await fetch('/api/seasons');
    if(!r.ok)throw new Error(String(r.status));
    runs=await r.json();
  }catch{
    // Remote devices and refused requests do not get the run card.
    runBox.hidden=true;runBox.replaceChildren();card=null;runs=null;return;
  }
  if(!card){runBox.replaceChildren(buildCard());modelsKey='';}
  runBox.hidden=false;
  syncModels();
  renderRuns();
}

// app.js passes the model list, the town's default model and viewer state from each state refresh.
export function setSeasonHost(next){
  host={models:next.models??[],readOnly:!!next.readOnly,townDefault:next.townDefault??null};
  if(host.readOnly&&card){runBox.replaceChildren();card=null;}
  syncModels();
}

export function initSeasonPanel(){
  new MutationObserver(sync).observe(panel,{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',sync);
  sync();
}

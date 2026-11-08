// Needs you (the dock's old Quests): what needs the owner, most urgent first, read from GET /api/quests (read-only, so paired viewers
// see it too). The server ranks items S to F; the panel shows plain words instead (plain-words.js, D12): each card says whether it is
// a Decision, a To-do, a Goal or a Request, and a finished one wears ✓, never a grade.
// Two tabs: Active (what needs attention now) and Done (finished items, from GET /api/quests/done, newest first).
// Items with needsYou false sit in one collapsed section under the list; the rest are the one "needs you" count (needsYouCount)
// that the dock badge, the Mayor's notice and the Projects summary all show. A card is short: title, one summary line,
// the step tally for to-dos and one button row. Details opens a sheet (a native dialog) with the intro and the steps
// as a stepper; ticks are kept in this browser only. The server refuses marks, removals and hides for anyone but the owner.
// The pure helpers are exported for Node tests; the DOM is built with createElement and textContent only.
import {el,clip} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';
import {webLink} from './connectors-panel.js';
import {signInPlan,signInBox,tokenLine} from './connect-flow.js';
import {humanizeText} from './humanize-ids.js';
import {glyphOf,needsYouLabel,nounOf,plainWords} from './plain-words.js';
import {emptyState} from './empty-state.js';

export const RANK_ORDER=['S','A','B','C','D','E','F'];
// An artifact chip's tap area is the 44px button; the visible pill inside stays about 22px tall.
const CHIP={'min-height':'44px',padding:'0 2px',border:'0',background:'none',display:'inline-flex','align-items':'center','vertical-align':'middle','max-width':'100%'};
const PILL={display:'inline-block',maxWidth:'100%',padding:'0 8px',border:'1px solid #c9d7bb','border-radius':'999px',background:'#e3efd9',color:'#2f4a2c',font:'600 12px/22px var(--font-ui,Inter,"Segoe UI",sans-serif)','overflow-wrap':'anywhere'};
// One plain heading per server rank, most urgent first. No letter grades: only the order is kept.
const HEADINGS={S:'Decisions',A:'Needs you to act',B:'Trouble and to-dos',C:'AI models offline',D:'Gone quiet',E:'Waiting on the town',F:'Done'};
const KINDS=new Map([['account','Account'],['payment','Payment'],['legal','Legal'],['identity','Identity'],['physical','In person'],['design','Design']]);
const HANDLED_KEY='clowder.questsHandledOpen';

// Groups the server's list by rank, S first. Ranks with no quests are left out.
export function groupQuests(list){
  return RANK_ORDER.map(rank=>[rank,(list??[]).filter(q=>q.rank===rank)]).filter(([,items])=>items.length);
}

// A quest needs the owner unless the server says needsYou is false. A quest without the field (older servers) needs them.
export const needsOwner=q=>q.needsYou!==false;
export function splitNeeds(list){const all=list??[];return {needs:all.filter(needsOwner),handled:all.filter(q=>!needsOwner(q))};}

// The one "needs you" count: every item only the owner can act on, whatever its rank, so a to-do that blocks nothing counts too.
// It is the number of cards above the fold in this panel, and the dock badge, the Mayor's notice and the Projects summary show it.
export function needsYouCount(list){return splitNeeds(list).needs.length;}

// The small label on an owner step's card. Unknown kinds show no label.
export function kindLabel(kind){return KINDS.get(kind)??'';}

// Relative time for a quest. Unknown or unreadable times say so instead of inventing a value.
export function ago(iso,now=Date.now()){
  const t=iso?Date.parse(iso):NaN;
  if(!Number.isFinite(t))return 'time unknown';
  const minutes=Math.max(0,Math.round((now-t)/60000));
  if(minutes<1)return 'just now';
  if(minutes<60)return `${minutes} min ago`;
  const hours=Math.round(minutes/60);
  if(hours<48)return `${hours} h ago`;
  return `${Math.round(hours/24)} d ago`;
}

export const badgeLabel=needsYouLabel;

// Splits quest text into an intro and steps. Numbers count up from 0 or 1 ("v2.1" and "15/17" stay in the text), "1)" works too,
// and with no numbers, lines starting with - or • are steps.
export function splitSteps(text){
  const s=String(text??'');
  const marks=[];let want=null;
  for(const m of s.matchAll(/(?<=^|\s)(\d{1,2})[.)]\s+/g)){
    const n=Number(m[1]);
    if(want===null?n>1:n!==want)continue;
    marks.push({at:m.index,start:m.index+m[0].length});want=n+1;
  }
  if(marks.length)return {intro:s.slice(0,marks[0].at).trim(),steps:marks.map((mark,i)=>s.slice(mark.start,marks[i+1]?.at??s.length).trim())};
  const lines=s.split('\n');
  if(!lines.some(line=>/^\s*[-•]\s/.test(line)))return {intro:s.trim(),steps:[]};
  const intro=[],steps=[];
  for(const line of lines){
    const bullet=line.match(/^\s*[-•]\s+(.*)$/);
    if(bullet)steps.push(bullet[1].trim());
    else if(!line.trim())continue;
    else if(steps.length)steps[steps.length-1]+=` ${line.trim()}`;
    else intro.push(line.trim());
  }
  return {intro:intro.join(' '),steps:steps.filter(Boolean)};
}

// A step's bold title (its first sentence or the text before the first colon, at most max characters) and the rest as body.
export function stepParts(text,max=80){
  const s=String(text??'').replace(/\s+/g,' ').trim();
  const hits=[s.search(/(?<=[.!?])\s/),s.search(/:\s/)].filter(i=>i>0&&i<=max);
  if(hits.length){const at=Math.min(...hits);return {title:s.slice(0,at).replace(/[.!?]$/,''),body:s.slice(at+1).trim()};}
  if(s.length<=max)return {title:s,body:''};
  const space=s.lastIndexOf(' ',max);
  const at=space>max*.5?space:max;
  return {title:s.slice(0,at).trim(),body:s.slice(at).trim()};
}

// The card's one line: the first sentence of the intro, cut to max characters.
export function summaryOf(text,max=110){
  const first=splitSteps(text).intro.split(/(?<=[.!?])\s/)[0]??'';
  return clip(first,max);
}

// Steps ticked off out of the steps there are. Ticks past the last step do not count.
export function progressOf(text,ticks=[]){
  const total=splitSteps(text).steps.length;
  const done=[...new Set(ticks)].filter(i=>Number.isInteger(i)&&i>=0&&i<total).length;
  return {done,total};
}

// Artifact ids (8 hex with a digit and a letter, or a full id), and money or durations, inside step text.
const TOKEN=/(?<![0-9a-zA-Z-])(?<id>(?=[0-9a-f]{0,7}\d)(?=[0-9a-f]{0,7}[a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)(?![0-9a-zA-Z-])|(?<hl>\$\d+(?:[.,]\d+)*(?:\/h)?|\b\d+-(?:day|week|hour|min)s?\b|\bWeeks? \d+(?:\s?[-–]\s?\d+)?\b|\b\d+(?:\.\d+)? ?h\/(?:week|day)\b)/gi;

// Text split into {text}, {id} (lowercase) and {hl} parts, in order.
export function textParts(text){
  const s=String(text??'');const out=[];let at=0;
  for(const m of s.matchAll(TOKEN)){
    if(m.index>at)out.push({text:s.slice(at,m.index)});
    out.push(m.groups.id?{id:m.groups.id.toLowerCase()}:{hl:m[0]});
    at=m.index+m[0].length;
  }
  if(at<s.length)out.push({text:s.slice(at)});
  return out;
}

// Web addresses in step text, as clickable pieces: the address minus trailing punctuation, http and https only.
const URL_RE=/https?:\/\/[^\s<>"'\]]+/g;
export function linkParts(text){
  const s=String(text??''),out=[];let at=0;
  for(const m of s.matchAll(URL_RE)){
    const url=m[0].replace(/[.,;:!?)]+$/,'');
    if(m.index>at)out.push({text:s.slice(at,m.index)});
    out.push({url});
    at=m.index+url.length;
  }
  if(at<s.length)out.push({text:s.slice(at)});
  return out;
}
export const linksIn=text=>[...new Set(linkParts(text).filter(p=>p.url).map(p=>p.url))];
// A chat message as safe HTML: every character escaped, **bold** as bold, and web addresses as short links that open in a new tab.
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// An address cut short in a summary ("https://ollama") has no dot in its host and stays plain text rather than a broken link.
const fullHost=url=>{try{return new URL(url).hostname.includes('.');}catch{return false;}};
export const chatHtml=text=>linkParts(text).map(p=>p.url&&!fullHost(p.url)?{text:p.url}:p).map(p=>p.url
  ?`<a class="chat-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortUrl(p.url))} ↗</a>`
  :escapeHtml(p.text).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')).join('');
// Opens a page the server handed back after a wait. A browser may block a window opened after a wait; the desktop app always
// hands links to the system browser, where window.open returns null by design. False means the page may not have opened.
export function openPage(url,win=globalThis.window){
  if(/Electron/i.test(win?.navigator?.userAgent??'')){win.open(url,'_blank');return true;}
  let w=null;try{w=win.open(url,'_blank');if(w)w.opener=null;}catch{w=null;}
  return !!w;
}
const webLinkOk=url=>{try{return ['https:','http:'].includes(new URL(url).protocol);}catch{return false;}};
// A long address reads as its site and the start of its path; the full address stays in the link and its title.
export const shortUrl=url=>{try{const u=new URL(url),rest=(u.pathname+u.search).replace(/\/$/,'');return u.hostname.replace(/^www\./,'')+(rest.length>22?rest.slice(0,20)+'…':rest);}catch{return url;}};
const siteName=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return 'the site';}};

// questionOf(id): an approval's full question, from the town state. The quest's title is only its first sentence.
// onPhone(): this page is a paired phone (body.remote), where a quest that only finishes on the computer offers the hand-off instead.
export function createQuestsPanel({panel,body,status,badge,onAction=()=>{},onOpenArtifact=()=>{},onCount=()=>{},questionOf=()=>null,fetchImpl=(...args)=>fetch(...args),onPhone=()=>panel.ownerDocument?.body?.classList?.contains?.('remote')===true}){
  let busy=false,again=false,lastKey=null,view='active',active=[],done=[];
  // Ids in quest text read as titles: owner steps and goals from the active list, artifacts from GET /api/artifacts while the panel is open.
  let known=new Map(),artifacts=[];
  // Ticks by quest id. The map keeps them when storage is off; storage keeps them across reloads.
  const ticks=new Map();
  let sheetQuest=null,sheetOpener=null,sheetMsg=null;
  // Sign-ins started from a quest that finish with a device code or a pasted address (plan 1.6), by quest id, shown in its sheet.
  const signins=new Map();
  // The sheet hangs off the body, not the panel: render() rebuilds the panel's list and the sheet must survive that.
  const sheet=el('dialog',{className:'quest-sheet',attrs:{role:'dialog','aria-labelledby':'quest-sheet-title'}});
  sheet.addEventListener('close',()=>{const opener=sheetOpener;sheetOpener=null;sheetQuest=null;if(opener?.isConnected)opener.focus();});
  panel.ownerDocument.body.append(sheet);

  function tabBar(){
    const tab=(id,label)=>{
      const button=el('button',{className:'quest-tab',text:label,attrs:{type:'button',role:'tab','aria-selected':String(view===id),'data-view':id}});
      button.onclick=()=>{if(view===id)return;view=id;lastKey=null;void refresh();};
      return button;
    };
    return el('div',{className:'quest-tabs',attrs:{role:'tablist','aria-label':'Needs you'}},[tab('active','Active'),tab('done','Done')]);
  }

  // Text with ids and money or durations highlighted, built node by node. A known id reads as its title. An artifact id is a chip
  // that opens the Archive on it. An unknown id is dropped, like humanizeText does.
  // The known id a token names: a full id, or the 8-character start of one. Null when the panel knows nothing by that id.
  function resolveId(token){return [...known.keys()].find(k=>k===token||(token.length===8&&k.startsWith(token)))??null;}
  // Plain text for a card's summary line: full ids read as titles, 8-character ids as their title or not at all.
  function plainText(text){return textParts(humanizeText(text,known)).map(p=>{if(p.hl)return p.hl;if(!p.id)return p.text;const id=resolveId(p.id);return id?known.get(id).title:'';}).join('');}
  function richNodes(text,open=onOpenArtifact){
    return textParts(text).flatMap(part=>{
      if(part.hl)return [el('span',{className:'quest-hl',text:part.hl})];
      if(!part.id)return linkParts(part.text).map(piece=>piece.url
        ?el('a',{className:'quest-link',text:shortUrl(piece.url),attrs:{href:piece.url,target:'_blank',rel:'noopener noreferrer',title:piece.url}})
        :document.createTextNode(piece.text));
      const id=resolveId(part.id);
      if(!id)return [];
      const title=known.get(id).title;
      if(!artifacts.some(a=>a.id===id))return [document.createTextNode(title)];
      const chip=el('button',{className:'quest-id',style:CHIP,attrs:{type:'button',title:`Open artifact ${title}`,'aria-label':`Open artifact ${title}`}},[el('span',{text:clip(title,40),style:PILL})]);
      chip.onclick=()=>open(id);
      return [chip];
    });
  }

  // Long text folds to a few lines with a More button; short text shows whole and gets no button.
  function foldable(text,className,limit){
    const p=el('p',{className:`quest-fold ${className}`},richNodes(text));
    if(text.length<=limit)return [p];
    const more=el('button',{className:'quest-more-text',text:'More',attrs:{type:'button','aria-expanded':'false'}});
    more.onclick=()=>{const open=p.classList.toggle('is-open');more.textContent=open?'Less':'More';more.setAttribute('aria-expanded',String(open));};
    return [p,more];
  }

  // Ticked steps for a quest: the map first, then storage. Storage can be off or full, so every access is guarded.
  function ticksOf(id){
    if(!ticks.has(id)){
      let saved=[];
      try{const raw=JSON.parse(localStorage.getItem(`quest-steps:${id}`)??'[]');if(Array.isArray(raw))saved=raw.filter(Number.isInteger);}catch{}
      ticks.set(id,saved);
    }
    return ticks.get(id);
  }
  function setTicks(id,list){
    ticks.set(id,list);
    try{localStorage.setItem(`quest-steps:${id}`,JSON.stringify(list));}catch{}
  }

  // Errors go to the sheet when it is open (the panel behind it cannot be reached), otherwise to the panel's status line.
  // A status line; with a link, the line ends in a tap-to-open button, so a blocked or missed page is one tap away.
  function say(message,link=null){
    const node=sheet.open&&sheetMsg?sheetMsg:status;node.hidden=false;
    node.replaceChildren(document.createTextNode(message),...(link?[' ',el('a',{className:'quest-open',text:link.label,attrs:{href:link.url,target:'_blank',rel:'noopener noreferrer'}})]:[]));
  }
  // Feedback for a one-tap link: the page opens in a new tab or the browser, and the owner knows where to look.
  function opened(link,url){link.addEventListener('click',()=>say(`Opened ${siteName(url)} in a new tab. Finish there, then come back and tick the step.`));return link;}
  function closeSheet(){if(sheet.open)sheet.close();}

  // Remove or Hide. Approvals and purchases are decisions, so they keep only their own answer button; a model quest's time is
  // always now, so a hide could never hold: signing in clears it.
  function removeButton(quest){
    const kind=quest.source?.kind;
    if(kind==='approval'||kind==='purchase'||kind==='model')return null;
    const label=kind==='goal'?'Remove goal':kind==='owner-step'?'Remove':'Hide';
    const button=el('button',{className:'quest-remove',text:label,attrs:{type:'button'}});
    button.onclick=()=>void removeQuest(quest,button);
    return button;
  }

  // Details opens the sheet. A quest with no text has nothing to open. Finished items (live false) have no actions in the sheet.
  function detailsButton(quest,live=true){
    if(!quest.detail?.trim())return null;
    const button=el('button',{className:'quest-more',text:'Details',attrs:{type:'button','aria-haspopup':'dialog'}});
    button.onclick=()=>openSheet(quest,button,live);
    return button;
  }

  function connectButton(quest){
    if(!quest.connect)return null;
    const button=el('button',{className:'quest-connect',text:`Connect ${quest.connect.name??'a service'}`,attrs:{type:'button'}});
    // A service that needs a token connects from the sheet, where the token box is.
    button.onclick=()=>quest.connect.token&&!sheet.open?openSheet(quest,button):void connect(quest,button);
    return button;
  }

  // Open the cats' browser on the owner's computer, for a step that signs in or makes a token there. A phone gets a 403 and is told so.
  function browserButton(quest){
    if(!quest.browser||(quest.computer&&onPhone()))return null;
    const button=el('button',{className:'quest-connect',text:'Open the cats’ browser',attrs:{type:'button'}});
    button.onclick=()=>void openBrowser(button,quest.url);
    return button;
  }
  async function openBrowser(button,url){
    button.disabled=true;
    try{
      const r=await fetchImpl('/api/cat-browser/open',{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(url?{url}:{})});
      if(r.status===403){say('Open it on the computer running Clowder.');return;}
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      say('Opened the cats’ browser. Finish there, then come back and tick the step.');
    }catch(error){say(`Could not open the cats’ browser. ${error.message}`);}
    finally{button.disabled=false;}
  }

  // "Continue on your computer" (plan 1.6): a quest that only finishes on the computer running Clowder (the cats' browser, a CLI sign-in) is sent
  // there from the phone; the computer then lists it first. Once sent, the button says so and stays off.
  function handoffButton(quest){
    if(!quest.computer||!onPhone())return null;
    const sent=!!quest.handoff;
    const button=el('button',{className:'quest-connect quest-handoff',text:sent?'Sent to your computer ✓':'Continue on your computer',attrs:{type:'button'}});
    if(sent)button.disabled=true;
    else button.onclick=()=>void handoff(quest,button);
    return button;
  }
  async function handoff(quest,button){
    button.disabled=true;
    try{
      const r=await fetchImpl(`/api/quests/${encodeURIComponent(quest.id)}/handoff`,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:'{}'});
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      lastKey=null;closeSheet();
      await refresh();
      say('Sent to your computer. It waits at the top of Needs you there.');
    }catch(error){
      say(`Could not send it. ${error.message}`);
      button.disabled=false;
    }
  }

  // The quest's own main button: Mark done for an owner step (its note comes from note()), the quest's action otherwise.
  // The action opens another surface (an approval's decision, a panel or a dialog), so the sheet closes first and never covers it.
  function primaryButton(quest,note=()=>''){
    const button=el('button',{className:'quest-action quest-primary',text:quest.source?.kind==='owner-step'?'Mark done':quest.action.label,attrs:{type:'button'}});
    if(quest.source?.kind==='owner-step')button.onclick=()=>void markDone(quest,note(),button);
    else button.onclick=()=>{closeSheet();onAction(quest);};
    return button;
  }

  function progressBar(done,total){
    return el('div',{className:'quest-progress'},[
      el('span',{className:'quest-tally',text:`${done} of ${total} done`}),
      el('span',{className:'quest-bar',attrs:{'aria-hidden':'true'}},[el('i',{style:{width:`${Math.round(done/total*100)}%`}})]),
    ]);
  }
  function progressNode(quest){
    if(quest.source?.kind!=='owner-step')return null;
    const {done,total}=progressOf(quest.detail,ticksOf(quest.id));
    return total?progressBar(done,total):null;
  }

  // One card: a badge (✓ when finished, else its noun's glyph), what it is (Decision, To-do · Account, Goal…), title, one summary
  // line, the step tally, time and one button row. The kind line names a to-do, so its title drops the "To-do:" the server put on it.
  function card(quest,buttons,progress=null){
    const time=el('time',{className:'quest-time',text:ago(quest.at)});
    if(quest.at)time.dateTime=quest.at;
    const summary=summaryOf(plainText(plainWords(quest.detail)));
    const kind=[nounOf(quest),quest.source?.kind==='owner-step'?kindLabel(quest.stepKind??quest.kind):''].filter(Boolean).join(' · ');
    const done=quest.rank==='F';
    return el('li',{className:'quest',attrs:{'data-rank':quest.rank,'data-id':quest.id}},[
      el('span',{className:'rank-badge',text:glyphOf(quest),attrs:{'data-rank':quest.rank,...(done?{role:'img','aria-label':'Done'}:{'aria-hidden':'true'})}}),
      el('div',{className:'quest-main'},[
        el('p',{className:'quest-kind',text:kind}),
        el('p',{className:'quest-title'},richNodes(plainWords(quest.title).replace(/^To-do: /,''))),
        summary?el('p',{className:'quest-summary',text:summary}):null,
        progress,
        quest.handoff&&!onPhone()?el('p',{className:'quest-sent',text:`Sent from your phone ${ago(quest.handoff)}. Finish it here.`}):null,
        time,
        el('div',{className:'quest-buttons'},buttons.filter(Boolean)),
      ].filter(Boolean)),
    ]);
  }

  function row(quest){
    return card(quest,[primaryButton(quest),connectButton(quest),browserButton(quest),handoffButton(quest),removeButton(quest),detailsButton(quest)],progressNode(quest));
  }

  // Quests the owner does not need to act on: one collapsed section, open state remembered in this browser.
  function handledOpen(){try{return localStorage.getItem(HANDLED_KEY)==='1';}catch{return false;}}
  function handledSection(items){
    const details=el('details',{className:'quest-handled'},[
      el('summary',{text:`Your cats are handling these (${items.length})`}),
      el('ul',{className:'quest-list'},items.map(row)),
    ]);
    details.open=handledOpen();
    details.ontoggle=()=>{try{localStorage.setItem(HANDLED_KEY,details.open?'1':'0');}catch{}};
    return details;
  }

  async function markDone(quest,note,button){
    button.disabled=true;
    try{
      const r=await fetchImpl(`/api/owner-steps/${encodeURIComponent(quest.source.id)}/done`,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify({note:String(note??'').trim()})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(data.error||'Request failed');
      lastKey=null;closeSheet();
      await refresh();
      // A cats' browser step hands the work back to its cat: say so, since nothing else on screen changes at once.
      if(data.message&&data.message!=='Marked done.')say(data.message);
    }catch(error){
      say(`Could not mark it done. ${error.message}`);
      button.disabled=false;
    }
  }

  // Opens the service's sign-in page when the server gives one. A 403 means this browser is not the computer running Clowder.
  async function connect(quest,button){
    button.disabled=true;
    try{
      const token=sheet.open&&sheetQuest===quest?sheet.querySelector('.quest-token-input')?.value.trim():'';
      const r=await fetchImpl(`/api/owner-steps/${encodeURIComponent(quest.source.id)}/connect`,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(token?{token}:{})});
      if(r.status===403){say('Connect it on the computer running Clowder.');button.disabled=false;return;}
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(data.error||'Request failed');
      const plan=signInPlan(data);
      button.disabled=false;
      lastKey=null;await refresh();
      if(plan&&plan.finish!=='callback'){
        // A device code or a pasted address is finished in the sheet, where the code or the paste box stays in view.
        signins.set(quest.id,plan);
        if(sheet.open&&sheetQuest?.id===quest.id)paintSignin();else openSheet(quest,button);
        if(plan.finish==='paste')openPage(plan.url);
      }else if(plan){
        const ok=openPage(plan.url);
        say(ok?`The ${quest.connect.name} sign-in page opened. Finish there; this updates by itself.`:`Your browser did not open the ${quest.connect.name} sign-in page.`,{url:plan.url,label:ok?'Open it again ↗':'Open the sign-in page ↗'});
      }else say(data.account?tokenLine(data.account,quest.connect.name):`${quest.connect.name} is connected.`);
    }catch(error){
      say(`Could not connect. ${error.message}`);
      button.disabled=false;
    }
  }

  // Goals and owner steps confirm first; a Hide is immediate. The server refuses non-owners with a 403, shown in the status line.
  async function removeQuest(quest,button){
    const kind=quest.source.kind;
    if(kind==='goal'){
      const ok=await confirmDialog({title:`Remove “${plainWords(quest.title).slice(0,60)}”?`,message:'It leaves the goal list, Needs you and the Mayor’s banner. The journal keeps the record.',confirmLabel:'Remove goal',cancelLabel:'Keep it',danger:true});
      if(!ok)return;
    }else if(kind==='owner-step'){
      const ok=await confirmDialog({title:'Remove this to-do?',message:'It is not marked done. A goal waiting on it resumes.',confirmLabel:'Remove',cancelLabel:'Keep it',danger:true});
      if(!ok)return;
    }
    const url=kind==='goal'?`/api/goals/${encodeURIComponent(quest.source.id)}/archive`:kind==='owner-step'?`/api/owner-steps/${encodeURIComponent(quest.source.id)}/dismiss`:`/api/quests/${encodeURIComponent(quest.id)}/hide`;
    const payload=kind==='goal'||kind==='owner-step'?{}:{at:quest.at??null};
    button.disabled=true;
    try{
      const r=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(payload)});
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      lastKey=null;closeSheet();
      await refresh();
    }catch(error){
      say(`Could not remove it. ${error.message}`);
      button.disabled=false;
    }
  }

  // Finished items are read-only: the time they finished, and Details for what was decided.
  function doneRow(item){return card(item,[detailsButton(item,false)]);}

  // One step as a card: a number bubble, the title with its checkbox on the right, and the rest of the step folded.
  function stepNode(quest,i,text){
    const {title,body}=stepParts(text);
    const box=el('input',{attrs:{type:'checkbox','aria-label':title}});
    box.checked=ticksOf(quest.id).includes(i);
    const item=el('li',{className:'quest-step',attrs:{'data-done':String(box.checked)}},[
      el('span',{className:'quest-step-num',text:String(i+1),attrs:{'aria-hidden':'true'}}),
      el('div',{className:'quest-step-main'},[
        el('div',{className:'quest-step-head'},[
          el('p',{className:'quest-step-title'},richNodes(title)),
          el('label',{className:'quest-step-check'},[box]),
        ]),
        ...(body?[el('div',{className:'quest-step-text'},foldable(body,'quest-step-body',130))]:[]),
        // One tap opens each site the step names, instead of copying its address.
        ...linksIn(text).slice(0,3).map(url=>opened(el('a',{className:'quest-open',text:`Open ${siteName(url)} ↗`,attrs:{href:url,target:'_blank',rel:'noopener noreferrer'}}),url)),
      ]),
    ]);
    box.onchange=()=>{
      const set=ticksOf(quest.id).filter(n=>n!==i);
      if(box.checked)set.push(i);
      setTicks(quest.id,set.sort((a,b)=>a-b));
      item.dataset.done=String(box.checked);
      paintProgress();
    };
    return item;
  }

  // A tick redraws the sheet's progress and Mark done, and the card's tally. The list is not rebuilt, so focus stays put.
  function paintProgress(){
    const quest=sheetQuest;if(!quest)return;
    const {done,total}=progressOf(quest.detail,ticksOf(quest.id));
    sheet.querySelector('.quest-sheet-progress')?.replaceChildren(...(total?[progressBar(done,total)]:[]));
    if(quest.source?.kind==='owner-step')sheet.querySelector('.quest-primary')?.setAttribute('data-ready',String(!total||done===total));
    const tally=[...body.querySelectorAll('li.quest')].find(li=>li.dataset.id===quest.id)?.querySelector('.quest-progress');
    if(tally&&total)tally.replaceWith(progressBar(done,total));
  }

  // The step view: full height on phones, a wide panel on desktop. Escape and Back close it and return focus to Details.
  // Where to make the token (one tap), one line of how, and the box to paste it in. Connect sends it with the request.
  function tokenNode(quest){
    const {url,help}=quest.connect.token;
    return el('div',{className:'quest-token'},[
      el('p',{className:'quest-token-help',text:help}),
      ...(webLinkOk(url)?[opened(el('a',{className:'quest-open',text:`Get a token on ${quest.connect.name} ↗`,attrs:{href:url,target:'_blank',rel:'noopener noreferrer'}}),url)]:[]),
      el('input',{className:'quest-token-input',attrs:{type:'password',autocomplete:'off',spellcheck:'false',maxlength:'500',placeholder:'Paste the token here','aria-label':`${quest.connect.name} token`}}),
    ]);
  }

  // The open sheet's sign-in box: the code to type, or the box to paste the address into. A paste that finishes refreshes the list.
  function paintSignin(){
    const slot=sheet.querySelector('.quest-sheet-connect'),quest=sheetQuest;
    if(!slot||!quest)return;
    const plan=signins.get(quest.id);
    slot.replaceChildren(...(plan?[signInBox(plan,{name:quest.connect?.name??'the service',fetchImpl,onDone:()=>{signins.delete(quest.id);lastKey=null;void refresh();}})]:[]));
  }

  function openSheet(quest,opener,live=true){
    sheetQuest=quest;sheetOpener=opener;
    sheet.style.setProperty('--q',`var(--rank-${String(quest.rank).toLowerCase()})`);
    const {intro,steps}=splitSteps(plainWords(quest.detail));
    const owner=quest.source?.kind==='owner-step';
    // An approval leads with its whole question, as the decision shows it; the line under it says who waits.
    const question=quest.source?.kind==='approval'?String(questionOf(quest.source.id)??'').trim():'';
    const back=el('button',{className:'back-pill quest-sheet-back',text:'← Back',attrs:{type:'button'}});
    back.onclick=()=>closeSheet();
    const note=el('input',{className:'quest-note',attrs:{type:'text',maxlength:'600',placeholder:'Note (optional)','aria-label':`Note for ${quest.title}`}});
    sheetMsg=el('p',{className:'quest-sheet-msg',attrs:{role:'status',hidden:''}});
    const actions=live?[removeButton(quest),connectButton(quest),browserButton(quest),handoffButton(quest),primaryButton(quest,()=>note.value)].filter(Boolean):[];
    sheet.replaceChildren(
      el('div',{className:'quest-sheet-head'},[back,el('h2',{className:'quest-sheet-title',text:plainWords(humanizeText(quest.title,known)),attrs:{id:'quest-sheet-title'}})]),
      el('div',{className:'quest-sheet-body'},[
        owner&&steps.length?el('div',{className:'quest-sheet-progress'}):null,
        question||intro?el('div',{className:'quest-callout'},[...(question?[el('p',{className:'quest-question',text:humanizeText(question,known)})]:[]),...(intro?foldable(intro,'quest-intro-text',100):[])]):null,
        steps.length?el('ol',{className:'quest-stepper',attrs:{'aria-label':'Steps'}},steps.map((text,i)=>stepNode(quest,i,text))):null,
        live&&quest.connect?.token?tokenNode(quest):null,
        live&&quest.connect?el('div',{className:'quest-sheet-connect'}):null,
        owner?note:null,
      ].filter(Boolean)),
      el('div',{className:'quest-sheet-foot'},[sheetMsg,...actions]),
    );
    sheet.querySelector('.quest-sheet-foot').hidden=!actions.length;
    paintProgress();
    paintSignin();
    sheet.showModal();
    back.focus();
  }

  // Nothing needs the owner: one sentence, and the Diary (its dock button, as a tap would) shows what the cats did meanwhile.
  function emptyNeeds(){
    const diary=el('button',{className:'secondary',text:'See the diary',attrs:{type:'button'}});
    diary.onclick=()=>panel.ownerDocument?.getElementById?.('toggle-diary')?.click();
    return emptyState(panel.ownerDocument??document,{icon:'check',text:'Nothing needs you right now; your cats are on it.',action:diary});
  }

  function render(){
    let content;
    if(view==='done'){
      content=done.length
        ?el('ul',{className:'quest-list done-list'},done.map(doneRow))
        :emptyState(panel.ownerDocument??document,{icon:'list-checks',text:'Nothing finished yet.'});
    }else{
      const {needs,handled}=splitNeeds(active);
      const groups=groupQuests(needs);
      content=el('div',{className:'quest-groups'},[
        ...(groups.length
          ?groups.map(([rank,items])=>el('section',{className:'quest-group',attrs:{'data-rank':rank,'aria-labelledby':`quest-rank-${rank}`}},[
              el('h3',{className:'rank-heading',text:HEADINGS[rank],attrs:{id:`quest-rank-${rank}`}}),
              el('ul',{className:'quest-list'},items.map(row)),
            ]))
          :[emptyNeeds()]),
        handled.length?handledSection(handled):null,
      ].filter(Boolean));
    }
    body.replaceChildren(tabBar(),content);
  }

  // Artifact titles for ids in quest text. A failed read keeps the last list.
  async function loadArtifacts(){
    try{const r=await fetchImpl('/api/artifacts');if(!r.ok)return artifacts;return (await r.json()).artifacts??[];}
    catch{return artifacts;}
  }

  // The badge is fetched even while the panel is closed. Rows are rebuilt only when visible data changes.
  // The minute bucket in the key refreshes the relative times without re-rendering on every poll.
  async function refresh(){
    if(busy){again=true;return;}
    busy=true;
    try{
      const r=await fetchImpl('/api/quests');
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      active=await r.json();
      if(!panel.hidden)artifacts=await loadArtifacts();
      known=new Map([...artifacts.map(a=>[a.id,{title:humanizeText(a.title||'Untitled')}]),...active.filter(q=>q.source?.id).map(q=>[q.source.id,{title:plainWords(humanizeText(q.title))}])]);
      // A device-code sign-in finishes on the server: once its quest closes, the open sheet says so instead of showing a stale code.
      for(const id of [...signins.keys()])if(!active.some(q=>q.id===id)){signins.delete(id);if(sheet.open&&sheetQuest?.id===id){paintSignin();say('Signed in. This to-do is done.');}}
      const count=needsYouCount(active);
      badge.textContent=String(count);badge.hidden=count===0;badge.setAttribute('aria-label',badgeLabel(count));onCount(count);
      if(!panel.hidden&&view==='done'){
        const d=await fetchImpl('/api/quests/done');
        if(!d.ok)throw new Error((await d.json().catch(()=>({}))).error||'Request failed');
        done=await d.json();
      }
      status.textContent='';status.hidden=true;
      const key=view+JSON.stringify(view==='done'?done:active)+JSON.stringify(known)+Math.floor(Date.now()/60000);
      if(!panel.hidden&&key!==lastKey){lastKey=key;render();}
    }catch(error){
      status.hidden=false;status.textContent=`Quests could not load. ${error.message}`;
    }finally{
      busy=false;
      if(again){again=false;void refresh();}
    }
  }

  return {refresh};
}

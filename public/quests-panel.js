// The Inbox (the dock's old Quests and Needs you): what needs the owner, most urgent first, read from GET /api/quests (read-only, so paired viewers
// see it too). The server ranks items S to F; the panel shows plain words instead (plain-words.js, D12): each card says whether it is
// a Decision, a To-do, a Goal or a Request, and a finished one wears ✓, never a grade.
// Two tabs: Active (what needs attention now) and Done (finished items, from GET /api/quests/done, newest first).
// Active is in bands (plan 11.16), from the server's band (src/quests.ts): Needs you (needsYou true: the one "needs you" count,
// needsYouCount, that the dock badge, the Mayor's notice and the Projects summary all show), Trouble (open, not counted, with Retry for a
// failed request), For you, then two folded sections: the quiet work the cats handle, and what finished recently. A card is short: title, one summary line,
// the step tally for to-dos and one button row. Details opens a sheet (a native dialog) with the intro and the steps
// as a stepper; a to-do's ticks live on the server (plan 11.9), so a tick on the phone reads back on the computer. The server refuses
// marks, removals and hides for anyone but the owner.
// A to-do or Payment card (plan 11.23): kind and due on line 1 ("Due Fri", "Approval ends in 2 days"), the title, "For: <request>", one
// line why and "After you mark it done: …", then Mark done, Remind me tomorrow, Remove and Details. On a phone-width screen the card is
// only kind and due, title and one main button, with the rest in Details. A to-do with a due date offers Add to calendar (.ics).
// A decision is drawn by decision-strip.js (decisionCard), the same card the chat shows, and is answered where it appears (plan 8.8).
// For you cards (quests of kind 'suggestion', owner only) leave the folded section for their own section after Trouble, drawn by
// for-you.js (plan 9.11). They have needsYou false, so the count above never includes them.
// The pure helpers are exported for Node tests; the DOM is built with createElement and textContent only.
import {el,clip} from './projects-panel.js';
import {confirmDialog} from './dialogs.js';
import {webLink} from './connectors-panel.js';
import {signInPlan,signInBox,tokenLine} from './connect-flow.js';
import {humanizeText} from './humanize-ids.js';
import {BANDS,approvalEnds,glyphOf,needsYouLabel,nounOf,plainWords} from './plain-words.js';
import {emptyState} from './empty-state.js';
import {createForYou,isForYou} from './for-you.js';
import {PHONE_QUERY} from './mobile-ui.js';

export const RANK_ORDER=['S','A','B','C','D','E','F'];
// An artifact chip's tap area is the 44px button; the visible pill inside stays about 22px tall.
const CHIP={'min-height':'44px',padding:'0 2px',border:'0',background:'none',display:'inline-flex','align-items':'center','vertical-align':'middle','max-width':'100%'};
const PILL={display:'inline-block',maxWidth:'100%',padding:'0 8px',border:'1px solid #c9d7bb','border-radius':'999px',background:'#e3efd9',color:'#2f4a2c',font:'600 12px/22px var(--font-ui,Inter,"Segoe UI",sans-serif)','overflow-wrap':'anywhere'};
const KINDS=new Map([['account','Account'],['payment','Payment'],['legal','Legal'],['identity','Identity'],['physical','In person'],['design','Design']]);
const HANDLED_KEY='clowder.questsHandledOpen',FINISHED_KEY='clowder.questsFinishedOpen';
// A request the network never reached says so in plain words, not the browser's "Failed to fetch" (F7).
const NOT_ANSWERING='Clowder is not answering.';
// The glossary (D12, plan 3.9): what each of the four words means, said where the word appears. The title shows it on hover, and the
// first card of each kind in a list says it in words under its label, for touch and screen readers.
export const GLOSSARY={
  Goal:'Something your cats keep working on, round by round, until it is done.',
  Request:'Something you asked a cat to do.',
  Decision:'Something a cat asks you to decide.',
  'To-do':'Something only you can do.',
  // For you's two card nouns (D16, plan 9.11).
  'Heads-up':'Something your cats noticed for you. Nothing to do but know.',
  Suggestion:'Something your cats could take on for you. Start sends it to the Mayor as a Request.',
};

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

// Where the owner answered a Done item (plan 11.16, N10), from the device the journal keeps: 'host' is the computer running Clowder,
// 'telegram' and 'discord' the chat channels, anything else a paired device. phone: this page is a paired phone.
// ponytail: every paired device reads "your phone"; a paired tablet would need the device list (host only) to say otherwise.
export function answeredFrom(device,{phone=false}={}){
  if(!device)return '';
  return `From ${device==='host'?(phone?'your computer':'this computer'):device==='telegram'?'Telegram':device==='discord'?'Discord':device.startsWith('mcp:')?`MCP token ${device.slice(4)}`:'your phone'}`;
}

// A to-do's due date (YYYY-MM-DD, the day its cat stated, plan 11.9) in words: today, tomorrow, the weekday within the week ("Due Fri"),
// else the date; a day gone by reads "Was due 6 Nov". Days are counted on the date parts against today's local date, so no time zone
// shifts them. Anything that is not a date reads as nothing.
const DAY_MS=86_400_000;
const dateParts=due=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due??''));return m?[Number(m[1]),Number(m[2])-1,Number(m[3])]:null;};
export function dueLabel(due,now=Date.now()){
  const parts=dateParts(due);if(!parts)return '';
  const at=Date.UTC(...parts),n=new Date(now),days=Math.round((at-Date.UTC(n.getFullYear(),n.getMonth(),n.getDate()))/DAY_MS);
  const fmt=options=>new Date(at).toLocaleDateString('en-GB',{...options,timeZone:'UTC'});
  if(days===0)return 'Due today';
  if(days===1)return 'Due tomorrow';
  if(days>1&&days<7)return `Due ${fmt({weekday:'short'})}`;
  return `${days<0?'Was due':'Due'} ${fmt({day:'numeric',month:'short'})}`;
}

// Remind me tomorrow (plan 11.18, 11.23): the to-do comes back at 9:00 tomorrow, this device's time.
export function tomorrowAt(now=Date.now()){const d=new Date(now);d.setDate(d.getDate()+1);d.setHours(9,0,0,0);return d.toISOString();}

// Add to calendar (N11): a to-do with a due date as a one-day event in an .ics file. No connector and no model: the file is built here.
// ponytail: lines are not folded at 75 octets (RFC 5545 says SHOULD); calendars read long lines. Fold them if one refuses the file.
const icsText=s=>String(s??'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
export function icsOf(quest,now=Date.now()){
  const parts=dateParts(quest?.due);if(!parts)return '';
  const day=t=>new Date(t).toISOString().slice(0,10).replace(/-/g,''),start=Date.UTC(...parts);
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Clowder//Inbox//EN','BEGIN:VEVENT',`UID:${quest.id}@clowder`,`DTSTAMP:${new Date(now).toISOString().replace(/[-:]|\.\d{3}/g,'')}`,
    `DTSTART;VALUE=DATE:${day(start)}`,`DTEND;VALUE=DATE:${day(start+DAY_MS)}`,`SUMMARY:${icsText(plainWords(quest.title).replace(/^To-do: /,''))}`,
    ...(quest.detail?[`DESCRIPTION:${icsText(quest.detail)}`]:[]),'END:VEVENT','END:VCALENDAR',''].join('\r\n');
}

// Splits quest text into an intro and steps. Numbers count up from 0 or 1 ("v2.1" and "15/17" stay in the text), "1)" works too,
// and with no numbers, lines starting with - or • are steps. lines: the line each step starts on (an index into text.split('\n')),
// which is what the server's tick route counts (plan 11.9).
function parseSteps(text){
  const s=String(text??''),lineOf=at=>s.slice(0,at).split('\n').length-1;
  const marks=[];let want=null;
  for(const m of s.matchAll(/(?<=^|\s)(\d{1,2})[.)]\s+/g)){
    const n=Number(m[1]);
    if(want===null?n>1:n!==want)continue;
    marks.push({at:m.index,start:m.index+m[0].length});want=n+1;
  }
  if(marks.length)return {intro:s.slice(0,marks[0].at).trim(),steps:marks.map((mark,i)=>s.slice(mark.start,marks[i+1]?.at??s.length).trim()),lines:marks.map(mark=>lineOf(mark.at))};
  const lines=s.split('\n');
  if(!lines.some(line=>/^\s*[-•]\s/.test(line)))return {intro:s.trim(),steps:[],lines:[]};
  const intro=[],steps=[],at=[];
  lines.forEach((line,i)=>{
    const bullet=line.match(/^\s*[-•]\s+(.*)$/);
    if(bullet){steps.push(bullet[1].trim());at.push(i);}
    else if(!line.trim())return;
    else if(steps.length)steps[steps.length-1]+=` ${line.trim()}`;
    else intro.push(line.trim());
  });
  const kept=steps.flatMap((step,i)=>step?[i]:[]);
  return {intro:intro.join(' '),steps:kept.map(i=>steps[i]),lines:kept.map(i=>at[i])};
}
export function splitSteps(text){const {intro,steps}=parseSteps(text);return {intro,steps};}
// The line each step starts on. Steps written on one line ("1. a 2. b") share it.
export const stepLines=text=>parseSteps(text).lines;

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
// decisionCard(id, {explain, note}): the decision strip's live card for an approval (decision-strip.js decisionCardFor), or null.
// openThread({kind, id}): opens a Request or goal thread in the chat (For you's Start opens the Request it made).
// compact(): the screen is phone-width (mobile-ui.js PHONE_QUERY), so a to-do or Payment card is drawn compact (plan 11.23, N11).
export function createQuestsPanel({panel,body,status,badge,openThread=null,onAction=()=>{},onOpenArtifact=()=>{},onCount=()=>{},questionOf=()=>null,decisionCard=null,fetchImpl=(...args)=>fetch(...args),onPhone=()=>panel.ownerDocument?.body?.classList?.contains?.('remote')===true,compact=()=>globalThis.matchMedia?.(PHONE_QUERY)?.matches===true}){
  let busy=false,again=false,lastKey=null,view='active',active=[],done=[];
  // Decisions listed during this visit, in the order first shown. Once answered they stay in place, folded, so the list never just
  // empties under the owner's thumb (chat-ux principle 4). Forgotten when the panel closes.
  const seen=new Map();
  // Glossary words already explained in this drawing of the list: only the first card of each kind says what its word means.
  let explained=new Set();
  const firstTime=noun=>!!GLOSSARY[noun]&&!explained.has(noun)&&!!explained.add(noun);
  // Ids in quest text read as titles: owner steps and goals from the active list, artifacts from GET /api/artifacts while the panel is open.
  let known=new Map(),artifacts=[];
  // Ticked steps by quest id, as step indexes. A to-do's come from the server with the list and go back one line at a time (plan 11.9,
  // N12); the server counts lines, so serverLines maps between the two. Other quests' ticks last while this page is open.
  const ticks=new Map();
  let sheetQuest=null,sheetOpener=null,sheetMsg=null;
  // Sign-ins started from a quest that finish with a device code or a pasted address (plan 1.6), by quest id, shown in its sheet.
  const signins=new Map();
  // Payments this phone was refused (no fresh passkey step-up): their cards offer Continue on your computer (plan 11.16, N1).
  const phoneOnly=new Set();
  const post=(path,payload={})=>fetchImpl(path,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(payload)});
  const read=url=>fetchImpl(url).catch(()=>{throw new Error(NOT_ANSWERING);});
  // The sheet hangs off the body, not the panel: render() rebuilds the panel's list and the sheet must survive that.
  const sheet=el('dialog',{className:'quest-sheet',attrs:{role:'dialog','aria-labelledby':'quest-sheet-title'}});
  sheet.addEventListener('close',()=>{const opener=sheetOpener;sheetOpener=null;sheetQuest=null;if(opener?.isConnected)opener.focus();});
  panel.ownerDocument.body.append(sheet);
  const forYou=createForYou({doc:panel.ownerDocument,fetchImpl,openThread,onAction,say:(...args)=>say(...args),repaint:()=>{if(!panel.hidden)render();},refresh:()=>{lastKey=null;return refresh();}});
  // Turning a phone or resizing across the phone width redraws the cards in their other form.
  globalThis.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change',()=>{lastKey=null;if(!panel.hidden)render();});

  function tabBar(){
    const tab=(id,label)=>{
      const button=el('button',{className:'quest-tab',text:label,attrs:{type:'button',role:'tab','aria-selected':String(view===id),'data-view':id}});
      button.onclick=()=>{if(view===id)return;view=id;lastKey=null;void refresh();};
      return button;
    };
    return el('div',{className:'quest-tabs',attrs:{role:'tablist','aria-label':'Inbox'}},[tab('active','Active'),tab('done','Done')]);
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

  const ticksOf=id=>ticks.get(id)??[];
  // The server's line for each step of a to-do, or null when its ticks stay in this page: not a to-do, no steps, or steps that share a
  // line ("1. a 2. b" on one line), which the server cannot tell apart. The tool asks the cat for one line per step.
  // ponytail: a connect step whose sign-in was abandoned gets a two-line prefix on its detail (quests.ts:84), which shifts its lines by 2.
  function serverLines(quest){
    if(quest.source?.kind!=='owner-step')return null;
    const lines=stepLines(quest.detail);
    return lines.length&&new Set(lines).size===lines.length?lines:null;
  }
  const stepsAt=(lines,server)=>lines.flatMap((line,i)=>server.includes(line)?[i]:[]);
  // Every to-do's ticks, read with the list while the panel is open. A failed read keeps the last ticks.
  // ponytail: one GET per to-do with steps on each refresh of the open panel; carry the ticks on /api/quests if the list grows long.
  function loadTicks(){
    return Promise.all(active.map(async quest=>{
      const lines=serverLines(quest);if(!lines)return;
      try{
        const r=await fetchImpl(`/api/owner-steps/${encodeURIComponent(quest.source.id)}/ticks`);
        const data=r.ok?await r.json():null;
        if(Array.isArray(data?.ticks))ticks.set(quest.id,stepsAt(lines,data.ticks));
      }catch{}
    }));
  }
  // A tick shows at once, then goes to the server; a refused one is undone and said.
  async function tick(quest,i,done,box,item){
    const flip=on=>{const set=ticksOf(quest.id).filter(n=>n!==i);if(on)set.push(i);ticks.set(quest.id,set.sort((a,b)=>a-b));box.checked=on;item.dataset.done=String(on);paintProgress();};
    flip(done);
    const lines=serverLines(quest);if(!lines)return;
    try{
      const r=await post(`/api/owner-steps/${encodeURIComponent(quest.source.id)}/tick`,{line:lines[i],done});
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(data.error||'Request failed');
      if(Array.isArray(data.ticks)){ticks.set(quest.id,stepsAt(lines,data.ticks));paintProgress();}
    }catch(error){
      flip(!done);
      say(`Could not save the tick. ${error.message}`);
    }
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
    // A connect to-do's other choice is to leave it for now (N5): the same dismiss, in the words of the choice.
    const label=kind==='goal'?'Remove goal':kind==='owner-step'?(quest.connect?'Not now':'Remove'):'Hide';
    const button=el('button',{className:'quest-remove',text:label,attrs:{type:'button'}});
    button.onclick=()=>void removeQuest(quest,button);
    return button;
  }

  // Remind me tomorrow (plan 11.18, 11.23, N11): the to-do leaves Needs you until 9:00 tomorrow, then comes back and is announced again.
  // Only to-dos: a Payment's 72 h approval could end while it is away.
  function remindButton(quest){
    if(quest.source?.kind!=='owner-step')return null;
    const button=el('button',{className:'quest-remind',text:'Remind me tomorrow',attrs:{type:'button'}});
    button.onclick=()=>void remindTomorrow(quest,button);
    return button;
  }
  async function remindTomorrow(quest,button){
    button.disabled=true;
    try{
      const r=await post(`/api/quests/${encodeURIComponent(quest.id)}/hide`,{at:quest.at??null,until:tomorrowAt()});
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      lastKey=null;closeSheet();
      await refresh();
      say('It comes back tomorrow at 9:00.');
    }catch(error){
      say(`Could not put it off. ${error.message}`);
      button.disabled=false;
    }
  }

  // Details opens the sheet. A quest with no text has nothing to open. Finished items (live false) have no actions in the sheet.
  function detailsButton(quest,live=true){
    // A Payment's Mark paid opens the same sheet, so a second opener would only repeat it.
    if(!quest.detail?.trim()||(live&&quest.payment))return null;
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
    if(!(quest.computer||phoneOnly.has(quest.id))||!onPhone())return null;
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
      say('Sent to your computer. It waits at the top of the Inbox there.');
    }catch(error){
      say(`Could not send it. ${error.message}`);
      button.disabled=false;
    }
  }

  // The quest's own main button: Mark done for an owner step (its note comes from note()), the quest's action otherwise.
  // The action opens another surface (an approval's decision, a panel or a dialog), so the sheet closes first and never covers it.
  // A connect to-do has Connect as its only main button (N5): Mark done would close it with nothing connected and no cat told.
  // A Payment's Mark paid opens its sheet, where the amount is; there it records the payment (N1). Beside a Retry the action is secondary.
  function primaryButton(quest,note=()=>''){
    const owner=quest.source?.kind==='owner-step';
    if(owner&&quest.connect)return null;
    const button=el('button',{className:canRetry(quest)?'quest-more':'quest-action quest-primary',text:owner?'Mark done':quest.action.label,attrs:{type:'button'}});
    if(owner)button.onclick=()=>void markDone(quest,note(),button);
    else if(quest.payment)button.onclick=()=>sheet.open&&sheetQuest===quest?void markPaid(quest,button):openSheet(quest,button);
    else button.onclick=()=>{closeSheet();onAction(quest);};
    return button;
  }

  // Trouble (plan 11.16, N6): a failed request runs again inside the same request (POST /api/tasks/:id/retry, plan 11.1). Its id is the root task's.
  const canRetry=quest=>quest.band==='trouble'&&quest.source?.kind==='project';
  function retryButton(quest){
    if(!canRetry(quest))return null;
    const button=el('button',{className:'quest-action quest-primary',text:'Retry',attrs:{type:'button'}});
    button.onclick=()=>void retry(quest,button);
    return button;
  }
  async function retry(quest,button){
    button.disabled=true;
    try{
      const r=await post(`/api/tasks/${encodeURIComponent(quest.source.id)}/retry`);
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      lastKey=null;closeSheet();
      await refresh();
      say('Running it again, inside the same request.');
    }catch(error){
      say(`Could not retry it. ${error.message}`);
      button.disabled=false;
    }
  }

  // Mark paid records what the owner paid outside the app (POST /api/purchases/:id/paid). Money stays on the computer running Clowder
  // unless this phone has a fresh passkey step-up (plan 5.5): refused here, the passkey page opens where this phone offers one, else
  // the card offers Continue on your computer.
  async function markPaid(quest,button){
    const amount=sheet.querySelector('.quest-amount')?.value.trim()??'';
    button.disabled=true;
    try{
      const r=await post(`/api/purchases/${encodeURIComponent(quest.source.id)}/paid`,{amount});
      const data=await r.json().catch(()=>({}));
      if(r.status===403&&onPhone()){button.disabled=false;needsComputer(quest);return;}
      if(!r.ok)throw new Error(data.error||'Request failed');
      lastKey=null;closeSheet();
      await refresh();
      say(`Recorded as paid: ${quest.payment.vendor}.`);
    }catch(error){
      say(`Could not mark it paid. ${error.message}`);
      button.disabled=false;
    }
  }
  function needsComputer(quest){
    const stepUp=panel.ownerDocument?.getElementById?.('step-up-open');
    closeSheet();
    if(stepUp&&!stepUp.hidden){stepUp.click();say('Confirm it’s you with your passkey, then tap Mark paid again.');return;}
    phoneOnly.add(quest.id);lastKey=null;render();
    say('This phone cannot mark money paid. Continue on your computer sends it there.');
  }

  // Line 3 (plan 11.16, F2, N4): a to-do that holds a goal names it. The quest carries the goal's title, not its id; the folded goal row
  // gives the id when its title matches, and the line opens that goal's thread. Otherwise the line is plain text.
  function holdsNode(quest){
    if(!quest.holds)return null;
    const goal=openThread?active.find(q=>q.source?.kind==='goal'&&plainWords(q.title).replace(/^Waiting for you: /,'')===quest.holds):null;
    const label=el('span',{className:'decision-for-label',text:'Holds goal:'});
    if(!goal)return el('p',{className:'quest-for'},[label,document.createTextNode(` ${quest.holds}`)]);
    const link=el('a',{className:'decision-for quest-for',attrs:{href:'#',title:`Open the goal: ${quest.holds}`}},[label,document.createTextNode(' '),el('span',{className:'decision-for-title',text:quest.holds})]);
    link.onclick=event=>{event?.preventDefault?.();openThread({kind:'goal',id:goal.source.id});};
    return link;
  }

  // A Payment's facts (N1): when the approval ends (on a card, line 1 says it), and the vendor's page, one tap away.
  function payNode(quest,{ends=true}={}){
    if(!quest.payment)return null;
    const {url,endsAt}=quest.payment,left=ends?approvalEnds(endsAt):'';
    return el('div',{className:'quest-pay'},[
      ...(left?[el('p',{className:'quest-summary quest-ends',text:left})]:[]),
      ...(webLinkOk(url)?[el('a',{className:'quest-open',text:`Pay on ${siteName(url)} ↗`,attrs:{href:url,target:'_blank',rel:'noopener noreferrer',title:url}})]:[]),
    ]);
  }

  // Line 3 (F2, N8): the request a to-do or a Payment belongs to, a link to its thread, as the decision card shows it (decision-strip.js).
  function forNode(quest){
    const request=quest.request;if(!request?.id)return null;
    return el('a',{className:'decision-for quest-for',attrs:{href:`#thread=${encodeURIComponent(request.id)}`,title:`Open the request: ${request.title}`}},
      [el('span',{className:'decision-for-label',text:'For:'}),document.createTextNode(' '),el('span',{className:'decision-for-title',text:request.title})]);
  }
  // Line 4 (N8): what the cat does once the owner is done, in its own words (`after`, plan 11.9).
  function afterNode(quest,className){
    if(!quest.after)return null;
    return el('p',{className,text:`After you ${quest.connect?'connect it':'mark it done'}: ${quest.after}`});
  }
  // On the right of line 1: when a to-do is due, or when a Payment's approval ends.
  const dueOf=quest=>quest.payment?approvalEnds(quest.payment.endsAt):quest.source?.kind==='owner-step'?dueLabel(quest.due):'';
  // Add to calendar: the .ics file as a download link, built here (N11).
  function calendarLink(quest){
    const ics=quest.source?.kind==='owner-step'?icsOf(quest):'';
    return ics?el('a',{className:'quest-open quest-ics',text:'Add to calendar',attrs:{href:`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`,download:'clowder-to-do.ics'}}):null;
  }
  // The sheet's facts for a to-do or a Payment: due, the goal it holds, its request, what happens next, and Add to calendar.
  function factsNode(quest){
    const due=quest.source?.kind==='owner-step'?dueLabel(quest.due):'';
    const nodes=[due?el('p',{className:'quest-due',text:due}):null,holdsNode(quest),forNode(quest),afterNode(quest,'quest-after'),calendarLink(quest)].filter(Boolean);
    return nodes.length?el('div',{className:'quest-facts'},nodes):null;
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

  // The kind line with its glossary word marked (the meaning on hover), and under the first card of each kind, the meaning in words.
  // A to-do's due date or a Payment's approval end sits on the right of it (plan 11.23).
  function kindNodes(quest){
    const noun=nounOf(quest),step=quest.source?.kind==='owner-step'?kindLabel(quest.stepKind??quest.kind):quest.payment?kindLabel('payment'):'';
    const word=GLOSSARY[noun]?el('span',{className:'glossary-term',text:noun,attrs:{title:`${noun}: ${GLOSSARY[noun]}`}}):document.createTextNode(noun);
    const kind=el('p',{className:'quest-kind'},[word,...(step?[document.createTextNode(` · ${step}`)]:[])]),due=dueOf(quest);
    const line=due?el('div',{className:'quest-head',style:{display:'flex','justify-content':'space-between','align-items':'baseline',gap:'8px'}},[
      kind,el('span',{className:`quest-due${quest.payment?' quest-ends':''}`,text:due,style:{flex:'none','font-size':'12px','font-weight':'600',color:'#6b6657'}}),
    ]):kind;
    return [line,firstTime(noun)?el('p',{className:'glossary-note',text:GLOSSARY[noun]}):null];
  }

  // One card: a badge (✓ when finished, else its noun's glyph), what it is (Decision, To-do · Account, Goal…) with its due date, title,
  // the goal a to-do holds and the request it is for, one summary line, what happens next, extra (the step tally, a Payment's facts,
  // where a Done item was answered), time and one button row. The kind line names a to-do, so its title drops the "To-do:" the server put
  // on it. A compact card (a to-do or Payment on a phone-width screen, N11) keeps the kind line, the title and its buttons; Details has the rest.
  function card(quest,buttons,progress=null,{compact:small=false}={}){
    const title=el('p',{className:'quest-title'},richNodes(plainWords(quest.title).replace(/^To-do: /,'')));
    const time=el('time',{className:'quest-time',text:ago(quest.at)});
    if(quest.at)time.dateTime=quest.at;
    const summary=small?'':summaryOf(plainText(plainWords(quest.detail)));
    const done=quest.rank==='F';
    return el('li',{className:'quest',attrs:{'data-rank':quest.rank,'data-id':quest.id,...(small?{'data-compact':'true'}:{})}},[
      el('span',{className:'rank-badge',text:glyphOf(quest),attrs:{'data-rank':quest.rank,...(done?{role:'img','aria-label':'Done',title:'Done'}:{'aria-hidden':'true'})}}),
      el('div',{className:'quest-main'},(small?[...kindNodes(quest),title]:[
        ...kindNodes(quest),
        title,
        holdsNode(quest),
        forNode(quest),
        summary?el('p',{className:'quest-summary',text:summary}):null,
        afterNode(quest,'quest-summary quest-after'),
        progress,
        quest.handoff&&!onPhone()?el('p',{className:'quest-sent',text:`Sent from your phone ${ago(quest.handoff)}. Finish it here.`}):null,
        time,
      ]).concat(el('div',{className:'quest-buttons'},buttons.filter(Boolean))).filter(Boolean)),
    ]);
  }

  // A decision is the decision strip's own card (decision-strip.js decisionCard), the one the chat shows: answer buttons only where its
  // quick list allows, else Answer opens the full card, and it folds to one line once answered. With no card to hand (an older page, a
  // decision the town no longer lists) a pending one is an ordinary card whose Answer opens the decision, and an answered one is left out.
  function row(quest){
    if(decisionCard&&quest.source?.kind==='approval'){
      const explain=!explained.has('Decision');
      const slot=decisionCard(quest.source.id,{explain,note:[summaryOf(plainText(plainWords(quest.detail))),quest.at?ago(quest.at):''].filter(Boolean).join(' · ')});
      if(slot){if(explain)explained.add('Decision');return el('li',{className:'decision-item',attrs:{'data-rank':quest.rank,'data-id':quest.id}},[slot]);}
      if(quest.answered)return null;
    }
    // A to-do or Payment on a phone-width screen: one main button (Mark done, Connect or Mark paid), the hand-off where the phone cannot
    // finish it, and Details for the rest, so 4 owner actions fit in one sheet (N11: 818 px before, for a 552 px sheet).
    const todo=quest.source?.kind==='owner-step'||!!quest.payment;
    if(todo&&compact())return card(quest,[primaryButton(quest),connectButton(quest),handoffButton(quest),detailsButton(quest)],null,{compact:true});
    return card(quest,[retryButton(quest),primaryButton(quest),connectButton(quest),browserButton(quest),handoffButton(quest),remindButton(quest),removeButton(quest),detailsButton(quest)],progressNode(quest)??payNode(quest,{ends:false}));
  }

  // A band the owner looks at (Needs you, Trouble): a heading over its cards.
  function bandSection(id,rows){
    return el('section',{className:'quest-group',attrs:{'data-band':id,'aria-labelledby':`quest-band-${id}`}},[
      el('h3',{className:'rank-heading',text:BANDS[id],attrs:{id:`quest-band-${id}`}}),
      el('ul',{className:'quest-list'},rows),
    ]);
  }
  // A folded band (the cats' quiet work, what finished recently): one collapsed section, open state remembered in this browser.
  function foldedSection(id,items,key){
    const details=el('details',{className:'quest-handled',attrs:{'data-band':id}},[
      el('summary',{text:`${BANDS[id]} (${items.length})`}),
      el('ul',{className:'quest-list'},items.map(row).filter(Boolean)),
    ]);
    try{details.open=localStorage.getItem(key)==='1';}catch{details.open=false;}
    details.ontoggle=()=>{try{localStorage.setItem(key,details.open?'1':'0');}catch{}};
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
      const ok=await confirmDialog({title:`Remove “${plainWords(quest.title).slice(0,60)}”?`,message:'It leaves the goal list, the Inbox and the Mayor’s banner. The journal keeps the record.',confirmLabel:'Remove goal',cancelLabel:'Keep it',danger:true});
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

  // Finished items are read-only: where the owner answered, the time they finished, and Details for what was decided.
  function doneRow(item){
    const from=answeredFrom(item.device,{phone:onPhone()});
    return card(item,[detailsButton(item,false)],from?el('p',{className:'quest-sent quest-from',text:from}):null);
  }

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
    box.onchange=()=>void tick(quest,i,box.checked,box,item);
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
    // A Payment's amount, filled with the approved amount ("12.00 USD"): the owner corrects it when the vendor charged less.
    const [paid,currency]=String(quest.payment?.amount??'').split(' ');
    const amount=live&&quest.payment?el('label',{className:'quest-amount-label',text:`Amount you paid${currency?`, in ${currency}`:''}`},[
      el('input',{className:'quest-note quest-amount',attrs:{type:'text',inputmode:'decimal',maxlength:'15',value:paid??'',autocomplete:'off'}}),
    ]):null;
    // Remove keeps the left; Remind me tomorrow sits before the main button, which keeps the right, on its own row on a phone.
    const actions=live?[removeButton(quest),remindButton(quest),connectButton(quest),browserButton(quest),handoffButton(quest),primaryButton(quest,()=>note.value),retryButton(quest)].filter(Boolean):[];
    sheet.replaceChildren(
      el('div',{className:'quest-sheet-head'},[back,el('h2',{className:'quest-sheet-title',text:plainWords(humanizeText(quest.title,known)),attrs:{id:'quest-sheet-title'}})]),
      el('div',{className:'quest-sheet-body'},[
        owner&&steps.length?el('div',{className:'quest-sheet-progress'}):null,
        live?factsNode(quest):null,
        question||intro?el('div',{className:'quest-callout'},[...(question?[el('p',{className:'quest-question',text:humanizeText(question,known)})]:[]),...(intro?foldable(intro,'quest-intro-text',100):[])]):null,
        steps.length?el('ol',{className:'quest-stepper',attrs:{'aria-label':'Steps'}},steps.map((text,i)=>stepNode(quest,i,text))):null,
        live&&quest.connect?.token?tokenNode(quest):null,
        live&&quest.connect?el('div',{className:'quest-sheet-connect'}):null,
        live?payNode(quest):null,
        amount,
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
    return emptyState(panel.ownerDocument??document,{icon:'check',text:'Nothing needs you.',action:diary});
  }

  function render(){
    let content;
    explained=new Set();
    if(view==='done'){
      content=done.length
        ?el('ul',{className:'quest-list done-list'},done.map(doneRow))
        :emptyState(panel.ownerDocument??document,{icon:'list-checks',text:'Nothing finished yet.'});
    }else{
      // Needs you is exactly what the count counts (needsYou). The rest splits by the server's band: Trouble, For you's cards, and the
      // folded rest, where a finished item (rank F) has its own fold instead of "Your cats are handling these" (F13).
      const {needs,handled:rest}=splitNeeds(active),quiet=rest.filter(q=>q.band!=='trouble'&&!isForYou(q));
      // Decisions keep the place they were first shown in; one the server no longer lists was answered and comes back folded.
      let listed=needs;
      if(decisionCard){
        for(const q of needs)if(q.source?.kind==='approval')seen.set(q.id,q);
        listed=[...[...seen.values()].map(q=>needs.find(n=>n.id===q.id)??{...q,answered:true}),...needs.filter(q=>q.source?.kind!=='approval')];
      }
      // In the server's order (plan 11.18): money and blocking items first, then by due date, then oldest first. Regrouping by rank here
      // would put an undated goal above a to-do due tomorrow.
      const rows=listed.map(row).filter(Boolean),trouble=rest.filter(q=>q.band==='trouble').map(row).filter(Boolean);
      const handled=quiet.filter(q=>q.rank!=='F'),finished=quiet.filter(q=>q.rank==='F');
      content=el('div',{className:'quest-groups'},[
        rows.length?bandSection('needs',rows):null,
        needs.length?null:emptyNeeds(),
        trouble.length?bandSection('trouble',trouble):null,
        forYou.section(rest.filter(isForYou),{firstTime}),
        handled.length?foldedSection('handled',handled,HANDLED_KEY):null,
        finished.length?foldedSection('finished',finished,FINISHED_KEY):null,
      ].filter(Boolean));
    }
    keepPlace(()=>body.replaceChildren(tabBar(),content));
  }

  // A redraw keeps the keyboard where it was: the same control of the same card (by data-id), else that card's first, else the same tab.
  function keepPlace(paint){
    const was=document.activeElement,inside=!!was&&was!==body&&!!body.contains?.(was);
    const id=inside?was.closest?.('li[data-id]')?.getAttribute('data-id')??null:null;
    const sig=n=>[n.className,n.getAttribute('data-view'),n.getAttribute('data-answer')].join('|'),mark=inside?sig(was):null;
    paint();
    if(!inside||body.contains(document.activeElement))return;
    const scope=id===null?body:[...body.querySelectorAll('li')].find(n=>n.getAttribute('data-id')===id);
    const all=scope?[...scope.querySelectorAll('button, [tabindex]')]:[];
    (all.find(n=>sig(n)===mark)??(id===null?null:all[0]))?.focus({preventScroll:true});
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
      const r=await read('/api/quests');
      if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Request failed');
      active=await r.json();
      if(panel.hidden)seen.clear();
      if(!panel.hidden)artifacts=await loadArtifacts();
      if(!panel.hidden)await forYou.probe();
      if(!panel.hidden)await loadTicks();
      known=new Map([...artifacts.map(a=>[a.id,{title:humanizeText(a.title||'Untitled')}]),...active.filter(q=>q.source?.id).map(q=>[q.source.id,{title:plainWords(humanizeText(q.title))}])]);
      // A device-code sign-in finishes on the server: once its quest closes, the open sheet says so instead of showing a stale code.
      for(const id of [...signins.keys()])if(!active.some(q=>q.id===id)){signins.delete(id);if(sheet.open&&sheetQuest?.id===id){paintSignin();say('Signed in. This to-do is done.');}}
      const count=needsYouCount(active);
      badge.textContent=String(count);badge.hidden=count===0;badge.setAttribute('aria-label',badgeLabel(count));onCount(count);
      if(!panel.hidden&&view==='done'){
        const d=await read('/api/quests/done');
        if(!d.ok)throw new Error((await d.json().catch(()=>({}))).error||'Request failed');
        done=await d.json();
      }
      status.textContent='';status.hidden=true;
      const key=view+JSON.stringify(view==='done'?done:active)+JSON.stringify(known)+JSON.stringify([...ticks])+forYou.key()+Math.floor(Date.now()/60000);
      if(!panel.hidden&&key!==lastKey){lastKey=key;render();}
    }catch(error){
      status.hidden=false;status.textContent=`The Inbox could not load. ${error.message}`;
    }finally{
      busy=false;
      if(again){again=false;void refresh();}
    }
  }

  // #item=<quest id> links (plan 11.20) open one card's Details; app.js opens the Inbox first. A decision opens its own card, as Answer
  // does. False when the list does not hold the item (answered, done or gone).
  async function openItem(id){
    if(!active.some(q=>q.id===id)){lastKey=null;await refresh();}
    const quest=active.find(q=>q.id===id);
    if(!quest)return false;
    if(quest.source?.kind==='approval'){closeSheet();onAction(quest);return true;}
    openSheet(quest,[...body.querySelectorAll('li')].find(n=>n.getAttribute('data-id')===id)?.querySelector('button.quest-more')??null);
    return true;
  }

  return {refresh,openItem};
}

// For you (plan 9.11, D16): the Inbox section under Decisions that holds the owner's Heads-ups and Suggestions, and its settings sheet.
// A card is a quest of kind 'suggestion' from GET /api/quests. Only the owner gets them: a paired viewer gets none and a member a 403, and
// GET /api/for-you answers 403 to both, so neither sees this section. A card's subject was written by someone else (an email subject, an
// event title), so every string here reaches the page through textContent, never as markup.
// Open shows the card in a sheet with a link to its source. Start posts /api/suggestions/:id/start and opens the Request it made (a 409 means
// the card is no longer open). Dismiss asks why (optional), folds the card and waits HOLD_MS behind an Undo toast before it posts the hide
// route with the reason, so an Undo never reaches the server (the decision strip's rule, decision-strip.js). Settings is GET/PUT /api/for-you.
// None of this touches the "needs you" count: a card has needsYou false (src/quests.ts), and the panel counts before it draws this section.
// Styles: for-you.css, layout only; colours and type are the style.css tokens and the Inbox's own .quest classes.
import {el,clip} from './projects-panel.js';
import {ago,GLOSSARY} from './quests-panel.js';
import {forYouNoun,glyphOf} from './plain-words.js';
import {ensureStyles,h,msgNode,ownerDialog,readJson,sendJson,switchControl} from './owner-dialog.js';
import {googleAccounts} from './mail-watch-panel.js';
import {HOLD_MS} from './decision-strip.js';
import {icon} from './icons.js';

export const DENIED='The owner sets up For you.';
export const isForYou=q=>q?.source?.kind==='suggestion';

// What each category is, in the owner's words: its name in Settings, where its cards come from, the card's one line, what the card's
// time means, what Start does and what the category looks for. person: its cards carry a person key (src/for-you-google.ts), so
// "Not about this person" can stop them (src/for-you.ts suppressed). google: it reads the Google account Settings picks. The order is the
// order Settings lists them in.
export const CATEGORIES={
  reply:{name:'Replies waiting',from:'Gmail',google:true,line:'Waiting for your reply.',time:'Last message',start:'Start asks the Mayor to draft a reply. Sending it still asks you.',about:'Mail from people you have written to before that is still waiting for your answer. Promotions and Social are left out.',person:true},
  prep:{name:'Meeting prep',from:'Google Calendar',google:true,line:'A meeting soon. Prep for it?',time:'Starts',start:'Start asks the Mayor to get you ready for the meeting.',about:'Meetings coming up soon with someone else in them, unless you declined.',person:true},
  repeat:{name:'Repeat work',from:'Your requests',line:'Asked for again and again. Make it a routine?',time:'First asked',start:'Start asks the Mayor to draft a routine. A Decision still asks you before it is made.',about:'Requests you keep making, offered as a routine.'},
  quiet:{name:'Quiet goals',from:'Your goals',line:'No news on this goal for a while.',time:'Last news',start:'Start asks the Mayor to look into it.',about:'Active goals with no news for a while. These are Heads-ups.'},
};
export const categoryInfo=category=>CATEGORIES[category]??{name:category||'Other',from:'',line:'',time:'',start:'Start asks the Mayor to take it on.',about:''};

/** A card from its quest. The card id is `<category>:<source>:<source id>` (src/for-you.ts cardId); the quest id is `suggestion:<card id>`. */
export function cardOf(quest){
  const card=String(quest?.source?.id??''),[category='',source='',...rest]=card.split(':');
  return {quest:String(quest?.id??''),card,category,source,sourceId:rest.join(':'),subject:String(quest?.title??''),at:quest?.at??null,noun:forYouNoun(quest)};
}

/** A time before or after now, in the panel's words: "5 h ago", or "in 3 h" for a meeting still to come. */
export function relTime(iso,now=Date.now()){
  const t=iso?Date.parse(iso):NaN;
  if(!Number.isFinite(t))return 'time unknown';
  if(t<=now)return ago(iso,now);
  const minutes=Math.round((t-now)/60000);
  if(minutes<1)return 'now';
  if(minutes<60)return `in ${minutes} min`;
  const hours=Math.round(minutes/60);
  return hours<48?`in ${hours} h`:`in ${Math.round(hours/24)} d`;
}

/** Where a card came from, as a link: a web address ({url}) or a thread in this app ({thread}). Null when there is nothing to open.
 *  Gmail opens the thread in the browser's first signed-in Google account; a Calendar event opens its day (the event's own link needs the
 *  calendar's address, which the card does not keep). */
export function sourceLink(c){
  if(c.source==='gmail'&&c.sourceId)return {url:`https://mail.google.com/mail/#all/${encodeURIComponent(c.sourceId)}`,label:'Open in Gmail ↗'};
  if(c.source==='calendar'){
    const d=new Date(c.at??NaN);
    if(Number.isFinite(d.getTime()))return {url:`https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`,label:'Open the day in Google Calendar ↗'};
  }
  if(c.source==='clowder'&&c.sourceId&&c.category==='repeat')return {thread:{kind:'request',id:c.sourceId},label:'Open the first of those Requests'};
  if(c.source==='clowder'&&c.sourceId&&c.category==='quiet')return {thread:{kind:'goal',id:c.sourceId},label:'Open the goal'};
  return null;
}

// Dismiss's reasons, as the hide route takes them (src/server.ts; src/for-you.ts suppressed): a word, or null for this card only.
export const REASONS=[
  {reason:'category',label:'Less of this kind',said:'Fewer like this.'},
  {reason:'person',label:'Not about this person',said:'No more about this person.'},
  {reason:'topic',label:'Not this topic',said:'No more on this topic.'},
  {reason:null,label:'Just this one',said:''},
];
/** The reasons a card offers: "Not about this person" only where its category keeps a person. */
export const reasonsFor=c=>REASONS.filter(r=>r.reason!=='person'||categoryInfo(c.category).person===true);
/** What a folded card and its Undo toast say. */
export function dismissedLine(subject,reason=null){
  const said=REASONS.find(r=>r.reason===reason)?.said??'';
  return [`Dismissed “${clip(subject,60)}”.`,said].filter(Boolean).join(' ');
}

/** GET /api/for-you's answer, or null when it is not one (an older server, a test double). */
export const validStatus=s=>s&&typeof s==='object'&&!Array.isArray(s)&&typeof s.enabled==='boolean'?s:null;

/** The settings sheet's status line: {tone, text}. */
export function forYouLine(status,now=Date.now()){
  if(!status?.enabled)return status?.error?{tone:'error',text:status.error}:{tone:'off',text:'Off. Nothing is checked for you.'};
  const seconds=Number(status.intervalSeconds);
  if(!(seconds>0))return {tone:'error',text:'On, but town.config.json sets no interval for For you, so nothing is checked.'};
  const last=Number(status.lastPassAt)>0?`last checked ${ago(new Date(Number(status.lastPassAt)).toISOString(),now)}`:'not checked yet';
  const line=`On. Checks every ${Math.max(1,Math.round(seconds/60))} min; ${last}.`;
  return status.error?{tone:'error',text:`${line} ${status.error}`}:{tone:'ok',text:line};
}

const OWNER={'Content-Type':'application/json','X-Town-Action':'owner'};
const errorOf=async r=>(await r.json().catch(()=>({}))).error||'Request failed';

/**
 * The section and its sheets. The Inbox (quests-panel.js) owns the list: say(text) writes its status line, repaint() redraws it at once,
 * refresh() reloads it from the server, firstTime(noun) says whether this drawing has explained that word yet. openThread({kind, id})
 * opens a Request or goal thread; onAction(quest) is the panel's own action, used when there is no thread to open.
 */
export function createForYou({doc=globalThis.document,fetchImpl=(...args)=>fetch(...args),openThread=null,onAction=()=>{},say=()=>{},repaint=()=>{},refresh=async()=>{},now=()=>Date.now(),holdMs=HOLD_MS}={}){
  ensureStyles(doc,'for-you.css','for-you');
  ensureStyles(doc,'decision-strip.css','decision-strip'); // the Undo toast is the decision strip's
  let status=null,denied=false,checkedAt=0,menuFor=null,toast=null,toastFor=null,sheet=null,sheetCard=null,sheetOpener=null,settings=null,settingsOpener=null;
  const held=new Map(),starting=new Set();
  // The controls of the last drawing by name ("<quest id>|start", "heading"), so focus can land on one after a redraw.
  let built=new Map();
  const draw=(focus=null)=>{repaint();if(focus)built.get(focus)?.focus?.({preventScroll:true});};

  /** GET /api/for-you, at most once a minute while the Inbox is open. A 401 or 403 is final for this page: no section, no more asking. */
  async function probe(force=false){
    if(denied||(!force&&checkedAt&&now()-checkedAt<60_000))return;
    checkedAt=now();
    try{
      const r=await readJson(fetchImpl,'/api/for-you');
      if(r.status===401||r.status===403){denied=true;status=null;return;}
      if(r.ok)status=validStatus(r.data);
    }catch{/* keep the last answer */}
  }
  // The section's part of the Inbox's redraw key: a change here redraws the list.
  const key=()=>JSON.stringify([denied,status?.enabled??null]);

  // Sends a held dismissal: time is up, the page is going away (keepalive), or never, after an Undo.
  async function send(id,keepalive=false){
    const hold=held.get(id);
    if(hold?.phase!=='held')return;
    clearTimeout(hold.timer);
    const focused=!!toast?.contains?.(doc.activeElement)||built.get(`${id}|folded`)===doc.activeElement;
    hold.phase='sending';hideToast(id);draw();
    let note='';
    try{
      const r=await fetchImpl(`/api/quests/${encodeURIComponent(id)}/hide`,{method:'POST',keepalive,headers:OWNER,body:JSON.stringify({reason:hold.reason})});
      if(r.status===409){held.delete(id);note='That card is no longer open.';}
      else if(!r.ok)throw new Error(await errorOf(r));
      else hold.phase='sent'; // kept folded until the list no longer has it
    }catch(error){held.delete(id);note=`Could not dismiss it. ${error.message}`;}
    await refresh();
    if(note)say(note);
    if(focused)draw('heading');
  }
  function hold(c,reason){
    if(held.has(c.quest))return;
    menuFor=null;
    held.set(c.quest,{reason,phase:'held',timer:setTimeout(()=>void send(c.quest),holdMs)});
    draw();
    showToast(c.quest,dismissedLine(c.subject,reason));
  }
  // Undo: nothing was sent. The card opens again and focus goes back to its Dismiss.
  function undo(id){
    const hold=held.get(id);
    if(hold?.phase!=='held')return;
    clearTimeout(hold.timer);held.delete(id);hideToast(id,false);
    draw(`${id}|dismiss`);
  }
  // A hidden page cannot show its Undo, and a phone may stop the page there: held dismissals go now, with keepalive, instead of being lost.
  doc.addEventListener?.('visibilitychange',()=>{if(doc.visibilityState==='hidden')for(const [id,h] of held)if(h.phase==='held')void send(id,true);});

  // The Undo toast: the decision strip's, one at a time, for the newest dismissal. Focus moves to Undo, so the keyboard reaches it in time;
  // Escape goes back to the folded card without undoing.
  function showToast(id,line){
    if(!toast){
      const undoButton=el('button',{className:'decision-toast-undo',text:'Undo',attrs:{type:'button','aria-describedby':'for-you-toast-text'}});
      undoButton.onclick=()=>undo(toastFor);
      toast=el('div',{className:'decision-toast for-you-toast'},[el('span',{className:'decision-toast-icon'},[icon('check')]),el('p',{attrs:{id:'for-you-toast-text'}}),undoButton]);
      toast.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();const at=toastFor;hideToast(at,false);built.get(`${at}|undo`)?.focus?.({preventScroll:true});}});
      doc.body.append(toast);
    }
    toastFor=id;
    toast.querySelector('p').textContent=line;
    toast.hidden=false;
    toast.querySelector('button').focus({preventScroll:true});
  }
  function hideToast(id,restore=true){
    if(!toast||toastFor!==id)return;
    const had=!!toast.contains?.(doc.activeElement);
    toast.hidden=true;toastFor=null;
    if(had&&restore)built.get(`${id}|folded`)?.focus?.({preventScroll:true});
  }

  async function start(c){
    if(starting.has(c.quest))return;
    starting.add(c.quest);paintSheet();draw(`${c.quest}|start`);
    let note='',task=null;
    try{
      const r=await fetchImpl(`/api/suggestions/${encodeURIComponent(c.card)}/start`,{method:'POST',headers:OWNER,body:'{}'});
      const data=await r.json().catch(()=>({}));
      if(r.status===409)note='That card is no longer open.';
      else if(!r.ok)throw new Error(data.error||'Request failed');
      else task=typeof data.task==='string'?data.task:null;
    }catch(error){note=`Could not start it. ${error.message}`;}
    starting.delete(c.quest);
    if(note&&sheet?.open&&sheetCard?.quest===c.quest){sheetSay(note);paintSheet();draw();return;}
    leaveSheet();
    await refresh();
    if(note){say(note);return;}
    if(task&&openThread)openThread({kind:'request',id:task});
    else onAction({id:c.quest,source:{kind:'suggestion',id:c.card},action:{label:'Start',panel:'chat',cat:'mayor'}});
  }

  function openMenu(c){menuFor=c.quest;draw(`${c.quest}|reason`);}
  function closeMenu(c){if(menuFor!==c.quest)return;menuFor=null;draw(`${c.quest}|dismiss`);}

  // Why dismiss it: optional. Each reason dismisses at once (behind the Undo); Keep it closes the menu.
  function reasonMenu(c,n){
    const labelId=`for-you-why-label-${n}`;
    const reasons=reasonsFor(c).map((r,i)=>{
      const button=el('button',{className:'quest-remove for-you-reason',text:r.label,attrs:{type:'button','data-answer':r.reason??'none'}});
      button.onclick=()=>hold(c,r.reason);
      if(i===0)built.set(`${c.quest}|reason`,button);
      return button;
    });
    const keep=el('button',{className:'quest-more for-you-keep',text:'Keep it',attrs:{type:'button'}});
    keep.onclick=()=>closeMenu(c);
    const menu=el('div',{className:'for-you-why',attrs:{role:'group','aria-labelledby':labelId,id:`for-you-why-${n}`}},[
      el('p',{className:'for-you-why-label',text:'Why dismiss it? (optional)',attrs:{id:labelId}}),
      el('div',{className:'quest-buttons'},[...reasons,keep]),
    ]);
    menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(c);}});
    return menu;
  }

  function folded(c,n){
    const hold=held.get(c.quest),lineId=`for-you-folded-${n}`;
    const line=el('p',{className:'quest-summary for-you-folded-line',text:hold.phase==='held'?dismissedLine(c.subject,hold.reason):'Dismissing…',attrs:{id:lineId}});
    const undoButton=hold.phase==='held'?el('button',{className:'quest-remove for-you-undo',text:'Undo',attrs:{type:'button','aria-describedby':lineId}}):null;
    if(undoButton){undoButton.onclick=()=>undo(c.quest);built.set(`${c.quest}|undo`,undoButton);}
    const item=el('li',{className:'quest for-you-card for-you-folded',attrs:{'data-rank':'E','data-id':c.quest,tabindex:'-1'}},[
      el('span',{className:'rank-badge',text:glyphOf({source:{kind:'suggestion',id:c.card}}),attrs:{'data-rank':'E','aria-hidden':'true'}}),
      el('div',{className:'quest-main'},[line,...(undoButton?[el('div',{className:'quest-buttons'},[undoButton])]:[])]),
    ]);
    built.set(`${c.quest}|folded`,item);
    return item;
  }

  // One card: what it is (Heads-up or Suggestion · where from), the subject as plain text, one line of ours, the time, and Start, Dismiss, Open.
  function card(quest,n,firstTime){
    const c=cardOf(quest);
    if(held.has(c.quest))return folded(c,n);
    const info=categoryInfo(c.category),titleId=`for-you-title-${n}`,busy=starting.has(c.quest);
    const word=el('span',{className:'glossary-term',text:c.noun,attrs:{title:`${c.noun}: ${GLOSSARY[c.noun]}`}});
    const time=el('time',{className:'quest-time',text:[info.time,relTime(c.at,now())].filter(Boolean).join(' ')});
    if(c.at)time.dateTime=c.at;
    const startButton=el('button',{className:'quest-action quest-primary for-you-start',text:busy?'Starting…':'Start',attrs:{type:'button','aria-describedby':titleId}});
    startButton.disabled=busy;
    startButton.onclick=()=>void start(c);
    const open=menuFor===c.quest;
    const dismiss=el('button',{className:'quest-remove for-you-dismiss',text:'Dismiss',attrs:{type:'button','aria-describedby':titleId,'aria-expanded':String(open),...(open?{'aria-controls':`for-you-why-${n}`}:{})}});
    dismiss.onclick=()=>(open?closeMenu(c):openMenu(c));
    const details=el('button',{className:'quest-more for-you-open',text:'Open',attrs:{type:'button','aria-haspopup':'dialog','aria-describedby':titleId}});
    details.onclick=()=>openSheet(c,details);
    for(const [name,node] of [['start',startButton],['dismiss',dismiss],['open',details]])built.set(`${c.quest}|${name}`,node);
    return el('li',{className:'quest for-you-card',attrs:{'data-rank':'E','data-id':c.quest,'data-category':c.category}},[
      el('span',{className:'rank-badge',text:glyphOf(quest),attrs:{'data-rank':'E','aria-hidden':'true'}}),
      el('div',{className:'quest-main'},[
        el('p',{className:'quest-kind'},[word,...(info.from?[document.createTextNode(` · ${info.from}`)]:[])]),
        firstTime(c.noun)?el('p',{className:'glossary-note',text:GLOSSARY[c.noun]}):null,
        el('p',{className:'quest-title for-you-subject',text:c.subject,attrs:{id:titleId}}),
        info.line?el('p',{className:'quest-summary',text:info.line}):null,
        time,
        el('div',{className:'quest-buttons'},[startButton,dismiss,details]),
        open?reasonMenu(c,n):null,
      ].filter(Boolean)),
    ]);
  }

  /**
   * The For you section over the open cards (quests of kind 'suggestion'), or null where it has nothing to show: a viewer or a member,
   * or an owner whose server has no For you. firstTime(noun) is the Inbox's: only the first card of each noun says what its word means.
   */
  function section(items,{firstTime=()=>false}={}){
    built=new Map();
    const ids=new Set(items.map(q=>q.id));
    for(const [id,h] of held)if(h.phase==='sent'&&!ids.has(id))held.delete(id);
    if(menuFor&&!ids.has(menuFor))menuFor=null;
    if(!items.length&&!status)return null;
    const heading=el('h3',{className:'rank-heading',text:'For you',attrs:{id:'quest-for-you',tabindex:'-1'}});
    built.set('heading',heading);
    const gear=el('button',{className:'quest-more for-you-settings',text:'Settings',attrs:{type:'button','aria-haspopup':'dialog','aria-label':'For you settings'}});
    gear.onclick=()=>void openSettings(gear);
    built.set('settings',gear);
    const empty=status?.enabled===false?'Off. Turn it on in Settings for Heads-ups and Suggestions from your mail, calendar, Requests and goals.':'Nothing for you right now.';
    return el('section',{className:'quest-group for-you',attrs:{'data-rank':'E','aria-labelledby':'quest-for-you'}},[
      el('div',{className:'for-you-head'},[heading,gear]),
      items.length?el('ul',{className:'quest-list'},items.map((q,n)=>card(q,n,firstTime))):el('p',{className:'for-you-empty',text:empty}),
    ]);
  }

  // The card's sheet: the Inbox's Details sheet (the .quest-sheet classes), for one card. Escape and Back close it and focus goes back to Open.
  let sheetMsg=null;
  // Closes the sheet for an action that puts focus somewhere else (a thread, the reason menu), so the close does not pull it back to Open.
  function leaveSheet(){if(!sheet?.open)return;sheetOpener=null;sheet.close();}
  function sheetSay(text){if(sheetMsg){sheetMsg.hidden=false;sheetMsg.textContent=text;}}
  function openSheet(c,opener){
    if(!sheet){
      sheet=el('dialog',{className:'quest-sheet for-you-sheet',attrs:{role:'dialog','aria-labelledby':'for-you-sheet-title'}});
      // A close fires after the call that closed it: an action that moves focus elsewhere clears sheetOpener first (leaveSheet).
      sheet.addEventListener('close',()=>{const back=sheetOpener,id=sheetCard?.quest;sheetOpener=null;sheetCard=null;if(back)(back.isConnected?back:built.get(`${id}|open`)??built.get('heading'))?.focus?.();});
      doc.body.append(sheet);
    }
    sheetCard=c;sheetOpener=opener;
    sheet.style.setProperty('--q','var(--rank-e)');
    paintSheet(true);
    if(!sheet.open)sheet.showModal();
    sheet.querySelector('.quest-sheet-back')?.focus();
  }
  function paintSheet(fresh=false){
    if(!sheet||!sheetCard||(!fresh&&!sheet.open))return;
    const c=sheetCard,info=categoryInfo(c.category),link=sourceLink(c),busy=starting.has(c.quest);
    const back=el('button',{className:'back-pill quest-sheet-back',text:'← Back',attrs:{type:'button'}});
    back.onclick=()=>sheet.close();
    const linkNode=link?.url
      ?el('a',{className:'quest-open',text:link.label,attrs:{href:link.url,target:'_blank',rel:'noopener noreferrer'}})
      :link?.thread?el('button',{className:'quest-open',text:link.label,attrs:{type:'button'}}):null;
    if(link?.thread)linkNode.onclick=()=>{leaveSheet();(openThread??(()=>onAction({id:c.quest,source:{kind:'suggestion',id:c.card},action:{label:'Open',panel:'chat',cat:'mayor'}})))(link.thread);};
    const dismiss=el('button',{className:'quest-remove for-you-dismiss',text:'Dismiss…',attrs:{type:'button'}});
    dismiss.onclick=()=>{leaveSheet();openMenu(c);};
    const startButton=el('button',{className:'quest-primary for-you-start',text:busy?'Starting…':'Start',attrs:{type:'button'}});
    startButton.disabled=busy;
    startButton.onclick=()=>void start(c);
    const keepMsg=!fresh&&sheetMsg&&!sheetMsg.hidden?sheetMsg.textContent:'';
    sheetMsg=el('p',{className:'quest-sheet-msg',attrs:{role:'status'}});
    sheetMsg.hidden=!keepMsg;sheetMsg.textContent=keepMsg;
    const facts=[info.from?`From ${info.from}`:'',[info.time||'Time',relTime(c.at,now())].join(' ')].filter(Boolean).join(' · ');
    sheet.replaceChildren(
      el('div',{className:'quest-sheet-head'},[back,el('h2',{className:'quest-sheet-title',text:c.subject,attrs:{id:'for-you-sheet-title'}})]),
      el('div',{className:'quest-sheet-body'},[
        el('div',{className:'quest-callout'},[
          el('p',{className:'quest-kind'},[el('span',{className:'glossary-term',text:c.noun,attrs:{title:`${c.noun}: ${GLOSSARY[c.noun]}`}}),document.createTextNode(info.name&&CATEGORIES[c.category]?` · ${info.name}`:'')]),
          el('p',{className:'for-you-meaning',text:GLOSSARY[c.noun]}),
          el('p',{className:'for-you-facts',text:facts}),
          info.line?el('p',{className:'for-you-line',text:info.line}):null,
        ].filter(Boolean)),
        el('p',{className:'for-you-start-note',text:info.start}),
        linkNode,
        el('p',{className:'for-you-note',text:'The subject was written by someone else. Clowder shows it as plain text and gives it to the Mayor as quoted text, never as an instruction.'}),
      ].filter(Boolean)),
      el('div',{className:'quest-sheet-foot'},[sheetMsg,dismiss,startButton]),
    );
  }

  // Settings: GET and PUT /api/for-you, in the owner panels' dialog. Each control saves on its own and says so under its section.
  const ui={status:null,accounts:[],loaded:false,msg:null,busy:'',guidance:null};
  async function openSettings(opener){
    settingsOpener=opener;
    if(!settings){
      settings=ownerDialog({doc,id:'for-you-dialog',eyebrow:'FOR YOU',title:'For you',closeLabel:'Close For you settings',
        lede:'Your cats look over your mail, your calendar, your Requests and your goals, and put Heads-ups and Suggestions in the Inbox under Decisions. The checks follow fixed rules: no AI model reads anything unless you turn on triage.',
        onClose:()=>{ui.msg=null;ui.guidance=null;const back=settingsOpener;settingsOpener=null;void probe(true).then(()=>{draw();(back?.isConnected?back:built.get('settings'))?.focus?.();});}});
      settings.dialog.classList?.add('for-you-dialog');
    }
    if(!settings.dialog.open)settings.dialog.showModal();
    ui.loaded=false;paintSettings();
    const [s,c]=await Promise.all([readJson(fetchImpl,'/api/for-you'),readJson(fetchImpl,'/api/connectors')].map(p=>p.catch(error=>({ok:false,status:0,data:{error:error.message}}))));
    const ok=s.ok?validStatus(s.data):null;
    if(ok){ui.status=ok;status=ok;checkedAt=now();}
    else ui.msg={slot:'page',bad:true,text:s.status===401||s.status===403?DENIED:s.data?.error||'For you settings could not load.'};
    ui.accounts=c.ok?googleAccounts(c.data):[];
    ui.loaded=true;paintSettings();
  }
  const say2=slot=>ui.msg?.slot===slot?msgNode(ui.msg,slot):null;
  const button=(text,{className='',key,onclick})=>{const b=h('button',{className,text,attrs:{type:'button','data-key':key}});b.disabled=!!ui.busy;b.onclick=onclick;return b;};
  function paintSettings(){
    if(!settings)return;
    const {body}=settings,focusKey=doc.activeElement?.dataset?.key,s=ui.status;
    if(!s||!ui.loaded){body.replaceChildren(...[ui.loaded?say2('page'):h('p',{className:'cx-empty muted',text:'Loading…',attrs:{role:'status'}})].filter(Boolean));return;}
    const line=forYouLine(s,now());
    const kinds=[...Object.keys(CATEGORIES).filter(k=>Object.hasOwn(s.categories??{},k)),...Object.keys(s.categories??{}).filter(k=>!CATEGORIES[k])];
    const google=kinds.some(k=>categoryInfo(k).google===true);
    const parts=[
      h('div',{className:'op-row-head'},
        h('p',{className:'op-status'},h('span',{className:'cx-dot',attrs:{'data-tone':line.tone,'aria-hidden':'true'}}),h('span',{text:line.text})),
        switchControl({label:'For you',checked:s.enabled,key:'enabled',disabled:!!ui.busy,onChange:on=>void write('enabled',{enabled:on},on?'On. The first check runs within the interval.':'Off. Nothing new is checked. Cards already here stay.')})),
      say2('page'),
      h('section',{className:'cx-section'},h('h4',{text:'What to look for'}),
        kinds.length?h('ul',{className:'op-list for-you-kinds'},...kinds.map(k=>{const info=categoryInfo(k),on=s.categories[k]===true;return h('li',{className:'op-row-head'},
          h('div',{className:'op-field'},h('span',{text:info.name}),info.about?h('small',{text:info.about}):null),
          switchControl({label:info.name,checked:on,key:`kind-${k}`,disabled:!!ui.busy,onChange:v=>void write(`kind-${k}`,{categories:{[k]:v}},v?`${info.name} on.`:`${info.name} off. Its open cards stay as they are.`,'kinds')}));}))
          :h('p',{className:'cx-empty muted',text:'town.config.json lists no For you categories.'}),
        say2('kinds')),
    ];
    if(google){
      let pick=null;
      if(ui.accounts.length){
        pick=h('select',{attrs:{'aria-label':'Google account','data-key':'account'}});
        pick.replaceChildren(...[...(s.account?[]:[Object.assign(doc.createElement('option'),{value:'',textContent:'Pick an account'})]),...ui.accounts.map(a=>Object.assign(doc.createElement('option'),{value:a.id,textContent:a.signedIn?a.name:`${a.name} (not signed in)`}))]);
        pick.value=s.account??'';
        pick.disabled=!!ui.busy;
        pick.onchange=()=>{if(pick.value)void write('account',{account:pick.value},'Saved. The next check reads this account.','account');};
      }
      parts.push(h('section',{className:'cx-section'},h('h4',{text:'Google account'}),
        pick?h('label',{className:'op-field'},h('span',{text:'Mail and calendar from'}),pick,h('small',{text:'Replies waiting and meeting prep read this account: message headers and event times only, never a message body.'}))
          :h('p',{text:'No Google account is connected yet. Replies waiting and meeting prep need one (Connectors & plugins, Google Workspace); Requests and goals need none.'}),
        say2('account')));
    }
    const guidance=h('textarea',{attrs:{rows:'3',maxlength:'2000',spellcheck:'true','aria-label':'Guidance for triage','data-key':'guidance',placeholder:'Skip newsletters. Keep anything from my team.'}});
    guidance.value=ui.guidance??s.guidance??'';
    guidance.oninput=()=>{ui.guidance=guidance.value;};
    parts.push(
      h('section',{className:'cx-section'},h('h4',{text:'Triage (optional)'}),
        h('div',{className:'op-row-head'},h('div',{className:'op-field'},h('span',{text:'Triage with your AI model'}),h('small',{text:'Off by default.'})),
          switchControl({label:'Triage with your AI model',checked:s.triage===true,key:'triage',disabled:!!ui.busy,onChange:on=>void write('triage',{triage:on},on?'Triage on. It spends model tokens, within its caps.':'Triage off. No model reads your cards.','triage')})),
        h('p',{className:'op-hint',text:'Off unless you turn it on. When it is on, each check sends the subject lines of a few new cards, as quoted text, to your default AI model, which drops the ones you would not want. It spends model tokens: within a cap per check and a cap per day (town.config.json), and never past this world’s monthly cap. Usage lists each call.'}),
        h('label',{className:'op-field'},h('span',{text:'Guidance for triage (optional)'}),guidance),
        h('div',{className:'op-actions'},button(ui.busy==='guidance'?'Saving…':'Save guidance',{key:'save-guidance',onclick:()=>void write('guidance',{guidance:ui.guidance??s.guidance??''},'Guidance saved.','triage')})),
        say2('triage')),
      h('section',{className:'cx-section'},h('h4',{text:'Saved reasons'}),
        h('p',{text:'When you dismiss a card with a reason, For you raises fewer like it. Clearing lets those cards come back; the journal keeps the record.'}),
        s.reasonsClearedAt?h('p',{className:'op-hint',text:`Last cleared ${ago(s.reasonsClearedAt,now())}.`}):null,
        h('div',{className:'op-actions'},button(ui.busy==='clear'?'Clearing…':'Clear saved reasons',{key:'clear',onclick:()=>void write('clear',{clearReasons:true},'Cleared. Cards you dismissed with a reason can come back.','reasons')})),
        say2('reasons')),
      h('p',{className:'op-hint',text:'A card’s subject was written by someone else. Start gives it to the Mayor as quoted text, never as an instruction, and sending anything still asks you.'}),
    );
    body.replaceChildren(...parts.filter(Boolean));
    if(focusKey)[...body.querySelectorAll('[data-key]')].find(n=>n.dataset.key===focusKey&&!n.disabled)?.focus();
  }
  async function write(key,patch,done,slot='page'){
    if(ui.busy)return;
    ui.busy=key;ui.msg=null;paintSettings();
    try{ui.status=await sendJson(fetchImpl,'/api/for-you',patch,'PUT');status=ui.status;checkedAt=now();ui.msg={slot,text:done};if(key==='guidance')ui.guidance=null;}
    catch(error){ui.msg={slot,bad:true,text:error.status===401||error.status===403?DENIED:error.message};}
    finally{ui.busy='';}
    paintSettings();
  }

  return {section,probe,key,openSettings,undo,held:()=>new Map(held)};
}

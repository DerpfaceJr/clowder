import {approvalDetail} from './connectors-panel.js';
import {icon} from './icons.js';
import {uiSound} from './ui-sounds.js';
import {ensureStyles} from './owner-dialog.js';
import {GLOSSARY} from './quests-panel.js';
// The decisions waiting on the owner (plan 8.8). One card, decisionCard, is drawn in the strip above the composer, in the Inbox and in the
// thread. It answers inline only where the server's quick list allows (push.ts quickActions, the rule push, Telegram and Discord follow);
// every other decision opens the full card, the dialog, with focus on its first option. A chosen answer folds its card to one line and
// waits HOLD_MS behind an Undo toast in this page. Only then is it posted, so an Undo never reaches the server.
// An answer that cannot reach Clowder waits in an outbox and is sent when Clowder answers again (plan 11.17, F7).
export const isRefusal=text=>/^(reject|decline|deny|no\b)/i.test(text);
export const HOLD_MS=4000;
// The outbox: answers on their way or waiting for Clowder, in localStorage under OUTBOX_KEY as {id: {answer, approved}}, so a reload or a
// closed tab keeps them. A waiting answer is tried again every RETRY_MS while the page does not say Clowder is down.
export const OUTBOX_KEY='clowder.decision-outbox';
export const RETRY_MS=3000;
export const QUEUED='Sends when Clowder answers';
// What engine.ts decide answers for a decision that is no longer pending: a replayed answer that meets it was settled, not refused.
const ANSWERED=/already been answered/i;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kids=list=>list.flat(Infinity).filter(c=>c!==null&&c!==undefined&&c!==false&&c!=='');
const attrs=a=>Object.entries(a??{}).filter(([,v])=>v!==null&&v!==undefined&&v!==false);
/** Draws a card as an escaped string: h returns {html}. For markup built as text (a thread) and for snapshot tests. */
export const HTML={
  h:(tag,a,...children)=>({html:`<${tag}${attrs(a).map(([k,v])=>v===true?` ${k}`:` ${k}="${esc(v)}"`).join('')}>${kids(children).map(c=>typeof c==='string'?esc(c):c.html).join('')}</${tag}>`}),
  icon:name=>({html:`<svg width="20" height="20" focusable="false" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`}),
};
/** Draws a card as nodes, with createElement and text nodes only, so nothing a cat writes can become markup. Icons come from icon(). */
export const domRenderer=(doc=globalThis.document)=>({
  h:(tag,a,...children)=>{const node=doc.createElement(tag);for(const [k,v] of attrs(a))node.setAttribute(k,v===true?'':String(v));node.append(...kids(children).map(c=>typeof c==='string'?doc.createTextNode(c):c));return node;},
  icon:name=>icon(name),
});

// What a folded card says, in the diary's words (app.js decisionLine): who asked and what you said. A plain yes or no is not said twice.
const PLAIN={true:/^(yes|ok|okay|approve|approved|allow|accept)$/i,false:/^(no|deny|decline|declined|reject|rejected)$/i};
export function answeredLine(answer,approved,cat){
  const said=`You said ${approved?'yes':'no'} to ${cat}`,text=String(answer??'').trim().replace(/[.!]$/,'');
  return !text||PLAIN[!!approved].test(text)?said:`${said}: ${text}`;
}
// A held answer's line: the toast and the folded card say first that it waits for Clowder, so a cut line still says so.
const heldLine=(hold,cat)=>`${hold.phase==='queued'?`${QUEUED} · `:''}${answeredLine(hold.answer,hold.approved,cat)}`;
/** The answers a decision takes without its card: publicApproval's quick (push.ts quickActions, plan 8.4). None means the card opens. */
export const quickOf=a=>(Array.isArray(a?.quick)?a.quick:[]).filter(q=>typeof q?.answer==='string'&&q.answer.trim()!=='');
// The strip names the cat before the question, so a question that starts with that name drops it ("wants to use GitHub: push_files").
const stripName=(q,n)=>String(q??'').startsWith(n+' ')?String(q).slice(n.length+1):String(q??'');
const term=(word,r)=>r.h('span',{class:'glossary-term',title:`${word}: ${GLOSSARY[word]}`},word);

// A request's title as Projects shows it (src/projects.ts, oneLiner at 60): its first sentence, markdown marks dropped, cut at a word.
export function requestTitle(text,max=60){
  const sentence=String(text??'').replace(/[*#>`]/g,'').replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g,'').split(/[.!?]+(?=\s|$)|[\r\n]/).map(s=>s.replace(/^[.!?\s]+/,'').replace(/\s+/g,' ').trim()).find(Boolean)||'';
  if(sentence.length<=max)return sentence;
  const cut=sentence.slice(0,max-1),space=cut.lastIndexOf(' ');
  return (space>max*.5?cut.slice(0,space):cut).trimEnd()+'…';
}
/**
 * The request a decision serves (plan 11.6, F2): the root of its task's delegation chain, {id, title}. The title is the goal's when the
 * root is a goal round, else the root's own words. Null when the decision belongs to no request (a usage cap or a budget) or the page
 * does not hold its task. state: {tasks, goals}, as GET /api/state lists them; a pending decision's chain is unfinished, so it is there.
 */
export function requestOf(a,{tasks=[],goals=[]}={}){
  const find=id=>id?tasks.find(t=>t?.id===id):undefined,seen=new Set();
  let t=find(a?.task);if(!t)return null;
  while(t.parent&&!seen.has(t.id)){const up=find(t.parent);if(!up)break;seen.add(t.id);t=up;}
  const title=String((t.goal&&goals.find(g=>g?.id===t.goal)?.title)||'').trim()||requestTitle(t.text);
  return title?{id:String(t.id),title}:null;
}
// "For: <title>" as a link to the request's thread (app.js takeLink opens #thread=). The strip's one-row form says it on the cat's line
// inside its question button instead, where a link cannot go; the full card, one tap away, has the link.
const forLink=(request,r)=>r.h('a',{class:'decision-for',href:`#thread=${encodeURIComponent(request.id)}`,title:`Open the request: ${request.title}`},
  r.h('span',{class:'decision-for-label'},'For:'),' ',r.h('span',{class:'decision-for-title'},request.title));

/**
 * One decision as a card (design rule 5): the one function the strip, the Inbox and the thread draw with.
 * a: the approval as the state lists it. hold: an answer chosen here that the server has not settled ({answer, approved, phase, error},
 * phase held, sending, queued, sent or failed; queued waits for Clowder). compact: the strip's one-row form. explain: says what a Decision is under its label (plan 3.9).
 * surface: keeps ids unique when one decision shows in two places. request: the request it serves, requestOf's {id, title}, shown as
 * "For: <title>" (plan 11.6); null shows none. r: HTML (an escaped string, the default), domRenderer(document), or any {h, icon} pair,
 * such as one built on Preact's h.
 */
export function decisionCard(a,{name=id=>String(id),readOnly=false,compact=false,explain=false,hold=null,note='',surface='card',request=null}={},r=HTML){
  const {h}=r,id=String(a?.id??''),cat=name(a?.cat),settled=a?.status==='approved'||a?.status==='rejected';
  const said=hold&&hold.phase!=='failed'?hold:settled?{answer:a.answer,approved:a.status==='approved'}:null;
  // Answered, here or anywhere: one line in --ink-3. It can take focus, so the keyboard has a place to land when the card folds.
  if(said||a?.status==='cancelled'){
    const line=said?heldLine(said,cat):`${cat}’s decision was cancelled`;
    return h('section',{class:'decision-card is-folded','data-decision':id,'data-state':hold?.phase??a.status},
      h('p',{class:'decision-folded',tabindex:'-1',title:line},r.icon(said?.approved?'check':'x'),h('span',null,line)));
  }
  const qid=`${surface}-decision-${id}`,quick=readOnly?[]:quickOf(a);
  // A yes-or-no pair marks its yes as the main answer; a choice between several plain options weights none of them.
  const yesNo=quick.length>1&&quick.filter(q=>q.approved).length===1;
  const forText=request?.title?`For: ${request.title}`:'';
  const question=h('button',{type:'button',class:'decision-question',id:qid,'data-open':true,'aria-haspopup':'dialog',title:compact?'Read the full question':null},
    compact?h('span',{class:'decision-head'},h('strong',null,cat),forText?[' · ',h('span',{class:'decision-for-inline'},forText)]:null,' '):null,
    h('span',{class:'decision-q'},compact?stripName(a?.question,cat):String(a?.question??'')));
  const actions=readOnly?null:h('div',{class:'decision-actions',role:'group','aria-label':`Answer ${cat}`},
    quick.length?quick.map((q,i)=>h('button',{type:'button',class:`decision-answer${yesNo&&q.approved?' is-primary':''}`,'data-answer':String(i),'aria-describedby':qid},q.answer))
      :h('button',{type:'button',class:'decision-open is-primary','data-open':true,'aria-haspopup':'dialog','aria-describedby':qid},'Answer'));
  const error=hold?.phase==='failed'?h('p',{class:'decision-error',role:'alert'},`Your answer did not go through. ${hold.error??''}`.trim()):null;
  return h('section',{class:`decision-card${compact?' is-compact':''}`,'data-decision':id,'data-state':hold?.phase??'pending'},
    compact?[r.icon('bell'),question,error,actions]
      :[h('p',{class:'decision-who'},r.icon('bell'),h('span',null,term('Decision',r),` · ${cat}`)),
        explain?h('p',{class:'glossary-note'},GLOSSARY.Decision):null,forText?forLink(request,r):null,question,note?h('p',{class:'decision-note'},note):null,error,actions]);
}
/** The card as an escaped HTML string. */
export const decisionCardHtml=(a,options)=>decisionCard(a,options,HTML).html;

// A POST like app.js api, with keepalive, so an answer sent as the page goes away still arrives (api cannot ask for that).
const keepPost=(path,body)=>fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(body),keepalive:true})
  .then(async r=>{const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Request failed');return data;});

export function createDecisionStrip({getState,name,avatar,api,render,keep=keepPost}){
  ensureStyles(document,'decision-strip.css','decision-strip');
  const dom=domRenderer(document);
  // Answers chosen and not yet settled, by decision id: {answer, approved, custom, fromCard, surface, phase, error, timer, trying}.
  const held=new Map();
  // Cards handed to the Inbox (decisionCardFor), redrawn here when their decision changes. A card no longer on the page is let go.
  const handed=new Map();
  let openApprovalId=null,opener=null,openerSurface=null,nextOpener=null,toast=null,toastId=null,toastTimer=null;
  const readOnly=()=>!!getState()?.readOnly;
  const pendingNow=()=>(getState()?.approvals??[]).filter(a=>a.status==='pending');
  const requestFor=a=>requestOf(a,getState()??{});
  const card=(a,extra)=>decisionCard(a,{name,readOnly:readOnly(),hold:held.get(a.id)??null,request:requestFor(a),...extra},dom);
  // The request is in the key, so a card redraws when its request's task or goal title reaches the page after the decision did.
  const keyOf=a=>{const req=requestFor(a);return `${a.id}.${a.status}.${held.get(a.id)?.phase??''}.${held.get(a.id)?.error??''}.${req?.id??''}.${req?.title??''}`;};
  // The outbox in localStorage. Every read and write is in try/catch: with storage off or full it lives in this page only.
  // saved: what it last held, undefined until the first draw reads it.
  let saved;
  const readOutbox=()=>{try{const o=JSON.parse(globalThis.localStorage.getItem(OUTBOX_KEY)??'{}');return o&&typeof o==='object'&&!Array.isArray(o)?o:{};}catch{return {};}};
  function saveOutbox(){
    const out={};for(const [id,h] of held)if(h.phase==='sending'||h.phase==='queued')out[id]={answer:h.answer,approved:h.approved};
    const text=JSON.stringify(out);if(text===saved)return;saved=text;
    try{if(text==='{}')globalThis.localStorage.removeItem(OUTBOX_KEY);else globalThis.localStorage.setItem(OUTBOX_KEY,text);}catch{/* this page keeps it */}
  }
  // Each pending decision is a compact card. A held answer whose decision was settled elsewhere (Telegram, another device) is dropped,
  // and with it its outbox entry: none outlives the decision it answers. The first draw takes back what a closed page left waiting.
  function renderApprovalStrips(pending){
    if(saved===undefined){
      const stored=readOutbox();saved=JSON.stringify(stored);
      for(const [id,o] of Object.entries(stored))if(!held.has(id)&&pending.some(a=>a.id===id)&&typeof o?.answer==='string'&&typeof o?.approved==='boolean')
        held.set(id,{answer:o.answer,approved:o.approved,custom:'',fromCard:false,surface:null,phase:'queued',error:null,timer:setTimeout(()=>void send(id),0)});
    }
    for(const [id,hold] of held)if(hold.phase!=='sending'&&!hold.trying&&!pending.some(a=>a.id===id))drop(id);
    const box=$('approvals'),key=[readOnly()?'viewer':'owner',...pending.map(keyOf)].join(':');
    if(box.dataset.key!==key){box.dataset.key=key;keepFocus(box,()=>box.replaceChildren(...pending.map(a=>card(a,{compact:true,surface:'strip'}))));}
    for(const [slot,o] of handed){
      if(!slot.isConnected){handed.delete(slot);unwatch(slot);continue;}
      const a=getState()?.approvals.find(x=>x.id===o.id);
      if(a&&keyOf(a)+readOnly()!==o.key){o.key=keyOf(a)+readOnly();keepFocus(slot,()=>slot.replaceChildren(card(a,{explain:o.explain,note:o.note,surface:o.surface})));watch(slot);}
    }
    syncStrip();
    saveOutbox();
  }

  // One decision, one card on screen (plan 11.6, F9, N2). A strip card hides while a card handed out for the same decision (the thread's,
  // an Inbox one) shows where it is answered, its answer buttons, at least ON_SCREEN visible; a folded or read-only card is watched by
  // its line or its question. The whole strip hides while the Inbox is open, since the Inbox lists every decision. A strip card that
  // holds focus stays until focus leaves it. Without IntersectionObserver every strip card stays, as before.
  const ON_SCREEN=0.75;
  const watched=new Map(); // handed slot -> {target, on}
  const Watch=globalThis.IntersectionObserver;
  const watcher=typeof Watch==='function'?new Watch(entries=>{
    for(const e of entries)for(const w of watched.values())if(w.target===e.target)w.on=e.isIntersecting&&e.intersectionRatio>=ON_SCREEN;
    syncStrip();
  },{threshold:[0,ON_SCREEN,1]}):null;
  const targetOf=slot=>slot.querySelector('.decision-actions')??slot.querySelector('.decision-question')??slot.querySelector('.decision-folded')??slot;
  // Watches a handed card's answer row; a redraw makes new nodes, so it is called again after each one.
  function watch(slot){
    if(!watcher)return;
    const target=targetOf(slot),was=watched.get(slot);
    if(was?.target===target)return;
    if(was)watcher.unobserve(was.target);
    watched.set(slot,{target,on:false});
    watcher.observe(target);
  }
  function unwatch(slot){const was=watched.get(slot);if(!was)return;watcher?.unobserve(was.target);watched.delete(slot);}
  const shownElsewhere=id=>[...handed].some(([slot,o])=>o.id===id&&watched.get(slot)?.on===true&&slot.isConnected&&!slot.closest('[hidden]'));
  const inboxOpen=()=>{const inbox=$('quests-panel');return !!inbox&&!inbox.hidden;};
  function syncStrip(){
    const box=$('approvals');if(!box)return;
    const focus=document.activeElement,inbox=inboxOpen()&&!box.contains(focus);
    if(box.hidden!==inbox)box.hidden=inbox;
    for(const cardEl of box.querySelectorAll('[data-decision]')){
      const hide=!cardEl.contains(focus)&&shownElsewhere(cardEl.dataset.decision);
      if(cardEl.hidden!==hide)cardEl.hidden=hide;
    }
  }
  // Opening or closing the Inbox (app.js setPanel) only flips its hidden attribute, and focus leaving the strip may free a card to hide.
  const Mutations=globalThis.MutationObserver,inboxPanel=$('quests-panel');
  if(typeof Mutations==='function'&&inboxPanel)new Mutations(syncStrip).observe(inboxPanel,{attributes:true,attributeFilter:['hidden']});
  $('approvals').addEventListener('focusout',()=>queueMicrotask(syncStrip));
  const repaint=()=>renderApprovalStrips(pendingNow());
  // Redraws a box of cards without losing the keyboard: focus goes back to the same control of the same card, else to that card's first
  // answer (a card that opens again after a refusal is ready for another try), else to the first card left.
  const FIRST='button, .decision-folded';
  const firstOf=cardEl=>cardEl.querySelector('.decision-answer')??cardEl.querySelector('.decision-open')??cardEl.querySelector(FIRST);
  const controlOf=el=>el.dataset.answer!==undefined?`[data-answer="${el.dataset.answer}"]`:el.matches('.decision-question')?'.decision-question':el.matches('.decision-open')?'.decision-open':'.decision-folded';
  function keepFocus(box,paint){
    const was=document.activeElement,inside=!!was&&was!==box&&box.contains(was);
    const id=inside?was.closest('[data-decision]')?.dataset.decision:null,control=inside?controlOf(was):null;
    paint();
    if(!inside||box.contains(document.activeElement))return;
    const again=[...box.querySelectorAll('[data-decision]')].find(c=>c.dataset.decision===id);
    ((again&&(again.querySelector(control)??firstOf(again)))??box.querySelector(FIRST))?.focus({preventScroll:true});
  }
  // The card for a decision on the surface the owner used, else on a redrawn Inbox card, else in the strip. A closed panel, or a strip
  // card hidden while its decision shows elsewhere, is skipped: focus cannot land in it.
  function cardOn(id,surface){
    for(const root of [surface,...handed.keys(),$('approvals')]){
      if(!root?.isConnected||root.closest('[hidden]'))continue;
      const found=[...root.querySelectorAll('[data-decision]')].find(c=>c.dataset.decision===id&&!c.hidden);
      if(found)return found;
    }
    return null;
  }

  // One listener per box of cards (the strip, each Inbox card): an answer button holds that answer, Answer or the question opens the card.
  function onCardClick(event){
    const button=event.target?.closest?.('button'),cardEl=button?.closest('[data-decision]');
    if(!cardEl||button.disabled)return;
    const id=cardEl.dataset.decision;
    if(button.hasAttribute('data-open')){nextOpener={button,surface:event.currentTarget};openApprovalSheet(id);return;}
    const q=quickOf(pendingNow().find(a=>a.id===id))[Number(button.dataset.answer)];
    if(q&&!readOnly())choose(id,q.answer,q.approved,{surface:event.currentTarget});
  }
  $('approvals').addEventListener('click',onCardClick);

  // Holds an answer for HOLD_MS: the card folds at once and the toast offers Undo. A second tap on a folded card does nothing.
  function choose(id,answer,approved,{surface=null,custom='',fromCard=false}={}){
    const a=pendingNow().find(x=>x.id===id);
    if(!a||(held.has(id)&&held.get(id).phase!=='failed'))return;
    if(openApprovalId===id)closeApprovalSheet();
    held.set(id,{answer,approved,custom,fromCard,surface,phase:'held',error:null,timer:setTimeout(()=>void send(id),HOLD_MS)});
    repaint();
    showToast(id,answeredLine(answer,approved,name(a.cat)),approved);
  }
  // app.js paints the header's connection line down or closed while Clowder is not answering (plan 10.10, 11.5).
  const unanswered=()=>/^(down|closed)$/.test($('connection')?.dataset.state??'');
  // Time is up: the answer goes to the server, written to the outbox first. Accepted, it sounds success and the card stays folded until the
  // town lists the decision as answered. Refused, it sounds an error and the card opens again with the reason, ready for another answer.
  // Not reached (fetch throws a TypeError), it waits in the outbox: the Undo hold comes back once, saying it sends when Clowder answers,
  // and then the folded card keeps saying so; the toast leaves after HOLD_MS, as every hold's does, so it never sits over the composer
  // while a host sleeps. It is tried again every RETRY_MS. A try again that hears the decision was already answered counts as sent: an
  // earlier try got there.
  async function send(id,post=api){
    const hold=held.get(id),replay=hold?.phase==='queued',a=pendingNow().find(x=>x.id===id);
    if(!hold||hold.trying||!(replay||hold.phase==='held'))return;
    clearTimeout(hold.timer);
    if(!a){drop(id);repaint();return;}
    if(replay&&unanswered()){hold.timer=setTimeout(()=>void send(id),RETRY_MS);return;}
    const back=!!toast&&toastId===id&&toast.contains(document.activeElement);
    if(!replay){hideToast(id);hold.phase='sending';repaint();}
    hold.trying=true;
    let phase='sent';
    try{await post('approvals/'+id,{answer:hold.answer,approved:hold.approved});}
    catch(error){phase=error instanceof TypeError?'queued':replay&&ANSWERED.test(error?.message??'')?'sent':'failed';if(phase==='failed')hold.error=error?.message||String(error);}
    hold.trying=false;
    if(held.get(id)!==hold)return;
    if(phase==='queued'){
      hold.phase='queued';hold.timer=setTimeout(()=>void send(id),RETRY_MS);
      if(!replay){repaint();showToast(id,heldLine(hold,name(a.cat)),hold.approved,back);toastTimer=setTimeout(()=>hideToast(id),HOLD_MS);}
      return;
    }
    hideToast(id);hold.phase=phase;
    if(phase==='sent'){uiSound('success');render();}else uiSound('error');
    repaint();
  }
  // Forgets an answer: its timer stops and its toast goes.
  function drop(id){const hold=held.get(id);if(!hold)return;clearTimeout(hold.timer);held.delete(id);hideToast(id);}
  // Undo: nothing was sent, or nothing got there yet. The card opens again where it was, or the full card opens again if the answer came
  // from it, own words kept.
  function undo(){
    const id=toastId,hold=held.get(id);if(hold?.phase!=='held'&&hold?.phase!=='queued')return;
    clearTimeout(hold.timer);held.delete(id);hideToast(id,false);repaint();
    if(hold.fromCard){
      nextOpener={button:null,surface:hold.surface};
      if(openApprovalSheet(id)){if(hold.custom){$('approval-custom').value=hold.custom;$('approval-send').disabled=false;$('approval-custom').focus();}return;}
    }
    const back=cardOn(id,hold.surface);if(back)firstOf(back)?.focus({preventScroll:true});
  }

  // The Undo toast: one at a time, for the newest held answer. Focus moves to Undo, so the keyboard can reach it inside HOLD_MS;
  // Escape goes back to the folded card without undoing. It is not a dialog, so it makes no open or close sound. focus false: shown again
  // for an answer that waits for Clowder, it does not take focus from where the owner is now.
  function showToast(id,line,approved,focus=true){
    clearTimeout(toastTimer);
    if(!toast){
      toast=dom.h('div',{class:'decision-toast',hidden:true},dom.h('span',{class:'decision-toast-icon'}),dom.h('p',{id:'decision-toast-text'}),
        dom.h('button',{type:'button',class:'decision-toast-undo','aria-describedby':'decision-toast-text'},'Undo'));
      toast.querySelector('.decision-toast-undo').addEventListener('click',undo);
      // stopPropagation: app.js closes the open sheet on Escape, and this Escape only leaves the toast.
      toast.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();toFolded(toastId);}});
      document.body.append(toast);
    }
    toastId=id;
    toast.querySelector('.decision-toast-icon').replaceChildren(icon(approved?'check':'x'));
    toast.querySelector('p').textContent=line;
    toast.hidden=false;
    if(!focus)return;
    const button=toast.querySelector('.decision-toast-undo');
    if(document.activeElement===button)button.blur();
    button.focus({preventScroll:true});
  }
  function hideToast(id,restore=true){
    if(!toast||toastId!==id)return;
    const had=toast.contains(document.activeElement);
    clearTimeout(toastTimer);toast.hidden=true;toastId=null;
    if(had&&restore)toFolded(id);
  }
  // From the toast back to the folded card it speaks for, else to the strip.
  function toFolded(id){(cardOn(id,held.get(id)?.surface)?.querySelector('.decision-folded')??$('approvals').querySelector(FIRST))?.focus({preventScroll:true});}

  /** A card for the Inbox or a chat thread (surface keeps its ids unique), kept current here: it folds while its answer is held and opens again on Undo. Null when the town no longer lists the decision. */
  function decisionCardFor(id,{explain=false,note='',surface='inbox'}={}){
    const a=getState()?.approvals.find(x=>x.id===id);if(!a)return null;
    const slot=document.createElement('div');slot.className='decision-slot';
    slot.replaceChildren(card(a,{explain,note,surface}));
    slot.addEventListener('click',onCardClick);
    handed.set(slot,{id,explain,note,surface,key:keyOf(a)+readOnly()});
    watch(slot);
    return slot;
  }

  // True when the decision is still pending and its full card is now open. Focus starts on the first option (autofocus), not on Close.
  function openApprovalSheet(id){
    const a=getState()?.approvals.find(x=>x.id===id&&x.status==='pending');
    if(!a)return false;
    openApprovalId=id;({button:opener=null,surface:openerSurface=null}=nextOpener??{});nextOpener=null;
    const cat=getState().cats.find(c=>c.id===a.cat);
    $('approval-avatar').innerHTML=cat?avatar(cat):'';
    // The eyebrow says NEEDS YOUR DECISION; the title says the glossary word in plain words (plan 3.9).
    $('approval-title').textContent=`${name(a.cat)} asks you to decide`;
    // The request it serves, as on every card (plan 11.6): a notification's #approval= link opens this card first. Following the link
    // closes the card, so the thread it opens is not under the dialog.
    $('approval-for')?.remove();
    const request=requestFor(a);
    if(request){const link=forLink(request,dom);link.id='approval-for';link.addEventListener('click',closeApprovalSheet);$('approval-question').before(link);}
    $('approval-question').textContent=a.question;
    const detail=approvalDetail(a);
    $('approval-hint').textContent=a.options?.some(o=>o.startsWith('Always allow'))?'Always allow stops asking: (this cat) for this cat only, (every cat) for all of them. Set it back to Ask in Connectors & plugins.':'Applies to this request only.';$('approval-detail').hidden=!detail;$('approval-detail-text').textContent=detail;$('approval-detail').open=matchMedia('(min-width:600px)').matches;
    const options=a.options??[];
    $('approval-options').replaceChildren(...options.map((option,i)=>{const b=document.createElement('button');b.type='button';b.className='approval-option';b.textContent=option;b.autofocus=i===0;b.onclick=()=>choose(id,option,!isRefusal(option),{fromCard:true,surface:openerSurface});return b;}));
    $('approval-custom').value='';$('approval-send').disabled=true;$('approval-error').textContent='';$('approval-custom').autofocus=!options.length;
    const first=$('approval-options').querySelector('button')??$('approval-custom');
    $('approval-dialog').open?first.focus():$('approval-dialog').showModal();
    return true;
  }
  function closeApprovalSheet(){openApprovalId=null;const d=$('approval-dialog');if(d.open)d.close();}
  // Escape, Close or Back puts focus back on what opened the card, or on that decision's card if it was redrawn (chat-ux §6).
  $('approval-dialog').addEventListener('close',()=>{
    const id=openApprovalId,back=opener;openApprovalId=opener=null;
    if(!id)return;
    if(back?.isConnected){back.focus({preventScroll:true});return;}
    const cardEl=cardOn(id,openerSurface);
    (cardEl?.querySelector(back?controlOf(back):'.decision-open')??cardEl?.querySelector('[data-open]'))?.focus({preventScroll:true});
  });
  $('approval-custom').oninput=()=>{$('approval-send').disabled=!$('approval-custom').value.trim();};
  $('approval-send').onclick=()=>{const text=$('approval-custom').value.trim();if(openApprovalId&&text)choose(openApprovalId,text,!isRefusal(text),{fromCard:true,custom:text,surface:openerSurface});};
  $('approval-decline').onclick=()=>{if(openApprovalId)choose(openApprovalId,'Rejected',false,{fromCard:true,surface:openerSurface});};
  // A hidden page cannot show its Undo, and a phone may stop the page there or the tab may be closing: held answers go now, with
  // keepalive, instead of being lost.
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')for(const [id,hold] of held)if(hold.phase==='held')void send(id,keep);});
  return {renderApprovalStrips,openApprovalSheet,closeApprovalSheet,openId:()=>openApprovalId,decisionCardFor,undo};
}

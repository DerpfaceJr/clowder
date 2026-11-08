import {chatMessages} from './state-delta.js';
import {asideClass,asideLabel,inboxNote} from './ask-mayor.js';
import {goalRound,roundStarted} from './town-events.js';
import {chatHtml} from './quests-panel.js';
import {demoReply,DEMO_REPLY_NOTE} from './demo-state.js';
import {artifactParts,artifactNodes} from './gallery-view.js';
import {distanceFromBottom} from './scroll-latest.js';
// The Mayor's thread: message rows, the follow-the-newest rule and the Earlier button. app.js hands it the page and state on each render.
export function createChatThread({chat,escape,name,time,openArchiveOn}){
  let following=true,shownCat=null,markup=null;
  chat.addEventListener('scroll',()=>{if(chat.clientHeight)following=distanceFromBottom(chat)<70;},{passive:true});
  // The thread opens at the newest message (on open, cat switch, tab switch and own send). New replies follow only while the reader is already at the bottom.
  function pin(){chat.scrollTop=chat.scrollHeight;following=true;}
  function paint({page,state,selected}){
    const messages=chatMessages(page?.messages,state.messages,selected);
    const switched=shownCat!==selected;shownCat=selected;
    const taskById=new Map(state.tasks.map(t=>[t.id,t]));
  const html=(page?.more?'<button type="button" class="chat-earlier" data-earlier>Earlier messages</button>':'')+(messages.map(m=>{const round=goalRound(m);if(round)return `<p class="chat-event">${escape(roundStarted(round))}&nbsp;·&nbsp;<time>${time(m.at)}</time></p>`;const task=taskById.get(m.task),note=inboxNote(task),cancel=task?.status==='queued'&&!state.readOnly;const demo=demoReply(m);return `<article class="chat-message ${escape(m.from)}${asideClass(m)}"><div class="sender"><span>${asideLabel(m)}${escape(name(m.from))}${m.from!=='owner'&&m.to!=='owner'?` → ${escape(name(m.to))}`:''}</span><time>${time(m.at)}</time></div>${demo===null?'':`<p class="demo-warning demo-reply-note">${DEMO_REPLY_NOTE}</p>`}<div class="text">${chatHtml(demo??m.text)}</div>${note?`<p class="inbox-note">${escape(note)}${cancel?` <button type="button" class="inbox-cancel" data-cancel="${escape(task.id)}">Cancel</button>`:''}</p>`:''}</article>`;}).join('')||`<div class="empty"><span class="big">ฅ</span><p>A little idea can become<br>something worth working on.</p><button id="try-demo">Try a delegation</button></div>`);
  // Artifact ids in message text become links after the escaped markup is in; markup stands in for comparing innerHTML.
  if(markup!==html||!chat.firstChild){markup=html;chat.innerHTML=html;for(const t of chat.querySelectorAll('.chat-message .text'))if(artifactParts(t.textContent).some(p=>p.id))t.replaceChildren(...artifactNodes(t.textContent,openArchiveOn));}
    if(switched||following)pin();
  }
  return {paint,pin,setFollow:value=>{following=value;},forget:()=>{markup=null;}};
}

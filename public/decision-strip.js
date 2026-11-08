import {approvalDetail} from './connectors-panel.js';
import {confirmDialog} from './dialogs.js';
// The decisions waiting on the owner: one-line strips above the composer, and the answer dialog that opens from them.
export const isRefusal=text=>/^(reject|decline|deny|no\b)/i.test(text);
const $=id=>document.getElementById(id);
export function createDecisionStrip({getState,escape,name,avatar,api,render}){
// The strip already names the cat, so a question that starts with its name drops it ("wants to use GitHub: push_files").
const stripName=(q,n)=>String(q).startsWith(n+' ')?String(q).slice(n.length+1):String(q);
// Each pending request is a one-line strip. Its text or Answer opens the full sheet; Decline asks first.
function renderApprovalStrips(pending){
  const box=$('approvals'),key=[getState().readOnly?'viewer':'owner',...pending.map(a=>a.id)].join(':');
  if(box.dataset.key===key)return;
  box.dataset.key=key;
  box.innerHTML=pending.map(a=>`<section class="approval" data-id="${escape(a.id)}"><button type="button" class="approval-open" aria-haspopup="dialog" title="Read the full question"><strong>${escape(name(a.cat))}</strong><span>${escape(stripName(a.question,name(a.cat)))}</span></button>${getState().readOnly?'':'<div class="approval-quick"><button type="button" data-quick="answer">Answer</button><button type="button" data-quick="decline">Decline</button></div>'}</section>`).join('');
}
let openApprovalId=null;
// True when the decision is still pending and its dialog is now open.
function openApprovalSheet(id){
  const a=getState()?.approvals.find(x=>x.id===id&&x.status==='pending');
  if(!a)return false;
  openApprovalId=id;
  const cat=getState().cats.find(c=>c.id===a.cat);
  $('approval-avatar').innerHTML=cat?avatar(cat):'';
  $('approval-title').textContent=`${name(a.cat)} needs you`;
  $('approval-question').textContent=a.question;
  const detail=approvalDetail(a);
  $('approval-hint').textContent=a.options?.some(o=>o.startsWith('Always allow'))?'Always allow stops asking: (this cat) for this cat only, (every cat) for all of them. Set it back to Ask in Connectors & plugins.':'Applies to this request only.';$('approval-detail').hidden=!detail;$('approval-detail-text').textContent=detail;$('approval-detail').open=matchMedia('(min-width:600px)').matches;
  $('approval-options').replaceChildren(...(a.options??[]).map(option=>{const b=document.createElement('button');b.type='button';b.className='approval-option';b.textContent=option;b.onclick=()=>answerApproval(id,option,!isRefusal(option));return b;}));
  $('approval-custom').value='';$('approval-send').disabled=true;$('approval-error').textContent='';
  if(!$('approval-dialog').open)$('approval-dialog').showModal();
  return true;
}
function closeApprovalSheet(){openApprovalId=null;const d=$('approval-dialog');if(d.open)d.close();}
async function answerApproval(id,answer,approved){
  const buttons=[...$('approval-dialog').querySelectorAll('button'),...$('approvals').querySelectorAll('button')];
  buttons.forEach(b=>b.disabled=true);
  try{await api('approvals/'+id,{answer,approved});closeApprovalSheet();render();}
  catch(error){$('approval-error').textContent=error.message;notify(error);buttons.forEach(b=>b.disabled=false);}
}
async function declineApproval(id){
  const a=getState()?.approvals.find(x=>x.id===id&&x.status==='pending');if(!a)return;
  // A one-tap decline is easy to hit by mistake on a phone, so it asks first.
  const ok=await confirmDialog({title:`Decline ${name(a.cat)}’s request?`,message:'The cat will be told no.',confirmLabel:'Decline',cancelLabel:'Keep it open',danger:true});
  if(ok)await answerApproval(id,'Rejected',false);
}
$('approvals').addEventListener('click',e=>{
  const card=e.target.closest('.approval');if(!card)return;
  if(e.target.closest('[data-quick="decline"]'))void declineApproval(card.dataset.id);
  else openApprovalSheet(card.dataset.id);
});
$('approval-dialog').addEventListener('close',()=>{openApprovalId=null;});
$('approval-custom').oninput=()=>{$('approval-send').disabled=!$('approval-custom').value.trim();};
$('approval-send').onclick=()=>{const text=$('approval-custom').value.trim();if(openApprovalId&&text)answerApproval(openApprovalId,text,!isRefusal(text));};
$('approval-decline').onclick=()=>{if(openApprovalId)answerApproval(openApprovalId,'Rejected',false);};
  return {renderApprovalStrips,openApprovalSheet,closeApprovalSheet,openId:()=>openApprovalId};
}

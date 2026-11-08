// The "ask about progress" side channel in the chat composer. The helpers are pure (no DOM at import), so the tests can load them.
const LIVE=['running','waiting','waiting_child'];

/** A cat is busy while it has live work, or the Mayor has an active goal (between rounds too). */
export function catIsBusy(state,catId){
  if(!state)return false;
  if((state.tasks??[]).some(t=>t.cat===catId&&LIVE.includes(t.status)))return true;
  return catId==='mayor'&&(state.goals??[]).some(g=>g.status==='active');
}

/** The toggle is offered only for a busy cat, and never in view-only mode. */
export function askToggleShown(state,catId,readOnly){
  return !readOnly&&catIsBusy(state,catId);
}

export const asideClass=m=>(m.aside?' aside':'');
export const asideLabel=m=>(m.aside?'<em class="aside-label">Q&amp;A</em>':'');

/** Adds the toggle to the composer's Options popover (or above the text box without one), on by default and hidden until the cat is busy. */
export function mountAskToggle(form,onChange){
  const label=document.createElement('label');
  label.id='ask-toggle';label.className='ask-toggle';label.hidden=true;label.dataset.short='Ask';
  const box=document.createElement('input');box.type='checkbox';box.id='ask-mode';box.checked=true;
  // The placeholder names the mode, so the caller repaints the composer as soon as the box flips.
  box.addEventListener('change',()=>onChange?.());
  const text=document.createElement('span');text.textContent='Ask about progress — won’t interrupt';
  label.append(box,' ',text);
  const options=form.querySelector('.composer-options');
  if(options)options.append(label);else form.insertBefore(label,form.querySelector('label.sr-only'));
  return {label,box};
}

/** True when the next send is a question. The toggle starts on for the other cats and off for the Mayor, whose busy messages queue in its inbox. */
export function syncAskToggle(toggle,state,catId){
  const shown=askToggleShown(state,catId,state?.readOnly);
  toggle.label.hidden=!shown;
  if(!shown||toggle.catId!==catId){toggle.box.checked=catId!=='mayor';toggle.catId=catId;}
  return shown&&toggle.box.checked;
}

/** Owner messages the Mayor has not picked up yet. The Mayor's header and the world label show this count. */
export const inboxCount=state=>(state?.tasks??[]).filter(t=>t.status==='queued').length;
/** The note under a message waiting in the Mayor's inbox, or '' for any other message. */
export const inboxNote=task=>{
  if(!task?.inbox)return '';
  if(task.status==='queued')return 'Queued · the Mayor will pick this up next';
  return task.status==='cancelled'?'Cancelled before the Mayor picked it up':'';
};

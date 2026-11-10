import {initPeople} from './people-panel.js';
import {copyBox, h, readJson, sendJson} from './owner-dialog.js';
import {confirmDialog} from './dialogs.js';

// The line under a paired device in Devices: whether the app has fetched the relay details, so it finds the town after a restart.
export const followText=device=>device.followAt?'Reconnects after restarts':'Not set up to reconnect yet: open Clowder on that phone once';

// Owner MCP tokens (plan 11.28, src/owner-tokens.ts): a section in Devices. Make token shows the new token once, with the command that adds it
// to Claude Code; reopening Devices clears it, and the server keeps only a hash. Revoke stops a token at once. The routes answer the host (or a
// stepped-up owner phone); everything is drawn with textContent, so a token's name cannot become markup.
const day=(v,locale)=>new Date(v).toLocaleDateString(locale,{day:'numeric',month:'short'});
/** A token's line under its name: when it was made and last used. */
export const tokenLine=(t,locale)=>`Made ${day(t.createdAt,locale)} · ${t.lastUsedAt?`last used ${day(t.lastUsedAt,locale)}`:'never used'}`;
/** The Claude Code command that adds this town's MCP endpoint with a token. */
export const mcpCommand=(origin,token)=>`claude mcp add --transport http clowder ${origin}/mcp --header "Authorization: Bearer ${token}"`;

export function createOwnerTokens({doc=document,win=globalThis.window,fetchImpl=(...a)=>fetch(...a),ask=confirmDialog,locale}={}){
  const ui={tokens:[],fresh:null,msg:null,busy:false};
  const list=h('div',{className:'owner-tokens-list'}),out=h('div',{attrs:{'aria-live':'polite'}});
  const name=h('input',{attrs:{type:'text',maxlength:'40',autocomplete:'off',spellcheck:'false',placeholder:'Such as Claude Code','aria-label':'Token name'}});
  const make=h('button',{text:'Make token',attrs:{type:'submit'}});
  const form=h('form',{attrs:{novalidate:''}},h('label',{},'Name',name),make);
  const section=h('section',{className:'owner-tokens',attrs:{'aria-labelledby':'owner-tokens-title'}},
    h('h3',{text:'MCP tokens',attrs:{id:'owner-tokens-title'}}),
    h('p',{text:'A token lets an MCP client on this computer, such as Claude Code, see Needs you, answer simple decisions, mark to-dos done and send the Mayor requests. Public, money and delete decisions still open their card here. A token works on this computer only.'}),
    list,form,out);
  section.hidden=true;

  function paint(){
    list.replaceChildren(...ui.tokens.map(t=>{
      const revoke=h('button',{text:'Revoke',attrs:{type:'button','aria-label':`Revoke ${t.name}`}});revoke.disabled=ui.busy;revoke.onclick=()=>void remove(t);
      return h('div',{style:{display:'flex','justify-content':'space-between','align-items':'center',gap:'12px',padding:'10px 0','border-bottom':'1px solid var(--line)'}},
        h('span',{style:{'min-width':'0','overflow-wrap':'anywhere'}},t.name,h('small',{text:tokenLine(t,locale),style:{display:'block',color:'var(--muted)','margin-top':'4px'}})),revoke);
    }));
    if(!ui.tokens.length)list.replaceChildren(h('p',{text:'No tokens yet.'}));
    make.disabled=ui.busy;
    out.replaceChildren(...[
      ui.fresh?h('div',{className:'owner-token-fresh'},
        h('p',{text:`Copy “${ui.fresh.name}” now: Clowder shows it once.`}),copyBox(win,`Token ${ui.fresh.name}`,ui.fresh.token),
        h('p',{text:'Or add it to Claude Code with this command:'}),copyBox(win,'Claude Code command',mcpCommand(win?.location?.origin??'',ui.fresh.token))):null,
      ui.msg?h('p',{text:ui.msg,attrs:{role:'status'}}):null].filter(Boolean));
  }
  async function refresh(){
    const r=await readJson(fetchImpl,'/api/owner-tokens').catch(()=>({ok:false}));
    section.hidden=!r.ok;if(r.ok)ui.tokens=Array.isArray(r.data.tokens)?r.data.tokens:[];
    paint();
  }
  async function act(work){
    if(ui.busy)return;ui.busy=true;ui.msg=null;paint();
    try{await work();}catch(error){ui.msg=error.status===403?'Make and revoke tokens on the host computer.':error.message;}
    finally{ui.busy=false;}
    await refresh();
  }
  form.onsubmit=event=>{
    event?.preventDefault?.();
    const n=name.value.trim();if(!n){ui.msg='Name the token first.';paint();return;}
    void act(async()=>{ui.fresh=await sendJson(fetchImpl,'/api/owner-tokens',{name:n});name.value='';});
  };
  async function remove(t){
    if(!await ask({title:`Revoke ${t.name}?`,message:'Anything using it stops working at once.',confirmLabel:'Revoke',cancelLabel:'Keep it',danger:true}))return;
    await act(async()=>{await sendJson(fetchImpl,`/api/owner-tokens/${encodeURIComponent(t.id)}/revoke`);if(ui.fresh?.id===t.id)ui.fresh=null;ui.msg=`Revoked ${t.name}.`;});
  }
  // Each opening of Devices starts clean: a token made earlier is never shown again.
  const open=()=>{ui.fresh=null;ui.msg=null;return refresh();};
  return {section,open,refresh};
}

/** Puts the section in Devices, after Sign out other browsers, and refreshes it each time Devices opens. */
export function initOwnerTokens(options={}){
  const doc=options.doc??document,anchor=doc.getElementById('owner-key');
  if(!anchor)return null;
  const panel=createOwnerTokens(options);anchor.after(panel.section);
  doc.getElementById('share')?.addEventListener('click',()=>void panel.open());
  return panel;
}

// The entry point for People and a member's own view (plan 10.11, people-panel.js): app.js loads this module, and module scripts run once the
// page is parsed, so ☰ > Devices & AI and the dock are there. In Node (the tests) there is no page and nothing starts.
if(globalThis.document?.getElementById?.('settings-devices'))initPeople();
if(globalThis.document?.getElementById?.('owner-key'))initOwnerTokens();

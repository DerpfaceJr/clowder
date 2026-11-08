// Connectors and plugins: the owner's panel, opened from ☰ > Devices & AI. Connectors are MCP servers; plugins are Claude Code
// plugin folders. The panel talks only to the routes in docs/connectors-spec.md. The pure helpers are exported for Node tests and
// the module touches no DOM at import. Server text is written with textContent only. Each control has a data-key (its busy and
// focus key) and each message sits in a data-slot named after the request that made it, so an error shows by its control.
import {el} from './projects-panel.js';

export const SIGN_IN_POLL_MS=2000,SIGN_IN_WINDOW_MS=180_000,APPROVAL_DETAIL_MAX=600;
export const SOURCE_LABEL={custom:'Custom',directory:'Directory',plugin:'Plugin','claude-code':'Claude Code'};
export const AUTH_NOTE={oauth:'Sign in',token:'Needs a token',none:'No sign-in'};
export const PERMISSIONS=[['allow','Allow'],['ask','Ask first'],['off','Off']];
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const list=value=>Array.isArray(value)?value:[];
const enc=encodeURIComponent;

// The dot's tone and the plain label. A disabled connector reads Off whatever the server last reported.
export function statusLabel(c){
  const status=c?.enabled===false?'off':c?.status;
  // A sign-in past its expiry with no way to renew reads Expired even while the old session still answers.
  if(status!=='off'&&c?.auth==='expired')return {tone:'warn',label:'Expired: Sign in again'};
  if(status==='connected')return {tone:'ok',label:`Connected · ${plural(list(c.tools).length,'tool')}`};
  if(status==='connecting')return {tone:'warn',label:'Connecting…'};
  if(status==='needs-auth')return {tone:'warn',label:'Needs sign-in'};
  if(status==='needs-setup')return {tone:'warn',label:'Needs setup'};
  if(status==='error')return {tone:'error',label:'Error'};
  return {tone:'off',label:'Off'};
}

export const missingVars=c=>list(c?.vars).filter(v=>!v.set).map(v=>v.name);
// What the Instagram account lookup found, as one line for the card.
export function instagramLine(r){
  if(!r)return '';
  if(r.error)return r.error;
  const accounts=list(r.accounts),added=list(r.added);
  if(!accounts.length){
    const missing=list(r.missing);
    if(missing.length)return `This token reaches no Instagram account: Facebook did not grant it ${missing.join(', ')}. In Graph API Explorer add ${missing.length>1?'those permissions':'that permission'}, tick the Pages your accounts are linked to, generate, extend, then save the new token here.`;
    if(r.pages===0)return 'This token reaches no Facebook Page. Generate it again with the Pages your Instagram accounts are linked to ticked, then save it here.';
    if(r.pages>0)return `This token reaches ${plural(r.pages,'Facebook Page')}, but none has an Instagram professional account linked. Link each account to its Page, then save the token again.`;
    return 'This token reaches no Instagram account yet. Check each account is linked to a Facebook Page and the token was generated with those Pages ticked, then save it again.';
  }
  return `Found ${plural(accounts.length,'Instagram account')}: ${accounts.join(', ')}.${added.length?` Added ${added.join(', ')}.`:''}`;
}
// A token, key, secret or password is typed hidden; an id or a version is typed in the clear so the owner can check it.
export const secretVar=name=>/TOKEN|KEY|SECRET|PASS|AUTH|COOKIE|CREDENTIAL/i.test(String(name));

// The server sends the permission for every tool; a tool without one follows the spec default.
export function permissionOf(tool){
  if(PERMISSIONS.some(([id])=>id===tool?.permission))return tool.permission;
  return tool?.readOnly===true?'allow':'ask';
}

// "3 skills · 2 commands · 1 agent · 1 connector": only the non-zero parts.
export function countsLine(p){
  return [[list(p?.skills).length,'skill'],[list(p?.commands).length,'command'],[list(p?.agents).length,'agent'],[list(p?.connectors).length,'connector']]
    .filter(([n])=>n>0).map(([n,word])=>plural(n,word)).join(' · ');
}

// KEY=value lines. Blank lines are skipped; any other line needs a key of letters, digits, _ . or -. Values may contain "=".
export function parseLines(text){
  const pairs={};
  for(const [i,raw] of String(text??'').split(/\r?\n/).entries()){
    const line=raw.trim();
    if(!line)continue;
    const m=/^([A-Za-z0-9_.-]+)\s*=(.*)$/.exec(line);
    if(!m)return {pairs:{},error:`Line ${i+1} needs KEY=value.`};
    pairs[m[1]]=m[2].trim();
  }
  return {pairs,error:null};
}

export const argLines=text=>String(text??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

// http or https only; anything else is not a web link.
export function webLink(value){
  try{const url=new URL(String(value??''));return ['https:','http:'].includes(url.protocol)?url.href:null;}
  catch{return null;}
}

// The POST body for a custom connector, or the first problem with it. Header and environment values go as typed;
// the server moves them into secrets. "Web address" is an http transport, "Program" a stdio one.
export function customDraft({name,kind,url,command,args,secrets}){
  const label=String(name??'').trim();
  if(!label)return {error:'Give the connector a name.'};
  const pairs=parseLines(secrets);
  if(pairs.error)return {error:`${kind==='program'?'Environment':'Headers'}: ${pairs.error}`};
  if(kind==='program'){
    const cmd=String(command??'').trim();
    if(!cmd)return {error:'Enter the command that starts the program.'};
    return {body:{name:label,type:'stdio',command:cmd,args:argLines(args),env:pairs.pairs}};
  }
  const href=webLink(url);
  if(!href)return {error:'Enter a web address that starts with https:// or http://.'};
  return {body:{name:label,type:'http',url:href,headers:pairs.pairs}};
}

// The import result as lines: what was added, then one line per skipped connector and its reason.
export function importLines({added=[],skipped=[]}={}){
  return [list(added).length?`Added: ${list(added).join(', ')}`:'Added: nothing new.',...list(skipped).map(s=>`Skipped: ${s.name} (${s.reason})`)];
}

export function filterDirectory(items,query){
  const q=String(query??'').trim().toLowerCase();
  return list(items).filter(d=>!q||`${d.name} ${d.description??''}`.toLowerCase().includes(q));
}

export function filterMarketplace(items,{query='',category=''}={}){
  const q=String(query??'').trim().toLowerCase();
  return list(items).filter(p=>(!category||p.category===category)&&(!q||`${p.name} ${p.description??''}`.toLowerCase().includes(q)));
}

// The call's arguments for a connector approval or a Hermes tool call (gate hermes), cut to 600 characters. Other approvals show nothing.
// One line per argument, so a long one (a file's contents) cannot push the repo, branch or file names out of view.
const cut=(s,n)=>{s=String(s).replace(/\s+/g,' ').trim();return s.length>n?`${s.slice(0,n-1)}…`:s;};
const argLine=(key,value)=>{
  if(Array.isArray(value)){
    const names=value.map(v=>v&&typeof v==='object'?v.path??v.name??v.title??v.id:v).filter(v=>v!==undefined&&v!==null);
    const shown=names.slice(0,6).map(String).join(', ');
    return `${key}: ${value.length} — ${cut(shown||JSON.stringify(value),160)}${names.length>6?` (+${names.length-6} more)`:''}`;
  }
  return `${key}: ${cut(value&&typeof value==='object'?JSON.stringify(value):value,160)}`;
};
export function approvalDetail(a){
  if(!['connector','hermes'].includes(a?.gate)||!a.detail)return '';
  let text=String(a.detail);
  try{const args=JSON.parse(a.call?.function?.arguments??'');if(args&&typeof args==='object'&&!Array.isArray(args))text=Object.entries(args).map(([k,v])=>argLine(k,v)).join('\n');}catch{/* the stored detail stands */}
  return text.length>APPROVAL_DETAIL_MAX?`${text.slice(0,APPROVAL_DETAIL_MAX-1)}…`:text;
}

const h=(tag,props,...children)=>el(tag,props,children.flat().filter(child=>child!==null&&child!==undefined&&child!==false));

export function createConnectorsPanel({button,dialog,body,request,fetchImpl=(...args)=>fetch(...args),openAccounts=()=>globalThis.window?.openSurface?.('accounts')}){
  const state={connectors:[],directory:[],cats:[],plugins:[],claudeCode:[],marketplaces:[]};
  const ui={tab:'connectors',loaded:false,addConnector:false,addPlugin:false,market:null,marketPlugins:null,expanded:new Set(),toolsOpen:new Set(),catsOpen:new Set(),varsOpen:new Set(),copyOpen:new Set(),details:new Set(),confirming:new Set(),busy:new Set(),msgs:new Map(),drafts:new Map(),signing:null};
  const refs={};
  let signTimer=0,connectTimer=0;

  const read=async path=>{
    const response=await fetchImpl(`/api/${path}`,{cache:'no-store'});
    const data=await response.json().catch(()=>null);
    if(!response.ok||!data)throw new Error(data?.error||'Could not read connectors.');
    return data;
  };
  const write=(path,data,method='POST')=>request(path,data??{},method);

  // Buttons and switches. A switch keeps its own On/Off text so the flip shows while the request runs.
  const btn=(text,{key,className='',pressed,expanded,disabled,onclick}={})=>{
    const attrs={type:'button'};
    if(key)attrs['data-key']=key;
    if(pressed!==undefined)attrs['aria-pressed']=String(pressed);
    if(expanded!==undefined)attrs['aria-expanded']=String(expanded);
    const node=h('button',{className,text,attrs});
    if(disabled)node.disabled=true;
    if(onclick)node.onclick=onclick;
    return node;
  };
  const toggle=(label,checked,key,onChange)=>{
    const text=h('span',{text:checked?'On':'Off'});
    const input=h('input',{attrs:{type:'checkbox',role:'switch','data-key':key,'aria-label':label}});
    input.checked=checked===true;
    input.onchange=()=>{text.textContent=input.checked?'On':'Off';onChange(input.checked);};
    return h('label',{className:'cx-switch'},input,h('span',{className:'switch-track',attrs:{'aria-hidden':'true'}}),text);
  };
  const slot=name=>h('p',{className:'cx-msg',attrs:{role:'status','data-slot':name,hidden:''}});
  const empty=text=>h('p',{className:'cx-empty muted',text});

  function setMsg(name,text,bad=false){
    if(text)ui.msgs.set(name,{text,bad});else ui.msgs.delete(name);
    paintSlots();
  }
  function paintSlots(){
    for(const node of body.querySelectorAll('[data-slot]')){
      const m=ui.msgs.get(node.dataset.slot);
      node.textContent=m?.text??'';node.hidden=!m;node.classList.toggle('bad',m?.bad===true);
    }
  }
  function markBusy(){
    for(const node of body.querySelectorAll('[data-key]')){
      if(node.type==='checkbox')continue;
      const key=node.dataset.key;
      node.disabled=[...ui.busy].some(k=>key===k||key.startsWith(`${k}:`));
    }
  }

  // Runs one request. Its key is busy until it ends; its failure lands in the slot. Then the state is read again.
  async function act(key,work,slotName=key){
    if(ui.busy.has(key))return false;
    ui.busy.add(key);ui.msgs.delete(slotName);markBusy();paintMarket();
    let ok=false;
    try{await work();ok=true;}
    catch(err){ui.msgs.set(slotName,{text:err.message||String(err),bad:true});}
    finally{ui.busy.delete(key);await refresh(true);}
    return ok;
  }

  async function loadMarket(){
    if(!ui.market){ui.marketPlugins=null;return;}
    try{
      ui.marketPlugins=list((await read(`plugins/marketplaces/${enc(ui.market)}`)).plugins);
      ui.msgs.delete('plug:mkt');
    }catch(err){ui.marketPlugins=[];ui.msgs.set('plug:mkt',{text:err.message,bad:true});}
  }

  function signDone(){
    const now=state.connectors.find(c=>c.id===ui.signing.id);
    return !now||now.status!==ui.signing.status||Date.now()>ui.signing.until;
  }
  function stopSignIn(){clearInterval(signTimer);signTimer=0;ui.signing=null;}

  const snapshot=()=>JSON.stringify([state,ui.market,ui.marketPlugins]);
  // Polls and focus re-read the state; the lists are painted only when the data changed, so typed text survives.
  async function refresh(force=false){
    if(!dialog.open)return;
    const before=snapshot();
    try{
      const [c,p]=await Promise.all([read('connectors'),read('plugins')]);
      Object.assign(state,{connectors:list(c.connectors),directory:list(c.directory),cats:list(c.cats),plugins:list(p.plugins),claudeCode:list(p.claudeCode),marketplaces:list(p.marketplaces)});
      if(!state.marketplaces.some(m=>m.id===ui.market))ui.market=state.marketplaces[0]?.id??null;
      if(ui.addPlugin)await loadMarket();
      ui.msgs.delete('page');
    }catch(err){ui.msgs.set('page',{text:err.message||'Could not read connectors.',bad:true});force=true;}
    ui.loaded=true;
    if(ui.signing&&signDone()){stopSignIn();force=true;}
    if(force||snapshot()!==before)paint();
    // A card that says Connecting… is read again until the server says otherwise (ux-audit F11), not only during a sign-in.
    clearTimeout(connectTimer);connectTimer=0;
    if(dialog.open&&!signTimer&&state.connectors.some(c=>c.enabled!==false&&c.status==='connecting'))connectTimer=setTimeout(()=>void refresh(),SIGN_IN_POLL_MS);
  }

  // The first frame, before the first read returns, is the Connectors tab with a loading row, not empty lists.
  const loading=text=>h('p',{className:'cx-empty muted',text,attrs:{role:'status'}});
  function paint(){
    const focused=document.activeElement;
    for(const [id,tab,panel] of refs.tabs){tab.setAttribute('aria-selected',String(ui.tab===id));panel.hidden=ui.tab!==id;}
    refs.cxListView.hidden=ui.addConnector;refs.cxAddView.hidden=!ui.addConnector;
    refs.plListView.hidden=ui.addPlugin;refs.plAddView.hidden=!ui.addPlugin;
    const noConnectors=ui.loaded?empty('No connectors yet. Add one to let your cats use your apps.'):loading('Loading connectors…');
    refs.cxList.replaceChildren(...(state.connectors.length?state.connectors.map(connectorCard):[noConnectors]));
    refs.browser.replaceChildren(...browserParts().filter(Boolean));
    refs.dirList.replaceChildren(...directoryItems());
    const noPlugins=ui.loaded?empty('No plugins yet. Add one from Claude Code, a marketplace or a folder.'):loading('Loading plugins…');
    refs.plList.replaceChildren(...(state.plugins.length?state.plugins.map(pluginCard):[noPlugins]));
    refs.ccList.replaceChildren(...claudeItems());
    paintMarket();
    paintSlots();
    markBusy();
    // A control that was replaced loses focus; put it back on its twin.
    if(focused&&!focused.isConnected&&focused.dataset?.key)body.querySelector(`[data-key="${CSS.escape(focused.dataset.key)}"]`)?.focus({preventScroll:true});
  }

  // ---- Connectors ----

  // One line per connector: name, status and Manage. Manage opens the rest: enable, sign-in, cats, tools and remove.
  function connectorCard(c){
    const key=`cx:${c.id}`,s=statusLabel(c),open=ui.expanded.has(c.id);
    const toggleOpen=()=>{if(open)ui.expanded.delete(c.id);else ui.expanded.add(c.id);paint();};
    const head=h('div',{className:'cx-head'},
      h('div',{className:'cx-title'},h('strong',{text:c.name})),
      h('p',{className:'cx-status'},h('span',{className:'cx-dot',attrs:{'data-tone':s.tone,'aria-hidden':'true'}}),h('span',{text:s.label})),
      btn(open?'Hide':'Manage',{key:`${key}:manage`,className:'cx-disclose',expanded:open,onclick:toggleOpen}));
    return h('li',{className:'cx-card',attrs:{'data-id':c.id}},head,open?connectorDetails(c,key):null);
  }

  function connectorDetails(c,key){
    const missing=missingVars(c),on=c.enabled!==false,tools=list(c.tools),cats=list(c.cats);
    return h('div',{className:'cx-details-wrap'},
      h('div',{className:'cx-head'},
        h('span',{className:'cx-badge',text:SOURCE_LABEL[c.source]??c.source}),
        toggle(`Use ${c.name}`,c.enabled,key,value=>act(key,()=>write(`connectors/${enc(c.id)}`,{enabled:value},'PATCH')))),
      c.url||c.command?h('p',{className:'cx-where muted',text:c.url||c.command}):null,
      on&&c.status==='error'&&c.error?h('p',{className:'cx-err-line',text:c.error}):null,
      on&&c.status==='error'?btn('Retry',{key,className:'cx-primary',onclick:()=>act(key,()=>write(`connectors/${enc(c.id)}/reconnect`,{}))}):null,
      on&&c.status==='needs-auth'?btn('Sign in',{key,className:'cx-primary',onclick:()=>signIn(c)}):null,
      ui.signing?.id===c.id?h('p',{className:'cx-wait',attrs:{role:'status','aria-live':'polite'}},['Waiting for you to finish signing in in your browser. ',h('a',{className:'cx-open',text:'Didn’t open? Open the sign-in page ↗',attrs:{href:ui.signing.url,target:'_blank',rel:'noopener noreferrer'}})]):null,
      on&&c.status==='needs-setup'&&missing.length?setupForm(c,missing,key):settingsBlock(c,key),
      slot(key),
      catsBlock(c,cats,key),
      toolsBlock(c,tools,key),
      copyBlock(c,key),
      removeBlock(key,c.name,()=>act(key,()=>write(`connectors/${enc(c.id)}`,{},'DELETE')),'Its tools leave every cat.'));
  }

  // The cat picker: a summary ("Cats: All", "Cats: 3") that opens the chips.
  function catsBlock(c,cats,key){
    const all=cats.includes('*'),open=ui.catsOpen.has(c.id);
    const summary=all?'Cats: All':`Cats: ${cats.length||'none'}`;
    const toggleCats=()=>{if(open)ui.catsOpen.delete(c.id);else ui.catsOpen.add(c.id);paint();};
    const none=cats.length?null:empty('No cat can use it yet.');
    const chips=state.cats.length?h('div',{className:'cx-chips',attrs:{role:'group','aria-label':`Cats that can use ${c.name}`}},[
      btn('All cats',{key:`${key}:cat:*`,className:'cx-chip',pressed:all,onclick:()=>act(key,()=>write(`connectors/${enc(c.id)}`,{cats:['*']},'PATCH'))}),
      ...state.cats.map(cat=>{
        const chosen=!all&&cats.includes(cat.id),toggled=chosen?cats.filter(x=>x!==cat.id):[...cats,cat.id];
        return btn(cat.name,{key:`${key}:cat:${cat.id}`,className:'cx-chip',pressed:chosen,onclick:()=>act(key,()=>write(`connectors/${enc(c.id)}`,{cats:all?[cat.id]:toggled},'PATCH'))});
      }),
    ]):null;
    return h('div',{className:'cx-cats'},
      btn(summary,{key:`${key}:cats`,className:'cx-disclose',expanded:open,onclick:toggleCats}),
      open?[chips,none]:null);
  }

  // Every value the connector reads, saved or not, behind "Settings": a saved one is replaced by typing a new one.
  function settingsBlock(c,key){
    const vars=list(c.vars);
    if(!vars.length)return null;
    const open=ui.varsOpen.has(c.id);
    const toggleVars=()=>{if(open)ui.varsOpen.delete(c.id);else ui.varsOpen.add(c.id);paint();};
    // An Instagram connector can look up every account its token reaches and set one connector up per account.
    const find=c.instagram?btn('Find my Instagram accounts',{key,className:'cx-disclose',onclick:()=>act(key,async()=>{const r=await write(`connectors/${enc(c.id)}/instagram-accounts`,{});ui.msgs.set(key,{text:instagramLine(r?.instagram),bad:false});})}):null;
    return h('div',{className:'cx-cats'},
      btn(`Settings (${vars.length})`,{key:`${key}:vars`,className:'cx-disclose',expanded:open,onclick:toggleVars}),
      find,
      open?setupForm(c,vars.map(v=>v.name),key):null);
  }

  // Another copy of the connector for a second account: same program and saved values, its own name, so each cat sees which is which.
  function copyBlock(c,key){
    if(!list(c.vars).length)return null;
    const open=ui.copyOpen.has(c.id),dataKey=`${key}:copy-name`;
    const toggleCopy=()=>{if(open)ui.copyOpen.delete(c.id);else ui.copyOpen.add(c.id);paint();};
    if(!open)return h('div',{className:'cx-cats'},btn('Add another account',{key:`${key}:copy`,className:'cx-disclose',expanded:false,onclick:toggleCopy}));
    const input=h('input',{attrs:{type:'text',autocomplete:'off',maxlength:'80',placeholder:`${c.name} @otheraccount`,'data-key':dataKey}});
    input.value=ui.drafts.get(dataKey)??'';
    input.oninput=()=>ui.drafts.set(dataKey,input.value);
    const add=btn('Add',{key,className:'cx-primary'});
    add.type='submit';
    const form=h('form',{className:'cx-setup',attrs:{novalidate:''}},
      h('p',{className:'muted',text:'Makes a second copy with the same settings. Open its Settings and change what differs, such as the account id.'}),
      h('label',{className:'cx-field'},h('span',{text:'Name'}),input),add);
    form.onsubmit=event=>{
      event.preventDefault();
      const name=(ui.drafts.get(dataKey)??'').trim();
      if(!name){setMsg(key,'Give the copy a name first.',true);return;}
      void act(key,()=>write(`connectors/${enc(c.id)}/copy`,{name})).then(ok=>{if(ok){ui.drafts.delete(dataKey);ui.copyOpen.delete(c.id);}});
    };
    return h('div',{className:'cx-cats'},btn('Add another account',{key:`${key}:copy`,className:'cx-disclose',expanded:true,onclick:toggleCopy}),form);
  }

  function setupForm(c,missing,key){
    const saved=new Set(list(c.vars).filter(v=>v.set).map(v=>v.name));
    const inputs=missing.map(name=>{
      const dataKey=`${key}:var:${name}`;
      const input=h('input',{attrs:{type:secretVar(name)?'password':'text',autocomplete:'off',spellcheck:'false',autocapitalize:'off','data-key':dataKey,...(saved.has(name)?{placeholder:'Saved · type a new value to replace it'}:{})}});
      input.value=ui.drafts.get(dataKey)??'';
      input.oninput=()=>ui.drafts.set(dataKey,input.value);
      return h('label',{className:'cx-field'},h('span',{text:name}),input);
    });
    const save=btn('Save',{key,className:'cx-primary'});
    save.type='submit';
    // A directory service that names where its token is made gets a one-tap link there, with its one line of how.
    const entry=state.directory.find(d=>d.id===c.id),tokenUrl=webLink(entry?.tokenUrl??(entry?.auth==='token'?entry?.homepage:''));
    const help=tokenUrl?[h('p',{className:'muted',text:entry.tokenHelp??`Create a token on ${entry.name}, copy it and paste it below.`}),h('a',{className:'cx-open',text:`Get a token on ${entry.name} ↗`,attrs:{href:tokenUrl,target:'_blank',rel:'noopener noreferrer'}})]:[];
    const intro=missing.every(name=>saved.has(name))?'Type a new value to replace a saved one. Values are kept on this computer only.':'Fill in the values this connector needs. They are kept on this computer only.';
    const form=h('form',{className:'cx-setup',attrs:{novalidate:''}},h('p',{className:'muted',text:intro}),help,inputs,save);
    form.onsubmit=event=>{
      event.preventDefault();
      const vars=Object.fromEntries(missing.map(name=>[name,(ui.drafts.get(`${key}:var:${name}`)??'').trim()]).filter(([,value])=>value));
      if(!Object.keys(vars).length){setMsg(key,'Enter a value first.',true);return;}
      void act(key,async()=>{const r=await write(`connectors/${enc(c.id)}`,{vars},'PATCH');if(r?.instagram)ui.msgs.set(key,{text:instagramLine(r.instagram),bad:!!r.instagram.error});}).then(ok=>{
        if(ok)for(const name of Object.keys(vars))ui.drafts.delete(`${key}:var:${name}`);
      });
    };
    return form;
  }

  async function signIn(c){
    const key=`cx:${c.id}`;
    await act(key,async()=>{
      const r=await write(`connectors/${enc(c.id)}/sign-in`,{});
      const link=webLink(r.url);
      if(!link)throw new Error('The sign-in address is not a web link.');
      window.open(link,'_blank','noopener');
      // The link stays on the card while waiting: a browser that blocked the page, or a closed tab, is one tap from it.
      ui.signing={id:c.id,status:c.status,until:Date.now()+SIGN_IN_WINDOW_MS,url:link};
      clearInterval(signTimer);
      signTimer=setInterval(()=>void refresh(),SIGN_IN_POLL_MS);
    });
  }

  function toolsBlock(c,tools,key){
    const open=ui.toolsOpen.has(c.id);
    const toggleTools=()=>{if(open)ui.toolsOpen.delete(c.id);else ui.toolsOpen.add(c.id);paint();};
    return h('div',{className:'cx-tools-wrap'},
      btn(`Tools (${tools.length})`,{key:`${key}:tools`,className:'cx-disclose',expanded:open,onclick:toggleTools}),
      open?toolList(c,tools,key):null);
  }

  function toolList(c,tools,key){
    if(!tools.length)return empty('This connector lists no tools.');
    return h('ul',{className:'cx-tools'},tools.map(tool=>toolRow(c,tool,key)));
  }

  function toolRow(c,tool,key){
    const permission=permissionOf(tool),name=tool.title||tool.name;
    return h('li',{className:'cx-tool'},
      h('div',{className:'cx-tool-main'},
        h('div',{className:'cx-tool-name'},h('strong',{text:name}),tool.readOnly?h('span',{className:'cx-ro',text:'read-only'}):null),
        tool.title&&tool.title!==tool.name?h('code',{className:'cx-code',text:tool.name}):null,
        tool.description?h('p',{className:'cx-tool-desc',text:tool.description}):null),
      h('div',{className:'cx-seg',attrs:{role:'group','aria-label':`Permission for ${name}`}},
        PERMISSIONS.map(([value,label])=>btn(label,{key:`${key}:tool:${tool.name}:${value}`,className:'cx-seg-btn',pressed:permission===value,
          onclick:()=>{if(permission!==value)void act(key,()=>write(`connectors/${enc(c.id)}`,{tools:{[tool.name]:value}},'PATCH'));}}))));
  }

  // Remove asks inside the card first; the confirm step is the card's own row, not a window dialog.
  function removeBlock(key,name,remove,note){
    if(!ui.confirming.has(key))return btn('Remove',{key:`${key}:remove`,className:'cx-remove',onclick:()=>{ui.confirming.add(key);paint();}});
    return h('div',{className:'cx-confirm'},
      h('p',{text:`Remove ${name}? ${note}`}),
      btn('Remove',{key:`${key}:remove-yes`,className:'cx-danger',onclick:async()=>{if(await remove()){ui.confirming.delete(key);paint();}}}),
      btn('Keep it',{key:`${key}:keep`,onclick:()=>{ui.confirming.delete(key);paint();}}));
  }

  function directoryItems(){
    if(!ui.loaded)return [loading('Loading the directory…')];
    if(!state.directory.length)return [empty('The directory is empty.'),btn('Reload',{key:'dir:reload',className:'cx-secondary',onclick:()=>void refresh(true)})];
    const shown=filterDirectory(state.directory,refs.dirSearch.value);
    if(!shown.length)return [empty('Nothing matches that search.')];
    return shown.map(d=>{
      const key=`dir:${d.id}`,added=state.connectors.some(c=>c.source==='directory'&&(c.id===d.id||c.name===d.name));
      return h('li',{className:'cx-row'},
        h('div',{className:'cx-row-main'},h('strong',{text:d.name}),h('p',{className:'cx-desc',text:d.description??''}),h('p',{className:'cx-auth muted',text:AUTH_NOTE[d.auth]??''})),
        added?btn('Added',{className:'cx-done',disabled:true}):btn('Add',{key,className:'cx-primary',onclick:async()=>{
          if(await act(key,()=>write(`connectors/directory/${enc(d.id)}`,{}))){ui.addConnector=false;paint();}
        }}),
        slot(key));
    });
  }

  function buildCustomForm(){
    const name=h('input',{attrs:{name:'name',type:'text',maxlength:'60',autocomplete:'off'}});
    const url=h('input',{attrs:{name:'url',type:'url',inputmode:'url',autocomplete:'off',spellcheck:'false',placeholder:'https://example.com/mcp'}});
    const command=h('input',{attrs:{name:'command',type:'text',autocomplete:'off',spellcheck:'false',placeholder:'npx'}});
    const args=h('textarea',{attrs:{name:'args',rows:'3',autocomplete:'off',spellcheck:'false',placeholder:'One argument per line'}});
    const secrets=h('textarea',{className:'cx-masked',attrs:{name:'secrets',rows:'3',autocomplete:'off',autocapitalize:'off',spellcheck:'false',placeholder:'KEY=value, one per line','data-masked':'true'}});
    const secretTitle=h('span',{text:'Headers (KEY=value, one per line)'});
    const showValues=btn('Show',{className:'cx-show'});
    showValues.setAttribute('aria-pressed','false');
    showValues.onclick=()=>{
      const shown=showValues.getAttribute('aria-pressed')!=='true';
      showValues.setAttribute('aria-pressed',String(shown));showValues.textContent=shown?'Hide':'Show';secrets.dataset.masked=String(!shown);
    };
    const kinds=[['web','Web address'],['program','Program on this computer']].map(([value,label],i)=>{
      const input=h('input',{attrs:{type:'radio',name:'kind',value}});
      input.checked=i===0;
      return h('label',{className:'cx-choice'},input,h('span',{text:label}));
    });
    const field=(label,control,kind)=>h('label',{className:'cx-field',attrs:kind?{'data-kind':kind}:{}},h('span',{text:label}),control);
    const submit=btn('Add connector',{key:'add:custom',className:'cx-primary'});
    submit.type='submit';
    const form=h('form',{className:'cx-form',attrs:{novalidate:''}},
      field('Name',name),
      h('fieldset',{className:'cx-kind'},h('legend',{text:'Kind'}),kinds),
      field('Web address',url,'web'),
      field('Command',command,'program'),
      field('Arguments, one per line',args,'program'),
      h('div',{className:'cx-secret'},h('label',{className:'cx-field'},secretTitle,secrets),showValues),
      h('p',{className:'cx-warn',attrs:{'data-kind':'program',role:'note'},text:'This runs a program on this computer with your permissions. Only add programs you trust.'}),
      slot('add:custom'),
      h('div',{className:'cx-actions'},submit));
    const syncKind=()=>{
      const kind=form.elements.namedItem('kind').value;
      for(const node of form.querySelectorAll('[data-kind]'))node.hidden=node.dataset.kind!==kind;
      secretTitle.textContent=kind==='program'?'Environment (KEY=value, one per line)':'Headers (KEY=value, one per line)';
    };
    form.addEventListener('change',syncKind);
    syncKind();
    form.onsubmit=async event=>{
      event.preventDefault();
      const draft=customDraft({name:name.value,kind:form.elements.namedItem('kind').value,url:url.value,command:command.value,args:args.value,secrets:secrets.value});
      if(draft.error){setMsg('add:custom',draft.error,true);return;}
      if(await act('add:custom',()=>write('connectors',draft.body))){
        form.reset();syncKind();ui.addConnector=false;paint();
      }
    };
    return form;
  }

  // ---- Plugins ----

  function pluginCard(p){
    const key=`pl:${p.id}`,open=ui.details.has(p.id),counts=countsLine(p),unsupported=list(p.unsupported);
    const toggleDetails=()=>{if(open)ui.details.delete(p.id);else ui.details.add(p.id);paint();};
    return h('li',{className:'cx-card',attrs:{'data-id':p.id}},
      h('div',{className:'cx-head'},
        h('div',{className:'cx-title'},h('strong',{text:p.name}),p.version?h('span',{className:'cx-badge',text:`v${p.version}`}):null),
        toggle(`Use ${p.name}`,p.enabled,key,value=>act(key,()=>write(`plugins/${enc(p.id)}`,{enabled:value},'PATCH')))),
      p.author?h('p',{className:'cx-where muted',text:`by ${p.author}`}):null,
      p.description?h('p',{className:'cx-desc',text:p.description}):null,
      counts?h('p',{className:'cx-counts',text:counts}):null,
      // Every cat leads with these skills, even one the Mayor gave a short list of its own.
      list(p.skills).length?h('div',{className:'cx-every'},h('span',{text:'Every cat leads with its skills'}),toggle(`Every cat leads with ${p.name}’s skills`,p.everyCat,`${key}:every`,value=>act(key,()=>write(`plugins/${enc(p.id)}`,{everyCat:value},'PATCH')))):null,
      unsupported.length?h('p',{className:'cx-note',text:`Not used by Clowder: ${unsupported.join(', ')}`}):null,
      btn(open?'Hide details':'Details',{key:`${key}:details`,className:'cx-disclose',expanded:open,onclick:toggleDetails}),
      open?pluginDetails(p):null,
      slot(key),
      removeBlock(key,p.name,()=>act(key,()=>write(`plugins/${enc(p.id)}`,{},'DELETE')),'Its skills, commands and agents go with it.'));
  }

  function pluginDetails(p){
    const section=(title,items)=>items.length?h('div',{className:'cx-sub'},h('h4',{text:title}),h('ul',{className:'cx-plain'},items)):null;
    const skills=list(p.skills),commands=list(p.commands),agents=list(p.agents);
    return h('div',{className:'cx-details'},
      section('Skills',skills.map(s=>h('li',{},h('strong',{text:s.name}),s.description?h('span',{text:` — ${s.description}`}):null))),
      section('Commands',commands.map(c=>h('li',{},h('code',{className:'cx-code',text:`/${c.name}`}),c.argumentHint?h('span',{className:'muted',text:` ${c.argumentHint}`}):null,c.description?h('span',{text:` — ${c.description}`}):null))),
      section('Agents',agents.map(a=>h('li',{},h('strong',{text:a.name}),a.description?h('span',{text:` — ${a.description}`}):null))),
      list(p.connectors).length?h('p',{className:'muted',text:`Connectors: ${list(p.connectors).join(', ')}`}):null,
      skills.length||commands.length||agents.length?null:empty('This plugin adds no skills, commands or agents.'));
  }

  function claudeItems(){
    if(!ui.loaded)return [loading('Loading…')];
    if(!state.claudeCode.length)return [empty('No Claude Code plugins on this computer.')];
    return state.claudeCode.map(p=>{
      const key=`cc:${p.key}`,detail=[p.marketplace,p.version?`v${p.version}`:''].filter(Boolean).join(' · ');
      return h('li',{className:'cx-row'},
        h('div',{className:'cx-row-main'},h('strong',{text:p.name}),detail?h('p',{className:'cx-desc muted',text:detail}):null),
        p.installed?btn('Added',{className:'cx-done',disabled:true}):btn('Add',{key,className:'cx-primary',onclick:()=>act(key,()=>write('plugins/claude-code',{key:p.key}),'plug:cc')}));
    });
  }

  function marketItem(p){
    const key=`mk:${p.name}`;
    return h('li',{className:'cx-row'},
      h('div',{className:'cx-row-main'},h('strong',{text:p.name}),p.category?h('span',{className:'cx-badge',text:p.category}):null,p.description?h('p',{className:'cx-desc',text:p.description}):null),
      p.installed?btn('Installed',{className:'cx-done',disabled:true}):btn('Install',{key,className:'cx-primary',onclick:()=>act(key,async()=>{
        await write(`plugins/marketplaces/${enc(ui.market)}/install`,{name:p.name});
        await loadMarket();
      },'plug:mkt')}));
  }

  function marketRows(all,shown){
    if(!state.marketplaces.length)return [empty('No marketplaces yet.'),btn('Reload',{key:'mk:reload',className:'cx-secondary',onclick:()=>void refresh(true)})];
    if(!all.length)return [empty('This marketplace has no plugins yet. Refresh it to fetch them.')];
    if(!shown.length)return [empty('Nothing matches that search.')];
    return shown.map(marketItem);
  }

  function paintMarket(){
    const select=refs.mkSelect,all=list(ui.marketPlugins),refreshing=ui.busy.has('pl:refresh');
    select.replaceChildren(...state.marketplaces.map(m=>h('option',{text:m.name,attrs:{value:m.id}})));
    select.value=ui.market??'';
    select.disabled=!state.marketplaces.length;
    refs.mkRefresh.disabled=!ui.market||refreshing;
    refs.mkRefresh.textContent=refreshing?'Refreshing…':'Refresh';
    const categories=[...new Set(all.map(p=>p.category).filter(Boolean))].sort();
    const chosen=refs.mkCat.value;
    refs.mkCat.replaceChildren(h('option',{text:'All categories',attrs:{value:''}}),...categories.map(c=>h('option',{text:c,attrs:{value:c}})));
    refs.mkCat.value=categories.includes(chosen)?chosen:'';
    const shown=filterMarketplace(all,{query:refs.mkSearch.value,category:refs.mkCat.value});
    refs.mkList.replaceChildren(...marketRows(all,shown));
  }

  function buildFolderForm(){
    const path=h('input',{attrs:{name:'path',type:'text',autocomplete:'off',spellcheck:'false',placeholder:'Path to the plugin folder'}});
    const submit=btn('Add folder',{key:'plug:folder',className:'cx-primary'});
    submit.type='submit';
    const form=h('form',{className:'cx-form',attrs:{novalidate:''}},
      h('label',{className:'cx-field'},h('span',{text:'Folder path'}),path),
      slot('plug:folder'),
      h('div',{className:'cx-actions'},submit));
    form.onsubmit=async event=>{
      event.preventDefault();
      const value=path.value.trim();
      if(!value){setMsg('plug:folder','Enter the folder path.',true);return;}
      if(await act('plug:folder',()=>write('plugins/folder',{path:value}),'plug:folder')){
        path.value='';ui.addPlugin=false;paint();
      }
    };
    return form;
  }

  // ---- Accounts ----

  // The cats' browser, every sign-in's health and the built-in tools moved to Accounts & connections (plan 1.9). This row points there.
  function browserParts(){
    return [
      h('div',{className:'cx-browser-text'},h('strong',{text:'Accounts & connections'}),h('p',{className:'cx-lede muted',text:'Sign-ins, who each account is, the cats’ browser and the built-in tools are there.'})),
      btn('Open',{key:'ac:open',className:'cx-secondary',onclick:()=>{dialog.close();openAccounts();}})];
  }

  // ---- Shell: built once, so the forms keep what the owner typed ----

  function buildShell(){
    const tab=(id,label)=>{
      const node=btn(label,{className:'cx-tab',onclick:()=>{ui.tab=id;paint();}});
      node.id=`cx-tab-${id}`;node.setAttribute('role','tab');node.setAttribute('aria-controls',`cx-panel-${id}`);
      return node;
    };
    const tabConnectors=tab('connectors','Connectors'),tabPlugins=tab('plugins','Plugins');

    refs.cxList=h('ul',{className:'cx-list'});
    refs.cxListView=h('div',{className:'cx-view'},
      h('div',{className:'cx-bar'},h('p',{className:'cx-lede muted',text:'Each connector gives your cats tools from one app or service.'}),
        btn('Add a connector',{className:'cx-primary',onclick:()=>{ui.addConnector=true;paint();}})),
      refs.browser=h('div',{className:'cx-browser'}),
      refs.cxList);
    refs.dirSearch=h('input',{attrs:{type:'search',autocomplete:'off',placeholder:'Search the directory','aria-label':'Search the directory'}});
    refs.dirSearch.oninput=()=>{refs.dirList.replaceChildren(...directoryItems());markBusy();};
    refs.dirList=h('ul',{className:'cx-list'});
    refs.cxAddView=h('div',{className:'cx-view',attrs:{hidden:''}},
      h('div',{className:'cx-bar'},btn('← Back',{className:'cx-back',onclick:()=>{ui.addConnector=false;paint();}}),h('h3',{text:'Add a connector'})),
      h('section',{className:'cx-section'},h('h4',{text:'From the directory'}),refs.dirSearch,refs.dirList),
      h('section',{className:'cx-section'},h('h4',{text:'Custom connector'}),buildCustomForm()),
      h('section',{className:'cx-section'},h('h4',{text:'From Claude Code'}),
        h('p',{className:'muted',text:'Copies the connectors in your Claude Code settings. Nothing runs when you import.'}),
        btn('Import from Claude Code',{key:'add:import',onclick:()=>act('add:import',async()=>{
          const result=await write('connectors/import-claude-code',{});
          ui.msgs.set('add:import',{text:importLines(result).join('\n')});
        },'add:import')}),
        slot('add:import')));

    refs.plList=h('ul',{className:'cx-list'});
    refs.plListView=h('div',{className:'cx-view'},
      h('div',{className:'cx-bar'},h('p',{className:'cx-lede muted',text:'Plugins bring skills, commands and agents to your cats.'}),
        btn('Add a plugin',{className:'cx-primary',onclick:()=>{ui.addPlugin=true;paint();void loadMarket().then(paint);}})),
      refs.plList);
    refs.ccList=h('ul',{className:'cx-list'});
    refs.mkSelect=h('select',{attrs:{id:'cx-mk-select'}});
    refs.mkSelect.onchange=()=>{ui.market=refs.mkSelect.value;ui.marketPlugins=null;void loadMarket().then(paint);};
    refs.mkRefresh=btn('Refresh',{key:'pl:refresh',className:'cx-secondary',onclick:()=>act('pl:refresh',async()=>{
      await write(`plugins/marketplaces/${enc(ui.market)}/refresh`,{});
      await loadMarket();
    },'plug:mkt')});
    refs.mkSearch=h('input',{attrs:{type:'search',autocomplete:'off',placeholder:'Search plugins','aria-label':'Search plugins'}});
    refs.mkCat=h('select',{attrs:{'aria-label':'Category'}});
    refs.mkList=h('ul',{className:'cx-list'});
    refs.mkSearch.oninput=()=>paintMarket();
    refs.mkCat.onchange=()=>paintMarket();
    refs.plAddView=h('div',{className:'cx-view',attrs:{hidden:''}},
      h('div',{className:'cx-bar'},btn('← Back',{className:'cx-back',onclick:()=>{ui.addPlugin=false;paint();}}),h('h3',{text:'Add a plugin'})),
      h('section',{className:'cx-section'},h('h4',{text:'From Claude Code'}),refs.ccList,slot('plug:cc')),
      h('section',{className:'cx-section'},h('h4',{text:'Marketplace'}),
        h('div',{className:'cx-market-bar'},h('label',{className:'cx-field'},h('span',{text:'Marketplace'}),refs.mkSelect),refs.mkRefresh),
        h('div',{className:'cx-filters'},
          h('label',{className:'cx-field'},h('span',{text:'Search'}),refs.mkSearch),
          h('label',{className:'cx-field'},h('span',{text:'Category'}),refs.mkCat)),
        refs.mkList,
        slot('plug:mkt')),
      h('section',{className:'cx-section'},h('h4',{text:'From a folder'}),buildFolderForm()));

    refs.tabs=[['connectors',tabConnectors,h('section',{className:'cx-panel',attrs:{id:'cx-panel-connectors',role:'tabpanel','aria-labelledby':'cx-tab-connectors'}},refs.cxListView,refs.cxAddView)],
      ['plugins',tabPlugins,h('section',{className:'cx-panel',attrs:{id:'cx-panel-plugins',role:'tabpanel','aria-labelledby':'cx-tab-plugins'}},refs.plListView,refs.plAddView)]];
    body.replaceChildren(slot('page'),h('div',{className:'cx-tabs',attrs:{role:'tablist','aria-label':'Connectors and plugins'}},tabConnectors,tabPlugins),...refs.tabs.map(([,,panel])=>panel));
    // The close button of the dialog shares the app's 44px close control.
    dialog.querySelector('[data-close]')?.classList.add('close-x');
  }

  buildShell();
  paint();

  // Only the owner's route answers; paired and LAN devices get a 403 and never see the button.
  async function probe(){
    try{await read('connectors');button.hidden=false;}
    catch{/* stays hidden */}
  }

  const onFocus=()=>void refresh();
  async function open(){
    dialog.showModal();
    window.addEventListener('focus',onFocus);
    await refresh(true);
  }
  button.onclick=open;
  dialog.addEventListener('close',()=>{stopSignIn();clearTimeout(connectTimer);connectTimer=0;window.removeEventListener('focus',onFocus);});
  return {probe};
}

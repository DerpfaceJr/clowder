// AI models settings for the owner's dialog. Pure helpers are exported for tests. createModelsPanel builds the
// DOM once and paints it in place, so a status poll never wipes what the owner is typing into the API key form.
// Server text is always written with textContent; the only href is an https URL that passes httpsLink().

import {aiDraft,effortChoices,usingText,savingButton,modelOptions,paintModelPicker,wireModelPicker,readModelPicker} from './ai-settings.js';
import {confirmDialog} from './dialogs.js';
import {createAnthropicSection,createHermesSection} from './model-extras.js';
import {icon} from './icons.js';

export const POLL_MS=3000,POLL_WINDOW_MS=120_000;
export const HOSTED_LIMITS={base:300,model:120,key:500};
const PLANS={
  claude:{title:'Claude plan',cli:'Claude Code',signIn:'Sign in with Claude',note:'Uses your own Claude subscription through the official Claude Code app. Counts against your plan limits.'},
  chatgpt:{title:'ChatGPT plan',cli:'Codex CLI',signIn:'Sign in with ChatGPT',note:'Uses your own ChatGPT subscription through the official Codex CLI. Counts against your plan limits.'},
};

export const ollamaModel=name=>String(name??'').split(' · ').slice(1).join(' · ').trim();

// The command the owner runs by hand. The town never runs the installer itself.
export const WORKSHOP_COMMAND='powershell -ExecutionPolicy Bypass -File scripts\\workshop\\install-workshop.ps1';
const WORKSHOP_STATE={'not installed':'Not installed','installed':'Installed','failed':'Failed'};
const WORKSHOP_RETRY=new Set(['not installed','failed']);
// A repo that is installed but not runnable is waiting for its run recipe. The label says who decides it.
const RECIPE_WAIT={needs_owner:'Installed, the owner decides its run recipe',pending:'Installed, the Mayor decides its run recipe',approved:'Installed, setup still to run',none:'Installed, no run recipe yet'};
export const SETUP_TOAST='Setting up the cats’ workshop…';
export const WSL_CONFIRM='Clowder’s cats need Windows Subsystem for Linux for their sandbox. Install it now? (Windows will ask for permission and may need a restart.)';
export const SETUP_CONFIRM='Clowder will download the official Ubuntu base image, check its SHA-256, and create a separate WSL distro named cat-workshop. The cats’ tools run there and cannot see your Windows files. This can take a while. Continue?';

// Pure: the workshop card from GET /api/workshop. Install is enabled only when the distro exists and is isolated.
export function workshopCard(w){
  const present=w?.distro?.present===true,isolated=w?.isolated===true;
  const tools=Array.isArray(w?.tools)?w.tools:[];
  const setup=w?.setup??{};
  const running=setup.status==='running';
  const failure=setup.status==='failed'&&setup.error?setup.error:null;
  const wsl=typeof setup.wsl==='boolean'?(setup.wsl?'present':'missing'):'unknown';
  return {
    badge:running?'Setting up':!present?'Not installed':isolated?'Isolated':'Not isolated',
    tone:running?'warn':present&&isolated?'ok':present?'warn':'off',
    distro:present?'Yes':'No',
    isolated:isolated?'Yes':'No',
    command:present?null:WORKSHOP_COMMAND,
    hint:!present?'Needs you: run this once on this computer. It creates the cat-workshop distro.':isolated?'':'Not isolated: the distro can reach Windows drives or start Windows programs. Nothing is installed or run until it is.',
    error:w?.error??null,
    setup:{
      running,status:setup.status??'idle',lines:Array.isArray(setup.lines)?setup.lines.slice(-6):[],failure,wsl,wslMessage:setup.wslMessage??null,
      canCreate:!present&&!running&&wsl!=='missing',canInstallWsl:wsl==='missing'&&!running,
    },
    autoSetup:w?.settings?.autoSetup!==false,
    allowLongJobs:w?.settings?.allowLongJobs===true,
    tools:tools.map(t=>{
      const recipe=t.recipe??null;
      const label=t.state==='not runnable'?RECIPE_WAIT[recipe?.status]??RECIPE_WAIT.none:(WORKSHOP_STATE[t.state]??String(t.state));
      const action=WORKSHOP_RETRY.has(t.state)||(t.state==='not runnable'&&recipe?.status==='approved');
      return {
        id:t.id,label:t.purpose||t.need||t.id,state:t.state,stateLabel:label,reason:t.reason??null,
        action,installable:action&&present&&isolated,
        recipe:recipe?{description:recipe.description??'',status:recipe.status,long:recipe.long===true}:null,
        decidable:recipe?.status==='needs_owner',
      };
    }),
  };
}

export const httpsLink=value=>{
  if(typeof value!=='string')return null;
  try{const url=new URL(value);return url.protocol==='https:'?url.href:null;}catch{return null;}
};
// Pure: two addresses name one endpoint. The URL parser adds a trailing slash to a bare host, so both sides are normalised.
export const sameBase=(a,b)=>{try{return new URL(String(a).trim()).href===new URL(String(b).trim()).href;}catch{return false;}};

// Ollama status says only whether the server answers, not whether the model is pulled.
export function localCard(local){
  const model=ollamaModel(local.name),up=local.available===true;
  return {
    badge:up?'Detected':'Not detected',tone:up?'ok':'off',model,
    hint:up?(model?`If replies fail, the model may be missing. Run: ollama pull ${model}`:''):'Install Ollama from ollama.com and start it. Then pull the model.',
    copy:!up&&model?`ollama pull ${model}`:null,
    use:local.enabled===false?'Off. Cats will not use Local AI, and it is not in the Reasoning menu.':up?'Listed in the chat Reasoning menu.':'Not listed in the chat Reasoning menu until Ollama answers.',
  };
}

export function planCard(id,p){
  const plan=PLANS[id];
  const toggle={checked:p.enabled===true,disabled:p.installed!==true};
  const use=!p.enabled?'Off. Cats will not use this plan.':p.configured?'In use for cats.':'On, but cats cannot use it until it is signed in.';
  const base={title:plan.title,note:plan.note,toggle,use,model:''};
  if(!p.installed)return {...base,badge:'Not installed',tone:'off',hint:`Install ${plan.cli} to use this plan.`,copy:p.installHint||null,signIn:false};
  if(p.configured)return {...base,badge:'Signed in',tone:'ok',hint:'',copy:null,signIn:false};
  // Codex can report an API-key login; this plan needs a ChatGPT sign-in, so it is not ready.
  const apiKey=id==='chatgpt'&&p.loggedIn===true;
  return {...base,badge:apiKey?'Signed in with an API key':'Not signed in',tone:'warn',
    hint:apiKey?'This plan needs a ChatGPT sign-in, not an API key.':'Sign in once. The app starts the official sign-in and never reads your tokens.',
    copy:null,signIn:true};
}

export function hostedCard(h){
  const fromEnv=h.source==='env';
  return {
    badge:h.configured?'Ready':h.enabled?'Not ready':'Not set',
    tone:h.configured?'ok':h.enabled?'warn':'off',
    hint:[h.detail,fromEnv?'Set by CAT_MODEL environment variables. Saving here replaces them.':''].filter(Boolean).join(' '),
    keyLine:h.hasKey?(h.keyLast4?`Key saved ••••${h.keyLast4}`:'Key saved'):'No key saved',
    removable:h.source==='settings',
    use:h.configured?'Listed in the chat Reasoning menu.':'Not listed until a base, model and key are saved.',
  };
}

// Mirrors the server checks in src/models.ts so the owner sees the reason before a round trip.
// `saved` is the status hosted block: a blank key is reused only for the same saved endpoint.
export function hostedDraft(input,saved){
  const base=String(input.base??'').trim(),model=String(input.model??'').trim(),key=String(input.key??'').trim();
  let url;
  try{url=new URL(base);}catch{return {error:'Hosted base must be a full HTTPS URL.'};}
  if(url.protocol!=='https:')return {error:'Hosted providers require HTTPS.'};
  if(url.username||url.password||url.search||url.hash)return {error:'Hosted base must not contain a login, query or fragment.'};
  if(base.length>HOSTED_LIMITS.base)return {error:`Hosted base is longer than ${HOSTED_LIMITS.base} characters.`};
  if(!model)return {error:'Enter a model name.'};
  if(model.length>HOSTED_LIMITS.model)return {error:`Model name is longer than ${HOSTED_LIMITS.model} characters.`};
  if(key.length>HOSTED_LIMITS.key)return {error:`API key is longer than ${HOSTED_LIMITS.key} characters.`};
  const sameEndpoint=saved?.hasKey===true&&saved.base===url.href;
  if(!key&&!sameEndpoint)return {error:'Enter an API key for this endpoint.'};
  return {body:{base:url.href,model,...(key?{key}:{})}};
}

// Jev card: a typed-decision provider for approvals. The server returns only the last four key characters.
export function jevCard(j){
  const on=j?.enabled===true;
  return {
    badge:j?.available?'Ready':on?'Not ready':j?.hasKey?'Off':'Not set',
    tone:j?.available?'ok':on?'warn':'off',
    hint:j?.detail??'',
    keyLine:j?.hasKey?(j.keyLast4?`Key saved ••••${j.keyLast4}`:'Key saved'):'No key saved',
    removable:j?.hasKey===true,
  };
}

// auto: the link comes back to the CLI on this computer by itself, so there is no code to paste and the code box stays hidden.
export function loginMessage(result){
  const auto=result?.auto===true;
  const vpn=typeof result?.vpn==='string'?`A VPN is on (${result.vpn}). The sign-in page usually says it could not verify your browser over a VPN: turn the VPN off, then tap Sign in again. `:'';
  return {
    text:vpn+(auto?'The sign-in page opened in your browser. Click Authorize there, and Clowder finishes by itself.':result?.alreadyRunning?'A sign-in is already running. Finish it in the browser window that opened.':'Finish signing in in the browser window that opened.'),
    href:httpsLink(result?.url),
    auto,
    browsers:auto&&Array.isArray(result?.browsers)?result.browsers.filter(b=>b&&typeof b.id==='string'&&typeof b.name==='string'):[],
  };
}

// A sign-in note only shows while the plan is not signed in. Once it is, a stale note is dropped.
export const visibleLogin=(entry,plan)=>plan?.configured===true?null:(entry??null);

// The chat Reasoning menu changes only when one of these flips.
export const availabilityKey=s=>JSON.stringify([s.local?.available,s.hosted?.available,s.claude?.available,s.chatgpt?.available,s.anthropic?.available]);

// Provider order, with the short names the nav uses. The icons are decorative Lucide names from the sprite (icons.js).
export const PROVIDERS=[
  {id:'local',short:'Local AI',icon:'cpu'},
  {id:'claude',short:'Claude plan',icon:'sparkles'},
  {id:'chatgpt',short:'ChatGPT plan',icon:'bot'},
  {id:'hosted',short:'API key',icon:'key-round'},
  {id:'anthropic',short:'Anthropic',icon:'star'},
  {id:'jev',short:'Jev',icon:'list-checks'},
  // Hermes (experimental), the Mayor's sidecar (model-extras.js). Its nav item hides where its owner route answers 403.
  {id:'hermes',short:'Hermes',icon:'globe'},
  {id:'workshop',short:'Workshop',icon:'wrench'},
  // Images is the media group (media-settings.js). It has no status of its own, so it sorts last.
  {id:'images',short:'Images',icon:'image'},
];
// A card's status tone as the shared chip (style.css): ok is accent, warn is warm, error is danger, off stays neutral.
const CHIP={ok:'chip chip-accent',warn:'chip chip-warm',error:'chip chip-danger'};
export const chipClass=tone=>CHIP[tone]??'chip';
export const NAV_KEY='cat-town-models-provider';
// Pure: nav order by readiness. Ready first, then needs attention, then not set; ties keep PROVIDERS order.
const TONE_RANK={ok:0,warn:1,off:2};
export const providerOrder=tones=>PROVIDERS.map((p,i)=>({id:p.id,rank:TONE_RANK[tones?.[p.id]]??2,i})).sort((a,b)=>a.rank-b.rank||a.i-b.i).map(x=>x.id);
const THINKING_NAMES={local:'Local AI (Ollama)',claude:'Claude plan',chatgpt:'ChatGPT plan',hosted:'API key',anthropic:'Anthropic API'};

// Pure: the summary strip, "Claude plan · sonnet · effort high". It names the town default, the thinking every cat uses unless it has its own.
export function thinkingText(s){
  const td=s?.townDefault;
  if(!td)return 'Demonstration · scripted';
  const model=td.model??(td.provider==='hosted'?s?.hosted?.model:null);
  const text=[THINKING_NAMES[td.provider]??td.provider,model||'no model set',`effort ${td.effort??'not set'}`].join(' · ');
  return td.usable?text:`${text} · not ready`;
}

const el=(tag,props={},...children)=>{
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props)){
    if(key==='text')node.textContent=value;
    else if(value!==undefined&&value!==null&&value!==false)node.setAttribute(key,value===true?'':String(value));
  }
  node.append(...children.filter(child=>child!=null));
  return node;
};
const collect=section=>Object.fromEntries([...section.querySelectorAll('[data-role]')].map(node=>[node.dataset.role,node]));
const setText=(node,text)=>{node.textContent=text||'';node.hidden=!text;};
// A native checkbox kept for accessibility, drawn as a pill track with a sliding knob (see immersive.css).
const switchControl=(input,text)=>el('label',{class:'model-switch'},input,el('span',{class:'switch-track','aria-hidden':'true'}),el('span',{text}));
// A titled group inside a provider panel: Status & sign-in, Use for cats, Defaults.
const group=(title,...children)=>el('div',{class:'model-group'},el('h4',{class:'model-group-title',text:title}),...children);
// Long help sits behind a small disclosure so the status and the controls stay in view.
const more=text=>text?el('details',{class:'model-more'},el('summary',{text:'More info'}),el('p',{class:'model-note muted',text})):null;
// A preset chip: one tap fills the service's fields; the link opens its key page in a new tab. Two separate tap targets.
export function presetChip(preset,onFill){
  const fill=el('button',{type:'button',class:'preset-fill','aria-pressed':'false',text:preset.label});
  fill.onclick=()=>onFill(preset);
  const href=httpsLink(preset.keyUrl);
  return el('span',{class:'preset-chip'},fill,href?el('a',{class:'preset-key',href,target:'_blank',rel:'noopener noreferrer',text:'Get a key'},icon('external-link',{size:14})):null);
}
// The panel stylesheet, added once. It lives beside the component so immersive.css and index.html stay as they are.
export function ensureModelsPanelStyles(){
  if(typeof document==='undefined'||document.querySelector('link[data-models-panel-css]'))return;
  const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./models-panel.css',import.meta.url).href;link.setAttribute('data-models-panel-css','');document.head?.append(link);
}

// The owner-only workshop route answers 403 on paired and LAN devices; that reads as null, not an error.
async function readWorkshop(){
  const response=await fetch('/api/workshop',{cache:'no-store'});
  if(response.status===403)return null;
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data)throw new Error('Could not read the workshop.');
  return data;
}

// The owner-only status route answers 403 on paired and LAN devices; that reads as null, not an error.
async function readStatus(){
  const response=await fetch('/api/models/status',{cache:'no-store'});
  if(response.status===403)return null;
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data)throw new Error('Could not read AI model status.');
  return data;
}

// mode() returns the Reasoning choice the cats use in chat; the summary strip names it.
// catsWithOverride(provider) lists the cat ids that have their own choice for that provider; used by Use for all cats.
export function createModelsPanel({button,chip=null,dialog,body,api,onChanged=()=>{},catsWithOverride=()=>[]}){
  ensureModelsPanelStyles();
  let status=null,lastKey=null,pollTimer=0,pollUntil=0,polling=false,selected='local';
  const waiting=new Set(),pending={},cards={},tones={},navs={};
  const error=el('p',{id:'models-error',role:'status'});
  const setError=err=>{error.textContent=err?(err.message||String(err)):'';};
  const thinking=el('strong',{'data-role':'thinking'});

  // Default model and effort for one provider. Hosted has only an effort: its model lives in the hosted form.
  // The model is a select of every listed model, then Other…. Its options are rebuilt only when the list changes.
  function aiDefaultsPanel(id){
    const model=id==='hosted'?null:el('select',{'data-role':'ai-model-select'});
    const other=id==='hosted'?null:el('input',{type:'text',autocomplete:'off',spellcheck:'false',maxlength:120,hidden:true,placeholder:'Model name','aria-label':'Other model name','data-role':'ai-model-other'});
    if(model)wireModelPicker(model,other);
    const section=el('div',{class:'model-ai model-group','data-role':'ai',hidden:true},
      el('h4',{class:'model-group-title',text:'Defaults'}),
      more('The default for every cat without its own choice.'),
      model?el('label',{},'Default model',model,other):null,
      el('label',{},'Default effort',el('select',{'data-role':'ai-effort'})),
      el('p',{class:'model-error','data-role':'ai-error',role:'status'}),
      el('div',{class:'dialog-actions'},el('button',{type:'button','data-role':'ai-save',text:'Save defaults'})),
      el('p',{class:'model-use muted','data-role':'ai-using'}));
    return {section,r:collect(section)};
  }
  const aiPanels={local:aiDefaultsPanel('local'),claude:aiDefaultsPanel('claude'),chatgpt:aiDefaultsPanel('chatgpt'),hosted:aiDefaultsPanel('hosted'),anthropic:aiDefaultsPanel('anthropic')};
  // The "Use for all cats" button: hidden until the provider is on and ready (see paintUseAll).
  const useAllNode=()=>el('button',{type:'button',hidden:true,'data-role':'use-all',text:'Use for all cats'});

  // One provider panel: status first, then the use switch, then defaults, with help behind More info.
  function makeCard(id,title,{note='',statusNodes=[],useNodes=[],defaults=null}={}){
    const section=el('section',{class:'model-card','data-card':id,'aria-labelledby':`models-${id}-title`,hidden:true},
      el('div',{class:'model-head'},el('h3',{id:`models-${id}-title`,text:title}),el('span',{class:'chip','data-role':'badge'})),
      group('Status & sign-in',
        el('p',{class:'model-detail','data-role':'model'}),
        el('p',{class:'model-detail','data-role':'hint'}),
        el('div',{class:'model-copy','data-role':'copy'},el('code',{'data-role':'copy-text'}),el('button',{type:'button','data-role':'copy-button',text:'Copy'})),
        ...statusNodes),
      group('Use for cats',...useNodes,el('p',{class:'model-use muted','data-role':'use'})),
      defaults,
      more(note));
    return {section,r:collect(section)};
  }
  function planCardNodes(id){
    const signIn=el('button',{type:'button','data-role':'signin',text:PLANS[id].signIn});
    const login=el('div',{class:'model-login','data-role':'login',role:'status'},
      el('p',{'data-role':'login-text'}),el('a',{'data-role':'login-link',class:'model-open',target:'_blank',rel:'noopener noreferrer',text:'Open sign-in page'}),
      // When the sign-in site cannot verify this browser, the link pasted into Chrome or Edge finishes the same sign-in.
      el('button',{type:'button','data-role':'login-copy',text:'Copy link'}),
      el('p',{class:'model-login-hint',text:'If the page says it could not verify your browser, open it in another browser (not a private window, VPN and ad blocker off).'}),
      el('div',{class:'model-login-browsers','data-role':'login-browsers'}),
      el('form',{class:'model-login-code','data-role':'login-code'},
        el('label',{text:'If the browser shows an authentication code, paste it here:'},el('input',{type:'text','data-role':'login-code-input',autocomplete:'off',spellcheck:'false',maxlength:'600'})),
        el('button',{type:'submit',text:'Submit code'})));
    const toggle=el('input',{type:'checkbox',role:'switch','data-role':'toggle'});
    return makeCard(id,PLANS[id].title,{note:PLANS[id].note,statusNodes:[el('div',{class:'model-actions'},signIn),login],useNodes:[switchControl(toggle,'Use for cats'),useAllNode()],defaults:aiPanels[id].section});
  }

  const localToggle=el('input',{type:'checkbox',role:'switch','data-role':'toggle'});
  cards.local=makeCard('local','Local AI (Ollama)',{note:'Runs on this computer. Listed only while Ollama answers.',useNodes:[switchControl(localToggle,'Use for cats'),useAllNode()],defaults:aiPanels.local.section});
  cards.claude=planCardNodes('claude');
  cards.chatgpt=planCardNodes('chatgpt');
  const hostedForm=el('form',{class:'model-form model-grid',autocomplete:'off',novalidate:true,'data-role':'form'},
    el('label',{class:'model-cell model-wide'},el('span',{text:'HTTPS base URL'}),el('input',{name:'base',type:'text',inputmode:'url',autocomplete:'off',spellcheck:'false',placeholder:'https://api.example.com/v1',maxlength:HOSTED_LIMITS.base})),
    el('label',{class:'model-cell'},el('span',{text:'Model'}),el('input',{name:'model',type:'text',autocomplete:'off',spellcheck:'false',placeholder:'Model name',maxlength:HOSTED_LIMITS.model})),
    el('label',{class:'model-cell'},el('span',{text:'API key'}),el('input',{name:'key',type:'password',autocomplete:'off',spellcheck:'false',autocapitalize:'off',placeholder:'Paste a new key',maxlength:HOSTED_LIMITS.key})),
    el('p',{class:'model-error model-wide','data-role':'form-error',role:'status'}),
    el('div',{class:'model-actions model-wide'},el('button',{type:'button','data-role':'remove',text:'Remove key'}),el('button',{type:'submit',class:'primary','data-role':'save',text:'Save'})));
  // The presets come from the status (src/models.ts). They are drawn once and redrawn only if the list changes.
  const presetRow=el('div',{class:'preset-row','data-role':'presets'});
  let presetButtons=[],presetKey='';
  const hostedSection=el('section',{class:'model-card','data-card':'hosted','aria-labelledby':'models-hosted-title',hidden:true},
    el('div',{class:'model-head'},el('h3',{id:'models-hosted-title',text:'API key'}),el('span',{class:'chip','data-role':'badge'})),
    group('Status & sign-in',
      el('p',{class:'model-detail','data-role':'hint'}),
      el('p',{class:'model-key','data-role':'key'})),
    group('Connect a service',
      el('p',{class:'model-detail muted',text:'Pick a service to fill its address and model, then paste your key.'}),
      presetRow,
      hostedForm),
    group('Use for cats',useAllNode(),el('p',{class:'model-use muted','data-role':'use'})),
    aiPanels.hosted.section,
    more('Works with any service that has an OpenAI-style chat endpoint over HTTPS: pick one above or enter its address. Your provider may charge for use.'));
  const hosted=collect(hostedSection);
  const fields=hostedForm.elements;
  fields.base.addEventListener('input',paintPresets);
  // A preset fills the address and model, then the key is pasted. The chip whose address matches the form is pressed.
  function fillHosted(preset){
    fields.base.value=preset.base;fields.model.value=preset.model;
    hosted['form-error'].textContent='';paintPresets();fields.key.focus();
  }
  function paintPresets(){
    for(const {preset,chip} of presetButtons)chip.querySelector('.preset-fill').setAttribute('aria-pressed',String(sameBase(fields.base.value,preset.base)));
  }
  function paintPresetList(list){
    const key=JSON.stringify(list);
    if(key===presetKey)return;
    presetKey=key;
    presetButtons=list.map(preset=>({preset,chip:presetChip(preset,fillHosted)}));
    presetRow.replaceChildren(...presetButtons.map(b=>b.chip));
    paintPresets();
  }
  const jevToggle=el('input',{type:'checkbox',role:'switch','data-role':'toggle'});
  const jevForm=el('form',{class:'model-form',autocomplete:'off',novalidate:true,'data-role':'form'},
    el('label',{},'Jev API key',el('input',{name:'key',type:'password',autocomplete:'off',spellcheck:'false',autocapitalize:'off',placeholder:'Paste a new key',maxlength:HOSTED_LIMITS.key})),
    el('p',{class:'model-error','data-role':'form-error',role:'status'}),
    el('div',{class:'dialog-actions'},el('button',{type:'button','data-role':'remove',text:'Remove key'}),el('button',{type:'submit',class:'primary','data-role':'save',text:'Save'})));
  const jevSection=el('section',{class:'model-card','data-card':'jev','aria-labelledby':'models-jev-title',hidden:true},
    el('div',{class:'model-head'},el('h3',{id:'models-jev-title',text:'Jev decisions'}),el('span',{class:'chip','data-role':'badge'})),
    group('Status & sign-in',
      el('p',{class:'model-detail','data-role':'hint'}),
      el('p',{class:'model-key','data-role':'key'}),
      jevForm),
    group('Use for cats',switchControl(jevToggle,'Use for approvals')),
    more('Fast typed decisions for approvals; LLMs still do open-ended work.'));
  const jev=collect(jevSection);
  // Owner only: the nav item and chip stay hidden when the workshop route answers 403.
  const workshopSection=el('section',{class:'model-card','data-card':'workshop','aria-labelledby':'models-workshop-title',hidden:true},
    el('div',{class:'model-head'},el('h3',{id:'models-workshop-title',text:'Workshop'}),el('span',{class:'chip','data-role':'badge'})),
    group('Status & sign-in',
      el('p',{class:'model-detail','data-role':'distro'}),
      el('p',{class:'model-detail','data-role':'isolated'}),
      el('p',{class:'model-detail','data-role':'hint'}),
      el('div',{class:'model-copy','data-role':'command'},el('code',{'data-role':'command-text'})),
      el('p',{class:'model-detail','data-role':'setup-state',role:'status'}),
      el('ul',{class:'muted','data-role':'setup-lines'}),
      el('p',{class:'model-detail','data-role':'wsl-message'}),
      el('div',{class:'model-copy'},
        el('button',{type:'button','data-role':'create',text:'Create workshop'}),
        el('button',{type:'button','data-role':'install-wsl',text:'Install WSL'})),
      el('p',{class:'model-error','data-role':'workshop-error',role:'status'}),
      el('ul',{'data-role':'tools'})),
    group('Settings',
      switchControl(el('input',{type:'checkbox','data-role':'auto-setup'}),'Set up the workshop automatically when Clowder starts'),
      switchControl(el('input',{type:'checkbox','data-role':'long-jobs'}),'Allow runs of up to 15 minutes for tools that declare a long run')),
    more('Approved tools are installed and run only inside the cat-workshop WSL distro, never on Windows. The workshop is set up in the background when WSL is present; Create workshop retries it by hand.'));
  const workshop=collect(workshopSection);
  // Anthropic API key and Hermes (experimental): their cards live in model-extras.js.
  const anthropic=createAnthropicSection({api,onStatus:s=>applyStatus(s),defaults:aiPanels.anthropic.section,useAll:useAllNode()});
  const anth=collect(anthropic.section);
  const hermes=createHermesSection({api});

  // One provider switcher: the nav (a left list on desktop, a scrolling tab row on phones).
  // The Images tab has no section here: its group is #media-settings, shown by CSS when body[data-tab=images] (see models-panel.css).
  const sections={local:cards.local.section,claude:cards.claude.section,chatgpt:cards.chatgpt.section,hosted:hostedSection,anthropic:anthropic.section,jev:jevSection,hermes:hermes.section,workshop:workshopSection,images:null};
  const dot=()=>el('i',{class:'model-dot','aria-hidden':'true'});
  const navItems=PROVIDERS.map(p=>{
    const navDot=dot();
    if(p.id==='images')navDot.hidden=true;
    const item=el('button',{type:'button','data-nav':p.id,'aria-controls':`models-panel-${p.id}`},
      el('span',{class:'models-nav-icon','aria-hidden':'true'},icon(p.icon,{size:18})),el('span',{class:'models-nav-name',text:p.short}),navDot);
    item.onclick=()=>choose(p.id);
    navs[p.id]={button:item,dot:navDot};
    return item;
  });
  const summary=el('div',{class:'models-summary'},
    el('p',{class:'models-thinking'},el('span',{class:'models-thinking-label',text:'Cats are thinking with:'}),' ',thinking));
  for(const p of PROVIDERS)if(sections[p.id])sections[p.id].id=`models-panel-${p.id}`;
  const navBox=el('nav',{class:'models-nav','aria-label':'AI providers'},...navItems);
  const detail=el('div',{class:'models-detail'},...PROVIDERS.map(p=>sections[p.id]));
  body.replaceChildren(summary,error,el('div',{class:'models-shell'},navBox,detail));

  // One provider at a time. A hidden provider (workshop, owner-only) falls back to Local AI.
  function choose(id,{remember=true}={}){
    if(!navs[id]||navs[id].button.hidden)id='local';
    selected=id;
    body.dataset.tab=id;
    for(const p of PROVIDERS){
      const on=p.id===id;
      if(sections[p.id])sections[p.id].hidden=!on;
      navs[p.id].button.setAttribute('aria-pressed',String(on));
      navs[p.id].button.classList.toggle('active',on);
    }
    if(remember)try{localStorage.setItem(NAV_KEY,id);}catch{/* private window: the choice is not remembered */}
  }
  // The nav and its sections follow readiness. The order is rewritten only when it changes, so a focused tab does not move on every poll.
  let navOrder='';
  function paintTones(){
    for(const p of PROVIDERS)navs[p.id].dot.dataset.tone=tones[p.id]??'off';
    // Every card's status reads as a chip, including the two model-extras.js paints: the tone it set picks the variant.
    for(const s of Object.values(sections)){const b=s?.querySelector('[data-role="badge"]');if(b)b.className=chipClass(b.dataset.tone);}
    const order=providerOrder(tones),key=order.join(',');
    if(key===navOrder)return;
    navOrder=key;
    for(const id of order){navBox.append(navs[id].button);if(sections[id])detail.append(sections[id]);}
  }

  function paintCommon(node,c){
    node.badge.textContent=c.badge;node.badge.dataset.tone=c.tone;
    setText(node.hint,c.hint);setText(node.model,c.model?`Model: ${c.model}`:'');setText(node.use,c.use);
    node.copy.hidden=!c.copy;node['copy-text'].textContent=c.copy||'';
  }
  // Efforts and model names come from the server. The lists are rebuilt only when they change, never on a status poll.
  const blankModel=block=>`Not set · now ${block?.default?.model??'none'}`;
  function paintAi(id,s){
    const p=aiPanels[id],block=s[id]?.ai;
    p.section.hidden=!block;
    if(!block)return;
    const key=JSON.stringify([block.efforts,block.models??[],block.default?.model??null]);
    if(p.r['ai-effort'].dataset.key!==key){
      p.r['ai-effort'].replaceChildren(...effortChoices(block.efforts,'Not set').map(c=>new Option(c.label,c.value)));
      p.r['ai-effort'].dataset.key=key;
      if(p.r['ai-model-select']){
        const select=p.r['ai-model-select'],previous=select.value;
        select.replaceChildren(...modelOptions(block.models??[],blankModel(block)).map(o=>new Option(o.label,o.value)));
        select.value=[...select.options].some(o=>o.value===previous)?previous:'';
      }
    }
    p.r['ai-using'].textContent=usingText(block);
  }
  function loadAi(id,s){
    const p=aiPanels[id],block=s?.[id]?.ai,saved=block?.saved??{};
    if(p.r['ai-model-select'])paintModelPicker(p.r['ai-model-select'],p.r['ai-model-other'],{models:block?.models??[],value:saved.model??'',blankLabel:blankModel(block)});
    p.r['ai-effort'].value=saved.effort??'';
  }
  async function saveAi(id){
    const p=aiPanels[id];
    p.r['ai-error'].textContent='';
    const model=p.r['ai-model-select']?readModelPicker(p.r['ai-model-select'],p.r['ai-model-other']):'';
    const draft=aiDraft(id,{model,effort:p.r['ai-effort'].value},status?.[id]?.ai);
    if(draft.error){p.r['ai-error'].textContent=draft.error;return;}
    await savingButton(p.r['ai-save'],api('models/settings',{defaults:{[id]:draft.body}}).then(s=>{applyStatus(s);loadAi(id,status);}),{errorNode:p.r['ai-error']});
  }
  for(const id of Object.keys(aiPanels))aiPanels[id].r['ai-save'].onclick=()=>saveAi(id);

  // Shows the button only when this provider is on and ready.
  function paintUseAll(node,entry){node['use-all'].hidden=!(entry?.enabled===true&&entry?.available===true);}
  function paintPlan(id,s){
    const node=cards[id].r,c=planCard(id,s[id]);
    paintCommon(node,c);
    tones[id]=c.tone;
    node.toggle.checked=c.toggle.checked;node.toggle.disabled=c.toggle.disabled;
    node.signin.hidden=!c.signIn;
    if(!c.signIn)pending[id]=null;
    const entry=visibleLogin(pending[id],s[id]);
    if(!entry)pending[id]=null;
    if(s[id]?.configured===true)waiting.delete(id);
    node.login.hidden=!entry;
    if(entry){
      node['login-text'].textContent=entry.text;
      const link=node['login-link'];
      link.hidden=node['login-copy'].hidden=!entry.href;
      if(entry.href)link.href=entry.href;
      link.textContent=entry.auto?'Open the sign-in page again':'Open sign-in page';
      node['login-code'].hidden=!!entry.auto;
      // One button per other installed browser; each opens the same no-paste page there.
      node['login-browsers'].replaceChildren(...(entry.browsers||[]).map(b=>{
        const button=el('button',{type:'button',text:`Open in ${b.name}`});
        button.onclick=()=>api(`models/${id}/login/open`,{browser:b.id}).catch(setError);
        return button;
      }));
    }
    paintUseAll(node,s[id]);
  }
  // Paints only status text, chips and buttons. The hosted inputs are never written here, so typing survives a poll.
  function paint(s){
    status=s;
    const lc=localCard(s.local);
    paintCommon(cards.local.r,lc);
    tones.local=lc.tone;
    cards.local.r.toggle.checked=s.local?.enabled!==false;
    paintUseAll(cards.local.r,s.local);
    paintPlan('claude',s);
    paintPlan('chatgpt',s);
    for(const id of Object.keys(aiPanels))paintAi(id,s);
    paintPresetList(Array.isArray(s.hosted?.presets)?s.hosted.presets:[]);
    const c=hostedCard(s.hosted);
    hosted.badge.textContent=c.badge;hosted.badge.dataset.tone=c.tone;tones.hosted=c.tone;
    setText(hosted.hint,c.hint);setText(hosted.use,c.use);
    hosted.key.textContent=c.keyLine;
    hosted.remove.hidden=!c.removable;
    paintUseAll(hosted,s.hosted);
    const j=jevCard(s.jev);
    jev.badge.textContent=j.badge;jev.badge.dataset.tone=j.tone;tones.jev=j.tone;
    setText(jev.hint,j.hint);
    jev.key.textContent=j.keyLine;
    jevToggle.checked=s.jev?.enabled===true;
    jev.remove.hidden=!j.removable;
    tones.anthropic=anthropic.paint(s).tone;
    paintUseAll(anth,s.anthropic);
    thinking.textContent=thinkingText(s);
    paintTones();
  }
  // Any change to the status (a save, a sign-in, a default) tells the app, so the chat menu and cat pickers repaint.
  function applyStatus(s){
    paint(s);
    const key=JSON.stringify(s),changed=lastKey!==null&&key!==lastKey;
    lastKey=key;
    if(changed)onChanged();
  }

  async function setPlanEnabled(id,toggle){
    const enabled=toggle.checked;
    toggle.disabled=true;setError('');
    try{applyStatus(await api('models/settings',{[id]:{enabled}}));}
    catch(err){setError(err);}
    finally{if(status)paint(status);}
  }

  // Sets this provider and its default model as the town's default thinking. Ticking the box also clears every cat's own choice for it.
  async function useForAllCats(id,button){
    const block=status?.[id]?.ai;
    if(!block)return;
    const name=THINKING_NAMES[id];
    const body={provider:id,model:block.default?.model??null,effort:block.default?.effort??null};
    const box={label:'Also reset each cat’s own model choice',checked:false};
    const ok=await confirmDialog({title:`Use ${name} for all cats?`,message:`${name}${body.model?` with ${body.model}`:''} becomes what every cat thinks with, unless a cat has its own choice.`,confirmLabel:'Use for all cats',checkbox:box});
    if(!ok)return;
    setError('');button.disabled=true;
    try{
      applyStatus(await api('models/settings',{townDefault:body}));
      if(box.checked)for(const catId of catsWithOverride(id))await api(`cats/${encodeURIComponent(catId)}/ai`,{provider:id,model:null,effort:null});
      onChanged();
    }catch(err){setError(err);}
    finally{button.disabled=false;}
  }
  async function submitCode(id,form){
    const input=form.querySelector('[data-role=login-code-input]'),button=form.querySelector('button');
    const code=input.value.trim();if(!code)return;
    button.disabled=true;setError('');
    try{await api(`models/${id}/login/code`,{code});input.value='';pending[id]={text:'Code sent. Finishing sign-in…',href:null};if(status)paint(status);}
    catch(err){setError(err);}
    finally{button.disabled=false;}
  }

  async function startSignIn(id,buttonEl){
    buttonEl.disabled=true;buttonEl.textContent='Starting sign-in…';setError('');
    try{
      pending[id]=loginMessage(await api(`models/${id}/login`,{}));
      waiting.add(id);startPolling();
      if(status)paint(status);
    }catch(err){setError(err);}
    finally{buttonEl.disabled=false;buttonEl.textContent=PLANS[id].signIn;}
  }

  // Re-polls every 3 s for up to 2 minutes after a sign-in click, and stops early once that plan reports ready.
  function startPolling(){
    pollUntil=Date.now()+POLL_WINDOW_MS;
    if(!pollTimer)pollTimer=setInterval(poll,POLL_MS);
  }
  function stopPolling(){clearInterval(pollTimer);pollTimer=0;waiting.clear();}
  async function poll(){
    if(polling)return;
    if(Date.now()>=pollUntil||waiting.size===0){stopPolling();return;}
    polling=true;
    try{
      const s=await readStatus();
      if(s){
        applyStatus(s);
        for(const id of [...waiting])if(s[id]?.configured)waiting.delete(id);
      }
    }catch{/* the next tick retries */}
    finally{polling=false;}
  }

  async function saveHosted(event){
    event.preventDefault();
    const draft=hostedDraft({base:fields.base.value,model:fields.model.value,key:fields.key.value},status?.hosted);
    if(draft.error){hosted['form-error'].textContent=draft.error;return;}
    hosted['form-error'].textContent='';
    await savingButton(hosted.save,api('models/settings',{hosted:draft.body}).then(s=>{applyStatus(s);fields.key.value='';}),{errorNode:hosted['form-error']});
  }
  async function removeHosted(){
    hosted['form-error'].textContent='';hosted.remove.disabled=true;
    try{
      applyStatus(await api('models/settings',{hosted:null}));
      fields.base.value='';fields.model.value='';fields.key.value='';paintPresets();
    }catch(err){hosted['form-error'].textContent=err.message||String(err);}
    finally{hosted.remove.disabled=false;}
  }

  async function setJevEnabled(){
    jev['form-error'].textContent='';jevToggle.disabled=true;
    try{applyStatus(await api('models/settings',{jev:{enabled:jevToggle.checked}}));}
    catch(err){jev['form-error'].textContent=err.message||String(err);jevToggle.checked=!jevToggle.checked;}
    finally{jevToggle.disabled=false;}
  }
  async function saveJev(event){
    event.preventDefault();
    const key=String(jevForm.elements.key.value).trim();
    if(!key&&status?.jev?.hasKey!==true){jev['form-error'].textContent='Enter an API key for Jev.';return;}
    jev['form-error'].textContent='';
    await savingButton(jev.save,api('models/settings',{jev:{enabled:jevToggle.checked,...(key?{key}:{})}}).then(s=>{applyStatus(s);jevForm.elements.key.value='';}),{errorNode:jev['form-error']});
  }
  async function removeJev(){
    jev['form-error'].textContent='';jev.remove.disabled=true;
    try{applyStatus(await api('models/settings',{jev:null}));jevForm.elements.key.value='';}
    catch(err){jev['form-error'].textContent=err.message||String(err);}
    finally{jev.remove.disabled=false;}
  }
  jevToggle.onchange=setJevEnabled;
  jevForm.onsubmit=saveJev;
  jev.remove.onclick=removeJev;

  function setWorkshopError(err){setText(workshop['workshop-error'],err?(err.message||String(err)):'');}
  function paintWorkshop(w){
    const c=workshopCard(w);
    workshop.badge.textContent=c.badge;workshop.badge.dataset.tone=c.tone;tones.workshop=c.tone;
    setText(workshop.distro,`cat-workshop distro installed: ${c.distro}`);
    setText(workshop.isolated,`Isolated: ${c.isolated}`);
    setText(workshop.hint,c.hint);
    workshop.command.hidden=!c.command;workshop['command-text'].textContent=c.command||'';
    setText(workshop['workshop-error'],c.error);
    setText(workshop['setup-state'],c.setup.running?'Setting up now. This can take a while.':c.setup.failure?`Setup did not finish: ${c.setup.failure}`:'');
    workshop['setup-lines'].replaceChildren(...c.setup.lines.map(line=>el('li',{text:line})));
    workshop['setup-lines'].hidden=!c.setup.lines.length;
    setText(workshop['wsl-message'],c.setup.wslMessage||(c.setup.wsl==='missing'?WSL_CONFIRM:''));
    workshop.create.hidden=!c.setup.canCreate&&!c.setup.running;workshop.create.disabled=!c.setup.canCreate;
    workshop['install-wsl'].hidden=!c.setup.canInstallWsl;workshop['install-wsl'].disabled=!c.setup.canInstallWsl;
    workshop['auto-setup'].checked=c.autoSetup;workshop['long-jobs'].checked=c.allowLongJobs;
    workshop.tools.replaceChildren(...(c.tools.length?c.tools.map(t=>el('li',{'data-tool':t.id},
      el('span',{text:`${t.label} · ${t.stateLabel}`}),
      t.recipe?el('small',{class:'muted',text:` ${t.recipe.description}${t.recipe.long?' (long run)':''}`}):null,
      t.action?el('button',{type:'button','data-install':t.id,disabled:!t.installable,text:'Install'}):null,
      t.decidable?el('button',{type:'button','data-recipe':t.id,'data-approved':'true',text:'Approve recipe'}):null,
      t.decidable?el('button',{type:'button','data-recipe':t.id,'data-approved':'false',text:'Reject recipe'}):null,
      t.reason?el('small',{class:'muted',text:` ${t.reason}`}):null)):[el('li',{class:'muted',text:'No approved tools yet.'})]));
    paintTones();
    // Setup runs in the background. Show one note when it starts, and check again until it ends.
    if(c.setup.running&&!workshopRunningSeen){workshopRunningSeen=true;showToast(SETUP_TOAST);}
    if(!c.setup.running)workshopRunningSeen=false;
    if(c.setup.running&&!workshopTimer)workshopTimer=setTimeout(()=>{workshopTimer=null;refreshWorkshop();},3000);
  }
  let workshopRunningSeen=false,workshopTimer=null;
  // A small note that never blocks anything. It goes away on its own.
  function showToast(text){
    const note=el('div',{role:'status',text});
    note.style.cssText='position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:12px;background:#2b2233;color:#fff;font-size:14px;z-index:9999;';
    document.body.append(note);
    setTimeout(()=>note.remove(),4000);
  }
  // The nav item and chip appear only when the owner route answers; a hidden workshop that was selected falls back.
  async function refreshWorkshop(){
    try{
      const w=await readWorkshop();
      navs.workshop.button.hidden=w===null;
      if(w===null&&selected==='workshop')choose('local',{remember:false});
      if(w)paintWorkshop(w);
    }catch(err){setWorkshopError(err);}
  }
  async function installTool(id,button){
    button.disabled=true;button.textContent='Installing…';setWorkshopError('');
    try{await api('workshop/install',{id});}
    catch(err){setWorkshopError(err);}
    finally{await refreshWorkshop();}
  }
  async function createWorkshop(button){
    if(!window.confirm(SETUP_CONFIRM))return;
    button.disabled=true;setWorkshopError('');
    try{await api('workshop/setup',{});showToast(SETUP_TOAST);}
    catch(err){setWorkshopError(err);}
    finally{await refreshWorkshop();}
  }
  async function installWsl(button){
    if(!window.confirm(WSL_CONFIRM))return;
    button.disabled=true;setWorkshopError('');
    try{await api('workshop/install-wsl',{confirm:true});}
    catch(err){setWorkshopError(err);}
    finally{await refreshWorkshop();}
  }
  async function saveWorkshopSetting(body){
    setWorkshopError('');
    try{await api('workshop/settings',body);}
    catch(err){setWorkshopError(err);}
    finally{await refreshWorkshop();}
  }
  async function decideRecipe(id,approved,button){
    button.disabled=true;setWorkshopError('');
    try{await api('workshop/recipe',{id,approved,reason:approved?'Approved by the owner in AI models.':'Rejected by the owner in AI models.'});}
    catch(err){setWorkshopError(err);}
    finally{await refreshWorkshop();}
  }
  workshop.create.onclick=()=>createWorkshop(workshop.create);
  workshop['install-wsl'].onclick=()=>installWsl(workshop['install-wsl']);
  workshop['auto-setup'].onchange=()=>saveWorkshopSetting({autoSetup:workshop['auto-setup'].checked});
  workshop['long-jobs'].onchange=()=>saveWorkshopSetting({allowLongJobs:workshop['long-jobs'].checked});
  workshop.tools.onclick=event=>{
    const b=event.target.closest?.('[data-install]');if(b)installTool(b.dataset.install,b);
    const r=event.target.closest?.('[data-recipe]');if(r)decideRecipe(r.dataset.recipe,r.dataset.approved==='true',r);
  };

  for(const id of ['claude','chatgpt']){
    const r=cards[id].r;
    r.signin.onclick=()=>startSignIn(id,r.signin);
    r['login-code'].onsubmit=event=>{event.preventDefault();submitCode(id,r['login-code']);};
    r['login-copy'].onclick=async()=>{
      try{await navigator.clipboard.writeText(r['login-link'].href);r['login-copy'].textContent='Copied';setTimeout(()=>{r['login-copy'].textContent='Copy link';},1500);}
      catch{setError('Press and hold Open sign-in page to copy its link.');}
    };
    r.toggle.onchange=()=>setPlanEnabled(id,r.toggle);
  }
  cards.local.r.toggle.onchange=()=>setPlanEnabled('local',cards.local.r.toggle);
  for(const [id,node] of [['local',cards.local.r],['claude',cards.claude.r],['chatgpt',cards.chatgpt.r],['hosted',hosted],['anthropic',anth]])node['use-all'].onclick=()=>useForAllCats(id,node['use-all']);
  for(const card of Object.values(cards))card.r['copy-button'].onclick=async()=>{
    const node=card.r['copy-button'];
    try{await navigator.clipboard.writeText(card.r['copy-text'].textContent);node.textContent='Copied';setTimeout(()=>{node.textContent='Copy';},1500);}
    catch{setError('Select the command and copy it by hand.');}
  };
  hostedForm.onsubmit=saveHosted;
  hosted.remove.onclick=removeHosted;

  async function open(){
    setError('');fields.key.value='';
    dialog.showModal();
    try{
      const s=await readStatus();
      if(!s){setError('AI model settings are managed on the host computer.');return;}
      if(s.hosted.source==='settings'){fields.base.value=s.hosted.base??'';fields.model.value=s.hosted.model??'';}
      paintPresets();
      applyStatus(s);
      for(const id of Object.keys(aiPanels))loadAi(id,s);
      refreshWorkshop();
      refreshHermes();
    }catch(err){setError(err);}
  }
  // Hermes reads its own owner route; a device that may not see it never gets the nav item.
  async function refreshHermes(){
    const h=await hermes.refresh();
    navs.hermes.button.hidden=h.denied;
    if(h.denied&&selected==='hermes')choose('local',{remember:false});
    tones.hermes=h.tone;paintTones();
  }
  button.onclick=open;
  // The header chip only opens the same panel; it appears with the ☰ entry, so both are owner-only.
  if(chip)chip.onclick=()=>button.click();

  // Shows the button only when the owner route answers, so paired and LAN devices never see it.
  async function probe(){
    try{
      const s=await readStatus();
      if(s){status=s;lastKey=JSON.stringify(s);button.hidden=false;if(chip)chip.hidden=false;}
    }catch{/* stays hidden */}
  }
  // The last provider the owner chose, or Local AI.
  let remembered=null;
  try{remembered=localStorage.getItem(NAV_KEY);}catch{/* no storage: start on Local AI */}
  choose(PROVIDERS.some(p=>p.id===remembered)?remembered:'local',{remember:false});
  return {probe};
}

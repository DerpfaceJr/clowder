import {oneLiner} from './one-liner.js';
import {TIMES} from './time-of-day.js';
import {WEATHERS} from './weather-names.js';
import {QUALITIES,QUALITY_KEY,savedQuality} from './quality.js';
import {formatFunds,chatTokens,formatTokens,usedTokens,treasuryMode,saveTreasuryMode,treasuryText,treasuryShort,setVaultLine,tokensUsedHtml} from './treasury-view.js';
import {initSeasonPanel,setSeasonHost} from './season-panel.js';
import {createStudio} from './studio.js';
import {humanizeText} from './humanize-ids.js';
import {memorialRows,memorialPanel} from './memorial.js';
import {createMemorialView} from './memorial-view.js';
import {createMemorialTransition} from './memorial-transition.js';
import {createModelsPanel} from './models-panel.js';
import {createConnectorsPanel,approvalDetail} from './connectors-panel.js';
import {followText} from './devices-status.js';
import {addressNote,createRemotePath,remoteStatusText} from './remote-path.js';
import {createStepUp,passkeyControls} from './step-up.js';
import {createComposer} from './chat-composer.js';
import {aiDraft,startingReasoning,effortChoices,paintModelPicker,parseReasoning,providerChoices,readModelPicker,reasoningGroups,suggestionText,usingText,savingButton,wireModelPicker} from './ai-settings.js';
import {demoCats,isDemo,demoReply,DEMO_REPLY_NOTE} from './demo-state.js';
import {asideClass,asideLabel,inboxCount,inboxNote,mountAskToggle,syncAskToggle} from './ask-mayor.js';
import {attachScrollLatest,distanceFromBottom} from './scroll-latest.js';
import {goalRound,roundStarted} from './town-events.js';
import {taskCatOf} from './town-events.js';
// Owner-only status route, read once and dropped whenever the models change. Viewers never get it.
let aiCatalog=null,aiCatalogVersion=0,catAiKey='';
import {createProjectsPanel,goalBannerText,el} from './projects-panel.js';
import {createQuestsPanel,badgeLabel,chatHtml,splitNeeds} from './quests-panel.js';
import {nounOf} from './plain-words.js';
import {COMPACT_QUERY,initSheet,initTownMenu,initHouseNames,initInstallApp,initPaneLayout,waitingLead} from './mobile-ui.js';
import {initSound,linkFromHash} from './notify.js';
import {maybePromptNotifications} from './notify-prompt.js';
import './autonomy-settings.js';
import './backup-settings.js';
import './restore-dialog.js';
import {initCatSettingsFlyout,settingsTitle} from './cat-settings-flyout.js';
import {confirmDialog} from './dialogs.js';
import {initWorldsPanel} from './worlds-panel.js';
import {createWorldTravel} from './world-travel.js';
import {createGalleryView,galleryAvailable,artifactParts,artifactNodes} from './gallery-view.js';
import {createArchiveView} from './archive-view.js';
import {createMediaSettings} from './media-settings.js';
import {catGroups,groupIsOpen} from './cat-groups.js';
import {applyFrame,catTasks,chatMessages,createGate} from './state-delta.js';
import {initRoutinesPanel} from './routines-panel.js';
import {createTelegramPanel} from './telegram-panel.js';
import {initMemoryPanel} from './memory-panel.js';
import {initUsagePanel} from './usage-panel.js';
import {createDiscordPanel} from './discord-panel.js';
import {createAccountsPanel} from './accounts-panel.js';
import {initOwnerClientsPanel} from './owner-clients-panel.js';
import {initMailWatchPanel} from './mail-watch-panel.js';
import {initNtfyPanel} from './ntfy-panel.js';
import {initCommandPalette} from './command-palette.js';
import {probeHermes,withHermes} from './model-extras.js';
import {initComposerOptions,initTabsOverflow,paintBrainCard,fitComposer,pinComposer} from './chat-sheet.js';
import {nameDockButton,DECISIONS} from './dock-names.js';
import {createChatThread} from './chat-thread.js';
import {createDecisionStrip,isRefusal} from './decision-strip.js';
import {openSettingsPage} from './settings-menu.js';
import {createManage,townStatus} from './manage.js';
import {createPostOffice} from './post-office.js';
import {initMoonvault} from './moonvault.js';
const $=id=>document.getElementById(id);
const askToggle=mountAskToggle($('chat-form'),()=>{if(state)render();});
// One Options chip holds the goal, reply and ask toggles; tabs that do not fit go under More (chat-sheet.js, plan 5.6).
const composerOptions=initComposerOptions({form:$('chat-form'),chip:$('composer-options'),menu:$('composer-options-menu')});
const tabsOverflow=initTabsOverflow({bar:document.querySelector('.inspector .tabs'),more:$('tabs-more'),menu:$('tabs-more-menu')});
pinComposer({panel:$('inspector-panel'),form:$('chat-form')});
// Conversation (also carries the Ask-about-progress asides and the Mayor's queued inbox messages) and Council.
attachScrollLatest($('chat'));attachScrollLatest($('council'));
// The thread opens at the newest message (on open, cat switch, tab switch and own send). New replies follow only while the reader is already at the bottom.
const chatEl=$('chat');
// /api/state carries only recent messages, so each chat loads its own history from /api/chats: the newest page when the
// cat is opened, older pages on "Earlier messages". Every full refetch drops them, since frames may have been missed.
const chatPages=new Map();
async function loadChat(cat,older=false){
  const page=chatPages.get(cat)??{messages:[],tasks:[],more:false,loading:false};
  if(page.loading)return;page.loading=true;chatPages.set(cat,page);
  try{
    const before=older?page.messages[0]?.id:undefined,r=await fetch(`/api/chats/${encodeURIComponent(cat)}${before?`?before=${encodeURIComponent(before)}`:''}`);
    if(!r.ok)throw new Error((await r.json()).error||'Cannot read this chat');
    const d=await r.json();if(chatPages.get(cat)!==page||!state)return;
    page.messages=older?[...d.messages,...page.messages]:d.messages;page.more=d.more;if(d.tasks)page.tasks=d.tasks;
    // Older messages go on top: keep the reader's place instead of jumping.
    const fromBottom=chatEl.scrollHeight-chatEl.scrollTop;render();if(older)chatEl.scrollTop=chatEl.scrollHeight-fromBottom;
  }catch(e){notify(e);}finally{page.loading=false;}
}
// wantedLink: what an #item=, #approval=, #thread= or #cat= link asked for ({kind,id}), opened once the town has loaded (takeLink below).
let remote=false,pollMs,stream=null,wantedLink=null,gate=null;
// questCount: the one "needs you" count (quests-panel.js needsYouCount), null until it has loaded.
let state,selected='mayor',tab='chat',connected=false,scene,questAlert=false,questCount=null,refreshing=false,refreshAgain=false;
// questList: the items behind questCount, from the Inbox's own read of /api/quests (readQuests passes each read through, so there is no
// second fetch). The header's lead and the Mayor's notice name what the one count is made of (plan 11.5).
let questList=[];
async function readQuests(...args){const r=await fetch(...args);if(args[0]==='/api/quests'&&r.ok){try{const list=await r.clone().json();if(Array.isArray(list))questList=list;}catch{/* the panel says it could not load */}}return r;}
// Clowder is not answering once the gate (plan 10.10) has closed: the page stream failed and nothing answered for pollMs. A shorter blip
// stays the header dot's Reconnecting….
const hostDown=()=>!connected&&gate?.gateState().open===false;
// The header's lead (plan 11.5, F12): "3 decisions waiting" before the activity line. app.js draws it as its own span, so town.js keeps
// the activity line to itself; the phone's town strip mirrors both (mobile-ui.js).
const waitingLine=el('span',{className:'world-waiting',attrs:{id:'world-waiting'}});waitingLine.hidden=true;$('world-activity').before(waitingLine);
// One bar under the header while Clowder is not answering, with Retry (plan 11.5, F7: the banner half of plan 5.7), and a line over the
// composer that says why Send is off.
const hostText=el('p',{className:'host-down-text',attrs:{role:'alert'}}),hostRetry=el('button',{className:'host-down-retry',text:'Retry',attrs:{type:'button'}});
const hostBar=el('div',{className:'host-down-bar',attrs:{id:'host-down'}},[hostText,hostRetry]);hostBar.hidden=true;document.querySelector('body>header').after(hostBar);
const sendReason=el('p',{className:'send-reason',attrs:{id:'send-reason'}});sendReason.hidden=true;$('chat-form').prepend(sendReason);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=id=>state.cats.find(c=>c.id===id)?.name||state.retiredCats?.find(c=>c.id===id)?.name||({owner:'You',system:'Town',town:'Town'}[id]||id);
const time=at=>new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const chatThread=createChatThread({chat:chatEl,name,time,openArchiveOn,api,notify,select,decisionSlot:(id,o)=>decisionCardFor(id,o),focusCat:id=>aimTown(id),replay:messages=>scene?.replay(messages),
  // A starter chip fills the composer (plan 11.12) and sends nothing; the input event saves the draft and settles Send, as typing does.
  fill:text=>{const box=$('message');box.value=text;box.dispatchEvent(new Event('input',{bubbles:true}));box.focus();}});
const active=t=>['running','waiting','waiting_child'].includes(t.status);
function status(id){const tasks=state.tasks.filter(t=>t.cat===id&&active(t));return tasks.some(t=>t.status==='waiting')?'Needs you':tasks.length?'Working':'At ease';}
async function api(path,data,method='POST'){const r=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json','X-Town-Action':'owner'},body:JSON.stringify(data)});const body=await r.json();if(!r.ok)throw new Error(body.error||'Request failed');return body;}
// While the bar says Clowder is not answering, a request that could not reach it adds no "Failed to fetch" (plan 11.5: one bar).
function notify(error){if(error instanceof TypeError&&hostDown())return;$('notice').textContent=error.message||String(error);}
const panels=['residents','inspector','diary','season','projects','quests'];
// The Reasoning menu's last paint: the option list it was built from, and the cat it last started on.
// wantedReasoning: the pick for the selected cat (the owner's or the starting rule's). A provider that drops out of the list for a moment falls back, then comes back to it.
let reasoningKey=null,reasoningCat=null,wantedReasoning=null,hermesOn=false;
let lastPanel;
// The chat pane and its rail, the left sheets and the phone's town strip (plan 8.5, mobile-ui.js). setPanel asks it what gives way.
const paneLayout=initPaneLayout({panels,setPanel:(id,open,focus)=>setPanel(id,open,focus),pin:()=>chatThread.pin()});
// Built before the first setPanel call, which can reopen a saved panel. It fetches only while open.
const projectsPanel=createProjectsPanel({act:(path,body)=>api(path,body),panel:$('projects-panel'),body:$('projects-body'),status:$('projects-status'),onOpenChat:id=>{if(state?.cats.some(c=>c.id===id))select(id);},onShowHamlet:()=>setPanel('projects',false),onOpenArtifact:id=>void openArtifactById(id),onAskMayorReview:askMayorToReviewGoals,needsYou:()=>questCount});
// The same send as typing to the Mayor, in the town's default reasoning. A removal suggestion arrives as a quest.
async function askMayorToReviewGoals(){await api('chat',{cat:'mayor',text:'Review all town goals. Suggest removing duplicates or outdated ones with suggest_goal_removal; don\'t change anything else.',...parseReasoning(startingReasoning(state.models,state.townDefault,null,null))});await refresh();}
const questsPanel=createQuestsPanel({panel:$('quests-panel'),body:$('quests-body'),status:$('quests-status'),badge:$('quests-badge'),onAction:openQuest,openThread:t=>{showPane('inspector');chatThread.open(t);},questionOf:id=>state?.approvals.find(a=>a.id===id)?.question,decisionCard:(id,o)=>decisionCardFor(id,o),onOpenArtifact:id=>openArchiveOn(id),fetchImpl:readQuests,onCount:n=>{const changed=n!==questCount;questCount=n;questAlert=n>0;scene?.setAttention(questAlert);paintQuestNotice();if(changed)void projectsPanel.refresh();dispatchEvent(new CustomEvent('quest-list',{detail:questList}));openWantedLink();}});
// The Memorial is a full-screen layer, not a sheet: the dock button and the ☰ entry open it (the observatory does too, via open-panel).
// Every entry zooms the camera into the observatory first (memorial-transition.js).
const memorialView=createMemorialView({dialog:$('memorial-panel'),dock:$('toggle-memorial')});
const memorialZoom=createMemorialTransition({view:memorialView,stage:()=>scene,audio:()=>sound?.audio});
$('toggle-memorial').onclick=()=>memorialZoom.open();
// The Town Archive, the same kind of layer: the town square's notice board and its label fly the camera to the board first.
// An artifact link in a quest or in chat opens it straight on that artifact with the quick crossfade (archive-view.js).
const archiveView=createArchiveView({dialog:$('archive-panel'),body:$('archive-body'),dock:$('toggle-archive'),catName:id=>state?name(id):id});
// An artifact link (chat, Inbox) opens the Archive with open(true): a --dur-quick crossfade and no flight (plan 8.10).
const archiveZoom=createMemorialTransition({view:archiveView,stage:()=>scene,audio:()=>sound?.audio,shotOf:s=>s?.archiveShot?.(),screenOf:s=>s?.archiveScreen?.(),tone:null,quickMs:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-quick'))||undefined});
function openArchiveOn(id){archiveZoom.open(true);void archiveView.openArtifact(id);}
$('toggle-archive').onclick=()=>archiveZoom.open();
// The Post office: the Mailman's panel of channels, sign-ins and apps (post-office.js). The Moonvault: Money and Usage, a tab each (moonvault.js).
const postOffice=createPostOffice();
const vault=initMoonvault({onSelect:tab=>{if(tab==='usage')void usagePanel.load();}});
// The surfaces other code opens by name (window.openSurface). Each closes the ☰ menu and any open dialog first, so one layer is on top.
const SURFACES={memorial:()=>memorialZoom.open(),archive:()=>archiveZoom.open(),season:()=>setPanel('season',true,true),models:()=>$('models-open').click(),connectors:()=>$('connectors-open').click(),devices:()=>$('share').click(),treasury:()=>openTreasury(),studio:()=>openStudio(selected),worlds:()=>$('worlds-button').click(),routines:()=>void routinesPanel.open(),telegram:()=>void telegramPanel.open(),memory:()=>void memoryPanel.open(),usage:()=>void usagePanel.open(),discord:()=>void discordPanel.open(),accounts:()=>void accountsPanel.open(),clients:()=>void ownerClientsPanel.open(),mail:()=>void mailWatchPanel.open(),ntfy:()=>void ntfyPanel.open(),postoffice:()=>postOffice.open(),autonomy:()=>openSettingsPage('autonomy',{over:'thread'}),backups:()=>openSettingsPage('backup',{over:'thread'})};
function openSurface(name){if(!SURFACES[name])return false;for(const d of document.querySelectorAll('dialog[open]'))d.close();SURFACES[name]();return true;}
window.openSurface=openSurface;
initCommandPalette({surfaces:SURFACES,openSurface,select,openThread:t=>chatThread.open(t),town:()=>state,openMemoryPage:slug=>{openSurface('memory');void memoryPanel.openPage(slug);},openSetup:()=>void openSetup()});// Ctrl+K / ⌘K over threads, cats, these surfaces, actions and search (plan 8.9)
// A decision opens its own dialog. One answered in the meantime falls back to the cat's chat, where the answer shows.
function openQuest(quest){const {panel,cat}=quest.action;if(quest.source?.kind==='approval'&&openApprovalSheet(quest.source.id))return;if(panel==='models'){$('models-open').click();return;}if(panel==='moonvault'){openTreasury();return;}if(cat&&state?.cats.some(c=>c.id===cat))select(cat);else if(panel==='chat')showPane('inspector');else setPanel(panel,true);}
function setPanel(id,open,focus=false){
  // Plan 8.5. Narrow screens (under 900px) show one sheet at a time, chat first. From 900px the chat is a pane on the right that
  // folds to its rail instead of closing, and the other sheets open on the left. paneLayout.plan says which open panels give way.
  for(const other of paneLayout.plan(id,open))setPanel(other,false);
  const panel=$(id+'-panel'),shown=open||(id==='inspector'&&!matchMedia(COMPACT_QUERY).matches);
  panel.hidden=!shown;panel.inert=!shown;
  if(open&&id==='projects')void projectsPanel.refresh();
  if(open&&id==='quests')void questsPanel.refresh();
  // The size a phone sheet's grip starts from: chat full, the others half (while the town is a strip every sheet fills the room under it).
  if(open)panel.dataset.size=id==='inspector'?'full':'half';
  $('toggle-'+id).setAttribute('aria-expanded',String(open));
  if(open){lastPanel=id;revealDockButton($('toggle-'+id));}
  try{localStorage.setItem('cat-town-panel-'+id,String(open));}catch{}
  syncSheet();paneLayout.sync();
  // After sync, so an unfolded pane has its height again before the thread jumps to the newest message.
  if(open&&id==='inspector')chatThread.pin();
  if(focus)(open?panel.querySelector('[data-collapse]'):paneLayout.focusAfterClose(id))?.focus();
}
// The open sheet's size drives the camera controls' position on phones (body[data-sheet]).
function syncSheet(){const open=panels.find(id=>!$(id+'-panel').hidden);document.body.dataset.sheet=open&&matchMedia(COMPACT_QUERY).matches?$(open+'-panel').dataset.size:'';}
function showPane(pane){if(pane==='world')panels.forEach(id=>setPanel(id,false));else setPanel(pane,true);}
// Phones scroll the dock sideways: the open panel's button is brought into view, and edge fades show more items.
const dockNav=document.querySelector('.town-dock');
function revealDockButton(button){if(!dockNav||dockNav.scrollWidth<=dockNav.clientWidth)return;const b=button.getBoundingClientRect(),d=dockNav.getBoundingClientRect();dockNav.scrollBy({left:b.left-d.left-(d.width-b.width)/2,behavior:'smooth'});}
function updateDockFade(){if(!dockNav)return;const max=dockNav.scrollWidth-dockNav.clientWidth;dockNav.dataset.fade=[dockNav.scrollLeft>2&&'left',dockNav.scrollLeft<max-2&&'right'].filter(Boolean).join(' ');}
dockNav?.addEventListener('scroll',updateDockFade,{passive:true});
addEventListener('resize',updateDockFade);
// A window that shrinks to phone or tablet width keeps one sheet: the last one opened, or the first open one.
matchMedia(COMPACT_QUERY).addEventListener('change',e=>{if(!e.matches)return;const open=panels.filter(id=>!$(id+'-panel').hidden),keep=open.includes(lastPanel)?lastPanel:open[0];for(const id of open)if(id!==keep)setPanel(id,false);});
const savedPanels=panels.filter(id=>{try{return localStorage.getItem('cat-town-panel-'+id)==='true';}catch{return false;}});
// Chat opens at launch at every width (plan 8.5), last so it wins; wide screens also bring back the sheets that were open.
for(const id of [...panels.filter(p=>p!=='inspector'),'inspector'])setPanel(id,id==='inspector'||(!matchMedia(COMPACT_QUERY).matches&&savedPanels.includes(id)));
initSeasonPanel();
updateDockFade();
document.querySelectorAll('[data-toggle-panel]').forEach(b=>b.onclick=()=>setPanel(b.dataset.togglePanel,b.getAttribute('aria-expanded')!=='true',true));// aria-expanded, since a folded chat pane is not hidden
addEventListener('open-panel',e=>{if(e.detail==='memorial')memorialZoom.open();else if(e.detail==='archive')archiveZoom.open();else if(panels.includes(e.detail))setPanel(e.detail,true);});// town.js: the memorial chapel and its label
document.querySelectorAll('[data-collapse]').forEach(b=>b.onclick=()=>setPanel(b.dataset.collapse,false,true));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&editing){if(scene?.cancelMove?.()){e.preventDefault();return;}setEditing(false);e.preventDefault();return;}if(e.key==='Escape'&&!document.querySelector('dialog[open]')&&!document.querySelector(':popover-open')){const id=panels.find(id=>$(id+'-panel').contains(document.activeElement))||lastPanel;if(id&&!$(id+'-panel').hidden){setPanel(id,false,true);e.preventDefault();}}});
matchMedia(COMPACT_QUERY).addEventListener('change',e=>{if(e.matches)for(const id of panels)if(id!==lastPanel)setPanel(id,false);});
// Each panel gets a drag grip that acts as a sheet handle on phones. Every control lives in the ☰ menu at every width.
initTownMenu($('town-menu'),$('menu-toggle'));
initInstallApp(document,window);
const sound=initSound();
// Visiting another world flies there and rebuilds the town in place (world-travel.js); the panel reloads only without a scene.
const travel=createWorldTravel({stage:()=>scene,onLanded:()=>void refresh()});
if(new URLSearchParams(location.search).has('perf'))window.__travel=travel;
initWorldsPanel({travel,aiChoices:async()=>{const s=state??await fetch('/api/state',{cache:'no-store'}).then(r=>r.json());return {models:s.models??[],townDefault:s.townDefault??null,catalog:await catAiCatalog()};}});
if(window.isSecureContext&&'serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(error=>console.warn('Offline cache unavailable:',error));
initHouseNames(document,$('label-mode'));
for(const id of panels)initSheet($(id+'-panel'),{onClose:()=>setPanel(id,false,true),onResize:syncSheet});
$('fullscreen').hidden=!document.fullscreenEnabled;
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(e){notify(e);}};
document.addEventListener('fullscreenchange',()=>$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen'));
function renderTreasury(){
  const funds=state.treasury,mode=treasuryMode(funds),tokens=usedTokens(state.usage,seasonTokenRows),line=treasuryText(mode,funds,tokens);
  // The chip and the vault label (town.js reads vaultText) show the same line. Seasons load once so both include them.
  setVaultLine(line);if(!seasonsAsked){seasonsAsked=true;void loadSeasonTokens();}
  $('treasury-total').textContent=line;$('treasury-short').textContent=treasuryShort(mode,funds,tokens);$('treasury-button').dataset.show=mode;$('treasury-button').title='Money · '+line;$('treasury-button').setAttribute('aria-label','Money · '+line);
  document.querySelectorAll('[data-treasury-show]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.treasuryShow===mode)));
  $('treasury-balance').textContent=funds?formatFunds(funds):'Balance not set';
  $('treasury-source').textContent=funds?'Owner recorded · '+new Date(funds.recordedAt).toLocaleString():'No balance has been recorded.';
  $('treasury-note').textContent=funds?.note||'';$('treasury-viewer').hidden=!remote&&!state.readOnly;
  renderTokens();
}
// The Moonvault's token ledger: chat, tasks and goal rounds from this world, plus each economy season. Only what providers report.
let seasonTokenRows=[],seasonsAsked=false;
// Ids that may appear in diary and task text, mapped to what they name. Unknown ids are dropped by humanizeText.
// Built once per tasks/goals snapshot, not once per row.
let knownCache={tasks:null,goals:null,map:new Map()};
const knownIds=()=>{if(knownCache.tasks!==state.tasks||knownCache.goals!==state.goals)knownCache={tasks:state.tasks,goals:state.goals,map:new Map([...state.tasks.map(t=>[t.id,{title:oneLiner(t.text,60)}]),...(state.goals??[]).map(g=>[g.id,{title:g.title}])])};return knownCache.map;};
function renderTokens(){$('treasury-tokens').innerHTML=tokensUsedHtml(state.usage,seasonTokenRows,escape);}

async function loadSeasonTokens(){
  try{
    const owner=!remote&&!state.readOnly,r=await fetch(owner?'/api/seasons':'/api/season',{cache:'no-store'});if(!r.ok)return;
    const d=await r.json();
    seasonTokenRows=(owner?d.seasons:(d.name?[d]:[])).filter(s=>s?.tokens?.calls>0).map(s=>({name:s.name,tokens:s.tokens}));
    renderTreasury();scene?.update(state,selected);
  }catch{/* the chat ledger still shows */}
}
document.querySelectorAll('[data-treasury-show]').forEach(b=>b.onclick=()=>{saveTreasuryMode(b.dataset.treasuryShow);if(state){renderTreasury();scene?.update(state,selected);}});
// The Moonvault opens on Money (the Money pill, the vault in town) or on its Usage tab (Usage from the Banker's corner, Manage or the palette).
function openTreasury(tab='money'){
  if(!state)return;renderTreasury();const funds=state.treasury;
  $('treasury-currency').value=funds?.currency||'';$('treasury-amount').value=funds?(funds.amountMinor/100).toFixed(2):'';
  $('treasury-entry-note').value=funds?.note||'';$('treasury-error').textContent='';vault.select(tab==='usage'?'usage':'money',{quiet:true});
  if(!$('treasury-dialog').open)$('treasury-dialog').showModal();void loadSeasonTokens();
  if(tab==='usage')void usagePanel.load();
}
$('treasury-button').onclick=()=>openTreasury();
$('treasury-season').onclick=()=>{$('treasury-dialog').close();openSurface('season');};
$('treasury-form').onsubmit=async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;$('treasury-error').textContent='';try{await api('treasury',{amount:$('treasury-amount').value.trim(),currency:$('treasury-currency').value,note:$('treasury-entry-note').value});await refresh();$('treasury-dialog').close();}catch(error){$('treasury-error').textContent=error.message;}finally{button.disabled=false;}};

function select(id){selected=id;render();showPane('inspector');if(scene)scene.select(id,{inset:paneInset()});else townAim=id;}
// Plan 8.10: opening a chat eases the town to its cat, never a flight. From 900px the chat pane (or its rail) covers the town's right side,
// so the cat centres in what is left: the inset is how far the pane reaches into the canvas. One asked before the town loads waits for it.
let townAim=null;
function paneInset(){if(matchMedia(COMPACT_QUERY).matches)return 0;const pane=$('inspector-panel').getBoundingClientRect(),town=$('town-canvas').getBoundingClientRect();return pane.width?Math.max(0,town.right-pane.left):0;}
function aimTown(id){if(scene)scene.focus(id,{inset:paneInset()});else townAim=id;}
let editing=false;
// Owner-only: the toggles are hidden on view-only devices, which also exits edit mode. The banner, the frame and the live region
// say so, so the mode is never a guess.
function setEditing(on){
  const was=editing;editing=!!on&&!state?.readOnly;
  for(const b of [$('edit-town'),$('edit-toggle')])b.setAttribute('aria-pressed',String(editing));
  $('edit-town').textContent=editing?'Done editing':'Edit town';
  $('world-hint').textContent=editing?'Drag a house to move it. On a phone, tap a house, then tap open ground. Esc to finish.':'Drag to travel · Pinch / scroll to zoom · Right-drag to orbit';
  $('edit-pill').hidden=!editing;document.body.classList.toggle('editing-town',editing);
  scene?.setEditing(editing);
  if(editing!==was)$('edit-live').textContent=editing?'Edit mode on. Drag a house to move it, or select one for its options.':'Edit mode off.';
}
$('edit-done').onclick=()=>setEditing(false);
$('edit-toggle').onclick=()=>setEditing(!editing);
// The house toolbar: a selected house in edit mode gets Move, Customize and Done beside it, and follows the house while it shows.
let barHouse=null,barFrame=0,barW=0,wrapW=0;
function showEditBar(id){
  barHouse=editing&&id?id:null;const bar=$('edit-bar');bar.hidden=!barHouse;cancelAnimationFrame(barFrame);
  if(barHouse){barW=bar.offsetWidth;wrapW=$('canvas-wrap').clientWidth;followEditBar();}
}
// Centred over the house but kept inside the town view, so a house at the edge still gets all three buttons.
function followEditBar(){
  const bar=$('edit-bar'),p=scene?.houseScreen?.(barHouse);
  if(p)bar.style.translate=`${Math.round(Math.min(Math.max(p.x-barW/2,8),wrapW-barW-8))}px ${Math.round(p.y)}px`;
  if(!bar.hidden)barFrame=requestAnimationFrame(followEditBar);
}
addEventListener('edit-select',e=>showEditBar(e.detail));
addEventListener('edit-status',e=>{$('edit-live').textContent=e.detail;});
$('edit-bar-move').onclick=()=>scene?.startMove(barHouse);
$('edit-bar-customize').onclick=()=>{const id=barHouse;setEditing(false);openStudio(id,'house');};
$('edit-bar-done').onclick=()=>scene?.clearEditSelect();
// Edit mode keys. E toggles it (not while typing, in a dialog or in the Studio). In edit mode, with a house selected, the arrows
// nudge it (Shift for quarter metres) and Enter saves the move. Escape is handled above.
const typing=t=>t?.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName??'');
document.addEventListener('keydown',e=>{
  if(typing(e.target)||e.ctrlKey||e.metaKey||e.altKey||document.querySelector('dialog[open]')||studio.isOpen())return;
  if(e.key==='e'||e.key==='E'){if(!state||state.readOnly)return;e.preventDefault();setEditing(!editing);return;}
  if(!editing)return;
  if(e.key==='Enter'&&scene?.commitMove?.()){e.preventDefault();return;}
  if(e.key.startsWith('Arrow')&&scene?.keyMove?.(e.key,e.shiftKey))e.preventDefault();
});
// The server validates the plot; a rejected move shows its message and the house never moved locally.
async function moveHome(id,x,z){try{await api(`homes/${encodeURIComponent(id)}/move`,{x,z});await refresh();$('edit-live').textContent='House moved.';}catch(error){notify(error);}}
// The Studio opens from the chat, the Cats panel, the ☰ menu and edit mode. Edit mode and the chat's Settings close first.
const studio=createStudio({scene:()=>scene,api,refresh,onOpen:()=>{setEditing(false);catSettings?.close();}});
const catSettings=initCatSettingsFlyout();
function openStudio(catId,which='cat'){void studio.open(catId,which);}
$('open-studio').onclick=()=>openStudio(selected);
$('menu-studio').onclick=()=>openStudio(selected);
$('studio-house').onclick=()=>openStudio(selected,'house');
$('cats-customize').onclick=()=>openStudio(selected);
addEventListener('studio-pick',e=>openStudio(e.detail));
$('edit-town').onclick=()=>setEditing(!editing);
function avatar(cat){return `<span class="avatar" style="background:${escape(cat.color)}">${escape(cat.icon)}</span>`;}
// The Cats list: one collapsible group per project (cat-groups.js). The search box is made once, outside #cats, so a live refresh never clears what was typed.
let catQuery='',catRevealed=null;
const catSearch=document.createElement('input');
catSearch.type='search';catSearch.id='cats-search';catSearch.placeholder='Find a cat';catSearch.setAttribute('aria-label','Find a cat by name or role');catSearch.hidden=true;
$('cats').before(catSearch);
catSearch.addEventListener('input',()=>{catQuery=catSearch.value;paintCats();});
{const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('cats-panel.css',import.meta.url).href;document.head.append(link);}
const groupKey=key=>`cat-town-cats-group:${key}`;
function savedGroupOpen(key){try{const v=localStorage.getItem(groupKey(key));return v==='open'||v==='closed'?v:null;}catch{return null;}}
function rememberGroupOpen(key,open){try{localStorage.setItem(groupKey(key),open?'open':'closed');}catch{/* private window: the choice lasts this visit */}}
function paintCats(){
  const list=$('cats'),statusOf=new Map(state.cats.map(c=>[c.id,status(c.id)])),live=id=>statusOf.get(id)!=='At ease';
  catSearch.hidden=state.cats.length<=8;if(catSearch.hidden){catQuery='';catSearch.value='';}
  const groups=catGroups(state.cats,{groups:state.groups,goals:state.goals,tasks:state.tasks,isWorking:live,query:catQuery});
  // A newly selected cat opens its group once (saved), so the highlighted row is never hidden in a closed group.
  if(selected!==catRevealed&&!catQuery.trim()){catRevealed=selected;const home=groups.find(g=>g.cats.some(c=>c.id===selected));if(home)rememberGroupOpen(home.key,true);}
  const row=c=>`<div class="cat-row"><button class="cat-button ${c.id===selected?'selected':''} ${live(c.id)?'working':''}" data-cat="${escape(c.id)}" aria-pressed="${c.id===selected}">${avatar(c)}<span><strong>${escape(c.name)}</strong><small>${escape(statusOf.get(c.id))}</small></span><i class="status-dot"></i></button></div>`;
  const filtering=catQuery.trim()!=='';
  const markup=groups.map((g,i)=>{
    const id=`cat-group-${i}`,open=groupIsOpen(g,{saved:savedGroupOpen(g.key),query:catQuery});
    const title=`<span class="cat-group-title">${escape(g.title)}</span><span class="cat-group-count">${g.count}</span>${g.working?'<i class="cat-group-dot" aria-hidden="true"></i><span class="sr-only">, working</span>':''}`;
    const head=filtering?`<div class="cat-group-head">${title}</div>`:`<button type="button" class="cat-group-head" data-group="${escape(g.key)}" aria-expanded="${open}" aria-controls="${id}">${title}<i class="cat-group-chev" aria-hidden="true"></i></button>`;
    return `<section class="cat-group">${head}<div class="cat-group-body" id="${id}"${open?'':' hidden'}>${g.cats.map(row).join('')}</div></section>`;
  }).join('');
  list.innerHTML=markup||`<p class="cat-empty">No cat matches “${escape(catQuery.trim())}”.</p>`;
  list.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>select(b.dataset.cat));
  list.querySelectorAll('[data-group]').forEach(b=>b.onclick=()=>{const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));b.closest('.cat-group').querySelector('.cat-group-body').hidden=!open;rememberGroupOpen(b.dataset.group,open);});
}
function render(){
  if(!state)return;document.body.classList.toggle('viewer',state.readOnly);const cat=state.cats.find(c=>c.id===selected)||state.cats[0];selected=cat.id;$('edit-town').hidden=$('edit-toggle').hidden=state.readOnly;if(state.readOnly&&editing)setEditing(false);studio.update(state);
  paintCats();
  
  // The ⋯ menu's row is named after the sheet it opens ("Mayor’s settings"), so it is not a second "Settings" beside the ☰ one.
  catSettings?.setCatName(cat.name);{const row=document.querySelector('#pane-menu .chat-settings>summary'),words=settingsTitle(cat.name);if(row&&row.textContent!==words)row.textContent=words;}
  const waiting=cat.id==='mayor'?inboxCount(state):0;
  $('cat-header').innerHTML=`${avatar(cat)}<div><h2>${escape(cat.name)}’s corner</h2>${cat.directs?`<p>Directs: ${escape(oneLiner(state.tasks.find(t=>t.id===cat.directs)?.text??'',60)||'a project')}</p>`:cat.manager?`<p>Reports to: ${escape(name(cat.manager))}</p>`:''}<p class="cat-status">${escape(status(cat.id))}${waiting?` · ${waiting} queued`:''}<span class="cat-role"> · ${cat.id==='mayor'?'Your guide to the town':'Town specialist'}</span></p></div>`;
  $('home-label').textContent=state.world?.designs[cat.home?.style]?.label||'Planning a home';
  setSeasonHost({models:state.models,readOnly:state.readOnly,townDefault:state.townDefault});
  // The coin economy is off unless the server says economy.enabled; its button (and so the palette row) stays hidden then.
  $('treasury-season').hidden=state.economy?.enabled!==true;
  paintReasoning();
  paintDemoState(cat);
  paintQuestNotice();
  void renderCatAi(cat);
  if(!chatPages.has(selected))void loadChat(selected);
  const page=chatPages.get(selected);
  chatThread.paint({page,state,selected});
  paintLive();
  if($('try-demo'))$('try-demo').hidden=state.readOnly;
  if($('try-demo'))$('try-demo').onclick=()=>{$('mode').value=wantedReasoning='demo';modeNote();$('message').value='Help the town explore a small digital service. Ask the specialists to review it.';$('chat-form').requestSubmit();};
  $('tasks').innerHTML=catTasks(page?.tasks,state.tasks,selected).reverse().map(t=>`<div class="task-card"><small>${escape(t.status.replaceAll('_',' '))} · ${escape(t.mode)}</small><strong>${escape(t.text)}</strong>${t.result?`<p>${escape(humanizeText(t.result,knownIds()))}</p>`:''}<details><summary>Task record</summary>${escape(t.id)}${t.parent?`<br>Delegated from ${escape(name(t.from))}`:''}</details></div>`).join('')||'<p class="empty">Assignments will appear here.</p>';
  $('roads').innerHTML=`<p class="muted">Connected cats can delegate directly.</p>${state.roads.filter(r=>r.a===selected||r.b===selected).map(r=>`<div class="road-row"><span>${escape(name(r.a===selected?r.b:r.a))}</span><small>${r.messages?'Used':'Quiet'}</small></div>`).join('')}`;
  const pending=state.approvals.filter(a=>a.status==='pending');$('decision-badge').hidden=!pending.length;nameDockButton($('toggle-inspector'),pending.length,DECISIONS);
  renderApprovalStrips(pending);
  if(openId()&&!pending.some(a=>a.id===openId()))closeApprovalSheet();
  // With exactly one decision pending, the composer can answer it instead of chatting.
  const single=pending.length===1&&!state.readOnly;
  $('reply-as-answer').hidden=!single;
  if(!single)$('reply-as-answer-input').checked=false;
  const replying=single&&$('reply-as-answer-input').checked;
  if(single)$('reply-as-answer-label').textContent=`Reply to ${name(pending[0].cat)}’s question`;
  // Work runs side by side up to the town's parallel limit. A cat already working takes no second message.
  const full=state.tasks.filter(t=>!t.parent&&active(t)).length>=(state.maxParallelWork||1)||!!state.councils?.some(c=>c.status==='voting');
  const busy=full||(selected!=='mayor'&&state.tasks.some(t=>t.cat===selected&&active(t)));
  const askInstead=syncAskToggle(askToggle,state,selected);
  // The Mayor takes messages while the town is full: they wait in its inbox. Other cats wait for a free slot.
  $('send').disabled=state.readOnly||!connected||(!replying&&!askInstead&&(state.paused||(busy&&selected!=='mayor')));$('mode').disabled=busy;
  // The goal toggle and banner belong to the Mayor's composer only.
  const banner=selected==='mayor'?goalBannerText(state.goals??[]):null;$('goal-banner').hidden=!banner;$('goal-banner').textContent=banner??'';
  $('goal-toggle').hidden=selected!=='mayor'||state.readOnly;
  manage.paint();composerOptions.paint();composer.paint();fitComposer($('message'));
  paintBrainCard({card:$('brain-card'),button:$('brain-signin'),text:$('brain-card-text'),models:state.models,readOnly:state.readOnly,canSignIn:!$('models-open').hidden});
  $('message').placeholder=replying?`Answer ${name(pending[0].cat)}’s question…`:askInstead?`Ask ${cat.name} how it’s going…`:state.paused?'Town paused. Resume when you’re ready.':busy&&selected==='mayor'?'The Mayor is busy. Your message waits in its inbox.':busy?'Your cats are working. You can pause at any time.':`Give ${cat.name} a goal…`;
  paintConnection();
  $('pause').textContent=state.paused?'Resume town':'Pause town';$('world-state').textContent=(state.paused?'Resting':pending.length?'Needs your decision':busy?'Ideas in motion':'At ease')+(inboxCount(state)?` · ${inboxCount(state)} queued`:'');
  // The diary: who talked to whom with a one-line gist, finished work with a one-line result, and town milestones. Newest first.
  const taskCat=(id,result)=>taskCatOf(id,state.tasks,state.events,result),who=id=>id==='owner'?'You':name(id),to=id=>id==='owner'?'you':name(id);
  const said=new Set(state.events.filter(e=>e.type==='message'&&e.data.text).map(e=>`${e.data.from}|${oneLiner(e.data.text,96)}`));
  $('diary').innerHTML=state.events.filter(e=>['town.planned','cat.restored','council.closed','homes.planned','home.styled','home.looked','founded','cat.created','road.created','message','task.updated','approval.requested','approval.resolved','paused'].includes(e.type)).map(e=>{
    const d=e.data,target=state.councils?.find(c=>c.id===d.id)?.target;
    if(e.type==='message'){
      if(d.from==='system'||!d.text)return null;
      // Goal rounds come from the town (older journals put them in the owner's name); the diary calls them what they are.
      const round=goalRound(d);
      return round?{e,text:roundStarted(round)}:{e,talk:true,text:`${who(d.from)} → ${to(d.to)}: ${oneLiner(d.text,96)}`};
    }
    if(e.type==='task.updated'){
      // A result the cat already said in a message is not repeated as its own line.
      if(d.status==='done'&&d.result){const cat=taskCat(d.id,d.result);return said.has(`${cat}|${oneLiner(d.result,96)}`)?null:{e,text:`${cat?name(cat):'A cat'} finished: ${oneLiner(d.result,96)}`};}
      if(['failed','cancelled'].includes(d.status)){const cat=taskCat(d.id);return {e,text:cat?`${name(cat)}'s work ${d.status}.`:`A cat's work ${d.status}.`};}
      return null;
    }
    const text=({'town.planned':'The town planned its civic square and neighborhoods.','cat.restored':`${d.cat?.name} returned to town.`,'council.closed':d.status==='retired'&&target?`${name(target)} rests in the memorial garden.`:`Council: ${d.result}`,'homes.planned':'The town settled into permanent homes.','home.styled':`${name(d.id)} redesigned their home.`,'home.looked':`${name(d.id)}’s home got a new look.`,founded:'The town opened its doors.','cat.created':`${d.name} built a new home.`,'road.created':`${name(d.a)} and ${name(d.b)} are now connected.`,'approval.requested':`${name(d.cat)} is waiting for your decision.`,'approval.resolved':decisionLine(d),paused:d.value?'The town is paused.':'The town is awake.'})[e.type];
    return text?{e,text}:null;
  }).filter(Boolean).slice(-30).reverse().map(({e,text,talk})=>`<li${talk?' class="diary-talk"':''}><time>${time(e.at)}</time><span>${escape(humanizeText(text,knownIds()))}</span></li>`).join('');
  // state.usage is per-mode totals (src/store.ts small()), summed by the same rule as the Money dialog.
  const used=chatTokens(state.usage);
  $('usage').textContent=used.calls?`Tokens: ${used.unknown<used.calls?(used.input+used.output).toLocaleString():'unreported'}${used.unknown?' · incomplete':''} · provider-reported`:'Token usage: not reported';
  renderCouncil();renderMemorial();renderMemory();renderGallery();tabsOverflow.fit();renderArchive();renderTreasury();scene?.update(state,selected);projectsPanel.refresh();questsPanel.refresh();
}
// The diary's line for an answered decision, in plain words: who asked and what you said, never "Your decision was rejected".
function decisionLine(d){const cat=state.approvals.find(a=>a.id===d.id)?.cat,to=cat?` to ${name(cat)}`:'';return d.status==='approved'?`You said yes${to}.`:d.status==='rejected'?`You said no${to}.`:'A decision was cancelled.';}
const {renderApprovalStrips,openApprovalSheet,closeApprovalSheet,openId,decisionCardFor}=createDecisionStrip({getState:()=>state,escape,name,avatar,api,render});
// Rebuilt only when the rows or permissions change, so open ballot details survive unrelated refreshes.
function renderMemorial(){
  const rows=memorialRows(state.retiredCats||[],state.councils||[],name),busy=!!state.paused||!!state.councils?.some(c=>c.status==='voting');
  const key=JSON.stringify([rows,!!state.readOnly,busy]),body=$('memorial-body');if(body.dataset.key===key)return;body.dataset.key=key;
  body.replaceChildren(...memorialPanel(rows,{canRestore:!state.readOnly,disabled:busy,onRestore:async(id,button)=>{button.disabled=true;try{await api('cats/'+encodeURIComponent(id)+'/restore',{});await refresh();}catch(error){notify(error);button.disabled=false;}}}));
}
function renderCouncil(){
  const records=state.councils||[],retired=state.retiredCats||[],evidence=catTasks(chatPages.get(selected)?.tasks,state.tasks,selected).filter(t=>!active(t));
  const protectedRole=state.councilPolicy?.protectedCats.includes(selected),busy=state.tasks.some(active)||records.some(c=>c.status==='voting');
  const hint=protectedRole?'This civic role is protected.':busy?'Finish current work or stop and resume the town before a council.':!evidence.length?'A completed or stopped task record is needed as evidence.':'Review whether this cat’s job is complete or its work is wrong.';
  const markup=`<p class="muted">${escape(hint)}</p><button id="review-cat" data-owner ${protectedRole||busy||!evidence.length?'disabled':''}>Review ${escape(name(selected))}’s role</button><p class="muted">Peers cast their own ballots. A strict majority is required. History stays available.</p>`+
    records.slice().reverse().map(c=>`<article class="task-card"><small>${escape(c.status)} · ${escape(c.mode)} · ${time(c.at)}</small><strong>${escape(name(c.target))}</strong><p>${escape(c.reason)}</p><p>${escape(c.result||'The council is reviewing task evidence…')}</p><details><summary>Ballots & evidence</summary><p>Electorate: ${c.electorate.map(name).map(escape).join(', ')}</p>${c.votes.map(v=>`<p><strong>${escape(name(v.cat))}: ${escape(v.vote)}</strong><br>${escape(v.reason)}</p>`).join('')}<p>Task records: ${c.evidence.map(escape).join(', ')}</p></details></article>`).join('')+
    (retired.length?'<h3>Retired residents</h3>':'')+retired.map(c=>`<article class="task-card"><strong>${escape(c.name)}</strong><p>${escape(c.reason)}</p><button data-restore="${escape(c.id)}" data-owner ${busy?'disabled':''}>Welcome back</button><details><summary>Saved work</summary>${state.tasks.filter(t=>t.cat===c.id).map(t=>`<p>${escape(t.text)}<br>${escape(t.result||t.status)}</p>`).join('')}</details></article>`).join('');
  if($('council').dataset.markup===markup)return;$('council').dataset.markup=markup;$('council').innerHTML=markup;
  $('review-cat').onclick=()=>{
    $('council-reason').value='';$('council-error').textContent='';$('council-form').dataset.cat=selected;
    $('council-mode').replaceChildren(...state.models.map(m=>new Option(m.name,m.id)));$('council-mode').value=parseReasoning($('mode').value).mode;
    $('council-evidence').innerHTML=evidence.slice().reverse().map(t=>`<label class="evidence-choice"><input type="checkbox" name="evidence" value="${escape(t.id)}"><span>${escape(t.text)}<small>${escape(t.status)} · task ${escape(t.id.slice(0,8))}</small></span></label>`).join('');$('council-dialog').showModal();
  };
  $('council').querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('cats/'+b.dataset.restore+'/restore',{});await refresh();}catch(e){notify(e);b.disabled=false;}});
}
$('council-form').onsubmit=async e=>{e.preventDefault();$('council-error').textContent='';$('council-submit').disabled=true;try{const evidence=[...document.querySelectorAll('#council-evidence input:checked')].map(i=>i.value);await api('councils',{cat:e.currentTarget.dataset.cat,reason:$('council-reason').value,evidence,mode:$('council-mode').value});$('council-dialog').close();await refresh();}catch(error){$('council-error').textContent=error.message;}finally{$('council-submit').disabled=false;}};
// "plan" is the old name for "claude"; saved tasks and older clients may still send it.
const MODE_NOTES={hermes:'Experimental: the Mayor runs on Hermes Agent on this computer. Every tool call still asks Clowder first.',demo:'Scripted demonstration. No model calls or external actions.',local:'Real local reasoning through Ollama. This is Qwen, not GPT.',claude:'Your Claude subscription through the claude CLI. Calls count against your plan limits.',plan:'Your Claude subscription through the claude CLI. Calls count against your plan limits.',chatgpt:'Your ChatGPT subscription through the codex CLI. Calls count against your plan limits.'};
function modeNote(){const mode=parseReasoning($('mode').value).mode;$('mode-note').textContent=MODE_NOTES[mode]??'Real hosted reasoning. Your configured provider may charge for use.';$('demo-warning').hidden=mode!=='demo';}
// The chat open now and its Reasoning provider, for demo-state.js (the header pill and the town's Demonstration glow).
function demoChat(){return {cat:selected,mode:parseReasoning($('mode').value).mode};}
// The Mayor's notice: while anything needs the owner, a strip above the Mayor's conversation opens the Inbox.
function paintQuestNotice(){
  // The dock's Inbox button is read with the same count: "Inbox, 3" (dock-names.js), and so is the thread switcher (chat-composer.js).
  nameDockButton($('toggle-quests'),questCount);composer.count();paintWaiting();
  // When everything that needs the owner is a decision, the strip above the composer already shows each one: the notice would only
  // repeat it, and on a phone under the town strip it pushed the decision strip over the brain card's button. Only decisions that count
  // are compared, from the same list (plan 11.5, N4): a goal-removal suggestion is not counted, so it no longer hides a to-do.
  const decisions=splitNeeds(questList).needs.filter(q=>q.source?.kind==='approval').length;
  const box=$('quest-notice'),show=selected==='mayor'&&questCount>decisions;
  box.hidden=!show;if(!show){box.replaceChildren();return;}
  // One line that opens the Inbox, with the dock badge's number and words.
  const open=el('button',{className:'quest-notice-open',text:`${badgeLabel(questCount)} ›`,attrs:{type:'button'}});
  open.onclick=()=>setPanel('quests',true,true);
  box.replaceChildren(open);
}
// The lead: what waits, from the items behind the one count. Hidden while nothing waits, and while the bar says Clowder is not answering.
function paintWaiting(){const text=questCount?waitingLead(splitNeeds(questList).needs.map(nounOf)):'';if(waitingLine.textContent!==text)waitingLine.textContent=text;waitingLine.hidden=!text||hostDown();}
// The Demonstration pill in the cat header, a one-line reason, and for an active demo goal a switch back to the real default.
// Stopping the goal uses the same confirm and stop route as the Projects panel; the composer is then filled for a restart.
// The Demonstration caveat: on a phone one complete line with Details. Its open state survives the renders that rebuild it.
let caveatOpen=false;
function caveat(short,long){
  const p=document.createElement('p');p.className='caveat';
  const more=Object.assign(document.createElement('button'),{type:'button',className:'caveat-more'});
  p.append(Object.assign(document.createElement('span'),{className:'caveat-short',textContent:short}),' ',more,' ',Object.assign(document.createElement('span'),{className:'caveat-long',textContent:long}));
  return p;
}
function paintCaveats(){for(const p of document.querySelectorAll('.caveat')){p.classList.toggle('is-open',caveatOpen);const b=p.querySelector('.caveat-more');if(b){b.setAttribute('aria-expanded',String(caveatOpen));b.textContent=caveatOpen?'Less':'Details';}}}
document.addEventListener('click',e=>{if(e.target.closest?.('.caveat-more')){caveatOpen=!caveatOpen;paintCaveats();}});
function paintDemoState(cat){
  const header=$('cat-header'),text=header.querySelector('.cat-status');
  header.querySelector('.demo-line')?.remove();
  if(!text||!isDemo(state,cat.id,demoChat()))return;
  text.append(' ',Object.assign(document.createElement('span'),{className:'demo-pill',textContent:'Demonstration'}));
  const goal=cat.id==='mayor'?state.goals?.find(g=>g.mode==='demo'&&(g.status==='active'||g.status==='paused')):null;
  const real=startingReasoning(state.models,state.townDefault,null,null);
  let line;
  if(goal&&goal.status==='active'&&real!=='demo'){
    const label=state.models.find(m=>m.id===parseReasoning(real).mode)?.label??'the town default';
    line=caveat('Demonstration goal running. No model.','A Demonstration goal is running. It runs a canned script and calls no model.');
    const button=Object.assign(document.createElement('button'),{type:'button',className:'demo-switch',textContent:`Switch to ${label}`});
    button.onclick=()=>switchDemoGoal(goal,real);
    line.append(button);
  }else if(goal){
    const status=goal.status==='active'?'running':'paused';
    line=caveat(`Demonstration goal ${status}. No model.`,`A Demonstration goal is ${status}. It runs a canned script and calls no model.`);
  }else if(demoCats(state).has(cat.id))line=caveat('Demonstration task running. No model.','A Demonstration task is running. It runs a canned script and calls no model.');
  else line=caveat('Demonstration: no model.','This chat is set to Demonstration. Replies are canned and no model is called.');
  line.classList.add('demo-line');
  header.querySelector('div').append(line);
  paintCaveats();
}
async function switchDemoGoal(goal,real){
  if(!await confirmDialog({title:`Stop “${goal.title}”?`,message:'Demonstration goals stop here. The goal text goes back in the composer on the real default, so you can start it again.',confirmLabel:'Stop goal',cancelLabel:'Keep running',danger:true}))return;
  try{await api(`goals/${encodeURIComponent(goal.id)}/action`,{action:'stop'});}catch(error){notify(error);return;}
  $('mode').value=wantedReasoning=real;rememberReasoning();modeNote();reasoningCat=selected;
  $('message').value=goal.success||goal.title;$('goal-mode').checked=true;
  if(selected!=='mayor')select('mayor');
  await refresh();$('message').focus();
}
function showPairing(){stream?.close();stream=null;connected=false;$('town-loading').hidden=true;state=undefined;document.body.classList.add('unpaired');$('chat').replaceChildren();$('tasks').replaceChildren();$('approvals').replaceChildren();delete $('approvals').dataset.key;if(!$('pair-dialog').open)$('pair-dialog').showModal();}
async function refresh(){if(refreshing){refreshAgain=true;return;}refreshing=true;try{const r=await fetch('/api/state');if(remote&&r.status===401){showPairing();return;}if(!r.ok){const error=await r.json();throw new Error(error.error||'Cannot read town');}gate?.seen();const prev=state;state=await r.json();state.presence=prev?.presence;chatPages.clear();dispatchEvent(new CustomEvent('town-state',{detail:{prev,next:state}}));
  // Frames that came in during the fetch: those past the snapshot's seq apply on top; a gap means fetch again.
  for(const frame of held.splice(0))if(!take(frame)){refreshAgain=true;break;}
  if(remote)connected=true;document.body.classList.remove('connecting','unpaired');render();openWantedLink();}catch(e){connected=false;notify(e);if(state)render();}finally{refreshing=false;if(refreshAgain){refreshAgain=false;void refresh();}}}
// The Reasoning menu: one optgroup per usable provider, each listing its models. The options are rebuilt only when that list changes.
function rememberedReasoning(catId){try{return localStorage.getItem(`cat-town-reasoning:${catId}`);}catch{return null;}}
// Demonstration is never remembered: choosing it clears the cat's remembered pick, so the next start uses the real default.
function rememberReasoning(){try{const key=`cat-town-reasoning:${selected}`,mode=$('mode').value;if(mode==='demo')localStorage.removeItem(key);else localStorage.setItem(key,mode);}catch{/* private window: the choice is not remembered */}}
// Hermes (experimental) joins the Mayor's menu while town.config.json has it on (model-extras.js); the other cats never offer it.
void probeHermes().then(on=>{hermesOn=on;if(on&&state)render();});
function paintReasoning(){
  const models=withHermes(state.models,{enabled:hermesOn,cat:selected});
  const select=$('mode'),groups=reasoningGroups(models),key=JSON.stringify(groups);
  if(key!==reasoningKey){
    reasoningKey=key;
    select.replaceChildren(...groups.flatMap(g=>{
      const options=g.options.map(o=>new Option(o.label,o.value));
      if(g.label===null)return options;
      const group=document.createElement('optgroup');group.label=g.label;group.append(...options);return [group];
    }));
  }
  // A cat starts on its remembered real choice, else its own AI setting, else the town default, else a real provider. Later renders keep what the owner picked.
  const values=[...select.options].map(o=>o.value);
  if(reasoningCat!==selected){
    reasoningCat=selected;
    select.value=wantedReasoning=startingReasoning(models,state.townDefault,state.cats.find(c=>c.id===selected)?.ai,rememberedReasoning(selected));
  }else if(values.includes(wantedReasoning))select.value=wantedReasoning;
  else if(!values.includes(select.value))select.value=startingReasoning(models,state.townDefault,state.cats.find(c=>c.id===selected)?.ai,rememberedReasoning(selected));
  modeNote();
}
// The default a provider's cats use now: the town default when it is for this provider, else the provider's own default.
function effectiveDefault(provider,block){
  const td=state.townDefault;
  if(td?.usable&&td.provider===provider)return {model:td.model??block.default?.model,effort:td.effort??block.default?.effort};
  return block.default;
}
wireModelPicker($('cat-ai-model'),$('cat-ai-model-other'));
wireModelPicker($('cat-model'),$('cat-model-other'));
$('mode').onchange=()=>{wantedReasoning=$('mode').value;rememberReasoning();modeNote();if(state)scene?.update(state,selected);};

// The composer (plan 8.7, chat-composer.js): Send and its pending bubble, per-thread drafts, the thread switcher, @mentions, built-in / commands, / to focus.
const composer=createComposer({form:$('chat-form'),chatThread,chatPages,askToggle,getState:()=>state,selected:()=>selected,connected:()=>connected,select,api,notify,render,needsYou:()=>questCount,openChat:()=>showPane('inspector'),openInbox:()=>setPanel('quests',true,true),openPanel:key=>openManaged(key),canOpen:key=>canManage(key)});
// Chat manages everything (docs/design/menu-chat-mailman.md, manage.js): Options > Manage, the chips in a cat's corner, the panel commands
// and the "Set up Clowder" card on the Mayor's thread. Each item opens its panel as a sheet over the thread; the chat stays open under it.
const manageReady={routines:false,memory:false,usage:false};
const MANAGED={autonomy:()=>openSettingsPage('autonomy',{over:'thread'}),routines:()=>void routinesPanel.open(),postoffice:()=>postOffice.open(),channels:()=>postOffice.open('channels'),signins:()=>postOffice.open('signins'),apps:()=>postOffice.open('apps'),money:()=>openTreasury('money'),usage:()=>openTreasury('usage'),memory:()=>void memoryPanel.open(),backups:()=>openSettingsPage('backup',{over:'thread'})};
// Whether this device can open an item now: its probe answered (routines, memory, usage), its ☰ page drew (autonomy, backups) or a Post office entry shows.
function canManage(key){
  if(!state)return false;
  if(key==='autonomy')return !!document.querySelector('#settings-autonomy input[name="mayor-autonomy"]');
  if(key==='backups'){const page=$('settings-backup');return !!page&&page.style.display!=='none'&&!!page.querySelector('button');}
  if(key==='postoffice')return postOffice.has();
  if(['channels','signins','apps'].includes(key))return postOffice.has(key);
  if(key==='money')return true;
  return manageReady[key]===true;
}
function openManaged(key){if(!MANAGED[key]||!canManage(key))return false;for(const d of document.querySelectorAll('dialog[open]'))d.close();MANAGED[key]();return true;}
const manage=createManage({menu:$('composer-options-menu'),header:$('cat-header'),chat:$('chat'),getState:()=>state,selected:()=>selected,can:canManage,open:key=>openManaged(key),summary:()=>import('./setup-hub.js').then(hub=>hub.setupSummary()),openSetup:()=>void openSetup(),closeOptions:()=>composerOptions.close(true)});
const paintManage=()=>{if(state){manage.paint();composerOptions.paint();}};
// The hub refreshes the card when it closes, so a finished step shows at once.
async function openSetup(){const hub=await import('./setup-hub.js'),opening=hub.openSetupHub(),dialog=document.querySelector('dialog.setup-hub');if(dialog&&!dialog.dataset.watched){dialog.dataset.watched='1';dialog.addEventListener('close',()=>manage.refreshSetup());}await opening;}
// What the chat offers follows the pages and entries it opens: the autonomy and backup sections draw after their routes answer, and Post office
// entries show once their probes do.
{const watch=new MutationObserver(paintManage);for(const id of ['settings-autonomy','settings-backup','post-office-dialog']){const node=$(id);if(node)watch.observe(node,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','style']});}}
// Cancel on a queued message, and Earlier messages. One listener on the chat, because render() replaces the messages.
// The outcome of an action arrives as a stream frame like any other change, so nothing here refetches the state.
$('chat').addEventListener('click',e=>{if(e.target.closest?.('[data-earlier]')){chatThread.setFollow(false);void loadChat(selected,true);return;}const button=e.target.closest?.('[data-cancel]');if(!button)return;button.disabled=true;api('tasks/'+encodeURIComponent(button.dataset.cancel)+'/cancel',{}).then(()=>render()).catch(error=>{notify(error);chatThread.forget();render();});});
$('reply-as-answer-input').onchange=()=>render();
// The text box grows with what is typed, not with focus, so the decision strip above it stays where it was after typing.
$('message').addEventListener('input',()=>fitComposer($('message')));
// First launch: the brain card opens the AI models sign-in (the same as ☰ > AI models).
$('brain-signin').onclick=()=>openSurface('models');
$('pause').onclick=async()=>{try{await api('pause',{value:!state.paused});render();}catch(e){notify(e);}};
// Town section: back up the current world, then start a fresh one. The server keeps settings and devices.
const newWorld=document.createElement('button');
newWorld.id='new-world';newWorld.setAttribute('data-owner','');newWorld.setAttribute('data-note','Back up this town and start a fresh one');newWorld.textContent='Start new world';
$('settings-more-items').append(newWorld);
function toast(message){const el=document.createElement('div');el.setAttribute('role','status');el.textContent=message;Object.assign(el.style,{position:'fixed',left:'16px',right:'16px',bottom:'24px',zIndex:'9999',padding:'12px 16px',borderRadius:'12px',background:'var(--surface,#fff)',color:'var(--ink,#222)',boxShadow:'0 8px 24px rgba(0,0,0,.25)'});document.body.append(el);setTimeout(()=>el.remove(),12000);}
newWorld.onclick=async()=>{
  const ok=await confirmDialog({title:'Start a new world?',message:'Your current town is saved to a backup folder and all cats, goals, requests, decisions and to-dos start over. Settings and paired devices are kept.',confirmLabel:'Start new world',cancelLabel:'Keep this town',danger:true});
  if(!ok)return;
  try{
    const r=await api('world/reset',{});
    if(r.restartRequired){toast(`Backup saved to ${r.backup}. Restart Cat Town to open the new world.`);return;}
    toast(`Backup saved to ${r.backup}. Opening the new world.`);setTimeout(()=>location.reload(),1500);
  }catch(e){notify(e);}
};
// The chat tabs follow the ARIA tabs pattern (plan 8.5): aria-selected here, the roving tabindex and arrow keys in chat-sheet.js initTabsOverflow.
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-selected',String(x===b));});['chat','tasks','roads','council','memory','gallery'].forEach(id=>$(id).hidden=id!==tab);paintLive();renderMemory();renderGallery();if(tab==='chat')chatThread.pin();});
// Town memory is the Scholar's tab only. The view loads on first use and refetches only when the town's records change.
let memoryView=null;
function renderMemory(){
  const scholar=selected==='scholar'&&!!state?.cats.some(c=>c.id==='scholar');
  document.querySelector('[data-tab="memory"]').hidden=!scholar;
  $('inspector-panel').classList.toggle('memory-expanded',scholar&&tab==='memory');
  if(!scholar&&tab==='memory'){document.querySelector('[data-tab="chat"]').click();return;}
  if(scholar&&tab==='memory')import('./memory-view.js').then(({createMemoryView})=>{memoryView??=createMemoryView($('memory'),{onBack:()=>document.querySelector('[data-tab="chat"]').click()});memoryView.update(state);}).catch(notify);
}
// The Gallery is the Artist's tab, or any cat's tab when the town has no Artist. It reloads when the newest event changes.
let galleryView=null,galleryKey='';
function ensureGallery(){galleryView??=createGalleryView($('gallery'),{catName:id=>state?name(id):id});return galleryView;}
function renderGallery(){
  const show=!!state&&galleryAvailable(state.cats,selected);
  document.querySelector('[data-tab="gallery"]').hidden=!show;
  if(!show&&tab==='gallery'){document.querySelector('[data-tab="chat"]').click();return;}
  if(show&&tab==='gallery'){const key=`${selected}:${state.events.at(-1)?.id??''}`;if(key!==galleryKey){galleryKey=key;ensureGallery().load();}}
}
// The Archive list reloads when a new artifact shows among the newest events; its count goes on the board's label.
let archiveKey=null;
function renderArchive(){const key=state.events.findLast(e=>e.type==='artifact.created')?.id??'';if(key===archiveKey){scene?.setArchiveCount?.(archiveView.count);return;}archiveKey=key;void archiveView.load().then(()=>scene?.setArchiveCount?.(archiveView.count));}
async function openArtifactById(id){const g=ensureGallery();if(!g.openArtifact(id)){await g.load();g.openArtifact(id);}}
$('road-button').onclick=()=>{for(const id of ['road-a','road-b'])$(id).replaceChildren(...state.cats.map(c=>new Option(c.name,c.id)));$('road-a').value=selected;$('road-b').value=state.cats.find(c=>c.id!==selected).id;$('road-dialog').showModal();};
$('road-form').onsubmit=async e=>{e.preventDefault();try{await api('roads',{a:$('road-a').value,b:$('road-b').value});$('road-dialog').close();await refresh();}catch(err){notify(err);$('road-dialog').close();}};
function fillStyles(id,automatic=false){$(id).replaceChildren(...(automatic?[new Option('Match their role','')]:[]),...Object.entries(state.world.designs).map(([id,d])=>new Option(d.label,id)));}
$('recruit').onclick=()=>{fillStyles('cat-style',true);void fillRecruitAi();$('recruit-dialog').showModal();};
$('visit-home').onclick=()=>{showPane('world');scene?.focus();};
$('focus-home').onclick=()=>scene?.focus();
// Time of day: four looks in the ☰ menu. Scenes that have setTimeOfDay take the name; older scenes only know day and night.
const TIME_NAMES=TIMES;
function showTimeChoice(name){document.querySelectorAll('[data-world-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.worldView===name)));}
function setTimeOfDay(name){
  if(!scene||!TIME_NAMES.includes(name))return;
  if(typeof scene.setTimeOfDay==='function')scene.setTimeOfDay(name);
  else scene.setView(name==='night'?'night':'day');
  showTimeChoice(name);
}
document.querySelectorAll('[data-world-view]').forEach(b=>b.onclick=()=>setTimeOfDay(b.dataset.worldView));
{let saved='day';try{saved=localStorage.getItem('cat-town-view')||'day';}catch{}showTimeChoice(TIMES.includes(saved)?saved:'day');}
// Weather: eight looks in the ☰ menu, per viewer like the time of day (weather.js draws them).
// ?weather= picks one for this load (perf probes and screenshots); otherwise the viewer's saved choice.
function savedWeather(){const q=new URLSearchParams(location.search).get('weather');if(WEATHERS.includes(q))return q;try{const w=localStorage.getItem('cat-town-weather');return WEATHERS.includes(w)?w:'clear';}catch{return 'clear';}}
function setWeather(name){
  if(!WEATHERS.includes(name))return;
  scene?.setWeather?.(name);try{localStorage.setItem('cat-town-weather',name);}catch{}
  document.querySelectorAll('[data-weather]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.weather===name)));
}
document.querySelectorAll('[data-weather]').forEach(b=>b.onclick=()=>setWeather(b.dataset.weather));
// Graphics quality: Auto, Low, Medium, High in the ☰ menu, per viewer like the weather (quality.js). A pick is saved;
// the load-time choice (?quality= or the saved one) is only applied.
function setQuality(name,save=true){
  if(!QUALITIES.includes(name))return;
  scene?.setQuality?.(name);if(save)try{localStorage.setItem(QUALITY_KEY,name);}catch{}
  document.querySelectorAll('[data-quality]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.quality===name)));
}
document.querySelectorAll('[data-quality]').forEach(b=>b.onclick=()=>setQuality(b.dataset.quality));
$('replay-visits').onclick=()=>scene?.replay();
$('recruit-form').onsubmit=async e=>{e.preventDefault();try{const {id}=await api('cats',{name:$('cat-name').value,role:$('cat-role').value,...($('cat-style').value?{style:$('cat-style').value}:{})});await saveRecruitAi(id);$('recruit-dialog').close();$('recruit-form').reset();selected=id;await refresh();}catch(err){notify(err);$('recruit-dialog').close();}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
document.querySelectorAll('.device-nav button').forEach(b=>b.onclick=()=>showPane(b.dataset.pane));
$('reset-view').onclick=()=>scene?.reset();$('zoom-in').onclick=()=>scene?.zoom(1.2);$('zoom-out').onclick=()=>scene?.zoom(1/1.2);
const mediaSettings=createMediaSettings({root:$('media-settings'),ask:confirmDialog,notify});
// The models panel rebuilds its body on every render, so the Media group is moved back into that body after each one.
new MutationObserver(()=>{const m=$('media-settings'),b=$('models-body');if(m&&b&&m.parentNode!==b)b.append(m);}).observe($('models-body'),{childList:true});
for(const b of [$('models-open'),$('models-chip')])b?.addEventListener('click',()=>void mediaSettings.refresh());
const modelsPanel=createModelsPanel({button:$('models-open'),chip:$('models-chip'),dialog:$('models-dialog'),body:$('models-body'),api,onChanged:()=>{aiCatalog=null;void refresh();},catsWithOverride:provider=>state.cats.filter(c=>c.ai?.[provider]).map(c=>c.id)});

// Per-cat model and effort. The status route gives the efforts and the town defaults; the cat's own choice comes from state.
async function catAiCatalog(){
  if(aiCatalog)return aiCatalog;
  try{const r=await fetch('/api/models/status',{cache:'no-store'});if(r.ok){aiCatalog=await r.json();aiCatalogVersion++;}}catch{/* the section stays hidden */}
  return aiCatalog;
}
function renderSuggestion(cat){
  const s=cat.aiSuggestion,box=$('cat-suggestion');
  box.hidden=!s||state.readOnly;
  $('cat-suggestion-text').textContent=s?suggestionText(s):'';
  // An applied choice needs no Accept: Got it clears the note, and Settings below changes the model.
  $('cat-suggestion-accept').hidden=!!s?.applied;$('cat-suggestion-dismiss').textContent=s?.applied?'Got it':'Dismiss';
  $('cat-suggestion-error').textContent='';
  box.dataset.cat=cat.id;
}
async function renderCatAi(cat){
  renderSuggestion(cat);
  const box=$('cat-ai');
  if(state.readOnly){box.hidden=true;return;}
  const catalog=await catAiCatalog();
  const providers=providerChoices(state.models,catalog);
  box.hidden=providers.length===0;
  if(box.hidden)return;
  const key=JSON.stringify([cat.id,cat.ai??null,aiCatalogVersion,providers.map(p=>p.id)]);
  if(key===catAiKey)return;
  catAiKey=key;
  paintCatAiFields(cat,catalog,providers);
}
function paintCatAiFields(cat,catalog,providers){
  const select=$('cat-ai-provider');
  const previous=select.value||parseReasoning($('mode').value).mode;
  select.replaceChildren(...providers.map(p=>new Option(p.name,p.id)));
  select.value=providers.some(p=>p.id===previous)?previous:providers[0].id;
  const provider=select.value,block=catalog[provider].ai,saved=cat.ai?.[provider]??{};
  const effective=effectiveDefault(provider,block);
  paintModelPicker($('cat-ai-model'),$('cat-ai-model-other'),{models:block.models??[],value:saved.model??'',blankLabel:`Town default: ${effective.model??'none'}`});
  $('cat-ai-effort').replaceChildren(...effortChoices(block.efforts,`Town default: ${block.default.effort??'not set'}`).map(c=>new Option(c.label,c.value)));
  $('cat-ai-effort').value=saved.effort??'';
  $('cat-ai-note').textContent=usingText({default:{model:saved.model??effective.model,effort:saved.effort??effective.effort}});
  $('cat-ai-error').textContent='';
  $('cat-ai-model').closest('label').hidden=provider==='hosted';
}
$('cat-ai-provider').onchange=async()=>{const cat=state.cats.find(c=>c.id===selected);const catalog=await catAiCatalog();if(cat&&catalog)paintCatAiFields(cat,catalog,providerChoices(state.models,catalog));};
// Save and Use town default share one flow: "Saving…", "Saved ✓", then the cat's Settings disclosure closes.
async function saveCatAi(button,body,provider){
  const saved=await savingButton(button,api(`cats/${encodeURIComponent(selected)}/ai`,{provider,...body}).then(async()=>{catAiKey='';await refresh();}),{errorNode:$('cat-ai-error')});
  if(saved)catSettings?.close();
}
$('cat-ai-save').onclick=async()=>{
  const provider=$('cat-ai-provider').value,block=(await catAiCatalog())?.[provider]?.ai;
  const draft=aiDraft(provider,{model:readModelPicker($('cat-ai-model'),$('cat-ai-model-other')),effort:$('cat-ai-effort').value},block);
  if(draft.error){$('cat-ai-error').textContent=draft.error;return;}
  await saveCatAi($('cat-ai-save'),draft.body,provider);
};
$('cat-ai-default').onclick=()=>saveCatAi($('cat-ai-default'),{model:null,effort:null},$('cat-ai-provider').value);
async function answerSuggestion(accept){
  const id=$('cat-suggestion').dataset.cat;
  $('cat-suggestion-error').textContent='';
  try{await api(`cats/${encodeURIComponent(id)}/ai/suggestion`,{accept});catAiKey='';await refresh();}
  catch(err){$('cat-suggestion-error').textContent=err.message;}
}
$('cat-suggestion-accept').onclick=()=>answerSuggestion(true);
$('cat-suggestion-dismiss').onclick=()=>answerSuggestion(false);

// The Recruit dialog starts on the town default for the chat's current provider. Demo has no model choice.
async function fillRecruitAi(){
  const provider=parseReasoning($('mode').value).mode,box=$('recruit-ai');
  box.hidden=true;box.dataset.provider='';
  if(!provider||provider==='demo')return;
  const catalogBlock=(await catAiCatalog())?.[provider]?.ai;
  if(!catalogBlock)return;
  const block={...catalogBlock,default:effectiveDefault(provider,catalogBlock)};
  paintModelPicker($('cat-model'),$('cat-model-other'),{models:block.models??[],value:block.default.model??'',blankLabel:'Town default'});
  $('cat-effort').replaceChildren(...effortChoices(block.efforts,`Town default: ${block.default.effort??'not set'}`).map(c=>new Option(c.label,c.value)));
  $('cat-effort').value=block.default.effort??'';
  box.querySelector('[data-ai-model]').hidden=provider==='hosted';
  box.dataset.provider=provider;box.dataset.model=block.default.model??'';box.dataset.effort=block.default.effort??'';
  box.hidden=false;
}
// Stores an override only when the owner changed the town default, so the cat keeps following the default otherwise.
async function saveRecruitAi(id){
  const box=$('recruit-ai'),provider=box.dataset.provider;
  if(box.hidden||!provider)return;
  const block=(await catAiCatalog())?.[provider]?.ai;
  const draft=aiDraft(provider,{model:readModelPicker($('cat-model'),$('cat-model-other')),effort:$('cat-effort').value},block);
  if(draft.error)throw new Error(draft.error);
  const model=draft.body.model??'',effort=draft.body.effort??'';
  if(model===box.dataset.model&&effort===box.dataset.effort)return;
  await api(`cats/${encodeURIComponent(id)}/ai`,{provider,model:draft.body.model,effort:draft.body.effort});
}
// Once the probe shows AI models (host only), the brain card can offer its Sign in button.
void modelsPanel.probe().then(()=>{if(state)render();}).catch(()=>{});
const connectorsPanel=createConnectorsPanel({button:$('connectors-open'),dialog:$('connectors-panel'),body:$('connectors-body'),request:api});
void connectorsPanel.probe();
// The Mayor's corner > Routines. Run now's "Open chat" shows the cat that runs it.
const routinesPanel=initRoutinesPanel({town:()=>state,onOpenChat:id=>{if(state?.cats.some(c=>c.id===id))select(id);}});
// Post office > Channels > Telegram: host only, so the entry shows once its route answers.
const telegramPanel=createTelegramPanel({button:$('telegram-open')});
void telegramPanel.probe();
// The Archivist's corner > Memory (the wiki pages, owners only; the graph is its second view), and Usage (tokens and the monthly cap) in the
// Moonvault's Usage tab.
const memoryPanel=initMemoryPanel({town:()=>state});
const usagePanel=initUsagePanel({town:()=>state,mount:{dialog:$('treasury-dialog'),body:$('vault-usage-body'),lede:$('vault-usage-lede'),show:()=>openTreasury('usage'),showing:()=>vault.current()==='usage'}});
for(const [key,panel] of [['routines',routinesPanel],['memory',memoryPanel],['usage',usagePanel]])void panel.ready.then(ok=>{manageReady[key]=ok===true;paintManage();});
// Post office > Channels > Discord: host only, like Telegram.
const discordPanel=createDiscordPanel({button:$('discord-open')});
void discordPanel.probe();
// Post office > Sign-ins > Accounts & connections (plan 1.9): every account, its health and what the cats may use. Owner and host only, like Connectors.
const accountsPanel=createAccountsPanel({button:$('accounts-open')});
void accountsPanel.probe();
// The Post office's other entries: Sign-in clients (Sign-ins > Advanced), Email to the Mayor and Android ping (Channels), each listed once its owner route answers.
const ownerClientsPanel=initOwnerClientsPanel();
const mailWatchPanel=initMailWatchPanel({openClients:()=>openSurface('clients'),openConnectors:()=>openSurface('connectors')});
const ntfyPanel=initNtfyPanel({openDevices:()=>openSurface('devices')});
$('share').onclick=async()=>{try{const r=await fetch('/api/sharing');const data=await r.json();if(!r.ok)throw new Error(data.error);$('share-help').textContent=data.enabled?'Open a viewing link on your other device:':'Restart the town with start-town-mobile.cmd to enable Wi-Fi viewing.';$('share-links').replaceChildren(...data.urls.map(url=>{const row=document.createElement('div'),input=document.createElement('input'),copy=document.createElement('button');input.value=url;input.readOnly=true;input.setAttribute('aria-label','Private viewing link');input.onclick=()=>input.select();copy.textContent='Copy link';copy.onclick=async()=>{try{await navigator.clipboard.writeText(url);copy.textContent='Copied';}catch{input.select();copy.textContent='Select and copy link';}};row.append(input,copy);return row;}));await loadRemoteSettings();$('share-dialog').showModal();}catch(e){notify(e);}};

// Devices leads with Tailscale, with Quick Tunnel as the fallback (plan 5.1).
const remotePath=createRemotePath({root:$('remote-path'),request:api,reload:()=>loadRemoteSettings().catch(notify)});
// Passkey step-up (plan 5.5): ☰ > Devices > Passkey on an owner phone, shown only on a stable address.
const stepUp=createStepUp({button:$('step-up-open')});
async function loadRemoteSettings(){
  const r=await fetch('/api/remote/status'),data=await r.json();if(!r.ok)throw new Error(data.error);
  remotePath.show(data);
  $('remote-status').textContent=remoteStatusText(data);$('remote-address-note').textContent=addressNote(data);
  $('remote-start').hidden=!!data.origin;$('remote-stop').hidden=!data.origin;$('remote-invite').disabled=!data.origin;$('remote-invite-hint').hidden=!!data.origin;
  $('paired-devices').replaceChildren(...data.devices.map(d=>{const row=document.createElement('div'),label=document.createElement('span'),detail=document.createElement('small'),follow=document.createElement('small'),button=document.createElement('button');label.textContent=d.name;detail.textContent=(d.permission==='owner'?'View and control':'View only')+' · expires '+new Date(d.expiresAt).toLocaleDateString();follow.textContent=followText(d);label.append(detail,follow);button.textContent='Revoke';button.onclick=async()=>{try{await api('remote/revoke/'+d.id,{});await loadRemoteSettings();}catch(e){notify(e);}};const passkey=passkeyControls(d,data,{request:api,reload:loadRemoteSettings,notify});if(passkey)label.append(passkey.line);row.append(label,...(passkey?.buttons??[]),button);return row;}));
  if(!data.devices.length)$('paired-devices').textContent='No devices paired yet.';
  $('owner-key').hidden=!data.ownerKeyRotates;
}
// A new owner key (plan 11.27): every browser holding the old cookie is signed out; this one gets the new cookie with the answer.
$('owner-key-rotate').onclick=async()=>{const button=$('owner-key-rotate');button.disabled=true;try{await api('owner-key/rotate',{});button.textContent='Other browsers signed out';}catch(e){notify(e);}finally{button.disabled=false;}};
$('remote-start').onclick=async()=>{const button=$('remote-start');button.disabled=true;$('remote-status').textContent='Connecting your town…';try{await api('remote/start',{});await loadRemoteSettings();}catch(e){$('remote-status').textContent=e.message;}finally{button.disabled=false;}};
$('remote-stop').onclick=async()=>{try{await api('remote/stop',{});$('pair-invitation').hidden=true;await loadRemoteSettings();}catch(e){notify(e);}};
$('remote-invite').onclick=async()=>{try{const invite=await api('remote/invite',{permission:$('remote-permission').value});$('pair-qr').innerHTML=invite.qr||'';$('pair-link').value=invite.origin+'/#pair='+encodeURIComponent(invite.code);$('pair-code').textContent=invite.code;$('pair-expiry').textContent=(invite.permission==='owner'?'This code grants town control. ':'This code grants viewing only. ')+'Expires '+new Date(invite.expiresAt).toLocaleTimeString()+'. A new code replaces this one.';$('pair-invitation').hidden=false;}catch(e){notify(e);}};
$('pair-link').onclick=()=>$('pair-link').select();
$('copy-pair-link').onclick=async()=>{try{await navigator.clipboard.writeText($('pair-link').value);$('copy-pair-link').textContent='Copied';}catch{$('pair-link').select();}};
$('pair-dialog').addEventListener('cancel',e=>e.preventDefault());
async function ensureScene(){if(scene)return;try{const {createScene}=await import('./town.js');scene=await createScene(select,openTreasury,moveHome,demoChat);scene.update(state,selected);scene.setAttention(questAlert);if(townAim){scene[townAim===selected?'select':'focus'](townAim,{inset:paneInset()});townAim=null;}scene.setArchiveCount?.(archiveView.count);document.querySelectorAll('[data-world-view],[data-weather],[data-quality]').forEach(b=>b.disabled=false);setWeather(savedWeather());{let s=null;try{s=localStorage;}catch{}setQuality(savedQuality(location.search,s),false);}}catch(e){$('scene-error').hidden=false;$('scene-error').textContent='The town view could not load. Conversations and approvals still work.';console.error(e);}finally{requestAnimationFrame(()=>requestAnimationFrame(()=>{$('town-loading').hidden=true;}));}}
// The page's one live feed, on this computer and on a paired phone alike (src/state-delta.ts). Each frame is one journal
// event applied to the state in place; /api/state is fetched only at load, after a world switch (`changed`), and when
// a reconnect's hello or a frame shows the page missed something.
const held=[];
// Applies one frame to the state; false when the page must refetch.
function take(frame){
  if(frame.hello)return frame.seq<=state.seq&&frame.world===state.activeWorld?.id;
  const next=applyFrame(state,frame);if(!next)return false;
  if(next!==state){const prev=state;state=next;dispatchEvent(new CustomEvent('town-state',{detail:{prev,next}}));}
  return true;
}
// The working line and the streamed draft under the chat (plan 8.2, 8.3) are drawn by chat-thread.js; activity and delta frames repaint only them.
function paintLive(){if(state)chatThread.live({page:chatPages.get(selected),state,selected});}
function onFrame(data){
  if(data==='changed'){held.length=0;void refresh();return;}
  const frame=JSON.parse(data);
  // Activity and live text: not journal events, so only the working line repaints.
  if((frame.activity||frame.delta)&&state&&!refreshing){const next=applyFrame(state,frame);if(next){state=next;paintLive();}return;}
  if(refreshing||!state){held.push(frame);if(!refreshing)void refresh();return;}
  if(take(frame))render();else void refresh();
}
// The header's connection line. Away from the host computer, a host that stopped answering reads as the closed gate (plan 10.10): its own
// data-state, a calm hollow dot in style.css rather than Reconnecting…'s red one.
const awayFromHost=()=>remote||!/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
function paintConnection(){
  const el=$('connection'),g=gate?.gateState(),closed=!connected&&awayFromHost()&&g?.open===false;
  el.textContent=connected?(state?.readOnly?'Live · view only':remote?'Paired · control':'Town connected'):closed?'Gate closed':'Reconnecting…';el.dataset.state=connected?'up':closed?'closed':'down';
  el.title=closed?`Gate closed: the host computer is asleep or off.${g.lastSeenAt?` It last answered at ${new Date(g.lastSeenAt).toLocaleTimeString()}.`:''}`:'';
  paintTownStatus();
  paintHostDown();
}
// While Clowder is not answering: the bar shows (away from the host, with the likely reason), the activity line and its lead hide, since
// they would describe a town that is not answering, and Send says why it is off. body.host-down moves the sheets and the strip under the bar.
function paintHostDown(){
  const down=hostDown();
  document.body.classList.toggle('host-down',down);hostBar.hidden=!down;
  const text=down?`Clowder is not answering. Retrying…${awayFromHost()?' The host computer may be asleep or off.':''}`:'';
  if(hostText.textContent!==text)hostText.textContent=text;
  $('world-activity').hidden=down;paintWaiting();
  const why=down?'Send is off while Clowder is not answering.':connected?'':'Send is off while Clowder reconnects.';
  $('send').title=why;$('send').setAttribute('aria-label',why?`Send message. ${why}`:'Send message');
  sendReason.textContent=down?why:'';sendReason.hidden=!down;
}
// Retry opens the page stream again at once instead of waiting for the next try; its answer closes the bar.
hostRetry.onclick=()=>{hostRetry.textContent='Trying…';openStream();setTimeout(()=>{hostRetry.textContent='Retry';},1500);};
// The bar's height, for the sheets and the strip that move down under it: its text wraps on a narrow screen.
if(typeof ResizeObserver==='function')new ResizeObserver(()=>{if(!hostBar.hidden)document.body.style.setProperty('--host-bar-h',`${hostBar.offsetHeight}px`);}).observe(hostBar);
// The header logo's status dot reads Running or Paused (manage.js townStatus); a tap opens the Town panel, where Pause and Resume are.
function paintTownStatus(){
  const b=$('town-status'),s=townStatus({loaded:!!state,paused:!!state?.paused,connected,connection:$('connection').textContent});
  if(b.dataset.state===s.state&&b.getAttribute('aria-label')===s.label)return;
  b.dataset.state=s.state;b.querySelector('.town-status-word').textContent=s.word;b.setAttribute('aria-label',s.label);b.title=s.title;
}
$('town-status').onclick=()=>{if(!openSettingsPage('town'))$('menu-toggle').click();};
function openStream(){
  stream?.close();const source=stream=new EventSource('/api/events');
  gate?.watch(source);
  source.onopen=()=>{connected=true;if(state)render();};
  source.onmessage=e=>onFrame(e.data);
  source.onerror=()=>{
    connected=false;paintConnection();if(state)render();
    // A refused stream (401 once unpaired, a server that went away) is never retried by the browser: check, then reopen.
    if(source.readyState===EventSource.CLOSED)setTimeout(()=>{if(stream===source)void refresh().then(()=>{if(state&&stream===source)openStream();});},pollMs);
  };
}
$('pair-form').onsubmit=async e=>{e.preventDefault();$('pair-submit').disabled=true;$('pair-error').textContent='';try{await api('pair',{code:$('device-code').value,name:$('device-name').value});$('device-code').value='';$('pair-dialog').close();void stepUp.probe();$('notice').textContent='';openStream();await refresh();await ensureScene();if(/ClowderApp/.test(navigator.userAgent))location.reload();else offerNotifications();}catch(error){$('pair-error').textContent=error.message;}finally{$('pair-submit').disabled=false;}};
$('logout').onclick=async()=>{try{await api('logout',{});showPairing();}catch(e){notify(e);}};
// A notification opens /#item=<quest id>: that card opens once the town has loaded, and again when only the fragment changes
// (a notification tapped while Clowder is open). The fragment is cleared once read, so a reload never opens it twice.
function takeLink(){const link=linkFromHash(location.hash);if(!link)return;wantedLink=link;history.replaceState(null,'',location.pathname+location.search);openWantedLink();}
// #thread=<task> opens that request's thread and #cat=<id> that cat's chat (plan 8.10); both ease the town there. #item=<quest id> opens the
// Inbox and that card's Details (plan 11.20; a decision opens its own card); the older #approval=<id> is the item approval:<id>. An item
// waits for the Inbox's first list (onCount calls this again), so a link opened from a notice finds a card filed a moment ago.
function openWantedLink(){
  if(!wantedLink||!state)return;
  const {kind,id}=wantedLink,item=kind==='item'?id:kind==='approval'?`approval:${id}`:null;
  if(item&&questCount===null)return;
  wantedLink=null;
  if(kind==='cat'){if(state.cats.some(c=>c.id===id))select(id);else $('notice').textContent='That cat is not in this town.';return;}
  if(kind==='thread'){showPane('inspector');chatThread.open({kind:'request',id});return;}
  void questsPanel.openItem(item).then(found=>{
    if(found)setPanel('quests',true);
    else if(item.startsWith('approval:'))openDecisionLink(item.slice('approval:'.length));
    else $('notice').textContent='That item is no longer in your Inbox.';
  }).catch(notify);
}
// A decision the Inbox no longer lists: still pending in the town (opens its card), or answered in the meantime (on Telegram, or on
// another device), when the cat's chat shows the answer.
function openDecisionLink(id){
  if(openApprovalSheet(id))return;
  const a=state.approvals.find(x=>x.id===id);
  if(a&&state.cats.some(c=>c.id===a.cat))select(a.cat);
  $('notice').textContent=a?`${name(a.cat)}’s decision was already answered.`:'That decision is no longer open.';
}
// The first-run card that offers notifications (notify-prompt.js), on owner devices only. It asks once per browser.
function offerNotifications(){if(state&&!state.readOnly)void maybePromptNotifications({controller:sound});}
// The share target (plan 11.25): sw.js stashes a shared file in this browser and opens /?share=<id>. Nothing reaches the town until the owner
// taps Save to Archive here, which posts each file to the owner upload route (11.22) as this page. Discard, a stash older than STASH_MS, a
// stash under another id, and any page that is not the owner's delete it. The three names match sw.js (test/share-target-ui.test.mjs).
const SHARE_CACHE='share-stash',STASH_PREFIX='/share-stash/',STASH_MS=10*60*1000;
const shareId=new URLSearchParams(location.search).get('share');
if(shareId!==null){const q=new URLSearchParams(location.search);q.delete('share');history.replaceState(null,'',location.pathname+(q.size?`?${q}`:'')+location.hash);}
const fileSize=n=>n<1024?`${n} B`:n<1024*1024?`${Math.round(n/1024)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
// A long name is cut in the middle, keeping its ending, so the sheet never scrolls sideways at 375 px.
const shortName=name=>[...name].length>32?`${[...name].slice(0,21).join('')}…${[...name].slice(-10).join('')}`:name;
async function takeShare(owner){
  if(typeof caches==='undefined')return;
  let cache;try{cache=await caches.open(SHARE_CACHE);}catch{return;}
  const files=[];
  for(const request of await cache.keys()){
    const response=await cache.match(request),at=Number(response?.headers.get('X-Stashed-At'));
    if(owner&&shareId&&new URL(request.url).pathname.startsWith(`${STASH_PREFIX}${shareId}/`)&&Date.now()-at<STASH_MS)files.push({request,response});
    else await cache.delete(request);
  }
  if(!files.length)return;
  const named=files.map(({response:r})=>{let name='Shared file';try{name=decodeURIComponent(r.headers.get('X-File-Name')||name);}catch{}return {name,type:r.headers.get('Content-Type')||'unknown type',size:Number(r.headers.get('X-File-Size'))||0};});
  const save=await confirmDialog({title:files.length===1?'Save this shared file?':`Save these ${files.length} shared files?`,
    message:`${named.map(f=>`${shortName(f.name)} (${f.type}, ${fileSize(f.size)})`).join('; ')}. Saved files go to the Archive, where your cats can read them when you ask.`,
    confirmLabel:'Save to Archive',cancelLabel:'Discard'});
  const saved=[],failed=[];
  if(save)for(const [i,{response}] of files.entries()){
    try{
      const r=await fetch('/api/uploads',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-Town-Action':'owner','X-File-Name':encodeURIComponent(named[i].name)},body:await response.blob()});
      if(r.ok)saved.push(named[i].name);else failed.push(`${named[i].name}: ${(await r.json().catch(()=>({}))).error||'not saved'}`);
    }catch{failed.push(`${named[i].name}: not saved`);}
  }
  for(const {request} of files)await cache.delete(request);
  if(save)$('notice').textContent=[saved.length?`Saved to the Archive: ${saved.join(', ')}.`:'',failed.join(' ')].filter(Boolean).join(' ');
}
const arrived=location.href;const fragment=new URLSearchParams(location.hash.slice(1)),invitation=fragment.get('view'),pairCode=fragment.get('pair');
takeLink();
// Android outside the app: offer the APK, and a link that opens this exact pairing link in Clowder (the #pair code survives).
if(/Android/.test(navigator.userAgent)&&!/ClowderApp/.test(navigator.userAgent)){$('pair-app').hidden=false;$('pair-app-open').href='clowder://open?url='+encodeURIComponent(arrived);}
if(invitation||pairCode)history.replaceState(null,'',location.pathname);
if(invitation){try{await api('viewer-session',{token:invitation});}catch(e){notify(e);}}
if(pairCode)$('device-code').value=pairCode;
// A link for the town already open changes only the fragment, which never reloads the page, so read it by reloading.
addEventListener('hashchange',()=>{const next=new URLSearchParams(location.hash.slice(1));if(next.has('pair')||next.has('view'))location.reload();else takeLink();});
try{
  const response=await fetch('/api/remote-access');if(!response.ok)throw new Error('Open a fresh viewing or pairing link from your host computer.');
  const access=await response.json();remote=access.remote;document.body.classList.toggle('remote',remote);document.body.classList.remove('connecting');$('logout').hidden=!remote;
  // pollMs: how long to wait before retrying a stream the browser gave up on.
  pollMs=access.pollMs;
  // The closed gate (plan 10.10): town-gate carries {open,lastSeenAt} for the banner and the town; nothing queues while it is closed.
  gate=createGate({every:pollMs,onChange:detail=>{paintConnection();dispatchEvent(new CustomEvent('town-gate',{detail}));}});
  if(remote&&!access.paired)showPairing();else{openStream();await refresh();await ensureScene();offerNotifications();}
  if(remote)void stepUp.probe();
  // A phone that slept can come back with its stream closed: reopen it, and its hello says whether to refetch.
  if(remote)document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state&&stream?.readyState===EventSource.CLOSED)openStream();});
}catch(e){notify(e);}
void takeShare(!!state&&!state.readOnly);

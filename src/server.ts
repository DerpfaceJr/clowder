import Fastify,{type FastifyInstance,type FastifyReply,type FastifyRequest,type HTTPMethods} from 'fastify';
import staticPlugin from '@fastify/static';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {gatePath,installAccess,isHost,isOwner,lanAddresses,memberPerson,ownerKeyFile,ownerSetCookie} from './access.ts';
import {accessories,chromas,designs,houseDecor,kit} from './world.ts';
import {registerTreasury} from './treasury.ts';
import {OWNER,Pairing,type Role} from './pairing.ts';
import {People} from './people.ts';
import {Tunnel} from './tunnel.ts';
import {TailscaleServe,detectTailscale,serveCommand,servePort} from './tailscale.ts';
import {RemoteCarrier,remoteProvider,type RemoteProvider} from './remote-provider.ts';
import {installRemoteAccess,isSteppedUp} from './remote-access.ts';
import {RemoteKeeper,RemoteSettings} from './remote-keeper.ts';
import {registerRendezvousRoute,rendezvousFor} from './rendezvous.ts';
import {registerAndroidApk} from './android-apk.ts';
import {installAppCsp,installGzip,installServiceWorkerHeaders} from './pwa.ts';
import {installStateGzip} from './state-gzip.ts';
import {buildStamp} from './build-info.ts';
import {preUpgradeSnapshot} from './snapshot.ts';
import {Backups,registerBackupRoutes} from './backup.ts';
import {recoverRestore,registerRestoreRoutes} from './restore.ts';
import {Cron} from 'croner';
import {DEFAULT_OLLAMA,ModelHub,defaultsFor,normalizeMode,providerStatus,registerCatAiRoutes,registerMediaRoutes,registerModelRoutes} from './models.ts';
import {latestSeason,publicSeason,readSeason} from './season-view.ts';
import {seasonFrame,type CoinTotals} from './season-watch.ts';
import {memoryFor,registerMemoryRoutes} from './memory.ts';
import {registerWikiRoutes,wikiOf} from './wiki.ts';
import {projects} from './projects.ts';
import {doneQuests,quests,type QuestInput,type SeasonCapability} from './quests.ts';
import type {Integration} from './health.ts';
import {economyOn,loadConfig} from './config.ts';
import {registerSeasonRoutes} from './season-host.ts';
import {registerWorkshopRoutes,wslSpawner} from './workshop.ts';
import {WorkshopSetup} from './workshop-setup.ts';
import {importWorkshopOutbox} from './workshop-outbox.ts';
import {PushService,registerPushRoutes,storeQuestInput} from './push.ts';
import {NtfyService,registerNtfyRoutes} from './ntfy.ts';
import {registerChannelRoutes} from './chat-channel.ts';
import {OwnerVerbs,registerOwnerVerbRoutes} from './owner-verbs.ts';
import {OwnerTokens,registerOwnerTokenRoutes} from './owner-tokens.ts';
import {DiscordChannel} from './discord.ts';
import {TelegramChannel} from './telegram.ts';
import {MailWatcher,registerMailRoutes} from './mail-inbox.ts';
import {ForYou,dismissSuggestion,registerForYouRoutes,startSuggestion} from './for-you.ts';
import {googleCollectors} from './for-you-google.ts';
import {clowderCollectors} from './for-you-clowder.ts';
import {registerAutonomyRoutes} from './autonomy.ts';
import {catBrowserSettings,registerCatBrowserRoutes} from './cat-browser.ts';
import {pairLink,pairQrSvg,registerSetupRoutes} from './setup-routes.ts';
import {refuseWritesAfterReset,registerWorldResetRoute} from './world-reset.ts';
import {DeltaFeed} from './state-delta.ts';
import {WorldHost,registerWorldDeleteRoute,registerWorldIntroRoute,registerWorldRoutes} from './worlds.ts';
import {registerArtifactRoutes} from './artifacts.ts';
import {registerUploadRoutes} from './uploads.ts';
import {registerGoalRoutes} from './goals.ts';
import {registerRoutineRoutes,setBriefingQuestInput} from './routines.ts';
import {registerUsageRoutes} from './usage.ts';
import {registerAskRoute} from './ask.ts';
import {RealMoney,registerRealMoneyRoutes,registerStripeWebhook} from './real-money.ts';
import {ConnectorHub,registerConnectRoutes,registerConnectorRoutes} from './connectors.ts';
import {AccountMonitor} from './accounts.ts';
import {openSuggestions,type Store} from './store.ts';
import type {MemberBudgets, Town} from './engine.ts';
import {ipcBroker,openSecretStore} from './secret-store.ts';
import {HermesSidecar,registerHermesRoutes} from './hermes.ts';
import {HermesBridge} from './hermes-bridge.ts';
import {HermesBootstrap} from './hermes-bootstrap.ts';
import {registerTownMcp} from './town-mcp.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=loadConfig(root);
// The coin economy (seasons) is off unless town config says economy.enabled: true. Read once at start, like the rest of config.
const seasonsOn=economyOn(config);
const dataPath=resolve(process.env.CAT_TOWN_DATA||resolve(root,'data'));
// A new build's first boot copies the data into backups/pre-<commit>-<time>/ before anything below can write or replay (plan 7.1).
// A failed copy is logged and the boot goes on, as before 7.1; last-boot.json is not written, so the next boot tries again.
// A restore the desktop app did not finish swapping (plan 7.6) is finished or put back first, so nothing below reads a mixed data folder.
try{const r=await recoverRestore(dataPath);if(r)console.log(`An interrupted restore was ${r==='finished'?'finished':'put back'}.`);}
catch(err){console.error(`Restore recovery failed: ${(err as Error).message}`);throw err;}
const build=buildStamp(root);
try{
  const shot=preUpgradeSnapshot(dataPath,build.get());
  if('skipped' in shot){if(shot.skipped==='no-commit')console.log('Pre-upgrade snapshot skipped: this build has no commit.');}
  else if(shot.folder)console.log(`Pre-upgrade snapshot: ${shot.files} files in ${shot.folder}`);
}catch(err){console.error(`Pre-upgrade snapshot failed, continuing without one: ${(err as Error).message}`);}
// The owner session (security pass H2, access.ts). The desktop app passes its own key and sets the cookie in its window; it leaves the environment
// here, so no child process inherits it. Under npm start the key is kept in the data folder (plan 11.27, access.ts ownerKeyFile), so the owner's
// browser stays signed in across restarts, and the console link below carries a per-launch code that sets the cookie, never the key.
const appKey=process.env.CAT_OWNER_KEY||undefined;delete process.env.CAT_OWNER_KEY;
const ownerKeys=appKey?null:ownerKeyFile(dataPath),ownerSession=()=>appKey??ownerKeys!.session();
const ownerLinkLine=()=>`Clowder: http://127.0.0.1:${port}${ownerKeys?`/?owner=${ownerKeys.link()}`:''}`;
// Saved keys first: every module below reads its secrets from this store (desktop app: encrypted by its main process; npm start: plain text).
const broker=ipcBroker(),secretStore=await openSecretStore(dataPath,broker);
// Providers come from the saved AI models settings and env. Models, devices, push keys and the tunnel are global (dataPath).
// A plan call's outcome goes to the monitor, which moves the plan's Account (accounts.ts plan()).
const hub=new ModelHub({file:resolve(dataPath,'models.json'),config,env:process.env,planHealth:(account,fault)=>accountMonitor.plan(account,fault)});
// Store, Town, seasons, season feed and workshop belong to the active world. Routes read them through `worlds`, so a switch takes effect everywhere.
// Real money is global like the models: one policy, one ledger and one monthly limit whichever world is open. Off by default.
const realMoney:RealMoney=new RealMoney({dataDir:dataPath,journal:():Store=>worlds.store});
// Connectors and plugins are global like the models. Clients start after listen (below) and close on exit. Grants (accounts.json) are per world.
// remote: where a phone's sign-in may come back (item 1.6). Stable only on Tailscale or a named tunnel: a Quick Tunnel's address dies with it, so phones paste back.
const connectorHub=new ConnectorHub({dataDir:dataPath,port:Number(process.env.PORT||config.port),world:():string=>worlds.activeId,remote:()=>{const s=tunnel.status();return s.origin?{origin:s.origin,stable:s.provider==='tailscale'||s.named}:undefined;}});
// Every saved secret value, read per tool call: each tool result is masked against these before it is journaled or seen by a model.
// The Hermes Mayor's sidecar (plan 4.9), only with hermes.enabled: its own HERMES_HOME in the data folder, the gate plugin and the loopback gate routes
// below. Mayor tasks in mode hermes run on it through the bridge (4.10). Its API key and gate token are saved keys, so tool results are masked against them too.
// With no python set, the runtime shipped in hermes-runtime/ is built in the data folder on first enable (4.13); GET /api/hermes/runtime shows it.
const hermesPython=process.env.CAT_HERMES_PYTHON||config.hermes?.python||null;
const hermesRuntime=config.hermes?.enabled===true&&!hermesPython?new HermesBootstrap({dataDir:dataPath,bundle:resolve(root,'hermes-runtime')}):null;
const hermes:HermesSidecar|null=config.hermes?.enabled===true?new HermesSidecar({dataDir:dataPath,root,port:Number(config.hermes.port)||18642,clowderPort:Number(process.env.PORT||config.port),python:hermesPython,bootstrap:hermesRuntime,journal:():Store=>worlds.store}):null;
const bridge:HermesBridge|null=hermes?new HermesBridge({sidecar:hermes,town:():Town=>worlds.town}):null;
const secrets=()=>[ownerSession(),...hub.secretValues(),...connectorHub.secretValues(),...realMoney.secretValues(),catBrowserSettings(dataPath).token,telegram.secret(),discord.secret(),...(hermes?.secretValues()??[])];
// personName reads people (made below, before anything can call it: a member's name is read only when their work runs or speaks).
const worlds=new WorldHost({root,dataDir:dataPath,config,providers:hub.providers,media:()=>hub.media(),claude:()=>hub.claudeTools(),realMoney,townDefault:()=>hub.townDefault(),connectors:()=>connectorHub,secrets,hermes:()=>bridge,personName:id=>people.name(id),
  // Read and set when the town needs them, so people (made below) need not exist yet (plan 10.9).
  members:{budgetOf:id=>people.budgetOf(id),setBudget:(actor,id,tokens)=>people.setBudget(actor,id,tokens)}});
// Account health (items 1.2, 1.3): probes every connector account at boot and every 15 min, and files one quest per account per state change in the
// open world. A switch checks again, so the new world's quests are filed there.
const accountMonitor=new AccountMonitor({source:connectorHub,store:()=>worlds.store,strikes:()=>loadConfig(root).planTimeoutStrikes});connectorHub.health=accountMonitor;
worlds.switched.add(()=>void accountMonitor.tick());
// One SSE frame per store event for every open page, local or paired (state-delta.ts).
const feed=new DeltaFeed(worlds);worlds.clients.add(event=>feed.publish(event));worlds.live.add(frame=>feed.transient(frame));
// How much recent data /api/state carries and how big a chat page is (town.config.json snapshot), read on each request.
const limits=()=>config.snapshot as {messages:number;events:number;approvals:number;messagesPerChat:number;tasksPerCat:number};
const app=Fastify({logger:false,bodyLimit:32000,forceCloseConnections:true});
const port=Number(process.env.PORT||config.port),lan=process.env.CAT_TOWN_LAN==='1';
const addresses=lanAddresses();
// A team instance's slug (desktop/teams.cjs teamEnv, plan 10.2), unset for the private town. Its cookie names and Tailscale port carry it.
const team=process.env.CAT_TEAM||undefined;
// One device list for phones, tablets and Same Wi-Fi viewers.
const pairing=new Pairing(resolve(dataPath,'devices.json'),config.remote);
// A LAN owner device gets the tunnel listener's routes and gates, no more (item 5.2). remoteApp is read per request, once both listeners exist.
const tunnelRoute=(req:FastifyRequest)=>!!req.routeOptions.url&&remoteApp.hasRoute({method:req.method as HTTPMethods,url:req.routeOptions.url});
const access=installAccess(app,lan,addresses,port,pairing,tunnelRoute,ownerSession,team,ownerKeys?.link);
installStateGzip(app);
registerModelRoutes(app,hub);
// Main app only.
registerSetupRoutes(app,{ollamaBase:()=>process.env.CAT_OLLAMA_BASE||DEFAULT_OLLAMA,defaultModel:()=>defaultsFor('local',hub.settings,config).model});
registerMediaRoutes(app,hub,()=>({journal:worlds.store,dir:worlds.dir}));
// Web Push: keys and subscriptions live in the data dir. Season completion is polled because seasons run in their own process.
// Notices come from the Needs you list itself (plan 11.10): the same items the badge counts, plus Trouble under Problems.
// The host's full input (projects, purchases, capabilities) is set once registerTown has built it; until then the store alone.
let hostQuestInput:(()=>QuestInput)|undefined;
// Each integration's health (11.21), set once every integration below exists, so an early store event never reads one too soon.
let integrationHealth:()=>Integration[]=()=>[];
const push=new PushService({dataDir:dataPath,questInput:state=>hostQuestInput?.()??storeQuestInput(state)});
pairing.revoked.add(id=>push.forget(id));
// The owner's verbs from outside the app (plan 11.25): push actions, Telegram and Discord buttons, all checked again against this one list.
const verbs=new OwnerVerbs({town:()=>worlds.town,state:()=>worlds.store.state,input:state=>hostQuestInput?.()??storeQuestInput(state)});
// Owner tokens for the town MCP (plan 11.28): global like the devices, hashes only, made and revoked in Devices.
const ownerTokens=new OwnerTokens(resolve(dataPath,'owner-tokens.json'));
// Android ping (plan 5.4): opt-in per paired device, fed by the same notices as Web Push. Off until the owner enables a device.
const ntfy=new NtfyService({dataDir:dataPath,server:config.ntfy?.server});
push.onNotify(kind=>ntfy.ping(kind));
pairing.revoked.add(id=>ntfy.forget(id));
// The people of a shared world (plan 10.3). Made after the revoke hooks above, since a device whose person is gone is revoked here.
const people=new People(resolve(dataPath,'people.json'),pairing);
worlds.switched.add(()=>push.resetSeasonBaseline());
// Telegram and Discord (plan 3.5, D7): host-only setup, owner-only chat. A message there thinks with the town default, else what the owner last used with the Mayor.
const lastMayorMode=()=>[...worlds.store.state.tasks].reverse().find(t=>t.cat==='mayor'&&t.from==='owner'&&!t.parent)?.mode;
// The model a message to the Mayor's inbox runs on: outside channels and For you's Start.
const inboxMode=()=>hub.townDefault()?.provider??lastMayorMode()??'demo';
const telegram:TelegramChannel=new TelegramChannel({dataDir:dataPath,pairing,town:()=>worlds.town,mode:inboxMode,remote:()=>tunnel.origin||undefined,verbs});
registerChannelRoutes(app,'telegram','Telegram',telegram,isHost);
// Email to the Mayor (plan 3.11): off until the owner picks a Gmail label; the interval is read from town.config.json on every tick.
const mail=new MailWatcher({dataDir:dataPath,town:()=>worlds.town,mode:inboxMode,token:id=>connectorHub.accessToken(id),interval:()=>Number(loadConfig(root).mailWatch?.intervalSeconds)});
registerMailRoutes(app,mail,isOwner);
// For you (plan 9.3): one collector loop for the open world, restarted on a switch; off until the owner turns it on. Interval, floor and categories: town.config.json forYou.
const forYou=new ForYou({dir:()=>worlds.dir,store:()=>worlds.store,token:id=>connectorHub.accessToken(id),config:()=>loadConfig(root).forYou,collectors:[...googleCollectors,...clowderCollectors],providers:()=>hub.providers,mode:inboxMode});
worlds.switched.add(()=>forYou.start());
registerForYouRoutes(app,forYou,isOwner);
const discord:DiscordChannel=new DiscordChannel({dataDir:dataPath,pairing,town:()=>worlds.town,mode:inboxMode,remote:()=>tunnel.origin||undefined,verbs});
registerChannelRoutes(app,'discord','Discord',discord,isHost);
const checkSeasons=()=>{try{push.checkSeasons(()=>worlds.seasons.list().seasons);}catch{/* a damaged season file must not stop the watch */}};
checkSeasons();
const seasonWatch=setInterval(checkSeasons,45_000);seasonWatch.unref();
registerSeasonRoutes(app,{host:{list:()=>worlds.seasons.list(),start:input=>seasonsOn?worlds.seasons.start(input):Promise.reject(new Error('Seasons are off. Set economy.enabled to true in town.local.json and restart Clowder.')),stop:name=>worlds.seasons.stop(name)},hub});
// Main app only: the remote and tunnel apps below never get the workshop routes.
// Set up at start in the background when WSL is present (docs/workshop.md). Nothing here waits for the installer.
const workshopSetup=new WorkshopSetup({settingsDir:dataPath,root,defaultAutoSetup:config.workshop?.autoSetup!==false,wsl:wslSpawner,current:()=>({dataDir:worlds.dir,workshop:worlds.workshop})});
registerWorkshopRoutes(app,{status:()=>worlds.workshop.status(),install:id=>worlds.workshop.install(id)},workshopSetup.owner());
// Tool files written to a run's out folder reach the gallery here, in the server, because seasons run in their own process.
const outboxSweep=setInterval(()=>{try{importWorkshopOutbox(worlds.dir,worlds.store);}catch{/* the next sweep retries */}},3000);outboxSweep.unref();
registerAutonomyRoutes(app,{get dataDir(){return worlds.dir;}});
registerCatBrowserRoutes(app,{dataDir:dataPath});
// The one "safe to stop" rule (plan 7.10): null when no season and no task is running, else why not. Reset, restore, the hourly backup and the
// desktop updater (asked over IPC, below) all use it.
const busyReason=():string|null=>worlds.seasons.running()?'A season is running. Stop it first.':worlds.town.isBusy()?'Finish the current work or stop the town first.':null;
registerWorldResetRoute(app,{get dataDir(){return worlds.dir;},busy:busyReason,town:{pause:value=>worlds.town.pause(value)}});
// The carrier: tailscale (a stable tailnet-only address) or cloudflare (Quick Tunnel or named tunnel). The one picked in Devices (plan 5.1) wins;
// until then remote.provider in the config decides.
const remotePort=Number(process.env.CAT_REMOTE_PORT||config.remote.port);
const tailnetPort=servePort(remotePort,team);
const remoteSettings=new RemoteSettings(resolve(dataPath,'remote-settings.json'));
const tunnel=new RemoteCarrier({tailscale:new TailscaleServe(undefined,tailnetPort),cloudflare:new Tunnel(resolve(dataPath,'tunnel'),config.remote.tunnelTimeoutMs,()=>keeper.retry())},remoteSettings.provider??remoteProvider(config.remote.provider));
// The owner's choice is remembered in remote-settings.json, and the keeper brings the tunnel back when cloudflared dies while it is on.
const keeper=new RemoteKeeper(tunnel,remotePort,remoteSettings);
// The current address is announced, sealed, to a relay (docs/android.md). Null when remote.rendezvous is false.
const rendezvous=rendezvousFor(dataPath,config.remote);
// Host-only settings (money, Stripe, marking paid, new webhook links): the host, or an owner device with a fresh passkey step-up (plan 5.5).
// Only the remote listener's gateway marks a step-up, so on the main listener this is isHost.
const hostOrStepUp=(req:FastifyRequest)=>isHost(req)||isSteppedUp(req);
// Both listeners gate on isOwner: the host, or a paired owner device on the remote listener (access.ts).
// device: who acts, journaled on closed owner steps and answered approvals: the paired device id, or 'host'.
async function registerTown(app:FastifyInstance,device:(req:FastifyRequest)=>string){
refuseWritesAfterReset(app);
app.setErrorHandler((error:any,req,res)=>{res.code(error.statusCode||400).send({error:error.message});});
// The active world's own default when it has one, else the global default. Both are shown the same way.
const activeTownDefault=async()=>{const own=worlds.ownTownDefault(worlds.dir);return own?hub.describeTownDefault(own):hub.townDefaultStatus();};
// me (plan 10.11): who this page acts for, so a member's page can show its own view. readOnly is true for a member and a viewer alike, and the
// presence frame carries ids only to the owner, so without it a member's page could tell neither its role nor which Requests are its own.
const me=(req:FastifyRequest)=>{const person=memberPerson(req);return isOwner(req)?{role:'owner',id:OWNER,name:people.name(OWNER)}:person!==undefined?{role:'member',id:person,name:people.name(person)}:{role:'viewer'};};
app.get('/api/state',async(req)=>({...worlds.store.snapshot(limits()),limits:limits(),build:build.get(),activeWorld:worlds.activeWorld(),introPending:worlds.introPending,world:{...config.world,designs,maxCats:config.maxCats,chromas,accessories,kit,houseDecor},councilPolicy:config.council,maxParallelWork:config.maxParallelWork,readOnly:!isOwner(req),me:me(req),secrets:secretStore.status(),models:await hub.list(),townDefault:await activeTownDefault(),economy:{enabled:seasonsOn}}));
app.get('/api/projects',async()=>projects(worlds.store.state));
registerWorldRoutes(app,worlds,isOwner);
registerWorldIntroRoute(app,worlds,isOwner);
registerMemoryRoutes(app,()=>memoryFor(worlds.dir,worlds.store.state.events,seasonsOn));
registerWikiRoutes(app,{store:()=>worlds.store,owner:isOwner});
registerArtifactRoutes(app,{dir:()=>worlds.dir,events:()=>worlds.store.state.events,owner:isOwner});
// The owner hands Clowder a file (plan 11.22): owner only on both listeners; it lands in the gallery as an owner artifact.
registerUploadRoutes(app,{dir:()=>worlds.dir,journal:()=>worlds.store,owner:isOwner});
// Model status is probed slowly, so the route serves the last answer and refreshes it in the background.
let modelStatus:Awaited<ReturnType<ModelHub['status']>>|null=null;
const latestCapabilities=():SeasonCapability[]=>{const name=latestSeason(worlds.dir);if(!name)return [];try{const events=readSeason(worlds.dir,name);return events.length?publicSeason(events,name).capabilities:[];}catch{return [];}};
// ponytail: rebuilds projects() and reads the latest season on every request, and it runs on every store event. Cache by event count if the log grows.
// The Quests panel's input (also the daily briefing's, routines.ts), so the briefing counts what the panel shows.
const questInput=(host:boolean,owner:boolean):QuestInput=>({host,economy:seasonsOn,integrations:owner?integrationHealth():[],state:worlds.store.state,projects:projects(worlds.store.state),latestSeason:seasonsOn?latestSeason(worlds.dir):undefined,capabilities:seasonsOn?latestCapabilities():[],seasons:seasonsOn?worlds.seasons.list().seasons:[],models:owner&&modelStatus?providerStatus(modelStatus):null,config:config.quests,now:new Date(),workshopSetup:owner?workshopSetup.failure():null,hermesSetup:owner?hermesRuntime?.status()??null:null,purchases:realMoney.purchases(),suggestions:owner?openSuggestions(worlds.store.state):undefined});
setBriefingQuestInput(()=>questInput(true,true));hostQuestInput=()=>questInput(true,true);
app.get('/api/quests',async req=>{
  const owner=isOwner(req);
  if(owner)void hub.status().then(s=>{modelStatus=s;},()=>{});
  return quests(questInput(isHost(req),owner));
});
// The quest log's Done tab: finished items from the journal, newest first, last 50. Read-only, like the active list.
app.get('/api/quests/done',async req=>doneQuests(worlds.store.state,50,isOwner(req)));
// Owner-only. Hides a quest until its `at` changes; the id is decoded by Fastify, so `goal:x` arrives whole.
// A For you card (`suggestion:<card>`) is dismissed instead, with the owner's optional reason (plan 9.6; for-you.ts suppressed() reads it).
app.post('/api/quests/:id/hide',{onRequest:async(req,reply)=>{if(!isOwner(req))return reply.code(403).send({error:'Quests are managed on the host computer.'});},schema:{body:{type:'object',additionalProperties:false,properties:{at:{type:['string','null'],maxLength:64},reason:{type:['string','null'],maxLength:64},until:{type:['string','null'],maxLength:64}}}}},async req=>{
  const id=(req.params as {id:string}).id,body=req.body as {at?:string|null;reason?:string|null;until?:string|null}|undefined;
  if(id.startsWith('suggestion:'))dismissSuggestion(worlds.store,id.slice('suggestion:'.length),body?.reason??null);
  else worlds.town.hideQuest('owner',id,body?.at??null,body?.until??null);
  return {ok:true};
});
// Owner-only. A push action's verb on a Needs-you item (plan 11.25): Mark done, Remind me tomorrow or Retry, checked again by owner-verbs.ts.
registerOwnerVerbRoutes(app,{verbs,owner:isOwner,device});
// Owner-only. Start a For you card: one framed Request to the Mayor (plan 9.6). A card that is not open is a 409.
app.post('/api/suggestions/:id/start',{onRequest:async(req,reply)=>{if(!isOwner(req))return reply.code(403).send({error:'The owner starts For you cards.'});}},async req=>
  startSuggestion(worlds.store,(req.params as {id:string}).id,(text,origin)=>worlds.town.inbox(text,inboxMode(),origin)));
// Owner-only. "Continue on your computer": a quest that only finishes there (the cats' browser, a CLI sign-in) is marked from the phone, and the host lists it first.
app.post('/api/quests/:id/handoff',{onRequest:async(req,reply)=>{if(!isOwner(req))return reply.code(403).send({error:'Quests are managed on the host computer.'});}},async req=>{
  worlds.town.handoffQuest('owner',(req.params as {id:string}).id,device(req));
  return {ok:true};
});
// A hello with the journal position, then one frame per store event (state-delta.ts), and `changed` after a world switch.
// ?only=season is audio.js's own stream: coin totals only. Paired phones use this too instead of polling.
app.get('/api/events',async(req,res)=>{
  // The head goes out at once: the season-only stream writes nothing until its first total or the 20 s keep-alive, and a page would wait on it.
  res.hijack();res.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.raw.flushHeaders();
  // A paired device is checked again before each write, so a revoked or expired one gets nothing more, as when it polled.
  const gone=()=>{if(device(req)!=='unpaired')return false;res.raw.end();return true;};
  const send=(data:string)=>{if(!gone())res.raw.write(`data: ${data}\n\n`);};
  // Activity and live-text frames go to owner pages only: a viewer's stream stays what /api/state shows it.
  if((req.query as {only?:string}).only!=='season'){
    send(feed.hello());feed.clients.add(send);if(isOwner(req))feed.owners.add(send);
    // Presence (plan 10.10) is by person: the owner, the member the gate admitted, or the person a viewer device belongs to.
    const id=isOwner(req)?OWNER:memberPerson(req)??pairing.list().find(d=>d.id===device(req))?.person,person=people.list().find(p=>p.id===id);
    if(person)feed.join(send,{id:person.id,name:person.name,role:person.role});
  }
  // Coin totals from the active world's season journal, pushed as `event: season` (main and remote).
  const sendSeason=(totals:CoinTotals)=>{if(!gone())res.raw.write(seasonFrame(totals));};worlds.seasonClients.add(sendSeason);
  const heartbeat=setInterval(()=>{if(!gone())res.raw.write(': keep-alive\n\n');},20000);
  req.raw.on('close',()=>{clearInterval(heartbeat);feed.clients.delete(send);feed.owners.delete(send);feed.leave(send);worlds.seasonClients.delete(sendSeason);});
});
// One cat's chat history, a page at a time: the chat panel loads the newest page when it opens a cat and pages back with before=<oldest id>.
app.get('/api/chats/:cat',{schema:{querystring:{type:'object',additionalProperties:false,properties:{before:{type:'string',minLength:1,maxLength:64},limit:{type:'integer',minimum:1,maximum:200}}}}},async req=>{
  const q=req.query as {before?:string;limit?:number},l=limits();
  return worlds.store.chat((req.params as {cat:string}).cat,{before:q.before,limit:q.limit??l.messagesPerChat,tasks:l.tasksPerCat});
});
// The read routes (plan 8.4). A thread is one root task and everything it delegated, paged like a chat, through the same gate as /api/chats.
// Search finds messages for anyone who can read the chats; wiki pages, memory notes, artifacts and request results are the owner's, as /api/wiki and /api/memory/search are not.
app.get('/api/threads/:task',{schema:{querystring:{type:'object',additionalProperties:false,properties:{before:{type:'string',minLength:1,maxLength:64},limit:{type:'integer',minimum:1,maximum:200}}}}},async (req,res)=>{
  const q=req.query as {before?:string;limit?:number};
  const thread=worlds.store.thread((req.params as {task:string}).task,{before:q.before,limit:q.limit??limits().messagesPerChat,name:id=>people.name(id)});
  return thread??res.code(404).send({error:'That task is not in this town.'});
});
app.get('/api/search',{schema:{querystring:{type:'object',additionalProperties:false,required:['q'],properties:{q:{type:'string',minLength:1,maxLength:200}}}}},async req=>{
  const owner=isOwner(req),query=(req.query as {q:string}).q.trim(),rm=worlds.store.readModel;
  if(!query||!rm)return {messages:[],...(owner?{notes:[],wiki:[],artifacts:[],requests:[]}:{})};
  rm.flush();
  const messages=rm.search(query,30,'message').map(h=>({id:h.ref,cat:h.cat,at:h.at,text:h.text}));
  if(!owner)return {messages};
  const pages=wikiOf(worlds.store);
  const notes=rm.search(query,30,'note').map(h=>({kind:h.kind,ref:h.ref,cat:h.cat,at:h.at,text:`${h.title}\n${h.text}`}));
  const artifacts=rm.search(query,30,'artifact').map(h=>({id:h.ref,title:h.title,cat:h.cat,at:h.at,excerpt:h.text}));
  // A request's result, found by a word in it. `title` is the request's own text.
  const requests=rm.search(query,30,'request').map(h=>({id:h.ref,title:h.title,cat:h.cat,at:h.at,result:h.text}));
  return {messages,notes,wiki:rm.wikiSearch(query,30).filter(h=>pages.pages.has(h.slug)),artifacts,requests};
});
app.get('/api/season',async req=>{
  const requested=(req.query as {name?:string}).name;
  if(requested!==undefined&&!/^[\w-]+$/.test(requested))throw new Error('Season name must be letters, digits, - or _.');
  const name=requested??latestSeason(worlds.dir);
  const events=name?readSeason(worlds.dir,name):[];
  return name&&events.length?publicSeason(events,name):{season:null};
});
const schema=(properties:any,required:string[])=>({body:{type:'object',properties,required,additionalProperties:false}});
const string={type:'string',minLength:1,maxLength:12000};
// A `/command` that an enabled plugin defines is expanded here; the chat shows the typed line above the expanded prompt.
// A member (plan 10.5) talks to the Mayor only, and the owner's plugins never expand a member's text. Their task is theirs (by, plan 10.6); submit
// refuses them the Hermes mode.
app.post('/api/chat',{schema:schema({cat:string,text:string,mode:{type:'string',enum:['demo','local','hosted','claude','chatgpt','anthropic','plan',...(hermes?['hermes']:[])]},model:{type:'string',maxLength:120},goal:{type:'boolean'},parent:{type:'string',minLength:1,maxLength:64}},['cat','text','mode'])},async(req,res)=>{
  const b=req.body as any,by=memberPerson(req);
  if(by!==undefined&&b.cat!=='mayor')return res.code(403).send({error:'Members talk to the Mayor.'});
  // A follow-up (plan 11.1) continues a request from the same sender: the owner's own requests, or a member's own (by). A member's tree stays
  // theirs (plan 10.6), so the owner steers a member's request with a new request, not by writing inside it as that member.
  if(b.parent!==undefined){const root=worlds.store.state.tasks.find(t=>t.id===b.parent);if(root&&root.by!==by)return res.code(403).send({error:by!==undefined?'Members follow up on their own requests.':'That request is a team member’s. Start a new request instead.'});}
  return {task:worlds.town.submit(b.cat,by!==undefined?b.text:connectorHub.expandForChat(b.text),normalizeMode(b.mode),{goal:b.goal===true,model:b.model,...(by!==undefined?{by}:{}),...(b.parent!==undefined?{parent:b.parent}:{})})};
});
app.post('/api/tasks/:id/cancel',async req=>({result:worlds.town.cancelQueued('owner',(req.params as any).id)}));
// Stop (plan 8.2): ends a running request's whole task tree as cancelled. Writes are owner-only at the access hooks, as for cancel.
// Retry (plan 11.1): a failed or interrupted request runs again inside its own thread. A member retries only their own request.
app.post('/api/tasks/:id/retry',async(req,res)=>{const id=(req.params as any).id,by=memberPerson(req);const root=worlds.store.state.tasks.find(t=>t.id===id);if(root&&by!==undefined&&root.by!==by)return res.code(403).send({error:'Members retry their own requests.'});return {task:worlds.town.retry(id)};});
app.post('/api/tasks/:id/stop',async req=>({result:worlds.town.stop('owner',(req.params as any).id)}));
registerGoalRoutes(app,{town:()=>worlds.town,decide:isOwner,device});
// A new webhook link is a secret URL: the host, or an owner device with a fresh passkey step-up, as for money settings.
registerRoutineRoutes(app,{town:()=>worlds.town,canWrite:isOwner,canReveal:hostOrStepUp});
registerUsageRoutes(app,{town:()=>worlds.town,device});
registerAskRoute(app,{town:()=>worlds.town});
// Money settings, Stripe connect and marking paid stay on the host: a lost phone must not change how money moves. The one exception is an owner
// device that confirmed with its passkey in the last few minutes, on a stable address (plan 5.5, remote-access.ts). A paired owner device
// may still approve or reject a purchase; viewers only see.
registerRealMoneyRoutes(app,realMoney,{owner:hostOrStepUp,decide:isOwner,journal:()=>worlds.store});
// Rotate the kept owner key from Devices (plan 11.27): the host, or an owner device with a fresh passkey step-up, as for money settings. Every
// browser holding the old cookie is signed out; the host browser that asked gets the new one, and the console shows a new link. The desktop
// app's key (CAT_OWNER_KEY) is per launch already and its window holds it, so it is not rotated here.
app.post('/api/owner-key/rotate',async(req,res)=>{
  if(!hostOrStepUp(req))return res.code(403).send({error:'The owner key is changed on the host computer.'});
  if(!ownerKeys)return res.code(409).send({error:'The Clowder app makes a new owner key each time it starts.'});
  ownerKeys.rotate();console.log(ownerLinkLine());
  if(isHost(req))res.header('Set-Cookie',ownerSetCookie(port,ownerKeys.session()));
  return {ok:true};
});
// Owner tokens for the town MCP (plan 11.28): the owner lists them; Make and Revoke take the host, or an owner device with a fresh passkey
// step-up, as for rotating the owner key. A token is shown once, in Make's answer.
registerOwnerTokenRoutes(app,{tokens:ownerTokens,owner:isOwner,manage:hostOrStepUp});
app.post('/api/roads',{schema:schema({a:string,b:string},['a','b'])},async(req)=>{const b=req.body as any;return {result:worlds.town.road('owner',b.a,b.b)};});
app.post('/api/cats',{schema:schema({name:string,role:string,style:{type:'string',enum:Object.keys(designs)}},['name','role'])},async(req)=>{const b=req.body as any;return {id:worlds.town.recruit('owner',b.name,b.role,b.style)};});
app.post('/api/homes',{schema:schema({cat:string,style:{type:'string',enum:Object.keys(designs)}},['cat','style'])},async req=>{const b=req.body as any;return {result:worlds.town.styleHome('owner',b.cat,b.style)};});
const hexColour={type:'string',minLength:7,maxLength:7};
app.post('/api/homes/:id/move',{schema:schema({x:{type:'number'},z:{type:'number'}},['x','z'])},async req=>{const b=req.body as any;return {result:worlds.town.moveHome('owner',(req.params as any).id,b.x,b.z)};});
app.post('/api/homes/:id/look',{schema:schema({roof:hexColour,wall:hexColour,trim:hexColour,door:hexColour,decor:{type:'array',maxItems:6,uniqueItems:true,items:{type:'string',enum:houseDecor.map(d=>d.id)}}},[])},async req=>({result:worlds.town.lookHome('owner',(req.params as any).id,req.body as any)}));
const choice=(list:string[])=>({type:'string',enum:list});
const appearanceSchema={chroma:{type:'string',minLength:1,maxLength:40,enum:chromas.map(c=>c.id)},accessory:choice(accessories),base:choice(kit.bases),marking:choice(kit.markings),expression:choice(kit.expressions),
  parts:{type:'array',maxItems:kit.sockets.length,uniqueItems:true,items:choice(Object.keys(kit.parts))},...Object.fromEntries(kit.colours.map(k=>[k,hexColour]))};
registerCatAiRoutes(app,{setCatAi:(actor,id,provider,choice)=>worlds.town.setCatAi(actor,id,provider,choice),answerCatAi:(actor,id,accept)=>worlds.town.answerCatAi(actor,id,accept)});
app.post('/api/cats/:id/appearance',{schema:schema(appearanceSchema,[])},async req=>{const b=req.body as any;return {result:worlds.town.customizeCat('owner',(req.params as any).id,b)};});
// A member answers only a decision in a tree they started that touches team-scoped accounts only (plan 4.5, Town.mayDecide); every other one waits
// for the owner. Refused here before decide(), which checks the same rule again and journals the member's answer as theirs.
const memberDecides=(req:FastifyRequest,id:string)=>{
  const person=memberPerson(req);if(person===undefined)return true;
  const approval=worlds.store.state.approvals.find(a=>a.id===id);
  return !!approval&&person!==OWNER&&worlds.town.mayDecide(approval,person);
};
app.post('/api/approvals/:id',{schema:schema({answer:string,approved:{type:'boolean'}},['answer','approved'])},async(req,res)=>{
  const b=req.body as any,id=(req.params as any).id;
  if(!memberDecides(req,id))return res.code(403).send({error:'This decision waits for the owner.'});
  worlds.town.decide(id,b.answer,b.approved,device(req),memberPerson(req));return {ok:true};
});
app.post('/api/councils',{schema:schema({cat:string,reason:{type:'string',maxLength:1000},evidence:{type:'array',items:string},mode:{type:'string',enum:['demo','local','hosted','claude','chatgpt','anthropic','plan']}},['cat','reason','evidence','mode'])},async req=>{if(worlds.town.isBusy())throw new Error('Finish current work or stop the town first.');const b=req.body as any;return {id:worlds.town.council('owner',b.cat,b.reason,b.evidence,normalizeMode(b.mode)).id};});
app.post('/api/cats/:id/restore',async req=>({id:worlds.town.restore((req.params as any).id)}));
app.post('/api/pause',{schema:schema({value:{type:'boolean'}},['value'])},async(req)=>{worlds.town.pause((req.body as any).value);return {ok:true};});
registerAndroidApk(app);
installServiceWorkerHeaders(app);installGzip(app);installAppCsp(app,resolve(root,'public','index.html'));
await app.register(staticPlugin,{root:resolve(root,'public'),prefix:'/'});
await app.register(staticPlugin,{root:resolve(root,'node_modules/three'),prefix:'/vendor/three/',decorateReply:false});
}
await registerTown(app,access.device);
// Hooked once registerTown has set the host's full list (hostQuestInput), so each baseline already holds the failed requests and payments,
// and a restart announces none of them again (11.10, 11.25).
for(const channel of [push,telegram,discord])channel.attach({get state(){return worlds.store.state;},listeners:worlds.storeListeners});
// Main app only: the remote and tunnel apps never get connector or plugin routes.
registerConnectorRoutes(app,connectorHub,{canWrite:isOwner,cats:()=>worlds.store.state.cats.map(c=>({id:c.id,name:c.name})),town:()=>worlds.town,device:access.device});
// Main app only, and only with hermes.enabled: the plugin's hello, gate and result routes answer loopback with the gate token, never the tunnel listener.
// The town MCP (4.11): Hermes reaches Clowder's tools through it with its gate token, and the owner's MCP clients with an owner token (11.28),
// loopback only. Registered whether or not Hermes runs.
if(hermes)registerHermesRoutes(app,hermes,()=>worlds.town);
registerTownMcp(app,hermes,()=>worlds.town,{tokens:ownerTokens,verbs,mode:inboxMode});
// Owner only: the first-enable setup's progress or failure (4.13), and a retry after one (offline, say). external: CAT_HERMES_PYTHON or hermes.python is used.
if(hermes){
  const owner={onRequest:async(req:FastifyRequest,reply:FastifyReply)=>{if(!isOwner(req))return reply.code(403).send({error:'Hermes is set up on the host computer.'});}};
  app.get('/api/hermes/runtime',owner,async()=>hermesRuntime?.status()??{state:'external'});
  app.post('/api/hermes/runtime/retry',owner,async()=>{void hermes.start().catch(()=>{/* the status says why */});return {ok:true};});
}
// Without Hermes the page still asks on every load: a plain "off" keeps a red 404 out of its console (public/model-extras.js readHermes).
else app.get('/api/hermes/runtime',async()=>({enabled:false}));
registerTreasury(app,()=>worlds.store);
// Main app only: deleting a world is never offered on the tunnel listener.
registerWorldDeleteRoute(app,worlds,isOwner);
// device: the host, or the Same Wi-Fi owner device that subscribed, so revoking that device drops its endpoints (push.forget).
registerPushRoutes(app,{service:push,allowed:isOwner,device:access.device});
registerNtfyRoutes(app,{service:ntfy,allowed:isOwner,devices:()=>pairing.list().map(d=>({id:d.id,name:d.name}))});
// Portable encrypted backups (plan 7.5), main listener only: setup and the recovery key on the host. One croner job, hourly at :17, runs only
// when busyReason() says the town is idle.
const backups=new Backups(dataPath);
registerBackupRoutes(app,backups,{owner:isOwner,host:isHost});
// Restore (plan 7.6), main listener only: the server stages the chosen point, then the desktop app stops it, swaps the files and restarts it.
registerRestoreRoutes(app,{dataDir:dataPath,backups,broker:()=>secretStore.mode==='encrypted'?broker:undefined,live:()=>secretStore,
  busy:busyReason,
  handOff:staging=>{worlds.town.pause(true);setTimeout(()=>process.send!({restore:{staging}}),100);}},{owner:isOwner,host:isHost});
integrationHealth=()=>[{id:'telegram',name:'Telegram',health:telegram.health()},{id:'discord',name:'Discord',health:discord.health()},{id:'mail',name:'Mail watch',health:mail.health()},{id:'backup',name:'Backup',health:backups.health()},{id:'ntfy',name:'ntfy',health:ntfy.health()}];
const backupJob=new Cron('17 * * * *',{protect:true,unref:true},()=>backups.scheduled(!busyReason()));
const remoteApp=Fastify({logger:false,bodyLimit:32000,forceCloseConnections:true});
// The passkey step-up is offered only where the address keeps its host name: Tailscale or a named tunnel, never a Quick Tunnel.
const stableOrigin=()=>{const s=tunnel.status();return !!s.origin&&(s.provider==='tailscale'||s.named);};
const remoteAccess=installRemoteAccess(remoteApp,pairing,()=>tunnel.origin,stableOrigin,Date.now,team);
// The relay key goes to owner devices only: a viewer cannot follow the town after a restart.
registerRendezvousRoute(remoteApp,()=>rendezvous,isOwner);
registerPushRoutes(remoteApp,{service:push,allowed:isOwner,device:remoteAccess.device});
// The tunnel listener has the town routes and the connect routes only: the rest of connectors, models, the cats' browser and the other main-app routes
// above are never registered on it. An owner device connects a service from a quest; its sign-in callback answers on the pending state alone.
await registerTown(remoteApp,req=>remoteAccess.device(req)??'unpaired');
registerConnectRoutes(remoteApp,connectorHub,{canWrite:isOwner,town:()=>worlds.town,phone:true,device:req=>remoteAccess.device(req)??'unpaired'});
// Autopay's real-time authorizations arrive here through the tunnel's public HTTPS address, signed by Stripe.
registerStripeWebhook(remoteApp,realMoney);
await remoteApp.listen({port:remotePort,host:'127.0.0.1'});
keeper.autostart(process.env);
telegram.start();discord.start();mail.start();forYou.start();
rendezvous?.watch(()=>tunnel.origin);
app.get('/api/remote-access',async()=>({remote:false,paired:true,pollMs:config.remote.pollMs}));
// /api/remote/ here is device management, the tunnel and the relay key: host-only, so isHost, never isOwner.
app.addHook('onRequest',async(req,res)=>{if((gatePath(req)??'').startsWith('/api/remote/')&&!isHost(req))return res.code(403).send({error:'Device access is managed on the host computer.'});});
// passkeyAllowedUntil: the window Devices opened for that phone to add its passkey (plan 5.5).
app.get('/api/remote/status',async()=>({...tunnel.status(),stable:stableOrigin(),ownerKeyRotates:!!ownerKeys,devices:pairing.list().map(d=>{const until=remoteAccess.stepUp.allowedUntil(d.id);return until?{...d,passkeyAllowedUntil:until}:d;})}));
registerRendezvousRoute(app,()=>rendezvous,isHost);
app.post('/api/remote/start',async()=>({origin:await keeper.start()}));
app.post('/api/remote/stop',async()=>{await keeper.stop();pairing.cancel();return {ok:true};});
// Devices leads with Tailscale (plan 5.1): whether it is installed and signed in here, the address it gives, and the serve command Clowder runs.
app.get('/api/remote/tailscale',async()=>({...await detectTailscale(undefined,tailnetPort),serve:serveCommand(remotePort,tailnetPort)}));
// The carrier picked in Devices. When remote access is on it restarts on the new one, so the old pairing code goes.
app.post('/api/remote/provider',{schema:{body:{type:'object',required:['provider'],additionalProperties:false,properties:{provider:{type:'string',enum:['tailscale','cloudflare']}}}}},async req=>{
  pairing.cancel();
  return {origin:await keeper.choose((req.body as {provider:RemoteProvider}).provider)??null};
});
app.post('/api/remote/invite',{schema:{body:{type:'object',required:['permission'],additionalProperties:false,properties:{permission:{type:'string',enum:['viewer','owner']}}}}},async req=>{
  if(!tunnel.origin)throw new Error('Start remote access first.');
  const invite=pairing.create((req.body as {permission:Role}).permission);
  return {...invite,origin:tunnel.origin,qr:pairQrSvg(pairLink(tunnel.origin,invite.code))};
});
// People and their invites (plan 10.4), host only like the rest of device management. One open code per person; the link is the remote pairing
// link, so it needs remote access on, as an invite above does.
app.get('/api/remote/people',async()=>({people:people.list()}));
app.post('/api/remote/people',{schema:{body:{type:'object',required:['name'],additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:60},role:{type:'string',enum:['member','viewer']}}}}},async req=>{
  const b=req.body as {name:string;role?:'member'|'viewer'};return people.add(b.name,b.role??'member');
});
app.post('/api/remote/people/:id/invite',async req=>{
  if(!tunnel.origin)throw new Error('Start remote access first.');
  const invite=people.invite((req.params as {id:string}).id),link=pairLink(tunnel.origin,invite.code);
  return {...invite,origin:tunnel.origin,link,qr:pairQrSvg(link)};
});
app.post('/api/remote/people/:id/remove',async req=>{people.remove((req.params as {id:string}).id);return {ok:true};});
// A member's monthly token budget (plan 10.9), owner-only through the host's /api/remote guard. null removes it; a held member's work resumes at once if under it.
app.post('/api/remote/people/:id/budget',{schema:{body:{type:'object',required:['tokens'],additionalProperties:false,properties:{tokens:{type:['integer','null'],minimum:1}}}}},async req=>{
  worlds.town.setMemberBudget('owner',(req.params as {id:string}).id,(req.body as {tokens:number|null}).tokens);return {ok:true,people:people.list()};
});
app.post('/api/remote/revoke/:id',async req=>{pairing.revoke((req.params as {id:string}).id);return {ok:true};});
// Passkey step-up (plan 5.5), host only: let one owner or member device (10.4) add its passkey within a few minutes, or remove the one it has.
app.post('/api/remote/passkey/:id',async req=>{
  if(!stableOrigin())throw Object.assign(new Error('Passkeys need an address that stays the same: turn on remote access with Tailscale first.'),{statusCode:409});
  return {until:remoteAccess.stepUp.allow((req.params as {id:string}).id)};
});
app.post('/api/remote/passkey/:id/remove',async req=>{remoteAccess.stepUp.remove((req.params as {id:string}).id);return {ok:true};});
// The route-matrix test (test/device-roles.test.ts) imports this module and walks every route of both listeners.
export {app,remoteApp,tunnel,people,worlds};
app.addHook('onClose',async()=>{clearInterval(seasonWatch);backupJob.stop();accountMonitor.stop();worlds.close();push.close();ntfy.close();telegram.stop();discord.stop();mail.stop();forYou.stop();await connectorHub.dispose();keeper.dispose();rendezvous?.stop();await tunnel.stop();await remoteApp.close();bridge?.close();await hermes?.stop();});
// One shutdown for Ctrl-C, SIGTERM and the desktop app's IPC 'shutdown': a season this server started is stopped too,
// so its journal stays resumable and no lock or child is left behind.
let closing=false;
const shutdown=()=>{if(closing)return;closing=true;keeper.dispose();const stopping=Promise.resolve(tunnel.stop()).catch(()=>{});const run=worlds.seasons.running();void (run?.source==='host'?worlds.seasons.stop(run.name).catch(()=>{}):Promise.resolve()).then(()=>stopping).then(()=>secretStore.flush()).then(()=>app.close()).then(()=>process.exit(0));};
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,shutdown);
// A stray rejection is logged and the town carries on: Node's default would end every running task for it. A thrown error still ends the
// process, and the desktop app starts it again once (desktop/main.cjs).
process.on('unhandledRejection',reason=>console.error('Clowder: unhandled rejection:',reason));
// The desktop app asks {busyQuery:n} before it installs an update and gets {busyReply:n,reason} back on the same channel (plan 7.10).
process.on('message',m=>{
  if(m==='shutdown')shutdown();
  else if(m&&typeof m==='object'&&typeof (m as {busyQuery?:unknown}).busyQuery==='number')process.send?.({busyReply:(m as {busyQuery:number}).busyQuery,reason:busyReason()});
});process.on('disconnect',shutdown);
// 'exit' is the last chance: stdio servers are killed synchronously there (stopCli), so no child outlives the server.
process.on('exit',()=>{void connectorHub.dispose();hermes?.killSync();});
// CAT_TOWN_BIND narrows the LAN bind to one address; tests use loopback so no firewall prompt appears.
await app.listen({port,host:lan?process.env.CAT_TOWN_BIND||'0.0.0.0':'127.0.0.1'});
connectorHub.start();accountMonitor.start();
// After listen: the plugin's hello comes back to this listener.
void hermes?.start().catch(error=>console.error(`Clowder: Hermes did not start: ${(error as Error).message}`));
console.log(ownerLinkLine());
void workshopSetup.autoStart().then(r=>{if(r==='started')console.log('Clowder: setting up the cats\' workshop in the background.');}).catch(()=>{/* the card shows the state */});

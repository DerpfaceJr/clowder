import Fastify,{type FastifyInstance,type FastifyReply,type FastifyRequest,type HTTPMethods} from 'fastify';
import staticPlugin from '@fastify/static';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {gatePath,installAccess,isHost,isOwner,lanAddresses} from './access.ts';
import {accessories,chromas,designs,houseDecor,kit} from './world.ts';
import {registerTreasury} from './treasury.ts';
import {Pairing,type Role} from './pairing.ts';
import {Tunnel} from './tunnel.ts';
import {TailscaleServe,detectTailscale,serveCommand} from './tailscale.ts';
import {RemoteCarrier,remoteProvider,type RemoteProvider} from './remote-provider.ts';
import {installRemoteAccess,isSteppedUp} from './remote-access.ts';
import {RemoteKeeper,RemoteSettings} from './remote-keeper.ts';
import {registerRendezvousRoute,rendezvousFor} from './rendezvous.ts';
import {registerAndroidApk} from './android-apk.ts';
import {installServiceWorkerHeaders} from './pwa.ts';
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
import {loadConfig} from './config.ts';
import {registerSeasonRoutes} from './season-host.ts';
import {registerWorkshopRoutes,wslSpawner} from './workshop.ts';
import {WorkshopSetup} from './workshop-setup.ts';
import {importWorkshopOutbox} from './workshop-outbox.ts';
import {PushService,registerPushRoutes} from './push.ts';
import {NtfyService,registerNtfyRoutes} from './ntfy.ts';
import {registerChannelRoutes} from './chat-channel.ts';
import {DiscordChannel} from './discord.ts';
import {TelegramChannel} from './telegram.ts';
import {MailWatcher,registerMailRoutes} from './mail-inbox.ts';
import {registerAutonomyRoutes} from './autonomy.ts';
import {catBrowserSettings,registerCatBrowserRoutes} from './cat-browser.ts';
import {pairLink,pairQrSvg,registerSetupRoutes} from './setup-routes.ts';
import {refuseWritesAfterReset,registerWorldResetRoute} from './world-reset.ts';
import {DeltaFeed} from './state-delta.ts';
import {WorldHost,registerWorldDeleteRoute,registerWorldIntroRoute,registerWorldRoutes} from './worlds.ts';
import {registerArtifactRoutes} from './artifacts.ts';
import {registerGoalRoutes} from './goals.ts';
import {registerRoutineRoutes,setBriefingQuestInput} from './routines.ts';
import {registerUsageRoutes} from './usage.ts';
import {registerAskRoute} from './ask.ts';
import {RealMoney,registerRealMoneyRoutes,registerStripeWebhook} from './real-money.ts';
import {ConnectorHub,registerConnectRoutes,registerConnectorRoutes} from './connectors.ts';
import {AccountMonitor} from './accounts.ts';
import type {Store} from './store.ts';
import type {Town} from './engine.ts';
import {ipcBroker,openSecretStore} from './secret-store.ts';
import {HermesSidecar,registerHermesRoutes} from './hermes.ts';
import {HermesBridge} from './hermes-bridge.ts';
import {HermesBootstrap} from './hermes-bootstrap.ts';
import {registerTownMcp} from './town-mcp.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=loadConfig(root);
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
const secrets=()=>[...hub.secretValues(),...connectorHub.secretValues(),...realMoney.secretValues(),catBrowserSettings(dataPath).token,telegram.secret(),discord.secret(),...(hermes?.secretValues()??[])];
const worlds=new WorldHost({root,dataDir:dataPath,config,providers:hub.providers,media:()=>hub.media(),claude:()=>hub.claudeTools(),realMoney,townDefault:()=>hub.townDefault(),connectors:()=>connectorHub,secrets,hermes:()=>bridge});
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
// This launch's owner session key (security pass H2, access.ts). The desktop app passes its own and sets the cookie in its window; under npm start the
// console link below carries it. It leaves the environment here, so no child process inherits it.
const ownerLink=!process.env.CAT_OWNER_KEY,ownerKey=process.env.CAT_OWNER_KEY||randomBytes(32).toString('base64url');delete process.env.CAT_OWNER_KEY;
// One device list for phones, tablets and Same Wi-Fi viewers.
const pairing=new Pairing(resolve(dataPath,'devices.json'),config.remote);
// A LAN owner device gets the tunnel listener's routes and gates, no more (item 5.2). remoteApp is read per request, once both listeners exist.
const tunnelRoute=(req:FastifyRequest)=>!!req.routeOptions.url&&remoteApp.hasRoute({method:req.method as HTTPMethods,url:req.routeOptions.url});
const access=installAccess(app,lan,addresses,port,pairing,tunnelRoute,ownerKey);
installStateGzip(app);
registerModelRoutes(app,hub);
// Main app only.
registerSetupRoutes(app,{ollamaBase:()=>process.env.CAT_OLLAMA_BASE||DEFAULT_OLLAMA,defaultModel:()=>defaultsFor('local',hub.settings,config).model});
registerMediaRoutes(app,hub,()=>({journal:worlds.store,dir:worlds.dir}));
// Web Push: keys and subscriptions live in the data dir. Season completion is polled because seasons run in their own process.
const push=new PushService({dataDir:dataPath});
push.attach({get state(){return worlds.store.state;},listeners:worlds.storeListeners});
pairing.revoked.add(id=>push.forget(id));
// Android ping (plan 5.4): opt-in per paired device, fed by the same notices as Web Push. Off until the owner enables a device.
const ntfy=new NtfyService({dataDir:dataPath,server:config.ntfy?.server});
push.onNotify(kind=>ntfy.ping(kind));
pairing.revoked.add(id=>ntfy.forget(id));
worlds.switched.add(()=>push.resetSeasonBaseline());
// Telegram and Discord (plan 3.5, D7): host-only setup, owner-only chat. A message there thinks with the town default, else what the owner last used with the Mayor.
const lastMayorMode=()=>[...worlds.store.state.tasks].reverse().find(t=>t.cat==='mayor'&&t.from==='owner'&&!t.parent)?.mode;
const telegram:TelegramChannel=new TelegramChannel({dataDir:dataPath,pairing,town:()=>worlds.town,mode:()=>hub.townDefault()?.provider??lastMayorMode()??'demo'});
telegram.attach({get state(){return worlds.store.state;},listeners:worlds.storeListeners});
registerChannelRoutes(app,'telegram','Telegram',telegram,isHost);
// Email to the Mayor (plan 3.11): off until the owner picks a Gmail label; the interval is read from town.config.json on every tick.
const mail=new MailWatcher({dataDir:dataPath,town:()=>worlds.town,mode:()=>hub.townDefault()?.provider??lastMayorMode()??'demo',token:id=>connectorHub.accessToken(id),interval:()=>Number(loadConfig(root).mailWatch?.intervalSeconds)});
registerMailRoutes(app,mail,isOwner);
const discord:DiscordChannel=new DiscordChannel({dataDir:dataPath,pairing,town:()=>worlds.town,mode:()=>hub.townDefault()?.provider??lastMayorMode()??'demo'});
discord.attach({get state(){return worlds.store.state;},listeners:worlds.storeListeners});
registerChannelRoutes(app,'discord','Discord',discord,isHost);
const checkSeasons=()=>{try{push.checkSeasons(()=>worlds.seasons.list().seasons);}catch{/* a damaged season file must not stop the watch */}};
checkSeasons();
const seasonWatch=setInterval(checkSeasons,45_000);seasonWatch.unref();
registerSeasonRoutes(app,{host:{list:()=>worlds.seasons.list(),start:input=>worlds.seasons.start(input),stop:name=>worlds.seasons.stop(name)},hub});
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
const remoteSettings=new RemoteSettings(resolve(dataPath,'remote-settings.json'));
const tunnel=new RemoteCarrier({tailscale:new TailscaleServe(),cloudflare:new Tunnel(resolve(dataPath,'tunnel'),config.remote.tunnelTimeoutMs,()=>keeper.retry())},remoteSettings.provider??remoteProvider(config.remote.provider));
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
app.get('/api/state',async(req)=>({...worlds.store.snapshot(limits()),limits:limits(),build:build.get(),activeWorld:worlds.activeWorld(),introPending:worlds.introPending,world:{...config.world,designs,maxCats:config.maxCats,chromas,accessories,kit,houseDecor},councilPolicy:config.council,maxParallelWork:config.maxParallelWork,readOnly:!isOwner(req),secrets:secretStore.status(),models:await hub.list(),townDefault:await activeTownDefault()}));
app.get('/api/projects',async()=>projects(worlds.store.state));
registerWorldRoutes(app,worlds,isOwner);
registerWorldIntroRoute(app,worlds,isOwner);
registerMemoryRoutes(app,()=>memoryFor(worlds.dir,worlds.store.state.events));
registerWikiRoutes(app,{store:()=>worlds.store,owner:isOwner});
registerArtifactRoutes(app,{dir:()=>worlds.dir,events:()=>worlds.store.state.events});
// Model status is probed slowly, so the route serves the last answer and refreshes it in the background.
let modelStatus:Awaited<ReturnType<ModelHub['status']>>|null=null;
const latestCapabilities=():SeasonCapability[]=>{const name=latestSeason(worlds.dir);if(!name)return [];try{const events=readSeason(worlds.dir,name);return events.length?publicSeason(events,name).capabilities:[];}catch{return [];}};
// ponytail: rebuilds projects() and reads the latest season on every request, and it runs on every store event. Cache by event count if the log grows.
// The Quests panel's input (also the daily briefing's, routines.ts), so the briefing counts what the panel shows.
const questInput=(host:boolean,owner:boolean):QuestInput=>({host,state:worlds.store.state,projects:projects(worlds.store.state),latestSeason:latestSeason(worlds.dir),capabilities:latestCapabilities(),seasons:worlds.seasons.list().seasons,models:owner&&modelStatus?providerStatus(modelStatus):null,config:config.quests,now:new Date(),workshopSetup:owner?workshopSetup.failure():null,hermesSetup:owner?hermesRuntime?.status()??null:null,purchases:realMoney.purchases()});
setBriefingQuestInput(()=>questInput(true,true));
app.get('/api/quests',async req=>{
  const owner=isOwner(req);
  if(owner)void hub.status().then(s=>{modelStatus=s;},()=>{});
  return quests(questInput(isHost(req),owner));
});
// The quest log's Done tab: finished items from the journal, newest first, last 50. Read-only, like the active list.
app.get('/api/quests/done',async()=>doneQuests(worlds.store.state));
// Owner-only. Hides a quest until its `at` changes; the id is decoded by Fastify, so `goal:x` arrives whole.
app.post('/api/quests/:id/hide',{onRequest:async(req,reply)=>{if(!isOwner(req))return reply.code(403).send({error:'Quests are managed on the host computer.'});},schema:{body:{type:'object',additionalProperties:false,properties:{at:{type:['string','null'],maxLength:64}}}}},async req=>{
  worlds.town.hideQuest('owner',(req.params as {id:string}).id,(req.body as {at?:string|null}|undefined)?.at??null);
  return {ok:true};
});
// Owner-only. "Continue on your computer": a quest that only finishes there (the cats' browser, a CLI sign-in) is marked from the phone, and the host lists it first.
app.post('/api/quests/:id/handoff',{onRequest:async(req,reply)=>{if(!isOwner(req))return reply.code(403).send({error:'Quests are managed on the host computer.'});}},async req=>{
  worlds.town.handoffQuest('owner',(req.params as {id:string}).id,device(req));
  return {ok:true};
});
// A hello with the journal position, then one frame per store event (state-delta.ts), and `changed` after a world switch.
// ?only=season is audio.js's own stream: coin totals only. Paired phones use this too instead of polling.
app.get('/api/events',async(req,res)=>{
  res.hijack();res.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  // A paired device is checked again before each write, so a revoked or expired one gets nothing more, as when it polled.
  const gone=()=>{if(device(req)!=='unpaired')return false;res.raw.end();return true;};
  const send=(data:string)=>{if(!gone())res.raw.write(`data: ${data}\n\n`);};
  // Activity and live-text frames go to owner pages only: a viewer's stream stays what /api/state shows it.
  if((req.query as {only?:string}).only!=='season'){send(feed.hello());feed.clients.add(send);if(isOwner(req))feed.owners.add(send);}
  // Coin totals from the active world's season journal, pushed as `event: season` (main and remote).
  const sendSeason=(totals:CoinTotals)=>{if(!gone())res.raw.write(seasonFrame(totals));};worlds.seasonClients.add(sendSeason);
  const heartbeat=setInterval(()=>{if(!gone())res.raw.write(': keep-alive\n\n');},20000);
  req.raw.on('close',()=>{clearInterval(heartbeat);feed.clients.delete(send);feed.owners.delete(send);worlds.seasonClients.delete(sendSeason);});
});
// One cat's chat history, a page at a time: the chat panel loads the newest page when it opens a cat and pages back with before=<oldest id>.
app.get('/api/chats/:cat',{schema:{querystring:{type:'object',additionalProperties:false,properties:{before:{type:'string',minLength:1,maxLength:64},limit:{type:'integer',minimum:1,maximum:200}}}}},async req=>{
  const q=req.query as {before?:string;limit?:number},l=limits();
  return worlds.store.chat((req.params as {cat:string}).cat,{before:q.before,limit:q.limit??l.messagesPerChat,tasks:l.tasksPerCat});
});
// The read routes (plan 8.4). A thread is one root task and everything it delegated, paged like a chat, through the same gate as /api/chats.
// Search finds messages for anyone who can read the chats; wiki pages and memory notes are the owner's, as /api/wiki and /api/memory/search are not.
app.get('/api/threads/:task',{schema:{querystring:{type:'object',additionalProperties:false,properties:{before:{type:'string',minLength:1,maxLength:64},limit:{type:'integer',minimum:1,maximum:200}}}}},async (req,res)=>{
  const q=req.query as {before?:string;limit?:number};
  const thread=worlds.store.thread((req.params as {task:string}).task,{before:q.before,limit:q.limit??limits().messagesPerChat});
  return thread??res.code(404).send({error:'That task is not in this town.'});
});
app.get('/api/search',{schema:{querystring:{type:'object',additionalProperties:false,required:['q'],properties:{q:{type:'string',minLength:1,maxLength:200}}}}},async req=>{
  const owner=isOwner(req),query=(req.query as {q:string}).q.trim(),rm=worlds.store.readModel;
  if(!query||!rm)return {messages:[],...(owner?{notes:[],wiki:[]}:{})};
  rm.flush();
  const hits=rm.search(query,30);
  const messages=hits.filter(h=>h.kind==='message').map(h=>({id:h.ref,cat:h.cat,at:h.at,text:h.text}));
  if(!owner)return {messages};
  const pages=wikiOf(worlds.store);
  return {messages,notes:hits.filter(h=>h.kind==='note'),wiki:rm.wikiSearch(query,30).filter(h=>pages.pages.has(h.slug))};
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
app.post('/api/chat',{schema:schema({cat:string,text:string,mode:{type:'string',enum:['demo','local','hosted','claude','chatgpt','anthropic','plan',...(hermes?['hermes']:[])]},model:{type:'string',maxLength:120},goal:{type:'boolean'}},['cat','text','mode'])},async(req)=>{const b=req.body as any;return {task:worlds.town.submit(b.cat,connectorHub.expandForChat(b.text),normalizeMode(b.mode),{goal:b.goal===true,model:b.model})};});
app.post('/api/tasks/:id/cancel',async req=>({result:worlds.town.cancelQueued('owner',(req.params as any).id)}));
// Stop (plan 8.2): ends a running request's whole task tree as cancelled. Writes are owner-only at the access hooks, as for cancel.
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
app.post('/api/approvals/:id',{schema:schema({answer:string,approved:{type:'boolean'}},['answer','approved'])},async(req)=>{const b=req.body as any;worlds.town.decide((req.params as any).id,b.answer,b.approved,device(req));return {ok:true};});
app.post('/api/councils',{schema:schema({cat:string,reason:{type:'string',maxLength:1000},evidence:{type:'array',items:string},mode:{type:'string',enum:['demo','local','hosted','claude','chatgpt','anthropic','plan']}},['cat','reason','evidence','mode'])},async req=>{if(worlds.town.isBusy())throw new Error('Finish current work or stop the town first.');const b=req.body as any;return {id:worlds.town.council('owner',b.cat,b.reason,b.evidence,normalizeMode(b.mode)).id};});
app.post('/api/cats/:id/restore',async req=>({id:worlds.town.restore((req.params as any).id)}));
app.post('/api/pause',{schema:schema({value:{type:'boolean'}},['value'])},async(req)=>{worlds.town.pause((req.body as any).value);return {ok:true};});
registerAndroidApk(app);
installServiceWorkerHeaders(app);
await app.register(staticPlugin,{root:resolve(root,'public'),prefix:'/'});
await app.register(staticPlugin,{root:resolve(root,'node_modules/three'),prefix:'/vendor/three/',decorateReply:false});
}
await registerTown(app,access.device);
// Main app only: the remote and tunnel apps never get connector or plugin routes.
registerConnectorRoutes(app,connectorHub,{canWrite:isOwner,cats:()=>worlds.store.state.cats.map(c=>({id:c.id,name:c.name})),town:()=>worlds.town,device:access.device});
// Main app only, and only with hermes.enabled: the plugin's hello, gate and result routes answer loopback with the gate token, never the tunnel listener.
// The town MCP Hermes reaches Clowder's tools through (4.11), under the same loopback and token rule.
if(hermes){registerHermesRoutes(app,hermes,()=>worlds.town);registerTownMcp(app,hermes,()=>worlds.town);}
// Owner only: the first-enable setup's progress or failure (4.13), and a retry after one (offline, say). external: CAT_HERMES_PYTHON or hermes.python is used.
if(hermes){
  const owner={onRequest:async(req:FastifyRequest,reply:FastifyReply)=>{if(!isOwner(req))return reply.code(403).send({error:'Hermes is set up on the host computer.'});}};
  app.get('/api/hermes/runtime',owner,async()=>hermesRuntime?.status()??{state:'external'});
  app.post('/api/hermes/runtime/retry',owner,async()=>{void hermes.start().catch(()=>{/* the status says why */});return {ok:true};});
}
registerTreasury(app,()=>worlds.store);
// Main app only: deleting a world is never offered on the tunnel listener.
registerWorldDeleteRoute(app,worlds,isOwner);
registerPushRoutes(app,{service:push,allowed:isOwner,device:()=>'host'});
registerNtfyRoutes(app,{service:ntfy,allowed:isOwner,devices:()=>pairing.list().map(d=>({id:d.id,name:d.name}))});
// Portable encrypted backups (plan 7.5), main listener only: setup and the recovery key on the host. One croner job, hourly at :17, runs only
// when busyReason() says the town is idle.
const backups=new Backups(dataPath);
registerBackupRoutes(app,backups,{owner:isOwner,host:isHost});
// Restore (plan 7.6), main listener only: the server stages the chosen point, then the desktop app stops it, swaps the files and restarts it.
registerRestoreRoutes(app,{dataDir:dataPath,backups,broker:()=>secretStore.mode==='encrypted'?broker:undefined,live:()=>secretStore,
  busy:busyReason,
  handOff:staging=>{worlds.town.pause(true);setTimeout(()=>process.send!({restore:{staging}}),100);}},{owner:isOwner,host:isHost});
const backupJob=new Cron('17 * * * *',{protect:true,unref:true},()=>backups.scheduled(!busyReason()));
const remoteApp=Fastify({logger:false,bodyLimit:32000,forceCloseConnections:true});
// The passkey step-up is offered only where the address keeps its host name: Tailscale or a named tunnel, never a Quick Tunnel.
const stableOrigin=()=>{const s=tunnel.status();return !!s.origin&&(s.provider==='tailscale'||s.named);};
const remoteAccess=installRemoteAccess(remoteApp,pairing,()=>tunnel.origin,stableOrigin);
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
telegram.start();discord.start();mail.start();
rendezvous?.watch(()=>tunnel.origin);
app.get('/api/remote-access',async()=>({remote:false,paired:true,pollMs:config.remote.pollMs}));
// /api/remote/ here is device management, the tunnel and the relay key: host-only, so isHost, never isOwner.
app.addHook('onRequest',async(req,res)=>{if((gatePath(req)??'').startsWith('/api/remote/')&&!isHost(req))return res.code(403).send({error:'Device access is managed on the host computer.'});});
// passkeyAllowedUntil: the window Devices opened for that phone to add its passkey (plan 5.5).
app.get('/api/remote/status',async()=>({...tunnel.status(),stable:stableOrigin(),devices:pairing.list().map(d=>{const until=remoteAccess.stepUp.allowedUntil(d.id);return until?{...d,passkeyAllowedUntil:until}:d;})}));
registerRendezvousRoute(app,()=>rendezvous,isHost);
app.post('/api/remote/start',async()=>({origin:await keeper.start()}));
app.post('/api/remote/stop',async()=>{await keeper.stop();pairing.cancel();return {ok:true};});
// Devices leads with Tailscale (plan 5.1): whether it is installed and signed in here, the address it gives, and the serve command Clowder runs.
app.get('/api/remote/tailscale',async()=>({...await detectTailscale(),serve:serveCommand(remotePort)}));
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
app.post('/api/remote/revoke/:id',async req=>{pairing.revoke((req.params as {id:string}).id);return {ok:true};});
// Passkey step-up (plan 5.5), host only: let one owner device add its passkey within a few minutes, or remove the one it has.
app.post('/api/remote/passkey/:id',async req=>{
  if(!stableOrigin())throw Object.assign(new Error('Passkeys need an address that stays the same: turn on remote access with Tailscale first.'),{statusCode:409});
  return {until:remoteAccess.stepUp.allow((req.params as {id:string}).id)};
});
app.post('/api/remote/passkey/:id/remove',async req=>{remoteAccess.stepUp.remove((req.params as {id:string}).id);return {ok:true};});
// The route-matrix test (test/device-roles.test.ts) imports this module and walks every route of both listeners.
export {app,remoteApp,tunnel};
app.addHook('onClose',async()=>{clearInterval(seasonWatch);backupJob.stop();accountMonitor.stop();worlds.close();push.close();ntfy.close();telegram.stop();discord.stop();mail.stop();await connectorHub.dispose();keeper.dispose();rendezvous?.stop();await tunnel.stop();await remoteApp.close();bridge?.close();await hermes?.stop();});
// One shutdown for Ctrl-C, SIGTERM and the desktop app's IPC 'shutdown': a season this server started is stopped too,
// so its journal stays resumable and no lock or child is left behind.
let closing=false;
const shutdown=()=>{if(closing)return;closing=true;keeper.dispose();const stopping=Promise.resolve(tunnel.stop()).catch(()=>{});const run=worlds.seasons.running();void (run?.source==='host'?worlds.seasons.stop(run.name).catch(()=>{}):Promise.resolve()).then(()=>stopping).then(()=>secretStore.flush()).then(()=>app.close()).then(()=>process.exit(0));};
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,shutdown);
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
console.log(`Clowder: http://127.0.0.1:${port}${ownerLink?`/?owner=${ownerKey}`:''}`);
void workshopSetup.autoStart().then(r=>{if(r==='started')console.log('Clowder: setting up the cats\' workshop in the background.');}).catch(()=>{/* the card shows the state */});

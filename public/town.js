import {townLayout,resolveLayout,homeYaw,standPoint,memorialSpot,BOARD,FOUNTAIN} from './hamlet-layout.js';
import {formatFunds,vaultText} from './treasury-view.js';
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadRoofKit,buildHouseLife} from './house-art.js';
import {SHADOW_LAYER,makeHouse,makeAnimatedCat,makePlaza,setWorldGlow,makeGarden,applyAppearance,makeMemorial,buildKitCat,setKitColours,prepareKit,applyExpression,expressionFor,kitKey,makeBench,makeNoticeBoard,makeFountain,makeFountainWater,bake,bakeCollect,bakeCopy,bakeMerge,bakedMeshes,wind,mergeRig,restBounds} from './world-art.js';
import {resolveAppearance,planHomeMove,wantsKitBody} from './editor.js';
import {TIMES,LIGHT_COLOURS,LIGHT_NUMBERS} from './time-of-day.js';
import {MessageVisits,idleCat,restStep,faceYaw,turnToward,talkRule} from './world-motion.js';
import {flagstoneTexture,buildTownGround,buildLinks,buildMagicLights,buildLamps,buildContactShadows,buildEdgeGrass,groundClock,PAW,pawUniforms} from './town-ground.js';
import {terrain,heldGround,townHolds,findBridges,roadHeight} from './terrain.js';
import {createMeadow,PAL as GROUND} from './meadow.js';
import {animateCat,bindMayor,settle,footprintRadius} from './cat-animation.js';
import {speechBubble,disposeSprite,fitBubble,BUBBLE_PX,iconTexture,iconPx,liftClear,unionBox,nameplate} from './hologram.js';
import {FAREWELL_MS,NAMEPLATE_PX,farewellText,newlyRetired,retirementKey} from './memorial.js';
import {createConstruction} from './construction.js';
import {createIntro} from './intro-cinematic.js';
import {createTownPause,ARCHIVE_EVENT} from './memorial-view.js';
import {createCameraFlight,easeStep} from './camera-flight.js';
import {destroy,removeResident as dropResident,clearWorld} from './world-reset.js';
import {demoCats} from './demo-state.js';
import {createWeather} from './weather.js';
import {QUALITIES,startTier,tierFor,stepTier} from './quality.js';

// Height fog: three's distance fog, thinned with height above the ground plane, so the far meadow fades into the
// horizon haze while hill tops and tree crowns stand out of it. Patched once in the shared chunks (before any program
// compiles), so every fogged material gets it; the world height comes from the view-space position and the view matrix.
T.ShaderChunk.fog_pars_vertex='#ifdef USE_FOG\nvarying float vFogDepth;varying float vFogHeight;\n#endif';
T.ShaderChunk.fog_vertex='#ifdef USE_FOG\nvFogDepth=-mvPosition.z;vFogHeight=((mvPosition.xyz-viewMatrix[3].xyz)*mat3(viewMatrix)).y;\n#endif';
T.ShaderChunk.fog_pars_fragment=T.ShaderChunk.fog_pars_fragment.replace('varying float vFogDepth;','varying float vFogDepth;varying float vFogHeight;');
T.ShaderChunk.fog_fragment=T.ShaderChunk.fog_fragment.replace('gl_FragColor.rgb = mix','fogFactor*=exp(-max(vFogHeight,0.)/7.);\n\tgl_FragColor.rgb = mix');
// The Demonstration glow: a soft amber disc with a bright rim and a dark outer edge, so it reads on pale paving by day.
function demoGlowTexture(){
  const canvas=Object.assign(document.createElement('canvas'),{width:128,height:128}),ctx=canvas.getContext('2d'),g=ctx.createRadialGradient(64,64,0,64,64,64);
  for(const [at,colour] of [[0,'rgba(255,190,80,.3)'],[.5,'rgba(255,180,60,.42)'],[.62,'rgba(255,205,100,1)'],[.78,'rgba(250,145,15,1)'],[.86,'rgba(90,40,0,.7)'],[1,'rgba(90,40,0,0)']])g.addColorStop(at,colour);
  ctx.fillStyle=g;ctx.fillRect(0,0,128,128);
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;return texture;
}
export async function createScene(onSelect,onTreasury,onMoveHome,chatNow=()=>null){
  // The house shingle kit loads alongside the settings: houses are built from the first snapshot, synchronously.
  const [settings]=await Promise.all([fetch('/presentation.config.json').then(r=>{if(!r.ok)throw Error('Presentation settings unavailable');return r.json();}),loadRoofKit()]);
  let clips={};try{const response=await fetch(settings.motionAsset);if(!response.ok)throw Error('Motion asset unavailable');clips=(await response.json()).clips;}catch(error){console.warn(error.message);}
  // viewW/viewH: the canvas box, kept by resize() (ResizeObserver). Reading wrap.clientWidth in the frame loop after
  // a label write forced a style and layout pass per read (two per cat per frame).
  let viewW=0,viewH=0;
  const canvas=document.getElementById('town-canvas'),wrap=canvas.parentElement,labels=document.getElementById('labels'),activity=document.getElementById('world-activity');
  const mobile=matchMedia('(pointer: coarse)').matches||innerWidth<=1100,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  // MSAA on every device (phones looked pixelated and smeared without it). The pixel ratio starts at the device ratio
  // capped by presentation config and steps down only while the measured frame rate stays low (see adaptQuality).
  const renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:mobile?'default':'low-power'});
  // ?ratio= pins the pixel ratio for perf probes (scripts/perf-probe.mjs); anything unusable falls back to the cap.
  const pinned=Number(new URLSearchParams(location.search).get('ratio'));
  const maxRatio=pinned>0&&pinned<=4?pinned:Math.min(devicePixelRatio,mobile?settings.mobileMaxPixelRatio:settings.maxPixelRatio);let pixelRatio=maxRatio;
  renderer.setPixelRatio(pixelRatio);renderer.info.autoReset=false;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;
  // ACES stays: Neutral was tried (A/B at the Mayor and the plaza) and pushed the cats' and the paving's oranges far past
  // their hand-tuned look. Exposure comes from each preset.
  renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
  // World matrices are updated by hand: the whole scene only after something is built or moved (markDirty), and per
  // frame only what moves (cats in view, holograms, bubbles, sun, sky). Recomposing ~3,000 static and off-screen
  // nodes every frame was the largest CPU cost (updateMatrixWorld ~15% of the frame loop).
  const scene=new T.Scene();scene.matrixWorldAutoUpdate=false;let worldDirty=true;const markDirty=()=>{worldDirty=true;};if(new URLSearchParams(location.search).has('perf'))window.__town={renderer,scene,get camera(){return camera;},get controls(){return controls;},presets:settings.timesOfDay};
  // Sky: a vertical gradient, the preset's horizon colour (sky) over the lower part of the screen rising to skyTop. It is
  // one screen quad at the far plane drawn after the opaque scene, so depth testing shades only the pixels where sky
  // shows (a scene.background texture shaded the whole screen every frame: about 4-6% of the frame rate, paired A/B).
  // The quad covers only the band where the gradient leaves the horizon colour (from 38% up the screen); below it the
  // clear colour is that same horizon, so those pixels are never shaded twice.
  // The clear colour and the fog take the horizon colour.
  const sky=new T.Mesh(new T.PlaneGeometry(2,2),new T.ShaderMaterial({uniforms:{uHorizon:{value:new T.Color()},uTop:{value:new T.Color()}},depthWrite:false,
    vertexShader:'varying float vY;void main(){vY=mix(-.24,1.,position.y*.5+.5);gl_Position=vec4(position.x,vY,1.,1.);}',
    fragmentShader:'uniform vec3 uHorizon,uTop;varying float vY;void main(){float t=clamp((vY*.5+.12)/.62,0.,1.);gl_FragColor=vec4(mix(uHorizon,uTop,t*t*(3.-2.*t)),1.);\n#include <colorspace_fragment>\n}'}));
  sky.frustumCulled=false;sky.renderOrder=1e6;scene.add(sky);scene.userData.sky=sky;
  let post=null;// the Medium and High post stack (post.js); null on Low, see applyTier
  function paintSky(horizon,top){sky.material.uniforms.uHorizon.value.copy(horizon);sky.material.uniforms.uTop.value.copy(top||horizon);renderer.setClearColor(horizon);}
  // The ortho camera stands 4x farther back than its framing needs: zoomed out, the ground at the bottom of the view
  // used to fall behind the near plane and vanish. Fog distances carry the same offset (CAMERA_BACK).
  const CAMERA_BACK=Math.hypot(24,32,35)*3,CAMERA_HOME=[96,128,140],camera=new T.OrthographicCamera(-22,22,18,-18,.1,600);camera.position.set(...CAMERA_HOME);scene.fog=new T.Fog('#cbdcc0',65+CAMERA_BACK,150+CAMERA_BACK);
  const controls=new OrbitControls(camera,canvas);controls.target.set(0,.6,0);controls.enableDamping=true;controls.screenSpacePanning=false;controls.maxPolarAngle=Math.PI*.43;controls.minPolarAngle=.15;controls.minZoom=.3;controls.maxZoom=6;controls.enablePan=true;
  controls.touches.ONE=T.TOUCH.PAN;controls.touches.TWO=T.TOUCH.DOLLY_ROTATE;controls.mouseButtons.LEFT=T.MOUSE.PAN;controls.mouseButtons.RIGHT=T.MOUSE.ROTATE;camera.zoom=mobile?1:1.45;camera.updateProjectionMatrix();controls.saveState();
  const flight=createCameraFlight({camera,controls});// scripted moves (flyTo); the Memorial zoom uses it, any cinematic can
  const ambient=new T.HemisphereLight('#fff3d5','#739165',2.2);scene.add(ambient);
  // Shadows cover the view around the target only; a tighter box on phones keeps texels small at a 1024 map.
  const shadowBox=mobile?24:30,sun=new T.DirectionalLight('#fff0d1',2.5);sun.castShadow=true;sun.shadow.autoUpdate=false;let shadowFrame=0;const lastShadowAt=new T.Vector3(1e9,0,0);sun.shadow.mapSize.set(mobile?1024:2048,mobile?1024:2048);Object.assign(sun.shadow.camera,{left:-shadowBox,right:shadowBox,top:shadowBox,bottom:-shadowBox,near:1,far:110});sun.shadow.normalBias=.03;sun.shadow.bias=-.0004;scene.add(sun,sun.target);
  // Soft shadow edges: r186's PCF filter takes the radius as its kernel spread, at the same sample count (no extra cost).
  // 3 texels: at 4 the filter's dither showed as grain on the paving at close zoom.
  sun.shadow.radius=3;
  const meadow=createMeadow(scene,{mobile,anisotropy:Math.min(8,renderer.capabilities.getMaxAnisotropy())});
  // Cat shadows come from one instanced soft blob per cat on layer 1, which only the sun's shadow camera sees. Skinned
  // bodies (and the 470k-triangle Mayor) never enter the shadow pass: one shadow draw for the whole town.
  sun.shadow.camera.layers.enable(SHADOW_LAYER);
  const catShadowGeo=mergeGeometries([new T.SphereGeometry(1,10,7).scale(.55,.5,.42).translate(0,.62,0),new T.SphereGeometry(1,10,7).scale(.52,.42,.42).translate(0,1.2,.02)]);
  const catShadows=new T.InstancedMesh(catShadowGeo,new T.MeshBasicMaterial(),128);
  const lastCatShadows=new Float32Array(128*16),lastSunOffset=new T.Vector3();let lastCatShadowCount=-1;
  catShadows.instanceMatrix.setUsage(T.DynamicDrawUsage);catShadows.layers.set(SHADOW_LAYER);catShadows.castShadow=true;catShadows.receiveShadow=false;catShadows.frustumCulled=false;catShadows.count=0;scene.add(catShadows);
  // "z z z" over every sleeping cat: one instanced billboard (three glyphs per sleeper) for the whole town, one draw.
  const SLEEP_Z=3,sleepZ=new T.InstancedMesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({transparent:true,depthWrite:false,depthTest:false}),128*SLEEP_Z),zAt=new T.Object3D(),zeroMatrix=new T.Matrix4().makeScale(0,0,0);let primeGlyph=false;
  sleepZ.instanceMatrix.setUsage(T.DynamicDrawUsage);sleepZ.frustumCulled=false;sleepZ.count=0;sleepZ.visible=false;sleepZ.renderOrder=2;scene.add(sleepZ);
  // An amber ground glow under every cat in Demonstration (demo-state.js decides which): one instanced disc for the
  // whole town, one draw while any cat is in it, none otherwise. Unlit and not tone-mapped, so it reads at night and dawn.
  // Its polygon offset beats the paving's (town-ground.js), which grows with the depth slope and buried it zoomed out.
  const DEMO_GLOW_M=2.8,DEMO_GLOW_PX=56,demoGlow=new T.InstancedMesh(new T.PlaneGeometry(DEMO_GLOW_M,DEMO_GLOW_M).rotateX(-Math.PI/2),new T.MeshBasicMaterial({map:demoGlowTexture(),transparent:true,depthWrite:false,toneMapped:false,fog:false,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-8}),128);
  demoGlow.instanceMatrix.setUsage(T.DynamicDrawUsage);demoGlow.frustumCulled=false;demoGlow.count=0;demoGlow.visible=false;scene.add(demoGlow);
  // ground.height: held terrain (level commons and plots); ground.walk adds bridge decks. Flat until the first layout.
  let ground={height:()=>0,walk:()=>0},groundTerrain=null,groundHolds=[],landings=[];
  const treasury=bakedMeshes([{baked:bake(makePlaza()),matrix:new T.Matrix4()}]);treasury.traverse(o=>o.userData.treasury=true);scene.add(treasury);
  const treasuryLabel=document.createElement('button');treasuryLabel.className='world-label treasury-label';treasuryLabel.setAttribute('aria-label','Open the Moonvault');treasuryLabel.onclick=()=>onTreasury?.();labels.append(treasuryLabel);
  const residents=new Map(),roads=new Map(),visits=new MessageVisits();
  let layoutModel=null,townGroup=null,hamletLabels=[];
  let snapshot,selected='mayor',mayorAsset,focusTarget,night=false,animationTime=0,catDetail=true;
  const ray=new T.Raycaster(),pointer=new T.Vector2(),touches=new Set();let down;
  // Recruits that arrive while the page is open are built on site (construction.js); a new world opens with the Mayor's welcome (intro-cinematic.js).
  const construction=createConstruction({scene,renderer,reduced,residents,walkSpeed:settings.walkingSpeed,world:()=>({layout:layoutModel,ground,cats:snapshot?.cats||[]}),onBuilt:()=>remergeHamlets()});
  const mayorBase=()=>residents.get('mayor')?.base.clone()??null;
  const intro=createIntro({camera,controls,canvas,reduced,ready:()=>!!mayorAsset,head:()=>mayorBase()?.setY(residents.get('mayor').catModel.position.y+2.4),
    spot:name=>name==='mayor'?mayorBase():name==='treasury'?treasury.position.clone():name==='memorial'&&memorial?memorial.group.position.clone():null,
    onEnd:()=>{dispatchEvent(new CustomEvent('open-panel',{detail:'inspector'}));setTimeout(()=>document.getElementById('message')?.focus(),60);}});
  if(window.__town)Object.assign(window.__town,{construction,intro,previewHouse});
  // Memorial observatory on the reserved plot, there from the first snapshot. Farewells are speech bubbles that expire on wall-clock time.
  let memorial=null,memorialKey=null,retiredKeys=null;const farewells=[];
  // While the full-screen Memorial covers the town, the render loop skips its frames (memorial-view.js dispatches the event).
  const memorialPause=createTownPause(window);
  const memorialCentre=()=>snapshot?.world?.layout?memorialSpot(resolveLayout(snapshot.world.layout)):null;
  // Clicking the observatory or its label opens the Memorial panel (app.js listens for open-panel).
  const openMemorial=()=>dispatchEvent(new CustomEvent('open-panel',{detail:'memorial'}));
  const memorialLabel=document.createElement('button');memorialLabel.className='world-label treasury-label memorial-label';memorialLabel.textContent='❀ Memorial';memorialLabel.title='Memorial garden';memorialLabel.setAttribute('aria-label','Open the memorial');memorialLabel.hidden=true;memorialLabel.onclick=openMemorial;labels.append(memorialLabel);
  // Each plaza's notice board takes clicks through an invisible box (the board art stays merged, and the box wins over the
  // house box it stands inside); any board and the town square's label open the Town Archive (app.js flies the camera to
  // the board that was clicked, else the town square's, first). setArchiveCount writes N.
  const openArchive=()=>dispatchEvent(new CustomEvent('open-panel',{detail:'archive'}));
  const archiveLabel=document.createElement('button');archiveLabel.className='world-label treasury-label memorial-label archive-label';archiveLabel.textContent='▤ Archive';archiveLabel.title='Town Archive';archiveLabel.setAttribute('aria-label','Open the town archive');archiveLabel.hidden=true;archiveLabel.onclick=()=>{clickedBoard=null;openArchive();};labels.append(archiveLabel);
  let boards=[],clickedBoard=null;const mainBoard=()=>boards.find(b=>b.main)??boards[0],shotBoard=()=>clickedBoard??mainBoard();
  // The Mayor's treasury sits off the main hub, inside the centre plaza.
  const treasuryZ=()=>snapshot?.world?.layout?resolveLayout(snapshot.world.layout).main_plaza*.45:0;
  // Owner edit mode. previews hold unsaved looks per cat; editPress is one house gesture; editTap is a press on open ground.
  const previews=new Map(),lookFor=(cat,design=snapshot.world.designs[cat.home?.style]||{})=>previews.get(cat.id)??resolveAppearance(cat.appearance,snapshot.world.chromas,design,cat.look,snapshot.world.kit);
  // The kit is modelled at the Mayor GLB's native size; both are shown at the same in-game scale.
  const KIT_SCALE=1.75/1.915;let kitAsset=null,approvedSeen=null;
  let editing=false,editPress=null,editTap=null,editSelected=null,ghost=null,move=null,lastSelect=null,studioView=null;
  const editRing=new T.Mesh(new T.RingGeometry(1.9,2.1,40),new T.MeshBasicMaterial({color:'#fff3c4',transparent:true,opacity:.85,side:T.DoubleSide,depthWrite:false}));editRing.rotation.x=-Math.PI/2;editRing.position.y=.08;editRing.visible=false;scene.add(editRing);
  // The edit ring's look, sized to a notice board and wider so it reads on the pale paving: under the board the mouse is
  // over, and under the Archive's board while the Archive is open or the camera flies to it (ARCHIVE_EVENT, start to close).
  const boardRing=new T.Mesh(new T.RingGeometry(BOARD.half+.2,BOARD.half+.5,40),editRing.material);boardRing.rotation.x=-Math.PI/2;boardRing.visible=false;scene.add(boardRing);let hoveredBoard=null,archiveOpen=false;
  function placeBoardRing(){const b=hoveredBoard??(archiveOpen?shotBoard():null);boardRing.visible=!!b;if(b)boardRing.position.set(b.x,b.y+.1,b.z);}
  addEventListener(ARCHIVE_EVENT,e=>{archiveOpen=e.detail?.open===true;placeBoardRing();});
  const groundPlane=new T.Plane(new T.Vector3(0,1,0),0),groundHit=new T.Vector3();
  const houseBakes=new Map(),proxyGeo=new T.BoxGeometry(1,1,1),proxyMat=new T.MeshBasicMaterial();
  const hash=(x,z,n)=>{const v=Math.sin(x*127.1+z*311.7+n*74.7)*43758.5453;return v-Math.floor(v);};
  const starPositions=[];for(let n=0;n<100;n++)starPositions.push((hash(n,1,0)-.5)*100,12+hash(n,2,0)*25,(hash(n,3,0)-.5)*100);
  const stars=new T.Points(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(starPositions,3)),new T.PointsMaterial({color:'#dfd9ff',size:1.8,transparent:true,opacity:.7,depthWrite:false}));scene.add(stars);
  const firePositions=[];for(let n=0;n<70;n++)firePositions.push((hash(n,4,0)-.5)*65,.5+hash(n,5,0)*2,(hash(n,6,0)-.5)*65);
  // Weather (weather.js): falling fields, the sky mood and far-side set pieces. Its mood rides on every applyLight.
  const weather=createWeather({scene,mobile,reduced,night:settings.timesOfDay?.night});
  const weatherGround=(x,z)=>ground.height(x,z);// the sea surge sits on the ground, the meteor dust rises from it
  const fireflies=new T.Points(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(firePositions,3)),new T.PointsMaterial({color:'#d5ff98',size:2.6,transparent:true,opacity:.8,depthWrite:false}));scene.add(fireflies);
  // Time of day (presets in presentation.config.json timesOfDay, keys in time-of-day.js). A change eases every light
  // value over timeOfDayEaseSeconds in the frame loop, instantly with reduced motion. `night` (sleepy faces, the
  // .world data-view) is true only for 'night'. Stars, fireflies, lamp pools and street lights fade by opacity and are
  // hidden at 0, so day draws exactly what it drew before.
  const sunOffset=new T.Vector3(-18,32,20),starOpacity=stars.material.opacity,fireflyOpacity=fireflies.material.opacity;
  const toLight=p=>Object.fromEntries([...LIGHT_COLOURS.map(k=>[k,new T.Color(p[k])]),...Object.keys(LIGHT_NUMBERS).map(k=>[k,p[k]]),['sunFrom',new T.Vector3(...p.sunFrom)]]);
  const mixLight=(a,b,t)=>Object.fromEntries(Object.keys(b).map(k=>[k,typeof b[k]==='number'?a[k]+(b[k]-a[k])*t:a[k].clone().lerp(b[k],t)]));
  let light=null,lightFrom=null,lightTo=null,lightT=1,lightSeconds=settings.timeOfDayEaseSeconds,chosenTime='day';
  function applyLight(p){
    p=weather.adjust(p);
    paintSky(p.sky,p.skyTop);scene.fog.color.copy(p.sky);ambient.color.copy(p.hemiSky);ambient.groundColor.copy(p.hemiGround);ambient.intensity=p.hemi;
    sun.color.copy(p.sun);sun.intensity=p.sunIntensity;sunOffset.copy(p.sunFrom);renderer.toneMappingExposure=p.exposure;setWorldGlow(p.glow);meadow.setTint(p.terrain,p.water);
    stars.material.opacity=starOpacity*p.stars;stars.visible=p.stars>.01;fireflies.material.opacity=fireflyOpacity*p.fireflies;fireflies.visible=p.fireflies>.01;
    for(const o of [townGroup?.userData.pools,townGroup?.userData.magic,townGroup?.userData.halos])if(o){o.material.opacity=p.lamps;o.visible=p.lamps>.01;}
    // Under the post stack the additive pools blend in linear light before tone mapping, where the same disc reads about
    // twice as bright as on the screen's sRGB buffer: they are dimmed there to match Low.
    if(townGroup?.userData.pools)townGroup.userData.pools.material.opacity=p.lamps*(post?.45:1);
    // Snow cover: the ground glows a cool white by how much snow lies (weather.js), dimmer at night.
    // The paving takes the terrain tint too, so it darkens with the meadow at night instead of staying a grey day.
    const cover=(p.snow||0)*.42*Math.min(1,p.hemi/(settings.timesOfDay.day?.hemi||1))*(1-.55*p.stars);for(const m of [townGroup?.userData.ground?.material])if(m?.emissive){m.emissive.setRGB(cover*.93,cover*.96,cover);m.color.copy(p.terrain);}meadow.setSnow?.(cover);
  }
  function setTimeOfDay(name,instant=false){
    const preset=TIMES.includes(name)&&settings.timesOfDay?.[name];if(!preset)return;
    chosenTime=name;lightSeconds=settings.timeOfDayEaseSeconds;night=name==='night';const world=document.querySelector('.world');world.dataset.view=night?'night':'day';world.dataset.time=name;
    lightTo=toLight(preset);lightFrom=light||lightTo;lightT=instant||reduced||!light?1:0;if(lightT>=1){light=lightTo;applyLight(light);}
    document.querySelectorAll('[data-world-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.worldView===name)));
    try{localStorage.setItem('cat-town-view',name);}catch{}
  }
  /** Eases the light toward a preset without choosing it (no storage, no menu state); null eases back to the chosen time. */
  function tint(name,seconds=settings.timeOfDayEaseSeconds){
    const preset=settings.timesOfDay?.[name||chosenTime];if(!preset)return;
    lightTo=toLight(preset);lightFrom=light||lightTo;lightSeconds=Math.max(.01,seconds);lightT=seconds>0&&light?0:1;if(lightT>=1){light=lightTo;applyLight(light);}
  }
  /** The old two-way switch: 'night' or anything else for day. */
  const setView=value=>setTimeOfDay(value==='night'?'night':'day');
  if(window.__town){window.__town.setTimeOfDay=setTimeOfDay;window.__town.setWeather=n=>weather.set(n);}
  let savedView=settings.defaultView;try{savedView=localStorage.getItem('cat-town-view')||savedView;}catch{}setTimeOfDay(TIMES.includes(savedView)?savedView:'day',true);
  // The meadow streams around the camera; it needs the town layout (clearances, level ground) to scatter its props.
  function refreshMeadow(){
    if(!layoutModel)return;
    const {chunkSize,chunkRadius}=snapshot.world,radius=mobile?Math.min(chunkRadius,1):chunkRadius;
    meadow.setWorld({t:groundTerrain,height:ground.height,layout:{...layoutModel,circles:[...(layoutModel.circles||[]),...landings]},holds:groundHolds,chunkSize,landRadius:radius+settings.landExtraRings,detailRing:radius,
      step:mobile?settings.mobileTerrainStep:settings.terrainStep,grassPerChunk:mobile?settings.mobileGrassPerChunk:settings.grassPerChunk});
  }
  sleepZ.material.map=iconTexture('z');
  function hologram(){
    const group=new T.Group(),sprite=new T.Sprite(new T.SpriteMaterial({map:iconTexture('talk'),transparent:true,depthWrite:false,depthTest:false}));sprite.scale.set(1.35,1.35,1);sprite.position.y=2.45;group.add(sprite);
    const ring=new T.Mesh(new T.TorusGeometry(.45,.018,6,40),new T.MeshBasicMaterial({color:'#9cefe0',transparent:true,opacity:.45,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.position.y=.07;group.add(ring);const slate=new T.Mesh(new T.PlaneGeometry(.95,.6),new T.MeshBasicMaterial({color:'#a5f9ee',transparent:true,opacity:.3,side:T.DoubleSide,depthWrite:false}));slate.position.set(0,.85,.85);slate.rotation.x=-.8;group.add(slate);const edge=new T.LineSegments(new T.EdgesGeometry(slate.geometry),new T.LineBasicMaterial({color:'#baffef',transparent:true,opacity:.85}));slate.add(edge);group.visible=false;scene.add(group);return {group,sprite,ring,slate,kind:''};
  }
  // Kit cats are bound while unrotated (bindMayor caches world-space bases), then turned back to where they faced.
  function installKit(item,look,id){
    const old=item.catModel,at=old.position.clone(),yaw=old.rotation.y;destroy(old);
    const cat=buildKitCat(kitAsset,look,snapshot.world.kit),actor=new T.Group();cat.root.scale.setScalar(KIT_SCALE);actor.add(cat.root);actor.position.copy(at);scene.add(actor);
    actor.updateMatrixWorld(true);item.rig=bindMayor(cat.root);actor.rotation.y=yaw;actor.traverse(o=>{o.userData.cat=id;});
    Object.assign(item,{catModel:actor,kit:cat,kitLook:look,mayorGlb:false});applyCatDetail(item);markDirty();
  }
  // Zoomed far out a cat is a few pixels tall: draw only its fur body (1 draw instead of about 4). Cat meshes never cast
  // shadows themselves (see catShadows).
  function applyCatDetail(item){
    item.catModel.traverse(o=>{if(!o.isMesh)return;o.castShadow=false;if(item.kit&&o.material.name!=='fur')o.visible=catDetail;});
  }
  /** The Mayor keeps its hand-made GLB until the owner gives it a different kit body, markings or parts. */
  function refreshLook(cat,r){
    const look=lookFor(cat);
    if(cat.id==='mayor'&&mayorAsset&&!wantsKitBody(previews.get(cat.id)??cat.appearance,cat.look)){if(!r.mayorGlb)installMayor(r);return;}
    if(!kitAsset){applyAppearance(r.catModel,look);return;}
    if(!r.kit||r.kit.key!==kitKey(look))installKit(r,look,cat.id);else setKitColours(r.kit,look);
    r.kitLook=look;
  }
  function installMayor(item){
    const old=item.catModel,at=old.position.clone();destroy(old);const asset=mayorAsset.scene;item.kit=null;item.mayorGlb=true;
    // Box from geometry bounds: the GLB loads in its bind pose, where this matches Box3.setFromObject's per-vertex skinned
    // pass to 1e-6 m in 10 ms instead of 480-830 ms.
    if(!asset.userData.normalized){const box=new T.Box3(),piece=new T.Box3();asset.updateMatrixWorld(true);asset.traverse(o=>{if(o.isMesh){if(!o.geometry.boundingBox)o.geometry.computeBoundingBox();box.union(piece.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));}});const size=box.getSize(new T.Vector3()),center=box.getCenter(new T.Vector3()),scale=1.75/size.y;asset.scale.setScalar(scale);asset.position.set(-center.x*scale,-box.min.y*scale,-center.z*scale);asset.userData.normalized=true;}
    const actor=new T.Group();actor.add(asset);actor.position.copy(at);scene.add(actor);item.catModel=actor;
    asset.traverse(o=>{o.userData.cat='mayor';if(o.isMesh){o.castShadow=false;o.receiveShadow=true;}});restBounds(asset,false);item.rig=bindMayor(asset);markDirty();
  }
  const refreshAll=()=>{for(const cat of snapshot?.cats||[]){const r=residents.get(cat.id);if(r)refreshLook(cat,r);}warmShaders();};
  // Compiles every material in the scene, hidden ones too (sleep glyphs, reaction icons), in the background, and uploads
  // the sleep glyph: the first cat to fall asleep used to compile and upload them mid-frame.
  // A compiled program still pays blocking GL queries on its first draw (three's onFirstUse: one GPU round trip each,
  // 20-290 ms behind a busy GPU process). primeGlyph draws one zero-size glyph on the frame after the compile finishes,
  // so that cost lands at load and not on the frame where every idle cat falls asleep at once (docs/perf.md).
  // Under the post stack the scene draws into its target, whose programs differ (no tone mapping, linear output), so
  // they are compiled against that target.
  const warmShaders=()=>{renderer.initTexture(sleepZ.material.map);const was=renderer.getRenderTarget();if(post)renderer.setRenderTarget(post.target);renderer.compileAsync(scene,camera).then(()=>{primeGlyph=true;},()=>{});renderer.setRenderTarget(was);};
  new GLTFLoader().load('/assets/mayor-lod.glb',asset=>{mergeRig(asset.scene);mayorAsset=asset;refreshAll();},undefined,error=>console.warn('Mayor model could not load; using role character.'));
  // ?v= changes with every kit rebuild: sw.js serves /assets stale-while-revalidate, so a new catalog never meets an old kit.
  new GLTFLoader().load('/assets/cat-kit.glb?v=2',gltf=>{kitAsset=prepareKit(gltf);refreshAll();},undefined,error=>console.warn('Cat kit could not load; using procedural cats.'));
  // House and garden art per look, baked once and cached. houseBake(cat) yields between its steps (build, copies of
  // 80 meshes at a time, merge) so resetWorld can put a frame between them; it yields nothing when the look is cached.
  // Precedence: design, the recruit's seeded house look, then the owner's home look (or a Studio draft from previewHouse).
  const housePreviews=new Map();
  const defined=o=>Object.fromEntries(Object.entries(o||{}).filter(([,v])=>v!=null)),houseLook=cat=>({...snapshot.world.designs[cat.home.style],...defined(cat.look?.house),...defined(housePreviews.has(cat.id)?housePreviews.get(cat.id):cat.home.look),back:backToCamera(cat)}),houseKey=cat=>cat.home.style+JSON.stringify(houseLook(cat));
  // Whether a house's back faces the camera's home angle (its door looks away): its chimney then stands at the back.
  const backToCamera=cat=>{const yaw=homeYaw(cat,snapshot.groups||[],snapshot.world.layout);return Math.sin(yaw)*CAMERA_HOME[0]+Math.cos(yaw)*CAMERA_HOME[2]<0;};
  function* houseBake(cat){
    const key=houseKey(cat);if(houseBakes.has(key))return;
    const art=new T.Group(),home=makeHouse(cat.home.style,houseLook(cat));art.add(home,makeGarden());art.userData.life=home.userData.life;yield;
    const parts=bakeCollect(art);while(!bakeCopy(parts,80))yield;yield;
    houseBakes.set(key,{baked:bakeMerge(parts),height:home.userData.height||4});
  }
  /** Swaps a standing house to its current look's bake; true when it changed (the caller re-merges the hamlets). */
  function rebake(cat,r){const key=houseKey(cat);if(r.key===key)return false;for(const _ of houseBake(cat));r.baked=houseBakes.get(key).baked;r.key=key;return true;}
  /** Studio live preview: draws id's house with a draft home look until null restores the saved one. While a draft shows,
   *  the house is drawn live (unbaked: about 2 ms a change, some extra draws) and left out of its hamlet merge;
   *  only starting and ending a preview re-merge the hamlets. An unchanged draft does nothing. */
  function previewHouse(id,look){
    if(JSON.stringify(housePreviews.get(id)??null)===JSON.stringify(look??null))return;
    if(look)housePreviews.set(id,look);else housePreviews.delete(id);
    const cat=snapshot?.cats.find(c=>c.id===id),r=residents.get(id);if(!cat?.home||!r)return;
    const was=!!r.live;if(r.live){destroy(r.live);r.live=null;}
    if(!look){rebake(cat,r);remergeHamlets();return;}
    r.live=new T.Group();r.live.add(makeHouse(snapshot.world.designs[look.style]?look.style:cat.home.style,houseLook(cat)),makeGarden());r.live.traverse(o=>{o.userData.cat=id;});r.group.add(r.live);
    if(was)markDirty();else remergeHamlets();
  }
  function house(cat){
    const style=cat.home.style,palette=snapshot.world.designs[style],group=new T.Group(),L=resolveLayout(snapshot.world.layout),yaw=homeYaw(cat,snapshot.groups||[],snapshot.world.layout);
    // Houses face their door (yaw) and are drawn at layout scale, so the art fills the footprint the layout reserves.
    group.position.set(cat.home.x,ground.height(cat.home.x,cat.home.z),cat.home.z);group.rotation.y=yaw;group.scale.setScalar(L.scale);scene.add(group);
    const [standX,standZ]=standPoint(cat.home,yaw,L);
    // House and garden are baked once per look and merged with every other house in rebuildStreets;
    // the group keeps only an invisible box for clicks and drags.
    for(const _ of houseBake(cat));
    const {baked,height}=houseBakes.get(houseKey(cat)),proxy=new T.Mesh(proxyGeo,proxyMat);proxy.visible=false;proxy.scale.set(5.6,height,5.2);proxy.position.y=height/2;group.add(proxy);
    const catModel=makeAnimatedCat(style,palette),base=new T.Vector3(standX,ground.walk(standX,standZ)+.14,standZ);catModel.position.copy(base);scene.add(catModel);
    const label=document.createElement('button');label.className='world-label';label.textContent=cat.name;label.title=palette.label+' · '+cat.role;label.setAttribute('aria-label',`Visit ${cat.name}`);label.dataset.cat=cat.id;label.onclick=()=>onSelect(cat.id);labels.append(label);
    for(const object of [group,catModel])object.traverse(o=>{o.userData.cat=cat.id;});
    const item={group,baked,key:houseKey(cat),catModel,label,base,yaw,holo:hologram(),busy:false,style,height,seed:hash(cat.home.x,cat.home.z,1),rest:{idle:0,amount:0,state:'awake'}};residents.set(cat.id,item);
    refreshLook(cat,item);return item;
  }
  // Plazas, roads, lamps and walking routes all come from hamlet-layout.js, so what cats walk is what is drawn.
  // Paving, roads and inlays are merged into a few meshes; lamps are instanced (see town-ground.js).
  let stoneMap=null;
  function rebuildStreets(){
    if(townGroup)destroy(townGroup);
    layoutModel=townLayout(snapshot.cats,snapshot.groups||[],snapshot.world.layout);
    const L=layoutModel.L,group=new T.Group();
    // Ground: the seeded terrain held level under every common, plot and the memorial, with bridge decks for walking.
    const homes=snapshot.cats.filter(c=>c.home).map(c=>({...c.home,group:c.group}));
    groundTerrain=terrain(L.terrain);groundHolds=townHolds(groundTerrain,layoutModel.sites,homes,{...layoutModel.memorial,r:L.memorial_reserve},L);
    const height=heldGround(groundTerrain,groundHolds),bridges=findBridges(layoutModel.roads,height,groundTerrain.water);
    ground={height,walk:roadHeight(height,bridges)};
    // Bridge landings (town-ground.js) are as wide as the deck: grass and flowers keep off them like off a road.
    landings=bridges.flatMap(br=>[br.a,br.b].map(([x,z])=>({x,z,r:br.width+.25})));
    treasury.position.set(0,height(0,treasuryZ()),treasuryZ());
    for(const r of residents.values()){const x=r.group.position.x,z=r.group.position.z;r.group.position.y=height(x,z);r.base.y=ground.walk(r.base.x,r.base.z)+.14;}
    if(memorial)memorial.group.position.y=height(memorial.x,memorial.z);
    const lampSpots=[...layoutModel.lamps],hamlets=hamletMeshes(lampSpots);group.add(hamlets);group.userData.hamlets=hamlets;
    // Board picks sit where hamletMeshes draws each board (plaza translated to the site's ground, board turned to f.yaw).
    clickedBoard=null;boards=layoutModel.sites.flatMap(site=>site.features.filter(f=>f.kind==='board').map(f=>{const y=height(site.x,site.z),yaw=f.yaw,pick=new T.Mesh(proxyGeo,proxyMat);pick.visible=false;pick.userData.archive=true;pick.position.set(f.x,y+BOARD.top/2,f.z);pick.rotation.y=yaw;pick.scale.set(BOARD.half*2,BOARD.top,BOARD.depth*2);group.add(pick);return {main:site.group==='main',x:f.x,y,z:f.z,yaw,pick};}));hoveredBoard=null;placeBoardRing();
    stoneMap??=flagstoneTexture(renderer.capabilities.getMaxAnisotropy());
    group.add(group.userData.ground=buildTownGround({sites:layoutModel.sites,yards:layoutModel.yards,roads:layoutModel.roads,junctions:layoutModel.junctions,common:layoutModel.common,homes,L,bridges},height,ground.walk,stoneMap));
    // Delegation links follow the physical route; they are drawn only for the selected cat (showLinks).
    roads.clear();
    for(const road of snapshot.roads){const a=snapshot.cats.find(c=>c.id===road.a),b=snapshot.cats.find(c=>c.id===road.b);if(!a?.home||!b?.home)continue;
      roads.set(road.id,{points:layoutModel.visitPath(a,b),a:road.a,b:road.b});}
    linksFor=null;showLinks();
    const magic=buildMagicLights(layoutModel.roads,ground.walk);group.add(magic);group.userData.magic=magic;
    // Lamps along every road and by every door; none stand in the river.
    const litSpots=lampSpots.filter(p=>ground.walk(p.x,p.z)>groundTerrain.water+.6),lamps=buildLamps(litSpots,ground.walk);group.add(lamps);group.userData.pools=lamps.userData.pools;group.userData.halos=lamps.userData.halos;
    group.userData.edgeGrass=buildEdgeGrass({sites:layoutModel.sites,roads:layoutModel.roads,yards:layoutModel.yards,homes,common:layoutModel.common,L},height,groundTerrain.water);group.add(group.userData.edgeGrass);
    // Contact shadows under houses (with their gardens), plaza furniture, the vault and lamps (sizes in metres, unscaled art).
    const contact=[...residents.values()].map(r=>({x:r.group.position.x,y:r.group.position.y,z:r.group.position.z,w:5.6*L.scale,d:5*L.scale,yaw:r.yaw}));
    for(const site of layoutModel.sites)for(const f of site.features){const y=height(site.x,site.z),size={fountain:[FOUNTAIN.r*2.5,FOUNTAIN.r*2.5],bench:[1.5,.9],board:[BOARD.half*2.3,BOARD.depth*2.6]}[f.kind];if(size)contact.push({x:f.x,y,z:f.z,w:size[0],d:size[1],yaw:f.kind==='bench'?Math.atan2(-(f.x-site.x),-(f.z-site.z)):f.yaw||0});}
    contact.push({x:0,y:height(0,treasuryZ()),z:treasuryZ(),w:6.4,d:6.4},...litSpots.map(p=>({x:p.x,y:ground.walk(p.x,p.z),z:p.z,w:.9,d:.9})));
    group.add(buildContactShadows(contact));
    townGroup=group;scene.add(townGroup);lowDetail();refreshMeadow();if(light)applyLight(light);markDirty();warmShaders();
    // Hamlet labels (shown only zoomed out, see the label level of detail): one per group site; a click flies there.
    for(const h of hamletLabels)h.el.remove();
    hamletLabels=layoutModel.sites.filter(s=>s.group!=='main').flatMap(s=>{
      const name=(snapshot.groups||[]).find(g=>g.id===s.group)?.name;if(!name)return [];
      const el=document.createElement('button'),y=height(s.x,s.z)+3;el.className='world-label hamlet-label';el.textContent=name;el.hidden=true;el.setAttribute('aria-label',`Go to ${name}`);
      el.onclick=()=>{focusTarget={position:new T.Vector3(s.x,y-2.4,s.z),zoom:controls.zoom0};};labels.append(el);
      return [{el,x:s.x,y,z:s.z,width:Math.max(56,name.length*7+18)}];
    });
  }
  // Every house, garden, bench and notice board of the town merged per hamlet: two draws per hamlet (solid + glow).
  // Houses still being built stay out (construction.js); a finished build re-merges only these, not the ground and meadow.
  function hamletMeshes(lampSpots){
    const pieces=new Map(),siteOf=new Map(layoutModel.sites.map(s=>[s.group,s])),m=new T.Matrix4(),furniture=new Map(),water=new T.Group(),life=[];
    const add=(key,baked,matrix)=>{if(!pieces.has(key))pieces.set(key,[]);pieces.get(key).push({baked,matrix});};
    for(const cat of snapshot.cats){const r=residents.get(cat.id);if(!r||r.live||construction.building(cat.id))continue;r.group.updateMatrixWorld(true);add(cat.group||'main',r.baked,r.group.matrixWorld.clone());life.push({points:r.baked.userData?.life,matrix:r.group.matrixWorld.clone()});}
    for(const site of layoutModel.sites){
      const plaza=new T.Group();
      for(const f of site.features){
        const lx=f.x-site.x,lz=f.z-site.z,facing=Math.atan2(-lx,-lz);
        if(f.kind==='lamp')lampSpots.push({x:f.x,z:f.z});
        else if(f.kind==='bench')makeBench(plaza,lx,lz,facing);
        else if(f.kind==='fountain'){makeFountain(plaza,lx,lz);water.add(makeFountainWater(f.x,ground.height(site.x,site.z),f.z));}
        else makeNoticeBoard(plaza,lx,lz,f.yaw);
      }
      const key='plaza:'+site.plaza;if(!furniture.has(key))furniture.set(key,bake(plaza));
      add(site.group,furniture.get(key),m.clone().makeTranslation(site.x,ground.height(site.x,site.z),site.z));
    }
    // Chimney smoke and window light for every merged house: two instanced draws for the whole town (house-art.js).
    const out=new T.Group();for(const list of pieces.values())out.add(bakedMeshes(list));out.add(water,buildHouseLife(life));return out;
  }
  function remergeHamlets(){const old=townGroup?.userData.hamlets;if(!old)return rebuildStreets();const next=hamletMeshes([]);destroy(old);townGroup.add(next);townGroup.userData.hamlets=next;lowDetail();markDirty();warmShaders();}
  // Only after the owner picks a cat (the default selection draws nothing, or the Mayor's links would star the town).
  let linkMesh=null,linksFor=null,picked=null;
  function showLinks(){
    const who=picked===selected?selected:null;
    if(linksFor===who&&(linkMesh||!roads.size||!who))return;linksFor=who;
    if(linkMesh){destroy(linkMesh);linkMesh=null;}
    const paths=who?[...roads.values()].filter(r=>r.a===who||r.b===who).map(r=>r.points):[];
    if(paths.length){linkMesh=buildLinks(paths,ground.walk);scene.add(linkMesh);}markDirty();
  }
  // Sender-only speech bubble: one sprite per visit, fading as the courier walks home, disposed when the visit ends.
  function syncBubble(r,visit){
    if(r.bubbleVisit!==visit){if(r.bubble)disposeSprite(r.bubble);r.bubble=visit?speechBubble(visit.message.text):null;r.bubbleVisit=visit;if(r.bubble)scene.add(r.bubble);}
    if(r.bubble)r.bubble.material.opacity=visit.phase==='return'?visit.distance/visit.stop||0:1;
  }
  // A courier's name label floats LABEL_Y above it; labels are centred on their point and about LABEL_H px tall.
  const LABEL_Y=3.3,LABEL_H=36,toScreen=v=>[(v.x*.5+.5)*viewW,(-v.y*.5+.5)*viewH],labelWidth=r=>Math.max(56,r.label.textContent.length*7+18)+(r.demo?22:0);// the DEMO pill's padding and gap
  // Per frame: screen px per metre (ppm across, ppy for height; the camera is orthographic) and the reaction icon's
  // clamped on-screen size (iconPx).
  let ppm=1,ppy=1,iconScreen=24;
  const screenBox=(x,y,z,width,height)=>{const [sx,sy]=toScreen(position.set(x,y,z).project(camera));return {x:sx,y:sy,width,height};};
  // A cat's hologram stack on screen: the reaction icon (with its bob), the work slate in front of it, and the floor ring.
  function holoBox(p,yaw,slate){
    const parts=[screenBox(p.x,p.y+2.4,p.z,iconScreen,iconScreen+.16*ppy),screenBox(p.x,p.y+.07,p.z,.9*ppm,.9*ppm)];
    if(slate)parts.push(screenBox(p.x+Math.sin(yaw)*.85,p.y+.85,p.z+Math.cos(yaw)*.85,.95*ppm,.6*ppm));
    return unionBox(parts);
  }
  // The sender's name label sits above every hologram stack it would cover; the talk bubble's bottom sits 4 px above
  // that label and clears the stacks too (the recipient's reaction icon). Returns its screen box, which is reserved
  // before any name label is placed. At most one bubble exists: one visit at a time, and only the sender speaks.
  function placeBubble(r,visit,boxes){
    syncBubble(r,visit);if(!r.bubble)return null;
    const x=visit.position.x,z=visit.position.z,y=ground.walk(x,z)+.14+LABEL_Y;
    const [sx,sy]=toScreen(position.set(x,y,z).project(camera)),width=BUBBLE_PX*r.bubble.userData.aspect;
    const labelY=liftClear({x:sx,y:sy,width:labelWidth(r),height:LABEL_H},boxes);
    const centre=liftClear({x:sx,y:labelY-LABEL_H/2-4-BUBBLE_PX/2,width,height:BUBBLE_PX},boxes),bottom=centre+BUBBLE_PX/2;
    // The bob only lifts, so the gap never closes.
    r.bubble.position.set(x,y+(sy-bottom)/ppy+(reduced?0:(1+Math.sin(animationTime*2.5))*.03),z);
    fitBubble(r.bubble,camera,viewH);r.bubble.updateMatrixWorld();
    return {x:sx,y:centre,width,height:BUBBLE_PX};
  }
  // Bounding-circle radius per body (kit key, Mayor GLB or procedural style), measured once from its real vertices in
  // the rest pose, so a sleeping or mid-stride first sample does not stand in for the talking body.
  const footprints=new Map();
  function footprint(r){
    const key=r.kit?r.kit.key:r.mayorGlb?'mayor':'style:'+r.style;
    if(!footprints.has(key))footprints.set(key,footprintRadius(r.catModel,r.rig));return footprints.get(key);
  }
  // Where a courier stops to talk (talkRule, talkStop): bounding circles talkGap apart, on the walking path.
  function talkSpot(m){
    const a=residents.get(m.from),b=residents.get(m.to);if(!a||!b||!layoutModel||!groundTerrain)return null;
    return talkRule({ra:footprint(a),rb:footprint(b),talkGap:settings.talkGap,houseRadius:layoutModel.L.house_radius,height:ground.height,water:groundTerrain.water,yards:layoutModel.yards,
      homes:[...residents.values()].map(r=>r.group.position),others:[...residents].filter(([id])=>id!==m.from&&id!==m.to).map(([,r])=>({x:r.base.x,z:r.base.z,r:footprint(r)}))});
  }
  const removeResident=(id,r)=>dropResident(id,r,residents,{disposeSprite,mayorScene:mayorAsset?.scene});
  function rebuildMemorial(retired){
    if(memorial){for(const label of memorial.labels)disposeSprite(label);destroy(memorial.group);memorial=null;}
    const centre=memorialCentre();if(!centre)return;
    // The art is drawn at layout scale like the houses; name plates stay unscaled so fitBubble keeps them at NAMEPLATE_PX.
    const scale=resolveLayout(snapshot.world.layout).scale,built=makeMemorial(retired.length,centre.grounds/scale),group=new T.Group(),art=built.group;
    art.scale.setScalar(scale);group.add(art);
    art.add(built.pick);group.traverse(o=>{o.userData.memorial=true;});
    const labels=built.stones.map((stone,i)=>{const label=nameplate(retired[i].name);label.position.set(stone.x*scale,1.25*scale,stone.z*scale);group.add(label);return label;});
    group.position.set(centre.x,ground.height(centre.x,centre.z),centre.z);group.rotation.y=centre.yaw;scene.add(group);
    memorial={group,labels,x:centre.x,z:centre.z};markDirty();
  }
  function farewell(name){
    const centre=memorialCentre(),sprite=centre&&speechBubble(farewellText(name));if(!sprite)return;
    const y=ground.height(centre.x,centre.z)+9.2;sprite.position.set(centre.x,y,centre.z);scene.add(sprite);farewells.push({sprite,until:performance.now()+FAREWELL_MS,y});
  }
  function updateMemorialFrame(now){
    for(const item of farewells.splice(0)){
      if(now>item.until){disposeSprite(item.sprite);continue;}
      item.sprite.material.opacity=Math.min(1,(item.until-now)/1000);
      if(!reduced)item.sprite.position.y=item.y+Math.sin(animationTime*2.5)*.06;
      fitBubble(item.sprite,camera,viewH);farewells.push(item);
    }
    if(memorial)for(const label of memorial.labels)fitBubble(label,camera,viewH,NAMEPLATE_PX);
  }
  // A cat in Demonstration gets the ground glow (frame loop) and a DEMO tag inside its name label, so the tag moves,
  // clears holograms and hides with the label (House names setting). Touched only when the cat's state flips.
  function markDemo(r,cat,on){
    if(!!r.demo===on)return;r.demo=on;
    if(on)r.label.append(Object.assign(document.createElement('span'),{className:'demo-tag',textContent:'DEMO'}));else r.label.querySelector('.demo-tag')?.remove();
    r.label.setAttribute('aria-label',`Visit ${cat.name}${on?', in Demonstration: canned replies, no model':''}`);
  }
  function update(state,id){
    // A state from another world (it arrives over SSE while the travel flight runs) never patches this one: worlds
    // change only through resetWorld, and states that arrive while it rebuilds wait for the next refresh.
    if(!state?.world||resetting||snapshot&&state.activeWorld?.id!==snapshot.activeWorld?.id)return;snapshot=state;markDirty();selected=id;treasuryLabel.textContent='◈ '+(vaultText()||formatFunds(state.treasury));treasuryLabel.title='Town treasury · '+(state.treasury?'Owner recorded balance':'Balance not set');let changed=false,remerge=false;
    for(const [oldId,item] of residents)if(!state.cats.some(c=>c.id===oldId)){removeResident(oldId,item);changed=true;}
    for(const cat of state.cats){const old=residents.get(cat.id);if(old&&(old.style!==cat.home.style||old.group.position.x!==cat.home.x||old.group.position.z!==cat.home.z||old.yaw!==homeYaw(cat,state.groups||[],state.world.layout))){removeResident(cat.id,old);}if(!residents.has(cat.id)){house(cat);changed=true;}else{const r=residents.get(cat.id);if(!r.live&&rebake(cat,r))remerge=true;}}
    if(state.roads.length!==roads.size||state.roads.some(r=>!roads.has(r.id)))changed=true;const demo=demoCats(state,chatNow());
    for(const [id,r] of residents){r.busy=state.tasks.some(t=>t.cat===id&&['pending','running','waiting_child'].includes(t.status))||(id==='mayor'&&(state.goals||[]).some(g=>g.status==='active'));r.waiting=state.approvals.some(a=>a.cat===id&&a.status==='pending');r.label.classList.toggle('selected',id===selected);r.label.classList.toggle('working',r.busy);}
    for(const cat of state.cats){const r=residents.get(cat.id);if(r){refreshLook(cat,r);markDemo(r,cat,demo.has(cat.id));}}
    // A newly approved request makes its cat happy for a moment; approvals already in the first snapshot are history.
    const approved=new Set(state.approvals.filter(a=>a.status==='approved').map(a=>a.id));
    if(approvedSeen)for(const a of state.approvals)if(a.status==='approved'&&!approvedSeen.has(a.id)){const r=residents.get(a.cat);if(r)r.happyUntil=performance.now()+6000;}
    approvedSeen=approved;
    placeEditRing();if(layoutModel)showLinks();
    const retiredNow=state.retiredCats||[],memorialNow=retiredNow.map(retirementKey).join('|');
    if(memorialNow!==memorialKey){memorialKey=memorialNow;rebuildMemorial(retiredNow);}
    // The first state a scene sees is history: only retirements that arrive afterwards get a farewell.
    if(retiredKeys===null)retiredKeys=new Set(retiredNow.map(retirementKey));
    else{const fresh=newlyRetired(retiredKeys,retiredNow);retiredKeys=new Set(retiredNow.map(retirementKey));for(const cat of fresh)farewell(cat.name);}
    construction.ingest(state);if(changed)rebuildStreets();else if(remerge)remergeHamlets();if(!introHeld)intro.check(state);
    visits.retainCats(state.cats);visits.ingest(state.messages,state.cats);visits.cancelTasks(new Set(state.tasks.filter(t=>['cancelled','failed','interrupted'].includes(t.status)).map(t=>t.id)));
    document.getElementById('replay-visits').disabled=!state.messages.some(m=>residents.has(m.from)&&residents.has(m.to));
  }
  // Another world, rebuilt in place with no page reload (world-travel.js runs it while the town render is paused under
  // the space flight). Teardown, then houses in small batches, then streets, then update() for the memorial, links and
  // the rest, with a frame between steps so no single main-thread task is long. The new world's intro waits for
  // releaseIntro(). Resolves once the new materials are compiled. Returns step timestamps for perf probes.
  let introHeld=false,renderPaused=false,resetting=false,attention=false;
  async function resetWorld(state,{nextFrame=()=>new Promise(r=>requestAnimationFrame(()=>r())),batch=1}={}){
    if(!state?.world)throw Error('No world in that state');
    resetting=true;try{
    const marks=[['start',performance.now()]],mark=name=>marks.push([name,performance.now()]);
    // The observatory stays when the new world remembers the same retired cats (it stands on the same reserved plot).
    const retiredNow=(state.retiredCats||[]).map(retirementKey).join('|'),keepMemorial=memorial&&retiredNow===memorialKey;
    clearWorld({residents,townGroup,linkMesh,memorial:keepMemorial?null:memorial,farewells,mayorScene:mayorAsset?.scene},{disposeSprite});
    if(!keepMemorial){memorial=null;memorialKey=null;}
    townGroup=linkMesh=layoutModel=groundTerrain=null;linksFor=picked=clickedBoard=hoveredBoard=null;boards=[];placeBoardRing();roads.clear();groundHolds=[];landings=[];ground={height:()=>0,walk:()=>0};
    retiredKeys=approvedSeen=null;previews.clear();housePreviews.clear();cancelPress();endMove();editSelected=null;placeEditRing();
    construction.reset();visits.reset();intro.reset();introHeld=true;focusTarget=undefined;selected='mayor';
    controls.reset();resize();markDirty();snapshot=state;mark('clear');await nextFrame();
    for(const cat of state.cats)if(cat.home)for(const _ of houseBake(cat)){mark('bake');await nextFrame();}
    for(let i=0;i<state.cats.length;i+=batch){for(const cat of state.cats.slice(i,i+batch))if(cat.home)house(cat);mark('houses');await nextFrame();}
    rebuildStreets();mark('streets');await nextFrame();
    // The meadow streams its land on its next update: done here, under the sky, not on the first frame of the landing.
    for(const step of meadow.rebuildSteps(controls.target0.x,controls.target0.z,6)){step();mark('meadow');await nextFrame();}
    if(!memorial){memorialKey=retiredNow;rebuildMemorial(state.retiredCats||[]);mark('memorial');await nextFrame();}
    snapshot=null;resetting=false;update(state,'mayor');mark('update');await nextFrame();
    await renderer.compileAsync(scene,camera).catch(()=>{});mark('compiled');
    // One hidden draw, zoomed out as far as the landing starts, so everything it will show has been drawn once:
    // first-use costs (texture uploads, uniforms, shadow map, GL queries) land here, under the sky.
    const zoom=camera.zoom;camera.zoom=controls.minZoom;camera.updateProjectionMatrix();
    scene.updateMatrixWorld(true);worldDirty=false;sun.shadow.needsUpdate=true;renderer.render(scene,camera);
    camera.zoom=zoom;camera.updateProjectionMatrix();mark('drawn');
    if(window.__town)window.__town.lastReset=marks;
    return marks;
    }finally{resetting=false;}
  }
  canvas.addEventListener('pointerdown',e=>{focusTarget=undefined;touches.add(e.pointerId);down=touches.size===1&&e.button===0?[e.clientX,e.clientY,e.pointerId]:null;});
  canvas.addEventListener('pointercancel',e=>{touches.delete(e.pointerId);down=null;});
  canvas.addEventListener('pointerup',e=>{touches.delete(e.pointerId);const start=down;down=null;if(editing||!start||start[2]!==e.pointerId||Math.hypot(e.clientX-start[0],e.clientY-start[1])>5)return;const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);const hits=ray.intersectObjects([treasury,...(memorial?[memorial.group]:[]),...boards.map(b=>b.pick),...[...residents.values()].flatMap(r=>[r.group,r.catModel])],true),hit=hits.find(h=>h.object.userData.archive)??hits.find(h=>h.object.userData.cat||h.object.userData.treasury||h.object.userData.memorial);if(hit){if(studioView){if(hit.object.userData.cat)dispatchEvent(new CustomEvent('studio-pick',{detail:hit.object.userData.cat}));return;}if(hit.object.userData.treasury)onTreasury?.();else if(hit.object.userData.memorial)openMemorial();else if(hit.object.userData.archive){clickedBoard=boards.find(b=>b.pick===hit.object)??null;openArchive();}else onSelect(hit.object.userData.cat);}});
  const pointAt=e=>{const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);};
  const houseAt=e=>{pointAt(e);const hit=ray.intersectObjects([...residents.values()].map(r=>r.group),true).find(h=>h.object.userData.cat);return hit?hit.object.userData.cat:null;};
  // The ray meets the terrain where it crosses the plane at the ground height of its own hit: three refinements suffice on gentle land.
  const groundAt=e=>{pointAt(e);groundPlane.constant=-ground.height(controls.target.x,controls.target.z);
    for(let i=0;i<3;i++){if(!ray.ray.intersectPlane(groundPlane,groundHit))return null;groundPlane.constant=-ground.height(groundHit.x,groundHit.z);}
    return {x:groundHit.x,z:groundHit.z};};
  // Every selection change goes through here, so app.js hears 'edit-select' (its house toolbar follows the selection).
  function placeEditRing(){if(editSelected&&!residents.has(editSelected))editSelected=null;const r=editSelected&&residents.get(editSelected);editRing.visible=!!r;if(r)editRing.position.set(r.group.position.x,r.group.position.y+.12,r.group.position.z);if(editSelected!==lastSelect){lastSelect=editSelected;dispatchEvent(new CustomEvent('edit-select',{detail:editSelected}));}}
  function showGhost(plot,item){
    if(!ghost){ghost=new T.Mesh(new T.BoxGeometry(2.7,item.height,2.3),new T.MeshBasicMaterial({transparent:true,opacity:.4,depthWrite:false}));ghost.position.y=item.height/2;scene.add(ghost);}
    ghost.position.set(plot.x,ground.height(plot.x,plot.z)+item.height/2,plot.z);ghost.material.color.set(plot.valid?'#9cefe0':'#e9826f');
  }
  function clearGhost(){if(!ghost)return;ghost.geometry.dispose();ghost.material.dispose();ghost.removeFromParent();ghost=null;}
  function cancelPress(){if(editPress)controls.enabled=true;editPress=null;editTap=null;clearGhost();}
  function setEditing(on){editing=!!on;if(!editing){cancelPress();endMove();editSelected=null;}hoveredBoard=null;placeBoardRing();wrap.classList.toggle('editing',editing);canvas.style.cursor=editing?'grab':'';placeEditRing();}
  // Studio camera: frameCat glides to a cat's home at zoom 3, shifted into the part of the screen the Studio leaves free (inset px
  // covered on the right for side 'left', at the bottom for 'above'). restoreCamera flies back to the view the Studio found.
  // save:false eases there without keeping a view for restoreCamera (focus, for the chat, uses the same shift).
  function frameCat(id,{side='left',inset=0,save=true}={}){
    const r=residents.get(id);if(!r||!viewW)return;
    if(save&&!studioView)studioView={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};
    aimAt(r.base,3,{side,inset});
  }
  // The ease's goal: 1 unit above point at zoom, moved so it lands in the middle of what inset px on the right ('left') or bottom ('above') leave.
  function aimAt(point,zoom,{side='left',inset=0}={}){
    const perPx=viewW?(camera.right-camera.left)/(zoom*viewW):0,axis=new T.Vector3().setFromMatrixColumn(camera.matrixWorld,side==='left'?0:1);
    focusTarget={position:point.clone().add(new T.Vector3(0,1,0)).addScaledVector(axis,(side==='left'?1:-1)*inset/2*perPx),zoom};
  }
  function restoreCamera(){if(!studioView)return;const v=studioView;studioView=null;focusTarget=undefined;flight.flyTo({position:v.position,target:v.target,zoom:v.zoom,duration:reduced?1:900});}
  // A house's roof in CSS px from the canvas corner, for the edit toolbar. Null while the house is not drawn.
  function houseScreen(id){const r=residents.get(id);if(!r||!viewW)return null;camera.updateMatrixWorld();const p=new T.Vector3(r.group.position.x,r.group.position.y+r.height,r.group.position.z).project(camera);return {x:(p.x*.5+.5)*viewW,y:(-p.y*.5+.5)*viewH};}
  // Keyboard and toolbar moves. startMove picks the selected house up as a ghost; arrows nudge it along the screen (1 m, 0.25 m with
  // Shift); commitMove saves it and cancelMove drops it. x/z stay unrounded so quarter-metre steps add up (planHomeMove rounds).
  function endMove(){move=null;clearGhost();}
  function moveSay(text){dispatchEvent(new CustomEvent('edit-status',{detail:text}));}
  function nudgeMove(dx,dz,lead=''){
    if(!move||!snapshot)return false;
    const f=new T.Vector3(),r=new T.Vector3();camera.getWorldDirection(f);f.y=0;f.normalize();r.setFromMatrixColumn(camera.matrixWorld,0);r.y=0;r.normalize();
    move.x+=r.x*dx+f.x*dz;move.z+=r.z*dx+f.z*dz;
    const plot=planHomeMove(move.x,move.z,snapshot.cats,move.id,snapshot.world.layout,snapshot.groups||[]);
    move.plot=plot;showGhost(plot,residents.get(move.id));
    // Announced only when the validity changes, so holding an arrow key does not flood the live region.
    if(lead||plot.valid!==move.valid){move.valid=plot.valid;moveSay(lead+(plot.valid?'Can go here.':`Cannot go here. ${plot.reason}`));}
    return true;
  }
  function startMove(id){
    const r=residents.get(id),cat=snapshot?.cats.find(c=>c.id===id);if(!editing||!r||!cat?.home)return false;
    endMove();editSelected=id;placeEditRing();move={id,x:cat.home.x,z:cat.home.z,plot:null,valid:null};
    return nudgeMove(0,0,`Moving ${cat.name}. Arrow keys move the house, Enter saves, Escape cancels. `);
  }
  function keyMove(key,shift){
    const s=shift?.25:1,d={ArrowLeft:[-s,0],ArrowRight:[s,0],ArrowUp:[0,s],ArrowDown:[0,-s]}[key];
    if(!d||!editing)return false;
    if(!move&&!startMove(editSelected))return false;
    return nudgeMove(...d);
  }
  function commitMove(){
    if(!move)return false;const m=move;
    if(!m.plot.valid){moveSay(`Cannot go here. ${m.plot.reason}`);return true;}
    const current=snapshot.cats.find(c=>c.id===m.id)?.home;endMove();
    if(m.plot.x!==current?.x||m.plot.z!==current?.z)onMoveHome?.(m.id,m.plot.x,m.plot.z);else moveSay('The house stays where it is.');
    return true;
  }
  function cancelMove(){if(!move)return false;endMove();moveSay('Move cancelled. The house stays where it is.');return true;}
  function clearEditSelect(){editSelected=null;endMove();placeEditRing();}
  // A mouse over a notice board rings it and shows the hand, as a click there opens the Archive (touch has no hover).
  const hoverBoard=b=>{if(b===hoveredBoard)return;hoveredBoard=b;canvas.style.cursor=b?'pointer':'';placeBoardRing();};
  canvas.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse'||editing||e.buttons)return;pointAt(e);const hit=ray.intersectObjects(boards.map(b=>b.pick))[0];hoverBoard(hit?boards.find(b=>b.pick===hit.object):null);hoveredCat=lod?houseAt(e):null;});
  canvas.addEventListener('pointerleave',()=>{hoveredCat=null;if(!editing)hoverBoard(null);});
  // Capture phase on the wrapper runs before OrbitControls, so a mouse press on a house can switch the camera off for that gesture only.
  wrap.addEventListener('pointerdown',e=>{
    if(!editing||e.button!==0)return;
    const id=houseAt(e);
    if(!id){editTap={x:e.clientX,y:e.clientY,pointerId:e.pointerId,mouse:e.pointerType==='mouse'};return;}
    endMove();editSelected=id;placeEditRing();
    editPress={id,x:e.clientX,y:e.clientY,pointerId:e.pointerId,mouse:e.pointerType==='mouse',active:false,plot:null};
    if(editPress.mouse){controls.enabled=false;try{canvas.setPointerCapture(e.pointerId);}catch{}}
  },{capture:true});
  wrap.addEventListener('pointermove',e=>{
    if(!editing||!editPress||e.pointerId!==editPress.pointerId||!editPress.mouse)return;
    if(!editPress.active){if(Math.hypot(e.clientX-editPress.x,e.clientY-editPress.y)<=5)return;editPress.active=true;}
    const item=residents.get(editPress.id),ground=groundAt(e);if(!item||!ground)return;
    editPress.plot=planHomeMove(ground.x,ground.z,snapshot.cats,editPress.id,snapshot.world.layout,snapshot.groups||[]);showGhost(editPress.plot,item);
  },{capture:true});
  wrap.addEventListener('pointerup',e=>{
    if(!editing)return;
    if(editPress&&e.pointerId===editPress.pointerId){
      const press=editPress;editPress=null;controls.enabled=true;clearGhost();
      const current=snapshot.cats.find(c=>c.id===press.id)?.home;
      // The server validates; a rejected move is reported and the house never moved locally, so it stays put.
      if(press.active&&press.plot&&(press.plot.x!==current?.x||press.plot.z!==current?.z))onMoveHome?.(press.id,press.plot.x,press.plot.z);
      return;
    }
    if(editTap&&e.pointerId===editTap.pointerId){
      const tap=editTap;editTap=null;
      if(Math.hypot(e.clientX-tap.x,e.clientY-tap.y)>5)return;
      // A move in progress: a tap on open ground puts the house there (touch and mouse alike) and saves it when it is valid.
      if(move){const ground=groundAt(e);if(ground){move.x=ground.x;move.z=ground.z;nudgeMove(0,0);commitMove();}return;}
      if(tap.mouse){editSelected=null;placeEditRing();return;}
      const target=editSelected,ground=target&&groundAt(e);if(!ground)return;
      const plot=planHomeMove(ground.x,ground.z,snapshot.cats,target,snapshot.world.layout,snapshot.groups||[]),current=snapshot.cats.find(c=>c.id===target)?.home;
      editSelected=null;placeEditRing();
      if(plot.x!==current?.x||plot.z!==current?.z)onMoveHome?.(target,plot.x,plot.z);
    }
  },{capture:true});
  wrap.addEventListener('pointercancel',e=>{if(editPress&&e.pointerId===editPress.pointerId)cancelPress();else if(editTap&&e.pointerId===editTap.pointerId)editTap=null;},{capture:true});
  function previewAppearance(id,look){
    if(look)previews.set(id,look);else previews.delete(id);
    const cat=snapshot?.cats.find(c=>c.id===id),r=residents.get(id);
    if(cat&&r)refreshLook(cat,r);
  }
  function resize(){const w=viewW=wrap.clientWidth,h=viewH=wrap.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);const aspect=w/h,half=Math.max(17,18/aspect);camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;camera.updateProjectionMatrix();}new ResizeObserver(resize).observe(wrap);resize();
  const position=new T.Vector3();let previousFrame=performance.now();
  // Labels move with the CSS translate property (compositor only, no layout) and are written only when they change.
  function place(el,x,y,hidden){
    const v=`${Math.round(x)}px ${Math.round(y)}px`;if(el._at!==v){el._at=v;el.style.left=el.style.top='0';el.style.translate=v;}
    if(el.hidden!==hidden)el.hidden=hidden;
  }
  let treasuryWidth=0,treasuryText='';
  // Estimated like the cat labels: no offsetWidth read, which would force a layout pass while CSS hides the label.
  const memorialWidth=Math.max(56,memorialLabel.textContent.length*7+18),LOD_PPM=16;let lod=false,hoveredCat=null;let archiveWidth=Math.max(56,archiveLabel.textContent.length*7+18);
  // Adaptive resolution: every 2 s compare the frame rate with the target; two slow windows step the pixel ratio down
  // by .25 (never below 1), three fast windows step it back up to the cap. Phones run at a 30 fps budget.
  // The first 6 s (shader compiles, first chunk build) are not judged.
  // On Auto graphics quality (quality.js), the same windows step the tier: two more slow windows already at ratio 1 step
  // it down (and it never climbs back above that tier this session), three fast windows at the ratio cap step it up.
  const quality={frames:0,since:performance.now()+6000,slow:0,fast:0},target=mobile?30:60;
  function adaptQuality(now){
    if(now<quality.since)return;quality.frames++;const span=now-quality.since;if(span<2000)return;
    const fps=quality.frames*1000/span;quality.frames=0;quality.since=now;
    const auto=qualityChoice==='auto';
    if(fps<target*.75){quality.fast=0;if(++quality.slow>=2){
      if(pixelRatio>1){pixelRatio=Math.max(1,pixelRatio-.25);quality.slow=0;renderer.setPixelRatio(pixelRatio);resize();}
      else if(auto&&autoTier!=='low'){autoTier=autoCeiling=stepTier(autoTier,-1,mobile);quality.slow=0;applyTier();}}}
    else if(fps>target*.95){quality.slow=0;if(++quality.fast>=3){
      if(pixelRatio<maxRatio){pixelRatio=Math.min(maxRatio,pixelRatio+.25);quality.fast=0;renderer.setPixelRatio(pixelRatio);resize();}
      else if(auto){const up=stepTier(autoTier,1,mobile,autoCeiling);quality.fast=0;if(up!==autoTier){autoTier=up;applyTier();}}}}
    else quality.slow=quality.fast=0;
  }
  // Graphics quality: the viewer's choice (app.js passes it, see setQuality) and the tier it draws now.
  // Medium and High draw through the post stack (post.js, loaded only then); Low renders straight to the screen.
  let qualityChoice='auto',autoTier=startTier(mobile),autoCeiling='high',tier=null;
  // Low keeps the light, the houses, the lamps and the contact shadows but leaves out the sky gradient (the clear colour is
  // its horizon, the flat sky of before) and the edge grass, and the roof shingles cast no shadow of their own there (the
  // hamlets' shadow stand-ins, see bakedMeshes). Low then measures under the old main, or within 3% of it while cats walk
  // at the default view (docs/perf.md).
  function lowDetail(){const show=tier!=='low';sky.visible=show;meadow.setDetail(show);if(townGroup?.userData.edgeGrass)townGroup.userData.edgeGrass.visible=show;
    townGroup?.traverse(o=>{const s=o.userData.shadowStandIn;if(s){o.castShadow=show;s.visible=!show;}});}
  function applyTier(){
    const next=tierFor(qualityChoice,autoTier,mobile);if(next===tier)return;tier=next;if(window.__town)window.__town.quality=tier;
    // Low draws a 1024 shadow map, as phones always do: a texel stays under a screen pixel at the default zoom, and the pass
    // costs a quarter of the fill. Medium and High keep 2048 on computers.
    const size=mobile||next==='low'?1024:2048;if(sun.shadow.mapSize.x!==size){sun.shadow.mapSize.set(size,size);sun.shadow.map?.dispose();sun.shadow.map=null;sun.shadow.needsUpdate=true;}
    lowDetail();post?.dispose();post=null;if(light)applyLight(light);if(next==='low')return;
    import('./post.js').then(({createPost})=>{if(tier!==next||post)return;post=createPost(renderer,scene,camera,{tier:next,mobile});if(light)applyLight(light);warmShaders();}).catch(error=>console.warn('Post effects unavailable:',error.message));
  }
  applyTier();
  // Cat detail by on-screen size (pixels per metre), with a little hysteresis so it does not flicker at the threshold.
  function updateCatDetail(){
    const ppm=viewH*camera.zoom/(camera.top-camera.bottom),detail=catDetail?ppm>8:ppm>9.5;
    if(detail===catDetail)return;catDetail=detail;for(const r of residents.values())applyCatDetail(r);
  }
  // Ground radius around the target that can show on screen: the tilted ortho footprint, plus room for trees and hills
  // standing past its edge (they rise into view by height / tan(elevation)). The meadow draws nothing beyond it.
  function viewReach(){
    const w=(camera.right-camera.left)/2/camera.zoom,h=(camera.top-camera.bottom)/2/camera.zoom;
    const elev=Math.max(.1,Math.asin(Math.min(1,(camera.position.y-controls.target.y)/camera.position.distanceTo(controls.target))));
    // The height allowance: 14 m covers a pine (about 6 m) on a hilltop (up to 8 m, terrain.js roll), so nothing pops in at the
    // top edge. Low keeps 8 m: 14 cost Low +5% GPU at the min view (1280x800, one load toggled, 2026-11-08).
    return Math.hypot(w,h/Math.sin(elev))+6+(tier==='low'?8:14)/Math.tan(elev);
  }
  const shadowAt=new T.Object3D(),frustum=new T.Frustum(),viewProjection=new T.Matrix4(),catSphere=new T.Sphere();let frameCount=0;
  // The Projects panel's "Show nook" glides the camera to a site (instantly with reduced motion; see focusTarget).
  addEventListener('focus-site',e=>{const {x,z}=e.detail||{};if(Number.isFinite(x)&&Number.isFinite(z))focusTarget={position:new T.Vector3(x,ground.height(x,z)+.6,z),zoom:camera.zoom};});
  addEventListener('focus-memorial',()=>{const m=memorial;if(m)focusTarget={position:new T.Vector3(m.x,m.group.position.y+1.5,m.z),zoom:Math.max(camera.zoom,2.4)};});
  // The Memorial zoom's shot: aimed at the telescope out of the dome's slit (local +z, the front), from the front and a
  // little to the side, lower than the town view so the sky shows above the dome. memorialScreen: the lens on screen.
  const telescopeAt=(m,t)=>m.group.children[0].localToWorld(new T.Vector3(-.1+.5*t,3.85+1.9*t,.2+1.25*t));
  function memorialShot(){
    const m=memorial;if(!m)return null;m.group.updateMatrixWorld(true);
    const target=telescopeAt(m,.5),far=camera.position.distanceTo(controls.target),up=.25,turn=m.group.rotation.y+.5;
    const position=target.clone().add(new T.Vector3(Math.sin(turn)*Math.cos(up),Math.sin(up),Math.cos(turn)*Math.cos(up)).multiplyScalar(far));
    return {position,target,zoom:T.MathUtils.clamp(camera.top/5.2,camera.zoom,controls.maxZoom)};
  }
  function memorialScreen(){
    const m=memorial;if(!m)return null;m.group.updateMatrixWorld(true);camera.updateMatrixWorld();
    const p=telescopeAt(m,1.05).project(camera),rect=canvas.getBoundingClientRect();
    return {x:rect.left+(p.x*.5+.5)*rect.width,y:rect.top+(-p.y*.5+.5)*rect.height};
  }
  // The Archive zoom's shot: square on to the board's face (local +z, its yaw), a little above
  // and to the side and high enough to look over the vault, so the board fills the middle of the screen. archiveScreen: the board on screen.
  function archiveShot(){
    const b=shotBoard();if(!b)return null;
    const target=new T.Vector3(b.x,b.y+BOARD.face,b.z),far=camera.position.distanceTo(controls.target),up=.6,turn=b.yaw+.5;
    const position=target.clone().add(new T.Vector3(Math.sin(turn)*Math.cos(up),Math.sin(up),Math.cos(turn)*Math.cos(up)).multiplyScalar(far));
    return {position,target,zoom:T.MathUtils.clamp(camera.top/(BOARD.top*.65),camera.zoom,controls.maxZoom)};
  }
  function archiveScreen(){
    const b=shotBoard();if(!b)return null;camera.updateMatrixWorld();
    const p=new T.Vector3(b.x,b.y+BOARD.face,b.z).project(camera),rect=canvas.getBoundingClientRect();
    return {x:rect.left+(p.x*.5+.5)*rect.width,y:rect.top+(-p.y*.5+.5)*rect.height};
  }
  // A chat open eases here (plan 8.10): inset px of chat pane on the right, so the cat centres in the town still showing. Never a flight.
  function focus(id,{inset=0}={}){const r=residents.get(id);if(r)aimAt(r.catModel.position,3.2,{inset});}
  function describeVisit(v,sleepers=0){
    if(!v)return snapshot?.paused?'Town resting':!Object.keys(clips).length?'Meadow life · motion asset unavailable':sleepers?`Meadow life · ${sleepers} ${sleepers===1?'cat':'cats'} sleeping`:'Meadow life · cats at home';
    const name=id=>snapshot.cats.find(c=>c.id===id)?.name||'a neighbour',from=name(v.message.from),to=name(v.message.to);
    return `Message animation · ${from} ${v.phase==='talk'?'talks with '+to:v.phase==='return'?'returns home':'visits '+to}${snapshot.paused?' · paused':''}`;
  }
  renderer.setAnimationLoop(()=>{
    const now=performance.now();if(document.hidden||memorialPause.paused||!viewW||!viewH||renderPaused){previousFrame=now;return;}if(mobile&&now-previousFrame<1000/30-4)return;adaptQuality(now);const dt=Math.min((now-previousFrame)/1000,settings.maxAnimationDelta);previousFrame=now;
    if(!snapshot?.paused)animationTime+=dt;
    if(intro.frame(dt))focusTarget=undefined;
    if(flight.step())focusTarget=undefined;else if(focusTarget&&easeStep(camera,controls,focusTarget,dt,{reduced}))focusTarget=undefined;
    controls.update();wind.uStrength.value=reduced?0:weather.wind;groundClock.value=reduced?0:now/1000;if(meadow.update(controls.target.x,controls.target.z,camera.zoom,reduced?0:now/1000,viewReach()))markDirty();camera.updateMatrixWorld();frustum.setFromProjectionMatrix(viewProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));frameCount++;updateCatDetail();const relight=weather.frame(dt,{target:controls.target,camera,reach:viewReach(),light,ground:weatherGround});if(lightT<1){lightT=Math.min(1,lightT+dt/lightSeconds);light=mixLight(lightFrom,lightTo,lightT*lightT*(3-2*lightT));applyLight(light);}else if(relight&&light)applyLight(light);sun.position.copy(controls.target).add(sunOffset);sun.target.position.copy(controls.target);
    shadowFrame++;stars.position.set(controls.target.x,0,controls.target.z);fireflies.position.set(controls.target.x+Math.sin(animationTime*.2)*.7,ground.height(controls.target.x,controls.target.z)+Math.sin(animationTime)*.12,controls.target.z);
    // The next visit waits until its cats have woken (sleep wake-up runs first; see restStep).
    const paused=!!snapshot?.paused,next=visits.current?null:visits.queue[0],awake=m=>[m.from,m.to].every(id=>!(residents.get(id)?.rest.amount>0)&&!construction.busy(id));
    if(snapshot&&!paused)visits.start(snapshot.cats,layoutModel,awake,talkSpot);
    const visit=visits.advance(dt,{speed:settings.walkingSpeed,talkSeconds:settings.talkSeconds,paused,reduced});
    construction.frame({dt:paused?0:dt,time:animationTime,camera,viewH,inVisit:id=>visit?.message.from===id||visit?.message.to===id});
    let sleepers=0,zCount=0;const weatherMood=weather.mood;
    ppm=viewH*camera.zoom/(camera.top-camera.bottom);pawUniforms.uGrow.value=Math.min(PAW.maxGrow,Math.max(1,PAW.minPx/(ppm*PAW.size)));pawUniforms.uMotion.value=reduced?0:1;ppy=screenBox(0,0,0).y-screenBox(0,1,0).y;iconScreen=iconPx(ppm);
    // The vault label rises above the vault's glowing crystal (y 2.5, radius .44) as a name label does above a hologram.
    const crystal=screenBox(0,treasury.position.y+2.5,treasuryZ(),.9*ppm,.9*ppm);
    position.set(0,treasury.position.y+3.3,treasuryZ()).project(camera);const [tx,vaultY]=toScreen(position),vaultOut=Math.abs(position.x)>1||Math.abs(position.y)>1||position.z>1;
    if(treasuryText!==treasuryLabel.textContent&&!treasuryLabel.hidden){treasuryText=treasuryLabel.textContent;treasuryWidth=treasuryLabel.offsetWidth;}
    if(memorial){position.set(memorial.x,memorial.group.position.y+8.2,memorial.z).project(camera);}
    const [mx,memorialY]=toScreen(position),memorialOut=!memorial||Math.abs(position.x)>1||Math.abs(position.y)>1||position.z>1;
    const board=mainBoard();if(board)position.set(board.x,board.y+BOARD.top+.8,board.z).project(camera);
    const [bx,boardY]=toScreen(position),boardOut=!board||Math.abs(position.x)>1||Math.abs(position.y)>1||position.z>1;
    const occupiedLabels=[],priority=id=>id===selected?3:id===visit?.message.from?2:id===visit?.message.to?1:0;
    const from=visit&&residents.get(visit.message.from),to=visit&&residents.get(visit.message.to),talking=visit?.phase==='talk';
    const holoBoxes=[],labelled=[];
    const free=(x,y,width)=>!occupiedLabels.some(p=>Math.abs(p.x-x)<(p.width+width)/2+3&&Math.abs(p.y-y)<((p.height||LABEL_H)+LABEL_H)/2);
    for(const [id,r] of [...residents].sort((a,b)=>priority(b[0])-priority(a[0]))){
      if(construction.hidden(id)){r.catModel.visible=r.holo.group.visible=false;place(r.label,0,0,true);continue;}
      // A quest that needs the owner (the dock badge's S and A ranks) keeps the Mayor awake under an amber "!".
      r.alert=id==='mayor'&&attention;
      let mode=r.busy?'work':'idle',reaction=r.alert?'alert':r.waiting?'question':r.busy?'work':null;
      const sender=visit?.message.from===id,receiver=visit?.message.to===id;
      restStep(r.rest,{idle:idleCat(r,id,visit,next)&&!construction.busy(id)&&!intro.holds(id),dt,sleepAfter:settings.sleepAfterSeconds,paused,reduced});
      // Talking cats face each other from where they actually stand; every turn eases over about 0.3 s (turnToward).
      let yaw=r.yaw||0;
      if(sender){r.catModel.position.set(visit.position.x,ground.walk(visit.position.x,visit.position.z)+.14,visit.position.z);yaw=talking&&to?faceYaw(visit.position,to.base):visit.position.yaw;mode=talking?'talk':'walk';reaction=talking?'talk':'mail';}
      else{r.catModel.position.copy(r.base);if(receiver&&talking){yaw=faceYaw(r.base,visit.position);mode='talk';reaction=r.style==='critic'?'review':r.style==='scholar'?'idea':'talk';}}
      const act=construction.actor(id)||intro.actor(id);if(act){if(act.position)r.catModel.position.copy(act.position);yaw=act.yaw??yaw;mode=act.mode;reaction=null;}
      r.facing=turnToward(r.facing,yaw,paused?0:dt,reduced);r.catModel.rotation.y=r.facing;
      const resting=r.rest.amount>0,asleep=r.rest.state==='sleeping';if(resting){mode='sleep';reaction=null;}settle(r);r.weather=sender||act?null:weatherMood;if(r.hop)r.catModel.position.y+=r.hop;
      // Off-screen cats are hidden and not animated; zoomed far out, each cat animates every other frame; a cat fast
      // asleep only breathes, so it animates every fourth frame.
      const inView=frustum.intersectsSphere(catSphere.set(r.catModel.position,3));r.catModel.visible=inView;
      const animate=inView&&(asleep?(r.seed*1000+frameCount)%4<1:catDetail||sender||!!act||(r.seed*1000+frameCount)%2<1);
      if(r.rest.state==='sleeping'||r.rest.state==='settling')sleepers++;
      // Three glyphs rise from the head, grow, and shrink away; they swell in with the settle and out on waking.
      if(resting&&inView&&zCount+SLEEP_Z<=sleepZ.instanceMatrix.count)for(let k=0;k<SLEEP_Z;k++){
        const t=reduced?(k+.6)/SLEEP_Z:(animationTime*.4+r.seed+k/SLEEP_Z)%1,size=(.42+.3*t)*(reduced?1:Math.sin(Math.PI*t))*r.rest.amount;
        zAt.position.set(r.catModel.position.x+.35+t*.45,r.catModel.position.y+1.55+t*1.1,r.catModel.position.z);zAt.quaternion.copy(camera.quaternion);zAt.scale.setScalar(Math.max(size,1e-4));zAt.updateMatrix();sleepZ.setMatrixAt(zCount++,zAt.matrix);
      }
      if(animate&&!snapshot?.paused){animateCat(r,mode,animationTime,dt,clips,reduced);if(r.rig)applyExpression(r.rig.faces,expressionFor({mode,busy:r.busy,waiting:r.waiting||r.alert,night,happy:(r.happyUntil||0)>now,style:r.style,fallback:r.kitLook?.expression}),reduced?1:1-Math.exp(-dt*8));}
      const motion=r.rest.state==='sleeping'||r.rest.state==='settling'?'Sleeping':r.rest.state==='waking'?'Waking up':r.motion||'At home',wx=r.catModel.position.x.toFixed(2),wz=r.catModel.position.z.toFixed(2);
      if(r.shown?.motion!==motion||r.shown.wx!==wx||r.shown.wz!==wz){r.shown={motion,wx,wz};Object.assign(r.label.dataset,{motion,worldX:wx,worldZ:wz});}
      r.holo.group.visible=!!reaction;r.holo.group.position.copy(r.catModel.position);r.holo.group.rotation.y=r.catModel.rotation.y;r.holo.slate.visible=mode==='work';if(reaction&&r.holo.kind!==reaction){r.holo.sprite.material.map=iconTexture(reaction);r.holo.kind=reaction;}
      const loud=reaction==='alert';r.holo.sprite.position.y=2.4+(reduced?0:Math.sin(animationTime*(loud?5:2.5))*(loud?.16:.08));r.holo.ring.scale.setScalar(reduced?1:1+Math.sin(animationTime*3)*.08);r.holo.sprite.scale.setScalar(iconScreen/ppm*(loud?1.25:1));
      if(!sender)syncBubble(r,null);
      if(animate)r.catModel.updateMatrixWorld(true);
      if(r.holo.group.visible){r.holo.group.updateMatrixWorld(true);if(inView)holoBoxes.push(holoBox(r.catModel.position,r.catModel.rotation.y,r.holo.slate.visible));}
      labelled.push([r,sender]);
    }
    // Name labels go after every hologram stack is known: a label rises above any stack it would cover (its own cat's
    // first), so the stack and the name never overlap at any zoom.
    // The vault, memorial and archive labels clear the vault's crystal and every hologram stack the same way, and go first.
    const ty=liftClear({x:tx,y:vaultY,width:Math.max(60,treasuryWidth),height:LABEL_H},[crystal,...holoBoxes]),my=liftClear({x:mx,y:memorialY,width:memorialWidth,height:LABEL_H},holoBoxes),by=liftClear({x:bx,y:boardY,width:archiveWidth,height:LABEL_H},holoBoxes);
    place(treasuryLabel,tx,ty,vaultOut);place(memorialLabel,mx,my,memorialOut);place(archiveLabel,bx,by,boardOut);
    if(!treasuryLabel.hidden)occupiedLabels.push({x:tx,y:ty,width:treasuryWidth});if(!memorialLabel.hidden)occupiedLabels.push({x:mx,y:my,width:memorialWidth});if(!archiveLabel.hidden)occupiedLabels.push({x:bx,y:by,width:archiveWidth});
    const bubbleBox=from?placeBubble(from,visit,holoBoxes):null;if(bubbleBox)occupiedLabels.push(bubbleBox);occupiedLabels.push(...holoBoxes);
    // Label level of detail: zoomed out (under LOD_PPM screen px per metre) the town shows its hamlet labels and only the
    // Mayor's, the selected cat's, a courier's and the hovered house's names. House names "On" keeps every name.
    lod=ppm<LOD_PPM&&document.body.dataset.labels!=='on';
    for(const h of hamletLabels){
      if(!lod){if(!h.el.hidden)h.el.hidden=true;continue;}
      position.set(h.x,h.y,h.z).project(camera);const out=Math.abs(position.x)>1||Math.abs(position.y)>1||position.z>1,[hx,hy0]=toScreen(position),hy=liftClear({x:hx,y:hy0,width:h.width,height:LABEL_H},holoBoxes);
      place(h.el,hx,hy,out||!free(hx,hy,h.width));if(!h.el.hidden)occupiedLabels.push({x:hx,y:hy,width:h.width});
    }
    for(const [r,sender] of labelled){
      const who=r.label.dataset.cat;if(lod&&!sender&&who!=='mayor'&&who!==selected&&who!==hoveredCat){if(!r.label.hidden)r.label.hidden=true;continue;}
      if(sender){position.copy(r.catModel.position);position.y+=LABEL_Y;}else{position.copy(r.group.position);position.y+=r.height+.5;}position.project(camera);const outside=position.z>1||position.x<-1||position.x>1||position.y<-1||position.y>1,width=labelWidth(r);
      const px=toScreen(position)[0];let py=liftClear({x:px,y:toScreen(position)[1],width,height:LABEL_H},holoBoxes);
      // A label the talk bubble would cover moves just above the bubble, else just below it, else hides.
      if(bubbleBox&&!free(px,py,width)&&Math.abs(bubbleBox.x-px)<(bubbleBox.width+width)/2+3&&Math.abs(bubbleBox.y-py)<(bubbleBox.height+LABEL_H)/2)py=[bubbleBox.y-(bubbleBox.height+LABEL_H)/2-4,bubbleBox.y+(bubbleBox.height+LABEL_H)/2+4].find(y=>free(px,y,width))??py;
      place(r.label,px,py,outside||!free(px,py,width));if(!r.label.hidden)occupiedLabels.push({x:px,y:py,width});
    }
    const caption=describeVisit(visit,sleepers);if(activity.textContent!==caption)activity.textContent=caption;
    if(primeGlyph&&!zCount){sleepZ.setMatrixAt(0,zeroMatrix);zCount=1;}primeGlyph=false;
    sleepZ.count=zCount;sleepZ.visible=zCount>0;if(zCount){sleepZ.instanceMatrix.clearUpdateRanges();sleepZ.instanceMatrix.addUpdateRange(0,zCount*16);sleepZ.instanceMatrix.needsUpdate=true;}
    let shadowCount=0,demoCount=0;const glowScale=Math.min(2,Math.max(1,DEMO_GLOW_PX/(DEMO_GLOW_M*ppm)));
    for(const [id,r] of residents){if(construction.hidden(id))continue;shadowAt.position.copy(r.catModel.position);shadowAt.quaternion.copy(r.catModel.quaternion);shadowAt.updateMatrix();catShadows.setMatrixAt(shadowCount++,shadowAt.matrix);
      // The glow is round, so the cat's yaw does not matter. It lies just above the paving (about +.05), from the ground
      // itself: a settling or sleeping body sinks below its standing height.
      // Zoomed out it grows (up to 2x) to stay about DEMO_GLOW_PX across, so it still reads at phone width.
      if(r.demo){shadowAt.position.y=ground.walk(shadowAt.position.x,shadowAt.position.z)+.08;shadowAt.scale.setScalar(glowScale);shadowAt.updateMatrix();demoGlow.setMatrixAt(demoCount++,shadowAt.matrix);shadowAt.scale.setScalar(1);}}
    catShadows.count=shadowCount;catShadows.instanceMatrix.clearUpdateRanges();catShadows.instanceMatrix.addUpdateRange(0,shadowCount*16);catShadows.instanceMatrix.needsUpdate=true;
    // The shadow map redraws only when what it shows changed: at once when the view or the sun moves, every other frame
    // while a cat's shadow blob moves (every third on Low), after a rebuild (worldDirty, see rebuild), and every
    // 30th frame as a safety net for anything else. Everything else in it is static, so a town at rest skips the pass,
    // about 1 ms of GPU a frame on Low (1280x800, 22 cats, MEASURED).
    {const a=catShadows.instanceMatrix.array,len=shadowCount*16;let catsMoved=shadowCount!==lastCatShadowCount;for(let i=0;!catsMoved&&i<len;i++)catsMoved=a[i]!==lastCatShadows[i];
      if(!lastShadowAt.equals(controls.target)||!lastSunOffset.equals(sunOffset)||(catsMoved&&shadowFrame%(tier==='low'?3:2)===0)||shadowFrame%30===0)sun.shadow.needsUpdate=true;
      if(sun.shadow.needsUpdate){lastShadowAt.copy(controls.target);lastSunOffset.copy(sunOffset);lastCatShadows.set(a.subarray(0,len));lastCatShadowCount=shadowCount;}}
    demoGlow.count=demoCount;demoGlow.visible=demoCount>0;
    if(demoCount){demoGlow.material.opacity=reduced?1:.78+.22*Math.sin(animationTime*2.2);demoGlow.instanceMatrix.clearUpdateRanges();demoGlow.instanceMatrix.addUpdateRange(0,demoCount*16);demoGlow.instanceMatrix.needsUpdate=true;}
    updateMemorialFrame(now);
    if(worldDirty){scene.updateMatrixWorld(true);worldDirty=false;}
    else{for(const o of [sun,sun.target,stars,fireflies,editRing,boardRing,ghost,linkMesh,...farewells.map(f=>f.sprite),...(memorial?.labels||[])])o?.updateMatrixWorld();}
    // renderer.info counts the whole frame (every pass of the post stack, not only its last quad): reset by hand here.
    renderer.info.reset();if(post)post.render(viewW,viewH);else renderer.render(scene,camera);
  });
  const xyz=v=>({x:v.x,y:v.y,z:v.z}),hex=c=>'#'+c.getHexString();
  return {flyTo:flight.flyTo,cameraView:flight.view,tint,resetWorld,
    frameCat,restoreCamera,houseScreen,startMove,keyMove,commitMove,cancelMove,clearEditSelect,
    /** The town square view that Town square (controls.reset) returns to. */
    homeView:()=>({position:xyz(controls.position0),target:xyz(controls.target0),zoom:controls.zoom0}),
    /** Skips whole frames (the render and every per-frame update) while something else covers the town. */
    setRenderPaused:on=>{renderPaused=!!on;},
    setArchiveCount:n=>{const text=`▤ Archive · ${n}`;if(archiveLabel.textContent===text)return;archiveLabel.textContent=text;archiveLabel.setAttribute('aria-label',`Open the town archive, ${n} ${n===1?'artifact':'artifacts'}`);archiveWidth=Math.max(56,archiveLabel.textContent.length*7+18);},
    /** True while a quest needs the owner: the Mayor wakes and shows the alert hologram. */
    setAttention:on=>{attention=!!on;markDirty();},
    releaseIntro:()=>{introHeld=false;if(snapshot)intro.check(snapshot);},
    /** Ends a welcome that is still playing (a flight to another world is starting). */
    endIntro:()=>intro.reset(),
    /** The ground, water and sky colours on screen now, for the travel planet. */
    palette:()=>light?{terrain:hex(GROUND.meadow.clone().multiply(light.terrain)),water:hex(light.water),sky:hex(light.sky)}:null,
    get worldId(){return snapshot?.activeWorld?.id??null;},
    /** Graphics quality: auto, low, medium or high (quality.js). Returns the tier drawn now. */
    setQuality:name=>{if(QUALITIES.includes(name)){qualityChoice=name;if(name==='auto')autoCeiling='high';applyTier();}return tier;},
    memorialShot,memorialScreen,archiveShot,archiveScreen,update,setView,setTimeOfDay,setWeather:name=>weather.set(name),setEditing,previewAppearance,previewHouse,replay:msgs=>{if(snapshot){visits.replay(msgs??snapshot.messages,snapshot.cats);}},focus:(id=selected,o)=>focus(id,o),reset:()=>{focusTarget=undefined;controls.reset();resize();},zoom:factor=>{focusTarget=undefined;camera.zoom=T.MathUtils.clamp(camera.zoom*factor,controls.minZoom,controls.maxZoom);camera.updateProjectionMatrix();},select:(id,o)=>{selected=id;picked=id;for(const [key,r] of residents)r.label.classList.toggle('selected',key===id);showLinks();focus(id,o);}};
}

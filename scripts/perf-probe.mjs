// Render probe: opens the town in headless Chrome (GPU on), reads renderer.info at fixed camera positions and saves screenshots.
// Needs the page loaded with ?perf (town.js then exposes window.__town). No dependencies: Chrome DevTools Protocol over WebSocket.
// Usage: node scripts/perf-probe.mjs --url "http://127.0.0.1:8907/?perf&owner=<key from the server's Clowder: line>" [--size 1280x800] [--dpr 1] [--mobile] [--measure [--runs 3]]
//        [--shot out.jpg] [--view min|default|close] [--night | --time dawn|day|sunset|night] [--pin 1.25] [--tilt] [--yaw deg] [--focus x,z[,zoom]]
// --pin fixes the pixel ratio for the whole run (adaptive quality can no longer step it), so A/B builds render the same pixels.
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const args=process.argv.slice(2),opt=k=>{const i=args.indexOf('--'+k);return i<0?undefined:args[i+1]&&!args[i+1].startsWith('--')?args[i+1]:true;};
const url=opt('url')||'http://localhost:8907/?perf',[width,height]=(opt('size')||'1280x800').split('x').map(Number),dpr=Number(opt('dpr')||1),mobile=!!opt('mobile');
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!chrome)throw new Error('Chrome or Edge not found.');
const port=9300+Math.floor(Math.random()*500);
const proc=spawn(chrome,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${mkdtempSync(join(tmpdir(),'town-probe-'))}`,'--ignore-gpu-blocklist','--enable-gpu-rasterization','--use-angle=d3d11','--disable-frame-rate-limit=false',`--window-size=${width},${height}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let target;for(let i=0;i<50&&!target;i++){try{target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');}catch{}if(!target)await sleep(200);}
if(!target){proc.kill();throw new Error('Chrome did not start.');}
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pending=new Map(),problems=[];ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id);}
  if(d.method==='Runtime.exceptionThrown')problems.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text);
  if(d.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(d.params.type))problems.push(d.params.args.map(a=>a.value??a.description).join(' '));};
const send=(method,params={})=>new Promise((res,rej)=>{const n=++id;pending.set(n,d=>d.error?rej(new Error(method+': '+d.error.message)):res(d.result));ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
try{
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile});
  if(mobile){await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'});}
  await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url});
  for(let i=0;i<100;i++){if(await evaluate('!!(window.__town&&document.querySelectorAll(".world-label").length>3)').catch(()=>false))break;await sleep(200);}
  await sleep(8000);// models, kit, shaders and chunks settle
  if(opt('pin'))await evaluate(`(()=>{const r=window.__town.renderer;r.setPixelRatio(${Number(opt('pin'))});r.setPixelRatio=()=>{};})()`);
  // --time dawn|day|sunset|night (or --night) sets the time of day at once, skipping the 1 s ease.
  const time=opt('time')||(opt('night')&&'night');if(time)await evaluate(`window.__town.setTimeOfDay(${JSON.stringify(time)},true)`);
  // keep: with --eval the shot shows the camera the eval left (a Studio framing, say), so no reset runs.
  const setup={min:'controls.reset();cam.zoom=controls.minZoom;',default:'controls.reset();',close:'controls.reset();cam.zoom=3.2;',keep:';'};
  const frames=`const t=window.__town,{renderer,controls}=t,cam=t.camera,frame=()=>new Promise(r=>requestAnimationFrame(r));`;
  if(opt('measure')){
    // One discarded warm-up pass over every view, then `runs` passes; fps is the mean of 5 s windows with min and max.
    const runs=Number(opt('runs')||3);
    const out=await evaluate(`(async()=>{${frames}const views=${JSON.stringify(setup)},go=code=>{new Function('controls','cam',code)(controls,cam);cam.updateProjectionMatrix();};
      const sample=async(name,ms)=>{go(views[name]);for(let i=0;i<40;i++)await frame();const calls=renderer.info.render.calls,tris=renderer.info.render.triangles;let n=0;const s=performance.now();while(performance.now()-s<ms){await frame();n++;}return {calls,tris,fps:n/((performance.now()-s)/1000),sleeping:document.querySelectorAll('[data-motion="Sleeping"]').length};};
      for(const name of Object.keys(views))await sample(name,1500);
      const out=[];for(const name of Object.keys(views)){const r=[];for(let i=0;i<${runs};i++)r.push(await sample(name,5000));const f=r.map(x=>x.fps);
        out.push({view:name,calls:r[0].calls,triangles:r[0].tris,fps:+(f.reduce((a,b)=>a+b,0)/f.length).toFixed(1),fpsMin:+Math.min(...f).toFixed(1),fpsMax:+Math.max(...f).toFixed(1),runs:f.length,sleeping:Math.min(...r.map(x=>x.sleeping))});}
      controls.reset();const gl=renderer.getContext(),dbg=gl.getExtension('WEBGL_debug_renderer_info');
      return {size:innerWidth+'x'+innerHeight,dpr:devicePixelRatio,pixelRatio:renderer.getPixelRatio(),gpu:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'?',browser:navigator.userAgent.match(/(Chrome|Edg)\\/[\\d.]+/)?.[0],out};})()`);
    console.log(JSON.stringify(out,null,1));
  }
  if(opt('profile')){
    await evaluate(`(async()=>{${frames}new Function('controls','cam',${JSON.stringify(setup[opt('view')||'default'])})(controls,cam);cam.updateProjectionMatrix();for(let i=0;i<30;i++)await frame();})()`);
    await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:200});await send('Profiler.start');await sleep(4000);
    const {profile}=await send('Profiler.stop'),self=new Map(),dt=profile.timeDeltas,total=dt.reduce((a,b)=>a+b,0);
    const byId=new Map(profile.nodes.map(n=>[n.id,n]));profile.samples.forEach((id,i)=>{const n=byId.get(id),k=`${n.callFrame.functionName||'(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;self.set(k,(self.get(k)||0)+(dt[i]||0));});
    console.log([...self].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([k,v])=>(v/total*100).toFixed(1)+'% '+k).join(String.fromCharCode(10)));
    // Hot lines of the app's own files (positionTicks): which statement inside a big function carries the time.
    const lines=new Map();let ticks=0;for(const n of profile.nodes){const f=n.callFrame.url.split('/').pop();for(const t of n.positionTicks||[]){ticks+=t.ticks;if(f.endsWith('.js')&&!f.startsWith('three')){const k=f+':'+t.line;lines.set(k,(lines.get(k)||0)+t.ticks);}}}
    console.log('hot lines:',[...lines].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>k+' '+(v/ticks*100).toFixed(1)+'%').join(', '));
  }
  if(opt('eval'))console.log(JSON.stringify(await evaluate(`(async()=>{${frames}${readFileSync(opt('eval'),'utf8')}})()`),null,1));
  if(opt('shot')){
    const view=opt('view')||(opt('eval')?'keep':'default');
    // --focus x,z[,zoom] moves the target first (bridges, a hamlet); --view mayor frames the Mayor up close.
    if(view==='mayor')setup.mayor="controls.reset();const p=new (cam.position.constructor)();window.__town.scene.traverse(o=>{if(o.userData.cat==='mayor'&&o.isSkinnedMesh)o.getWorldPosition(p);});const d=p.clone().sub(controls.target);controls.target.add(d);cam.position.add(d);cam.zoom=6;";
    // --tilt lowers the camera to its lowest allowed angle (grazing view, where z-fighting shows first).
    if(opt('tilt'))setup[view]=(setup[view]||setup.default)+`const o=cam.position.clone().sub(controls.target),r=o.length(),a=Math.atan2(o.x,o.z),p=controls.maxPolarAngle-.02;cam.position.set(controls.target.x+r*Math.sin(p)*Math.sin(a),controls.target.y+r*Math.cos(p),controls.target.z+r*Math.sin(p)*Math.cos(a));`;
    // --yaw D turns the camera D degrees around the target (reach culling and edges seen from another side).
    if(opt('yaw'))setup[view]=(setup[view]||setup.default)+`{const o=cam.position.clone().sub(controls.target),a=${Number(opt("yaw"))}*Math.PI/180,c=Math.cos(a),s=Math.sin(a);cam.position.set(controls.target.x+o.x*c+o.z*s,cam.position.y,controls.target.z-o.x*s+o.z*c);cam.lookAt(controls.target);}`;
    if(opt('focus')){const [fx,fz,fzoom]=String(opt('focus')).split(',').map(Number);setup[view]=(setup[view]||setup.default)+`const d=new (cam.position.constructor)(${fx},controls.target.y,${fz}).sub(controls.target);controls.target.add(d);cam.position.add(d);cam.zoom=${fzoom||3};`;}
    if(await evaluate('!!window.__town'))await evaluate(`(async()=>{${frames}new Function('controls','cam',${JSON.stringify(setup[view]||setup.default)})(controls,cam);cam.updateProjectionMatrix();for(let i=0;i<40;i++)await frame();})()`);
    const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:85});writeFileSync(opt('shot'),Buffer.from(shot.data,'base64'));console.log('saved',opt('shot'));
  }
  if(problems.length)console.log('page problems:',[...new Set(problems)].slice(0,10));
}finally{ws.close();proc.kill();}

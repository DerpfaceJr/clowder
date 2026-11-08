// Weather: per viewer, like the time of day (localStorage 'cat-town-weather', the ☰ menu). Every kind is cheap on purpose:
//  - falling things (rain, snow, sakura petals, a tornado's debris, sea spray, meteors) are ONE instanced quad mesh per kind,
//    moved entirely in the vertex shader from one clock. The field wraps round the view target, so it never needs rebuilding.
//  - the sky mood leans the time-of-day light (sky, sun, hemisphere, snow on the ground, and for meteors toward the night
//    preset with stars and lamps); town.js re-applies the light only while the mood eases or a flash fades, never every frame.
//  - set pieces (lightning, the tornado, the sea surge, a meteor's distant impact) stand on the far side of the view, near
//    its top edge, so the town in the middle of the screen stays clear.
//  - changing the weather disposes every mesh, geometry and material of the old one; the next use builds them again.
// Reduced motion: the clock stops (still rain, still snow), lightning and impacts never flash and the set pieces stand still.
import * as T from 'three';

export const WEATHERS=['clear','rain','thunder','snow','sakura','tornado','tsunami','meteors'];
export const WEATHER_LABELS={clear:'Clear',rain:'Rain',thunder:'Thunder',snow:'Snow',sakura:'Sakura',tornado:'Tornado',tsunami:'Tsunami',meteors:'Meteors'};

// How each weather leans the light: dim (0..1) toward `sky`, how much snow lies on the ground, how far toward the night
// preset (stars out, lamps lit). Wind scales the grass sway.
const MOOD={
  clear:{dim:0,sky:'#cbdcc0',ground:0,night:0,wind:1},
  rain:{dim:.45,sky:'#9ea8b1',ground:0,night:0,wind:1.4},
  thunder:{dim:.68,sky:'#727a89',ground:0,night:0,wind:1.9},
  snow:{dim:.24,sky:'#e8edf2',ground:.42,night:0,wind:.8},
  sakura:{dim:.1,sky:'#f2d5dc',ground:0,night:0,wind:1.2},
  tornado:{dim:.42,sky:'#aaa48e',ground:0,night:0,wind:2.4},
  tsunami:{dim:.62,sky:'#4f6a73',ground:0,night:0,wind:2.2},
  meteors:{dim:.18,sky:'#1d2445',ground:0,night:.82,wind:.9},
};
// Falling fields: [desktop, phone] counts, fall speed m/s, drift m/s, quad size [width, length] in metres at the default zoom.
const FIELDS={
  rain:{kind:'RAIN',count:[1800,1000],fall:22,drift:[3,1.2],size:[.06,1.15],color:'#eef5fc',opacity:.7},
  thunder:{kind:'RAIN',count:[2200,1200],fall:28,drift:[6.5,2],size:[.065,1.3],color:'#e8eff8',opacity:.74},
  snow:{kind:'FLAKE',count:[3000,1400],fall:1.5,drift:[.8,.3],size:[.3,.3],color:'#ffffff',opacity:.92,tall:.22},
  sakura:{kind:'PETAL',count:[1500,700],fall:1.05,drift:[1.4,.55],size:[.34,.24],color:'#ee96b2',opacity:.95,tall:.22},
  tornado:{kind:'DEBRIS',count:[300,160],fall:0,drift:[0,0],size:[.3,.2],color:'#8f7d5c',opacity:.9},
  // Spray and wind-blown mist off the surge's breaking front (positions come from the sea, see frame()).
  tsunami:{kind:'SPRAY',count:[260,130],fall:0,drift:[0,0],size:[1,1],color:'#dfeeee',opacity:.36},
  // Meteors burn out high: a short streak (0.45 to 1 s) in a long period, all from one radiant. Additive light.
  meteors:{kind:'METEOR',count:[16,10],fall:0,drift:[0,0],size:[1,1],color:'#ffd9a8',opacity:1,additive:true},
};

const FIELD_VERTEX=`attribute vec4 aSeed;
uniform float uTime,uFall,uBoxY,uScale;uniform vec3 uCentre,uFar,uSide;uniform vec2 uBoxXZ,uDrift,uSize;
varying vec2 vUv;varying float vFade;varying float vSeed;varying vec4 vStreak;
vec2 rot(vec2 v,float a){float c=cos(a),s=sin(a);return vec2(c*v.x-s*v.y,s*v.x+c*v.y);}
void main(){
  vUv=position.xy+.5;vSeed=aSeed.w;vStreak=vec4(0.);
  float t=uTime*(.75+.5*aSeed.w);vec3 p;vec2 size=uSize*uScale;
#if defined(DEBRIS)
  // Debris rides the tornado: up the funnel and round it, the orbit widening as it climbs.
  float h=fract(aSeed.y+uTime*.07*(.6+aSeed.w)),r=(mix(1.,7.2,h*h)+aSeed.z*1.4)*uScale,a=aSeed.x*6.2832+uTime*(3.4-2.*h);
  p=uCentre+vec3(cos(a)*r+sin(uTime*.5+h*3.)*h*1.8*uScale,h*uBoxY,sin(a)*r);
  vFade=smoothstep(0.,.06,h)*(1.-smoothstep(.8,1.,h));size=uSize;
#elif defined(SPRAY)
  // uFar: the middle of the breaking line; uDrift: toward the sea; uBoxY: the swell height; uBoxXZ.x: the line's length.
  // Each puff is thrown up off the line, blown landward, swells into mist and fades.
  float life=fract(aSeed.y+uTime*(.16+.14*aSeed.w)),big=step(.62,aSeed.w);
  vec3 f=vec3(uDrift.x,0.,uDrift.y);
  p=uFar+uSide*(aSeed.x-.5)*uBoxXZ.x+f*(aSeed.z*2.5-life*(2.5+5.*aSeed.z)*uScale);
  p.y+=(life*(1.2+2.2*aSeed.z)-life*life*(.6+.8*big))*max(uBoxY,.8);
  size=vec2(mix(.25,1.3+2.2*big,life)*(.6+.6*aSeed.w)*uScale);
  vFade=sin(life*3.1416)*(1.-.45*big);
#elif defined(METEOR)
  // A streak: every period (4 to 13 s) one meteor lights up high over the view for 0.45 to 1 s and burns out before it falls
  // a third of the sky. uCentre: the view target; uBoxY: the height that shows at the top edge there; uBoxXZ.x: the view width.
  float period=4.+aSeed.w*9.,ph=fract(uTime/period+aSeed.x)*period,dur=.45+.55*aSeed.y,k=ph/dur;
  vec3 dir=normalize(vec3(0.,-.8,0.)+uSide*(.7+.35*(aSeed.z-.5)));
  float L=uBoxY*(.1+.16*aSeed.z),headR=uBoxY*.011;
  vec3 from=uCentre+uSide*((fract(aSeed.x*7.31)-.62)*uBoxXZ.x)+vec3(0.,uBoxY*(.6+.32*fract(aSeed.y*5.17)),0.);
  p=from+dir*L*k;
  float glow=smoothstep(0.,.12,k)*(1.-smoothstep(.62,1.,k));glow*=1.+1.3*step(.78,aSeed.w)*exp(-pow((k-.7)/.08,2.));
  vFade=k<1.?glow:0.;
  vStreak=vec4(0.,0.,L*.8*clamp(k*2.2,0.,1.)+1e-3,headR);
#else
  p.y=uBoxY*(1.-fract(aSeed.y+t*uFall/uBoxY));
  p.xz=aSeed.xz*uBoxXZ+uDrift*t;
#if defined(FLAKE)||defined(PETAL)
  p.xz+=vec2(sin(t*1.3+aSeed.x*40.),cos(t*1.1+aSeed.z*40.))*.7;
#endif
  vec2 base=uCentre.xz-uBoxXZ*.5;p.xz=base+mod(p.xz-base,uBoxXZ);
  float f=p.y/uBoxY;p.y+=uCentre.y-1.5;vFade=smoothstep(0.,.06,f)*(1.-smoothstep(.88,1.,f));
#endif
  vec4 c=viewMatrix*vec4(p,1.);
#if defined(RAIN)
  // A streak along the motion as the camera sees it.
  vec3 dir=normalize(vec3(uDrift.x,-uFall,uDrift.y));
  vec2 d=(viewMatrix*vec4(dir,0.)).xy;d=d/max(length(d),1e-4);
  c.xy+=d*(position.y-.5)*size.y+vec2(-d.y,d.x)*position.x*size.x;
#elif defined(METEOR)
  // The quad runs from the tail's end to just past the head, as wide as the head's glow; vStreak.xy: metres along (0 at the
  // head, negative down the tail) and across.
  vec2 d=(viewMatrix*vec4(dir,0.)).xy;d=d/max(length(d),1e-4);
  float along=mix(-vStreak.z,vStreak.w,position.y+.5),across=position.x*2.*vStreak.w;
  vStreak.xy=vec2(along,across);
  c.xy+=d*along+vec2(-d.y,d.x)*across;
  if(vFade<=0.)c.xy=vec2(1e5);
#elif defined(SPRAY)
  c.xy+=position.xy*size;
#else
  float spin=aSeed.w*6.2832+t*(.8+aSeed.z*2.2);vec2 q=position.xy*size;
#if defined(PETAL)||defined(DEBRIS)
  q.x*=.3+.7*abs(cos(spin*.7+aSeed.x*9.));
#endif
  c.xy+=rot(q,spin);
#endif
  gl_Position=projectionMatrix*c;
}`;
const FIELD_FRAGMENT=`uniform vec3 uColor,uTint;uniform float uOpacity;varying vec2 vUv;varying float vFade;varying float vSeed;varying vec4 vStreak;
void main(){
  vec2 q=vUv*2.-1.;vec3 col=uColor;float a;
#if defined(RAIN)
  a=(1.-abs(q.x))*smoothstep(-1.,.4,q.y)*(1.-smoothstep(.85,1.,q.y));
#elif defined(METEOR)
  // A white-hot head with a small halo, and a tail that thins and cools from warm gold to a faint blue-green.
  float along=vStreak.x,across=vStreak.y,tail=vStreak.z,r=vStreak.w;
  float t=clamp(1.+along/tail,0.,1.),w=r*(.06+.2*t);
  float ta=along<0.?t*t*exp(-abs(across)/w):0.;
  float ha=exp(-(along*along+across*across)/(r*r)*6.);
  col=mix(vec3(.45,.8,.85),uColor,smoothstep(.2,.9,t))*ta*.9+vec3(1.,.97,.9)*ha*1.6;
  gl_FragColor=vec4(col*vFade*uOpacity,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  return;
#elif defined(SPRAY)
  float r=length(q);a=smoothstep(1.,0.,r);a*=a*.75;
#elif defined(FLAKE)
  a=smoothstep(1.,.15,length(q));
#elif defined(PETAL)
  // A petal: a soft oval with the little notch at its tip, paler at the heart.
  float e=length(q*vec2(1.,.9));a=smoothstep(1.,.82,e)*smoothstep(0.,.3,length(q-vec2(0.,1.05)));
  col=mix(uColor,vec3(1.,.94,.96),smoothstep(.8,0.,e)*.55)*(.92+.16*vSeed);
#else
  a=smoothstep(1.,.75,length(q*vec2(1.,1.6)));col=mix(uColor,vec3(.45,.6,.32),step(.55,vSeed));
#endif
  a*=uOpacity*vFade;if(a<.01)discard;
  gl_FragColor=vec4(col*uTint,a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const seeded=count=>{const seed=new Float32Array(count*4);let s=0x9e3779b9;for(let i=0;i<count*4;i++){s=Math.imul(s^s>>>15,0x2c1b3c6d)^Math.imul(s^s>>>7,0x297a2d39);seed[i]=(s>>>0)/4294967296;}return seed;};
function quads(seed){
  const geo=new T.InstancedBufferGeometry().copy(new T.PlaneGeometry(1,1));
  geo.setAttribute('aSeed',new T.InstancedBufferAttribute(seed,4));geo.instanceCount=seed.length/4;return geo;
}
function field(def,count,clock){
  const geo=quads(seeded(count));
  const uniforms={uTime:clock,uFall:{value:def.fall},uBoxY:{value:24},uScale:{value:1},uCentre:{value:new T.Vector3()},uFar:{value:new T.Vector3()},uSide:{value:new T.Vector3(1,0,0)},
    uBoxXZ:{value:new T.Vector2(60,60)},uDrift:{value:new T.Vector2(...def.drift)},uSize:{value:new T.Vector2(...def.size)},
    uColor:{value:new T.Color(def.color)},uTint:{value:new T.Color(1,1,1)},uOpacity:{value:def.opacity}};
  const material=new T.ShaderMaterial({uniforms,vertexShader:FIELD_VERTEX,fragmentShader:FIELD_FRAGMENT,defines:{[def.kind]:''},transparent:true,depthWrite:false,
    blending:def.additive?T.AdditiveBlending:T.NormalBlending,side:T.DoubleSide});
  const mesh=new T.Mesh(geo,material);mesh.frustumCulled=false;mesh.renderOrder=5;mesh.matrixAutoUpdate=false;
  return {mesh,uniforms,def};
}

// The tornado: an open funnel turned on a lathe, its stripes spiralling up; it sways and drifts along the far side.
const FUNNEL_VERTEX=`uniform float uTime;varying float vY;varying float vA;
void main(){vY=position.y/28.;vA=atan(position.z,position.x);vec3 p=position;p.x+=sin(uTime*.6+vY*4.)*vY*2.2;p.z+=cos(uTime*.45+vY*3.)*vY*1.4;
  gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(p,1.);}`;
const FUNNEL_FRAGMENT=`uniform float uTime;uniform vec3 uColor,uTint;uniform float uOpacity;varying float vY;varying float vA;
void main(){
  float s=.5+.5*sin(vA*7.+vY*22.-uTime*7.),s2=.5+.5*sin(vA*13.-vY*35.-uTime*10.+1.3);
  float a=(.28+.5*s*s2)*smoothstep(0.,.08,vY)*(1.-smoothstep(.78,1.,vY))*uOpacity;
  gl_FragColor=vec4(mix(uColor,vec3(.92,.9,.86),s*s2*.45)*uTint,a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// The sea surge: a sheet of sea from the shoreline (uFront metres past the target, toward the far side) to well past the
// top edge, rows packed toward the shore. A swell (uCrestD, uCrestH) rolls in on it, steep on its landward face, its top
// tipping forward and foaming as it breaks (uBreak); the shoreline wobbles, foams and settles to the ground's height.
const WAVE_VERTEX=`uniform float uTime,uLen,uFront,uReach,uCrestD,uCrestH,uBreak,uNear,uFar,uRise;uniform vec3 uOrigin;uniform vec2 uF,uS;
varying vec3 vWorld,vNormal;varying float vFoam,vShore,vSwell,vAlong;
// Height of the sea at (metres along the shore, metres out from the target); swell is the rolling hump alone.
float swellAt(float along,float d){
  float x=d-uCrestD,w=x<0.?uCrestH*.8+1.4:uCrestH*2.4+5.;
  return uCrestH*exp(-x*x/(w*w))*(.82+.18*sin(along*.13+uTime*.8))*smoothstep(0.,.1,.5-abs(along/uLen));
}
float heightAt(float along,float d){
  vec2 xz=uOrigin.xz+uS*along+uF*d;
  float chop=.13*sin(xz.x*.9+uTime*1.6)*sin(xz.y*.8-uTime*1.2)+.08*sin(dot(xz,vec2(.35,-.6))*2.1+uTime*2.2);
  return (swellAt(along,d)+chop)*smoothstep(0.,3.,d-uFront);
}
void main(){
  float u=position.y+.5,k=(1.-u)*(1.-u),along=position.x*uLen,shore=k*uReach;
  float d=uFront+shore+sin(along*.19+uTime*.6)*.5+sin(along*.51-uTime*.9)*.3;
  float h=heightAt(along,d),hs=heightAt(along+.4,d),hd=heightAt(along,d+.4);
  vec3 S=vec3(uS.x,0.,uS.y),F=vec3(uF.x,0.,uF.y);
  vNormal=normalize(cross(F*.4+vec3(0.,hd-h,0.),S*.4+vec3(0.,hs-h,0.)));if(vNormal.y<0.)vNormal=-vNormal;
  float rel=swellAt(along,d)/max(uCrestH,.01),land=smoothstep(0.,3.,shore);
  vec2 xz=uOrigin.xz+uS*along+uF*(d-uBreak*smoothstep(.5,1.,rel)*uCrestH*.55*land);
  vSwell=rel;vShore=shore;vAlong=along;vFoam=smoothstep(.75,.98,rel)*(.15+.85*uBreak)*land*(d<uCrestD?1.:.35);
  vWorld=vec3(xz.x,mix(uNear,uFar,smoothstep(0.,uRise,shore))+h,xz.y);// sea level: just over the ground at the shore and out to sea
  gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}`;
const WAVE_FRAGMENT=`uniform float uTime,uOpacity;uniform vec3 uDeep,uShallow,uFoamC,uTint;varying vec3 vWorld,vNormal;varying float vFoam,vShore,vSwell,vAlong;
void main(){
  vec3 n=normalize(vNormal);
  float lit=.62+.38*clamp(dot(n,normalize(vec3(-.4,.8,.45))),0.,1.),steep=1.-n.y;
  // Turquoise in the shallows, darker out to sea, lighter where the swell's face stands up and thins.
  vec3 col=mix(uShallow,uDeep,smoothstep(1.,9.,vShore));col=mix(col,uShallow*1.15,clamp(vSwell*.35+steep*1.6,0.,1.));
  col=col*lit+pow(max(dot(n,normalize(vec3(-.25,1.,.35))),0.),60.)*.15;
  // Foam: sparse wind-blown dashes out at sea, the breaking crest, a lacy line where the sea meets the land and a second,
  // fainter line of the last wash drawing back.
  float n2=.5+.5*sin(vAlong*1.7+uTime*1.5)*sin(vShore*3.1-uTime*2.1+vAlong*.4);
  float w=sin(vAlong*.9+sin(vShore*.5+uTime*.3)*3.)*sin(vShore*2.3-uTime*.8+sin(vAlong*.21)*2.);
  float foam=smoothstep(.9,.99,w)*.4*smoothstep(4.,8.,vShore)+vFoam*(.5+.5*n2)
    +(1.-smoothstep(.25,.8+.9*n2,vShore))+smoothstep(.35,0.,abs(vShore-2.1-.7*n2+.4*sin(vAlong*.3+uTime*.5)))*.45;
  col=mix(col,uFoamC,clamp(foam,0.,1.));
  gl_FragColor=vec4(col*uTint,uOpacity*smoothstep(0.,.12+.3*n2,vShore));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// A meteor's distant impact: instance 0 is the fireball falling to the horizon (uAge < 0), instance 1 the ground glow, the
// rest dust puffs that rise, spread and settle over about nine seconds. uAt: the impact point; uH: the sky height there.
const IMPACT_VERTEX=`attribute vec4 aSeed;uniform float uAge,uH,uScale;uniform vec3 uAt,uSide;varying vec2 vUv;varying float vA;varying float vKind;varying float vHeat;
void main(){
  vUv=position.xy+.5;vKind=aSeed.x<0.?-aSeed.x:2.;vHeat=0.;vec3 p=uAt;vec4 c;
  if(vKind<1.5){
    if(vKind<.5){
      float k=clamp(1.+uAge/.8,0.,1.);vec3 dir=normalize(vec3(0.,-1.,0.)+uSide*.75);
      p=uAt-dir*uH*.75*(1.-k);vA=uAge<0.?smoothstep(0.,.2,k):0.;
      vec2 d=(viewMatrix*vec4(dir,0.)).xy;d=d/max(length(d),1e-4);float len=uH*.2,w=uH*.03;
      c=viewMatrix*vec4(p,1.);c.xy+=d*mix(-len,w,position.y+.5)+vec2(-d.y,d.x)*position.x*w*2.;vHeat=1.;
    }else{
      vA=uAge<0.?0.:exp(-uAge*1.3)*(1.-exp(-uAge*30.));
      c=viewMatrix*vec4(p+vec3(0.,.6,0.),1.);c.xy+=position.xy*vec2(1.,.5)*(3.+4.*sqrt(min(uAge,2.)))*uScale;
    }
  }else{
    float a=max(0.,uAge-.08*aSeed.y),rise=(1.-exp(-a*.55))*(.25+.75*aSeed.y);
    // A column that mushrooms: puffs higher up spread wider.
    p+=uSide*(aSeed.z-.5)*(.8+rise*4.+a*.3)*uScale+vec3(0.,rise*uH*.3,0.);
    vA=.45*smoothstep(0.,.5,a)*(1.-smoothstep(3.5,9.,a))*step(0.,uAge);vHeat=exp(-a*.9)*(1.-aSeed.y);
    float sz=(1.+a*.3)*(.6+.6*aSeed.w)*1.1*uScale;p.y+=sz*.8;// the camera-facing puff leans back into the ground: lift it clear
    c=viewMatrix*vec4(p,1.);c.xy+=position.xy*sz;
  }
  gl_Position=projectionMatrix*c;}`;
const IMPACT_FRAGMENT=`uniform vec3 uTint;varying vec2 vUv;varying float vA;varying float vKind;varying float vHeat;
void main(){
  vec2 q=vUv*2.-1.;float r=length(q),a;vec3 col;
  if(vKind<.5){float t=vUv.y;a=t*t*(1.-abs(q.x))*vA;col=mix(vec3(1.,.55,.25),vec3(1.,.97,.9),smoothstep(.8,1.,t));}
  else if(vKind<1.5){a=smoothstep(1.,0.,r);a*=a*vA;col=mix(vec3(1.,.38,.1),vec3(1.,.78,.45),smoothstep(.45,0.,r));}
  else{a=smoothstep(1.,.25,r)*(.8+.2*sin(q.x*5.+q.y*4.))*vA;col=mix(vec3(.45,.38,.32)*max(uTint,vec3(.5)),vec3(1.,.5,.2),vHeat*.8);}
  if(a<.01)discard;gl_FragColor=vec4(col,a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Metres from the view target the surge's shore never passes: just outside the main plaza at its default framing.
const SHORE_MIN=13.5;
const LIGHT_KEYS=['sky','skyTop','hemiSky','hemiGround','sun','terrain','water'],LIGHT_NUMS=['hemi','sunIntensity','exposure','glow'];
/** Lean the time-of-day light: night (0..1) toward the night preset, dim toward the mood sky, flash on top. Pure; `out`
 *  and its colours are scratch, the preset `p` is never written. Exported for tests. */
export function leanLight(p,{night=0,dim=0,flash=0,ground=0,sky,nightLight=null},out){
  Object.assign(out,p);
  if(night>.001){
    if(nightLight){for(const k of LIGHT_KEYS)if(p[k]&&nightLight[k])out[k]=(out['_'+k]||=new T.Color()).copy(p[k]).lerp(nightLight[k],night);
      for(const k of LIGHT_NUMS)if(typeof p[k]==='number'&&typeof nightLight[k]==='number')out[k]=p[k]+(nightLight[k]-p[k])*night;}
    out.stars=Math.max(p.stars||0,night);out.lamps=Math.max(p.lamps||0,night*.9);
  }
  const lum=c=>.2126*c.r+.7152*c.g+.0722*c.b,base=out.sky;
  // Under a heavy sky the light itself turns toward the cloud colour, not only dimmer.
  if(sky&&dim>.001){for(const k of ['hemiSky','sun'])if(out[k])out[k]=(out['_c'+k]||=new T.Color()).copy(out[k]).lerp(sky,dim*.4);}
  if(sky&&dim>.001){const m=(out._mood||=new T.Color()).copy(sky),scale=Math.min(1,lum(base)/Math.max(.01,lum(m)));out.sky=(out._dimSky||=new T.Color()).copy(base).lerp(m.multiplyScalar(scale),dim);if(out.skyTop)out.skyTop=(out._dimTop||=new T.Color()).copy(out.skyTop).lerp(m,dim);}
  out.sunIntensity=out.sunIntensity*(1-.9*dim);out.hemi=out.hemi*(1-.45*dim)+flash*1.6;out.exposure=out.exposure*(1-.15*dim)+flash*.35;
  out.snow=ground;
  return out;
}

export function createWeather({scene,mobile=false,reduced=false,night=null}){
  const clock={value:0},root=new T.Group();root.matrixAutoUpdate=false;scene.add(root);
  const tint=new T.Color(1,1,1),fields=new Map();
  // The night preset (presentation.config.json timesOfDay.night) as colours, for the meteor shower's night-ish sky.
  const nightLight=night?Object.fromEntries(Object.entries(night).map(([k,v])=>[k,typeof v==='string'?new T.Color(v):v])):null;
  let name='clear',mood=MOOD.clear,dim=0,dimTo=0,ground=0,groundTo=0,nightK=0,flash=0,flashGain=1,nextStrike=3,bolt=null,boltLife=0,since=0;
  const moodSky=new T.Color(MOOD.clear.sky),out={},moodOut={kind:'clear',strength:0,startle:0,toward:0,since:0};
  const far=new T.Vector3(),side=new T.Vector3(1,0,0),fwd=new T.Vector2(0,1),anchor=new T.Vector3();
  let anchorSet=false,windNow=1,boltSpread=40,funnelScale=1,skyH=10,toward=0;
  // Set pieces are built on first use and disposed when the weather changes.
  let funnel=null,wave=null,impact=null,impactAge=99,nextImpact=6,levelClock=0,levelSet=false;const level=[0,0];
  const drop=m=>{if(!m)return null;root.remove(m);m.geometry.dispose();m.material.dispose();return null;};
  const fieldFor=key=>{
    if(!FIELDS[key])return null;
    if(!fields.has(key)){const def=FIELDS[key],f=field(def,mobile?def.count[1]:def.count[0],clock);root.add(f.mesh);fields.set(key,f);}
    return fields.get(key);
  };
  function buildFunnel(){
    const pts=[];for(let i=0;i<=24;i++){const y=i/24*28;pts.push(new T.Vector2(.7+6.6*Math.pow(i/24,1.7),y));}
    const uniforms={uTime:clock,uColor:{value:new T.Color('#9c8f76')},uTint:{value:tint},uOpacity:{value:.78}};
    const m=new T.Mesh(new T.LatheGeometry(pts,48),new T.ShaderMaterial({uniforms,vertexShader:FUNNEL_VERTEX,fragmentShader:FUNNEL_FRAGMENT,transparent:true,depthWrite:false,side:T.DoubleSide}));
    m.frustumCulled=false;m.renderOrder=4;return m;
  }
  function buildWave(){
    const uniforms={uTime:clock,uLen:{value:120},uFront:{value:20},uReach:{value:30},uCrestD:{value:40},uCrestH:{value:0},uBreak:{value:0},uNear:{value:0},uFar:{value:0},uRise:{value:10},uOrigin:{value:new T.Vector3()},
      uF:{value:new T.Vector2(0,1)},uS:{value:new T.Vector2(1,0)},uDeep:{value:new T.Color('#11343f')},uShallow:{value:new T.Color('#2f7d86')},uFoamC:{value:new T.Color('#e8f2ef')},uTint:{value:tint},uOpacity:{value:.97}};
    const m=new T.Mesh(new T.PlaneGeometry(1,1,mobile?72:120,mobile?28:40),new T.ShaderMaterial({uniforms,vertexShader:WAVE_VERTEX,fragmentShader:WAVE_FRAGMENT,transparent:true,side:T.DoubleSide}));
    m.frustumCulled=false;m.renderOrder=3;return m;
  }
  function buildImpact(){
    const n=mobile?14:22,seed=seeded(n);seed[0]=-1e-6;seed[4]=-1;// instance 0: the fireball, 1: the glow, the rest dust
    const uniforms={uAge:{value:99},uH:{value:20},uScale:{value:1},uAt:{value:new T.Vector3()},uSide:{value:new T.Vector3(1,0,0)},uTint:{value:tint}};
    const m=new T.Mesh(quads(seed),new T.ShaderMaterial({uniforms,vertexShader:IMPACT_VERTEX,fragmentShader:IMPACT_FRAGMENT,transparent:true,depthWrite:false,side:T.DoubleSide}));
    m.frustumCulled=false;m.renderOrder=4;m.matrixAutoUpdate=false;m.visible=false;return m;
  }
  // A lightning bolt: a jagged ribbon from the clouds to the ground on the far side, facing the camera.
  function strike(){
    if(bolt){root.remove(bolt);bolt.geometry.dispose();}
    const pts=[],at=far.clone().addScaledVector(side,(Math.random()-.5)*boltSpread);let x=0;
    for(let i=0;i<=14;i++){x+=(Math.random()-.5)*3.2;pts.push(at.clone().addScaledVector(side,x).setY(at.y+skyH*1.15*(1-i/14)));}
    const pos=[];const w=Math.max(.12,skyH*.012);
    for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1],wa=w*(1-i/14*.6),wb=w*(1-(i+1)/14*.6);
      const a0=a.clone().addScaledVector(side,-wa),a1=a.clone().addScaledVector(side,wa),b0=b.clone().addScaledVector(side,-wb),b1=b.clone().addScaledVector(side,wb);
      pos.push(...a0.toArray(),...b0.toArray(),...a1.toArray(),...a1.toArray(),...b0.toArray(),...b1.toArray());}
    const g=new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(pos,3));
    bolt=new T.Mesh(g,boltMaterial);bolt.frustumCulled=false;bolt.renderOrder=6;bolt.updateMatrixWorld();root.add(bolt);boltLife=.32;flash=1;flashGain=1;
  }
  const boltMaterial=new T.MeshBasicMaterial({color:'#f4f1ff',transparent:true,opacity:1,depthWrite:false,side:T.DoubleSide,fog:false,toneMapped:false});

  function set(next){
    if(!WEATHERS.includes(next))next='clear';if(next!==name)since=0;name=next;mood=MOOD[next];dimTo=mood.dim;groundTo=mood.ground;
    for(const [key,f] of fields)if(key!==next){drop(f.mesh);fields.delete(key);}
    fieldFor(next);
    if(next!=='tornado')funnel=drop(funnel);else if(!funnel){funnel=buildFunnel();root.add(funnel);}
    if(next!=='tsunami')wave=drop(wave);else if(!wave){wave=buildWave();root.add(wave);levelClock=0;levelSet=false;}
    if(next!=='meteors')impact=drop(impact);else if(!impact){impact=buildImpact();root.add(impact);impactAge=99;nextImpact=4+Math.random()*5;}
    if(bolt&&next!=='thunder'){root.remove(bolt);bolt.geometry.dispose();bolt=null;}
    anchorSet=false;if(reduced){dim=dimTo;ground=groundTo;nightK=mood.night;}
  }

  /** Per frame. Returns true when the light must be re-applied (the mood is easing or a flash is fading). */
  function frame(dt,{target,camera,reach,light,ground=null}){
    if(!reduced)clock.value+=dt;since+=dt;
    // Where the far side of the view is: along the camera's look, past the target, near the top of the screen.
    fwd.set(target.x-camera.position.x,target.z-camera.position.z);if(fwd.lengthSq()<1e-6)fwd.set(0,1);fwd.normalize();
    side.set(-fwd.y,0,fwd.x);toward=Math.atan2(fwd.x,fwd.y);
    // The view on the ground: half its width, and how far past the target the top edge of the screen lands.
    const halfW=(camera.right-camera.left)/2/camera.zoom,elev=Math.max(.2,Math.asin(Math.min(1,(camera.position.y-target.y)/camera.position.distanceTo(target)))),top=(camera.top-camera.bottom)/2/camera.zoom/Math.sin(elev);
    const box=Math.min(170,Math.max(34,reach*1.5)),scale=Math.min(1.6,box/60);// zoomed far out, drops stay thin: fill rate is the cost
    far.set(target.x+fwd.x*top*.55,target.y,target.z+fwd.y*top*.55);
    // The tornado stands to one side of the view, sized so its whole height fits on screen.
    funnelScale=Math.min(1,top*.7/28);skyH=top*.42*Math.tan(elev);
    // Set pieces wander toward that point slowly, so a pan does not drag them along at once.
    if(!anchorSet){anchor.copy(far);anchorSet=true;}else anchor.lerp(far,Math.min(1,dt*(reduced?10:.25)));
    // The light leans on the time of day: at night the mood sky is scaled down to the night sky's brightness.
    if(light){const l=light.stars>.5?.35:1;tint.setRGB(l,l,l).lerp(light.hemiSky,.25);}
    for(const [key,f] of fields){
      const u=f.uniforms;
      u.uCentre.value.copy(key==='tornado'?anchor:target);u.uFar.value.copy(anchor);u.uSide.value.copy(side);
      if(key==='tornado'){u.uBoxY.value=28*funnelScale;u.uScale.value=funnelScale;}
      else if(key==='meteors'){u.uBoxXZ.value.set(halfW*2,halfW*2);u.uBoxY.value=top*Math.tan(elev);u.uScale.value=1;}
      else if(key!=='tsunami'){u.uBoxXZ.value.set(box,box);u.uBoxY.value=Math.min(40,box*(f.def.tall||.4));u.uScale.value=scale;}
      if(key==='meteors')u.uTint.value.setRGB(1,1,1);else u.uTint.value.copy(tint);// meteors glow at night too
    }
    if(funnel){funnel.position.set(anchor.x-fwd.x*top*.35,anchor.y,anchor.z-fwd.y*top*.35).addScaledVector(side,(Math.sin(clock.value*.05)>0?1:-1)*halfW*(.5+.15*Math.abs(Math.sin(clock.value*.05))));funnel.scale.setScalar(funnelScale);funnel.updateMatrixWorld();
      fields.get('tornado')?.uniforms.uCentre.value.copy(funnel.position);toward=Math.atan2(funnel.position.x-target.x,funnel.position.z-target.z);}
    if(wave)surge(wave.material.uniforms,target,top,halfW,scale,dt,ground);
    if(impact)meteorImpact(dt,target,top,halfW,elev,ground);
    if(bolt){boltLife-=dt;bolt.material.opacity=boltLife>0?(boltLife>.2||boltLife<.12?1:.25):0;if(boltLife<=0){root.remove(bolt);bolt.geometry.dispose();bolt=null;}}
    boltSpread=halfW*1.6;
    if(name==='thunder'&&!reduced){nextStrike-=dt;if(nextStrike<=0){strike();nextStrike=4+Math.random()*8;}}
    const was=dim+ground+flash+nightK;
    dim+=(dimTo-dim)*Math.min(1,dt*1.2);if(Math.abs(dimTo-dim)<.002)dim=dimTo;
    ground+=(groundTo-ground)*Math.min(1,dt*.5);if(Math.abs(groundTo-ground)<.002)ground=groundTo;
    nightK+=(mood.night-nightK)*Math.min(1,dt*.8);if(Math.abs(mood.night-nightK)<.002)nightK=mood.night;
    flash=Math.max(0,flash-dt*2.6);
    windNow+=(mood.wind-windNow)*Math.min(1,dt);
    return was!==dim+ground+flash+nightK;
  }
  // The surge: the sea floods in from past the top edge over six seconds and settles with its shore a little above the
  // middle of the upper half of the screen. Then every 13 s a swell rolls in from far out, grows as it nears the shore,
  // tips over and breaks in foam and spray, its wash runs a few metres up the land and draws back.
  function surge(u,target,top,halfW,scale,dt,ground){
    const ease=x=>x*x*(3-2*x),arrive=reduced?1:ease(Math.min(1,since/6)),p=reduced?.55:Math.max(0,since-3)/13%1;
    const c=Math.min(1,p/.8),brk=ease(Math.min(1,Math.max(0,(p-.62)/.18)))*(1-ease(Math.min(1,Math.max(0,(p-.86)/.14))));
    // The shore rests halfway to the top edge, never nearer the view target than SHORE_MIN (zoomed in, the sea stays off
    // the plaza and simply goes off screen).
    const rest=Math.max(top*.5,SHORE_MIN),start=Math.max(top*1.35,rest+top*.85);
    const front=start+(rest-start)*arrive-Math.min(2,top*.05)*Math.sin(Math.PI*Math.min(1,Math.max(0,(p-.74)/.26))),hMax=Math.min(3.6,top*.16);
    u.uFront.value=front;u.uReach.value=top*1.5+12;u.uCrestD.value=front+(top*1.1)*(1-(1-Math.pow(1-c,1.6)))+1.2;
    u.uCrestH.value=hMax*(.25+.75*Math.pow(c,1.4))*(1-.8*ease(Math.min(1,Math.max(0,(p-.8)/.17))))*arrive;u.uBreak.value=brk;
    u.uOrigin.value.copy(target);u.uF.value.copy(fwd);u.uRise.value=top*.6;
    // Sea level rides just over the highest ground under it, near the shore and farther out (hills and grass tufts must not poke through);
    // sampled twice a second, eased. Without a ground sampler, the view target (.6 m up) less .55.
    if((levelClock-=dt)<=0){levelClock=.5;for(let band=0;band<2;band++){let m=-Infinity;for(let i=-2;i<=2;i++)for(let j=0;j<3;j++){const dd=front+(band?top*.6+j*top*.4:j*top*.2),ss=i*halfW*.65;m=Math.max(m,ground?ground(target.x+fwd.x*dd+side.x*ss,target.z+fwd.y*dd+side.z*ss):target.y-.55);}level[band]=m+.6;}}
    if(!levelSet){u.uNear.value=level[0];u.uFar.value=level[1];levelSet=true;}u.uNear.value+=(level[0]-u.uNear.value)*Math.min(1,dt*2);u.uFar.value+=(Math.max(level[0],level[1])+top*.06-u.uFar.value)*Math.min(1,dt*2);u.uS.value.set(side.x,side.z);u.uLen.value=halfW*2.8;
    const spray=fields.get('tsunami');
    if(spray){const s=spray.uniforms,at=Math.max(front+.5,u.uCrestD.value-1.5);s.uFar.value.set(target.x+fwd.x*at,u.uNear.value,target.z+fwd.y*at);
      s.uDrift.value.copy(fwd);s.uBoxXZ.value.set(halfW*2.4,0);s.uBoxY.value=u.uCrestH.value;s.uScale.value=scale;s.uOpacity.value=spray.def.opacity*(.12+.88*brk)*arrive;}
  }
  // Every 7 to 16 s a bigger meteor falls to the horizon: a fireball, a flash (cats startle; the light warms briefly) and a
  // dust plume that rises and settles. Never with reduced motion.
  function meteorImpact(dt,target,top,halfW,elev,ground){
    const u=impact.material.uniforms;
    if(!reduced){nextImpact-=dt;if(nextImpact<=0&&impactAge>9){nextImpact=7+Math.random()*9;impactAge=-.8;const d=top*(.6+.06*Math.random()),s=(Math.random()<.5?-1:1)*(.3+.4*Math.random())*halfW;
      const x=target.x+fwd.x*d+side.x*s,z=target.z+fwd.y*d+side.z*s;u.uAt.value.set(x,ground?ground(x,z):target.y-.6,z);u.uSide.value.copy(side);}}
    if(impactAge<9){const before=impactAge;impactAge+=reduced?0:dt;if(before<0&&impactAge>=0){flash=Math.max(flash,.55);flashGain=.35;}}
    u.uAge.value=impactAge;u.uH.value=top*Math.tan(elev);u.uScale.value=Math.max(.6,top/20);impact.visible=impactAge<9;
  }

  /** The time-of-day light with the weather's mood on top. Returns p itself when the sky is clear and still. */
  function adjust(p){
    if(dim<=.001&&ground<=.001&&flash<=.001&&nightK<=.001)return p;
    moodSky.set(mood===MOOD.clear?p.sky:mood.sky);
    return leanLight(p,{night:nightK,dim,flash:flash*flashGain,ground,sky:moodSky,nightLight},out);
  }
  set('clear');
  return {
    set,frame,adjust,root,
    get name(){return name;},
    /** Grass and reed sway multiplier. */
    get wind(){return reduced?1:windNow;},
    /** What cats react to (one object, rewritten each read): the weather, how strong it is now (0..1), a startle (0..1,
     *  decays; lightning or a meteor impact), the world yaw of the far side or the tornado (faceYaw's convention), and
     *  seconds since the weather was chosen. */
    get mood(){moodOut.kind=name;moodOut.strength=dim/Math.max(.01,mood.dim||1);moodOut.startle=flash;moodOut.toward=toward;moodOut.since=since;return moodOut;},
  };
}

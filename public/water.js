// River water: one MeshStandardMaterial with a small onBeforeCompile patch. Everything moves through one time uniform
// (frozen at 0 under reduced motion by town.js), no render targets, no per-frame JS. The mesh carries `depth` (metres
// below the water line at each vertex, negative on the bank), so depth = 0 is exactly the visible shoreline.
//  - colour: shallow (lighter, greener) at the banks to deep (darker, teal-blue) mid-channel, both from the preset water
//  - ripples: two scrolling value-noise layers at different scales and directions tilt the normal, so the scene's own
//    sun and hemisphere lights make the glint (every time of day for free)
//  - foam: a soft broken line where depth nears 0
//  - sky: a Fresnel-ish mix toward the fog colour (the preset sky), stronger on ripple faces turned away from the camera
import * as T from 'three';

const NL=String.fromCharCode(10);
/** Shallow and deep tints for a water colour (the time-of-day preset's `water`). */
export function waterTints(water,shallow=new T.Color(),deep=new T.Color()){
  const c=new T.Color(water);
  shallow.setRGB(Math.min(1,c.r*1.05),Math.min(1,c.g*1.18),Math.min(1,c.b));
  deep.setRGB(c.r*.42,c.g*.66,c.b*.84);
  return {shallow,deep};
}

const PARS=`uniform float uTime;uniform float uBed;uniform vec3 uShallow;uniform vec3 uDeep;varying float vDepth;varying vec2 vWaterXZ;
float wHash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
// Value noise with its analytic gradient: (value, d/dx, d/dy).
vec3 wNoise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f),du=6.*f*(1.-f);
  float a=wHash(i),b=wHash(i+vec2(1.,0.)),c=wHash(i+vec2(0.,1.)),d=wHash(i+vec2(1.,1.)),k=a-b-c+d;
  return vec3(a+(b-a)*u.x+(c-a)*u.y+k*u.x*u.y,du*(vec2(b-a,c-a)+k*u.yx));}`;
const COLOUR=`#include <color_fragment>
  const mat2 wMA=mat2(.8,-.6,.6,.8),wMB=mat2(.6,.8,-.8,.6);
  const vec2 wSA=vec2(.3,.9);
  vec3 wA=wNoise(wSA*(wMA*vWaterXZ)+vec2(uTime*.16,uTime*.05)),wB=wNoise(wMB*vWaterXZ*1.3+vec2(-uTime*.1,uTime*.22));
  vec2 wSlope=((wA.yz*wSA)*wMA)*.5+(wB.yz*wMB)*1.3*.3;
  float wDepth=clamp(vDepth/uBed,0.,1.);
  diffuseColor.rgb=mix(uShallow,uDeep,smoothstep(.04,.85,wDepth));
  float wFoam=(1.-smoothstep(.0,.15,wDepth+(wB.x-.5)*.1))*(.55+.45*wA.x);
  diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.94,.96,.93),wFoam*.75);
  diffuseColor.a=max(opacity*mix(.6,1.,smoothstep(0.,.35,wDepth)),wFoam*.9);`;
const NORMAL=`#include <normal_fragment_maps>
  vec3 wUp=normalize(vec3(-wSlope.x,1.,-wSlope.y));normal=normalize((viewMatrix*vec4(wUp,0.)).xyz);`;
// Glint: the sun cannot mirror into a camera this high, so the highlight is aimed half way from straight up
// toward the true half vector; ripple faces near it sparkle in the sun's own colour (moonlight at night).
const SKY=`vec3 wView=isOrthographic?vec3(0.,0.,1.):normalize(vViewPosition);
  #if NUM_DIR_LIGHTS>0
  vec3 wHalf=normalize(mix((viewMatrix*vec4(0.,1.,0.,0.)).xyz,normalize(directionalLights[0].direction+wView),.5));
  outgoingLight+=directionalLights[0].color*pow(clamp(dot(normal,wHalf),0.,1.),600.)*.35*(1.-wFoam);
  #endif
  #ifdef USE_FOG
  outgoingLight=mix(outgoingLight,fogColor,clamp(.02+.7*pow(1.-clamp(dot(normal,wView),0.,1.),3.),0.,.35));
  #endif
  #include <opaque_fragment>`;

/** The water material. time: a {value} uniform shared with the wind; bed: river bed depth (terrain P.bed). */
export function createWaterMaterial(time,bed=1){
  const uniforms={uTime:time,uBed:{value:bed},uShallow:{value:new T.Color()},uDeep:{value:new T.Color()}};
  const material=new T.MeshStandardMaterial({color:'#79b2c9',roughness:.2,metalness:.05,transparent:true,opacity:.88,depthWrite:false});
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);
    shader.vertexShader='attribute float depth;varying float vDepth;varying vec2 vWaterXZ;'+NL+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+NL+'vDepth=depth;vWaterXZ=(modelMatrix*vec4(transformed,1.)).xz;');
    shader.fragmentShader=PARS+NL+shader.fragmentShader.replace('#include <color_fragment>',COLOUR).replace('#include <normal_fragment_maps>',NORMAL).replace('#include <opaque_fragment>',SKY);
  };
  material.customProgramCacheKey=()=>'river-water-2';
  /** Time of day: the preset's water colour. */
  const setTint=water=>{material.color.set(water);waterTints(water,uniforms.uShallow.value,uniforms.uDeep.value);};
  setTint(material.color);
  return {material,uniforms,setTint};
}

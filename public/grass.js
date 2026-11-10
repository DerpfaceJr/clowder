// The meadow's grass look, shared by the ground shader (meadow.js), the meadow's grass clumps and fine blades, and the
// edge grass along the kerbs (town-ground.js). One field of world-space noise and one wind field feed all of them, so a
// clump's root takes the colour of the ground it stands on and the bright wind bands roll across ground and grass alike.
import * as T from 'three';
import {wind} from './world-art.js';

export const GRASS_TILE=3.2;// metres per repeat of the painted grass detail
const NL=String.fromCharCode(10);
const rand=seed=>{let h=seed;return ()=>(h=(h*16807)%2147483647)/2147483647;};

/** Painted grass detail: short rounded strokes on a light ground, seamless, drawn once. Only fine strokes (no blotches):
 *  the large-scale variation comes from world-space noise, which never repeats. Stored around 0.85 so it can darken and
 *  (x1.2 in the shader) lighten the vertex colour. userData.mean is its mean linear colour x1.2, so a clump's root can
 *  match the ground on average. */
export function grassTexture(anisotropy){
  const N=512,c=document.createElement('canvas');c.width=c.height=N;const g=c.getContext('2d'),rnd=rand(7);
  g.fillStyle='rgb(212,222,192)';g.fillRect(0,0,N,N);
  const wrap=(draw,x,y,r)=>{for(const dx of [-N,0,N])for(const dy of [-N,0,N])if(x+dx>-r&&x+dx<N+r&&y+dy>-r&&y+dy<N+r)draw(x+dx,y+dy);};
  g.lineCap='round';
  for(let i=0;i<3000;i++){
    const x=rnd()*N,y=rnd()*N,len=6+rnd()*9,lean=(rnd()-.5)*.9,t=rnd(),w=1.8+rnd()*1.8;
    const col=t<.5?`rgba(${122+t*70|0},${158+t*50|0},${98+t*40|0},.56)`:`rgba(${230+t*20|0},${240+t*12|0},${192+t*20|0},.5)`;
    wrap((px,py)=>{g.strokeStyle=col;g.lineWidth=w;g.beginPath();g.moveTo(px,py);g.quadraticCurveTo(px+lean*len*.3,py-len*.6,px+lean*len,py-len);g.stroke();},x,y,20);
  }
  const px=g.getImageData(0,0,N,N).data,lin=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;},sum=[0,0,0];
  for(let i=0;i<px.length;i+=4)for(let k=0;k<3;k++)sum[k]+=lin(px[i+k]);
  const tex=new T.CanvasTexture(c);tex.wrapS=tex.wrapT=T.RepeatWrapping;tex.colorSpace=T.SRGBColorSpace;tex.anisotropy=anisotropy;tex.minFilter=T.LinearMipmapLinearFilter;
  tex.userData.mean=new T.Vector3(...sum.map(s=>s/(N*N)*1.2));
  return tex;
}

/** 64x64 tileable value noise, smooth, two independent channels (green and alpha, 8 and 6 cells per tile; red and blue
 *  stay 0), stretched to 0..1. */
let noise=null;
function noiseTexture(){
  if(noise)return noise;
  const N=64,data=new Uint8Array(N*N*4),s=t=>t*t*(3-2*t),rnd=rand(4242);
  [[8,1],[6,3]].forEach(([cells,ch])=>{
    const lat=Array.from({length:cells*cells},rnd),val=new Float32Array(N*N);
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      const fx=x/N*cells,fy=y/N*cells,i=Math.floor(fx),j=Math.floor(fy),u=s(fx-i),v=s(fy-j),at=(a,b)=>lat[(b%cells)*cells+(a%cells)];
      val[y*N+x]=(at(i,j)*(1-u)+at(i+1,j)*u)*(1-v)+(at(i,j+1)*(1-u)+at(i+1,j+1)*u)*v;
    }
    let lo=Infinity,hi=-Infinity;for(const v of val){lo=Math.min(lo,v);hi=Math.max(hi,v);}
    for(let k=0;k<N*N;k++)data[k*4+ch]=Math.round((val[k]-lo)/(hi-lo)*255);
  });
  noise=new T.DataTexture(data,N,N,T.RGBAFormat);noise.wrapS=noise.wrapT=T.RepeatWrapping;noise.magFilter=T.LinearFilter;noise.minFilter=T.LinearMipmapLinearFilter;
  noise.generateMipmaps=true;noise.colorSpace=T.NoColorSpace;noise.needsUpdate=true;return noise;
}

/** Shared uniforms: the wind clock and strength (world-art.js; town.js holds both at 0 under reduced motion), the noise
 *  for the fine mottle, and the detail's mean colour. */
export const field={uNoise:{value:null},uTexMean:{value:new T.Vector3(1,1,1)},uFocus:{value:new T.Vector3(0,0,1e9)}};
const uniforms=shader=>{field.uNoise.value=noiseTexture();Object.assign(shader.uniforms,wind,field);};

// GLSL shared by the ground and the grass. The large tones (three greens, sun-dried and lush patches) are in the vertex
// colours (meadow.js colourAt), where they cost nothing a frame. mottle: small lighter and darker clumps, a metre or
// two across, from one fetch of the 64x64 noise. windBand: 0..1, soft bright crests rolling downwind (WIND_DIR) at about
// 5.5 m/s, wavy, and in gusts that travel with them; arithmetic only (no fetch), so the land works it out per vertex
// and every clump at its root. Scaled by the weather's wind, capped so a storm does not blow the field white; zero
// under reduced motion (uStrength 0).
const GLSL=`uniform sampler2D uNoise;uniform float uTime,uStrength;uniform vec3 uTexMean,uFocus;
const vec2 WIND_DIR=vec2(.8,.6);
float mottle(vec2 p){vec4 c=texture2D(uNoise,mat2(.6,-.8,.8,.6)*p*(1./19.)+.7);return .86+.28*(c.a*.6+c.g*.4);}
float windBand(vec2 p){
  float along=dot(p,WIND_DIR),across=dot(p,vec2(-WIND_DIR.y,WIND_DIR.x));
  float crest=.5+.5*sin(along*.21-uTime*1.15+sin(across*.083)*1.7+sin(across*.029-along*.013)*2.3);
  float gust=.5+.5*sin(along*.043-uTime*.235+sin(across*.051)*1.4)*sin(across*.019+along*.007+uTime*.04+1.3);
  return crest*crest*crest*smoothstep(.35,.85,gust)*min(uStrength,1.2);
}`;
const BAND=.2;// how much a wind band brightens the ground and the grass

/** Turns the meadow ground material (vertex colours x painted detail, weighted by vertex attribute grassW) into the
 *  field. Low pays nothing for the field itself: its tones are in the vertex colours and its anti-tiling in the uv
 *  (meadow.js), and its wind bands are worked out per vertex. With define GRASS_FINE (Medium and High,
 *  meadow.setDetail) each pixel adds one noise fetch for a finer mottle. Every new term is weighted by grassW, so sand, banks and the riverbed stay as they were. */
export function fieldGround(material){
  material.map.userData.mean&&field.uTexMean.value.copy(material.map.userData.mean);
  material.onBeforeCompile=shader=>{
    uniforms(shader);
    shader.vertexShader='attribute float grassW;varying float vGrassW,vGBand;'+NL+GLSL+NL+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>'+NL+'vGrassW=grassW;vGBand=windBand(position.xz);');
    shader.fragmentShader='varying float vGrassW,vGBand;'+NL+GLSL+NL+shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
      vec3 gd=texture2D(map,vMapUv).rgb*(1.2+${(1.2*BAND).toFixed(3)}*vGBand);
      #ifdef GRASS_FINE
      gd*=mottle(vMapUv*${GRASS_TILE.toFixed(2)});
      #endif
      diffuseColor.rgb*=mix(vec3(1.),gd,vGrassW);
      #endif`);
  };
  material.customProgramCacheKey=()=>'meadow-ground';
  return material;
}

/** Anti-tiling for the painted detail: its uv at world (x,z), gently warped by smooth noise (up to about 0.8 m, over
 *  features of 6-20 m), so the 3.2 m repeat never lines up. Worked out per vertex when the land is built. */
export function grassUv(x,z,noise2,out,k){
  out[k]=x/GRASS_TILE+(noise2(x*.05,z*.05,311)+noise2(x*.16,z*.16,313)*.5)*.17;
  out[k+1]=z/GRASS_TILE+(noise2(x*.05,z*.05,312)+noise2(x*.16,z*.16,314)*.5)*.17;
}

/**
 * The grass clump material. Colour: the instance colour is the ground colour under the clump (its root, meadow.js
 * colourAt, with the field's tones); x the painted detail's mean and the wind band there. The root sits a shade darker
 * and cooler than the ground around it (the shade between blades) and the tip is clearly lighter and warmer, so clumps
 * read as grass from the phone's height, not as specks. Motion: clumps lean downwind (WIND_DIR, in world space whatever the
 * clump's own turn) with a gentle sway plus the wind band passing over them, so the bright bands on the ground and the
 * motion agree.
 * fade: the fine blades, which shrink away between 55% and 100% of uFocus.z metres from uFocus.xy (the view's centre).
 */
const grassMaterials=new Map(),grassLook={color:new T.Color(1,1,1),emissive:new T.Color(0,0,0)};
export function grassMaterial({fade=false}={}){
  if(grassMaterials.has(fade))return grassMaterials.get(fade);
  const m=new T.MeshStandardMaterial({vertexColors:true,roughness:.95});m.color.copy(grassLook.color);m.emissive.copy(grassLook.emissive);
  m.onBeforeCompile=shader=>{
    uniforms(shader);
    shader.vertexShader=GLSL+NL+shader.vertexShader.replace('#include <color_vertex>',`vColor=vec4(1.);
      vec3 gAt=vec3(0.);
      #ifdef USE_INSTANCING
      gAt=instanceMatrix[3].xyz;
      #endif
      float gBand=windBand(gAt.xz);vec3 gRoot=uTexMean*(1.+${BAND}*gBand);
      #ifdef USE_INSTANCING_COLOR
      gRoot*=instanceColor.rgb;
      #endif
      vColor.rgb=mix(gRoot*vec3(.72,.8,.76),gRoot*vec3(1.42,1.36,.92)+vec3(.07,.06,0.),smoothstep(0.,.42,position.y));`).replace('#include <begin_vertex>',`#include <begin_vertex>
      ${fade?'transformed*=1.-smoothstep(uFocus.z*.55,uFocus.z,distance(gAt.xz,uFocus.xy));':''}
      float gSway=(sin(uTime*1.6+gAt.x*.31+gAt.z*.23)*.22+.18+gBand*1.3)*uStrength*.85;
      vec3 gLean=vec3(WIND_DIR.x,0.,WIND_DIR.y);
      #ifdef USE_INSTANCING
      gLean=(vec4(gLean,0.)*instanceMatrix).xyz/max(1e-4,dot(instanceMatrix[0].xyz,instanceMatrix[0].xyz));
      #endif
      transformed+=gLean*gSway*position.y*position.y;`);
  };
  m.customProgramCacheKey=()=>'meadow-grass-'+fade;
  grassMaterials.set(fade,m);return m;
}
/** The grass follows the ground's light: the time of day's terrain colour, a fifth of the way back to white so clumps
 *  still catch a little moonlight at night (by day it is white anyway), and the snow's glow (meadow.js setTint/setSnow). */
const WHITE=new T.Color(1,1,1);
export function setGrassLook({color,emissive}){
  if(color)grassLook.color.copy(color).lerp(WHITE,.2);if(emissive)grassLook.emissive.copy(emissive);
  for(const m of grassMaterials.values()){m.color.copy(grassLook.color);m.emissive.copy(grassLook.emissive);}
}

/** Fine blades for Medium and High: a clump of six thin bent blades (two segments each, 18 triangles a side, 30 vertices),
 *  normals up so a clump takes the light like the ground. About 0.45 m tall, and within 0.21 m of its centre at scale 1
 *  (vegetation.js TUFT_RADIUS keeps 0.24 m clear). */
let blades=null;
export function bladeGeometry(){
  if(blades)return blades;
  const pos=[],index=[],rnd=rand(99);
  for(let n=0;n<6;n++){
    const a=n*1.047+rnd()*.6,r=.02+rnd()*.06,h=.32+rnd()*.22,lean=.05+rnd()*.08,w=.03+rnd()*.016,c=Math.cos(a),s=Math.sin(a),bx=c*r,bz=s*r,k=pos.length/3,px=-s,pz=c;
    // Base pair, mid pair (narrower, a third of the lean), tip.
    pos.push(bx-px*w,0,bz-pz*w, bx+px*w,0,bz+pz*w, bx+c*lean*.35-px*w*.7,h*.55,bz+s*lean*.35-pz*w*.7, bx+c*lean*.35+px*w*.7,h*.55,bz+s*lean*.35+pz*w*.7, bx+c*lean,h,bz+s*lean);
    index.push(k,k+1,k+2, k+1,k+3,k+2, k+2,k+3,k+4);
  }
  // Both faces, by repeating each triangle with the reverse winding (a double-sided material would light the back dark).
  const back=index.map((_,i)=>index[i-i%3+2-i%3]);
  blades=new T.BufferGeometry();blades.setAttribute('position',new T.Float32BufferAttribute(pos,3));
  blades.setAttribute('normal',new T.Float32BufferAttribute(pos.map((_,i)=>i%3===1?1:0),3));blades.setAttribute('color',new T.Float32BufferAttribute(pos.map(()=>1),3));
  blades.setIndex([...index,...back]);return blades;
}

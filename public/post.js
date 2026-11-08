// Post stack for the Medium and High graphics tiers (quality.js); Low draws straight to the screen and never builds it.
// Medium: the scene into a half-float target (MSAA x2 on computers, x4 on High; phones use FXAA at the end instead, the multisample
// resolve is bandwidth-heavy there), one finishing pass (tilt-shift, grade, vignette), then the output pass (tone
// mapping and sRGB). High adds GTAO at half resolution and bloom (its own mips start at half) before the finish;
// bloom's threshold sits well above 1, so only HDR emissives (night windows, lanterns, crystals) glow.
import * as T from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {Pass,FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {CopyShader} from 'three/addons/shaders/CopyShader.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {FXAAPass} from 'three/addons/postprocessing/FXAAPass.js';
import {GTAOPass} from 'three/addons/postprocessing/GTAOPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';

// Tilt-shift (D-V2, subtle): a disc blur whose radius grows with distance from the horizontal focus band, 0 inside it.
// Grade: a touch more saturation and contrast in linear light, cool shadows and warm highlights. Vignette: soft corners.
const FINISH={
  uniforms:{tDiffuse:{value:null},uTexel:{value:new T.Vector2(1,1)},uAspect:{value:1},uBand:{value:.2},uBlur:{value:2.4},uVignette:{value:.2},uSaturation:{value:1.06},uContrast:{value:1.05}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:`uniform sampler2D tDiffuse;uniform vec2 uTexel;uniform float uAspect,uBand,uBlur,uVignette,uSaturation,uContrast;varying vec2 vUv;
void main(){
  vec4 base=texture2D(tDiffuse,vUv);vec3 c=base.rgb;
  float r=uBlur*smoothstep(uBand,uBand+.32,abs(vUv.y-.5));
  if(r>.15){vec3 sum=c;for(int i=0;i<12;i++){float a=float(i)*2.39996,d=sqrt((float(i)+.5)/12.);sum+=textureLod(tDiffuse,vUv+vec2(cos(a),sin(a))*d*r*uTexel,0.).rgb;}c=sum/13.;}
  float l=dot(c,vec3(.2126,.7152,.0722));
  c=max(mix(vec3(l),c,uSaturation),0.);
  c=.18*pow(c/.18,vec3(uContrast));
  c*=mix(vec3(.985,.995,1.03),vec3(1.03,1.,.965),smoothstep(.02,.6,l));
  vec2 v=(vUv-.5)*vec2(uAspect,1.);c*=1.-uVignette*smoothstep(.35,.95,length(v));
  gl_FragColor=vec4(c,base.a);
}`};

// The scene pass: draws into its own target (MSAA x4 on computers) and copies the resolved image into the composer's read
// buffer. RenderPass would draw straight into whichever composer buffer reads first, and that alternates every frame when a
// tier has an odd number of swapping passes (High), so a multisampled composer buffer gave anti-aliasing on half the frames.
class ScenePass extends Pass{
  constructor(scene,camera,samples){super();this.needsSwap=false;this.scene=scene;this.camera=camera;
    this.target=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,samples});
    this.copy=new FullScreenQuad(new T.ShaderMaterial({uniforms:T.UniformsUtils.clone(CopyShader.uniforms),vertexShader:CopyShader.vertexShader,fragmentShader:CopyShader.fragmentShader,depthTest:false,depthWrite:false}));}
  setSize(w,h){this.target.setSize(w,h);}
  render(renderer,writeBuffer,readBuffer){
    renderer.setRenderTarget(this.target);renderer.clear();renderer.render(this.scene,this.camera);
    this.copy.material.uniforms.tDiffuse.value=this.target.texture;renderer.setRenderTarget(this.renderToScreen?null:readBuffer);this.copy.render(renderer);}
  dispose(){this.target.dispose();this.copy.material.dispose();this.copy.dispose();}
}

export function createPost(renderer,scene,camera,{tier,mobile}){
  const composer=new EffectComposer(renderer,new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType}));
  // MSAA on computers: x2 on Medium (58.7 fps against 50.1 at x4 and 67.6 with none, default view, 1280x800 at pixel ratio
  // 1.25, 22-cat test town, MEASURED), x4 on High.
  const scenePass=new ScenePass(scene,camera,mobile?0:tier==='high'?4:2);composer.addPass(scenePass);
  const half=[];
  if(tier==='high'&&!mobile){
    const ao=new GTAOPass(scene,camera,1,1);ao.blendIntensity=.75;composer.addPass(ao);half.push(ao);
    // GTAO's normal pass draws every mesh with one plain material, so anything placed or sized in its own vertex shader (the
    // sky quad, smoke puffs, lamp halos, sprites) would land there at its raw size and leave dark rings. All of them are
    // transparent effects that write no depth in the main pass either, so they sit the AO pass out.
    const aoRender=ao.render.bind(ao),skip=[];
    ao.render=(...args)=>{
      scene.traverseVisible(o=>{const m=o.material;if(o===scene.userData.sky||o.isSprite||(m&&!Array.isArray(m)&&m.transparent&&!m.depthWrite))skip.push(o);});
      for(const o of skip)o.visible=false;aoRender(...args);for(const o of skip)o.visible=true;skip.length=0;};
    // UnrealBloomPass already works from half the size it is given (its first mip), so it gets the full size.
    // Threshold 1.6 (scene values before exposure): the night glass (glow 3.2) blooms; lamp pools on the paving (about
    // 1, additive over the lit ground) do not, at 1.05 they flared into orange discs.
    composer.addPass(new UnrealBloomPass(new T.Vector2(1,1),.45,.3,1.6));
  }
  const finish=new ShaderPass(FINISH);composer.addPass(finish);composer.addPass(new OutputPass());
  if(mobile)composer.addPass(new FXAAPass());
  // GTAO (its normal, depth and AO targets) runs at half the composer's size; its blend samples it back up.
  for(const p of half){const set=p.setSize.bind(p);p.setSize=(w,h)=>set(Math.max(1,w>>1),Math.max(1,h>>1));}
  let ratio=0,w=0,h=0;
  return {
    target:scenePass.target,
    /** Draws a frame; follows the renderer's pixel ratio and the canvas size (perf probes pin the ratio on the renderer). */
    render(width,height){
      const pr=renderer.getPixelRatio();
      if(pr!==ratio||width!==w||height!==h){ratio=pr;w=width;h=height;composer.setPixelRatio(pr);composer.setSize(w,h);finish.uniforms.uTexel.value.set(1/(w*pr),1/(h*pr));finish.uniforms.uAspect.value=w/h;}
      composer.render();
    },
    dispose(){for(const p of composer.passes)p.dispose?.();composer.dispose();},
  };
}

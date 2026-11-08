// Adapt licensed Mixamo source motion to the short limbs of this specific game.
// Usage: node scripts/bake-mixamo.mjs <walk.fbx> <talk.fbx> <work.fbx>
import {readFileSync,writeFileSync} from 'node:fs';
import * as T from 'three';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
const inputs=process.argv.slice(2);if(inputs.length!==3)throw Error('Supply walk, talk and work FBX files.');
const output={source:'Adobe Mixamo; adapted for Cat Town short-limb rigs',clips:{}};
const clamp=T.MathUtils.clamp;
for(const [index,mode] of ['walk','talk','work'].entries()){
  const bytes=readFileSync(inputs[index]),rig=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  const clip=rig.animations[0];if(!clip)throw Error('No animation in '+inputs[index]);
  const bones={};rig.traverse(o=>{if(o.isBone)bones[o.name.replace(/^mixamorig:?/,'')]=o;});
  for(const name of ['Hips','Spine2','LeftArm','RightArm','LeftHand','RightHand','LeftUpLeg','RightUpLeg','LeftLeg','RightLeg','LeftFoot','RightFoot'])if(!bones[name])throw Error('Missing '+name);
  rig.updateMatrixWorld(true);const height=bones.Hips.getWorldPosition(new T.Vector3()).y;
  const mixer=new T.AnimationMixer(rig);mixer.clipAction(clip).setLoop(T.LoopOnce,1).play();const count=Math.ceil(clip.duration*30),frames=[];
  const pos=name=>bones[name].getWorldPosition(new T.Vector3());
  for(let i=0;i<=count;i++){
    mixer.setTime(i/count*clip.duration);rig.updateMatrixWorld(true);const inverse=bones.Hips.getWorldQuaternion(new T.Quaternion()).invert();
    const angles=(a,b)=>{const d=pos(b).sub(pos(a)).applyQuaternion(inverse).normalize();return [clamp(Math.atan2(-d.z,-d.y)*.65,-1,1),clamp(Math.atan2(d.x,Math.hypot(d.y,d.z))*.5,-.65,.65)];};
    const left=angles('LeftArm','LeftHand'),right=angles('RightArm','RightHand'),lf=angles('LeftUpLeg','LeftLeg'),rf=angles('RightUpLeg','RightLeg');
    const spine=new T.Euler().setFromQuaternion(bones.Spine2.quaternion);
    frames.push([...left,...right,lf[0],rf[0],pos('LeftFoot').y/height,pos('RightFoot').y/height,clamp(spine.x*.3,-.12,.12),clamp(spine.y*.3,-.12,.12),clamp(spine.z*.3,-.12,.12),pos('Hips').y/height]);
  }
  const floors=[6,7,11].map(n=>Math.min(...frames.map(f=>f[n])));
  for(const frame of frames){for(const [i,n] of [6,7,11].entries())frame[n]=clamp((frame[n]-floors[i])*1.1,0,n===11?.06:.14);for(let n=0;n<frame.length;n++)frame[n]=Number(frame[n].toFixed(5));}
  // Ease the final samples back to the opening pose for a continuous game loop.
  const seam=Math.min(5,Math.floor(frames.length/4));for(let i=0;i<seam;i++){const f=frames[frames.length-seam+i],t=(i+1)/seam;f.forEach((v,n)=>f[n]=Number((v+(frames[0][n]-v)*t).toFixed(5)));}
  output.clips[mode]={duration:clip.duration,frames};
}
writeFileSync(new URL('../public/assets/cat-motions.json',import.meta.url),JSON.stringify(output));
console.log('Baked downloaded Mixamo motion into the Cat Town animation asset.');

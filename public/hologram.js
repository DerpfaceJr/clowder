import * as T from 'three';
import {oneLiner} from './one-liner.js';

// Hologram palette, shared by the reaction icons and the talk bubbles: a dark teal glass plate under a cyan glow edge,
// with near-white text, so the glyphs read against grass, roofs and the night sky alike.
const GLOW='#8df5ed',EDGE='#acf9ee',PLATE='rgba(8,36,52,.86)',INK='#f1fffc';

// Texture pixels per CSS pixel: the device pixel ratio, at least 2 (sprites land on sub-pixel positions) and at most 3.
// Textures are linear-filtered with no mipmaps: text drawn near 1:1 only gets blurrier from a mip chain.
export const TEXT_SCALE_MAX=3;
export const textScale=(dpr=globalThis.devicePixelRatio||1)=>Math.min(TEXT_SCALE_MAX,Math.max(2,dpr));
export const textCanvasSize=(width,height,scale)=>({width:Math.ceil(width*scale),height:Math.ceil(height*scale)});
function holoCanvas(width,height,scale){
  const canvas=document.createElement('canvas');Object.assign(canvas,textCanvasSize(width,height,scale));
  const ctx=canvas.getContext('2d');ctx.scale(scale,scale);return {canvas,ctx};
}
function holoTexture(canvas){
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
  texture.generateMipmaps=false;texture.minFilter=texture.magFilter=T.LinearFilter;texture.userData.cached=true;return texture;
}

// Talk bubble, drawn in on-screen CSS px: fitBubble sizes the sprite to exactly BUBBLE_PX tall, so FONT_PX is the real
// on-screen text size (it was about 12 px before).
export const FONT_PX=14;
const FONT=`600 ${FONT_PX}px system-ui,sans-serif`,PAD=10,BODY=26,TAIL=6,MARGIN=7;
export const BUBBLE_PX=BODY+TAIL+2*MARGIN;
// One texture per line of text and scale, most recently used last. An evicted texture that a live sprite still shows
// is uploaded again on its next draw, so eviction can never blank a bubble.
const bubbles=new Map(),BUBBLE_CACHE=24;
export function bubbleTexture(line,scale=textScale()){
  const key=scale+'|'+line,hit=bubbles.get(key);
  if(hit){bubbles.delete(key);bubbles.set(key,hit);return hit;}
  const probe=document.createElement('canvas').getContext('2d');probe.font=FONT;
  const width=Math.ceil(probe.measureText(line).width)+2*PAD+2*MARGIN,height=BUBBLE_PX,mid=width/2;
  const {canvas,ctx}=holoCanvas(width,height,scale);ctx.font=FONT;
  ctx.shadowColor=GLOW;ctx.shadowBlur=7;ctx.fillStyle=PLATE;ctx.strokeStyle=EDGE;ctx.lineWidth=1.5;
  ctx.beginPath();ctx.roundRect(MARGIN,MARGIN,width-2*MARGIN,BODY,10);ctx.moveTo(mid-5,MARGIN+BODY);ctx.lineTo(mid,MARGIN+BODY+TAIL);ctx.lineTo(mid+5,MARGIN+BODY);ctx.fill();ctx.stroke();
  ctx.shadowColor='rgba(141,245,237,.55)';ctx.shadowBlur=3;ctx.fillStyle=INK;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(line,mid,MARGIN+BODY/2+1);
  const entry={texture:holoTexture(canvas),aspect:width/height};bubbles.set(key,entry);
  if(bubbles.size>BUBBLE_CACHE){const [oldest,old]=bubbles.entries().next().value;bubbles.delete(oldest);old.texture.dispose();}
  return entry;
}
export function speechBubble(text){
  const line=oneLiner(text,28);if(!line)return null;
  const {texture,aspect}=bubbleTexture(line);
  const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,transparent:true,depthWrite:false}));
  sprite.center.set(.5,0);sprite.userData.aspect=aspect;
  return sprite;
}

// Reaction icons ('z' is the sleep glyph): one texture per kind and scale, shared by every cat. Drawn in a 128-unit
// square at the icon's largest on-screen size. A cat's icon is ICON_WORLD metres across, clamped on screen between
// ICON_MIN_PX (so the glyph stays about 11 px zoomed out) and ICON_MAX_PX (so it never swamps a close-up).
export const ICON_WORLD=1.35,ICON_MIN_PX=24,ICON_MAX_PX=120;
export const iconPx=ppm=>Math.min(ICON_MAX_PX,Math.max(ICON_MIN_PX,ICON_WORLD*ppm));
const GLYPHS={talk:'···',work:'⚙',question:'?',idea:'✦',review:'!',mail:'✉',alert:'!'},icons=new Map();
export function iconTexture(kind,scale=textScale()){
  const key=kind+'|'+scale;if(icons.has(key))return icons.get(key);
  const {canvas,ctx}=holoCanvas(ICON_MAX_PX,ICON_MAX_PX,scale);ctx.scale(ICON_MAX_PX/128,ICON_MAX_PX/128);
  ctx.textAlign='center';ctx.textBaseline='middle';
  if(kind==='z'){ctx.shadowColor=GLOW;ctx.shadowBlur=12;ctx.fillStyle='#ddfff6';ctx.strokeStyle='rgba(35,91,115,.8)';ctx.lineWidth=6;ctx.font='bold 96px Georgia';ctx.strokeText('z',64,60);ctx.fillText('z',64,60);}
  else{
    // 'alert' (a quest needs the owner) is amber so it stands out from the town's cyan holograms.
    const alert=kind==='alert';
    ctx.shadowColor=alert?'#ffb347':GLOW;ctx.shadowBlur=alert?18:12;ctx.fillStyle=alert?'rgba(110,48,6,.9)':PLATE;ctx.strokeStyle=alert?'#ffd27a':EDGE;ctx.lineWidth=alert?4:3;
    ctx.beginPath();ctx.roundRect(14,12,100,86,22);ctx.moveTo(53,98);ctx.lineTo(64,112);ctx.lineTo(75,98);ctx.fill();ctx.stroke();
    ctx.shadowColor=alert?'rgba(255,190,90,.8)':'rgba(141,245,237,.7)';ctx.shadowBlur=5;ctx.fillStyle=alert?'#fff4dc':INK;ctx.font='bold 62px Georgia,serif';ctx.fillText(GLYPHS[kind]||'✦',64,57);
  }
  const texture=holoTexture(canvas);icons.set(key,texture);return texture;
}

// Screen rects here are centred boxes {x,y,width,height} in CSS px. Moves rect straight up until it clears every box
// by gap px, and returns its new centre y. It only ever moves up, so a name label ends above a hologram stack, never
// under it; each box can push it at most once, so boxes.length+1 passes always settle.
export function liftClear(rect,boxes,gap=4){
  let y=rect.y;
  for(let pass=0;pass<=boxes.length;pass++){
    const hit=boxes.find(b=>Math.abs(b.x-rect.x)<(b.width+rect.width)/2+gap&&Math.abs(b.y-y)<(b.height+rect.height)/2+gap);
    if(!hit)break;y=hit.y-(hit.height+rect.height)/2-gap-1e-6;// the hair keeps rounding from re-hitting the same box
  }
  return y;
}
// Smallest centred box holding all the given boxes.
export function unionBox(boxes){
  const l=Math.min(...boxes.map(b=>b.x-b.width/2)),r=Math.max(...boxes.map(b=>b.x+b.width/2)),t=Math.min(...boxes.map(b=>b.y-b.height/2)),btm=Math.max(...boxes.map(b=>b.y+b.height/2));
  return {x:(l+r)/2,y:(t+btm)/2,width:r-l,height:btm-t};
}

// Orthographic camera only: world units per CSS pixel are (frustum height / zoom) / viewport height.
// Call every frame so zoom, camera distance and resizes keep the bubble at heightPx on screen.
export function fitBubble(sprite,camera,viewportHeight,heightPx=BUBBLE_PX){
  if(!viewportHeight)return;
  const height=heightPx*(camera.top-camera.bottom)/camera.zoom/viewportHeight;
  sprite.scale.set(height*sprite.userData.aspect,height,1);
}

// Cached hologram textures stay alive for the next sprite that shows the same text; other maps are freed with the sprite.
export function disposeSprite(sprite){
  sprite.removeFromParent();if(!sprite.material.map?.userData.cached)sprite.material.map?.dispose();sprite.material.dispose();
}

/** Name plate for a headstone. Same canvas-sprite approach as the speech bubbles, sized with fitBubble. */
export function nameplate(text){
  const FONT='600 24px system-ui,sans-serif',PAD=12,HEIGHT=34,MARGIN=4;
  const label=String(text||'').slice(0,40)||'Unnamed';
  const probe=document.createElement('canvas').getContext('2d');probe.font=FONT;
  const width=Math.ceil(probe.measureText(label).width)+2*PAD+2*MARGIN,height=HEIGHT+2*MARGIN;
  const canvas=document.createElement('canvas');canvas.width=width*2;canvas.height=height*2;
  const ctx=canvas.getContext('2d');ctx.scale(2,2);ctx.font=FONT;
  ctx.fillStyle='rgba(54,62,52,.78)';ctx.strokeStyle='#e7dcc0';ctx.lineWidth=2;
  ctx.beginPath();ctx.roundRect(MARGIN,MARGIN,width-2*MARGIN,HEIGHT,12);ctx.fill();ctx.stroke();
  ctx.fillStyle='#f6eedb';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,width/2,MARGIN+HEIGHT/2+1);
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
  const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,transparent:true,depthWrite:false}));
  sprite.center.set(.5,0);sprite.userData.aspect=width/height;return sprite;
}

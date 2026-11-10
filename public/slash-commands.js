// Slash commands and @mentions in the chat composer (plan 8.7). Typing "/" lists the composer's built-in commands first (/goal,
// /ask, /pause, /resume, /stop: chat-composer.js), then the enabled plugins' commands from GET /api/plugins/commands, cached for
// 30 s; a failed read lists the built-ins only. Typing "@" at the start lists the other cats. The list is a popover above the
// text box. The matchers are pure and exported for tests.
import {el} from './projects-panel.js';

export const COMMANDS_TTL_MS=30_000,SLASH_SHOWN=8;

// Only "/" plus one word matches: a space ends the command, and the list closes. Names that start with the typed text rank first,
// then names that contain it. A name shared by two plugins inserts as plugin:name.
// 0: the name starts with the typed text; 1: plugin:name does; 2: either contains it; -1: no match.
const matchRank=(q,short,full)=>{
  if(!q||short.startsWith(q))return 0;
  if(full.startsWith(q))return 1;
  return short.includes(q)||full.includes(q)?2:-1;
};

// builtins: the composer's own commands ({name, description, argumentHint}), listed first in their own order. A plugin command
// with a built-in's name inserts as plugin:name, because the bare name runs the built-in. At most SLASH_SHOWN plugin rows.
export function slashMatches(commands,text,{builtins=[]}={}){
  const typed=String(text??'');
  if(!/^\/\S*$/.test(typed))return [];
  const q=typed.slice(1).toLowerCase(),all=Array.isArray(commands)?commands:[],own=Array.isArray(builtins)?builtins:[];
  const first=own.flatMap((c,i)=>{
    const name=String(c?.name??''),rank=matchRank(q,name.toLowerCase(),name.toLowerCase());
    return name&&rank>=0?[{rank,i,row:{rank,builtin:true,name,plugin:'',label:name,description:String(c.description??''),argumentHint:String(c.argumentHint??''),insert:`/${name} `}}]:[];
  }).sort((a,b)=>a.rank-b.rank||a.i-b.i).map(r=>r.row);
  const counts=new Map(own.map(c=>[c?.name,1]));
  for(const c of all)counts.set(c?.name,(counts.get(c?.name)??0)+1);
  const plugins=all.flatMap(c=>{
    const name=String(c?.name??''),plugin=String(c?.plugin??''),short=name.toLowerCase(),full=`${plugin}:${name}`.toLowerCase();
    const rank=matchRank(q,short,full);
    if(!name||rank<0)return [];
    const qualified=counts.get(c.name)>1&&plugin!=='';
    const label=qualified?`${plugin}:${name}`:name;
    return [{rank,name,plugin,label,description:String(c.description??''),argumentHint:String(c.argumentHint??''),insert:`/${label} `}];
  }).sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name)||a.plugin.localeCompare(b.plugin)).slice(0,SLASH_SHOWN);
  return [...first,...plugins];
}

// "@" plus one word lists the cats whose name starts with it, then whose id does, then whose name contains it. exclude: the
// open cat, which needs no mention. Choosing one inserts "@Name ", and the composer sends the rest to that cat.
export function mentionMatches(cats,text,{exclude=null}={}){
  const typed=String(text??'');
  if(!/^[@＠]\S*$/.test(typed))return [];
  const q=typed.slice(1).toLowerCase();
  return (Array.isArray(cats)?cats:[]).flatMap(c=>{
    const id=String(c?.id??''),name=String(c?.name||id),low=name.toLowerCase();
    if(!id||id===exclude)return [];
    const rank=!q||low.startsWith(q)?0:id.toLowerCase().startsWith(q)?1:low.includes(q)?2:-1;
    return rank<0?[]:[{rank,kind:'cat',id,name,label:name,description:String(c.role??''),insert:`@${name} `}];
  }).sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name)).slice(0,SLASH_SHOWN);
}

export const stepIndex=(index,delta,count)=>count?(index+delta+count)%count:0;

// Mounts the list before the composer's text box. The owner's keydown handler calls onKey first; true means the key was the list's.
// builtins(): the built-in commands to offer now. cats(): {cats, exclude} for "@", or leave it out for no mentions.
export function mountSlashList(textarea,{fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),builtins=()=>[],cats=null}={}){
  const panel=el('ul',{className:'slash-list',attrs:{id:'slash-list',role:'listbox','aria-label':'Commands',hidden:''}});
  textarea.before(panel);
  textarea.setAttribute('aria-autocomplete','list');
  textarea.setAttribute('aria-controls','slash-list');
  textarea.setAttribute('aria-expanded','false');
  let cache={at:-Infinity,commands:[]},rows=[],index=0,dismissed=false;
  const fresh=()=>now()-cache.at<COMMANDS_TTL_MS;

  async function commands(){
    if(fresh())return cache.commands;
    try{
      const response=await fetchImpl('/api/plugins/commands',{cache:'no-store'});
      const data=await response.json();
      cache={at:now(),commands:response.ok&&Array.isArray(data)?data:[]};
    }catch{cache={at:now(),commands:[]};}
    return cache.commands;
  }

  function paintRows(){
    const items=rows.map((row,i)=>el('li',{className:`slash-item${row.builtin?' is-builtin':''}${row.kind==='cat'?' mention-item':''}`,attrs:{id:`slash-opt-${i}`,role:'option','aria-selected':String(i===index)}},(row.kind==='cat'?[
      el('span',{className:'mention-name',text:`@${row.name}`}),
      row.description?el('span',{className:'slash-desc',text:row.description}):null,
    ]:[
      el('code',{className:'slash-name',text:`/${row.label}`}),
      row.argumentHint?el('span',{className:'slash-hint',text:row.argumentHint}):null,
      row.plugin||row.description?el('span',{className:'slash-desc',text:[row.plugin,row.description].filter(Boolean).join(' · ')}):null,
    ]).filter(Boolean)));
    items.forEach((node,i)=>{node.onmousedown=event=>event.preventDefault();node.onclick=()=>choose(i);});
    panel.replaceChildren(...items);
    panel.hidden=rows.length===0;
    textarea.setAttribute('aria-expanded',String(rows.length>0));
    if(rows.length)textarea.setAttribute('aria-activedescendant',`slash-opt-${index}`);
    else textarea.removeAttribute('aria-activedescendant');
  }

  // keep: the plugins' commands arrived for the same text, so the row the owner moved to stays picked.
  function show(found,label,keep=false){
    rows=found;index=keep&&index<found.length?index:0;
    panel.setAttribute('aria-label',label);
    paintRows();
  }

  function close(){rows=[];paintRows();}

  function choose(i){
    const row=rows[i];
    if(!row)return;
    textarea.value=row.insert;
    textarea.setSelectionRange(row.insert.length,row.insert.length);
    close();
    textarea.focus();
  }

  async function update(){
    const value=textarea.value;
    if(dismissed){close();return;}
    if(value.startsWith('/')){
      // The built-ins show at once; the plugins' commands join them when their read comes back.
      const waiting=!fresh();
      if(waiting)show(slashMatches([],value,{builtins:builtins()}),'Commands');
      const found=slashMatches(await commands(),value,{builtins:builtins()});
      if(textarea.value!==value)return;
      show(found,'Commands',waiting);
      return;
    }
    const mention=cats?.();
    if(mention&&/^[@＠]\S*$/.test(value)){show(mentionMatches(mention.cats,value,{exclude:mention.exclude}),'Cats');return;}
    close();
  }

  function onKey(event){
    if(panel.hidden||event.isComposing)return false;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){index=stepIndex(index,event.key==='ArrowDown'?1:-1,rows.length);paintRows();}
    else if((event.key==='Enter'||event.key==='Tab')&&!event.shiftKey)choose(index);
    else if(event.key==='Escape'){dismissed=true;close();event.stopPropagation();}
    else return false;
    event.preventDefault();
    return true;
  }

  textarea.addEventListener('input',()=>{dismissed=false;void update();});
  textarea.addEventListener('blur',close);
  textarea.form?.addEventListener('submit',close);
  return {onKey,close};
}

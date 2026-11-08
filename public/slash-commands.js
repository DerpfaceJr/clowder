// Slash commands in the chat composer. Typing "/" lists the enabled plugins' commands from GET /api/plugins/commands, cached for
// 30 s; a failed read shows nothing. The list sits in the form's flow above the text box. The matcher is pure and exported for tests.
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

export function slashMatches(commands,text){
  const typed=String(text??'');
  if(!/^\/\S*$/.test(typed))return [];
  const q=typed.slice(1).toLowerCase(),all=Array.isArray(commands)?commands:[];
  const counts=new Map();
  for(const c of all)counts.set(c?.name,(counts.get(c?.name)??0)+1);
  return all.flatMap(c=>{
    const name=String(c?.name??''),plugin=String(c?.plugin??''),short=name.toLowerCase(),full=`${plugin}:${name}`.toLowerCase();
    const rank=matchRank(q,short,full);
    if(!name||rank<0)return [];
    const qualified=counts.get(c.name)>1&&plugin!=='';
    const label=qualified?`${plugin}:${name}`:name;
    return [{rank,name,plugin,label,description:String(c.description??''),argumentHint:String(c.argumentHint??''),insert:`/${label} `}];
  }).sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name)||a.plugin.localeCompare(b.plugin)).slice(0,SLASH_SHOWN);
}

export const stepIndex=(index,delta,count)=>count?(index+delta+count)%count:0;

// Mounts the list before the composer's text box. The owner's keydown handler calls onKey first; true means the key was the list's.
export function mountSlashList(textarea,{fetchImpl=(...args)=>fetch(...args),now=()=>Date.now()}={}){
  const panel=el('ul',{className:'slash-list',attrs:{id:'slash-list',role:'listbox','aria-label':'Commands',hidden:''}});
  textarea.before(panel);
  textarea.setAttribute('aria-autocomplete','list');
  textarea.setAttribute('aria-controls','slash-list');
  textarea.setAttribute('aria-expanded','false');
  let cache={at:-Infinity,commands:[]},rows=[],index=0,dismissed=false;

  async function commands(){
    if(now()-cache.at<COMMANDS_TTL_MS)return cache.commands;
    try{
      const response=await fetchImpl('/api/plugins/commands',{cache:'no-store'});
      const data=await response.json();
      cache={at:now(),commands:response.ok&&Array.isArray(data)?data:[]};
    }catch{cache={at:now(),commands:[]};}
    return cache.commands;
  }

  function paintRows(){
    const items=rows.map((row,i)=>el('li',{className:'slash-item',attrs:{id:`slash-opt-${i}`,role:'option','aria-selected':String(i===index)}},[
      el('code',{className:'slash-name',text:`/${row.label}`}),
      row.argumentHint?el('span',{className:'slash-hint',text:row.argumentHint}):null,
      row.plugin||row.description?el('span',{className:'slash-desc',text:[row.plugin,row.description].filter(Boolean).join(' · ')}):null,
    ].filter(Boolean)));
    items.forEach((node,i)=>{node.onmousedown=event=>event.preventDefault();node.onclick=()=>choose(i);});
    panel.replaceChildren(...items);
    panel.hidden=rows.length===0;
    textarea.setAttribute('aria-expanded',String(rows.length>0));
    if(rows.length)textarea.setAttribute('aria-activedescendant',`slash-opt-${index}`);
    else textarea.removeAttribute('aria-activedescendant');
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
    if(dismissed||!value.startsWith('/')){close();return;}
    const found=slashMatches(await commands(),value);
    if(textarea.value!==value)return;
    rows=found;index=0;paintRows();
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

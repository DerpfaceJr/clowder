// Full ids in user text (task, goal and step summaries) read as the title of the thing they name. A known id becomes its title;
// an unknown id is dropped together with the separator before it, so "Filed owner step <id>" reads "Filed owner step" and
// "saved as artifact <id>" keeps the word "artifact". Output is segments, never HTML, so no caller parses markup.
// known: a Map or a plain object from id to {title, href?}. Ids are matched in lower case.
const ID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,SPACE=/\s/,SEP=/[:—–-]/;
const lookup=(known,id)=>known instanceof Map?known.get(id):(known&&Object.hasOwn(known,id)?known[id]:undefined);
// The separator before an id (" : ( "), scanned back no further than floor, and a closing ")" after it. Scans, not one
// regex, so a long run of spaces costs linear time instead of the backtracking a chain of \s* would.
function leadStart(s,end,floor){let i=end;const ws=()=>{while(i>floor&&SPACE.test(s[i-1]))i--;};ws();if(i>floor&&s[i-1]==='('){i--;ws();}if(i>floor&&SEP.test(s[i-1])){i--;ws();}return i;}
function tailEnd(s,start){let i=start;while(i<s.length&&SPACE.test(s[i]))i++;return s[i]===')'?i+1:start;}

export function humanizeIds(text,known={}){
  const s=String(text??''),out=[];let at=0;
  for(const m of s.matchAll(ID)){
    const from=leadStart(s,m.index,at),end=m.index+m[0].length,to=tailEnd(s,end),id=m[0].toLowerCase(),hit=lookup(known,id);
    if(from>at)out.push({text:s.slice(at,from)});
    if(hit?.title)out.push({text:s.slice(from,m.index)},{id,title:String(hit.title),...(hit.href?{href:hit.href}:{})},{text:s.slice(end,to)});
    at=to;
  }
  if(at<s.length)out.push({text:s.slice(at)});
  return out.filter(p=>p.id||p.text).reduce((a,p)=>{const last=a.at(-1);if(!p.id&&last&&!last.id)last.text+=p.text;else a.push({...p});return a;},[]);
}

export const humanizeText=(text,known)=>humanizeIds(text,known).map(p=>p.id?p.title:p.text).join('');

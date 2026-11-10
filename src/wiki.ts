// Visible wiki memory (product plan 3.7). Pages per person, project, topic and owner preference, journaled whole as
// wiki.saved (new pages, owner edits, merges), grown one note at a time by wiki.line, dropped by wiki.removed (memory.ts replays them for lookup and lessons; read-model.ts indexes them for search) and
// mirrored as Markdown files in the world's wiki/ folder for the owner to open. The organiser files remember notes into
// pages by the names their titles share; it never deletes a note and only flags near-duplicates for the owner.
import {existsSync,mkdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Event,Store} from './store.ts';
import {memoryFor,tokenize,wikiLines,type Wiki,type WikiKind,type WikiPage} from './memory.ts';

export const KINDS:WikiKind[]=['person','project','topic','preference'];
const SLUG=/^[a-z0-9][a-z0-9-]{0,59}$/;
export const slugify=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+/,'').slice(0,60).replace(/-+$/,'');
// Duplicate pairs above this word overlap are flagged. Calibrated on the owner's 717 notes (see the commit report).
export const DUPLICATE=0.6;
// Words that label a note rather than name a thing ("Round 6", "Fact:", "UTC 1 Nov").
const LABEL=new Set('round goal fact facts hypothesis decision note lesson update status the a an and of for to in on at by with from is are not no new step utc gmt am pm jan feb mar apr may jun jul aug sep oct nov dec monday tuesday wednesday thursday friday saturday sunday'.split(' '));
// Common words that never make a topic page on their own.
const COMMON=new Set('this that with from into when what which before after while than then them they their there have has been were will would should could must does done only also more most less each every other some about over under just still need needs ready used uses using make made work works first last next three without between because'.split(' '));

export const wikiOf=(store:Store):Wiki=>memoryFor(dirname(store.file),store.state.events,false).wiki;
const notesOf=(events:Event[])=>events.filter(e=>e.type==='memory.noted');
const noteLine=(e:Event)=>`- (${String(e.at).slice(0,10)}) ${String(e.data?.title??'').replace(/\s+/g,' ').trim()}: ${String(e.data?.text??'').replace(/\s+/g,' ').trim().slice(0,280)}`;
const words=(e:Event)=>new Set(tokenize(`${e.data?.title??''} ${e.data?.text??''}`));
export function overlap(a:Set<string>,b:Set<string>){let n=0;for(const t of a)if(b.has(t))n++;return n/((a.size+b.size-n)||1);}

/** The Markdown mirror. Frontmatter values are JSON, which YAML reads as flow scalars and sequences. */
function mirror(dir:string,p:WikiPage){
  const file=join(dir,'wiki',`${p.slug}.md`),temp=`${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file),{recursive:true});
  const head=[`title: ${JSON.stringify(p.title)}`,`kind: ${p.kind}`,`updated: ${p.updated}`,`by: ${p.by}`,`sources: ${JSON.stringify(p.sources)}`,...(p.owner.length?[`owner_lines: ${JSON.stringify(p.owner)}`]:[]),...(p.duplicates.length?[`duplicates: ${JSON.stringify(p.duplicates)}`]:[])];
  try{writeFileSync(temp,`---\n${head.join('\n')}\n---\n${p.body}\n`);renameSync(temp,file);}catch(err){rmSync(temp,{force:true});throw err;}
}
// Whole-page saves are for new pages, owner edits and merges only; a note joining a page is a wiki.line (organise).
function save(store:Store,page:Omit<WikiPage,'updated'>){
  const e=store.emit('wiki.saved',page);
  // The journal is the truth; a mirror that cannot be written (a locked file) is rewritten on the next organise.
  try{mirror(dirname(store.file),{...page,updated:e.at});}catch{/* mirror only */}
}

/** Names a note title gives: @handles, capitalised runs ("Daily Tower", "Reel 2") and cat names. A lone capital that starts
 *  a phrase counts only when the town writes it capitalised mid-sentence more often than in lower case ("Instagram", not "Check"). */
function namer(notes:Event[],cats:string[]){
  const bare=(w:string)=>w.replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu,'');
  const lower=new Map<string,number>(),capital=new Map<string,number>(),bump=(m:Map<string,number>,k:string)=>m.set(k,(m.get(k)??0)+1);
  for(const n of notes)for(const s of `${n.data?.title??''}. ${n.data?.text??''}`.split(/[.!?:;]\s+/))s.split(/\s+/).map(bare).forEach((w,i)=>{if(/^\p{Ll}/u.test(w))bump(lower,w);else if(i>0&&/^\p{Lu}/u.test(w))bump(capital,w.toLowerCase());});
  const people=new Set(cats.map(c=>c.toLowerCase()));
  return (title:string)=>{
    const out=new Map<string,{title:string;kind:WikiKind}>();
    for(const h of title.match(/@[A-Za-z0-9_.]*[A-Za-z0-9_]/g)??[])out.set(h.slice(1).toLowerCase(),{title:h,kind:'project'});
    for(const seg of title.split(/[:;,()[\]"“”!?|]+|\s[—–-]\s/)){
      let run:string[]=[],start=0;
      const flush=()=>{
        while(run.length&&LABEL.has(run[0].toLowerCase())){run.shift();start++;}
        while(run.length&&LABEL.has(run.at(-1)!.toLowerCase()))run.pop();
        const first=run[0]?.toLowerCase()??'',weak=start===0&&(capital.get(first)??0)<=(lower.get(first)??0);
        if(run.length===1&&weak)run=[];
        const add=(ws:string[])=>{const t=ws.slice(0,4).join(' '),k=t.toLowerCase();if(/^\p{L}/u.test(k)&&/\p{L}{2}/u.test(k)&&!out.has(k))out.set(k,{title:t,kind:people.has(k)?'person':'project'});};
        if(run.length)add(run);
        // "Three Instagram" also offers "Instagram" (sentence case capitalised "Three"); the counts across notes pick one.
        if(run.length>1&&weak)add(run.slice(1));
        run=[];
      };
      seg.split(/\s+/).map(bare).filter(Boolean).forEach((w,i)=>{
        const cap=/^\p{Lu}/u.test(w)&&!LABEL.has(w.toLowerCase()),num=run.length>0&&/^\d+[A-Za-z]?$/.test(w);
        if(cap||num){if(!run.length)start=i;run.push(w);}else flush();
      });
      flush();
    }
    return out;
  };
}

const PREFERENCE=/\bowner (prefers|likes|dislikes|wants)\b|\bpreferences?\b/i;
/**
 * Files every note not yet on a page (and not on a page the owner forgot). Idempotent: a second run finds nothing to file.
 * A note joins an existing page it names; otherwise the name most notes share (at least 3), then the title word most
 * of the still-unfiled notes share (at least 3, or an existing page), then "Town notes". New pages get a Related line of [[links]] to the other pages their notes name.
 */
export function organise(store:Store,by='organiser'){
  const w=wikiOf(store),notes=notesOf(store.state.events),dir=dirname(store.file);
  const paged=new Set([...w.pages.values()].flatMap(p=>p.sources));
  const todo=notes.filter(e=>!paged.has(`note:${e.id}`)&&!w.hidden.has(`note:${e.id}`));
  // A mirror file the owner deleted, or one a locked write skipped, comes back here.
  for(const p of w.pages.values())if(!existsSync(join(dir,'wiki',`${p.slug}.md`)))try{mirror(dir,p);}catch{/* mirror only */}
  if(!todo.length)return {notes:0,pages:0,created:0,duplicates:0};
  const name=namer(notes,[...store.state.cats,...store.state.retiredCats].map(c=>c.name));
  const names=new Map(notes.map(e=>[e.id,name(String(e.data?.title??''))])),df=new Map<string,number>();
  for(const e of notes)for(const k of names.get(e.id)!.keys())df.set(k,(df.get(k)??0)+1);
  const target=(slug:string)=>{let s=slug;for(let i=0;i<5&&w.redirects.has(s);i++)s=w.redirects.get(s)!;return s;};
  const usable=(slug:string)=>!!slug&&!w.forgotten.has(slug);
  const groups=new Map<string,{title:string;kind:WikiKind;notes:Event[]}>(),leftover:Event[]=[];
  const file=(e:Event,pick:{slug:string;title:string;kind:WikiKind})=>{const g=groups.get(pick.slug),old=w.pages.get(pick.slug);if(g)g.notes.push(e);else groups.set(pick.slug,{title:old?.title??pick.title,kind:old?.kind??pick.kind,notes:[e]});};
  for(const e of todo){
    if(PREFERENCE.test(`${e.data?.title} ${e.data?.text}`)&&usable('owner-preferences')){file(e,{slug:'owner-preferences',title:'Owner preferences',kind:'preference'});continue;}
    const options=[...names.get(e.id)!].map(([k,v])=>({...v,slug:target(slugify(k)),df:df.get(k)??0})).filter(o=>usable(o.slug)).sort((a,b)=>b.df-a.df||(a.slug<b.slug?-1:1));
    const pick=options.find(o=>w.pages.has(o.slug))??options.find(o=>o.df>=3);
    if(pick)file(e,pick);else leftover.push(e);
  }
  // Topic words are counted over the unfiled notes only, so a word the entity pages already took cannot make a one-line page.
  const titleWords=(e:Event)=>[...new Set(tokenize(String(e.data?.title??'')))].filter(t=>t.length>=4&&!/^\d/.test(t)&&!COMMON.has(t)&&!LABEL.has(t)&&usable(target(slugify(t))));
  const wf=new Map<string,number>();for(const e of leftover)for(const t of titleWords(e))wf.set(t,(wf.get(t)??0)+1);
  const topics=new Map<string,{title:string;notes:Event[]}>();
  for(const e of leftover){
    const word=titleWords(e).filter(t=>w.pages.has(target(slugify(t)))||wf.get(t)!>=3).sort((a,b)=>Number(w.pages.has(target(slugify(b))))-Number(w.pages.has(target(slugify(a))))||wf.get(b)!-wf.get(a)!||(a<b?-1:1))[0];
    const slug=word?target(slugify(word)):'',t=topics.get(slug);
    if(t)t.notes.push(e);else topics.set(slug,{title:word?word[0].toUpperCase()+word.slice(1):'',notes:[e]});
  }
  for(const [slug,t] of topics){
    // Fewer than 3 notes on a new topic is not a page yet: they go to Town notes. A note whose only page was forgotten stays a note.
    if(slug&&(w.pages.has(slug)||groups.has(slug)||t.notes.length>=3))for(const e of t.notes)file(e,{slug,title:t.title,kind:'topic'});
    else if(usable('town-notes'))for(const e of t.notes)file(e,{slug:'town-notes',title:'Town notes',kind:'topic'});
  }
  const byId=new Map(notes.map(e=>[`note:${e.id}`,e])),bag=new Map<string,Set<string>>();
  const bagOf=(e:Event)=>{let b=bag.get(e.id);if(!b)bag.set(e.id,b=words(e));return b;};
  let created=0,duplicates=0;
  for(const slug of [...groups.keys()].sort()){
    const g=groups.get(slug)!,old=w.pages.get(slug),earlier=(old?.sources??[]).map(s=>byId.get(s)).filter((e):e is Event=>!!e);
    const pairs:[string,string][]=[...(old?.duplicates??[])];
    // Each new note against every note already on the page and the new ones before it.
    g.notes.forEach((e,i)=>{for(const o of [...earlier,...g.notes.slice(0,i)])if(overlap(bagOf(e),bagOf(o))>=DUPLICATE)pairs.push([`note:${o.id}`,`note:${e.id}`]);});
    duplicates+=pairs.length-(old?.duplicates.length??0);
    const sourcesOf=(e:Event)=>[`note:${e.id}`,...(e.data?.task?[`task:${e.data.task}`]:[])];
    if(old){
      // An existing page grows by one small wiki.line per note; replay appends it (memory.ts), so the page is never re-journaled whole.
      const fresh=pairs.slice(old.duplicates.length);
      for(const e of g.notes)store.emit('wiki.line',{slug,line:noteLine(e),sources:sourcesOf(e),by,...(fresh.some(p=>p[1]===`note:${e.id}`)?{duplicates:fresh.filter(p=>p[1]===`note:${e.id}`)}:{})});
      try{mirror(dir,wikiOf(store).pages.get(slug)!);}catch{/* mirror only */}
      continue;
    }
    created++;
    const related=[...new Set(g.notes.flatMap(e=>[...names.get(e.id)!.keys()].map(k=>target(slugify(k)))))].filter(s=>s!==slug&&(w.pages.has(s)||groups.has(s))).slice(0,8);
    const body=`${related.length?`Related: ${related.map(s=>`[[${s}]]`).join(', ')}\n`:''}${g.notes.map(noteLine).join('\n')}`;
    save(store,{slug,title:g.title,kind:g.kind,by,sources:[...new Set(g.notes.flatMap(sourcesOf))],body,owner:[],duplicates:pairs});
  }
  return {notes:todo.length,pages:groups.size,created,duplicates};
}

/** The owner's edit. Lines the owner added or changed are marked owner-written; machine lines left as they were stay machine lines. */
export function ownerSave(store:Store,slug:string,input:{title?:string;kind?:WikiKind;body:string}){
  if(!SLUG.test(slug))throw Object.assign(new Error('A page name is lower-case letters, digits and dashes.'),{statusCode:400});
  const old=wikiOf(store).pages.get(slug),before=new Set(wikiLines(old?.body??'')),mine=new Set(old?.owner??[]);
  const lines=wikiLines(input.body),owner=[...new Set(lines.filter(l=>mine.has(l)||!before.has(l)))];
  // A duplicate pair stays flagged while both notes are still on the page.
  const titles=new Map(notesOf(store.state.events).map(e=>[`note:${e.id}`,String(e.data?.title??'')]));
  const kept=(old?.duplicates??[]).filter(pair=>pair.every(id=>{const t=titles.get(id);return !!t&&input.body.includes(t);}));
  save(store,{slug,title:input.title?.trim()||old?.title||slug,kind:input.kind??old?.kind??'topic',by:'owner',sources:old?.sources??[],body:lines.join('\n'),owner,duplicates:kept});
}
/** One line on the owner-preferences page (For you's dismiss reasons, plan 9.9): a wiki.line when the page exists, a new page otherwise
 *  (replay drops a line for a page it does not have). Nothing once the owner forgot the page. */
export function preferenceLine(store:Store,text:string,by='for-you'){
  const slug='owner-preferences',w=wikiOf(store);
  if(w.forgotten.has(slug))return;
  const line=`- (${new Date().toISOString().slice(0,10)}) ${text.replace(/\s+/g,' ').trim()}`;
  if(!w.pages.has(slug))return save(store,{slug,title:'Owner preferences',kind:'preference',by,sources:[],body:line,owner:[],duplicates:[]});
  store.emit('wiki.line',{slug,line,sources:[],by});
  try{mirror(dirname(store.file),wikiOf(store).pages.get(slug)!);}catch{/* mirror only */}
}
/** Forget: the page goes, its notes leave lookup and lessons (they stay in the journal), and the organiser never makes it again. */
export function forget(store:Store,slug:string){
  const page=wikiOf(store).pages.get(slug);
  if(!page)throw Object.assign(new Error('No such page.'),{statusCode:404});
  store.emit('wiki.removed',{slug,forget:true,by:'owner'});
  rmSync(join(dirname(store.file),'wiki',`${slug}.md`),{force:true});
}
/** Merge `from` into `into`: lines, sources, owner lines and duplicate flags combine; `from` redirects to `into` for the organiser. */
export function merge(store:Store,from:string,into:string){
  const w=wikiOf(store),a=w.pages.get(from),b=w.pages.get(into);
  if(!a||!b)throw Object.assign(new Error('No such page.'),{statusCode:404});
  if(from===into)throw Object.assign(new Error('Pick two different pages.'),{statusCode:400});
  const have=new Set(wikiLines(b.body)),related=[...have].some(l=>l.startsWith('Related: '));
  const extra=wikiLines(a.body).filter(l=>!have.has(l)&&!(related&&l.startsWith('Related: ')));
  const pairs=new Map([...b.duplicates,...a.duplicates].map(p=>[p.join('|'),p]));
  save(store,{slug:into,title:b.title,kind:b.kind,by:'owner',sources:[...new Set([...b.sources,...a.sources])],body:[...wikiLines(b.body),...extra].join('\n'),owner:[...new Set([...b.owner,...a.owner])],duplicates:[...pairs.values()]});
  store.emit('wiki.removed',{slug:from,into,by:'owner'});
  rmSync(join(dirname(store.file),'wiki',`${from}.md`),{force:true});
}
/** Pages whose titles share most of their words ("Daily Tower" and "Daily Tower 3D", "Reel" and "Reels"): merge suggestions. */
export function mergeSuggestions(pages:WikiPage[]){
  const bag=(t:string)=>new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(x=>x.length>3?x.replace(/s$/,''):x));
  const bags=pages.map(p=>bag(p.title)),out:{a:string;b:string;score:number}[]=[];
  // ponytail: O(pages²) title compare, fine for hundreds of pages; an inverted index past a few thousand.
  for(let i=0;i<pages.length;i++)for(let j=i+1;j<pages.length;j++){const s=overlap(bags[i],bags[j]);if(s>=0.6)out.push({a:pages[i].slug,b:pages[j].slug,score:Math.round(s*100)/100});}
  return out.sort((x,y)=>y.score-x.score||(x.a<y.a?-1:1)).slice(0,50);
}

/** Owner routes for the Memory panel. Every route, reads included, is owner-only: pages carry what the town knows. */
export function registerWikiRoutes(app:FastifyInstance,opts:{store:()=>Store;owner:(req:FastifyRequest)=>boolean}){
  const onRequest=async(req:FastifyRequest,reply:FastifyReply)=>{if(!opts.owner(req))return reply.code(403).send({error:'Memory is managed on the host computer or an owner device.'});};
  const slugParam={type:'object',required:['slug'],properties:{slug:{type:'string',pattern:SLUG.source}}};
  const summary=(p:WikiPage)=>({slug:p.slug,title:p.title,kind:p.kind,updated:p.updated,by:p.by,lines:wikiLines(p.body).length,owner:p.owner.length>0,duplicates:p.duplicates.length});
  // ?q= searches page text through the read model's FTS5 table; without q, every page, newest first, with merge suggestions.
  app.get('/api/wiki',{onRequest,schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:200}}}}},async req=>{
    const store=opts.store(),w=wikiOf(store),q=(req.query as {q?:string}).q?.trim();
    if(q){
      const rm=store.readModel;
      if(rm){rm.flush();return {hits:rm.wikiSearch(q,30).filter(h=>w.pages.has(h.slug)).map(h=>({...summary(w.pages.get(h.slug)!),snippet:h.snippet}))};}
      // A world without a read model (tests, a throwaway store): every query word must appear in the page.
      const ws=tokenize(q);
      return {hits:[...w.pages.values()].filter(p=>{const t=new Set(tokenize(`${p.title} ${p.body}`));return ws.length>0&&ws.every(x=>t.has(x));}).slice(0,30).map(p=>({...summary(p),snippet:''}))};
    }
    const pages=[...w.pages.values()].sort((a,b)=>a.updated===b.updated?(a.slug<b.slug?-1:1):a.updated<b.updated?1:-1);
    return {pages:pages.map(summary),suggestions:mergeSuggestions(pages),forgotten:[...w.forgotten].sort(),notes:notesOf(store.state.events).length};
  });
  app.get('/api/wiki/:slug',{onRequest,schema:{params:slugParam}},async(req,reply)=>{
    const store=opts.store(),p=wikiOf(store).pages.get((req.params as {slug:string}).slug);
    if(!p)return reply.code(404).send({error:'No such page.'});
    const titles=new Map(notesOf(store.state.events).map(e=>[`note:${e.id}`,String(e.data?.title??'')]));
    return {...p,duplicates:p.duplicates.map(([a,b])=>({a:{id:a,title:titles.get(a)??''},b:{id:b,title:titles.get(b)??''}}))};
  });
  app.put('/api/wiki/:slug',{onRequest,schema:{params:slugParam,body:{type:'object',required:['body'],additionalProperties:false,properties:{title:{type:'string',maxLength:120},kind:{type:'string',enum:KINDS},body:{type:'string',maxLength:200000}}}}},async req=>{
    ownerSave(opts.store(),(req.params as {slug:string}).slug,req.body as {title?:string;kind?:WikiKind;body:string});
    return {ok:true};
  });
  app.post('/api/wiki/:slug/forget',{onRequest,schema:{params:slugParam}},async req=>{forget(opts.store(),(req.params as {slug:string}).slug);return {ok:true};});
  app.post('/api/wiki/merge',{onRequest,schema:{body:{type:'object',required:['from','into'],additionalProperties:false,properties:{from:{type:'string',pattern:SLUG.source},into:{type:'string',pattern:SLUG.source}}}}},async req=>{
    const {from,into}=req.body as {from:string;into:string};merge(opts.store(),from,into);return {ok:true};
  });
  app.post('/api/wiki/organise',{onRequest},async()=>organise(opts.store()));
}

// Town knowledge graph: cats, groups, projects, tasks, businesses, decisions and messages. Read from the town journal and
// the latest season journal. No LLM calls, no embeddings, no dependencies. An edge is EXTRACTED when an event field states
// it, and INFERRED when it is derived; every INFERRED edge carries a `why`.
import {closeSync, existsSync, openSync, readSync, statSync} from 'node:fs';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import type {EconomyEvent} from './economy.ts';
import {splitJournal, type Event} from './store.ts';
import {latestSeason, publicSeason, readSeason} from './season-view.ts';

export type NodeType='cat'|'group'|'project'|'task'|'business'|'note'|'decision'|'message';
export type EdgeType='owns'|'delegated'|'decided'|'messaged'|'part-of'|'lives-in';
export type Basis='EXTRACTED'|'INFERRED';
export type Src={id:string;type:string};
export type MemNode={id:string;type:NodeType;label:string;text:string;at:string|null;cat?:string;status?:string;src?:Src};
export type MemEdge={from:string;to:string;type:EdgeType;basis:Basis;why?:string;note?:string;count?:number;src:Src};
// Wiki pages (product plan 3.7, wiki.ts writes them). Replayed here from wiki.saved / wiki.line / wiki.removed so lookup and lessons see them.
export type WikiKind='person'|'project'|'topic'|'preference';
export type WikiPage={slug:string;title:string;kind:WikiKind;updated:string;by:string;sources:string[];body:string;owner:string[];duplicates:[string,string][]};
// forgotten: slugs the owner forgot (never suggested again). hidden: their source notes, kept in the journal but out of lookup and lessons. redirects: merged slugs.
export type Wiki={pages:Map<string,WikiPage>;forgotten:Set<string>;hidden:Set<string>;redirects:Map<string,string>};
export const wikiLines=(body:string)=>body.split('\n').map(l=>l.trim()).filter(Boolean);

const oneLine=(v:unknown,max:number)=>{const t=String(v??'').replace(/\s+/g,' ').trim();return t.length>max?`${t.slice(0,max-3)}...`:t;};
const clamp=(n:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,n));
const cut=(s:string,max:number)=>s.length>max?`${s.slice(0,max-3)}...`:s;
const RANK:Record<NodeType,number>={cat:0,group:1,project:2,business:3,note:4,decision:5,task:6,message:7};
// ISO timestamps sort as plain strings, which is far cheaper than localeCompare on a 10k-node graph.
function byRankThenRecency(x:MemNode,y:MemNode){
  if(RANK[x.type]!==RANK[y.type])return RANK[x.type]-RANK[y.type];
  const a=x.at??'',b=y.at??'';
  return a===b?0:a<b?1:-1;
}
const srcTag=(s?:Src)=>s?`; event ${s.id} ${s.type}`:'';

// Splits on whitespace, ASCII and Latin-1 punctuation, and the general punctuation block. Letters from other scripts stay in tokens.
export const tokenize=(s:string)=>s.toLowerCase().split(/[\s!-/:-@[-`{-~ -¿ -⁯]+/).filter(t=>t.length>1);

/** Small in-memory BM25 index. Documents are node ids; a document's text is its label and its text. */
export class Bm25{
  // Postings are parallel arrays per term: documents arrive in order, so they are sorted by construction.
  private postings=new Map<string,{docs:number[];tfs:number[]}>();
  private lengths:number[]=[];
  private ids:string[]=[];
  private total=0;
  add(id:string,text:string){
    const doc=this.ids.length,terms=tokenize(text),counts=new Map<string,number>();
    for(const t of terms)counts.set(t,(counts.get(t)??0)+1);
    this.ids.push(id);this.lengths.push(terms.length);this.total+=terms.length;
    for(const [term,tf] of counts){let p=this.postings.get(term);if(!p)this.postings.set(term,p={docs:[],tfs:[]});p.docs.push(doc);p.tfs.push(tf);}
  }
  // maxShare drops terms found in more than that share of the documents ("the", "and"), so they cannot make a match alone.
  search(query:string,limit:number,maxShare=1):{id:string;score:number}[]{
    const terms=[...new Set(tokenize(query))],n=this.ids.length;
    if(!n||!terms.length)return [];
    const avg=(this.total/n)||1,k1=1.2,b=0.75,scores=new Map<number,number>();
    for(const term of terms){
      // A word in one document always counts, so a one-line index (one wiki page line) can still match.
      const p=this.postings.get(term);if(!p||(p.docs.length>1&&p.docs.length>maxShare*n))continue;
      const df=p.docs.length,idf=Math.log(1+(n-df+0.5)/(df+0.5));
      for(let i=0;i<df;i++){
        const doc=p.docs[i],tf=p.tfs[i];
        const score=idf*tf*(k1+1)/(tf+k1*(1-b+b*this.lengths[doc]/avg));
        scores.set(doc,(scores.get(doc)??0)+score);
      }
    }
    return [...scores].sort((x,y)=>y[1]-x[1]||x[0]-y[0]).slice(0,limit).map(([doc,score])=>({id:this.ids[doc],score}));
  }
}

const newWiki=():Wiki=>({pages:new Map(),forgotten:new Set(),hidden:new Set(),redirects:new Map()});
/** The built graph. Immutable after construction; memoryFor makes a new one when the journals change. */
export class TownMemory{
  private adj=new Map<string,MemEdge[]>();
  private tasksByCat=new Map<string,MemNode[]>();
  private liveCats=0;
  private openBusinesses=0;
  // The full-text index is built on the first search, so the graph and the briefs stay cheap to rebuild.
  private index?:Bm25;
  private notesIndex?:Bm25;
  private pageIndex?:Bm25;
  private lineIndex?:Bm25;
  private paged?:Set<string>;
  constructor(readonly nodes:Map<string,MemNode>,readonly edges:MemEdge[],readonly wiki:Wiki=newWiki()){
    for(const e of edges){for(const id of [e.from,e.to]){const list=this.adj.get(id);if(list)list.push(e);else this.adj.set(id,[e]);}}
    for(const n of nodes.values()){
      if(n.cat&&(n.type==='task'||n.type==='project')){const list=this.tasksByCat.get(n.cat);if(list)list.push(n);else this.tasksByCat.set(n.cat,[n]);}
      if(n.type==='cat'&&n.status!=='retired')this.liveCats++;
      if(n.type==='business'&&n.status==='open')this.openBusinesses++;
    }
  }
  private searchIndex(){
    if(!this.index){
      this.index=new Bm25();
      for(const n of this.nodes.values())this.index.add(n.id,`${n.label} ${n.label} ${n.text}`);
    }
    return this.index;
  }
  neighbours(id:string):MemEdge[]{return this.adj.get(id)??[];}
  /** A cat's most recent tasks and projects, newest first. */
  workOf(catId:string,limit:number){return (this.tasksByCat.get(catId)??[]).slice().sort(byRankThenRecency).slice(0,limit);}
  /** Nodes and edges for the Scholar's view. Without focus, the highest-ranked and most recent nodes; with focus, a breadth-first neighbourhood. */
  graph(opts:{focus?:string;depth?:number;limit?:number}={}){
    const limit=clamp(Math.floor(opts.limit??120),1,300);
    let ids:string[];
    if(opts.focus!==undefined){
      const start=this.nodes.get(opts.focus);if(!start)throw new Error('Unknown focus node.');
      const depth=clamp(Math.floor(opts.depth??1),1,3),dist=new Map([[start.id,0]]);
      let frontier=[start.id];
      for(let d=1;d<=depth&&frontier.length;d++){
        const next:string[]=[];
        for(const id of frontier)for(const e of this.neighbours(id)){const other=e.from===id?e.to:e.from;if(!dist.has(other)){dist.set(other,d);next.push(other);}}
        frontier=next;
      }
      ids=[...dist.keys()].sort((a,b)=>dist.get(a)!-dist.get(b)!||byRankThenRecency(this.nodes.get(a)!,this.nodes.get(b)!)).slice(0,limit);
    }else{
      ids=[...this.nodes.values()].sort(byRankThenRecency).slice(0,limit).map(n=>n.id);
    }
    const keep=new Set(ids);
    return {
      nodes:ids.map(id=>{const n=this.nodes.get(id)!;return {id:n.id,type:n.type,label:n.label,at:n.at};}),
      edges:this.edges.filter(e=>keep.has(e.from)&&keep.has(e.to)).map(({from,to,type,basis})=>({from,to,type,basis})),
    };
  }
  /** Notes filed on a live page: the page line carries them, so lookup and lessons show the page instead. */
  onPage(id:string){return (this.paged??=new Set([...this.wiki.pages.values()].flatMap(p=>p.sources))).has(id);}
  search(query:string,limit=10){
    // A forgotten page's notes stay in the journal but out of every search.
    const n=clamp(Math.floor(limit),1,50);
    return this.searchIndex().search(query,n+this.wiki.hidden.size).filter(h=>!this.wiki.hidden.has(h.id)).slice(0,n).map(({id,score})=>{
      const n=this.nodes.get(id)!;
      return {id,type:n.type,label:n.label,snippet:oneLine(n.text||n.label,140),score:Math.round(score*1000)/1000};
    });
  }
  /** The town notes that best match a task's text, dated, for every task's brief. Notes have their own index so the
   *  thousands of tasks sharing a task's words cannot crowd the lessons out. */
  lessons(text:string,limit=3,max=700){
    if(!this.notesIndex){
      this.notesIndex=new Bm25();
      for(const n of this.nodes.values())if(n.type==='note'&&!this.onPage(n.id)&&!this.wiki.hidden.has(n.id))this.notesIndex.add(n.id,`${n.label} ${n.label} ${n.text}`);
    }
    // Page lines lead, the owner's own lines first (owner text wins over what the cats recorded).
    const pages=this.pageLines(text,limit).map(h=>`${h.owner?'(the owner’s words) ':''}[[${h.slug}]] ${oneLine(h.line.replace(/^- /,''),200)}`);
    const lines=this.notesIndex.search(text,limit,0.5).map(({id})=>{const n=this.nodes.get(id)!;return `${n.at?`(${n.at.slice(0,10)}) `:''}${oneLine(n.label,90)}: ${oneLine(n.text,180)}`;});
    return cut([...pages,...lines].join(' | '),max);
  }
  /** The wiki page lines that best match a text, owner-written lines first. */
  pageLines(text:string,limit=3){
    if(!this.lineIndex){
      this.lineIndex=new Bm25();
      for(const p of this.wiki.pages.values())wikiLines(p.body).forEach((l,i)=>{if(!l.startsWith('Related: '))this.lineIndex!.add(`${p.slug}\n${i}`,`${p.title} ${l}`);});
    }
    return this.lineIndex.search(text,limit,0.5).map(({id})=>{
      const [slug,i]=id.split('\n'),p=this.wiki.pages.get(slug)!,line=wikiLines(p.body)[Number(i)];
      return {slug,line,owner:p.owner.includes(line)};
    }).sort((a,b)=>Number(b.owner)-Number(a.owner));
  }
  /** Wiki pages matching a query, best first. */
  pageSearch(query:string,limit=3){
    if(!this.pageIndex){
      this.pageIndex=new Bm25();
      for(const p of this.wiki.pages.values())this.pageIndex.add(p.slug,`${p.title} ${p.title} ${p.body}`);
    }
    return this.pageIndex.search(query,limit,0.5).map(({id})=>this.wiki.pages.get(id)!);
  }
  /** One paragraph about a cat: who it is, its group, what it owns, its recent work and a few town counts. */
  brief(catId:string,max=600){
    const cat=this.nodes.get(catId);if(!cat||cat.type!=='cat')return '';
    const parts=[`${cat.label}: ${oneLine(cat.text,160)||'a town cat'}.`];
    const edges=this.neighbours(catId);
    const group=edges.find(e=>e.type==='lives-in'&&e.from===catId);
    if(group)parts.push(`Lives in ${this.nodes.get(group.to)?.label??group.to}.`);
    const owned=edges.filter(e=>e.type==='owns'&&e.from===catId).map(e=>this.nodes.get(e.to)?.label).filter((l):l is string=>!!l).slice(0,3);
    if(owned.length)parts.push(`Runs ${owned.join(', ')}.`);
    const work=(this.tasksByCat.get(catId)??[]).slice().sort(byRankThenRecency).slice(0,2);
    if(work.length)parts.push(`Recent work: ${work.map(n=>`${oneLine(n.text,90)} (${n.status??'open'})`).join('; ')}.`);
    parts.push(`Town: ${this.liveCats} cats, ${this.openBusinesses} open businesses.`);
    const notes=[...this.nodes.values()].filter(n=>n.type==='note').sort(byRankThenRecency).slice(0,3);
    if(notes.length)parts.push(`Latest town notes: ${notes.map(n=>oneLine(n.label,70)).join('; ')}.`);
    return cut(parts.join(' '),max);
  }
}

// The id is shown so a cat can ask about it next; task ids are the raw ones review_cat and the prompt use.
// A page for lookup: lines that share a word with the query lead, the owner's own lines first and marked OWNER.
function pageFact(p:WikiPage,query:string|undefined,max:number){
  const words=new Set(tokenize(query??'')),lines=wikiLines(p.body).filter(l=>!l.startsWith('Related: '));
  const hits=words.size?lines.filter(l=>tokenize(l).some(t=>words.has(t))):[];
  const shown=(hits.length?hits:lines).sort((a,b)=>Number(p.owner.includes(b))-Number(p.owner.includes(a))).map(l=>`${p.owner.includes(l)?'OWNER: ':''}${l.replace(/^- /,'')}`);
  return `- wiki page "${p.title}" (wiki:${p.slug}, ${p.kind}, ${lines.length} lines${p.owner.length?'; OWNER lines are the owner’s own words and win':''}): ${oneLine(shown.join(' / '),max)}`;
}
const fact=(n:MemNode,max=160)=>`- ${n.type} "${n.label}" (${n.id.replace(/^(task|project):/,'')}${n.status?`, ${n.status}`:''}): ${oneLine(n.text,max)} [EXTRACTED${srcTag(n.src)}]`;
/** Facts for the cats' lookup tool. Every line names its basis and source event. Output stays under 1500 characters. */
export function lookup(mem:TownMemory,args:{query?:unknown;about?:unknown}):string{
  if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))throw new Error('Invalid query');
  if(args.about!==undefined&&(typeof args.about!=='string'||args.about.length>200))throw new Error('Invalid about');
  if(args.query===undefined&&args.about===undefined)throw new Error('Give a query or an about id');
  const lines:string[]=[];
  if(typeof args.about==='string'){
    const n=mem.nodes.get(args.about)??mem.nodes.get(`task:${args.about}`)??mem.nodes.get(`project:${args.about}`);
    const page=mem.wiki.pages.get(args.about.replace(/^wiki:/,''));
    if(page&&(!n||args.about.startsWith('wiki:')))lines.push(pageFact(page,undefined,1300));
    else if(!n||mem.wiki.hidden.has(n.id))lines.push(`No record with id ${args.about}.`);
    else{
      // The asked-for record in full (a cat's whole role); a cat's recent work comes first, since the prompt lists live tasks only.
      lines.push(fact(n,600));
      if(n.type==='cat')for(const w of mem.workOf(n.id,6))lines.push(fact(w,100));
      for(const e of mem.neighbours(n.id)){
        const from=mem.nodes.get(e.from)?.label??e.from,to=mem.nodes.get(e.to)?.label??e.to;
        lines.push(`- ${from} ${e.type} ${to} [${e.basis}${e.why?`: ${e.why}`:''}${e.note?`; ${e.note}`:''}${srcTag(e.src)}]`);
      }
    }
  }
  // Pages first; a note filed on a page is shown through its page.
  if(typeof args.query==='string'){
    for(const p of mem.pageSearch(args.query,3))lines.push(pageFact(p,args.query,450));
    for(const hit of mem.search(args.query,8))if(!mem.onPage(hit.id))lines.push(fact(mem.nodes.get(hit.id)!));
  }
  if(!lines.length)return 'No town records match.';
  let out='';
  for(const line of new Set(lines)){
    if(out.length+line.length+1>1500)break;
    out+=(out?'\n':'')+line;
  }
  return out;
}

/** Accumulates the graph one town event at a time, so a rebuild after new events only reads the new ones. */
class Builder{
  nodes=new Map<string,MemNode>();
  edges=new Map<string,MemEdge>();
  cats=new Set<string>(['owner']);
  wiki=newWiki();
  private nodeOfTask=new Map<string,string>();
  private rootOfTask=new Map<string,string>();
  constructor(){this.node({id:'owner',type:'cat',label:'Owner',text:'The town owner, who sets the direction.',at:null,status:'active',src:{id:'implicit',type:'owner'}});}
  node(n:MemNode){const old=this.nodes.get(n.id);this.nodes.set(n.id,old?{...old,...n,at:old.at??n.at}:n);}
  link(type:EdgeType,from:string,to:string,basis:Basis,src:Src,extra:Partial<MemEdge>={}){
    if(!this.nodes.has(from)||!this.nodes.has(to))return;
    this.edges.set(`${type}|${from}|${to}`,{from,to,type,basis,src,...extra});
  }
  // A message between two actors is one aggregated messaged edge with a count.
  messaged(from:string,to:string,src:Src){
    const actor=(x:string)=>x==='owner'||this.cats.has(x);
    if(from===to||!actor(from)||!actor(to))return;
    const k=`messaged|${from}|${to}`,old=this.edges.get(k);
    if(old)old.count=(old.count??1)+1;else this.link('messaged',from,to,'EXTRACTED',src,{count:1});
  }
  private addCat(c:any,at:string|null,src:Src){
    if(!c?.id)return;
    this.cats.add(c.id);
    // The whole role (the prompt shows 120 chars and points here); briefs cut their own copy.
    this.node({id:c.id,type:'cat',label:String(c.name??c.id),text:oneLine(c.role,600),at,status:'active',src});
  }
  private placeCat(catId:string,group:string,at:string|null,src:Src){
    const gid=`group:${group}`;
    if(!this.nodes.has(gid))this.node({id:gid,type:'group',label:group,text:'',at,src});
    for(const k of [...this.edges.keys()])if(k.startsWith(`lives-in|${catId}|`))this.edges.delete(k);
    this.link('lives-in',catId,gid,'EXTRACTED',src);
  }
  // Journal payloads are untyped JSON, so each field is read defensively; `any` stands for that untyped payload.
  town(e:Event){
    const d:any=e.data??{};
    const at=e.at??null,src={id:e.id,type:e.type};
    switch(e.type){
      case 'founded':for(const c of d.cats??[])this.addCat(c,at,src);break;
      case 'cat.created':this.addCat(d,at,src);if(d.group)this.placeCat(d.id,d.group,at,src);break;
      case 'cat.restored':this.addCat(d.cat,at,src);if(d.cat?.group)this.placeCat(d.cat.id,d.cat.group,at,src);break;
      case 'group.founded':this.node({id:`group:${d.id}`,type:'group',label:String(d.name??d.id),text:d.lead?`Hall led by ${d.lead}.`:'',at,src});break;
      case 'town.planned':
        for(const g of d.groups??[])this.node({id:`group:${g.id}`,type:'group',label:String(g.name??g.id),text:g.lead?`Hall led by ${g.lead}.`:'',at,src});
        for(const h of d.homes??[])if(h.group)this.placeCat(h.id,h.group,at,src);
        break;
      case 'homes.planned':for(const h of d.homes??[])if(h.group)this.placeCat(h.id,h.group,at,src);break;
      case 'task.created':{
        const isRoot=!d.parent,id=isRoot?`project:${d.id}`:`task:${d.id}`;
        this.node({id,type:isRoot?'project':'task',label:oneLine(d.text,80),text:oneLine(d.text,300),at,cat:d.cat,status:d.status,src});
        this.nodeOfTask.set(d.id,id);
        if(isRoot){this.rootOfTask.set(d.id,id);break;}
        const parent=this.nodeOfTask.get(d.parent);
        if(!parent)break;
        const root=this.rootOfTask.get(d.parent)??parent;
        this.rootOfTask.set(d.id,root);
        this.link('delegated',parent,id,'EXTRACTED',src);
        this.link('part-of',id,root,'EXTRACTED',src);
        if(d.from&&d.cat&&d.from!==d.cat)this.link('delegated',d.from,d.cat,'EXTRACTED',src);
        break;
      }
      case 'task.updated':{const n=this.nodes.get(this.nodeOfTask.get(d.id)??'');if(n&&d.status)n.status=d.status;break;}
      // The Mayor's diary: one entry when a goal is turned in or stopped.
      // A fact a memory keeper recorded with remember. Searchable like every other record.
      case 'memory.noted':this.node({id:`note:${e.id}`,type:'note',label:oneLine(d.title,90),text:oneLine(d.text,400),at,cat:d.cat,src});break;
      case 'wiki.saved':if(typeof d.slug==='string'){
        this.wiki.pages.set(d.slug,{slug:d.slug,title:String(d.title??d.slug),kind:d.kind??'topic',updated:at??'',by:String(d.by??''),sources:d.sources??[],body:String(d.body??''),owner:d.owner??[],duplicates:d.duplicates??[]});
        this.wiki.forgotten.delete(d.slug);this.wiki.redirects.delete(d.slug);
      }break;
      // One note joining a page: its line, sources and duplicate flags are appended to the last full save.
      case 'wiki.line':{
        const p=this.wiki.pages.get(d.slug);if(!p||typeof d.line!=='string')break;
        this.wiki.pages.set(d.slug,{...p,updated:at??p.updated,by:String(d.by??p.by),body:p.body?`${p.body}\n${d.line}`:d.line,sources:[...new Set([...p.sources,...(d.sources??[])])],duplicates:[...p.duplicates,...(d.duplicates??[])]});
        break;
      }
      case 'wiki.removed':{
        const p=this.wiki.pages.get(d.slug);this.wiki.pages.delete(d.slug);
        if(d.forget){this.wiki.forgotten.add(d.slug);for(const s of p?.sources??[])this.wiki.hidden.add(s);}
        if(typeof d.into==='string')this.wiki.redirects.set(d.slug,d.into);
        break;
      }
      case 'diary.entry':this.node({id:`diary:${e.id}`,type:'message',label:oneLine(`Diary: ${d.title}`,90),text:oneLine(`${d.status==='achieved'?'Achieved':'Stopped'}: ${d.text}`,300),at,src});break;
      case 'message':{
        const mid=`msg:${e.id}`;
        this.node({id:mid,type:'message',label:oneLine(`${d.from} to ${d.to}: ${d.text}`,90),text:oneLine(d.text,300),at,src});
        const task=d.task?this.nodeOfTask.get(d.task):undefined;
        if(task)this.link('part-of',mid,task,'EXTRACTED',src);
        if(d.from!=='system')this.messaged(d.from,d.to,src);
        break;
      }
      case 'approval.requested':{
        const id=`approval:${d.id}`;
        this.node({id,type:'decision',label:oneLine(`Approval: ${d.question}`,90),text:oneLine(`${d.question} Options: ${(d.options??[]).join(' / ')}`,300),at,cat:d.cat,status:'pending',src});
        const root=this.rootOfTask.get(d.task);if(root)this.link('part-of',id,root,'EXTRACTED',src);
        break;
      }
      case 'approval.resolved':{
        const id=`approval:${d.id}`,n=this.nodes.get(id);
        if(!n||(d.status!=='approved'&&d.status!=='rejected'))break;
        n.status=d.status;n.text=oneLine(`${n.text} Answer: ${d.answer??''}`,300);
        this.link('decided','owner',id,'INFERRED',src,{why:'approval.resolved records no actor; only the owner answers approvals'});
        break;
      }
      case 'council.opened':this.node({id:`council:${d.id}`,type:'decision',label:oneLine(`Retirement review: ${d.target}`,90),text:oneLine(d.reason,300),at,cat:d.target,status:'voting',src});break;
      case 'council.voted':if(d.ballot)this.link('decided',d.ballot.cat,`council:${d.id}`,'EXTRACTED',src,{note:`vote ${d.ballot.vote}`});break;
      case 'council.closed':{
        const n=this.nodes.get(`council:${d.id}`);if(!n)break;
        n.status=d.status;n.text=oneLine(`${n.text} Result: ${d.result??d.status}`,300);
        const target=n.cat?this.nodes.get(n.cat):undefined;
        if(d.status==='retired'&&target)target.status='retired';
        break;
      }
    }
  }
  /** A copy with its own nodes and edges, so season facts never touch the town's running state. */
  clone(){
    const b=new Builder();
    b.nodes=new Map([...this.nodes].map(([k,n])=>[k,{...n}]));
    b.edges=new Map([...this.edges].map(([k,e])=>[k,{...e}]));
    b.cats=new Set(this.cats);
    b.nodeOfTask=new Map(this.nodeOfTask);
    b.rootOfTask=new Map(this.rootOfTask);
    // Pages are replaced whole on every save, so sharing the page objects is safe.
    b.wiki={pages:new Map(this.wiki.pages),forgotten:new Set(this.wiki.forgotten),hidden:new Set(this.wiki.hidden),redirects:new Map(this.wiki.redirects)};
    return b;
  }
}

// Season facts come from the season journal. Its events have no ids or timestamps, so each source is "<season>#<index>".
function addSeason(b:Builder,{name,events}:{name:string;events:EconomyEvent[]}){
  const srcOf=(i:number,type:string):Src=>({id:`${name}#${i}`,type});
  const season=publicSeason(events,name);
  const bizIndex=new Map<string,number>();
  events.forEach((e,i)=>{if(e.type==='business.opened')bizIndex.set(e.id,i);});
  for(const biz of season.businesses){
    const id=`biz:${name}/${biz.id}`,src=srcOf(bizIndex.get(biz.id)??-1,'business.opened');
    b.node({id,type:'business',label:oneLine(biz.name,80),text:oneLine(`${biz.category}. Sold ${biz.sold}.`,300),at:null,cat:biz.owner,status:biz.open?'open':'closed',src});
    b.link('owns',biz.owner,id,'EXTRACTED',src);
  }
  events.forEach((e,i)=>{
    const src=srcOf(i,e.type);
    switch(e.type){
      case 'capability.requested':
        b.node({id:`cap:${name}/${e.id}`,type:'decision',label:oneLine(`Capability: ${e.need}`,90),text:oneLine(`${e.cat} asks for ${e.need} (${e.kind}). ${e.purpose}`,300),at:null,cat:e.cat,status:'pending',src});
        break;
      case 'capability.decided':{
        const id=`cap:${name}/${e.id}`,n=b.nodes.get(id);if(!n)break;
        n.status=e.approved?'approved':'rejected';
        if(e.by&&e.by!=='system')b.link('decided',e.by,id,'EXTRACTED',src);
        break;
      }
      case 'spend.requested':
        b.node({id:`spend:${name}/${e.id}`,type:'decision',label:oneLine(`Spend ${e.amount}: ${e.purpose}`,90),text:oneLine(`${e.cat} asks to spend ${e.amount} for ${e.purpose}.`,300),at:null,cat:e.cat,status:'pending',src});
        if(e.business)b.link('part-of',`spend:${name}/${e.id}`,`biz:${name}/${e.business}`,'EXTRACTED',src);
        break;
      case 'spend.decided':{
        const id=`spend:${name}/${e.id}`,n=b.nodes.get(id);if(!n)break;
        n.status=e.approved?'approved':'rejected';
        if(e.by&&e.by!=='system')b.link('decided',e.by,id,'EXTRACTED',src);
        break;
      }
      case 'action':
        if(e.name==='message'&&typeof e.args?.to==='string'&&typeof e.args?.text==='string'&&b.cats.has(e.cat)){
          b.node({id:`msg:${name}/${i}`,type:'message',label:oneLine(`${e.cat} to ${e.args.to}: ${e.args.text}`,90),text:oneLine(e.args.text,300),at:null,src});
          b.messaged(e.cat,e.args.to,src);
        }
        break;
    }
  });
}

/** Builds the graph from town events and, optionally, one season. Used directly by tests and the benchmark. */
export function buildMemory(town:Event[],season?:{name:string;events:EconomyEvent[]}):TownMemory{
  const b=new Builder();
  for(const e of town)b.town(e);
  return finish(b,season);
}
// The snapshot is a copy: the town builder keeps changing as new events arrive.
function finish(town:Builder,season?:{name:string;events:EconomyEvent[]}):TownMemory{
  const b=town.clone();
  // A season that cannot be replayed leaves the town facts in place.
  if(season){try{addSeason(b,season);}catch{/* damaged season journal */}}
  return new TownMemory(b.nodes,[...b.edges.values()],b.wiki);
}

// Cached per data directory. The town builder reads only the events that arrived since the last build (the journal is
// append-only), and the town journal is read again only when its own stamp moves. A season change rebuilds the season
// facts on top of the town builder, without re-reading the town journal.
type Entry={townKey:string;seasonKey:string;builder:Builder;seen:number;offset:number;seasonEvents?:EconomyEvent[];mem?:TownMemory};
const cache=new Map<string,Entry>();
const stamp=(file:string)=>{try{const s=statSync(file);return `${s.size}:${s.mtimeMs}`;}catch{return '-';}};
// Complete lines from byte `from` on. A torn last append is left for the next read; -1 means the file shrank.
function readAppended(file:string,from:number):{events:Event[];end:number}{
  if(!existsSync(file))return {events:[],end:0};
  const size=statSync(file).size;
  if(size<from)return {events:[],end:-1};
  if(size===from)return {events:[],end:from};
  const fd=openSync(file,'r');
  try{
    const buf=Buffer.alloc(size-from);
    readSync(fd,buf,0,buf.length,from);
    const {lines}=splitJournal(buf),events:Event[]=[];
    for(const line of lines.toString('utf8').split('\n')){
      if(!line.trim())continue;
      try{const e=JSON.parse(line);if(typeof e?.type==='string')events.push(e as Event);}catch{/* a damaged line is skipped */}
    }
    return {events,end:from+lines.length};
  }finally{closeSync(fd);}
}
// season=false keeps only the town facts. view() uses it: a cat's season state is already in its view, and a season file
// changes after every action, so keying the brief on it would rebuild the graph for every cat on every tick.
export function memoryFor(dataDir:string,townEvents?:Event[],season=true):TownMemory{
  const name=season?latestSeason(dataDir):undefined;
  const cacheKey=season?dataDir:`${dataDir}#town`;
  const townKey=townEvents?`n${townEvents.length}`:stamp(join(dataDir,'events.jsonl'));
  const seasonKey=name?`${name}:${stamp(join(dataDir,`season-${name}.jsonl`))}`:'-';
  let entry=cache.get(cacheKey);
  if(entry&&entry.mem&&entry.townKey===townKey&&entry.seasonKey===seasonKey)return entry.mem;
  if(!entry)entry={townKey:'',seasonKey:'',builder:new Builder(),seen:0,offset:0};
  if(entry.townKey!==townKey){
    if(townEvents){
      if(townEvents.length<entry.seen){entry.builder=new Builder();entry.seen=0;}
      for(let i=entry.seen;i<townEvents.length;i++)entry.builder.town(townEvents[i]);
      entry.seen=townEvents.length;
    }else{
      // The file path reads only the bytes appended since the last build.
      const file=join(dataDir,'events.jsonl');
      let read=readAppended(file,entry.offset);
      if(read.end<0){entry.builder=new Builder();read=readAppended(file,0);}
      for(const e of read.events)entry.builder.town(e);
      entry.offset=read.end;
    }
    entry.townKey=townKey;
  }
  if(entry.seasonKey!==seasonKey||!entry.mem){
    entry.seasonKey=seasonKey;
    entry.seasonEvents=undefined;
    if(name){try{const events=readSeason(dataDir,name);if(events.length)entry.seasonEvents=events;}catch{/* a damaged season file must not break the town memory */}}
  }
  entry.mem=finish(entry.builder,entry.seasonEvents?{name:name!,events:entry.seasonEvents}:undefined);
  cache.set(cacheKey,entry);
  return entry.mem;
}

/** Read-only routes for both apps. Bad input is a 400; responses carry labels and one-line summaries only. */
export function registerMemoryRoutes(app:FastifyInstance,memory:()=>TownMemory){
  const bad=(message:string)=>Object.assign(new Error(message),{statusCode:400});
  const whole=(q:Record<string,unknown>,name:string,lo:number,hi:number)=>{
    const v=q[name];if(v===undefined||v==='')return undefined;
    const n=Number(v);if(typeof v!=='string'||!Number.isInteger(n)||n<lo||n>hi)throw bad(`${name} must be a whole number from ${lo} to ${hi}.`);
    return n;
  };
  app.get('/api/memory/graph',async req=>{
    const q=req.query as Record<string,unknown>;
    if(q.focus!==undefined&&(typeof q.focus!=='string'||q.focus.length>120))throw bad('focus must be a node id of up to 120 characters.');
    const opts={focus:q.focus===''?undefined:q.focus as string|undefined,depth:whole(q,'depth',1,3),limit:whole(q,'limit',1,300)};
    try{return memory().graph(opts);}
    catch(error){throw bad((error as Error).message);}
  });
  app.get('/api/memory/search',async req=>{
    const query=(req.query as Record<string,unknown>).q;
    if(typeof query!=='string'||!query.trim()||query.length>200)throw bad('Search for 1 to 200 characters.');
    return {hits:memory().search(query,20)};
  });
}

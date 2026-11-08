// Plain-language approval cards: what, where, who sees it, and whether it can be undone. Built from the tool arguments, never raw JSON.
import {redact,redactValues} from './tool-runtimes.ts';

export type Card={what:string; where:string; who_sees:string; undo:string};
export type CardCtx={label?:string; identity?:string|null; browser?:string; secrets?:readonly unknown[]};

const str=(v:unknown)=>typeof v==='string'?v:'';
// First line only, cut short: a caption or task can run on, and the card is one line each.
const one=(v:unknown,n:number)=>str(v).split(/\r?\n/)[0].trim().slice(0,n);
const repo=(a:any)=>[str(a.owner),str(a.repo)].filter(Boolean).join('/')||'a GitHub repo';
const paths=(files:any[])=>{const p=files.map(f=>str(f?.path)).filter(Boolean);return p.length<=3?p.join(', '):`${p.slice(0,3).join(', ')} and ${p.length-3} more`;};
// GitHub does not say a repo's visibility on a file write, so the card says it is not checked.
const seesRepo='Anyone who can see the repo (visibility not checked)';
const undoCommit='Revert the commit on GitHub; the old files stay in its history';
// Stripe amounts are in minor units (cents for USD); ASSUMED for two-decimal currencies only.
const money=(p:any)=>(/^\d+$/.test(str(p?.amount))||typeof p?.amount==='number')?`${(Number(p.amount)/100).toFixed(2)} ${str(p.currency).toUpperCase()}`.trim():'';

// The built-ins that write keep their files in the town's gallery on this computer, which has no delete yet.
const gallery='The gallery on this computer',undoGallery='Stays in the gallery; Clowder has no delete for it yet',seesGallery='You and the devices you paired, in the gallery';
const media=(kind:string)=>(a:any)=>({what:`Make ${kind==='image'?'an image':'a video'}: ${one(a.title,60)||'(untitled)'}${one(a.prompt,100)?`, from “${one(a.prompt,100)}”`:''}`, where:gallery, who_sees:`${seesGallery}; the prompt goes to your ${kind} model’s provider`, undo:undoGallery});

// Arguments are untyped JSON from a cat's tool call, so each template reads only the fields it names and tolerates the rest.
const T:Record<string,(a:any,c:CardCtx)=>Card>={
  // The run edits files only in its private workspace (Bash off, the data folder unreadable: claude-tools.ts) and spends the owner's plan.
  code_workspace:a=>({what:`Build in a code workspace: ${one(a.task,100)||'(no brief)'}`, where:`A private workspace${one(a.project,60)?` for ${one(a.project,60)}`:''}; new and changed files go to the gallery on this computer`, who_sees:`${seesGallery}; the brief goes to the AI plan that runs it`, undo:'The files stay in the gallery and the workspace; Clowder has no delete for them yet'}),
  generate_image:media('image'),
  generate_video:media('video'),
  save_artifact:a=>({what:`Save ${str(a.kind)||'a file'}: ${one(a.title,80)||'(untitled)'}${typeof a.content==='string'?` (${a.content.length} characters)`:''}`, where:gallery, who_sees:`${seesGallery}, and any cat given its id`, undo:undoGallery}),
  browse:(a,c)=>{
    let site='';try{site=new URL(str(a.url)).host;}catch{}
    return {what:`Browse: ${one(a.task,100)}`, where:`${site?`${site}, `:''}${c.browser??"the cats' browser"}`, who_sees:'The sites it visits, and anything it types or submits there', undo:'Cannot be undone from Clowder; check the site afterwards'};
  },
  push_files:(a,c)=>{
    const n=Array.isArray(a.files)?a.files.length:0;
    return {what:`Push ${n} file${n===1?'':'s'}${n?`: ${paths(a.files)}`:''}`, where:`${c.label??'GitHub'}: ${repo(a)}${a.branch?`, branch ${str(a.branch)}`:''}`, who_sees:seesRepo, undo:undoCommit};
  },
  // A repo is public unless private is true (GitHub's default), so an unset flag reads as public.
  create_repository:(a,c)=>({what:`Create repository ${one(a.name,60)||'(unnamed)'}`, where:`${c.label??'GitHub'}${str(a.owner)?`, under ${str(a.owner)}`:''}`, who_sees:a.private===true?'Only you (private repo)':'Anyone on the internet (public repo)', undo:'Delete the repo on GitHub; its contents go with it'}),
  create_or_update_file:(a,c)=>({what:`Create or update ${str(a.path)||'a file'}`, where:`${c.label??'GitHub'}: ${repo(a)}${a.branch?`, branch ${str(a.branch)}`:''}`, who_sees:seesRepo, undo:undoCommit}),
  publish_reel:(a,c)=>{
    // The handle comes from the verified identity the connector reports, never from the arguments.
    const handle=c.identity?`@${c.identity.replace(/^@/,'')}`:'the connected account';
    const cap=one(a.caption,60);
    return {what:`Post a reel to ${handle}${cap?`: “${cap}”`:''}`, where:`${c.label??'Instagram'}, ${handle}`, who_sees:'Everyone, public on Instagram', undo:'Delete it in Instagram; anyone who already saw it keeps that'};
  },
  stripe_api_write:(a,c)=>{
    const m=str(a.method).toUpperCase()||'POST';
    const obj=str(a.path).split('?')[0].split('/').filter(s=>s&&s!=='v1')[0]||'an object';
    const amt=money(a.params);
    return {what:`${m==='DELETE'?'Delete':'Create or change'} ${obj}${amt?`, ${amt}`:''}`, where:c.label??'Stripe', who_sees:'Your Stripe account, and the customer on the object', undo:m==='DELETE'?'Cannot be undone from Clowder':'Reverse it in the Stripe dashboard; Clowder does not undo money moves'};
  },
};

// Unknown tools, and any template that fails on odd arguments, return undefined so the approval keeps today's text.
export function cardFor(tool:string,args:unknown,ctx:CardCtx={}):Card|undefined{
  const f=T[tool];if(!f)return undefined;
  try{
    const a=args&&typeof args==='object'?args as any:{};
    const card=f(a,ctx);
    // Secret values are masked on every line; a token pasted into a task or caption never reaches the card.
    const clean=(s:string)=>redactValues(redact(s),ctx.secrets??[]);
    return {what:clean(card.what),where:clean(card.where),who_sees:clean(card.who_sees),undo:clean(card.undo)};
  }catch{return undefined;}
}

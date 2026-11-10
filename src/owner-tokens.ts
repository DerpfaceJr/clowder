// Plan 11.28 (N18): owner tokens for the town MCP (town-mcp.ts), a second token type beside Hermes's gate token. An owner token reaches the
// five owner tools and nothing else; the gate token reaches the Mayor's tools and nothing else. Each token is shown once, when it is made; the
// file keeps its SHA-256 only, with a name and when it was made and last used. Revoke takes it out of the file and out of memory, so the next
// call with it gets 401. A missing or unreadable file means no tokens (the timid answer): nothing works until the owner makes one again.
// Make and Revoke: the host, or an owner device with a fresh passkey step-up, as for rotating the owner key (server.ts).
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,renameSync,writeFileSync} from 'node:fs';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {same} from './access.ts';

// The prefix keeps an owner token apart from every other credential at a glance (Hermes's gate token is plain hex).
export const TOKEN_PREFIX='clw_owner_';
export type OwnerToken={id:string;name:string;createdAt:string;lastUsedAt:string|null};
type Saved=OwnerToken&{hash:string};
const sha=(token:string)=>createHash('sha256').update(token).digest('hex');

export class OwnerTokens{
  private saved:Saved[];
  constructor(private file:string,private now:()=>Date=()=>new Date()){
    try{const data=JSON.parse(readFileSync(file,'utf8'));this.saved=(Array.isArray(data?.tokens)?data.tokens:[]).filter((t:any)=>typeof t?.id==='string'&&typeof t?.hash==='string'&&/^[0-9a-f]{64}$/.test(t.hash));}
    catch{this.saved=[];}
  }
  private save(){const tmp=`${this.file}.${randomBytes(4).toString('hex')}.tmp`;writeFileSync(tmp,JSON.stringify({tokens:this.saved},null,2));renameSync(tmp,this.file);}
  list():OwnerToken[]{return this.saved.map(({hash:_,...t})=>t);}
  /** The one time the token's value exists outside the client: this return. */
  make(name:string):OwnerToken&{token:string}{
    const clean=name.replace(/\s+/g,' ').trim().slice(0,40);
    if(!clean)throw Object.assign(new Error('Name the token first.'),{statusCode:400});
    const token=`${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`,t:OwnerToken={id:randomUUID(),name:clean,createdAt:this.now().toISOString(),lastUsedAt:null};
    this.saved.push({...t,hash:sha(token)});this.save();
    return {...t,token};
  }
  revoke(id:string){
    const before=this.saved.length;this.saved=this.saved.filter(t=>t.id!==id);
    if(this.saved.length===before)throw Object.assign(new Error('That token is not on the list.'),{statusCode:404});
    this.save();
  }
  /** An Authorization header's owner token, checked against every stored hash; the match's last-used time moves. */
  authenticate(header:unknown):OwnerToken|undefined{
    if(typeof header!=='string'||!header.startsWith(`Bearer ${TOKEN_PREFIX}`))return undefined;
    const hash=sha(header.slice('Bearer '.length)),hit=this.saved.find(t=>same(t.hash,hash));
    if(!hit)return undefined;
    hit.lastUsedAt=this.now().toISOString();
    try{this.save();}catch{/* last-used is a convenience; the call still runs */}
    const {hash:_,...t}=hit;return t;
  }
}

/** GET /api/owner-tokens (owner), POST /api/owner-tokens {name} and POST /api/owner-tokens/:id/revoke (manage: host or stepped-up owner device). */
export function registerOwnerTokenRoutes(app:FastifyInstance,o:{tokens:OwnerTokens;owner:(req:FastifyRequest)=>boolean;manage:(req:FastifyRequest)=>boolean}){
  const gate=(allowed:(req:FastifyRequest)=>boolean)=>async(req:FastifyRequest,reply:FastifyReply)=>{if(!allowed(req))return reply.code(403).send({error:'Owner tokens are made and revoked on the host computer.'});};
  app.get('/api/owner-tokens',{onRequest:gate(o.owner)},async()=>({tokens:o.tokens.list()}));
  app.post('/api/owner-tokens',{onRequest:gate(o.manage),schema:{body:{type:'object',required:['name'],additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:40}}}}},async req=>o.tokens.make((req.body as {name:string}).name));
  app.post('/api/owner-tokens/:id/revoke',{onRequest:gate(o.manage)},async req=>{o.tokens.revoke((req.params as {id:string}).id);return {ok:true};});
}

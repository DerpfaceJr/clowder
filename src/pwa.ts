import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pipeline,type Readable} from 'node:stream';
import {createGzip} from 'node:zlib';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';

// The service worker must always be re-checked by the browser, so it is never served from the HTTP cache.
export async function serviceWorkerHeaders(req:FastifyRequest,res:FastifyReply,payload:unknown){
  if(req.url.split('?')[0]==='/sw.js')res.header('Cache-Control','no-cache');
  return payload;
}

export const installServiceWorkerHeaders=(app:FastifyInstance)=>app.addHook('onSend',serviceWorkerHeaders);

// Text that leaves as a file stream (the static files, a text artifact) is gzipped when the browser accepts it: a phone on a tunnel downloads
// about a quarter of the bytes. Whole GET responses only: JSON routes send strings, the event stream is hijacked, and a range stays as it is.
// ponytail: compressed on every request, nothing kept; write .gz files at build (the static plugin's preCompressed) if it shows in a profile.
const GZIP_TYPES=/^(text\/(html|css|javascript|plain)|application\/(javascript|json|manifest\+json)|image\/svg\+xml)\b/;
export async function gzipText(req:FastifyRequest,res:FastifyReply,payload:unknown){
  if(req.method!=='GET'||res.statusCode!==200||typeof (payload as Readable|null)?.pipe!=='function'||res.hasHeader('content-encoding')
    ||!/\bgzip\b/.test(String(req.headers['accept-encoding']??''))||!GZIP_TYPES.test(String(res.getHeader('content-type')??'')))return payload;
  res.removeHeader('content-length');res.header('Content-Encoding','gzip').header('Vary','Accept-Encoding');
  return pipeline(payload as Readable,createGzip(),()=>{/* a failed read ends the response */});
}
export const installGzip=(app:FastifyInstance)=>app.addHook('onSend',gzipText);

// The app page's Content-Security-Policy: scripts run from this origin only, plus the page's own inline scripts by hash (the import map and
// the desktop-app class). Text a model wrote cannot run as script even if an escaping slip lets it into the DOM. Styles, images, media
// and connections stay open on purpose: the town loads blobs and data URLs, and artifacts carry their own sandbox policy (src/artifacts.ts).
export function appCsp(indexHtml:string){
  const hashes=[...indexHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>`'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
  return `script-src ${["'self'",...hashes].join(' ')}; object-src 'none'; base-uri 'none'`;
}
// Set on the static index page only, a 304 for it included (it carries an ETag; a route's own HTML does not). The hashes are read again
// when the file changes.
export function installAppCsp(app:FastifyInstance,indexFile:string){
  let seen:unknown,policy='';
  app.addHook('onSend',async(req,res,payload)=>{
    const path=req.url.split('?')[0],etag=res.getHeader('etag');
    if((path!=='/'&&path!=='/index.html')||!etag)return payload;
    if(!policy||etag!==seen){seen=etag;policy=appCsp(readFileSync(indexFile,'utf8'));}
    res.header('Content-Security-Policy',policy);
    return payload;
  });
}

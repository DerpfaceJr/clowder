import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';

// The service worker must always be re-checked by the browser, so it is never served from the HTTP cache.
export async function serviceWorkerHeaders(req:FastifyRequest,res:FastifyReply,payload:unknown){
  if(req.url.split('?')[0]==='/sw.js')res.header('Cache-Control','no-cache');
  return payload;
}

export const installServiceWorkerHeaders=(app:FastifyInstance)=>app.addHook('onSend',serviceWorkerHeaders);

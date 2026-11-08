import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {FastifyInstance, FastifyRequest} from 'fastify';

const gzipAsync=promisify(gzip);
// A request from this computer itself gains nothing: copying 6.7 MB over loopback is cheaper than compressing it.
// Through the LAN, Tailscale or a tunnel (a forwarded header or a non-loopback address) the 4x smaller body is worth it.
const remote=(req:FastifyRequest)=>!!req.headers['x-forwarded-for']||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip);
// /api/state is several MB of JSON, refetched on every change, so it is gzipped for remote clients that accept it.
// Level 1 off the main thread: level 6 took a median 367 ms and level 1 180 ms on a 6.7 MB snapshot (n=5 runs each), for 4.7x vs 4.0x.
export function installStateGzip(app:FastifyInstance){
  app.addHook('onSend',async(req,res,payload)=>{
    if(req.url.split('?')[0]!=='/api/state')return payload;
    res.header('vary','accept-encoding');
    if(!remote(req)||!/\bgzip\b/i.test(String(req.headers['accept-encoding']??''))||typeof payload!=='string')return payload;
    res.header('content-encoding','gzip');
    return gzipAsync(payload,{level:1});
  });
}

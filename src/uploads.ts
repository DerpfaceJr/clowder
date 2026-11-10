// Plan 11.22 (N15): the owner hands Clowder a file. One owner route saves it as an owner artifact and returns its id; a request names that id
// and the cats read it with read_artifact, which labels it as data (artifacts.ts readArtifactTool).
// The file is untrusted. Owner only: the access hooks, then this route's own check, both before any byte is read. The cap is the route's
// bodyLimit, so Fastify refuses a longer Content-Length before reading and stops a streamed body at the cap. The type comes from the bytes,
// never from the name or Content-Type. The client's name is a display title only; the file is stored under a generated id (storeArtifact).
// HTML and SVG are kept as text, so the gallery serves them as text/plain under the artifact sandbox, never as a page from the town's origin.
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {ArtifactError, artifactsDir, sniffMedia, storeArtifact, type ArtifactKind} from './artifacts.ts';
import type {Event} from './store.ts';

/** The request body cap (ASSUMED, plan 11.22). The gallery's own per-kind limits sit under it: text 512 KB, images 8 MB (artifacts.ts LIMITS). */
export const UPLOAD_CAP = 20 * 1024 * 1024;
const TOO_BIG = 'This file is larger than the 20 MB limit.';
const ACCEPTED = 'Clowder takes photos (PNG, JPEG or WebP), videos (MP4 or WebM) and text files (plain text, Markdown, JSON, CSV, HTML or SVG, kept as text).';
// ISO media files that are photos, not video: HEIC and AVIF share MP4's ftyp box, so sniffMedia alone would call them MP4.
const PHOTO_BRANDS = /^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/;
// Text may hold tabs, line breaks and form feeds; any other control character (NUL, escape) marks a binary file.
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/;

/** The display title from the X-File-Name header (URI-encoded, so any name fits a header): the last path segment, with control and
 *  format characters (a right-to-left override, say) removed and whitespace collapsed. null when it is missing or not valid encoding. */
export function uploadTitle(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  let name: string;
  try { name = decodeURIComponent(header); } catch { return null; }
  const title = (name.split(/[\\/]/).pop() ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return title ? [...title].slice(0, 120).join('') : null;
}

/** The gallery kind for these bytes, from their content; the name's extension only picks among the text kinds. null: not a type Clowder takes. */
export function uploadKind(bytes: Buffer, title: string): ArtifactKind | null {
  if (sniffMedia('image', bytes)) return 'image';
  if (sniffMedia('video', bytes)) return PHOTO_BRANDS.test(bytes.toString('latin1', 8, 12)) ? null : 'video';
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return null; }
  if (CONTROL.test(text)) return null;
  const ext = /\.([^.]+)$/.exec(title)?.[1]?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'json') { try { JSON.parse(text); return 'json'; } catch { return 'text'; } }
  return 'text';
}

type Journal = {state: {events: Event[]}; emit(type: string, data: any): Event};

/** POST /api/uploads: the body is the file's bytes, X-File-Name its name. Registered on each listener (server.ts registerTown). */
export function registerUploadRoutes(app: FastifyInstance, opts: {dir: () => string; journal: () => Journal; owner: (req: FastifyRequest) => boolean}) {
  const ownerOnly = async (req: FastifyRequest, reply: FastifyReply) => { if (!opts.owner(req)) return reply.code(403).send({error: 'Only the owner hands Clowder a file.'}); };
  void app.register(async scope => {
    // Any body is read as bytes, up to the cap; the declared Content-Type is never trusted.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', {parseAs: 'buffer'}, (_req, body, done) => done(null, body));
    scope.setErrorHandler((error: any, _req, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({error: TOO_BIG});
      return reply.code(error.statusCode || 400).send({error: error.message});
    });
    scope.post('/api/uploads', {onRequest: ownerOnly, bodyLimit: UPLOAD_CAP}, async (req, reply) => {
      const title = uploadTitle(req.headers['x-file-name']);
      if (!title) return reply.code(400).send({error: 'Give the file a name.'});
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!bytes.length) return reply.code(400).send({error: 'That file is empty.'});
      const kind = uploadKind(bytes, title);
      if (!kind) return reply.code(415).send({error: `Clowder cannot keep this kind of file. ${ACCEPTED}`});
      try {
        const record = storeArtifact({journal: opts.journal(), dir: artifactsDir(opts.dir()), cat: 'owner', task: null, project: null, title, kind, bytes});
        return {id: record.id, title: record.title, kind: record.kind, mime: record.mime, size: record.size};
      } catch (err) {
        if (err instanceof ArtifactError) return reply.code(err.statusCode).send({error: err.message});
        throw err;
      }
    });
  });
}

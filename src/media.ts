// Media providers: one interface, one adapter per service. An adapter starts a job; if the service is asynchronous it returns a
// job id, and the runtime polls that id until the job finishes. Results that arrive as a URL are downloaded here, over HTTPS
// only, with a size cap. The URL is never hotlinked into the app.
//
// Docs each adapter follows (fetched while building this; quote and re-check before changing an endpoint):
// - OpenAI-compatible images: POST {base}/images/generations, Bearer key, b64_json or url in data[0].
// - Seedance (BytePlus ModelArk): https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api
//   POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks, Authorization: Bearer; reply {id};
//   GET .../contents/generations/tasks/{id}; status queued|running|succeeded|failed|expired|cancelled; content.video_url.
//   Images: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/image-generation-tutorial
//   POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations; response data[0].url.
// - Higgsfield: https://docs.higgsfield.ai/docs/quickstart.md
//   POST https://api.higgsfield.ai/{model path}, Authorization: Key id:secret, Idempotency-Key (lowercase UUID);
//   reply has request_id and status_url; poll status_url; completed carries images[].url; failed, nsfw, canceled end it.
//   TODO: video is disabled. The checked docs do not name the video result field, so nothing is guessed.
import {randomUUID} from 'node:crypto';

export type MediaKind = 'image' | 'video';
export type MediaRequest = {prompt: string; kind: MediaKind; size?: string; duration?: number};
export type MediaFile = {bytes: Buffer; adapter: string};
type Step = {done: true; bytes: Buffer} | {done: false; jobId: string};
type Ctx = {download(url: string, kind: MediaKind, signal: AbortSignal): Promise<Buffer>};
export type MediaAdapter = {
  id: string;
  label: string;
  kinds: MediaKind[];
  start(req: MediaRequest, signal: AbortSignal, ctx: Ctx): Promise<Step>;
  poll?(jobId: string, signal: AbortSignal, ctx: Ctx): Promise<Step>;
};
export type MediaRuntime = {has(kind: MediaKind): boolean; generate(req: MediaRequest, signal: AbortSignal): Promise<MediaFile>};

export class MediaError extends Error {
  constructor(message: string, readonly statusCode = 502) { super(message); }
}

const MB = 1024 * 1024;
export const DOWNLOAD_LIMITS = {image: 8 * MB, video: 100 * MB} as const;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const tooLarge = (kind: MediaKind) => `The ${kind} is larger than the ${kind === 'image' ? '8 MB' : '100 MB'} limit.`;

/** Downloads a result file. HTTPS only, redirects checked, and the size cap is enforced while streaming. allowHttp exists for tests only. */
export async function downloadMedia(url: string, kind: MediaKind, signal: AbortSignal, allowHttp = false): Promise<Buffer> {
  const ok = (u: URL) => u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
  let first: URL;
  try { first = new URL(url); } catch { throw new MediaError('The result link is not a valid URL.'); }
  if (!ok(first) || first.username || first.password) throw new MediaError('Result links must be plain HTTPS.');
  const response = await fetch(first, {signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])});
  if (!response.ok) throw new MediaError(`The result download answered ${response.status}.`);
  if (!ok(new URL(response.url || url))) throw new MediaError('The result redirected to a non-HTTPS link.');
  const limit = DOWNLOAD_LIMITS[kind];
  if (Number(response.headers.get('content-length')) > limit) throw new MediaError(tooLarge(kind));
  const reader = response.body?.getReader();
  if (!reader) throw new MediaError('The result download was empty.');
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new MediaError(tooLarge(kind)); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Every request that carries a key goes through here: no redirects (a key never follows a redirect elsewhere), a timeout, and a generic error.
async function requestJson(url: string, init: {method: string; headers: Record<string, string>; body?: string}, signal: AbortSignal, label: string, timeoutMs: number): Promise<any> {
  const response = await fetch(url, {...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])});
  if (!response.ok) throw new MediaError(`${label} answered ${response.status}. Check the saved settings.`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new MediaError(`${label} returned an unreadable reply.`);
  return body;
}
const JSON_HEADERS = {'Content-Type': 'application/json'};
const ARK = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const HIGGSFIELD = 'https://api.higgsfield.ai';
const B64_MAX = Math.ceil(DOWNLOAD_LIMITS.image / 3) * 4 + 8;
const JOB_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export function openAIImagesAdapter(o: {base: string; model: string; key: string; timeoutMs: number}): MediaAdapter {
  const base = o.base.replace(/\/$/, '');
  return {
    id: 'openai-images', label: 'OpenAI-compatible images', kinds: ['image'],
    async start(req, signal, ctx) {
      const body = await requestJson(`${base}/images/generations`, {method: 'POST', headers: {...JSON_HEADERS, Authorization: `Bearer ${o.key}`},
        body: JSON.stringify({model: o.model, prompt: req.prompt, n: 1, response_format: 'b64_json', ...(req.size ? {size: req.size} : {})})}, signal, 'The images service', o.timeoutMs);
      const item = body.data?.[0];
      if (typeof item?.b64_json === 'string' && item.b64_json) {
        if (item.b64_json.length > B64_MAX) throw new MediaError('The image is larger than the 8 MB limit.');
        return {done: true, bytes: Buffer.from(item.b64_json, 'base64')};
      }
      if (typeof item?.url === 'string') return {done: true, bytes: await ctx.download(item.url, 'image', signal)};
      throw new MediaError('The images service returned no image.');
    },
  };
}

export function seedanceAdapter(o: {base?: string; key: string; imageModel?: string; videoModel?: string; timeoutMs: number}): MediaAdapter {
  const base = (o.base ?? ARK).replace(/\/$/, '');
  const auth = {Authorization: `Bearer ${o.key}`};
  return {
    id: 'seedance', label: 'Seedance (BytePlus ModelArk)',
    kinds: [...(o.imageModel ? ['image' as const] : []), ...(o.videoModel ? ['video' as const] : [])],
    async start(req, signal, ctx) {
      if (req.kind === 'image') {
        if (!o.imageModel) throw new MediaError('No Seedance image model is set.');
        const body = await requestJson(`${base}/images/generations`, {method: 'POST', headers: {...JSON_HEADERS, ...auth},
          body: JSON.stringify({model: o.imageModel, prompt: req.prompt, response_format: 'url', ...(req.size ? {size: req.size} : {})})}, signal, 'Seedance images', o.timeoutMs);
        const url = body.data?.[0]?.url;
        if (typeof url !== 'string') throw new MediaError('Seedance returned no image.');
        return {done: true, bytes: await ctx.download(url, 'image', signal)};
      }
      if (!o.videoModel) throw new MediaError('No Seedance video model is set.');
      const body = await requestJson(`${base}/contents/generations/tasks`, {method: 'POST', headers: {...JSON_HEADERS, ...auth},
        body: JSON.stringify({model: o.videoModel, content: [{type: 'text', text: req.prompt}], ...(req.duration ? {duration: req.duration} : {})})}, signal, 'Seedance video', o.timeoutMs);
      if (typeof body.id !== 'string' || !JOB_ID.test(body.id)) throw new MediaError('Seedance returned no task id.');
      return {done: false, jobId: body.id};
    },
    async poll(jobId, signal, ctx) {
      if (!JOB_ID.test(jobId)) throw new MediaError('Bad Seedance task id.');
      const body = await requestJson(`${base}/contents/generations/tasks/${encodeURIComponent(jobId)}`, {method: 'GET', headers: auth}, signal, 'Seedance task', o.timeoutMs);
      if (body.status === 'succeeded') {
        const url = body.content?.video_url;
        if (typeof url !== 'string') throw new MediaError('Seedance finished without a video link.');
        return {done: true, bytes: await ctx.download(url, 'video', signal)};
      }
      if (['failed', 'expired', 'cancelled'].includes(body.status)) throw new MediaError(`Seedance ${body.status} the video.`);
      return {done: false, jobId};
    },
  };
}

// Only the status link the service returned is polled, and only on the API's own origin, so the key never goes to another host.
export function higgsfieldAdapter(o: {base?: string; key: string; imageModel?: string; timeoutMs: number}): MediaAdapter {
  const base = (o.base ?? HIGGSFIELD).replace(/\/$/, '');
  const origin = new URL(base).origin;
  const auth = {Authorization: `Key ${o.key}`};
  return {
    id: 'higgsfield', label: 'Higgsfield', kinds: o.imageModel ? ['image'] : [],
    async start(req, signal, ctx) {
      if (req.kind !== 'image' || !o.imageModel) throw new MediaError('Higgsfield image is not set.');
      const body = await requestJson(`${base}${o.imageModel}`, {method: 'POST', headers: {...JSON_HEADERS, ...auth, 'Idempotency-Key': randomUUID()},
        body: JSON.stringify({prompt: req.prompt})}, signal, 'Higgsfield', o.timeoutMs);
      if (body.status === 'completed') return {done: true, bytes: await higgsfieldImage(body, ctx, signal)};
      if (typeof body.status_url !== 'string') throw new MediaError('Higgsfield returned no status link.');
      if (new URL(body.status_url).origin !== origin) throw new MediaError('Higgsfield returned a status link on another host.');
      return {done: false, jobId: body.status_url};
    },
    async poll(statusUrl, signal, ctx) {
      const url = new URL(statusUrl);
      if (url.origin !== origin) throw new MediaError('Higgsfield returned a status link on another host.');
      const body = await requestJson(url.href, {method: 'GET', headers: auth}, signal, 'Higgsfield status', o.timeoutMs);
      if (body.status === 'completed') return {done: true, bytes: await higgsfieldImage(body, ctx, signal)};
      if (['failed', 'nsfw', 'canceled'].includes(body.status)) throw new MediaError(`Higgsfield ${body.status} the image.`);
      return {done: false, jobId: statusUrl};
    },
  };
}
// A completed Higgsfield request carries images[].url (quickstart doc). The file is downloaded, never linked.
async function higgsfieldImage(body: any, ctx: Ctx, signal: AbortSignal): Promise<Buffer> {
  const url = body.images?.[0]?.url;
  if (typeof url !== 'string') throw new MediaError('Higgsfield finished without an image link.');
  return ctx.download(url, 'image', signal);
}

export type CustomConfig = {base: string; path: string; authHeader: string; authPrefix: string; key: string; kind: MediaKind; bodyTemplate: string;
  resultPath: string; resultEncoding: 'url' | 'base64'; idPath?: string; pollPath?: string; statusPath?: string; doneValue?: string; failedValue?: string};

// A dot path into a JSON reply, with numeric parts for array indexes. Missing parts give undefined.
export function pick(value: any, path: string): any {
  return path.split('.').filter(Boolean).reduce((node, part) => (node == null ? undefined : node[part]), value);
}
// Fills {prompt} in string values of a parsed template. The prompt is inserted as a value, so it cannot change the JSON's shape.
export function fillTemplate(node: any, prompt: string): any {
  if (typeof node === 'string') return node.split('{prompt}').join(prompt);
  if (Array.isArray(node)) return node.map(item => fillTemplate(item, prompt));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillTemplate(v, prompt)]));
  return node;
}

export function customAdapter(o: CustomConfig & {timeoutMs: number}): MediaAdapter {
  const base = o.base.replace(/\/$/, '');
  const auth = {[o.authHeader]: `${o.authPrefix}${o.key}`};
  const template = JSON.parse(o.bodyTemplate);
  const result = async (body: any, ctx: Ctx, signal: AbortSignal): Promise<Buffer> => {
    const value = pick(body, o.resultPath);
    if (typeof value !== 'string' || !value) throw new MediaError('The custom service returned no result.');
    if (o.resultEncoding === 'base64') {
      if (value.length > B64_MAX) throw new MediaError(`The ${o.kind} is larger than the limit.`);
      return Buffer.from(value, 'base64');
    }
    return ctx.download(value, o.kind, signal);
  };
  return {
    id: 'custom', label: 'Custom HTTP', kinds: [o.kind],
    async start(req, signal, ctx) {
      if (req.kind !== o.kind) throw new MediaError(`The custom provider makes ${o.kind}s.`);
      const body = await requestJson(`${base}${o.path}`, {method: 'POST', headers: {...JSON_HEADERS, ...auth}, body: JSON.stringify(fillTemplate(template, req.prompt))}, signal, 'The custom service', o.timeoutMs);
      if (o.idPath && o.pollPath) {
        const id = pick(body, o.idPath);
        if (typeof id !== 'string' || !JOB_ID.test(id)) throw new MediaError('The custom service returned no usable job id.');
        return {done: false, jobId: id};
      }
      return {done: true, bytes: await result(body, ctx, signal)};
    },
    async poll(jobId, signal, ctx) {
      if (!o.pollPath || !o.statusPath) throw new MediaError('The custom service is not set up to poll.');
      const body = await requestJson(`${base}${o.pollPath.split('{id}').join(encodeURIComponent(jobId))}`, {method: 'GET', headers: auth}, signal, 'The custom service', o.timeoutMs);
      const status = pick(body, o.statusPath);
      if (status !== undefined && status === o.failedValue) throw new MediaError('The custom service reported a failed job.');
      if (status === o.doneValue) return {done: true, bytes: await result(body, ctx, signal)};
      return {done: false, jobId};
    },
  };
}

// MoneyPrinterTurbo (MIT, https://github.com/harry0703/MoneyPrinterTurbo, LICENSE). It runs on the owner's machine or in the workshop.
// Endpoints, read at main commit 40d7f3de9d8e14056c72f523ecbb6700cff50372:
// - README-en.md: the API listens on 127.0.0.1:8080 by default (app/config/config.py listen_port = 8080; docs at /docs).
// - app/controllers/v1/base.py new_router: prefix "/api/v1". app/router.py includes the v1 video router.
// - app/controllers/v1/video.py: POST /api/v1/videos (create_video) returns get_response(200, {task_id, request_id, params}).
// - video.py get_task: GET /api/v1/tasks/{task_id} returns data.state, data.progress, data.videos[], data.error, data.failed_stage.
// - app/models/const.py: TASK_STATE_FAILED = -1, TASK_STATE_COMPLETE = 1, TASK_STATE_PROCESSING = 4.
// - video.py _task_file_to_uri: videos[] are absolute URLs when app.endpoint is set, otherwise "/tasks/..." paths on the same origin.
// - app/controllers/v1/base.py verify_token: when app.api_key is set, the x-api-key header is required.
// The adapter only talks to the loopback origin the owner set. Its video is downloaded from the same origin with redirects refused.
export function moneyPrinterAdapter(o: {base: string; apiKey?: string; timeoutMs: number}): MediaAdapter {
  const base = parseLocalBase(o.base);
  const headers: Record<string, string> = o.apiKey ? {'x-api-key': o.apiKey} : {};
  return {
    id: 'moneyprinter', label: 'MoneyPrinterTurbo (local service)', kinds: ['video'],
    async start(req, signal) {
      if (req.kind !== 'video') throw new MediaError('MoneyPrinterTurbo makes videos only.');
      const body = await requestJson(`${base}/api/v1/videos`, {method: 'POST', headers: {...JSON_HEADERS, ...headers},
        body: JSON.stringify({video_subject: req.prompt, video_source: 'pexels', video_count: 1, video_clip_duration: 5})}, signal, 'MoneyPrinterTurbo', o.timeoutMs);
      const id = body.data?.task_id;
      if (typeof id !== 'string' || !JOB_ID.test(id)) throw new MediaError('MoneyPrinterTurbo returned no task id.');
      return {done: false, jobId: id};
    },
    async poll(jobId, signal) {
      if (!JOB_ID.test(jobId)) throw new MediaError('Bad MoneyPrinterTurbo task id.');
      const body = await requestJson(`${base}/api/v1/tasks/${encodeURIComponent(jobId)}`, {method: 'GET', headers}, signal, 'MoneyPrinterTurbo task', o.timeoutMs);
      const task = body.data ?? {};
      if (task.state === 1) {
        const file = Array.isArray(task.videos) ? task.videos[0] : undefined;
        if (typeof file !== 'string' || !file) throw new MediaError('MoneyPrinterTurbo finished without a video.');
        const url = new URL(file, base);
        if (url.origin !== new URL(base).origin) throw new MediaError('MoneyPrinterTurbo returned a video on another host.');
        return {done: true, bytes: await downloadLocalVideo(url.href, headers, signal)};
      }
      if (task.state === -1) throw new MediaError(`MoneyPrinterTurbo failed${typeof task.error === 'string' ? `: ${task.error.slice(0, 200)}` : '.'}`);
      return {done: false, jobId};
    },
  };
}

// Own download for the loopback adapter: redirects refused, size cap while streaming. Same origin as the base, checked by the caller.
async function downloadLocalVideo(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, {headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])});
  if (!response.ok) throw new MediaError(`The video download answered ${response.status}.`);
  if (Number(response.headers.get('content-length')) > DOWNLOAD_LIMITS.video) throw new MediaError(tooLarge('video'));
  const reader = response.body?.getReader();
  if (!reader) throw new MediaError('The video download was empty.');
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > DOWNLOAD_LIMITS.video) { await reader.cancel(); throw new MediaError(tooLarge('video')); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** A runtime over the configured adapters. The first adapter that makes a kind serves it. Jobs are polled until done or the wait runs out. */
export function runtimeFor(adapters: MediaAdapter[], opts: {pollMs?: number; maxWaitMs?: number; allowHttp?: boolean} = {}): MediaRuntime {
  const ctx: Ctx = {download: (url, kind, signal) => downloadMedia(url, kind, signal, opts.allowHttp ?? false)};
  return {
    has: kind => adapters.some(a => a.kinds.includes(kind)),
    async generate(req, signal) {
      const adapter = adapters.find(a => a.kinds.includes(req.kind));
      if (!adapter) throw new MediaError(`No ${req.kind} provider is configured.`);
      const deadline = Date.now() + (opts.maxWaitMs ?? (req.kind === 'video' ? 15 * 60_000 : 3 * 60_000));
      let step = await adapter.start(req, signal, ctx);
      while (!step.done) {
        if (Date.now() > deadline) throw new MediaError(`${adapter.label} took too long.`);
        await pause(opts.pollMs ?? 5000, signal);
        step = await adapter.poll!(step.jobId, signal, ctx);
      }
      return {bytes: step.bytes, adapter: adapter.id};
    },
  };
}

// Settings: one field list per provider. Keys are secret: they are stored, never returned, and a blank key keeps the saved one
// for the same endpoint. An https base is the only kind of URL accepted, and an unknown field is refused.
type Field = {name: string; label: string; required?: boolean; secret?: boolean; url?: boolean; local?: boolean; pattern?: RegExp; max: number; choices?: string[]; default?: string};
// A preset fills the listed fields; the owner then pastes only the key. keyUrl is the service's key page (https).
export type MediaPreset = {label: string; keyUrl: string; values: Record<string, string>};
export type MediaSpec = {label: string; note?: string; hint?: string; presets?: MediaPreset[]; fields: Field[]};
export const MEDIA_SPECS: Record<string, MediaSpec> = {
  // Any service with this images endpoint works; OpenAI is the preset. Model ids are from OpenAI's image guide (WebFetch, not called).
  'openai-images': {label: 'OpenAI-compatible images', hint: 'Any service with an OpenAI-style images endpoint. Pick OpenAI or enter a base URL.',
    presets: [{label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', values: {base: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst'}}], fields: [
    {name: 'base', label: 'Base URL (HTTPS)', required: true, url: true, max: 300},
    {name: 'model', label: 'Images model', required: true, max: 120},
    {name: 'key', label: 'API key', required: true, secret: true, max: 500}]},
  seedance: {label: 'Seedance · BytePlus ModelArk', hint: 'Seedream makes images, Seedance makes video. Set one or both.', note: 'Image models use Seedream; video uses Seedance. Set one or both.', fields: [
    {name: 'imageModel', label: 'Image model', max: 120},
    {name: 'videoModel', label: 'Video model', max: 120},
    {name: 'key', label: 'ModelArk API key', required: true, secret: true, max: 500}]},
  // MoneyPrinterTurbo keeps its own keys (Pexels or Pixabay for footage, an LLM provider for the script) in its config.toml. Clowder never stores them.
  moneyprinter: {label: 'MoneyPrinterTurbo (local service)', hint: 'Narrated videos from MoneyPrinterTurbo running on this computer or in the workshop.', note: 'Makes narrated short videos. Run MoneyPrinterTurbo on this computer or in the workshop, then set its address here. Its own keys go in its config.toml, not here: a Pexels or Pixabay key for footage and an LLM provider key for the script. Video only; the first video provider in the list serves a request.', fields: [
    {name: 'base', label: 'Local address, for example http://127.0.0.1:8080', required: true, url: true, local: true, max: 300},
    {name: 'key', label: 'x-api-key (only if MoneyPrinterTurbo sets app.api_key)', secret: true, max: 500}]},
  higgsfield: {label: 'Higgsfield', hint: 'Images only for now. Video is not wired yet.', note: 'Images only for now. Higgsfield video is not wired yet: the docs checked do not name its result field.', fields: [
    {name: 'imageModel', label: 'Image endpoint path, for example /higgsfield-ai/soul/v2/standard', required: true, pattern: /^\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,150}$/, max: 160},
    {name: 'key', label: 'API key as id:secret', required: true, secret: true, pattern: /^[^:\s]+:\S+$/, max: 500}]},
  custom: {label: 'Custom HTTP', hint: 'Any JSON service that returns a file link or base64 data.', note: 'Any service that takes a JSON request and returns a file URL or base64. {prompt} in the template is replaced by the prompt.', fields: [
    {name: 'base', label: 'Base URL (HTTPS)', required: true, url: true, max: 300},
    {name: 'path', label: 'Path, for example /v1/images', required: true, pattern: /^\/[A-Za-z0-9._~\/-]{0,299}$/, max: 300},
    {name: 'kind', label: 'Makes', required: true, choices: ['image', 'video'], max: 10},
    {name: 'key', label: 'API key', required: true, secret: true, max: 500},
    {name: 'authHeader', label: 'Auth header name', pattern: /^[A-Za-z][A-Za-z0-9-]{0,39}$/, max: 40, default: 'Authorization'},
    {name: 'authPrefix', label: 'Auth prefix (may be empty)', max: 40, default: 'Bearer '},
    {name: 'bodyTemplate', label: 'JSON request template', required: true, max: 4000},
    {name: 'resultPath', label: 'Result path, for example data.0.url', required: true, max: 200},
    {name: 'resultEncoding', label: 'Result is', choices: ['url', 'base64'], max: 10, default: 'url'},
    {name: 'idPath', label: 'Job id path (only for async services)', max: 200},
    {name: 'pollPath', label: 'Poll path with {id}, for example /tasks/{id}', max: 200},
    {name: 'statusPath', label: 'Status path', max: 200},
    {name: 'doneValue', label: 'Status value when done', max: 60},
    {name: 'failedValue', label: 'Status value when failed', max: 60}]},
};

export function checkMedia(id: string, input: Record<string, unknown>, saved?: Record<string, string>): Record<string, string> {
  const spec = MEDIA_SPECS[id];
  if (!spec) throw new MediaError('Unknown media provider.', 400);
  const known = new Set(spec.fields.map(f => f.name));
  for (const k of Object.keys(input)) if (!known.has(k)) throw new MediaError(`Unknown setting ${k}.`, 400);
  const urlField = spec.fields.find(f => f.url);
  const parse = urlField?.local ? parseLocalBase : parseHostedBase;
  const base = urlField && typeof input[urlField.name] === 'string' && (input[urlField.name] as string).trim()
    ? parse((input[urlField.name] as string).trim()).replace(/\/$/, '') : undefined;
  // A blank key is reused only when the endpoint is unchanged, the same rule as the hosted provider.
  const sameEndpoint = !urlField || saved?.[urlField.name] === base;
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    let v = typeof input[f.name] === 'string' ? (input[f.name] as string).trim() : '';
    if (f.secret && !v && sameEndpoint && saved?.[f.name]) v = saved[f.name];
    if (!v) {
      if (f.default !== undefined) v = f.default;
      else if (f.required) throw new MediaError(`Enter ${f.label.toLowerCase()}.`, 400);
      else continue;
    }
    if (v.length > f.max) throw new MediaError(`${f.label} is too long.`, 400);
    if (f.url) v = base!.replace(/\/$/, '');
    if (f.choices && !f.choices.includes(v)) throw new MediaError(`Choose a valid ${f.label.toLowerCase()}.`, 400);
    if (f.pattern && !f.pattern.test(v)) throw new MediaError(`${f.label} is not in the right form.`, 400);
    out[f.name] = v;
  }
  if (id === 'custom') {
    let template: unknown;
    try { template = JSON.parse(out.bodyTemplate); } catch { throw new MediaError('The JSON request template is not valid JSON.', 400); }
    if (!JSON.stringify(template).includes('{prompt}')) throw new MediaError('The request template must include {prompt}.', 400);
    if (out.pollPath && !out.pollPath.includes('{id}')) throw new MediaError('The poll path must include {id}.', 400);
    if (out.idPath && !out.pollPath) throw new MediaError('A job id path needs a poll path.', 400);
  }
  return out;
}

/** The adapters for every saved provider, in the order a cat's request is served: the first one that makes the kind wins. */
export function buildAdapters(saved: Record<string, Record<string, string>>, timeoutMs: number): MediaAdapter[] {
  const out: MediaAdapter[] = [];
  const o = saved['openai-images'];
  if (o) out.push(openAIImagesAdapter({base: o.base, model: o.model, key: o.key, timeoutMs}));
  const s = saved.seedance;
  if (s) out.push(seedanceAdapter({key: s.key, imageModel: s.imageModel, videoModel: s.videoModel, timeoutMs}));
  const h = saved.higgsfield;
  if (h) out.push(higgsfieldAdapter({key: h.key, imageModel: h.imageModel, timeoutMs}));
  const m = saved.moneyprinter;
  if (m) out.push(moneyPrinterAdapter({base: m.base, apiKey: m.key || undefined, timeoutMs}));
  const c = saved.custom;
  if (c) out.push(customAdapter({base: c.base, path: c.path, authHeader: c.authHeader ?? 'Authorization', authPrefix: c.authPrefix ?? 'Bearer ', key: c.key,
    kind: c.kind as MediaKind, bodyTemplate: c.bodyTemplate, resultPath: c.resultPath, resultEncoding: (c.resultEncoding ?? 'url') as 'url' | 'base64',
    idPath: c.idPath, pollPath: c.pollPath, statusPath: c.statusPath, doneValue: c.doneValue, failedValue: c.failedValue, timeoutMs}));
  return out;
}

// The loopback rule for MoneyPrinterTurbo only: http or https to 127.0.0.1 or localhost, any port, no login, query or fragment.
export function parseLocalBase(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('The local address must be a full URL such as http://127.0.0.1:8080.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The local address must be http or https.');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('The local address must be 127.0.0.1 or localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The local address must not contain a login, query or fragment.');
  return url.origin;
}

// The one rule for a provider base URL: HTTPS, no login, query or fragment. models.ts re-exports it.
export function parseHostedBase(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('Hosted base must be a full HTTPS URL.'); }
  if (url.protocol !== 'https:') throw new Error('Hosted providers require HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Hosted base must not contain a login, query or fragment.');
  return url.href;
}


function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Stopped by owner.')); }, {once: true});
  });
}

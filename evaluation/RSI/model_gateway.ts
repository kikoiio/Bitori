import {createHash, timingSafeEqual} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {createServer, request as httpRequest} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export type GatewayProtocol = 'anthropic' | 'openai-chat' | 'openai-responses';

export interface GatewayOptions {
  upstream: {baseURL: string; protocol: GatewayProtocol; model: string; apiKeyEnv: string};
  runTokenEnv: string;
  limits: {maxRequests: number; maxTokens: number; maxOutputTokens: number; deadlineEpochMs: number};
  ledgerPath: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  allowLocalhostHttp?: boolean;
}

export interface GatewayUsage {
  requests: number;
  upstreamRequests: number;
  completedRequests: number;
  failedRequests: number;
  activeRequests: number;
  chargedTokens: number;
  reservedTokens: number;
  totalTokens: number;
  reliableUsageRequests: number;
  exhausted: boolean;
  ledgerFailed: boolean;
}

export interface GatewayHandle {
  url: string;
  readonly usage: Readonly<GatewayUsage>;
  close(): Promise<void>;
}

type ObjectValue = Record<string, unknown>;
const paths: Record<GatewayProtocol, string> = {
  anthropic: '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
};
const frameLimit = 1024 * 1024;

class GatewayError extends Error {
  public constructor(public readonly status: number, public readonly code: string, public readonly providerType?: string) { super(code); }
}

function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function onlyKeys(value: ObjectValue, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function configuration(options: GatewayOptions): {endpoint: URL; apiKey: string; tokenHash: Buffer} {
  if (!object(options) || !onlyKeys(options, ['upstream', 'runTokenEnv', 'limits', 'ledgerPath', 'host', 'port', 'maxBodyBytes', 'allowLocalhostHttp'])
    || !object(options.upstream) || !onlyKeys(options.upstream, ['baseURL', 'protocol', 'model', 'apiKeyEnv'])
    || !object(options.limits) || !onlyKeys(options.limits, ['maxRequests', 'maxTokens', 'maxOutputTokens', 'deadlineEpochMs'])) throw new Error('Invalid gateway configuration.');
  const {upstream, limits} = options;
  if (!Object.hasOwn(paths, upstream.protocol) || typeof upstream.model !== 'string' || !upstream.model.trim() || upstream.model.length > 256
    || !integer(limits.maxRequests, 1) || !integer(limits.maxTokens, 1) || !integer(limits.maxOutputTokens, 1)
    || limits.maxOutputTokens > limits.maxTokens || !integer(limits.deadlineEpochMs, 1)
    || typeof options.ledgerPath !== 'string' || !isAbsolute(options.ledgerPath)
    || (options.port !== undefined && (!integer(options.port) || options.port > 65535))
    || (options.host !== undefined && !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(options.host))
    || (options.maxBodyBytes !== undefined && (!integer(options.maxBodyBytes, 1) || options.maxBodyBytes > 16 * 1024 * 1024))
    || (options.allowLocalhostHttp !== undefined && typeof options.allowLocalhostHttp !== 'boolean')) throw new Error('Invalid gateway configuration.');
  let endpoint: URL;
  try {
    if (typeof upstream.baseURL !== 'string' || /[\s\\%?#]/u.test(upstream.baseURL) || /\/\.\.?($|\/)/u.test(upstream.baseURL)) throw new Error();
    endpoint = new URL(upstream.baseURL);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[\w/-]*$/u.test(endpoint.pathname)) throw new Error();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(options.allowLocalhostHttp === true && local && endpoint.protocol === 'http:')) throw new Error();
    if (endpoint.protocol === 'http:' && endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    const prefix = endpoint.pathname.replace(/\/+$/u, '') || '/v1';
    endpoint.pathname = prefix + paths[upstream.protocol].slice(3);
  } catch { throw new Error('Invalid trusted upstream URL.'); }
  const readSecret = (name: unknown): string => {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error('Invalid secret environment variable.');
    const value = process.env[name];
    if (!value || !/^[\x21-\x7e]+$/u.test(value) || value.length > 4096) throw new Error('Required gateway secret is unavailable.');
    return value;
  };
  const apiKey = readSecret(upstream.apiKeyEnv);
  const token = readSecret(options.runTokenEnv);
  if (token.length < 32 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token) || token === apiKey) throw new Error('Invalid temporary run token.');
  return {endpoint, apiKey, tokenHash: createHash('sha256').update(`Bearer ${token}`).digest()};
}

function validateHeaders(req: IncomingMessage, tokenHash: Buffer, path: string): void {
  const authorization = req.headers.authorization ?? '';
  if (!timingSafeEqual(createHash('sha256').update(authorization).digest(), tokenHash)) throw new GatewayError(401, 'unauthorized');
  if (req.method !== 'POST' || req.url !== path) throw new GatewayError(404, 'invalid_route');
  const allowed = new Set(['authorization', 'host', 'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language', 'sec-fetch-mode', 'user-agent', 'connection', 'transfer-encoding', 'anthropic-version']);
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (seen.has(name) || (!allowed.has(name) && !/^x-stainless-[a-z-]+$/u.test(name))) throw new GatewayError(400, 'invalid_headers');
    seen.add(name);
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')
    || (req.headers.connection && !/^(?:keep-alive|close)$/iu.test(req.headers.connection))
    || (req.headers['transfer-encoding'] && req.headers['transfer-encoding'] !== 'chunked')
    || (req.headers['anthropic-version'] && req.headers['anthropic-version'] !== '2023-06-01')) throw new GatewayError(400, 'invalid_headers');
}

function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted);
      signal.removeEventListener('abort', onAborted);
    };
    const fail = (error: GatewayError) => { cleanup(); req.pause(); reject(error); };
    const onError = () => fail(new GatewayError(400, 'invalid_body'));
    const onAborted = () => fail(new GatewayError(504, 'request_stopped'));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail(new GatewayError(413, 'body_too_large'));
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    if (signal.aborted) { onAborted(); return; }
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) { fail(new GatewayError(413, 'body_too_large')); return; }
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted);
    signal.addEventListener('abort', onAborted, {once: true});
  });
}

function prepareBody(raw: Buffer, options: GatewayOptions): Buffer {
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)); }
  catch { throw new GatewayError(400, 'invalid_body'); }
  const {protocol, model} = options.upstream;
  const common = ['model', 'stream', 'temperature', 'top_p', 'tools', 'tool_choice', 'metadata'];
  const extra: Record<GatewayProtocol, string[]> = {
    anthropic: ['messages', 'system', 'max_tokens', 'top_k', 'stop_sequences', 'thinking', 'output_config'],
    'openai-chat': ['messages', 'max_tokens', 'max_completion_tokens', 'stream_options', 'n', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'response_format', 'reasoning_effort', 'parallel_tool_calls', 'store', 'user'],
    'openai-responses': ['input', 'instructions', 'max_output_tokens', 'reasoning', 'text', 'parallel_tool_calls', 'store', 'background', 'truncation', 'user'],
  };
  if (!object(body) || !onlyKeys(body, [...common, ...extra[protocol]]) || body.stream !== true
    || (body.model !== undefined && body.model !== model) || (body.n !== undefined && body.n !== 1)
    || (body.background !== undefined && body.background !== false)) throw new GatewayError(400, 'invalid_parameters');
  const field = protocol === 'anthropic' ? 'max_tokens' : protocol === 'openai-responses' ? 'max_output_tokens' : body.max_tokens !== undefined ? 'max_tokens' : 'max_completion_tokens';
  if (protocol === 'openai-chat' && body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw new GatewayError(400, 'invalid_output_limit');
  const output = body[field] ?? options.limits.maxOutputTokens;
  if (!integer(output, 1) || output > options.limits.maxOutputTokens) throw new GatewayError(400, 'invalid_output_limit');
  if (object(body.thinking) && body.thinking.budget_tokens !== undefined && (!integer(body.thinking.budget_tokens, 1) || body.thinking.budget_tokens > output)) throw new GatewayError(400, 'invalid_output_limit');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => !object(tool)
    || (protocol === 'anthropic' ? (tool.type !== undefined && tool.type !== 'custom') || !object(tool.input_schema) : tool.type !== 'function')))) throw new GatewayError(400, 'unsupported_tools');
  const context = protocol === 'openai-responses' ? body.input : body.messages;
  if (!(Array.isArray(context) || (protocol === 'openai-responses' && typeof context === 'string'))) throw new GatewayError(400, 'invalid_parameters');
  if (Array.isArray(context) && context.some(item => !object(item) || (typeof item.role !== 'string'
    && !(protocol === 'openai-responses' && ['message', 'function_call', 'function_call_output', 'reasoning'].includes(String(item.type)))))) throw new GatewayError(400, 'unbounded_context');
  const forbidden = new Set(['image', 'image_url', 'input_image', 'input_file', 'file', 'document', 'audio', 'input_audio', 'video', 'computer_screenshot', 'item_reference', 'compaction']);
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 64) throw new GatewayError(400, 'invalid_parameters');
    if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); }
    else if (object(value)) {
      if ((typeof value.type === 'string' && forbidden.has(value.type)) || ['file_id', 'encrypted_content', 'previous_response_id', 'conversation', 'image_url', 'audio'].some(key => Object.hasOwn(value, key))) throw new GatewayError(400, 'unbounded_context');
      for (const item of Object.values(value)) inspect(item, depth + 1);
    }
  };
  inspect(context, 0);
  inspect(body.system, 0);
  body.model = model;
  body[field] = output;
  if (protocol === 'openai-chat') body.stream_options = {include_usage: true};
  if (protocol !== 'anthropic') body.store = false;
  return Buffer.from(JSON.stringify(body));
}

class SseFrames {
  #pending = '';
  #frame = '';
  #decoder = new TextDecoder('utf-8', {fatal: true});

  public push(chunk: Uint8Array, final = false): string[] {
    this.#pending += this.#decoder.decode(chunk, {stream: !final});
    const frames: string[] = [];
    let start = 0;
    const lines = /\r\n|\r|\n/gu;
    for (let match = lines.exec(this.#pending); match; match = lines.exec(this.#pending)) {
      if (!final && match[0] === '\r' && match.index + 1 === this.#pending.length) break;
      const line = this.#pending.slice(start, match.index);
      this.#frame += line + match[0];
      if (Buffer.byteLength(this.#frame) > frameLimit) throw new GatewayError(502, 'invalid_stream');
      start = lines.lastIndex;
      if (!line) { frames.push(this.#frame); this.#frame = ''; }
    }
    this.#pending = this.#pending.slice(start);
    if (Buffer.byteLength(this.#frame) + Buffer.byteLength(this.#pending) > frameLimit
      || (final && (this.#pending.trim() || this.#frame.trim()))) throw new GatewayError(502, 'invalid_stream');
    return frames;
  }
}

function sumTokens(...values: unknown[]): number | undefined {
  if (!values.every(value => integer(value))) return undefined;
  const sum = values.reduce((total, value) => total + value, 0);
  return integer(sum) ? sum : undefined;
}

class StreamUsage {
  public terminal = false;
  public failed = false;
  public errorType: string | undefined;
  #valid = true;
  #input: ObjectValue = {};
  #output: number | undefined;
  #candidate: number | undefined;
  #finishedChoice = false;
  #started = false;
  #finalDelta = false;

  public constructor(private readonly protocol: GatewayProtocol) {}

  public observe(frame: string): string | undefined {
    let event = '';
    const data: string[] = [];
    for (const line of frame.split(/\r\n|\r|\n/u)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
    }
    if (!data.length) return undefined;
    const text = data.join('\n');
    if (text === '[DONE]') {
      if (this.protocol === 'openai-chat') this.terminal = true;
      return undefined;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new GatewayError(502, 'invalid_stream'); }
    if (!object(value)) throw new GatewayError(502, 'invalid_stream');
    const type = typeof value.type === 'string' ? value.type : event;
    if (event === 'error' || type === 'error' || type === 'response.failed' || value.error != null) {
      this.failed = true;
      const error = object(value.error) ? value.error : {};
      if (typeof error.type === 'string' && ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'overloaded_error', 'api_error', 'server_error'].includes(error.type)) this.errorType = error.type;
      return type === 'response.failed' ? 'response.failed' : 'error';
    }
    if (this.terminal) this.#valid = false;
    if (this.protocol === 'anthropic') {
      if (type === 'message_start') {
        if (this.#started) this.#valid = false;
        this.#started = true;
        const usage = object(value.message) && object(value.message.usage) ? value.message.usage : {};
        this.#input = {input_tokens: usage.input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens};
      } else if (type === 'message_delta') {
        if (this.#finalDelta) this.#valid = false;
        this.#finalDelta = object(value.delta) && typeof value.delta.stop_reason === 'string' && value.delta.stop_reason.length > 0;
        const usage = object(value.usage) ? value.usage : {};
        if (this.#output !== undefined && integer(usage.output_tokens) && usage.output_tokens < this.#output) this.#valid = false;
        this.#output = integer(usage.output_tokens) ? usage.output_tokens : undefined;
        for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
          if (Object.hasOwn(usage, key)) {
            if (!integer(usage[key]) || (integer(this.#input[key]) && usage[key] < this.#input[key])) this.#valid = false;
            this.#input[key] = usage[key];
          }
        }
      } else if (type === 'message_stop') {
        this.terminal = true;
        if (this.#started && this.#finalDelta) this.#candidate = sumTokens(this.#input.input_tokens, this.#input.cache_creation_input_tokens, this.#input.cache_read_input_tokens, this.#output);
      }
    } else if (this.protocol === 'openai-chat') {
      if (this.#candidate !== undefined) this.#valid = false;
      if (Array.isArray(value.choices) && value.choices.some(choice => object(choice) && typeof choice.finish_reason === 'string')) this.#finishedChoice = true;
      if (value.usage != null) {
        if (this.#candidate !== undefined) this.#valid = false;
        const usage = object(value.usage) ? value.usage : {};
        if (this.#finishedChoice && Array.isArray(value.choices) && value.choices.length === 0) {
          this.#candidate = sumTokens(usage.prompt_tokens, usage.completion_tokens);
          if (usage.total_tokens !== undefined && usage.total_tokens !== this.#candidate) this.#valid = false;
        }
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      this.terminal = true;
      const response = object(value.response) ? value.response : {};
      const usage = object(response.usage) ? response.usage : {};
      if (response.status === type.slice('response.'.length)) this.#candidate = sumTokens(usage.input_tokens, usage.output_tokens);
      if (usage.total_tokens !== undefined && usage.total_tokens !== this.#candidate) this.#valid = false;
    }
    return undefined;
  }

  public get tokens(): number | undefined {
    return this.#valid && this.terminal && !this.failed ? this.#candidate : undefined;
  }
}

function errorPayload(protocol: GatewayProtocol, code: string, providerType?: string): ObjectValue {
  const message = 'Model gateway request failed.';
  if (protocol === 'anthropic') return {type: 'error', error: {type: providerType ?? (code === 'unauthorized' ? 'authentication_error' : 'api_error'), message}};
  if (protocol === 'openai-responses') return {type: 'error', code, message, param: null};
  return {error: {type: providerType ?? 'server_error', code, message}};
}

function sendError(res: ServerResponse, protocol: GatewayProtocol, error: GatewayError, event = 'error'): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    let payload = errorPayload(protocol, error.code, error.providerType);
    if (event === 'response.failed') payload = {type: event, response: {status: 'failed', error: {code: error.code, message: 'Model gateway request failed.'}}};
    res.end(`${protocol === 'openai-chat' ? '' : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`);
  } else {
    res.writeHead(error.status, {'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close'});
    const payload = protocol === 'openai-responses' ? {error: {type: 'server_error', code: error.code, message: 'Model gateway request failed.'}} : errorPayload(protocol, error.code);
    res.end(JSON.stringify(payload));
  }
}

function writeFrame(res: ServerResponse, frame: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed) return Promise.reject(new GatewayError(504, 'request_stopped'));
  if (res.write(frame)) return Promise.resolve();
  return new Promise((resolveWrite, reject) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); signal.removeEventListener('abort', onClose); };
    const onDrain = () => { cleanup(); resolveWrite(); };
    const onClose = () => { cleanup(); reject(new GatewayError(504, 'request_stopped')); };
    res.once('drain', onDrain); res.once('close', onClose); signal.addEventListener('abort', onClose, {once: true});
  });
}

export async function startGateway(input: GatewayOptions): Promise<GatewayHandle> {
  let options: GatewayOptions;
  try { options = structuredClone(input); } catch { throw new Error('Invalid gateway configuration.'); }
  const {endpoint, apiKey, tokenHash} = configuration(options);
  const {protocol} = options.upstream;
  const {limits} = options;
  let ledger;
  try { ledger = await open(options.ledgerPath, 'wx', 0o600); } catch { throw new Error('Cannot create a fresh gateway ledger.'); }
  const usage = {requests: 0, upstreamRequests: 0, completedRequests: 0, failedRequests: 0, activeRequests: 0, chargedTokens: 0, reservedTokens: 0, reliableUsageRequests: 0};
  let ledgerFailed = false;
  let closed = false;
  let ledgerQueue: Promise<void> = Promise.resolve();
  const controllers = new Set<AbortController>();
  const handlers = new Set<Promise<void>>();
  const snapshot = (): Readonly<GatewayUsage> => Object.freeze({...usage, totalTokens: usage.chargedTokens + usage.reservedTokens, ledgerFailed,
    exhausted: closed || ledgerFailed || Date.now() >= limits.deadlineEpochMs || usage.requests >= limits.maxRequests || usage.chargedTokens + usage.reservedTokens >= limits.maxTokens});
  const record = (entry: ObjectValue): Promise<void> => {
    const line = JSON.stringify({...entry, time: Date.now(), usage: snapshot()}) + '\n';
    const next = ledgerQueue.then(async () => {
      if (ledgerFailed) throw new GatewayError(503, 'ledger_unavailable');
      try { await ledger.writeFile(line); await ledger.sync(); }
      catch {
        ledgerFailed = true;
        for (const controller of controllers) controller.abort();
        throw new GatewayError(503, 'ledger_unavailable');
      }
    });
    ledgerQueue = next.catch(() => {});
    return next;
  };
  try { await record({type: 'start', protocol, limits}); } catch { await ledger.close(); throw new Error('Cannot initialize gateway ledger.'); }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const id = ++usage.requests;
    const controller = new AbortController();
    const {signal} = controller;
    controllers.add(controller);
    usage.activeRequests++;
    let reservation = 0;
    let sent = false;
    let tokens: number | undefined;
    let success = false;
    let outcome = 'request_failed';
    let upstream: IncomingMessage | undefined;
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    req.on('error', () => {});
    res.on('error', () => controller.abort());
    try {
      if (closed || Date.now() >= limits.deadlineEpochMs) throw new GatewayError(504, 'deadline_exceeded');
      if (ledgerFailed) throw new GatewayError(503, 'ledger_unavailable');
      if (id > limits.maxRequests) throw new GatewayError(429, 'request_budget_exceeded');
      validateHeaders(req, tokenHash, paths[protocol]);
      const raw = await readBody(req, options.maxBodyBytes ?? 1024 * 1024, signal);
      const body = prepareBody(raw, options);
      if (body.length > (options.maxBodyBytes ?? 1024 * 1024)) throw new GatewayError(413, 'body_too_large');
      const amount = Math.max(raw.length, body.length) + limits.maxOutputTokens;
      if (signal.aborted || Date.now() >= limits.deadlineEpochMs) throw new GatewayError(504, 'deadline_exceeded');
      if (amount > limits.maxTokens - usage.chargedTokens - usage.reservedTokens) throw new GatewayError(429, 'token_budget_exceeded');
      reservation = amount;
      usage.reservedTokens += reservation;
      await record({type: 'reserve', id, reservedTokens: reservation});
      if (signal.aborted || closed || Date.now() >= limits.deadlineEpochMs) throw new GatewayError(504, 'deadline_exceeded');
      const headers: Record<string, string | number> = {'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity', 'content-length': body.length};
      if (protocol === 'anthropic') { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
      else headers.authorization = `Bearer ${apiKey}`;
      usage.upstreamRequests++;
      sent = true;
      upstream = await new Promise<IncomingMessage>((resolveResponse, reject) => {
        const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {method: 'POST', headers, signal, agent: false, rejectUnauthorized: true}, resolveResponse);
        request.once('error', () => reject(new GatewayError(502, 'upstream_unavailable')));
        request.end(body);
      });
      const status = upstream.statusCode ?? 502;
      if (status !== 200) throw new GatewayError(status >= 400 && status <= 599 ? status : 502, 'upstream_error');
      if (!/^text\/event-stream(?:\s*;.*)?$/iu.test(upstream.headers['content-type'] ?? '')
        || (upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity')) throw new GatewayError(502, 'invalid_stream');
      res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no'});
      res.flushHeaders();
      const parser = new SseFrames();
      const tracker = new StreamUsage(protocol);
      const forward = async (frames: string[]) => {
        for (const frame of frames) {
          if (signal.aborted || Date.now() >= limits.deadlineEpochMs) throw new GatewayError(504, 'deadline_exceeded');
          const errorEvent = tracker.observe(frame);
          if (errorEvent) {
            sendError(res, protocol, new GatewayError(502, 'upstream_error', tracker.errorType), errorEvent);
            throw new GatewayError(502, 'upstream_error');
          }
          if (frame.includes(apiKey)) throw new GatewayError(502, 'invalid_stream');
          await writeFrame(res, frame, signal);
        }
      };
      for await (const chunk of upstream) await forward(parser.push(chunk as Buffer));
      await forward(parser.push(new Uint8Array(), true));
      if (signal.aborted || Date.now() >= limits.deadlineEpochMs) throw new GatewayError(504, 'deadline_exceeded');
      if (!tracker.terminal) throw new GatewayError(502, 'incomplete_stream');
      tokens = tracker.tokens;
      success = true;
      outcome = 'completed';
    } catch (error) {
      const failure = ledgerFailed ? new GatewayError(503, 'ledger_unavailable') : signal.aborted ? new GatewayError(504, 'request_stopped') : error instanceof GatewayError ? error : new GatewayError(502, 'upstream_unavailable');
      outcome = failure.code;
      sendError(res, protocol, failure);
    } finally {
      upstream?.destroy();
      controller.abort();
      usage.reservedTokens -= reservation;
      usage.chargedTokens += sent ? tokens ?? reservation : 0;
      if (tokens !== undefined) usage.reliableUsageRequests++;
      if (success) usage.completedRequests++; else usage.failedRequests++;
      usage.activeRequests--;
      controllers.delete(controller);
      res.off('close', onClose);
      try { await record({type: 'settle', id, outcome, source: !sent ? 'not_sent' : tokens === undefined ? 'reservation' : 'provider', chargedTokens: sent ? tokens ?? reservation : 0}); }
      catch { sendError(res, protocol, new GatewayError(503, 'ledger_unavailable')); }
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  };
  const dispatch = (req: IncomingMessage, res: ServerResponse) => {
    const task = handle(req, res).catch(() => { res.destroy(); });
    handlers.add(task);
    void task.finally(() => handlers.delete(task));
  };
  const server = createServer({maxHeaderSize: 16 * 1024, requestTimeout: 0, headersTimeout: 10_000}, dispatch);
  server.on('checkContinue', dispatch);
  server.on('checkExpectation', dispatch);
  server.on('connect', (_req, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
    });
  } catch { await ledger.close(); throw new Error('Cannot listen for gateway requests.'); }
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const checkDeadline = () => {
    const remaining = limits.deadlineEpochMs - Date.now();
    if (remaining <= 0) { for (const controller of controllers) controller.abort(); server.closeIdleConnections(); }
    else { deadlineTimer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647)); deadlineTimer.unref(); }
  };
  checkDeadline();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      clearTimeout(deadlineTimer);
      const stopped = new Promise<void>(resolveClose => { server.close(() => resolveClose()); });
      for (const controller of controllers) controller.abort();
      await Promise.all([...handlers]);
      server.closeAllConnections();
      await stopped;
      try { await record({type: 'close'}); } catch { ledgerFailed = true; }
      await ledger.close();
    })();
    return closing;
  };
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Cannot determine gateway address.'); }
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return {url: `http://${host}:${address.port}`, get usage() { return snapshot(); }, close};
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: tsx evaluation/RSI/model_gateway.ts --config /absolute/config.json');
  let config: GatewayOptions;
  try { config = JSON.parse(await readFile(resolve(process.argv[3]!), 'utf8')) as GatewayOptions; }
  catch { throw new Error('Cannot read gateway configuration.'); }
  const gateway = await startGateway(config);
  process.stdout.write(JSON.stringify({url: gateway.url}) + '\n');
  const stop = () => { void gateway.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { process.stderr.write('Model gateway startup failed.\n'); process.exitCode = 1; });
}

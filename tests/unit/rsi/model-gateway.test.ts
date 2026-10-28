import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, open, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer, request} from 'node:http';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {startGateway} from '../../../evaluation/RSI/model_gateway.js';
import type {GatewayHandle, GatewayOptions, GatewayProtocol} from '../../../evaluation/RSI/model_gateway.js';

const apiKey = 'upstream-secret-probe-never-expose-this';
const runToken = 'temporary-run-bearer-token-at-least-32-bytes';
const paths: Record<GatewayProtocol, string> = {anthropic: '/v1/messages', 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses'};
const protocols: GatewayProtocol[] = ['anthropic', 'openai-chat', 'openai-responses'];
let directory: string;
let sequence = 0;
const gateways: GatewayHandle[] = [];
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bitori-gateway-'));
  vi.stubEnv('GATEWAY_TEST_API_KEY', apiKey);
  vi.stubEnv('GATEWAY_TEST_RUN_TOKEN', runToken);
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.unstubAllEnvs();
  await rm(directory, {recursive: true, force: true});
});

function frame(value: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
}

function stream(protocol: GatewayProtocol, includeUsage = true): string {
  if (protocol === 'anthropic') return [
    frame({type: 'message_start', message: {id: 'm', usage: includeUsage ? {input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, cache_creation: {ephemeral_5m_input_tokens: 20}} : {}}}, 'message_start'),
    frame({type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'tool-1', name: 'read_file', input: {}}}, 'content_block_start'),
    frame({type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"path":"你好"}'}}, 'content_block_delta'),
    frame({type: 'content_block_stop', index: 0}, 'content_block_stop'),
    frame({type: 'message_delta', delta: {stop_reason: 'tool_use'}, ...(includeUsage ? {usage: {output_tokens: 7}} : {})}, 'message_delta'),
    frame({type: 'message_stop'}, 'message_stop'),
  ].join('');
  if (protocol === 'openai-chat') return [
    frame({choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'tool-1', type: 'function', function: {name: 'read_file', arguments: '{"path":"你好"}'}}]}, finish_reason: null}]}),
    frame({choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]}),
    includeUsage ? frame({choices: [], usage: {prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, prompt_tokens_details: {cached_tokens: 8}, completion_tokens_details: {reasoning_tokens: 5}}}) : '',
    'data: [DONE]\n\n',
  ].join('');
  return [
    frame({type: 'response.output_item.added', output_index: 0, item: {id: 'item-1', type: 'function_call', name: 'read_file', call_id: 'tool-1'}}, 'response.output_item.added'),
    frame({type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"你好"}'}, 'response.function_call_arguments.delta'),
    frame({type: 'response.output_item.done', output_index: 0, item: {id: 'item-1', type: 'function_call', name: 'read_file', call_id: 'tool-1'}}, 'response.output_item.done'),
    frame({type: 'response.completed', response: {status: 'completed', ...(includeUsage ? {usage: {input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: {cached_tokens: 8}, output_tokens_details: {reasoning_tokens: 5}}} : {})}}, 'response.completed'),
  ].join('');
}

function body(protocol: GatewayProtocol, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {model: 'fixed-model', stream: true, ...(protocol === 'openai-responses' ? {input: [{role: 'user', content: '你好'}]} : {messages: [{role: 'user', content: '你好'}]}), ...extra};
}

async function fake(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fake server address');
  return `http://127.0.0.1:${address.port}`;
}

function options(baseURL: string, protocol: GatewayProtocol, overrides: Partial<GatewayOptions> = {}): GatewayOptions {
  return {
    upstream: {baseURL, protocol, model: 'fixed-model', apiKeyEnv: 'GATEWAY_TEST_API_KEY'},
    runTokenEnv: 'GATEWAY_TEST_RUN_TOKEN',
    limits: {maxRequests: 20, maxTokens: 100_000, maxOutputTokens: 100, deadlineEpochMs: Date.now() + 10_000},
    ledgerPath: join(directory, `ledger-${++sequence}.jsonl`),
    allowLocalhostHttp: true,
    ...overrides,
  };
}

async function start(config: GatewayOptions): Promise<GatewayHandle> {
  const gateway = await startGateway(config);
  gateways.push(gateway);
  return gateway;
}

async function post(gateway: GatewayHandle, protocol: GatewayProtocol, value = body(protocol)): Promise<{status: number; text: string; headers: Headers}> {
  const response = await fetch(gateway.url + paths[protocol], {method: 'POST', headers: {authorization: `Bearer ${runToken}`, 'content-type': 'application/json'}, body: JSON.stringify(value)});
  return {status: response.status, text: await response.text(), headers: response.headers};
}

async function rawPost(gateway: GatewayHandle, path: string, headers: Record<string, string | string[]>, payload = '{}', method = 'POST'): Promise<{status: number; text: string}> {
  return new Promise((resolveResponse, reject) => {
    const req = request(gateway.url, {method, path, headers: {authorization: `Bearer ${runToken}`, 'content-type': 'application/json', ...headers}}, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolveResponse({status: res.statusCode ?? 0, text}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function collect(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function settled(gateway: GatewayHandle): Promise<void> {
  await vi.waitFor(() => expect(gateway.usage.activeRequests).toBe(0), {interval: 5});
}

function reservationLine(text: string): {reservedTokens: number} {
  return text.trim().split('\n').map(line => JSON.parse(line) as {type: string; reservedTokens: number}).find(entry => entry.type === 'reserve')!;
}

describe('trusted RSI model gateway', () => {
  it.each(protocols)('streams %s tool events and reconciles protocol-specific final usage', async protocol => {
    let received: Record<string, unknown> = {};
    let headers: IncomingMessage['headers'] = {};
    let upstreamPath: string | undefined;
    const output = stream(protocol).replaceAll('\n', '\r\n');
    const baseURL = await fake((req, res) => {
      void collect(req).then(raw => {
        received = JSON.parse(raw.toString()) as Record<string, unknown>;
        headers = req.headers; upstreamPath = req.url;
        res.writeHead(200, {'content-type': 'text/event-stream', 'x-secret': apiKey});
        const bytes = Buffer.from(output);
        const split = bytes.indexOf(Buffer.from('你')) + 1;
        res.write(bytes.subarray(0, split));
        setImmediate(() => res.end(bytes.subarray(split)));
      });
    });
    const config = options(baseURL + '/v1/', protocol);
    const gateway = await start(config);
    const before = gateway.usage;
    const result = await post(gateway, protocol);
    expect(result.status).toBe(200);
    expect(result.text).toBe(output);
    expect(result.headers.get('x-secret')).toBeNull();
    expect(upstreamPath).toBe(paths[protocol]);
    expect(headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization']).toBe(protocol === 'anthropic' ? apiKey : `Bearer ${apiKey}`);
    expect(JSON.stringify(headers)).not.toContain(runToken);
    expect(received.model).toBe('fixed-model');
    expect(received[protocol === 'anthropic' ? 'max_tokens' : protocol === 'openai-chat' ? 'max_completion_tokens' : 'max_output_tokens']).toBe(100);
    if (protocol === 'openai-chat') expect(received.stream_options).toEqual({include_usage: true});
    if (protocol !== 'anthropic') expect(received.store).toBe(false);
    await settled(gateway);
    expect(gateway.usage).toMatchObject({requests: 1, upstreamRequests: 1, completedRequests: 1, failedRequests: 0, chargedTokens: protocol === 'anthropic' ? 67 : 17, reservedTokens: 0, reliableUsageRequests: 1});
    expect(before.requests).toBe(0);
    expect(Object.isFrozen(gateway.usage)).toBe(true);
    await gateway.close();
    const ledger = await readFile(config.ledgerPath, 'utf8');
    expect(ledger).not.toContain(apiKey);
    expect(ledger).not.toContain(runToken);
    expect(ledger).not.toContain('你好');
    expect(ledger).not.toContain('read_file');
    if (process.platform !== 'win32') expect((await stat(config.ledgerPath)).mode & 0o777).toBe(0o600);
    expect(reservationLine(ledger).reservedTokens).toBeGreaterThan(Buffer.byteLength(JSON.stringify(body(protocol))) + 100);
  });

  it.each(protocols)('keeps the entire UTF-8 reservation when %s final usage is absent', async protocol => {
    let bytes = 0;
    const baseURL = await fake((req, res) => {
      void collect(req).then(raw => { bytes = raw.length; res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream(protocol, false)); });
    });
    const config = options(baseURL, protocol);
    const gateway = await start(config);
    const result = await post(gateway, protocol);
    expect(result.status).toBe(200);
    expect(result.text).toBe(stream(protocol, false));
    await settled(gateway);
    expect(gateway.usage).toMatchObject({chargedTokens: bytes + 100, reliableUsageRequests: 0});
    await gateway.close();
    expect(reservationLine(await readFile(config.ledgerPath, 'utf8')).reservedTokens).toBe(bytes + 100);
  });

  it('reserves original whitespace and UTF-8 bytes rather than JS characters', async () => {
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream('openai-chat', false)); });
    const gateway = await start(options(baseURL, 'openai-chat'));
    const raw = JSON.stringify(body('openai-chat', {messages: [{role: 'user', content: '你好'.repeat(20)}]}), null, 8) + ' '.repeat(200);
    expect((await rawPost(gateway, paths['openai-chat'], {}, raw)).status).toBe(200);
    await settled(gateway);
    expect(gateway.usage.chargedTokens).toBe(Buffer.byteLength(raw) + 100);
    expect(gateway.usage.chargedTokens).toBeGreaterThan(raw.length + 100);
  });

  it('merges cumulative Anthropic final input/cache counts without counting cache detail twice', async () => {
    const output = stream('anthropic').replace('"usage":{"output_tokens":7}', '"usage":{"input_tokens":11,"cache_creation_input_tokens":22,"cache_read_input_tokens":33,"output_tokens":7}');
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(output); });
    const gateway = await start(options(baseURL, 'anthropic'));
    await post(gateway, 'anthropic');
    await settled(gateway);
    expect(gateway.usage.chargedTokens).toBe(73);
  });

  it.each([
    ['anthropic', stream('anthropic').replace('"input_tokens":10', '"input_tokens":null')],
    ['anthropic', stream('anthropic').replace('"cache_read_input_tokens":30', '"cache_read_input_tokens":null')],
    ['anthropic', stream('anthropic').replace('"output_tokens":7', '"output_tokens":-1')],
    ['openai-chat', stream('openai-chat').replace('"total_tokens":17', '"total_tokens":1')],
    ['openai-chat', stream('openai-chat').replace('"completion_tokens":7', '"completion_tokens":1.5')],
    ['openai-responses', stream('openai-responses').replace('"input_tokens":10', '"input_tokens":"10"')],
    ['openai-responses', stream('openai-responses').replace('"status":"completed"', '"status":"in_progress"')],
  ] as [GatewayProtocol, string][])('does not refund malformed/inconsistent %s usage', async (protocol, output) => {
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(output); });
    const gateway = await start(options(baseURL, protocol));
    await post(gateway, protocol);
    await settled(gateway);
    expect(gateway.usage.reliableUsageRequests).toBe(0);
    expect(gateway.usage.chargedTokens).toBeGreaterThan(100);
  });

  it.each(protocols)('requires the %s terminal event before refunding any usage', async protocol => {
    let output = stream(protocol);
    if (protocol === 'anthropic') output = output.replace(frame({type: 'message_stop'}, 'message_stop'), '');
    else if (protocol === 'openai-chat') output = output.replace('data: [DONE]\n\n', '');
    else output = output.replaceAll('response.completed', 'response.in_progress').replace('"status":"completed"', '"status":"in_progress"');
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(output); });
    const gateway = await start(options(baseURL, protocol));
    const result = await post(gateway, protocol);
    expect(result.text).toContain('error');
    await settled(gateway);
    expect(gateway.usage).toMatchObject({reliableUsageRequests: 0, failedRequests: 1});
    expect(gateway.usage.chargedTokens).toBeGreaterThan(100);
  });

  it('accepts reliable Responses incomplete usage including reasoning tokens only once', async () => {
    const output = stream('openai-responses').replaceAll('response.completed', 'response.incomplete').replace('"status":"completed"', '"status":"incomplete"');
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(output); });
    const gateway = await start(options(baseURL, 'openai-responses'));
    expect((await post(gateway, 'openai-responses')).text).toBe(output);
    await settled(gateway);
    expect(gateway.usage.chargedTokens).toBe(17);
  });

  it('authenticates only the exact bearer token and rejects duplicate credentials', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const gateway = await start(options(await fake(upstream), 'openai-chat'));
    for (const headers of [{authorization: ''}, {authorization: `Bearer ${apiKey}`}, {authorization: `Bearer ${runToken}x`}, {authorization: [`Bearer ${runToken}`, `Bearer ${runToken}`]}, {'x-api-key': runToken, authorization: ''}]) {
      const result = await rawPost(gateway, paths['openai-chat'], headers);
      expect([400, 401]).toContain(result.status);
      expect(result.text).not.toContain(apiKey);
      expect(result.text).not.toContain(runToken);
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(gateway.usage.requests).toBe(5);
  });

  it.each([
    ['/v1/chat/completions?upstream=https://evil.invalid', {}],
    ['http://evil.invalid/v1/chat/completions', {}],
    ['/v1/../v1/chat/completions', {}],
    ['/v1/%63hat/completions', {}],
    ['/v1/chat/completions/', {}],
    ['/v1/responses', {}],
    ['/v1/chat/completions', {'x-api-key': apiKey}],
    ['/v1/chat/completions', {'x-upstream-url': 'https://evil.invalid'}],
    ['/v1/chat/completions', {forwarded: 'host=evil.invalid'}],
    ['/v1/chat/completions', {'proxy-authorization': 'anything'}],
    ['/v1/chat/completions', {connection: 'authorization'}],
    ['/v1/chat/completions', {'content-encoding': 'gzip'}],
    ['/v1/chat/completions', {'anthropic-beta': 'untrusted-extension'}],
  ] as [string, Record<string, string>][])('rejects malicious route/header %s %j', async (path, headers) => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const gateway = await start(options(await fake(upstream), 'openai-chat'));
    expect([400, 404]).toContain((await rawPost(gateway, path, headers)).status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects non-POST, CONNECT, upgrades and Expect without tunneling', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const gateway = await start(options(await fake(upstream), 'openai-chat'));
    expect((await rawPost(gateway, paths['openai-chat'], {}, '', 'GET')).status).toBe(404);
    expect((await rawPost(gateway, paths['openai-chat'], {expect: '100-continue'})).status).toBe(400);
    const address = new URL(gateway.url);
    for (const first of ['CONNECT evil.invalid:443 HTTP/1.1', 'GET /v1/chat/completions HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket']) {
      const socket = connect(Number(address.port), address.hostname);
      let text = '';
      socket.setEncoding('utf8'); socket.on('data', (chunk: string) => { text += chunk; });
      socket.end(`${first}\r\nHost: localhost\r\n\r\n`);
      await once(socket, 'close');
      expect(text).toMatch(/HTTP\/1.1 (400|405)/u);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['openai-chat', {model: 'unapproved-model'}], ['openai-chat', {stream: false}], ['openai-chat', {n: 2}],
    ['openai-chat', {max_tokens: 101}], ['openai-chat', {max_completion_tokens: 101}], ['openai-chat', {max_tokens: 1, max_completion_tokens: 1}],
    ['openai-chat', {baseURL: 'https://evil.invalid'}], ['openai-chat', {tools: [{type: 'web_search'}]}],
    ['anthropic', {max_tokens: -1}], ['anthropic', {max_tokens: 1.5}], ['anthropic', {thinking: {type: 'enabled', budget_tokens: 101}}],
    ['anthropic', {tools: [{type: 'web_search_20250305', name: 'web_search'}]}],
    ['anthropic', {messages: [{role: 'user', content: [{type: 'document', source: {type: 'url', url: 'https://evil.invalid'}}]}]}],
    ['openai-responses', {max_output_tokens: 101}], ['openai-responses', {previous_response_id: 'unbounded-history'}],
    ['openai-responses', {background: true}], ['openai-responses', {input: [{id: 'hidden-history'}]}],
    ['openai-responses', {input: [{role: 'user', content: [{type: 'input_image', image_url: 'https://evil.invalid'}]}]}],
  ] as [GatewayProtocol, Record<string, unknown>][])('enforces fixed model, output and bounded context for %s %j', async (protocol, parameters) => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const gateway = await start(options(await fake(upstream), protocol));
    expect((await post(gateway, protocol, body(protocol, parameters))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(gateway.usage.chargedTokens).toBe(0);
    expect(gateway.usage.requests).toBe(1);
  });

  it('caps declared and chunked bodies and rejects malformed JSON', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const gateway = await start(options(await fake(upstream), 'openai-chat', {maxBodyBytes: 256}));
    expect((await rawPost(gateway, paths['openai-chat'], {'content-length': '1000'}, 'x'.repeat(1000))).status).toBe(413);
    expect((await rawPost(gateway, paths['openai-chat'], {'transfer-encoding': 'chunked'}, 'x'.repeat(1000))).status).toBe(413);
    expect((await rawPost(gateway, paths['openai-chat'], {}, '{invalid-json')).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('serializes simultaneous token reservations before any upstream work', async () => {
    const held: ServerResponse[] = [];
    const baseURL = await fake((_req, res) => { held.push(res); });
    const config = options(baseURL, 'openai-chat');
    config.limits.maxTokens = 400;
    const gateway = await start(config);
    const pending = Array.from({length: 6}, () => post(gateway, 'openai-chat'));
    await vi.waitFor(() => expect(held).toHaveLength(1), {interval: 5});
    await vi.waitFor(() => expect(gateway.usage.failedRequests).toBe(5), {interval: 5});
    expect(gateway.usage.totalTokens).toBeLessThanOrEqual(400);
    expect(gateway.usage.reservedTokens).toBeGreaterThan(100);
    expect(gateway.usage.upstreamRequests).toBe(1);
    const admissionLedger = await readFile(config.ledgerPath, 'utf8');
    expect(reservationLine(admissionLedger).reservedTokens).toBe(gateway.usage.reservedTokens);
    held[0]!.writeHead(200, {'content-type': 'text/event-stream'}); held[0]!.end(stream('openai-chat'));
    const results = await Promise.all(pending);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.status === 429)).toHaveLength(5);
    await settled(gateway);
    expect(gateway.usage.chargedTokens).toBe(17);
  });

  it('counts failed upstream requests and all denials against the request limit', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.writeHead(500); res.end(apiKey); });
    const config = options(await fake(upstream), 'openai-chat');
    config.limits.maxRequests = 2;
    const gateway = await start(config);
    const results = await Promise.all(Array.from({length: 5}, () => post(gateway, 'openai-chat')));
    expect(results.filter(result => result.status === 500)).toHaveLength(2);
    expect(results.filter(result => result.status === 429)).toHaveLength(3);
    expect(results.every(result => !result.text.includes(apiKey))).toBe(true);
    await settled(gateway);
    expect(gateway.usage).toMatchObject({requests: 5, upstreamRequests: 2, failedRequests: 5, exhausted: true});
    expect(gateway.usage.chargedTokens).toBeGreaterThan(200);
  });

  it('does not follow redirects or expose upstream headers/errors', async () => {
    const target = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const targetURL = await fake(target);
    const baseURL = await fake((_req, res) => { res.writeHead(307, {location: targetURL, 'set-cookie': apiKey}); res.end(apiKey); });
    const gateway = await start(options(baseURL, 'openai-chat'));
    const result = await post(gateway, 'openai-chat');
    expect(result.status).toBe(502);
    expect(result.text).not.toContain(apiKey);
    expect(result.headers.get('location')).toBeNull();
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(target).not.toHaveBeenCalled();
    await settled(gateway);
    expect(gateway.usage.chargedTokens).toBeGreaterThan(100);
  });

  it.each(protocols)('preserves %s SSE error semantics while removing upstream secrets', async protocol => {
    const event = protocol === 'openai-responses' ? 'response.failed' : 'error';
    const data = protocol === 'openai-chat' ? {error: {message: apiKey}} : {type: event, error: {message: apiKey}};
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(frame(data, event) + stream(protocol)); });
    const gateway = await start(options(baseURL, protocol));
    const result = await post(gateway, protocol);
    expect(result.status).toBe(200);
    expect(result.text).not.toContain(apiKey);
    expect(result.text).not.toContain('[DONE]');
    expect(result.text).not.toContain('read_file');
    if (protocol !== 'openai-chat') expect(result.text).toContain(`event: ${event}`);
    expect(result.text).toContain('error');
    await settled(gateway);
    expect(gateway.usage).toMatchObject({reliableUsageRequests: 0, failedRequests: 1});
  });

  it.each(['before_headers', 'during_stream', 'during_body'] as const)('enforces the hard deadline %s', async phase => {
    let upstreamClosed = false;
    const baseURL = await fake((_req, res) => {
      res.on('close', () => { upstreamClosed = true; });
      if (phase === 'during_stream') { res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(': waiting\n\n'); }
    });
    const config = options(baseURL, 'openai-chat');
    config.limits.deadlineEpochMs = Date.now() + 200;
    const gateway = await start(config);
    let result: {status: number; text: string};
    if (phase === 'during_body') {
      result = await new Promise((resolveResponse, reject) => {
        const req = request(gateway.url + paths['openai-chat'], {method: 'POST', headers: {authorization: `Bearer ${runToken}`, 'content-type': 'application/json', 'content-length': 100}}, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { text += chunk; });
          res.on('end', () => { req.destroy(); resolveResponse({status: res.statusCode ?? 0, text}); });
        });
        req.on('error', reject); req.write('{');
      });
    } else result = await post(gateway, 'openai-chat');
    expect(result.status).toBe(phase === 'during_stream' ? 200 : 504);
    expect(result.text).toContain('request_stopped');
    await settled(gateway);
    expect(gateway.usage.reservedTokens).toBe(0);
    if (phase === 'during_body') expect(gateway.usage.chargedTokens).toBe(0);
    if (phase !== 'during_body') {
      expect(gateway.usage.chargedTokens).toBeGreaterThan(100);
      await vi.waitFor(() => expect(upstreamClosed).toBe(true), {interval: 5});
    }
    expect((await post(gateway, 'openai-chat')).status).toBe(504);
  });

  it('aborts upstream on client disconnect and close is idempotent with active streams', async () => {
    let upstreamClosed = 0;
    const baseURL = await fake((_req, res) => { res.on('close', () => upstreamClosed++); res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(': started\n\n'); });
    const gateway = await start(options(baseURL, 'openai-chat'));
    const abort = new AbortController();
    const response = await fetch(gateway.url + paths['openai-chat'], {method: 'POST', headers: {authorization: `Bearer ${runToken}`, 'content-type': 'application/json'}, body: JSON.stringify(body('openai-chat')), signal: abort.signal});
    await response.body!.getReader().read();
    abort.abort();
    await settled(gateway);
    await vi.waitFor(() => expect(upstreamClosed).toBe(1), {interval: 5});
    expect(gateway.usage.chargedTokens).toBeGreaterThan(100);
    const pending = post(gateway, 'openai-chat');
    await vi.waitFor(() => expect(gateway.usage.upstreamRequests).toBe(2), {interval: 5});
    await Promise.all([gateway.close(), gateway.close()]);
    expect((await pending).text).toContain('request_stopped');
    expect(gateway.usage).toMatchObject({activeRequests: 0, reservedTokens: 0, exhausted: true});
  });

  it('bounds SSE frames and never treats an oversized frame as reliable usage', async () => {
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end('data: ' + 'x'.repeat(1024 * 1024 + 1)); });
    const gateway = await start(options(baseURL, 'openai-chat'));
    const result = await post(gateway, 'openai-chat');
    expect(result.text).toContain('invalid_stream');
    expect(result.text.length).toBeLessThan(1000);
    await settled(gateway);
    expect(gateway.usage.reliableUsageRequests).toBe(0);
  });

  it('allows configured path prefixes but never accepts caller overrides', async () => {
    let path: string | undefined;
    const baseURL = await fake((req, res) => { path = req.url; res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream('openai-chat')); });
    const config = options(baseURL + '/trusted/v2', 'openai-chat');
    const gateway = await start(config);
    config.upstream.model = 'mutated-after-start';
    config.limits.maxRequests = 0;
    expect((await post(gateway, 'openai-chat')).status).toBe(200);
    expect(path).toBe('/trusted/v2/chat/completions');
  });

  it.each([
    ['http://example.com', true], ['http://127.0.0.1', false], ['http://localhost.evil.invalid', true],
    ['https://user:password@example.com', false], ['https://example.com/?key=secret', false],
    ['https://example.com/#fragment', false], ['https://example.com/a/../b', false], ['file:///tmp/upstream', true],
  ] as [string, boolean][])('rejects untrusted upstream configuration %s', async (baseURL, allowLocalhostHttp) => {
    await expect(startGateway(options(baseURL, 'openai-chat', {allowLocalhostHttp}))).rejects.toThrow('Invalid trusted upstream URL.');
  });

  it('requires env-only secrets, sufficiently long distinct run tokens and a fresh ledger', async () => {
    const config = options('https://example.com/v1', 'openai-chat');
    await expect(startGateway({...config, upstream: {...config.upstream, apiKey} as GatewayOptions['upstream']})).rejects.toThrow('Invalid gateway configuration.');
    vi.stubEnv('GATEWAY_TEST_API_KEY', '');
    await expect(startGateway(config)).rejects.toThrow('Required gateway secret is unavailable.');
    vi.stubEnv('GATEWAY_TEST_API_KEY', apiKey);
    vi.stubEnv('GATEWAY_TEST_RUN_TOKEN', 'short');
    await expect(startGateway(config)).rejects.toThrow('Invalid temporary run token.');
    vi.stubEnv('GATEWAY_TEST_RUN_TOKEN', apiKey);
    await expect(startGateway(config)).rejects.toThrow('Invalid temporary run token.');
    vi.stubEnv('GATEWAY_TEST_RUN_TOKEN', runToken);
    const gateway = await start(config);
    await gateway.close();
    await expect(startGateway(config)).rejects.toThrow('Cannot create a fresh gateway ledger.');
  });

  it.each(protocols)('allows bounded custom function tools and smaller output limits for %s', async protocol => {
    let received: Record<string, unknown> = {};
    const baseURL = await fake((req, res) => {
      void collect(req).then(raw => { received = JSON.parse(raw.toString()) as Record<string, unknown>; res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream(protocol)); });
    });
    const gateway = await start(options(baseURL, protocol));
    const schema = {type: 'object', properties: {audio: {type: 'string'}}};
    const tools = protocol === 'anthropic' ? [{name: 'read_file', input_schema: schema}] : protocol === 'openai-chat' ? [{type: 'function', function: {name: 'read_file', parameters: schema}}] : [{type: 'function', name: 'read_file', parameters: schema}];
    const outputField = protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
    const result = await post(gateway, protocol, body(protocol, {tools, [outputField]: 20}));
    expect(result.status).toBe(200);
    expect(received.tools).toEqual(tools);
    expect(received[outputField]).toBe(20);
  });

  it('retains missing-usage charges and refuses subsequent calls that cannot reserve enough', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream('openai-chat', false)); });
    const config = options(await fake(upstream), 'openai-chat');
    config.limits.maxTokens = 400;
    const gateway = await start(config);
    expect((await post(gateway, 'openai-chat')).status).toBe(200);
    expect((await post(gateway, 'openai-chat')).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(gateway.usage.chargedTokens).toBeGreaterThan(200);
  });

  it('makes reliable refunds available for later reservations without refunding request count', async () => {
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream('openai-chat')); });
    const config = options(baseURL, 'openai-chat');
    config.limits.maxTokens = 400;
    config.limits.maxRequests = 2;
    const gateway = await start(config);
    expect((await post(gateway, 'openai-chat')).status).toBe(200);
    expect((await post(gateway, 'openai-chat')).status).toBe(200);
    expect((await post(gateway, 'openai-chat')).status).toBe(429);
    expect(gateway.usage).toMatchObject({chargedTokens: 34, requests: 3, upstreamRequests: 2});
  });

  it('fails closed before contacting upstream if durable ledger accounting fails', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const gateway = await start(options(await fake(upstream), 'openai-chat'));
    const probe = await open(join(directory, 'file-handle-probe'), 'wx');
    const prototype = Object.getPrototypeOf(probe) as {sync(): Promise<void>};
    const sync = vi.spyOn(prototype, 'sync').mockRejectedValueOnce(new Error(apiKey));
    try {
      const result = await post(gateway, 'openai-chat');
      expect(result.status).toBe(503);
      expect(result.text).not.toContain(apiKey);
      expect((await post(gateway, 'openai-chat')).status).toBe(503);
      await settled(gateway);
      expect(gateway.usage).toMatchObject({ledgerFailed: true, exhausted: true, reservedTokens: 0, chargedTokens: 0});
      expect(upstream).not.toHaveBeenCalled();
    } finally { sync.mockRestore(); await probe.close(); }
  });

  it('preserves safe Anthropic overload classification while replacing error messages', async () => {
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(frame({type: 'error', error: {type: 'overloaded_error', message: apiKey}}, 'error')); });
    const gateway = await start(options(baseURL, 'anthropic'));
    const result = await post(gateway, 'anthropic');
    expect(result.text).toContain('overloaded_error');
    expect(result.text).not.toContain(apiKey);
  });

  it('rejects an already expired run without contacting upstream', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
    const config = options(await fake(upstream), 'openai-chat');
    config.limits.deadlineEpochMs = Date.now() - 1;
    const gateway = await start(config);
    expect((await post(gateway, 'openai-chat')).status).toBe(504);
    expect(gateway.usage.exhausted).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('runs the --config CLI through installed tsx and shuts down without logging secrets', async () => {
    const baseURL = await fake((_req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(stream('openai-chat')); });
    const config = options(baseURL, 'openai-chat');
    const configPath = join(directory, 'gateway.json');
    await writeFile(configPath, JSON.stringify(config), {mode: 0o600});
    const source = fileURLToPath(new URL('../../../evaluation/RSI/model_gateway.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', source, '--config', configPath], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(() => expect(stdout).toContain('\n'), {timeout: 5000, interval: 10});
      const {url} = JSON.parse(stdout.trim()) as {url: string};
      const result = await fetch(url + paths['openai-chat'], {method: 'POST', headers: {authorization: `Bearer ${runToken}`, 'content-type': 'application/json'}, body: JSON.stringify(body('openai-chat'))});
      expect(await result.text()).toBe(stream('openai-chat'));
      child.kill('SIGTERM');
      const [code] = await exited;
      if (process.platform !== 'win32') expect(code).toBe(0);
      expect(stdout + stderr).not.toContain(apiKey);
      expect(stdout + stderr).not.toContain(runToken);
      expect(stderr).toBe('');
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    }
  });
});

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ProviderProfile} from '../../src/config/types.js';

export const qoderProfile: ProviderProfile = {
  name: 'qoder', protocol: 'qoder', model: 'DeepSeek-Flash',
  baseUrl: 'https://api.qoder.com.cn', apiKey: 'pt-test', thinking: {type: 'disabled'},
};

const fixtureDir = join(import.meta.dirname, '..', 'fixtures', 'streams', 'qoder');

/** tests/fixtures/streams/qoder 下的脱敏真实录制(来源:tests/acceptance/qoder-capture.ts)。 */
export function qoderFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

export function qoderFixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Record<string, unknown>;
}

export function sse(frames: Array<{event: string; id?: string; data: unknown}>): string {
  return frames.map(frame => {
    const lines = [];
    if (frame.id) lines.push(`id: ${frame.id}`);
    lines.push(`event: ${frame.event}`);
    lines.push(`data: ${JSON.stringify(frame.data)}`);
    return `${lines.join('\n')}\n\n`;
  }).join('');
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

export function streamResponse(body: string, options: {errorAfterFrames?: number; holdOpenAfterFrames?: number; signal?: AbortSignal | null | undefined} = {}): Response {
  const {errorAfterFrames, holdOpenAfterFrames, signal} = options;
  if (errorAfterFrames === undefined && holdOpenAfterFrames === undefined) {
    return new Response(body, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
  }
  const remaining = body.split('\n\n').filter(chunk => chunk.trim() !== '');
  const encoder = new TextEncoder();
  let delivered = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      // 按 pull 投喂:controller.error 会丢弃已入队 chunk,只有按需交付才符合真实断线时序。
      if (errorAfterFrames !== undefined && delivered >= errorAfterFrames) {
        controller.error(new TypeError('terminated'));
        return;
      }
      if (holdOpenAfterFrames !== undefined && delivered >= holdOpenAfterFrames) {
        // 真实 fetch 在 abort 后挂起的 read 会以 AbortError 失败;reject pull 即可复现。
        return new Promise<void>((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('AbortError'), {name: 'AbortError'}));
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort, {once: true});
          void resolve;
        });
      }
      const next = remaining.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      delivered += 1;
      controller.enqueue(encoder.encode(`${next}\n\n`));
    },
  });
  return new Response(stream, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
}

export function pongStream(): string {
  return sse([
    {id: 'evt_msg', event: 'event_start', data: {type: 'event_start', event: {id: 'evt_msg', type: 'agent.message'}}},
    {id: 'evt_msg', event: 'event_delta', data: {type: 'event_delta', event_id: 'evt_msg', delta: {type: 'content_delta', index: 0, content: {type: 'text', text: 'p'}}}},
    {id: 'evt_msg', event: 'event_delta', data: {type: 'event_delta', event_id: 'evt_msg', delta: {type: 'content_delta', index: 0, content: {type: 'text', text: 'ong'}}}},
    {id: 'evt_msg', event: 'agent.message', data: {id: 'evt_msg', type: 'agent.message', content: [{type: 'text', text: 'pong'}]}},
    {id: 'evt_end', event: 'session.thread_status_idle', data: {type: 'session.thread_status_idle', stop_reason: {type: 'end_turn'}}},
  ]);
}

export function toolStream(): string {
  return sse([
    {id: 'evt_tool', event: 'agent.custom_tool_use', data: {id: 'evt_tool', type: 'agent.custom_tool_use', name: 'read_file', input: {path: 'README.md'}}},
    {id: 'evt_wait', event: 'session.thread_status_idle', data: {type: 'session.thread_status_idle', stop_reason: {type: 'requires_action', event_ids: ['evt_tool']}}},
  ]);
}

/** busy 真实错误体(busy-409.json)的兼容包装,单测可直接复用录制内容。 */
export const busyErrorBody = qoderFixtureJson('busy-409.json');
export const agentVersionConflictBody = qoderFixtureJson('agent-version-conflict-409.json');

export interface HarnessOptions {
  streams: string[];
  /** 第 index 条流在 N 帧后强制断流(模拟网络中断),配合 streams[index+1] 验证 Last-Event-ID 续读。 */
  disconnectAfter?: Array<{streamIndex: number; frames: number}>;
  /** 第 index 条流在 N 帧后保持连接挂起(模拟服务端仍在生成),用于取消时序。 */
  holdOpen?: Array<{streamIndex: number; frames: number}>;
  /** 首轮 POST /events 返回该状态(通常是 busy 409)。 */
  error?: {status: number; body: unknown};
  /** 第二次复用会话发消息时返回 busy。 */
  busyOnReuse?: boolean;
  /** 复用会话的流开头就报 busy。 */
  busyStreamOnReuse?: boolean;
  /** POST /agents/{id} 前 N 次返回 version 冲突 409,GET 列表返回 freshAgentVersion。 */
  agentConflict?: {times: number; freshAgentVersion: number};
}

export interface Harness {
  fetch: typeof fetch;
  calls: Array<{method: string; path: string; body: unknown}>;
  streamRequests: Array<{path: string; headers: Record<string, string>}>;
}

export function harness(options: HarnessOptions): Harness {
  const calls: Harness['calls'] = [];
  const streamRequests: Harness['streamRequests'] = [];
  let streamIndex = 0;
  let sessionCounter = 0;
  let userPosts = 0;
  let busyStreamServed = false;
  let agentUpdateAttempts = 0;
  const env = {id: 'env_1', name: 'bitori', archived_at: null, config: {type: 'self_hosted'}};
  const agent = {id: 'agent_1', name: 'bitori', archived_at: null, version: options.agentConflict ? options.agentConflict.freshAgentVersion : 1};
  let hasEnv = false;
  let hasAgent = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = init?.method ?? 'GET';
    const path = url.pathname + url.search;
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key.toLowerCase()] = String(value);
    }
    let parsed: unknown;
    if (typeof init?.body === 'string' && init.body) parsed = JSON.parse(init.body);
    calls.push({method, path, body: parsed});
    if (options.error && method === 'POST' && path.endsWith('/events') && streamIndex === 0 && !path.includes('/events/stream')) {
      return jsonResponse(options.error.status, options.error.body);
    }
    if (method === 'GET' && url.pathname.endsWith('/models')) {
      return jsonResponse(200, {data: [
        {id: 'dfmodel', display_name: 'DeepSeek-Flash', is_enabled: true},
        {id: 'auto', display_name: 'Auto', is_enabled: true},
      ]});
    }
    if (method === 'GET' && url.pathname.endsWith('/environments')) {
      return jsonResponse(200, {data: hasEnv ? [env] : []});
    }
    if (method === 'POST' && url.pathname.endsWith('/environments')) {
      hasEnv = true;
      return jsonResponse(200, env);
    }
    if (method === 'GET' && url.pathname.endsWith('/agents')) {
      return jsonResponse(200, {data: hasAgent ? [agent] : []});
    }
    if (method === 'POST' && /\/agents\/agent_1$/.test(url.pathname)) {
      agentUpdateAttempts += 1;
      if (options.agentConflict && agentUpdateAttempts <= options.agentConflict.times) {
        return jsonResponse(409, agentVersionConflictBody);
      }
      agent.version += 1;
      return jsonResponse(200, {...agent, version: agent.version});
    }
    if (method === 'POST' && url.pathname.endsWith('/agents')) {
      hasAgent = true;
      return jsonResponse(200, agent);
    }
    if (method === 'POST' && url.pathname.endsWith('/sessions')) {
      sessionCounter += 1;
      return jsonResponse(200, {id: `sess_${sessionCounter}`, status: 'idle'});
    }
    if (method === 'POST' && url.pathname.endsWith('/events')) {
      const sessionId = /\/sessions\/([^/]+)\/events$/.exec(url.pathname)?.[1];
      const events = parsed && typeof parsed === 'object' && Array.isArray((parsed as {events?: unknown}).events) ? (parsed as {events: Array<{type?: string}>}).events : [];
      const postsUserMessage = events.some(event => event.type === 'user.message');
      if (options.busyOnReuse && sessionId === 'sess_1' && postsUserMessage) {
        userPosts += 1;
        if (userPosts >= 2) {
          return jsonResponse(409, busyErrorBody);
        }
      }
      return jsonResponse(200, {data: []});
    }
    if (method === 'GET' && url.pathname.endsWith('/events/stream')) {
      streamRequests.push({path, headers});
      if (options.busyStreamOnReuse && !busyStreamServed && url.pathname.includes('/sessions/sess_1/events/stream') && streamIndex === 1) {
        busyStreamServed = true;
        streamIndex += 1;
        return streamResponse(sse([{event: 'session.error', data: {type: 'session.error', message: 'Session is currently processing a turn. Cancel the current turn or wait for completion.'}}]));
      }
      const body = options.streams[streamIndex] ?? pongStream();
      const disconnect = options.disconnectAfter?.find(item => item.streamIndex === streamIndex);
      const hold = options.holdOpen?.find(item => item.streamIndex === streamIndex);
      streamIndex += 1;
      return streamResponse(body, {
        ...(disconnect === undefined ? {} : {errorAfterFrames: disconnect.frames}),
        ...(hold === undefined ? {} : {holdOpenAfterFrames: hold.frames, signal: init?.signal}),
      });
    }
    return jsonResponse(404, {error: {message: `missing mock ${method} ${path}`}});
  };
  return {fetch: fetchImpl, calls, streamRequests};
}

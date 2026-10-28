import {errorMessage} from '../shared/errors.js';
import {getLogger} from '../shared/logger.js';
import {MCP_PROTOCOL_VERSION, McpProtocolError} from './types.js';

const logger = getLogger('mcp');
import type {JsonRpcMessage, McpTransport} from './types.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBody(response: Response, signal: AbortSignal, onEvent: (value: unknown) => void, sse: boolean): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let eventBytes = 0;
  const consume = (line: string) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized === '') {
      if (data.length) onEvent(JSON.parse(data.join('\n')));
      data = [];
      eventBytes = 0;
    } else if (normalized.startsWith('data:')) {
      const value = normalized.slice(5).replace(/^ /, '');
      eventBytes += Buffer.byteLength(value) + 1;
      if (eventBytes > MAX_RESPONSE_BYTES) throw new McpProtocolError('MCP SSE 事件超过大小限制');
      data.push(value);
    }
  };
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, {once: true});
  try {
    if (signal.aborted) throw new DOMException('MCP 请求已取消', 'AbortError');
    while (true) {
      const {done, value} = await reader.read();
      if (signal.aborted) throw new DOMException('MCP 请求已取消', 'AbortError');
      buffer += decoder.decode(value, {stream: !done});
      if (sse) {
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) throw new McpProtocolError('MCP SSE 行超过大小限制');
          consume(line);
        }
      }
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) throw new McpProtocolError('MCP HTTP 响应超过大小限制');
      if (done) break;
    }
    if (sse) {
      if (buffer) consume(buffer);
      consume('');
    } else if (buffer) onEvent(JSON.parse(buffer));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
  }
}

/** Streamable HTTP 同时接受普通 JSON 响应与 POST 返回的 SSE 消息流。 */
export class StreamableHttpMcpTransport implements McpTransport {
  #onMessage: ((message: unknown) => void) | null = null;
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #closed = false;
  readonly #active = new Set<AbortController>();

  constructor(readonly url: string, readonly customHeaders: Record<string, string>, readonly fetcher: typeof fetch = fetch) {}

  start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): Promise<void> {
    void onClose;
    this.#onMessage = onMessage;
    return Promise.resolve();
  }

  setProtocolVersion(version: string): void { this.#protocolVersion = version; }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new McpProtocolError('MCP HTTP 连接已经关闭');
    const controller = new AbortController();
    this.#active.add(controller);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
    const headers = new Headers(this.customHeaders);
    // 协议管理的 header 不允许被静态配置伪造或覆盖。
    headers.delete('Mcp-Session-Id');
    headers.delete('MCP-Protocol-Version');
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json, text/event-stream');
    if (this.#sessionId) headers.set('Mcp-Session-Id', this.#sessionId);
    if (this.#protocolVersion) headers.set('MCP-Protocol-Version', this.#protocolVersion);
    const response = await this.fetcher(this.url, {method: 'POST', headers, body: JSON.stringify(message), signal: requestSignal});
    if (!this.#sessionId) this.#sessionId = response.headers.get('Mcp-Session-Id');
    if (!response.ok) throw new McpProtocolError(`MCP HTTP 请求失败：${response.status} ${response.statusText}`);
    if (response.status === 202 || response.status === 204) return;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json')) await readBody(response, requestSignal, value => this.#onMessage?.(value), false);
    else if (contentType.includes('text/event-stream')) await readBody(response, requestSignal, value => this.#onMessage?.(value), true);
    else throw new McpProtocolError(`MCP HTTP 响应 Content-Type 不受支持：${contentType || '(空)'}`);
    } finally { this.#active.delete(controller); }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    if (!this.#sessionId) return;
    const headers = new Headers(this.customHeaders);
    headers.set('Mcp-Session-Id', this.#sessionId);
    headers.set('MCP-Protocol-Version', this.#protocolVersion ?? MCP_PROTOCOL_VERSION);
    // 关闭阶段不因远端不可达阻塞应用退出。
    // 关闭失败降级为日志，会话资源泄漏可被观察。
    try { await this.fetcher(this.url, {method: 'DELETE', headers, signal: AbortSignal.timeout(2_000)}); }
    catch (error) { logger.debug('MCP HTTP 会话关闭失败', {url: this.url, error: errorMessage(error)}); }
  }
}

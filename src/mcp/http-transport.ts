import {errorMessage} from '../shared/errors.js';
import {getLogger} from '../shared/logger.js';
import {MCP_PROTOCOL_VERSION, McpProtocolError} from './types.js';

const logger = getLogger('mcp');
import type {JsonRpcMessage, McpTransport} from './types.js';

function sseData(text: string): string[] {
  const events = text.replaceAll('\r\n', '\n').split('\n\n');
  return events.map(event => event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean);
}

/** [s06] Streamable HTTP 同时接受普通 JSON 响应与 POST 返回的 SSE 消息流。 */
export class StreamableHttpMcpTransport implements McpTransport {
  #onMessage: ((message: unknown) => void) | null = null;
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #closed = false;

  constructor(readonly url: string, readonly customHeaders: Record<string, string>, readonly fetcher: typeof fetch = fetch) {}

  start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): Promise<void> {
    void onClose;
    this.#onMessage = onMessage;
    return Promise.resolve();
  }

  setProtocolVersion(version: string): void { this.#protocolVersion = version; }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new McpProtocolError('MCP HTTP 连接已经关闭');
    const headers = new Headers(this.customHeaders);
    // [s06] 协议管理的 header 不允许被静态配置伪造或覆盖。
    headers.delete('Mcp-Session-Id');
    headers.delete('MCP-Protocol-Version');
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json, text/event-stream');
    if (this.#sessionId) headers.set('Mcp-Session-Id', this.#sessionId);
    if (this.#protocolVersion) headers.set('MCP-Protocol-Version', this.#protocolVersion);
    const response = await this.fetcher(this.url, {method: 'POST', headers, body: JSON.stringify(message), ...(signal === undefined ? {} : {signal})});
    if (!this.#sessionId) this.#sessionId = response.headers.get('Mcp-Session-Id');
    if (!response.ok) throw new McpProtocolError(`MCP HTTP 请求失败：${response.status} ${response.statusText}`);
    if (response.status === 202 || response.status === 204) return;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const body = await response.text();
    if (!body) return;
    if (contentType.includes('application/json')) this.#onMessage?.(JSON.parse(body));
    else if (contentType.includes('text/event-stream')) for (const data of sseData(body)) this.#onMessage?.(JSON.parse(data));
    else throw new McpProtocolError(`MCP HTTP 响应 Content-Type 不受支持：${contentType || '(空)'}`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#sessionId) return;
    const headers = new Headers(this.customHeaders);
    headers.set('Mcp-Session-Id', this.#sessionId);
    headers.set('MCP-Protocol-Version', this.#protocolVersion ?? MCP_PROTOCOL_VERSION);
    // [s06] 关闭阶段不因远端不可达阻塞应用退出。
    // [s15] 关闭失败降级为日志，会话资源泄漏可被观察。
    try { await this.fetcher(this.url, {method: 'DELETE', headers}); }
    catch (error) { logger.debug('MCP HTTP 会话关闭失败', {url: this.url, error: errorMessage(error)}); }
  }
}

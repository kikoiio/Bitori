import {McpProtocolError} from './types.js';
import type {JsonObject} from '../tools/types.js';
import type {JsonRpcFailure, JsonRpcId, JsonRpcMessage, McpTransport} from './types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageId(value: unknown): JsonRpcId | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** JSON-RPC Peer 只按 id 配对响应；乱序响应不会串到其他请求。 */
export class JsonRpcPeer {
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(readonly transport: McpTransport, readonly timeoutMs = 30_000) {}

  async start(): Promise<void> {
    await this.transport.start(
      message => { void this.#receive(message).catch(error => this.#failAll(error instanceof Error ? error : new McpProtocolError(String(error)))); },
      error => { this.#closed = true; this.#failAll(error ?? new McpProtocolError('MCP 连接已关闭')); },
    );
  }

  async request(method: string, params: JsonObject = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new McpProtocolError('MCP 连接已经关闭');
    const id = this.#nextId++;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (abort !== undefined) signal?.removeEventListener('abort', abort);
        this.#pending.delete(id);
        controller.abort();
      };
      abort = () => { cleanup(); reject(new DOMException('MCP 请求已取消', 'AbortError')); };
      this.#pending.set(id, {resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, cleanup});
      timeout = setTimeout(() => {
        cleanup();
        reject(new McpProtocolError(`MCP 请求超时：${method}`));
      }, this.timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
    });
    if (signal?.aborted) {
      this.#pending.get(id)?.reject(new DOMException('MCP 请求已取消', 'AbortError'));
      return response;
    }
    void this.transport.send({jsonrpc: '2.0', id, method, params}, controller.signal).catch(error => {
      this.#pending.get(id)?.reject(error instanceof Error ? error : new McpProtocolError(String(error)));
    });
    return response;
  }

  async notify(method: string, params: JsonObject = {}, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new McpProtocolError('MCP 连接已经关闭');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => { controller.abort(); reject(new DOMException('MCP 通知已取消', 'AbortError')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, {once: true});
        timeout = setTimeout(() => { controller.abort(); reject(new McpProtocolError(`MCP 通知超时：${method}`)); }, this.timeoutMs);
        void this.transport.send({jsonrpc: '2.0', method, params}, controller.signal).then(resolve, reject);
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#failAll(new McpProtocolError('MCP 连接已经关闭'));
    this.#closePromise = this.transport.close();
    return this.#closePromise;
  }

  async #receive(value: unknown): Promise<void> {
    if (!isRecord(value) || value.jsonrpc !== '2.0') return;
    const id = messageId(value.id);
    if (id !== null && ('result' in value || 'error' in value)) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      if ('error' in value && isRecord(value.error)) {
        const failure = value as unknown as JsonRpcFailure;
        pending.reject(new McpProtocolError(failure.error.message, failure.error.code, failure.error.data));
      } else pending.resolve(value.result);
      return;
    }
    // 不支持 sampling/resources 等反向能力；明确回复 method not found，避免 Server 悬挂。
    if (id !== null && typeof value.method === 'string') {
      await this.transport.send({jsonrpc: '2.0', id, error: {code: -32601, message: `Bitori 不支持 Server 请求：${value.method}`}});
    }
  }

  #failAll(error: Error): void {
    for (const pending of [...this.#pending.values()]) pending.reject(error);
  }
}

export function parseJsonRpcLine(line: string): JsonRpcMessage {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value.jsonrpc !== '2.0') throw new McpProtocolError('收到非法 JSON-RPC 2.0 消息');
  return value as unknown as JsonRpcMessage;
}

export function encodeJsonRpcLine(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

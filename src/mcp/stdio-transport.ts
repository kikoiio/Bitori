import {OwnedProcessTree} from '../shared/owned-process-tree.js';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {encodeJsonRpcLine, parseJsonRpcLine} from './json-rpc.js';
import {McpProtocolError} from './types.js';
import type {JsonRpcMessage, McpTransport} from './types.js';

export interface StdioTransportOptions {command: string; args: string[]; env: Record<string, string>; cwd: string}
export const MAX_STDIO_FRAME_BYTES = 1_048_576;

/** stdio 每行恰好一条 UTF-8 JSON-RPC 消息，stderr 仅被消费而不参与协议。 */
export class StdioMcpTransport implements McpTransport {
  #child: ChildProcessWithoutNullStreams | null = null;
  #tree: OwnedProcessTree | null = null;
  #closePromise: Promise<void> | null = null;
  #closing = false;

  constructor(readonly options: StdioTransportOptions) {}

  async start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): Promise<void> {
    if (this.#closing) throw new McpProtocolError('MCP stdio 连接已经关闭');
    if (this.#child) return;
    const tree = new OwnedProcessTree(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: {...process.env, ...this.options.env},
      // Windows 的 npx.cmd 等脚本必须经系统 shell 启动；配置文件本身是用户授权的命令来源。
      shell: process.platform === 'win32',
    });
    const child = tree.child;
    this.#tree = tree;
    this.#child = child;
    child.stderr.on('data', () => undefined);
    let buffer = '';
    let closeNotified = false;
    const notifyClose = (error?: Error): void => { if (closeNotified) return; closeNotified = true; onClose(error); };
    const protocolFailure = (message: string): void => {
      const error = new McpProtocolError(message);
      notifyClose(error);
      void this.close().catch(() => undefined);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (closeNotified) return;
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_STDIO_FRAME_BYTES) {
          protocolFailure('MCP stdio Server 单帧超过大小限制');
          return;
        }
        if (line.trim()) {
          let message: unknown;
          try { message = parseJsonRpcLine(line); }
          catch { protocolFailure('MCP stdio Server 输出了非法 JSON'); return; }
          onMessage(message);
        }
        newline = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_STDIO_FRAME_BYTES) protocolFailure('MCP stdio Server 单帧超过大小限制');
    });
    child.once('exit', (code, signal) => {
      notifyClose(this.#closing ? undefined : new McpProtocolError(`MCP stdio Server 提前退出（code=${String(code)}, signal=${String(signal)}）`));
      void this.close().catch(() => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        if (this.#closing) reject(new McpProtocolError('MCP stdio 连接已经关闭'));
        else resolve();
      });
      child.once('error', error => {
        notifyClose(error);
        void this.close().catch(() => undefined);
        reject(error);
      });
    });
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    const child = this.#child;
    if (this.#closing || !child?.stdin.writable || child.exitCode !== null || child.signalCode !== null) throw new McpProtocolError('MCP stdio 连接不可写');
    if (signal?.aborted) throw new DOMException('MCP 请求已取消', 'AbortError');
    const line = encodeJsonRpcLine(message);
    await new Promise<void>((resolve, reject) => child.stdin.write(line, 'utf8', error => error ? reject(error) : resolve()));
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      try { await this.#tree?.close({stdinGraceMs: 1_000}); }
      finally { this.#child = null; this.#tree = null; }
    })();
    return this.#closePromise;
  }
}

import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {encodeJsonRpcLine, parseJsonRpcLine} from './json-rpc.js';
import {McpProtocolError} from './types.js';
import type {JsonRpcMessage, McpTransport} from './types.js';

export interface StdioTransportOptions {command: string; args: string[]; env: Record<string, string>; cwd: string}

/** [s06] stdio 每行恰好一条 UTF-8 JSON-RPC 消息，stderr 仅被消费而不参与协议。 */
export class StdioMcpTransport implements McpTransport {
  #child: ChildProcessWithoutNullStreams | null = null;
  #closePromise: Promise<void> | null = null;
  #closing = false;

  constructor(readonly options: StdioTransportOptions) {}

  async start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): Promise<void> {
    if (this.#child) return;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: {...process.env, ...this.options.env},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // [s06] Windows 的 npx.cmd 等脚本必须经系统 shell 启动；配置文件本身是用户授权的命令来源。
      shell: process.platform === 'win32',
    });
    this.#child = child;
    child.stderr.on('data', () => undefined);
    createInterface({input: child.stdout, crlfDelay: Infinity}).on('line', line => {
      if (!line.trim()) return;
      try { onMessage(parseJsonRpcLine(line)); }
      catch { onClose(new McpProtocolError('MCP stdio Server 输出了非法 JSON')); }
    });
    child.once('exit', (code, signal) => {
      this.#child = null;
      onClose(this.#closing ? undefined : new McpProtocolError(`MCP stdio Server 提前退出（code=${String(code)}, signal=${String(signal)}）`));
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => { this.#child = null; reject(error); });
    });
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    const child = this.#child;
    if (!child?.stdin.writable) throw new McpProtocolError('MCP stdio 连接不可写');
    if (signal?.aborted) throw new DOMException('MCP 请求已取消', 'AbortError');
    const line = encodeJsonRpcLine(message);
    await new Promise<void>((resolve, reject) => child.stdin.write(line, 'utf8', error => error ? reject(error) : resolve()));
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      this.#closing = true;
      const child = this.#child;
      if (!child) return;
      child.stdin.end();
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const terminateTimer = setTimeout(() => {
          child.kill('SIGTERM');
          forceTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1_000);
        }, 1_000);
        child.once('exit', () => {
          clearTimeout(terminateTimer);
          if (forceTimer !== undefined) clearTimeout(forceTimer);
          resolve();
        });
      });
    })();
    return this.#closePromise;
  }
}

import {describe, expect, it} from 'vitest';
import {encodeJsonRpcLine, JsonRpcPeer, parseJsonRpcLine} from '../../../src/mcp/json-rpc.js';
import type {JsonRpcMessage, McpTransport} from '../../../src/mcp/types.js';

class ControlledTransport implements McpTransport {
  sent: JsonRpcMessage[] = [];
  receiver: ((message: unknown) => void) | null = null;
  start(onMessage: (message: unknown) => void): Promise<void> { this.receiver = onMessage; return Promise.resolve(); }
  send(message: JsonRpcMessage, _signal?: AbortSignal): Promise<void> { this.sent.push(message); return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  receive(message: unknown): void { this.receiver?.(message); }
}

describe('JsonRpcPeer', () => {
  it('发送悬挂时超时、中止传输并拒绝请求', async () => {
    const transport = new ControlledTransport();
    let aborted = false;
    transport.send = (_message, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, {once: true});
    });
    const peer = new JsonRpcPeer(transport, 20); await peer.start();
    await expect(peer.request('initialize')).rejects.toThrow('超时');
    expect(aborted).toBe(true);
  });

  it('调用方取消和连接关闭都会中止未完成发送', async () => {
    let closeCallback: ((error?: Error) => void) | undefined;
    const signals: AbortSignal[] = [];
    const transport: McpTransport = {
      async start(_onMessage, onClose) { closeCallback = onClose; },
      async send(_message, signal) { if (signal) signals.push(signal); await new Promise<void>(() => {}); },
      async close() {},
    };
    const peer = new JsonRpcPeer(transport, 1000); await peer.start();
    const controller = new AbortController();
    const first = peer.request('one', {}, controller.signal); controller.abort();
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    const second = peer.request('two'); closeCallback?.();
    await expect(second).rejects.toThrow('关闭');
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it('用 id 配对乱序返回的并发请求', async () => {
    const transport = new ControlledTransport(); const peer = new JsonRpcPeer(transport, 1_000); await peer.start();
    const first = peer.request('first'); const second = peer.request('second');
    await Promise.resolve();
    transport.receive({jsonrpc: '2.0', id: 2, result: {value: 'two'}});
    transport.receive({jsonrpc: '2.0', id: 1, result: {value: 'one'}});
    await expect(first).resolves.toEqual({value: 'one'});
    await expect(second).resolves.toEqual({value: 'two'});
  });

  it('把 JSON-RPC error 变成带 code 的异常', async () => {
    const transport = new ControlledTransport(); const peer = new JsonRpcPeer(transport, 1_000); await peer.start();
    const pending = peer.request('broken'); await Promise.resolve();
    transport.receive({jsonrpc: '2.0', id: 1, error: {code: -32602, message: 'bad params'}});
    await expect(pending).rejects.toMatchObject({message: 'bad params', code: -32602});
  });

  it('stdio framing 每条消息只占一行并保持 UTF-8 内容', () => {
    const message = {jsonrpc: '2.0' as const, id: 1, method: 'echo', params: {text: '你好\nworld'}};
    const line = encodeJsonRpcLine(message);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(parseJsonRpcLine(line.trimEnd())).toEqual(message);
  });
});

import {describe, expect, it} from 'vitest';
import {McpManager} from '../../../src/mcp/manager.js';
import type {JsonRpcMessage, McpTransport} from '../../../src/mcp/types.js';
import {ToolRegistry} from '../../../src/tools/registry.js';

describe('McpManager 关闭', () => {
  it('关闭尚在启动和已完成握手的客户端，等待清理及慢启动，不登记工具', async () => {
    let releaseStart = () => {};
    let releaseClose = () => {};
    let fastListed = () => {};
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const listed = new Promise<void>(resolve => { fastListed = resolve; });
    let fastReceiver: ((message: unknown) => void) | undefined;
    let fastCloses = 0;
    let slowCloses = 0;
    let slowSends = 0;
    const fast: McpTransport = {
      async start(onMessage) { fastReceiver = onMessage; },
      async send(message: JsonRpcMessage) {
        if (!('method' in message) || !('id' in message)) return;
        if (message.method === 'initialize') fastReceiver?.({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-06-18', capabilities: {}}});
        if (message.method === 'tools/list') {
          fastReceiver?.({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'tool', inputSchema: {type: 'object'}}]}});
          fastListed();
        }
      },
      async close() { fastCloses++; },
    };
    const slow: McpTransport = {
      async start() { await startGate; },
      async send() { slowSends++; },
      async close() { slowCloses++; await closeGate; },
    };
    const registry = new ToolRegistry();
    const server = {transport: 'http' as const, url: 'https://example.invalid', headers: {}};
    const manager = new McpManager(registry, {fast: server, slow: server}, '.', name => name === 'fast' ? fast : slow);
    const initialization = manager.initialize();
    await listed;
    const closing = manager.close();
    expect(manager.close()).toBe(closing);
    expect(fastCloses).toBe(1);
    expect(slowCloses).toBe(1);
    let finished = false;
    void closing.then(() => { finished = true; });
    releaseClose();
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseStart();
    const result = await initialization;
    await closing;
    expect(result.connected).toEqual([]);
    expect(result.registeredTools).toEqual([]);
    expect(registry.entries()).toEqual([]);
    expect(manager.get('fast')).toBeUndefined();
    expect(slowSends).toBe(0);
    await expect(manager.initialize()).rejects.toThrow('已关闭');
  });
});

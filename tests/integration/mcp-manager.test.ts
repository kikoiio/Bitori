import {describe, expect, it} from 'vitest';
import {McpManager} from '../../src/mcp/manager.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import type {JsonRpcMessage, McpTransport} from '../../src/mcp/types.js';

class FixtureTransport implements McpTransport {
  receiver: ((message: unknown) => void) | null = null;
  constructor(readonly broken = false) {}
  start(onMessage: (message: unknown) => void): Promise<void> {
    if (this.broken) return Promise.reject(new Error('offline'));
    this.receiver = onMessage; return Promise.resolve();
  }
  send(message: JsonRpcMessage): Promise<void> {
    if (!('method' in message) || !('id' in message)) return Promise.resolve();
    if (message.method === 'initialize') queueMicrotask(() => this.receiver?.({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}}}));
    if (message.method === 'tools/list') queueMicrotask(() => this.receiver?.({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'echo', description: 'echo args', inputSchema: {type: 'object'}}]}}));
    if (message.method === 'tools/call') queueMicrotask(() => this.receiver?.({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: JSON.stringify(message.params?.arguments)}], structuredContent: message.params?.arguments}}));
    return Promise.resolve();
  }
  close(): Promise<void> { return Promise.resolve(); }
}

describe('McpManager', () => {
  it('注册可用 Server 的工具，并隔离另一个 Server 的启动失败', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, {
      good: {transport: 'stdio', command: 'node', args: [], env: {}},
      bad: {transport: 'stdio', command: '__bitori_missing_mcp_command__', args: [], env: {}},
    }, process.cwd(), name => new FixtureTransport(name === 'bad'));
    try {
      const result = await manager.initialize();
      expect(result.connected).toEqual(['good']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.name).toBe('bad');
      expect(result.registeredTools).toEqual(['mcp__good__echo']);
      const tool = registry.get('mcp__good__echo'); expect(tool).toBeDefined();
      const execution = await tool!.execute({message: 'hello'}, {workspaceRoot: process.cwd(), signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 10_000, maxMatches: 10}});
      expect(execution).toEqual({status: 'success', output: {content: [{type: 'text', text: '{"message":"hello"}'}], structuredContent: {message: 'hello'}}});
    } finally { await manager.close(); }
  });
});

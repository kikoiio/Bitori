import {describe, expect, it} from 'vitest';
import {McpClient} from '../../../src/mcp/client.js';
import type {JsonRpcMessage, McpTransport} from '../../../src/mcp/types.js';

class ProtocolTransport implements McpTransport {
  receiver: ((message: unknown) => void) | null = null;
  methods: string[] = [];
  cursors: unknown[] = [];
  negotiated: string | null = null;
  start(onMessage: (message: unknown) => void): Promise<void> { this.receiver = onMessage; return Promise.resolve(); }
  setProtocolVersion(version: string): void { this.negotiated = version; }
  send(message: JsonRpcMessage): Promise<void> {
    if (!('method' in message)) return Promise.resolve();
    this.methods.push(message.method);
    if (!('id' in message)) return Promise.resolve();
    if (message.method === 'initialize') queueMicrotask(() => this.reply(message.id, {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'test', version: '1'}}));
    if (message.method === 'tools/list') {
      const cursor = message.params?.cursor; this.cursors.push(cursor);
      const result = cursor === undefined
        ? {tools: [{name: 'one', inputSchema: {type: 'object'}}], nextCursor: 'page-2'}
        : {tools: [{name: 'two', description: 'second', inputSchema: {type: 'object'}}]};
      queueMicrotask(() => this.reply(message.id, result));
    }
    if (message.method === 'tools/call') queueMicrotask(() => this.reply(message.id, {content: [{type: 'text', text: 'ok'}], structuredContent: {ok: true}}));
    return Promise.resolve();
  }
  close(): Promise<void> { return Promise.resolve(); }
  reply(id: string | number, result: unknown): void { this.receiver?.({jsonrpc: '2.0', id, result}); }
}

describe('McpClient', () => {
  it('完成握手、initialized 通知、分页列举和工具调用', async () => {
    const transport = new ProtocolTransport(); const client = new McpClient(transport);
    await client.initialize();
    expect(transport.methods.slice(0, 2)).toEqual(['initialize', 'notifications/initialized']);
    expect(transport.negotiated).toBe('2025-06-18');
    await expect(client.listTools()).resolves.toEqual([
      {name: 'one', inputSchema: {type: 'object'}},
      {name: 'two', description: 'second', inputSchema: {type: 'object'}},
    ]);
    expect(transport.cursors).toEqual([undefined, 'page-2']);
    await expect(client.callTool('one', {value: 1})).resolves.toEqual({content: [{type: 'text', text: 'ok'}], structuredContent: {ok: true}});
    await client.close();
  });
});

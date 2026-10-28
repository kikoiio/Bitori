import {describe, expect, it} from 'vitest';
import {McpToolAdapter} from '../../../src/mcp/tool-adapter.js';
import type {McpClient} from '../../../src/mcp/client.js';

describe('McpToolAdapter', () => {
  it('按工具结果上限截断远端结果', async () => {
    const client = {callTool: async () => ({content: [{type: 'text', text: '"\\\n'.repeat(10_000)}]})} as unknown as McpClient;
    const tool = new McpToolAdapter('demo', {name: 'large', inputSchema: {type: 'object'}}, client, 'mcp__demo__large');
    const result = await tool.execute({}, {workspaceRoot: '.', signal: new AbortController().signal, limits: {timeoutMs: 1000, maxResultBytes: 128, maxMatches: 10}});
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.truncation?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(128);
  });
});

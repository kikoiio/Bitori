import {describe, expect, it, vi} from 'vitest';
import {StreamableHttpMcpTransport} from '../../../src/mcp/http-transport.js';

describe('StreamableHttpMcpTransport', () => {
  it('保留 session、协议版本与自定义 header，并解析 JSON/SSE', async () => {
    const received: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc: '2.0', id: 1, result: {ok: true}}), {headers: {'content-type': 'application/json', 'mcp-session-id': 'session-1'}}))
      .mockResolvedValueOnce(new Response('data: {"jsonrpc":"2.0","id":2,"result":{"streamed":true}}\n\n', {headers: {'content-type': 'text/event-stream'}}))
      .mockResolvedValueOnce(new Response(null, {status: 200}));
    const transport = new StreamableHttpMcpTransport('https://example.com/mcp', {Authorization: 'Bearer token', 'Mcp-Session-Id': 'forged'}, fetcher);
    await transport.start(value => received.push(value), () => undefined);
    await transport.send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}});
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('mcp-session-id')).toBeNull();
    transport.setProtocolVersion('2025-06-18');
    await transport.send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
    const secondHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(secondHeaders.get('accept')).toContain('application/json');
    expect(secondHeaders.get('accept')).toContain('text/event-stream');
    expect(secondHeaders.get('authorization')).toBe('Bearer token');
    expect(secondHeaders.get('mcp-session-id')).toBe('session-1');
    expect(secondHeaders.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(received).toEqual([
      {jsonrpc: '2.0', id: 1, result: {ok: true}},
      {jsonrpc: '2.0', id: 2, result: {streamed: true}},
    ]);
    await transport.close();
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });
});

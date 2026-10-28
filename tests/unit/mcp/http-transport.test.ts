import {describe, expect, it, vi} from 'vitest';
import {JsonRpcPeer} from '../../../src/mcp/json-rpc.js';
import {McpClient} from '../../../src/mcp/client.js';
import {StreamableHttpMcpTransport} from '../../../src/mcp/http-transport.js';

describe('StreamableHttpMcpTransport', () => {
  it('初始化等待 HTTP 响应头超时并中止 fetch', async () => {
    let aborted = false;
    const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }, {once: true});
    });
    const client = new McpClient(new StreamableHttpMcpTransport('https://example.invalid', {}, fetcher), 20);
    await expect(client.initialize()).rejects.toThrow('超时');
    expect(aborted).toBe(true);
    await client.close();
  });
  it('SSE 保持打开时立即交付响应并取消读取', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n')); },
      cancel() { cancelled = true; },
    });
    const transport = new StreamableHttpMcpTransport('https://example.invalid', {}, async () => new Response(stream, {headers: {'content-type': 'text/event-stream'}}));
    const peer = new JsonRpcPeer(transport, 100); await peer.start();
    await expect(peer.request('test')).resolves.toEqual({ok: true});
    await Promise.resolve();
    expect(cancelled).toBe(true);
    await peer.close();
  });

  it('拒绝过大的 SSE 事件', async () => {
    const body = `data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`;
    const transport = new StreamableHttpMcpTransport('https://example.invalid', {}, async () => new Response(body, {headers: {'content-type': 'text/event-stream'}}));
    const peer = new JsonRpcPeer(transport, 1000); await peer.start();
    await expect(peer.request('test')).rejects.toThrow('超过大小限制');
    await peer.close();
  });
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

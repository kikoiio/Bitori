import {describe, expect, it} from 'vitest';
import {startMockSseServer} from './mock-sse-server.js';

describe('mock SSE server', () => {
  it('发送多个分块并释放端口', async () => {
    const server = await startMockSseServer(['data: one\n\n', 'data: two\n\n']);
    const response = await fetch(server.baseUrl, {method: 'POST', body: '{}'});
    expect(await response.text()).toContain('data: two');
    expect(server.requests).toHaveLength(1);
    await server.close();
  });
});

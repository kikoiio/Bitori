import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {StdioMcpTransport} from '../../../src/mcp/stdio-transport.js';

describe('StdioMcpTransport', () => {
  it('启动失败时并发关闭仍会收尾', async () => {
    const transport = new StdioMcpTransport({command: join(process.env.TMPDIR ?? '.', 'missing-mcp-command'), args: [], env: {}, cwd: process.cwd()});
    const starting = transport.start(() => {}, () => {});
    const closing = transport.close();
    await expect(starting).rejects.toThrow();
    await expect(closing).resolves.toBeUndefined();
    await expect(transport.start(() => {}, () => {})).rejects.toThrow('关闭');
  });
});

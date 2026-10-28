import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';
import {cleanupFixture, fixturePid, isFixtureRunning, processTreeFixture} from '../../helpers/process-tree-fixture.js';
import {MAX_STDIO_FRAME_BYTES, StdioMcpTransport} from '../../../src/mcp/stdio-transport.js';

describe('StdioMcpTransport', () => {
  it.each(['hold-parent', 'exit-parent'])('关闭 %s 启动器时清理持有管道且忽略 SIGTERM 的后代', async mode => {
    if (process.platform === 'win32' && mode === 'exit-parent') return;
    const workspace = await TemporaryWorkspace.create();
    const pidFile = join(workspace.root, 'descendant.pid');
    const transport = new StdioMcpTransport({command: process.execPath, args: [processTreeFixture, mode, pidFile], env: {}, cwd: workspace.root});
    let pid = 0;
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    try {
      await transport.start(() => {}, () => resolveExit());
      pid = await fixturePid(pidFile);
      if (mode === 'exit-parent') await exited;
      const closing = transport.close();
      expect(transport.close()).toBe(closing);
      await closing;
      await expect.poll(() => isFixtureRunning(pid), {timeout: 2_000}).toBe(false);
    } finally {
      await cleanupFixture(pid);
      await transport.close();
      await workspace.cleanup();
    }
  }, 10_000);

  it('无效 cwd 启动失败后关闭不会等待不存在的进程', async () => {
    const transport = new StdioMcpTransport({command: process.execPath, args: ['-e', ''], env: {}, cwd: join(process.cwd(), 'missing-mcp-cwd')});
    await expect(transport.start(() => {}, () => {})).rejects.toThrow();
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('启动失败时并发关闭仍会收尾', async () => {
    const transport = new StdioMcpTransport({command: join(process.env.TMPDIR ?? '.', 'missing-mcp-command'), args: [], env: {}, cwd: process.cwd()});
    const starting = transport.start(() => {}, () => {});
    const closing = transport.close();
    await expect(starting).rejects.toThrow();
    await expect(closing).resolves.toBeUndefined();
    await expect(transport.start(() => {}, () => {})).rejects.toThrow('关闭');
  });

  it.each([
    ['非法 JSON', `process.stdout.write('not-json\\n');`],
    ['超大帧', `process.stdout.write('x'.repeat(${MAX_STDIO_FRAME_BYTES + 1}));`],
  ])('遇到%s时关闭并保留协议错误', async (_label, script) => {
    const transport = new StdioMcpTransport({command: process.execPath, args: ['-e', script], env: {}, cwd: process.cwd()});
    const closed = new Promise<Error | undefined>(resolve => { void transport.start(() => {}, resolve); });
    const error = await closed;
    expect(error?.message).toMatch(/非法 JSON|单帧超过大小限制/);
    await transport.close();
  });
});

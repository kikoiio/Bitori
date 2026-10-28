import {describe, expect, it, vi} from 'vitest';
import type {ChatController} from '../../../src/chat/agent-controller.js';
import type {TerminalSession} from '../../../src/terminal/session.js';
import {createShutdownOnce} from '../../../src/terminal/shutdown.js';

describe('终端关闭', () => {
  it('控制器关闭失败时仍关闭资源并恢复终端，且重复调用不会重复执行', async () => {
    const error = new Error('controller failure');
    const controller = {shutdown: vi.fn().mockRejectedValue(error)} as unknown as ChatController;
    const terminal = {unmount: vi.fn()} as unknown as TerminalSession;
    const closeResources = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownOnce(() => controller, () => terminal, closeResources);
    await expect(shutdown('user')).rejects.toBe(error);
    await expect(shutdown('fatal_error')).rejects.toBe(error);
    expect(controller.shutdown).toHaveBeenCalledTimes(1);
    expect(closeResources).toHaveBeenCalledTimes(1);
    expect(terminal.unmount).toHaveBeenCalledTimes(1);
  });
});

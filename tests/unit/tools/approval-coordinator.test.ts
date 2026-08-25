import {describe, expect, it, vi} from 'vitest';
import {ApprovalCoordinator} from '../../../src/tools/approval-coordinator.js';
import type {ToolCall} from '../../../src/tools/types.js';

const call = (effect: ToolCall['effect'], name = 'write_file'): ToolCall => ({internalId: `${effect}-1`, providerCallId: 'p', position: 0, name, arguments: effect === 'command' ? {command: 'echo x'} : {path: 'x'}, effect});
describe('ApprovalCoordinator', () => {
  it('只读自动批准，写入逐项等待决定', async () => { const coordinator = new ApprovalCoordinator(); await expect(coordinator.request(call('read'))).resolves.toBe('approved'); const listener = vi.fn(); coordinator.subscribe(listener); const pending = coordinator.request(call('write')); expect(coordinator.current()).toMatchObject({toolName: 'write_file', riskMessage: null}); coordinator.resolve('write-1', 'approved'); await expect(pending).resolves.toBe('approved'); expect(listener).toHaveBeenLastCalledWith(null); });
  it('命令提示完整风险并支持拒绝/中断', async () => { const coordinator = new ApprovalCoordinator(); const pending = coordinator.request(call('command', 'run_command')); expect(coordinator.current()?.riskMessage).toContain('访问网络'); expect(coordinator.current()?.riskMessage).toContain('启动子进程'); expect(coordinator.current()?.riskMessage).toContain('工作区外'); coordinator.interruptAll(); await expect(pending).resolves.toBe('denied'); });
  it('拒绝并发审批和错误 ID 决定', async () => { const coordinator = new ApprovalCoordinator(); const pending = coordinator.request(call('write')); await expect(coordinator.request({...call('write'), internalId: 'second'})).rejects.toThrow(/已有/); coordinator.resolve('wrong', 'approved'); expect(coordinator.current()).not.toBeNull(); coordinator.resolve('write-1', 'denied'); await expect(pending).resolves.toBe('denied'); });
});

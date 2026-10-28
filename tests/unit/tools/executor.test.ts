import {describe, expect, it, vi} from 'vitest';
import {PermissionEngine} from '../../../src/tools/permission-engine.js';
import type {PermissionCheck} from '../../../src/tools/permission-engine.js';
import {ToolExecutor} from '../../../src/tools/executor.js';
import {ToolRegistry} from '../../../src/tools/registry.js';
import type {ToolCall} from '../../../src/tools/types.js';
import {MockTool} from '../../helpers/mock-tool.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';
import {join} from 'node:path';

const limits = {read: {timeoutMs: 30, maxResultBytes: 10, maxMatches: 2}, write: {timeoutMs: 30, maxResultBytes: 10, maxMatches: 2}, command: {timeoutMs: 30, maxResultBytes: 10, maxMatches: 2}};
const call = (name: string, effect: ToolCall['effect'] = 'read'): ToolCall => ({internalId: 'i', providerCallId: 'p', position: 0, name, arguments: {}, effect});
describe('ToolExecutor', () => {
  it('已取消时不启动工具', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({status: 'success', output: {}});
    registry.register(new MockTool('write', 'write', execute));
    const result = await new ToolExecutor(registry, {workspaceRoot: '.', limits}).execute(call('write', 'write'), AbortSignal.abort());
    expect(result).toMatchObject({status: 'interrupted', error: {code: 'interrupted'}});
    expect(execute).not.toHaveBeenCalled();
  });
  it('权限检查等待期间取消后不启动获准工具', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({status: 'success', output: {}});
    registry.register(new MockTool('write', 'write', execute));
    const workspace = await TemporaryWorkspace.create();
    const permissions = new PermissionEngine({workspaceRoot: workspace.root, userRulesPath: join(workspace.root, 'user.yaml'), projectRulesPath: join(workspace.root, 'project.yaml'), localRulesPath: join(workspace.root, 'local.yaml')});
    let completeCheck: ((check: PermissionCheck) => void) | undefined;
    const check = new Promise<PermissionCheck>(resolve => { completeCheck = resolve; });
    const evaluate = vi.spyOn(permissions, 'evaluate').mockReturnValue(check);
    try {
      const controller = new AbortController();
      const pending = new ToolExecutor(registry, {workspaceRoot: '.', limits, permissions}).execute(call('write', 'write'), controller.signal);
      expect(evaluate).toHaveBeenCalledOnce();
      controller.abort();
      if (!completeCheck) throw new Error('权限检查尚未初始化');
      completeCheck({decision: 'allow', source: 'tier', reason: 'test'});
      expect(await pending).toMatchObject({status: 'interrupted', error: {code: 'interrupted'}});
      expect(execute).not.toHaveBeenCalled();
    } finally { evaluate.mockRestore(); await workspace.cleanup(); }
  });
  it('工具提交完成后取消仍保留成功结果', async () => {
    const registry = new ToolRegistry(); const controller = new AbortController();
    registry.register(new MockTool('write', 'write', async () => { controller.abort(); return {status: 'success', output: {}}; }));
    expect(await new ToolExecutor(registry, {workspaceRoot: '.', limits}).execute(call('write', 'write'), controller.signal)).toMatchObject({status: 'success'});
  });
  it('执行成功并注入固定限制', async () => { const registry = new ToolRegistry(); let observed = 0; registry.register(new MockTool('ok', 'read', async (_args, context) => { observed = context.limits.maxResultBytes; return {status: 'success', output: {ok: true}}; })); expect(await new ToolExecutor(registry, {workspaceRoot: '.', limits}).execute(call('ok'), new AbortController().signal)).toMatchObject({status: 'success'}); expect(observed).toBe(10); });
  it('归一化未知工具、异常和外部取消', async () => { const registry = new ToolRegistry(); registry.register(new MockTool('boom', 'read', async () => { throw new Error('boom'); })); const executor = new ToolExecutor(registry, {workspaceRoot: '.', limits}); expect(await executor.execute(call('missing'), new AbortController().signal)).toMatchObject({status: 'error', error: {code: 'unknown_tool'}}); expect(await executor.execute(call('boom'), new AbortController().signal)).toMatchObject({status: 'error', error: {code: 'internal_error'}}); const abort = new AbortController(); abort.abort(); expect(await executor.execute(call('boom'), abort.signal)).toMatchObject({status: 'interrupted'}); });
  it('固定超时转换为 timeout', async () => { const registry = new ToolRegistry(); registry.register(new MockTool('slow', 'read', async (_args, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({status: 'interrupted', error: {code: 'interrupted', message: 'stop', retryable: false}}), {once: true})))); expect(await new ToolExecutor(registry, {workspaceRoot: '.', limits}).execute(call('slow'), new AbortController().signal)).toMatchObject({status: 'timeout', error: {code: 'timeout'}}); });
});

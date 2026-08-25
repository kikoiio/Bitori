import {describe, expect, it} from 'vitest';
import {ToolExecutor} from '../../../src/tools/executor.js';
import {ToolRegistry} from '../../../src/tools/registry.js';
import type {ToolCall} from '../../../src/tools/types.js';
import {MockTool} from '../../helpers/mock-tool.js';

const limits = {read: {timeoutMs: 30, maxResultBytes: 10, maxMatches: 2}, write: {timeoutMs: 30, maxResultBytes: 10, maxMatches: 2}, command: {timeoutMs: 30, maxResultBytes: 10, maxMatches: 2}};
const call = (name: string, effect: ToolCall['effect'] = 'read'): ToolCall => ({internalId: 'i', providerCallId: 'p', position: 0, name, arguments: {}, effect});
describe('ToolExecutor', () => {
  it('执行成功并注入固定限制', async () => { const registry = new ToolRegistry(); let observed = 0; registry.register(new MockTool('ok', 'read', async (_args, context) => { observed = context.limits.maxResultBytes; return {status: 'success', output: {ok: true}}; })); expect(await new ToolExecutor(registry, {workspaceRoot: '.', limits}).execute(call('ok'), new AbortController().signal)).toMatchObject({status: 'success'}); expect(observed).toBe(10); });
  it('归一化未知工具、异常和外部取消', async () => { const registry = new ToolRegistry(); registry.register(new MockTool('boom', 'read', async () => { throw new Error('boom'); })); const executor = new ToolExecutor(registry, {workspaceRoot: '.', limits}); expect(await executor.execute(call('missing'), new AbortController().signal)).toMatchObject({status: 'error', error: {code: 'unknown_tool'}}); expect(await executor.execute(call('boom'), new AbortController().signal)).toMatchObject({status: 'error', error: {code: 'internal_error'}}); const abort = new AbortController(); abort.abort(); expect(await executor.execute(call('boom'), abort.signal)).toMatchObject({status: 'interrupted'}); });
  it('固定超时转换为 timeout', async () => { const registry = new ToolRegistry(); registry.register(new MockTool('slow', 'read', async (_args, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({status: 'interrupted', error: {code: 'interrupted', message: 'stop', retryable: false}}), {once: true})))); expect(await new ToolExecutor(registry, {workspaceRoot: '.', limits}).execute(call('slow'), new AbortController().signal)).toMatchObject({status: 'timeout', error: {code: 'timeout'}}); });
});

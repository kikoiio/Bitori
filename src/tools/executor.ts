import {ZodError} from 'zod';
import type {ToolCall, ToolExecutionResult, ToolLimits} from './types.js';
import type {ToolRegistry} from './registry.js';
import type {PermissionEngine} from './permission-engine.js';

export interface ToolExecutorOptions {workspaceRoot: string; limits: Record<'read' | 'write' | 'command', ToolLimits>; permissions?: PermissionEngine}

/** 每次执行都注入固定限制并将所有路径收敛成一个结构化终态。 */
export class ToolExecutor {
  constructor(readonly registry: ToolRegistry, readonly options: ToolExecutorOptions) {}
  async execute(call: ToolCall, signal: AbortSignal, authorization?: {approvedCallId: string}): Promise<ToolExecutionResult> {
    const tool = this.registry.get(call.name);
    if (!tool) return {status: 'error', error: {code: 'unknown_tool', message: `未知工具：${call.name}`, retryable: false}};
    if (call.effect !== tool.effect) return {status: 'denied', error: {code: 'permission_denied', message: '工具效果与注册信息不一致', retryable: false}};
    if (signal.aborted) return {status: 'interrupted', error: {code: 'interrupted', message: '工具执行已取消', retryable: false}};
    if (this.options.permissions) {
      try {
        const check = await this.options.permissions.evaluate(call);
        if (signal.aborted) return {status: 'interrupted', error: {code: 'interrupted', message: '工具执行已取消', retryable: false}};
        if (check.decision === 'deny' || (check.decision === 'ask' && authorization?.approvedCallId !== call.internalId)) return this.options.permissions.denialResult(check);
      } catch (error) {
        return {status: 'denied', error: {code: error instanceof Error && 'code' in error && error.code === 'path_outside_workspace' ? 'path_outside_workspace' : 'permission_denied', message: error instanceof Error ? error.message : '路径未通过权限沙箱', retryable: false, details: {source: 'sandbox'}}};
      }
    }
    const timeout = AbortSignal.timeout(this.options.limits[tool.effect].timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const args = tool.parseArguments(call.arguments);
      combined.throwIfAborted();
      const result = await tool.execute(args, {workspaceRoot: this.options.workspaceRoot, signal: combined, limits: this.options.limits[tool.effect]});
      if (timeout.aborted && result.status === 'interrupted') return {status: 'timeout', error: {code: 'timeout', message: '工具执行超时', retryable: true}, ...('partialOutput' in result ? {partialOutput: result.partialOutput} : {})};
      return result;
    } catch (error) {
      if (timeout.aborted) return {status: 'timeout', error: {code: 'timeout', message: '工具执行超时', retryable: true}};
      if (signal.aborted) return {status: 'interrupted', error: {code: 'interrupted', message: '工具执行已取消', retryable: false}};
      if (error instanceof ZodError) return {status: 'error', error: {code: 'invalid_arguments', message: '工具参数无效', retryable: false, details: {issues: error.issues}}};
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : '工具内部异常', retryable: false}};
    }
  }
}

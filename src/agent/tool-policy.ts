import {ZodError} from 'zod';
import type {AgentMode} from './types.js';
import type {JsonObject, PreparedToolCall, ToolCallDraft, ToolDefinition, ToolExecutionResult} from '../tools/types.js';
import type {ToolRegistry} from '../tools/registry.js';

function failure(code: 'unknown_tool' | 'invalid_arguments' | 'tool_unavailable_in_mode', message: string, details?: JsonObject): ToolExecutionResult {
  return {status: 'error', error: {code, message, retryable: false, ...(details === undefined ? {} : {details})}};
}

/** [s03] 模式过滤和调用分类共享完整注册中心。 */
export class ToolPolicy {
  constructor(readonly registry: ToolRegistry, readonly mode: AgentMode) {}

  definitions(): ToolDefinition[] {
    return this.registry.entries().filter(tool => this.mode === 'execute' || tool.effect === 'read')
      .map(({name, description, inputSchema}) => ({name, description, inputSchema}));
  }

  prepare(draft: ToolCallDraft): PreparedToolCall {
    const tool = this.registry.get(draft.name);
    if (!tool) return {availability: 'unknown', draft, result: failure('unknown_tool', `未知工具：${draft.name}`)};
    let parsed: unknown;
    try { parsed = JSON.parse(draft.argumentsText || '{}'); }
    catch { return {availability: 'invalid', draft, result: failure('invalid_arguments', '工具参数不是有效 JSON', {raw: draft.argumentsText})}; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {availability: 'invalid', draft, result: failure('invalid_arguments', '工具参数必须是 JSON 对象')};
    try { parsed = tool.parseArguments(parsed); }
    catch (error) {
      const details = error instanceof ZodError ? {issues: error.issues} : undefined;
      return {availability: 'invalid', draft, result: failure('invalid_arguments', '工具参数无效', details)};
    }
    if (this.mode === 'plan' && tool.effect !== 'read') return {availability: 'unavailable_in_mode', draft, result: failure('tool_unavailable_in_mode', `当前 Plan Mode 不可使用工具：${draft.name}`)};
    return {availability: 'available', argumentsText: draft.argumentsText, call: {internalId: draft.internalId, providerCallId: draft.providerCallId ?? draft.internalId, position: draft.position, name: draft.name, arguments: parsed as JsonObject, effect: tool.effect}};
  }
}

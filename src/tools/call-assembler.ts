import type {StreamEvent} from '../providers/types.js';
import type {AssembledToolBatch, InvalidToolCall, ToolCallDraft, ToolError} from './types.js';
import type {ToolRegistry} from './registry.js';

function invalid(draft: ToolCallDraft, message: string): InvalidToolCall {
  const error: ToolError = {code: 'invalid_arguments', message, retryable: false}; return {...draft, error};
}

/** 参数分片以内部调用 ID 隔离，结束后才解析和校验不可信 JSON。 */
export class ToolCallAssembler {
  readonly #drafts = new Map<string, ToolCallDraft & {ended: boolean; issue?: string}>();
  constructor(readonly registry: ToolRegistry) {}
  consume(event: StreamEvent): void {
    if (event.type === 'tool_call_start') {
      if (this.#drafts.has(event.internalId)) { this.#drafts.get(event.internalId)!.issue = '调用重复开始'; return; }
      this.#drafts.set(event.internalId, {...event, argumentsText: '', ended: false});
    } else if (event.type === 'tool_call_arguments_delta') {
      const draft = this.#drafts.get(event.internalId); if (draft) draft.argumentsText += event.delta;
    } else if (event.type === 'tool_call_end') {
      const draft = this.#drafts.get(event.internalId); if (draft) draft.ended = true;
    }
  }
  finish(): AssembledToolBatch {
    const validCalls: AssembledToolBatch['validCalls'] = []; const invalidCalls: InvalidToolCall[] = [];
    for (const draft of [...this.#drafts.values()].sort((a, b) => a.position - b.position)) {
      if (draft.issue || !draft.ended || !draft.providerCallId) { invalidCalls.push(invalid(draft, draft.issue ?? '工具调用不完整')); continue; }
      const tool = this.registry.get(draft.name); if (!tool) { invalidCalls.push({...draft, error: {code: 'unknown_tool', message: `未知工具：${draft.name}`, retryable: false}}); continue; }
      try { const parsed: unknown = JSON.parse(draft.argumentsText); const arguments_ = tool.parseArguments(parsed); validCalls.push({internalId: draft.internalId, providerCallId: draft.providerCallId, position: draft.position, name: draft.name, arguments: arguments_, effect: tool.effect}); }
      catch { invalidCalls.push(invalid(draft, '工具参数不是符合约束的完整 JSON')); }
    }
    return {validCalls, invalidCalls};
  }
}

import {createToolCallId, now} from '../shared/ids.js';
import type {StreamEvent, Usage} from '../providers/types.js';
import type {AgentEvent, CollectedIteration} from './types.js';
import type {ToolCallDraft} from '../tools/types.js';
import type {ToolPolicy} from './tool-policy.js';

export interface StreamCollectorInput {runId: string; sessionId: string; iterationId: string; iteration: number; stream: AsyncIterable<StreamEvent>; toolPolicy: ToolPolicy; signal: AbortSignal}

/** [s03] 单次消费 Provider 流，同时实时转发并返回完整迭代。 */
export class StreamCollector {
  async *collect(input: StreamCollectorInput): AsyncGenerator<AgentEvent, CollectedIteration, void> {
    let text = ''; let thinking = ''; let finishReason: CollectedIteration['finishReason'] = null;
    let providerState: CollectedIteration['providerState'] = null; let error: CollectedIteration['error'] = null;
    let usage: Usage = {inputTokens: 0, outputTokens: 0}; let completed = false;
    const drafts = new Map<string, ToolCallDraft>();
    try {
      for await (const event of input.stream) {
        if (input.signal.aborted) break;
        const base = {runId: input.runId, sessionId: input.sessionId, at: now(), iterationId: input.iterationId};
        if (event.type === 'text_delta') { text += event.text; yield {...base, type: 'text_delta', delta: event.text}; }
        else if (event.type === 'thinking_delta') { thinking += event.text; yield {...base, type: 'thinking_delta', delta: event.text}; }
        else if (event.type === 'usage') {
          /* [s03 旧实现，s04 替换] usage 聚合只保留 inputTokens 与 outputTokens。 */
          // [s04] 缓存字段沿用「有值才覆盖」的保留语义：Anthropic 只在 message_start 上报，后续 usage 事件不清空已收到的值。
          usage = {
            inputTokens: event.usage.inputTokens || usage.inputTokens,
            outputTokens: event.usage.outputTokens || usage.outputTokens,
            ...(event.usage.cacheReadInputTokens !== undefined || usage.cacheReadInputTokens !== undefined ? {cacheReadInputTokens: event.usage.cacheReadInputTokens ?? usage.cacheReadInputTokens} : {}),
            ...(event.usage.cacheCreationInputTokens !== undefined || usage.cacheCreationInputTokens !== undefined ? {cacheCreationInputTokens: event.usage.cacheCreationInputTokens ?? usage.cacheCreationInputTokens} : {}),
          };
          yield {...base, type: 'usage_updated', iterationUsage: usage, totalUsage: usage};
        } else if (event.type === 'tool_call_start') {
          const draft: ToolCallDraft = {internalId: createToolCallId(), providerCallId: event.providerCallId, position: event.position, name: event.name, argumentsText: ''};
          drafts.set(event.internalId, draft);
          yield {...base, type: 'tool_call_started', callId: draft.internalId, providerCallId: draft.providerCallId, position: draft.position, name: draft.name};
        } else if (event.type === 'tool_call_arguments_delta') {
          const draft = drafts.get(event.internalId);
          if (draft) { draft.argumentsText += event.delta; yield {...base, type: 'tool_arguments_delta', callId: draft.internalId, delta: event.delta}; }
        } else if (event.type === 'completed') { completed = true; finishReason = event.finishReason; providerState = event.providerState ?? null; }
        else if (event.type === 'error') { error = event.error; break; }
      }
    } catch (caught) {
      error = {code: 'provider_error', message: caught instanceof Error ? caught.message : '模型流意外中断', retryable: false};
    }
    const cancelled = input.signal.aborted;
    if (!cancelled && !error && !completed) error = {code: 'provider_error', message: '模型流未产生正常结束事件', retryable: false};
    const calls = [...drafts.values()].sort((a, b) => a.position - b.position).map(draft => input.toolPolicy.prepare(draft));
    if (!error && !cancelled) for (const call of calls) yield {runId: input.runId, sessionId: input.sessionId, at: now(), type: 'tool_call_ready', iterationId: input.iterationId, call};
    return {iterationId: input.iterationId, iteration: input.iteration, text, thinking, usage, finishReason, providerState, calls, error, cancelled};
  }
}

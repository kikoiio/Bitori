import {createId, now} from '../shared/ids.js';
import type {LLMClient, ModelAssistantIterationItem, ModelToolResultsItem, Usage} from '../providers/types.js';
import type {ToolRegistry} from '../tools/registry.js';
import type {PreparedToolCall, ToolExecutionResult} from '../tools/types.js';
import {AgentContext} from './context.js';
import type {AgentEvent, AgentRunInput, AgentRunResult} from './types.js';
import type {StreamCollector} from './stream-collector.js';
import type {SafetyBatchScheduler} from './safety-batch-scheduler.js';
import {ToolPolicy} from './tool-policy.js';
import {ToolResultReplacementState} from '../toolresult/state.js';
import {applyToolResultBudget} from '../toolresult/budget.js';
import type {ModelContextItem} from '../providers/types.js';
import {computeKeepStartIndex, manageContext, usageAnchorFrom, type UsageAnchor} from '../compact/compact.js';
import type {HookEngine} from '../hooks/engine.js';
function computeKeep(items: readonly ModelContextItem[]): number { return computeKeepStartIndex(items); }
import {RecoveryState} from '../compact/recovery.js';

function callId(call: PreparedToolCall): string { return call.availability === 'available' ? call.call.internalId : call.draft.internalId; }
function providerCallId(call: PreparedToolCall): string | null { return call.availability === 'available' ? call.call.providerCallId : call.draft.providerCallId; }
function callName(call: PreparedToolCall): string { return call.availability === 'available' ? call.call.name : call.draft.name; }
function limitResult(): ToolExecutionResult { return {status: 'error', error: {code: 'agent_loop_limit', message: '已达到 20 次模型迭代上限，新的工具调用未执行', retryable: false}}; }

/** [s04] 累计用量；缓存字段只在 Anthropic 协议出现，双方都缺省时不带入结果。 */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined ? {cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0)} : {}),
    ...(a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined ? {cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0)} : {}),
  };
}

/** [s03] 唯一的自主 Agent 循环入口，不依赖存储或界面。 */
export class AgentRunner {
  constructor(readonly client: LLMClient, readonly registry: ToolRegistry, readonly collector: StreamCollector, readonly scheduler: SafetyBatchScheduler, readonly hooks: HookEngine | null = null) {}

  async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const maxIterations = input.limits?.maxIterations ?? 20;
    const maxUnknown = input.limits?.maxUnknownToolIterations ?? 3;
    const requestContext = input.trigger === 'do'
      ? input.context.map((item, index) => index === input.context.length - 1 && item.type === 'message' && item.role === 'user' ? {...item, content: input.instruction} : item)
      : input.context;
    const context = new AgentContext(requestContext);
    // [s04] 提醒注入位于最后一条用户消息之后，随后续每次迭代请求一起发送。
    for (const text of input.reminders ?? []) context.appendReminder({type: 'reminder', text});
    const policy = new ToolPolicy(this.registry, input.mode);
    let total: Usage = {inputTokens: 0, outputTokens: 0}; let unknownIterations = 0; let finalIterationId: string | null = null;
    const replacementState = new ToolResultReplacementState(); const recovery = new RecoveryState(); const tracking = {consecutiveFailures: 0}; let usageAnchor: UsageAnchor | null = null;
    const base = () => ({runId: input.runId, sessionId: input.sessionId, at: now()});
    await this.hooks?.fire('turn_start', {event: 'turn_start', message: input.instruction});
    try {
      yield {...base(), type: 'run_started', mode: input.mode, maxIterations};
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (signal.aborted) {
        const result: AgentRunResult = {runId: input.runId, status: 'cancelled', stopReason: 'user_cancelled', iterationCount: iteration - 1, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
      const iterationId = createId(); finalIterationId = iterationId;
      yield {...base(), type: 'iteration_started', iterationId, iteration};
      yield {...base(), type: 'progress', iteration, maxIterations, phase: 'streaming', completedTools: 0, totalTools: 0};
      /* [s07] 每次请求前先做全量摘要兜底，再做工具结果轻量预算；替换决策冻结以保护缓存前缀。 */
      let requestItems = [...context.items()];
      if (input.contextManagement?.windowTokens) {
        const compact = await manageContext({items: requestItems, client: this.client, contextWindow: input.contextManagement.windowTokens, tracking, recovery, tools: policy.definitions(), anchor: usageAnchor, signal});
        if (compact.compacted) {
          context.replaceItems([
            {type: 'message', messageId: 'compact-summary', role: 'user', content: `${compact.summary ?? ''}\n\n${recovery.buildRecoveryAttachment(policy.definitions())}`},
            ...requestItems.slice(computeKeep(requestItems))],
          );
          requestItems = [...context.items()];
        }
      }
      requestItems = input.contextManagement ? applyToolResultBudget(requestItems, input.contextManagement.workspaceRoot, replacementState) : requestItems;
      const generator = this.collector.collect({runId: input.runId, sessionId: input.sessionId, iterationId, iteration, stream: this.client.streamChat({items: requestItems, messages: [], tools: policy.definitions(), ...(input.system ? {system: input.system} : {})}, signal), toolPolicy: policy, signal});
      let response;
      while (true) {
        const step = await generator.next();
        if (step.done) { response = step.value; break; }
        const event = step.value;
        if (event.type === 'usage_updated') yield {...event, totalUsage: addUsage(total, event.iterationUsage)};
        else yield event;
      }
      total = addUsage(total, response.usage); usageAnchor = usageAnchorFrom(response.usage, requestItems);
      yield {...base(), type: 'iteration_finished', iterationId, iteration, response};
      if (response.cancelled || signal.aborted) {
        const result: AgentRunResult = {runId: input.runId, status: 'cancelled', stopReason: 'user_cancelled', iterationCount: iteration, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
      if (response.error) {
        const result: AgentRunResult = {runId: input.runId, status: 'failed', stopReason: 'stream_error', iterationCount: iteration, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
      const assistant: ModelAssistantIterationItem = {type: 'assistant_iteration', messageId: iterationId, content: response.text, ...(response.thinking ? {thinking: response.thinking} : {}), ...(response.providerState === null ? {} : {providerState: response.providerState}), toolCalls: response.calls.map(call => ({callId: callId(call), providerCallId: providerCallId(call), name: callName(call), argumentsText: call.availability === 'available' ? call.argumentsText : call.draft.argumentsText, arguments: call.availability === 'available' ? call.call.arguments : null}))};
      context.appendIteration(assistant);
      if (response.calls.length === 0) {
        const result: AgentRunResult = {runId: input.runId, status: 'completed', stopReason: 'natural_completion', iterationCount: iteration, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
      if (iteration === maxIterations) {
        const results = response.calls.map(call => ({callId: callId(call), providerCallId: providerCallId(call), name: callName(call), result: limitResult()}));
        for (const item of results) yield {...base(), type: 'tool_result', iterationId, callId: item.callId, result: item.result};
        context.appendToolResults({type: 'tool_results', assistantMessageId: iterationId, results});
        const result: AgentRunResult = {runId: input.runId, status: 'stopped', stopReason: 'iteration_limit', iterationCount: iteration, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
      unknownIterations = response.calls.every(call => call.availability === 'unknown') ? unknownIterations + 1 : 0;
      yield {...base(), type: 'progress', iteration, maxIterations, phase: 'scheduling_tools', completedTools: 0, totalTools: response.calls.length};
      const scheduler = this.scheduler.execute({runId: input.runId, sessionId: input.sessionId, iterationId, calls: response.calls, signal, iteration, maxIterations});
      let batch;
      while (true) { const step = await scheduler.next(); if (step.done) { batch = step.value; break; } yield step.value; }
      const toolResults: ModelToolResultsItem = {type: 'tool_results', assistantMessageId: iterationId, results: batch.orderedResults.map(({call, result}) => ({callId: callId(call), providerCallId: providerCallId(call), name: callName(call), result}))};
      context.appendToolResults(toolResults);
      if (signal.aborted) {
        const result: AgentRunResult = {runId: input.runId, status: 'cancelled', stopReason: 'user_cancelled', iterationCount: iteration, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
      if (unknownIterations >= maxUnknown) {
        const result: AgentRunResult = {runId: input.runId, status: 'stopped', stopReason: 'unknown_tool_limit', iterationCount: iteration, usage: total, finalIterationId};
        yield {...base(), type: 'run_finished', result}; return result;
      }
    }
    } finally {
      await this.hooks?.fire('turn_end', {event: 'turn_end'});
    }
    throw new Error('AgentRunner 到达不可达分支');
  }
}

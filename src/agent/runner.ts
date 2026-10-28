import {createId, now} from '../shared/ids.js';
import {createHash} from 'node:crypto';
import type {LLMClient, ModelAssistantIterationItem, ModelToolResultsItem, Usage} from '../providers/types.js';
import type {ToolDefinition} from '../tools/types.js';
import type {ToolRegistry} from '../tools/registry.js';
import type {PreparedToolCall, ToolExecutionResult} from '../tools/types.js';
import {AgentContext} from './context.js';
import type {AgentEvent, AgentRunInput, AgentRunResult} from './types.js';
import type {StreamCollector} from './stream-collector.js';
import type {SafetyBatchScheduler} from './safety-batch-scheduler.js';
import {ToolPolicy} from './tool-policy.js';
import {ToolResultReplacementState} from '../toolresult/state.js';
import {applyToolResultBudget} from '../toolresult/budget.js';
import {compactionBoundaryMessageId, manageContext} from '../compact/compact.js';
import {usageAnchorFrom, type UsageAnchor} from '../shared/token-estimate.js';
import type {HookEngine} from '../hooks/engine.js';

function callId(call: PreparedToolCall): string { return call.availability === 'available' ? call.call.internalId : call.draft.internalId; }
function providerCallId(call: PreparedToolCall): string | null { return call.availability === 'available' ? call.call.providerCallId : call.draft.providerCallId; }
function callName(call: PreparedToolCall): string { return call.availability === 'available' ? call.call.name : call.draft.name; }
function limitResult(): ToolExecutionResult { return {status: 'error', error: {code: 'agent_loop_limit', message: '已达到 20 次模型迭代上限，新的工具调用未执行', retryable: false}}; }

/** 工具定义指纹：内容变化才随 request_prepared 携带完整定义，其余轮次只带摘要。 */
function definitionsDigest(definitions: readonly ToolDefinition[]): string {
  return createHash('sha256').update(JSON.stringify(definitions)).digest('hex').slice(0, 16);
}

/** 累计用量；缓存字段只在 Anthropic 协议出现，双方都缺省时不带入结果。 */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined ? {cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0)} : {}),
    ...(a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined ? {cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0)} : {}),
  };
}

/** 唯一的自主 Agent 循环入口，不依赖存储或界面。 */
export class AgentRunner {
  constructor(readonly client: LLMClient, readonly registry: ToolRegistry, readonly collector: StreamCollector, readonly scheduler: SafetyBatchScheduler, readonly hooks: HookEngine | null = null) {}

  async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const maxIterations = input.limits?.maxIterations ?? 20;
    const maxUnknown = input.limits?.maxUnknownToolIterations ?? 3;
    const lastUser = input.context.findLast(item => item.type === 'message' && item.role === 'user');
    const userMessageId = input.userMessageId ?? (lastUser?.type === 'message' ? lastUser.messageId : undefined);
    const requestContext = input.context.map(item => item.type === 'message' && item.role === 'user' && item.messageId === userMessageId ? {...item, content: input.instruction} : item);
    const context = new AgentContext(requestContext);
    // 提醒注入位于最后一条用户消息之后，随后续每次迭代请求一起发送。
    for (const text of input.reminders ?? []) context.appendReminder({type: 'reminder', text});
    const policy = new ToolPolicy(this.registry, input.mode);
    let total: Usage = {inputTokens: 0, outputTokens: 0}; let unknownIterations = 0; let finalIterationId: string | null = null;
    const replacementState = new ToolResultReplacementState(); const tracking = {consecutiveFailures: 0}; let usageAnchor: UsageAnchor | null = null;
    const retryBaseDelayMs = input.limits?.retryBaseDelayMs ?? 5_000;
    let retryDelayMs = retryBaseDelayMs;
    let retriesLeft = 3;
    let lastToolDefinitionDigest: string | null = null;
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
      /* 每次请求前先做全量摘要兜底，再做工具结果轻量预算；替换决策冻结以保护缓存前缀。 */
      let requestItems = [...context.items()];
      if (input.contextManagement?.windowTokens) {
        const compact = await manageContext({items: requestItems, client: this.client, contextWindow: input.contextManagement.windowTokens, tracking, tools: policy.definitions(), anchor: usageAnchor, signal});
        if (compact.compacted) {
          const boundaryMessageId = compactionBoundaryMessageId(requestItems, compact.keepIndex);
          yield {...base(), type: 'context_compacted', beforeTokens: compact.beforeTokens, afterTokens: compact.afterTokens, keepIndex: compact.keepIndex, reason: 'auto', boundaryMessageId, items: compact.checkpointItems};
          context.replaceItems(compact.items);
          usageAnchor = null;
          await this.hooks?.fire('compact', {event: 'compact', message: `${compact.beforeTokens} -> ${compact.afterTokens}`});
          requestItems = [...context.items()];
        }
      }
      requestItems = input.contextManagement ? applyToolResultBudget(requestItems, input.contextManagement.workspaceRoot, replacementState) : requestItems;
      await this.hooks?.fire('pre_send', {event: 'pre_send', message: input.instruction});
      // 每次迭代发出请求级事件；工具定义内容变化才携带完整定义。
      const definitions = policy.definitions();
      const toolDefinitionDigest = definitionsDigest(definitions);
      const definitionsChanged = toolDefinitionDigest !== lastToolDefinitionDigest;
      lastToolDefinitionDigest = toolDefinitionDigest;
      yield {...base(), type: 'request_prepared', iterationId, iteration, items: requestItems, system: input.system ?? [], toolDefinitions: definitionsChanged ? definitions : [], toolDefinitionDigest};
      let response;
      let attempt = 1;
      while (true) {
        let visible = false;
        const generator = this.collector.collect({runId: input.runId, sessionId: input.sessionId, iterationId, iteration, stream: this.client.streamChat({items: requestItems, messages: [], tools: policy.definitions(), ...(input.system ? {system: input.system} : {})}, signal), toolPolicy: policy, signal});
        while (true) {
          const step = await generator.next();
          if (step.done) { response = step.value; break; }
          const event = step.value;
          if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_call_started' || event.type === 'tool_arguments_delta') visible = true;
          if (event.type === 'usage_updated') yield {...event, totalUsage: addUsage(total, event.iterationUsage)};
          else yield event;
        }
        // 429/网络/5xx 属于瞬时故障：指数退避后重发同一迭代，而不是终止整个任务。
        if (!response.error?.retryable || signal.aborted || retriesLeft === 0 || visible) { retryDelayMs = retryBaseDelayMs; retriesLeft = 3; break; }
        await this.hooks?.fire('error', {event: 'error', error: `第 ${iteration} 轮请求失败（${response.error.code}），${retryDelayMs / 1000} 秒后重试`});
        yield {...base(), type: 'request_retry', iterationId, iteration, attempt, delayMs: retryDelayMs, error: response.error};
        retriesLeft--;
        attempt += 1;
        await new Promise<void>(resolve => {
          if (signal.aborted) { resolve(); return; }
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, retryDelayMs);
          signal.addEventListener('abort', done, {once: true});
        });
        if (signal.aborted) { response = {...response, cancelled: true}; break; }
        total = addUsage(total, response.usage);
        retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
      }
      total = addUsage(total, response.usage); usageAnchor = usageAnchorFrom(response.usage, requestItems);
      yield {...base(), type: 'iteration_finished', iterationId, iteration, response};
      if (response.error) await this.hooks?.fire('error', {event: 'error', error: response.error.message});
      else await this.hooks?.fire('post_receive', {event: 'post_receive', message: response.text});
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

import {now} from '../shared/ids.js';
import {getLogger} from '../shared/logger.js';
import type {AgentEvent} from '../agent/types.js';
import type {ModelContextItem, Usage} from '../providers/types.js';
import type {PromptBlock} from '../prompt/builder.js';
import type {ToolDefinition} from '../tools/types.js';
import {composeBuckets, compositionTotal} from './composition.js';
import {TRACE_VERSION, type ContextCompositionBuckets, type TraceToolCallSummary} from './types.js';
import type {TraceWriter} from './writer.js';

const logger = getLogger('trace');
const DEBUG_RING_LIMIT = 120;

/** TUI 调试面板的单条摘要。 */
export interface DebugEntry {at: number; text: string}

export interface AgentTraceTapOptions {
  profileName: string;
  model: string;
  protocol: string;
  workspaceRoot: string;
  /** 使用统计联动：load_skill 成功时回调（含技能名与会话）。 */
  onSkillActivated?: (name: string, sessionId: string) => void;
}

interface PendingRequest {
  items: readonly ModelContextItem[];
  system: readonly PromptBlock[];
  preparedAt: number;
}

function callOf(event: Extract<AgentEvent, {type: 'tool_call_ready'}>): {internalId: string; name: string; argumentsText: string; arguments: Record<string, unknown>} {
  if (event.call.availability === 'available') {
    const call = event.call.call;
    return {internalId: call.internalId, name: call.name, argumentsText: event.call.argumentsText, arguments: call.arguments};
  }
  const draft = event.call.draft;
  return {internalId: draft.internalId, name: draft.name, argumentsText: draft.argumentsText, arguments: {}};
}

/**
 * AgentEvent 的第二订阅者：把内存事件流投影为持久 trace 与 TUI 调试摘要。
 * 所有方法火后不理，绝不加入控制器的持久化屏障。
 */
export class AgentTraceTap {
  readonly #writer: TraceWriter;
  readonly #options: AgentTraceTapOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #lastToolDefinitions: ToolDefinition[] = [];
  readonly #calls = new Map<string, {name: string; skillName: string | null}>();
  readonly #debug: DebugEntry[] = [];

  constructor(writer: TraceWriter, options: AgentTraceTapOptions) {
    this.#writer = writer;
    this.#options = options;
  }

  runHeader(sessionId: string, runId: string, mode: 'plan' | 'execute', trigger: 'message' | 'do'): void {
    this.#writer.append({v: TRACE_VERSION, at: now(), sessionId, type: 'run_header', runId, profileName: this.#options.profileName, model: this.#options.model, protocol: this.#options.protocol, mode, trigger, workspaceRoot: this.#options.workspaceRoot});
    this.#debugPush(`run 开始 ${mode}/${trigger}`);
  }

  fact(sessionId: string, fact: string, data?: Record<string, unknown>): void {
    this.#writer.append({v: TRACE_VERSION, at: now(), sessionId, type: 'domain_fact', fact, ...(data === undefined ? {} : {data})});
    this.#debugPush(`事实 ${fact}`);
  }

  record(event: AgentEvent): void {
    try {
      this.#dispatch(event);
    } catch (error) {
      logger.warn('trace 投影失败', {type: event.type, error: error instanceof Error ? error.message : String(error)});
    }
  }

  recentDebugEntries(limit = DEBUG_RING_LIMIT): DebugEntry[] {
    return this.#debug.slice(-limit);
  }

  async flush(): Promise<void> { await this.#writer.flush(); }

  #debugPush(text: string): void {
    this.#debug.push({at: now(), text});
    if (this.#debug.length > DEBUG_RING_LIMIT) this.#debug.shift();
  }

  #dispatch(event: AgentEvent): void {
    switch (event.type) {
      case 'request_prepared': {
        this.#pending.set(event.runId, {items: event.items, system: event.system, preparedAt: event.at});
        if (event.toolDefinitions.length > 0) this.#lastToolDefinitions = event.toolDefinitions;
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'request_prepared', runId: event.runId, iterationId: event.iterationId, iteration: event.iteration, items: event.items, system: event.system, toolDefinitions: event.toolDefinitions, toolDefinitionDigest: event.toolDefinitionDigest});
        this.#debugPush(`it${event.iteration} 请求 ${event.items.length} 项`);
        return;
      }
      case 'request_retry': {
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'request_retry', runId: event.runId, iterationId: event.iterationId, iteration: event.iteration, attempt: event.attempt, delayMs: event.delayMs, errorCode: event.error.code, errorMessage: event.error.message});
        this.#debugPush(`it${event.iteration} 重试 #${event.attempt}（${event.error.code}）`);
        return;
      }
      case 'context_compacted': {
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'context_compacted', runId: event.runId, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens, keepIndex: event.keepIndex, reason: event.reason});
        this.#debugPush(`压缩 ${event.beforeTokens}→${event.afterTokens}`);
        return;
      }
      case 'iteration_finished': {
        this.#recordIteration(event);
        return;
      }
      case 'tool_call_ready': {
        const call = callOf(event);
        const skillName = call.name === 'load_skill' && typeof call.arguments['name'] === 'string' ? call.arguments['name'] : null;
        this.#calls.set(call.internalId, {name: call.name, skillName});
        this.#debugPush(`工具就绪 ${call.name}(${call.argumentsText.slice(0, 80)})`);
        return;
      }
      case 'tool_result': {
        const entry = this.#calls.get(event.callId);
        if (entry?.skillName !== undefined && entry.skillName !== null && event.result.status === 'success') {
          this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'domain_fact', fact: 'skill_activated', data: {name: entry.skillName, source: 'model'}});
          this.#options.onSkillActivated?.(entry.skillName, event.sessionId);
          this.#debugPush(`技能激活 ${entry.skillName}`);
        }
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'agent_event', event});
        this.#debugPush(`工具完成 ${entry?.name ?? event.callId}`);
        return;
      }
      case 'approval_resolved': {
        const entry = this.#calls.get(event.callId);
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'domain_fact', fact: 'approval_resolved', data: {callId: event.callId, tool: entry?.name ?? null, decision: event.decision ?? 'denied'}});
        this.#debugPush(`审批 ${event.decision ?? 'denied'} ${entry?.name ?? ''}`);
        return;
      }
      case 'run_finished': {
        this.#pending.delete(event.runId);
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'agent_event', event});
        this.#debugPush(`run 结束 ${event.result.stopReason}`);
        return;
      }
      default: {
        this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'agent_event', event});
      }
    }
  }

  #recordIteration(event: Extract<AgentEvent, {type: 'iteration_finished'}>): void {
    const pending = this.#pending.get(event.runId);
    const response = event.response;
    const toolCalls: TraceToolCallSummary[] = response.calls.map(call => ({
      callId: call.availability === 'available' ? call.call.internalId : call.draft.internalId,
      providerCallId: call.availability === 'available' ? call.call.providerCallId : call.draft.providerCallId,
      name: call.availability === 'available' ? call.call.name : call.draft.name,
      argumentsText: call.availability === 'available' ? call.argumentsText : call.draft.argumentsText,
    }));
    this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'response', runId: event.runId, iterationId: event.iterationId, iteration: event.iteration, text: response.text, thinking: response.thinking, toolCalls, usage: response.usage, finishReason: response.finishReason, providerState: response.providerState, errorCode: response.error?.code ?? null, errorMessage: response.error?.message ?? null, durationMs: pending === undefined ? 0 : Math.max(0, event.at - pending.preparedAt)});
    const names = toolCalls.map(call => call.name).join(', ');
    this.#debugPush(`it${event.iteration} 响应 ${response.text.length} 字，工具 [${names}]`);
    if (pending !== undefined && !response.error && !response.cancelled) this.#recordComposition(event, pending, response.usage);
    this.#pending.delete(event.runId);
  }

  #recordComposition(event: Extract<AgentEvent, {type: 'iteration_finished'}>, pending: PendingRequest, usage: Usage): void {
    const buckets: ContextCompositionBuckets = composeBuckets({items: pending.items, system: pending.system, toolDefinitions: this.#lastToolDefinitions});
    const estimatedTotal = compositionTotal(buckets);
    const providerInputTokens = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
    this.#writer.append({v: TRACE_VERSION, at: event.at, sessionId: event.sessionId, type: 'context_composition', runId: event.runId, iterationId: event.iterationId, iteration: event.iteration, buckets, estimatedTotal, providerInputTokens, delta: estimatedTotal - providerInputTokens});
  }
}

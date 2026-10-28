import {now} from '../shared/ids.js';
import type {AgentEvent, AgentMode} from '../agent/types.js';
import type {AppState} from './state.js';
import type {FinalMessageUpdate, SessionRepositoryContract, StoredMessage, ToolCallRecord} from '../storage/types.js';
import type {PreparedToolCall} from '../tools/types.js';

function callId(call: PreparedToolCall): string { return call.availability === 'available' ? call.call.internalId : call.draft.internalId; }

/** 事件消费的写盘顺序构成 Agent 继续推进前的持久化屏障。 */
export class AgentEventProjector {
  #state: AppState;
  readonly #records = new Map<string, ToolCallRecord>();
  readonly #mode: AgentMode;
  constructor(readonly repository: SessionRepositoryContract, initialState: AppState, readonly publish: (state: AppState) => void, mode: AgentMode) { this.#state = initialState; this.#mode = mode; }

  async project(event: AgentEvent): Promise<void> {
    if (event.type === 'run_started') this.#set({...this.#state, activeRunId: event.runId, agentMode: event.mode, requestStatus: 'streaming', iteration: 0, maxIterations: event.maxIterations, agentPhase: 'preparing', runUsage: {inputTokens: 0, outputTokens: 0}, stopReason: null, visibleError: null});
    else if (event.type === 'iteration_started') {
      const message = await this.repository.beginAgentIteration({messageId: event.iterationId, runId: event.runId, sessionId: event.sessionId, iteration: event.iteration});
      this.#set({...this.#state, messages: [...this.#state.messages, message], iteration: event.iteration, requestStatus: 'streaming'});
    } else if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const current = this.#state.messages.find(message => message.id === event.iterationId);
      if (!current) throw new Error(`缺少迭代消息：${event.iterationId}`);
      const message: StoredMessage = event.type === 'text_delta' ? {...current, content: current.content + event.delta, updatedAt: event.at} : {...current, thinking: current.thinking + event.delta, updatedAt: event.at};
      await this.repository.checkpointAssistant(message.id, message.content, message.thinking);
      this.#set({...this.#state, messages: this.#state.messages.map(item => item.id === message.id ? message : item), requestStatus: event.type === 'thinking_delta' ? 'thinking' : 'streaming'});
    } else if (event.type === 'usage_updated') this.#set({...this.#state, latestUsage: event.iterationUsage, runUsage: event.totalUsage});
    else if (event.type === 'progress') this.#set({...this.#state, iteration: event.iteration, maxIterations: event.maxIterations, agentPhase: event.phase, requestStatus: event.phase === 'awaiting_approval' ? 'approving' : event.phase === 'executing_tools' || event.phase === 'scheduling_tools' ? 'executing_tools' : this.#state.requestStatus});
    else if (event.type === 'approval_requested') this.#set({...this.#state, approvalPrompt: event.prompt, requestStatus: 'approving', agentPhase: 'awaiting_approval'});
    else if (event.type === 'approval_resolved') {
      const record = this.#records.get(event.callId);
      if (record) { const approvalStatus: ToolCallRecord['approvalStatus'] = event.decision === 'denied' ? 'denied' : event.decision === undefined ? 'denied' : 'approved'; const updated: ToolCallRecord = {...record, approvalStatus, updatedAt: event.at}; this.#records.set(event.callId, updated); await this.repository.updateToolCall(updated); this.#replaceTool(updated); }
      this.#set({...this.#state, approvalPrompt: null, requestStatus: 'executing_tools', agentPhase: 'executing_tools'});
    }
    else if (event.type === 'iteration_finished') await this.#finishIteration(event);
    else if (event.type === 'tool_status') {
      const record = this.#records.get(event.callId); if (!record) return;
      const updated = {...record, executionStatus: event.status, updatedAt: event.at}; this.#records.set(event.callId, updated); await this.repository.updateToolCall(updated); this.#replaceTool(updated);
    } else if (event.type === 'tool_result') {
      const record = this.#records.get(event.callId); if (!record) return;
      const executionStatus: ToolCallRecord['executionStatus'] = event.result.status === 'success' ? 'succeeded' : event.result.status === 'timeout' ? 'timed_out' : event.result.status === 'interrupted' ? 'interrupted' : event.result.status === 'denied' ? 'skipped' : 'failed';
      const updated = {...record, result: event.result, executionStatus, updatedAt: event.at}; this.#records.set(event.callId, updated); await this.repository.updateToolCall(updated); this.#replaceTool(updated);
    } else if (event.type === 'run_finished') {
      const latestPlan = this.#mode === 'plan' && event.result.stopReason === 'natural_completion' ? event.result.finalIterationId ?? undefined : undefined;
      await this.repository.finishAgentRun(event.runId, event.result, latestPlan);
      const failed = [...this.#state.messages].findLast(message => message.role === 'assistant' && message.status === 'failed');
      const detail = failed?.errorMessage === undefined || failed.errorMessage === null ? '' : `：${failed.errorMessage}`;
      const message = event.result.stopReason === 'natural_completion' ? null : `Agent 已停止：${event.result.stopReason}${detail}`;
      this.#set({...this.#state, activeRunId: null, requestStatus: event.result.status === 'failed' ? 'failed' : 'idle', agentPhase: 'finishing', runUsage: event.result.usage, stopReason: event.result.stopReason, approvalPrompt: null, visibleError: message});
    }
  }

  async flush(): Promise<void> { await Promise.resolve(); }

  async #finishIteration(event: Extract<AgentEvent, {type: 'iteration_finished'}>): Promise<void> {
    const message = this.#state.messages.find(item => item.id === event.iterationId); if (!message) throw new Error(`缺少迭代消息：${event.iterationId}`);
    const response = event.response;
    const status: FinalMessageUpdate['status'] = response.cancelled ? 'cancelled' : response.error ? 'failed' : 'completed';
    const update: FinalMessageUpdate = {content: response.text, thinking: response.thinking, status, error: response.error, usage: response.usage, providerState: response.providerState};
    const records = response.calls.map(call => {
      const available = call.availability === 'available'; const id = callId(call); const timestamp = now();
      const record: ToolCallRecord = {id, sessionId: event.sessionId, assistantMessageId: event.iterationId, providerCallId: available ? call.call.providerCallId : call.draft.providerCallId, position: available ? call.call.position : call.draft.position, toolName: available ? call.call.name : call.draft.name, arguments: available ? call.call.arguments : {raw: call.draft.argumentsText}, argumentsText: available ? call.argumentsText : call.draft.argumentsText, agentRunId: event.runId, approvalStatus: available && call.call.effect !== 'read' ? 'pending' : 'not_required', executionStatus: available ? 'queued' : 'failed', result: available ? null : call.result, createdAt: timestamp, updatedAt: timestamp};
      this.#records.set(id, record); return record;
    });
    await this.repository.finalizeIterationWithToolBatch(message.id, update, records);
    const finalMessage = {...message, content: response.text, thinking: response.thinking, status, errorCode: response.error?.code ?? null, errorMessage: response.error?.message ?? null, usage: response.usage, providerState: response.providerState, updatedAt: event.at};
    this.#set({...this.#state, messages: this.#state.messages.map(item => item.id === finalMessage.id ? finalMessage : item), toolCalls: [...this.#state.toolCalls, ...records]});
  }

  #replaceTool(record: ToolCallRecord): void { this.#set({...this.#state, toolCalls: this.#state.toolCalls.map(item => item.id === record.id ? record : item)}); }
  #set(state: AppState): void { this.#state = state; this.publish(state); }
}

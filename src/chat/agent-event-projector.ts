import {now} from '../shared/ids.js';
import type {AgentEvent, AgentMode} from '../agent/types.js';
import {providerErrorGuidance} from '../providers/errors.js';
import type {AppState} from './state.js';
import type {FinalMessageUpdate, SessionRepositoryContract, StoredMessage, ToolCallRecord} from '../storage/types.js';
import type {PreparedToolCall} from '../tools/types.js';

function callId(call: PreparedToolCall): string { return call.availability === 'available' ? call.call.internalId : call.draft.internalId; }

/** 事件消费的写盘顺序构成 Agent 继续推进前的持久化屏障。 */
export class AgentEventProjector {
  readonly #records = new Map<string, ToolCallRecord>();
  readonly #mode: AgentMode;
  /** 状态只有控制器一份：投影器每次都基于控制器的最新状态改，避免覆盖控制器侧的新增（排队消息等）。 */
  readonly #getState: () => AppState;
  constructor(readonly repository: SessionRepositoryContract, getState: () => AppState, readonly publish: (state: AppState) => void, mode: AgentMode) { this.#getState = getState; this.#mode = mode; }

  async project(event: AgentEvent): Promise<void> {
    if (event.type === 'run_started') this.#set({...this.#getState(), activeRunId: event.runId, agentMode: event.mode, requestStatus: 'streaming', iteration: 0, maxIterations: event.maxIterations, agentPhase: 'preparing', runUsage: {inputTokens: 0, outputTokens: 0}, stopReason: null, visibleError: null, liveToolCalls: []});
    else if (event.type === 'context_compacted') {
      await this.repository.saveContextCheckpoint(event.sessionId, {boundaryMessageId: event.boundaryMessageId, items: event.items});
    }
    else if (event.type === 'iteration_started') {
      const message = await this.repository.beginAgentIteration({messageId: event.iterationId, runId: event.runId, sessionId: event.sessionId, iteration: event.iteration});
      this.#set({...this.#getState(), messages: [...this.#getState().messages, message], iteration: event.iteration, requestStatus: 'streaming', liveToolCalls: []});
    } else if (event.type === 'tool_call_started') {
      this.#set({...this.#getState(), liveToolCalls: [...this.#getState().liveToolCalls.filter(call => call.callId !== event.callId), {callId: event.callId, iterationId: event.iterationId, name: event.name, argumentsText: '', ready: false}]});
    } else if (event.type === 'tool_arguments_delta') {
      this.#set({...this.#getState(), liveToolCalls: this.#getState().liveToolCalls.map(call => call.callId === event.callId ? {...call, argumentsText: call.argumentsText + event.delta} : call)});
    } else if (event.type === 'tool_call_ready') {
      const id = event.call.availability === 'available' ? event.call.call.internalId : event.call.draft.internalId;
      const argumentsText = event.call.availability === 'available' ? event.call.argumentsText : event.call.draft.argumentsText;
      this.#set({...this.#getState(), liveToolCalls: this.#getState().liveToolCalls.map(call => call.callId === id ? {...call, argumentsText, ready: true} : call)});
    } else if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const current = this.#getState().messages.find(message => message.id === event.iterationId);
      if (!current) throw new Error(`缺少迭代消息：${event.iterationId}`);
      const message: StoredMessage = event.type === 'text_delta' ? {...current, content: current.content + event.delta, updatedAt: event.at} : {...current, thinking: current.thinking + event.delta, updatedAt: event.at};
      await this.repository.checkpointAssistant(message.id, message.content, message.thinking);
      this.#set({...this.#getState(), messages: this.#getState().messages.map(item => item.id === message.id ? message : item), requestStatus: event.type === 'thinking_delta' ? 'thinking' : 'streaming'});
    } else if (event.type === 'usage_updated') this.#set({...this.#getState(), latestUsage: event.iterationUsage, runUsage: event.totalUsage});
    else if (event.type === 'progress') this.#set({...this.#getState(), iteration: event.iteration, maxIterations: event.maxIterations, agentPhase: event.phase, requestStatus: event.phase === 'awaiting_approval' ? 'approving' : event.phase === 'executing_tools' || event.phase === 'scheduling_tools' ? 'executing_tools' : this.#getState().requestStatus});
    else if (event.type === 'approval_requested') this.#set({...this.#getState(), approvalPrompt: event.prompt, requestStatus: 'approving', agentPhase: 'awaiting_approval'});
    else if (event.type === 'approval_resolved') {
      const record = this.#records.get(event.callId);
      if (record) { const approvalStatus: ToolCallRecord['approvalStatus'] = event.decision === 'denied' ? 'denied' : event.decision === undefined ? 'denied' : 'approved'; const updated: ToolCallRecord = {...record, approvalStatus, updatedAt: event.at}; this.#records.set(event.callId, updated); await this.repository.updateToolCall(updated); this.#replaceTool(updated); }
      this.#set({...this.#getState(), approvalPrompt: null, requestStatus: 'executing_tools', agentPhase: 'executing_tools'});
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
      const failed = [...this.#getState().messages].findLast(message => message.role === 'assistant' && message.status === 'failed');
      const detail = failed?.errorMessage === undefined || failed.errorMessage === null ? '' : `：${failed.errorMessage}`;
      const guidance = failed?.errorCode === undefined || failed.errorCode === null ? '' : ` ${providerErrorGuidance(failed.errorCode)}`;
      const message = event.result.stopReason === 'natural_completion' ? null : `Agent 已停止：${event.result.stopReason}${detail}${guidance}`;
      this.#set({...this.#getState(), activeRunId: null, requestStatus: event.result.status === 'failed' ? 'failed' : 'idle', agentPhase: 'finishing', runUsage: event.result.usage, stopReason: event.result.stopReason, approvalPrompt: null, visibleError: message, liveToolCalls: []});
    }
  }

  async #finishIteration(event: Extract<AgentEvent, {type: 'iteration_finished'}>): Promise<void> {
    const message = this.#getState().messages.find(item => item.id === event.iterationId); if (!message) throw new Error(`缺少迭代消息：${event.iterationId}`);
    const response = event.response;
    const status: FinalMessageUpdate['status'] = response.cancelled ? 'cancelled' : response.error ? 'failed' : 'completed';
    const update: FinalMessageUpdate = {content: response.text, thinking: response.thinking, status, error: response.error, usage: response.usage, providerState: response.providerState};
    const records = (response.cancelled || response.error ? [] : response.calls).map(call => {
      const available = call.availability === 'available'; const id = callId(call); const timestamp = now();
      const record: ToolCallRecord = {id, sessionId: event.sessionId, assistantMessageId: event.iterationId, providerCallId: available ? call.call.providerCallId : call.draft.providerCallId, position: available ? call.call.position : call.draft.position, toolName: available ? call.call.name : call.draft.name, arguments: available ? call.call.arguments : {raw: call.draft.argumentsText}, argumentsText: available ? call.argumentsText : call.draft.argumentsText, agentRunId: event.runId, approvalStatus: available && call.call.effect !== 'read' ? 'pending' : 'not_required', executionStatus: available ? 'queued' : 'failed', result: available ? null : call.result, createdAt: timestamp, updatedAt: timestamp};
      this.#records.set(id, record); return record;
    });
    await this.repository.finalizeIterationWithToolBatch(message.id, update, records);
    const finalMessage = {...message, content: response.text, thinking: response.thinking, status, errorCode: response.error?.code ?? null, errorMessage: response.error?.message ?? null, usage: response.usage, providerState: response.providerState, updatedAt: event.at};
    this.#set({...this.#getState(), messages: this.#getState().messages.map(item => item.id === finalMessage.id ? finalMessage : item), toolCalls: [...this.#getState().toolCalls, ...records], liveToolCalls: this.#getState().liveToolCalls.filter(call => call.iterationId !== event.iterationId)});
  }

  #replaceTool(record: ToolCallRecord): void { this.#set({...this.#getState(), toolCalls: this.#getState().toolCalls.map(item => item.id === record.id ? record : item)}); }
  #set(state: AppState): void { this.publish(state); }
}

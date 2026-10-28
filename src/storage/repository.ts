import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {configPaths} from '../config/loader.js';
import {StorageError} from '../shared/errors.js';
import {StorageWorkerClient} from './worker-client.js';
import type {BeginTurnResult, ContextCheckpoint, FinalMessageUpdate, Session, SessionRepositoryContract, StoredConversation, StoredMessage, ToolCallRecord, AgentRunRecord} from './types.js';
import type {AgentMode, AgentRunResult} from '../agent/types.js';

/**
 * 面向业务层的仓储门面。
 * 它把易用的具体方法翻译为 Worker 消息，并在这里集中做数据库目录创建。
 */
export class SessionRepository implements SessionRepositoryContract {
  readonly #client: StorageWorkerClient;

  public constructor(databasePath = configPaths().database, workerUrl?: URL) {
    mkdirSync(dirname(databasePath), {recursive: true});
    this.#client = new StorageWorkerClient(databasePath, workerUrl);
  }

  // 下列方法虽然大多只是转发，但保住了“控制器不认识 Worker 协议”的架构边界。
  public async initialize(options?: {recover?: boolean}): Promise<void> { await this.#client.request({type: 'initialize', ...(options?.recover === undefined ? {} : {recover: options.recover})}); }
  public async findLatestSession(profileName: string): Promise<Session | null> {
    return this.#client.request({type: 'find_latest_session', profileName}) as Promise<Session | null>;
  }
  public async listSessions(profileName: string): Promise<Session[]> {
    return this.#client.request({type: 'list_sessions', profileName}) as Promise<Session[]>;
  }
  public async createSession(profileName: string): Promise<Session> {
    return this.#client.request({type: 'create_session', profileName}) as Promise<Session>;
  }
  public async getSession(sessionId: string): Promise<Session | null> {
    return this.#client.request({type: 'get_session', sessionId}) as Promise<Session | null>;
  }
  public async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.#client.request({type: 'get_messages', sessionId}) as Promise<StoredMessage[]>;
  }
  public async getConversation(sessionId: string): Promise<StoredConversation | null> { return this.#client.request({type: 'get_conversation', sessionId}) as Promise<StoredConversation | null>; }
  public async saveContextCheckpoint(sessionId: string, checkpoint: ContextCheckpoint): Promise<void> { await this.#client.request({type: 'save_context_checkpoint', sessionId, checkpoint}); }
  public async saveToolBatch(records: ToolCallRecord[]): Promise<void> { await this.#client.request({type: 'save_tool_batch', records}); }
  public async finalizeAssistantWithToolBatch(messageId: string, update: FinalMessageUpdate, records: ToolCallRecord[]): Promise<void> { await this.#client.request({type: 'finalize_assistant_with_tool_batch', messageId, update, records}); }
  public async updateToolCall(record: ToolCallRecord): Promise<void> { await this.#client.request({type: 'update_tool_call', record}); }
  public async beginTurn(sessionId: string, text: string): Promise<BeginTurnResult> {
    return this.#client.request({type: 'begin_turn', sessionId, text}) as Promise<BeginTurnResult>;
  }
  public async beginAssistantContinuation(sessionId: string): Promise<StoredMessage> { return this.#client.request({type: 'begin_assistant_continuation', sessionId}) as Promise<StoredMessage>; }
  public async checkpointAssistant(messageId: string, content: string, thinking: string): Promise<void> {
    await this.#client.request({type: 'checkpoint_assistant', messageId, content, thinking});
  }
  public async finalizeMessage(messageId: string, update: FinalMessageUpdate): Promise<void> {
    await this.#client.request({type: 'finalize_message', messageId, update});
  }
  public async setSessionMode(sessionId: string, mode: AgentMode): Promise<Session> { return this.#client.request({type: 'set_session_mode', sessionId, mode}) as Promise<Session>; }
  public async beginAgentRun(input: {runId: string; sessionId: string; displayText: string; mode: AgentMode}): Promise<{run: AgentRunRecord; userMessage: StoredMessage}> { return this.#client.request({type: 'begin_agent_run', ...input}) as Promise<{run: AgentRunRecord; userMessage: StoredMessage}>; }
  public async beginAgentIteration(input: {messageId: string; runId: string; sessionId: string; iteration: number}): Promise<StoredMessage> { return this.#client.request({type: 'begin_agent_iteration', ...input}) as Promise<StoredMessage>; }
  public async finalizeIterationWithToolBatch(messageId: string, update: FinalMessageUpdate, records: ToolCallRecord[]): Promise<void> { await this.#client.request({type: 'finalize_iteration_with_tool_batch', messageId, update, records}); }
  public async abortAgentRun(runId: string, result: AgentRunResult, message: string): Promise<void> { await this.#client.request({type: 'abort_agent_run', runId, result, message}); }
  public async finishAgentRun(runId: string, result: AgentRunResult, latestPlanMessageId?: string): Promise<void> {
    await this.#client.request(latestPlanMessageId === undefined ? {type: 'finish_agent_run', runId, result} : {type: 'finish_agent_run', runId, result, latestPlanMessageId});
  }
  public async close(): Promise<void> { await this.#client.close(); }
}

export function asStorageError(error: unknown): StorageError {
  // 保留已经标准化的 StorageError，其余异常统一包装并通过 cause 保留原错误。
  return error instanceof StorageError ? error : new StorageError('本地会话存储操作失败', {cause: error});
}

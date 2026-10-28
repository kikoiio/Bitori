import type {ProviderError, ProviderErrorCode} from '../providers/errors.js';
import type {MessageRole, ProviderState, Usage} from '../providers/types.js';
import type {ApprovalStatus, JsonObject, ToolExecutionResult, ToolExecutionStatus} from '../tools/types.js';
import type {AgentMode, AgentRunResult, AgentRunStatus, AgentStopReason} from '../agent/types.js';

/** 一段会话的元数据；消息正文保存在 messages 表中。 */
export interface Session {
  id: string;
  profileName: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentMode: AgentMode;
  latestPlanMessageId: string | null;
}

export interface AgentRunRecord {
  id: string; sessionId: string; userMessageId: string; mode: AgentMode; status: AgentRunStatus;
  stopReason: AgentStopReason | null; iterationCount: number; inputTokens: number; outputTokens: number;
  startedAt: number; finishedAt: number | null; updatedAt: number;
}

/** streaming 是临时状态，其余三个是不可再改变的终态。 */
export type MessageStatus = 'streaming' | 'completed' | 'cancelled' | 'failed';

/** SQLite 中一行消息在 TypeScript 世界里的完整形状。 */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  thinking: string;
  status: MessageStatus;
  errorCode: ProviderErrorCode | null;
  errorMessage: string | null;
  usage: Usage | null;
  providerState: ProviderState | null;
  agentRunId?: string | null;
  iteration?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FinalMessageUpdate {
  content: string;
  thinking: string;
  // Exclude 从联合类型中去掉 streaming，编译期保证“finalize”只能写入终态。
  status: Exclude<MessageStatus, 'streaming'>;
  error: ProviderError | null;
  usage: Usage | null;
  providerState: ProviderState | null;
}

export interface BeginTurnResult {
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
}

export interface ToolCallRecord {
  id: string; sessionId: string; assistantMessageId: string; providerCallId: string | null; position: number;
  toolName: string; arguments: JsonObject; argumentsText?: string; agentRunId?: string | null; approvalStatus: ApprovalStatus; executionStatus: ToolExecutionStatus;
  result: ToolExecutionResult | null; createdAt: number; updatedAt: number;
}
export interface StoredConversation {session: Session; messages: StoredMessage[]; toolCalls: ToolCallRecord[]; agentRuns: AgentRunRecord[]}

/**
 * 控制器所依赖的仓储接口。测试可以传入内存假实现，生产环境则使用 Worker + SQLite。
 */
export interface SessionRepositoryContract {
  initialize(): Promise<void>;
  findLatestSession(profileName: string): Promise<Session | null>;
  listSessions(profileName: string): Promise<Session[]>;
  createSession(profileName: string): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  getConversation(sessionId: string): Promise<StoredConversation | null>;
  saveToolBatch(records: ToolCallRecord[]): Promise<void>;
  finalizeAssistantWithToolBatch(messageId: string, update: FinalMessageUpdate, records: ToolCallRecord[]): Promise<void>;
  updateToolCall(record: ToolCallRecord): Promise<void>;
  beginTurn(sessionId: string, text: string): Promise<BeginTurnResult>;
  beginAssistantContinuation(sessionId: string): Promise<StoredMessage>;
  checkpointAssistant(messageId: string, content: string, thinking: string): Promise<void>;
  finalizeMessage(messageId: string, update: FinalMessageUpdate): Promise<void>;
  setSessionMode(sessionId: string, mode: AgentMode): Promise<Session>;
  beginAgentRun(input: {runId: string; sessionId: string; displayText: string; mode: AgentMode}): Promise<{run: AgentRunRecord; userMessage: StoredMessage}>;
  beginAgentIteration(input: {messageId: string; runId: string; sessionId: string; iteration: number}): Promise<StoredMessage>;
  finalizeIterationWithToolBatch(messageId: string, update: FinalMessageUpdate, records: ToolCallRecord[]): Promise<void>;
  finishAgentRun(runId: string, result: AgentRunResult, latestPlanMessageId?: string): Promise<void>;
  close(): Promise<void>;
}

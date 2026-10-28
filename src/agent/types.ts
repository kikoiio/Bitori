import type {ProviderError} from '../providers/errors.js';
import type {FinishReason, ModelContextItem, ProviderState, Usage} from '../providers/types.js';
import type {PromptBlock} from '../prompt/builder.js';
import type {PreparedToolCall, ToolApprovalPrompt, ToolDefinition, ToolExecutionResult, ToolExecutionStatus} from '../tools/types.js';

export type AgentMode = 'plan' | 'execute';
export type AgentRunStatus = 'running' | 'completed' | 'stopped' | 'cancelled' | 'failed' | 'interrupted';
export type AgentStopReason = 'natural_completion' | 'iteration_limit' | 'unknown_tool_limit' | 'user_cancelled' | 'stream_error' | 'storage_error' | 'process_interrupted' | 'context_compact_failed';
export type AgentPhase = 'preparing' | 'streaming' | 'scheduling_tools' | 'awaiting_approval' | 'executing_tools' | 'finishing';

export interface AgentRunInput {
  runId: string;
  sessionId: string;
  trigger: 'message' | 'do';
  mode: AgentMode;
  instruction: string;
  /** 本次显示消息的标识；模型请求使用 instruction，持久化仍保留用户输入。 */
  userMessageId?: string;
  context: ModelContextItem[];
  /** 控制器在会话激活时冻结的系统提示；缺省时不发送系统提示。 */
  system?: PromptBlock[];
  /** 本回合注入的提醒文本（已含标签），由控制器按模式与轮次生成。 */
  reminders?: string[];
  limits?: {maxIterations: number; maxUnknownToolIterations: number; /** 重试基础退避毫秒数；测试可注入较小值。 */ retryBaseDelayMs?: number};
  /** 上下文窗口与工作目录；缺省时工具结果预算仍生效，全量摘要禁用。 */
  contextManagement?: {windowTokens: number; workspaceRoot: string};
}

export interface AgentRunResult {
  runId: string;
  status: Exclude<AgentRunStatus, 'running'>;
  stopReason: AgentStopReason;
  iterationCount: number;
  usage: Usage;
  finalIterationId: string | null;
}

export interface CollectedIteration {
  iterationId: string;
  iteration: number;
  text: string;
  thinking: string;
  usage: Usage;
  finishReason: FinishReason | null;
  providerState: ProviderState | null;
  calls: PreparedToolCall[];
  error: ProviderError | null;
  cancelled: boolean;
}

interface AgentEventBase {runId: string; sessionId: string; at: number}
export type AgentEvent =
  | (AgentEventBase & {type: 'run_started'; mode: AgentMode; maxIterations: number})
  | (AgentEventBase & {type: 'iteration_started'; iterationId: string; iteration: number})
  | (AgentEventBase & {type: 'text_delta' | 'thinking_delta'; iterationId: string; delta: string})
  | (AgentEventBase & {type: 'usage_updated'; iterationId: string; iterationUsage: Usage; totalUsage: Usage})
  | (AgentEventBase & {type: 'tool_call_started'; iterationId: string; callId: string; providerCallId: string | null; position: number; name: string})
  | (AgentEventBase & {type: 'tool_arguments_delta'; iterationId: string; callId: string; delta: string})
  | (AgentEventBase & {type: 'tool_call_ready'; iterationId: string; call: PreparedToolCall})
  | (AgentEventBase & {type: 'approval_requested' | 'approval_resolved'; iterationId: string; callId: string; prompt: ToolApprovalPrompt; decision?: 'approved' | 'approved_once' | 'approved_session' | 'approved_permanent' | 'denied'})
  | (AgentEventBase & {type: 'tool_status'; iterationId: string; callId: string; status: ToolExecutionStatus})
  | (AgentEventBase & {type: 'tool_result'; iterationId: string; callId: string; result: ToolExecutionResult})
  | (AgentEventBase & {type: 'progress'; iteration: number; maxIterations: number; phase: AgentPhase; completedTools: number; totalTools: number})
  | (AgentEventBase & {type: 'iteration_finished'; iterationId: string; iteration: number; response: CollectedIteration})
  // 请求级可观察性：完整请求载荷、重试序列与压缩事实只在此处可见。
  | (AgentEventBase & {type: 'request_prepared'; iterationId: string; iteration: number; items: ModelContextItem[]; system: PromptBlock[]; toolDefinitions: ToolDefinition[]; toolDefinitionDigest: string})
  | (AgentEventBase & {type: 'request_retry'; iterationId: string; iteration: number; attempt: number; delayMs: number; error: ProviderError})
  | (AgentEventBase & {type: 'context_compacted'; beforeTokens: number; afterTokens: number; keepIndex: number; reason: 'auto' | 'manual'; boundaryMessageId: string; items: ModelContextItem[]})
  | (AgentEventBase & {type: 'run_finished'; result: AgentRunResult});

import type {AgentEvent, AgentMode} from '../agent/types.js';
import type {ModelContextItem, ProviderState, Usage} from '../providers/types.js';
import type {PromptBlock} from '../prompt/builder.js';
import type {FinishReason} from '../providers/types.js';
import type {ToolDefinition} from '../tools/types.js';

/** [s15] trace 事件格式版本；结构变化时递增并配套迁移读取逻辑。 */
export const TRACE_VERSION = 1;

interface TraceEventBase {
  v: typeof TRACE_VERSION;
  at: number;
  sessionId: string;
}

/** [s15] 工具定义按内容变化才整体记录，其余轮次仅携带摘要。 */
export interface TraceToolCallSummary {callId: string; providerCallId: string | null; name: string; argumentsText: string}

export type TraceEvent =
  | (TraceEventBase & {type: 'run_header'; runId: string; profileName: string; model: string; protocol: string; mode: AgentMode; trigger: 'message' | 'do'; workspaceRoot: string})
  | (TraceEventBase & {type: 'request_prepared'; runId: string; iterationId: string; iteration: number; items: ModelContextItem[]; system: PromptBlock[]; toolDefinitions: ToolDefinition[]; toolDefinitionDigest: string})
  | (TraceEventBase & {type: 'response'; runId: string; iterationId: string; iteration: number; text: string; thinking: string; toolCalls: TraceToolCallSummary[]; usage: Usage; finishReason: FinishReason | null; providerState: ProviderState | null; errorCode: string | null; errorMessage: string | null; durationMs: number})
  | (TraceEventBase & {type: 'request_retry'; runId: string; iterationId: string; iteration: number; attempt: number; delayMs: number; errorCode: string; errorMessage: string})
  | (TraceEventBase & {type: 'context_compacted'; runId: string; beforeTokens: number; afterTokens: number; keepIndex: number; reason: 'auto' | 'manual'})
  | (TraceEventBase & {type: 'context_composition'; runId: string; iterationId: string; iteration: number; buckets: ContextCompositionBuckets; estimatedTotal: number; providerInputTokens: number; delta: number})
  | (TraceEventBase & {type: 'agent_event'; event: AgentEvent})
  | (TraceEventBase & {type: 'domain_fact'; fact: string; data?: Record<string, unknown>});

/** [s15] 上下文组成桶；数值均为估算 token 数。 */
export interface ContextCompositionBuckets {
  fixed_system: number;
  environment: number;
  custom_instructions: number;
  skills: number;
  long_term_memory: number;
  tool_definitions: number;
  user_messages: number;
  assistant_messages: number;
  tool_results: number;
  reminders: number;
  compact_summary: number;
}

export const emptyCompositionBuckets = (): ContextCompositionBuckets => ({
  fixed_system: 0, environment: 0, custom_instructions: 0, skills: 0, long_term_memory: 0,
  tool_definitions: 0, user_messages: 0, assistant_messages: 0, tool_results: 0, reminders: 0, compact_summary: 0,
});

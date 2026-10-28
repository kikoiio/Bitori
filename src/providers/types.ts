import type {ProviderError} from './errors.js';
import type {ToolDefinition} from '../tools/types.js';
import type {JsonObject, ToolExecutionResult} from '../tools/types.js';
import type {PromptBlock} from '../prompt/builder.js';
import {z} from 'zod';

/**
 * Provider 层的核心抽象。
 * 上层只依赖这些类型，不直接依赖 Anthropic/OpenAI SDK，因此可以用同一套聊天逻辑驱动三种协议。
 */
export type MessageRole = 'user' | 'assistant';

const anthropicBlockTypes = ['text', 'thinking', 'redacted_thinking', 'tool_use'];
/** 保留额外协议字段和后续 SDK 支持的块，已知块则校验其必需字段。 */
export const anthropicReplayPayloadSchema = z.array(z.union([
  z.looseObject({type: z.literal('text'), text: z.string()}),
  z.looseObject({type: z.literal('thinking'), thinking: z.string(), signature: z.string().min(1)}),
  z.looseObject({type: z.literal('redacted_thinking'), data: z.string().min(1)}),
  z.looseObject({type: z.literal('tool_use'), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.unknown())}),
  z.looseObject({type: z.string().min(1).refine(type => !anthropicBlockTypes.includes(type))}),
])).min(1);

/** 展示文本与供应商的不透明、有序重放载荷分开保存。 */
export type ProviderState =
  | {protocol: 'openai-responses'; payload: unknown}
  | {protocol: 'anthropic'; payload: z.infer<typeof anthropicReplayPayloadSchema>};

export interface ChatMessage {
  role: MessageRole;
  content: string;
  providerState?: ProviderState;
  messageId?: string;
}

/** Agent 使用严格有序的上下文表达任意多轮工具链。 */
export interface ModelMessageItem {
  type: 'message';
  messageId: string;
  role: MessageRole;
  content: string;
  providerState?: ProviderState;
}

export interface ModelToolCall {
  callId: string;
  providerCallId: string | null;
  name: string;
  argumentsText: string;
  arguments: JsonObject | null;
}

export interface ModelAssistantIterationItem {
  type: 'assistant_iteration';
  messageId: string;
  content: string;
  thinking?: string;
  providerState?: ProviderState;
  toolCalls: ModelToolCall[];
}

export interface ModelToolResultsItem {
  type: 'tool_results';
  assistantMessageId: string;
  results: Array<{callId: string; providerCallId: string | null; name: string; result: ToolExecutionResult}>;
}

/** 请求级补充指令；provider 渲染为用户角色消息，文本已含标签，不持久化。 */
export interface ModelReminderItem {
  type: 'reminder';
  text: string;
}

export type ModelContextItem = ModelMessageItem | ModelAssistantIterationItem | ModelToolResultsItem | ModelReminderItem;

export interface ChatRequest {
  /** Agent 主流程的严格有序上下文；工具循环必须使用 items。提供时（包括空数组）优先于 messages。 */
  items?: ModelContextItem[];
  /** 结构化系统提示；缺省时不发送系统提示。 */
  system?: PromptBlock[];
  /** 未提供 items 时使用的兼容消息形态。 */
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** 缓存命中与缓存创建字段仅 Anthropic 协议上报；不持久化，只走事件与界面即时展示。 */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** 供应商各自的结束原因会在边界层被映射成这组统一值。 */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'cancelled' | 'tool_calls' | 'unknown';

export type StreamEvent =
  | {type: 'text_delta'; text: string}
  | {type: 'thinking_delta'; text: string}
  | {type: 'usage'; usage: Usage}
  | {type: 'tool_call_start'; internalId: string; providerCallId: string | null; position: number; name: string}
  | {type: 'tool_call_arguments_delta'; internalId: string; delta: string}
  | {type: 'tool_call_end'; internalId: string}
  | {type: 'completed'; finishReason: FinishReason; providerState?: ProviderState}
  | {type: 'error'; error: ProviderError};

export interface LLMClient {
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/** 从数据库 JSON 恢复后校验 ProviderState 的结构。 */
export function isProviderState(value: unknown): value is ProviderState {
  return typeof value === 'object' && value !== null
    && 'protocol' in value && 'payload' in value
    && (value.protocol === 'openai-responses'
      || (value.protocol === 'anthropic' && isAnthropicReplayPayload(value.payload)));
}

export function isAnthropicReplayPayload(value: unknown): value is z.infer<typeof anthropicReplayPayloadSchema> {
  return anthropicReplayPayloadSchema.safeParse(value).success;
}

/** Responses 的 replay payload 至少必须是“对象数组”，否则退回普通文本上下文。 */
export function isReplayPayload(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null);
}

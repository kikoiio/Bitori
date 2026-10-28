import type {ProviderError} from './errors.js';
import type {ToolDefinition} from '../tools/types.js';
import type {JsonObject, ToolExecutionResult} from '../tools/types.js';
import type {PromptBlock} from '../prompt/builder.js';

/**
 * Provider 层的核心抽象。
 * 上层只依赖这些类型，不直接依赖 Anthropic/OpenAI SDK，因此可以用同一套聊天逻辑驱动三种协议。
 */
export type MessageRole = 'user' | 'assistant';

/** 某些协议需要保存的不透明重放数据；当前只有 Responses API 使用。 */
export interface ProviderState {
  protocol: 'openai-responses';
  payload: unknown;
}

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
  /** Agent 主流程的严格有序上下文；工具循环必须使用 items。 */
  items?: ModelContextItem[];
  /** 结构化系统提示；缺省时不发送系统提示。 */
  system?: PromptBlock[];
  /** 纯文本摘要等无工具请求仍可使用消息形态。 */
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

// 判别联合：先检查 event.type，TS 就能自动知道其余字段是什么。
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
  // AsyncIterable 允许调用方用 for await...of 一边接收、一边刷新 UI。
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/** 运行时类型守卫：从数据库 JSON 恢复后，确认对象确实像 ProviderState。 */
export function isProviderState(value: unknown): value is ProviderState {
  return typeof value === 'object' && value !== null
    && 'protocol' in value && value.protocol === 'openai-responses'
    && 'payload' in value;
}

/** Responses 的 replay payload 至少必须是“对象数组”，否则退回普通文本上下文。 */
export function isReplayPayload(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null);
}

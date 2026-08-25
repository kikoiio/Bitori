import OpenAI from 'openai';
import type {ProviderProfile} from '../config/types.js';
import {isAbortError, normalizeProviderError} from './errors.js';
import type {ChatRequest, FinishReason, LLMClient, StreamEvent} from './types.js';

interface ChatChunk {
  choices?: Array<{delta?: {content?: string | null; tool_calls?: Array<{index: number; id?: string; function?: {name?: string; arguments?: string}}>}; finish_reason?: string | null}>;
  usage?: {prompt_tokens?: number; completion_tokens?: number} | null;
}

/** [s01] 将 Chat Completions 的 finish_reason 映射到项目内部枚举。 */
function finishReason(value: string | null | undefined): FinishReason {
  if (value === 'stop') return 'stop';
  if (value === 'length') return 'length';
  if (value === 'content_filter') return 'content_filter';
  if (value === 'tool_calls') return 'tool_calls';
  return 'unknown';
}

export class OpenAIChatClient implements LLMClient {
  readonly #profile: ProviderProfile;
  readonly #client: OpenAI;

  public constructor(profile: ProviderProfile, client?: OpenAI) {
    this.#profile = profile;
    this.#client = client ?? new OpenAI({apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 0});
  }

  public async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    try {
      // [s01] Chat Completions 只需要普通 role/content 历史，不使用 Responses 专属的 providerState。
      /* [s01 旧实现，s02 替换] SDK 参数中的 messages 只映射普通 role/content 历史。 */
      const messages: unknown[] = [];
      if (request.items) for (const item of request.items) {
        if (item.type === 'message') messages.push({role: item.role, content: item.content});
        else if (item.type === 'assistant_iteration') {
          messages.push({role: 'assistant', content: item.content || null, ...(item.toolCalls.length === 0 ? {} : {tool_calls: item.toolCalls.map(call => ({id: call.providerCallId ?? call.callId, type: 'function', function: {name: call.name, arguments: call.argumentsText}}))})});
        // [s04] 请求级提醒渲染为用户角色消息；文本已含标签，由 prompt 模块生成。
        } else if (item.type === 'reminder') messages.push({role: 'user', content: item.text});
        else for (const entry of item.results) messages.push({role: 'tool', tool_call_id: entry.providerCallId ?? entry.callId, content: JSON.stringify(entry.result)});
      }
      const history = new Map<string, NonNullable<ChatRequest['toolHistory']>>();
      for (const call of request.toolHistory ?? []) history.set(call.assistantMessageId, [...(history.get(call.assistantMessageId) ?? []), call]);
      for (const message of request.items ? [] : request.messages) {
        const calls = message.messageId ? history.get(message.messageId) ?? [] : [];
        if (message.role === 'assistant' && calls.length > 0) {
          messages.push({role: 'assistant', content: message.content || null, tool_calls: calls.map(call => ({id: call.callId, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))});
          for (const call of calls) messages.push({role: 'tool', tool_call_id: call.callId, content: JSON.stringify(call.result)});
        } else messages.push({role: message.role, content: message.content});
      }
      if (!request.items && !request.toolHistory?.length && request.toolCalls?.length) messages.push({role: 'assistant', content: null, tool_calls: request.toolCalls.map(call => ({id: call.callId, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))});
      if (!request.items && !request.toolHistory?.length) for (const result of request.toolResults ?? []) messages.push({role: 'tool', tool_call_id: result.callId, content: JSON.stringify(result.result)});
      // [s04] 系统提示全文放在首条 system 消息；该协议无显式缓存标记，依赖服务端自动前缀缓存。
      if (request.system?.length) messages.unshift({role: 'system', content: request.system.map(block => block.text).join('\n\n')});
      const stream = await this.#client.chat.completions.create({
        model: this.#profile.model,
        messages: messages as never,
        ...(request.phase === 'final' || !request.tools?.length ? {} : {tools: request.tools.map(tool => ({type: 'function' as const, function: {name: tool.name, description: tool.description, parameters: tool.inputSchema}}))}),
        stream: true,
        // [s01] 默认流常常不带 usage，显式请求让最后的 chunk 返回 token 统计。
        stream_options: {include_usage: true},
      }, {signal});
      let reason: FinishReason = 'unknown';
      const started = new Set<number>();
      for await (const rawChunk of stream) {
        const chunk = rawChunk as unknown as ChatChunk;
        for (const choice of chunk.choices ?? []) {
          if (choice.delta?.content) yield {type: 'text_delta', text: choice.delta.content};
          for (const call of choice.delta?.tool_calls ?? []) {
            const internalId = `chat-${call.index}`;
            if (!started.has(call.index)) { started.add(call.index); yield {type: 'tool_call_start', internalId, providerCallId: call.id ?? null, position: call.index, name: call.function?.name ?? ''}; }
            if (call.function?.arguments) yield {type: 'tool_call_arguments_delta', internalId, delta: call.function.arguments};
          }
          if (choice.finish_reason) reason = finishReason(choice.finish_reason);
        }
        if (chunk.usage?.prompt_tokens !== undefined && chunk.usage.completion_tokens !== undefined) {
          yield {type: 'usage', usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          }};
        }
      }
      for (const index of started) yield {type: 'tool_call_end', internalId: `chat-${index}`};
      // [s01] SDK 流结束不等于业务层已收到结束事件，因此在这里统一补一条。
      yield {type: 'completed', finishReason: reason};
    } catch (error) {
      if (!isAbortError(error, signal)) yield {type: 'error', error: normalizeProviderError(error, this.#profile)};
    }
  }
}

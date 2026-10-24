import OpenAI from 'openai';
import type {ProviderProfile} from '../config/types.js';
import {isAbortError, normalizeProviderError} from './errors.js';
import {isReplayPayload} from './types.js';
import type {ChatRequest, LLMClient, ProviderState, StreamEvent} from './types.js';

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {type?: string; id?: string; call_id?: string; name?: string};
  output_index?: number;
  response?: {
    output?: unknown[];
    usage?: {input_tokens?: number; output_tokens?: number};
    status?: string;
  };
  error?: unknown;
}

export class OpenAIResponsesClient implements LLMClient {
  readonly #profile: ProviderProfile;
  readonly #client: OpenAI;

  public constructor(profile: ProviderProfile, client?: OpenAI) {
    this.#profile = profile;
    this.#client = client ?? new OpenAI({apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 0});
  }

  public async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    try {
      // [s01] Responses API 的 assistant 输出不只是文本，还可能包含推理等 output items。
      // [s01] 若数据库里保存了原始 items，就原样回放；否则用普通 role/content 消息。
      const input: unknown[] = [];
      if (request.items) for (const item of request.items) {
        if (item.type === 'message') input.push({role: item.role, content: item.content});
        else if (item.type === 'assistant_iteration') {
          if (item.providerState?.protocol === 'openai-responses' && isReplayPayload(item.providerState.payload)) input.push(...item.providerState.payload);
          else {
            if (item.content) input.push({role: 'assistant', content: item.content});
            for (const call of item.toolCalls) input.push({type: 'function_call', call_id: call.providerCallId ?? call.callId, name: call.name, arguments: call.argumentsText});
          }
        // [s04] 请求级提醒渲染为用户角色 input 消息；文本已含标签，由 prompt 模块生成。
        } else if (item.type === 'reminder') input.push({role: 'user', content: item.text});
        else for (const entry of item.results) input.push({type: 'function_call_output', call_id: entry.providerCallId ?? entry.callId, output: JSON.stringify(entry.result)});
      }
      const history = new Map<string, NonNullable<ChatRequest['toolHistory']>>();
      for (const call of request.toolHistory ?? []) history.set(call.assistantMessageId, [...(history.get(call.assistantMessageId) ?? []), call]);
      for (const message of request.items ? [] : request.messages) {
        const calls = message.messageId ? history.get(message.messageId) ?? [] : [];
        if (message.role === 'assistant' && message.providerState?.protocol === 'openai-responses'
          && isReplayPayload(message.providerState.payload)) {
          // [s02] function_call 由统一工具记录表达；恢复 state 只重放 reasoning/message 等非工具项，避免同一调用重复。
          input.push(...message.providerState.payload.filter(item => calls.length === 0 || typeof item !== 'object' || item === null || !('type' in item) || (item.type !== 'function_call' && item.type !== 'function_call_output')));
        } else {
          input.push({role: message.role, content: message.content});
        }
        for (const call of calls) {
          input.push({type: 'function_call', call_id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments)});
          input.push({type: 'function_call_output', call_id: call.callId, output: JSON.stringify(call.result)});
        }
      }
      if (!request.items && !request.toolHistory?.length) for (const call of request.toolCalls ?? []) input.push({type: 'function_call', call_id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments)});
      if (!request.items && !request.toolHistory?.length) for (const result of request.toolResults ?? []) input.push({type: 'function_call_output', call_id: result.callId, output: JSON.stringify(result.result)});
      const stream = await this.#client.responses.create({
        model: this.#profile.model,
        input: input as never,
        stream: true,
        store: false, // [s01] 明确要求 OpenAI 不在服务端持久保存该响应。
        // [s04] 系统提示全文放入 instructions 字段；该协议无显式缓存标记，依赖服务端自动前缀缓存。
        ...(request.system?.length ? {instructions: request.system.map(block => block.text).join('\n\n')} : {}),
        /* [s02 旧实现，s06 替换] 所有工具固定 strict: true。 */
        ...(request.phase === 'final' || !request.tools?.length ? {} : {tools: request.tools.map(tool => ({type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: tool.strict ?? true}))}),
      }, {signal});

      let emittedToolCall = false;
      for await (const rawEvent of stream) {
        const event = rawEvent as unknown as ResponsesEvent;
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          emittedToolCall = true;
          const position = event.output_index ?? 0; yield {type: 'tool_call_start', internalId: `responses-${position}`, providerCallId: event.item.call_id ?? event.item.id ?? null, position, name: event.item.name ?? ''};
        } else if (event.type === 'response.function_call_arguments.delta' && event.delta) {
          yield {type: 'tool_call_arguments_delta', internalId: `responses-${event.output_index ?? 0}`, delta: event.delta};
        } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          yield {type: 'tool_call_end', internalId: `responses-${event.output_index ?? 0}`};
        } else if (event.type === 'response.output_text.delta' && event.delta) {
          yield {type: 'text_delta', text: event.delta};
        } else if (event.type === 'response.completed' && event.response) {
          const usage = event.response.usage;
          if (usage?.input_tokens !== undefined && usage.output_tokens !== undefined) {
            yield {type: 'usage', usage: {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens}};
          }
          // [s01] 完整 output items 随 assistant 消息存入 SQLite，供下一轮准确重放。
          const state: ProviderState = {protocol: 'openai-responses', payload: event.response.output ?? []};
          yield {type: 'completed', finishReason: emittedToolCall ? 'tool_calls' : event.response.status === 'completed' ? 'stop' : 'unknown', providerState: state};
        } else if (event.type === 'error' || event.type === 'response.failed') {
          yield {type: 'error', error: normalizeProviderError(event.error ?? event, this.#profile)};
          return;
        }
      }
    } catch (error) {
      // [s01] 用户取消是正常控制流，不向 UI 显示为供应商错误。
      if (!isAbortError(error, signal)) yield {type: 'error', error: normalizeProviderError(error, this.#profile)};
    }
  }
}

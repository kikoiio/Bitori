import Anthropic from '@anthropic-ai/sdk';
import type {ProviderProfile, ThinkingConfig} from '../config/types.js';
import {isAbortError, isAdaptiveThinkingUnsupported, normalizeProviderError} from './errors.js';
import type {ChatRequest, FinishReason, LLMClient, StreamEvent} from './types.js';

interface AnthropicEvent {
  type?: string;
  index?: number;
  content_block?: {type?: string; id?: string; name?: string};
  delta?: {type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string};
  // usage 增加缓存创建/命中字段，仅 Anthropic 协议上报。
  message?: {usage?: {input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number}};
  usage?: {input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number};
}

/** 将 Anthropic 的 stop_reason 翻译成项目统一的 FinishReason。 */
function stopReason(value: string | undefined): FinishReason {
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop';
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_calls';
  return 'unknown';
}

export class AnthropicClient implements LLMClient {
  readonly #profile: ProviderProfile;
  readonly #client: Anthropic;

  public constructor(profile: ProviderProfile, client?: Anthropic) {
    this.#profile = profile;
    // 可注入 client 便于测试；生产环境才创建真实 SDK。重试由本层显式控制，所以关闭 SDK 自动重试。
    this.#client = client ?? new Anthropic({apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 0});
  }

  public async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const config = this.#profile.thinking;
    if (config.type !== 'auto') {
      yield* this.#attempt(request, signal, config);
      return;
    }

    // thinking: true 的语义是“先 adaptive；若服务端明确不支持且尚未输出，再回退 manual”。
    let emittedDelta = false;
    try {
      for await (const event of this.#rawAttempt(request, signal, {type: 'adaptive'})) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta') emittedDelta = true;
        yield event;
      }
    } catch (error) {
      if (isAbortError(error, signal)) return;
      if (!emittedDelta && isAdaptiveThinkingUnsupported(error)) {
        yield* this.#attempt(request, signal, {type: 'manual', budgetTokens: 4096, maxTokens: 8192});
        return;
      }
      yield {type: 'error', error: normalizeProviderError(error, this.#profile)};
    }
  }

  async *#attempt(request: ChatRequest, signal: AbortSignal, config: ThinkingConfig): AsyncIterable<StreamEvent> {
    try {
      yield* this.#rawAttempt(request, signal, config);
    } catch (error) {
      if (!isAbortError(error, signal)) yield {type: 'error', error: normalizeProviderError(error, this.#profile)};
    }
  }

  async *#rawAttempt(request: ChatRequest, signal: AbortSignal, config: ThinkingConfig): AsyncIterable<StreamEvent> {
    // disabled 也需要给 Anthropic 一个普通回复 token 上限；manual 则采用用户配置的上限。
    const maxTokens = config.type === 'manual' ? config.maxTokens : 8192;
    const thinking = config.type === 'adaptive'
      ? {type: 'adaptive'}
      : config.type === 'manual'
        ? {type: 'enabled', budget_tokens: config.budgetTokens}
        : undefined;
    // 对象展开只在 thinking 存在时加入字段，避免把 thinking: undefined 发给 SDK。
    const messages: unknown[] = [];
    for (const item of request.items ?? []) {
      if (item.type === 'message') messages.push({role: item.role, content: item.content});
      else if (item.type === 'assistant_iteration') messages.push({role: 'assistant', content: [
        ...(item.content ? [{type: 'text', text: item.content}] : []),
        ...item.toolCalls.map(call => ({type: 'tool_use', id: call.providerCallId ?? call.callId, name: call.name, input: call.arguments ?? {}})),
      ]});
      // 请求级提醒渲染为用户角色消息；文本已含标签，由 prompt 模块生成。
      else if (item.type === 'reminder') messages.push({role: 'user', content: item.text});
      else messages.push({role: 'user', content: item.results.map(entry => ({type: 'tool_result', tool_use_id: entry.providerCallId ?? entry.callId, content: JSON.stringify(entry.result), is_error: entry.result.status !== 'success'}))});
    }
    if (messages.length === 0 && request.system === undefined) {
      for (const message of request.messages) messages.push({role: message.role, content: message.content});
    }
    const parameters = {
      model: this.#profile.model,
      max_tokens: maxTokens,
      messages,
      // 缓存断点利用「缓存到此为止的全部前缀」语义：末位工具一个断点覆盖全部工具定义，稳定块一个断点覆盖系统提示固定模块。
      ...(!request.tools?.length ? {} : {tools: request.tools.map((tool, index, all) => ({name: tool.name, description: tool.description, input_schema: tool.inputSchema, ...(index === all.length - 1 ? {cache_control: {type: 'ephemeral'}} : {})}))}),
      // 结构化系统提示映射为 system 块数组；仅可缓存块携带 cache_control。
      ...(request.system?.length ? {system: request.system.map(block => ({type: 'text', text: block.text, ...(block.cacheable ? {cache_control: {type: 'ephemeral'}} : {})}))} : {}),
      ...(thinking === undefined ? {} : {thinking}),
    };
    // SDK 的 thinking 联合类型随版本变化较快；边界处用 never 绕过声明差异，事件随后仍由本文件校验。
    const stream = this.#client.messages.stream(parameters as never, {signal});
    let reason: FinishReason = 'unknown';
    const toolIds = new Map<number, string>();
    for await (const rawEvent of stream) {
      const event = rawEvent as unknown as AnthropicEvent;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.index !== undefined) {
        const internalId = `anthropic-${event.index}`; toolIds.set(event.index, internalId);
        yield {type: 'tool_call_start', internalId, providerCallId: event.content_block.id ?? null, position: event.index, name: event.content_block.name ?? ''};
      } else if (event.type === 'content_block_stop' && event.index !== undefined && toolIds.has(event.index)) {
        yield {type: 'tool_call_end', internalId: toolIds.get(event.index)!};
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) yield {type: 'text_delta', text: event.delta.text};
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) yield {type: 'thinking_delta', text: event.delta.thinking};
        if (event.delta?.type === 'input_json_delta' && event.index !== undefined && toolIds.has(event.index)) yield {type: 'tool_call_arguments_delta', internalId: toolIds.get(event.index)!, delta: event.delta.partial_json ?? ''};
      } else if (event.type === 'message_start' && event.message?.usage?.input_tokens !== undefined) {
        // Anthropic 在流的开始给 input tokens，在后续 message_delta 给 output tokens。
        // 缓存创建/命中字段只在 message_start 上报，存在时才加入事件。
        const startUsage = event.message.usage;
        yield {type: 'usage', usage: {
          inputTokens: startUsage.input_tokens!,
          outputTokens: startUsage.output_tokens ?? 0,
          ...(startUsage.cache_creation_input_tokens !== undefined ? {cacheCreationInputTokens: startUsage.cache_creation_input_tokens} : {}),
          ...(startUsage.cache_read_input_tokens !== undefined ? {cacheReadInputTokens: startUsage.cache_read_input_tokens} : {}),
        }};
      } else if (event.type === 'message_delta') {
        reason = stopReason(event.delta?.stop_reason);
        if (event.usage?.output_tokens !== undefined) {
          yield {type: 'usage', usage: {inputTokens: 0, outputTokens: event.usage.output_tokens}};
        }
      }
    }
    // 正常遍历完 SDK 流后，补发统一 completed 事件。
    yield {type: 'completed', finishReason: reason};
  }
}

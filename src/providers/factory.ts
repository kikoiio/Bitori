import type {ProviderProfile} from '../config/types.js';
import {AnthropicClient} from './anthropic.js';
import {OpenAIChatClient} from './openai-chat.js';
import {OpenAIResponsesClient} from './openai-responses.js';
import type {LLMClient} from './types.js';

/** 根据配置的 protocol 创建对应实现，返回值统一为 LLMClient 接口。 */
export function createLLMClient(profile: ProviderProfile): LLMClient {
  switch (profile.protocol) {
    case 'anthropic': return new AnthropicClient(profile);
    case 'openai-responses': return new OpenAIResponsesClient(profile);
    case 'openai-chat': return new OpenAIChatClient(profile);
    default: return assertNever(profile.protocol);
  }
}

function assertNever(value: never): never {
  throw new Error(`不支持的协议：${String(value)}`);
}

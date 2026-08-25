import {describe, expect, it} from 'vitest';
import {createLLMClient} from '../../../src/providers/factory.js';
import {AnthropicClient} from '../../../src/providers/anthropic.js';
import {OpenAIChatClient} from '../../../src/providers/openai-chat.js';
import {OpenAIResponsesClient} from '../../../src/providers/openai-responses.js';
import type {Protocol, ProviderProfile} from '../../../src/config/types.js';

function profile(protocol: Protocol): ProviderProfile {
  return {name: protocol, protocol, model: 'model', baseUrl: 'https://example.com', apiKey: 'test', thinking: {type: 'disabled'}};
}

describe('createLLMClient', () => {
  it('按协议创建独立客户端', () => {
    expect(createLLMClient(profile('anthropic'))).toBeInstanceOf(AnthropicClient);
    expect(createLLMClient(profile('openai-responses'))).toBeInstanceOf(OpenAIResponsesClient);
    expect(createLLMClient(profile('openai-chat'))).toBeInstanceOf(OpenAIChatClient);
  });
});

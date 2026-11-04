import {describe, expect, it} from 'vitest';
import type {ChatRequest, LLMClient, StreamEvent} from '../../../src/providers/types.js';
import {ProviderRequestLimiter} from '../../../src/providers/request-limiter.js';

const request: ChatRequest = {messages: [{role: 'user', content: 'hello'}]};

describe('ProviderRequestLimiter', () => {
  it('拒绝超过硬上限的请求，且不调用底层 Provider', async () => {
    let calls = 0;
    const provider: LLMClient = {
      async *streamChat(): AsyncIterable<StreamEvent> {
        calls++;
        yield {type: 'completed', finishReason: 'stop'};
      },
    };
    const limiter = new ProviderRequestLimiter(1);
    const limited = limiter.wrap(provider);
    const consume = async (client: LLMClient) => {
      for await (const event of client.streamChat(request, new AbortController().signal)) {
        expect(event.type).toBe('completed');
      }
    };

    await consume(limited);
    await expect(consume(limited)).rejects.toThrow('硬上限 1');
    expect(calls).toBe(1);
    expect(limiter.count).toBe(1);
    expect(limiter.blockedCount).toBe(1);
  });

  it('拒绝无效上限', () => {
    expect(() => new ProviderRequestLimiter(0)).toThrow('必须是正整数');
    expect(() => new ProviderRequestLimiter(1.5)).toThrow('必须是正整数');
  });
});

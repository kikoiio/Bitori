import {describe, expect, it} from 'vitest';
import {MockLLMClient} from '../helpers/mock-llm-client.js';

describe('统一 Provider 流', () => {
  it('在完成前产生多个可见 delta 与 usage', async () => {
    const client = new MockLLMClient([
      {type: 'text_delta', text: 'a'}, {type: 'text_delta', text: 'b'},
      {type: 'usage', usage: {inputTokens: 1, outputTokens: 2}},
      {type: 'completed', finishReason: 'stop'},
    ]);
    const events = [];
    for await (const event of client.streamChat({messages: []}, new AbortController().signal)) events.push(event);
    expect(events.slice(0, 2)).toEqual([{type: 'text_delta', text: 'a'}, {type: 'text_delta', text: 'b'}]);
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });
});

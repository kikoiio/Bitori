import {describe, expect, it, vi} from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {AnthropicClient} from '../../../src/providers/anthropic.js';
import type {ProviderProfile} from '../../../src/config/types.js';

function profile(thinking: ProviderProfile['thinking']): ProviderProfile {
  return {name: 'claude', protocol: 'anthropic', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking};
}
async function* successful() {
  yield {type: 'content_block_delta', delta: {type: 'thinking_delta', thinking: '想'}};
  yield {type: 'content_block_delta', delta: {type: 'text_delta', text: '答'}};
  yield {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 2}};
}

describe('AnthropicClient', () => {
  it('转换 thinking 和文本', async () => {
    const sdk = {messages: {stream: vi.fn().mockReturnValue(successful())}} as unknown as Anthropic;
    const events = [];
    for await (const event of new AnthropicClient(profile({type: 'adaptive'}), sdk).streamChat({messages: []}, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({type: 'thinking_delta', text: '想'});
    expect(events).toContainEqual({type: 'text_delta', text: '答'});
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });

  it('auto 仅在 adaptive 明确不支持且无 delta 时回退 manual', async () => {
    async function* unsupported() { throw Object.assign(new Error('adaptive is not supported'), {status: 400}); }
    const stream = vi.fn().mockReturnValueOnce(unsupported()).mockReturnValueOnce(successful());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    const events = [];
    for await (const event of new AnthropicClient(profile({type: 'auto'}), sdk).streamChat({messages: []}, new AbortController().signal)) events.push(event);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls[1]?.[0]).toMatchObject({max_tokens: 8192, thinking: {type: 'enabled', budget_tokens: 4096}});
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });

  it('认证错误不回退', async () => {
    async function* unauthorized() { throw Object.assign(new Error('bad key'), {status: 401}); }
    const stream = vi.fn().mockReturnValue(unauthorized());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    const events = [];
    for await (const event of new AnthropicClient(profile({type: 'auto'}), sdk).streamChat({messages: []}, new AbortController().signal)) events.push(event);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({type: 'error', error: {code: 'authentication'}});
  });

  // 结构化系统提示与缓存断点映射。
  it('system 映射为块数组，仅可缓存块携带 cache_control', async () => {
    const stream = vi.fn().mockReturnValue(successful());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    const request = {messages: [], system: [{text: '稳定模块', cacheable: true}, {text: '环境信息', cacheable: false}]};
    for await (const event of new AnthropicClient(profile({type: 'disabled'}), sdk).streamChat(request, new AbortController().signal)) { void event; }
    const parameters = stream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(parameters.system).toEqual([
      {type: 'text', text: '稳定模块', cache_control: {type: 'ephemeral'}},
      {type: 'text', text: '环境信息'},
    ]);
    expect((parameters.system as Array<Record<string, unknown>>)[1]).not.toHaveProperty('cache_control');
  });

  it('仅末位工具携带 cache_control 断点', async () => {
    const stream = vi.fn().mockReturnValue(successful());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    const tools = [
      {name: 'read_file', description: '读取', inputSchema: {type: 'object'}},
      {name: 'write_file', description: '写入', inputSchema: {type: 'object'}},
    ];
    for await (const event of new AnthropicClient(profile({type: 'disabled'}), sdk).streamChat({messages: [], tools}, new AbortController().signal)) { void event; }
    const sentTools = (stream.mock.calls[0]?.[0] as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    expect(sentTools[0]).not.toHaveProperty('cache_control');
    expect(sentTools[1]).toMatchObject({cache_control: {type: 'ephemeral'}});
  });

  it('解析 message_start 携带的缓存创建与命中字段', async () => {
    async function* withCacheUsage() {
      yield {type: 'message_start', message: {usage: {input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 80, cache_read_input_tokens: 20}}};
      yield {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 2}};
    }
    const sdk = {messages: {stream: vi.fn().mockReturnValue(withCacheUsage())}} as unknown as Anthropic;
    const events = [];
    for await (const event of new AnthropicClient(profile({type: 'disabled'}), sdk).streamChat({messages: []}, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({type: 'usage', usage: {inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 80, cacheReadInputTokens: 20}});
  });

  it('reminder 项渲染为用户角色消息且内容原样', async () => {
    const stream = vi.fn().mockReturnValue(successful());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    const text = '<system-reminder>\n保持只读\n</system-reminder>';
    const request = {messages: [], items: [{type: 'reminder' as const, text}]};
    for await (const event of new AnthropicClient(profile({type: 'disabled'}), sdk).streamChat(request, new AbortController().signal)) { void event; }
    expect((stream.mock.calls[0]?.[0] as Record<string, unknown>).messages).toEqual([{role: 'user', content: text}]);
  });

  it('无 system 的旧式请求不发送系统提示（回归）', async () => {
    const stream = vi.fn().mockReturnValue(successful());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    for await (const event of new AnthropicClient(profile({type: 'disabled'}), sdk).streamChat({messages: []}, new AbortController().signal)) { void event; }
    const parameters = stream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(parameters).not.toHaveProperty('system');
    expect(parameters).not.toHaveProperty('tools');
  });
  it('同时传入系统提示和消息时保留用户消息', async () => {
    const stream = vi.fn().mockReturnValue(successful());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    for await (const event of new AnthropicClient(profile({type: 'disabled'}), sdk).streamChat({system: [{text: 'system', cacheable: false}], messages: [{role: 'user', content: 'hello'}]}, new AbortController().signal)) { void event; }
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({messages: [{role: 'user', content: 'hello'}]}), expect.anything());
  });

});

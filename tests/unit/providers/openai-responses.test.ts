import {describe, expect, it, vi} from 'vitest';
import type OpenAI from 'openai';
import {OpenAIResponsesClient} from '../../../src/providers/openai-responses.js';
import type {ProviderProfile} from '../../../src/config/types.js';

const profile: ProviderProfile = {name: 'responses', protocol: 'openai-responses', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking: {type: 'disabled'}};
async function* stream() {
  yield {type: 'response.output_text.delta', delta: 'hello'};
  yield {type: 'response.completed', response: {status: 'completed', output: [{type: 'message', id: 'x'}], usage: {input_tokens: 3, output_tokens: 2}}};
}

describe('OpenAIResponsesClient', () => {
  it('设置 store false 并保留 replay output items', async () => {
    const create = vi.fn().mockResolvedValue(stream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    const events = [];
    for await (const event of new OpenAIResponsesClient(profile, sdk).streamChat({messages: [{role: 'user', content: 'hi'}]}, new AbortController().signal)) events.push(event);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({store: false, stream: true}), expect.anything());
    expect(events.at(-1)).toMatchObject({type: 'completed', providerState: {protocol: 'openai-responses', payload: [{type: 'message', id: 'x'}]}});
  });

  it('损坏 state 回退到普通 assistant 文本', async () => {
    const create = vi.fn().mockResolvedValue(stream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    const client = new OpenAIResponsesClient(profile, sdk);
    for await (const event of client.streamChat({messages: [{role: 'assistant', content: 'fallback', providerState: {protocol: 'openai-responses', payload: 'bad'}}]}, new AbortController().signal)) { void event; }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({input: [{role: 'assistant', content: 'fallback'}]}), expect.anything());
  });

  // 系统提示与提醒注入映射。
  it('system 映射为 instructions 字段，reminder 渲染为用户 input', async () => {
    const create = vi.fn().mockResolvedValue(stream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    const request = {
      messages: [],
      system: [{text: '稳定模块', cacheable: true}, {text: '环境信息', cacheable: false}],
      items: [{type: 'reminder' as const, text: '<system-reminder>\n提醒\n</system-reminder>'}],
    };
    for await (const event of new OpenAIResponsesClient(profile, sdk).streamChat(request, new AbortController().signal)) { void event; }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({instructions: '稳定模块\n\n环境信息'}), expect.anything());
    expect((create.mock.calls[0]?.[0] as Record<string, unknown>).input).toEqual([{role: 'user', content: '<system-reminder>\n提醒\n</system-reminder>'}]);
  });

  it('无 system 的请求不携带 instructions（回归）', async () => {
    const create = vi.fn().mockResolvedValue(stream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    for await (const event of new OpenAIResponsesClient(profile, sdk).streamChat({messages: [{role: 'user', content: 'hi'}]}, new AbortController().signal)) { void event; }
    expect(create.mock.calls[0]?.[0] as Record<string, unknown>).not.toHaveProperty('instructions');
  });

  // MCP Server 提供的 JSON Schema 不保证满足 OpenAI strict 子集。
  it('按工具定义保留 strict 开关', async () => {
    const create = vi.fn().mockResolvedValue(stream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    for await (const event of new OpenAIResponsesClient(profile, sdk).streamChat({messages: [], tools: [
      {name: 'builtin', description: 'built in', inputSchema: {type: 'object'}},
      {name: 'mcp__demo__tool', description: 'remote', inputSchema: {type: 'object'}, strict: false},
    ]}, new AbortController().signal)) { void event; }
    expect((create.mock.calls[0]?.[0] as {tools: Array<{strict: boolean}>}).tools.map(tool => tool.strict)).toEqual([true, false]);
  });
  it('同时传入系统提示和消息时保留用户消息', async () => {
    const create = vi.fn().mockResolvedValue(stream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    for await (const event of new OpenAIResponsesClient(profile, sdk).streamChat({system: [{text: 'system', cacheable: false}], messages: [{role: 'user', content: 'hello'}]}, new AbortController().signal)) { void event; }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({instructions: 'system', input: [{role: 'user', content: 'hello'}]}), expect.anything());
  });

});

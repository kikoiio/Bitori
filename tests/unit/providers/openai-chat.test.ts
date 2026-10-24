import {describe, expect, it, vi} from 'vitest';
import type OpenAI from 'openai';
import {OpenAIChatClient} from '../../../src/providers/openai-chat.js';
import type {ProviderProfile} from '../../../src/config/types.js';

const profile: ProviderProfile = {name: 'chat', protocol: 'openai-chat', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking: {type: 'disabled'}};
async function* chunks() {
  yield {choices: [{delta: {content: '你'}, finish_reason: null}]};
  yield {choices: [{delta: {content: '好'}, finish_reason: 'stop'}]};
  yield {choices: [], usage: {prompt_tokens: 2, completion_tokens: 1}};
}

describe('OpenAIChatClient', () => {
  it('转换文本、完成和用量事件', async () => {
    const create = vi.fn().mockResolvedValue(chunks());
    const sdk = {chat: {completions: {create}}} as unknown as OpenAI;
    const events = [];
    for await (const event of new OpenAIChatClient(profile, sdk).streamChat({messages: [{role: 'user', content: 'hi'}]}, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({type: 'text_delta', text: '你'});
    expect(events).toContainEqual({type: 'usage', usage: {inputTokens: 2, outputTokens: 1}});
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });
  it('发送统一工具定义并拼接流式调用', async () => {
    async function* toolChunks() {
      yield {choices: [{delta: {tool_calls: [{index: 0, id: 'p1', function: {name: 'read_file', arguments: '{"path":'}}]}, finish_reason: null}]};
      yield {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"a"}'}}]}, finish_reason: 'tool_calls'}]};
    }
    const create = vi.fn().mockResolvedValue(toolChunks()); const sdk = {chat: {completions: {create}}} as unknown as OpenAI; const events = [];
    for await (const event of new OpenAIChatClient(profile, sdk).streamChat({messages: [], tools: [{name: 'read_file', description: 'read', inputSchema: {type: 'object'}}]}, new AbortController().signal)) events.push(event);
    expect(create).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({type: 'tool_call_start', internalId: 'chat-0', providerCallId: 'p1', position: 0, name: 'read_file'});
    expect(events).toContainEqual({type: 'tool_call_arguments_delta', internalId: 'chat-0', delta: '"a"}'});
    expect(events).toContainEqual({type: 'tool_call_end', internalId: 'chat-0'});
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'tool_calls'});
  });

  // [s04] 系统提示与提醒注入映射。
  it('system 映射为首条 system 消息，reminder 渲染为用户消息', async () => {
    const create = vi.fn().mockResolvedValue(chunks());
    const sdk = {chat: {completions: {create}}} as unknown as OpenAI;
    const request = {
      messages: [],
      system: [{text: '稳定模块', cacheable: true}, {text: '环境信息', cacheable: false}],
      items: [
        {type: 'message' as const, messageId: 'm1', role: 'user' as const, content: '任务'},
        {type: 'reminder' as const, text: '<system-reminder>\n提醒\n</system-reminder>'},
      ],
    };
    for await (const event of new OpenAIChatClient(profile, sdk).streamChat(request, new AbortController().signal)) { void event; }
    const sent = (create.mock.calls[0]?.[0] as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({role: 'system', content: '稳定模块\n\n环境信息'});
    expect(sent.at(-1)).toEqual({role: 'user', content: '<system-reminder>\n提醒\n</system-reminder>'});
  });

  it('无 system 的请求不添加 system 消息（回归）', async () => {
    const create = vi.fn().mockResolvedValue(chunks());
    const sdk = {chat: {completions: {create}}} as unknown as OpenAI;
    for await (const event of new OpenAIChatClient(profile, sdk).streamChat({messages: [{role: 'user', content: 'hi'}]}, new AbortController().signal)) { void event; }
    const sent = (create.mock.calls[0]?.[0] as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    expect(sent.every(message => message.role !== 'system')).toBe(true);
  });
});

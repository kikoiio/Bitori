import {describe, expect, it, vi} from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {AnthropicClient} from '../../src/providers/anthropic.js';
import {OpenAIChatClient} from '../../src/providers/openai-chat.js';
import {OpenAIResponsesClient} from '../../src/providers/openai-responses.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {LLMClient, StreamEvent} from '../../src/providers/types.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';

const base = {model: 'm', baseUrl: 'https://x', apiKey: 'test', thinking: {type: 'disabled'} as const};
async function collect(client: LLMClient): Promise<StreamEvent[]> { const events: StreamEvent[] = []; for await (const event of client.streamChat({messages: [], tools: createToolSystem(process.cwd()).registry.definitions()}, new AbortController().signal)) events.push(event); return events; }
async function* anthropicStream() { yield {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'p1', name: 'read_file'}}; yield {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"path":'}}; yield {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '"a.txt"}'}}; yield {type: 'content_block_stop', index: 0}; yield {type: 'message_delta', delta: {stop_reason: 'tool_use'}}; }
async function* responsesStream() { yield {type: 'response.output_item.added', output_index: 0, item: {type: 'function_call', call_id: 'p1', name: 'read_file'}}; yield {type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":'}; yield {type: 'response.function_call_arguments.delta', output_index: 0, delta: '"a.txt"}'}; yield {type: 'response.output_item.done', output_index: 0, item: {type: 'function_call'}}; yield {type: 'response.completed', response: {status: 'completed', output: []}}; }
async function* chatStream() { yield {choices: [{delta: {tool_calls: [{index: 0, id: 'p1', function: {name: 'read_file', arguments: '{"path":'}}]}, finish_reason: null}]}; yield {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"a.txt"}'}}]}, finish_reason: 'tool_calls'}]}; }
describe('三协议统一工具流', () => {
  it('导出相同工具集并产生等价调用事件', async () => { const anthropicSdk = {messages: {stream: vi.fn().mockReturnValue(anthropicStream())}} as unknown as Anthropic; const responsesCreate = vi.fn().mockResolvedValue(responsesStream()); const chatCreate = vi.fn().mockResolvedValue(chatStream()); const openai = {responses: {create: responsesCreate}, chat: {completions: {create: chatCreate}}} as unknown as OpenAI; const clients: LLMClient[] = [new AnthropicClient({name: 'a', protocol: 'anthropic', ...base} satisfies ProviderProfile, anthropicSdk), new OpenAIResponsesClient({name: 'r', protocol: 'openai-responses', ...base} satisfies ProviderProfile, openai), new OpenAIChatClient({name: 'c', protocol: 'openai-chat', ...base} satisfies ProviderProfile, openai)]; for (const client of clients) { const events = await collect(client); expect(events.map(event => event.type)).toEqual(['tool_call_start', 'tool_call_arguments_delta', 'tool_call_arguments_delta', 'tool_call_end', 'completed']); expect(events[0]).toMatchObject({providerCallId: 'p1', position: 0, name: 'read_file'}); expect(events.at(-1)).toMatchObject({finishReason: 'tool_calls'}); } const requestTools = createToolSystem(process.cwd()).registry.definitions(); expect(requestTools.map(tool => tool.name)).toEqual(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'search_text', 'load_skill', 'team', 'enter_worktree', 'exit_worktree']); });
  it('items 按严格顺序重建工具调用与结果上下文', async () => {
    const aStream = vi.fn().mockReturnValue((async function* () { yield {type: 'message_delta', delta: {stop_reason: 'end_turn'}}; })());
    const rCreate = vi.fn().mockResolvedValue((async function* () { yield {type: 'response.completed', response: {status: 'completed', output: []}}; })());
    const cCreate = vi.fn().mockResolvedValue((async function* () { yield {choices: [{delta: {}, finish_reason: 'stop'}]}; })());
    const result = {status: 'success' as const, output: {content: 'x'}};
    const request = {messages: [], items: [
      {type: 'message' as const, messageId: 'u', role: 'user' as const, content: '读文件'},
      {type: 'assistant_iteration' as const, messageId: 'a', content: '', toolCalls: [{callId: 'c1', providerCallId: 'p1', name: 'read_file', argumentsText: '{"path":"a"}', arguments: {path: 'a'}}]},
      {type: 'tool_results' as const, assistantMessageId: 'a', results: [{callId: 'c1', providerCallId: 'p1', name: 'read_file', result}]},
      {type: 'assistant_iteration' as const, messageId: 'c', content: '结果如下', toolCalls: []},
      {type: 'message' as const, messageId: 'u2', role: 'user' as const, content: '继续'},
    ]};
    for await (const event of new AnthropicClient({name: 'a', protocol: 'anthropic', ...base}, {messages: {stream: aStream}} as unknown as Anthropic).streamChat(request, new AbortController().signal)) void event;
    for await (const event of new OpenAIResponsesClient({name: 'r', protocol: 'openai-responses', ...base}, {responses: {create: rCreate}} as unknown as OpenAI).streamChat(request, new AbortController().signal)) void event;
    for await (const event of new OpenAIChatClient({name: 'c', protocol: 'openai-chat', ...base}, {chat: {completions: {create: cCreate}}} as unknown as OpenAI).streamChat(request, new AbortController().signal)) void event;
    expect((aStream.mock.calls[0]?.[0] as {messages: Array<{role: string}>}).messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const responseTypes = (rCreate.mock.calls[0]?.[0] as {input: Array<{type?: string}>}).input.map(item => item.type).filter(Boolean);
    expect(responseTypes).toEqual(['function_call', 'function_call_output']);
    expect((cCreate.mock.calls[0]?.[0] as {messages: Array<{role: string}>}).messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  });
});

import Anthropic from '@anthropic-ai/sdk';
import {describe, expect, it} from 'vitest';
import {AnthropicClient} from '../../../src/providers/anthropic.js';
import type {ProviderProfile} from '../../../src/config/types.js';
import type {ChatRequest, ModelContextItem, StreamEvent} from '../../../src/providers/types.js';

const blocks = [
  {type: 'thinking', thinking: '先检查文件。', signature: 'sig-part-1+part-2='},
  {type: 'redacted_thinking', data: 'opaque-redacted+/='},
  {type: 'text', text: '准备读取。', citations: null},
  {type: 'tool_use', id: 'tool-1', name: 'read_file', input: {path: 'a.txt'}},
  {type: 'thinking', thinking: '', signature: 'empty-thinking-signature='},
  {type: 'tool_use', id: 'tool-2', name: 'read_file', input: {path: 'b.txt'}},
] satisfies Anthropic.ContentBlockParam[];

function sse(content: typeof blocks, reason: string): Response {
  const events: Array<{type: string; [key: string]: unknown}> = [{type: 'message_start', message: {id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 0}}}];
  for (const [index, block] of content.entries()) {
    if (block.type === 'thinking') {
      events.push({type: 'content_block_start', index, content_block: {...block, thinking: '', signature: ''}},
        {type: 'content_block_delta', index, delta: {type: 'thinking_delta', thinking: block.thinking}},
        {type: 'content_block_delta', index, delta: {type: 'signature_delta', signature: block.signature.slice(0, 10)}},
        {type: 'content_block_delta', index, delta: {type: 'signature_delta', signature: block.signature.slice(10)}});
    } else if (block.type === 'text') {
      events.push({type: 'content_block_start', index, content_block: {...block, text: ''}},
        {type: 'content_block_delta', index, delta: {type: 'text_delta', text: block.text}});
    } else if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input);
      events.push({type: 'content_block_start', index, content_block: {...block, input: {}}},
        {type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: json.slice(0, 8)}},
        {type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: json.slice(8)}});
    } else events.push({type: 'content_block_start', index, content_block: block});
    events.push({type: 'content_block_stop', index});
  }
  events.push({type: 'message_delta', delta: {stop_reason: reason, stop_sequence: null}, usage: {output_tokens: 10}}, {type: 'message_stop'});
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
}

async function collect(client: AnthropicClient, request: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamChat(request, new AbortController().signal)) events.push(event);
  return events;
}

describe('Anthropic thinking 协议重放', () => {
  it.each<ProviderProfile['thinking']>([{type: 'manual', budgetTokens: 1024, maxTokens: 4096}, {type: 'adaptive'}, {type: 'auto'}])('%j 工具续轮原样重放所有块、签名和顺序', async thinking => {
    const requests: unknown[] = [];
    const replies = [sse(blocks, 'tool_use'), sse([{type: 'text', text: '文件已读取。', citations: null}], 'end_turn'), sse([], 'end_turn')];
    let unsupported = thinking.type === 'auto';
    const sdk = new Anthropic({apiKey: 'test', maxRetries: 0, fetch: async (_url, init) => {
      requests.push(parseRequestBody(init));
      if (unsupported) { unsupported = false; return new Response(JSON.stringify({type: 'error', error: {type: 'invalid_request_error', message: 'adaptive is not supported'}}), {status: 400}); }
      const reply = replies.shift();
      if (!reply) throw new Error('收到未预期的请求');
      return reply;
    }});
    const client = new AnthropicClient({name: 'test', protocol: 'anthropic', model: 'm', baseUrl: 'https://unused.invalid', apiKey: 'test', thinking}, sdk);
    const first = await collect(client, {messages: [{role: 'user', content: '读取两个文件'}]});
    const completed = first.find(event => event.type === 'completed');
    expect(completed).toEqual({type: 'completed', providerState: {protocol: 'anthropic', payload: blocks}, finishReason: 'tool_calls'});
    if (completed?.type !== 'completed' || !completed.providerState) throw new Error('缺少协议状态');
    expect(first.filter(event => event.type === 'thinking_delta')).toEqual([{type: 'thinking_delta', text: '先检查文件。'}]);
    expect(first.filter(event => event.type === 'tool_call_start')).toMatchObject([{providerCallId: 'tool-1', position: 3}, {providerCallId: 'tool-2', position: 5}]);
    const result = {status: 'success' as const, output: {content: '内容'}};
    const items: ModelContextItem[] = [
      {type: 'message', messageId: 'u', role: 'user', content: '读取两个文件'},
      {type: 'assistant_iteration', messageId: 'a', content: '展示文字不参与协议重建', thinking: '展示思考', providerState: completed.providerState, toolCalls: [
        {callId: 'c1', providerCallId: 'tool-1', name: 'read_file', argumentsText: '{"path":"a.txt"}', arguments: {path: 'a.txt'}},
        {callId: 'c2', providerCallId: 'tool-2', name: 'read_file', argumentsText: '{"path":"b.txt"}', arguments: {path: 'b.txt'}},
      ]},
      {type: 'tool_results', assistantMessageId: 'a', results: ['1', '2'].map(id => ({callId: `c${id}`, providerCallId: `tool-${id}`, name: 'read_file', result}))},
    ];
    const second = await collect(client, {messages: [], items});
    expect(requests.at(-1)).toMatchObject({messages: [
      {role: 'user', content: '读取两个文件'}, {role: 'assistant', content: blocks},
      {role: 'user', content: ['1', '2'].map(id => ({type: 'tool_result', tool_use_id: `tool-${id}`, content: JSON.stringify(result), is_error: false}))},
    ]});
    const final = second.find(event => event.type === 'completed');
    if (final?.type !== 'completed' || !final.providerState) throw new Error('缺少最终回复协议状态');
    items.push({type: 'message', messageId: 'a2', role: 'assistant', content: '展示回复', providerState: final.providerState}, {type: 'message', messageId: 'u2', role: 'user', content: '继续'});
    await collect(client, {messages: [], items: structuredClone(items)});
    expect(requests.at(-1)).toMatchObject({messages: [
      {role: 'user'}, {role: 'assistant', content: blocks}, {role: 'user'},
      {role: 'assistant', content: [{type: 'text', text: '文件已读取。', citations: null}]}, {role: 'user', content: '继续'},
    ]});
  });

  it('兼容 messages 历史也重放助手完整块，用户与其他协议状态不参与重放', async () => {
    const requests: unknown[] = [];
    const sdk = new Anthropic({apiKey: 'test', fetch: async (_url, init) => {
      requests.push(parseRequestBody(init));
      return sse([], 'end_turn');
    }});
    const client = new AnthropicClient({name: 'test', protocol: 'anthropic', model: 'm', baseUrl: 'https://unused.invalid', apiKey: 'test', thinking: {type: 'adaptive'}}, sdk);
    const providerState = {protocol: 'anthropic' as const, payload: [{type: 'thinking', thinking: '历史思考', signature: 'signed'}, {type: 'redacted_thinking', data: 'opaque'}, {type: 'text', text: '历史回复'}]};
    const events = await collect(client, {messages: [
      {role: 'user', content: '问题', providerState},
      {role: 'assistant', content: '展示内容', providerState},
      {role: 'assistant', content: '旧回复', providerState: {protocol: 'openai-responses', payload: [{type: 'reasoning'}]}},
      {role: 'user', content: '继续'},
    ]});
    expect(events.at(-1)).toMatchObject({type: 'completed'});
    expect(requests).toEqual([expect.objectContaining({messages: [
      {role: 'user', content: '问题'}, {role: 'assistant', content: providerState.payload},
      {role: 'assistant', content: '旧回复'}, {role: 'user', content: '继续'},
    ]})]);
  });
});

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('测试请求必须使用 JSON 字符串正文');
  return JSON.parse(init.body) as Record<string, unknown>;
}

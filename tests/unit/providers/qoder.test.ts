import {describe, expect, it} from 'vitest';
import {cloudApiRoot, QoderClient, QoderHttpError, resolveQoderModelId} from '../../../src/providers/qoder.js';
import type {ChatRequest} from '../../../src/providers/types.js';
import {harness, pongStream, qoderProfile as profile, sse, toolStream} from '../../helpers/qoder-harness.js';

async function collect(client: QoderClient, request: ChatRequest) {
  const events = [];
  for await (const event of client.streamChat(request, new AbortController().signal)) events.push(event);
  return events;
}

describe('Qoder Cloud Agents 适配', () => {
  it('归一 Cloud Agents 根路径', () => {
    expect(cloudApiRoot('https://api.qoder.com.cn')).toBe('https://api.qoder.com.cn/api/v1/cloud');
    expect(cloudApiRoot('https://api.qoder.com.cn/')).toBe('https://api.qoder.com.cn/api/v1/cloud');
    expect(cloudApiRoot('https://api.qoder.com.cn/api/v1/cloud')).toBe('https://api.qoder.com.cn/api/v1/cloud');
    expect(cloudApiRoot('https://api.qoder.com/api/v1')).toBe('https://api.qoder.com/api/v1/cloud');
  });

  it('把展示名解析成官方模型 id', () => {
    const models = [
      {id: 'dfmodel', display_name: 'DeepSeek-Flash', is_enabled: true},
      {id: 'auto', display_name: 'Auto', is_enabled: true},
    ];
    expect(resolveQoderModelId('DeepSeek-Flash', models)).toBe('dfmodel');
    expect(resolveQoderModelId('deepseek flash', models)).toBe('dfmodel');
    expect(resolveQoderModelId('dfmodel', models)).toBe('dfmodel');
  });

  it('创建 self_hosted 环境与自定义工具 Agent，并流式输出文本', async () => {
    const {fetch, calls} = harness({streams: [pongStream()]});
    const events = await collect(new QoderClient(profile, fetch), {
      messages: [],
      system: [{text: 'You are Bitori.', cacheable: true}],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'Reply with exactly: pong'}],
      tools: [{name: 'read_file', description: 'Read a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}}],
    });
    expect(events.filter(event => event.type === 'text_delta')).toEqual([
      {type: 'text_delta', text: 'p'},
      {type: 'text_delta', text: 'ong'},
    ]);
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const createdAgent = calls.find(call => call.method === 'POST' && call.path.endsWith('/agents'));
    expect(createdAgent?.body).toMatchObject({name: 'bitori', model: 'dfmodel'});
    const tools = (createdAgent?.body as {tools: Array<{type: string; name?: string}>}).tools;
    expect(tools).toEqual([
      expect.objectContaining({type: 'custom', name: 'read_file'}),
      expect.objectContaining({type: 'agent_toolset_20260401', enabled_tools: ['Bash'], configs: [{name: 'Bash', enabled: false}]}),
    ]);
    const env = calls.find(call => call.method === 'POST' && call.path.endsWith('/environments'));
    expect(env?.body).toMatchObject({config: {type: 'self_hosted'}});
  });

  it('忽略连接时重放的上一轮 idle，继续等待本轮输出', async () => {
    const staleIdle = sse([
      {id: 'evt_old', event: 'session.thread_status_idle', data: {type: 'session.thread_status_idle', stop_reason: {type: 'end_turn'}}},
    ]);
    const {fetch} = harness({streams: [staleIdle + pongStream()]});
    const events = await collect(new QoderClient(profile, fetch), {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'ping'}],
    });
    expect(events.filter(event => event.type === 'text_delta')).toEqual([
      {type: 'text_delta', text: 'p'},
      {type: 'text_delta', text: 'ong'},
    ]);
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });

  it('复用会话返回 busy 时自动换新会话并发送完整转录', async () => {
    const {fetch, calls} = harness({streams: [pongStream(), pongStream()], busyOnReuse: true});
    const client = new QoderClient(profile, fetch);
    const first = await collect(client, {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'first'}],
    });
    expect(first.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const second = await collect(client, {
      messages: [],
      items: [
        {type: 'message', messageId: 'u1', role: 'user', content: 'first'},
        {type: 'message', messageId: 'u2', role: 'user', content: 'second'},
      ],
    });
    expect(second.filter(event => event.type === 'text_delta')).toEqual([
      {type: 'text_delta', text: 'p'},
      {type: 'text_delta', text: 'ong'},
    ]);
    expect(second.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const created = calls.filter(call => call.method === 'POST' && call.path.endsWith('/sessions'));
    expect(created).toHaveLength(2);
    const interrupted = calls.some(call => {
      if (call.method !== 'POST' || !call.path.includes('/sessions/sess_1/events')) return false;
      const body = call.body as {events?: Array<{type?: string}>} | undefined;
      return body?.events?.some(event => event.type === 'user.interrupt') === true;
    });
    expect(interrupted).toBe(true);
    const freshPost = calls.find(call => call.method === 'POST' && call.path.includes('/sessions/sess_2/events'));
    expect(freshPost).toBeTruthy();
    const body = freshPost?.body as {events: Array<{type: string; content: Array<{text: string}>}>};
    const transcript = body.events[0]?.content[0]?.text ?? '';
    expect(transcript).toContain('user: first');
    expect(transcript).toContain('user: second');
  });

  it('复用会话在流开头报 busy 时自动换新会话', async () => {
    const {fetch, calls} = harness({streams: [pongStream(), pongStream(), pongStream()], busyStreamOnReuse: true});
    const client = new QoderClient(profile, fetch);
    await collect(client, {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'first'}],
    });
    const second = await collect(client, {
      messages: [],
      items: [
        {type: 'message', messageId: 'u1', role: 'user', content: 'first'},
        {type: 'message', messageId: 'u2', role: 'user', content: 'second'},
      ],
    });
    expect(second.filter(event => event.type === 'text_delta')).toEqual([
      {type: 'text_delta', text: 'p'},
      {type: 'text_delta', text: 'ong'},
    ]);
    expect(second.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const created = calls.filter(call => call.method === 'POST' && call.path.endsWith('/sessions'));
    expect(created).toHaveLength(2);
  });

  it('内置工具被策略拒绝后继续使用自定义工具，不产生空白回复', async () => {
    const stream = sse([
      {id: 'evt_bash', event: 'agent.tool_use', data: {id: 'evt_bash', type: 'agent.tool_use', name: 'Bash', input: {command: 'pwd'}, evaluated_permission: 'deny'}},
      {id: 'evt_denied', event: 'agent.tool_result', data: {id: 'evt_denied', type: 'agent.tool_result', tool_use_id: 'evt_bash', is_error: true, content: [{type: 'text', text: 'tool not permitted by policy'}]}},
      {id: 'evt_custom', event: 'agent.custom_tool_use', data: {id: 'evt_custom', type: 'agent.custom_tool_use', name: 'run_command', input: {command: 'pwd'}}},
      {id: 'evt_idle', event: 'session.thread_status_idle', data: {type: 'session.thread_status_idle', stop_reason: {type: 'requires_action', event_ids: ['evt_custom']}}},
    ]);
    const {fetch} = harness({streams: [stream]});
    const events = await collect(new QoderClient(profile, fetch), {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'pwd'}],
      tools: [{name: 'run_command', description: 'Run', inputSchema: {type: 'object', properties: {command: {type: 'string'}}}}],
    });
    expect(events).toContainEqual({type: 'tool_call_start', internalId: 'evt_custom', providerCallId: 'evt_custom', position: 0, name: 'run_command'});
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'tool_calls'});
  });

  it('工具结果回传后忽略上一轮的 requires_action 快照并继续读取文本', async () => {
    const stale = sse([
      {id: 'evt_tool', event: 'session.thread_status_idle', data: {type: 'session.thread_status_idle', stop_reason: {type: 'requires_action', event_ids: ['evt_tool']}}},
    ]);
    const {fetch} = harness({streams: [toolStream(), stale + pongStream()]});
    const client = new QoderClient(profile, fetch);
    await collect(client, {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'read it'}],
      tools: [{name: 'read_file', description: 'Read a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}}}}],
    });
    const second = await collect(client, {
      messages: [],
      items: [
        {type: 'message', messageId: 'u1', role: 'user', content: 'read it'},
        {type: 'assistant_iteration', messageId: 'a1', content: '', toolCalls: [{callId: 'c1', providerCallId: 'evt_tool', name: 'read_file', argumentsText: '{"path":"README.md"}', arguments: {path: 'README.md'}}]},
        {type: 'tool_results', assistantMessageId: 'a1', results: [{callId: 'c1', providerCallId: 'evt_tool', name: 'read_file', result: {status: 'success', output: {content: 'hello'}}}]},
      ],
      tools: [{name: 'read_file', description: 'Read a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}}}}],
    });
    expect(second.filter(event => event.type === 'text_delta')).toEqual([
      {type: 'text_delta', text: 'p'},
      {type: 'text_delta', text: 'ong'},
    ]);
    expect(second.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });

  it('把 custom_tool_use 映射为本地工具调用，并回传 custom_tool_result', async () => {
    const {fetch, calls} = harness({streams: [toolStream(), pongStream()]});
    const client = new QoderClient(profile, fetch);
    const first = await collect(client, {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'read it'}],
      tools: [{name: 'read_file', description: 'Read a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}}}}],
    });
    expect(first).toContainEqual({type: 'tool_call_start', internalId: 'evt_tool', providerCallId: 'evt_tool', position: 0, name: 'read_file'});
    expect(first.at(-1)).toEqual({type: 'completed', finishReason: 'tool_calls'});
    const second = await collect(client, {
      messages: [],
      items: [
        {type: 'message', messageId: 'u1', role: 'user', content: 'read it'},
        {type: 'assistant_iteration', messageId: 'a1', content: '', toolCalls: [{callId: 'c1', providerCallId: 'evt_tool', name: 'read_file', argumentsText: '{"path":"README.md"}', arguments: {path: 'README.md'}}]},
        {type: 'tool_results', assistantMessageId: 'a1', results: [{callId: 'c1', providerCallId: 'evt_tool', name: 'read_file', result: {status: 'success', output: {content: 'hello'}}}]},
      ],
    });
    expect(second.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const resultCall = calls.filter(call => call.method === 'POST' && call.path.endsWith('/events')).at(-1);
    expect(resultCall?.body).toMatchObject({
      events: [{type: 'user.custom_tool_result', custom_tool_use_id: 'evt_tool'}],
    });
  });

  it('为保留名和 mcp__ 工具加前缀', async () => {
    const {fetch, calls} = harness({streams: [pongStream()]});
    await collect(new QoderClient(profile, fetch), {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'hi'}],
      tools: [
        {name: 'Read', description: 'x', inputSchema: {type: 'object'}},
        {name: 'mcp__git__status', description: 'y', inputSchema: {type: 'object'}},
      ],
    });
    const createdAgent = calls.find(call => call.method === 'POST' && call.path.endsWith('/agents'));
    const tools = (createdAgent?.body as {tools: Array<{type: string; name?: string}>}).tools;
    expect(tools.filter(tool => tool.type === 'custom').map(tool => tool.name)).toEqual(['bitori__Read', 'bitori__mcp__git__status']);
  });

  it('把官方错误信封映射为供应商错误', async () => {
    const {fetch} = harness({
      streams: [],
      error: {status: 401, body: {type: 'error', error: {type: 'authentication_error', message: 'PAT invalid'}}},
    });
    const events = await collect(new QoderClient(profile, fetch), {
      messages: [{role: 'user', content: 'hi'}],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'hi'}],
    });
    expect(events[0]).toMatchObject({type: 'error', error: {code: 'authentication', statusCode: 401, message: 'PAT invalid'}});
  });

  it('暴露 HTTP 错误状态', () => {
    const error = new QoderHttpError(404, 'missing');
    expect(error.status).toBe(404);
    expect(error.message).toBe('missing');
  });
});

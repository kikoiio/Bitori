import {describe, expect, it} from 'vitest';
import {QoderClient, resolveQoderModelId} from '../../src/providers/qoder.js';
import type {ChatRequest, StreamEvent} from '../../src/providers/types.js';
import {harness, pongStream, qoderFixture, qoderFixtureJson, qoderProfile} from '../helpers/qoder-harness.js';

const echoTool = {name: 'capture_echo', description: 'Echo text', inputSchema: {type: 'object', properties: {text: {type: 'string'}}}};

async function collect(client: QoderClient, request: ChatRequest, signal: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamChat(request, signal)) events.push(event);
  return events;
}

function textOf(events: StreamEvent[]): string {
  return events.filter(event => event.type === 'text_delta').map(event => event.type === 'text_delta' ? event.text : '').join('');
}

function usageOf(events: StreamEvent[]): Array<{inputTokens: number; outputTokens: number; credits?: number}> {
  return events.filter(event => event.type === 'usage').map(event => event.type === 'usage' ? event.usage : {inputTokens: 0, outputTokens: 0});
}

describe('Qoder 真实事件 fixture 回放', () => {
  it('回放真实文本回合:增量只出一次,credits 用量在 completed 前上报', async () => {
    const {fetch} = harness({streams: [qoderFixture('text-turn.txt')]});
    const events = await collect(new QoderClient(qoderProfile, fetch), {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: '只回复:收到'}],
    }, new AbortController().signal);
    expect(textOf(events)).toBe('收到');
    expect(usageOf(events)).toEqual([{inputTokens: 0, outputTokens: 0, credits: 0.04}]);
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const order = events.map(event => event.type);
    expect(order.indexOf('usage')).toBeLessThan(order.indexOf('completed'));
  });

  it('回放 custom_tool_use + requires_action,续轮回传结果后再接住新一轮工具调用', async () => {
    const {fetch, calls} = harness({streams: [qoderFixture('custom-tool-requires-action.txt'), qoderFixture('transcript-fallback-turn.txt')]});
    const client = new QoderClient(qoderProfile, fetch);
    const request: ChatRequest = {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'call echo'}],
      tools: [echoTool],
    };
    const first = await collect(client, request, new AbortController().signal);
    expect(first).toContainEqual({type: 'tool_call_start', internalId: 'evt_0007', providerCallId: 'evt_0007', position: 0, name: 'capture_echo'});
    expect(usageOf(first)).toEqual([{inputTokens: 0, outputTokens: 0, credits: 0.05}]);
    expect(first.at(-1)).toEqual({type: 'completed', finishReason: 'tool_calls'});

    const second = await collect(client, {
      ...request,
      items: [
        ...request.items ?? [],
        {type: 'assistant_iteration', messageId: 'a1', content: '', toolCalls: [{callId: 'c1', providerCallId: 'evt_0007', name: 'capture_echo', argumentsText: '{"text":"hello"}', arguments: {text: 'hello'}}]},
        {type: 'tool_results', assistantMessageId: 'a1', results: [{callId: 'c1', providerCallId: 'evt_0007', name: 'capture_echo', result: {status: 'success', output: {echo: 'hello'}}}]},
      ],
    }, new AbortController().signal);
    const posted = calls.find(call => JSON.stringify(call.body)?.includes('user.custom_tool_result'));
    expect(posted?.body).toMatchObject({events: [{type: 'user.custom_tool_result', custom_tool_use_id: 'evt_0007'}]});
    expect(second).toContainEqual(expect.objectContaining({type: 'tool_call_start', internalId: 'evt_0014'}));
    expect(usageOf(second)).toEqual([{inputTokens: 0, outputTokens: 0, credits: 0.02}]);
    expect(second.at(-1)).toEqual({type: 'completed', finishReason: 'tool_calls'});
  });

  it('内置工具 requires_action 不再挂起会话:立即上报 unsupported_action 而不是空白结束', async () => {
    const {fetch} = harness({streams: [qoderFixture('builtin-tool-requires-action.txt')]});
    const events = await collect(new QoderClient(qoderProfile, fetch), {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'run pwd with built-in bash'}],
    }, new AbortController().signal);
    const error = events.find(event => event.type === 'error');
    expect(error).toMatchObject({type: 'error', error: {code: 'unsupported_action', retryable: false}});
    if (error?.type === 'error') expect(error.error.message).toContain('requires_action');
  });

  it('流在结论前被切断:带 Last-Event-ID 重连并续读,不产生空回复', async () => {
    const {fetch, streamRequests} = harness({
      streams: [qoderFixture('reconnect-first.txt'), qoderFixture('reconnect-resume.txt')],
      disconnectAfter: [{streamIndex: 0, frames: 3}],
    });
    const events = await collect(new QoderClient(qoderProfile, fetch), {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: '数到 30'}],
    }, new AbortController().signal);
    expect(streamRequests).toHaveLength(2);
    expect(streamRequests[1]?.headers['last-event-id']).toBe('evt_0027');
    expect(textOf(events)).toContain('24');
    expect(usageOf(events)).toEqual([{inputTokens: 0, outputTokens: 0, credits: 0.01}]);
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
  });

  it('agent 更新撞 409 Version conflict 时重取版本并重试一次', async () => {
    const {fetch, calls} = harness({streams: [pongStream(), pongStream()], agentConflict: {times: 1, freshAgentVersion: 42}});
    const client = new QoderClient(qoderProfile, fetch);
    const first = await collect(client, {
      messages: [],
      system: [{text: 'v1 system', cacheable: false}],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'ping'}],
    }, new AbortController().signal);
    expect(first.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const second = await collect(client, {
      messages: [],
      system: [{text: 'v2 system changed fingerprint', cacheable: false}],
      items: [{type: 'message', messageId: 'u2', role: 'user', content: 'ping'}],
    }, new AbortController().signal);
    expect(second.at(-1)).toEqual({type: 'completed', finishReason: 'stop'});
    const updates = calls.filter(call => call.method === 'POST' && /\/agents\/agent_1$/.test(call.path));
    expect(updates).toHaveLength(2);
    expect(updates[1]?.body).toMatchObject({version: 42});
  });

  it('取消带挂起工具的回合:清 pending、发 user.interrupt,不再向旧会话回传过期工具结果', async () => {
    const {fetch, calls} = harness({
      streams: [qoderFixture('custom-tool-requires-action.txt'), pongStream()],
      holdOpen: [{streamIndex: 0, frames: 2}],
    });
    const client = new QoderClient(qoderProfile, fetch);
    const controller = new AbortController();
    const request: ChatRequest = {
      messages: [],
      items: [{type: 'message', messageId: 'u1', role: 'user', content: 'call echo'}],
      tools: [echoTool],
    };
    const events: StreamEvent[] = [];
    for await (const event of client.streamChat(request, controller.signal)) {
      events.push(event);
      if (event.type === 'tool_call_start') controller.abort();
    }
    expect(events.at(-1)).toEqual({type: 'completed', finishReason: 'cancelled'});
    const interrupt = calls.find(call => JSON.stringify(call.body)?.includes('user.interrupt'));
    expect(interrupt).toBeTruthy();

    await collect(client, {
      ...request,
      items: [
        ...request.items ?? [],
        {type: 'assistant_iteration', messageId: 'a1', content: '', toolCalls: [{callId: 'c1', providerCallId: 'evt_0007', name: 'capture_echo', argumentsText: '{"text":"hello"}', arguments: {text: 'hello'}}]},
        {type: 'tool_results', assistantMessageId: 'a1', results: [{callId: 'c1', providerCallId: 'evt_0007', name: 'capture_echo', result: {status: 'success', output: {echo: 'hello'}}}]},
      ],
    }, new AbortController().signal);
    expect(JSON.stringify(calls)).not.toContain('user.custom_tool_result');
    const sessions = calls.filter(call => call.method === 'POST' && call.path.endsWith('/sessions'));
    expect(sessions).toHaveLength(2);
  });

  it('真实模型目录可解析展示名并保留未知 id', () => {
    const catalog = qoderFixtureJson('models.json');
    const data = (catalog.data ?? []) as Array<{id?: unknown; display_name?: unknown; is_enabled?: unknown}>;
    expect(data.length).toBeGreaterThan(5);
    expect(resolveQoderModelId('DeepSeek-Flash', data)).toBe('dfmodel');
    expect(resolveQoderModelId('qwen3.8 flash', data)).toBe('qfmodel');
    expect(resolveQoderModelId('Not-A-Model', data)).toBe('Not-A-Model');
  });
});

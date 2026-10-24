import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../../src/agent/runner.js';
import {SafetyBatchScheduler} from '../../../src/agent/safety-batch-scheduler.js';
import {StreamCollector} from '../../../src/agent/stream-collector.js';
import type {AgentEvent, AgentRunResult} from '../../../src/agent/types.js';
import type {StreamEvent} from '../../../src/providers/types.js';
import type {PromptBlock} from '../../../src/prompt/builder.js';
import {createToolSystem} from '../../../src/tools/create-tool-system.js';
import {MockLLMClient} from '../../helpers/mock-llm-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function toolCall(name: string, args: string, id = 'x'): StreamEvent[] { return [{type: 'tool_call_start', internalId: id, providerCallId: `p-${id}`, position: 0, name}, {type: 'tool_call_arguments_delta', internalId: id, delta: args}, {type: 'tool_call_end', internalId: id}, {type: 'completed', finishReason: 'tool_calls'}]; }
async function run(scripts: StreamEvent[][], limits?: {maxIterations: number; maxUnknownToolIterations: number}, extra?: {system?: PromptBlock[]; reminders?: string[]}) {
  const root = mkdtempSync(join(tmpdir(), 'bitori-runner-')); roots.push(root); writeFileSync(join(root, 'note.txt'), 'ok');
  const client = new MockLLMClient(scripts); const tools = createToolSystem(root);
  const runner = new AgentRunner(client, tools.registry, new StreamCollector(), new SafetyBatchScheduler(tools.executor, tools.approvals));
  const events: AgentEvent[] = []; const generator = runner.run({runId: 'r', sessionId: 's', trigger: 'message', mode: 'execute', instruction: 'test', context: [{type: 'message', messageId: 'u', role: 'user', content: 'test'}], ...(limits ? {limits} : {}), ...(extra?.system ? {system: extra.system} : {}), ...(extra?.reminders ? {reminders: extra.reminders} : {})}, new AbortController().signal);
  let result: AgentRunResult;
  while (true) { const step = await generator.next(); if (step.done) { result = step.value; break; } events.push(step.value); }
  return {client, events, result};
}

describe('AgentRunner', () => {
  it('自主循环并在无工具响应时自然完成', async () => {
    const value = await run([toolCall('read_file', '{"path":"note.txt"}'), [{type: 'text_delta', text: '完成'}, {type: 'completed', finishReason: 'stop'}]]);
    expect(value.client.requests).toHaveLength(2); expect(value.result).toMatchObject({status: 'completed', stopReason: 'natural_completion', iterationCount: 2});
    expect(value.client.requests[1]?.items?.at(-1)?.type).toBe('tool_results');
  });
  it('连续三轮全未知工具后停止', async () => {
    const value = await run([toolCall('missing_a', '{}', 'a'), toolCall('missing_b', '{}', 'b'), toolCall('missing_c', '{}', 'c')]);
    expect(value.client.requests).toHaveLength(3); expect(value.result.stopReason).toBe('unknown_tool_limit');
  });
  it('第 20 次工具调用不执行', async () => {
    const scripts = Array.from({length: 20}, (_, index) => toolCall('read_file', '{"path":"note.txt"}', String(index)));
    const value = await run(scripts, {maxIterations: 20, maxUnknownToolIterations: 3});
    expect(value.client.requests).toHaveLength(20); expect(value.result).toMatchObject({stopReason: 'iteration_limit', iterationCount: 20});
    expect(value.events.some(event => event.type === 'tool_result' && event.result.status === 'error' && event.result.error.code === 'agent_loop_limit')).toBe(true);
  });
  it('没有正常结束事件时按流错误停止且不重试', async () => {
    const value = await run([[{type: 'text_delta', text: '部分'}]]); expect(value.client.requests).toHaveLength(1); expect(value.result.stopReason).toBe('stream_error');
  });

  // [s04] 系统提示透传、提醒注入与缓存用量累计。
  it('每次模型请求携带同一份系统提示', async () => {
    const system: PromptBlock[] = [{text: '稳定模块', cacheable: true}, {text: '环境信息', cacheable: false}];
    const value = await run([toolCall('read_file', '{"path":"note.txt"}'), [{type: 'completed', finishReason: 'stop'}]], undefined, {system});
    expect(value.client.requests).toHaveLength(2);
    for (const request of value.client.requests) expect(request.system).toEqual(system);
  });

  it('reminders 追加在最后一条用户消息之后且顺序保持', async () => {
    const value = await run([[{type: 'completed', finishReason: 'stop'}]], undefined, {reminders: ['R1', 'R2']});
    const items = value.client.requests[0]?.items ?? [];
    expect(items.at(-3)).toMatchObject({type: 'message', role: 'user'});
    expect(items.at(-2)).toEqual({type: 'reminder', text: 'R1'});
    expect(items.at(-1)).toEqual({type: 'reminder', text: 'R2'});
  });

  it('缓存用量随事件与回合总量累计', async () => {
    const first = [...toolCall('read_file', '{"path":"note.txt"}')];
    first.splice(3, 0, {type: 'usage', usage: {inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 10, cacheCreationInputTokens: 100}});
    const second: StreamEvent[] = [{type: 'usage', usage: {inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 5}}, {type: 'completed', finishReason: 'stop'}];
    const value = await run([first, second]);
    expect(value.events.some(event => event.type === 'usage_updated' && event.iterationUsage.cacheReadInputTokens === 10)).toBe(true);
    expect(value.result.usage).toMatchObject({inputTokens: 30, outputTokens: 3, cacheReadInputTokens: 15, cacheCreationInputTokens: 100});
  });
});

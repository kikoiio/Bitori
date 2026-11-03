import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AgentContext} from '../../../src/agent/context.js';
import {AgentRunner} from '../../../src/agent/runner.js';
import {SafetyBatchScheduler} from '../../../src/agent/safety-batch-scheduler.js';
import {StreamCollector} from '../../../src/agent/stream-collector.js';
import type {AgentEvent, AgentRunResult} from '../../../src/agent/types.js';
import type {StoredConversation} from '../../../src/storage/types.js';
import type {ModelContextItem, StreamEvent} from '../../../src/providers/types.js';
import {createToolSystem} from '../../../src/tools/create-tool-system.js';
import {MockLLMClient} from '../../helpers/mock-llm-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

describe('Agent 恢复上下文', () => {
  it('同一次请求上报较低 usage 时，累计检查点和终态预算不倒退', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-agent-recovery-')); roots.push(root);
    const client = new MockLLMClient([
      {type: 'usage', usage: {inputTokens: 10, outputTokens: 6}},
      {type: 'usage', usage: {inputTokens: 3, outputTokens: 2}},
      {type: 'completed', finishReason: 'stop'},
    ]);
    const tools = createToolSystem(root);
    try {
      const runner = new AgentRunner(client, tools.registry, new StreamCollector(), new SafetyBatchScheduler(tools.executor, tools.approvals));
      const usages = [];
      for await (const event of runner.run({runId: 'r', sessionId: 's', trigger: 'resume', mode: 'execute', instruction: '继续', context: [], iterationOffset: 1, usageOffset: {inputTokens: 7, outputTokens: 3}}, new AbortController().signal)) {
        if (event.type === 'usage_updated') usages.push(event.totalUsage);
        if (event.type === 'run_finished') expect(event.result.usage).toEqual({inputTokens: 17, outputTokens: 9});
      }
      expect(usages).toEqual([{inputTokens: 17, outputTokens: 9}, {inputTokens: 17, outputTokens: 9}]);
    } finally { await tools.close(); }
  });

  it('在重试退避期间取消仍保留失败请求已上报的预算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-agent-recovery-')); roots.push(root);
    const client = new MockLLMClient([
      {type: 'usage', usage: {inputTokens: 10, outputTokens: 6}},
      {type: 'error', error: {code: 'rate_limit', message: '稍后重试', retryable: true}},
    ] satisfies StreamEvent[]);
    const tools = createToolSystem(root);
    const abort = new AbortController();
    try {
      const runner = new AgentRunner(client, tools.registry, new StreamCollector(), new SafetyBatchScheduler(tools.executor, tools.approvals));
      let result: AgentRunResult | undefined;
      for await (const event of runner.run({runId: 'r', sessionId: 's', trigger: 'resume', mode: 'execute', instruction: '继续', context: [], iterationOffset: 1, usageOffset: {inputTokens: 7, outputTokens: 3}}, abort.signal)) {
        if (event.type === 'request_retry') abort.abort();
        if (event.type === 'run_finished') result = event.result;
      }
      expect(client.requests).toHaveLength(1);
      expect(result).toMatchObject({stopReason: 'user_cancelled', iterationCount: 2, usage: {inputTokens: 17, outputTokens: 9}});
    } finally { await tools.close(); }
  });

  it('保留已完成工具的持久化结果', () => {
    const conversation = {
      session: {id: 's', profileName: 'p', title: '恢复', createdAt: 1, updatedAt: 1, agentMode: 'execute', latestPlanMessageId: null},
      messages: [
        {id: 'u', sessionId: 's', role: 'user', content: '读取文件', thinking: '', status: 'completed', errorCode: null, errorMessage: null, usage: null, providerState: null, createdAt: 1, updatedAt: 1},
        {id: 'i1', sessionId: 's', role: 'assistant', content: '我读到了文件。', thinking: '', status: 'completed', errorCode: null, errorMessage: null, usage: {inputTokens: 3, outputTokens: 1}, providerState: null, createdAt: 2, updatedAt: 2},
      ],
      toolCalls: [{id: 'read-1', sessionId: 's', assistantMessageId: 'i1', providerCallId: 'provider-read-1', position: 0, toolName: 'read_file', arguments: {path: 'note.txt'}, argumentsText: '{"path":"note.txt"}', agentRunId: 'r', approvalStatus: 'not_required', executionStatus: 'succeeded', result: {status: 'success', output: {content: 'persisted result'}}, createdAt: 2, updatedAt: 2}],
      agentRuns: [],
    } satisfies StoredConversation;

    expect(AgentContext.fromConversation(conversation).items()).toEqual([
      {type: 'message', messageId: 'u', role: 'user', content: '读取文件'},
      {type: 'assistant_iteration', messageId: 'i1', content: '我读到了文件。', toolCalls: [{callId: 'read-1', providerCallId: 'provider-read-1', name: 'read_file', argumentsText: '{"path":"note.txt"}', arguments: {path: 'note.txt'}}]},
      {type: 'tool_results', assistantMessageId: 'i1', results: [{callId: 'read-1', providerCallId: 'provider-read-1', name: 'read_file', result: {status: 'success', output: {content: 'persisted result'}}}]},
    ]);
  });

  it('从已保存的轮数和用量继续，并将 maxIterations 作为整次 run 的上限', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-agent-recovery-')); roots.push(root);
    const client = new MockLLMClient([[{type: 'usage', usage: {inputTokens: 5, outputTokens: 2}}, {type: 'text_delta', text: '继续完成'}, {type: 'completed', finishReason: 'stop'}]]);
    const tools = createToolSystem(root);
    const execute = vi.spyOn(tools.executor, 'execute');
    const runner = new AgentRunner(client, tools.registry, new StreamCollector(), new SafetyBatchScheduler(tools.executor, tools.approvals));
    const events: AgentEvent[] = [];
    const generator = runner.run({
      runId: 'r', sessionId: 's', trigger: 'message', mode: 'execute', instruction: '继续',
      userMessageId: 'u', context: [{type: 'message', messageId: 'u', role: 'user', content: '继续'}],
      iterationOffset: 2, usageOffset: {inputTokens: 7, outputTokens: 3},
      limits: {maxIterations: 3, maxUnknownToolIterations: 3},
    }, new AbortController().signal);
    let result: AgentRunResult | undefined;
    while (true) {
      const step = await generator.next();
      if (step.done) { result = step.value; break; }
      events.push(step.value);
    }

    expect(client.requests).toHaveLength(1);
    expect(events.find(event => event.type === 'iteration_started')).toMatchObject({iteration: 3});
    expect(events[0]).toMatchObject({type: 'run_started', iterationOffset: 2, totalUsage: {inputTokens: 7, outputTokens: 3}});
    expect(result).toMatchObject({iterationCount: 3, usage: {inputTokens: 12, outputTokens: 5}, stopReason: 'natural_completion'});
    expect(execute).not.toHaveBeenCalled();
    await tools.close();
  });

  it('恢复时已成功的命令只作为上下文，不能再次交给调度器执行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-agent-recovery-')); roots.push(root);
    const client = new MockLLMClient([{type: 'completed', finishReason: 'stop'}]);
    const tools = createToolSystem(root);
    const scheduler = new SafetyBatchScheduler(tools.executor, tools.approvals);
    const execute = vi.spyOn(scheduler, 'execute');
    const context = [
      {type: 'message', messageId: 'u', role: 'user', content: '创建文件'},
      {type: 'assistant_iteration', messageId: 'a', content: '', toolCalls: [{callId: 'done', providerCallId: 'provider-done', name: 'run_command', arguments: {command: 'touch done.txt'}, argumentsText: '{"command":"touch done.txt"}'}]},
      {type: 'tool_results', assistantMessageId: 'a', results: [{callId: 'done', providerCallId: 'provider-done', name: 'run_command', result: {status: 'success', output: {content: 'created'}}}]},
    ] satisfies ModelContextItem[];
    try {
      const runner = new AgentRunner(client, tools.registry, new StreamCollector(), scheduler);
      for await (const event of runner.run({runId: 'r', sessionId: 's', trigger: 'resume', mode: 'execute', instruction: '创建文件', context, iterationOffset: 1}, new AbortController().signal)) {
        if (event.type === 'run_finished') expect(event.result.stopReason).toBe('natural_completion');
      }
      expect(client.requests[0]?.items).toEqual(context);
      expect(execute).not.toHaveBeenCalled();
    } finally { await tools.close(); }
  });

  it('已耗尽迭代预算的恢复不会请求模型或执行工具', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-agent-recovery-')); roots.push(root);
    const client = new MockLLMClient([]);
    const tools = createToolSystem(root);
    const scheduler = new SafetyBatchScheduler(tools.executor, tools.approvals);
    const execute = vi.spyOn(scheduler, 'execute');
    try {
      const runner = new AgentRunner(client, tools.registry, new StreamCollector(), scheduler);
      let result: AgentRunResult | undefined;
      for await (const event of runner.run({runId: 'r', sessionId: 's', trigger: 'resume', mode: 'execute', instruction: '继续', context: [], iterationOffset: 3, usageOffset: {inputTokens: 7, outputTokens: 3}, limits: {maxIterations: 3, maxUnknownToolIterations: 3}}, new AbortController().signal)) {
        if (event.type === 'run_finished') result = event.result;
      }
      expect(result).toMatchObject({stopReason: 'iteration_limit', iterationCount: 3, usage: {inputTokens: 7, outputTokens: 3}});
      expect(client.requests).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
    } finally { await tools.close(); }
  });

  it('credits-only run 恢复后保留既有 credits 累计值', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-agent-recovery-')); roots.push(root);
    const client = new MockLLMClient([[{type: 'completed', finishReason: 'stop'}]]);
    const tools = createToolSystem(root);
    const runner = new AgentRunner(client, tools.registry, new StreamCollector(), new SafetyBatchScheduler(tools.executor, tools.approvals));
    const generator = runner.run({
      runId: 'qoder-run', sessionId: 's', trigger: 'resume', mode: 'execute', instruction: '继续',
      context: [{type: 'message', messageId: 'u', role: 'user', content: '继续'}],
      iterationOffset: 1, usageOffset: {inputTokens: 0, outputTokens: 0, credits: 1.25},
      limits: {maxIterations: 2, maxUnknownToolIterations: 3},
    }, new AbortController().signal);
    let result: AgentRunResult | undefined;
    while (true) {
      const step = await generator.next();
      if (step.done) { result = step.value; break; }
    }

    expect(client.requests).toHaveLength(1);
    expect(result).toMatchObject({iterationCount: 2, usage: {inputTokens: 0, outputTokens: 0, credits: 1.25}});
    await tools.close();
  });
});

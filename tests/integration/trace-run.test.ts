import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../src/agent/runner.js';
import {SafetyBatchScheduler} from '../../src/agent/safety-batch-scheduler.js';
import {StreamCollector} from '../../src/agent/stream-collector.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';
import {MockLLMClient} from '../helpers/mock-llm-client.js';
import {AgentTraceTap} from '../../src/trace/tap.js';
import {TraceWriter} from '../../src/trace/writer.js';
import type {StreamEvent} from '../../src/providers/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

describe('trace 全链路', () => {
  it('一次含 429 重试的 run 产出可回放 trace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-trace-run-')); roots.push(root);
    writeFileSync(join(root, 'note.txt'), 'ok');
    const traceDirectory = mkdtempSync(join(tmpdir(), 'bitori-trace-out-')); roots.push(traceDirectory);
    const scripts: StreamEvent[][] = [
      [{type: 'error', error: {code: 'rate_limit', message: 'too many requests', retryable: true}}],
      [{type: 'text_delta', text: '完成'}, {type: 'completed', finishReason: 'stop'}],
    ];
    const client = new MockLLMClient(scripts);
    const tools = createToolSystem(root);
    const runner = new AgentRunner(client, tools.registry, new StreamCollector(), new SafetyBatchScheduler(tools.executor, tools.approvals));
    const tap = new AgentTraceTap(new TraceWriter(traceDirectory), {profileName: 'demo', model: 'demo-model', protocol: 'anthropic', workspaceRoot: root});
    tap.runHeader('s1', 'r1', 'execute', 'message');
    const generator = runner.run({runId: 'r1', sessionId: 's1', trigger: 'message', mode: 'execute', instruction: 'test', context: [{type: 'message', messageId: 'u1', role: 'user', content: 'test'}], limits: {maxIterations: 20, maxUnknownToolIterations: 3, retryBaseDelayMs: 1}}, new AbortController().signal);
    while (true) {
      const step = await generator.next();
      if (step.done) break;
      tap.record(step.value);
    }
    await tap.flush();
    const events = readFileSync(join(traceDirectory, 's1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    const types = events.map(event => event.type);
    expect(types[0]).toBe('run_header');
    expect(types).toContain('request_prepared');
    expect(types).toContain('request_retry');
    expect(types).toContain('response');
    expect(types).toContain('context_composition');
    // 重试事实完整：尝试序号、退避与错误码可从 trace 还原。
    const retry = events.find(event => event.type === 'request_retry')!;
    expect(retry).toMatchObject({attempt: 1, delayMs: 1, errorCode: 'rate_limit'});
    // 请求载荷可重建：第一次请求只含一条用户消息。
    const prepared = events.find(event => event.type === 'request_prepared')! as {items: unknown[]};
    expect(prepared.items).toHaveLength(1);
    // 模型共被调用两次：1 次失败 + 1 次成功。
    expect(client.requests).toHaveLength(2);
    expect(tap.recentDebugEntries().at(-1)?.text).toContain('run 结束');
  });
});

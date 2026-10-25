import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentTraceTap} from '../../../src/trace/tap.js';
import {TraceWriter} from '../../../src/trace/writer.js';
import type {AgentEvent} from '../../../src/agent/types.js';
import type {CollectedIteration} from '../../../src/agent/types.js';
import type {PreparedToolCall, ToolExecutionResult} from '../../../src/tools/types.js';
import type {StreamEvent} from '../../../src/providers/types.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function availableCall(name: string, argsText: string): PreparedToolCall {
  return {availability: 'available', call: {internalId: 'c1', providerCallId: 'p1', position: 0, name, arguments: {name: 'demo'}, effect: 'read'}, argumentsText: argsText};
}

function iteration(calls: PreparedToolCall[]): CollectedIteration {
  return {iterationId: 'it1', iteration: 1, text: '回复', thinking: '', usage: {inputTokens: 100, outputTokens: 5}, finishReason: 'tool_calls', providerState: null, calls, error: null, cancelled: false};
}

function readEvents(directory: string, sessionId = 's1'): Array<Record<string, unknown>> {
  return readFileSync(join(directory, `${sessionId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('AgentTraceTap', () => {
  it('request_prepared 与 iteration_finished 投影为请求/响应/组成三类事件', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-tap-')); directories.push(directory);
    const tap = new AgentTraceTap(new TraceWriter(directory), {profileName: 'p', model: 'm', protocol: 'anthropic', workspaceRoot: '/tmp'});
    tap.runHeader('s1', 'r1', 'execute', 'message');
    tap.record({v: 1, at: 2, runId: 'r1', sessionId: 's1', type: 'request_prepared', iterationId: 'it1', iteration: 1, items: [{type: 'message', messageId: 'u1', role: 'user', content: '任务'}], system: [{text: 'sys', cacheable: true, sectionId: 'fixed_system'}], toolDefinitions: [], toolDefinitionDigest: 'd1'} as AgentEvent);
    tap.record({v: 1, at: 12, runId: 'r1', sessionId: 's1', type: 'iteration_finished', iterationId: 'it1', iteration: 1, response: iteration([])} as AgentEvent);
    await tap.flush();
    const events = readEvents(directory);
    expect(events.map(event => event.type)).toEqual(['run_header', 'request_prepared', 'response', 'context_composition']);
    const composition = events[3]! as {estimatedTotal: number; providerInputTokens: number; buckets: Record<string, number>};
    expect(composition.estimatedTotal).toEqual(expect.any(Number));
    expect(composition.providerInputTokens).toBe(100);
    expect(composition.buckets.user_messages).toBeGreaterThan(0);
    const response = events[2]!;
    expect(response.durationMs).toBe(10);
  });

  it('load_skill 成功触发 skill_activated 事实与回调', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-tap-')); directories.push(directory);
    const activated: string[] = [];
    const tap = new AgentTraceTap(new TraceWriter(directory), {profileName: 'p', model: 'm', protocol: 'anthropic', workspaceRoot: '/tmp', onSkillActivated: name => activated.push(name)});
    tap.record({v: 1, at: 2, runId: 'r1', sessionId: 's1', type: 'tool_call_ready', iterationId: 'it1', call: availableCall('load_skill', '{"name":"demo"}')} as AgentEvent);
    const result: ToolExecutionResult = {status: 'success', output: {name: 'demo'}};
    tap.record({v: 1, at: 3, runId: 'r1', sessionId: 's1', type: 'tool_result', iterationId: 'it1', callId: 'c1', result} as AgentEvent);
    await tap.flush();
    const events = readEvents(directory);
    expect(events[0]).toMatchObject({type: 'domain_fact', fact: 'skill_activated', data: {name: 'demo', source: 'model'}});
    expect(events[1]).toMatchObject({type: 'agent_event'});
    expect(activated).toEqual(['demo']);
  });

  it('审批决定落入 domain_fact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-tap-')); directories.push(directory);
    const tap = new AgentTraceTap(new TraceWriter(directory), {profileName: 'p', model: 'm', protocol: 'anthropic', workspaceRoot: '/tmp'});
    tap.record({v: 1, at: 2, runId: 'r1', sessionId: 's1', type: 'approval_resolved', iterationId: 'it1', callId: 'c9', prompt: {callId: 'c9', toolName: 'run_command', effect: 'command', argumentSummary: '', riskMessage: null}, decision: 'denied'} as AgentEvent);
    await tap.flush();
    expect(readEvents(directory)[0]).toMatchObject({type: 'domain_fact', fact: 'approval_resolved', data: {decision: 'denied'}});
  });

  it('run_finished 与其余事件包装为 agent_event 保序入流', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-tap-')); directories.push(directory);
    const tap = new AgentTraceTap(new TraceWriter(directory), {profileName: 'p', model: 'm', protocol: 'anthropic', workspaceRoot: '/tmp'});
    const streamEvent: StreamEvent = {type: 'text_delta', text: 'x'};
    tap.record({v: 1, at: 2, runId: 'r1', sessionId: 's1', type: 'iteration_started', iterationId: 'it1', iteration: 1} as AgentEvent);
    tap.record({v: 1, at: 3, runId: 'r1', sessionId: 's1', type: 'text_delta', iterationId: 'it1', delta: 'x', ...(streamEvent as object)} as AgentEvent);
    tap.record({v: 1, at: 4, runId: 'r1', sessionId: 's1', type: 'run_finished', result: {runId: 'r1', status: 'completed', stopReason: 'natural_completion', iterationCount: 1, usage: {inputTokens: 1, outputTokens: 1}, finalIterationId: 'it1'}} as AgentEvent);
    await tap.flush();
    const types = readEvents(directory).map(event => event.type);
    expect(types).toEqual(['agent_event', 'agent_event', 'agent_event']);
    expect(tap.recentDebugEntries().at(-1)?.text).toContain('run 结束');
  });
});

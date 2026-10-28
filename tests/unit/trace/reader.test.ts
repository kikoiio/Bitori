import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {groupByIteration, readTraceFile} from '../../../src/trace/reader.js';
import {renderTokenTrend, renderTraceShow} from '../../../src/trace/render.js';
import {exportTrace} from '../../../src/trace/export.js';
import type {TraceEvent} from '../../../src/trace/types.js';
import {readFileSync} from 'node:fs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function sampleEvents(): object[] {
  return [
    {v: 1, at: 1, sessionId: 's1', type: 'run_header', runId: 'r1', profileName: 'p', model: 'm', protocol: 'anthropic', mode: 'execute', trigger: 'message', workspaceRoot: '/w'},
    {v: 1, at: 2, sessionId: 's1', type: 'request_prepared', runId: 'r1', iterationId: 'it1', iteration: 1, items: [{type: 'message', messageId: 'u1', role: 'user', content: 'hi'}], system: [], toolDefinitions: [], toolDefinitionDigest: 'd'},
    {v: 1, at: 3, sessionId: 's1', type: 'request_retry', runId: 'r1', iterationId: 'it1', iteration: 1, attempt: 1, delayMs: 5, errorCode: 'rate_limit', errorMessage: '429'},
    {v: 1, at: 4, sessionId: 's1', type: 'context_composition', runId: 'r1', iterationId: 'it1', iteration: 1, buckets: {fixed_system: 10, environment: 0, custom_instructions: 0, skills: 0, long_term_memory: 0, tool_definitions: 0, user_messages: 5, assistant_messages: 0, tool_results: 0, reminders: 0, compact_summary: 0}, estimatedTotal: 15, providerInputTokens: 16, delta: -1},
    {v: 1, at: 5, sessionId: 's1', type: 'response', runId: 'r1', iterationId: 'it1', iteration: 1, text: 'done', thinking: '', toolCalls: [], usage: {inputTokens: 16, outputTokens: 2}, finishReason: 'stop', providerState: null, errorCode: null, errorMessage: null, durationMs: 100},
  ];
}

describe('trace reader/render/export', () => {
  it('读取 JSONL 并跳过损坏行', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-trace-read-')); directories.push(directory);
    const path = join(directory, 's1.jsonl');
    writeFileSync(path, `${JSON.stringify(sampleEvents()[0])}\n这不是JSON\n\n${JSON.stringify(sampleEvents()[1])}\n`);
    const {events, corruptLines} = readTraceFile(path);
    expect(events).toHaveLength(2);
    expect(corruptLines).toBe(1);
  });

  it('groupByIteration 聚合每轮的请求/重试/组成/响应', () => {
    const parsed = sampleEvents().map(line => JSON.parse(JSON.stringify(line)) as TraceEvent);
    const iterations = groupByIteration(parsed);
    expect(iterations).toHaveLength(1);
    expect(iterations[0]).toMatchObject({runId: 'r1', iteration: 1, iterationId: 'it1'});
    expect(iterations[0]!.retries).toHaveLength(1);
    expect(iterations[0]!.response?.text).toBe('done');
    expect(iterations[0]!.composition?.estimatedTotal).toBe(15);
  });

  it('同一会话不同 run 的相同轮次分别保留', () => {
    const first = sampleEvents().map(event => ({...event, runId: 'r1', iterationId: 'it1'})) as TraceEvent[];
    const second = first.map(event => ({...event, runId: 'r2', iterationId: 'it2', at: event.at + 10}));
    const iterations = groupByIteration([...first, ...second]);
    expect(iterations.map(item => [item.runId, item.iterationId])).toEqual([['r1', 'it1'], ['r2', 'it2']]);
  });

  it('renderTraceShow 输出头部、重试与组成行', () => {
    const parsed = sampleEvents().map(line => JSON.parse(JSON.stringify(line)) as TraceEvent);
    const text = renderTraceShow(parsed);
    expect(text).toContain('profile p');
    expect(text).toContain('重试 #1');
    expect(text).toContain('估算 15 vs 真实 16');
    expect(text).toContain('用户消息 5');
    const trend = renderTokenTrend(parsed);
    expect(trend).toContain('估算  真实  差值');
    expect(trend).toContain('15');
  });

  it('export 默认脱敏、raw 逐字保留', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-trace-export-')); directories.push(directory);
    const parsed = sampleEvents().map(line => JSON.parse(JSON.stringify(line)) as TraceEvent);
    parsed[0] = {...parsed[0]!, workspaceRoot: 'token sk-ant-0123456789x'} as TraceEvent;
    const out = join(directory, 'out.jsonl');
    const count = exportTrace(parsed, out, {redactor: text => text.replaceAll('sk-ant-0123456789x', '<redacted>')});
    expect(count).toBe(parsed.length);
    expect(readFileSync(out, 'utf8')).toContain('<redacted>');
    const rawOut = join(directory, 'raw.jsonl');
    exportTrace(parsed, rawOut, {raw: true});
    expect(readFileSync(rawOut, 'utf8')).toContain('sk-ant-0123456789x');
  });
});

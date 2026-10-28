import Anthropic from '@anthropic-ai/sdk';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {AnthropicClient} from '../../src/providers/anthropic.js';
import {anthropicReplayPayloadSchema} from '../../src/providers/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {AgentContext} from '../../src/agent/context.js';
import type {FinalMessageUpdate, ToolCallRecord} from '../../src/storage/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const workerUrl = new URL('../fixtures/anthropic-storage-worker.ts', import.meta.url);
const payload = anthropicReplayPayloadSchema.parse([
  {type: 'thinking', thinking: '读取文件', signature: 'signed+/='},
  {type: 'redacted_thinking', data: 'encrypted+/='},
  {type: 'text', text: '准备读取', citations: null},
  {type: 'tool_use', id: 'tool-1', name: 'read_file', input: {path: 'a.txt'}},
]);

describe('Anthropic 重放状态存储兼容', () => {
  it('SQLite 关闭重开后恢复工具历史、完整块及检查点，并生成继续请求', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-anthropic-')); roots.push(root);
    const path = join(root, 'session.db');
    const repo = new SessionRepository(path, workerUrl);
    await repo.initialize();
    const session = await repo.createSession('anthropic');
    await repo.beginAgentRun({runId: 'run', sessionId: session.id, displayText: '读取文件', mode: 'execute'});
    await repo.beginAgentIteration({messageId: 'a', runId: 'run', sessionId: session.id, iteration: 1});
    const update: FinalMessageUpdate = {content: '准备读取', thinking: '读取文件', status: 'completed', error: null, usage: null, providerState: {protocol: 'anthropic', payload}};
    const record: ToolCallRecord = {id: 'c1', sessionId: session.id, assistantMessageId: 'a', agentRunId: 'run', providerCallId: 'tool-1', position: 3, toolName: 'read_file', argumentsText: '{"path":"a.txt"}', arguments: {path: 'a.txt'}, approvalStatus: 'not_required', executionStatus: 'succeeded', result: {status: 'success', output: {content: '文件内容'}}, createdAt: 1, updatedAt: 1};
    await repo.finalizeIterationWithToolBatch('a', update, [record]);
    const conversation = await repo.getConversation(session.id);
    if (!conversation) throw new Error('会话未保存');
    const checkpointItems = [...AgentContext.fromConversation(conversation).items()];
    await repo.saveContextCheckpoint(session.id, {boundaryMessageId: 'a', items: checkpointItems});
    await repo.beginAgentIteration({messageId: 'a2', runId: 'run', sessionId: session.id, iteration: 2});
    await repo.finalizeMessage('a2', {...update, content: '完成', providerState: {protocol: 'anthropic', payload: [{type: 'text', text: '完成'}]}});
    await repo.finishAgentRun('run', {runId: 'run', status: 'completed', stopReason: 'natural_completion', iterationCount: 2, usage: {inputTokens: 1, outputTokens: 1}, finalIterationId: 'a2'});
    await repo.close();

    const reopened = new SessionRepository(path, workerUrl);
    try {
      await reopened.initialize();
      const restored = await reopened.getConversation(session.id);
      if (!restored) throw new Error('会话未恢复');
      expect(restored.messages.find(message => message.id === 'a')?.providerState).toEqual(update.providerState);
      expect(restored.checkpoint?.items).toEqual(checkpointItems);
      const items = [...AgentContext.fromConversation(restored).items()];
      items.push({type: 'message', messageId: 'next', role: 'user', content: '继续'});
      const requests: unknown[] = [];
      const sdk = new Anthropic({apiKey: 'test', fetch: async (_url, init) => {
        requests.push(parseRequestBody(init));
        return new Response([
          {type: 'message_start', message: {id: 'next', role: 'assistant', type: 'message', content: [], model: 'm', stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 0}}},
          {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 0}}, {type: 'message_stop'},
        ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
      }});
      const client = new AnthropicClient({name: 'test', protocol: 'anthropic', model: 'm', baseUrl: 'https://unused.invalid', apiKey: 'test', thinking: {type: 'manual', budgetTokens: 1024, maxTokens: 4096}}, sdk);
      for await (const event of client.streamChat({messages: [], items}, new AbortController().signal)) expect(event.type).not.toBe('error');
      expect(requests).toEqual([expect.objectContaining({messages: [
        {role: 'user', content: '读取文件'}, {role: 'assistant', content: payload},
        {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify(record.result), is_error: false}]},
        {role: 'assistant', content: [{type: 'text', text: '完成'}]}, {role: 'user', content: '继续'},
      ]})]);
    } finally { await reopened.close(); }
  });

  it('旧 Responses/null 状态可读，损坏的 Anthropic 状态降级为普通文本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-anthropic-legacy-')); roots.push(root);
    const path = join(root, 'session.db');
    const repo = new SessionRepository(path, workerUrl);
    await repo.initialize();
    const session = await repo.createSession('legacy');
    await repo.beginAgentRun({runId: 'run', sessionId: session.id, displayText: '问题', mode: 'execute'});
    for (const [index, state] of [null, {protocol: 'openai-responses' as const, payload: [{type: 'reasoning', encrypted_content: 'old'}]}, {protocol: 'anthropic' as const, payload}].entries()) {
      await repo.beginAgentIteration({messageId: `a${index}`, runId: 'run', sessionId: session.id, iteration: index + 1});
      await repo.finalizeMessage(`a${index}`, {content: '旧回答', thinking: '', status: 'completed', error: null, usage: null, providerState: state});
    }
    await repo.close();
    const db = new DatabaseSync(path);
    db.prepare('UPDATE messages SET provider_state=? WHERE id=?').run(JSON.stringify({protocol: 'anthropic', payload: [{type: 'thinking', thinking: '缺少签名'}]}), 'a2');
    db.close();
    const restored = new SessionRepository(path, workerUrl);
    try {
      await restored.initialize();
      expect((await restored.getMessages(session.id)).slice(1).map(message => message.providerState)).toEqual([null, {protocol: 'openai-responses', payload: [{type: 'reasoning', encrypted_content: 'old'}]}, null]);
    } finally { await restored.close(); }
  });
});

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('测试请求必须使用 JSON 字符串正文');
  return JSON.parse(init.body) as Record<string, unknown>;
}

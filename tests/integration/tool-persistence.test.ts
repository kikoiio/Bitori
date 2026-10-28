import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SessionRepository} from '../../src/storage/repository.js';
import type {ToolCallRecord} from '../../src/storage/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const update = {content: '准备读取', thinking: '', status: 'completed' as const, error: null, usage: null, providerState: null};
function toolRecord(sessionId: string, assistantMessageId: string, status: ToolCallRecord['executionStatus'], approval: ToolCallRecord['approvalStatus']): ToolCallRecord {
  return {id: `${status}-${approval}`, sessionId, assistantMessageId, providerCallId: 'provider-1', position: 0, toolName: 'read_file', arguments: {path: 'a'}, argumentsText: '{"path":"a"}', agentRunId: 'run', approvalStatus: approval, executionStatus: status, result: status === 'succeeded' ? {status: 'success', output: {content: 'x'}} : null, createdAt: 1, updatedAt: 1};
}
async function begin(repo: SessionRepository): Promise<{sessionId: string; messageId: string}> {
  await repo.initialize();
  const session = await repo.createSession('p');
  await repo.beginAgentRun({runId: 'run', sessionId: session.id, displayText: 'hi', mode: 'execute'});
  await repo.beginAgentIteration({messageId: 'iteration-1', runId: 'run', sessionId: session.id, iteration: 1});
  return {sessionId: session.id, messageId: 'iteration-1'};
}
function path(): string { const root = mkdtempSync(join(tmpdir(), 'bitori-persist-')); roots.push(root); return join(root, 'db.sqlite'); }

describe('工具持久化', () => {
  it('保存并恢复参数、决定、状态和结果', async () => {
    const databasePath = path(); const repo = new SessionRepository(databasePath); const {sessionId, messageId} = await begin(repo);
    const record = toolRecord(sessionId, messageId, 'succeeded', 'not_required');
    await repo.finalizeIterationWithToolBatch(messageId, update, [record]);
    expect((await repo.getConversation(sessionId))?.toolCalls[0]).toEqual(record);
    await repo.close(); const restored = new SessionRepository(databasePath); await restored.initialize();
    expect((await restored.getConversation(sessionId))?.toolCalls[0]).toEqual(record); await restored.close();
  });
  it.each([['queued', 'pending'], ['running', 'approved']] as const)('重启将非终态 %s/%s 闭合为 interrupted', async (status, approval) => {
    const databasePath = path(); const repo = new SessionRepository(databasePath); const {sessionId, messageId} = await begin(repo);
    await repo.finalizeIterationWithToolBatch(messageId, update, [toolRecord(sessionId, messageId, status, approval)]);
    await repo.close(); const restored = new SessionRepository(databasePath); await restored.initialize();
    expect((await restored.getConversation(sessionId))?.toolCalls[0]).toMatchObject({executionStatus: 'interrupted', result: {status: 'interrupted'}}); await restored.close();
  });
  it('迭代终态与工具批次原子提交，失败时全部回滚', async () => {
    const repo = new SessionRepository(path()); const {sessionId, messageId} = await begin(repo);
    const valid = toolRecord(sessionId, messageId, 'queued', 'not_required');
    const invalid = {...valid, id: 'invalid', assistantMessageId: 'missing'};
    await expect(repo.finalizeIterationWithToolBatch(messageId, update, [valid, invalid])).rejects.toThrow();
    expect((await repo.getMessages(sessionId)).at(-1)?.status).toBe('streaming');
    expect((await repo.getConversation(sessionId))?.toolCalls).toEqual([]);
    await repo.finalizeIterationWithToolBatch(messageId, update, [valid]);
    const continuation = await repo.beginAgentIteration({messageId: 'iteration-2', runId: 'run', sessionId, iteration: 2});
    expect((await repo.getMessages(sessionId)).slice(-2).map(message => message.status)).toEqual(['completed', 'streaming']);
    expect(continuation).toMatchObject({role: 'assistant', agentRunId: 'run', iteration: 2}); await repo.close();
  });
});

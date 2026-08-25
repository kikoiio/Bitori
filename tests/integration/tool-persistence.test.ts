import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SessionRepository} from '../../src/storage/repository.js';
import type {ToolCallRecord} from '../../src/storage/types.js';

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function toolRecord(sessionId: string, assistantMessageId: string, status: ToolCallRecord['executionStatus'], approval: ToolCallRecord['approvalStatus']): ToolCallRecord { return {id: `${status}-${approval}`, sessionId, assistantMessageId, providerCallId: 'provider-1', position: 0, toolName: 'read_file', arguments: {path: 'a'}, argumentsText: '{"path":"a"}', agentRunId: null, approvalStatus: approval, executionStatus: status, result: status === 'succeeded' ? {status: 'success', output: {content: 'x'}} : null, createdAt: 1, updatedAt: 1}; }
describe('工具持久化', () => {
  it('保存并恢复参数、决定、状态和结果', async () => { const root = mkdtempSync(join(tmpdir(), 'mycode-persist-')); roots.push(root); const path = join(root, 'db.sqlite'); const repo = new SessionRepository(path); await repo.initialize(); const session = await repo.createSession('p'); const turn = await repo.beginTurn(session.id, 'hi'); const record = toolRecord(session.id, turn.assistantMessage.id, 'succeeded', 'not_required'); await repo.saveToolBatch([record]); expect((await repo.getConversation(session.id))?.toolCalls[0]).toEqual(record); await repo.close(); const restored = new SessionRepository(path); await restored.initialize(); expect((await restored.getConversation(session.id))?.toolCalls[0]).toEqual(record); await restored.close(); });
  it.each([['queued', 'pending'], ['running', 'approved'] ] as const)('重启将非终态 %s/%s 闭合为 interrupted', async (status, approval) => { const root = mkdtempSync(join(tmpdir(), 'mycode-persist-')); roots.push(root); const path = join(root, 'db.sqlite'); const repo = new SessionRepository(path); await repo.initialize(); const session = await repo.createSession('p'); const turn = await repo.beginTurn(session.id, 'hi'); await repo.saveToolBatch([toolRecord(session.id, turn.assistantMessage.id, status, approval)]); await repo.close(); const restored = new SessionRepository(path); await restored.initialize(); expect((await restored.getConversation(session.id))?.toolCalls[0]).toMatchObject({executionStatus: 'interrupted', result: {status: 'interrupted'}}); await restored.close(); });
  it('批次任一外键失败时全部回滚', async () => { const root = mkdtempSync(join(tmpdir(), 'mycode-persist-')); roots.push(root); const repo = new SessionRepository(join(root, 'db.sqlite')); await repo.initialize(); const session = await repo.createSession('p'); const turn = await repo.beginTurn(session.id, 'hi'); const valid = toolRecord(session.id, turn.assistantMessage.id, 'queued', 'not_required'); const invalid = {...valid, id: 'invalid', assistantMessageId: 'missing'}; await expect(repo.saveToolBatch([valid, invalid])).rejects.toThrow(); expect((await repo.getConversation(session.id))?.toolCalls).toEqual([]); await repo.close(); });
  it('首段 assistant 终态与工具批次原子提交，失败时两者一起回滚', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mycode-persist-')); roots.push(root); const repo = new SessionRepository(join(root, 'db.sqlite'));
    await repo.initialize(); const session = await repo.createSession('p'); const turn = await repo.beginTurn(session.id, 'hi');
    const update = {content: '准备读取', thinking: '', status: 'completed' as const, error: null, usage: null, providerState: null};
    const invalid = {...toolRecord(session.id, turn.assistantMessage.id, 'queued', 'not_required'), assistantMessageId: 'missing'};
    await expect(repo.finalizeAssistantWithToolBatch(turn.assistantMessage.id, update, [invalid])).rejects.toThrow();
    expect((await repo.getMessages(session.id)).at(-1)?.status).toBe('streaming');
    const valid = toolRecord(session.id, turn.assistantMessage.id, 'queued', 'not_required');
    await repo.finalizeAssistantWithToolBatch(turn.assistantMessage.id, update, [valid]);
    const continuation = await repo.beginAssistantContinuation(session.id);
    expect((await repo.getMessages(session.id)).slice(-2).map(message => message.status)).toEqual(['completed', 'streaming']);
    expect(continuation.role).toBe('assistant'); await repo.close();
  });
});

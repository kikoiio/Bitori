import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SessionRepository} from '../../src/storage/repository.js';

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
describe('Agent 中断恢复', () => {
  it('重复结束运行不会覆盖终态或会话计划指针', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-recovery-')); roots.push(root);
    const repository = new SessionRepository(join(root, 'db.sqlite')); await repository.initialize();
    try {
      const session = await repository.createSession('p');
      await repository.beginAgentRun({runId: 'run', sessionId: session.id, displayText: '任务', mode: 'plan'});
      await repository.beginAgentIteration({messageId: 'plan', runId: 'run', sessionId: session.id, iteration: 1});
      const result = {runId: 'run', status: 'completed', stopReason: 'natural_completion', iterationCount: 1, usage: {inputTokens: 1, outputTokens: 1}, finalIterationId: 'plan'} as const;
      await repository.finishAgentRun('run', result, 'plan');
      await repository.finishAgentRun('run', {...result, status: 'failed', stopReason: 'stream_error'}, 'missing');
      expect((await repository.getConversation(session.id))?.agentRuns[0]?.status).toBe('completed');
      expect((await repository.getSession(session.id))?.latestPlanMessageId).toBe('plan');
    } finally { await repository.close(); }
  });

  it('第二个仓库初始化不会中断第一个仓库的活动任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-recovery-')); roots.push(root); const path = join(root, 'db.sqlite');
    const first = new SessionRepository(path); await first.initialize(); const session = await first.createSession('p');
    await first.beginAgentRun({runId: 'active', sessionId: session.id, displayText: '任务', mode: 'execute'});
    await first.beginAgentIteration({messageId: 'active-iteration', runId: 'active', sessionId: session.id, iteration: 1});
    const observer = new SessionRepository(path); await observer.initialize(); await observer.listSessions('p');
    expect((await first.getConversation(session.id))?.agentRuns[0]?.status).toBe('running');
    expect((await first.getConversation(session.id))?.messages.find(message => message.id === 'active-iteration')?.status).toBe('streaming');
    await observer.close(); await first.close();
  });

  it('非终态统一中断且不自动续跑', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-recovery-')); roots.push(root); const path = join(root, 'db.sqlite');
    const repository = new SessionRepository(path); await repository.initialize(); const session = await repository.createSession('p');
    await repository.beginAgentRun({runId: 'run', sessionId: session.id, displayText: '任务', mode: 'execute'});
    await repository.beginAgentIteration({messageId: 'iteration', runId: 'run', sessionId: session.id, iteration: 1}); await repository.close();
    const restored = new SessionRepository(path); await restored.initialize(); const conversation = await restored.getConversation(session.id);
    expect(conversation?.agentRuns[0]).toMatchObject({status: 'interrupted', stopReason: 'process_interrupted'});
    expect(conversation?.messages.find(message => message.id === 'iteration')).toMatchObject({status: 'failed', errorMessage: '程序中断，Agent 未自动续跑'});
    await restored.close();
  });
});

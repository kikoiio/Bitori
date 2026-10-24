import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SessionRepository} from '../../src/storage/repository.js';

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
describe('Agent 中断恢复', () => {
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

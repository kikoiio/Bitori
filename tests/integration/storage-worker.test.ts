import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {initialMigration} from '../../src/storage/migrations/001-initial.js';
import {toolCallsMigration} from '../../src/storage/migrations/002-tool-calls.js';
import {SessionRepository} from '../../src/storage/repository.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

describe('Storage Worker', () => {
  it('持久化运行、thinking、usage 和状态', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-storage-'));
    roots.push(root);
    const path = join(root, 'bitori.db');
    const repository = new SessionRepository(path);
    await repository.initialize();
    const session = await repository.createSession('profile-a');
    await repository.beginAgentRun({runId: 'run', sessionId: session.id, displayText: '你好', mode: 'execute'});
    const assistant = await repository.beginAgentIteration({messageId: 'iteration', runId: 'run', sessionId: session.id, iteration: 1});
    await repository.checkpointAssistant(assistant.id, '部分', '思考');
    await repository.finalizeMessage(assistant.id, {
      content: '完整回答', thinking: '思考', status: 'completed', error: null,
      usage: {inputTokens: 2, outputTokens: 3},
      providerState: {protocol: 'openai-responses', payload: [{type: 'message'}]},
    });
    await repository.finishAgentRun('run', {runId: 'run', status: 'completed', stopReason: 'natural_completion', iterationCount: 1, usage: {inputTokens: 2, outputTokens: 3}, finalIterationId: 'iteration'});
    await repository.close();

    const reopened = new SessionRepository(path);
    await reopened.initialize();
    const messages = await reopened.getMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({content: '完整回答', thinking: '思考', status: 'completed', usage: {inputTokens: 2, outputTokens: 3}});
    expect((await reopened.findLatestSession('profile-a'))?.id).toBe(session.id);
    expect(await reopened.findLatestSession('profile-b')).toBeNull();
    await reopened.close();
  }, 20_000);
  it('旧版消息和工具记录升级后可读取，死进程遗留草稿仍可恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-legacy-')); roots.push(root);
    const path = join(root, 'legacy.db'); const database = new DatabaseSync(path);
    for (const migration of [initialMigration, toolCallsMigration]) {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(migration.version, 1);
    }
    database.exec(`INSERT INTO sessions VALUES('s','p','旧标题',1,1);
      INSERT INTO messages(id,session_id,role,content,thinking,status,created_at,updated_at) VALUES
        ('u','s','user','旧问题','','completed',1,1),
        ('a','s','assistant','旧回答','思考','completed',2,2),
        ('draft','s','assistant','部分','','streaming',3,3);
      INSERT INTO tool_calls(id,session_id,assistant_message_id,position,tool_name,arguments_json,approval_status,execution_status,created_at,updated_at)
        VALUES('t','s','draft',0,'read_file','{}','pending','queued',3,3)`);
    database.close();
    const first = new SessionRepository(path); await first.initialize();
    const old = await first.getConversation('s');
    expect(old?.messages.map(item => item.content)).toEqual(['旧问题', '旧回答', '部分']);
    expect(old?.messages[1]).toMatchObject({agentRunId: null, thinking: '思考'});
    expect(old?.toolCalls[0]).toMatchObject({agentRunId: null, arguments: {}});
    await first.close();
    const migrated = new DatabaseSync(path);
    migrated.prepare("UPDATE messages SET owner_pid=? WHERE id='draft'").run(2147483647);
    migrated.close();
    const restored = new SessionRepository(path); await restored.initialize();
    const recovered = await restored.getConversation('s');
    expect(recovered?.messages[2]).toMatchObject({status: 'failed', errorCode: 'stream_interrupted'});
    expect(recovered?.toolCalls[0]).toMatchObject({approvalStatus: 'denied', executionStatus: 'interrupted'});
    await restored.beginAgentRun({runId: 'new-run', sessionId: 's', displayText: '新问题', mode: 'execute'});
    expect((await restored.getSession('s'))?.title).toBe('旧标题');
    await restored.close();
  });

});

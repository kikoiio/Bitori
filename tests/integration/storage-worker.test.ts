import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SessionRepository} from '../../src/storage/repository.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

describe('Storage Worker', () => {
  it('持久化 turn、thinking、usage 和状态', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-storage-'));
    roots.push(root);
    const path = join(root, 'bitori.db');
    const repository = new SessionRepository(path);
    await repository.initialize();
    const session = await repository.createSession('profile-a');
    const turn = await repository.beginTurn(session.id, '你好');
    await repository.checkpointAssistant(turn.assistantMessage.id, '部分', '思考');
    await repository.finalizeMessage(turn.assistantMessage.id, {
      content: '完整回答', thinking: '思考', status: 'completed', error: null,
      usage: {inputTokens: 2, outputTokens: 3},
      providerState: {protocol: 'openai-responses', payload: [{type: 'message'}]},
    });
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
});

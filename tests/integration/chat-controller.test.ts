import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ChatController} from '../../src/chat/agent-controller.js';
import type {ProviderProfile} from '../../src/config/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {MockLLMClient} from '../helpers/mock-llm-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const profile: ProviderProfile = {
  name: 'test', protocol: 'openai-chat', model: 'model', baseUrl: 'https://example.com',
  apiKey: 'secret', thinking: {type: 'disabled'},
};

describe('ChatController', () => {
  it('流式更新、持久化并发送多轮上下文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-'));
    roots.push(root);
    const client = new MockLLMClient([
      {type: 'text_delta', text: '你'}, {type: 'text_delta', text: '好'},
      {type: 'usage', usage: {inputTokens: 2, outputTokens: 1}},
      {type: 'completed', finishReason: 'stop'},
    ]);
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')));
    await controller.initialize(profile);
    const snapshots: string[] = [];
    controller.subscribe(state => snapshots.push(state.messages.at(-1)?.content ?? ''));
    await controller.sendMessage('第一问');
    await controller.sendMessage('第二问');
    expect(snapshots).toContain('你');
    expect(controller.getState().messages.at(-1)).toMatchObject({content: '你好', status: 'completed'});
    /* [s01 旧断言，s03 替换] Provider 请求使用 messages 平铺历史。 */
    // [s04] ModelContextItem 新增 reminder 类型后，过滤条件改为显式列举含 content 的项类型。
    expect(client.requests[1]?.items?.filter(item => item.type === 'message' || item.type === 'assistant_iteration').map(item => item.content)).toEqual(['第一问', '你好', '第二问']);
    expect(controller.getState().latestUsage).toEqual({inputTokens: 2, outputTokens: 1});
    await controller.shutdown();
  }, 20_000);

  it('重启后恢复最近 Agent 回合的累计用量和停止原因', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-'));
    roots.push(root);
    const database = join(root, 'db.sqlite');
    const first = new ChatController(new MockLLMClient([
      {type: 'text_delta', text: '完成'},
      {type: 'usage', usage: {inputTokens: 13, outputTokens: 7}},
      {type: 'completed', finishReason: 'stop'},
    ]), new SessionRepository(database));
    await first.initialize(profile);
    await first.sendMessage('保存用量');
    expect(first.getState()).toMatchObject({runUsage: {inputTokens: 13, outputTokens: 7}, stopReason: 'natural_completion'});
    await first.shutdown();

    const restored = new ChatController(new MockLLMClient([]), new SessionRepository(database));
    await restored.initialize(profile);
    expect(restored.getState()).toMatchObject({
      latestUsage: {inputTokens: 13, outputTokens: 7},
      runUsage: {inputTokens: 13, outputTokens: 7},
      stopReason: 'natural_completion',
    });
    await restored.shutdown();
  }, 20_000);
});

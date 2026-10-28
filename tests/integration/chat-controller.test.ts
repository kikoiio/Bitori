import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAgentServices} from '../../src/agent/services.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';
import {ChatController} from '../../src/chat/agent-controller.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {MockLLMClient} from '../helpers/mock-llm-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const profile: ProviderProfile = {
  name: 'test', protocol: 'openai-chat', model: 'model', baseUrl: 'https://example.com',
  apiKey: 'secret', thinking: {type: 'disabled'},
};

describe('ChatController', () => {
  it('关闭 hook 抛错仍关闭仓储', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    const services = createAgentServices({workDir: root, hooks: []});
    const tools = createToolSystem(root, {}, {services});
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const close = vi.spyOn(repository, 'close');
    vi.spyOn(services.hooks, 'fire').mockImplementation(async event => { if (event === 'shutdown') throw new Error('hook failure'); return []; });
    const controller = new ChatController(new MockLLMClient([]), repository, tools, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await expect(controller.shutdown()).rejects.toThrow('hook failure');
    expect(close).toHaveBeenCalledOnce();
    tools.close();
  });

  for (const mode of ['manual', 'auto'] as const) {
    it(`${mode} 压缩在下一回合及重启后保持`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
      const database = join(root, 'db.sqlite');
      const requests: ChatRequest[] = [];
      const client: LLMClient = {async *streamChat(request): AsyncIterable<StreamEvent> {
        requests.push(request);
        const first = request.items?.[0];
        const isSummary = first?.type === 'message' && first.content.startsWith('请压缩以下对话');
        yield {type: 'text_delta', text: isSummary ? '<summary>持久摘要标记</summary>' : '回答'};
        yield {type: 'completed', finishReason: 'stop'};
      }};
      const selectedProfile = mode === 'auto' ? {...profile, contextWindow: 14_000} : profile;
      const controller = new ChatController(client, new SessionRepository(database), null, undefined, {workspaceRoot: root});
      await controller.initialize(selectedProfile);
      await controller.sendMessage('较早消息');
      await controller.sendMessage('第二问');
      await controller.sendMessage('第三问');
      await controller.sendMessage('长'.repeat(40_000));
      if (mode === 'manual') await controller.sendMessage('/compact');
      await controller.sendMessage('压缩后');
      const after = requests.at(-1)?.items ?? [];
      expect(after.some(item => item.type === 'message' && item.content.includes('持久摘要标记'))).toBe(true);
      expect(after.some(item => item.type === 'message' && item.content === '较早消息')).toBe(false);
      await controller.shutdown();
      const restored = new ChatController(client, new SessionRepository(database), null, undefined, {workspaceRoot: root});
      await restored.initialize(selectedProfile); await restored.sendMessage('重启后');
      const replay = requests.at(-1)?.items ?? [];
      expect(replay.some(item => item.type === 'message' && item.content.includes('持久摘要标记'))).toBe(true);
      expect(replay.some(item => item.type === 'message' && item.content === '较早消息')).toBe(false);
      expect(restored.getState().messages.some(message => message.content === '较早消息')).toBe(true);
      await restored.shutdown();
    }, 20_000);
  }

  it('工作区选项进入系统提示', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    const client = new MockLLMClient([{type: 'completed', finishReason: 'stop'}]);
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), null, undefined, {workspaceRoot: root});
    await controller.initialize(profile); await controller.sendMessage('检查');
    expect(client.requests[0]?.system?.map(block => block.text).join(' ')).toContain(root);
    await controller.shutdown();
  });

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
    // ModelContextItem 新增 reminder 类型后，过滤条件改为显式列举含 content 的项类型。
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

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ChatController} from '../../src/chat/controller.js';
import type {ProviderProfile} from '../../src/config/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';
import {MockLLMClient} from '../helpers/mock-llm-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const profile: ProviderProfile = {name: 'plan', protocol: 'openai-chat', model: 'm', baseUrl: 'https://example.com', apiKey: 'x', thinking: {type: 'disabled'}};

describe('Plan Mode', () => {
  it('进入 Plan、拦截越权、保存计划并执行最近计划', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-plan-')); roots.push(root);
    const client = new MockLLMClient([
      [{type: 'tool_call_start', internalId: 'w', providerCallId: 'pw', position: 0, name: 'write_file'}, {type: 'tool_call_arguments_delta', internalId: 'w', delta: '{"path":"no.txt","content":"no"}'}, {type: 'tool_call_end', internalId: 'w'}, {type: 'completed', finishReason: 'tool_calls'}],
      [{type: 'text_delta', text: '计划完成'}, {type: 'completed', finishReason: 'stop'}],
      [{type: 'text_delta', text: '执行完成'}, {type: 'completed', finishReason: 'stop'}],
    ]);
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile);
    await controller.sendMessage('/plan'); expect(client.requests).toHaveLength(0); expect(controller.getState().agentMode).toBe('plan');
    await controller.sendMessage('制定计划'); expect(client.requests[0]?.tools?.map(tool => tool.name)).toEqual(['read_file', 'find_files', 'search_text', 'load_skill']);
    expect(controller.getState().toolCalls[0]?.result).toMatchObject({status: 'error', error: {code: 'tool_unavailable_in_mode'}});
    expect(controller.getState().session?.latestPlanMessageId).not.toBeNull();
    await controller.sendMessage('/do'); expect(client.requests[2]?.tools).toHaveLength(10); expect(client.requests[2]?.items?.at(-1)).toMatchObject({type: 'message', content: '根据当前会话中的最近计划立即执行。'});
    expect(controller.getState().agentMode).toBe('execute'); await controller.shutdown();
  }, 20_000);
  it('没有计划时 /do 不请求模型', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-plan-')); roots.push(root); const client = new MockLLMClient([{type: 'completed', finishReason: 'stop'}]);
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile); await controller.sendMessage('/do');
    expect(client.requests).toHaveLength(0); expect(controller.getState().visibleError).toContain('没有可执行计划'); await controller.shutdown();
  });

  // [s04] Plan 提醒注入节奏：首轮完整、每隔 3 轮重复完整、其余精简。
  it('Plan 模式按轮次注入完整或精简提醒', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-plan-')); roots.push(root);
    const client = new MockLLMClient(Array.from({length: 5}, () => [{type: 'completed', finishReason: 'stop'}] as never));
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile);
    await controller.sendMessage('/plan');
    for (let turn = 1; turn <= 5; turn++) await controller.sendMessage(`任务${turn}`);
    expect(client.requests).toHaveLength(5);
    const kinds = client.requests.map(request => {
      const last = request.items?.at(-1);
      expect(last).toMatchObject({type: 'reminder'});
      return (last as {text: string}).text.includes('只能使用只读工具进行探索和分析') ? 'full' : 'compact';
    });
    expect(kinds).toEqual(['full', 'compact', 'compact', 'full', 'compact']);
    // [s04] 系统提示随控制器冻结并随每次请求发送。
    expect(client.requests[0]?.system?.[0]?.cacheable).toBe(true);
    expect(client.requests[0]?.system?.[0]?.text).toContain('# 身份');
    expect(client.requests[0]?.system?.[1]?.text).toContain('# 环境信息');
    // [s04] 提醒不进入界面消息列表。
    expect(controller.getState().messages.every(message => !message.content.includes('<system-reminder>'))).toBe(true);
    await controller.shutdown();
  }, 20_000);

  it('/do 停止注入，再次 /plan 重新计轮，重启后提醒不残留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-plan-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const client = new MockLLMClient([
      [{type: 'text_delta', text: '计划'}, {type: 'completed', finishReason: 'stop'}],
      [{type: 'text_delta', text: '执行'}, {type: 'completed', finishReason: 'stop'}],
      [{type: 'text_delta', text: '计划2'}, {type: 'completed', finishReason: 'stop'}],
    ]);
    const controller = new ChatController(client, new SessionRepository(database), createToolSystem(root)); await controller.initialize(profile);
    await controller.sendMessage('/plan'); await controller.sendMessage('任务1');
    expect(client.requests[0]?.items?.at(-1)).toMatchObject({type: 'reminder'});
    await controller.sendMessage('/do');
    expect(client.requests[1]?.items?.every(item => item.type !== 'reminder')).toBe(true);
    await controller.sendMessage('/plan'); await controller.sendMessage('任务2');
    const reentered = client.requests[2]?.items?.at(-1);
    expect(reentered).toMatchObject({type: 'reminder'});
    expect((reentered as {text: string}).text).toContain('只能使用只读工具进行探索和分析');
    await controller.shutdown();
    // [s04] 重启后持久化历史不含提醒；继续回合仍按轮次规则注入。
    const persisted = new ChatController(new MockLLMClient([[{type: 'completed', finishReason: 'stop'}]]), new SessionRepository(database), createToolSystem(root));
    await persisted.initialize(profile);
    expect(persisted.getState().messages.every(message => !message.content.includes('<system-reminder>'))).toBe(true);
    expect(persisted.getState().agentMode).toBe('plan');
    await persisted.shutdown();
  }, 20_000);
});

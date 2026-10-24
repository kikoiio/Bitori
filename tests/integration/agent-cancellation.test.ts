import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ChatController} from '../../src/chat/controller.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const profile: ProviderProfile = {name: 'cancel', protocol: 'openai-chat', model: 'm', baseUrl: 'https://example.com', apiKey: 'x', thinking: {type: 'disabled'}};
async function waitFor(check: () => boolean): Promise<void> { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('等待状态超时'); }

class CancellationClient implements LLMClient {
  requests = 0;
  async *streamChat(_request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests++;
    if (this.requests > 1) { yield {type: 'text_delta', text: '恢复成功'}; yield {type: 'completed', finishReason: 'stop'}; return; }
    yield {type: 'text_delta', text: '部分'};
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
  }
}

describe('Agent 取消', () => {
  it('模型流取消后保留部分内容且可发送新任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-cancel-')); roots.push(root); const client = new CancellationClient();
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile);
    const pending = controller.sendMessage('长回答'); await waitFor(() => controller.getState().messages.at(-1)?.content === '部分'); await controller.cancelActiveRequest(); await pending;
    expect(controller.getState().messages.at(-1)).toMatchObject({content: '部分', status: 'cancelled'}); expect(controller.getState().stopReason).toBe('user_cancelled');
    await controller.sendMessage('新任务'); expect(controller.getState().messages.at(-1)).toMatchObject({content: '恢复成功', status: 'completed'}); await controller.shutdown();
  }, 20_000);
  it('等待审批时取消不产生副作用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-cancel-')); roots.push(root);
    const client: LLMClient = {async *streamChat() { yield {type: 'tool_call_start', internalId: 'w', providerCallId: 'pw', position: 0, name: 'write_file'}; yield {type: 'tool_call_arguments_delta', internalId: 'w', delta: '{"path":"no.txt","content":"no"}'}; yield {type: 'tool_call_end', internalId: 'w'}; yield {type: 'completed', finishReason: 'tool_calls'}; }};
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile);
    const pending = controller.sendMessage('写入'); await waitFor(() => controller.getState().approvalPrompt !== null); await controller.cancelActiveRequest(); await pending;
    expect(controller.getState().toolCalls[0]).toMatchObject({executionStatus: 'interrupted', result: {status: 'interrupted'}}); await controller.shutdown();
  }, 20_000);
});

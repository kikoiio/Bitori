import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ChatController} from '../../src/chat/agent-controller.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';

class TwoPhaseClient implements LLMClient {
  readonly requests: ChatRequest[] = [];
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    if (request.items?.at(-1)?.type === 'tool_results') { yield {type: 'text_delta', text: '已读取并总结'}; yield {type: 'completed', finishReason: 'stop'}; return; }
    yield {type: 'tool_call_start', internalId: 'call-1', providerCallId: 'provider-1', position: 0, name: 'read_file'};
    yield {type: 'tool_call_arguments_delta', internalId: 'call-1', delta: '{"path":"note.txt"}'};
    yield {type: 'tool_call_end', internalId: 'call-1'};
    yield {type: 'completed', finishReason: 'tool_calls'};
  }
}
class MixedBatchClient implements LLMClient {
  readonly requests: ChatRequest[] = [];
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) { yield {type: 'text_delta', text: '批次完成'}; yield {type: 'completed', finishReason: 'stop'}; return; }
    const calls = [
      {id: 'create', provider: 'pc', position: 0, name: 'write_file', args: {path: 'created.txt', content: 'created'}},
      {id: 'edit', provider: 'pe', position: 1, name: 'edit_file', args: {path: 'existing.txt', oldText: 'old', newText: 'new'}},
      {id: 'command', provider: 'pr', position: 2, name: 'run_command', args: {command: process.platform === 'win32' ? `Write-Output 'verified'` : `printf 'verified'`}},
    ];
    for (const call of calls) { yield {type: 'tool_call_start', internalId: call.id, providerCallId: call.provider, position: call.position, name: call.name}; yield {type: 'tool_call_arguments_delta', internalId: call.id, delta: JSON.stringify(call.args)}; yield {type: 'tool_call_end', internalId: call.id}; }
    yield {type: 'completed', finishReason: 'tool_calls'};
  }
}
class SecondBatchClient implements LLMClient {
  readonly requests: ChatRequest[] = [];
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> { this.requests.push(request); if (this.requests.length === 1) { yield {type: 'tool_call_start', internalId: 'read', providerCallId: 'p1', position: 0, name: 'read_file'}; yield {type: 'tool_call_arguments_delta', internalId: 'read', delta: '{"path":"note.txt"}'}; yield {type: 'tool_call_end', internalId: 'read'}; yield {type: 'completed', finishReason: 'tool_calls'}; } else if (this.requests.length === 2) { yield {type: 'tool_call_start', internalId: 'blocked', providerCallId: 'p2', position: 0, name: 'write_file'}; yield {type: 'tool_call_arguments_delta', internalId: 'blocked', delta: '{"path":"blocked.txt","content":"no"}'}; yield {type: 'tool_call_end', internalId: 'blocked'}; yield {type: 'completed', finishReason: 'tool_calls'}; } else { yield {type: 'text_delta', text: '已根据拒绝调整'}; yield {type: 'completed', finishReason: 'stop'}; } }
}
async function waitForApproval(controller: ChatController, toolName: string): Promise<void> { for (let index = 0; index < 100; index++) { if (controller.getState().approvalPrompt?.toolName === toolName) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`未等到审批：${toolName}`); }

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const profile: ProviderProfile = {name: 'tools', protocol: 'openai-chat', model: 'm', baseUrl: 'https://example.com', apiKey: 'test', thinking: {type: 'disabled'}};

describe('Agent 工具回合', () => {
  it('执行只读工具、持久化并自动续跑到自然完成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-tool-turn-')); roots.push(root); writeFileSync(join(root, 'note.txt'), '中文内容', 'utf8');
    const client = new TwoPhaseClient(); const repository = new SessionRepository(join(root, 'db.sqlite'));
    const controller = new ChatController(client, repository, createToolSystem(root));
    await controller.initialize(profile); await controller.sendMessage('读取 note.txt');
    expect(client.requests).toHaveLength(2); expect(client.requests[0]?.tools).toHaveLength(10); expect(client.requests[1]?.tools).toHaveLength(10); expect(client.requests[1]?.items?.find(item => item.type === 'tool_results')).toMatchObject({results: [{providerCallId: 'provider-1', name: 'read_file', result: {status: 'success'}}]});
    expect(controller.getState().toolCalls[0]).toMatchObject({toolName: 'read_file', executionStatus: 'succeeded', result: {status: 'success'}});
    expect(controller.getState().messages.at(-1)).toMatchObject({content: '已读取并总结', status: 'completed'});
    expect(controller.getState().messages.map(message => [message.role, message.status])).toEqual([['user', 'completed'], ['assistant', 'completed'], ['assistant', 'completed']]);
    expect(client.requests[1]?.items?.find(item => item.type === 'assistant_iteration')).toMatchObject({messageId: controller.getState().messages[1]?.id});
    const sessionId = controller.getState().session!.id; await controller.shutdown();
    const restored = new SessionRepository(join(root, 'db.sqlite')); await restored.initialize(); expect((await restored.getConversation(sessionId))?.toolCalls[0]?.executionStatus).toBe('succeeded'); await restored.close();
  }, 20_000);

  it('连续工具回合的内部 ID 重复时仍能持久化（回归：UNIQUE 约束崩溃）', async () => {
    // 真实供应商每条流的 internalId 都从 0 重新开始；TwoPhaseClient 每回合都发同一个 'call-1' 正好复现。
    const root = mkdtempSync(join(tmpdir(), 'bitori-tool-turn-')); roots.push(root); writeFileSync(join(root, 'note.txt'), '中文内容', 'utf8');
    const client = new TwoPhaseClient(); const repository = new SessionRepository(join(root, 'db.sqlite'));
    const controller = new ChatController(client, repository, createToolSystem(root));
    await controller.initialize(profile);
    await controller.sendMessage('第一次读取'); await controller.sendMessage('再读一次');
    const records = controller.getState().toolCalls;
    expect(records).toHaveLength(2); expect(new Set(records.map(record => record.id)).size).toBe(2);
    expect(records.every(record => record.executionStatus === 'succeeded')).toBe(true);
    expect(client.requests[2]?.items?.filter(item => item.type === 'tool_results')).toHaveLength(1);
    const sessionId = controller.getState().session!.id; await controller.shutdown();
    const restored = new SessionRepository(join(root, 'db.sqlite')); await restored.initialize();
    expect((await restored.getConversation(sessionId))?.toolCalls).toHaveLength(2); await restored.close();
  }, 20_000);

  it('同批逐项批准/拒绝，仅批准项产生副作用并共同回灌', async () => { const root = mkdtempSync(join(tmpdir(), 'bitori-tool-turn-')); roots.push(root); writeFileSync(join(root, 'existing.txt'), 'old', 'utf8'); const client = new MixedBatchClient(); const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile); const pending = controller.sendMessage('执行批次'); await waitForApproval(controller, 'write_file'); controller.resolveToolApproval('approved'); await waitForApproval(controller, 'edit_file'); controller.resolveToolApproval('denied'); await waitForApproval(controller, 'run_command'); controller.resolveToolApproval('approved'); await pending; expect(existsSync(join(root, 'created.txt'))).toBe(true); expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('old'); expect(controller.getState().toolCalls.map(record => [record.toolName, record.approvalStatus, record.executionStatus])).toEqual([['write_file', 'approved', 'succeeded'], ['edit_file', 'denied', 'skipped'], ['run_command', 'approved', 'succeeded']]); expect(client.requests).toHaveLength(2); const resultItem = client.requests[1]?.items?.find(item => item.type === 'tool_results'); expect(resultItem?.type === 'tool_results' && resultItem.results.some(entry => entry.result.status === 'denied')).toBe(true); await controller.shutdown(); }, 20_000);

  it('第二批工具仍按结果调整并继续到第三次自然完成', async () => { const root = mkdtempSync(join(tmpdir(), 'bitori-tool-turn-')); roots.push(root); writeFileSync(join(root, 'note.txt'), 'x'); const client = new SecondBatchClient(); const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), createToolSystem(root)); await controller.initialize(profile); const pending = controller.sendMessage('触发第二批'); await waitForApproval(controller, 'write_file'); controller.resolveToolApproval('denied'); await pending; expect(client.requests).toHaveLength(3); expect(existsSync(join(root, 'blocked.txt'))).toBe(false); expect(controller.getState().approvalPrompt).toBeNull(); expect(controller.getState().messages.at(-1)).toMatchObject({content: '已根据拒绝调整', status: 'completed'}); await controller.shutdown(); }, 20_000);
});

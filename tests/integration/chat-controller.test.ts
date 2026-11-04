import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAgentServices} from '../../src/agent/services.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';
import {ChatController} from '../../src/chat/agent-controller.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {createSessionArchive, parseSessionArchive} from '../../src/storage/archive.js';
import {MockLLMClient} from '../helpers/mock-llm-client.js';
import type {ImageAttachment} from '../../src/attachments/images.js';
import type {FinalMessageUpdate, StoredConversation, ToolCallRecord} from '../../src/storage/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const profile: ProviderProfile = {
  name: 'test', protocol: 'openai-chat', model: 'model', baseUrl: 'https://example.com',
  apiKey: 'secret', thinking: {type: 'disabled'},
};
const sampleImage = {name: 'diagram.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='} satisfies ImageAttachment;

async function seedInterruptedRun(database: string, tool: 'completed_read' | 'uncertain_command' | 'timed_out_command' | 'failed_command') {
  const repository = new SessionRepository(database);
  await repository.initialize();
  try {
    const session = await repository.createSession(profile.name);
    const runId = `interrupted-${tool}`;
    const begun = await repository.beginAgentRun({runId, sessionId: session.id, displayText: '继续原任务', instruction: '继续原任务', mode: 'execute'});
    const iteration = await repository.beginAgentIteration({messageId: `${runId}-iteration-1`, runId, sessionId: session.id, iteration: 1});
    const completedRead = tool === 'completed_read';
    const timestamp = Date.now();
    const call: ToolCallRecord = {
      id: `${runId}-tool`, sessionId: session.id, assistantMessageId: iteration.id, providerCallId: `${runId}-provider-tool`, position: 0,
      toolName: completedRead ? 'read_file' : 'run_command',
      arguments: completedRead ? {path: 'note.txt'} : {command: 'touch uncertain.txt'},
      argumentsText: completedRead ? '{"path":"note.txt"}' : '{"command":"touch uncertain.txt"}',
      agentRunId: runId, approvalStatus: completedRead ? 'not_required' : 'approved',
      executionStatus: completedRead ? 'succeeded' : tool === 'timed_out_command' ? 'timed_out' : tool === 'failed_command' ? 'failed' : 'running',
      result: completedRead ? {status: 'success', output: {content: 'persisted tool output'}} : tool === 'timed_out_command' ? {status: 'timeout', error: {code: 'timeout', message: '命令超时，可能已产生副作用', retryable: false}} : tool === 'failed_command' ? {status: 'error', error: {code: 'command_failed', message: '命令失败，可能已产生副作用', retryable: false}} : null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const update: FinalMessageUpdate = {content: '工具调用已发出', thinking: '', status: 'completed', error: null, usage: {inputTokens: 0, outputTokens: 0, credits: 1.25}, providerState: null};
    await repository.finalizeIterationWithToolBatch(iteration.id, update, [call]);
    await repository.checkpointAgentRun(runId, 1, {inputTokens: 0, outputTokens: 0, credits: 1.25});
    return {sessionId: session.id, userMessageId: begun.userMessage.id, runId};
  } finally { await repository.close(); }
}

async function seedIncompleteIteration(database: string, persistStreamingMessage: boolean) {
  const repository = new SessionRepository(database);
  await repository.initialize();
  try {
    const session = await repository.createSession(profile.name);
    const runId = `interrupted-incomplete-${persistStreamingMessage ? 'message' : 'before-message'}`;
    const begun = await repository.beginAgentRun({runId, sessionId: session.id, displayText: '继续原任务', instruction: '继续原任务', mode: 'execute'});
    await repository.checkpointAgentRun(runId, 1, {inputTokens: 4, outputTokens: 2});
    if (persistStreamingMessage) await repository.beginAgentIteration({messageId: `${runId}-iteration-1`, runId, sessionId: session.id, iteration: 1});
    return {sessionId: session.id, userMessageId: begun.userMessage.id, runId};
  } finally { await repository.close(); }
}

async function seedFinalResponseBeforeRunFinish(database: string, addSteerMessage: boolean) {
  const repository = new SessionRepository(database);
  await repository.initialize();
  try {
    const session = await repository.createSession(profile.name);
    const runId = `interrupted-final-response-${addSteerMessage ? 'with-steer' : 'alone'}`;
    const begun = await repository.beginAgentRun({runId, sessionId: session.id, displayText: '完成原任务', instruction: '完成原任务', mode: 'execute'});
    const iteration = await repository.beginAgentIteration({messageId: `${runId}-iteration-1`, runId, sessionId: session.id, iteration: 1});
    await repository.finalizeIterationWithToolBatch(iteration.id, {content: '任务已经完成', thinking: '', status: 'completed', error: null, usage: {inputTokens: 8, outputTokens: 3}, providerState: null}, []);
    await repository.checkpointAgentRun(runId, 1, {inputTokens: 8, outputTokens: 3});
    if (addSteerMessage) await repository.appendSteerMessage({runId, sessionId: session.id, content: '再检查一项'});
    return {sessionId: session.id, userMessageId: begun.userMessage.id, runId};
  } finally { await repository.close(); }
}

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
    await tools.close();
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
      const afterIds = after.flatMap(item => item.type === 'message' || item.type === 'assistant_iteration' ? [item.messageId] : []);
      expect(afterIds.length).toBe(new Set(afterIds).size);
      await controller.shutdown();
      const restored = new ChatController(client, new SessionRepository(database), null, undefined, {workspaceRoot: root});
      await restored.initialize(selectedProfile); await restored.sendMessage('重启后');
      const replay = requests.at(-1)?.items ?? [];
      expect(replay.some(item => item.type === 'message' && item.content.includes('持久摘要标记'))).toBe(true);
      expect(replay.some(item => item.type === 'message' && item.content === '较早消息')).toBe(false);
      const replayIds = replay.flatMap(item => item.type === 'message' || item.type === 'assistant_iteration' ? [item.messageId] : []);
      expect(replayIds.length).toBe(new Set(replayIds).size);
      expect(restored.getState().messages.some(message => message.content === '较早消息')).toBe(true);
      await restored.shutdown();
    }, 20_000);
  }

  it('自定义命令展开正文进入请求，原始命令保留为显示消息', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    mkdirSync(join(root, '.bitori', 'commands'), {recursive: true});
    writeFileSync(join(root, '.bitori', 'commands', 'explain.md'), '解释 $ARGUMENTS 并说明调用者');
    const client = new MockLLMClient([{type: 'completed', finishReason: 'stop'}]);
    const database = join(root, 'db.sqlite');
    const workerUrl = new URL('../fixtures/anthropic-storage-worker.ts', import.meta.url);
    const services = createAgentServices({workDir: root, hooks: [], projectTrusted: true});
    const tools = createToolSystem(root, {}, {services});
    const controller = new ChatController(client, new SessionRepository(database, workerUrl), tools, undefined, {workspaceRoot: root});
    try {
      await controller.initialize(profile);
      await controller.sendMessage('/explain\t  note.ts');
      expect(client.requests[0]?.items).toContainEqual(expect.objectContaining({type: 'message', role: 'user', content: '解释 note.ts 并说明调用者'}));
      expect(controller.getState().messages[0]?.content).toBe('解释 note.ts 并说明调用者');
      expect(controller.getState().messages[0]?.displayContent).toBe('/explain\t  note.ts');
      await controller.shutdown();
      await tools.close();
      const restored = new ChatController(client, new SessionRepository(database, workerUrl), null, undefined, {workspaceRoot: root});
      await restored.initialize(profile);
      await restored.sendMessage('继续');
      expect(client.requests.at(-1)?.items).toContainEqual(expect.objectContaining({type: 'message', role: 'user', content: '解释 note.ts 并说明调用者'}));
      await restored.shutdown();
    } finally { await controller.shutdown().catch(() => undefined); }
  });

  it('兼容旧检查点中已保存的保留尾部，不重复回放', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    const client = new MockLLMClient([{type: 'text_delta', text: '旧回答'}, {type: 'completed', finishReason: 'stop'}]);
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    try {
      await controller.initialize(profile); await controller.sendMessage('旧问题');
      const state = controller.getState();
      await repository.saveContextCheckpoint(state.session!.id, {boundaryMessageId: state.messages[0]!.id, items: [
        {type: 'message', messageId: 'compact-summary', role: 'user', content: '旧摘要'},
        {type: 'message', messageId: state.messages[1]!.id, role: 'assistant', content: '旧回答'},
      ]});
      await controller.sendMessage('新问题');
      const items = client.requests.at(-1)?.items ?? [];
      expect(items.filter(item => item.type === 'message' && item.content === '旧回答')).toHaveLength(1);
      expect(items.some(item => item.type === 'message' && item.content === '旧摘要')).toBe(true);
    } finally { await controller.shutdown(); }
  });

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

  it('生成中发送的新消息在同一回合的下一个边界注入模型', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    writeFileSync(join(root, 'note.txt'), 'ok');
    const requests: ChatRequest[] = [];
    let controller: ChatController | null = null;
    let queuedDuringRun: string[] = [];
    const client: LLMClient = {async *streamChat(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield {type: 'tool_call_start', internalId: 'c1', providerCallId: 'p1', position: 0, name: 'read_file'};
        yield {type: 'tool_call_arguments_delta', internalId: 'c1', delta: '{"path":"note.txt"}'};
        yield {type: 'tool_call_end', internalId: 'c1'};
        yield {type: 'completed', finishReason: 'tool_calls'};
        // 工具执行期间用户排队一条新消息：界面立刻看到“已排队”。
        void controller!.steerMessage('顺便把 README 也改了');
        queuedDuringRun = controller!.getState().queuedMessages;
        return;
      }
      yield {type: 'text_delta', text: '好的'};
      yield {type: 'completed', finishReason: 'stop'};
    }};
    const tools = createToolSystem(root);
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    controller = new ChatController(client, repository, tools, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.sendMessage('先读一下 note.txt');
    expect(queuedDuringRun).toEqual(['顺便把 README 也改了']);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.items?.some(item => item.type === 'message' && item.content === '顺便把 README 也改了')).toBe(true);
    expect(controller.getState().queuedMessages).toEqual([]);
    const sessionId = controller.getState().session?.id ?? '';
    expect((await repository.getConversation(sessionId))?.messages.map(item => item.content)).toContain('顺便把 README 也改了');
    await controller.shutdown();
    await tools.close();
  }, 20_000);

  it('回合先结束时，排队消息作为下一回合发出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    const requests: ChatRequest[] = [];
    let controller: ChatController | null = null;
    const client: LLMClient = {async *streamChat(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield {type: 'text_delta', text: '第一轮回答'};
        yield {type: 'completed', finishReason: 'stop'};
        void controller!.steerMessage('接着做第二件事');
        return;
      }
      yield {type: 'text_delta', text: '第二轮回答'};
      yield {type: 'completed', finishReason: 'stop'};
    }};
    controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.sendMessage('第一件事');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.items?.some(item => item.type === 'message' && item.content === '接着做第二件事')).toBe(true);
    expect(controller.getState().queuedMessages).toEqual([]);
    await controller.shutdown();
  }, 20_000);

  it('空闲时发送新消息直接开始回合', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-')); roots.push(root);
    const requests: ChatRequest[] = [];
    const client: LLMClient = {async *streamChat(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      yield {type: 'text_delta', text: '好的'};
      yield {type: 'completed', finishReason: 'stop'};
    }};
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.steerMessage('直接开始');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.items?.some(item => item.type === 'message' && item.content === '直接开始')).toBe(true);
    await controller.shutdown();
  }, 20_000);

  it('初始化时自动恢复安全中断 run，沿用原 run 和 user message，并保留已完成工具结果', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-recovery-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const seeded = await seedInterruptedRun(database, 'completed_read');
    const client = new MockLLMClient([[{type: 'text_delta', text: '已接续完成'}, {type: 'completed', finishReason: 'stop'}]]);
    const repository = new SessionRepository(database);
    const tools = createToolSystem(root);
    const execute = vi.spyOn(tools.executor, 'execute');
    const controller = new ChatController(client, repository, tools, undefined, {workspaceRoot: root, maxIterations: 3});
    await controller.initialize(profile);
    await vi.waitFor(async () => expect((await repository.getConversation(seeded.sessionId))?.agentRuns.at(-1)).toMatchObject({id: seeded.runId, status: 'completed'}));

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.items?.some(item => item.type === 'tool_results' && item.results.some(result => result.callId === `${seeded.runId}-tool` && result.result.status === 'success' && result.result.output.content === 'persisted tool output'))).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const conversation = await repository.getConversation(seeded.sessionId);
    expect(conversation?.agentRuns.at(-1)).toMatchObject({id: seeded.runId, status: 'completed', iterationCount: 2, inputTokens: 0, outputTokens: 0, credits: 1.25, userMessageId: seeded.userMessageId});
    expect(conversation?.toolCalls.map(call => call.id)).toEqual([`${seeded.runId}-tool`]);
    expect(controller.getState().recovery).toBeNull();
    await controller.shutdown();
    await tools.close();
  }, 20_000);

  it.each([false, true])('中断在第一个模型轮次完成落盘前时重试同一轮（streaming message=%s）', async persistStreamingMessage => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-recovery-incomplete-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const seeded = await seedIncompleteIteration(database, persistStreamingMessage);
    const client = new MockLLMClient([[{type: 'text_delta', text: '已重试完成'}, {type: 'completed', finishReason: 'stop'}]]);
    const repository = new SessionRepository(database);
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root, maxIterations: 3});
    await controller.initialize(profile);
    await vi.waitFor(async () => expect((await repository.getConversation(seeded.sessionId))?.agentRuns.at(-1)).toMatchObject({id: seeded.runId, status: 'completed'}));

    const conversation = await repository.getConversation(seeded.sessionId);
    expect(client.requests).toHaveLength(1);
    expect(conversation?.agentRuns.at(-1)).toMatchObject({iterationCount: 1, inputTokens: 4, outputTokens: 2});
    expect(conversation?.messages.filter(message => message.role === 'assistant' && message.status === 'completed')).toHaveLength(1);
    await controller.shutdown();
  }, 20_000);

  it.each([false, true])('恢复时区分已完成的最终回答与后续排队消息（queued=%s）', async addSteerMessage => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-recovery-final-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const seeded = await seedFinalResponseBeforeRunFinish(database, addSteerMessage);
    const client = new MockLLMClient(addSteerMessage ? [[{type: 'text_delta', text: '补充完成'}, {type: 'completed', finishReason: 'stop'}]] : []);
    const repository = new SessionRepository(database);
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root, maxIterations: 3});
    await controller.initialize(profile);
    await vi.waitFor(async () => expect((await repository.getConversation(seeded.sessionId))?.agentRuns.at(-1)).toMatchObject({id: seeded.runId, status: 'completed'}));

    const conversation = await repository.getConversation(seeded.sessionId);
    expect(client.requests).toHaveLength(addSteerMessage ? 1 : 0);
    expect(conversation?.agentRuns.at(-1)).toMatchObject({iterationCount: addSteerMessage ? 2 : 1, inputTokens: 8, outputTokens: 3});
    if (addSteerMessage) expect(client.requests[0]?.items).toContainEqual(expect.objectContaining({type: 'message', role: 'user', content: '再检查一项'}));
    await controller.shutdown();
  }, 20_000);

  it.each(['switch', 'delete_current'] as const)('%s 激活有安全中断任务的会话后自动恢复', async action => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-recovery-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const seeded = await seedInterruptedRun(database, 'completed_read');
    const repository = new SessionRepository(database);
    await repository.initialize();
    const currentSession = await repository.createSession(profile.name);
    await repository.close();
    const client = new MockLLMClient([[{type: 'text_delta', text: '切换后已恢复'}, {type: 'completed', finishReason: 'stop'}]]);
    const resumedRepository = new SessionRepository(database);
    const controller = new ChatController(client, resumedRepository, null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    expect(controller.getState().session?.id).toBe(currentSession.id);
    if (action === 'delete_current') await controller.deleteSession(currentSession.id);
    else await controller.switchSession(seeded.sessionId);
    await vi.waitFor(async () => expect((await resumedRepository.getConversation(seeded.sessionId))?.agentRuns.at(-1)).toMatchObject({id: seeded.runId, status: 'completed'}));
    expect(client.requests).toHaveLength(1);
    await controller.shutdown();
  }, 20_000);

  it.each([
    {status: 'cancelled', stopReason: 'user_cancelled'},
    {status: 'stopped', stopReason: 'iteration_limit'},
    {status: 'failed', stopReason: 'stream_error'},
  ] as const)('$status 记录不会在重启时自动恢复', async terminal => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-terminal-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const original = new SessionRepository(database);
    await original.initialize();
    try {
      const session = await original.createSession(profile.name);
      await original.beginAgentRun({runId: 'terminal-run', sessionId: session.id, displayText: '已停止的任务', mode: 'execute'});
      await original.finishAgentRun('terminal-run', {runId: 'terminal-run', ...terminal, iterationCount: 1, usage: {inputTokens: 7, outputTokens: 3}, finalIterationId: null});
    } finally { await original.close(); }
    const client = new MockLLMClient([]);
    const repository = new SessionRepository(database);
    const claim = vi.spyOn(repository, 'claimInterruptedRun');
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    try {
      await controller.initialize(profile);
      expect(controller.getState().recovery).toBeNull();
      expect(controller.getState().stopReason).toBe(terminal.stopReason);
      expect(client.requests).toHaveLength(0);
      expect(claim).not.toHaveBeenCalled();
    } finally { await controller.shutdown(); }
  });

  it('迭代消息写入失败时，终态不能覆盖已持久化的轮次预算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-checkpoint-')); roots.push(root);
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    vi.spyOn(repository, 'beginAgentIteration').mockRejectedValueOnce(new Error('模拟迭代消息写入失败'));
    const client = new MockLLMClient([]);
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    try {
      await controller.initialize(profile);
      await controller.sendMessage('检查预算屏障');
      expect(controller.getState()).toMatchObject({iteration: 1, requestStatus: 'failed'});
      const sessionId = controller.getState().session?.id;
      expect(sessionId).toBeDefined();
      if (sessionId === undefined) throw new Error('缺少会话');
      expect((await repository.getConversation(sessionId))?.agentRuns.at(-1)).toMatchObject({status: 'failed', iterationCount: 1});
      expect(client.requests).toHaveLength(0);
    } finally { await controller.shutdown(); }
  });

  it('轮次开始、流式 usage 更新和轮次完成都会持久化累计预算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-checkpoint-')); roots.push(root);
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const checkpoint = vi.spyOn(repository, 'checkpointAgentRun');
    const client = new MockLLMClient([[{type: 'usage', usage: {inputTokens: 13, outputTokens: 5}}, {type: 'text_delta', text: '完成'}, {type: 'completed', finishReason: 'stop'}]]);
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.sendMessage('检查预算写入');

    expect(checkpoint).toHaveBeenCalledTimes(3);
    expect(checkpoint.mock.calls.map(([, iterationCount]) => iterationCount)).toEqual([1, 1, 1]);
    expect(checkpoint.mock.calls[0]?.[2]).toEqual({inputTokens: 0, outputTokens: 0});
    expect(checkpoint.mock.calls[1]?.[2]).toMatchObject({inputTokens: 13, outputTokens: 5});
    expect(checkpoint.mock.calls[2]?.[2]).toMatchObject({inputTokens: 13, outputTokens: 5});
    await controller.shutdown();
  }, 20_000);

  it.each(['uncertain_command', 'timed_out_command', 'failed_command'] as const)('%s 有不确定命令副作用时等待显式恢复确认，确认后只继续模型上下文', async tool => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-recovery-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const seeded = await seedInterruptedRun(database, tool);
    const client = new MockLLMClient([[{type: 'text_delta', text: '先检查当前状态'}, {type: 'completed', finishReason: 'stop'}]]);
    const repository = new SessionRepository(database);
    const claim = vi.spyOn(repository, 'claimInterruptedRun');
    const tools = createToolSystem(root);
    const execute = vi.spyOn(tools.executor, 'execute');
    const controller = new ChatController(client, repository, tools, undefined, {workspaceRoot: root});
    await controller.initialize(profile);

    expect(client.requests).toHaveLength(0);
    expect(controller.getState().recovery).toMatchObject({runId: seeded.runId, requiresConfirmation: true});
    await controller.resumeInterruptedRun();

    expect(claim).toHaveBeenCalledWith(seeded.runId, true);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.items?.some(item => item.type === 'tool_results' && item.results.some(result => result.callId === `${seeded.runId}-tool` && result.result.status === (tool === 'timed_out_command' ? 'timeout' : tool === 'failed_command' ? 'error' : 'interrupted')))).toBe(true);
    expect(client.requests[0]?.items?.some(item => item.type === 'reminder' && item.text.includes('旧调用不会自动重放'))).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(controller.getState().recovery).toBeNull();
    await controller.shutdown();
    await tools.close();
  }, 20_000);

  it('关闭自动恢复时展示待恢复状态，导入的中断副本不会恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-import-recovery-')); roots.push(root);
    const database = join(root, 'db.sqlite');
    const seeded = await seedInterruptedRun(database, 'completed_read');
    const client = new MockLLMClient([]);
    const repository = new SessionRepository(database);
    const claim = vi.spyOn(repository, 'claimInterruptedRun');
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root, autoResume: false});
    try {
      await controller.initialize(profile);
      expect(controller.getState().recovery).toMatchObject({runId: seeded.runId, requiresConfirmation: false, message: '检测到可恢复任务。'});
      const archived = parseSessionArchive(createSessionArchive(await controller.exportSession()));
      await controller.importSession(archived);
      expect(controller.getState().session?.id).not.toBe(seeded.sessionId);
      expect(controller.getState().recovery).toBeNull();
      expect(client.requests).toHaveLength(0);
      expect(claim).not.toHaveBeenCalled();
      const importedSessionId = controller.getState().session?.id;
      if (importedSessionId === undefined) throw new Error('缺少导入会话');
      expect((await repository.getConversation(importedSessionId))?.agentRuns.at(-1)?.status).toBe('stopped');
    } finally { await controller.shutdown(); }
  });

  it('纯图消息可创建 run 并将图片附件交给仓储', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-image-')); roots.push(root);
    const image = sampleImage;
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const begin = vi.spyOn(repository, 'beginAgentRun');
    const client = new MockLLMClient([[{type: 'text_delta', text: '看到了图片'}, {type: 'completed', finishReason: 'stop'}]]);
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.sendMessage('', [image]);

    expect(begin).toHaveBeenCalledWith(expect.objectContaining({attachments: [image]}));
    const message = controller.getState().messages.find(item => item.role === 'user');
    expect(message).toMatchObject({content: '请分析图片附件。', attachments: [image]});
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.items?.[0]).toMatchObject({attachments: [image]});
    await controller.shutdown();
  }, 20_000);

  it('Qoder 在创建 run 或发起请求前拒绝图片附件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-image-')); roots.push(root);
    const image = sampleImage;
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const begin = vi.spyOn(repository, 'beginAgentRun');
    const client = new MockLLMClient([]);
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    await controller.initialize({...profile, protocol: 'qoder'});
    await controller.sendMessage('', [image]);

    expect(begin).not.toHaveBeenCalled();
    expect(client.requests).toHaveLength(0);
    expect(controller.getState().visibleError).toMatch(/Qoder.*图片/);
    await controller.shutdown();
  }, 20_000);

  it('附件也随生成中排队的 steer 持久化', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-image-')); roots.push(root);
    writeFileSync(join(root, 'note.txt'), 'ok');
    const image = sampleImage;
    const requests: ChatRequest[] = [];
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const append = vi.spyOn(repository, 'appendSteerMessage');
    const tools = createToolSystem(root);
    let controller: ChatController | null = null;
    const client: LLMClient = {async *streamChat(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield {type: 'tool_call_start', internalId: 'read', providerCallId: 'read-provider', position: 0, name: 'read_file'};
        yield {type: 'tool_call_arguments_delta', internalId: 'read', delta: '{"path":"note.txt"}'};
        yield {type: 'tool_call_end', internalId: 'read'};
        yield {type: 'completed', finishReason: 'tool_calls'};
        void controller!.steerMessage('', [image]);
        return;
      }
      yield {type: 'text_delta', text: '已处理附件'};
      yield {type: 'completed', finishReason: 'stop'};
    }};
    controller = new ChatController(client, repository, tools, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.sendMessage('读取 note.txt');

    expect(append).toHaveBeenCalledWith(expect.objectContaining({attachments: [image]}));
    expect(controller.getState().queuedMessages).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.items?.some(item => item.type === 'message' && item.attachments?.some(attachment => attachment.name === image.name))).toBe(true);
    await controller.shutdown();
    await tools.close();
  }, 20_000);

  it('导出当前 conversation，导入后切换新 session，并向 UI 暴露功能摘要', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-import-export-')); roots.push(root);
    const controller = new ChatController(new MockLLMClient([[{type: 'text_delta', text: 'saved'}, {type: 'completed', finishReason: 'stop'}]]), new SessionRepository(join(root, 'db.sqlite')), null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    await controller.sendMessage('保存这段会话');
    const originalSessionId = controller.getState().session?.id;
    const exported: StoredConversation = await controller.exportSession();
    expect(exported.messages.some(message => message.content === '保存这段会话')).toBe(true);
    await controller.importSession(exported);
    expect(controller.getState().session?.id).not.toBe(originalSessionId);
    expect(controller.getState().messages.some(message => message.content === '保存这段会话')).toBe(true);
    expect(controller.commandCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'attach', argumentHint: '[path]'}),
      expect.objectContaining({name: 'attachments', argumentHint: 'clear'}),
      expect.objectContaining({name: 'import', argumentHint: '<path>'}),
      expect.objectContaining({name: 'export', argumentHint: '<path>'}),
      expect.objectContaining({name: 'resume'}),
    ]));
    await controller.shutdown();
  }, 20_000);

  it('活动请求期间显式拒绝会话导入和导出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-controller-import-export-')); roots.push(root);
    let releaseStream = (): void => undefined;
    const waitForStream = new Promise<void>(resolve => { releaseStream = resolve; });
    const client: LLMClient = {async *streamChat(): AsyncIterable<StreamEvent> {
      await waitForStream;
      yield {type: 'completed', finishReason: 'stop'};
    }};
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const controller = new ChatController(client, repository, null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    const archived = await controller.exportSession();
    const sending = controller.sendMessage('忙碌中的任务');
    await vi.waitFor(() => expect(controller.getState().activeRunId).not.toBeNull());
    await expect(controller.exportSession()).rejects.toThrow('正在处理中');
    await expect(controller.importSession(archived)).rejects.toThrow('正在处理中');
    releaseStream();
    await sending;
    await controller.shutdown();
  }, 20_000);
});

import {toProfileSummary} from '../config/types.js';
import type {ProviderProfile} from '../config/types.js';
import type {HistoricalToolCall, LLMClient, ProviderState, Usage} from '../providers/types.js';
import type {ProviderError} from '../providers/errors.js';
import type {Session, SessionRepositoryContract, StoredMessage} from '../storage/types.js';
import type {ToolCallRecord} from '../storage/types.js';
import type {ApprovalDecision} from '../tools/types.js';
import {ToolCallAssembler} from '../tools/call-assembler.js';
import {ToolBatchCoordinator} from '../tools/batch-coordinator.js';
import type {ApprovalCoordinator} from '../tools/approval-coordinator.js';
import type {ToolExecutor} from '../tools/executor.js';
import type {ToolRegistry} from '../tools/registry.js';
import type {PermissionEngine} from '../tools/permission-engine.js';
import {createToolCallId, now} from '../shared/ids.js';
import {buildChatContext} from './context.js';
import {initialAppState, replaceMessage} from './state.js';
import type {AppState} from './state.js';
import {agentLoopLimitMessage, createAgentLoopLimitResult, createFinalChatRequest} from './turn-orchestrator.js';
import {ChatController as AgentChatController} from './agent-controller.js';

export type StateListener = (state: AppState) => void;
export interface ControllerToolSystem {registry: ToolRegistry; executor: ToolExecutor; approvals: ApprovalCoordinator; permissions?: PermissionEngine}

/** [s01] 单次进行中请求需要一起管理的取消、完成和 checkpoint 状态。 */
interface ActiveRequest {
  abortController: AbortController;
  messageId: string;
  promise: Promise<void>;
  checkpointTimer: ReturnType<typeof setTimeout> | null;
  checkpointPromise: Promise<void> | null;
  checkpointDirty: boolean;
}

const checkpointInterval = 200;

/** [s01]
 * 应用的业务中枢：它不渲染 UI，也不认识具体供应商 SDK 或 SQLite。
 * 它只通过 LLMClient 消费统一流事件，通过 Repository 保存消息，再向订阅者发布 AppState。
 */
export class LegacyChatController {
  readonly #client: LLMClient;
  readonly #repository: SessionRepositoryContract;
  readonly #listeners = new Set<StateListener>();
  readonly #tools: ControllerToolSystem | null;
  #profile: ProviderProfile | null = null;
  #state = initialAppState();
  #active: ActiveRequest | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #closed = false;

  public constructor(client: LLMClient, repository: SessionRepositoryContract, tools: ControllerToolSystem | null = null) {
    this.#client = client;
    this.#repository = repository;
    this.#tools = tools;
    tools?.approvals.subscribe(prompt => this.#publish({...this.#state, approvalPrompt: prompt, requestStatus: prompt ? 'approving' : this.#state.requestStatus}));
  }

  public getState(): AppState { return this.#state; }
  public subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    // [s01] 返回退订函数是常见的观察者模式，React 卸载时会调用它。
    return () => this.#listeners.delete(listener);
  }

  public async initialize(profile: ProviderProfile): Promise<void> {
    // [s01] 初始化只允许一次：先迁移数据库，再恢复当前 profile 最近会话；没有则创建。
    if (this.#profile !== null) return;
    this.#profile = profile;
    await this.#repository.initialize();
    const existing = await this.#repository.findLatestSession(profile.name);
    const session = existing ?? await this.#repository.createSession(profile.name);
    const conversation = await this.#repository.getConversation(session.id);
    const messages = conversation?.messages ?? await this.#repository.getMessages(session.id);
    this.#publish({...initialAppState(toProfileSummary(profile)), session, messages, toolCalls: conversation?.toolCalls ?? []});
  }

  public async sendMessage(text: string): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#active !== null) {
      this.#error('已有请求正在进行');
      return;
    }
    if (text.trim().length === 0 || this.#state.session === null) return;
    const turn = await this.#repository.beginTurn(this.#state.session.id, text);
    // [s01] beginTurn 已在一个事务里写入 user 消息和 assistant 草稿，此时才能把它们发布给 UI。
    const messages = [...this.#state.messages, turn.userMessage, turn.assistantMessage];
    this.#publish({...this.#state, messages, requestStatus: 'streaming', latestUsage: null, visibleError: null});
    const abortController = new AbortController();
    const active: ActiveRequest = {
      abortController,
      messageId: turn.assistantMessage.id,
      promise: Promise.resolve(),
      checkpointTimer: null,
      checkpointPromise: null,
      checkpointDirty: false,
    };
    this.#active = active;
    // [s01] 先把 Promise 放回 active，取消和 shutdown 才能等待同一项工作真正收尾。
    active.promise = this.#consume(turn.assistantMessage, abortController.signal, active);
    await active.promise;
  }

  public async cancelActiveRequest(): Promise<void> {
    const active = this.#active;
    if (active === null || active.abortController.signal.aborted) return;
    this.#publish({...this.#state, requestStatus: 'cancelling'});
    this.#tools?.approvals.interruptAll();
    active.abortController.abort();
    // [s01] 等待 consume 将部分回答写成 cancelled 终态，而不是只中断网络就立刻返回。
    await active.promise;
  }

  public resolveToolApproval(decision: ApprovalDecision): void {
    const prompt = this.#state.approvalPrompt;
    if (prompt) this.#tools?.approvals.resolve(prompt.callId, decision);
  }

  public async createSession(): Promise<void> {
    if (!this.#canChangeSession() || this.#profile === null) return;
    const session = await this.#repository.createSession(this.#profile.name);
    this.#publishSession(session, []);
  }

  public async listSessions(): Promise<Session[]> {
    if (this.#profile === null) return [];
    return this.#repository.listSessions(this.#profile.name);
  }

  public async switchSession(sessionId: string): Promise<void> {
    if (!this.#canChangeSession() || this.#profile === null) return;
    const session = await this.#repository.getSession(sessionId);
    // [s01] 即使调用方传入任意 id，也要在业务层再次验证 profile 隔离。
    if (session === null || session.profileName !== this.#profile.name) {
      this.#error('该会话不属于当前 profile');
      return;
    }
    const conversation = await this.#repository.getConversation(session.id);
    this.#publishSession(session, conversation?.messages ?? await this.#repository.getMessages(session.id), conversation?.toolCalls ?? []);
  }

  public setScreen(screen: AppState['screen']): void { this.#publish({...this.#state, screen}); }
  public selectMessage(messageId: string | null): void { this.#publish({...this.#state, selectedMessageId: messageId}); }
  public toggleThinking(messageId: string): void {
    // [s01] Set 也需要复制后再改，才能保持状态更新的不可变语义。
    const expanded = new Set(this.#state.expandedThinkingIds);
    if (expanded.has(messageId)) expanded.delete(messageId); else expanded.add(messageId);
    this.#publish({...this.#state, expandedThinkingIds: expanded});
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      this.#closed = true;
      // [s01] 活跃流必须先取消并完成最终写盘，随后才能关闭数据库 Worker。
      if (this.#active !== null) await this.cancelActiveRequest();
      await this.#repository.close();
    })();
    return this.#shutdownPromise;
  }

  async #consume(initial: StoredMessage, signal: AbortSignal, active: ActiveRequest): Promise<void> {
    // [s01] current 是正在不断追加文本的 assistant 消息快照。
    let current = initial;
    let usage: Usage | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let providerState: ProviderState | null = null;
    let terminal: 'completed' | 'cancelled' | 'failed' | null = null;
    let failure: ProviderError | null = null;
    let loopLimitMessage: string | null = null;
    const assembler = this.#tools ? new ToolCallAssembler(this.#tools.registry) : null;
    try {
      // [s01] 注意此时 state.messages 已包含本轮 user 和空 assistant 草稿；context 的过滤会排除 streaming 草稿。
      /* [s01 旧实现，s02 替换] const request = {messages: buildChatContext(this.#state.messages)}; */
      const request = {messages: buildChatContext(this.#state.messages), toolHistory: this.#toolHistory(), ...(this.#tools ? {tools: this.#tools.registry.definitions()} : {}), phase: 'initial' as const};
      for await (const event of this.#client.streamChat(request, signal)) {
        if (event.type === 'text_delta') {
          // [s01] 用对象展开创建新消息，而不是修改原对象；随后立即发布，实现逐块刷新。
          current = {...current, content: current.content + event.text, updatedAt: Date.now()};
          this.#publish(replaceMessage({...this.#state, requestStatus: 'streaming'}, current));
          this.#scheduleCheckpoint(active);
        } else if (event.type === 'thinking_delta') {
          current = {...current, thinking: current.thinking + event.text, updatedAt: Date.now()};
          const expanded = new Set(this.#state.expandedThinkingIds).add(current.id);
          this.#publish(replaceMessage({...this.#state, requestStatus: 'thinking', expandedThinkingIds: expanded}, current));
          this.#scheduleCheckpoint(active);
        } else if (event.type === 'usage') {
          // [s01] 有的协议分开发 input/output usage；0 表示本事件未更新该方向，因此保留旧值。
          inputTokens = event.usage.inputTokens || inputTokens;
          outputTokens = event.usage.outputTokens || outputTokens;
          usage = {
            inputTokens,
            outputTokens,
          };
          this.#publish({...this.#state, latestUsage: usage});
        } else if (event.type === 'completed') {
          terminal = 'completed';
          providerState = event.providerState ?? null;
          break;
        } else if (event.type === 'error') {
          terminal = 'failed';
          failure = event.error;
          break;
        } else {
          assembler?.consume(event);
        }
      }
      if (signal.aborted) terminal = 'cancelled';
      if (terminal === null) {
        // [s01] Provider 若没有 completed/error 就直接结束迭代器，视为异常，不能误标为成功。
        terminal = 'failed';
        failure = {code: 'provider_error', message: '供应商流意外结束', retryable: true};
      }
    } catch (error) {
      if (signal.aborted) terminal = 'cancelled';
      else {
        terminal = 'failed';
        failure = {code: 'unknown', message: error instanceof Error ? error.message : String(error), retryable: false};
      }
    }

    // [s02] 首轮存在工具调用时，执行整批并且只回灌一次；final 请求不再提供工具定义。
    if (terminal === 'completed' && assembler && this.#tools && this.#state.session) {
      const batch = assembler.finish();
      if (batch.validCalls.length > 0 || batch.invalidCalls.length > 0) {
        const timestamp = now();
        // [s02] 记录主键必须用独立 UUID：internalId 只在单条流内唯一，跨回合、跨会话都会重复。
        const validRecords: ToolCallRecord[] = batch.validCalls.map(call => ({id: createToolCallId(), sessionId: this.#state.session!.id, assistantMessageId: current.id, providerCallId: call.providerCallId, position: call.position, toolName: call.name, arguments: call.arguments, approvalStatus: call.effect === 'read' ? 'not_required' : 'pending', executionStatus: 'queued', result: null, createdAt: timestamp, updatedAt: timestamp}));
        const invalidRecords: ToolCallRecord[] = batch.invalidCalls.map(call => ({id: createToolCallId(), sessionId: this.#state.session!.id, assistantMessageId: current.id, providerCallId: call.providerCallId, position: call.position, toolName: call.name, arguments: {raw: call.argumentsText}, approvalStatus: 'not_required', executionStatus: 'failed', result: {status: 'error', error: call.error}, createdAt: timestamp, updatedAt: timestamp}));
        const recordsByCall = new Map(batch.validCalls.map((call, index) => [call.internalId, validRecords[index]!]));
        const records = [...validRecords, ...invalidRecords].sort((a, b) => a.position - b.position);
        // [s02] 工具调用与产生它的首段 assistant 必须在同一事务落盘，避免崩溃后只剩一半协议历史。
        await this.#flushCheckpoint(active, current);
        current = {...current, status: 'completed', usage, providerState, updatedAt: now()};
        await this.#repository.finalizeAssistantWithToolBatch(current.id, {content: current.content, thinking: current.thinking, status: 'completed', error: null, usage, providerState}, records);
        this.#publish(replaceMessage({...this.#state, toolCalls: [...this.#state.toolCalls, ...records], requestStatus: 'executing_tools'}, current));
        const completedRecords = await new ToolBatchCoordinator().execute(batch, {executor: this.#tools.executor, approvals: this.#tools.approvals, repository: this.#repository, records: recordsByCall, signal});
        const allRecords = [...completedRecords, ...invalidRecords].sort((a, b) => a.position - b.position);
        this.#publish({...this.#state, toolCalls: [...this.#state.toolCalls.filter(item => !records.some(record => record.id === item.id)), ...allRecords], requestStatus: 'streaming', approvalPrompt: null});
        if (!signal.aborted) {
          // [s02] 工具结果之后新建独立 assistant 草稿，使恢复后的消息顺序仍是合法的模型协议。
          const continuation = await this.#repository.beginAssistantContinuation(this.#state.session.id);
          current = continuation;
          active.messageId = continuation.id;
          usage = null;
          providerState = null;
          this.#publish({...this.#state, messages: [...this.#state.messages, continuation], requestStatus: 'streaming'});
          const toolCalls = batch.validCalls.map(call => ({callId: call.providerCallId, name: call.name, arguments: call.arguments}));
          const toolResults = allRecords.filter(record => record.providerCallId !== null).map(record => ({callId: record.providerCallId!, name: record.toolName, result: record.result}));
          const finalAssembler = new ToolCallAssembler(this.#tools.registry);
          for await (const event of this.#client.streamChat(createFinalChatRequest(buildChatContext(this.#state.messages), toolCalls, toolResults, this.#toolHistory()), signal)) {
            if (event.type === 'text_delta') { current = {...current, content: current.content + event.text, updatedAt: now()}; this.#publish(replaceMessage(this.#state, current)); }
            else if (event.type === 'thinking_delta') current = {...current, thinking: current.thinking + event.text, updatedAt: now()};
            else if (event.type === 'usage') usage = event.usage;
            else if (event.type === 'error') { terminal = 'failed'; failure = event.error; }
            else if (event.type === 'tool_call_start' || event.type === 'tool_call_arguments_delta' || event.type === 'tool_call_end') finalAssembler.consume(event);
          }
          const blocked = finalAssembler.finish();
          if (blocked.validCalls.length > 0 || blocked.invalidCalls.length > 0) {
            const blockedAt = now();
            const blockedRecords: ToolCallRecord[] = [...blocked.validCalls, ...blocked.invalidCalls].map(call => ({id: createToolCallId(), sessionId: this.#state.session!.id, assistantMessageId: current.id, providerCallId: call.providerCallId, position: call.position, toolName: call.name, arguments: 'arguments' in call ? call.arguments : {raw: call.argumentsText}, approvalStatus: 'not_required', executionStatus: 'skipped', result: createAgentLoopLimitResult(), createdAt: blockedAt, updatedAt: blockedAt}));
            await this.#repository.saveToolBatch(blockedRecords);
            loopLimitMessage = agentLoopLimitMessage;
            this.#publish({...this.#state, toolCalls: [...this.#state.toolCalls, ...blockedRecords], visibleError: loopLimitMessage});
          }
        } else {
          this.#active = null;
          this.#publish({...this.#state, requestStatus: 'idle', approvalPrompt: null});
          return;
        }
      }
    }

    // [s01] 先冲刷所有节流中的草稿，再写最终状态，保证最终内容不会被旧 checkpoint 覆盖。
    await this.#flushCheckpoint(active, current);
    const status = terminal ?? 'failed';
    current = {...current, status, errorCode: failure?.code ?? null, errorMessage: failure?.message ?? null, usage, providerState, updatedAt: Date.now()};
    await this.#repository.finalizeMessage(current.id, {
      content: current.content, thinking: current.thinking, status,
      error: failure, usage, providerState,
    });
    const expanded = new Set(this.#state.expandedThinkingIds);
    // [s01] 生成时 thinking 自动展开；正常完成后自动折叠，取消/失败则保留现场。
    if (status === 'completed') expanded.delete(current.id);
    this.#active = null;
    this.#publish(replaceMessage({
      ...this.#state,
      requestStatus: status === 'failed' ? 'failed' : 'idle',
      visibleError: failure?.message ?? loopLimitMessage,
      expandedThinkingIds: expanded,
    }, current));
  }

  #scheduleCheckpoint(active: ActiveRequest): void {
    // [s01] UI 对每个 delta 都更新，但 SQLite 最多约每 200ms 写一次，减少磁盘压力。
    active.checkpointDirty = true;
    if (active.checkpointTimer !== null || active.checkpointPromise !== null) return;
    active.checkpointTimer = setTimeout(() => {
      active.checkpointTimer = null;
      const message = this.#state.messages.find(item => item.id === active.messageId);
      if (message === undefined || !active.checkpointDirty) return;
      active.checkpointDirty = false;
      active.checkpointPromise = this.#repository.checkpointAssistant(message.id, message.content, message.thinking)
        .finally(() => {
          active.checkpointPromise = null;
          if (active.checkpointDirty) this.#scheduleCheckpoint(active);
        });
    }, checkpointInterval);
  }

  async #flushCheckpoint(active: ActiveRequest, message: StoredMessage): Promise<void> {
    // [s01] 收尾时取消尚未触发的 timer，等待在途写入，并补写最后一个 dirty 快照。
    if (active.checkpointTimer !== null) {
      clearTimeout(active.checkpointTimer);
      active.checkpointTimer = null;
    }
    if (active.checkpointPromise !== null) await active.checkpointPromise;
    if (active.checkpointDirty) {
      active.checkpointDirty = false;
      await this.#repository.checkpointAssistant(message.id, message.content, message.thinking);
    }
  }

  #canChangeSession(): boolean {
    if (this.#active !== null) {
      this.#error('生成期间不能新建或切换会话');
      return false;
    }
    return true;
  }

  #toolHistory(): HistoricalToolCall[] {
    return this.#state.toolCalls
      .filter(record => record.providerCallId !== null && record.result !== null)
      .map(record => ({assistantMessageId: record.assistantMessageId, callId: record.providerCallId!, name: record.toolName, arguments: record.arguments, result: record.result}));
  }

  #publishSession(session: Session, messages: StoredMessage[], toolCalls: ToolCallRecord[] = []): void {
    this.#publish({...this.#state, screen: 'chat', session, messages, requestStatus: 'idle', latestUsage: null,
      toolCalls, expandedThinkingIds: new Set(), selectedMessageId: null, visibleError: null});
  }

  #error(message: string): void { this.#publish({...this.#state, visibleError: message}); }
  #publish(state: AppState): void {
    if (state === this.#state) return;
    this.#state = state;
    // [s01] 同步通知所有订阅者；React hook 收到通知后再读取最新快照。
    for (const listener of this.#listeners) listener(state);
  }
}

/** [s03] 对外控制器切换为 Agent 驱动实现；上方 s02 实现仅保留作状态留痕。 */
export {AgentChatController as ChatController};

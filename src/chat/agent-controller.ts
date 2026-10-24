import {toProfileSummary} from '../config/types.js';
import type {ProviderProfile} from '../config/types.js';
import type {LLMClient} from '../providers/types.js';
import type {AgentRunRecord, Session, SessionRepositoryContract, StoredMessage, ToolCallRecord} from '../storage/types.js';
import type {ApprovalDecision} from '../tools/types.js';
import {ApprovalCoordinator} from '../tools/approval-coordinator.js';
import {ToolExecutor} from '../tools/executor.js';
import {ToolRegistry} from '../tools/registry.js';
import {fixedToolLimits} from '../tools/create-tool-system.js';
import {createId} from '../shared/ids.js';
import {AgentContext} from '../agent/context.js';
import {AgentRunner} from '../agent/runner.js';
import {SafetyBatchScheduler} from '../agent/safety-batch-scheduler.js';
import {StreamCollector} from '../agent/stream-collector.js';
import type {PromptBlock} from '../prompt/builder.js';
import {buildSystemPrompt} from '../prompt/builder.js';
import {collectEnvironment} from '../prompt/environment.js';
import {buildReminders} from '../prompt/reminders.js';
import {parseChatCommand} from './commands.js';
import {effectiveContextWindow} from '../config/types.js';
import {manageContext} from '../compact/compact.js';
import {RecoveryState} from '../compact/recovery.js';
import {AgentEventProjector} from './agent-event-projector.js';
import {initialAppState} from './state.js';
import type {AppState} from './state.js';
import type {PermissionEngine, PermissionTier} from '../tools/permission-engine.js';

type StateListener = (state: AppState) => void;
interface ControllerToolSystem {registry: ToolRegistry; executor: ToolExecutor; approvals: ApprovalCoordinator; permissions?: PermissionEngine}
interface ActiveRequest {abortController: AbortController; promise: Promise<void>}

/** [s03] 恢复会话时，状态栏继续显示最近一次 Agent 回合的累计用量和停止原因。 */
function restoredRunState(messages: readonly StoredMessage[], runs: readonly AgentRunRecord[]): Pick<AppState, 'latestUsage' | 'runUsage' | 'stopReason'> {
  const latestRun = runs.at(-1);
  const latestUsage = messages.findLast(message => message.usage !== null)?.usage ?? null;
  return {
    latestUsage,
    runUsage: latestRun === undefined ? {inputTokens: 0, outputTokens: 0} : {inputTokens: latestRun.inputTokens, outputTokens: latestRun.outputTokens},
    stopReason: latestRun?.stopReason ?? null,
  };
}

/** [s04] 统计会话 run 记录尾部连续 plan 模式 run 数；调用前本次 run 已入库，计数即本轮 Plan 轮次，/do 产生的 execute run 天然打断连续序列。 */
function trailingPlanRuns(runs: readonly AgentRunRecord[]): number {
  let count = 0;
  for (let index = runs.length - 1; index >= 0 && runs[index]!.mode === 'plan'; index--) count++;
  return count;
}

/** [s03] TUI 入口只负责命令、会话、取消和 AgentEvent 投影。 */
export class ChatController {
  readonly #repository: SessionRepositoryContract;
  readonly #listeners = new Set<StateListener>();
  readonly #tools: ControllerToolSystem;
  readonly #client: LLMClient;
  readonly #runner: AgentRunner;
  #profile: ProviderProfile | null = null;
  /** [s04] 会话激活时构建并冻结的系统提示；无 profile 时为 null。 */
  #systemBlocks: PromptBlock[] | null = null;
  #state = initialAppState();
  #active: ActiveRequest | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #closed = false;

  constructor(client: LLMClient, repository: SessionRepositoryContract, tools: ControllerToolSystem | null = null, runner?: AgentRunner) {
    this.#repository = repository; this.#client = client;
    const registry = tools?.registry ?? new ToolRegistry(); const approvals = tools?.approvals ?? new ApprovalCoordinator();
    const executor = tools?.executor ?? new ToolExecutor(registry, {workspaceRoot: process.cwd(), limits: fixedToolLimits});
    this.#tools = {registry, approvals, executor, ...(tools?.permissions === undefined && executor.options.permissions === undefined ? {} : {permissions: tools?.permissions ?? executor.options.permissions})};
    this.#runner = runner ?? new AgentRunner(client, registry, new StreamCollector(), new SafetyBatchScheduler(executor, approvals));
  }
  getState(): AppState { return this.#state; }
  subscribe(listener: StateListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async initialize(profile: ProviderProfile): Promise<void> {
    if (this.#profile) return; this.#profile = profile; await this.#repository.initialize();
    this.#rebuildSystemPrompt();
    const session = await this.#repository.findLatestSession(profile.name) ?? await this.#repository.createSession(profile.name);
    const conversation = await this.#repository.getConversation(session.id);
    const messages = conversation?.messages ?? await this.#repository.getMessages(session.id);
    /* [s03 旧实现，s03 验收修复替换] 初始化会话时把 runUsage、latestUsage 和 stopReason 留在初始零值。 */
    this.#publish({...initialAppState(toProfileSummary(profile)), session, agentMode: session.agentMode, permissionTier: this.#tools.permissions?.tier ?? 'default', messages, toolCalls: conversation?.toolCalls ?? [], ...restoredRunState(messages, conversation?.agentRuns ?? [])});
  }
  async sendMessage(text: string): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#active) { this.#error('已有请求正在进行'); return; }
    if (!text.trim() || !this.#state.session) return;
    const command = parseChatCommand(text);
    if (command !== null && typeof command === 'object' && command.type === 'unknown') { this.#error(`未知命令：${text.trim()}。可用命令：/plan、/do、/compact、/permission <tier>`); return; }
    if (command === 'plan') { await this.#setMode('plan'); return; }
    if (command === 'do') { await this.#setMode('execute'); if (!this.#state.session?.latestPlanMessageId) { this.#error('当前会话没有可执行计划'); return; } await this.#startRun('/do', '根据当前会话中的最近计划立即执行。', 'do'); return; }
    if (command !== null && typeof command === 'object' && command.type === 'permission') { this.#setPermissionTier(command.tier); return; }
    if (command === 'compact') { await this.#compactConversation(); return; }
    await this.#startRun(text, text, 'message');
  }
  /** [s07] 空闲时手动压缩；不发起普通对话请求，只额外调用一次摘要模型。 */
  async #compactConversation(): Promise<void> {
    const session = this.#state.session; if (!session || !this.#profile) return;
    if (this.#active) { this.#error('生成期间不能手动压缩上下文'); return; }
    const conversation = await this.#repository.getConversation(session.id); if (!conversation) { this.#error('无法读取当前会话上下文'); return; }
    const items = AgentContext.fromConversation(conversation).items();
    const tools = this.#tools.registry.definitions();
    const result = await manageContext({items, client: this.#client, contextWindow: effectiveContextWindow(this.#profile.protocol, this.#profile.contextWindow), tracking: {consecutiveFailures: 0}, recovery: new RecoveryState(), tools, anchor: null, signal: new AbortController().signal}, {force: true, safetyMargin: 3_000});
    if (result.compacted) this.#error(`上下文已压缩：估算 ${result.beforeTokens} → ${result.afterTokens} tokens`);
    else this.#error(`上下文未压缩：${result.reason}`);
  }

  async #startRun(displayText: string, instruction: string, trigger: 'message' | 'do'): Promise<void> {
    const session = this.#state.session; if (!session) return; const runId = createId();
    const begun = await this.#repository.beginAgentRun({runId, sessionId: session.id, displayText, mode: this.#state.agentMode});
    this.#publish({...this.#state, messages: [...this.#state.messages, begun.userMessage], requestStatus: 'streaming', latestUsage: null, runUsage: {inputTokens: 0, outputTokens: 0}, visibleError: null});
    const conversation = await this.#repository.getConversation(session.id); if (!conversation) throw new Error('Agent 回合创建后无法恢复会话');
    // [s04] Plan 轮次由会话 run 记录推导（本次 run 已入库）；reminders 只由模式与轮次决定，请求级注入、不持久化。
    const reminders = buildReminders(this.#state.agentMode, this.#state.agentMode === 'plan' ? trailingPlanRuns(conversation.agentRuns) : 0);
    const abortController = new AbortController(); const active: ActiveRequest = {abortController, promise: Promise.resolve()}; this.#active = active;
    active.promise = this.#consume(runId, instruction, trigger, AgentContext.fromConversation(conversation), abortController.signal, reminders); await active.promise;
  }
  async #consume(runId: string, instruction: string, trigger: 'message' | 'do', context: AgentContext, signal: AbortSignal, reminders: string[]): Promise<void> {
    const session = this.#state.session!; const projector = new AgentEventProjector(this.#repository, this.#state, state => this.#publish(state), this.#state.agentMode);
    try {
      const generator = this.#runner.run({runId, sessionId: session.id, trigger, mode: this.#state.agentMode, instruction, context: [...context.items()], ...(this.#systemBlocks ? {system: this.#systemBlocks} : {}), reminders, ...(this.#profile ? {contextManagement: {windowTokens: effectiveContextWindow(this.#profile.protocol, this.#profile.contextWindow), workspaceRoot: process.cwd()}} : {})}, signal);
      while (true) { const step = await generator.next(); if (step.done) break; await projector.project(step.value); }
      await projector.flush(); const restored = await this.#repository.getSession(session.id); if (restored) this.#publish({...this.#state, session: restored, agentMode: restored.agentMode});
    } catch (error) { if (!signal.aborted) this.#publish({...this.#state, requestStatus: 'failed', activeRunId: null, visibleError: error instanceof Error ? error.message : String(error)}); }
    finally { this.#active = null; }
  }
  async cancelActiveRequest(): Promise<void> { const active = this.#active; if (!active || active.abortController.signal.aborted) return; this.#publish({...this.#state, requestStatus: 'cancelling'}); active.abortController.abort(); this.#tools.approvals.interruptAll(); await active.promise; }
  resolveToolApproval(decision: ApprovalDecision): void { const prompt = this.#state.approvalPrompt; if (prompt) this.#tools.approvals.resolve(prompt.callId, decision); }
  setPermissionTier(tier: PermissionTier): void { this.#setPermissionTier(tier); }
  async createSession(): Promise<void> { if (!this.#canChangeSession() || !this.#profile) return; this.#rebuildSystemPrompt(); this.#publishSession(await this.#repository.createSession(this.#profile.name), []); }
  async listSessions(): Promise<Session[]> { return this.#profile ? this.#repository.listSessions(this.#profile.name) : []; }
  async switchSession(sessionId: string): Promise<void> { if (!this.#canChangeSession() || !this.#profile) return; const session = await this.#repository.getSession(sessionId); if (!session || session.profileName !== this.#profile.name) { this.#error('该会话不属于当前 profile'); return; } this.#rebuildSystemPrompt(); const conversation = await this.#repository.getConversation(session.id); this.#publishSession(session, conversation?.messages ?? await this.#repository.getMessages(session.id), conversation?.toolCalls ?? [], conversation?.agentRuns ?? []); }
  setScreen(screen: AppState['screen']): void { this.#publish({...this.#state, screen}); }
  selectMessage(messageId: string | null): void { this.#publish({...this.#state, selectedMessageId: messageId}); }
  toggleThinking(messageId: string): void { const expanded = new Set(this.#state.expandedThinkingIds); if (expanded.has(messageId)) expanded.delete(messageId); else expanded.add(messageId); this.#publish({...this.#state, expandedThinkingIds: expanded}); }
  shutdown(): Promise<void> { if (this.#shutdownPromise) return this.#shutdownPromise; this.#shutdownPromise = (async () => { this.#closed = true; if (this.#active) await this.cancelActiveRequest(); await this.#repository.close(); })(); return this.#shutdownPromise; }
  async #setMode(mode: 'plan' | 'execute'): Promise<void> { const session = this.#state.session; if (!session) return; const updated = await this.#repository.setSessionMode(session.id, mode); this.#publish({...this.#state, session: updated, agentMode: mode, visibleError: null}); }
  #setPermissionTier(tier: PermissionTier): void { if (!this.#tools.permissions) { this.#error('当前工具系统未启用权限引擎'); return; } this.#tools.permissions.setTier(tier); this.#publish({...this.#state, permissionTier: tier, visibleError: null}); }
  /** [s04] 会话激活时采集环境并冻结系统提示；同一会话内逐字节稳定，保证 Anthropic 可缓存前缀不被破坏。 */
  #rebuildSystemPrompt(): void { this.#systemBlocks = this.#profile ? buildSystemPrompt(collectEnvironment(this.#profile, process.cwd())).blocks : null; }
  #canChangeSession(): boolean { if (this.#active) { this.#error('生成期间不能新建或切换会话'); return false; } return true; }
  /* [s03 旧实现，s03 验收修复替换] 切换会话时无条件清零 latestUsage/runUsage，且沿用了前一会话的 stopReason。 */
  #publishSession(session: Session, messages: StoredMessage[], toolCalls: ToolCallRecord[] = [], agentRuns: AgentRunRecord[] = []): void { this.#publish({...this.#state, screen: 'chat', session, agentMode: session.agentMode, permissionTier: this.#tools.permissions?.tier ?? 'default', messages, toolCalls, requestStatus: 'idle', ...restoredRunState(messages, agentRuns), activeRunId: null, iteration: 0, agentPhase: null, expandedThinkingIds: new Set(), selectedMessageId: null, visibleError: null, approvalPrompt: null}); }
  #error(message: string): void { this.#publish({...this.#state, visibleError: message}); }
  #publish(state: AppState): void { if (state === this.#state) return; this.#state = state; for (const listener of this.#listeners) listener(state); }
}

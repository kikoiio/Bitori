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
import {errorMessage, StorageError} from '../shared/errors.js';
import {getLogger} from '../shared/logger.js';
import {AgentContext} from '../agent/context.js';
import {AgentRunner} from '../agent/runner.js';
import {SafetyBatchScheduler} from '../agent/safety-batch-scheduler.js';
import {StreamCollector} from '../agent/stream-collector.js';
import type {PromptBlock} from '../prompt/builder.js';
import {buildSessionPrompt} from './session-prompt.js';
import {buildReminders} from '../prompt/reminders.js';
import {effectiveContextWindow} from '../config/types.js';
import {compactionBoundaryMessageId, manageContext} from '../compact/compact.js';
import {AgentEventProjector} from './agent-event-projector.js';
import {initialAppState} from './state.js';
import type {AppState} from './state.js';
import {AgentTraceTap, type DebugEntry} from '../trace/tap.js';
import {TraceWriter} from '../trace/writer.js';
import {UsageRecorder} from '../usage/recorder.js';
import type {PermissionEngine, PermissionTier} from '../tools/permission-engine.js';
import type {AgentServices} from '../agent/services.js';
import type {AgentRunResult, AgentStopReason} from '../agent/types.js';
import {createDefaultRegistry, parseCommand, permissionTierArgument, type CommandRegistry} from '../commands/registry.js';
import {loadUserCommands} from '../commands/loader.js';

type StateListener = (state: AppState) => void;
const logger = getLogger('chat');
interface ControllerToolSystem {registry: ToolRegistry; executor: ToolExecutor; approvals: ApprovalCoordinator; permissions?: PermissionEngine}
interface ControllerToolSystemWithServices extends ControllerToolSystem {services?: AgentServices; memoryClient?: LLMClient}
interface ActiveRequest {abortController: AbortController; promise: Promise<void>}

/** 恢复会话时，状态栏继续显示最近一次 Agent 回合的累计用量和停止原因。 */
function restoredRunState(messages: readonly StoredMessage[], runs: readonly AgentRunRecord[]): Pick<AppState, 'latestUsage' | 'runUsage' | 'stopReason'> {
  const latestRun = runs.at(-1);
  const latestUsage = messages.findLast(message => message.usage !== null)?.usage ?? null;
  return {
    latestUsage,
    runUsage: latestRun === undefined ? {inputTokens: 0, outputTokens: 0} : {inputTokens: latestRun.inputTokens, outputTokens: latestRun.outputTokens},
    stopReason: latestRun?.stopReason ?? null,
  };
}

/** 统计会话 run 记录尾部连续 plan 模式 run 数；调用前本次 run 已入库，计数即本轮 Plan 轮次，/do 产生的 execute run 天然打断连续序列。 */
function trailingPlanRuns(runs: readonly AgentRunRecord[]): number {
  let count = 0;
  for (let index = runs.length - 1; index >= 0 && runs[index]!.mode === 'plan'; index--) count++;
  return count;
}

/** TUI 入口只负责命令、会话、取消和 AgentEvent 投影。 */
export class ChatController {
  readonly #repository: SessionRepositoryContract;
  readonly #workspaceRoot: string;
  readonly #listeners = new Set<StateListener>();
  readonly #tools: ControllerToolSystem;
  readonly #client: LLMClient;
  readonly #runner: AgentRunner;
  #profile: ProviderProfile | null = null;
  /** 会话激活时构建并冻结的系统提示；无 profile 时为 null。 */
  #systemBlocks: PromptBlock[] | null = null;
  #state = initialAppState();
  #active: ActiveRequest | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #closed = false;
  readonly #commands: CommandRegistry;
  readonly #services: AgentServices | null;
  readonly #memoryClient: LLMClient | null;
  readonly #maxIterations: number;
  // trace 写入器与每 profile 的投影 tap；组合根未注入观测目录时保持 null，测试因此不写用户主目录。
  #traceWriter: TraceWriter | null = null;
  #tap: AgentTraceTap | null = null;
  // 技能与命令使用统计（JSONL）；可丢弃数据。
  readonly #usage: UsageRecorder | null;

  constructor(client: LLMClient, repository: SessionRepositoryContract, tools: ControllerToolSystem | null = null, runner?: AgentRunner, options: {workspaceRoot?: string; maxIterations?: number; observability?: {traceDirectory: string; usagePath: string}} = {}) {
    this.#repository = repository; this.#client = client; this.#workspaceRoot = options.workspaceRoot ?? process.cwd();
    // 观测面只在组合根显式给出目录时启用；缺省完全关闭，测试不污染用户主目录。
    if (options.observability !== undefined) {
      this.#traceWriter = new TraceWriter(options.observability.traceDirectory);
      this.#usage = new UsageRecorder(options.observability.usagePath, this.#workspaceRoot);
    } else {
      this.#usage = null;
    }
    const registry = tools?.registry ?? new ToolRegistry(); const approvals = tools?.approvals ?? new ApprovalCoordinator();
    const executor = tools?.executor ?? new ToolExecutor(registry, {workspaceRoot: this.#workspaceRoot, limits: fixedToolLimits});
    this.#tools = {registry, approvals, executor, ...(tools?.permissions === undefined && executor.options.permissions === undefined ? {} : {permissions: tools?.permissions ?? executor.options.permissions})};
    const withServices: ControllerToolSystemWithServices | null = tools;
    this.#services = withServices?.services ?? null;
    this.#memoryClient = withServices?.memoryClient ?? null;
    this.#commands = loadUserCommands(this.#workspaceRoot, undefined, createDefaultRegistry());
    this.#runner = runner ?? new AgentRunner(client, registry, new StreamCollector(), new SafetyBatchScheduler(executor, approvals, undefined, this.#services?.hooks ?? null), this.#services?.hooks ?? null);
    this.#maxIterations = options.maxIterations ?? 20;
  }
  getState(): AppState { return this.#state; }
  traceStats(): ReturnType<TraceWriter['statsFor']> | null {
    return this.#state.session && this.#traceWriter ? this.#traceWriter.statsFor(this.#state.session.id) : null;
  }
  subscribe(listener: StateListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async initialize(profile: ProviderProfile): Promise<void> {
    if (this.#profile) return; this.#profile = profile; await this.#repository.initialize();
    // profile 就绪后创建 trace tap；真实路径沙箱与 trace 共用工作目录事实。
    if (this.#traceWriter !== null && this.#usage !== null) {
      const usageRecorder = this.#usage;
      this.#tap = new AgentTraceTap(this.#traceWriter, {profileName: profile.name, model: profile.model, protocol: profile.protocol, workspaceRoot: this.#workspaceRoot, onSkillActivated: (name, sessionId) => {
        usageRecorder.record({kind: 'skill', name, source: 'model', sessionId, profileName: profile.name});
      }});
    }
    this.#rebuildSystemPrompt();
    const session = await this.#repository.findLatestSession(profile.name) ?? await this.#repository.createSession(profile.name);
    const conversation = await this.#repository.getConversation(session.id);
    const messages = conversation?.messages ?? await this.#repository.getMessages(session.id);
    await this.#services?.hooks.fire('session_start', {event: 'session_start', message: session.id});
    this.#publish({...initialAppState(toProfileSummary(profile)), session, agentMode: session.agentMode, permissionTier: this.#tools.permissions?.tier ?? 'default', messages, toolCalls: conversation?.toolCalls ?? [], ...restoredRunState(messages, conversation?.agentRuns ?? [])});
  }
  async sendMessage(text: string): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#active) { this.#error('已有请求正在进行'); return; }
    if (!text.trim() || !this.#state.session) return;
    const abortController = new AbortController();
    const active: ActiveRequest = {abortController, promise: Promise.resolve()};
    this.#active = active;
    active.promise = Promise.resolve().then(() => this.#sendMessage(text, abortController.signal)).catch(error => {
      if (!abortController.signal.aborted) this.#publish({...this.#state, requestStatus: 'failed', activeRunId: null, visibleError: errorMessage(error)});
    }).finally(() => { if (this.#active === active) this.#active = null; if (abortController.signal.aborted && this.#state.requestStatus === 'cancelling') this.#publish({...this.#state, requestStatus: 'idle', activeRunId: null}); });
    await active.promise;
  }
  async #sendMessage(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const parsed = parseCommand(text);
    if (parsed !== null) {
      const known = this.#commands.find(parsed.name);
      if (!known) { this.#error(`未知命令：${text.trim()}。输入 /help 查看可用命令`); return; }
      // 命令使用统计与 trace 事实；prompt 与 local 命令都算一次使用。
      this.#usage?.record({kind: 'command', name: known.name, source: 'user', sessionId: this.#state.session?.id ?? '', ...(this.#profile === null ? {} : {profileName: this.#profile.name})});
      if (this.#state.session) this.#tap?.fact(this.#state.session.id, 'command_executed', {name: known.name});
      if (known.type === 'prompt') { await this.#startRun(text, known.handler({workDir: this.#workspaceRoot, args: parsed.args}), 'message', signal); return; }
      if (known.action === 'permission') {
        const tier = permissionTierArgument(parsed.args);
        if (tier) this.#setPermissionTier(tier); else this.#error('权限档必须是 strict、default 或 bypass');
        return;
      }
      if (parsed.args) { this.#error(`/${known.name} 不接受参数`); return; }
      if (known.action === 'plan') { await this.#setMode('plan'); return; }
      if (known.action === 'do') { await this.#setMode('execute'); if (!this.#state.session?.latestPlanMessageId) { this.#error('当前会话没有可执行计划'); return; } await this.#startRun('/do', '根据当前会话中的最近计划立即执行。', 'do', signal); return; }
      if (known.action === 'compact') { await this.#compactConversation(signal); return; }
      this.#error(this.#commands.listCommands().map(command => `/${command.name}：${command.description}`).join('\n'));
      return;
    }
    await this.#startRun(text, text, 'message', signal);
  }
  /** 空闲时手动压缩；不发起普通对话请求，只额外调用一次摘要模型。 */
  async #compactConversation(signal: AbortSignal): Promise<void> {
    const session = this.#state.session; if (!session || !this.#profile) return;
    const conversation = await this.#repository.getConversation(session.id); if (!conversation) { this.#error('无法读取当前会话上下文'); return; }
    const items = AgentContext.fromConversation(conversation).items();
    const tools = this.#tools.registry.definitions();
    const result = await manageContext({items, client: this.#client, contextWindow: effectiveContextWindow(this.#profile.protocol, this.#profile.contextWindow), tracking: {consecutiveFailures: 0}, tools, anchor: null, signal}, {force: true, safetyMargin: 3_000});
    if (result.compacted) {
      const boundaryMessageId = compactionBoundaryMessageId(items, result.keepIndex);
      if (signal.aborted) return;
      await this.#repository.saveContextCheckpoint(session.id, {boundaryMessageId, items: result.checkpointItems});
    }
    if (signal.aborted) return;
    await this.#services?.hooks.fire('compact', {event: 'compact', message: result.compacted ? `${result.beforeTokens} -> ${result.afterTokens}` : result.reason});
    if (result.compacted) this.#error(`上下文已压缩：估算 ${result.beforeTokens} → ${result.afterTokens} tokens`);
    else this.#error(`上下文未压缩：${result.reason}`);
  }

  async #startRun(displayText: string, instruction: string, trigger: 'message' | 'do', signal: AbortSignal): Promise<void> {
    const session = this.#state.session; if (!session) return; const runId = createId();
    try {
    if (signal.aborted) return;
    const begun = await this.#repository.beginAgentRun({runId, sessionId: session.id, displayText, instruction, mode: this.#state.agentMode});
    // run 元信息入 trace：模型/协议/模式/触发方式。
    this.#tap?.runHeader(session.id, runId, this.#state.agentMode, trigger);
    this.#publish({...this.#state, messages: [...this.#state.messages, begun.userMessage], requestStatus: 'streaming', latestUsage: null, runUsage: {inputTokens: 0, outputTokens: 0}, visibleError: null});
    const conversation = await this.#repository.getConversation(session.id); if (!conversation) throw new Error('Agent 回合创建后无法恢复会话');
    // Plan 轮次由会话 run 记录推导（本次 run 已入库）；reminders 只由模式与轮次决定，请求级注入、不持久化。
    const reminders = buildReminders(this.#state.agentMode, this.#state.agentMode === 'plan' ? trailingPlanRuns(conversation.agentRuns) : 0);
    await this.#consume(runId, begun.userMessage.id, instruction, trigger, AgentContext.fromConversation(conversation), signal, reminders);
    } catch (error) {
      const cancelled = signal.aborted;
      const reason: AgentStopReason = cancelled ? 'user_cancelled' : errorMessage(error).includes('上下文压缩失败') ? 'context_compact_failed' : error instanceof StorageError ? 'storage_error' : 'stream_error';
      const result: AgentRunResult = {runId, status: cancelled ? 'cancelled' as const : 'failed' as const, stopReason: reason, iterationCount: this.#state.iteration, usage: this.#state.runUsage, finalIterationId: null};
      let detail = errorMessage(error);
      try {
        await this.#repository.abortAgentRun(runId, result, detail);
        const conversation = await this.#repository.getConversation(session.id);
        if (conversation) this.#publish({...this.#state, messages: conversation.messages, toolCalls: conversation.toolCalls});
      } catch (storageError) { detail += `；无法持久化终态：${errorMessage(storageError)}`; logger.warn('Agent 终态写入失败', {runId, error: errorMessage(storageError)}); }
      this.#publish({...this.#state, requestStatus: cancelled ? 'idle' : 'failed', activeRunId: null, approvalPrompt: null, stopReason: reason, visibleError: detail});
    }
  }
  async #consume(runId: string, userMessageId: string, instruction: string, trigger: 'message' | 'do', context: AgentContext, signal: AbortSignal, reminders: string[]): Promise<void> {
    const session = this.#state.session!; const projector = new AgentEventProjector(this.#repository, this.#state, state => this.#publish(state), this.#state.agentMode);
    const generator = this.#runner.run({runId, userMessageId, sessionId: session.id, trigger, mode: this.#state.agentMode, instruction, context: [...context.items()], ...(this.#systemBlocks ? {system: this.#systemBlocks} : {}), reminders, limits: {maxIterations: this.#maxIterations, maxUnknownToolIterations: 3}, ...(this.#profile ? {contextManagement: {windowTokens: effectiveContextWindow(this.#profile.protocol, this.#profile.contextWindow), workspaceRoot: this.#workspaceRoot}} : {})}, signal);
    let finished = false;
    while (true) {
      const step = await generator.next();
      if (step.done) break;
      if (step.value.type === 'run_finished') finished = true;
      // trace 订阅者同步火后不理，不进入持久化屏障。
      this.#tap?.record(step.value);
      await projector.project(step.value);
    }
    if (!finished) throw new Error('Agent 未生成终态事件');
    const restored = await this.#repository.getSession(session.id); if (restored) this.#publish({...this.#state, session: restored, agentMode: restored.agentMode});
    // 回合自然停止后异步提取记忆；提取失败不影响本轮结果。
    if (this.#services && this.#profile && this.#memoryClient) {
      const dialogue = [...this.#state.messages].slice(-20).map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n');
      // 记忆提取失败记录日志，不影响当前回合。
      void this.#services.memoryExtractor(this.#memoryClient).extract(dialogue).catch((error: unknown) => { logger.warn('记忆提取失败', {error: errorMessage(error)}); });
    }
  }
  async cancelActiveRequest(): Promise<void> { const active = this.#active; if (!active) return; if (active.abortController.signal.aborted) { await active.promise; return; } this.#publish({...this.#state, requestStatus: 'cancelling'}); active.abortController.abort(); this.#tools.approvals.interruptAll(); await active.promise; }
  resolveToolApproval(decision: ApprovalDecision): void { const prompt = this.#state.approvalPrompt; if (prompt) this.#tools.approvals.resolve(prompt.callId, decision); }
  setPermissionTier(tier: PermissionTier): void { this.#setPermissionTier(tier); }
  async createSession(): Promise<void> { if (!this.#canChangeSession() || !this.#profile) return; const profile = this.#profile; await this.#changeSession(async signal => { this.#rebuildSystemPrompt(); const session = await this.#repository.createSession(profile.name); if (signal.aborted) return; this.#tap?.fact(session.id, 'session_created', {profileName: profile.name}); await this.#publishSession(session, [], [], [], signal); }); }
  async listSessions(): Promise<Session[]> { return this.#profile ? this.#repository.listSessions(this.#profile.name) : []; }
  async switchSession(sessionId: string): Promise<void> { if (!this.#canChangeSession() || !this.#profile) return; const profile = this.#profile; await this.#changeSession(async signal => { const session = await this.#repository.getSession(sessionId); if (signal.aborted) return; if (!session || session.profileName !== profile.name) { this.#error('该会话不属于当前 profile'); return; } this.#rebuildSystemPrompt(); const conversation = await this.#repository.getConversation(session.id); const messages = conversation?.messages ?? await this.#repository.getMessages(session.id); if (signal.aborted) return; this.#tap?.fact(session.id, 'session_switched', {profileName: profile.name}); await this.#publishSession(session, messages, conversation?.toolCalls ?? [], conversation?.agentRuns ?? [], signal); }); }
  setScreen(screen: AppState['screen']): void { this.#publish({...this.#state, screen}); }
  /** 调试面板开关；面板内容在渲染时通过 debugEntries/activeSkills 实时读取。 */
  toggleDebugPanel(): void { this.#publish({...this.#state, debugOpen: !this.#state.debugOpen}); }
  debugEntries(limit = 30): DebugEntry[] { return this.#tap?.recentDebugEntries(limit) ?? []; }
  activeSkills(): string[] { return this.#services?.activeSkills.list().map(skill => skill.name) ?? []; }
  selectMessage(messageId: string | null): void { this.#publish({...this.#state, selectedMessageId: messageId}); }
  toggleThinking(messageId: string): void { const expanded = new Set(this.#state.expandedThinkingIds); if (expanded.has(messageId)) expanded.delete(messageId); else expanded.add(messageId); this.#publish({...this.#state, expandedThinkingIds: expanded}); }
  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      this.#closed = true;
      const errors: unknown[] = [];
      for (const cleanup of [
        async () => { if (this.#active) await this.cancelActiveRequest(); },
        async () => { await this.#services?.close(); },
        async () => { await this.#services?.hooks.fire('shutdown', {event: 'shutdown'}); },
        async () => { await this.#tap?.flush(); },
        async () => { await this.#usage?.flush(); },
        async () => { await this.#repository.close(); },
      ]) { try { await cleanup(); } catch (error) { errors.push(error); } }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, '关闭控制器时多个步骤失败');
    })();
    return this.#shutdownPromise;
  }
  async #setMode(mode: 'plan' | 'execute'): Promise<void> { const session = this.#state.session; if (!session) return; const updated = await this.#repository.setSessionMode(session.id, mode); this.#tap?.fact(session.id, 'mode_switch', {mode}); this.#publish({...this.#state, session: updated, agentMode: mode, visibleError: null}); }
  #setPermissionTier(tier: PermissionTier): void { if (!this.#tools.permissions) { this.#error('当前工具系统未启用权限引擎'); return; } this.#tools.permissions.setTier(tier); this.#publish({...this.#state, permissionTier: tier, visibleError: null}); }
  /** 会话激活时采集环境并冻结系统提示；同一会话内逐字节稳定，保证 Anthropic 可缓存前缀不被破坏。 */
  #rebuildSystemPrompt(): void {
    if (!this.#profile) { this.#systemBlocks = null; return; }
    this.#systemBlocks = buildSessionPrompt(this.#profile, this.#workspaceRoot, this.#services);
  }
  async #changeSession(change: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const abortController = new AbortController();
    const active: ActiveRequest = {abortController, promise: Promise.resolve()}; this.#active = active;
    active.promise = Promise.resolve().then(() => change(abortController.signal)).finally(() => { if (this.#active === active) this.#active = null; if (abortController.signal.aborted && this.#state.requestStatus === 'cancelling') this.#publish({...this.#state, requestStatus: 'idle'}); });
    await active.promise;
  }
  #canChangeSession(): boolean { if (this.#closed) return false; if (this.#active) { this.#error('生成期间不能新建或切换会话'); return false; } return true; }
  async #publishSession(session: Session, messages: StoredMessage[], toolCalls: ToolCallRecord[] = [], agentRuns: AgentRunRecord[] = [], signal?: AbortSignal): Promise<void> { await this.#services?.hooks.fire('session_end', {event: 'session_end'}); if (signal?.aborted) return; this.#publish({...this.#state, screen: 'chat', session, agentMode: session.agentMode, permissionTier: this.#tools.permissions?.tier ?? 'default', messages, toolCalls, requestStatus: 'idle', ...restoredRunState(messages, agentRuns), activeRunId: null, iteration: 0, agentPhase: null, expandedThinkingIds: new Set(), selectedMessageId: null, visibleError: null, approvalPrompt: null}); }
  #error(message: string): void { this.#publish({...this.#state, visibleError: message}); }
  #publish(state: AppState): void { if (state === this.#state) return; this.#state = state; for (const listener of this.#listeners) listener(state); }
}

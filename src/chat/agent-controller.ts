import {toProfileSummary} from '../config/types.js';
import type {ProviderProfile} from '../config/types.js';
import type {LLMClient, ModelMessageItem, Usage} from '../providers/types.js';
import type {ImageAttachment} from '../attachments/images.js';
import type {AgentRunRecord, Session, SessionRepositoryContract, StoredConversation, StoredMessage, ToolCallRecord} from '../storage/types.js';
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
import type {SnapshotStore} from '../tools/snapshots.js';
import type {AgentServices} from '../agent/services.js';
import type {AgentRunResult, AgentStopReason} from '../agent/types.js';
import {createDefaultRegistry, parseCommand, permissionTierArgument, type CommandRegistry} from '../commands/registry.js';
import {loadUserCommands} from '../commands/loader.js';
import {isWorkspaceTrusted} from '../config/trust.js';
import {createSessionArchive, parseSessionArchive} from '../storage/archive.js';

type StateListener = (state: AppState) => void;
export interface CommandSummary {
  name: string;
  aliases: string[];
  description: string;
  argumentHint?: string;
}
const logger = getLogger('chat');
interface ControllerToolSystem {registry: ToolRegistry; executor: ToolExecutor; approvals: ApprovalCoordinator; permissions?: PermissionEngine; snapshots?: SnapshotStore}
interface ControllerToolSystemWithServices extends ControllerToolSystem {services?: AgentServices; memoryClient?: LLMClient}
interface ActiveRequest {abortController: AbortController; promise: Promise<void>}

/** 恢复会话时，状态栏继续显示最近一次 Agent 回合的累计用量和停止原因。 */
function restoredRunState(messages: readonly StoredMessage[], runs: readonly AgentRunRecord[]): Pick<AppState, 'latestUsage' | 'runUsage' | 'stopReason'> {
  const latestRun = runs.at(-1);
  const latestUsage = messages.findLast(message => message.usage !== null)?.usage ?? null;
  return {
    latestUsage,
    runUsage: latestRun === undefined ? {inputTokens: 0, outputTokens: 0} : runUsage(latestRun),
    stopReason: latestRun?.stopReason ?? null,
  };
}

/** 统计会话 run 记录尾部连续 plan 模式 run 数；调用前本次 run 已入库，计数即本轮 Plan 轮次，/do 产生的 execute run 天然打断连续序列。 */
function trailingPlanRuns(runs: readonly AgentRunRecord[]): number {
  let count = 0;
  for (let index = runs.length - 1; index >= 0 && runs[index]!.mode === 'plan'; index--) count++;
  return count;
}

const RECOVERY_READ_TOOLS = new Set(['read_file', 'find_files', 'search_text']);

function runUsage(run: AgentRunRecord): Usage {
  return {inputTokens: run.inputTokens, outputTokens: run.outputTokens, ...(run.credits === null ? {} : {credits: run.credits})};
}

function uncertainEffectCalls(runId: string, calls: readonly ToolCallRecord[]): ToolCallRecord[] {
  return calls.filter(call => call.agentRunId === runId
    && !RECOVERY_READ_TOOLS.has(call.toolName)
    && (call.executionStatus === 'queued' || call.executionStatus === 'running' || call.executionStatus === 'interrupted'
      || call.executionStatus === 'timed_out' || (call.executionStatus === 'failed' && call.approvalStatus === 'approved')));
}

/** A started but uncommitted model turn has no replayable assistant result, so retry that same turn. */
function recoveryIterationOffset(run: AgentRunRecord, messages: readonly StoredMessage[]): number {
  const persisted = messages.reduce((highest, message) => {
    if (message.agentRunId !== run.id || message.role !== 'assistant' || message.iteration == null) return highest;
    const replayable = message.status === 'completed' || (message.status === 'cancelled' && message.content.length > 0);
    return replayable ? Math.max(highest, message.iteration) : highest;
  }, 0);
  return Math.min(run.iterationCount, persisted);
}

function completedFinalIteration(run: AgentRunRecord, conversation: StoredConversation, uncertain: readonly ToolCallRecord[]): StoredMessage | null {
  if (uncertain.length > 0) return null;
  const index = conversation.messages.findLastIndex(message => message.agentRunId === run.id && message.role === 'assistant');
  const message = conversation.messages[index];
  if (message === undefined || message.status !== 'completed' || message.iteration !== run.iterationCount) return null;
  if (conversation.toolCalls.some(call => call.assistantMessageId === message.id)) return null;
  if (conversation.messages.slice(index + 1).some(item => item.role === 'user' && item.agentRunId === run.id)) return null;
  return message;
}

function instructionFor(text: string, attachments: readonly ImageAttachment[]): string {
  return text.trim() ? text : attachments.length > 0 ? '请分析图片附件。' : text;
}

function displayTextFor(text: string, attachments: readonly ImageAttachment[]): string {
  if (text.trim()) return text;
  return attachments.length > 0 ? `图片附件：${attachments.map(image => image.name).join('、')}` : text;
}

function queuedMessageSummary(text: string, attachments: readonly ImageAttachment[]): string {
  if (attachments.length === 0) return text;
  const summary = `图片：${attachments.map(image => image.name).join('、')}`;
  return text.trim() ? `${text}（${summary}）` : summary;
}

function recoveryReminder(calls: readonly ToolCallRecord[]): string {
  const names = [...new Set(calls.map(call => call.toolName))].join('、');
  return `【进程恢复确认】以下非只读工具在中断时结果不确定：${names}。旧调用不会自动重放；请先用只读方式检查外部状态，再决定下一步。`;
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
  /** 生成中排队、等待注入模型的用户消息。 */
  #pendingSteers: Array<{text: string; attachments: ImageAttachment[]}> = [];
  #shutdownPromise: Promise<void> | null = null;
  #closed = false;
  readonly #commands: CommandRegistry;
  readonly #services: AgentServices | null;
  readonly #memoryClient: LLMClient | null;
  readonly #maxIterations: number;
  readonly #autoResume: boolean;
  #pendingBypassExpiresAt = 0;
  // trace 写入器与每 profile 的投影 tap；组合根未注入观测目录时保持 null，测试因此不写用户主目录。
  #traceWriter: TraceWriter | null = null;
  #tap: AgentTraceTap | null = null;
  // 技能与命令使用统计（JSONL）；可丢弃数据。
  readonly #usage: UsageRecorder | null;
  #pendingBypassSessionId: string | null = null;

  constructor(client: LLMClient, repository: SessionRepositoryContract, tools: ControllerToolSystem | null = null, runner?: AgentRunner, options: {workspaceRoot?: string; maxIterations?: number; autoResume?: boolean; observability?: {traceDirectory: string; usagePath: string}} = {}) {
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
    this.#tools = {registry, approvals, executor, ...(tools?.permissions === undefined && executor.options.permissions === undefined ? {} : {permissions: tools?.permissions ?? executor.options.permissions}), ...(tools?.snapshots === undefined ? {} : {snapshots: tools.snapshots})};
    const withServices: ControllerToolSystemWithServices | null = tools;
    this.#services = withServices?.services ?? null;
    this.#memoryClient = withServices?.memoryClient ?? null;
    this.#commands = loadUserCommands(this.#workspaceRoot, undefined, createDefaultRegistry(), this.#services?.projectTrusted ?? isWorkspaceTrusted(this.#workspaceRoot));
    this.#runner = runner ?? new AgentRunner(client, registry, new StreamCollector(), new SafetyBatchScheduler(executor, approvals, undefined, this.#services?.hooks ?? null), this.#services?.hooks ?? null);
    this.#maxIterations = options.maxIterations ?? 20;
    this.#autoResume = options.autoResume ?? true;
  }
  getState(): AppState { return this.#state; }
  /** 供输入框命令面板展示；包括内置命令与用户 Markdown 命令。 */
  commandCatalog(): CommandSummary[] {
    const commands = this.#commands.listCommands().map(command => ({
      name: command.name,
      aliases: [...command.aliases],
      description: command.description,
      ...(command.argumentHint === undefined ? {} : {argumentHint: command.argumentHint}),
    }));
    return [...commands,
      {name: 'attach', aliases: [], description: '附加图片到下一条消息', argumentHint: '[path]'},
      {name: 'attachments', aliases: [], description: '清除待发送图片附件', argumentHint: 'clear'},
      {name: 'import', aliases: [], description: '导入会话归档', argumentHint: '<path>'},
      {name: 'export', aliases: [], description: '导出当前会话归档', argumentHint: '<path>'},
      {name: 'resume', aliases: [], description: '恢复中断的 Agent 任务'},
    ];
  }
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
    this.#publish({...initialAppState(toProfileSummary(profile)), session, agentMode: session.agentMode, permissionTier: this.#tools.permissions?.tierFor(session.id) ?? 'default', messages, toolCalls: conversation?.toolCalls ?? [], ...restoredRunState(messages, conversation?.agentRuns ?? [])});
    await this.#prepareRecovery(this.#autoResume);
  }
  async sendMessage(text: string, attachments: ImageAttachment[] = []): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#rejectQoderImages(attachments)) return;
    if (this.#active) { this.#error('已有请求正在进行'); return; }
    if ((!text.trim() && attachments.length === 0) || !this.#state.session) return;
    if (this.#state.recovery) { this.#error('请先恢复当前会话中的中断任务'); return; }
    const abortController = new AbortController();
    const active: ActiveRequest = {abortController, promise: Promise.resolve()};
    this.#active = active;
    active.promise = Promise.resolve().then(() => this.#sendMessage(text, attachments, abortController.signal)).catch(error => {
      if (!abortController.signal.aborted) this.#publish({...this.#state, requestStatus: 'failed', activeRunId: null, visibleError: errorMessage(error)});
    }).finally(() => { if (this.#active === active) this.#active = null; if (abortController.signal.aborted && this.#state.requestStatus === 'cancelling') this.#publish({...this.#state, requestStatus: 'idle', activeRunId: null}); });
    await active.promise;
    // 回合结束后，把还没来得及注入的排队消息作为下一回合发出。
    await this.#flushPendingSteers();
  }
  /**
   * 生成中发送新消息：排队后由 runner 在当前回合的下一个边界注入，模型在同一回合里读到；
   * 回合若先结束，剩余排队消息由 #flushPendingSteers 作为下一回合发出。
   */
  async steerMessage(text: string, attachments: ImageAttachment[] = []): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#rejectQoderImages(attachments)) return;
    if (!text.trim() && attachments.length === 0) return;
    if (this.#active === null) { await this.sendMessage(text, attachments); return; }
    this.#pendingSteers.push({text, attachments: [...attachments]});
    this.#publish({...this.#state, queuedMessages: this.#pendingSteers.map(item => queuedMessageSummary(item.text, item.attachments))});
  }
  /** 回合结束后依次发出排队消息；每条都是独立回合，顺序保持不变。 */
  async #flushPendingSteers(): Promise<void> {
    while (this.#pendingSteers.length > 0 && !this.#closed) {
      const next = this.#pendingSteers.shift()!;
      this.#publish({...this.#state, queuedMessages: this.#pendingSteers.map(item => queuedMessageSummary(item.text, item.attachments))});
      await this.sendMessage(next.text, next.attachments);
    }
  }
  /**
   * runner 每轮迭代调用：排队消息先落库再进入上下文，保证会话记录与模型看到的内容一致。
   */
  async #takePendingSteers(runId: string): Promise<ModelMessageItem[]> {
    if (this.#pendingSteers.length === 0) return [];
    const session = this.#state.session;
    if (!session) return [];
    const pending = this.#pendingSteers.splice(0, this.#pendingSteers.length);
    const items: ModelMessageItem[] = [];
    const stored: StoredMessage[] = [];
    for (const queued of pending) {
      const attachments = queued.attachments;
      const content = instructionFor(queued.text, attachments);
      const message = await this.#repository.appendSteerMessage({runId, sessionId: session.id, content, ...(attachments.length === 0 ? {} : {attachments})});
      stored.push(message);
      items.push({type: 'message', role: 'user', messageId: message.id, content: message.content, ...(message.attachments === undefined || message.attachments.length === 0 ? {} : {attachments: message.attachments})});
    }
    this.#publish({...this.#state, messages: [...this.#state.messages, ...stored], queuedMessages: this.#pendingSteers.map(item => queuedMessageSummary(item.text, item.attachments))});
    return items;
  }
  /** UI 调用即代表用户确认继续处理结果不确定的副作用。 */
  async resumeInterruptedRun(): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    const recovery = this.#state.recovery;
    if (recovery === null) return;
    await this.#activateRecovery(recovery.runId, recovery.requiresConfirmation);
  }
  async #prepareRecovery(autoResume: boolean): Promise<void> {
    if (this.#closed) return;
    const session = this.#state.session;
    if (session === null) return;
    const active = this.#active;
    const conversation = await this.#repository.getConversation(session.id);
    if (this.#closed || this.#state.session?.id !== session.id || this.#active !== active) return;
    if (conversation === null || conversation.agentRuns.some(run => run.status === 'running')) {
      if (this.#state.recovery !== null) this.#publish({...this.#state, recovery: null});
      return;
    }
    const candidate = conversation.agentRuns.at(-1);
    if (candidate === undefined || candidate.status !== 'interrupted' || candidate.stopReason !== 'process_interrupted') {
      if (this.#state.recovery !== null) this.#publish({...this.#state, recovery: null});
      return;
    }
    const uncertain = uncertainEffectCalls(candidate.id, conversation.toolCalls);
    const requiresConfirmation = uncertain.length > 0;
    this.#publish({
      ...this.#state,
      agentMode: candidate.mode,
      iteration: candidate.iterationCount,
      maxIterations: this.#maxIterations,
      runUsage: runUsage(candidate),
      stopReason: candidate.stopReason,
      recovery: {
        runId: candidate.id,
        requiresConfirmation,
        message: requiresConfirmation
          ? '任务中断时有写入或命令结果不确定；确认后才会继续。'
          : autoResume ? '检测到安全中断任务，正在自动恢复。' : '检测到可恢复任务。',
      },
    });
    if (autoResume && !requiresConfirmation && this.#active === null) {
      void this.#activateRecovery(candidate.id, false).catch(error => logger.warn('自动恢复启动失败', {runId: candidate.id, error: errorMessage(error)}));
    }
  }
  async #activateRecovery(runId: string, allowUncertainEffects: boolean): Promise<void> {
    if (this.#closed) return;
    if (this.#active !== null) { this.#error('当前请求进行中，稍后再恢复中断任务'); return; }
    const abortController = new AbortController();
    const active: ActiveRequest = {abortController, promise: Promise.resolve()};
    this.#active = active;
    active.promise = Promise.resolve().then(() => this.#resumeClaimedRun(runId, allowUncertainEffects, abortController.signal)).catch(error => {
      if (!abortController.signal.aborted) this.#publish({...this.#state, requestStatus: 'failed', activeRunId: null, visibleError: errorMessage(error)});
    }).finally(() => {
      if (this.#active === active) this.#active = null;
      if (abortController.signal.aborted && this.#state.requestStatus === 'cancelling') this.#publish({...this.#state, requestStatus: 'idle', activeRunId: null});
    });
    await active.promise;
    await this.#flushPendingSteers();
  }
  async #resumeClaimedRun(runId: string, allowUncertainEffects: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const claimed = await this.#repository.claimInterruptedRun(runId, allowUncertainEffects);
    if (claimed === null) { await this.#prepareRecovery(false); return; }
    const session = this.#state.session;
    try {
      if (session === null || session.id !== claimed.sessionId) throw new Error('中断任务不属于当前会话');
      const conversation = await this.#repository.getConversation(claimed.sessionId);
      if (conversation === null) throw new Error('无法读取中断任务的会话上下文');
      const run = conversation.agentRuns.find(item => item.id === claimed.id);
      if (run === undefined || run.status !== 'running') throw new Error('恢复任务已不再处于运行状态');
      const userMessage = conversation.messages.find(message => message.id === run.userMessageId);
      if (userMessage === undefined) throw new Error('恢复任务缺少原始用户消息');
      const iterationOffset = recoveryIterationOffset(run, conversation.messages);
      const uncertain = uncertainEffectCalls(run.id, conversation.toolCalls);
      const instruction = userMessage.content || instructionFor('', userMessage.attachments ?? []);
      const reminders = buildReminders(run.mode, run.mode === 'plan' ? trailingPlanRuns(conversation.agentRuns) : 0);
      if (allowUncertainEffects && uncertain.length > 0) reminders.push(recoveryReminder(uncertain));
      const usage = runUsage(run);
      this.#publish({...this.#state, recovery: null, activeRunId: run.id, agentMode: run.mode, iteration: run.iterationCount, maxIterations: this.#maxIterations, runUsage: usage, requestStatus: 'streaming', visibleError: null, stopReason: null});
      this.#tap?.runHeader(session.id, run.id, run.mode, 'resume');
      const finishedMessage = completedFinalIteration(run, conversation, uncertain);
      if (finishedMessage !== null) {
        const result: AgentRunResult = {runId: run.id, status: 'completed', stopReason: 'natural_completion', iterationCount: run.iterationCount, usage, finalIterationId: finishedMessage.id};
        const latestPlan = run.mode === 'plan' ? finishedMessage.id : undefined;
        await this.#repository.finishAgentRun(run.id, result, latestPlan);
        const refreshed = await this.#repository.getConversation(session.id);
        this.#publish({...this.#state, ...(refreshed === null ? {} : {messages: refreshed.messages, toolCalls: refreshed.toolCalls}), requestStatus: 'idle', activeRunId: null, iteration: run.iterationCount, runUsage: usage, stopReason: 'natural_completion', visibleError: null, liveToolCalls: [], approvalPrompt: null, recovery: null});
        return;
      }
      await this.#consume(run.id, run.userMessageId, instruction, 'resume', AgentContext.fromConversation(conversation), signal, reminders, {iterationCount: iterationOffset, usage});
    } catch (error) {
      const cancelled = signal.aborted;
      const reason: AgentStopReason = cancelled ? 'user_cancelled' : errorMessage(error).includes('上下文压缩失败') ? 'context_compact_failed' : error instanceof StorageError ? 'storage_error' : 'stream_error';
      const result: AgentRunResult = {runId, status: cancelled ? 'cancelled' : 'failed', stopReason: reason, iterationCount: this.#state.iteration, usage: this.#state.runUsage, finalIterationId: null};
      let detail = errorMessage(error);
      try {
        await this.#repository.abortAgentRun(runId, result, detail);
        const refreshed = await this.#repository.getConversation(claimed.sessionId);
        if (refreshed !== null) this.#publish({...this.#state, messages: refreshed.messages, toolCalls: refreshed.toolCalls, liveToolCalls: []});
      } catch (storageError) { detail += `；无法持久化终态：${errorMessage(storageError)}`; logger.warn('Agent 恢复终态写入失败', {runId, error: errorMessage(storageError)}); }
      this.#publish({...this.#state, requestStatus: cancelled ? 'idle' : 'failed', activeRunId: null, stopReason: reason, visibleError: detail, liveToolCalls: [], approvalPrompt: null, recovery: null});
    }
  }
  async #sendMessage(text: string, attachments: ImageAttachment[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const parsed = attachments.length === 0 ? parseCommand(text) : null;
    const currentSessionId = this.#state.session?.id ?? null;
    const parsedCommand = parsed === null ? null : this.#commands.find(parsed.name);
    const commandAction = parsedCommand !== null && parsedCommand !== undefined && 'action' in parsedCommand ? parsedCommand.action : undefined;
    const confirmingBypass = commandAction === 'permission' && parsed?.args === 'bypass confirm'
      && currentSessionId !== null && this.#pendingBypassSessionId === currentSessionId;
    if (!confirmingBypass) {
      this.#pendingBypassExpiresAt = 0;
      this.#pendingBypassSessionId = null;
    }
    if (parsed !== null) {
      const known = parsedCommand;
      if (!known) { this.#error(`未知命令：${text.trim()}。输入 /help 查看可用命令`); return; }
      // 命令使用统计与 trace 事实；prompt 与 local 命令都算一次使用。
      this.#usage?.record({kind: 'command', name: known.name, source: 'user', sessionId: this.#state.session?.id ?? '', ...(this.#profile === null ? {} : {profileName: this.#profile.name})});
      if (this.#state.session) this.#tap?.fact(this.#state.session.id, 'command_executed', {name: known.name});
      if (known.type === 'prompt') { await this.#startRun(text, known.handler({workDir: this.#workspaceRoot, args: parsed.args}), 'message', signal); return; }
      if (known.action === 'permission') {
        if (parsed.args === 'bypass') {
          if (currentSessionId === null) { this.#error('请先打开会话，再启用放行档。'); return; }
          this.#pendingBypassExpiresAt = Date.now() + 60_000;
          this.#pendingBypassSessionId = currentSessionId;
          this.#error('放行档会跳过逐项审批，并只在当前聊天有效。二次确认前请检查命令和工作区来源，再输入 /permission bypass confirm；一分钟后确认失效。');
          return;
        }
        if (parsed.args === 'bypass confirm') {
          if (this.#pendingBypassSessionId !== currentSessionId || this.#pendingBypassExpiresAt < Date.now()) {
            this.#error('放行档确认已过期；如仍需要，请重新输入 /permission bypass。');
            return;
          }
          this.#pendingBypassExpiresAt = 0;
          this.#pendingBypassSessionId = null;
          this.#setPermissionTier('bypass');
          return;
        }
        const tier = permissionTierArgument(parsed.args);
        if (tier === 'bypass') {
          this.#error('放行档只能通过 /permission bypass 后再输入 /permission bypass confirm 启用。');
          return;
        }
        if (tier) this.#setPermissionTier(tier); else this.#error('权限档必须是 strict、default、bypass 或 bypass confirm');
        return;
      }
      if (known.action === 'undo') {
        const result = await this.undoLastEdit(parsed.args === '' ? undefined : parsed.args);
        this.#error(result.message);
        return;
      }
      if (parsed.args) { this.#error(`/${known.name} 不接受参数`); return; }
      if (known.action === 'plan') { await this.#setMode('plan'); return; }
      if (known.action === 'do') { await this.#setMode('execute'); if (!this.#state.session?.latestPlanMessageId) { this.#error('当前会话没有可执行计划'); return; } await this.#startRun('/do', '根据当前会话中的最近计划立即执行。', 'do', signal); return; }
      if (known.action === 'compact') { await this.#compactConversation(signal); return; }
      this.#error(this.#commands.listCommands().map(command => `/${command.name}：${command.description}`).join('\n'));
      return;
    }
    await this.#startRun(displayTextFor(text, attachments), instructionFor(text, attachments), 'message', signal, attachments);
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

  async #startRun(displayText: string, instruction: string, trigger: 'message' | 'do', signal: AbortSignal, attachments: ImageAttachment[] = []): Promise<void> {
    const session = this.#state.session; if (!session) return; const runId = createId();
    try {
    if (signal.aborted) return;
    const begun = await this.#repository.beginAgentRun({runId, sessionId: session.id, displayText, instruction, mode: this.#state.agentMode, ...(attachments.length === 0 ? {} : {attachments})});
    // run 元信息入 trace：模型/协议/模式/触发方式。
    this.#tap?.runHeader(session.id, runId, this.#state.agentMode, trigger);
    this.#publish({...this.#state, messages: [...this.#state.messages, begun.userMessage], requestStatus: 'streaming', latestUsage: null, runUsage: {inputTokens: 0, outputTokens: 0}, iteration: 0, recovery: null, visibleError: null});
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
        if (conversation) this.#publish({...this.#state, messages: conversation.messages, toolCalls: conversation.toolCalls, liveToolCalls: []});
      } catch (storageError) { detail += `；无法持久化终态：${errorMessage(storageError)}`; logger.warn('Agent 终态写入失败', {runId, error: errorMessage(storageError)}); }
      this.#publish({...this.#state, requestStatus: cancelled ? 'idle' : 'failed', activeRunId: null, approvalPrompt: null, stopReason: reason, visibleError: detail, liveToolCalls: []});
    }
  }
  async #consume(runId: string, userMessageId: string, instruction: string, trigger: 'message' | 'do' | 'resume', context: AgentContext, signal: AbortSignal, reminders: string[], resume?: {iterationCount: number; usage: Usage}): Promise<void> {
    const session = this.#state.session!; const projector = new AgentEventProjector(this.#repository, () => this.#state, state => this.#publish(state), this.#state.agentMode);
    const generator = this.#runner.run({runId, userMessageId, sessionId: session.id, trigger, mode: this.#state.agentMode, instruction, context: [...context.items()], ...(resume === undefined ? {} : {iterationOffset: resume.iterationCount, usageOffset: resume.usage}), ...(this.#systemBlocks ? {system: this.#systemBlocks} : {}), reminders, steering: async () => this.#takePendingSteers(runId), limits: {maxIterations: this.#maxIterations, maxUnknownToolIterations: 3}, ...(this.#profile ? {contextManagement: {windowTokens: effectiveContextWindow(this.#profile.protocol, this.#profile.contextWindow), workspaceRoot: this.#workspaceRoot}} : {})}, signal);
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
    if (this.#services?.projectTrusted && this.#profile && this.#memoryClient) {
      const dialogue = [...this.#state.messages].slice(-20).map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n');
      // 记忆提取失败记录日志，不影响当前回合。
      void this.#services.memoryExtractor(this.#memoryClient).extract(dialogue).catch((error: unknown) => { logger.warn('记忆提取失败', {error: errorMessage(error)}); });
    }
  }
  async cancelActiveRequest(): Promise<void> { const active = this.#active; if (!active) return; if (active.abortController.signal.aborted) { await active.promise; return; } this.#publish({...this.#state, requestStatus: 'cancelling'}); active.abortController.abort(); this.#tools.approvals.interruptAll(); await active.promise; }
  resolveToolApproval(decision: ApprovalDecision): void { const prompt = this.#state.approvalPrompt; if (prompt) this.#tools.approvals.resolve(prompt.callId, decision); }
  /** 撤销最近一次(或指定文件的)Bitori 文件写入;当前内容被外部修改时拒绝盲目覆盖。 */
  async undoLastEdit(path?: string): Promise<{ok: boolean; message: string}> {
    if (this.#active) return {ok: false, message: '生成中不能撤销;请先停止或等待当前任务'};
    const store = this.#tools.snapshots;
    if (store === undefined) return {ok: false, message: '当前工具系统未启用快照存储,无法撤销'};
    return store.undo(path);
  }
  setPermissionTier(tier: Exclude<PermissionTier, 'bypass'>): void {
    if ((tier as string) === 'bypass') { this.#error('放行档只能通过聊天命令二次确认启用。'); return; }
    this.#setPermissionTier(tier);
  }
  async createSession(): Promise<void> { if (!this.#canChangeSession() || !this.#profile) return; const profile = this.#profile; await this.#changeSession(async signal => { this.#rebuildSystemPrompt(); const session = await this.#repository.createSession(profile.name); if (signal.aborted) return; this.#tap?.fact(session.id, 'session_created', {profileName: profile.name}); await this.#publishSession(session, [], [], [], signal); }); }
  async listSessions(): Promise<Session[]> { return this.#profile ? this.#repository.listSessions(this.#profile.name) : []; }
  async switchSession(sessionId: string): Promise<void> {
    if (!this.#canChangeSession() || !this.#profile) return;
    const profile = this.#profile;
    await this.#changeSession(async signal => {
      const session = await this.#repository.getSession(sessionId);
      if (signal.aborted) return;
      if (!session || session.profileName !== profile.name) { this.#error('该会话不属于当前 profile'); return; }
      this.#rebuildSystemPrompt();
      const conversation = await this.#repository.getConversation(session.id);
      const messages = conversation?.messages ?? await this.#repository.getMessages(session.id);
      if (signal.aborted) return;
      this.#tap?.fact(session.id, 'session_switched', {profileName: profile.name});
      await this.#publishSession(session, messages, conversation?.toolCalls ?? [], conversation?.agentRuns ?? [], signal);
    });
    await this.#prepareRecovery(this.#autoResume);
  }
  async exportSession(): Promise<StoredConversation> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#active !== null) throw new Error('当前会话正在处理中，暂不能导出');
    const session = this.#state.session;
    if (session === null) throw new Error('没有可导出的会话');
    const active: ActiveRequest = {abortController: new AbortController(), promise: Promise.resolve()};
    this.#active = active;
    const request = this.#repository.getConversation(session.id);
    active.promise = request.then(() => undefined, () => undefined);
    try {
      const conversation = await request;
      if (conversation === null) throw new Error('无法读取当前会话');
      return conversation;
    } finally { if (this.#active === active) this.#active = null; }
  }
  async importSession(conversation: StoredConversation): Promise<void> {
    if (this.#closed) throw new Error('控制器已经关闭');
    if (this.#active !== null) throw new Error('当前会话正在处理中，暂不能导入');
    const profile = this.#profile;
    if (profile === null) throw new Error('模型配置尚未就绪');
    // exportSession returns the full storage record, including local recovery
    // checkpoints. Route it through the portable archive allowlist so direct
    // controller imports have the same validation and credential boundary as
    // file imports, without persisting non-portable provider/recovery state.
    const portableConversation = parseSessionArchive(createSessionArchive(conversation));
    await this.#changeSession(async signal => {
      const session = await this.#repository.importConversation(profile.name, portableConversation);
      if (signal.aborted) return;
      this.#rebuildSystemPrompt();
      const imported = await this.#repository.getConversation(session.id);
      if (signal.aborted) return;
      if (imported === null) throw new Error('会话导入后无法读取');
      this.#tap?.fact(session.id, 'session_imported', {profileName: profile.name});
      await this.#publishSession(session, imported.messages, imported.toolCalls, imported.agentRuns, signal);
    });
    await this.#prepareRecovery(false);
  }
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (this.#closed) return;
    if (this.#active) { this.#error('生成期间不能重命名会话'); return; }
    const trimmed = title.trim();
    if (!trimmed) { this.#error('会话标题不能为空'); return; }
    try {
      const updated = await this.#repository.renameSession(sessionId, trimmed);
      if (this.#state.session?.id === updated.id) this.#publish({...this.#state, session: updated});
    } catch (error) { this.#error(`重命名失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.#canChangeSession()) return;
    const profile = this.#profile;
    const isCurrent = this.#state.session?.id === sessionId;
    try {
      await this.#repository.deleteSession(sessionId);
    } catch (error) { this.#error(`删除失败：${error instanceof Error ? error.message : String(error)}`); return; }
    this.#tap?.fact(sessionId, 'session_deleted', {profileName: profile?.name ?? ''});
    if (isCurrent && profile !== null && profile !== undefined) {
      await this.#changeSession(async signal => {
        const next = await this.#repository.findLatestSession(profile.name) ?? await this.#repository.createSession(profile.name);
        if (signal.aborted) return;
        this.#rebuildSystemPrompt();
        const conversation = await this.#repository.getConversation(next.id);
        const messages = conversation?.messages ?? await this.#repository.getMessages(next.id);
        if (signal.aborted) return;
        await this.#publishSession(next, messages, conversation?.toolCalls ?? [], conversation?.agentRuns ?? [], signal);
      });
      await this.#prepareRecovery(this.#autoResume);
    }
  }
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
      this.#pendingSteers.length = 0;
      this.#publish({...this.#state, queuedMessages: []});
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
  #setPermissionTier(tier: PermissionTier): void {
    const permissions = this.#tools.permissions;
    if (!permissions) { this.#error('当前工具系统未启用权限引擎'); return; }
    const sessionId = this.#state.session?.id;
    if (tier === 'bypass') {
      if (sessionId === undefined) { this.#error('请先打开会话，再启用放行档。'); return; }
      permissions.enableSessionBypass(sessionId);
    } else {
      if (sessionId !== undefined) permissions.clearSessionBypass(sessionId);
      permissions.setTier(tier);
    }
    this.#publish({...this.#state, permissionTier: permissions.tierFor(sessionId), visibleError: tier === 'bypass' ? '当前聊天已临时启用放行档：写入与命令将跳过逐项审批。切换聊天或退出程序后失效。' : null});
  }
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
  async #publishSession(session: Session, messages: StoredMessage[], toolCalls: ToolCallRecord[] = [], agentRuns: AgentRunRecord[] = [], signal?: AbortSignal): Promise<void> {
    await this.#services?.hooks.fire('session_end', {event: 'session_end'});
    if (signal?.aborted) return;
    const previousSessionId = this.#state.session?.id;
    if (previousSessionId !== undefined && previousSessionId !== session.id) {
      this.#tools.permissions?.clearSessionBypass(previousSessionId);
      if (this.#pendingBypassSessionId === previousSessionId) {
        this.#pendingBypassExpiresAt = 0;
        this.#pendingBypassSessionId = null;
      }
    }
    this.#publish({...this.#state, screen: 'chat', session, agentMode: session.agentMode, permissionTier: this.#tools.permissions?.tierFor(session.id) ?? 'default', messages, toolCalls, requestStatus: 'idle', ...restoredRunState(messages, agentRuns), activeRunId: null, recovery: null, iteration: 0, agentPhase: null, expandedThinkingIds: new Set(), selectedMessageId: null, visibleError: null, approvalPrompt: null, liveToolCalls: []});
  }
  #rejectQoderImages(attachments: readonly ImageAttachment[]): boolean {
    if (attachments.length === 0 || this.#profile?.protocol !== 'qoder') return false;
    this.#error('Qoder 不支持图片附件，图片未发送。');
    return true;
  }
  #error(message: string): void { this.#publish({...this.#state, visibleError: message}); }
  #publish(state: AppState): void { if (state === this.#state) return; this.#state = state; for (const listener of this.#listeners) listener(state); }
}

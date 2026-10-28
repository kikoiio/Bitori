import {resolve, join} from 'node:path';
import {createApplicationRuntime} from '../app/runtime.js';
import type {ApplicationRuntime} from '../app/runtime.js';
import type {AppConfig, ProviderProfile} from '../config/types.js';
import type {TraceWriteStats} from '../trace/writer.js';

export interface ExecOptions {
  task: string;
  workspace?: string;
  maxIterations?: number;
  json: boolean;
}

export interface ExecResult {
  task: string;
  sessionId: string | null;
  runId: string | null;
  trace: TraceWriteStats | null;
  status: string;
  stopReason: string | null;
  iterations: number;
  toolCalls: Array<{name: string; status: string}>;
  inputTokens: number;
  outputTokens: number;
  reply: string;
  errorCode: string | null;
  errorMessage: string | null;
  error: string | null;
}

/** 无头单任务执行入口：复用完整 AgentRunner 链路，为 benchmark harness 提供可脚本化退出码。 */
export async function runExec(config: AppConfig, profile: ProviderProfile, options: ExecOptions): Promise<number> {
  const workspace = resolve(options.workspace ?? process.cwd());
  let runtime: ApplicationRuntime | undefined;
  let exitCode = 0;
  let runId: string | null = null;
  try {
    runtime = await createApplicationRuntime({config, profileName: profile.name, workspace, databasePath: join(workspace, '.bitori', 'bitori.db'), ...(options.maxIterations === undefined ? {} : {maxIterations: options.maxIterations})});
    const {controller} = runtime;
    controller.subscribe(state => {
      if (state.activeRunId) runId = state.activeRunId;
      if (state.approvalPrompt) controller.resolveToolApproval('denied');
    });
    for (const warning of runtime.warnings) process.stderr.write(`${warning}\n`);
    await controller.sendMessage(options.task);
    const state = controller.getState();
    await runtime.close();
    const failed = [...state.messages].findLast(message => message.role === 'assistant' && message.status === 'failed');
    const result: ExecResult = {
      task: options.task,
      sessionId: state.session?.id ?? null,
      runId,
      trace: controller.traceStats(),
      status: state.requestStatus,
      stopReason: state.stopReason,
      iterations: state.iteration,
      toolCalls: state.toolCalls.map(call => ({name: call.toolName, status: call.executionStatus})),
      inputTokens: state.runUsage.inputTokens,
      outputTokens: state.runUsage.outputTokens,
      reply: [...state.messages].findLast(message => message.role === 'assistant')?.content ?? '',
      errorCode: failed?.errorCode ?? null,
      errorMessage: failed?.errorMessage ?? null,
      error: state.visibleError,
    };
    if (state.requestStatus === 'failed' || state.stopReason === null || state.visibleError !== null) exitCode = 1;
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`\n${result.reply}\n`);
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) process.stdout.write(`${JSON.stringify({task: options.task, sessionId: runtime?.controller.getState().session?.id ?? null, runId, trace: null, status: 'failed', stopReason: null, iterations: 0, toolCalls: [], inputTokens: 0, outputTokens: 0, reply: '', errorCode: null, errorMessage: message, error: message})}\n`);
    else process.stderr.write(`Bitori exec 失败：${message}\n`);
  } finally {
    try { await runtime?.close(); }
    catch (error) { process.stderr.write(`Bitori 关闭失败：${error instanceof Error ? error.message : String(error)}\n`); exitCode = 1; }
  }
  return exitCode;
}

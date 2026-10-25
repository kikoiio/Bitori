import {resolve, join} from 'node:path';
import {configPaths} from '../config/loader.js';
import type {AppConfig, ProviderProfile} from '../config/types.js';
import {createLLMClient} from '../providers/factory.js';
import {SessionRepository} from '../storage/repository.js';
import {ChatController} from '../chat/agent-controller.js';
import {createToolSystem} from '../tools/create-tool-system.js';

export interface ExecOptions {
  task: string;
  workspace?: string;
  maxIterations?: number;
  json: boolean;
}

export interface ExecResult {
  task: string;
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

/** [s12] 无头单任务执行入口：复用完整 AgentRunner 链路，为 benchmark harness 提供可脚本化退出码。 */
export async function runExec(config: AppConfig, profile: ProviderProfile, options: ExecOptions): Promise<number> {
  const workspace = resolve(options.workspace ?? process.cwd());
  // 控制器内部的部分能力（自定义命令、上下文管理）读取 process.cwd，统一切到目标工作区。
  process.chdir(workspace);
  const client = createLLMClient(profile);
  const profileByName = new Map(config.profiles.map(item => [item.name, item]));
  const clientCache = new Map<string, ReturnType<typeof createLLMClient>>();
  const clientFor = (model: string | null): ReturnType<typeof createLLMClient> => {
    const profileName = model === null ? profile.name : config.models[model] ?? (profileByName.has(model) ? model : profile.name);
    const cached = clientCache.get(profileName);
    if (cached) return cached;
    const resolved = profileByName.get(profileName) ?? profile;
    const created = createLLMClient(resolved);
    clientCache.set(profileName, created);
    return created;
  };
  const tools = createToolSystem(workspace, config.mcpServers, {clientFor, memoryClient: client});
  const repository = new SessionRepository(`${workspace}/.bitori/bitori.db`);
  // [s15] exec 一次性任务同样开启观测面，trace 可被 benchmarks 消费。
  const observability = {traceDirectory: configPaths().traces, usagePath: join(configPaths().usage, 'skills.jsonl')};
  const controller = new ChatController(client, repository, tools, undefined, {observability, ...(options.maxIterations === undefined ? {} : {maxIterations: options.maxIterations})});
  // 无头环境没有审批 UI；未通过权限规则放行的副作用工具一律自动拒绝。
  controller.subscribe(state => {
    if (state.approvalPrompt) controller.resolveToolApproval('denied');
  });
  let exitCode = 0;
  try {
    const mcpResult = await tools.mcp.initialize();
    await tools.services.hooks.fire('startup', {event: 'startup'});
    for (const failure of mcpResult.failed) process.stderr.write(`MCP Server ${failure.name} 启动失败：${failure.error.message}\n`);
    await controller.initialize(profile);
    await controller.sendMessage(options.task);
    const state = controller.getState();
    const failed = [...state.messages].findLast(message => message.role === 'assistant' && message.status === 'failed');
    const result: ExecResult = {
      task: options.task,
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
    if (options.json) process.stdout.write(`${JSON.stringify({task: options.task, status: 'failed', stopReason: null, iterations: 0, toolCalls: [], inputTokens: 0, outputTokens: 0, reply: '', errorCode: null, errorMessage: message, error: message})}\n`);
    else process.stderr.write(`Bitori exec 失败：${message}\n`);
  } finally {
    await controller.shutdown();
    tools.close();
  }
  return exitCode;
}

import {join, resolve} from 'node:path';
import {isWorkspaceTrusted} from '../config/trust.js';
import {ChatController} from '../chat/agent-controller.js';
import {collectSecretValues, configPaths, resolveProfileWithApiKey} from '../config/loader.js';
import type {AppConfig} from '../config/types.js';
import {createLLMClient} from '../providers/factory.js';
import {ProviderRequestLimiter} from '../providers/request-limiter.js';
import type {LLMClient} from '../providers/types.js';
import {configureLogging} from '../shared/logger.js';
import type {LogLevel} from '../shared/logger.js';
import {createRedactor, setGlobalRedactor} from '../shared/redact.js';
import {SessionRepository} from '../storage/repository.js';
import {createToolSystem} from '../tools/create-tool-system.js';
import {cleanupExpiredTraces} from '../trace/retention.js';

export interface ApplicationRuntime {
  controller: ChatController;
  warnings: string[];
  /** Number of calls into ProviderClient.streamChat, excluding SDK-internal retries. */
  providerRequestCount(): number;
  /** Number of chat calls rejected by the optional hard limit. */
  providerRequestBlockedCount(): number;
  close(): Promise<void>;
}

export function configureApplicationLogging(config: AppConfig, level?: LogLevel): void {
  const paths = configPaths();
  const redactor = createRedactor(collectSecretValues(config));
  setGlobalRedactor(redactor);
  const effectiveLevel = level ?? config.logging.level;
  configureLogging({directory: paths.logs, redactor, ...(effectiveLevel === undefined ? {} : {level: effectiveLevel}), ...(config.logging.retention_days === undefined ? {} : {retentionDays: config.logging.retention_days})});
  cleanupExpiredTraces(paths.traces, config.trace.retention_days ?? 30);
}

export async function createApplicationRuntime(options: {
  config: AppConfig;
  profileName: string;
  workspace: string;
  databasePath?: string;
  maxIterations?: number;
  /** 交互式运行时默认自动恢复安全中断任务；无头 exec 显式关闭。 */
  autoResume?: boolean;
  /** Provider 内模型选择：只覆盖本次运行时的 model，不改配置文件。 */
  modelOverride?: string;
  /** ProviderClient.streamChat 调用数硬上限；不统计 SDK 内部重试或回退。 */
  providerRequestLimit?: number;
}): Promise<ApplicationRuntime> {
  const {config} = options;
  const resolved = resolveProfileWithApiKey(config, options.profileName);
  if (resolved === null) throw new Error('请选择模型配置');
  const profile = options.modelOverride === undefined ? resolved : {...resolved, model: options.modelOverride};
  const workspace = resolve(options.workspace);
  const cache = new Map<string, LLMClient>();
  const providerRequests = new ProviderRequestLimiter(options.providerRequestLimit);
  const clientFor = (model: string | null): LLMClient => {
    const name = model === null ? profile.name : config.models[model] ?? model;
    const selected = name === profile.name ? profile : (config.profiles.find(item => item.name === name) ?? profile);
    if (selected.apiKey.length === 0) throw new Error(`请在 .env 中填写 ${selected.apiKeyVariable ?? 'API key'}`);
    const cached = cache.get(selected.name);
    if (cached) return cached;
    const client = providerRequests.wrap(createLLMClient(selected));
    cache.set(selected.name, client);
    return client;
  };
  const client = clientFor(null);
  const tools = createToolSystem(workspace, config.mcpServers, {clientFor, memoryClient: client, projectTrusted: isWorkspaceTrusted(workspace)});
  // 未信任工作区的项目级扩展由 loadConfig/services 拒载，这里把原因呈现到 UI。
  let repository: SessionRepository | undefined;
  let controller: ChatController | undefined;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      const failures: unknown[] = [];
      try { if (controller) await controller.shutdown(); else await repository?.close(); }
      catch (error) { failures.push(error); }
      try { await tools.close(); }
      catch (error) { failures.push(error); }
      if (failures.length) throw failures[0];
    })();
    return closed;
  };
  try {
    const mcp = await tools.mcp.initialize();
    await tools.services.hooks.fire('startup', {event: 'startup'});
    repository = options.databasePath === undefined ? new SessionRepository() : new SessionRepository(options.databasePath);
    const paths = configPaths();
    controller = new ChatController(client, repository, tools, undefined, {workspaceRoot: workspace, autoResume: options.autoResume ?? true, observability: {traceDirectory: paths.traces, usagePath: join(paths.usage, 'skills.jsonl')}, ...(options.maxIterations === undefined ? {} : {maxIterations: options.maxIterations})});
    await controller.initialize(profile);
    return {controller, providerRequestCount: () => providerRequests.count, providerRequestBlockedCount: () => providerRequests.blockedCount, warnings: [
      ...(config.notices ?? []),
      ...(tools.permissions.hadPersistedBypass ? ['已忽略配置文件中持久化的 bypass 档；如需使用，请在当前聊天中二次确认 /permission bypass。'] : []),
      ...mcp.failed.map(item => `MCP Server ${item.name} 启动失败：${item.error.message}`),
    ], close};
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

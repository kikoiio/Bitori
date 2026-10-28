import {join, resolve} from 'node:path';
import {ChatController} from '../chat/agent-controller.js';
import {collectSecretValues, configPaths, resolveProfileWithApiKey} from '../config/loader.js';
import type {AppConfig} from '../config/types.js';
import {createLLMClient} from '../providers/factory.js';
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
}): Promise<ApplicationRuntime> {
  const {config} = options;
  const profile = resolveProfileWithApiKey(config, options.profileName);
  if (profile === null) throw new Error('请选择模型配置');
  const workspace = resolve(options.workspace);
  const cache = new Map<string, LLMClient>();
  const clientFor = (model: string | null): LLMClient => {
    const name = model === null ? profile.name : config.models[model] ?? model;
    const candidate = config.profiles.find(item => item.name === name) ?? profile;
    const selected = resolveProfileWithApiKey(config, candidate.name);
    if (selected === null) throw new Error('找不到模型配置');
    const cached = cache.get(selected.name);
    if (cached) return cached;
    const client = createLLMClient(selected);
    cache.set(selected.name, client);
    return client;
  };
  const client = clientFor(null);
  const tools = createToolSystem(workspace, config.mcpServers, {clientFor, memoryClient: client});
  let repository: SessionRepository | undefined;
  let controller: ChatController | undefined;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      const failures: unknown[] = [];
      try { if (controller) await controller.shutdown(); else await repository?.close(); }
      catch (error) { failures.push(error); }
      try { tools.close(); await tools.mcp.close(); }
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
    controller = new ChatController(client, repository, tools, undefined, {workspaceRoot: workspace, observability: {traceDirectory: paths.traces, usagePath: join(paths.usage, 'skills.jsonl')}, ...(options.maxIterations === undefined ? {} : {maxIterations: options.maxIterations})});
    await controller.initialize(profile);
    return {controller, warnings: mcp.failed.map(item => `MCP Server ${item.name} 启动失败：${item.error.message}`), close};
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

import {ChatController} from '../chat/agent-controller.js';
import {collectSecretValues, configPaths, loadConfig, resolveProfileWithApiKey} from '../config/loader.js';
import {toProfileSummary} from '../config/types.js';
import type {ProviderProfile} from '../config/types.js';
import {createLLMClient} from '../providers/factory.js';
import {configureLogging} from '../shared/logger.js';
import {createRedactor, setGlobalRedactor} from '../shared/redact.js';
import {cleanupExpiredTraces} from '../trace/retention.js';
import {SessionRepository} from '../storage/repository.js';
import {resolve} from 'node:path';
import {createShutdownOnce} from '../terminal/shutdown.js';
import {TerminalSession} from '../terminal/session.js';
import {renderApp} from '../tui/render.js';
import {usage} from './args.js';
import type {CliOptions} from './args.js';
import {createToolSystem} from '../tools/create-tool-system.js';
import {runExec} from './exec.js';
import {runSessionsCommand} from './commands/sessions.js';
import {runTraceCommand} from './commands/trace.js';
import {runUsageCommand} from './commands/usage.js';

/** [s01] 在读取配置和创建资源前先拒绝不受支持的运行环境。 */
function assertRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (major !== 24) throw new Error(`Bitori 需要 Node.js 24 LTS，当前为 ${process.versions.node}`);
}

/** [s15] 日志与脱敏在拿到配置后立即启用；CLI 级别优先于配置文件。trace 保留期超期清理顺带执行。 */
function setupLogging(config: ReturnType<typeof loadConfig>, logLevel?: CliOptions['logLevel']): void {
  const paths = configPaths();
  const redactor = createRedactor(collectSecretValues(config));
  setGlobalRedactor(redactor);
  configureLogging({
    ...(logLevel === undefined ? {} : {level: logLevel}),
    ...(config.logging.level === undefined ? {} : {level: config.logging.level}),
    directory: paths.logs,
    ...(config.logging.retention_days === undefined ? {} : {retentionDays: config.logging.retention_days}),
    redactor,
  });
  cleanupExpiredTraces(paths.traces, config.trace.retention_days ?? 30);
}

export async function bootstrap(options: CliOptions): Promise<void> {
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  assertRuntime();
  // [s15] 只读观察子命令：配置与日志照常启用，不进入 TUI 或 exec 主链路。
  if (options.trace !== undefined || options.usage !== undefined || options.sessions !== undefined) {
    const config = loadConfig(undefined, process.cwd());
    setupLogging(config, options.logLevel);
    if (options.trace !== undefined) process.exitCode = runTraceCommand(options.trace);
    else if (options.usage !== undefined) process.exitCode = runUsageCommand(options.usage);
    else if (options.sessions !== undefined) process.exitCode = await runSessionsCommand(options.sessions, options.profile);
    return;
  }
  if (options.exec) {
    const workspace = resolve(options.exec.workspace ?? process.cwd());
    const config = loadConfig(undefined, workspace);
    setupLogging(config, options.logLevel);
    const profile = resolveProfileWithApiKey(config, options.profile);
    if (profile === null) throw new Error('多 profile 时 exec 需要 --profile 指定');
    process.exitCode = await runExec(config, profile, options.exec);
    return;
  }
  // [s01] 配置读取、profile 选择、Provider/存储创建都集中在“组合根”中，UI 无需知道构造细节。
  const config = loadConfig(undefined, process.cwd());
  setupLogging(config, options.logLevel);
  const selected = resolveProfileWithApiKey(config, options.profile);
  // [s02] 启动时固定捕获工作区；限制不来自配置或模型参数。
  // [s12] SubAgent 的模型映射先复用当前 profile；自定义模型路由在配置系统扩展后接入。
  const fallback = selected ?? config.profiles[0]!;
  const profileByName = new Map(config.profiles.map(profile => [profile.name, profile]));
  const clientCache = new Map<string, ReturnType<typeof createLLMClient>>();
  const clientFor = (model: string | null): ReturnType<typeof createLLMClient> => {
    const profileName = model === null ? fallback.name : config.models[model] ?? (profileByName.has(model) ? model : fallback.name);
    const cached = clientCache.get(profileName); if (cached) return cached;
    const profile = profileByName.get(profileName) ?? fallback;
    const client = createLLMClient(profile); clientCache.set(profileName, client); return client;
  };
  const toolOptions: {clientFor: (model: string | null) => ReturnType<typeof createLLMClient>; memoryClient?: ReturnType<typeof createLLMClient>} = {clientFor};
  if (selected) toolOptions.memoryClient = createLLMClient(selected);
  const toolSystem = createToolSystem(process.cwd(), config.mcpServers, toolOptions);
  // [s06] Server 逐个隔离初始化；可用工具先注册，失败项只告警而不阻断应用。
  const mcpResult = await toolSystem.mcp.initialize();
  await toolSystem.services.hooks.fire('startup', {event: 'startup'});
  for (const failure of mcpResult.failed) process.stderr.write(`MCP Server ${failure.name} 启动失败：${failure.error.message}\n`);
  let activeController: ChatController | null = null;
  let terminal: TerminalSession | null = null;

  const createController = async (profile: ProviderProfile): Promise<ChatController> => {
    // [s01] 每个 controller 拥有一条独立的存储 Worker 客户端和一个具体模型客户端。
    const repository = new SessionRepository();
    const controller = new ChatController(createLLMClient(profile), repository, toolSystem);
    try {
      await controller.initialize(profile);
      return controller;
    } catch (error) {
      // [s01] 初始化中途失败也必须关闭 Worker；catch 后重新抛出，保留原始失败原因。
      await repository.close().catch(() => undefined);
      throw error;
    }
  };

  if (selected !== null) {
    try { activeController = await createController(selected); }
    catch (error) { toolSystem.close(); throw error; }
  }
  // [s01] shutdown 内部会记忆第一次关闭 Promise，因此多个退出来源不会重复释放资源。
  const shutdown = createShutdownOnce(() => activeController, () => terminal, async () => { toolSystem.close(); await Promise.resolve(); });
  const instance = renderApp({
    profiles: config.profiles.map(toProfileSummary),
    initialController: activeController,
    createController: async name => {
      const profile = config.profiles.find(item => item.name === name);
      if (profile === undefined) throw new Error(`找不到 profile：${name}`);
      const controller = await createController(profile);
      activeController = controller;
      return controller;
    },
    onController: controller => { activeController = controller; },
    onExit: () => { void shutdown('user'); },
  });
  terminal = new TerminalSession(instance);

  const fatalHandler = (error: unknown) => {
    // [s01] void 表示有意不在同步事件处理器里 await；finally 仍保证错误输出发生在清理之后。
    void shutdown('fatal_error').finally(() => {
      process.stderr.write(`Bitori 发生未处理错误：${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once('uncaughtException', fatalHandler);
  process.once('unhandledRejection', fatalHandler);
  try {
    // [s01] Ink 卸载前保持主流程存活。
    await terminal.waitUntilExit();
  } finally {
    process.off('uncaughtException', fatalHandler);
    process.off('unhandledRejection', fatalHandler);
    await shutdown('user');
  }
}

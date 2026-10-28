import {resolve} from 'node:path';
import {configureApplicationLogging, createApplicationRuntime} from '../app/runtime.js';
import type {ApplicationRuntime} from '../app/runtime.js';
import type {ChatController} from '../chat/agent-controller.js';
import {loadConfig, resolveProfileWithApiKey} from '../config/loader.js';
import {toProfileSummary} from '../config/types.js';
import {getLogger} from '../shared/logger.js';
import {createShutdownOnce} from '../terminal/shutdown.js';
import {TerminalSession} from '../terminal/session.js';
import {renderApp} from '../tui/render.js';
import {usage} from './args.js';
import type {CliOptions} from './args.js';
import {runExec} from './exec.js';
import {runSessionsCommand} from './commands/sessions.js';
import {runTraceCommand} from './commands/trace.js';
import {runUsageCommand} from './commands/usage.js';

function assertRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (major !== 24) throw new Error(`Bitori 需要 Node.js 24 LTS，当前为 ${process.versions.node}`);
}

export async function bootstrap(options: CliOptions): Promise<void> {
  if (options.help) { process.stdout.write(`${usage}\n`); return; }
  assertRuntime();
  const workspace = resolve(options.exec?.workspace ?? process.cwd());
  const config = loadConfig(undefined, workspace);
  configureApplicationLogging(config, options.logLevel);
  if (options.trace !== undefined || options.usage !== undefined || options.sessions !== undefined) {
    if (options.trace !== undefined) process.exitCode = runTraceCommand(options.trace);
    else if (options.usage !== undefined) process.exitCode = runUsageCommand(options.usage);
    else if (options.sessions !== undefined) process.exitCode = await runSessionsCommand(options.sessions, options.profile);
    return;
  }
  const selected = resolveProfileWithApiKey(config, options.profile);
  if (options.exec) {
    if (selected === null) throw new Error('多 profile 时 exec 需要 --profile 指定');
    process.exitCode = await runExec(config, selected, options.exec);
    return;
  }

  let runtime: ApplicationRuntime | null = null;
  let activeController: ChatController | null = null;
  let terminal: TerminalSession | null = null;
  let stopping = false;
  const createController = async (name: string): Promise<ChatController> => {
    const next = await createApplicationRuntime({config, profileName: name, workspace});
    if (stopping) { await next.close(); throw new Error('应用正在关闭'); }
    runtime = next;
    activeController = next.controller;
    for (const warning of next.warnings) getLogger('cli').warn(warning);
    return next.controller;
  };
  const shutdown = createShutdownOnce(() => activeController, () => terminal, async () => {
    stopping = true;
    if (runtime) await runtime.close();
  });
  try {
    if (selected !== null) await createController(selected.name);
    const instance = renderApp({
      profiles: config.profiles.map(toProfileSummary),
      initialController: activeController,
      createController,
      onController: controller => { activeController = controller; },
      onExit: () => { stopping = true; void shutdown('user').catch(error => { getLogger('cli').error('关闭失败', {error: String(error)}); }); },
    });
    terminal = new TerminalSession(instance);
    const fatalHandler = (error: unknown) => {
      stopping = true;
      const report = () => {
        process.stderr.write(`Bitori 发生未处理错误：${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      };
      void shutdown('fatal_error').then(report, report);
    };
    process.once('uncaughtException', fatalHandler);
    process.once('unhandledRejection', fatalHandler);
    try { await terminal.waitUntilExit(); }
    finally {
      process.off('uncaughtException', fatalHandler);
      process.off('unhandledRejection', fatalHandler);
    }
  } finally { stopping = true; await shutdown('user'); }
}

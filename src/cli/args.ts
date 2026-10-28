import {UsageError} from '../shared/errors.js';
import type {LogLevel} from '../shared/logger.js';

const logLevels = ['debug', 'info', 'warn', 'error'] as const;

/** 解析完成后的命令行选项；`?` 表示这个属性可以不存在。 */
export interface CliOptions {
  profile?: string;
  help: boolean;
  /** 全局日志级别，优先于 config.yaml 的 logging.level。 */
  logLevel?: LogLevel;
  exec?: {task: string; workspace?: string; maxIterations?: number; json: boolean};
  /** 只读观察子命令；与 exec/TUI 互斥。 */
  trace?: {action: 'show' | 'tail' | 'export' | 'replay'; sessionId?: string; file?: string; iteration?: number; out?: string; json?: boolean; raw?: boolean};
  usage?: {action: 'stats' | 'tail'; sessionId?: string; kind?: 'skill' | 'command'; json?: boolean};
  sessions?: {action: 'list' | 'show'; sessionId?: string; json?: boolean};
}

export const usage = `用法：bitori [--profile <name>] [--log-level <level>] [--help]
       bitori exec [--profile <name>] --task <text> [--workspace <path>] [--max-iterations <n>] [--json]
       bitori trace show <sessionId> [--iteration <n>] [--json]
       bitori trace tail --session <sessionId>
       bitori trace export <sessionId> [--out <file>] [--raw]
       bitori trace replay <file>
       bitori usage stats [--session <id>] [--kind skill|command] [--json]
       bitori usage tail
       bitori sessions list
       bitori sessions show <sessionId> [--json]

选项：
  --profile <name>        直接使用指定模型配置
  --log-level <level>     日志级别 debug|info|warn|error，缺省 info
  --help                  显示帮助

trace 子命令：
  show                    渲染一次会话的逐轮请求/响应/重试/组成
  tail                    实时跟随一个会话的 trace 事件流
  export                  导出自包含 JSONL（默认脱敏，--raw 关闭）
  replay                  离线重放已导出的 trace 文件

usage 子命令：
  stats                   按名称聚合技能与命令使用统计
  tail                    实时跟随使用统计流

sessions 子命令：
  list                    列出当前 profile 的会话
  show                    查看会话的消息、回合与工具调用摘要

exec 选项：
  --profile <name>      指定模型配置
  --task <text>         要执行的任务描述（必填）
  --workspace <path>    工作区目录，缺省为当前目录
  --max-iterations <n>  Agent 最大迭代数，缺省 20
  --json                结束时向 stdout 追加结构化结果 JSON`;

function positiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${option} 必须是正整数`);
  return parsed;
}

/** 校验并归一化 --log-level 取值。 */
function logLevel(value: string): LogLevel {
  if (!(logLevels as readonly string[]).includes(value)) throw new UsageError(`--log-level 必须是 debug|info|warn|error，收到：${value}`);
  return value as LogLevel;
}

interface SubcommandParseContext {
  argv: readonly string[];
  start: number;
  profile: string | undefined;
}

/** 解析 trace/usage/sessions 子命令；返回是否消费了当前子命令。 */
function parseSubcommand(name: 'trace' | 'usage' | 'sessions', context: SubcommandParseContext): {trace?: CliOptions['trace']; usage?: CliOptions['usage']; sessions?: CliOptions['sessions']} {
  const {argv, start} = context;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const flagWithValue = new Set(['--iteration', '--out', '--session', '--kind', '--profile']);
  for (let cursor = start + 1; cursor < argv.length; cursor += 1) {
    const token = argv[cursor]!;
    if (token === '--json' || token === '--raw') {
      if (flags.has(token)) throw new UsageError(`${token} 不能重复`);
      flags.set(token, true);
    } else if (flagWithValue.has(token)) {
      if (flags.has(token)) throw new UsageError(`${token} 不能重复`);
      const value = argv[cursor + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${token} 缺少取值`);
      flags.set(token, value);
      cursor += 1;
    } else if (token.startsWith('--')) {
      throw new UsageError(`未知 ${name} 参数：${token}`);
    } else {
      positionals.push(token);
    }
  }
  // 子命令内也接受 --profile（sessions 需要）；与全局 profile 冲突时报错。
  const profileFlag = flags.get('--profile');
  if (typeof profileFlag === 'string') {
    if (context.profile !== undefined && context.profile !== profileFlag) throw new UsageError('--profile 不能重复');
    context.profile = profileFlag;
  }
  const json = flags.get('--json') === true;
  const sessionFlag = flags.get('--session');
  if (name === 'trace') {
    const action = positionals[0];
    const iterationFlag = flags.get('--iteration');
    const iteration = typeof iterationFlag === 'string' ? positiveInteger(iterationFlag, '--iteration') : undefined;
    if (action === 'show') {
      const sessionId = positionals[1] ?? (typeof sessionFlag === 'string' ? sessionFlag : undefined);
      if (sessionId === undefined) throw new UsageError('trace show 需要 <sessionId>');
      return {trace: {action, sessionId, ...(iteration === undefined ? {} : {iteration}), json}};
    }
    if (action === 'tail') {
      const sessionId = typeof sessionFlag === 'string' ? sessionFlag : positionals[1];
      return {trace: {action, ...(sessionId === undefined ? {} : {sessionId}), json}};
    }
    if (action === 'export') {
      const sessionId = positionals[1] ?? (typeof sessionFlag === 'string' ? sessionFlag : undefined);
      if (sessionId === undefined) throw new UsageError('trace export 需要 <sessionId>');
      const out = flags.get('--out');
      return {trace: {action, sessionId, ...(typeof out === 'string' ? {out} : {}), raw: flags.get('--raw') === true, json}};
    }
    if (action === 'replay') {
      if (positionals[1] === undefined) throw new UsageError('trace replay 需要 <file>');
      return {trace: {action, file: positionals[1], json}};
    }
    throw new UsageError('trace 子命令需要 show|tail|export|replay');
  }
  if (name === 'usage') {
    const action = positionals[0];
    const kind = flags.get('--kind');
    if (action === 'stats') {
      const sessionId = typeof sessionFlag === 'string' ? sessionFlag : positionals[1];
      if (kind !== undefined && kind !== 'skill' && kind !== 'command') throw new UsageError('--kind 必须是 skill|command');
      return {usage: {action, ...(sessionId === undefined ? {} : {sessionId}), ...(typeof kind === 'string' ? {kind: kind} : {}), json}};
    }
    if (action === 'tail') return {usage: {action, json}};
    throw new UsageError('usage 子命令需要 stats|tail');
  }
  // sessions
  const action = positionals[0];
  if (action === 'list') return {sessions: {action, json}};
  if (action === 'show') {
    const sessionId = positionals[1] ?? (typeof sessionFlag === 'string' ? sessionFlag : undefined);
    if (sessionId === undefined) throw new UsageError('sessions show 需要 <sessionId>');
    return {sessions: {action, sessionId, json}};
  }
  throw new UsageError('sessions 子命令需要 list|show');
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let profile: string | undefined;
  let help = false;
  let logLevelOption: LogLevel | undefined;
  let exec: CliOptions['exec'];
  let subcommand: {trace?: CliOptions['trace']; usage?: CliOptions['usage']; sessions?: CliOptions['sessions']} | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (index === 0 && argument === 'exec') {
      if (exec !== undefined) throw new UsageError('exec 不能重复');
      let task: string | undefined; let workspace: string | undefined; let maxIterations: number | undefined; let json = false;
      for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
        const option = argv[cursor];
        const takeValue = (): string => {
          const value = argv[cursor + 1];
          if (value === undefined || value.startsWith('--')) throw new UsageError(`${option} 缺少取值`);
          cursor += 1; return value;
        };
        if (option === '--profile') { const value = takeValue(); if (profile !== undefined) throw new UsageError('--profile 不能重复'); profile = value; }
        else if (option === '--task') { const value = takeValue(); if (task !== undefined) throw new UsageError('--task 不能重复'); task = value; }
        else if (option === '--workspace') { const value = takeValue(); if (workspace !== undefined) throw new UsageError('--workspace 不能重复'); workspace = value; }
        else if (option === '--max-iterations') { const value = takeValue(); if (maxIterations !== undefined) throw new UsageError('--max-iterations 不能重复'); maxIterations = positiveInteger(value, '--max-iterations'); }
        else if (option === '--json') { if (json) throw new UsageError('--json 不能重复'); json = true; }
        else if (option === '--log-level') { const value = takeValue(); if (logLevelOption !== undefined) throw new UsageError('--log-level 不能重复'); logLevelOption = logLevel(value); }
        else throw new UsageError(`未知 exec 参数：${option}`);
      }
      if (task === undefined) throw new UsageError('exec 需要 --task');
      exec = {task, ...(workspace === undefined ? {} : {workspace}), ...(maxIterations === undefined ? {} : {maxIterations}), json};
      break;
    }
    if (argument === 'trace' || argument === 'usage' || argument === 'sessions') {
      // 子命令允许出现在全局 flag 之后（如 --profile claude sessions list）；裸 token 原本就是非法参数，因此放宽位置是安全的。
      const subcommandContext = {argv, start: index, profile};
      subcommand = parseSubcommand(argument, subcommandContext);
      profile = subcommandContext.profile;
      break;
    }
    if (argument === '--help') {
      if (help) throw new UsageError('--help 不能重复');
      help = true;
      continue;
    }
    if (argument === '--profile') {
      if (profile !== undefined) throw new UsageError('--profile 不能重复');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--profile 缺少名称');
      profile = value;
      // profile 名称已经被本次循环消费，跳过它，下一轮从后一个参数继续。
      index += 1;
      continue;
    }
    if (argument === '--log-level') {
      if (logLevelOption !== undefined) throw new UsageError('--log-level 不能重复');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--log-level 缺少级别');
      logLevelOption = logLevel(value);
      index += 1;
      continue;
    }
    throw new UsageError(`未知参数：${argument}`);
  }

  if (exec && help) throw new UsageError('exec 不能和 --help 同时使用');
  if (help && profile !== undefined) throw new UsageError('--help 不能和 --profile 同时使用');
  if (subcommand !== undefined) {
    return {
      help: false,
      ...(profile === undefined ? {} : {profile}),
      ...(logLevelOption === undefined ? {} : {logLevel: logLevelOption}),
      ...(subcommand.trace === undefined ? {} : {trace: subcommand.trace}),
      ...(subcommand.usage === undefined ? {} : {usage: subcommand.usage}),
      ...(subcommand.sessions === undefined ? {} : {sessions: subcommand.sessions}),
    };
  }
  if (exec) return {help: false, ...(profile === undefined ? {} : {profile}), ...(logLevelOption === undefined ? {} : {logLevel: logLevelOption}), exec};
  // exactOptionalPropertyTypes 开启后，缺省属性应直接省略，而不是写成 profile: undefined。
  return {help, ...(profile === undefined ? {} : {profile}), ...(logLevelOption === undefined ? {} : {logLevel: logLevelOption})};
}

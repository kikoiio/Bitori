import {UsageError} from '../shared/errors.js';

/** [s01] 解析完成后的命令行选项；`?` 表示这个属性可以不存在。 */
export interface CliOptions {
  profile?: string;
  help: boolean;
  exec?: {task: string; workspace?: string; maxIterations?: number; json: boolean};
}

export const usage = `用法：bitori [--profile <name>] [--help]
       bitori exec [--profile <name>] --task <text> [--workspace <path>] [--max-iterations <n>] [--json]

选项：
  --profile <name>  直接使用指定模型配置
  --help            显示帮助

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

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let profile: string | undefined;
  let help = false;
  let exec: CliOptions['exec'];

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
        else throw new UsageError(`未知 exec 参数：${option}`);
      }
      if (task === undefined) throw new UsageError('exec 需要 --task');
      exec = {task, ...(workspace === undefined ? {} : {workspace}), ...(maxIterations === undefined ? {} : {maxIterations}), json};
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
      // [s01] profile 名称已经被本次循环消费，跳过它，下一轮从后一个参数继续。
      index += 1;
      continue;
    }
    throw new UsageError(`未知参数：${argument}`);
  }

  if (exec && help) throw new UsageError('exec 不能和 --help 同时使用');
  if (help && profile !== undefined) throw new UsageError('--help 不能和 --profile 同时使用');
  if (exec) return profile === undefined ? {help: false, exec} : {help: false, profile, exec};
  // [s01] exactOptionalPropertyTypes 开启后，缺省属性应直接省略，而不是写成 profile: undefined。
  return profile === undefined ? {help} : {help, profile};
}

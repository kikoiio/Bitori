import {UsageError} from '../shared/errors.js';

/** [s01] 解析完成后的命令行选项；`?` 表示这个属性可以不存在。 */
export interface CliOptions {
  profile?: string;
  help: boolean;
}

export const usage = `用法：MyCode [--profile <name>] [--help]

选项：
  --profile <name>  直接使用指定模型配置
  --help            显示帮助`;

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let profile: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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

  if (help && profile !== undefined) throw new UsageError('--help 不能和 --profile 同时使用');
  // [s01] exactOptionalPropertyTypes 开启后，缺省属性应直接省略，而不是写成 profile: undefined。
  return profile === undefined ? {help} : {help, profile};
}

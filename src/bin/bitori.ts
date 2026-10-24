#!/usr/bin/env node
/** [s01]
 * 命令行程序的最外层入口。
 *
 * package.json 会把构建后的这个文件注册成 `bitori` 命令。这里故意只做三件事：
 * 解析参数、启动应用、把没有在内部处理的错误转换成进程退出码。
 */
import {bootstrap} from '../cli/bootstrap.js';
import {parseCliArgs, usage} from '../cli/args.js';
import {UsageError} from '../shared/errors.js';

try {
  // [s01] process.argv 的前两项分别是 Node 可执行文件和当前脚本，所以从下标 2 开始才是用户参数。
  const options = parseCliArgs(process.argv.slice(2));
  await bootstrap(options);
} catch (error) {
  // [s01] catch 中的 error 在严格 TS 配置下是 unknown，必须先缩小类型才能读取 message。
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    process.stderr.write(`${message}\n\n${usage}\n`);
    // [s01] 只设置 exitCode，让 Node 有机会完成尚未结束的清理；2 专门表示命令行用法错误。
    process.exitCode = 2;
  } else {
    process.stderr.write(`Bitori 启动失败：${message}\n`);
    process.exitCode = 1;
  }
}

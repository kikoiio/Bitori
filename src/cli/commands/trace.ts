import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {configPaths} from '../../config/loader.js';
import {getGlobalRedactor} from '../../shared/redact.js';
import {UsageError} from '../../shared/errors.js';
import {exportTrace} from '../../trace/export.js';
import {readTraceFile} from '../../trace/reader.js';
import {renderTokenTrend, renderTraceShow} from '../../trace/render.js';
import {tailJsonlFile} from './tail-file.js';
import type {CliOptions} from '../args.js';

/** [s15] `bitori trace …` 只读命令入口；返回进程退出码。 */
export function runTraceCommand(options: NonNullable<CliOptions['trace']>): number {
  const directory = configPaths().traces;
  if (options.action === 'show') {
    if (options.sessionId === undefined) throw new UsageError('trace show 需要 <sessionId>');
    const path = join(directory, `${options.sessionId}.jsonl`);
    if (!existsSync(path)) { process.stdout.write(`没有 trace 文件：${path}\n`); return 1; }
    const {events} = readTraceFile(path);
    process.stdout.write(`${renderTraceShow(events, options.iteration === undefined ? {} : {iteration: options.iteration})}\n`);
    if (options.json === true) process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
    else process.stdout.write(`\n${renderTokenTrend(events)}\n`);
    return 0;
  }
  if (options.action === 'replay') {
    if (options.file === undefined) throw new UsageError('trace replay 需要 <file>');
    const {events} = readTraceFile(options.file);
    process.stdout.write(`${renderTraceShow(events)}\n\n${renderTokenTrend(events)}\n`);
    return 0;
  }
  if (options.action === 'export') {
    if (options.sessionId === undefined) throw new UsageError('trace export 需要 <sessionId>');
    const path = join(directory, `${options.sessionId}.jsonl`);
    const {events} = readTraceFile(path);
    const out = options.out ?? `${options.sessionId}.trace.jsonl`;
    const count = exportTrace(events, out, {raw: options.raw === true, redactor: getGlobalRedactor()});
    process.stdout.write(`已导出 ${count} 个事件到 ${out}${options.raw === true ? '（未脱敏）' : '（已脱敏）'}\n`);
    return 0;
  }
  // tail
  const sessionId = options.sessionId;
  if (sessionId === undefined) throw new UsageError('trace tail 需要 --session <sessionId>');
  tailJsonlFile(join(directory, `${sessionId}.jsonl`));
  return 0;
}

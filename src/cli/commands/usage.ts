import {join} from 'node:path';
import {configPaths} from '../../config/loader.js';
import {aggregateUsage, readUsageRecords} from '../../usage/stats.js';
import {tailJsonlFile} from './tail-file.js';
import type {CliOptions} from '../args.js';

/** [s15] `bitori usage …` 只读命令入口；返回进程退出码。 */
export function runUsageCommand(options: NonNullable<CliOptions['usage']>): number {
  const path = join(configPaths().usage, 'skills.jsonl');
  if (options.action === 'stats') {
    const {records} = readUsageRecords(path, {...(options.sessionId === undefined ? {} : {sessionId: options.sessionId}), ...(options.kind === undefined ? {} : {kind: options.kind})});
    const aggregates = aggregateUsage(records);
    if (aggregates.length === 0) { process.stdout.write('（没有使用记录）\n'); return 0; }
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(aggregates, null, 2)}\n`);
      return 0;
    }
    process.stdout.write('次数  会话  最近使用               类型     名称\n');
    for (const entry of aggregates) {
      process.stdout.write(`${String(entry.count).padStart(4)}  ${String(entry.sessions).padStart(4)}  ${entry.lastUsedAt.padEnd(22)} ${entry.kind.padEnd(8)} ${entry.name}\n`);
    }
    return 0;
  }
  tailJsonlFile(path);
  return 0;
}

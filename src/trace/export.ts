import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {TraceEvent} from './types.js';

export interface TraceExportOptions {
  /** [s15] 默认脱敏；--raw 时原样拷贝原始行。 */
  raw?: boolean;
  redactor?: (text: string) => string;
}

/**
 * [s15] 导出自包含 JSONL：默认每行重序列化并过脱敏器，--raw 逐字保留。
 * 返回写入的事件数；写出失败抛给 CLI 层报告。
 */
export function exportTrace(events: readonly TraceEvent[], outputPath: string, options: TraceExportOptions = {}): number {
  const redactor = options.redactor ?? (text => text);
  const lines = events.map(event => options.raw === true ? JSON.stringify(event) : redactor(JSON.stringify(event)));
  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return events.length;
}

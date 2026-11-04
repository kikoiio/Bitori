import {closeSync, constants, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {getGlobalRedactor} from '../shared/redact.js';
import type {TraceEvent} from './types.js';

export interface TraceExportOptions {
  /** 默认脱敏；--raw 时原样拷贝原始行。 */
  raw?: boolean;
  redactor?: (text: string) => string;
}

/**
 * 导出自包含 JSONL：默认每行重序列化并过脱敏器，--raw 逐字保留。
 * 返回写入的事件数；写出失败抛给 CLI 层报告。
 */
export function exportTrace(events: readonly TraceEvent[], outputPath: string, options: TraceExportOptions = {}): number {
  const redactor = options.redactor ?? getGlobalRedactor();
  const lines = events.map(event => options.raw === true ? JSON.stringify(event) : redactor(JSON.stringify(event)));
  mkdirSync(dirname(outputPath), {recursive: true});
  // Tighten an existing file before truncating it, so old and new trace data are private.
  // Reject symlinks and avoid blocking on a pre-existing FIFO before checking its type.
  const safeFlags = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const descriptor = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | safeFlags, 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('trace 导出目标必须是普通文件');
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, `${lines.join('\n')}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  return events.length;
}

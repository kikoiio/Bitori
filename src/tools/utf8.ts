import {open, opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {truncateUtf8, type LimitedText} from './limits.js';
import type {ToolErrorCode, ToolExecutionResult} from './types.js';

export class TextFileError extends Error {
  constructor(readonly code: Extract<ToolErrorCode, 'binary_file' | 'invalid_utf8'>, message: string) { super(message); }
}
/** fatal 解码拒绝替换字符；NUL 是二进制信号。 */
export function assertUtf8Text(data: Uint8Array): string {
  if (data.includes(0)) throw new TextFileError('binary_file', '文件包含 NUL 字节，不能作为文本读取');
  try { return new TextDecoder('utf-8', {fatal: true}).decode(data); }
  catch { throw new TextFileError('invalid_utf8', '文件不是有效的 UTF-8 文本'); }
}

export const MAX_TEXT_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_CONCURRENT = 4;
const MAX_WAITING = 128;
let active = 0;
const waiting: Array<() => void> = [];

/** 所有读取与搜索共享并发预算，等待中的调用也能立即取消。 */
export async function withTextBudget<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_WAITING) throw new Error('文件工具等待队列已满');
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = waiting.indexOf(ready); if (index >= 0) waiting.splice(index, 1); reject(signal.reason instanceof Error ? signal.reason : new Error('文件操作已取消')); };
      waiting.push(ready);
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    });
  } else active++;
  try { signal.throwIfAborted(); return await operation(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}

export function interruptedResult(): ToolExecutionResult {
  return {status: 'interrupted', error: {code: 'interrupted', message: '文件操作已取消', retryable: false}};
}

/** 只校验读取到的前缀；截断后的文件尾不参与文本校验。 */
export async function readLimitedUtf8(path: string, maximumBytes: number, signal?: AbortSignal): Promise<LimitedText & {fileBytes: number}> {
  if (!Number.isFinite(maximumBytes) || maximumBytes < 0) throw new RangeError('maximumBytes 无效');
  const limit = Math.min(Math.floor(maximumBytes), MAX_READ_BYTES);
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const information = await handle.stat();
    if (!information.isFile()) throw new Error('目标不是普通文件');
    const data = Buffer.alloc(Math.min(information.size, limit + 4));
    let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted();
      const {bytesRead} = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    const prefix = data.subarray(0, offset);
    if (prefix.includes(0)) throw new TextFileError('binary_file', '文件包含 NUL 字节，不能作为文本读取');
    let text: string;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(prefix, {stream: offset < information.size}); }
    catch { throw new TextFileError('invalid_utf8', '文件不是有效的 UTF-8 文本'); }
    const limited = truncateUtf8(text, limit);
    return {text: limited.text, fileBytes: information.size, truncation: {truncated: information.size > limited.truncation.returnedUnits, originalUnits: information.size, returnedUnits: limited.truncation.returnedUnits, unit: 'bytes'}};
  } finally { await handle.close(); }
}

/** 按目录项增量遍历，不预先缓存整个目录树。 */
export async function* walkWorkspace(root: string, signal: AbortSignal, pattern: string): AsyncGenerator<{path: string; isFile: boolean; depthLimited: boolean}> {
  const directories: Array<{handle: Awaited<ReturnType<typeof opendir>>; path: string; depth: number}> = [];
  try {
    signal.throwIfAborted();
    directories.push({handle: await opendir(root), path: '', depth: 0});
    while (directories.length) {
      signal.throwIfAborted();
      const current = directories[directories.length - 1]!;
      const entry = await current.handle.read();
      signal.throwIfAborted();
      if (!entry) { await current.handle.close(); directories.pop(); continue; }
      const path = join(current.path, entry.name);
      const depthLimited = entry.isDirectory() && current.depth >= 127;
      yield {path, isFile: entry.isFile(), depthLimited};
      signal.throwIfAborted();
      if (entry.isDirectory() && !depthLimited && entry.name !== 'node_modules' && (!entry.name.startsWith('.') || pattern.split(/[\\/]/).some(part => part.startsWith('.')))) {
        directories.push({handle: await opendir(join(root, path)), path, depth: current.depth + 1});
      }
    }
  } finally {
    for (const directory of directories.reverse()) await directory.handle.close();
  }
}

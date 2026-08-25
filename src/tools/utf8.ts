import {readFile, stat} from 'node:fs/promises';
import {truncateUtf8, type LimitedText} from './limits.js';
import type {ToolErrorCode} from './types.js';

export class TextFileError extends Error {
  constructor(readonly code: Extract<ToolErrorCode, 'binary_file' | 'invalid_utf8'>, message: string) { super(message); }
}
/** [s02] fatal 解码拒绝替换字符；NUL 是本阶段明确的二进制信号。 */
export function assertUtf8Text(data: Uint8Array): string {
  if (data.includes(0)) throw new TextFileError('binary_file', '文件包含 NUL 字节，不能作为文本读取');
  try { return new TextDecoder('utf-8', {fatal: true}).decode(data); }
  catch { throw new TextFileError('invalid_utf8', '文件不是有效的 UTF-8 文本'); }
}
export async function readLimitedUtf8(path: string, maximumBytes: number): Promise<LimitedText & {fileBytes: number}> {
  const [data, information] = await Promise.all([readFile(path), stat(path)]);
  return {...truncateUtf8(assertUtf8Text(data), maximumBytes), fileBytes: information.size};
}

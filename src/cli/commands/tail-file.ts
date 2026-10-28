import {existsSync, readFileSync, statSync} from 'node:fs';
import {getLogger} from '../../shared/logger.js';

const logger = getLogger('cli-tail');

/** JSONL 追随输出：每秒轮询增量、只打印完整行；Ctrl+C 退出。 */
export function tailJsonlFile(path: string): void {
  if (!existsSync(path)) process.stdout.write(`（尚无文件，等待写入：${path}）\n`);
  let offset = existsSync(path) ? statSync(path).size : 0;
  process.stdout.write('tail 模式按 Ctrl+C 退出\n');
  const timer = setInterval(() => {
    try {
      if (!existsSync(path)) return;
      const buffer = readFileSync(path);
      if (buffer.length <= offset) return;
      const text = buffer.subarray(offset).toString('utf8');
      offset = buffer.length;
      // 行可能被写到一半：只输出完整行，残余字节留给下一轮。
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return;
      offset -= Buffer.byteLength(text.slice(lastNewline + 1), 'utf8');
      const fresh = text.slice(0, lastNewline + 1);
      if (fresh.trim().length > 0) process.stdout.write(fresh);
    } catch (error) {
      logger.debug('tail 读取失败', {path, error: error instanceof Error ? error.message : String(error)});
    }
  }, 1000);
  process.once('SIGINT', () => { clearInterval(timer); process.exit(0); });
}

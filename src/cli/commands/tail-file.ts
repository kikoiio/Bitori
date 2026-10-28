import {statSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {once} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {getLogger} from '../../shared/logger.js';

const logger = getLogger('cli-tail');
const chunkSize = 64 * 1024;

/** 按字节扫描完整行，避免重复读取未完成的长行。 */
export class JsonlFollower {
  private identity: {dev: number; ino: number} | undefined;
  private scanned = 0;
  private emitted = 0;

  constructor(private readonly path: string, private readonly write: (text: string) => Promise<void>) {
    try {
      const stat = statSync(path);
      this.identity = {dev: stat.dev, ino: stat.ino};
      this.scanned = stat.size;
      this.emitted = stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async poll(): Promise<void> {
    let file;
    try {
      file = await open(this.path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.identity = undefined;
      this.scanned = 0;
      this.emitted = 0;
      return;
    }
    try {
      const stat = await file.stat();
      if (!this.identity || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || stat.size < this.scanned) {
        this.identity = {dev: stat.dev, ino: stat.ino};
        this.scanned = 0;
        this.emitted = 0;
      }
      const buffer = Buffer.allocUnsafe(chunkSize);
      let end = this.emitted;
      while (this.scanned < stat.size) {
        const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.scanned), this.scanned);
        if (bytesRead === 0) break;
        const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (newline !== -1) end = this.scanned + newline + 1;
        this.scanned += bytesRead;
      }
      const decoder = new StringDecoder('utf8');
      while (this.emitted < end) {
        const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, end - this.emitted), this.emitted);
        if (bytesRead === 0) break;
        const text = decoder.write(buffer.subarray(0, bytesRead));
        if (text) await this.write(text);
        this.emitted += bytesRead;
      }
      const final = decoder.end();
      if (final) await this.write(final);
    } finally {
      await file.close();
    }
  }
}

/** JSONL 追随输出：每秒轮询增量、只打印完整行；Ctrl+C 退出。 */
export function tailJsonlFile(path: string): void {
  const follower = new JsonlFollower(path, async text => {
    if (!process.stdout.write(text)) await once(process.stdout, 'drain');
  });
  try { statSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    process.stdout.write(`（尚无文件，等待写入：${path}）\n`);
  }
  process.stdout.write('tail 模式按 Ctrl+C 退出\n');
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void follower.poll().catch((error: unknown) => {
      logger.debug('tail 读取失败', {path, error: error instanceof Error ? error.message : String(error)});
    }).finally(() => { polling = false; });
  }, 1000);
  process.once('SIGINT', () => { clearInterval(timer); process.exit(0); });
}

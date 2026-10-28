import {closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const LOCK_MAX_ATTEMPTS = 10;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MIN_MS = 1;
const LOCK_RETRY_MAX_MS = 10;

export interface FileMailMessage {from: string; text: string; timestamp: string}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function acquireLock(lockFile: string): void {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');
      closeSync(fd);
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) unlinkSync(lockFile); } catch { /* 过期锁可能已被他人删除。 */ }
      sleepSync(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('无法获取邮箱锁');
}

function releaseLock(lockFile: string): void { try { unlinkSync(lockFile); } catch { /* 锁已消失即可。 */ } }

export function withLock<T>(filePath: string, operation: () => T): T {
  const lockFile = `${filePath}.lock`;
  acquireLock(lockFile);
  try { return operation(); }
  finally { releaseLock(lockFile); }
}

/** JSONL 邮箱按行持久化；read 游标独立保存，新实例能继续消费未读消息。 */
export class FileMailbox {
  readonly #filePath: string;
  readonly #readStatePath: string;
  #lastReadLines: number;

  constructor(directory: string, memberName: string) {
    mkdirSync(directory, {recursive: true});
    this.#filePath = join(directory, `${memberName}.jsonl`);
    this.#readStatePath = join(directory, `${memberName}.read`);
    this.#lastReadLines = this.#loadReadState();
  }

  #loadReadState(): number {
    try { return Number.parseInt(readFileSync(this.#readStatePath, 'utf8').trim(), 10) || 0; }
    catch { return 0; }
  }

  #saveReadState(): void { try { writeFileSync(this.#readStatePath, String(this.#lastReadLines), 'utf8'); } catch { /* 游标可重建。 */ } }

  #allLines(): string[] {
    if (!existsSync(this.#filePath)) return [];
    return readFileSync(this.#filePath, 'utf8').trim().split('\n').filter(Boolean);
  }

  async send(from: string, text: string): Promise<void> {
    const message: FileMailMessage = {from, text, timestamp: new Date().toISOString()};
    return Promise.resolve(withLock(this.#filePath, () => writeFileSync(this.#filePath, `${JSON.stringify(message)}\n`, {flag: 'a', encoding: 'utf8'})));
  }

  receiveSync(): FileMailMessage[] {
    return withLock(this.#filePath, () => {
      const lines = this.#allLines();
      const unread = lines.slice(this.#lastReadLines).map(line => {
        try { return JSON.parse(line) as FileMailMessage; }
        catch { return null; }
      }).filter(Boolean) as FileMailMessage[];
      this.#lastReadLines = lines.length;
      this.#saveReadState();
      return unread;
    });
  }

  receive(): Promise<FileMailMessage[]> { return Promise.resolve(this.receiveSync()); }
  unreadCount(): number { return Math.max(0, this.#allLines().length - this.#lastReadLines); }
  markAllRead(): void { withLock(this.#filePath, () => { this.#lastReadLines = this.#allLines().length; this.#saveReadState(); }); }

  async *poll(intervalMs = 1_000): AsyncGenerator<FileMailMessage> {
    while (true) {
      for (const message of await this.receive()) yield message;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

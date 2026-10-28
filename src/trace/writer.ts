import {appendFile} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {configPaths} from '../config/loader.js';
import {now} from '../shared/ids.js';
import {getLogger} from '../shared/logger.js';
import {getGlobalRedactor} from '../shared/redact.js';
import {TRACE_VERSION, type TraceEvent} from './types.js';

const logger = getLogger('trace');
const DEFAULT_QUEUE_LIMIT = 256;

/**
 * 会话级 JSONL trace 写入器：有界队列串行追加，失败只丢弃并告警。
 * 每个会话一个 `<sessionId>.jsonl` 文件；恢复会话时续写同一文件。
 */
export class TraceWriter {
  readonly #directory: string;
  readonly #redactor: (text: string) => string;
  readonly #queueLimit: number;
  readonly #chains = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, number>();
  #dropped = 0;
  #mkdirDone = false;

  constructor(directory = configPaths().traces, redactor: (text: string) => string = getGlobalRedactor(), queueLimit = DEFAULT_QUEUE_LIMIT) {
    this.#directory = directory;
    this.#redactor = redactor;
    this.#queueLimit = queueLimit;
  }

  /** 火后不理；调用方绝不等待写入，也不因写入失败受阻。 */
  append(event: TraceEvent): void {
    const sessionId = event.sessionId;
    const pending = (this.#pending.get(sessionId) ?? 0) + 1;
    if (pending > this.#queueLimit) {
      this.#dropped += 1;
      if (this.#dropped % 50 === 1) logger.warn('trace 队列已满，事件被丢弃', {sessionId, dropped: this.#dropped});
      return;
    }
    this.#pending.set(sessionId, pending);
    const line = () => {
      this.#pending.set(sessionId, (this.#pending.get(sessionId) ?? 1) - 1);
      let serialized: string;
      try {
        serialized = JSON.stringify({...event, at: event.at || now(), v: TRACE_VERSION});
      } catch {
        serialized = JSON.stringify({v: TRACE_VERSION, at: now(), sessionId, type: 'domain_fact', fact: 'trace_event_serialize_failed'});
      }
      this.#ensureDirectory();
      return appendFile(join(this.#directory, `${sessionId}.jsonl`), `${this.#redactor(serialized)}\n`, 'utf8').catch((error: unknown) => {
        // 观察绝不干扰被观察者：磁盘故障只降级记录一次代表性错误。
        logger.warn('trace 写入失败', {sessionId, error: error instanceof Error ? error.message : String(error)});
      });
    };
    const previous = this.#chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(line, line).finally(() => {
      if (this.#chains.get(sessionId) === next) {
        this.#chains.delete(sessionId);
        this.#pending.delete(sessionId);
      }
    });
    this.#chains.set(sessionId, next);
  }

  /** 等待指定会话（或全部）排队中的事件落盘；测试与关停使用。 */
  async flush(sessionId?: string): Promise<void> {
    const targets = sessionId === undefined ? [...this.#chains.values()] : this.#chains.has(sessionId) ? [this.#chains.get(sessionId)!] : [];
    await Promise.all(targets);
  }

  pathFor(sessionId: string): string { return join(this.#directory, `${sessionId}.jsonl`); }

  #ensureDirectory(): void {
    if (this.#mkdirDone) return;
    try { mkdirSync(this.#directory, {recursive: true}); } catch { /* 写入路径会再失败并降级 */ }
    this.#mkdirDone = true;
  }
}

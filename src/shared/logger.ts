import {appendFile} from 'node:fs/promises';
import {mkdirSync, readdirSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {configPaths} from '../config/loader.js';
import {now} from './ids.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40};

export interface LoggingOptions {
  level?: LogLevel;
  directory?: string;
  retentionDays?: number;
  /** [s15] 每行落盘前对序列化文本做密钥替换；由组合根注入。 */
  redactor?: (text: string) => string;
}

export interface LogFields {
  [key: string]: unknown;
}

interface LogLine {
  at: number;
  time: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: LogFields;
}

const dayFormat = (date: Date): string => date.toISOString().slice(0, 10);

/** [s15] 日志文件按天滚动为 `bitori-YYYY-MM-DD.log`；清理只删除匹配本命名且超期的文件。 */
function fileForDay(directory: string, date: Date): string {
  return join(directory, `bitori-${dayFormat(date)}.log`);
}

function cleanupExpired(directory: string, retentionDays: number): void {
  if (retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^bitori-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry);
    if (match === null) continue;
    if (Date.parse(match[1]!) < cutoff) {
      try { unlinkSync(join(directory, entry)); } catch { /* 被并发清理属正常竞争 */ }
    }
  }
}

/**
 * [s15] 全局日志汇：异步串行追加写文件，失败只丢弃并计数，绝不抛错。
 * TUI 模式下 stdout 由 Ink 独占，日志唯一出口是文件；未显式配置时按默认路径惰性启用。
 */
class LogSink {
  #level: LogLevel = 'info';
  #directory: string | null = null;
  #retentionDays = 7;
  #redactor: (text: string) => string = text => text;
  #enabled = false;
  #chain: Promise<void> = Promise.resolve();
  #dropped = 0;
  #lastCleanupDay = '';
  #mkdirDone = false;

  configure(options: LoggingOptions): void {
    if (options.level !== undefined) this.#level = options.level;
    if (options.directory !== undefined) this.#directory = options.directory;
    if (options.retentionDays !== undefined) this.#retentionDays = options.retentionDays;
    if (options.redactor !== undefined) this.#redactor = options.redactor;
    this.#enabled = true;
    this.#lastCleanupDay = dayFormat(new Date());
    try {
      mkdirSync(this.#directory!, {recursive: true});
      this.#mkdirDone = true;
      cleanupExpired(this.#directory!, this.#retentionDays);
    } catch { /* 目录不可写时逐条写入仍会失败并降级 */ }
  }

  get level(): LogLevel { return this.#level; }

  write(level: LogLevel, module: string, msg: string, data?: LogFields): void {
    if (levelOrder[level] < levelOrder[this.#level]) return;
    if (!this.#enabled) this.#lazyConfigure();
    const directory = this.#directory;
    if (directory === null) return;
    const date = new Date();
    const today = dayFormat(date);
    if (today !== this.#lastCleanupDay) {
      this.#lastCleanupDay = today;
      cleanupExpired(directory, this.#retentionDays);
    }
    const line: LogLine = {at: now(), time: date.toISOString(), level, module, msg, ...(data === undefined ? {} : {data})};
    let serialized: string;
    try {
      serialized = JSON.stringify(line);
    } catch {
      serialized = JSON.stringify({at: now(), level, module, msg: '日志字段序列化失败'});
    }
    if (!this.#mkdirDone) {
      try { mkdirSync(directory, {recursive: true}); this.#mkdirDone = true; }
      catch { this.#dropped += 1; return; }
    }
    // [s15] 串行链保证行序；任何失败只计数不抛错，观察不干扰被观察者。
    this.#chain = this.#chain
      .then(() => appendFile(fileForDay(directory, date), `${this.#redactor(serialized)}\n`, 'utf8'))
      .catch(() => { this.#dropped += 1; });
  }

  #lazyConfigure(): void {
    try {
      this.#directory = configPaths().logs;
    } catch {
      this.#directory = null;
    }
    this.#enabled = true;
  }

  get droppedCount(): number { return this.#dropped; }

  flush(): Promise<void> { return this.#chain; }
}

const globalSink = new LogSink();

export function configureLogging(options: LoggingOptions): void {
  globalSink.configure(options);
}

/** [s15] 等待全部排队中的日志行落盘；测试与关停路径使用。 */
export function flushLogging(): Promise<void> {
  return globalSink.flush();
}

/** [s15] 模块级 Logger：调用方只声明模块名，级别与输出由全局汇统一控制。 */
export interface Logger {
  readonly module: string;
  debug(msg: string, data?: LogFields): void;
  info(msg: string, data?: LogFields): void;
  warn(msg: string, data?: LogFields): void;
  error(msg: string, data?: LogFields): void;
}

export function getLogger(module: string): Logger {
  const emit = (level: LogLevel) => (msg: string, data?: LogFields) => globalSink.write(level, module, msg, data);
  return {module, debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error')};
}

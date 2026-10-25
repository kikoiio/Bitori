import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {getLogger} from '../shared/logger.js';

const logger = getLogger('commands');

export interface CommandUsage {count: number; lastUsedAt: number}

/** [s09] 使用次数与最近使用共同排序；JSON 持久化失败不阻断命令执行。 */
export class CommandUsageTracker {
  readonly #path: string;
  #usage: Record<string, CommandUsage> = {};

  constructor(path: string) {
    this.#path = path;
    if (existsSync(path)) {
      try { this.#usage = JSON.parse(readFileSync(path, 'utf8')) as Record<string, CommandUsage>; }
      catch (error) {
        this.#usage = {};
        // [s15] 统计文件损坏不再静默，降级为日志后从空统计继续。
        logger.warn('命令使用统计文件损坏，已重置', {path, error: error instanceof Error ? error.message : String(error)});
      }
    }
  }

  record(name: string, at = Date.now()): void {
    const current = this.#usage[name] ?? {count: 0, lastUsedAt: at};
    this.#usage[name] = {count: current.count + 1, lastUsedAt: at};
    try {
      mkdirSync(dirname(this.#path), {recursive: true});
      writeFileSync(this.#path, JSON.stringify(this.#usage), 'utf8');
    } catch (error) {
      // 使用统计是可丢弃数据，但失败原因应可见。
      logger.debug('命令使用统计写入失败', {path: this.#path, error: error instanceof Error ? error.message : String(error)});
    }
  }

  score(name: string): number {
    const entry = this.#usage[name];
    if (!entry) return 0;
    const ageHours = Math.max(0, Date.now() - entry.lastUsedAt) / 3_600_000;
    return entry.count / (1 + ageHours);
  }

  recentlyUsed(limit = 5): string[] {
    return Object.entries(this.#usage).sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt).slice(0, limit).map(([name]) => name);
  }
}

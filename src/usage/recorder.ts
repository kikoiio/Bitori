import {mkdirSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {configPaths} from '../config/loader.js';
import {createId, now} from '../shared/ids.js';
import {getLogger} from '../shared/logger.js';

const logger = getLogger('usage');

export type UsageKind = 'skill' | 'command';
export type UsageSource = 'model' | 'user';

export interface UsageRecordInput {
  kind: UsageKind;
  name: string;
  source: UsageSource;
  sessionId: string;
  profileName?: string;
}

export interface UsageRecord extends UsageRecordInput {
  /** ISO 时间戳，对齐 skill-tracker 的记录格式。 */
  ts: string;
  cwd: string;
  agent: 'bitori';
  event_id: string;
}

/**
 * 使用统计记录器：JSONL 追加行，与 trace 分离。
 * 统计是可丢弃数据：写入失败只记日志，绝不影响对话主链路。
 */
export class UsageRecorder {
  readonly #path: string;
  readonly #workspace: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(path = join(configPaths().usage, 'skills.jsonl'), workspace = process.cwd()) {
    this.#path = path;
    this.#workspace = workspace;
  }

  record(input: UsageRecordInput): void {
    const record: UsageRecord = {...input, ...(input.profileName === undefined ? {} : {profileName: input.profileName}), ts: new Date(now()).toISOString(), cwd: this.#workspace, agent: 'bitori', event_id: `bitori:${createId()}`};
    try {
      mkdirSync(dirname(this.#path), {recursive: true});
    } catch (error) {
      logger.debug('使用统计目录创建失败', {path: this.#path, error: error instanceof Error ? error.message : String(error)});
      return;
    }
    // 串行落盘，保证并发调用仍按记录顺序追加。
    this.#writes = this.#writes.then(() => appendFile(this.#path, `${JSON.stringify(record)}\n`, 'utf8')).catch((error: unknown) => {
      logger.debug('使用统计写入失败', {path: this.#path, error: error instanceof Error ? error.message : String(error)});
    });
  }

  flush(): Promise<void> { return this.#writes; }
}

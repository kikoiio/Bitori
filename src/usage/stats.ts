import {existsSync, readFileSync} from 'node:fs';
import {getLogger} from '../shared/logger.js';
import type {UsageKind, UsageRecord} from './recorder.js';

const logger = getLogger('usage');

export interface UsageFilter {
  sessionId?: string;
  kind?: UsageKind;
}

/** [s15] 读取使用统计 JSONL；坏行跳过并计数。 */
export function readUsageRecords(path: string, filter: UsageFilter = {}): {records: UsageRecord[]; corruptLines: number} {
  if (!existsSync(path)) return {records: [], corruptLines: 0};
  const records: UsageRecord[] = [];
  let corruptLines = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as UsageRecord;
      if (filter.sessionId !== undefined && parsed.sessionId !== filter.sessionId) continue;
      if (filter.kind !== undefined && parsed.kind !== filter.kind) continue;
      records.push(parsed);
    } catch {
      corruptLines += 1;
    }
  }
  if (corruptLines > 0) logger.warn('使用统计文件存在损坏行', {path, corruptLines});
  return {records, corruptLines};
}

export interface UsageAggregate {
  kind: UsageKind;
  name: string;
  count: number;
  lastUsedAt: string;
  sessions: number;
}

/** [s15] 按 kind+name 聚合；最近使用时间倒序，sessions 为去重会话数。 */
export function aggregateUsage(records: readonly UsageRecord[]): UsageAggregate[] {
  interface Accumulator {kind: UsageKind; name: string; count: number; lastUsedAt: string; sessionIds: Set<string>}
  const map = new Map<string, Accumulator>();
  for (const record of records) {
    const key = `${record.kind}:${record.name}`;
    let entry = map.get(key);
    if (entry === undefined) {
      entry = {kind: record.kind, name: record.name, count: 0, lastUsedAt: record.ts, sessionIds: new Set()};
      map.set(key, entry);
    }
    entry.count += 1;
    entry.sessionIds.add(record.sessionId);
    if (record.ts > entry.lastUsedAt) entry.lastUsedAt = record.ts;
  }
  return [...map.values()]
    .map(({kind, name, count, lastUsedAt, sessionIds}) => ({kind, name, count, lastUsedAt, sessions: sessionIds.size}))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

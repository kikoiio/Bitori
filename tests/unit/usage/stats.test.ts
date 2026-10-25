import {describe, expect, it} from 'vitest';
import {aggregateUsage, readUsageRecords} from '../../../src/usage/stats.js';
import {UsageRecorder} from '../../../src/usage/recorder.js';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach} from 'vitest';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function writeUsage(lines: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'bitori-usage-stats-'));
  directories.push(directory);
  const path = join(directory, 'skills.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('usage stats', () => {
  it('读取并按过滤器筛选记录', () => {
    const path = writeUsage([
      JSON.stringify({ts: '2026-10-25T00:00:00Z', kind: 'skill', name: 'demo', source: 'model', sessionId: 's1', agent: 'bitori', event_id: 'e1', cwd: '/w'}),
      JSON.stringify({ts: '2026-10-25T01:00:00Z', kind: 'command', name: 'compact', source: 'user', sessionId: 's2', agent: 'bitori', event_id: 'e2', cwd: '/w'}),
      '不是JSON',
    ]);
    const all = readUsageRecords(path);
    expect(all.records).toHaveLength(2);
    expect(all.corruptLines).toBe(1);
    expect(readUsageRecords(path, {kind: 'skill'}).records[0]!.name).toBe('demo');
    expect(readUsageRecords(path, {sessionId: 's2'}).records[0]!.name).toBe('compact');
  });

  it('聚合：计数、去重会话数与最近使用排序', () => {
    const path = writeUsage([
      JSON.stringify({ts: '2026-10-25T00:00:00Z', kind: 'skill', name: 'demo', source: 'model', sessionId: 's1', agent: 'bitori', event_id: 'e1', cwd: '/w'}),
      JSON.stringify({ts: '2026-10-26T00:00:00Z', kind: 'skill', name: 'demo', source: 'model', sessionId: 's2', agent: 'bitori', event_id: 'e2', cwd: '/w'}),
      JSON.stringify({ts: '2026-10-26T02:00:00Z', kind: 'command', name: 'compact', source: 'user', sessionId: 's2', agent: 'bitori', event_id: 'e3', cwd: '/w'}),
    ]);
    const aggregates = aggregateUsage(readUsageRecords(path).records);
    expect(aggregates[0]).toMatchObject({kind: 'command', name: 'compact', count: 1, sessions: 1});
    expect(aggregates[1]).toMatchObject({kind: 'skill', name: 'demo', count: 2, sessions: 2});
  });

  it('文件缺失返回空记录', () => {
    const {records, corruptLines} = readUsageRecords('/nonexistent/skills.jsonl');
    expect(records).toHaveLength(0);
    expect(corruptLines).toBe(0);
  });

  it('UsageRecorder 与 stats 读写闭环', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-usage-e2e-'));
    directories.push(directory);
    const path = join(directory, 'skills.jsonl');
    const recorder = new UsageRecorder(path);
    recorder.record({kind: 'skill', name: 'demo', source: 'model', sessionId: 's1'});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(aggregateUsage(readUsageRecords(path).records)[0]).toMatchObject({name: 'demo', count: 1});
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

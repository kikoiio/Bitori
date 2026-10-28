import {chmodSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {UsageRecorder} from '../../../src/usage/recorder.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

describe('UsageRecorder', () => {
  it('JSONL 追加记录：字段对齐 skill-tracker 超集', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-usage-'));
    directories.push(directory);
    const recorder = new UsageRecorder(join(directory, 'skills.jsonl'));
    recorder.record({kind: 'skill', name: 'demo', source: 'model', sessionId: 's1', profileName: 'p'});
    recorder.record({kind: 'command', name: 'compact', source: 'user', sessionId: 's1'});
    // appendFile 异步落盘；留出一拍。
    await new Promise(resolve => setTimeout(resolve, 20));
    const lines = readFileSync(join(directory, 'skills.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({kind: 'skill', name: 'demo', source: 'model', sessionId: 's1', profileName: 'p', agent: 'bitori'});
    expect(typeof lines[0]!.ts).toBe('string');
    expect(String(lines[0]!.event_id)).toMatch(/^bitori:/);
    expect(lines[1]).toMatchObject({kind: 'command', name: 'compact', source: 'user'});
  });

  it('路径不可写时静默降级不抛错', async () => {
    // 用 chmod 只读目录构造确定性失败；/proc 等特殊路径的 mkdir 会挂死，不可用作测试。
    const directory = mkdtempSync(join(tmpdir(), 'bitori-usage-ro-'));
    directories.push(directory);
    chmodSync(directory, 0o555);
    const recorder = new UsageRecorder(join(directory, 'nested', 'skills.jsonl'));
    expect(() => recorder.record({kind: 'skill', name: 'demo', source: 'model', sessionId: 's1'})).not.toThrow();
    chmodSync(directory, 0o755);
  });
});

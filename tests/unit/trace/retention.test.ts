import {mkdtempSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {cleanupExpiredTraces} from '../../../src/trace/retention.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function sessionId(): string {
  return '0123456789abcdef0123456789abcdef0123';
}

describe('cleanupExpiredTraces', () => {
  it('删除超期会话 trace，保留新鲜文件与无关文件', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-trace-rt-')); directories.push(directory);
    const old = join(directory, `${sessionId()}.jsonl`);
    const fresh = join(directory, 'fedcba9876543210fedcba9876543210fedcba98.jsonl');
    const other = join(directory, 'notes.txt');
    writeFileSync(old, '{}\n');
    writeFileSync(fresh, '{}\n');
    writeFileSync(other, 'x');
    const oldTime = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, oldTime, oldTime);
    expect(cleanupExpiredTraces(directory, 30)).toBe(1);
    expect(() => statSync(old)).toThrow();
    expect(() => statSync(fresh)).not.toThrow();
    expect(() => statSync(other)).not.toThrow();
  });

  it('目录不存在返回 0 不抛错', () => {
    expect(cleanupExpiredTraces('/nonexistent-traces', 30)).toBe(0);
  });
});

import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runUsageCommand} from '../../../src/cli/commands/usage.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bitori-usage-cli-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, {recursive: true, force: true});
});

function capture(options: Parameters<typeof runUsageCommand>[0]): string {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(runUsageCommand(options)).toBe(0);
  return output.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('usage stats CLI output', () => {
  it('returns a JSON array when no usage file exists', () => {
    expect(JSON.parse(capture({action: 'stats', json: true}))).toEqual([]);
  });

  it('returns an empty JSON array when the filter matches no records', () => {
    const directory = join(home, '.bitori', 'usage');
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, 'skills.jsonl'), JSON.stringify({
      ts: '2026-11-03T00:00:00Z', kind: 'skill', name: 'demo', sessionId: 's1',
    }) + '\n');
    expect(JSON.parse(capture({action: 'stats', sessionId: 'other', json: true}))).toEqual([]);
  });

  it('keeps the readable empty-state message outside JSON mode', () => {
    expect(capture({action: 'stats'})).toBe('（没有使用记录）\n');
  });
});

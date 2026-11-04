import {chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {exportTrace} from '../../../src/trace/export.js';
import type {TraceEvent} from '../../../src/trace/types.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'bitori-trace-export-permissions-'));
  directories.push(path);
  return path;
}

const events: TraceEvent[] = [{v: 1, at: 1, sessionId: 's1', type: 'domain_fact', fact: 'secret'}];

describe('trace export file permissions', () => {
  it('creates a private file while preserving raw JSONL content', () => {
    const path = join(directory(), 'trace.jsonl');
    expect(exportTrace(events, path, {raw: true})).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(events[0])}\n`);
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens an existing destination before writing', () => {
    const path = join(directory(), 'trace.jsonl');
    writeFileSync(path, 'old private trace data');
    chmodSync(path, 0o644);
    exportTrace(events, path, {raw: true});
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(events[0])}\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink without changing its target', () => {
    const target = join(directory(), 'target.jsonl');
    const path = join(directory(), 'trace.jsonl');
    writeFileSync(target, 'untouched');
    symlinkSync(target, path);
    expect(() => exportTrace(events, path)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
});

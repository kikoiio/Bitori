import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {TraceWriter} from '../../../src/trace/writer.js';
import {createRedactor} from '../../../src/shared/redact.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function makeWriter(redactor?: (text: string) => string, queueLimit?: number): {writer: TraceWriter; directory: string} {
  const directory = mkdtempSync(join(tmpdir(), 'bitori-trace-'));
  directories.push(directory);
  return {writer: new TraceWriter(directory, redactor, queueLimit), directory};
}

function baseEvent(sessionId: string) {
  return {sessionId, at: 1, v: 1 as const};
}

describe('TraceWriter', () => {
  it('按会话分文件追加 JSONL，flush 后可按行读取', async () => {
    const {writer, directory} = makeWriter();
    writer.append({...baseEvent('s1'), type: 'domain_fact', fact: 'a'});
    writer.append({...baseEvent('s1'), type: 'domain_fact', fact: 'b'});
    writer.append({...baseEvent('s2'), type: 'domain_fact', fact: 'c'});
    await writer.flush();
    const lines = readFileSync(join(directory, 's1.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({type: 'domain_fact', fact: 'a', v: 1, sessionId: 's1'});
    expect(readFileSync(join(directory, 's2.jsonl'), 'utf8')).toContain('"fact":"c"');
  });

  it('写入前经过脱敏器', async () => {
    const {writer, directory} = makeWriter(createRedactor(['sk-ant-0123456789']));
    writer.append({...baseEvent('s1'), type: 'domain_fact', fact: 'key sk-ant-0123456789 leaked'});
    await writer.flush();
    const content = readFileSync(join(directory, 's1.jsonl'), 'utf8');
    expect(content).toContain('<redacted>');
    expect(content).not.toContain('sk-ant-0123456789');
  });

  it('队列超限丢弃事件但绝不抛错', async () => {
    const {writer, directory} = makeWriter(undefined, 2);
    for (let index = 0; index < 50; index += 1) writer.append({...baseEvent('s1'), type: 'domain_fact', fact: `e${index}`});
    await writer.flush();
    const lines = readFileSync(join(directory, 's1.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThan(50);
    expect(lines.length).toBeGreaterThan(0);
    expect(writer.statsFor('s1')).toEqual({written: lines.length, dropped: 50 - lines.length, writeErrors: 0, serializationErrors: 0});
  });

  it('写入失败可查询且不影响其他会话统计', async () => {
    const {directory} = makeWriter();
    const blocked = join(directory, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const writer = new TraceWriter(blocked);
    writer.append({...baseEvent('s1'), type: 'domain_fact', fact: 'a'});
    await writer.flush();
    expect(writer.statsFor('s1')).toEqual({written: 0, dropped: 0, writeErrors: 1, serializationErrors: 0});
    expect(writer.statsFor('s2')).toEqual({written: 0, dropped: 0, writeErrors: 0, serializationErrors: 0});
  });
});

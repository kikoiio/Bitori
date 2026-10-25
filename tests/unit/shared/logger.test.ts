import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {configureLogging, flushLogging, getLogger} from '../../../src/shared/logger.js';

const temporaryDirectories: string[] = [];

function logDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bitori-logs-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await flushLogging();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('shared/logger', () => {
  it('按级别过滤：debug 不写入 info 级别文件', async () => {
    const directory = logDirectory();
    configureLogging({level: 'info', directory});
    const logger = getLogger('test');
    logger.debug('被过滤的消息');
    logger.info('保留的消息');
    await flushLogging();
    const file = readdirSync(directory)[0]!;
    const content = readFileSync(join(directory, file), 'utf8');
    expect(content).not.toContain('被过滤的消息');
    expect(content).toContain('保留的消息');
  });

  it('日志行为 JSONL：包含时间戳、级别、模块与结构化字段', async () => {
    const directory = logDirectory();
    configureLogging({level: 'debug', directory});
    getLogger('agent').warn('出错了', {code: 'x'});
    await flushLogging();
    const file = readdirSync(directory)[0]!;
    const line = JSON.parse(readFileSync(join(directory, file), 'utf8').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({level: 'warn', module: 'agent', msg: '出错了', data: {code: 'x'}});
    expect(typeof line.at).toBe('number');
  });

  it('按天滚动：文件名含日期', async () => {
    const directory = logDirectory();
    configureLogging({level: 'info', directory});
    getLogger('test').info('滚动检查');
    await flushLogging();
    const file = readdirSync(directory)[0]!;
    expect(file).toMatch(/^bitori-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it('每行落盘前经过脱敏器', async () => {
    const directory = logDirectory();
    configureLogging({level: 'info', directory, redactor: text => text.replaceAll('super-secret-key', '<redacted>')});
    getLogger('test').error('密钥泄露检查 super-secret-key');
    await flushLogging();
    const file = readdirSync(directory)[0]!;
    const content = readFileSync(join(directory, file), 'utf8');
    expect(content).toContain('<redacted>');
    expect(content).not.toContain('super-secret-key');
  });
});

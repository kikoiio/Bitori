import {describe, expect, it} from 'vitest';
import {parseCliArgs} from '../../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('解析空参数、帮助和 profile', () => {
    expect(parseCliArgs([])).toEqual({help: false});
    expect(parseCliArgs(['--help'])).toEqual({help: true});
    expect(parseCliArgs(['--profile', 'claude'])).toEqual({help: false, profile: 'claude'});
  });

  it('解析 exec 子命令', () => {
    expect(parseCliArgs(['exec', '--task', '修复测试', '--json'])).toEqual({help: false, exec: {task: '修复测试', json: true}});
    expect(parseCliArgs(['exec', '--profile', 'groq', '--task', '修复测试', '--workspace', '/tmp/demo', '--max-iterations', '8', '--json'])).toEqual({
      help: false,
      profile: 'groq',
      exec: {task: '修复测试', workspace: '/tmp/demo', maxIterations: 8, json: true},
    });
  });

  it('解析全局与 exec 内的 --log-level', () => {
    expect(parseCliArgs(['--log-level', 'debug'])).toEqual({help: false, logLevel: 'debug'});
    expect(parseCliArgs(['--profile', 'claude', '--log-level', 'error'])).toEqual({help: false, profile: 'claude', logLevel: 'error'});
    expect(parseCliArgs(['exec', '--task', 'demo', '--log-level', 'warn'])).toEqual({help: false, exec: {task: 'demo', json: false}, logLevel: 'warn'});
  });

  it.each([
    ['--log-level'],
    ['--log-level', '--help'],
    ['--log-level', 'verbose'],
    ['--log-level', 'debug', '--log-level', 'info'],
    ['exec', '--task', 'demo', '--log-level'],
    ['exec', '--task', 'demo', '--log-level', 'loud'],
  ])('拒绝非法 --log-level %#', (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });

  it('解析 trace 子命令', () => {
    expect(parseCliArgs(['trace', 'show', 'abc', '--iteration', '2'])).toEqual({
      help: false, trace: {action: 'show', sessionId: 'abc', iteration: 2, json: false},
    });
    expect(parseCliArgs(['trace', 'tail', '--session', 'abc'])).toEqual({help: false, trace: {action: 'tail', sessionId: 'abc', json: false}});
    expect(parseCliArgs(['trace', 'export', 'abc', '--out', 'o.jsonl', '--raw'])).toEqual({help: false, trace: {action: 'export', sessionId: 'abc', out: 'o.jsonl', raw: true, json: false}});
    expect(parseCliArgs(['trace', 'replay', 'x.jsonl', '--json'])).toEqual({help: false, trace: {action: 'replay', file: 'x.jsonl', json: true}});
  });

  it('解析 usage 与 sessions 子命令', () => {
    expect(parseCliArgs(['usage', 'stats', '--kind', 'skill'])).toEqual({help: false, usage: {action: 'stats', kind: 'skill', json: false}});
    expect(parseCliArgs(['usage', 'tail'])).toEqual({help: false, usage: {action: 'tail', json: false}});
    expect(parseCliArgs(['sessions', 'list'])).toEqual({help: false, sessions: {action: 'list', json: false}});
    expect(parseCliArgs(['--profile', 'claude', 'sessions', 'show', 'abc', '--json'])).toEqual({
      help: false, profile: 'claude', sessions: {action: 'show', sessionId: 'abc', json: true},
    });
  });

  it.each([
    ['trace'],
    ['trace', 'fly'],
    ['usage'],
    ['usage', 'count'],
    ['sessions'],
    ['sessions', 'delete'],
    ['trace', 'show'],
    ['trace', 'show', 'abc', '--iteration', '0'],
    ['usage', 'stats', '--kind', 'other'],
    ['trace', 'show', 'abc', '--unknown'],
  ])('拒绝非法子命令 %#', (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });

  it.each([
    ['--unknown'],
    ['--profile'],
    ['--profile', '--help'],
    ['--profile', 'a', '--profile', 'b'],
    ['--help', '--profile', 'a'],
    ['exec'],
    ['exec', '--task'],
    ['exec', '--task', 'demo', '--max-iterations', '0'],
    ['exec', '--task', 'demo', '--unknown'],
    ['exec', '--task', 'demo', '--help'],
  ])('拒绝非法参数 %#', (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });
});

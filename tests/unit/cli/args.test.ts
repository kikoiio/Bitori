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

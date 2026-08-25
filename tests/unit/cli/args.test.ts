import {describe, expect, it} from 'vitest';
import {parseCliArgs} from '../../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('解析空参数、帮助和 profile', () => {
    expect(parseCliArgs([])).toEqual({help: false});
    expect(parseCliArgs(['--help'])).toEqual({help: true});
    expect(parseCliArgs(['--profile', 'claude'])).toEqual({help: false, profile: 'claude'});
  });

  it.each([
    ['--unknown'],
    ['--profile'],
    ['--profile', '--help'],
    ['--profile', 'a', '--profile', 'b'],
    ['--help', '--profile', 'a'],
  ])('拒绝非法参数 %#', (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });
});

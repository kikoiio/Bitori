import {describe, expect, it} from 'vitest';
import {limitMatches, truncateUtf8} from '../../../src/tools/limits.js';

describe('工具结果限制', () => {
  it.each([['', 0, ''], ['abc', 3, 'abc'], ['中文', 3, '中'], ['🙂a', 4, '🙂']])('按 UTF-8 字节安全截断 %#', (input, limit, output) => expect(truncateUtf8(input, limit).text).toBe(output));
  it('报告原始与返回规模', () => expect(truncateUtf8('中🙂a', 7).truncation).toEqual({truncated: true, originalUnits: 8, returnedUnits: 7, unit: 'bytes'}));
  it('限制匹配数量并拒绝负限制', () => { expect(limitMatches([1, 2, 3], 2)).toMatchObject({matches: [1, 2], truncation: {truncated: true, originalUnits: 3, returnedUnits: 2}}); expect(() => limitMatches([], -1)).toThrow(RangeError); });
});

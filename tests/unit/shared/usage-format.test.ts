import {describe, expect, it} from 'vitest';
import {formatUsage} from '../../../src/shared/usage-format.js';

describe('formatUsage', () => {
  it('credits-only 用量不得显示成 0 tokens', () => {
    expect(formatUsage({inputTokens: 0, outputTokens: 0, credits: 0.04})).toBe('credits 0.04');
    expect(formatUsage({inputTokens: 0, outputTokens: 0, credits: 0.3})).toBe('credits 0.3');
  });
  it('两个来源都没有时显示占位而不是伪造 0', () => {
    expect(formatUsage({inputTokens: 0, outputTokens: 0})).toBe('tokens —');
    expect(formatUsage({inputTokens: 0, outputTokens: 0, credits: 0})).toBe('tokens —');
    expect(formatUsage(null)).toBe('tokens —');
  });
  it('token 用量照常展示,credits 存在则并列', () => {
    expect(formatUsage({inputTokens: 10, outputTokens: 5})).toBe('tokens 10↓ 5↑');
    expect(formatUsage({inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2})).toBe('tokens 10↓ 5↑ · cache 2');
    expect(formatUsage({inputTokens: 10, outputTokens: 5, credits: 0.04})).toBe('tokens 10↓ 5↑ · credits 0.04');
  });
});

import {describe, expect, it} from 'vitest';
import {createRedactor, redactedPlaceholder} from '../../../src/shared/redact.js';

describe('shared/redact', () => {
  it('替换长度 ≥ 8 的密钥值', () => {
    const redact = createRedactor(['sk-ant-0123456789abcdef', 'short']);
    expect(redact('Authorization: Bearer sk-ant-0123456789abcdef')).toBe(`Authorization: Bearer ${redactedPlaceholder}`);
    expect(redact('short 值不脱敏')).toBe('short 值不脱敏');
  });

  it('长密钥优先替换，避免前缀残余', () => {
    const redact = createRedactor(['abcdefgh', 'abcdefgh12345678']);
    expect(redact('token=abcdefgh12345678!')).toBe(`token=${redactedPlaceholder}!`);
  });

  it('空密钥集返回恒等函数', () => {
    const redact = createRedactor([]);
    expect(redact('anything here')).toBe('anything here');
  });

  it('同一密钥出现多次全部替换', () => {
    const redact = createRedactor(['secret-value-1']);
    expect(redact('a secret-value-1 b secret-value-1')).toBe(`a ${redactedPlaceholder} b ${redactedPlaceholder}`);
  });
});

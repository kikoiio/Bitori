import {describe, expect, it} from 'vitest';
import {parseChatCommand} from '../../../src/chat/commands.js';

describe('parseChatCommand', () => {
  it('识别去除首尾空白后的精确命令', () => {
    expect(parseChatCommand('  /plan\n')).toBe('plan');
    expect(parseChatCommand('/do')).toBe('do');
  });
  it('不吞掉带参数、大小写变体和普通文本', () => {
    for (const text of ['/plan x', '/do x', '/PLAN', '/Do', '', ' /help ']) expect(parseChatCommand(text)).toBeNull();
  });
});

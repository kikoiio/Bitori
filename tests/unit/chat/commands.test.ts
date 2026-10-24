import {describe, expect, it} from 'vitest';
import {parseChatCommand} from '../../../src/chat/commands.js';

describe('parseChatCommand', () => {
  it('识别去除首尾空白后的精确命令和紧凑别名', () => {
    expect(parseChatCommand('  /plan\n')).toBe('plan');
    expect(parseChatCommand('/do')).toBe('do');
    expect(parseChatCommand('/compact')).toBe('compact');
    expect(parseChatCommand('/c')).toBe('compact');
  });
  it('未注册的斜杠命令返回 unknown 而不是交给模型', () => {
    for (const text of ['/plan x', '/do x', '/PLAN', '/Do', ' /help ']) {
      expect(parseChatCommand(text)).toEqual({type: 'unknown', text: text.trim()});
    }
    expect(parseChatCommand('')).toBeNull();
    expect(parseChatCommand('普通文本')).toBeNull();
  });
});

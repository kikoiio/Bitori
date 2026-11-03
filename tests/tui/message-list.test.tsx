import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {MessageList} from '../../src/tui/components/message-list.js';
import type {StoredMessage} from '../../src/storage/types.js';

function message(id: string, role: 'user' | 'assistant', content: string): StoredMessage {
  return {id, sessionId: 's', role, content, thinking: '', status: 'completed', errorCode: null, errorMessage: null, usage: null, providerState: null, createdAt: 1, updatedAt: 1};
}

describe('MessageList', () => {
  it('从底部向上排列并优先展示最新消息', () => {
    const messages = [message('a', 'user', '第一条'), message('b', 'assistant', '第二条'), message('c', 'user', '第三条')];
    const view = render(<MessageList messages={messages} height={20} offset={0} selectedMessageId={null} expandedThinkingIds={new Set()} />);
    const frame = view.lastFrame() ?? '';
    const first = frame.indexOf('第一条');
    const last = frame.indexOf('第三条');
    expect(last).toBeGreaterThanOrEqual(0);
    expect(first === -1 || first < last).toBe(true);
    view.unmount();
  });

  it('图片名称折行计入消息高度，不让较旧消息挤进视口', () => {
    const older = message('older', 'user', '较旧消息');
    const latest = {
      ...message('latest', 'user', ''),
      attachments: [{name: 'very-long-diagram-filename-for-wrapping.png', mediaType: 'image/png' as const, data: ''}],
    };
    const view = render(<MessageList messages={[older, latest]} height={7} offset={0} selectedMessageId={null} expandedThinkingIds={new Set()} width={30} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('very-long-diagram-filename-for-wrapping.png');
    expect(frame).not.toContain('较旧消息');
    view.unmount();
  });
});

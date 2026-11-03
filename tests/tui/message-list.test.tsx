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
});

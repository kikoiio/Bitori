import {describe, expect, it} from 'vitest';
import {buildChatContext} from '../../../src/chat/context.js';
import type {MessageStatus, StoredMessage} from '../../../src/storage/types.js';

function message(role: 'user' | 'assistant', status: MessageStatus, content: string, createdAt: number): StoredMessage {
  return {id: String(createdAt), sessionId: 's', role, content, thinking: '私有思考', status,
    errorCode: null, errorMessage: null, usage: null, providerState: null, createdAt, updatedAt: createdAt};
}

describe('buildChatContext', () => {
  it('按顺序包含有效历史并排除失败和 thinking', () => {
    const context = buildChatContext([
      message('assistant', 'failed', 'bad', 4),
      message('assistant', 'cancelled', 'partial', 3),
      message('assistant', 'cancelled', '', 5),
      message('user', 'completed', 'hello', 1),
      message('assistant', 'completed', 'world', 2),
    ]);
    expect(context.map(item => item.content)).toEqual(['hello', 'world', 'partial']);
    expect(JSON.stringify(context)).not.toContain('私有思考');
  });
});

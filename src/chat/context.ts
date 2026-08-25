import type {ChatMessage} from '../providers/types.js';
import type {StoredMessage} from '../storage/types.js';

/** [s01]
 * 从持久化消息构造下一次模型请求的历史：
 * - 包含正常 user/assistant；
 * - 包含有正文的 cancelled assistant（保留用户已经看到的部分回答）；
 * - 排除 failed、空取消消息和仅供 UI 展示的 thinking 文本。
 */
export function buildChatContext(messages: readonly StoredMessage[]): ChatMessage[] {
  // [s01] 先复制再排序，避免修改调用方持有的只读数组。
  return [...messages]
    .sort((left, right) => left.createdAt - right.createdAt)
    .filter(message => {
      if (message.role === 'user') return message.status === 'completed';
      return message.status === 'completed' || (message.status === 'cancelled' && message.content.length > 0);
    })
    .map(message => {
      // [s01] providerState 仅在存在时附加，供 Responses API 重放结构化 output items。
      if (message.providerState === null) return {role: message.role, content: message.content, messageId: message.id};
      return {role: message.role, content: message.content, providerState: message.providerState, messageId: message.id};
    });
}

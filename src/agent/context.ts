import type {ModelAssistantIterationItem, ModelContextItem, ModelMessageItem, ModelReminderItem, ModelToolResultsItem} from '../providers/types.js';
import type {StoredConversation} from '../storage/types.js';

/** [s03] Agent 内存上下文保持助手调用与对应结果相邻。 */
export class AgentContext {
  readonly #items: ModelContextItem[];
  constructor(items: readonly ModelContextItem[] = []) { this.#items = [...items]; }

  static fromConversation(conversation: StoredConversation): AgentContext {
    const callsByMessage = new Map<string, typeof conversation.toolCalls>();
    for (const call of conversation.toolCalls) {
      const calls = callsByMessage.get(call.assistantMessageId) ?? [];
      calls.push(call); callsByMessage.set(call.assistantMessageId, calls);
    }
    const items: ModelContextItem[] = [];
    for (const message of [...conversation.messages].sort((a, b) => a.createdAt - b.createdAt)) {
      const replayable = message.status === 'completed' || (message.status === 'cancelled' && message.content.length > 0);
      if (!replayable) continue;
      if (message.role === 'user') {
        items.push({type: 'message', messageId: message.id, role: 'user', content: message.content});
        continue;
      }
      const calls = [...(callsByMessage.get(message.id) ?? [])].sort((a, b) => a.position - b.position);
      if (calls.length === 0) {
        items.push({type: 'message', messageId: message.id, role: 'assistant', content: message.content, ...(message.providerState === null ? {} : {providerState: message.providerState})});
        continue;
      }
      items.push({type: 'assistant_iteration', messageId: message.id, content: message.content, ...(message.thinking ? {thinking: message.thinking} : {}), ...(message.providerState === null ? {} : {providerState: message.providerState}), toolCalls: calls.map(call => ({callId: call.id, providerCallId: call.providerCallId, name: call.toolName, argumentsText: call.argumentsText ?? JSON.stringify(call.arguments), arguments: call.arguments}))});
      const completed = calls.filter(call => call.result !== null);
      if (completed.length > 0) items.push({type: 'tool_results', assistantMessageId: message.id, results: completed.map(call => ({callId: call.id, providerCallId: call.providerCallId, name: call.toolName, result: call.result!}))});
    }
    return new AgentContext(items);
  }

  items(): readonly ModelContextItem[] { return this.#items; }
  /** [s07] 全量摘要成功后原子替换内存请求上下文；持久化历史保持不变。 */
  replaceItems(items: readonly ModelContextItem[]): void { this.#items.splice(0, this.#items.length, ...items); }
  appendUserMessage(item: ModelMessageItem): void { this.#items.push(item); }
  appendIteration(item: ModelAssistantIterationItem): void { this.#items.push(item); }
  appendToolResults(item: ModelToolResultsItem): void { this.#items.push(item); }
  /** [s04] 提醒只存在于当次请求的内存上下文中，不进入持久化。 */
  appendReminder(item: ModelReminderItem): void { this.#items.push(item); }
}

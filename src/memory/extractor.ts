import type {LLMClient} from '../providers/types.js';
import type {MemoryManager, MemoryType} from './manager.js';

const MEMORY_TAGS = ['MEMORY_USER_PREFERENCE', 'MEMORY_FEEDBACK', 'MEMORY_PROJECT_KNOWLEDGE', 'MEMORY_REFERENCE'] as const;
type MemoryTag = (typeof MEMORY_TAGS)[number];
const TAG_TYPES: Record<MemoryTag, MemoryType> = {
  MEMORY_USER_PREFERENCE: 'user',
  MEMORY_FEEDBACK: 'feedback',
  MEMORY_PROJECT_KNOWLEDGE: 'project',
  MEMORY_REFERENCE: 'reference',
};

/** 回合自然停止后异步提取；返回 NONE 时不写任何文件。 */
export class MemoryExtractor {
  readonly #manager: MemoryManager;
  readonly #client: LLMClient;
  #inProgress: Promise<void> | null = null;

  constructor(manager: MemoryManager, client: LLMClient) {
    this.#manager = manager;
    this.#client = client;
  }

  extract(dialogue: string, signal?: globalThis.AbortSignal): Promise<void> {
    const cancellation = signal ?? new AbortController().signal;
    const next = this.#run(dialogue, cancellation).finally(() => { if (this.#inProgress === next) this.#inProgress = null; });
    this.#inProgress = this.#inProgress ? Promise.all([this.#inProgress, next]).then(() => undefined) : next;
    return this.#inProgress;
  }

  async #run(dialogue: string, signal: AbortSignal): Promise<void> {
    const prompt = [
      '从以下对话提取值得跨会话记住的信息。不要调用工具。',
      `可用标记：${MEMORY_TAGS.join(', ')}；没有值得记住的信息时只输出 NONE。`,
      '每条格式：`<TAG>|<标题>|<描述>|<正文>`，每条一行。由你判断与已有记忆去重。',
      dialogue,
    ].join('\n');
    const stream = this.#client.streamChat({messages: [{role: 'user', content: prompt}], items: [{type: 'message', messageId: 'memory-extract', role: 'user', content: prompt}]}, signal);
    let text = '';
    for await (const event of stream) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'error') return;
    }
    if (text.trim() === 'NONE') return;
    let changed = false;
    for (const line of text.split('\n')) {
      const [tag, title, description, ...content] = line.trim().split('|');
      if (!tag || !MEMORY_TAGS.includes(tag as MemoryTag) || !title) continue;
      const type = TAG_TYPES[tag as MemoryTag];
      this.#manager.write(type === 'user' ? 'user' : 'project', `${Date.now()}-${title.replace(/[^a-zA-Z0-9_-]+/g, '_')}.md`, {name: title, description: description ?? '', type}, content.join('|').trim());
      changed = true;
    }
    if (changed) this.#manager.rebuildIndex();
  }
}

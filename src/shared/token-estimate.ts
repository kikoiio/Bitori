import type {ModelContextItem, Usage} from '../providers/types.js';

/** 共享的上下文 token 估算器。 */
export const CHARS_PER_TOKEN = 3.5;

export interface UsageAnchor {tokens: number; itemLength: number}

export function serializedItem(item: ModelContextItem): string {
  if (item.type === 'message') return item.content;
  if (item.type === 'reminder') return item.text;
  if (item.type === 'assistant_iteration') return item.content + item.thinking + JSON.stringify(item.toolCalls);
  return JSON.stringify(item.results);
}

export function byteLengthOf(items: readonly ModelContextItem[]): number {
  return items.reduce((sum, item) => sum + Buffer.byteLength(serializedItem(item), 'utf8'), 0);
}

/** provider usage 作锚点，新增内容按 3.5 字符/token 估算增量。 */
export function estimateContextTokens(items: readonly ModelContextItem[], anchor: UsageAnchor | null): number {
  const length = byteLengthOf(items);
  if (!anchor) return Math.ceil(length / CHARS_PER_TOKEN);
  return Math.max(anchor.tokens, 0) + Math.ceil(Math.max(length - anchor.itemLength, 0) / CHARS_PER_TOKEN);
}

export function usageAnchorFrom(usage: Usage, items: readonly ModelContextItem[]): UsageAnchor {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  return {tokens: usage.inputTokens + cacheRead + cacheCreation + usage.outputTokens, itemLength: byteLengthOf(items)};
}

/** 任意文本（system 块、工具定义等）的独立估算；与上下文估算共用同一系数。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / CHARS_PER_TOKEN);
}

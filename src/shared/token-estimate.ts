import type {ModelContextItem, Usage} from '../providers/types.js';

/** 共享的上下文 token 估算器。 */
export const CHARS_PER_TOKEN = 3.5;
export const IMAGE_ATTACHMENT_TOKEN_ESTIMATE = 1024;
const IMAGE_ESTIMATE_PADDING = ' '.repeat(IMAGE_ATTACHMENT_TOKEN_ESTIMATE * CHARS_PER_TOKEN);

export interface UsageAnchor {tokens: number; itemLength: number}

export function serializedItem(item: ModelContextItem): string {
  const text = item.type === 'message' ? item.content
    : item.type === 'reminder' ? item.text
      : item.type === 'assistant_iteration' ? item.content + item.thinking + JSON.stringify(item.toolCalls)
        : JSON.stringify(item.results);
  const imageCount = item.type === 'message' ? item.attachments?.length ?? 0 : 0;
  // 图像按固定 token 预算计入估算；base64 本身不应视为可读文本或展开成巨量 token。
  return imageCount === 0 ? text : text + IMAGE_ESTIMATE_PADDING.repeat(imageCount);
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
